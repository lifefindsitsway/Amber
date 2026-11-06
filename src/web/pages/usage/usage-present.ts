import type { TFunction } from "i18next";
import {
  decodeModelKey,
  USAGE_LEGACY_CREDENTIAL,
  type UsageCall,
  type UsageCostCell,
  type UsageModalityUsage,
  type UsageResult,
  type UsageUnpricedReason,
} from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { formatBeijingMonthDay, formatCompactCount, formatCount, formatDuration, formatMoney } from "../../format.ts";

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

/** A key version, named by the day it was set; rows from before versions were kept have their own name. */
export function credentialVersionLabel(version: { credentialVersion: string | null; setAt: number | null }, t: TFunction): string {
  if (version.credentialVersion === null || version.credentialVersion === USAGE_LEGACY_CREDENTIAL) return t("usage.names.legacyCredential");
  return version.setAt === null ? t("usage.names.unknownVersion") : t("usage.names.versionSince", { date: formatBeijingMonthDay(version.setAt) });
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
