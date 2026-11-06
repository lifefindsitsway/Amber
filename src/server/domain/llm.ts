import type { TokenUsageFeature } from "../../shared/enums.ts";
import type { ModelRef } from "./model-ref.ts";

export type LlmContentPart = { type: "text"; text: string } | { type: "audio"; mimeType: string; dataRef: string };

/**
 * Invariant: the LLM boundary. Services build only this
 * request and consume only `LlmStreamEvent`; protocol types stay inside
 * `adapters/llm/<protocol>/`.
 */
export interface LlmRequest {
  modelRef: ModelRef;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: LlmContentPart[] }>;
  responseFormat?: { type: "json_schema"; schema: unknown };
  maxOutputTokens?: number;
  /** Omitted entirely when absent: some relays reject optional parameters for certain models. */
  optional?: { temperature?: number };
}

/** Token counts normalized by the adapter, plus the provider's raw usage JSON for auditing. */
export interface RawUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** All cache writes, including the one-hour part. */
  cacheWriteTokens?: number;
  /** Only when the upstream reports one-hour cache writes separately; never faked as 0. */
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  rawJson: string;
}

/**
 * How a call ended. `refused` is a model's safety policy declining the request (Anthropic
 * `refusal`, OpenAI-compatible `content_filter`): any text already streamed is incomplete.
 */
export type LlmStopReason = "stop" | "length" | "error" | "refused" | "aborted";

export type LlmStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "usage"; usage: RawUsage }
  | { type: "done"; stopReason: LlmStopReason; raw?: string };

/** What one LLM call is for and attributed to; the model is the request's `modelRef`. */
export interface LlmCallAttribution {
  userId: string;
  feature: TokenUsageFeature;
  taskId?: string;
  workUnitId?: string;
  contentId?: string;
  chatMessageId?: string;
}

/** A finished call collected into text; `invocationId` is the id of its TokenUsage row. */
export interface LlmCompletion {
  invocationId: string;
  text: string;
  stopReason: LlmStopReason;
  usage?: RawUsage;
}
