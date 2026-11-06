import {
  USAGE_CHART_SERIES_MAX,
  USAGE_GRANULARITY_DAY_MAX_DAYS,
  USAGE_GRANULARITY_HOUR_MAX_DAYS,
  USAGE_GRANULARITY_WEEK_MAX_YEARS,
} from "../../../src/shared/defaults.ts";
import {
  encodeModelKey,
  encodeProfileKey,
  USAGE_LEGACY_CREDENTIAL,
  USAGE_METRICS,
  usageActivitiesResponseSchema,
  usageCacheObservedResponseSchema,
  usageCallsResponseSchema,
  usageSummaryResponseSchema,
  type Money,
  type UsageActivitiesQuery,
  type UsageActivitiesResponse,
  type UsageActivity,
  type UsageCacheObservedResponse,
  type UsageCall,
  type UsageCallsQuery,
  type UsageCallsResponse,
  type UsageColorKey,
  type UsageCostCell,
  type UsageGranularity,
  type UsageMetric,
  type UsageModalityUsage,
  type UsageResult,
  type UsageResultCounts,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
  type UsageUnpricedReason,
} from "../../../src/shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../src/shared/model-pricing.ts";
import type { FixtureCall, FixtureGroup, FixtureModel, FixturePrice, FixtureScenario } from "./types.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const BEIJING_OFFSET_MS = 8 * MS_PER_HOUR;
const DAYS_PER_YEAR = 365.25;
const PER_MILLION = 1_000_000;
const MS_PER_SECOND = 1000;
const THURSDAY_INDEX = 3;
const DAYS_PER_WEEK = 7;
const COLOR_SLOTS = 8;

export const modelKeyOf = (model: FixtureModel): string => encodeModelKey([model.profile.modality, model.profile.id, model.modelId]);
export const profileKeyOf = (model: FixtureModel): string => encodeProfileKey([model.profile.modality, model.profile.id]);

// Time ------------------------------------------------------------------------------------------

function floorTo(ms: number, granularity: UsageGranularity): number {
  const shifted = ms + BEIJING_OFFSET_MS;
  switch (granularity) {
    case "hour":
      return Math.floor(shifted / MS_PER_HOUR) * MS_PER_HOUR - BEIJING_OFFSET_MS;
    case "day":
      return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY - BEIJING_OFFSET_MS;
    case "week": {
      const day = Math.floor(shifted / MS_PER_DAY);
      return (day - ((day + THURSDAY_INDEX) % DAYS_PER_WEEK)) * MS_PER_DAY - BEIJING_OFFSET_MS;
    }
    case "month": {
      const date = new Date(shifted);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - BEIJING_OFFSET_MS;
    }
  }
}

function nextBucket(start: number, granularity: UsageGranularity): number {
  switch (granularity) {
    case "hour":
      return start + MS_PER_HOUR;
    case "day":
      return start + MS_PER_DAY;
    case "week":
      return start + DAYS_PER_WEEK * MS_PER_DAY;
    case "month": {
      const date = new Date(start + BEIJING_OFFSET_MS);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - BEIJING_OFFSET_MS;
    }
  }
}

const PRESET_SPAN_MS: Record<string, number> = { "24h": MS_PER_DAY, "48h": 2 * MS_PER_DAY, "7d": 7 * MS_PER_DAY, "30d": 30 * MS_PER_DAY };

interface Filter {
  range: UsageSummaryQuery["range"];
  from?: number | undefined;
  to?: number | undefined;
  profileKey?: string | undefined;
  credentialVersion?: string | undefined;
  modelKey?: string | undefined;
  modality?: "llm" | "asr" | undefined;
}

function resolveRange(scenario: FixtureScenario, filter: Filter): { from: number | null; to: number } {
  if (filter.range === "custom") return { from: filter.from ?? null, to: filter.to ?? scenario.now };
  if (filter.range === "all") {
    const first = Math.min(...scenario.calls.map((call) => call.at));
    return { from: Number.isFinite(first) ? first : null, to: scenario.now };
  }
  return { from: scenario.now - (PRESET_SPAN_MS[filter.range] ?? MS_PER_DAY), to: scenario.now };
}

function inRange(call: FixtureCall, range: { from: number | null; to: number }): boolean {
  return (range.from === null || call.at >= range.from) && call.at < range.to;
}

function versionOf(call: FixtureCall): string {
  return call.version ?? USAGE_LEGACY_CREDENTIAL;
}

function matches(call: FixtureCall, filter: Filter, scenario: FixtureScenario, ignoreFilters = false): boolean {
  if (!inRange(call, resolveRange(scenario, filter))) return false;
  if (ignoreFilters) return true;
  return (
    (filter.profileKey === undefined || profileKeyOf(call.model) === filter.profileKey) &&
    (filter.credentialVersion === undefined || versionOf(call) === filter.credentialVersion) &&
    (filter.modelKey === undefined || modelKeyOf(call.model) === filter.modelKey) &&
    (filter.modality === undefined || call.model.profile.modality === filter.modality)
  );
}

// Money -----------------------------------------------------------------------------------------

/** A sum as the wire writes it: at most 8 fraction digits, no trailing zeros. */
export function moneyText(value: number): string {
  const fixed = value.toFixed(8);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

const money = (currency: PriceCurrency, value: number): Money => ({ currency, amount: moneyText(value) });

interface Evaluation {
  currency: PriceCurrency | null;
  amount: number | null;
  reason: UsageUnpricedReason | null;
}

/** Why a call without usable usage is left out, by how it ended. */
function reasonForResult(result: UsageResult): UsageUnpricedReason {
  switch (result) {
    case "outcome_unknown":
      return "unknown_without_usage";
    case "failed":
    case "cancelled":
      return "failed_without_usage";
    case "succeeded":
      return "usage_missing";
  }
}

/** The estimate rules of one call under one price: a missing price or quantity leaves the whole call out. */
function evaluate(call: FixtureCall, price: FixturePrice | null): Evaluation {
  // Without a frozen price the currency is unknown too: such a call belongs to no currency's coverage.
  if (price === null) return { currency: null, amount: null, reason: "no_snapshot" };
  const left = (reason: UsageUnpricedReason): Evaluation => ({ currency: price.currency, amount: null, reason });
  const extra = price.perRequest ?? 0;
  if (call.model.profile.modality === "llm") {
    const usage = call.llm;
    if (usage === undefined) return left(reasonForResult(call.result));
    if (usage.input === 0 && usage.output > 0) return left("input_missing");
    const cacheRead = usage.cacheRead ?? 0;
    if (cacheRead > 0 && price.cacheReadPerMillion === undefined) return left("missing_cache_read_price");
    const normal = Math.max(usage.input - cacheRead - (usage.cacheWrite ?? 0), 0);
    const total =
      (normal * (price.inputPerMillion ?? 0) + cacheRead * (price.cacheReadPerMillion ?? 0) + usage.output * (price.outputPerMillion ?? 0)) / PER_MILLION + extra;
    return { currency: price.currency, amount: total, reason: null };
  }
  const usage = call.asr;
  if (usage === undefined) return left("usage_missing");
  if (price.audioPerSecond !== undefined) {
    const billedMs = usage.billedAudioMs ?? (call.result === "succeeded" ? usage.audioMs : undefined);
    if (billedMs === undefined) return left(reasonForResult(call.result));
    return { currency: price.currency, amount: (billedMs / MS_PER_SECOND) * price.audioPerSecond + extra, reason: null };
  }
  if (usage.billedInput === undefined || usage.billedOutput === undefined) return left(reasonForResult(call.result));
  const total = (usage.billedInput * (price.billedInputPerMillion ?? 0) + usage.billedOutput * (price.billedOutputPerMillion ?? 0)) / PER_MILLION + extra;
  return { currency: price.currency, amount: total, reason: null };
}

const evaluateCall = (call: FixtureCall): Evaluation => evaluate(call, call.price);

/** What the current price would make of a call that has no usable snapshot; `undefined` when it cannot be simulated. */
function simulate(call: FixtureCall): Evaluation | undefined {
  if (call.model.profile.deleted || call.model.currentPrice === null) return undefined;
  const result = evaluate(call, call.model.currentPrice);
  return result.amount === null ? undefined : result;
}

// Aggregates ------------------------------------------------------------------------------------

function resultOf(call: FixtureCall): UsageResult {
  return call.result;
}

function countResults(calls: readonly FixtureCall[]): UsageResultCounts {
  const counts: UsageResultCounts = { succeeded: 0, failed: 0, outcome_unknown: 0, cancelled: 0 };
  for (const call of calls) counts[resultOf(call)] += 1;
  return counts;
}

const text = (value: number): string => String(Math.round(value));
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function usageOf(calls: readonly FixtureCall[]): UsageModalityUsage {
  const llm = calls.filter((call) => call.model.profile.modality === "llm");
  const asr = calls.filter((call) => call.model.profile.modality === "asr");
  return {
    llm:
      llm.length === 0
        ? null
        : {
            input: text(sum(llm.map((call) => call.llm?.input ?? 0))),
            output: text(sum(llm.map((call) => call.llm?.output ?? 0))),
            reasoning: text(sum(llm.map((call) => call.llm?.reasoning ?? 0))),
            cacheRead: text(sum(llm.map((call) => call.llm?.cacheRead ?? 0))),
            cacheWrite: text(sum(llm.map((call) => call.llm?.cacheWrite ?? 0))),
            cacheWrite1h: "0",
          },
    asr:
      asr.length === 0
        ? null
        : {
            audioMs: text(sum(asr.map((call) => call.asr?.audioMs ?? 0))),
            billedInputTokens: text(sum(asr.map((call) => call.asr?.billedInput ?? 0))),
            billedOutputTokens: text(sum(asr.map((call) => call.asr?.billedOutput ?? 0))),
          },
  };
}

function costCell(calls: readonly FixtureCall[], currency: PriceCurrency): UsageCostCell {
  let counted = 0;
  let inCurrency = 0;
  let otherCurrency = 0;
  let unknownCurrency = 0;
  let total = 0;
  const reasons = new Map<UsageUnpricedReason, number>();
  for (const call of calls) {
    const evaluation = evaluateCall(call);
    if (evaluation.currency === null) {
      unknownCurrency += 1;
      continue;
    }
    if (evaluation.currency !== currency) {
      otherCurrency += 1;
      continue;
    }
    inCurrency += 1;
    if (evaluation.amount === null) {
      if (evaluation.reason !== null) reasons.set(evaluation.reason, (reasons.get(evaluation.reason) ?? 0) + 1);
    } else {
      counted += 1;
      total += evaluation.amount;
    }
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    amount: counted === 0 ? null : money(currency, total),
    counted,
    inCurrency,
    otherCurrency,
    unknownCurrency,
    topReason: top ?? (inCurrency === 0 && unknownCurrency > 0 && otherCurrency === 0 ? "no_snapshot" : null),
  };
}

// Models and colours ----------------------------------------------------------------------------

function modelsOf(scenario: FixtureScenario): FixtureModel[] {
  const seen = new Map<string, FixtureModel>();
  for (const call of scenario.calls) seen.set(modelKeyOf(call.model), call.model);
  return [...seen.values()];
}

/** Colour slots follow the model's overall request count, so a model keeps its colour whatever the filter. */
function colorKeys(scenario: FixtureScenario): Map<string, UsageColorKey> {
  const counts = new Map<string, number>();
  for (const call of scenario.calls) counts.set(modelKeyOf(call.model), (counts.get(modelKeyOf(call.model)) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  return new Map(ranked.map((key, index) => [key, index < COLOR_SLOTS ? (`series-${index}` as UsageColorKey) : "other"]));
}

function profileTitle(profile: { name: string | null }): string | null {
  return profile.name;
}

// Summary ---------------------------------------------------------------------------------------

function allowedGranularities(range: { from: number | null; to: number }): UsageGranularity[] {
  const days = range.from === null ? 0 : (range.to - range.from) / MS_PER_DAY;
  const allowed: UsageGranularity[] = [];
  if (days <= USAGE_GRANULARITY_HOUR_MAX_DAYS) allowed.push("hour");
  if (days <= USAGE_GRANULARITY_DAY_MAX_DAYS) allowed.push("day");
  if (days <= USAGE_GRANULARITY_WEEK_MAX_YEARS * DAYS_PER_YEAR) allowed.push("week");
  allowed.push("month");
  return allowed;
}

function defaultGranularity(filter: Filter, allowed: readonly UsageGranularity[]): UsageGranularity {
  const wanted: UsageGranularity = { "24h": "hour", "48h": "hour", "7d": "day", "30d": "day", all: "month", custom: "day" }[filter.range] as UsageGranularity;
  return allowed.includes(wanted) ? wanted : (allowed[0] ?? "month");
}

function metricValue(call: FixtureCall, metric: UsageMetric, currency: PriceCurrency): number {
  switch (metric) {
    case "cost": {
      const evaluation = evaluateCall(call);
      return evaluation.currency === currency && evaluation.amount !== null ? evaluation.amount : 0;
    }
    case "llm_tokens":
      return call.llm === undefined ? 0 : call.llm.input + call.llm.output;
    case "asr_billed_tokens":
      return call.asr === undefined ? 0 : (call.asr.billedInput ?? 0) + (call.asr.billedOutput ?? 0);
    case "requests":
      return 1;
    case "audio":
      return call.asr?.audioMs ?? 0;
  }
}

const metricText = (metric: UsageMetric, value: number): string => (metric === "cost" ? moneyText(value) : text(value));

/** Whether a call is stacked under a series: a model's own, or the merged remainder for `null`. */
function belongsTo(call: FixtureCall, modelKey: string | null, main: readonly string[]): boolean {
  return modelKey === null ? !main.includes(modelKeyOf(call.model)) : modelKeyOf(call.model) === modelKey;
}

function buildSeries(
  calls: readonly FixtureCall[],
  metric: UsageMetric,
  currency: PriceCurrency,
  granularity: UsageGranularity,
  range: { from: number | null; to: number },
  colors: Map<string, UsageColorKey>,
): UsageSummaryResponse["series"][number] {
  const totals = new Map<string, number>();
  for (const call of calls) totals.set(modelKeyOf(call.model), (totals.get(modelKeyOf(call.model)) ?? 0) + metricValue(call, metric, currency));
  const ranked = [...totals.entries()].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const main = ranked.slice(0, USAGE_CHART_SERIES_MAX).map(([key]) => key);
  const hasOther = ranked.length > main.length;
  const series = [
    ...main.map((key) => ({ key, modelKey: key as string | null, colorKey: colors.get(key) ?? ("other" as UsageColorKey) })),
    ...(hasOther ? [{ key: "other", modelKey: null, colorKey: "other" as UsageColorKey }] : []),
  ];
  const buckets: UsageSummaryResponse["series"][number]["buckets"] = [];
  if (range.from !== null) {
    for (let start = floorTo(range.from, granularity); start < range.to; start = nextBucket(start, granularity)) {
      const end = nextBucket(start, granularity);
      const inBucket = calls.filter((call) => call.at >= start && call.at < end);
      const values = series.map((item) =>
        sum(inBucket.filter((call) => belongsTo(call, item.modelKey, main)).map((call) => metricValue(call, metric, currency))),
      );
      buckets.push({ start, end, values: values.map((value) => metricText(metric, value)), total: metricText(metric, sum(values)) });
    }
  }
  return { metric, series, buckets };
}

function buildModels(calls: readonly FixtureCall[], currency: PriceCurrency, colors: Map<string, UsageColorKey>): UsageSummaryResponse["models"] {
  const groups = new Map<string, FixtureCall[]>();
  for (const call of calls) groups.set(modelKeyOf(call.model), [...(groups.get(modelKeyOf(call.model)) ?? []), call]);
  return [...groups.entries()].map(([modelKey, items]) => {
    const model = (items[0] as FixtureCall).model;
    return {
      modelKey,
      profileKey: profileKeyOf(model),
      modality: model.profile.modality,
      profileName: profileTitle(model.profile),
      profileDeleted: model.profile.deleted,
      modelId: model.modelId,
      credentialVersions: [...new Set(items.map(versionOf))],
      colorKey: colors.get(modelKey) ?? "other",
      requests: items.length,
      results: countResults(items),
      usage: usageOf(items),
      cost: costCell(items, currency),
    };
  });
}

function buildOptions(scenario: FixtureScenario, filter: Filter): UsageSummaryResponse["options"] {
  const inScope = scenario.calls.filter((call) => matches(call, filter, scenario, true));
  const profiles = new Map<string, FixtureCall[]>();
  for (const call of inScope) profiles.set(profileKeyOf(call.model), [...(profiles.get(profileKeyOf(call.model)) ?? []), call]);
  const models = new Map<string, FixtureModel>();
  for (const call of inScope) models.set(modelKeyOf(call.model), call.model);
  return {
    profiles: [...profiles.entries()].map(([profileKey, items]) => {
      const profile = (items[0] as FixtureCall).model.profile;
      const versionIds = [...new Set(items.map(versionOf))];
      return {
        profileKey,
        modality: profile.modality,
        profileName: profile.name,
        deleted: profile.deleted,
        versions: versionIds.map((credentialVersion) => ({
          credentialVersion,
          setAt: profile.versions.find((version) => version.id === credentialVersion)?.setAt ?? null,
          requests: items.filter((call) => versionOf(call) === credentialVersion).length,
        })),
      };
    }),
    models: [...models.entries()].map(([modelKey, model]) => ({ modelKey, profileKey: profileKeyOf(model), modelId: model.modelId })),
  };
}

function buildCostDetail(calls: readonly FixtureCall[], currency: PriceCurrency, wantSimulation: boolean): UsageSummaryResponse["costDetail"] {
  const reasons = new Map<UsageUnpricedReason, { requests: number; modelKeys: Set<string> }>();
  const coverage = { llm: [0, 0], asr: [0, 0], audio: [0, 0] };
  let simulated = 0;
  let simulatedRequests = 0;
  let unavailable = 0;
  for (const call of calls) {
    const evaluation = evaluateCall(call);
    const llmTokens = call.llm === undefined ? 0 : call.llm.input + call.llm.output;
    const asrTokens = call.asr === undefined ? 0 : (call.asr.billedInput ?? 0) + (call.asr.billedOutput ?? 0);
    const counted = evaluation.currency === currency && evaluation.amount !== null;
    coverage.llm = [(coverage.llm[0] as number) + (counted ? llmTokens : 0), (coverage.llm[1] as number) + llmTokens];
    coverage.asr = [(coverage.asr[0] as number) + (counted ? asrTokens : 0), (coverage.asr[1] as number) + asrTokens];
    // Audio only counts towards the coverage of models that bill by the second, under the frozen or the current price.
    const audio = call.asr?.audioMs ?? 0;
    const billsAudio = call.price?.audioPerSecond !== undefined || call.model.currentPrice?.audioPerSecond !== undefined;
    coverage.audio = [
      (coverage.audio[0] as number) + (counted && call.price?.audioPerSecond !== undefined ? audio : 0),
      (coverage.audio[1] as number) + (billsAudio ? audio : 0),
    ];
    if (counted) {
      simulated += evaluation.amount ?? 0;
      continue;
    }
    if (evaluation.currency !== null && evaluation.currency !== currency) continue;
    if (evaluation.reason !== null) {
      const entry = reasons.get(evaluation.reason) ?? { requests: 0, modelKeys: new Set<string>() };
      entry.requests += 1;
      entry.modelKeys.add(modelKeyOf(call.model));
      reasons.set(evaluation.reason, entry);
    }
    const again = simulate(call);
    if (again !== undefined && again.currency === currency) {
      simulated += again.amount ?? 0;
      simulatedRequests += 1;
    } else {
      unavailable += 1;
    }
  }
  const pair = ([counted, total]: number[]) => ({ counted: text(counted ?? 0), total: text(total ?? 0) });
  return {
    unpriced: [...reasons.entries()].map(([reason, entry]) => ({ reason, requests: entry.requests, modelKeys: [...entry.modelKeys] })),
    coverage: { llmTokens: pair(coverage.llm), asrTokens: pair(coverage.asr), audioMs: pair(coverage.audio) },
    simulated: wantSimulation ? { cost: money(currency, simulated), requests: simulatedRequests, unavailable } : null,
  };
}

export function summaryResponse(scenario: FixtureScenario, query: UsageSummaryQuery): UsageSummaryResponse {
  const range = resolveRange(scenario, query);
  const calls = scenario.calls.filter((call) => matches(call, query, scenario));
  const allowed = allowedGranularities(range);
  const granularity = query.granularity !== undefined && allowed.includes(query.granularity) ? query.granularity : defaultGranularity(query, allowed);
  const colors = colorKeys(scenario);
  const currencies = [...new Set(scenario.calls.map((call) => call.price?.currency).filter((value): value is PriceCurrency => value !== undefined))];
  const llmCalls = calls.filter((call) => call.model.profile.modality === "llm");
  const reported = llmCalls.filter((call) => call.llm?.cacheRead !== undefined);
  const response: UsageSummaryResponse = {
    range: { preset: query.range, from: range.from, to: range.to },
    granularity,
    allowedGranularities: allowed,
    displayCurrency: query.displayCurrency,
    currencies,
    summary: {
      requests: calls.length,
      results: countResults(calls),
      cost: costCell(calls, query.displayCurrency),
      usage: usageOf(calls),
      cacheHit:
        reported.length === 0
          ? null
          : {
              cacheRead: text(sum(reported.map((call) => call.llm?.cacheRead ?? 0))),
              reportedInput: text(sum(reported.map((call) => call.llm?.input ?? 0))),
              reportedRequests: reported.length,
              llmRequests: llmCalls.length,
            },
      inputMissingRequests: llmCalls.filter((call) => call.llm !== undefined && call.llm.input === 0 && call.llm.output > 0).length,
      acceptedRequests: calls.filter((call) => call.accepted === true).length,
    },
    costDetail: buildCostDetail(calls, query.displayCurrency, query.simulate === "1"),
    series: USAGE_METRICS.map((metric) => buildSeries(calls, metric, query.displayCurrency, granularity, range, colors)),
    models: buildModels(calls, query.displayCurrency, colors),
    options: buildOptions(scenario, query),
  };
  return usageSummaryResponseSchema.parse(response);
}

// Activities ------------------------------------------------------------------------------------

function activityOf(group: FixtureGroup, items: readonly FixtureCall[], currency: PriceCurrency): UsageActivity {
  const byModel = new Map<string, FixtureCall[]>();
  for (const call of items) byModel.set(modelKeyOf(call.model), [...(byModel.get(modelKeyOf(call.model)) ?? []), call]);
  const models = [...byModel.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([modelKey, calls]) => ({ modelKey, profileName: (calls[0] as FixtureCall).model.profile.name, modelId: (calls[0] as FixtureCall).model.modelId, requests: calls.length }));
  const times = items.map((call) => call.at);
  return {
    group: group.id,
    kind: group.kind,
    startedAt: Math.min(...times),
    endedAt: Math.max(...times),
    title: group.title,
    contentId: group.contentId,
    taskId: group.taskId,
    chatMessageId: group.chatMessageId,
    features: [...new Set(items.map((call) => call.feature))] as UsageActivity["features"],
    models,
    credentialVersions: [...new Set(items.map(versionOf))],
    requests: items.length,
    results: countResults(items),
    usage: usageOf(items),
    cost: costCell(items, currency),
  };
}

export function activitiesResponse(scenario: FixtureScenario, query: UsageActivitiesQuery): UsageActivitiesResponse {
  const calls = scenario.calls.filter((call) => matches(call, query, scenario));
  const groups = new Map<string, FixtureCall[]>();
  for (const call of calls) groups.set(call.group.id, [...(groups.get(call.group.id) ?? []), call]);
  const all = [...groups.values()].map((items) => activityOf((items[0] as FixtureCall).group, items, query.displayCurrency)).sort((a, b) => b.startedAt - a.startedAt);
  const offset = (query.page - 1) * query.pageSize;
  return usageActivitiesResponseSchema.parse({ items: all.slice(offset, offset + query.pageSize), total: all.length, page: query.page, pageSize: query.pageSize });
}

function callOf(call: FixtureCall, currency: PriceCurrency): UsageCall {
  const evaluation = evaluateCall(call);
  const counted = evaluation.currency === currency && evaluation.amount !== null;
  const otherCurrency = evaluation.currency !== null && evaluation.currency !== currency;
  const profile = call.model.profile;
  const setAt = profile.versions.find((version) => version.id === call.version)?.setAt ?? null;
  return {
    id: call.id,
    modality: profile.modality,
    occurredAt: call.at,
    feature: call.feature,
    modelKey: modelKeyOf(call.model),
    profileName: profile.name,
    modelId: call.model.modelId,
    credentialVersion: call.version,
    credentialSetAt: setAt,
    result: call.result,
    accepted: call.accepted === true,
    inputMissing: call.llm !== undefined && call.llm.input === 0 && call.llm.output > 0,
    usage: usageOf([call]),
    cost: {
      status: counted ? "counted" : otherCurrency ? "other_currency" : "not_counted",
      amount: counted && evaluation.amount !== null ? money(currency, evaluation.amount) : null,
      currency: evaluation.currency,
      reason: counted || otherCurrency ? null : evaluation.reason,
    },
  };
}

export function callsResponse(scenario: FixtureScenario, query: UsageCallsQuery): UsageCallsResponse {
  const calls = scenario.calls.filter((call) => call.group.id === query.group && matches(call, query, scenario)).sort((a, b) => a.at - b.at);
  return usageCallsResponseSchema.parse({ items: calls.map((call) => callOf(call, query.displayCurrency)) });
}

export function cacheObservedResponse(scenario: FixtureScenario): UsageCacheObservedResponse {
  return usageCacheObservedResponseSchema.parse({ models: scenario.cacheObserved.map((model) => ({ modelKey: modelKeyOf(model) })) });
}
