import { LLM_FIRST_OUTPUT_TIMEOUT_MS, LLM_PROBE_MAX_OUTPUT_TOKENS, LLM_PROBE_TIMEOUT_MS, LLM_STREAM_IDLE_TIMEOUT_MS } from "../../../../shared/defaults.ts";
import { amberError } from "../../../domain/errors.ts";
import type { LlmRequest, LlmStopReason, LlmStreamEvent, RawUsage } from "../../../domain/llm.ts";
import { effectiveCapability, type ProviderProfile } from "../../../domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../domain/usage.ts";
import type { FileStore } from "../../../ports/file-store.ts";
import type { LlmProbeCheck, LlmProbeFlag, LlmProvider, LlmStreamOptions } from "../../../ports/llm-provider.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundResponse } from "../../../ports/outbound-http.ts";
import type { SecretStore } from "../../../ports/secret-store.ts";
import { beginRequest, endpoint, linkedController, OutputWatchdog, sseEvents, transportFailure } from "../shared.ts";
import { encodeRequest, OPENAI_AUDIO_MIME_TYPES, type ChatCompletionsBody } from "./encode.ts";
import { errorDetail, httpError, refusesProbedFeature, upstreamText } from "./errors.ts";

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
    return (["stream", "structuredOutput", "tools"] as const).map((flag) => ({
      flag,
      run: (opts: ProbeRunOptions) => this.runCheck(profile, modelId, flag, opts),
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
   * One probe request bounded by `LLM_PROBE_TIMEOUT_MS` as a whole. `onCall` reports it
   * once it ended past the send boundary: an answer of any status, or a failure after the
   * request left. A failure before that reports nothing.
   */
  private async runCheck(
    profile: ProviderProfile,
    modelId: string,
    flag: LlmProbeFlag,
    opts: ProbeRunOptions,
  ): Promise<{ result: "supported" | "unsupported"; latencyMs: number }> {
    const controller = linkedController(opts.signal);
    const timer = setTimeout(() => controller.abort(), LLM_PROBE_TIMEOUT_MS);
    const started = this.now();
    try {
      const response = await this.send(profile, probeBody(modelId, flag), controller.signal, opts.onRequestStart);
      const text = await response.text();
      const latencyMs = Math.max(0, this.now() - started);
      if (response.status === 200) {
        const usage = flag === "stream" ? streamUsage(text) : completionUsage(text);
        opts.onCall({ outcome: "succeeded", ...(usage === undefined ? {} : { usage }) });
        return { result: flag === "stream" || probeTookEffect(flag, text) ? "supported" : "unsupported", latencyMs };
      }
      opts.onCall({ outcome: "failed" });
      if (refusesProbedFeature(flag, response.status, text)) {
        return { result: "unsupported", latencyMs };
      }
      throw httpError(response.status, text, response.headers);
    } catch (error) {
      // Past the send boundary (an answer that broke off included) the request may have
      // been processed: it counts, with an unknown outcome.
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

/** The smallest request that exercises one capability; the cap keeps it to a few tokens. */
function probeBody(modelId: string, flag: LlmProbeFlag): ChatCompletionsBody {
  const base = { model: modelId, max_tokens: LLM_PROBE_MAX_OUTPUT_TOKENS };
  switch (flag) {
    case "stream":
      return { ...base, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Reply with OK." }] };
    case "structuredOutput":
      return {
        ...base,
        stream: false,
        // The prompt does not ask for JSON: only an enforced schema makes the answer conform.
        messages: [{ role: "user", content: "Reply with OK." }],
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
        messages: [{ role: "user", content: "Call the report_ok tool." }],
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

/** Usage of a probe's streamed answer, read from its last chunk that carries one. */
function streamUsage(text: string): RawUsage | undefined {
  let usage: RawUsage | undefined;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const data = line.startsWith("data:") ? line.slice("data:".length).trim() : undefined;
    if (data === undefined || data === DONE_SENTINEL) {
      continue;
    }
    try {
      usage = normalizeUsage(field(JSON.parse(data), "usage")) ?? usage;
    } catch {
      // A chunk that is not JSON carries no usage.
    }
  }
  // A relay that ignores `stream` answers with one JSON body instead.
  return usage ?? completionUsage(text);
}

function completionUsage(text: string): RawUsage | undefined {
  try {
    return normalizeUsage(field(JSON.parse(text), "usage"));
  } catch {
    return undefined;
  }
}
