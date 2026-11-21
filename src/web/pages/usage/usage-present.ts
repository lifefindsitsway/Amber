import type { TFunction } from "i18next";
import {
  decodeModelKey,
  encodeProfileKey,
  USAGE_LEGACY_CREDENTIAL,
  type UsageCall,
  type UsageCostCell,
  type UsageModalityUsage,
  type UsageResult,
  type UsageSummaryResponse,
  type UsageUnpricedReason,
} from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { beijingDateParts, formatBeijingShortDate, formatBeijingShortDateTime, formatCompactCount, formatCount, formatDuration, formatMoney } from "../../format.ts";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_SECOND = 1000;

/** A model as the menus and rows name it: its profile, then its id. */
export interface ModelNaming {
  modelKey: string;
  profileName: string | null;
  modelId: string;
}

/** Name of a profile, with the reasons a name may be missing spelled out. */
export function profileName(name: string | null, deleted: boolean, modelKey: string | undefined, t: TFunction): string {
  if (name !== null) return deleted ? t("usage.names.deletedSuffix", { name }) : name;
  const parts = modelKey === undefined ? undefined : decodeModelKey(modelKey);
  return parts?.[1] === "" ? t("usage.names.indistinct") : t("usage.names.deletedProfile");
}

/** `Profile · model`; models of different profiles never share a label. */
export function modelLabel(model: ModelNaming, t: TFunction, deleted = false): string {
  return t("usage.names.model", { profile: profileName(model.profileName, deleted, model.modelKey, t), model: model.modelId });
}

/** The profile key of a model key; `undefined` for a key this client cannot read. */
export function profileKeyOfModel(modelKey: string): string | undefined {
  const parts = decodeModelKey(modelKey);
  return parts === undefined ? undefined : encodeProfileKey([parts[0], parts[1]]);
}

// Credential versions ---------------------------------------------------------------------------

type OptionProfile = UsageSummaryResponse["options"]["profiles"][number];
type OptionVersion = OptionProfile["versions"][number];

/** How one credential version is named wherever it appears: the credential menu, the by-model rows and the call rows. */
export interface CredentialVersionLabel {
  credentialVersion: string;
  text: string;
  /** Calls recorded before versions were kept: not one known key, so never written as one. */
  legacy: boolean;
  setAt: number | null;
}

export interface ProfileVersionLabels {
  /**
   * The range holds two or more versions of the profile (the early records count as one), so a
   * row says which it used. Taken from the range alone, never from the model or credential
   * filter, so switching a filter never makes a row's tag appear or vanish.
   */
  distinct: boolean;
  versions: ReadonlyMap<string, CredentialVersionLabel>;
}

/** Labels by profile key. */
export type CredentialVersionLabels = ReadonlyMap<string, ProfileVersionLabels>;

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Oldest first; a version without a saved time sorts after every dated one; the id settles ties so the order is stable. */
function bySaved(a: OptionVersion, b: OptionVersion): number {
  if (a.setAt !== b.setAt) {
    if (a.setAt === null) return 1;
    if (b.setAt === null) return -1;
    return a.setAt - b.setAt;
  }
  return compareText(a.credentialVersion, b.credentialVersion);
}

/** Groups items by a key, keeping the first-seen order of keys and items. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
}

/**
 * Names every credential version of every profile, telling the versions of one profile apart
 * with as little as it takes: the day it was saved (with the year when that is not `now`'s
 * year), then the time of day for versions saved the same day, then an ordinal by saving order
 * for those still alike (the same minute, or no saved time at all). The early records keep their
 * own name and take no ordinal. Nothing about a key itself is ever part of a label.
 */
export function buildCredentialVersionLabels(profiles: readonly OptionProfile[], t: TFunction, now: number): CredentialVersionLabels {
  const result = new Map<string, ProfileVersionLabels>();
  for (const profile of profiles) {
    const versions = new Map<string, CredentialVersionLabel>();
    const keyed = profile.versions.filter((version) => version.credentialVersion !== USAGE_LEGACY_CREDENTIAL).sort(bySaved);
    const texts = new Map<string, string>(
      keyed.map((version) => [
        version.credentialVersion,
        version.setAt === null ? t("usage.names.unknownVersion") : t("usage.names.versionSince", { date: formatBeijingShortDate(version.setAt, now) }),
      ]),
    );
    const textOf = (version: OptionVersion): string => texts.get(version.credentialVersion) ?? "";
    for (const same of groupBy(keyed, textOf)) {
      if (same.length < 2) continue;
      for (const version of same) {
        if (version.setAt !== null) texts.set(version.credentialVersion, t("usage.names.versionSince", { date: formatBeijingShortDateTime(version.setAt, now) }));
      }
    }
    for (const same of groupBy(keyed, textOf)) {
      if (same.length < 2) continue;
      same.forEach((version, index) => texts.set(version.credentialVersion, t("usage.names.versionOrdinal", { label: textOf(version), n: index + 1 })));
    }
    for (const version of profile.versions) {
      const legacy = version.credentialVersion === USAGE_LEGACY_CREDENTIAL;
      versions.set(version.credentialVersion, {
        credentialVersion: version.credentialVersion,
        text: legacy ? t("usage.names.legacyCredential") : textOf(version),
        legacy,
        setAt: legacy ? null : version.setAt,
      });
    }
    result.set(profile.profileKey, { distinct: profile.versions.length >= 2, versions });
  }
  return result;
}

/**
 * The label of one version of a profile. A version the range does not list (which the server
 * never sends) is named on its own terms rather than left blank.
 */
export function credentialVersionLabelOf(
  labels: CredentialVersionLabels,
  profileKey: string | undefined,
  credentialVersion: string | null,
  setAt: number | null,
  t: TFunction,
  now: number,
): CredentialVersionLabel {
  const id = credentialVersion ?? USAGE_LEGACY_CREDENTIAL;
  const known = profileKey === undefined ? undefined : labels.get(profileKey)?.versions.get(id);
  if (known !== undefined) return known;
  const alone = buildCredentialVersionLabels([{ profileKey: "", modality: "llm", profileName: null, deleted: false, versions: [{ credentialVersion: id, setAt, requests: 0 }] }], t, now);
  return alone.get("")?.versions.get(id) as CredentialVersionLabel;
}

/**
 * The versions a row names, or none when its profile has only one version in the range. `own`
 * lists only what the row itself used, so a model that only ever ran on the newer key names that
 * key alone even when its profile had another.
 */
export function rowVersionLabels(labels: CredentialVersionLabels, profileKey: string | undefined, own: ReadonlyArray<string | null>): CredentialVersionLabel[] {
  const profile = profileKey === undefined ? undefined : labels.get(profileKey);
  if (profile === undefined || !profile.distinct) return [];
  const ids = [...new Set(own.map((id) => id ?? USAGE_LEGACY_CREDENTIAL))];
  return ids.map((id) => profile.versions.get(id)).filter((label): label is CredentialVersionLabel => label !== undefined);
}

/** A row's version tag: the key prefix and each version's label, with the early records named apart and without the prefix. */
export function versionTagText(labels: readonly CredentialVersionLabel[], t: TFunction): string {
  const keyed = labels.filter((label) => !label.legacy);
  const parts: string[] = [];
  if (keyed.length > 0) parts.push(t("usage.names.versionTag", { versions: keyed.map((label) => label.text).join(t("usage.names.versionListSeparator")) }));
  if (labels.some((label) => label.legacy)) parts.push(t("usage.names.legacyCredential"));
  return parts.join(" · ");
}

/** What a version tag explains on hover: when the key was saved, and that the figures are the calls made with it. */
export function credentialVersionHint(label: CredentialVersionLabel, t: TFunction): string {
  if (label.legacy) return t("usage.names.legacyCredentialHint");
  if (label.setAt === null) return t("usage.names.versionSavedAtUnknown");
  return t("usage.names.versionSavedAt", beijingDateParts(label.setAt));
}

// Usage -----------------------------------------------------------------------------------------

/** One modality's quantity as a row of a usage cell. */
export interface UsageLine {
  modality: "llm" | "asr-tokens" | "asr";
  main: string;
  unit: string;
}

/** Hours with one decimal from one hour on, else the clock form `m:ss`. */
export function audioText(audioMs: number | string, t: TFunction): string {
  const ms = Number(audioMs);
  return ms >= MS_PER_HOUR ? t("usage.format.hours", { value: (ms / MS_PER_HOUR).toFixed(1) }) : formatDuration(ms);
}

/** Quantities as one line of text, for rows too narrow for a column of their own. */
export function usageInline(usage: UsageModalityUsage, t: TFunction): string {
  return usageLines(usage, t)
    .map((line) => `${line.main} ${line.unit}`)
    .join(" · ");
}

/** The rows a record or call shows for its usage: tokens for an LLM, billed tokens (when reported) and processed audio for transcription. */
export function usageLines(usage: UsageModalityUsage, t: TFunction): UsageLine[] {
  const lines: UsageLine[] = [];
  if (usage.llm !== null) {
    lines.push({ modality: "llm", main: `${formatCompactCount(usage.llm.input)} / ${formatCompactCount(usage.llm.output)}`, unit: t("usage.units.tokens") });
  }
  if (usage.asr !== null) {
    if (BigInt(usage.asr.billedInputTokens) > 0n || BigInt(usage.asr.billedOutputTokens) > 0n) {
      lines.push({
        modality: "asr-tokens",
        main: `${formatCompactCount(usage.asr.billedInputTokens)} / ${formatCompactCount(usage.asr.billedOutputTokens)}`,
        unit: t("usage.units.asrTokens"),
      });
    }
    lines.push({ modality: "asr", main: formatDuration(Number(usage.asr.audioMs)), unit: t("usage.units.audio") });
  }
  return lines;
}

// Usage breakdown -------------------------------------------------------------------------------

type BreakdownKey = "input" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "output" | "reasoning" | "audio" | "billedInput" | "billedOutput";

/** One line of a usage breakdown; `depth` indents the parts that are already included in the line above. */
export interface BreakdownRow {
  key: BreakdownKey;
  label: string;
  value: string;
  /** Written after the value with a space ("tokens"). */
  unit: string;
  /** Written right after the value, with no space: a parenthesised remark. */
  note: string;
  depth: 0 | 1 | 2;
}

const positive = (count: string): boolean => /^\d+$/.test(count) && BigInt(count) > 0n;

/**
 * Every recorded quantity of a row, exactly. Input already includes cache reads and writes, the
 * one-hour cache write is part of the cache write, and output includes reasoning: the parts are
 * indented under what holds them and never add up to anything. A part of zero is left out.
 */
export function usageBreakdown(usage: UsageModalityUsage, t: TFunction): BreakdownRow[] {
  const rows: BreakdownRow[] = [];
  const tokens = t("usage.units.tokens");
  const row = (key: BreakdownKey, value: string, depth: BreakdownRow["depth"], unit = "", note = ""): void => {
    rows.push({ key, label: t(`usage.breakdown.${key}`), value, unit, note, depth });
  };
  const { llm, asr } = usage;
  if (llm !== null) {
    row("input", formatCount(llm.input), 0, tokens);
    if (positive(llm.cacheRead)) row("cacheRead", formatCount(llm.cacheRead), 1);
    if (positive(llm.cacheWrite)) row("cacheWrite", formatCount(llm.cacheWrite), 1);
    if (positive(llm.cacheWrite1h)) row("cacheWrite1h", formatCount(llm.cacheWrite1h), 2);
    row("output", formatCount(llm.output), 0, tokens);
    if (positive(llm.reasoning)) row("reasoning", formatCount(llm.reasoning), 1);
  }
  if (asr !== null) {
    row("audio", formatDuration(Number(asr.audioMs)), 0, "", t("usage.breakdown.audioNote"));
    if (positive(asr.billedInputTokens)) row("billedInput", formatCount(asr.billedInputTokens), 0, tokens);
    if (positive(asr.billedOutputTokens)) row("billedOutput", formatCount(asr.billedOutputTokens), 0, tokens);
  }
  return rows;
}

/** A breakdown as one sentence, for assistive technology. */
export function breakdownSentence(rows: readonly BreakdownRow[], t: TFunction): string {
  return rows.map((row) => `${row.label} ${row.value}${row.unit === "" ? "" : ` ${row.unit}`}${row.note}`).join(t("usage.breakdown.itemSeparator"));
}

/** The description a row's control carries: the same words as the tooltip, under the same title. */
export function breakdownDescription(rows: readonly BreakdownRow[], t: TFunction): string {
  return `${t("usage.breakdown.title")}${t("usage.breakdown.titleSeparator")}${breakdownSentence(rows, t)}`;
}

/**
 * The second line of a single call: the parts of its usage that are not zero, or that the
 * upstream sent no input count. Empty when there is nothing to add to the usage column.
 */
export function callDetailText(call: Pick<UsageCall, "inputMissing" | "usage">, t: TFunction): string {
  const parts: string[] = [];
  if (call.inputMissing) parts.push(t("usage.breakdown.inline.inputMissing"));
  const llm = call.usage.llm;
  if (llm !== null) {
    if (positive(llm.cacheRead)) parts.push(t("usage.breakdown.inline.cacheRead", { n: formatCount(llm.cacheRead) }));
    if (positive(llm.cacheWrite)) {
      parts.push(
        positive(llm.cacheWrite1h)
          ? t("usage.breakdown.inline.cacheWriteWith1h", { n: formatCount(llm.cacheWrite), hour: formatCount(llm.cacheWrite1h) })
          : t("usage.breakdown.inline.cacheWrite", { n: formatCount(llm.cacheWrite) }),
      );
    }
    if (positive(llm.reasoning)) parts.push(t("usage.breakdown.inline.reasoning", { n: formatCount(llm.reasoning) }));
  }
  return parts.join(t("usage.breakdown.inline.separator"));
}

// Results ---------------------------------------------------------------------------------------

export const RESULT_TONE: Readonly<Record<UsageResult, string>> = {
  succeeded: "bg-ok",
  failed: "bg-danger",
  outcome_unknown: "bg-muted",
  cancelled: "bg-line",
};

export function resultLabel(result: UsageResult, accepted: boolean, t: TFunction): string {
  return result === "succeeded" && accepted ? t("usage.result.accepted") : t(`usage.result.${result}`);
}

/** The classes of a call's result badge. */
export function resultBadgeClass(result: UsageResult): string {
  switch (result) {
    case "failed":
      return "bg-danger/10 text-danger";
    case "succeeded":
      return "bg-ok/10 text-ok";
    default:
      return "bg-sunken text-muted";
  }
}

// Cost ------------------------------------------------------------------------------------------

export type CostView =
  /** An amount in the display currency. */
  | { kind: "amount"; text: string; partial: { counted: number; total: number } | undefined }
  /** Priced in the other currency only. */
  | { kind: "other-currency"; currency: PriceCurrency }
  /** Not counted, with the commonest reason. */
  | { kind: "none"; reason: UsageUnpricedReason | undefined };

export function otherCurrency(currency: PriceCurrency): PriceCurrency {
  return currency === "CNY" ? "USD" : "CNY";
}

/** How a cost cell reads in the display currency; counts are never converted between currencies. */
export function costView(cell: UsageCostCell, currency: PriceCurrency): CostView {
  if (cell.amount !== null) {
    const partial = cell.counted < cell.inCurrency ? { counted: cell.counted, total: cell.inCurrency } : undefined;
    return { kind: "amount", text: formatMoney(cell.amount), partial };
  }
  if (cell.inCurrency === 0 && cell.otherCurrency > 0) return { kind: "other-currency", currency: otherCurrency(currency) };
  return { kind: "none", reason: cell.topReason ?? undefined };
}

/** A single call's cost, in the same terms as an activity's. */
export function callCostView(cost: UsageCall["cost"], currency: PriceCurrency): CostView {
  if (cost.status === "counted" && cost.amount !== null) return { kind: "amount", text: formatMoney(cost.amount), partial: undefined };
  if (cost.status === "other_currency") return { kind: "other-currency", currency: otherCurrency(currency) };
  return { kind: "none", reason: cost.reason ?? undefined };
}

/** The short sentence under a dash in a narrow cost cell. */
export function costNote(view: CostView, t: TFunction): string | undefined {
  switch (view.kind) {
    case "amount":
      return view.partial === undefined ? undefined : t("usage.cost.partial", { counted: formatCount(view.partial.counted), total: formatCount(view.partial.total) });
    case "other-currency":
      return t("usage.cost.pricedIn", { currency: t(`usage.currencyNames.${view.currency}`) });
    case "none":
      return view.reason === undefined ? undefined : t(`usage.reasonShort.${view.reason}`);
  }
}

export function formatDurationRange(ms: number, t: TFunction): string {
  if (ms < MS_PER_SECOND) return t("usage.duration.underSecond");
  if (ms < MS_PER_MINUTE) return t("usage.duration.seconds", { n: Math.round(ms / MS_PER_SECOND) });
  if (ms < MS_PER_HOUR) return t("usage.duration.minutes", { n: Math.round(ms / MS_PER_MINUTE) });
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes === 0 ? t("usage.duration.hours", { n: hours }) : t("usage.duration.hoursMinutes", { hours, minutes });
}
