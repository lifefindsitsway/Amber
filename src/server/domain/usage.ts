import type { AsrUsageFeature, TokenUsageFeature } from "../../shared/enums.ts";
import type { PriceSnapshot } from "../../shared/model-pricing.ts";
import type { ModelRefSnapshot } from "./model-ref.ts";

/**
 * A usage row records a call that crossed the send boundary, not a successful response:
 * `outcome_unknown` calls may have been billed and are recorded too.
 */
export type UsageOutcome = "succeeded" | "failed" | "outcome_unknown";

/**
 * Reported by an adapter right before a paid request is sent. The send time and the version
 * of the key about to be sent come from the same moment, so a key replaced or a price edited
 * while the call was queued is recorded as it stood when the request left.
 */
export interface RequestStartInfo {
  sentAt: number;
  credential: { versionId: string; setAt: number };
}

/** The remote end state of an ASR job as the provider reported it; unrelated to local failures. */
export type AsrJobOutcome = "succeeded" | "failed" | "cancelled";

/** One row per LLM call, attributed many-to-one to an artifact revision, task or message. */
export interface TokenUsage {
  id: string;
  userId: string;
  modelRef: ModelRefSnapshot;
  /** Filter columns copied out of `modelRef`; they outlive the profile. Absent on older rows. */
  providerProfileId?: string;
  modelId?: string;
  feature: TokenUsageFeature;
  taskId?: string;
  workUnitId?: string;
  artifactRevisionId?: string;
  chatMessageId?: string;
  contentId?: string;
  outcome: UsageOutcome;
  /** Absent when the upstream returned no usage or the stream broke; never faked as 0. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** All cache writes, including the one-hour part. */
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  /** When the request left, from `RequestStartInfo`; older rows have none and fall back to `createdAt`. */
  sentAt?: number;
  credentialVersion?: string;
  credentialSetAt?: number;
  /** The model's price when the request was sent; absent when none was set or reading it failed. */
  priceSnapshot?: PriceSnapshot;
  rawUsageJson?: string;
  createdAt: number;
}

/** One row per ASR submission (a Task's or a model test's), measured in audio time. */
export interface AsrUsage {
  id: string;
  userId: string;
  /** Cleared when the profile is deleted; `provider` / `model` remain as the snapshot. */
  asrProfileId?: string;
  /** Written at call time, never changed by renaming or deleting the profile. Absent on older rows whose link was already cleared. */
  profileIdSnapshot?: string;
  profileNameSnapshot?: string;
  provider: string;
  model: string;
  feature: AsrUsageFeature;
  /** Outcome of the request itself (a sync transcription or the job-creating request). */
  outcome: UsageOutcome;
  /** Job-type providers only. */
  jobId?: string;
  /** Only from the provider's reported remote end state; unset means unknown (still running, or an older row). */
  jobOutcome?: AsrJobOutcome;
  /** Locally measured audio duration; not the billing basis. */
  audioMs: number;
  /** Quantities the upstream billed, when it reported them. */
  billedInputTokens?: number;
  billedOutputTokens?: number;
  billedAudioMs?: number;
  sentAt?: number;
  credentialVersion?: string;
  credentialSetAt?: number;
  priceSnapshot?: PriceSnapshot;
  taskId?: string;
  contentId?: string;
  /** The upstream usage object, metering fields only; never a key, signature or URL. */
  rawUsageJson?: string;
  createdAt: number;
}
