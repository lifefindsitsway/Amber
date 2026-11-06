import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import {
  USAGE_GRANULARITIES,
  USAGE_METRICS,
  USAGE_RANGES,
  type UsageActivitiesQuery,
  type UsageCallsQuery,
  type UsageGranularity,
  type UsageMetric,
  type UsageRange,
  type UsageSummaryQuery,
} from "../../../shared/dto/usage-analytics.ts";
import { PAGE_PARAM } from "../../ui/pagination.tsx";
import { PRICE_CURRENCIES, type PriceCurrency } from "../../../shared/model-pricing.ts";
import type { ListPageSize } from "../../../shared/list-pagination.ts";
import { useStoredValue } from "../../use-stored-value.ts";

/** Local UI preference: the currency the page last showed amounts in. */
export const USAGE_CURRENCY_STORAGE_KEY = "amber.usage.currency";

export const USAGE_RANGE_DEFAULT: UsageRange = "7d";
export const USAGE_METRIC_DEFAULT: UsageMetric = "cost";
/** Shown when nothing says otherwise; also the display currency of a history that has both. */
export const USAGE_CURRENCY_FALLBACK: PriceCurrency = "CNY";

export const USAGE_VIEWS = ["trend", "models"] as const;
export type UsageView = (typeof USAGE_VIEWS)[number];

/** Everything the page remembers in the address bar; `currency` stays unset until it is chosen or resolved. */
export interface UsageState {
  range: UsageRange;
  from?: number;
  to?: number;
  currency?: PriceCurrency;
  profileKey?: string;
  credentialVersion?: string;
  modelKey?: string;
  granularity?: UsageGranularity;
  view: UsageView;
  metric: UsageMetric;
  simulate: boolean;
}

/** `null` removes a value; a missing key leaves it alone. */
export type UsagePatch = {
  [Key in "range" | "from" | "to" | "currency" | "profileKey" | "credentialVersion" | "modelKey" | "granularity" | "view" | "metric" | "simulate"]?: UsageState[Key] | null;
};

const PARAM = {
  range: "range",
  from: "from",
  to: "to",
  currency: "currency",
  profileKey: "profile",
  credentialVersion: "credential",
  modelKey: "model",
  granularity: "granularity",
  view: "view",
  metric: "metric",
  simulate: "simulate",
} as const;

function oneOf<T extends string>(values: readonly T[], raw: string | null): T | undefined {
  return values.find((value) => value === raw);
}

function timestamp(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function nonEmpty(raw: string | null): string | undefined {
  return raw === null || raw === "" ? undefined : raw;
}

/** Reads the page state out of the address bar, falling back to defaults for anything malformed. */
export function parseUsageState(search: URLSearchParams): UsageState {
  let range = oneOf(USAGE_RANGES, search.get(PARAM.range)) ?? USAGE_RANGE_DEFAULT;
  const from = timestamp(search.get(PARAM.from));
  const to = timestamp(search.get(PARAM.to));
  const customValid = from !== undefined && to !== undefined && from < to;
  if (range === "custom" && !customValid) range = USAGE_RANGE_DEFAULT;
  const profileKey = nonEmpty(search.get(PARAM.profileKey));
  const credentialVersion = profileKey === undefined ? undefined : nonEmpty(search.get(PARAM.credentialVersion));
  const modelKey = nonEmpty(search.get(PARAM.modelKey));
  const currency = oneOf(PRICE_CURRENCIES, search.get(PARAM.currency));
  const granularity = oneOf(USAGE_GRANULARITIES, search.get(PARAM.granularity));
  return {
    range,
    ...(range === "custom" && from !== undefined && to !== undefined ? { from, to } : {}),
    ...(currency === undefined ? {} : { currency }),
    ...(profileKey === undefined ? {} : { profileKey }),
    ...(credentialVersion === undefined ? {} : { credentialVersion }),
    ...(modelKey === undefined ? {} : { modelKey }),
    ...(granularity === undefined ? {} : { granularity }),
    view: oneOf(USAGE_VIEWS, search.get(PARAM.view)) ?? "trend",
    metric: oneOf(USAGE_METRICS, search.get(PARAM.metric)) ?? USAGE_METRIC_DEFAULT,
    simulate: search.get(PARAM.simulate) === "1",
  };
}

/** Values equal to their default are left out of the address. */
export function usageStateToSearch(state: UsageState, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const name of Object.values(PARAM)) next.delete(name);
  if (state.range !== USAGE_RANGE_DEFAULT) next.set(PARAM.range, state.range);
  if (state.range === "custom" && state.from !== undefined && state.to !== undefined) {
    next.set(PARAM.from, String(state.from));
    next.set(PARAM.to, String(state.to));
  }
  if (state.currency !== undefined) next.set(PARAM.currency, state.currency);
  if (state.profileKey !== undefined) next.set(PARAM.profileKey, state.profileKey);
  if (state.credentialVersion !== undefined) next.set(PARAM.credentialVersion, state.credentialVersion);
  if (state.modelKey !== undefined) next.set(PARAM.modelKey, state.modelKey);
  if (state.granularity !== undefined) next.set(PARAM.granularity, state.granularity);
  if (state.view !== "trend") next.set(PARAM.view, state.view);
  if (state.metric !== USAGE_METRIC_DEFAULT) next.set(PARAM.metric, state.metric);
  if (state.simulate) next.set(PARAM.simulate, "1");
  return next;
}

/** Applies a patch; a change of range, profile or bucket size also resets what depended on the old one. */
function applyPatch(state: UsageState, patch: UsagePatch): UsageState {
  const next: UsageState = { ...state };
  const record = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete record[key];
    else record[key] = value;
  }
  // A preset range carries no bounds; a new range or drill target starts at the range's own bucket size.
  if (patch.range !== undefined && patch.range !== "custom") {
    delete next.from;
    delete next.to;
  }
  if (patch.range !== undefined && patch.granularity === undefined) delete next.granularity;
  if (patch.profileKey === null && patch.credentialVersion === undefined) delete next.credentialVersion;
  if (next.profileKey === undefined) delete next.credentialVersion;
  next.view = next.view ?? "trend";
  next.metric = next.metric ?? USAGE_METRIC_DEFAULT;
  next.range = next.range ?? USAGE_RANGE_DEFAULT;
  next.simulate = next.simulate ?? false;
  return next;
}

/** Whether a patch changes what the data is about (and so sends the record list back to page 1). */
function changesScope(patch: UsagePatch): boolean {
  return (["range", "from", "to", "profileKey", "credentialVersion", "modelKey"] as const).some((key) => key in patch);
}

/** The next address for a patch; exported for tests. */
export function patchUsageSearch(search: URLSearchParams, patch: UsagePatch): URLSearchParams {
  const state = applyPatch(parseUsageState(search), patch);
  const next = usageStateToSearch(state, search);
  if (changesScope(patch)) next.delete(PAGE_PARAM);
  return next;
}

/** Single currency in the owner's history, else the fallback. */
export function defaultUsageCurrency(currencies: readonly PriceCurrency[]): PriceCurrency {
  return currencies.length === 1 && currencies[0] !== undefined ? currencies[0] : USAGE_CURRENCY_FALLBACK;
}

export interface UsageStateHandle {
  state: UsageState;
  /** The currency to ask for: the chosen one, else the remembered one, else the fallback until the history says better. */
  currency: PriceCurrency;
  /** Whether the user (or an earlier visit) fixed the currency; if not, the history decides once it is known. */
  currencyChosen: boolean;
  /** The currency of an earlier visit, kept as a local preference. */
  remembered: PriceCurrency | undefined;
  patch(patch: UsagePatch, options?: { replace?: boolean }): void;
  /** Fixes the currency in the address and as the remembered preference. */
  chooseCurrency(currency: PriceCurrency, options?: { replace?: boolean }): void;
}

export function useUsageState(): UsageStateHandle {
  const [search, setSearch] = useSearchParams();
  const [stored, setStored] = useStoredValue(USAGE_CURRENCY_STORAGE_KEY);
  const state = useMemo(() => parseUsageState(search), [search]);
  const rememberedCurrency = PRICE_CURRENCIES.find((currency) => currency === stored);
  const currency = state.currency ?? rememberedCurrency;

  const patch = useCallback(
    (change: UsagePatch, options: { replace?: boolean } = {}) => {
      setSearch((previous) => patchUsageSearch(previous, change), { replace: options.replace === true });
    },
    [setSearch],
  );
  const chooseCurrency = useCallback(
    (next: PriceCurrency, options: { replace?: boolean } = {}) => {
      setStored(next);
      setSearch((previous) => patchUsageSearch(previous, { currency: next }), { replace: options.replace === true });
    },
    [setSearch, setStored],
  );
  return { state, currency: currency ?? USAGE_CURRENCY_FALLBACK, currencyChosen: currency !== undefined, remembered: rememberedCurrency, patch, chooseCurrency };
}

// Queries ---------------------------------------------------------------------------------------

type FilterFields = Pick<UsageSummaryQuery, "range" | "from" | "to" | "profileKey" | "credentialVersion" | "modelKey">;

function filterOf(state: UsageState): FilterFields {
  return {
    range: state.range,
    ...(state.range === "custom" && state.from !== undefined && state.to !== undefined ? { from: state.from, to: state.to } : {}),
    ...(state.profileKey === undefined ? {} : { profileKey: state.profileKey }),
    ...(state.credentialVersion === undefined ? {} : { credentialVersion: state.credentialVersion }),
    ...(state.modelKey === undefined ? {} : { modelKey: state.modelKey }),
  };
}

export function summaryQueryOf(state: UsageState, currency: PriceCurrency): UsageSummaryQuery {
  return {
    ...filterOf(state),
    displayCurrency: currency,
    ...(state.granularity === undefined ? {} : { granularity: state.granularity }),
    ...(state.simulate ? { simulate: "1" as const } : {}),
  };
}

export function activitiesQueryOf(state: UsageState, currency: PriceCurrency, position: { page: number; pageSize: ListPageSize }): UsageActivitiesQuery {
  return { ...filterOf(state), displayCurrency: currency, page: position.page, pageSize: position.pageSize };
}

export function callsQueryOf(state: UsageState, currency: PriceCurrency, group: string): UsageCallsQuery {
  return { ...filterOf(state), displayCurrency: currency, group };
}

/** Whether any of the three menu filters (credential, model) is set; the range and currency are not filters. */
export function hasUsageFilter(state: UsageState): boolean {
  return state.profileKey !== undefined || state.credentialVersion !== undefined || state.modelKey !== undefined;
}
