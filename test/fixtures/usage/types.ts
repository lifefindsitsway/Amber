import type { TokenUsageFeature, AsrUsageFeature } from "../../../src/shared/enums.ts";
import type { PriceCurrency } from "../../../src/shared/model-pricing.ts";
import type { UsageActivityKind, UsageModality, UsageResult } from "../../../src/shared/dto/usage-analytics.ts";

/**
 * Synthetic usage data for the usage page's tests and screenshots. A scenario lists calls; the
 * engine derives every response from them, so the summary, the chart, the model view and the
 * records always agree, whatever the filters.
 */

/** A frozen price: what a call was sent under. Amounts are per million tokens, per second or per request. */
export interface FixturePrice {
  currency: PriceCurrency;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  /** ASR billed-token prices. */
  billedInputPerMillion?: number;
  billedOutputPerMillion?: number;
  audioPerSecond?: number;
  perRequest?: number;
}

export interface FixtureVersion {
  id: string;
  setAt: number;
}

export interface FixtureProfile {
  id: string;
  modality: UsageModality;
  /** `null` for historic transcription rows whose profile cannot be told apart. */
  name: string | null;
  deleted: boolean;
  versions: FixtureVersion[];
}

export interface FixtureModel {
  profile: FixtureProfile;
  modelId: string;
  /** The price the settings hold now; simulation applies it to calls that were never priced. */
  currentPrice: FixturePrice | null;
}

export interface FixtureGroup {
  id: string;
  kind: UsageActivityKind;
  title: string | null;
  contentId: string | null;
  taskId: string | null;
  chatMessageId: string | null;
}

export interface FixtureCall {
  id: string;
  model: FixtureModel;
  /** A credential version id of the profile; `null` for a record from before versions were kept. */
  version: string | null;
  feature: TokenUsageFeature | AsrUsageFeature;
  at: number;
  result: UsageResult;
  /** An ASR job that was accepted but has no remote outcome yet. */
  accepted?: boolean;
  group: FixtureGroup;
  llm?: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
  asr?: { audioMs: number; billedInput?: number; billedOutput?: number; billedAudioMs?: number };
  /** The price frozen onto the call; `null` when none was recorded. */
  price: FixturePrice | null;
}

export interface FixtureScenario {
  id: string;
  /** The moment the server treats as "now" when it resolves a preset range. */
  now: number;
  calls: FixtureCall[];
  /** Models whose calls ever reported a cache read, for the price dialog hint. */
  cacheObserved: FixtureModel[];
  /** Answers every request after this many milliseconds. */
  delayMs?: number;
  /** Answers every usage request with a 500. */
  failing?: boolean;
}
