import type { UsageModality, UsageResult, UsageUnpricedReason, Money } from "../../shared/dto/usage-analytics.ts";
import { PRICE_CURRENCIES, priceSnapshotSchema, pricingFitsScope, type PriceCurrency, type PriceUnit } from "../../shared/model-pricing.ts";
import { USAGE_COMPONENT, USAGE_FLAG, type UsageClassFields, type UsageMeasures } from "../domain/usage-analytics.ts";

/**
 * Exact cost arithmetic for the usage estimate. Every priced quantity is a sum of integers
 * and every price has at most `AMOUNT_FRACTION_DIGITS` fraction digits, so a cost is a
 * rational number whose denominator divides `COST_DENOMINATOR`. Costs are kept as the
 * numerator over that one denominator: adding them is exact, and rounding happens once, when a
 * `Money` is produced.
 */

/** Fraction digits a stored price amount may have. */
const AMOUNT_FRACTION_DIGITS = 10;
/** Fraction digits of a reported `Money`. */
const MONEY_FRACTION_DIGITS = 8;
const AMOUNT_SCALE = 10n ** BigInt(AMOUNT_FRACTION_DIGITS);

/** How many of a unit's quantity one stated price covers; tokens per million, audio in ms. */
const UNIT_DIVISOR: Partial<Record<PriceUnit, bigint>> = {
  input_tokens_per_million: 1_000_000n,
  output_tokens_per_million: 1_000_000n,
  cached_input_tokens_per_million: 1_000_000n,
  cache_write_tokens_per_million: 1_000_000n,
  cache_write_1h_tokens_per_million: 1_000_000n,
  audio_per_second: 1_000n,
  audio_per_minute: 60_000n,
  audio_per_hour: 3_600_000n,
  per_request: 1n,
};

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

const DIVISOR_LCM = Object.values(UNIT_DIVISOR).reduce<bigint>((lcm, divisor) => (lcm * (divisor as bigint)) / gcd(lcm, divisor as bigint), 1n);

/** The common denominator of every cost: a priced term is `quantity × amount × (lcm / divisor) / (scale × lcm)`. */
export const COST_DENOMINATOR = AMOUNT_SCALE * DIVISOR_LCM;

const AUDIO_UNITS = ["audio_per_second", "audio_per_minute", "audio_per_hour"] as const;

/** A price as exact integers: each unit's amount times `AMOUNT_SCALE`. */
type UnitAmounts = ReadonlyMap<PriceUnit, bigint>;

export type SnapshotReading =
  | { kind: "none" }
  /** Unusable for this modality; the currency is known only when the stored text still says it. */
  | { kind: "invalid"; currency: PriceCurrency | null }
  | { kind: "valid"; currency: PriceCurrency; amounts: UnitAmounts };

/**
 * What one group of calls contributes to the estimate. `cost` is in `COST_DENOMINATOR` units.
 * A left-out group with an unknown `currency` is unreadable and counts against any display currency.
 */
export type GroupPricing =
  | { kind: "counted"; currency: PriceCurrency; cost: bigint }
  | { kind: "left_out"; currency: PriceCurrency | null; reason: UsageUnpricedReason }
  | { kind: "no_snapshot" };

function parseAmount(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * AMOUNT_SCALE + BigInt(fraction.padEnd(AMOUNT_FRACTION_DIGITS, "0"));
}

function looseCurrency(json: string): PriceCurrency | null {
  try {
    const currency = (JSON.parse(json) as { currency?: unknown } | null)?.currency;
    return PRICE_CURRENCIES.find((candidate) => candidate === currency) ?? null;
  } catch {
    return null;
  }
}

function readSnapshotJson(json: string, modality: UsageModality): SnapshotReading {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { kind: "invalid", currency: null };
  }
  const parsed = priceSnapshotSchema.safeParse(value);
  if (!parsed.success || !pricingFitsScope(parsed.data, modality)) {
    return { kind: "invalid", currency: looseCurrency(json) };
  }
  const amounts = new Map(parsed.data.items.map((item) => [item.unit, parseAmount(item.amount)] as const));
  return { kind: "valid", currency: parsed.data.currency, amounts };
}

/** Reads price snapshots once per distinct text and modality; groups share a handful of them. */
export class SnapshotReader {
  private readonly cache: Record<UsageModality, Map<string, SnapshotReading>> = { llm: new Map(), asr: new Map() };

  read(json: string | null, modality: UsageModality): SnapshotReading {
    if (json === null) {
      return { kind: "none" };
    }
    const readings = this.cache[modality];
    let reading = readings.get(json);
    if (reading === undefined) {
      reading = readSnapshotJson(json, modality);
      readings.set(json, reading);
    }
    return reading;
  }
}

/** Why a request without usable usage cannot be estimated, by how it ended. */
const REASON_BY_RESULT: Readonly<Record<UsageResult, UsageUnpricedReason>> = {
  outcome_unknown: "unknown_without_usage",
  failed: "failed_without_usage",
  cancelled: "failed_without_usage",
  succeeded: "usage_missing",
};

function term(quantity: bigint, unit: PriceUnit, amounts: UnitAmounts): bigint {
  const amount = amounts.get(unit);
  return amount === undefined ? 0n : quantity * amount * (DIVISOR_LCM / (UNIT_DIVISOR[unit] as bigint));
}

/** The surcharge of `requests` requests, which needs no usage. */
function surcharge(requests: bigint, amounts: UnitAmounts): bigint {
  return term(requests, "per_request", amounts);
}

function hasOnlyPerRequest(amounts: UnitAmounts): boolean {
  return [...amounts.keys()].every((unit) => unit === "per_request");
}

interface QuantityTerm {
  component: number;
  quantity: (group: UsageMeasures) => bigint;
  unit: PriceUnit;
  missing: UsageUnpricedReason;
}

/** In the order a missing price is reported. */
const LLM_TERMS: readonly QuantityTerm[] = [
  { component: USAGE_COMPONENT.input, quantity: (g) => g.input, unit: "input_tokens_per_million", missing: "missing_price" },
  { component: USAGE_COMPONENT.output, quantity: (g) => g.output, unit: "output_tokens_per_million", missing: "missing_price" },
  { component: USAGE_COMPONENT.cacheRead, quantity: (g) => g.cacheRead, unit: "cached_input_tokens_per_million", missing: "missing_cache_read_price" },
  { component: USAGE_COMPONENT.cacheWrite, quantity: (g) => g.cacheWrite, unit: "cache_write_tokens_per_million", missing: "missing_cache_write_price" },
  {
    component: USAGE_COMPONENT.cacheWrite1h,
    quantity: (g) => g.cacheWrite1h,
    unit: "cache_write_1h_tokens_per_million",
    missing: "missing_cache_write_1h_price",
  },
];

function leftOut(currency: PriceCurrency, reason: UsageUnpricedReason): GroupPricing {
  return { kind: "left_out", currency, reason };
}

/** The first positive component of the group whose unit the snapshot does not price. */
function firstMissing(group: UsageClassFields, terms: readonly QuantityTerm[], amounts: UnitAmounts): UsageUnpricedReason | undefined {
  return terms.find((candidate) => (group.bitmap & candidate.component) !== 0 && !amounts.has(candidate.unit))?.missing;
}

function priceLlm(group: UsageClassFields & UsageMeasures, currency: PriceCurrency, amounts: UnitAmounts): GroupPricing {
  const extra = surcharge(group.requests, amounts);
  if (hasOnlyPerRequest(amounts)) {
    return { kind: "counted", currency, cost: extra };
  }
  if ((group.flags & USAGE_FLAG.usageAbsent) !== 0) {
    return leftOut(currency, REASON_BY_RESULT[group.result]);
  }
  if ((group.flags & USAGE_FLAG.inputMissing) !== 0) {
    return leftOut(currency, "input_missing");
  }
  const missing = firstMissing(group, LLM_TERMS, amounts);
  if (missing !== undefined) {
    return leftOut(currency, missing);
  }
  const cost = LLM_TERMS.reduce((total, candidate) => total + term(candidate.quantity(group), candidate.unit, amounts), extra);
  return { kind: "counted", currency, cost };
}

const ASR_TOKEN_TERMS: readonly QuantityTerm[] = LLM_TERMS.filter((candidate) => candidate.unit === "input_tokens_per_million" || candidate.unit === "output_tokens_per_million");

/**
 * A transcription is billed by tokens or by audio time, whichever its snapshot prices. The
 * audio time is the billed duration when the upstream reported one; only a succeeded request
 * without it falls back to the locally measured duration, which is an estimate and says so.
 */
function priceAsr(group: UsageClassFields & UsageMeasures, currency: PriceCurrency, amounts: UnitAmounts): GroupPricing {
  const extra = surcharge(group.requests, amounts);
  if (hasOnlyPerRequest(amounts)) {
    return { kind: "counted", currency, cost: extra };
  }
  const byTokens = ASR_TOKEN_TERMS.some((candidate) => amounts.has(candidate.unit));
  if (byTokens) {
    if ((group.flags & USAGE_FLAG.billedTokens) === 0) {
      return leftOut(currency, REASON_BY_RESULT[group.result]);
    }
    const missing = firstMissing(group, ASR_TOKEN_TERMS, amounts);
    if (missing !== undefined) {
      return leftOut(currency, missing);
    }
    return { kind: "counted", currency, cost: ASR_TOKEN_TERMS.reduce((total, candidate) => total + term(candidate.quantity(group), candidate.unit, amounts), extra) };
  }
  const audioUnit = AUDIO_UNITS.find((unit) => amounts.has(unit)) as PriceUnit;
  const billed = (group.flags & USAGE_FLAG.billedAudio) !== 0;
  if (!billed && group.result !== "succeeded") {
    return leftOut(currency, REASON_BY_RESULT[group.result]);
  }
  return { kind: "counted", currency, cost: extra + term(billed ? group.audioBilledMs : group.audioLocalMs, audioUnit, amounts) };
}

/**
 * The contribution of one group of calls under a price. Calls of a group share the snapshot,
 * which quantities are positive and which were reported, and how they ended, so the
 * decision is the same for each of them and the sums price exactly.
 */
export function priceGroup(group: UsageClassFields & UsageMeasures & { modality: UsageModality }, reading: SnapshotReading): GroupPricing {
  if (reading.kind === "none") {
    return { kind: "no_snapshot" };
  }
  if (reading.kind === "invalid") {
    return { kind: "left_out", currency: reading.currency, reason: "conflicting_units" };
  }
  return group.modality === "llm" ? priceLlm(group, reading.currency, reading.amounts) : priceAsr(group, reading.currency, reading.amounts);
}

/** `cost` rounded half-up to the fraction digits of a `Money`, trailing zeros trimmed. */
export function toMoney(currency: PriceCurrency, cost: bigint): Money {
  const scale = 10n ** BigInt(MONEY_FRACTION_DIGITS);
  const units = (cost * scale + COST_DENOMINATOR / 2n) / COST_DENOMINATOR;
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(MONEY_FRACTION_DIGITS, "0").replace(/0+$/, "");
  return { currency, amount: fraction === "" ? whole.toString() : `${whole}.${fraction}` };
}
