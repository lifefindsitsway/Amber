import { describe, expect, it } from "vitest";
import {
  allowedGranularities,
  bucketsOf,
  bucketStart,
  defaultGranularity,
  nextBucketStart,
  resolveRange,
  type ResolvedRange,
} from "../../../src/server/application/usage-time.ts";
import {
  USAGE_GRANULARITY_DAY_MAX_DAYS,
  USAGE_GRANULARITY_HOUR_MAX_DAYS,
  USAGE_GRANULARITY_WEEK_MAX_YEARS,
} from "../../../src/shared/defaults.ts";
import { DAY, HOUR, MONDAY, NOW } from "../../fixtures/usage/rows.ts";

/** Beijing wall-clock time as Unix ms. */
function beijing(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - 8 * HOUR;
}

describe("bucket boundaries in Beijing time", () => {
  it("align hours and days to Beijing midnight, not UTC", () => {
    const t = beijing(2026, 9, 24, 23, 59, 59, 999);
    expect(bucketStart("hour", t)).toBe(beijing(2026, 9, 24, 23));
    expect(bucketStart("day", t)).toBe(beijing(2026, 9, 24));
    // 16:00 UTC is already the next Beijing day.
    expect(bucketStart("day", Date.UTC(2026, 8, 24, 16, 0, 0))).toBe(beijing(2026, 9, 25));
    expect(bucketStart("day", Date.UTC(2026, 8, 24, 15, 59, 59, 999))).toBe(beijing(2026, 9, 24));
  });

  it("start weeks on Monday", () => {
    expect(MONDAY).toBe(beijing(2026, 9, 21));
    expect(bucketStart("week", beijing(2026, 9, 21))).toBe(MONDAY);
    expect(bucketStart("week", beijing(2026, 9, 27, 23, 59, 59, 999))).toBe(MONDAY);
    expect(bucketStart("week", beijing(2026, 9, 28))).toBe(MONDAY + 7 * DAY);
    expect(bucketStart("week", beijing(2026, 9, 20, 23, 59))).toBe(MONDAY - 7 * DAY);
    // A week may begin in the previous month and the previous year.
    expect(bucketStart("week", beijing(2026, 1, 1, 12))).toBe(beijing(2025, 12, 29));
  });

  it("use calendar months with their real lengths, leap February included", () => {
    expect(bucketStart("month", beijing(2026, 9, 30, 23, 59, 59, 999))).toBe(beijing(2026, 9, 1));
    expect(bucketStart("month", beijing(2026, 10, 1))).toBe(beijing(2026, 10, 1));
    expect(nextBucketStart("month", beijing(2026, 12, 1))).toBe(beijing(2027, 1, 1));
    expect(nextBucketStart("month", beijing(2028, 2, 1))).toBe(beijing(2028, 3, 1));
    expect(nextBucketStart("month", beijing(2028, 2, 1)) - beijing(2028, 2, 1)).toBe(29 * DAY);
    expect(nextBucketStart("month", beijing(2027, 2, 1)) - beijing(2027, 2, 1)).toBe(28 * DAY);
  });

  it("put the last UTC evening of a month into the next Beijing month", () => {
    expect(bucketStart("month", Date.UTC(2026, 8, 30, 16, 0, 0))).toBe(beijing(2026, 10, 1));
    expect(bucketStart("month", Date.UTC(2026, 8, 30, 15, 59, 59, 999))).toBe(beijing(2026, 9, 1));
  });
});

describe("the bucket list of a range", () => {
  it("is contiguous with empty buckets, and may start before the range", () => {
    const range: ResolvedRange = { preset: "custom", from: beijing(2026, 9, 21, 10, 30), to: beijing(2026, 9, 21, 13, 0) };
    const buckets = bucketsOf("hour", range);
    expect(buckets.map((bucket) => bucket.start)).toEqual([beijing(2026, 9, 21, 10), beijing(2026, 9, 21, 11), beijing(2026, 9, 21, 12)]);
    for (const [index, bucket] of buckets.entries()) {
      expect(bucket.end).toBe(buckets[index + 1]?.start ?? beijing(2026, 9, 21, 13));
    }
  });

  it("excludes a bucket that begins exactly at the end of the range", () => {
    const range: ResolvedRange = { preset: "custom", from: MONDAY, to: MONDAY + 2 * DAY };
    expect(bucketsOf("day", range).map((bucket) => bucket.start)).toEqual([MONDAY, MONDAY + DAY]);
  });

  it("is empty when nothing matches an all-time range", () => {
    expect(bucketsOf("month", { preset: "all", from: null, to: NOW })).toEqual([]);
  });
});

describe("resolving a range", () => {
  const never = (): never => {
    throw new Error("the earliest call must not be looked up");
  };

  it("ends presets now and spans their length", () => {
    expect(resolveRange({ range: "24h" }, NOW, never)).toEqual({ preset: "24h", from: NOW - DAY, to: NOW });
    expect(resolveRange({ range: "48h" }, NOW, never)).toEqual({ preset: "48h", from: NOW - 2 * DAY, to: NOW });
    expect(resolveRange({ range: "7d" }, NOW, never)).toEqual({ preset: "7d", from: NOW - 7 * DAY, to: NOW });
    expect(resolveRange({ range: "30d" }, NOW, never)).toEqual({ preset: "30d", from: NOW - 30 * DAY, to: NOW });
  });

  it("starts all-time at the earliest matching call and keeps a custom range as given", () => {
    expect(resolveRange({ range: "all" }, NOW, () => 123)).toEqual({ preset: "all", from: 123, to: NOW });
    expect(resolveRange({ range: "all" }, NOW, () => null)).toEqual({ preset: "all", from: null, to: NOW });
    expect(resolveRange({ range: "custom", from: 5, to: 9 }, NOW, never)).toEqual({ preset: "custom", from: 5, to: 9 });
  });
});

describe("granularity limits", () => {
  const span = (ms: number): ResolvedRange => ({ preset: "custom", from: 0, to: ms });

  it("allow each granularity up to its limit, month always", () => {
    expect(allowedGranularities(span(USAGE_GRANULARITY_HOUR_MAX_DAYS * DAY))).toEqual(["hour", "day", "week", "month"]);
    expect(allowedGranularities(span(USAGE_GRANULARITY_HOUR_MAX_DAYS * DAY + 1))).toEqual(["day", "week", "month"]);
    expect(allowedGranularities(span(USAGE_GRANULARITY_DAY_MAX_DAYS * DAY))).toEqual(["day", "week", "month"]);
    expect(allowedGranularities(span(USAGE_GRANULARITY_DAY_MAX_DAYS * DAY + 1))).toEqual(["week", "month"]);
    expect(allowedGranularities(span(USAGE_GRANULARITY_WEEK_MAX_YEARS * 365 * DAY))).toEqual(["week", "month"]);
    expect(allowedGranularities(span(USAGE_GRANULARITY_WEEK_MAX_YEARS * 365 * DAY + 1))).toEqual(["month"]);
    expect(allowedGranularities({ preset: "all", from: null, to: NOW })).toEqual(["hour", "day", "week", "month"]);
  });

  it("default by preset, and to the finest allowed for a custom range", () => {
    expect(defaultGranularity({ preset: "24h", from: 0, to: DAY })).toBe("hour");
    expect(defaultGranularity({ preset: "48h", from: 0, to: 2 * DAY })).toBe("hour");
    expect(defaultGranularity({ preset: "7d", from: 0, to: 7 * DAY })).toBe("day");
    expect(defaultGranularity({ preset: "30d", from: 0, to: 30 * DAY })).toBe("day");
    expect(defaultGranularity({ preset: "all", from: 0, to: 900 * DAY })).toBe("month");
    expect(defaultGranularity(span(3 * DAY))).toBe("hour");
    expect(defaultGranularity(span(30 * DAY))).toBe("day");
    expect(defaultGranularity(span(1000 * DAY))).toBe("week");
    expect(defaultGranularity(span(3000 * DAY))).toBe("month");
  });
});
