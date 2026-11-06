import type { LlmProtocol } from "../../shared/enums.ts";
import type { LlmRequest, LlmStreamEvent, RawUsage } from "../domain/llm.ts";
import type { CapabilityFlags, ModelCapability, ProviderProfile } from "../domain/provider-profile.ts";
import type { RequestStartInfo, UsageOutcome } from "../domain/usage.ts";

export interface LlmStreamOptions {
  signal: AbortSignal;
  /** Capability decisions come only from here, never from the model name. */
  effectiveCapability: ModelCapability;
  /** Endpoint and credential reference; the key is revealed per call and dropped after it. */
  profile: ProviderProfile;
  /**
   * Called once per request, after the adapter revealed the key it will send and right
   * before sending it; the request must use exactly that key. Not called when building the
   * request or revealing the key fails. A throw means "do not send" and propagates unchanged.
   */
  onRequestStart(info: RequestStartInfo): void;
}

/** A "test connection" request that crossed the send boundary, reported once it ended. */
export interface LlmProbeCall {
  outcome: UsageOutcome;
  /** Absent when the upstream returned no usage; never faked as zero. */
  usage?: RawUsage;
}

/** The capability flags "test connection" measures; the rest are never probed. */
export type LlmProbeFlag = Extract<keyof CapabilityFlags, "stream" | "structuredOutput" | "tools">;

/**
 * One check of "test connection": exactly one upstream request. `onCall` fires once when
 * that request ended after crossing the send boundary and never for a failure before it,
 * so the caller records usage per request even when a later check fails. A check never
 * retries; the LlmGateway retries a failed check on its own, never the completed ones.
 */
export interface LlmProbeCheck {
  readonly flag: LlmProbeFlag;
  /**
   * `unsupported` only when the upstream explicitly rejected the parameter or feature;
   * every other failure (authentication, quota, unknown model, other 4xx, 5xx, network)
   * is thrown as an AppError and nothing is learned.
   */
  run(opts: {
    signal: AbortSignal;
    /** As `LlmStreamOptions.onRequestStart`. */
    onRequestStart(info: RequestStartInfo): void;
    onCall(call: LlmProbeCall): void;
  }): Promise<{ result: "supported" | "unsupported"; latencyMs: number }>;
}

/**
 * Invariant: the LLM boundary. One adapter per wire protocol, normalized to `LlmRequest` and
 * `LlmStreamEvent`. Adapters only classify failures into AppErrors carrying their retry
 * disposition and never retry or re-send; `outcome_unknown` surfaces to the caller.
 * Calls reach adapters only through the LlmGateway.
 */
export interface LlmProvider {
  readonly protocol: LlmProtocol;
  /** Audio input formats this protocol can encode; empty means no audio input at all. */
  readonly audioMimeTypes: readonly string[];
  /**
   * `text_delta*` → `usage?` → `done` (exactly once, last). `done.stopReason = "error"`
   * only reports an error the upstream sent inside a stream that had started, and
   * `"refused"` a safety refusal with its category and explanation in `raw`; transport,
   * protocol and HTTP errors are thrown as AppErrors. Cancellation through `opts.signal`
   * rethrows the transport's `OutboundHttpError` (reason `aborted`) unchanged: its `phase`
   * tells the caller whether the request had been sent and may be billed.
   */
  stream(request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent>;
  /** "Test connection": the stream, JSON and tools checks, run one by one by the LlmGateway. */
  probe(profile: ProviderProfile, modelId: string): readonly LlmProbeCheck[];
}
