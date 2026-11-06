import {
  decodeModelKey,
  decodeProfileKey,
  encodeModelKey,
  USAGE_LEGACY_CREDENTIAL,
  type UsageActivitiesQuery,
  type UsageActivitiesResponse,
  type UsageCacheObservedResponse,
  type UsageCallsQuery,
  type UsageCallsResponse,
  type UsageGranularity,
  type UsageModality,
  type UsageRange,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
} from "../../shared/dto/usage-analytics.ts";
import { PRICE_CURRENCIES, type PriceCurrency } from "../../shared/model-pricing.ts";
import { amberError } from "../domain/errors.ts";
import type { UsageBucketRow, UsageIdentityRow, UsageScope } from "../domain/usage-analytics.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { UsageAnalyticsRepository } from "../ports/usage-analytics.ts";
import { activityDtos, callDtos, contentIdsOf, decodeGroup } from "./usage-activities.ts";
import { SnapshotReader } from "./usage-cost.ts";
import { ProfileDirectory } from "./usage-directory.ts";
import { assignColors, buildSeries, type BucketedGroup } from "./usage-series.ts";
import {
  aggregateModels,
  evaluateGroups,
  modelDtos,
  optionsDto,
  rankedModels,
  simulate,
  totalsOf,
  type EvaluatedGroup,
  type PricingContext,
} from "./usage-summary.ts";
import { allowedGranularities, bucketsOf, defaultGranularity, resolveRange, type ResolvedRange } from "./usage-time.ts";

interface FilterFields {
  range: UsageRange;
  from?: number | undefined;
  to?: number | undefined;
  profileKey?: string | undefined;
  credentialVersion?: string | undefined;
  modelKey?: string | undefined;
  modality?: "llm" | "asr" | undefined;
}

function invalidFilter(field: string): never {
  throw amberError("invalid_request", `invalid usage filter ${field}`, { params: { detail: field } });
}

/** The owner and the non-time filters of a query; keys that this server did not issue are refused. */
function filterScope(owner: string, query: FilterFields): UsageScope {
  const profile = query.profileKey === undefined ? undefined : decodeProfileKey(query.profileKey);
  const model = query.modelKey === undefined ? undefined : decodeModelKey(query.modelKey);
  if (query.profileKey !== undefined && profile === undefined) {
    invalidFilter("profileKey");
  }
  if (query.modelKey !== undefined && model === undefined) {
    invalidFilter("modelKey");
  }
  return {
    owner,
    ...(query.modality === undefined ? {} : { modality: query.modality }),
    ...(profile === undefined ? {} : { profile: { modality: profile[0], profileId: profile[1] } }),
    ...(model === undefined ? {} : { model: { modality: model[0], profileId: model[1], modelId: model[2] } }),
    ...(query.credentialVersion === undefined ? {} : { credentialVersion: query.credentialVersion === USAGE_LEGACY_CREDENTIAL ? null : query.credentialVersion }),
  };
}

/** The time bounds of a list query. `all` has no lower bound, so no lookup of the earliest call is needed. */
function timeBounds(query: FilterFields, now: number): { from?: number; to: number } {
  const range = resolveRange(query, now, () => null);
  return { ...(range.from === null ? {} : { from: range.from }), to: range.to };
}

/** Whether the query narrows by nothing but time, so the menus are the same groups the summary reads. */
function isTimeOnly(scope: UsageScope): boolean {
  return scope.modality === undefined && scope.profile === undefined && scope.model === undefined && scope.credentialVersion === undefined;
}

/** The menus' rows, folded from groups that already carry every model and credential version. */
function identitiesOf(groups: readonly UsageBucketRow[]): UsageIdentityRow[] {
  const identities = new Map<string, UsageIdentityRow>();
  for (const group of groups) {
    const key = JSON.stringify([group.modality, group.profileId, group.modelId, group.credentialVersion]);
    const known = identities.get(key);
    identities.set(key, {
      modality: group.modality,
      profileId: group.profileId,
      modelId: group.modelId,
      credentialVersion: group.credentialVersion,
      credentialSetAt: known?.credentialSetAt ?? group.credentialSetAt,
      requests: (known?.requests ?? 0) + Number(group.requests),
    });
  }
  return [...identities.values()];
}

function currenciesOf(found: readonly string[]): PriceCurrency[] {
  return PRICE_CURRENCIES.filter((currency) => found.includes(currency));
}

export interface UsageAnalyticsOptions {
  repository: UsageAnalyticsRepository;
  now?: () => number;
}

/**
 * The analyses behind the AI usage page. Each answers from SQL-grouped integer sums, prices
 * them group by group against the price frozen with each call, and shows one display
 * currency without ever converting between currencies.
 */
export class UsageAnalyticsService {
  private readonly repository: UsageAnalyticsRepository;
  private readonly now: () => number;

  constructor(options: UsageAnalyticsOptions) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
  }

  summary(principal: RequestPrincipal, query: UsageSummaryQuery): UsageSummaryResponse {
    const owner = principal.userId;
    const filter = filterScope(owner, query);
    const range = resolveRange(query, this.now(), () => this.repository.earliest(filter));
    const allowed = allowedGranularities(range);
    const granularity = this.chooseGranularity(query.granularity, range, allowed);
    const scope: UsageScope = { ...filter, ...(range.from === null ? {} : { from: range.from }), to: range.to };
    const context: PricingContext = { currency: query.displayCurrency, reader: new SnapshotReader() };

    // One pass over the range serves the totals, the model table, the series and, when no
    // other filter narrows it, the menus: all of them are sums over these groups.
    const evaluated = evaluateGroups(range.from === null ? [] : this.repository.groupsByBucket(scope, granularity), context);
    const totals = totalsOf(evaluated, context.currency);
    const models = rankedModels(aggregateModels(evaluated, context.currency));
    const colors = assignColors(models.map((model) => ({ modelKey: model.modelKey, requests: model.totals.requestCount() })));
    const identities = isTimeOnly(filter)
      ? identitiesOf(evaluated.map((entry) => entry.group))
      : this.repository.identities(this.optionsScope(owner, query.range, range));
    const directory = this.directory(owner, [...evaluated.map((entry) => entry.group), ...identities]);

    return {
      range: { preset: range.preset, from: range.from, to: range.to },
      granularity,
      allowedGranularities: allowed,
      displayCurrency: query.displayCurrency,
      currencies: currenciesOf(this.repository.currencies(owner)),
      summary: {
        requests: totals.requestCount(),
        results: totals.resultCounts(),
        cost: totals.costCell(),
        usage: totals.usage(),
        cacheHit: totals.cacheHit(),
        inputMissingRequests: totals.inputMissingRequests(),
        acceptedRequests: totals.acceptedRequests(),
      },
      costDetail: {
        unpriced: totals.unpriced(),
        coverage: totals.coverage(),
        simulated: query.simulate === "1" ? simulate(evaluated, this.repository.currentPricing(owner), context) : null,
      },
      series: this.series(range, granularity, evaluated, colors, context.currency),
      models: modelDtos(models, colors, directory),
      options: optionsDto(identities, directory),
    };
  }

  activities(principal: RequestPrincipal, query: UsageActivitiesQuery): UsageActivitiesResponse {
    const owner = principal.userId;
    const scope: UsageScope = { ...filterScope(owner, query), ...timeBounds(query, this.now()) };
    const page = this.repository.activityKeys(scope, { limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
    const rows = this.repository.activityGroups(scope, page.items);
    const context: PricingContext = { currency: query.displayCurrency, reader: new SnapshotReader() };
    const directory = this.directory(owner, rows);
    const titles = this.repository.contentTitles(owner, contentIdsOf(rows));
    return { items: activityDtos(page.items, rows, titles, context, directory), total: page.total, page: query.page, pageSize: query.pageSize };
  }

  calls(principal: RequestPrincipal, query: UsageCallsQuery): UsageCallsResponse {
    const owner = principal.userId;
    const key = decodeGroup(query.group);
    if (key === undefined) {
      invalidFilter("group");
    }
    const scope: UsageScope = { ...filterScope(owner, query), ...timeBounds(query, this.now()) };
    const rows = this.repository.calls(scope, key);
    // A group of another owner, or one the filters leave empty, is indistinguishable from a made-up key.
    if (rows.length === 0) {
      invalidFilter("group");
    }
    const context: PricingContext = { currency: query.displayCurrency, reader: new SnapshotReader() };
    return { items: callDtos(rows, context, this.directory(owner, rows)) };
  }

  cacheObserved(principal: RequestPrincipal): UsageCacheObservedResponse {
    const models = this.repository.cacheObserved(principal.userId);
    return { models: models.map((model) => ({ modelKey: encodeModelKey(["llm", model.profileId, model.modelId]) })) };
  }

  private chooseGranularity(requested: UsageGranularity | undefined, range: ResolvedRange, allowed: readonly UsageGranularity[]): UsageGranularity {
    if (requested === undefined) {
      return defaultGranularity(range);
    }
    if (!allowed.includes(requested)) {
      const suggestedGranularity = allowed[0] as UsageGranularity;
      throw amberError("invalid_request", "granularity too fine for the range", {
        code: "invalid_request.usage_granularity",
        details: { suggestedGranularity },
      });
    }
    return requested;
  }

  /** The menus cover the time range only, so no other filter narrows them; `all` has no lower bound. */
  private optionsScope(owner: string, preset: UsageRange, range: ResolvedRange): UsageScope {
    return { owner, ...(preset === "all" || range.from === null ? {} : { from: range.from }), to: range.to };
  }

  /** Current profile names, plus the recorded names of the used profiles that have since been deleted. */
  private directory(owner: string, used: Iterable<{ modality: UsageModality; profileId: string }>): ProfileDirectory {
    const current = this.repository.profileNames(owner);
    const missing = new ProfileDirectory(current).missing(used);
    return new ProfileDirectory(current, this.repository.recordedProfileNames(owner, missing));
  }

  private series(
    range: ResolvedRange,
    granularity: UsageGranularity,
    evaluated: ReadonlyArray<EvaluatedGroup<UsageBucketRow>>,
    colors: ReturnType<typeof assignColors>,
    currency: PriceCurrency,
  ): UsageSummaryResponse["series"] {
    const buckets = bucketsOf(granularity, range);
    const indexOf = new Map(buckets.map((bucket, index) => [bucket.start, index]));
    const groups: BucketedGroup[] = evaluated.flatMap((entry) => {
      const bucketIndex = indexOf.get(entry.group.bucketStart);
      return bucketIndex === undefined ? [] : [{ ...entry, bucketIndex }];
    });
    return buildSeries(buckets, groups, colors, currency);
  }
}
