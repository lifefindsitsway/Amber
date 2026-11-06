import type { UsageGranularity, UsageModality } from "../../shared/dto/usage-analytics.ts";
import type {
  UsageActivityKey,
  UsageActivityRow,
  UsageBucketRow,
  UsageCallRow,
  UsageCurrentPricing,
  UsageIdentityRow,
  UsageProfileName,
  UsageScope,
} from "../domain/usage-analytics.ts";

/**
 * Read side of the usage tables. Every method takes the owner and answers from that owner's
 * rows only. LLM and ASR calls are normalized into one row shape and aggregated where the
 * data lives: the grouped methods return a bounded number of integer sums per group of
 * calls, never the calls themselves (except `calls`, which reads one activity).
 */
export interface UsageAnalyticsRepository {
  /**
   * One row per Beijing-time bucket, model, credential version, price snapshot, quantity
   * presence and result: the groups the whole summary is computed from.
   */
  groupsByBucket(scope: UsageScope, granularity: UsageGranularity): UsageBucketRow[];
  /** Request counts per model and credential version, for the filter menus. */
  identities(scope: UsageScope): UsageIdentityRow[];
  /** Time of the earliest call matching the scope, ignoring its time bounds; `null` when there is none. */
  earliest(scope: UsageScope): number | null;
  /** Currency codes found in the owner's price snapshots over all time, as written. */
  currencies(owner: string): string[];
  /** Names of the owner's profiles that still exist. */
  profileNames(owner: string): UsageProfileName[];
  /** The name the newest call recorded for each of the given profiles; for profiles that no longer exist. */
  recordedProfileNames(owner: string, profiles: ReadonlyArray<{ modality: UsageModality; profileId: string }>): UsageProfileName[];
  /** The prices the owner's existing profiles currently hold per model. */
  currentPricing(owner: string): UsageCurrentPricing[];
  /** One page of the activities in scope, newest first, and how many there are in all. */
  activityKeys(scope: UsageScope, page: { limit: number; offset: number }): { total: number; items: UsageActivityKey[] };
  /** The groups of the calls of the given activities (which `activityKeys` returned for the same scope). */
  activityGroups(scope: UsageScope, items: readonly UsageActivityKey[]): UsageActivityRow[];
  /** Display titles of the owner's contents that exist; absent ids and untitled contents map to `null`. */
  contentTitles(owner: string, contentIds: readonly string[]): ReadonlyMap<string, string | null>;
  /** Every call of one activity in scope, oldest first; empty for a key that matches nothing. */
  calls(scope: UsageScope, key: string): UsageCallRow[];
  /** LLM models whose usage ever reported a cache read. */
  cacheObserved(owner: string): Array<{ profileId: string; modelId: string }>;
}
