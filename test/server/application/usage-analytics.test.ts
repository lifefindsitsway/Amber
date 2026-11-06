import { describe, expect, it } from "vitest";
import { SqliteUsageAnalyticsRepository } from "../../../src/server/adapters/sqlite/repositories/usage-analytics.ts";
import { UsageAnalyticsService } from "../../../src/server/application/usage-analytics.ts";
import { decodeGroup, encodeGroup } from "../../../src/server/application/usage-activities.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { PriceCurrency } from "../../../src/shared/model-pricing.ts";
import { USAGE_CHART_SERIES_MAX } from "../../../src/shared/defaults.ts";
import {
  encodeModelKey,
  encodeProfileKey,
  USAGE_LEGACY_CREDENTIAL,
  USAGE_UNPRICED_REASONS,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
} from "../../../src/shared/dto/usage-analytics.ts";
import {
  DAY,
  HOUR,
  insertAsrProfile,
  insertAsrUsage,
  insertChatMessage,
  insertContent,
  insertLlmProfile,
  insertLlmUsage,
  insertTask,
  MONDAY,
  NOW,
  OTHER_OWNER,
  OWNER,
  principalOf,
  usageDb,
} from "../../fixtures/usage/rows.ts";
import { generateCalls, insertCalls, referenceCell, type ReferenceCall } from "../../fixtures/usage/reference.ts";

/** Palette slots that colour a model individually; models past them share the grey one. */
const SERIES_COLOR_COUNT = 8;

const CNY = (unit: string, amount: string) => ({ currency: "CNY", items: [{ unit, amount }] });
const TOKENS = {
  currency: "CNY",
  items: [
    { unit: "input_tokens_per_million", amount: "2" },
    { unit: "output_tokens_per_million", amount: "8" },
  ],
};

function setup() {
  const { db } = usageDb();
  const service = new UsageAnalyticsService({ repository: new SqliteUsageAnalyticsRepository(db), now: () => NOW });
  const summary = (query: Partial<UsageSummaryQuery> = {}, user = OWNER) =>
    service.summary(principalOf(user), { range: "30d", displayCurrency: "CNY", ...query } as UsageSummaryQuery);
  return { db, service, summary };
}

function failure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("display currency", () => {
  it("never filters counts or usage, marks the other currency and keeps unknown-currency calls out of the denominators", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "cny", sentAt: NOW - HOUR, input: 1_000_000, output: 0, snapshot: TOKENS });
    insertLlmUsage(db, { id: "usd", sentAt: NOW - HOUR, input: 3_000_000, output: 0, snapshot: { ...TOKENS, currency: "USD" } });
    insertLlmUsage(db, { id: "old", sentAt: NOW - HOUR, input: 5_000_000, output: 0 });

    const inCny = summary({ displayCurrency: "CNY" });
    const inUsd = summary({ displayCurrency: "USD" });

    expect(inCny.summary.requests).toBe(3);
    expect(inUsd.summary.requests).toBe(3);
    expect(inCny.summary.usage).toEqual(inUsd.summary.usage);
    expect(inCny.summary.cost).toEqual({ amount: { currency: "CNY", amount: "2" }, counted: 1, inCurrency: 1, otherCurrency: 1, unknownCurrency: 1, topReason: null });
    expect(inUsd.summary.cost).toEqual({ amount: { currency: "USD", amount: "6" }, counted: 1, inCurrency: 1, otherCurrency: 1, unknownCurrency: 1, topReason: null });
    // Only the request priced in the display currency is in the coverage denominator.
    expect(inCny.costDetail.coverage.llmTokens).toEqual({ counted: "1000000", total: "1000000" });
    expect(inUsd.costDetail.coverage.llmTokens).toEqual({ counted: "3000000", total: "3000000" });
    expect(inCny.currencies).toEqual(["CNY", "USD"]);
  });

  it("lists the currencies of the whole history, unfiltered", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "ancient", sentAt: NOW - 400 * DAY, input: 1, output: 1, snapshot: { ...TOKENS, currency: "USD" } });
    insertLlmUsage(db, { id: "recent", sentAt: NOW - HOUR, input: 1, output: 1, snapshot: TOKENS });
    expect(summary({ range: "24h", modality: "asr" }).currencies).toEqual(["CNY", "USD"]);
  });

  it("reports calls with no snapshot as unknown currency and explains an empty cell with it", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "a", sentAt: NOW - HOUR, input: 10, output: 1 });
    const { summary: totals, costDetail } = summary();
    expect(totals.cost).toMatchObject({ amount: null, counted: 0, inCurrency: 0, unknownCurrency: 1, topReason: "no_snapshot" });
    expect(costDetail.unpriced).toEqual([expect.objectContaining({ reason: "no_snapshot", requests: 1 })]);
  });
});

describe("the two modalities", () => {
  it("never sum LLM and ASR tokens into one figure", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "l", sentAt: NOW - HOUR, input: 100, output: 20 });
    insertAsrUsage(db, { id: "a", sentAt: NOW - HOUR, audioMs: 61_000, billedInput: 7, billedOutput: 3 });
    const { summary: totals, series } = summary();
    expect(totals.usage).toEqual({
      llm: { input: "100", output: "20", reasoning: "0", cacheRead: "0", cacheWrite: "0", cacheWrite1h: "0" },
      asr: { audioMs: "61000", billedInputTokens: "7", billedOutputTokens: "3" },
    });
    const total = (metric: string) => series.find((entry) => entry.metric === metric)!.buckets.reduce((sum, bucket) => sum + Number(bucket.total), 0);
    expect(total("llm_tokens")).toBe(120);
    expect(total("asr_billed_tokens")).toBe(10);
    expect(total("audio")).toBe(61_000);
    expect(total("requests")).toBe(2);
  });

  it("shows a modality with no calls as null", () => {
    const { db, summary } = setup();
    insertAsrUsage(db, { id: "a", sentAt: NOW - HOUR, audioMs: 1000 });
    expect(summary().summary.usage.llm).toBeNull();
  });

  it("keeps the same model id apart across profiles and modalities, and a model filter never serves another", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "1", profileId: "p-1", modelId: "shared", sentAt: NOW - HOUR, input: 1, output: 1 });
    insertLlmUsage(db, { id: "2", profileId: "p-2", modelId: "shared", sentAt: NOW - HOUR, input: 10, output: 1 });
    insertAsrUsage(db, { id: "3", profileId: "p-1", modelId: "shared", sentAt: NOW - HOUR, audioMs: 5 });
    const all = summary();
    expect(all.models).toHaveLength(3);
    expect(new Set(all.models.map((model) => model.modelKey)).size).toBe(3);

    const one = summary({ modelKey: encodeModelKey(["llm", "p-2", "shared"]) });
    expect(one.models.map((model) => model.modelKey)).toEqual([encodeModelKey(["llm", "p-2", "shared"])]);
    expect(one.summary.requests).toBe(1);
    expect(one.summary.usage.llm?.input).toBe("10");
    expect(one.summary.usage.asr).toBeNull();
    // The menus ignore the model filter so that every choice stays switchable.
    expect(one.options.models).toHaveLength(3);
  });

  it("filters by the legacy credential marker", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "1", sentAt: NOW - HOUR, input: 1, output: 1, credentialVersion: "v1", credentialSetAt: 5 });
    insertLlmUsage(db, { id: "2", sentAt: NOW - HOUR, input: 2, output: 1 });
    const profileKey = encodeProfileKey(["llm", "p-1"]);
    expect(summary({ profileKey, credentialVersion: USAGE_LEGACY_CREDENTIAL }).summary.usage.llm?.input).toBe("2");
    expect(summary({ profileKey, credentialVersion: "v1" }).summary.usage.llm?.input).toBe("1");
    // Both versions, the one used most recently first.
    expect(summary({ profileKey }).models[0]?.credentialVersions).toHaveLength(2);
  });

  it("rejects keys this server did not issue", () => {
    const { summary } = setup();
    expect(failure(() => summary({ profileKey: "not-a-key" })).class).toBe("invalid_request");
    expect(failure(() => summary({ modelKey: encodeProfileKey(["llm", "p"]) })).class).toBe("invalid_request");
  });
});

describe("summary specifics", () => {
  it("resolves presets to [now - span, now) and an all-time range from the earliest matching call", () => {
    const { db, summary } = setup();
    expect(summary({ range: "24h" }).range).toEqual({ preset: "24h", from: NOW - DAY, to: NOW });
    expect(summary({ range: "7d" }).range).toEqual({ preset: "7d", from: NOW - 7 * DAY, to: NOW });
    const empty = summary({ range: "all" });
    expect(empty.range).toEqual({ preset: "all", from: null, to: NOW });
    expect(empty.series.every((entry) => entry.buckets.length === 0)).toBe(true);
    insertLlmUsage(db, { id: "a", sentAt: NOW - 90 * DAY, modelId: "old", input: 1, output: 1 });
    insertLlmUsage(db, { id: "b", sentAt: NOW - 2 * DAY, modelId: "new", input: 1, output: 1 });
    expect(summary({ range: "all" }).range.from).toBe(NOW - 90 * DAY);
    expect(summary({ range: "all", modelKey: encodeModelKey(["llm", "p-1", "new"]) }).range.from).toBe(NOW - 2 * DAY);
  });

  it("includes a call at the start of the range and excludes one at its end", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "at-start", modelId: "start", sentAt: NOW - DAY, input: 1, output: 1 });
    insertLlmUsage(db, { id: "at-end", modelId: "end", sentAt: NOW, input: 1, output: 1 });
    expect(summary({ range: "24h" }).models.map((model) => model.modelId)).toEqual(["start"]);
  });

  it("buckets in Beijing time by send time, even when the row was recorded after midnight", () => {
    const { db, summary } = setup();
    const thursday = MONDAY + 3 * DAY;
    insertLlmUsage(db, { id: "late", modelId: "m", sentAt: thursday + DAY - 1000, createdAt: thursday + DAY + 5000, input: 1, output: 1 });
    const requests = summary({ range: "7d", granularity: "day" }).series.find((entry) => entry.metric === "requests")!;
    expect(requests.series).toHaveLength(1);
    const populated = requests.buckets.filter((bucket) => bucket.total !== "0");
    expect(populated).toEqual([{ start: thursday, end: thursday + DAY, values: ["1"], total: "1" }]);
  });

  it("returns contiguous buckets including empty ones, aligned to Beijing boundaries", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "a", sentAt: NOW - HOUR, input: 1, output: 1 });
    const { series, granularity } = summary({ range: "24h" });
    expect(granularity).toBe("hour");
    const buckets = series[0]!.buckets;
    expect(buckets).toHaveLength(24);
    expect(buckets[0]!.start).toBeLessThanOrEqual(NOW - DAY);
    expect(buckets.at(-1)!.end).toBeGreaterThanOrEqual(NOW);
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index]!.start).toBe(buckets[index - 1]!.end);
    }
    for (const bucket of buckets) {
      expect((bucket.start + 8 * HOUR) % HOUR).toBe(0);
    }
  });

  it("starts weeks on Monday and months on the first", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "sunday", modelId: "m", sentAt: MONDAY + 6 * DAY + 23 * HOUR, input: 1, output: 1 });
    insertLlmUsage(db, { id: "monday", modelId: "m", sentAt: MONDAY + 7 * DAY, input: 1, output: 1 });
    const weeks = summary({ range: "custom", from: MONDAY - DAY, to: MONDAY + 10 * DAY, granularity: "week" }).series.find((entry) => entry.metric === "requests")!;
    expect(weeks.buckets.map((bucket) => [bucket.start, bucket.total])).toEqual([
      [MONDAY - 7 * DAY, "0"],
      [MONDAY, "1"],
      [MONDAY + 7 * DAY, "1"],
    ]);
    const months = summary({ range: "custom", from: MONDAY - DAY, to: MONDAY + 10 * DAY, granularity: "month" }).series[0]!.buckets;
    expect(months).toHaveLength(1);
    expect(months[0]!.start).toBe(Date.UTC(2026, 7, 31, 16));
    expect(months[0]!.end).toBe(Date.UTC(2026, 8, 30, 16));
  });

  it("defaults the granularity by range and refuses one that is too fine, suggesting the finest that fits", () => {
    const { summary } = setup();
    expect(summary({ range: "24h" }).granularity).toBe("hour");
    expect(summary({ range: "7d" }).granularity).toBe("day");
    expect(summary({ range: "30d" }).granularity).toBe("day");
    expect(summary({ range: "all" }).granularity).toBe("month");
    expect(summary({ range: "custom", from: 0, to: 3 * DAY }).granularity).toBe("hour");
    expect(summary({ range: "30d" }).allowedGranularities).toEqual(["day", "week", "month"]);
    expect(summary({ range: "7d" }).allowedGranularities).toEqual(["hour", "day", "week", "month"]);

    const refused = failure(() => summary({ range: "30d", granularity: "hour" }));
    expect(refused).toMatchObject({ class: "invalid_request", code: "invalid_request.usage_granularity", details: { suggestedGranularity: "day" } });
    const tooLong = failure(() => summary({ range: "custom", from: 0, to: 1000 * DAY, granularity: "day" }));
    expect(tooLong.details).toEqual({ suggestedGranularity: "week" });
    const beyondWeeks = failure(() => summary({ range: "custom", from: 0, to: 2000 * DAY, granularity: "week" }));
    expect(beyondWeeks.details).toEqual({ suggestedGranularity: "month" });
  });
});

describe("chart series", () => {
  function manyModels(count: number) {
    const { db, summary } = setup();
    for (let index = 0; index < count; index += 1) {
      // The first model is the busiest; each following one has one request fewer.
      for (let call = 0; call < count - index; call += 1) {
        insertLlmUsage(db, { id: `m${index}-${call}`, modelId: `model-${index}`, sentAt: NOW - HOUR, input: 10, output: 1 });
      }
    }
    return summary();
  }

  it("keeps the top models of each metric and merges the rest, without an other series when nothing merges", () => {
    const few = manyModels(USAGE_CHART_SERIES_MAX);
    expect(few.series.find((entry) => entry.metric === "requests")!.series.map((entry) => entry.colorKey)).not.toContain("other");

    const many = manyModels(USAGE_CHART_SERIES_MAX + 3);
    const requests = many.series.find((entry) => entry.metric === "requests")!;
    expect(requests.series).toHaveLength(USAGE_CHART_SERIES_MAX + 1);
    expect(requests.series.at(-1)).toEqual({ key: "other", modelKey: null, colorKey: "other" });
    const bucket = requests.buckets.find((entry) => entry.total !== "0")!;
    const sum = (values: string[]) => values.reduce((total, value) => total + Number(value), 0);
    expect(sum(bucket.values)).toBe(Number(bucket.total));
    expect(Number(bucket.values.at(-1))).toBe(3 + 2 + 1);
  });

  it("gives a model one colour in every metric, the model table and the options", () => {
    const { models, series } = manyModels(SERIES_COLOR_COUNT + 3);
    const colours = new Map(models.map((model) => [model.modelKey, model.colorKey]));
    for (const entry of series) {
      for (const item of entry.series) {
        if (item.modelKey !== null) {
          expect(item.colorKey, `${entry.metric} ${item.modelKey}`).toBe(colours.get(item.modelKey));
        }
      }
    }
    expect(models.filter((model) => model.colorKey === "other")).toHaveLength(3);
    expect(new Set(models.filter((model) => model.colorKey !== "other").map((model) => model.colorKey)).size).toBe(models.length - 3);
  });

  it("is the same on a second request", () => {
    const { db, summary } = setup();
    for (let index = 0; index < 5; index += 1) {
      insertLlmUsage(db, { id: `u${index}`, modelId: `model-${index}`, sentAt: NOW - HOUR, input: 10, output: 1 });
    }
    expect(summary().models.map((model) => [model.modelKey, model.colorKey])).toEqual(summary().models.map((model) => [model.modelKey, model.colorKey]));
  });
});

describe("results and quality markers", () => {
  it("counts an unknown result as its own kind and an ASR job by its remote end state", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "ok", sentAt: NOW - HOUR, input: 1, output: 1 });
    insertLlmUsage(db, { id: "failed", sentAt: NOW - HOUR, outcome: "failed" });
    insertLlmUsage(db, { id: "unknown", sentAt: NOW - HOUR, outcome: "outcome_unknown" });
    insertAsrUsage(db, { id: "cancelled", sentAt: NOW - HOUR, jobId: "j1", jobOutcome: "cancelled" });
    insertAsrUsage(db, { id: "remote-failed", sentAt: NOW - HOUR, jobId: "j2", jobOutcome: "failed" });
    insertAsrUsage(db, { id: "accepted", sentAt: NOW - HOUR, jobId: "j3" });
    insertAsrUsage(db, { id: "accepted-too", sentAt: NOW - HOUR, jobId: "j4", outcome: "succeeded" });
    insertAsrUsage(db, { id: "sync-ok", sentAt: NOW - HOUR });
    const { summary: totals } = summary();
    expect(totals.results).toEqual({ succeeded: 4, failed: 2, outcome_unknown: 1, cancelled: 1 });
    expect(totals.acceptedRequests).toBe(2);
  });

  it("marks requests that returned output but no input and leaves them out of the cache share", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "ok", sentAt: NOW - HOUR, input: 100, output: 10, cacheRead: 40 });
    insertLlmUsage(db, { id: "missing", sentAt: NOW - HOUR, input: 0, output: 50, cacheRead: 0 });
    insertLlmUsage(db, { id: "plain", sentAt: NOW - HOUR, input: 100, output: 10 });
    const { summary: totals } = summary();
    expect(totals.inputMissingRequests).toBe(1);
    expect(totals.cacheHit).toEqual({ cacheRead: "40", reportedInput: "100", reportedRequests: 1, llmRequests: 3 });
  });

  it("has no cache share when no call reported cache fields", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "plain", sentAt: NOW - HOUR, input: 100, output: 10 });
    expect(summary().summary.cacheHit).toBeNull();
  });

  it("counts a failed or unknown call without usage as unpriced for its own reason, not as a failure of the estimate", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "u", sentAt: NOW - HOUR, outcome: "outcome_unknown", snapshot: TOKENS });
    insertLlmUsage(db, { id: "f", sentAt: NOW - HOUR, outcome: "failed", snapshot: TOKENS });
    insertLlmUsage(db, { id: "s", sentAt: NOW - HOUR, outcome: "succeeded", snapshot: TOKENS });
    insertLlmUsage(db, { id: "m", sentAt: NOW - HOUR, input: 0, output: 5, snapshot: TOKENS });
    const reasons = Object.fromEntries(summary().costDetail.unpriced.map((entry) => [entry.reason, entry.requests]));
    expect(reasons).toEqual({ unknown_without_usage: 1, failed_without_usage: 1, usage_missing: 1, input_missing: 1 });
  });

  it("counts a per-request-only snapshot even for a call that never returned usage", () => {
    const { db, summary } = setup();
    insertLlmUsage(db, { id: "a", sentAt: NOW - HOUR, outcome: "outcome_unknown", snapshot: CNY("per_request", "0.25") });
    insertAsrUsage(db, { id: "b", sentAt: NOW - HOUR, outcome: "failed", snapshot: CNY("per_request", "0.5") });
    const { cost } = summary().summary;
    expect(cost).toMatchObject({ amount: { currency: "CNY", amount: "0.75" }, counted: 2, inCurrency: 2 });
  });
});

describe("options and names", () => {
  it("cover the time range only, name profiles by their current name, and mark deleted ones", () => {
    const { db, summary } = setup();
    insertLlmProfile(db, "p-1", { name: "Renamed", models: [{ modelId: "model-a" }] });
    insertAsrProfile(db, "ap-live", { name: "Live Scribe" });
    insertLlmUsage(db, { id: "live", profileId: "p-1", profileName: "Old name", sentAt: NOW - HOUR, input: 1, output: 1, credentialVersion: "v1", credentialSetAt: 50 });
    insertLlmUsage(db, { id: "gone", profileId: "p-gone", profileName: "Deleted Relay", sentAt: NOW - HOUR, input: 1, output: 1 });
    insertAsrUsage(db, { id: "a-live", profileId: "ap-live", profileName: "Stale", sentAt: NOW - HOUR });
    insertAsrUsage(db, { id: "a-gone", profileId: "ap-gone", profileName: "Deleted Scribe", sentAt: NOW - HOUR });
    insertAsrUsage(db, { id: "a-unknown", profileId: null, profileName: null, sentAt: NOW - HOUR });
    insertLlmUsage(db, { id: "outside", profileId: "p-outside", sentAt: NOW - 100 * DAY, input: 1, output: 1 });

    const { options, models } = summary({ modality: "llm", profileKey: encodeProfileKey(["llm", "p-1"]) });
    const byKey = new Map(options.profiles.map((profile) => [profile.profileKey, profile]));
    expect(options.profiles).toHaveLength(5);
    expect(byKey.get(encodeProfileKey(["llm", "p-1"]))).toMatchObject({
      profileName: "Renamed",
      deleted: false,
      versions: [{ credentialVersion: "v1", setAt: 50, requests: 1 }],
    });
    expect(byKey.get(encodeProfileKey(["llm", "p-gone"]))).toMatchObject({ profileName: "Deleted Relay", deleted: true });
    expect(byKey.get(encodeProfileKey(["asr", "ap-live"]))).toMatchObject({ profileName: "Live Scribe", deleted: false });
    expect(byKey.get(encodeProfileKey(["asr", "ap-gone"]))).toMatchObject({ profileName: "Deleted Scribe", deleted: true });
    expect(byKey.get(encodeProfileKey(["asr", ""]))).toMatchObject({ profileName: null, deleted: false, versions: [{ credentialVersion: USAGE_LEGACY_CREDENTIAL, setAt: null, requests: 1 }] });
    expect(byKey.has(encodeProfileKey(["llm", "p-outside"]))).toBe(false);
    // The model table follows the filters.
    expect(models).toEqual([expect.objectContaining({ profileName: "Renamed", profileDeleted: false })]);
  });
});

describe("simulation", () => {
  it("is null unless asked for, and prices only calls without a snapshot at their model's current price", () => {
    const { db, summary } = setup();
    insertLlmProfile(db, "p-1", { models: [{ modelId: "model-a", pricing: TOKENS }, { modelId: "usd-model", pricing: { ...TOKENS, currency: "USD" } }, { modelId: "free" }] });
    insertAsrProfile(db, "ap-1", { models: [{ modelId: "scribe_v2", pricing: CNY("audio_per_second", "0.001") }] });
    insertLlmUsage(db, { id: "snap", sentAt: NOW - HOUR, input: 1_000_000, output: 0, snapshot: CNY("input_tokens_per_million", "1") });
    insertLlmUsage(db, { id: "old", sentAt: NOW - HOUR, input: 1_000_000, output: 0 });
    insertLlmUsage(db, { id: "old-usd", sentAt: NOW - HOUR, modelId: "usd-model", input: 1, output: 1 });
    insertLlmUsage(db, { id: "old-free", sentAt: NOW - HOUR, modelId: "free", input: 1, output: 1 });
    insertLlmUsage(db, { id: "old-failed", sentAt: NOW - HOUR, outcome: "failed" });
    insertLlmUsage(db, { id: "old-deleted", profileId: "p-deleted", sentAt: NOW - HOUR, input: 1, output: 1 });
    insertAsrUsage(db, { id: "old-asr", sentAt: NOW - HOUR, profileId: "ap-1", audioMs: 10_000 });
    insertAsrUsage(db, { id: "old-asr-gone", sentAt: NOW - HOUR, profileId: "ap-gone", audioMs: 10_000 });

    expect(summary().costDetail.simulated).toBeNull();
    const result = summary({ simulate: "1" });
    // 1 000 000 input tokens at 2 per million, plus ten seconds at 0.001.
    expect(result.costDetail.simulated).toEqual({ cost: { currency: "CNY", amount: "2.01" }, requests: 2, unavailable: 5 });
    // The simulation is separate from the cost the snapshots give.
    expect(result.summary.cost.amount).toEqual({ currency: "CNY", amount: "1" });
    expect(result.summary.cost.counted).toBe(1);
  });
});

describe("activities", () => {
  function seed() {
    const { db, service } = setup();
    insertContent(db, "c-1", { title: "Platform title", customTitle: "My title" });
    insertContent(db, "c-2", { title: "Second" });
    insertTask(db, "t-1", "c-1");
    insertChatMessage(db, "msg-1", "c-2");
    const owner = principalOf(OWNER);
    const list = (query: Record<string, unknown> = {}) =>
      service.activities(owner, { range: "30d", displayCurrency: "CNY", page: 1, pageSize: 50, ...query } as never);
    return { db, service, list };
  }

  it("groups by task, chat answer, connection test, content and day, and the remainder by day", () => {
    const { db, list } = seed();
    const at = NOW - DAY;
    // A task with two calls of different models.
    insertLlmUsage(db, { id: "t-a", taskId: "t-1", contentId: "c-1", feature: "summary", sentAt: at, input: 100, output: 10, snapshot: TOKENS });
    insertAsrUsage(db, { id: "t-b", taskId: "t-1", contentId: "c-1", sentAt: at + 1000, audioMs: 60_000 });
    // A chat answer: two calls, one of them the search plan.
    insertLlmUsage(db, { id: "chat-a", chatMessageId: "msg-1", contentId: "c-2", feature: "chat", sentAt: at + 5000, input: 10, output: 1 });
    insertLlmUsage(db, { id: "chat-b", chatMessageId: "msg-1", contentId: "c-2", feature: "chat_search_plan", sentAt: at + 4000, input: 5, output: 1 });
    // Connection tests in the same minute share a row; another minute does not.
    insertLlmUsage(db, { id: "test-1", feature: "test_connection", sentAt: at + 7 * 60_000 + 1000, input: 1, output: 1 });
    insertLlmUsage(db, { id: "test-2", feature: "test_connection", sentAt: at + 7 * 60_000 + 59_000, input: 1, output: 1 });
    insertLlmUsage(db, { id: "test-3", feature: "test_connection", sentAt: at + 8 * 60_000, input: 1, output: 1 });
    insertAsrUsage(db, { id: "test-asr", feature: "test_connection", sentAt: at + 7 * 60_000 + 2000 });
    // Task deleted, content kept: by content, purpose and Beijing day.
    insertLlmUsage(db, { id: "cd-1", contentId: "c-2", feature: "translate", sentAt: at + 10_000, input: 1, output: 1 });
    insertLlmUsage(db, { id: "cd-2", contentId: "c-2", feature: "translate", sentAt: at + 20_000, input: 1, output: 1 });
    insertLlmUsage(db, { id: "cd-3", contentId: "c-2", feature: "proofread", sentAt: at + 30_000, input: 1, output: 1 });
    // Task and content both deleted: one row per modality, purpose and day.
    insertLlmUsage(db, { id: "dd-1", feature: "summary", sentAt: at + 40_000, input: 1, output: 1 });
    insertLlmUsage(db, { id: "dd-2", feature: "summary", sentAt: at + 41_000, input: 1, output: 1 });
    insertAsrUsage(db, { id: "dd-3", sentAt: at + 42_000 });

    const { items, total } = list();
    const kinds = items.map((item: { kind: string; requests: number }) => `${item.kind}:${item.requests}`).sort();
    expect(total).toBe(items.length);
    // Tests of one minute share a row per modality: two LLM calls and one transcription test in minute 7, one LLM call in minute 8.
    expect(kinds).toEqual(["chat:2", "content_day:1", "content_day:2", "deleted_day:1", "deleted_day:2", "task:2", "test:1", "test:1", "test:2"]);
  });

  it("describes a task row with its title, links, models, purposes, results, usage and cost", () => {
    const { db, list } = seed();
    const at = NOW - DAY;
    insertLlmUsage(db, { id: "a", taskId: "t-1", contentId: "c-1", feature: "summary", profileName: "Relay", sentAt: at, input: 1_000_000, output: 0, snapshot: TOKENS, credentialVersion: "v1" });
    insertLlmUsage(db, { id: "b", taskId: "t-1", contentId: "c-1", feature: "chapter", sentAt: at + 5000, input: 10, output: 0, outcome: "failed", credentialVersion: "v2" });
    insertAsrUsage(db, { id: "c", taskId: "t-1", contentId: "c-1", sentAt: at + 9000, audioMs: 60_000 });
    const { items } = list();
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({
      kind: "task",
      startedAt: at,
      endedAt: at + 9000,
      title: "My title",
      contentId: "c-1",
      taskId: "t-1",
      chatMessageId: null,
      requests: 3,
      results: { succeeded: 2, failed: 1, outcome_unknown: 0, cancelled: 0 },
    });
    expect(item.features).toEqual(["chapter", "summary", "transcribe"]);
    expect(item.models.map((model: { requests: number }) => model.requests)).toEqual([2, 1]);
    expect(item.credentialVersions.sort()).toEqual([USAGE_LEGACY_CREDENTIAL, "v1", "v2"].sort());
    expect(item.usage.llm).toMatchObject({ input: "1000010" });
    expect(item.usage.asr).toMatchObject({ audioMs: "60000" });
    expect(item.cost).toMatchObject({ amount: { currency: "CNY", amount: "2" }, counted: 1, inCurrency: 1, unknownCurrency: 2 });
  });

  it("links a chat answer to its content and gives tests and deleted rows no title or link", () => {
    const { db, list } = seed();
    insertLlmUsage(db, { id: "chat", chatMessageId: "msg-1", contentId: "c-2", feature: "chat", sentAt: NOW - DAY, input: 1, output: 1 });
    insertLlmUsage(db, { id: "test", feature: "test_connection", sentAt: NOW - DAY, input: 1, output: 1 });
    insertLlmUsage(db, { id: "gone", feature: "summary", sentAt: NOW - DAY, input: 1, output: 1 });
    const byKind = Object.fromEntries(list().items.map((item: { kind: string }) => [item.kind, item]));
    expect(byKind["chat"]).toMatchObject({ title: "Second", contentId: "c-2", chatMessageId: "msg-1", taskId: null });
    expect(byKind["test"]).toMatchObject({ title: null, contentId: null, taskId: null, chatMessageId: null });
    expect(byKind["deleted_day"]).toMatchObject({ title: null, contentId: null });
  });

  it("splits content-day rows at Beijing midnight", () => {
    const { db, list } = seed();
    const midnight = MONDAY + DAY;
    insertLlmUsage(db, { id: "before", contentId: "c-2", feature: "translate", sentAt: midnight - 1000, input: 1, output: 1 });
    insertLlmUsage(db, { id: "after", contentId: "c-2", feature: "translate", sentAt: midnight, input: 1, output: 1 });
    expect(list({ range: "custom", from: MONDAY, to: MONDAY + 2 * DAY }).items).toHaveLength(2);
  });

  it("pages after grouping, newest first, with a stable total", () => {
    const { db, list } = seed();
    for (let index = 0; index < 5; index += 1) {
      insertLlmUsage(db, { id: `t${index}`, feature: "test_connection", sentAt: NOW - 100 * 60_000 + index * 120_000, input: 1, output: 1 });
      insertLlmUsage(db, { id: `x${index}`, feature: "test_connection", sentAt: NOW - 100 * 60_000 + index * 120_000 + 1000, input: 1, output: 1 });
    }
    const first = list({ pageSize: 10 });
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(5);
    expect(first.items.map((item: { requests: number }) => item.requests)).toEqual([2, 2, 2, 2, 2]);
    const starts = first.items.map((item: { startedAt: number }) => item.startedAt);
    expect(starts).toEqual([...starts].sort((a: number, b: number) => b - a));
    const small = Array.from({ length: 3 }, (_, index) => list({ pageSize: 2, page: index + 1 }));
    expect(small.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(small.every((page) => page.total === 5)).toBe(true);
    expect(small.flatMap((page) => page.items.map((item: { group: string }) => item.group))).toEqual(first.items.map((item: { group: string }) => item.group));
  });

  it("follows the filters and the owner", () => {
    const { db, list, service } = seed();
    insertLlmUsage(db, { id: "mine", taskId: "t-1", contentId: "c-1", modelId: "wanted", sentAt: NOW - DAY, input: 1, output: 1 });
    insertLlmUsage(db, { id: "other-model", taskId: "t-1", contentId: "c-1", modelId: "unwanted", sentAt: NOW - DAY, input: 1, output: 1 });
    insertLlmUsage(db, { id: "theirs", userId: OTHER_OWNER, feature: "test_connection", sentAt: NOW - DAY, input: 1, output: 1 });
    const filtered = list({ modelKey: encodeModelKey(["llm", "p-1", "wanted"]) });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.requests).toBe(1);
    expect(list().total).toBe(1);
    expect(service.activities(principalOf(OTHER_OWNER), { range: "30d", displayCurrency: "CNY", page: 1, pageSize: 10 } as never).total).toBe(1);
  });
});

describe("calls of an activity", () => {
  function seed() {
    const { db, service } = setup();
    insertContent(db, "c-1");
    insertTask(db, "t-1", "c-1");
    const owner = principalOf(OWNER);
    const base = { range: "30d", displayCurrency: "CNY" } as const;
    const group = (query: Record<string, unknown> = {}) => (service.activities(owner, { ...base, page: 1, pageSize: 50, ...query } as never).items[0] as { group: string }).group;
    return { db, service, owner, base, group };
  }

  it("returns every call of the group chronologically, each with its own cost, result and usage", () => {
    const { db, service, owner, base, group } = seed();
    const at = NOW - DAY;
    insertLlmUsage(db, { id: "late", taskId: "t-1", contentId: "c-1", sentAt: at + 2000, input: 1_000_000, output: 0, snapshot: TOKENS, credentialVersion: "v1", credentialSetAt: 77 });
    insertLlmUsage(db, { id: "early", taskId: "t-1", contentId: "c-1", sentAt: at, outcome: "outcome_unknown", snapshot: TOKENS });
    insertLlmUsage(db, { id: "usd", taskId: "t-1", contentId: "c-1", sentAt: at + 1000, input: 5, output: 1, snapshot: { ...TOKENS, currency: "USD" } });
    insertLlmUsage(db, { id: "old", taskId: "t-1", contentId: "c-1", sentAt: at + 1500, input: 0, output: 9 });
    insertAsrUsage(db, { id: "asr", taskId: "t-1", contentId: "c-1", sentAt: at + 3000, jobId: "j", audioMs: 1000 });

    const { items } = service.calls(owner, { ...base, group: group() });
    expect(items.map((item) => item.id)).toEqual(["early", "usd", "old", "late", "asr"]);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    expect(byId["early"]).toMatchObject({ result: "outcome_unknown", cost: { status: "not_counted", reason: "unknown_without_usage", currency: "CNY", amount: null } });
    expect(byId["usd"]?.cost).toEqual({ status: "other_currency", amount: null, currency: "USD", reason: null });
    expect(byId["old"]).toMatchObject({ inputMissing: true, cost: { status: "not_counted", reason: "no_snapshot", currency: null } });
    expect(byId["late"]).toMatchObject({
      modality: "llm",
      occurredAt: NOW - DAY + 2000,
      credentialVersion: "v1",
      credentialSetAt: 77,
      accepted: false,
      cost: { status: "counted", amount: { currency: "CNY", amount: "2" }, currency: "CNY", reason: null },
    });
    expect(byId["late"]?.usage.llm).toMatchObject({ input: "1000000", output: "0" });
    expect(byId["asr"]).toMatchObject({ modality: "asr", accepted: true, credentialVersion: null, usage: { llm: null, asr: { audioMs: "1000" } } });
  });

  it("opens every kind of group into exactly its own calls, however many other calls share its day or minute", () => {
    const { db, service, owner, base } = seed();
    insertContent(db, "c-2");
    insertChatMessage(db, "msg-1", "c-2");
    const midnight = MONDAY + 3 * DAY;
    const minute = midnight + 10 * HOUR;
    const rows: Array<[string, Parameters<typeof insertLlmUsage>[1]]> = [
      ["task", { id: "task-1", taskId: "t-1", contentId: "c-1", sentAt: minute }],
      ["task", { id: "task-2", taskId: "t-1", contentId: "c-1", sentAt: minute + 1000 }],
      ["chat", { id: "chat-1", chatMessageId: "msg-1", contentId: "c-2", feature: "chat", sentAt: minute + 2000 }],
      ["test", { id: "test-1", feature: "test_connection", sentAt: minute + 3000 }],
      ["test", { id: "test-2", feature: "test_connection", sentAt: minute + 4000 }],
      ["content_day", { id: "day-1", contentId: "c-2", feature: "translate", sentAt: midnight + 1000 }],
      ["content_day", { id: "day-2", contentId: "c-2", feature: "translate", sentAt: midnight + DAY - 1000 }],
      ["deleted_day", { id: "gone-1", feature: "summary", sentAt: midnight }],
      ["deleted_day", { id: "gone-2", feature: "summary", sentAt: midnight + DAY - 1 }],
      // Neighbours that must not leak in: the next Beijing day, another purpose, another minute.
      ["", { id: "next-day", feature: "summary", sentAt: midnight + DAY }],
      ["", { id: "other-purpose", feature: "proofread", sentAt: midnight + 5000 }],
      ["", { id: "other-minute", feature: "test_connection", sentAt: minute + 61_000 }],
    ];
    for (const [, row] of rows) {
      insertLlmUsage(db, { input: 1, output: 1, ...row });
    }
    const range = { range: "custom" as const, from: midnight - DAY, to: midnight + 2 * DAY };
    const activities = service.activities(owner, { ...base, ...range, page: 1, pageSize: 50 }).items;
    const opened = activities
      .map((item) => [item.kind, service.calls(owner, { ...base, ...range, group: item.group }).items.map((call) => call.id)] as const)
      .sort((x, y) => (x[1][0] as string).localeCompare(y[1][0] as string));
    expect(opened).toEqual([
      ["chat", ["chat-1"]],
      ["content_day", ["day-1", "day-2"]],
      ["deleted_day", ["gone-1", "gone-2"]],
      ["deleted_day", ["next-day"]],
      ["test", ["other-minute"]],
      ["deleted_day", ["other-purpose"]],
      ["task", ["task-1", "task-2"]],
      ["test", ["test-1", "test-2"]],
    ]);
  });

  it("rejects a malformed group, a made-up one and one the filters leave empty", () => {
    const { db, service, owner, base, group } = seed();
    insertLlmUsage(db, { id: "a", taskId: "t-1", contentId: "c-1", sentAt: NOW - DAY, input: 1, output: 1 });
    const valid = group();
    const forged = encodeGroup(JSON.stringify(["task", "t-unknown"]));
    const reshaped = Buffer.from(` ${JSON.stringify(["task", "t-1"])}`).toString("base64url");
    const padded = `${valid}=`;
    for (const bad of ["!!!", "e30", encodeGroup("not json"), encodeGroup(JSON.stringify(["task"])), encodeGroup(JSON.stringify(["nothing", "x"])), reshaped, padded]) {
      expect(failure(() => service.calls(owner, { ...base, group: bad })).class, bad).toBe("invalid_request");
    }
    expect(failure(() => service.calls(owner, { ...base, group: forged })).class).toBe("invalid_request");
    // The group exists, but not within these filters.
    expect(failure(() => service.calls(owner, { ...base, group: valid, range: "custom", from: 0, to: 5 })).class).toBe("invalid_request");
    expect(failure(() => service.calls(owner, { ...base, group: valid, modelKey: encodeModelKey(["llm", "p-1", "other"]) })).class).toBe("invalid_request");
    expect(service.calls(owner, { ...base, group: valid }).items).toHaveLength(1);
  });

  it("never serves another owner's group, however the key was obtained", () => {
    const { db, service, base, group } = seed();
    insertLlmUsage(db, { id: "a", taskId: "t-1", contentId: "c-1", sentAt: NOW - DAY, input: 1, output: 1 });
    const stolen = group();
    expect(failure(() => service.calls(principalOf(OTHER_OWNER), { ...base, group: stolen })).class).toBe("invalid_request");
  });

  it("encodes a group so that only its exact encoding decodes", () => {
    const key = JSON.stringify(["task", "t-1"]);
    expect(decodeGroup(encodeGroup(key))).toBe(key);
    expect(decodeGroup(`${encodeGroup(key)}A`)).toBeUndefined();
    expect(decodeGroup("")).toBeUndefined();
  });
});

describe("cache-observed", () => {
  it("lists model keys of LLM models that reported a cache read, for the owner only", () => {
    const { db, service } = setup();
    insertLlmUsage(db, { id: "a", sentAt: NOW, profileId: "p-1", modelId: "cached", input: 10, output: 1, cacheRead: 3 });
    insertLlmUsage(db, { id: "b", sentAt: NOW, profileId: "p-1", modelId: "plain", input: 10, output: 1, cacheRead: 0 });
    insertLlmUsage(db, { id: "c", userId: OTHER_OWNER, sentAt: NOW, profileId: "p-2", modelId: "theirs", input: 10, output: 1, cacheRead: 3 });
    expect(service.cacheObserved(principalOf(OWNER))).toEqual({ models: [{ modelKey: encodeModelKey(["llm", "p-1", "cached"]) }] });
    expect(service.cacheObserved(principalOf(OTHER_OWNER))).toEqual({ models: [{ modelKey: encodeModelKey(["llm", "p-2", "theirs"]) }] });
  });
});

describe("consistency between the views", () => {
  it("gives the same request totals in the summary, the series, the model table and the activity list under one filter", () => {
    const { db, service, summary } = setup();
    insertContent(db, "c-1");
    insertTask(db, "t-1", "c-1");
    for (let index = 0; index < 12; index += 1) {
      insertLlmUsage(db, {
        id: `l${index}`,
        taskId: index % 2 === 0 ? "t-1" : null,
        contentId: "c-1",
        modelId: `model-${index % 3}`,
        sentAt: NOW - (index + 1) * 3 * HOUR,
        input: 100,
        output: 10,
        snapshot: TOKENS,
      });
    }
    const filter = { modelKey: encodeModelKey(["llm", "p-1", "model-1"]) };
    const result: UsageSummaryResponse = summary(filter);
    const fromSeries = result.series.find((entry) => entry.metric === "requests")!.buckets.reduce((sum, bucket) => sum + Number(bucket.total), 0);
    const fromModels = result.models.reduce((sum, model) => sum + model.requests, 0);
    const activities = service.activities(principalOf(OWNER), { range: "30d", displayCurrency: "CNY", page: 1, pageSize: 50, ...filter } as never);
    const fromActivities = activities.items.reduce((sum, item) => sum + item.requests, 0);
    expect(new Set([result.summary.requests, fromSeries, fromModels, fromActivities])).toEqual(new Set([4]));
    const activityCost = activities.items.reduce((sum, item) => sum + Number(item.cost.amount?.amount ?? 0), 0);
    expect(activityCost).toBeCloseTo(Number(result.summary.cost.amount?.amount), 10);
  });
});

/**
 * The two-phase engine (SQL sums per group, then group pricing) must equal pricing every
 * call alone with exact rationals. The generated calls cover both modalities, every outcome,
 * all price units, two currencies, missing and unusable snapshots, ten-fraction-digit prices
 * and quantities beyond 2^53.
 */

const CALL_COUNT = 450;

function modelKeyOfCall(call: ReferenceCall): string {
  return JSON.stringify([call.modality, call.profileId ?? "", call.modelId ?? (call.modality === "llm" ? "model-a" : "scribe_v2")]);
}

function setupGenerated(seed: number) {
  const { db } = usageDb();
  const calls = generateCalls(seed, CALL_COUNT, NOW - 29 * DAY, NOW);
  insertCalls(db, calls);
  const service = new UsageAnalyticsService({ repository: new SqliteUsageAnalyticsRepository(db), now: () => NOW });
  return { calls, service };
}

function summaryOf(service: UsageAnalyticsService, currency: PriceCurrency) {
  return service.summary(principalOf(OWNER), { range: "30d", displayCurrency: currency });
}

describe.each([1, 2, 3])("estimate against the per-call reference (seed %i)", (seed) => {
  const { calls, service } = setupGenerated(seed);

  it.each(["CNY", "USD"] as const)("matches the summary cost cell and coverage in %s", (currency) => {
    const expected = referenceCell(calls, currency);
    const { summary, costDetail } = summaryOf(service, currency);

    expect(summary.cost).toEqual({
      amount: expected.amount === null ? null : { currency, amount: expected.amount },
      counted: expected.counted,
      inCurrency: expected.inCurrency,
      otherCurrency: expected.otherCurrency,
      unknownCurrency: expected.unknownCurrency,
      topReason: expected.topReason,
    });
    expect(Object.fromEntries(costDetail.unpriced.map((entry) => [entry.reason, entry.requests]))).toEqual(Object.fromEntries(expected.leftOut));
    expect(costDetail.unpriced.map((entry) => entry.reason)).toEqual(USAGE_UNPRICED_REASONS.filter((reason) => expected.leftOut.has(reason)));
    const text = ([counted, total]: [bigint, bigint]) => ({ counted: counted.toString(), total: total.toString() });
    expect(costDetail.coverage).toEqual({
      llmTokens: text(expected.coverage.llmTokens),
      asrTokens: text(expected.coverage.asrTokens),
      audioMs: text(expected.coverage.audioMs),
    });
  });

  it.each(["CNY", "USD"] as const)("matches the cost cell of every model in %s", (currency) => {
    const { models } = summaryOf(service, currency);
    const keys = new Set(calls.map(modelKeyOfCall));
    expect(models).toHaveLength(keys.size);
    for (const model of models) {
      const identity = JSON.stringify([model.modality, decode(model.modelKey)[1], model.modelId]);
      const own = calls.filter((call) => modelKeyOfCall(call) === identity);
      const expected = referenceCell(own, currency);
      expect(model.requests).toBe(own.length);
      expect(model.cost, model.modelKey).toEqual({
        amount: expected.amount === null ? null : { currency, amount: expected.amount },
        counted: expected.counted,
        inCurrency: expected.inCurrency,
        otherCurrency: expected.otherCurrency,
        unknownCurrency: expected.unknownCurrency,
        topReason: expected.topReason,
      });
    }
  });

  it("keeps quantity sums exact beyond 2^53", () => {
    const { summary } = summaryOf(service, "CNY");
    const total = (pick: (call: ReferenceCall) => bigint | number | null | undefined): string =>
      calls.reduce((sum, call) => sum + BigInt(pick(call) ?? 0), 0n).toString();
    const llm = calls.filter((call) => call.modality === "llm");
    const asr = calls.filter((call) => call.modality === "asr");
    expect(summary.usage.llm?.input).toBe(total((call) => (call.modality === "llm" ? call.input : 0)));
    expect(summary.usage.llm?.output).toBe(total((call) => (call.modality === "llm" ? call.output : 0)));
    expect(summary.usage.asr?.audioMs).toBe(total((call) => (call.modality === "asr" ? call.audioMs : 0)));
    expect(summary.usage.asr?.billedInputTokens).toBe(total((call) => (call.modality === "asr" ? call.billedInput : 0)));
    expect(summary.requests).toBe(llm.length + asr.length);
    expect(BigInt(summary.usage.llm?.input ?? "0") > 2n ** 53n).toBe(true);
  });
});

describe("the generated calls", () => {
  it("reach every unpriced reason, so the comparison above covers each of them", () => {
    const seen = new Set<string>();
    for (const seed of [1, 2, 3]) {
      for (const reason of referenceCell(generateCalls(seed, CALL_COUNT, NOW - 29 * DAY, NOW), "CNY").leftOut.keys()) {
        seen.add(reason);
      }
    }
    expect([...seen].sort()).toEqual([...USAGE_UNPRICED_REASONS].sort());
  });
});

/** The `[modality, profileId, modelId]` behind a model key. */
function decode(modelKey: string): [string, string, string] {
  return JSON.parse(Buffer.from(modelKey, "base64url").toString("utf8")) as [string, string, string];
}
