import { USAGE_LEGACY_CREDENTIAL, type UsageActivity, type UsageCall } from "../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../shared/model-pricing.ts";
import {
  activityKeyText,
  parseActivityIdentity,
  USAGE_FLAG,
  type UsageActivityIdentity,
  type UsageActivityKey,
  type UsageActivityRow,
  type UsageCallRow,
} from "../domain/usage-analytics.ts";
import { toMoney, type GroupPricing } from "./usage-cost.ts";
import { modelKeyOf, ProfileDirectory } from "./usage-directory.ts";
import { evaluateGroups, totalsOf, type EvaluatedGroup, type PricingContext } from "./usage-summary.ts";

/** The activity key is JSON text produced by the database; clients only carry it around, base64url-wrapped. */
export function encodeGroup(keyText: string): string {
  return Buffer.from(keyText, "utf8").toString("base64url");
}

/**
 * The key text of a group, or `undefined` unless the group is exactly what `encodeGroup` makes
 * of the canonical text of a well-formed identity: a differently spelled equivalent would give
 * one activity two keys.
 */
export function decodeGroup(group: string): string | undefined {
  const text = Buffer.from(group, "base64url").toString("utf8");
  const identity = parseActivityIdentity(text);
  return identity !== undefined && activityKeyText(identity) === text && encodeGroup(text) === group ? text : undefined;
}

interface ActivityModel {
  modelKey: string;
  modelId: string;
  modality: "llm" | "asr";
  profileId: string;
  requests: number;
}

/** Counts of one thing per label, kept as an ordered list busiest first. */
function busiest(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([label]) => label);
}

function modelsOf(evaluated: ReadonlyArray<EvaluatedGroup<UsageActivityRow>>): ActivityModel[] {
  const models = new Map<string, ActivityModel>();
  for (const { group, modelKey } of evaluated) {
    const model = models.get(modelKey) ?? {
      modelKey,
      modelId: group.modelId,
      modality: group.modality,
      profileId: group.profileId,
      requests: 0,
    };
    model.requests += Number(group.requests);
    models.set(modelKey, model);
  }
  return [...models.values()].sort((a, b) => b.requests - a.requests || (a.modelKey < b.modelKey ? -1 : 1));
}

function countBy<T>(items: readonly T[], label: (item: T) => string, weight: (item: T) => number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(label(item), (counts.get(label(item)) ?? 0) + weight(item));
  }
  return counts;
}

/** The content ids the page of activities names, for one title lookup. */
export function contentIdsOf(rows: readonly UsageActivityRow[]): string[] {
  return [...new Set(rows.flatMap((row) => (row.contentId === null ? [] : [row.contentId])))];
}

/** Which of the activity's links the user can follow, read from its identity and its calls. */
function linksOf(
  identity: UsageActivityIdentity,
  rows: readonly UsageActivityRow[],
): { contentId: string | null; taskId: string | null; chatMessageId: string | null } {
  const contentId = identity.kind === "content_day" ? identity.contentId : (rows.find((row) => row.contentId !== null)?.contentId ?? null);
  return {
    contentId: identity.kind === "test" || identity.kind === "deleted_day" ? null : contentId,
    taskId: identity.kind === "task" ? identity.taskId : null,
    chatMessageId: identity.kind === "chat" ? identity.chatMessageId : null,
  };
}

export function activityDtos(
  keys: readonly UsageActivityKey[],
  rows: readonly UsageActivityRow[],
  titles: ReadonlyMap<string, string | null>,
  context: PricingContext,
  directory: ProfileDirectory,
): UsageActivity[] {
  const evaluated = evaluateGroups(rows, context);
  return keys.flatMap((key) => {
    const identity = parseActivityIdentity(key.key);
    const own = evaluated.filter((entry) => entry.group.key === key.key);
    if (identity === undefined || own.length === 0) {
      return [];
    }
    const links = linksOf(identity, own.map((entry) => entry.group));
    const totals = totalsOf(own, context.currency);
    return [
      {
        group: encodeGroup(key.key),
        kind: identity.kind,
        startedAt: key.startedAt,
        endedAt: key.endedAt,
        title: links.contentId === null ? null : (titles.get(links.contentId) ?? null),
        ...links,
        features: busiest(countBy(own, (entry) => entry.group.feature, (entry) => Number(entry.group.requests))) as UsageActivity["features"],
        models: modelsOf(own).map((model) => ({
          modelKey: model.modelKey,
          profileName: directory.nameOf(model.modality, model.profileId),
          modelId: model.modelId,
          requests: model.requests,
        })),
        credentialVersions: busiest(
          countBy(own, (entry) => entry.group.credentialVersion ?? USAGE_LEGACY_CREDENTIAL, (entry) => Number(entry.group.requests)),
        ),
        requests: totals.requestCount(),
        results: totals.resultCounts(),
        usage: totals.usage(),
        cost: totals.costCell(),
      },
    ];
  });
}

/** What one call contributes: its amount, or why it contributes none. */
function callCost(pricing: GroupPricing, currency: PriceCurrency): UsageCall["cost"] {
  if (pricing.kind === "no_snapshot") {
    return { status: "not_counted", amount: null, currency: null, reason: "no_snapshot" };
  }
  if (pricing.currency !== null && pricing.currency !== currency) {
    return { status: "other_currency", amount: null, currency: pricing.currency, reason: null };
  }
  if (pricing.kind === "counted") {
    return { status: "counted", amount: toMoney(currency, pricing.cost), currency, reason: null };
  }
  return { status: "not_counted", amount: null, currency: pricing.currency, reason: pricing.reason };
}

export function callDtos(rows: readonly UsageCallRow[], context: PricingContext, directory: ProfileDirectory): UsageCall[] {
  return evaluateGroups(rows, context).map(({ group, pricing }) => ({
    id: group.id,
    modality: group.modality,
    occurredAt: group.occurredAt,
    feature: group.feature as UsageCall["feature"],
    modelKey: modelKeyOf(group),
    profileName: directory.nameOf(group.modality, group.profileId),
    modelId: group.modelId,
    credentialVersion: group.credentialVersion,
    credentialSetAt: group.credentialSetAt,
    result: group.result,
    accepted: (group.flags & USAGE_FLAG.accepted) !== 0,
    inputMissing: (group.flags & USAGE_FLAG.inputMissing) !== 0,
    usage: totalsOf([{ group, pricing, modelKey: modelKeyOf(group) }], context.currency).usage(),
    cost: callCost(pricing, context.currency),
  }));
}
