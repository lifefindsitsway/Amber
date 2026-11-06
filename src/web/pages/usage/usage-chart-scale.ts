import type { TFunction } from "i18next";
import type { UsageGranularity, UsageMetric } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { currencySymbol, formatBeijingMonth, formatBeijingMonthDay, formatBeijingTime } from "../../format.ts";

const TEN_THOUSAND = 10_000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
/** The top gridline sits two steps above zero, so three lines frame the plot. */
const STEPS_ABOVE_ZERO = 2;
const MAX_DECIMALS = 6;
const EPSILON = 1e-9;

/** Candidate step sizes within one decade; whole-number metrics skip the quarter step. */
const STEP_MANTISSAS = [1, 2, 2.5, 5, 10] as const;
const WHOLE_STEP_MANTISSAS = [1, 2, 5, 10] as const;

/** Smallest "round" step whose second multiple still reaches `max`. */
export function niceStep(max: number, wholeNumbers: boolean): number {
  // Counts never step below one; an empty chart still gets a sensible axis.
  const needed = Math.max(max, wholeNumbers ? 1 : Number.EPSILON) / STEPS_ABOVE_ZERO;
  const decade = 10 ** Math.floor(Math.log10(needed));
  const mantissas = wholeNumbers ? WHOLE_STEP_MANTISSAS : STEP_MANTISSAS;
  for (const mantissa of mantissas) {
    const step = mantissa * decade;
    if (step >= needed - EPSILON * decade && (!wholeNumbers || step >= 1)) return step;
  }
  return 10 * decade;
}

function decimalsOf(step: number): number {
  for (let digits = 0; digits <= MAX_DECIMALS; digits += 1) {
    const scaled = step * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < EPSILON * Math.max(1, scaled)) return digits;
  }
  return MAX_DECIMALS;
}

export interface AxisScale {
  /** Gridline values in the data's own unit, ascending from zero. */
  ticks: number[];
  /** The value at the top gridline; bars scale against it. */
  top: number;
  label(value: number): string;
}

/**
 * The y axis of a metric: three round gridlines in a unit people read (money, ten thousands of
 * tokens, hours). The unit is part of each label, so the axis needs no caption.
 */
export function axisFor(metric: UsageMetric, max: number, currency: PriceCurrency, t: TFunction): AxisScale {
  let divisor = 1;
  let prefix = "";
  let suffix = "";
  let whole = false;
  switch (metric) {
    case "cost":
      prefix = currencySymbol(currency);
      break;
    case "llm_tokens":
    case "asr_billed_tokens":
      if (max >= TEN_THOUSAND) {
        divisor = TEN_THOUSAND;
        suffix = t("usage.chart.tenThousandSuffix");
      } else {
        whole = true;
      }
      break;
    case "requests":
      whole = true;
      break;
    case "audio":
      // An empty axis (max 0) stays in minutes; only real sub-minute data switches to seconds, where
      // fractions of a minute such as "0.02 分钟" read badly. Seconds are not forced to whole numbers:
      // that would round a 45 s maximum up to a 100 s top line, past the minute the data fits in.
      if (max >= MS_PER_HOUR) {
        divisor = MS_PER_HOUR;
        suffix = t("usage.chart.hoursSuffix");
      } else if (max > 0 && max < MS_PER_MINUTE) {
        divisor = MS_PER_SECOND;
        suffix = t("usage.chart.secondsSuffix");
      } else {
        divisor = MS_PER_MINUTE;
        suffix = t("usage.chart.minutesSuffix");
      }
      break;
  }
  // Nothing to draw yet: an arbitrary unit range, so the axis is not a row of zeros.
  const step = niceStep(max > 0 ? max / divisor : 1, whole);
  const digits = decimalsOf(step);
  const ticks = Array.from({ length: STEPS_ABOVE_ZERO + 1 }, (_, index) => index * step * divisor);
  return {
    ticks,
    top: STEPS_ABOVE_ZERO * step * divisor,
    label(value) {
      if (value === 0) return metric === "cost" ? `${prefix}0` : "0";
      return `${prefix}${(value / divisor).toFixed(digits)}${suffix}`;
    },
  };
}

// Time axis -------------------------------------------------------------------------------------

/** The label of a bucket's tick. */
export function bucketTickLabel(start: number, granularity: UsageGranularity): string {
  switch (granularity) {
    case "hour":
      return formatBeijingTime(start);
    case "day":
    case "week":
      return formatBeijingMonthDay(start);
    case "month":
      return formatBeijingMonth(start);
  }
}

/** The coarser unit a tick belongs to; the first tick of each shows it on a second line. */
export function bucketGroupLabel(start: number, granularity: UsageGranularity): string {
  switch (granularity) {
    case "hour":
      return formatBeijingMonthDay(start);
    case "day":
    case "week":
      return formatBeijingMonth(start);
    case "month":
      return formatBeijingMonth(start).slice(0, "YYYY".length);
  }
}

/** The range of a bucket as a tooltip or a row header reads it (end exclusive on the wire, inclusive here). */
export function bucketRangeLabel(start: number, end: number, granularity: UsageGranularity): string {
  const last = end - 1;
  switch (granularity) {
    case "hour":
      return `${formatBeijingMonthDay(start)} ${formatBeijingTime(start)} – ${formatBeijingTime(end)}`;
    case "day":
      return formatBeijingMonthDay(start);
    case "week":
      return `${formatBeijingMonthDay(start)} – ${formatBeijingMonthDay(last)}`;
    case "month":
      return formatBeijingMonth(start);
  }
}

/** The next finer bucket size a bucket can be opened into; an hour is the finest. */
export function finerGranularity(granularity: UsageGranularity): UsageGranularity | undefined {
  switch (granularity) {
    case "month":
    case "week":
      return "day";
    case "day":
      return "hour";
    case "hour":
      return undefined;
  }
}

/** Width a tick label needs, in px, with a little air. */
export function tickLabelWidth(granularity: UsageGranularity): number {
  switch (granularity) {
    case "hour":
      return 44;
    case "month":
      return 64;
    default:
      return 52;
  }
}
