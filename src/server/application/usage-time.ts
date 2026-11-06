import {
  USAGE_GRANULARITY_DAY_MAX_DAYS,
  USAGE_GRANULARITY_HOUR_MAX_DAYS,
  USAGE_GRANULARITY_WEEK_MAX_YEARS,
} from "../../shared/defaults.ts";
import { USAGE_GRANULARITIES, type UsageGranularity, type UsageRange } from "../../shared/dto/usage-analytics.ts";
import { USAGE_UTC_OFFSET_MS } from "../domain/usage-analytics.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_YEAR = 365;
/** 1970-01-01 was a Thursday; adding 3 to a day number makes Monday the first weekday (0). */
const EPOCH_DAYS_TO_MONDAY = 3;

/** Spans of the presets; `all` and `custom` have none of their own. */
const PRESET_SPAN_MS: Readonly<Record<Exclude<UsageRange, "all" | "custom">, number>> = {
  "24h": 24 * MS_PER_HOUR,
  "48h": 48 * MS_PER_HOUR,
  "7d": 7 * MS_PER_DAY,
  "30d": 30 * MS_PER_DAY,
};

const PRESET_GRANULARITY: Readonly<Record<Exclude<UsageRange, "custom">, UsageGranularity>> = {
  "24h": "hour",
  "48h": "hour",
  "7d": "day",
  "30d": "day",
  all: "month",
};

/** The largest span each granularity may cover, in ms; a month has no limit. */
const GRANULARITY_MAX_SPAN_MS: Readonly<Record<UsageGranularity, number>> = {
  hour: USAGE_GRANULARITY_HOUR_MAX_DAYS * MS_PER_DAY,
  day: USAGE_GRANULARITY_DAY_MAX_DAYS * MS_PER_DAY,
  week: USAGE_GRANULARITY_WEEK_MAX_YEARS * DAYS_PER_YEAR * MS_PER_DAY,
  month: Number.POSITIVE_INFINITY,
};

export interface ResolvedRange {
  preset: UsageRange;
  /** `null` only for `all` when nothing matches. */
  from: number | null;
  /** Exclusive. */
  to: number;
}

export interface TimeBucket {
  start: number;
  end: number;
}

/**
 * The half-open interval a query covers. A preset ends now; `all` starts at the earliest
 * matching call (looked up only when needed); a custom range is as given.
 */
export function resolveRange(
  query: { range: UsageRange; from?: number | undefined; to?: number | undefined },
  now: number,
  earliest: () => number | null,
): ResolvedRange {
  if (query.range === "custom") {
    return { preset: "custom", from: query.from as number, to: query.to as number };
  }
  if (query.range === "all") {
    return { preset: "all", from: earliest(), to: now };
  }
  return { preset: query.range, from: now - PRESET_SPAN_MS[query.range], to: now };
}

/** Granularities that keep a range to a readable number of buckets, finest first. */
export function allowedGranularities(range: ResolvedRange): UsageGranularity[] {
  const span = range.from === null ? 0 : range.to - range.from;
  return USAGE_GRANULARITIES.filter((granularity) => span <= GRANULARITY_MAX_SPAN_MS[granularity]);
}

/** What a range is shown in when the client does not choose; a custom range uses the finest that fits. */
export function defaultGranularity(range: ResolvedRange): UsageGranularity {
  return range.preset === "custom" ? (allowedGranularities(range)[0] as UsageGranularity) : PRESET_GRANULARITY[range.preset];
}

function beijingParts(ms: number): { year: number; month: number } {
  const date = new Date(ms + USAGE_UTC_OFFSET_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

function monthStart(year: number, month: number): number {
  return Date.UTC(year, month, 1) - USAGE_UTC_OFFSET_MS;
}

/** The start of the Beijing-time bucket containing `ms`. */
export function bucketStart(granularity: UsageGranularity, ms: number): number {
  const shifted = ms + USAGE_UTC_OFFSET_MS;
  switch (granularity) {
    case "hour":
      return Math.floor(shifted / MS_PER_HOUR) * MS_PER_HOUR - USAGE_UTC_OFFSET_MS;
    case "day":
      return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY - USAGE_UTC_OFFSET_MS;
    case "week": {
      const day = Math.floor(shifted / MS_PER_DAY);
      return (day - ((day + EPOCH_DAYS_TO_MONDAY) % DAYS_PER_WEEK)) * MS_PER_DAY - USAGE_UTC_OFFSET_MS;
    }
    case "month": {
      const { year, month } = beijingParts(ms);
      return monthStart(year, month);
    }
  }
}

/** The start of the bucket after the one starting at `start`. */
export function nextBucketStart(granularity: UsageGranularity, start: number): number {
  switch (granularity) {
    case "hour":
      return start + MS_PER_HOUR;
    case "day":
      return start + MS_PER_DAY;
    case "week":
      return start + DAYS_PER_WEEK * MS_PER_DAY;
    case "month": {
      const { year, month } = beijingParts(start);
      return monthStart(year, month + 1);
    }
  }
}

/**
 * Contiguous buckets, empty ones included, that cover `[from, to)`. The first bucket may
 * start before `from` and the last may end after `to`, since buckets sit on Beijing boundaries.
 */
export function bucketsOf(granularity: UsageGranularity, range: ResolvedRange): TimeBucket[] {
  if (range.from === null) {
    return [];
  }
  const buckets: TimeBucket[] = [];
  let start = bucketStart(granularity, range.from);
  while (start < range.to) {
    const end = nextBucketStart(granularity, start);
    buckets.push({ start, end });
    start = end;
  }
  return buckets;
}
