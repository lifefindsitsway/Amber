import type { LlmProtocol } from "../../shared/enums.ts";
import type { LlmRequest, LlmStreamEvent, RawUsage } from "../domain/llm.ts";
import type { CapabilityFlags, ModelCapability, ProviderProfile } from "../domain/provider-profile.ts";
import type { RequestStartInfo, UsageOutcome } from "../domain/usage.ts";
import type { OutboundRoute } from "./outbound-http.ts";

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

/** Which part of "test connection" a check is: the plain call first, then one per flag. */
export type LlmProbeKind = "basic" | LlmProbeFlag;

/** Why a capability check could not decide. */
export type LlmProbeInconclusiveReason = "truncated" | "upstream_rejected" | "rate_limited";

/**
 * The plain non-streamed call. `connected`: an answer came back. `incomplete`: the output cap
 * cut it off before any answer text (typical of models that reason first). Any failure is
 * thrown as an AppError and fails the whole test.
 */
export interface LlmProbeBasicResult {
  kind: "basic";
  status: "connected" | "incomplete";
  latencyMs: number;
  /** The path the request actually took, from the outbound response; absent means direct. */
  route?: OutboundRoute;
}

/**
 * One capability. `supported` only when the feature visibly worked; `unsupported` when the
 * upstream explicitly rejected the parameter or feature, or ignored it; `inconclusive` when the
 * answer was cut off (`truncated`) or a 400/422 could not be classified (`upstream_rejected`).
 * Authentication, unknown model, quota, rate limit, 5xx and network failures are thrown.
 */
export interface LlmProbeFlagResult {
  kind: LlmProbeFlag;
  result: "supported" | "unsupported" | "inconclusive";
  reason?: LlmProbeInconclusiveReason;
  latencyMs: number;
}

export type LlmProbeResult = LlmProbeBasicResult | LlmProbeFlagResult;

/**
 * One check of "test connection". `onCall` fires once for every request that ended after
 * crossing the send boundary and never for a failure before it, so the caller records usage
 * per request even when a later check fails. A check sends one request, except that an
 * OpenAI-compatible check may re-send once with `max_completion_tokens` after the upstream
 * explicitly rejected `max_tokens`; the rejected request is reported through `onCall` too.
 * The LlmGateway retries a failed check on its own (never on rate limits), never the completed ones.
 */
export interface LlmProbeCheck {
  readonly kind: LlmProbeKind;
  run(opts: {
    signal: AbortSignal;
    /** As `LlmStreamOptions.onRequestStart`; called before each request sent. */
    onRequestStart(info: RequestStartInfo): void;
    onCall(call: LlmProbeCall): void;
  }): Promise<LlmProbeResult>;
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
  /** "Test connection": the basic call, then the stream, JSON and tools checks, run one by one by the LlmGateway. */
  probe(profile: ProviderProfile, modelId: string): readonly LlmProbeCheck[];
}
