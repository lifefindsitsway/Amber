import {
  LLM_FIRST_OUTPUT_TIMEOUT_MS,
  LLM_PROBE_MAX_OUTPUT_TOKENS,
  LLM_PROBE_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_MS,
  LLM_TOKEN_PARAM_CACHE_MAX,
} from "../../../../shared/defaults.ts";
import { amberError } from "../../../domain/errors.ts";
import type { LlmRequest, LlmStopReason, LlmStreamEvent, RawUsage } from "../../../domain/llm.ts";
import { effectiveCapability, type ProviderProfile } from "../../../domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../domain/usage.ts";
import type { FileStore } from "../../../ports/file-store.ts";
import type {
  LlmProbeCall,
  LlmProbeCheck,
  LlmProbeFlag,
  LlmProbeFlagResult,
  LlmProbeKind,
  LlmProbeResult,
  LlmProvider,
  LlmStreamOptions,
} from "../../../ports/llm-provider.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundResponse, type OutboundRoute } from "../../../ports/outbound-http.ts";
import type { SecretStore } from "../../../ports/secret-store.ts";
import { beginRequest, endpoint, linkedController, OutputWatchdog, sseEvents, transportFailure } from "../shared.ts";
import { encodeRequest, OPENAI_AUDIO_MIME_TYPES, type ChatCompletionsBody } from "./encode.ts";
import { errorDetail, httpError, refusesProbedFeature, rejectsMaxTokens, rejectsTokenParam, upstreamText } from "./errors.ts";

export interface OpenAiCompatibleProviderOptions {
  http: OutboundHttpClient;
  secrets: Pick<SecretStore, "revealVersioned">;
  files: Pick<FileStore, "read">;
  now?: () => number;
}

const PATH = "/chat/completions";

type ProbeRunOptions = Parameters<LlmProbeCheck["run"]>[0];
const DONE_SENTINEL = "[DONE]";

/** `finish_reason` values with a meaning of their own; any other value counts as a stop. */
const LENGTH_FINISH = "length";
/** Content withheld by the provider's filters: a refusal, whatever was already streamed. */
const CONTENT_FILTER_FINISH = "content_filter";

/**
 * The OpenAI-compatible Chat Completions protocol (OpenAI, DeepSeek, most relays).
 * Invariant: everything named after the wire format stays in this directory; callers see
 * `LlmRequest` and normalized events only. Failures are classified,
 * never retried here. A request is bounded by model output, not by bytes on the wire
 * (`OutputWatchdog`): comments and empty deltas do not keep it alive.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly protocol = "openai_compatible" as const;
  readonly audioMimeTypes = OPENAI_AUDIO_MIME_TYPES;
  private readonly options: OpenAiCompatibleProviderOptions;
  private readonly now: () => number;
  /**
   * Endpoints known to want `max_completion_tokens`, by profile, protocol, Base URL and model.
   * Insertion order is age: past `LLM_TOKEN_PARAM_CACHE_MAX` entries the oldest goes first.
   */
  private readonly completionTokenEndpoints = new Map<string, true>();

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async *stream(request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    // `unknown` is tried as a stream; only a known refusal falls back to one plain answer.
    const streaming = effectiveCapability(opts.effectiveCapability).flags.stream !== "unsupported";
    const body = await encodeRequest(request, streaming, this.options.files, opts.signal);
    const controller = linkedController(opts.signal);
    const watchdog = new OutputWatchdog(controller, { firstMs: LLM_FIRST_OUTPUT_TIMEOUT_MS, idleMs: LLM_STREAM_IDLE_TIMEOUT_MS });
    try {
      let response: OutboundResponse;
      watchdog.start();
      try {
        response = await this.send(opts.profile, body, controller.signal, opts.onRequestStart);
      } catch (error) {
        throw transportFailure(error, opts.signal);
      }
      if (response.status !== 200) {
        throw httpError(response.status, await readText(response, opts.signal), response.headers);
      }
      if (streaming) {
        yield* parseStream(response.body, watchdog, opts.signal);
      } else {
        // A plain answer is the first output only once all of it has arrived.
        const completion = parseCompletion(await readText(response, opts.signal));
        watchdog.stop();
        yield* completionEvents(completion);
      }
    } finally {
      watchdog.stop();
      // Releases the connection when the consumer stops early; harmless once complete.
      controller.abort();
    }
  }

  probe(profile: ProviderProfile, modelId: string): readonly LlmProbeCheck[] {
    return PROBE_KINDS.map((kind) => ({
      kind,
      run: (opts: ProbeRunOptions) => this.runCheck(profile, modelId, kind, opts),
    }));
  }

  /**
   * Everything that can fail is done before the key is revealed; the request then goes out
   * with exactly the key `onRequestStart` was told about.
   */
  private send(
    profile: ProviderProfile,
    body: ChatCompletionsBody,
    signal: AbortSignal,
    onRequestStart: (info: RequestStartInfo) => void,
  ): Promise<OutboundResponse> {
    const payload = JSON.stringify(body);
    const key = beginRequest(profile, this.options.secrets, onRequestStart, this.now);
    return this.options.http.request({
      url: endpoint(profile, PATH),
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: body.stream ? "text/event-stream" : "application/json",
      },
      body: payload,
      signal,
    });
  }

  /**
   * One check. The output cap goes out as `max_tokens` unless this endpoint already turned it
   * down; an explicit refusal of `max_tokens` is answered by sending the same check once more
   * with `max_completion_tokens`. That is remembered only once the re-sent request was not
   * refused over its output cap as well. The refused request was sent and is reported.
   */
  private async runCheck(profile: ProviderProfile, modelId: string, kind: LlmProbeKind, opts: ProbeRunOptions): Promise<LlmProbeResult> {
    const cacheKey = tokenParamKey(profile, modelId);
    let param: TokenParam = this.completionTokenEndpoints.has(cacheKey) ? "max_completion_tokens" : "max_tokens";
    let fellBack = false;
    for (;;) {
      const answer = await this.probeRequest(profile, probeBody(modelId, kind, param), opts);
      if (fellBack && !(answer.status !== 200 && rejectsTokenParam(answer.status, answer.text))) {
        this.rememberCompletionTokens(cacheKey);
      }
      if (answer.status === 200) {
        return judgeAnswer(kind, answer, opts.onCall);
      }
      opts.onCall({ outcome: "failed" });
      if (param === "max_tokens" && rejectsMaxTokens(answer.status, answer.text)) {
        param = "max_completion_tokens";
        fellBack = true;
        continue;
      }
      return failedAnswer(kind, answer);
    }
  }

  private rememberCompletionTokens(cacheKey: string): void {
    this.completionTokenEndpoints.delete(cacheKey);
    this.completionTokenEndpoints.set(cacheKey, true);
    for (const oldest of this.completionTokenEndpoints.keys()) {
      if (this.completionTokenEndpoints.size <= LLM_TOKEN_PARAM_CACHE_MAX) {
        break;
      }
      this.completionTokenEndpoints.delete(oldest);
    }
  }

  /**
   * One probe request bounded by `LLM_PROBE_TIMEOUT_MS` as a whole, body included. A failure
   * after the request left reports it with an unknown outcome; one before reports nothing.
   * An answer of any status is returned for the caller to report and judge.
   */
  private async probeRequest(profile: ProviderProfile, body: ChatCompletionsBody, opts: ProbeRunOptions): Promise<ProbeAnswer> {
    const controller = linkedController(opts.signal);
    const timer = setTimeout(() => controller.abort(), LLM_PROBE_TIMEOUT_MS);
    const started = this.now();
    try {
      const response = await this.send(profile, body, controller.signal, opts.onRequestStart);
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, latencyMs: Math.max(0, this.now() - started), ...(response.route === undefined ? {} : { route: response.route }) };
    } catch (error) {
      if (error instanceof OutboundHttpError && error.phase === "after_send") {
        opts.onCall({ outcome: "outcome_unknown" });
      }
      throw transportFailure(error, opts.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

type TokenParam = "max_tokens" | "max_completion_tokens";

/** One probe answer, read whole. */
interface ProbeAnswer {
  status: number;
  headers: ReadonlyMap<string, string>;
  text: string;
  latencyMs: number;
  route?: OutboundRoute;
}

/** The basic call goes first: the capability checks only mean something once it connected. */
const PROBE_KINDS: readonly LlmProbeKind[] = ["basic", "stream", "structuredOutput", "tools"];
/** Asks for no JSON, so only an enforced schema makes the JSON check's answer conform. */
const PROBE_PROMPT = "Reply with OK.";
const PROBE_TOOL_PROMPT = "Call the report_ok tool.";

/**
 * What the token-parameter memory is about: the same model behind the same endpoint and
 * profile. The Base URL is compared without trailing slashes, as requests are sent.
 */
function tokenParamKey(profile: ProviderProfile, modelId: string): string {
  return JSON.stringify([profile.id, profile.protocol, profile.baseURL.replace(/\/+$/u, ""), modelId]);
}

/** The smallest request that exercises one check; the cap keeps it short. */
function probeBody(modelId: string, kind: LlmProbeKind, param: TokenParam): ChatCompletionsBody {
  const base = {
    model: modelId,
    ...(param === "max_tokens" ? { max_tokens: LLM_PROBE_MAX_OUTPUT_TOKENS } : { max_completion_tokens: LLM_PROBE_MAX_OUTPUT_TOKENS }),
  };
  const messages: ChatCompletionsBody["messages"] = [{ role: "user", content: PROBE_PROMPT }];
  switch (kind) {
    case "basic":
      return { ...base, stream: false, messages };
    case "stream":
      // Shaped like every streamed request: an endpoint that refuses the usage option
      // could not serve them either, so that refusal counts against streaming.
      return { ...base, stream: true, stream_options: { include_usage: true }, messages };
    case "structuredOutput":
      return {
        ...base,
        stream: false,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "output",
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
            strict: true,
          },
        },
      };
    case "tools":
      return {
        ...base,
        stream: false,
        // Not forced through `tool_choice`: some models reject forced tool use.
        messages: [{ role: "user", content: PROBE_TOOL_PROMPT }],
        tools: [
          {
            type: "function",
            function: {
              name: "report_ok",
              description: "Reports that the connection works.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
        ],
      };
  }
}

const withUsage = (usage: RawUsage | undefined): { usage?: RawUsage } => (usage === undefined ? {} : { usage });

function refusedError(finishReason: string): Error {
  return amberError("llm_failed", "the model refused the probe", { code: "llm_failed.refused", upstreamMessage: finishReason });
}

/**
 * A 200 answer, reported and judged. The basic call needs answer text: cut off by the cap
 * before any, it is `incomplete`. A capability check is `supported` only when the feature
 * visibly worked; cut off before it could show, it cannot decide; otherwise the upstream
 * ignored the feature. A refusal or an error body fails the check.
 */
async function judgeAnswer(kind: LlmProbeKind, answer: ProbeAnswer, onCall: (call: LlmProbeCall) => void): Promise<LlmProbeResult> {
  if (kind === "stream") {
    return judgeStream(answer, onCall);
  }
  const { latencyMs } = answer;
  const completion = probeCompletion(answer.text, onCall);
  if (stopReasonOf(completion.finishReason) === "refused") {
    onCall({ outcome: "failed", ...withUsage(completion.usage) });
    throw refusedError(completion.finishReason);
  }
  onCall({ outcome: "succeeded", ...withUsage(completion.usage) });
  const truncated = completion.finishReason === LENGTH_FINISH;
  if (kind === "basic") {
    return { kind, status: completion.text === "" && truncated ? "incomplete" : "connected", latencyMs, ...(answer.route === undefined ? {} : { route: answer.route }) };
  }
  if (probeTookEffect(kind, answer.text)) {
    return { kind, result: "supported", latencyMs };
  }
  return truncated ? { kind, result: "inconclusive", reason: "truncated", latencyMs } : { kind, result: "unsupported", latencyMs };
}

/** The body as a JSON object, or `undefined` when it is not one. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A 200 probe answer read as a completion. An error object in it fails the check as such;
 * a body that cannot be read as a chat completion (not JSON, cut off, another shape) was
 * processed with an unknown outcome. Either way the call is reported before throwing.
 */
function probeCompletion(text: string, onCall: (call: LlmProbeCall) => void): Completion {
  const usage = completionUsage(text);
  if (jsonObject(text)?.["error"] !== undefined) {
    onCall({ outcome: "failed", ...withUsage(usage) });
    return parseCompletion(text);
  }
  try {
    return parseCompletion(text);
  } catch {
    onCall({ outcome: "outcome_unknown", ...withUsage(usage) });
    throw amberError("llm_outcome_unknown", "unreadable chat completions answer");
  }
}

/**
 * The stream check: `supported` once the event stream is read to the chunk that says how the
 * answer finished, exactly what a streamed request needs. A body without a single event (a
 * relay that ignores `stream` answers with one JSON document) is `unsupported`; an error
 * inside the stream fails the check; a stream that stops before finishing leaves the outcome
 * unknown, as it would for a streamed request.
 */
async function judgeStream(answer: ProbeAnswer, onCall: (call: LlmProbeCall) => void): Promise<LlmProbeFlagResult> {
  const { text, latencyMs } = answer;
  let finishReason: string | undefined;
  let usage: RawUsage | undefined;
  let events = 0;
  for await (const event of sseEvents(once(text))) {
    events += 1;
    if (event.data.trim() === DONE_SENTINEL) {
      break;
    }
    const chunk = jsonObject(event.data);
    if (chunk === undefined) {
      // The stream broke off or garbled: the request was processed, how is unknown.
      onCall({ outcome: "outcome_unknown", ...withUsage(usage) });
      throw amberError("llm_outcome_unknown", "unreadable chat completions stream chunk");
    }
    if (chunk["error"] !== undefined) {
      const upstream = upstreamText(errorDetail(event.data));
      onCall({ outcome: "failed", ...withUsage(usage) });
      throw amberError("llm_failed", "chat completions stream reported an error", upstream === undefined ? {} : { upstreamMessage: upstream });
    }
    const finish = firstChoice(chunk)?.["finish_reason"];
    if (typeof finish === "string" && finish !== "") {
      finishReason = finish;
    }
    usage = normalizeUsage(chunk["usage"]) ?? usage;
  }
  if (events === 0) {
    const whole = probeCompletion(text, onCall);
    onCall({ outcome: "succeeded", ...withUsage(whole.usage) });
    return { kind: "stream", result: "unsupported", latencyMs };
  }
  if (finishReason === undefined) {
    onCall({ outcome: "outcome_unknown", ...withUsage(usage) });
    throw amberError("llm_outcome_unknown", "stream ended before the answer finished");
  }
  if (stopReasonOf(finishReason) === "refused") {
    onCall({ outcome: "failed", ...withUsage(usage) });
    throw refusedError(finishReason);
  }
  onCall({ outcome: "succeeded", ...withUsage(usage) });
  return { kind: "stream", result: "supported", latencyMs };
}

/**
 * An error answer of a check, already reported. The basic call fails with it. A capability
 * check learns `unsupported` from an explicit refusal of its feature and cannot decide on a
 * bad request it cannot classify; every other failure (authentication, unknown model,
 * quota, rate limit, server errors) fails the check.
 */
function failedAnswer(kind: LlmProbeKind, answer: ProbeAnswer): LlmProbeFlagResult {
  const { status, text, latencyMs } = answer;
  const error = httpError(status, text, answer.headers);
  if (kind === "basic") {
    throw error;
  }
  if (refusesProbedFeature(kind, status, text)) {
    return { kind, result: "unsupported", latencyMs };
  }
  if ((status === 400 || status === 422) && error.appError.code === "llm_failed.invalid_request") {
    return { kind, result: "inconclusive", reason: "upstream_rejected", latencyMs };
  }
  throw error;
}

async function* once(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/**
 * Whether a successful JSON or tools probe shows the feature at work: an
 * endpoint that silently ignores `response_format` or `tools` still answers 200, so the
 * answer itself must be schema-shaped JSON or contain the probe's tool call. A body that
 * is not a chat completion teaches nothing.
 */
function probeTookEffect(flag: Exclude<LlmProbeFlag, "stream">, text: string): boolean {
  const message = field(firstChoice(parseJson(text)), "message");
  if (flag === "tools") {
    const calls = field(message, "tool_calls");
    return Array.isArray(calls) && calls.some((call) => field(field(call, "function"), "name") === "report_ok");
  }
  const content = field(message, "content");
  if (typeof content !== "string") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["ok"] === "boolean";
  } catch {
    return false;
  }
}

async function readText(response: OutboundResponse, signal: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw transportFailure(error, signal);
  }
}

/** Parsed JSON of one stream chunk; a chunk that is not JSON breaks the protocol. */
function parseJson(data: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw amberError("llm_failed", "malformed chat completions payload");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw amberError("llm_failed", "malformed chat completions payload");
  }
  return parsed as Record<string, unknown>;
}

function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = chunk["choices"];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  return typeof first === "object" && first !== null ? (first as Record<string, unknown>) : undefined;
}

function stopReasonOf(finishReason: string): LlmStopReason {
  if (finishReason === LENGTH_FINISH) {
    return "length";
  }
  return finishReason === CONTENT_FILTER_FINISH ? "refused" : "stop";
}

/**
 * Stream chunks to normalized events: `text_delta*` → `usage?` → `done`. Usage may arrive
 * in a chunk of its own after the finishing one, so both are held until the stream ends.
 * An error the upstream reports inside the stream ends it as `done` with `error`; a stream
 * that stops before saying how it finished leaves the outcome unknown.
 *
 * Answer text and reasoning (DeepSeek's `reasoning_content`, streamed before the answer in
 * thinking mode) count as output for `watchdog`; role-only or empty deltas, comments and
 * the usage chunk do not. Reasoning is not passed on.
 */
async function* parseStream(body: AsyncIterable<Uint8Array>, watchdog: OutputWatchdog, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
  let finishReason: string | undefined;
  let usage: RawUsage | undefined;
  try {
    for await (const event of sseEvents(body)) {
      if (event.data.trim() === DONE_SENTINEL) {
        break;
      }
      const chunk = parseJson(event.data);
      if (chunk["error"] !== undefined) {
        watchdog.stop();
        if (usage !== undefined) {
          yield { type: "usage", usage };
        }
        const upstream = upstreamText(errorDetail(event.data));
        yield { type: "done", stopReason: "error", ...(upstream === undefined ? {} : { raw: upstream }) };
        return;
      }
      const choice = firstChoice(chunk);
      const delta = choice?.["delta"];
      const fields = typeof delta === "object" && delta !== null ? (delta as Record<string, unknown>) : {};
      const content = fields["content"];
      const reasoning = fields["reasoning_content"];
      if (typeof content === "string" && content !== "") {
        watchdog.suspend();
        yield { type: "text_delta", delta: content };
        watchdog.resume();
      } else if (typeof reasoning === "string" && reasoning !== "") {
        watchdog.progress();
      }
      const finish = choice?.["finish_reason"];
      if (typeof finish === "string" && finish !== "") {
        finishReason = finish;
      }
      usage = normalizeUsage(chunk["usage"]) ?? usage;
    }
  } catch (error) {
    throw transportFailure(error, signal);
  }
  watchdog.stop();
  if (finishReason === undefined) {
    throw amberError("llm_outcome_unknown", "stream ended before the answer finished");
  }
  if (usage !== undefined) {
    yield { type: "usage", usage };
  }
  yield { type: "done", stopReason: stopReasonOf(finishReason), raw: finishReason };
}

interface Completion {
  text: string;
  finishReason: string;
  usage?: RawUsage;
}

function parseCompletion(body: string): Completion {
  const parsed = parseJson(body);
  if (parsed["error"] !== undefined) {
    const upstream = upstreamText(errorDetail(body));
    throw amberError("llm_failed", "chat completions answered with an error object", upstream === undefined ? {} : { upstreamMessage: upstream });
  }
  const choice = firstChoice(parsed);
  const message = choice?.["message"];
  const content = typeof message === "object" && message !== null ? (message as Record<string, unknown>)["content"] : undefined;
  const finish = choice?.["finish_reason"];
  if (choice === undefined || (content !== null && content !== undefined && typeof content !== "string")) {
    throw amberError("llm_failed", "malformed chat completions payload");
  }
  const usage = normalizeUsage(parsed["usage"]);
  return {
    text: typeof content === "string" ? content : "",
    finishReason: typeof finish === "string" && finish !== "" ? finish : "stop",
    ...(usage === undefined ? {} : { usage }),
  };
}

/** A non-streamed answer as the same event sequence: one delta, usage, done. */
function* completionEvents(completion: Completion): Iterable<LlmStreamEvent> {
  if (completion.text !== "") {
    yield { type: "text_delta", delta: completion.text };
  }
  if (completion.usage !== undefined) {
    yield { type: "usage", usage: completion.usage };
  }
  yield { type: "done", stopReason: stopReasonOf(completion.finishReason), raw: completion.finishReason };
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const field = (record: unknown, key: string): unknown =>
  typeof record === "object" && record !== null ? (record as Record<string, unknown>)[key] : undefined;

/**
 * Upstream usage to `RawUsage`. `prompt_tokens` already includes cached tokens, which are
 * reported as a breakdown (`cached_tokens`, or DeepSeek's `prompt_cache_hit_tokens`);
 * reasoning tokens are part of `completion_tokens`. A usage without both totals is none.
 */
export function normalizeUsage(raw: unknown): RawUsage | undefined {
  const inputTokens = count(field(raw, "prompt_tokens"));
  const outputTokens = count(field(raw, "completion_tokens"));
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  const cacheReadTokens = count(field(field(raw, "prompt_tokens_details"), "cached_tokens")) ?? count(field(raw, "prompt_cache_hit_tokens"));
  const reasoningTokens = count(field(field(raw, "completion_tokens_details"), "reasoning_tokens"));
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    rawJson: JSON.stringify(raw),
  };
}

function completionUsage(text: string): RawUsage | undefined {
  try {
    return normalizeUsage(field(JSON.parse(text), "usage"));
  } catch {
    return undefined;
  }
}
