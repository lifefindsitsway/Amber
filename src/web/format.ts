import i18next from "i18next";
import type { Money } from "../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../shared/model-pricing.ts";

/** `h:mm:ss` for an hour or more, else `m:ss`; media time is integer milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Local date and time for list columns; the UI language picks the format. */
export function formatDateTime(epochMs: number, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(epochMs);
}

/**
 * Publish dates, chat answer times and chat thread times show in Beijing time (UTC+8) in a
 * fixed `YYYY-MM-DD` / `YYYY-MM-DD HH:mm` form, so a moment reads the same whatever the
 * machine's time zone or UI language.
 */
const BEIJING_TIME_ZONE = "Asia/Shanghai";
const beijingParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function beijingFields(epochMs: number): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const fields = { year: "", month: "", day: "", hour: "", minute: "", second: "" };
  for (const part of beijingParts.formatToParts(epochMs)) {
    if (part.type in fields) {
      fields[part.type as keyof typeof fields] = part.value;
    }
  }
  return fields;
}

/** `YYYY-MM-DD` of a moment in Beijing time. */
export function formatBeijingDate(epochMs: number): string {
  const { year, month, day } = beijingFields(epochMs);
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD HH:mm` of a moment in Beijing time. */
export function formatBeijingDateTime(epochMs: number): string {
  const { hour, minute } = beijingFields(epochMs);
  return `${formatBeijingDate(epochMs)} ${hour}:${minute}`;
}

/** `YYYY-MM-DD HH:mm:ss` of a moment in Beijing time. */
export function formatBeijingDateTimeSeconds(epochMs: number): string {
  const { second } = beijingFields(epochMs);
  return `${formatBeijingDateTime(epochMs)}:${second}`;
}

/** `YYYY-MM-DD` of a publish moment in Beijing time. */
export function formatPublishedDate(epochMs: number): string {
  return formatBeijingDate(epochMs);
}

/** `YYYY-MM-DD HH:mm` of a publish moment in Beijing time. */
export function formatPublishedDateTime(epochMs: number): string {
  return formatBeijingDateTime(epochMs);
}

/** Local time of day only, for a moment on the same date as one shown just before it. */
export function formatTime(epochMs: number, language: string): string {
  return new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(epochMs);
}

/** Whether two moments fall on the same local date. */
export function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** The text after the thousands separators of a non-negative integer's decimal digits. */
function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

type Count = string | number | bigint;

function toBigInt(value: Count): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.max(0, Math.round(value)));
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

/** Every unit that counts as "ten thousand" in the compact count format (万). */
const TEN_THOUSAND = 10_000n;

/**
 * A non-negative whole number with thousands separators. Inputs may be decimal strings, as
 * token and millisecond sums can exceed what a JSON number holds exactly.
 */
export function formatCount(value: Count): string {
  return groupDigits(toBigInt(value).toString());
}

/**
 * Below ten thousand the whole number with separators; from ten thousand on `x.x 万`, rounded
 * half up to one decimal. BigInt throughout, so large token sums stay exact.
 */
export function formatCompactCount(value: Count): string {
  const count = toBigInt(value);
  if (count < TEN_THOUSAND) return groupDigits(count.toString());
  const tenths = (count * 10n + TEN_THOUSAND / 2n) / TEN_THOUSAND;
  return i18next.t("usage.format.tenThousand", { value: `${groupDigits((tenths / 10n).toString())}.${(tenths % 10n).toString()}` });
}

const CURRENCY_SYMBOLS: Readonly<Record<PriceCurrency, string>> = { CNY: "¥", USD: "$" };

/** The symbol a currency is written with (`¥`, `$`). */
export function currencySymbol(currency: PriceCurrency): string {
  return CURRENCY_SYMBOLS[currency];
}

/** Fraction digits a money amount carries on the wire; the smallest amount shown is one cent. */
const MONEY_WIRE_DIGITS = 8;
const MONEY_CENT_WIRE = 10n ** BigInt(MONEY_WIRE_DIGITS - 2);

/**
 * Two decimals, rounded half up on the exact decimal string. A positive amount below one cent
 * reads `< ¥0.01` rather than a misleading `¥0.00` or a rounded-up `¥0.01`.
 */
export function formatMoney(money: Money): string {
  const symbol = currencySymbol(money.currency);
  const [whole = "0", fraction = ""] = money.amount.split(".");
  const wire = BigInt(whole) * 10n ** BigInt(MONEY_WIRE_DIGITS) + BigInt(fraction.padEnd(MONEY_WIRE_DIGITS, "0").slice(0, MONEY_WIRE_DIGITS));
  if (wire > 0n && wire < MONEY_CENT_WIRE) return `< ${symbol}0.01`;
  const cents = (wire + MONEY_CENT_WIRE / 2n) / MONEY_CENT_WIRE;
  return `${symbol}${groupDigits((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** `HH:mm` of a moment in Beijing time. */
export function formatBeijingTime(epochMs: number): string {
  const { hour, minute } = beijingFields(epochMs);
  return `${hour}:${minute}`;
}

/** `HH:mm:ss` of a moment in Beijing time. */
export function formatBeijingTimeSeconds(epochMs: number): string {
  const { second } = beijingFields(epochMs);
  return `${formatBeijingTime(epochMs)}:${second}`;
}

/** `MM-DD` of a moment in Beijing time. */
export function formatBeijingMonthDay(epochMs: number): string {
  const { month, day } = beijingFields(epochMs);
  return `${month}-${day}`;
}

/** `MM-DD HH:mm` of a moment in Beijing time. */
export function formatBeijingMonthDayTime(epochMs: number): string {
  return `${formatBeijingMonthDay(epochMs)} ${formatBeijingTime(epochMs)}`;
}

/** `YYYY-MM` of a moment in Beijing time. */
export function formatBeijingMonth(epochMs: number): string {
  const { year, month } = beijingFields(epochMs);
  return `${year}-${month}`;
}
