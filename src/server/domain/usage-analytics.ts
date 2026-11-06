import type { UsageModality, UsageResult } from "../../shared/dto/usage-analytics.ts";

/**
 * Which priced quantities of a request are above zero. A request is left out of the cost
 * estimate when a positive quantity has no price, so the bits take part in grouping: rows
 * sharing a price snapshot and a bitmap stand or fall together.
 *
 * `input` is the normal input of an LLM request (input minus cache reads and writes) or the
 * billed input tokens of a transcription; `output` is the output or billed output tokens.
 */
export const USAGE_COMPONENT = {
  input: 1,
  cacheRead: 2,
  cacheWrite: 4,
  cacheWrite1h: 8,
  output: 16,
} as const;

/** What the upstream did and did not report; part of grouping for the same reason as the components. */
export const USAGE_FLAG = {
  /** An LLM request whose input and output were both not reported. */
  usageAbsent: 1,
  /** An LLM request that reported output but an input of zero. */
  inputMissing: 2,
  /** An LLM request whose usage carried a cache read or write field. */
  cacheReported: 4,
  /** A transcription whose upstream reported billed tokens. */
  billedTokens: 8,
  /** A transcription whose upstream reported a billed duration. */
  billedAudio: 16,
  /** An ASR job that was created successfully and has no remote outcome yet. */
  accepted: 32,
} as const;

/** Beijing time (UTC+8, no daylight saving) is the one time zone usage is bucketed in. */
export const USAGE_UTC_OFFSET_MS = 8 * 3_600_000;

/**
 * The slice of the owner's calls an analysis looks at. Time is a half-open interval on the
 * time a call is attributed to (`COALESCE(sent_at, created_at)`).
 */
export interface UsageScope {
  owner: string;
  from?: number;
  to?: number;
  modality?: UsageModality;
  profile?: { modality: UsageModality; profileId: string };
  model?: { modality: UsageModality; profileId: string; modelId: string };
  /** A credential version id, or `null` for calls recorded before versions were kept. */
  credentialVersion?: string | null;
  /**
   * Only the calls an activity can hold. A lookup hint for reading one activity cheaply;
   * the activity's key is still checked exactly by the caller.
   */
  narrow?: UsageActivityIdentity;
}

/** Integer sums of a group of calls; `bigint` because token and millisecond sums outgrow a double. */
export interface UsageMeasures {
  requests: bigint;
  /** LLM: reported input including cache reads and writes. ASR: billed input tokens. */
  rawInput: bigint;
  /** The priced input: LLM normal input, or billed input tokens. */
  input: bigint;
  /** LLM output, or ASR billed output tokens. */
  output: bigint;
  reasoning: bigint;
  cacheRead: bigint;
  /** Cache writes without the one-hour part. */
  cacheWrite: bigint;
  cacheWrite1h: bigint;
  audioBilledMs: bigint;
  audioLocalMs: bigint;
  /** Latest time attributed to a call of the group. */
  lastAt: number;
}

/** What a group of calls shares: the snapshot the estimate comes from, and the quantities' presence. */
export interface UsageClassFields {
  snapshotJson: string | null;
  /** `USAGE_COMPONENT` bits. */
  bitmap: number;
  /** `USAGE_FLAG` bits. */
  flags: number;
  result: UsageResult;
}

export interface UsageModelDims {
  modality: UsageModality;
  /** Empty for historic transcriptions whose profile cannot be told apart. */
  profileId: string;
  modelId: string;
}

export type UsageGroupRow = UsageModelDims &
  UsageClassFields &
  UsageMeasures & {
    /** `null` for calls recorded before credential versions were kept. */
    credentialVersion: string | null;
    /** When the version took effect (the latest of the group's calls); `null` when unknown. */
    credentialSetAt: number | null;
  };

/** A group of one Beijing-time bucket. */
export type UsageBucketRow = UsageGroupRow & { bucketStart: number };

export type UsageActivityRow = UsageGroupRow & {
  /** The server-built identity of the activity, JSON text. */
  key: string;
  feature: string;
  /** Any content the activity's calls name. */
  contentId: string | null;
};

export interface UsageCallRow extends UsageGroupRow {
  id: string;
  occurredAt: number;
  feature: string;
}

export interface UsageIdentityRow {
  modality: UsageModality;
  profileId: string;
  modelId: string;
  credentialVersion: string | null;
  credentialSetAt: number | null;
  requests: number;
}

export interface UsageProfileName {
  modality: UsageModality;
  profileId: string;
  name: string;
}

export interface UsageCurrentPricing {
  modality: UsageModality;
  profileId: string;
  modelId: string;
  /** Raw JSON of the pricing; `null` when the model has no price. */
  pricingJson: string | null;
}

/** One entry of the activity list before its calls are read: identity and time span. */
export interface UsageActivityKey {
  /** The key text of the identity, see `activityKeyText`. */
  key: string;
  startedAt: number;
  endedAt: number;
}

/** The identity of an activity, as the parts its key is made of. */
export type UsageActivityIdentity =
  | { kind: "task"; taskId: string }
  | { kind: "chat"; chatMessageId: string }
  | { kind: "test"; modality: UsageModality; profileId: string; modelId: string; minute: number }
  | { kind: "content_day"; contentId: string; feature: string; day: string }
  | { kind: "deleted_day"; modality: UsageModality; feature: string; day: string };

function isModality(value: unknown): value is UsageModality {
  return value === "llm" || value === "asr";
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Reads the JSON text an activity key is made of. `undefined` for anything that is not the
 * exact shape of one of the five identities, so a forged or damaged key never reaches a query.
 */
export function parseActivityIdentity(keyText: string): UsageActivityIdentity | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(keyText);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const [kind, a, b, c, d, ...rest] = parts as unknown[];
  if (rest.length > 0) {
    return undefined;
  }
  if (kind === "task" && isText(a) && b === undefined) {
    return { kind, taskId: a };
  }
  if (kind === "chat" && isText(a) && b === undefined) {
    return { kind, chatMessageId: a };
  }
  if (kind === "test" && isModality(a) && typeof b === "string" && typeof c === "string" && typeof d === "number" && Number.isInteger(d)) {
    return { kind, modality: a, profileId: b, modelId: c, minute: d };
  }
  if (kind === "content_day" && isText(a) && isText(b) && isText(c) && d === undefined) {
    return { kind, contentId: a, feature: b, day: c };
  }
  if (kind === "deleted_day" && isModality(a) && isText(b) && isText(c) && d === undefined) {
    return { kind, modality: a, feature: b, day: c };
  }
  return undefined;
}

/** The text an activity is keyed by; `parseActivityIdentity` is its inverse. */
export function activityKeyText(identity: UsageActivityIdentity): string {
  switch (identity.kind) {
    case "task":
      return JSON.stringify(["task", identity.taskId]);
    case "chat":
      return JSON.stringify(["chat", identity.chatMessageId]);
    case "test":
      return JSON.stringify(["test", identity.modality, identity.profileId, identity.modelId, identity.minute]);
    case "content_day":
      return JSON.stringify(["content_day", identity.contentId, identity.feature, identity.day]);
    case "deleted_day":
      return JSON.stringify(["deleted_day", identity.modality, identity.feature, identity.day]);
  }
}

/** The columns an activity is grouped by; unused parts are empty, as the database computes them. */
export interface UsageActivityParts {
  kind: UsageActivityIdentity["kind"];
  a: string;
  b: string;
  c: string;
  d: number;
}

export function activityPartsOf(identity: UsageActivityIdentity): UsageActivityParts {
  switch (identity.kind) {
    case "task":
      return { kind: "task", a: identity.taskId, b: "", c: "", d: 0 };
    case "chat":
      return { kind: "chat", a: identity.chatMessageId, b: "", c: "", d: 0 };
    case "test":
      return { kind: "test", a: identity.modality, b: identity.profileId, c: identity.modelId, d: identity.minute };
    case "content_day":
      return { kind: "content_day", a: identity.contentId, b: identity.feature, c: identity.day, d: 0 };
    case "deleted_day":
      return { kind: "deleted_day", a: identity.modality, b: identity.feature, c: identity.day, d: 0 };
  }
}

/** The identity the grouping columns stand for. */
export function identityOfParts(parts: UsageActivityParts): UsageActivityIdentity {
  switch (parts.kind) {
    case "task":
      return { kind: "task", taskId: parts.a };
    case "chat":
      return { kind: "chat", chatMessageId: parts.a };
    case "test":
      return { kind: "test", modality: parts.a as UsageModality, profileId: parts.b, modelId: parts.c, minute: parts.d };
    case "content_day":
      return { kind: "content_day", contentId: parts.a, feature: parts.b, day: parts.c };
    case "deleted_day":
      return { kind: "deleted_day", modality: parts.a as UsageModality, feature: parts.b, day: parts.c };
  }
}
