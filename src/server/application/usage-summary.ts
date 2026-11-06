import {
  USAGE_LEGACY_CREDENTIAL,
  type UsageColorKey,
  type UsageSummaryResponse,
  type UsageModality,
} from "../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../shared/model-pricing.ts";
import type { UsageCurrentPricing, UsageGroupRow, UsageIdentityRow } from "../domain/usage-analytics.ts";
import { modelKeyOf, profileKeyOf, ProfileDirectory } from "./usage-directory.ts";
import { priceGroup, SnapshotReader, toMoney, type GroupPricing } from "./usage-cost.ts";
import { UsageTotals, type PricedInput } from "./usage-totals.ts";

/** Everything pricing a group needs: the currency the page shows and a shared snapshot cache. */
export interface PricingContext {
  currency: PriceCurrency;
  reader: SnapshotReader;
}

export interface EvaluatedGroup<G extends PricedInput = PricedInput> {
  group: G;
  pricing: GroupPricing;
  modelKey: string;
}

/**
 * Prices each group. The few models behind many groups share one key computation, and the few
 * snapshots share one reading.
 */
export function evaluateGroups<G extends PricedInput>(groups: readonly G[], context: PricingContext): Array<EvaluatedGroup<G>> {
  const keys = new Map<string, string>();
  const keyOf = (group: G): string => {
    const slot = `${group.modality}\u0000${group.profileId}\u0000${group.modelId}`;
    let key = keys.get(slot);
    if (key === undefined) {
      key = modelKeyOf(group);
      keys.set(slot, key);
    }
    return key;
  };
  return groups.map((group) => ({
    group,
    pricing: priceGroup(group, context.reader.read(group.snapshotJson, group.modality)),
    modelKey: keyOf(group),
  }));
}

export function totalsOf(evaluated: readonly EvaluatedGroup[], currency: PriceCurrency): UsageTotals {
  const totals = new UsageTotals(currency);
  for (const { group, pricing, modelKey } of evaluated) {
    totals.add(group, pricing, modelKey);
  }
  return totals;
}

export interface ModelAggregate {
  modelKey: string;
  modality: UsageModality;
  profileId: string;
  modelId: string;
  totals: UsageTotals;
  /** Credential version (or the legacy marker) to the latest time it was used. */
  versions: Map<string, number>;
}

/** One aggregate per model, folded from the evaluated groups. */
export function aggregateModels(evaluated: readonly EvaluatedGroup<UsageGroupRow>[], currency: PriceCurrency): Map<string, ModelAggregate> {
  const models = new Map<string, ModelAggregate>();
  for (const { group, pricing, modelKey } of evaluated) {
    let model = models.get(modelKey);
    if (model === undefined) {
      model = {
        modelKey,
        modality: group.modality,
        profileId: group.profileId,
        modelId: group.modelId,
        totals: new UsageTotals(currency),
        versions: new Map(),
      };
      models.set(modelKey, model);
    }
    model.totals.add(group, pricing, modelKey);
    const version = group.credentialVersion ?? USAGE_LEGACY_CREDENTIAL;
    model.versions.set(version, Math.max(model.versions.get(version) ?? 0, group.lastAt));
  }
  return models;
}

/** Busiest first; the order of the table and of the colour assignment. */
export function rankedModels(models: ReadonlyMap<string, ModelAggregate>): ModelAggregate[] {
  return [...models.values()].sort((a, b) => b.totals.requestCount() - a.totals.requestCount() || (a.modelKey < b.modelKey ? -1 : 1));
}

export function modelDtos(
  models: readonly ModelAggregate[],
  colors: ReadonlyMap<string, UsageColorKey>,
  directory: ProfileDirectory,
): UsageSummaryResponse["models"] {
  return models.map((model) => ({
    modelKey: model.modelKey,
    profileKey: profileKeyOf(model),
    modality: model.modality,
    profileName: directory.nameOf(model.modality, model.profileId),
    profileDeleted: directory.isDeleted(model.modality, model.profileId),
    modelId: model.modelId,
    credentialVersions: [...model.versions.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([version]) => version),
    colorKey: colors.get(model.modelKey) as UsageColorKey,
    requests: model.totals.requestCount(),
    results: model.totals.resultCounts(),
    usage: model.totals.usage(),
    cost: model.totals.costCell(),
  }));
}

interface ProfileOption {
  profileKey: string;
  modality: UsageModality;
  profileId: string;
  versions: Map<string, { setAt: number | null; requests: number }>;
}

function compareNullableText(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null || b === null) {
    return a === null ? 1 : -1;
  }
  return a < b ? -1 : 1;
}

/** Profiles, credential versions and models seen in a time range, regardless of the other filters. */
export function optionsDto(identities: readonly UsageIdentityRow[], directory: ProfileDirectory): UsageSummaryResponse["options"] {
  const profiles = new Map<string, ProfileOption>();
  const models = new Map<string, { modelKey: string; profileKey: string; modelId: string; modality: UsageModality }>();
  for (const identity of identities) {
    const profileKey = profileKeyOf(identity);
    const profile = profiles.get(profileKey) ?? { profileKey, modality: identity.modality, profileId: identity.profileId, versions: new Map() };
    profiles.set(profileKey, profile);
    const version = identity.credentialVersion ?? USAGE_LEGACY_CREDENTIAL;
    const known = profile.versions.get(version);
    profile.versions.set(version, { setAt: identity.credentialSetAt ?? known?.setAt ?? null, requests: (known?.requests ?? 0) + identity.requests });
    const modelKey = modelKeyOf(identity);
    models.set(modelKey, { modelKey, profileKey, modelId: identity.modelId, modality: identity.modality });
  }
  const named = [...profiles.values()].map((profile) => ({ ...profile, name: directory.nameOf(profile.modality, profile.profileId) }));
  named.sort((a, b) => compareModality(a.modality, b.modality) || compareNullableText(a.name, b.name) || compareNullableText(a.profileKey, b.profileKey));
  return {
    profiles: named.map((profile) => ({
      profileKey: profile.profileKey,
      modality: profile.modality,
      profileName: profile.name,
      deleted: directory.isDeleted(profile.modality, profile.profileId),
      versions: [...profile.versions.entries()]
        .map(([credentialVersion, value]) => ({ credentialVersion, setAt: value.setAt, requests: value.requests }))
        .sort((a, b) => (b.setAt ?? -1) - (a.setAt ?? -1) || compareNullableText(a.credentialVersion, b.credentialVersion)),
    })),
    models: [...models.values()]
      .sort((a, b) => compareModality(a.modality, b.modality) || compareNullableText(a.profileKey, b.profileKey) || compareNullableText(a.modelId, b.modelId))
      .map(({ modelKey, profileKey, modelId }) => ({ modelKey, profileKey, modelId })),
  };
}

function compareModality(a: UsageModality, b: UsageModality): number {
  return a === b ? 0 : a === "llm" ? -1 : 1;
}

/**
 * What the calls with no price snapshot would cost at the price their model has now. Only a
 * price in the display currency that the call's modality can use is applied, and only to
 * calls whose profile still exists; everything else is counted as unavailable.
 */
export function simulate(
  evaluated: readonly EvaluatedGroup[],
  currentPricing: readonly UsageCurrentPricing[],
  context: PricingContext,
): { cost: { currency: PriceCurrency; amount: string }; requests: number; unavailable: number } {
  const current = new Map(currentPricing.map((entry) => [JSON.stringify([entry.modality, entry.profileId, entry.modelId]), entry.pricingJson]));
  let cost = 0n;
  let priced = 0n;
  let unavailable = 0n;
  for (const { group, pricing } of evaluated) {
    if (pricing.kind !== "no_snapshot") {
      continue;
    }
    const json = current.get(JSON.stringify([group.modality, group.profileId, group.modelId])) ?? null;
    const reading = context.reader.read(json, group.modality);
    const simulated = reading.kind === "valid" && reading.currency === context.currency ? priceGroup(group, reading) : undefined;
    if (simulated?.kind === "counted") {
      cost += simulated.cost;
      priced += group.requests;
    } else {
      unavailable += group.requests;
    }
  }
  return { cost: toMoney(context.currency, cost), requests: Number(priced), unavailable: Number(unavailable) };
}
