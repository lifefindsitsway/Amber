import type { TokenUsageFeature, AsrUsageFeature } from "../../../src/shared/enums.ts";
import type { UsageResult } from "../../../src/shared/dto/usage-analytics.ts";
import type { FixtureCall, FixtureGroup, FixtureModel, FixturePrice, FixtureProfile } from "./types.ts";

const BEIJING_OFFSET_HOURS = 8;

/** A moment in Beijing time. Months count from 1. */
export function beijing(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return Date.UTC(year, month - 1, day, hour - BEIJING_OFFSET_HOURS, minute, second);
}

/** The server's "now" in every scenario: 2026-11-06 10:00 Beijing time. */
export const SCENARIO_NOW = beijing(2026, 11, 6, 10);

/** Small deterministic generator, so a scenario is the same on every run. */
export function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function profile(id: string, modality: "llm" | "asr", name: string | null, versions: Array<[string, number]>, deleted = false): FixtureProfile {
  return { id, modality, name, deleted, versions: versions.map(([versionId, setAt]) => ({ id: versionId, setAt })) };
}

export function model(owner: FixtureProfile, modelId: string, currentPrice: FixturePrice | null): FixtureModel {
  return { profile: owner, modelId, currentPrice };
}

export function group(id: string, kind: FixtureGroup["kind"], title: string | null, contentId: string | null): FixtureGroup {
  return {
    id,
    kind,
    title,
    contentId,
    taskId: kind === "task" ? `task-${id}` : null,
    chatMessageId: kind === "chat" ? `message-${id}` : null,
  };
}

let sequence = 0;

export interface LlmCallOptions {
  input: number;
  output: number;
  cacheRead?: number;
  reasoning?: number;
  result?: UsageResult;
  version?: string | null;
  price?: FixturePrice | null;
}

/** One LLM call. A failed or unknown call carries no usage unless it is given. */
export function llmCall(owner: FixtureGroup, target: FixtureModel, feature: TokenUsageFeature, at: number, options: LlmCallOptions): FixtureCall {
  sequence += 1;
  const result = options.result ?? "succeeded";
  const version = options.version === undefined ? (target.profile.versions.at(-1)?.id ?? null) : options.version;
  const price = options.price === undefined ? target.currentPrice : options.price;
  return {
    id: `call-${String(sequence).padStart(5, "0")}`,
    model: target,
    version,
    feature,
    at,
    result,
    group: owner,
    ...(result === "succeeded" || options.input > 0
      ? {
          llm: {
            input: options.input,
            output: options.output,
            ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
            ...(options.cacheRead === undefined ? {} : { cacheRead: options.cacheRead }),
          },
        }
      : {}),
    price,
  };
}

export interface AsrCallOptions {
  audioMs: number;
  billedInput?: number;
  billedOutput?: number;
  billedAudioMs?: number;
  result?: UsageResult;
  accepted?: boolean;
  feature?: AsrUsageFeature;
  version?: string | null;
  price?: FixturePrice | null;
}

export function asrCall(owner: FixtureGroup, target: FixtureModel, at: number, options: AsrCallOptions): FixtureCall {
  sequence += 1;
  const version = options.version === undefined ? (target.profile.versions.at(-1)?.id ?? null) : options.version;
  return {
    id: `call-${String(sequence).padStart(5, "0")}`,
    model: target,
    version,
    feature: options.feature ?? "transcribe",
    at,
    result: options.result ?? "succeeded",
    ...(options.accepted === true ? { accepted: true } : {}),
    group: owner,
    asr: {
      audioMs: options.audioMs,
      ...(options.billedInput === undefined ? {} : { billedInput: options.billedInput }),
      ...(options.billedOutput === undefined ? {} : { billedOutput: options.billedOutput }),
      ...(options.billedAudioMs === undefined ? {} : { billedAudioMs: options.billedAudioMs }),
    },
    price: options.price === undefined ? target.currentPrice : options.price,
  };
}

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
