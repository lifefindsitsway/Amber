import { describe, expect, it } from "vitest";
import { assignColors, buildSeries, type BucketedGroup } from "../../../src/server/application/usage-series.ts";
import { USAGE_CHART_SERIES_MAX } from "../../../src/shared/defaults.ts";
import { USAGE_COLOR_KEYS, USAGE_METRICS, type UsageColorKey, type UsageMetric } from "../../../src/shared/dto/usage-analytics.ts";
import type { PricedInput } from "../../../src/server/application/usage-totals.ts";

const SLOTS = USAGE_COLOR_KEYS.filter((key) => key !== "other");

function keysWithSameSlot(count: number): string[] {
  const bySlot = new Map<UsageColorKey, string[]>();
  for (let index = 0; index < 400; index += 1) {
    const modelKey = `model-${index}`;
    const slot = assignColors([{ modelKey, requests: 1 }]).get(modelKey) as UsageColorKey;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), modelKey]);
  }
  return [...bySlot.values()].find((keys) => keys.length >= count)?.slice(0, count) as string[];
}

describe("colour assignment", () => {
  it("gives a model the same colour every time and whatever order the models arrive in", () => {
    const models = Array.from({ length: 5 }, (_, index) => ({ modelKey: `m${index}`, requests: 10 - index }));
    const forward = assignColors(models);
    const backward = assignColors([...models].reverse());
    expect([...forward]).toEqual([...backward]);
    expect(assignColors(models)).toEqual(forward);
  });

  it("keeps the colours of busier models when a quieter one joins", () => {
    const [first, second] = keysWithSameSlot(2) as [string, string];
    const alone = assignColors([{ modelKey: first, requests: 5 }]);
    const together = assignColors([{ modelKey: second, requests: 1 }, { modelKey: first, requests: 5 }]);
    expect(together.get(first)).toBe(alone.get(first));
    expect(together.get(second)).not.toBe(together.get(first));
  });

  it("probes forward past a taken slot, so colliding models still differ", () => {
    const colliding = keysWithSameSlot(3);
    const colors = assignColors(colliding.map((modelKey, index) => ({ modelKey, requests: 10 - index })));
    expect(new Set(colors.values()).size).toBe(3);
  });

  it("uses each palette slot once and gives the models past the palette the shared colour", () => {
    const models = Array.from({ length: SLOTS.length + 3 }, (_, index) => ({ modelKey: `busy-${index}`, requests: 100 - index }));
    const colors = assignColors(models);
    const individual = models.slice(0, SLOTS.length).map((model) => colors.get(model.modelKey));
    expect(new Set(individual).size).toBe(SLOTS.length);
    expect(individual).not.toContain("other");
    expect(models.slice(SLOTS.length).map((model) => colors.get(model.modelKey))).toEqual(["other", "other", "other"]);
  });

  it("breaks request ties by key", () => {
    const colors = assignColors([{ modelKey: "b", requests: 1 }, { modelKey: "a", requests: 1 }]);
    const reversed = assignColors([{ modelKey: "a", requests: 1 }, { modelKey: "b", requests: 1 }]);
    expect([...colors].sort()).toEqual([...reversed].sort());
  });
});

function group(modality: "llm" | "asr", fields: Partial<PricedInput> = {}): PricedInput {
  return {
    modality,
    profileId: "p",
    modelId: "m",
    snapshotJson: null,
    bitmap: 0,
    flags: 0,
    result: "succeeded",
    requests: 1n,
    rawInput: 0n,
    input: 0n,
    output: 0n,
    reasoning: 0n,
    cacheRead: 0n,
    cacheWrite: 0n,
    cacheWrite1h: 0n,
    audioBilledMs: 0n,
    audioLocalMs: 0n,
    lastAt: 0,
    ...fields,
  };
}

const BUCKETS = [
  { start: 0, end: 10 },
  { start: 10, end: 20 },
  { start: 20, end: 30 },
];

function entry(modelKey: string, bucketIndex: number, fields: Partial<PricedInput> = {}, modality: "llm" | "asr" = "llm"): BucketedGroup {
  return { group: group(modality, fields), pricing: { kind: "no_snapshot" }, modelKey, bucketIndex };
}

function seriesOf(groups: BucketedGroup[], colors: Map<string, UsageColorKey>, metric: UsageMetric = "requests") {
  const all = buildSeries(BUCKETS, groups, colors, "CNY");
  return all.find((candidate) => candidate.metric === metric)!;
}

describe("series of a metric", () => {
  it("has one entry per metric", () => {
    expect(buildSeries(BUCKETS, [], new Map(), "CNY").map((series) => series.metric)).toEqual([...USAGE_METRICS]);
  });

  it("covers every bucket, empty ones included, with a total", () => {
    const colors = new Map<string, UsageColorKey>([["a", "series-0"]]);
    const series = seriesOf([entry("a", 0, { requests: 3n }), entry("a", 2, { requests: 4n })], colors);
    expect(series.series).toEqual([{ key: "a", modelKey: "a", colorKey: "series-0" }]);
    expect(series.buckets).toEqual([
      { start: 0, end: 10, values: ["3"], total: "3" },
      { start: 10, end: 20, values: ["0"], total: "0" },
      { start: 20, end: 30, values: ["4"], total: "4" },
    ]);
  });

  it("keeps the top models of the metric and merges the rest into one other series", () => {
    const models = Array.from({ length: USAGE_CHART_SERIES_MAX + 2 }, (_, index) => `m${index}`);
    const colors = new Map(models.map((modelKey, index) => [modelKey, SLOTS[index % SLOTS.length] as UsageColorKey]));
    const groups = models.map((modelKey, index) => entry(modelKey, 1, { requests: BigInt(100 - index * 10) }));
    const series = seriesOf(groups, colors);
    expect(series.series.map((entry) => entry.key)).toEqual([...models.slice(0, USAGE_CHART_SERIES_MAX), "other"]);
    expect(series.series.at(-1)).toEqual({ key: "other", modelKey: null, colorKey: "other" });
    const middle = series.buckets[1]!;
    const mergedTotal = 100 - USAGE_CHART_SERIES_MAX * 10 + (100 - (USAGE_CHART_SERIES_MAX + 1) * 10);
    expect(middle.values.at(-1)).toBe(String(mergedTotal));
    expect(middle.total).toBe(String(models.reduce((sum, _, index) => sum + 100 - index * 10, 0)));
  });

  it("leaves other out when nothing is merged, and models that contributed nothing out of every series", () => {
    const colors = new Map<string, UsageColorKey>([["a", "series-0"], ["b", "series-1"]]);
    const series = seriesOf([entry("a", 0, { requests: 1n }), entry("b", 0, { requests: 0n })], colors);
    expect(series.series.map((entry) => entry.key)).toEqual(["a"]);
  });

  it("ranks models separately for each metric", () => {
    const colors = new Map<string, UsageColorKey>([["a", "series-0"], ["b", "series-1"]]);
    const groups = [
      entry("a", 0, { requests: 10n, rawInput: 1n, output: 1n }),
      entry("b", 0, { requests: 1n, rawInput: 500n, output: 500n }),
    ];
    expect(seriesOf(groups, colors, "requests").series.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(seriesOf(groups, colors, "llm_tokens").series.map((entry) => entry.key)).toEqual(["b", "a"]);
  });

  it("sends a model without a palette slot to other, even when it ranks in the top", () => {
    const colors = new Map<string, UsageColorKey>([["a", "series-0"], ["z", "other"]]);
    const series = seriesOf([entry("z", 0, { requests: 50n }), entry("a", 0, { requests: 1n })], colors);
    expect(series.series.map((entry) => entry.key)).toEqual(["a", "other"]);
    expect(series.buckets[0]).toMatchObject({ values: ["1", "50"], total: "51" });
  });

  it("measures each metric in its own unit and never mixes LLM and ASR tokens", () => {
    const colors = new Map<string, UsageColorKey>([["l", "series-0"], ["s", "series-1"]]);
    const groups = [
      entry("l", 0, { requests: 2n, rawInput: 100n, output: 20n }),
      entry("s", 0, { requests: 5n, rawInput: 7n, output: 3n, audioLocalMs: 61_000n }, "asr"),
    ];
    expect(seriesOf(groups, colors, "llm_tokens").buckets[0]).toMatchObject({ values: ["120"], total: "120" });
    expect(seriesOf(groups, colors, "asr_billed_tokens").buckets[0]).toMatchObject({ values: ["10"], total: "10" });
    expect(seriesOf(groups, colors, "audio").buckets[0]).toMatchObject({ values: ["61000"], total: "61000" });
    expect(seriesOf(groups, colors, "requests").buckets[0]).toMatchObject({ values: ["5", "2"], total: "7" });
  });

  it("sums cost exactly and rounds only the figures it shows", () => {
    const third = 10n ** 10n * 18_000_000n / 3n;
    const colors = new Map<string, UsageColorKey>([["a", "series-0"], ["b", "series-1"]]);
    const priced = (modelKey: string, cost: bigint): BucketedGroup => ({
      group: group("llm"),
      pricing: { kind: "counted", currency: "CNY", cost },
      modelKey,
      bucketIndex: 0,
    });
    const series = seriesOf([priced("a", third), priced("a", third), priced("b", third)], colors, "cost");
    expect(series.buckets[0]).toMatchObject({ values: ["0.66666667", "0.33333333"], total: "1" });
  });

  it("counts only costs in the display currency", () => {
    const colors = new Map<string, UsageColorKey>([["a", "series-0"]]);
    const usd: BucketedGroup = { group: group("llm"), pricing: { kind: "counted", currency: "USD", cost: 10n ** 10n * 18_000_000n }, modelKey: "a", bucketIndex: 0 };
    expect(seriesOf([usd], colors, "cost").series).toEqual([]);
  });
});
