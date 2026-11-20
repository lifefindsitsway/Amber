import { amberError } from "../../../domain/errors.ts";
import type { LlmStopReason, RawUsage } from "../../../domain/llm.ts";
import type { LogFields } from "../../../ports/logger.ts";
import { errorFields, keptText, upstreamText } from "./errors.ts";

/** Reports token counts that add up neither with nor without reasoning; fields are counts only. */
export type UsageInconsistency = (fields: LogFields) => void;

/** A function call the model made, with its final arguments. */
export interface FunctionCall {
  name: string;
  arguments: string;
}

/** How a response ended, normalized. `text` is all `output_text` of its message items, in order. */
export interface ResponseOutcome {
  text: string;
  stopReason: LlmStopReason;
  raw?: string;
  usage?: RawUsage;
  functionCalls: FunctionCall[];
}

type JsonRecord = Record<string, unknown>;

const INCOMPLETE_LENGTH_REASON = "max_output_tokens";

const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** Parsed JSON object of an answer or stream event; anything else breaks the protocol. */
export function parseObject(data: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw amberError("llm_failed", "malformed responses payload");
  }
  const object = record(parsed);
  if (object === undefined) {
    throw amberError("llm_failed", "malformed responses payload");
  }
  return object;
}

/**
 * Upstream usage to `RawUsage`. `input_tokens` already includes cached tokens, reported as
 * a breakdown. Whether `output_tokens` includes reasoning differs between upstreams (OpenAI
 * counts it in, xAI does not), so the totals decide, never the vendor: when input and
 * output add up to the total, output is taken as is; when only adding the reasoning
 * tokens does, they are added to it; when neither does, output is taken as is and the
 * mismatch reported. Without a total nothing can be checked. A usage missing input or
 * output is none; cost fields are ignored.
 */
export function normalizeUsage(raw: unknown, onInconsistent?: UsageInconsistency): RawUsage | undefined {
  const usage = record(raw);
  const input = count(usage?.["input_tokens"]);
  const output = count(usage?.["output_tokens"]);
  if (usage === undefined || input === undefined || output === undefined) {
    return undefined;
  }
  const cacheReadTokens = count(record(usage["input_tokens_details"])?.["cached_tokens"]);
  const reasoningTokens = count(record(usage["output_tokens_details"])?.["reasoning_tokens"]);
  const total = count(usage["total_tokens"]);
  let outputTokens = output;
  if (total !== undefined && input + output !== total) {
    if (reasoningTokens !== undefined && reasoningTokens > 0 && input + output + reasoningTokens === total) {
      outputTokens = output + reasoningTokens;
    } else {
      onInconsistent?.({ inputTokens: input, outputTokens: output, reasoningTokens: reasoningTokens ?? null, totalTokens: total });
    }
  }
  return {
    inputTokens: input,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    rawJson: JSON.stringify(raw),
  };
}

/** `refusal: <explanation>`, sanitized and capped, as `done.raw` of a refused answer. */
function refusalRaw(explanation: string): string {
  return keptText(`refusal: ${explanation}`) ?? "refusal";
}

/**
 * A whole Response object as an outcome. Output items are read in order and only the
 * `output_text` parts of `message` items make the text; reasoning and every other item
 * type are skipped. A `refusal` part makes the answer refused, whatever else it holds.
 * `refusalSeen` carries a refusal a stream announced before its terminal event.
 */
export function responseOutcome(response: JsonRecord, onInconsistent?: UsageInconsistency, refusalSeen?: string): ResponseOutcome {
  const items = Array.isArray(response["output"]) ? (response["output"] as unknown[]) : [];
  let text = "";
  let refusal = refusalSeen;
  const functionCalls: FunctionCall[] = [];
  for (const item of items.map(record)) {
    if (item?.["type"] === "function_call" && typeof item["name"] === "string") {
      functionCalls.push({ name: item["name"], arguments: typeof item["arguments"] === "string" ? item["arguments"] : "" });
    }
    if (item?.["type"] !== "message" || !Array.isArray(item["content"])) {
      continue;
    }
    for (const part of (item["content"] as unknown[]).map(record)) {
      if (part?.["type"] === "output_text" && typeof part["text"] === "string") {
        text += part["text"];
      } else if (part?.["type"] === "refusal") {
        refusal = typeof part["refusal"] === "string" ? part["refusal"] : (refusal ?? "");
      }
    }
  }
  const usage = normalizeUsage(response["usage"], onInconsistent);
  return { text, ...stopOf(response, refusal), ...(usage === undefined ? {} : { usage }), functionCalls };
}

/**
 * The stop reason of a finished response. A failure is an error; a refusal wins over how
 * the response otherwise ended; running out of output tokens is `length` and any other
 * incomplete reason is an error. A response without a status counts as completed.
 */
function stopOf(response: JsonRecord, refusal: string | undefined): { stopReason: LlmStopReason; raw?: string } {
  const status = typeof response["status"] === "string" ? response["status"] : "completed";
  if (status === "failed") {
    const upstream = upstreamText(errorFields(response["error"]));
    return { stopReason: "error", ...(upstream === undefined ? {} : { raw: upstream }) };
  }
  if (refusal !== undefined) {
    return { stopReason: "refused", raw: refusalRaw(refusal) };
  }
  if (status === "completed") {
    return { stopReason: "stop", raw: status };
  }
  if (status === "incomplete") {
    const reason = record(response["incomplete_details"])?.["reason"];
    if (reason === INCOMPLETE_LENGTH_REASON) {
      return { stopReason: "length", raw: reason };
    }
    return { stopReason: "error", raw: typeof reason === "string" ? (keptText(`incomplete: ${reason}`) ?? status) : status };
  }
  // `cancelled`, `queued`, `in_progress`: no finished answer came back.
  return { stopReason: "error", raw: keptText(status) ?? "unknown" };
}

/**
 * A non-streamed answer. A body that is only an `{ error }` object (as some relays answer
 * with status 200) fails the call; a failed Response is reported as an outcome like a
 * stream's `response.failed`.
 */
export function parseResponse(body: string, onInconsistent?: UsageInconsistency): ResponseOutcome {
  const parsed = parseObject(body);
  if (isErrorObject(parsed)) {
    const upstream = upstreamText(errorFields(parsed));
    throw amberError("llm_failed", "responses answered with an error object", upstream === undefined ? {} : { upstreamMessage: upstream });
  }
  return responseOutcome(parsed, onInconsistent);
}

/** A body that is only an `{ error }` object rather than a Response. */
function isErrorObject(parsed: JsonRecord): boolean {
  return parsed["status"] === undefined && parsed["output"] === undefined && parsed["error"] !== undefined && parsed["error"] !== null;
}

/** Whether an answer body is an explicit error object: the upstream refused, rather than answered unreadably. */
export function isErrorAnswer(body: string): boolean {
  try {
    const parsed = record(JSON.parse(body));
    return parsed !== undefined && isErrorObject(parsed);
  } catch {
    return false;
  }
}

/** What one stream event means to the caller. */
export type StreamStep =
  | { kind: "text"; delta: string }
  /** Model output that is not answer text (reasoning, refusal, function arguments): it keeps the request alive. */
  | { kind: "progress" }
  | { kind: "ignored" }
  /** A terminal event: nothing after it matters, a trailing `[DONE]` included. */
  | { kind: "end"; outcome: ResponseOutcome };

const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["response.completed", "response.incomplete", "response.failed"]);
const PROGRESS_DELTAS: ReadonlySet<string> = new Set([
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
]);

/**
 * Reads a Responses event stream one event at a time. The terminal event carries the whole
 * Response, whose output items hold the final values (function arguments may have been
 * streamed in pieces or in one chunk). Upstreams that leave the output out of the terminal
 * event fall back to the items each `response.output_item.done` delivered, in output order.
 */
export class ResponsesStreamReader {
  private readonly onInconsistent: UsageInconsistency | undefined;
  private readonly doneItems = new Map<number, unknown>();
  private refusal: string | undefined;

  constructor(onInconsistent?: UsageInconsistency) {
    this.onInconsistent = onInconsistent;
  }

  step(data: string, eventName?: string): StreamStep {
    const event = parseObject(data);
    const type = typeof event["type"] === "string" ? event["type"] : eventName;
    if (type === "response.output_text.delta") {
      const delta = event["delta"];
      return typeof delta === "string" && delta !== "" ? { kind: "text", delta } : { kind: "ignored" };
    }
    if (type !== undefined && PROGRESS_DELTAS.has(type)) {
      const delta = event["delta"];
      if (type === "response.refusal.delta") {
        this.refusal = (this.refusal ?? "") + (typeof delta === "string" ? delta : "");
      }
      return typeof delta === "string" && delta !== "" ? { kind: "progress" } : { kind: "ignored" };
    }
    if (type === "response.refusal.done") {
      this.refusal = typeof event["refusal"] === "string" ? event["refusal"] : (this.refusal ?? "");
      return { kind: "ignored" };
    }
    if (type === "response.output_item.done") {
      const index = count(event["output_index"]);
      if (index !== undefined) {
        this.doneItems.set(index, event["item"]);
      }
      return { kind: "ignored" };
    }
    if (type === "error") {
      const upstream = upstreamText(errorFields(event));
      return { kind: "end", outcome: { text: "", stopReason: "error", ...(upstream === undefined ? {} : { raw: upstream }), functionCalls: [] } };
    }
    if (type !== undefined && TERMINAL_EVENTS.has(type)) {
      const response = record(event["response"]) ?? {};
      const output = Array.isArray(response["output"]) && response["output"].length > 0 ? response["output"] : this.itemsInOrder();
      // A terminal event names how the response ended even when its status field is missing.
      const status = typeof response["status"] === "string" ? response["status"] : type.slice("response.".length);
      return { kind: "end", outcome: responseOutcome({ ...response, status, output }, this.onInconsistent, this.refusal) };
    }
    return { kind: "ignored" };
  }

  private itemsInOrder(): unknown[] {
    return [...this.doneItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  }
}
