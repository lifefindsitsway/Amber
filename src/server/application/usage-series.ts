import { USAGE_CHART_SERIES_MAX } from "../../shared/defaults.ts";
import { USAGE_COLOR_KEYS, USAGE_METRICS, type UsageColorKey, type UsageMetric } from "../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../shared/model-pricing.ts";
import type { TimeBucket } from "./usage-time.ts";
import { metricOf, type PricedInput } from "./usage-totals.ts";
import { toMoney, type GroupPricing } from "./usage-cost.ts";

/** The slots that colour a model individually; `other` is the last entry of the palette. */
const SERIES_COLOR_KEYS = USAGE_COLOR_KEYS.filter((key): key is Exclude<UsageColorKey, "other"> => key !== "other");

const OTHER_KEY = "other";

/** FNV-1a: a stable hash, so a model keeps its preferred slot from one response to the next. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const code of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ code, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Gives each model a palette slot. Models are taken busiest first (requests, then key); each
 * prefers the slot its key hashes to and probes forward past taken ones, so adding a quiet model
 * moves no busier model. Models past the palette share `other`.
 */
export function assignColors(models: ReadonlyArray<{ modelKey: string; requests: number }>): Map<string, UsageColorKey> {
  const ranked = [...models].sort((a, b) => b.requests - a.requests || (a.modelKey < b.modelKey ? -1 : 1));
  const taken = new Set<number>();
  const colors = new Map<string, UsageColorKey>();
  for (const model of ranked) {
    if (taken.size >= SERIES_COLOR_KEYS.length) {
      colors.set(model.modelKey, "other");
      continue;
    }
    let slot = hashOf(model.modelKey) % SERIES_COLOR_KEYS.length;
    while (taken.has(slot)) {
      slot = (slot + 1) % SERIES_COLOR_KEYS.length;
    }
    taken.add(slot);
    colors.set(model.modelKey, SERIES_COLOR_KEYS[slot] as UsageColorKey);
  }
  return colors;
}

export interface SeriesBucket {
  start: number;
  end: number;
  values: string[];
  total: string;
}

export interface MetricSeries {
  metric: UsageMetric;
  series: Array<{ key: string; modelKey: string | null; colorKey: UsageColorKey }>;
  buckets: SeriesBucket[];
}

/** Per bucket, what each model contributed to a metric; bucket order follows the bucket list. */
type ModelValues = Array<Map<string, bigint>>;

export interface BucketedGroup {
  group: PricedInput;
  pricing: GroupPricing;
  modelKey: string;
  bucketIndex: number;
}

function sumBy(values: ModelValues, modelKey: string): bigint {
  return values.reduce((total, bucket) => total + (bucket.get(modelKey) ?? 0n), 0n);
}

/** Formats a metric value: money amounts for cost, plain counts otherwise. */
function formatValue(metric: UsageMetric, currency: PriceCurrency, value: bigint): string {
  return metric === "cost" ? toMoney(currency, value).amount : value.toString();
}

function compareDescending(a: { total: bigint; modelKey: string }, b: { total: bigint; modelKey: string }): number {
  if (a.total !== b.total) {
    return a.total > b.total ? -1 : 1;
  }
  return a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0;
}

/**
 * The series of one metric. The models that contributed most over the whole range, up to
 * `USAGE_CHART_SERIES_MAX` and only those that own a palette slot, get a series each; every
 * other contributor is merged into one `other` series, left out when nothing is merged.
 */
function seriesOf(
  metric: UsageMetric,
  buckets: readonly TimeBucket[],
  values: ModelValues,
  colors: ReadonlyMap<string, UsageColorKey>,
  currency: PriceCurrency,
): MetricSeries {
  const contributors = new Set(values.flatMap((bucket) => [...bucket.entries()].filter(([, value]) => value > 0n).map(([modelKey]) => modelKey)));
  const ranked = [...contributors]
    .map((modelKey) => ({ modelKey, total: sumBy(values, modelKey) }))
    .sort(compareDescending);
  const named = ranked.filter((entry) => colors.get(entry.modelKey) !== "other").slice(0, USAGE_CHART_SERIES_MAX);
  const namedKeys = new Set(named.map((entry) => entry.modelKey));
  const merged = ranked.filter((entry) => !namedKeys.has(entry.modelKey));
  const series: MetricSeries["series"] = named.map((entry) => ({
    key: entry.modelKey,
    modelKey: entry.modelKey,
    colorKey: colors.get(entry.modelKey) as UsageColorKey,
  }));
  if (merged.length > 0) {
    series.push({ key: OTHER_KEY, modelKey: null, colorKey: "other" });
  }
  const mergedKeys = new Set(merged.map((entry) => entry.modelKey));
  return {
    metric,
    series,
    buckets: buckets.map((bucket, index) => {
      const own = values[index] as Map<string, bigint>;
      const mergedValue = [...mergedKeys].reduce((total, modelKey) => total + (own.get(modelKey) ?? 0n), 0n);
      const cells = [...named.map((entry) => own.get(entry.modelKey) ?? 0n), ...(merged.length > 0 ? [mergedValue] : [])];
      const total = cells.reduce((sum, cell) => sum + cell, 0n);
      return { start: bucket.start, end: bucket.end, values: cells.map((cell) => formatValue(metric, currency, cell)), total: formatValue(metric, currency, total) };
    }),
  };
}

/** One series set per metric, from groups that were assigned to buckets. */
export function buildSeries(
  buckets: readonly TimeBucket[],
  groups: readonly BucketedGroup[],
  colors: ReadonlyMap<string, UsageColorKey>,
  currency: PriceCurrency,
): MetricSeries[] {
  return USAGE_METRICS.map((metric) => {
    const values: ModelValues = buckets.map(() => new Map<string, bigint>());
    for (const { group, pricing, modelKey, bucketIndex } of groups) {
      const bucket = values[bucketIndex];
      const value = metricOf(metric, group, pricing, currency);
      if (bucket !== undefined && value > 0n) {
        bucket.set(modelKey, (bucket.get(modelKey) ?? 0n) + value);
      }
    }
    return seriesOf(metric, buckets, values, colors, currency);
  });
}
