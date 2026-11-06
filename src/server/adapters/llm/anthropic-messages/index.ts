import {
  LLM_FIRST_OUTPUT_TIMEOUT_MS,
  LLM_MAX_OUTPUT_TOKENS_DEFAULT,
  LLM_PROBE_MAX_OUTPUT_TOKENS,
  LLM_PROBE_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_MS,
} from "../../../../shared/defaults.ts";
import { amberError } from "../../../domain/errors.ts";
import type { LlmRequest, LlmStopReason, LlmStreamEvent, RawUsage } from "../../../domain/llm.ts";
import { effectiveCapability, type EffectiveCapability, type ProviderProfile } from "../../../domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../domain/usage.ts";
import type { LlmProbeCall, LlmProbeCheck, LlmProbeFlag, LlmProvider, LlmStreamOptions } from "../../../ports/llm-provider.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundResponse } from "../../../ports/outbound-http.ts";
import type { SecretStore } from "../../../ports/secret-store.ts";
import { beginRequest, endpoint, linkedController, OutputWatchdog, sseEvents, transportFailure, withIdleTimeout, type SseEvent } from "../shared.ts";
import { errorDetail, httpError, rejectsFeature, upstreamText } from "./errors.ts";

/** The API version every request pins (Messages API versioning). */
const ANTHROPIC_VERSION = "2023-06-01";
const MESSAGES_PATH = "/v1/messages";
/** Asks for no JSON, so only an enforced output format makes the JSON check's answer conform. */
const PROBE_PROMPT = "Reply with OK.";
const PROBE_TOOL_PROMPT = "Call the report_status tool with ok set to true.";
const PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
const PROBE_TOOL = {
  name: "report_status",
  description: "Reports whether the connection works.",
  input_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};

export interface AnthropicMessagesProviderOptions {
  http: OutboundHttpClient;
  secrets: Pick<SecretStore, "revealVersioned">;
  now?: () => number;
}

/** Wire usage as the Messages API reports it; later events repeat or extend earlier ones. */
interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Cache writes by lifetime; only the one-hour share is read. */
  cache_creation?: { ephemeral_1h_input_tokens?: unknown };
  [field: string]: unknown;
}

type WireBody = Record<string, unknown>;

/**
 * The Anthropic Messages protocol. Invariant: everything named after the wire format
 * stays in this directory; callers see `LlmRequest` and `LlmStreamEvent` only. The
 * Messages API takes no audio input, and `max_tokens` is required, so
 * it is always sent: the request's value, else the model's effective limit, else
 * `LLM_MAX_OUTPUT_TOKENS_DEFAULT`. A request is bounded by model output, not by bytes on
 * the wire (`OutputWatchdog`): pings keep a connection open but do not keep it alive.
 */
export class AnthropicMessagesProvider implements LlmProvider {
  readonly protocol = "anthropic_messages";
  readonly audioMimeTypes: readonly string[] = [];
  private readonly options: AnthropicMessagesProviderOptions;
  private readonly now: () => number;

  constructor(options: AnthropicMessagesProviderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async *stream(request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    const effective = effectiveCapability(opts.effectiveCapability);
    const streaming = effective.flags.stream !== "unsupported";
    const body = requestBody(request, effective, streaming);
    const controller = linkedController(opts.signal);
    const watchdog = new OutputWatchdog(controller, { firstMs: LLM_FIRST_OUTPUT_TIMEOUT_MS, idleMs: LLM_STREAM_IDLE_TIMEOUT_MS });
    let finished = false;
    try {
      let response: OutboundResponse;
      watchdog.start();
      try {
        response = await this.request(opts.profile, body, controller.signal, opts.onRequestStart, undefined);
      } catch (error) {
        throw transportFailure(error, opts.signal);
      }
      if (response.status !== 200) {
        throw httpError(response.status, await readText(response, opts.signal), response.headers);
      }
      if (streaming) {
        yield* normalizedStream(sseEvents(response.body), opts.signal, watchdog);
      } else {
        // A plain answer is the first output only once all of it has arrived.
        const text = await readText(response, opts.signal);
        watchdog.stop();
        yield* fromMessage(text);
      }
      finished = true;
    } finally {
      watchdog.stop();
      // A consumer that stops early must not leave the connection streaming.
      if (!finished) {
        controller.abort();
      }
    }
  }

  probe(profile: ProviderProfile, modelId: string): readonly LlmProbeCheck[] {
    const base: WireBody = {
      model: modelId,
      max_tokens: LLM_PROBE_MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: [{ type: "text", text: PROBE_PROMPT }] }],
    };
    const check = (flag: LlmProbeFlag, body: WireBody, streaming: boolean): LlmProbeCheck => ({
      flag,
      run: (opts) => this.probeOnce(profile, flag, body, streaming, opts),
    });
    return [
      check("stream", { ...base, stream: true }, true),
      check("structuredOutput", { ...base, output_config: { format: { type: "json_schema", schema: PROBE_SCHEMA } } }, false),
      // Not forced through `tool_choice`: several Claude models reject forced tool use
      // (`tool_choice` `any` or `tool` is an error), so the prompt asks for the call instead.
      check("tools", { ...base, messages: [{ role: "user", content: [{ type: "text", text: PROBE_TOOL_PROMPT }] }], tools: [PROBE_TOOL] }, false),
    ];
  }

  /** One probe request; `onCall` reports it once it ended past the send boundary. */
  private async probeOnce(
    profile: ProviderProfile,
    flag: LlmProbeFlag,
    body: WireBody,
    streaming: boolean,
    opts: Parameters<LlmProbeCheck["run"]>[0],
  ): Promise<{ result: "supported" | "unsupported"; latencyMs: number }> {
    const { signal } = opts;
    let reported = false;
    const report = (call: LlmProbeCall): void => {
      if (!reported) {
        reported = true;
        opts.onCall(call);
      }
    };
    const controller = linkedController(signal);
    const startedAt = this.now();
    let response: OutboundResponse;
    try {
      response = await this.request(profile, body, controller.signal, opts.onRequestStart, LLM_PROBE_TIMEOUT_MS);
    } catch (error) {
      // Only a request that reached the upstream in full can have been processed.
      if (error instanceof OutboundHttpError && error.phase === "after_send") {
        report({ outcome: "outcome_unknown" });
      }
      throw transportFailure(error, signal);
    }
    try {
      if (response.status !== 200) {
        const text = await readBounded(response, controller, signal);
        report({ outcome: "failed" });
        if (rejectsFeature(response.status, text, flag)) {
          return { result: "unsupported", latencyMs: this.now() - startedAt };
        }
        throw httpError(response.status, text, response.headers);
      }
      let usage: RawUsage | undefined;
      let stopReason: LlmStopReason = "stop";
      let raw: string | undefined;
      const body = streaming ? undefined : await readBounded(response, controller, signal);
      const events =
        body === undefined
          ? normalizedStream(withIdleTimeout(sseEvents(response.body), LLM_PROBE_TIMEOUT_MS, () => controller.abort()), signal)
          : fromMessage(body);
      for await (const event of events) {
        if (event.type === "usage") {
          usage = event.usage;
        } else if (event.type === "done") {
          stopReason = event.stopReason;
          raw = event.raw;
        }
      }
      if (stopReason === "error") {
        report({ outcome: "failed", ...(usage === undefined ? {} : { usage }) });
        throw amberError("llm_failed", "stream reported an error", raw === undefined ? {} : { upstreamMessage: raw });
      }
      if (stopReason === "refused") {
        report({ outcome: "failed", ...(usage === undefined ? {} : { usage }) });
        throw amberError("llm_failed", "the model refused the probe", { code: "llm_failed.refused", ...(raw === undefined ? {} : { upstreamMessage: raw }) });
      }
      report({ outcome: "succeeded", ...(usage === undefined ? {} : { usage }) });
      const tookEffect = body === undefined || flag === "stream" || probeTookEffect(flag, body);
      return { result: tookEffect ? "supported" : "unsupported", latencyMs: this.now() - startedAt };
    } catch (error) {
      // Anything failing after the answer began leaves the request's outcome unknown.
      report({ outcome: "outcome_unknown" });
      throw error;
    } finally {
      controller.abort();
    }
  }

  /**
   * One request through the transport; failures are the transport's own. Everything that
   * can fail is done before the key is revealed; the request then goes out with exactly the
   * key `onRequestStart` was told about.
   */
  private request(
    profile: ProviderProfile,
    body: WireBody,
    signal: AbortSignal,
    onRequestStart: (info: RequestStartInfo) => void,
    timeoutMs: number | undefined,
  ): Promise<OutboundResponse> {
    const payload = JSON.stringify(body);
    const headers = {
      "x-api-key": beginRequest(profile, this.options.secrets, onRequestStart, this.now),
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      accept: body["stream"] === true ? "text/event-stream" : "application/json",
    };
    return this.options.http.request({
      url: endpoint(profile, MESSAGES_PATH),
      method: "POST",
      headers,
      body: payload,
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }
}

/**
 * The wire body. Optional parameters are left out entirely when unset, never sent as
 * null: some relays reject them for some models.
 */
export function requestBody(request: LlmRequest, effective: EffectiveCapability, streaming: boolean): WireBody {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) => {
      if (part.type !== "text") {
        throw amberError("llm_capability", "the messages protocol has no audio input");
      }
      return { type: "text", text: part.text };
    }),
  }));
  return {
    model: request.modelRef.modelId,
    max_tokens: request.maxOutputTokens ?? effective.limits.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS_DEFAULT,
    ...(request.system === "" ? {} : { system: request.system }),
    messages,
    ...(streaming ? { stream: true } : {}),
    ...(request.optional?.temperature === undefined ? {} : { temperature: request.optional.temperature }),
    ...(request.responseFormat === undefined
      ? {}
      : { output_config: { format: { type: "json_schema", schema: request.responseFormat.schema } } }),
  };
}

/**
 * Normalizes a Messages event stream: text deltas as they come, then one `usage` merged
 * from `message_start` and `message_delta`, then `done`. A stream that ends before
 * `message_stop` may have been processed, so its outcome is unknown.
 *
 * With a `watchdog`, non-empty `text_delta` and `thinking_delta` count as model output;
 * `ping`, `message_start`, block boundaries and an empty `thinking_delta` (thinking with
 * display omitted) do not. Thinking is not passed on.
 */
async function* normalizedStream(
  events: AsyncIterable<SseEvent>,
  callerSignal: AbortSignal,
  watchdog?: OutputWatchdog,
): AsyncIterable<LlmStreamEvent> {
  const usage: WireUsage = {};
  let sawUsage = false;
  let stopReason: string | undefined;
  let stopDetails: unknown;
  try {
    for await (const event of events) {
      const data = parseEventData(event.data);
      switch (data["type"]) {
        case "message_start": {
          const message = data["message"] as { usage?: WireUsage } | undefined;
          sawUsage = mergeUsage(usage, message?.usage) || sawUsage;
          break;
        }
        case "content_block_delta": {
          const delta = data["delta"] as { type?: string; text?: unknown; thinking?: unknown } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
            watchdog?.suspend();
            yield { type: "text_delta", delta: delta.text };
            watchdog?.resume();
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
            watchdog?.progress();
          }
          break;
        }
        case "message_delta": {
          const delta = data["delta"] as { stop_reason?: unknown; stop_details?: unknown } | undefined;
          if (typeof delta?.stop_reason === "string") {
            stopReason = delta.stop_reason;
            stopDetails = delta.stop_details;
          }
          sawUsage = mergeUsage(usage, data["usage"] as WireUsage | undefined) || sawUsage;
          break;
        }
        case "message_stop": {
          watchdog?.stop();
          const normalized = sawUsage ? toRawUsage(usage) : undefined;
          if (normalized !== undefined) {
            yield { type: "usage", usage: normalized };
          }
          yield { type: "done", ...stopOf(stopReason, stopDetails) };
          return;
        }
        case "error": {
          watchdog?.stop();
          const upstream = upstreamText(errorDetail(event.data));
          yield { type: "done", stopReason: "error", ...(upstream === undefined ? {} : { raw: upstream }) };
          return;
        }
        default:
          // ping, content_block_start / _stop and future event types carry nothing to normalize.
          break;
      }
    }
  } catch (error) {
    throw transportFailure(error, callerSignal);
  }
  throw amberError("llm_outcome_unknown", "event stream ended before message_stop");
}

/**
 * Whether a successful JSON or tools probe shows the feature at work: an
 * endpoint that silently drops `output_config.format` or `tools` still answers 200, so the
 * answer must be schema-shaped JSON or contain the probe's tool call.
 */
function probeTookEffect(flag: Exclude<LlmProbeFlag, "stream">, text: string): boolean {
  const message = parseEventData(text) as { content?: unknown };
  const blocks = Array.isArray(message.content) ? (message.content as Array<{ type?: unknown; text?: unknown; name?: unknown }>) : [];
  if (flag === "tools") {
    return blocks.some((block) => block.type === "tool_use" && block.name === PROBE_TOOL.name);
  }
  const joined = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  try {
    const parsed: unknown = JSON.parse(joined);
    return typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["ok"] === "boolean";
  } catch {
    return false;
  }
}

/** A non-streaming answer as the same event sequence: one delta, usage, done. */
function* fromMessage(text: string): Iterable<LlmStreamEvent> {
  const message = parseEventData(text) as { content?: unknown; stop_reason?: unknown; stop_details?: unknown; usage?: WireUsage };
  const blocks = Array.isArray(message.content) ? (message.content as Array<{ type?: unknown; text?: unknown }>) : [];
  const joined = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  if (joined !== "") {
    yield { type: "text_delta", delta: joined };
  }
  const usage: WireUsage = {};
  if (mergeUsage(usage, message.usage)) {
    const normalized = toRawUsage(usage);
    if (normalized !== undefined) {
      yield { type: "usage", usage: normalized };
    }
  }
  yield { type: "done", ...stopOf(typeof message.stop_reason === "string" ? message.stop_reason : undefined, message.stop_details) };
}

/** Event data or a whole answer; unparsable data from a 200 answer leaves the outcome unknown. */
function parseEventData(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the error below.
  }
  throw amberError("llm_outcome_unknown", "unparsable messages API data");
}

function mergeUsage(target: WireUsage, source: WireUsage | undefined): boolean {
  if (typeof source !== "object" || source === null) {
    return false;
  }
  let merged = false;
  for (const [field, value] of Object.entries(source)) {
    if (value !== null && value !== undefined) {
      target[field] = value;
      merged = true;
    }
  }
  return merged;
}

/**
 * Normalized counts: `inputTokens` is every input token processed, cache reads and
 * writes included, the same meaning as OpenAI's `prompt_tokens`; the cache counts are
 * kept as a breakdown when reported. `cache_creation` is merged whole like every other
 * field, so a later event's breakdown replaces an earlier one's, as its totals do.
 */
function toRawUsage(usage: WireUsage): RawUsage | undefined {
  const { input_tokens: input, output_tokens: output } = usage;
  if (typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }
  const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined;
  const cacheWrite = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens;
  const cacheWrite1h = typeof oneHour === "number" && Number.isInteger(oneHour) && oneHour >= 0 ? oneHour : undefined;
  return {
    inputTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens: output,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1hTokens: cacheWrite1h }),
    rawJson: JSON.stringify(usage),
  };
}

/**
 * Hitting the output or context limit is `length`, a safety classifier's decline is
 * `refused`; every other way the turn ended is `stop`.
 */
function stopOf(stopReason: string | undefined, stopDetails?: unknown): { stopReason: LlmStopReason; raw?: string } {
  if (stopReason === "refusal") {
    return { stopReason: "refused", raw: refusalText(stopDetails) };
  }
  const normalized: LlmStopReason = stopReason === "max_tokens" || stopReason === "model_context_window_exceeded" ? "length" : "stop";
  return { stopReason: normalized, ...(stopReason === undefined ? {} : { raw: stopReason }) };
}

/**
 * `refusal: <category> — <explanation>` from a refusal's `stop_details`. Both fields may be
 * null (a refusal outside the named categories), and the explanation is for display only.
 */
function refusalText(stopDetails: unknown): string {
  const details = typeof stopDetails === "object" && stopDetails !== null ? (stopDetails as Record<string, unknown>) : {};
  const category = typeof details["category"] === "string" && details["category"] !== "" ? details["category"] : "unspecified";
  const explanation = typeof details["explanation"] === "string" ? details["explanation"].trim() : "";
  return explanation === "" ? `refusal: ${category}` : `refusal: ${category} — ${explanation}`;
}

async function readText(response: OutboundResponse, callerSignal: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw transportFailure(error, callerSignal);
  }
}

/** A whole body, failing with an unknown outcome when the upstream stalls past the idle limit. */
async function readBounded(response: OutboundResponse, controller: AbortController, callerSignal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of withIdleTimeout(response.body, LLM_PROBE_TIMEOUT_MS, () => controller.abort())) {
      chunks.push(chunk);
    }
  } catch (error) {
    throw transportFailure(error, callerSignal);
  }
  return Buffer.concat(chunks).toString("utf8");
}
