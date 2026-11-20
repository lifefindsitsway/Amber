import { LLM_FIRST_OUTPUT_TIMEOUT_MS, LLM_PROBE_MAX_OUTPUT_TOKENS, LLM_PROBE_TIMEOUT_MS, LLM_STREAM_IDLE_TIMEOUT_MS } from "../../../../shared/defaults.ts";
import { amberError } from "../../../domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../domain/llm.ts";
import { effectiveCapability, type ProviderProfile } from "../../../domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../domain/usage.ts";
import type { Logger } from "../../../ports/logger.ts";
import type { LlmProbeCall, LlmProbeCheck, LlmProbeKind, LlmProbeResult, LlmProvider, LlmStreamOptions } from "../../../ports/llm-provider.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundResponse } from "../../../ports/outbound-http.ts";
import type { SecretStore } from "../../../ports/secret-store.ts";
import { beginRequest, endpoint, linkedController, OutputWatchdog, sseEvents, transportFailure } from "../shared.ts";
import { isErrorAnswer, parseResponse, ResponsesStreamReader, type ResponseOutcome, type UsageInconsistency } from "./decode.ts";
import { encodeRequest, type FunctionTool, type ResponsesBody } from "./encode.ts";
import { httpError, refusesProbedFeature } from "./errors.ts";

export interface OpenAiResponsesProviderOptions {
  http: OutboundHttpClient;
  secrets: Pick<SecretStore, "revealVersioned">;
  /** Receives `llm_usage_inconsistent` warnings; counts only, never request or answer text. */
  logger?: Logger;
  now?: () => number;
}

const PATH = "/responses";
const DONE_SENTINEL = "[DONE]";

type ProbeRunOptions = Parameters<LlmProbeCheck["run"]>[0];

/** Asks for no JSON, so only an enforced output format makes the JSON check's answer conform. */
const PROBE_PROMPT = "Reply with OK.";
const PROBE_TOOL_PROMPT = "Call the report_status tool with ok set to true.";
const PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
const PROBE_TOOL: FunctionTool = {
  type: "function",
  name: "report_status",
  description: "Reports whether the connection works.",
  parameters: PROBE_SCHEMA,
  strict: true,
};

/**
 * The OpenAI Responses protocol (OpenAI, xAI). Invariant: everything named after the wire
 * format stays in this directory; callers see `LlmRequest` and normalized events only.
 * Failures are classified, never retried here. A request is bounded by model output, not
 * by bytes on the wire (`OutputWatchdog`): lifecycle events and empty deltas do not keep
 * it alive. The protocol takes no audio input here.
 */
export class OpenAiResponsesProvider implements LlmProvider {
  readonly protocol = "openai_responses" as const;
  readonly audioMimeTypes: readonly string[] = [];
  private readonly options: OpenAiResponsesProviderOptions;
  private readonly now: () => number;
  private readonly onInconsistent: UsageInconsistency;

  constructor(options: OpenAiResponsesProviderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.onInconsistent = (fields) => this.options.logger?.warn("llm_usage_inconsistent", fields);
  }

  async *stream(request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    // `unknown` is tried as a stream; only a known refusal falls back to one plain answer.
    const streaming = effectiveCapability(opts.effectiveCapability).flags.stream !== "unsupported";
    const body = encodeRequest(request, streaming);
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
        yield* parseStream(response.body, watchdog, opts.signal, this.onInconsistent);
      } else {
        // A plain answer is the first output only once all of it has arrived.
        const outcome = parseResponse(await readText(response, opts.signal), this.onInconsistent);
        watchdog.stop();
        yield* outcomeEvents(outcome, true);
      }
    } finally {
      watchdog.stop();
      // Releases the connection when the consumer stops early or a trailing `[DONE]` is left unread.
      controller.abort();
    }
  }

  probe(profile: ProviderProfile, modelId: string): readonly LlmProbeCheck[] {
    const request: LlmRequest = {
      modelRef: { providerProfileId: profile.id, modelId },
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: PROBE_PROMPT }] }],
      maxOutputTokens: LLM_PROBE_MAX_OUTPUT_TOKENS,
    };
    const check = (kind: LlmProbeKind, body: ResponsesBody): LlmProbeCheck => ({
      kind,
      run: (opts: ProbeRunOptions) => this.runCheck(profile, kind, body, opts),
    });
    return [
      check("basic", encodeRequest(request, false)),
      // Exactly the shape of a real streamed request.
      check("stream", encodeRequest(request, true)),
      check("structuredOutput", encodeRequest({ ...request, responseFormat: { type: "json_schema", schema: PROBE_SCHEMA } }, false)),
      // Not forced through `tool_choice`: some models reject forced tool use, so the prompt asks for the call.
      check("tools", {
        ...encodeRequest({ ...request, messages: [{ role: "user", content: [{ type: "text", text: PROBE_TOOL_PROMPT }] }] }, false),
        tools: [PROBE_TOOL],
      }),
    ];
  }

  /**
   * Everything that can fail is done before the key is revealed; the request then goes out
   * with exactly the key `onRequestStart` was told about.
   */
  private send(profile: ProviderProfile, body: ResponsesBody, signal: AbortSignal, onRequestStart: (info: RequestStartInfo) => void): Promise<OutboundResponse> {
    const payload = JSON.stringify(body);
    const key = beginRequest(profile, this.options.secrets, onRequestStart, this.now);
    return this.options.http.request({
      url: endpoint(profile, PATH),
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: body.stream === true ? "text/event-stream" : "application/json",
      },
      body: payload,
      signal,
    });
  }

  /**
   * One probe request bounded by `LLM_PROBE_TIMEOUT_MS` as a whole. `onCall` reports it
   * exactly once when it ended past the send boundary: an answer of any status, or a
   * failure after the request left. A failure before that reports nothing.
   */
  private async runCheck(profile: ProviderProfile, kind: LlmProbeKind, body: ResponsesBody, opts: ProbeRunOptions): Promise<LlmProbeResult> {
    let reported = false;
    const report = (call: LlmProbeCall): void => {
      if (!reported) {
        reported = true;
        opts.onCall(call);
      }
    };
    const controller = linkedController(opts.signal);
    const timer = setTimeout(() => controller.abort(), LLM_PROBE_TIMEOUT_MS);
    const started = this.now();
    try {
      const response = await this.send(profile, body, controller.signal, opts.onRequestStart);
      const text = await response.text();
      const latencyMs = Math.max(0, this.now() - started);
      if (response.status !== 200) {
        report({ outcome: "failed" });
        return rejectedCheck(kind, response.status, text, response.headers, latencyMs);
      }
      // An endpoint that ignores `stream` answers with one JSON body: not an event stream.
      // That body is judged like any plain answer first, so an error inside it still fails.
      const eventStream = kind === "stream" && !isJsonObject(text);
      let outcome: ResponseOutcome;
      try {
        outcome = eventStream ? await streamedOutcome(text, this.onInconsistent) : parseResponse(text, this.onInconsistent);
      } catch (error) {
        // An explicit error object is a refusal. Anything unreadable (not JSON, a broken event
        // stream, one cut off before its terminal event) may still have been processed and billed.
        report({ outcome: isErrorAnswer(text) ? "failed" : "outcome_unknown" });
        throw error;
      }
      const usage = outcome.usage === undefined ? {} : { usage: outcome.usage };
      if (outcome.stopReason === "refused") {
        report({ outcome: "failed", ...usage });
        throw amberError("llm_failed", "the model refused the probe", { code: "llm_failed.refused", ...(outcome.raw === undefined ? {} : { upstreamMessage: outcome.raw }) });
      }
      if (outcome.stopReason === "error") {
        report({ outcome: "failed", ...usage });
        throw amberError("llm_failed", "responses reported a failed response", outcome.raw === undefined ? {} : { upstreamMessage: outcome.raw });
      }
      report({ outcome: "succeeded", ...usage });
      if (kind === "stream" && !eventStream) {
        return { kind, result: "unsupported", latencyMs };
      }
      return checkResult(kind, outcome, latencyMs);
    } catch (error) {
      // Past the send boundary (an answer that broke off included) the request may have
      // been processed: it counts, with an unknown outcome.
      if (error instanceof OutboundHttpError && error.phase === "after_send") {
        report({ outcome: "outcome_unknown" });
      }
      throw transportFailure(error, opts.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

/**
 * A capability check's verdict on an error answer: an explicit refusal of the probed
 * feature is `unsupported`, a bad request that names nothing it can be placed by is
 * `inconclusive`; everything else, and any error of the basic call, fails the probe.
 */
function rejectedCheck(kind: LlmProbeKind, status: number, text: string, headers: ReadonlyMap<string, string>, latencyMs: number): LlmProbeResult {
  const error = httpError(status, text, headers);
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

/**
 * A finished probe answer's verdict. The basic call is connected once anything came back,
 * and incomplete when the output cap cut it off before any text. A capability shows only
 * in the answer itself: an endpoint that silently drops `text.format` or `tools` still
 * answers, so the text must be schema-shaped JSON or the output must hold the probe's
 * function call. An answer cut off by the cap before showing it decides nothing, except for
 * the stream check: reaching a terminal event at all, `response.incomplete` included, shows
 * that streaming works.
 */
function checkResult(kind: LlmProbeKind, outcome: ResponseOutcome, latencyMs: number): LlmProbeResult {
  const truncated = outcome.stopReason === "length";
  if (kind === "basic") {
    return { kind, status: truncated && outcome.text === "" ? "incomplete" : "connected", latencyMs };
  }
  const shown =
    kind === "stream" || (kind === "tools" ? outcome.functionCalls.some((call) => call.name === PROBE_TOOL.name) : conformsToProbeSchema(outcome.text));
  if (shown) {
    return { kind, result: "supported", latencyMs };
  }
  return truncated ? { kind, result: "inconclusive", reason: "truncated", latencyMs } : { kind, result: "unsupported", latencyMs };
}

function conformsToProbeSchema(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["ok"] === "boolean";
  } catch {
    return false;
  }
}

/**
 * The outcome of a probe's streamed answer, read to its terminal event. A stream that ends
 * before a terminal event leaves the outcome unknown.
 */
async function streamedOutcome(text: string, onInconsistent: UsageInconsistency): Promise<ResponseOutcome> {
  const reader = new ResponsesStreamReader(onInconsistent);
  const body = (async function* (): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(text);
  })();
  for await (const event of sseEvents(body)) {
    if (event.data.trim() === DONE_SENTINEL) {
      break;
    }
    const step = reader.step(event.data, event.event);
    if (step.kind === "end") {
      return step.outcome;
    }
  }
  throw amberError("llm_outcome_unknown", "responses stream ended before a terminal event");
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
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

/**
 * Stream events to normalized events: `text_delta*` → `usage?` → `done`. The terminal
 * event decides how the response ended and carries its usage; anything after it, a
 * trailing `data: [DONE]` included, is not read. An `error` event or `response.failed`
 * ends it as `done` with `error`; a stream that stops before a terminal event leaves the
 * outcome unknown.
 *
 * Answer text, reasoning, refusal and function-argument deltas count as output for
 * `watchdog`; lifecycle events, empty deltas and comments do not.
 */
async function* parseStream(
  body: AsyncIterable<Uint8Array>,
  watchdog: OutputWatchdog,
  signal: AbortSignal,
  onInconsistent: UsageInconsistency,
): AsyncIterable<LlmStreamEvent> {
  const reader = new ResponsesStreamReader(onInconsistent);
  let streamed = false;
  try {
    for await (const event of sseEvents(body)) {
      if (event.data.trim() === DONE_SENTINEL) {
        break;
      }
      const step = reader.step(event.data, event.event);
      if (step.kind === "text") {
        streamed = true;
        watchdog.suspend();
        yield { type: "text_delta", delta: step.delta };
        watchdog.resume();
      } else if (step.kind === "progress") {
        watchdog.progress();
      } else if (step.kind === "end") {
        watchdog.stop();
        // An upstream that sent no text deltas still delivers the answer in the terminal event.
        yield* outcomeEvents(step.outcome, !streamed);
        return;
      }
    }
  } catch (error) {
    throw transportFailure(error, signal);
  }
  watchdog.stop();
  throw amberError("llm_outcome_unknown", "responses stream ended before a terminal event");
}

/** An outcome as the tail of the event sequence: its text (unless already streamed), usage, done. */
function* outcomeEvents(outcome: ResponseOutcome, withText: boolean): Iterable<LlmStreamEvent> {
  if (withText && outcome.text !== "") {
    yield { type: "text_delta", delta: outcome.text };
  }
  if (outcome.usage !== undefined) {
    yield { type: "usage", usage: outcome.usage };
  }
  yield { type: "done", stopReason: outcome.stopReason, ...(outcome.raw === undefined ? {} : { raw: outcome.raw }) };
}
