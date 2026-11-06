import { USAGE_UNPRICED_REASONS, type UsageUnpricedReason } from "../../../src/shared/dto/usage-analytics.ts";
import { PRICE_CURRENCIES, priceSnapshotSchema, pricingFitsScope, type PriceCurrency, type PriceUnit } from "../../../src/shared/model-pricing.ts";
import type { SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { insertAsrUsage, insertLlmUsage, type AsrUsageInput, type LlmUsageInput } from "./rows.ts";

/**
 * A deliberately plain, per-call estimate of the usage cost, written straight from the
 * rules and sharing no code with the two-phase engine: each call is priced alone with
 * exact rational arithmetic, and the page's figures are plain sums over calls.
 */

export type ReferenceCall = ({ modality: "llm" } & LlmUsageInput) | ({ modality: "asr" } & AsrUsageInput);

export function insertCalls(db: SqliteConnection, calls: readonly ReferenceCall[]): void {
  for (const call of calls) {
    if (call.modality === "llm") {
      insertLlmUsage(db, call);
    } else {
      insertAsrUsage(db, call);
    }
  }
}

// Rational numbers over bigint --------------------------------------------------------------

export interface Rational {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

function rational(n: bigint, d = 1n): Rational {
  const g = gcd(n < 0n ? -n : n, d) || 1n;
  return { n: n / g, d: d / g };
}

export const ZERO = rational(0n);

export function add(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

/** `quantity × price ÷ divisor` where `price` is a decimal string with up to ten fraction digits. */
function priced(quantity: bigint, price: string, divisor: bigint): Rational {
  const [whole = "0", fraction = ""] = price.split(".");
  const scale = 10n ** BigInt(fraction.length);
  return rational(quantity * BigInt(whole + fraction), scale * divisor);
}

/** Half-up to eight fraction digits, trailing zeros trimmed. */
export function format(value: Rational): string {
  const scaled = (value.n * 2n * 10n ** 8n + value.d) / (2n * value.d);
  const whole = scaled / 10n ** 8n;
  const fraction = (scaled % 10n ** 8n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

// Per-call estimate -------------------------------------------------------------------------

export type ReferenceCost =
  | { status: "counted"; currency: PriceCurrency; cost: Rational }
  | { status: "left_out"; currency: PriceCurrency | null; reason: UsageUnpricedReason }
  | { status: "no_snapshot" };

const big = (value: number | bigint | null | undefined): bigint => (value === null || value === undefined ? 0n : BigInt(value));

function resultOf(call: ReferenceCall): string {
  return call.modality === "asr" ? (call.jobOutcome ?? call.outcome ?? "succeeded") : (call.outcome ?? "succeeded");
}

function withoutUsage(call: ReferenceCall): UsageUnpricedReason {
  const result = resultOf(call);
  return result === "outcome_unknown" ? "unknown_without_usage" : result === "succeeded" ? "usage_missing" : "failed_without_usage";
}

interface Items {
  currency: PriceCurrency;
  price: Map<PriceUnit, string>;
}

function readItems(call: ReferenceCall): Items | "none" | { invalid: PriceCurrency | null } {
  const raw = call.snapshot;
  if (raw === undefined || raw === null) {
    return "none";
  }
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { invalid: null };
    }
  }
  const parsed = priceSnapshotSchema.safeParse(value);
  if (!parsed.success || !pricingFitsScope(parsed.data, call.modality)) {
    const currency = (value as { currency?: unknown } | null)?.currency;
    return { invalid: PRICE_CURRENCIES.find((candidate) => candidate === currency) ?? null };
  }
  return { currency: parsed.data.currency, price: new Map(parsed.data.items.map((item) => [item.unit, item.amount])) };
}

const MILLION = 1_000_000n;

function sumTerms(terms: Array<[bigint, string | undefined, bigint]>): Rational {
  return terms.reduce((total, [quantity, price, divisor]) => (price === undefined ? total : add(total, priced(quantity, price, divisor))), ZERO);
}

function costLlm(call: Extract<ReferenceCall, { modality: "llm" }>, items: Items): ReferenceCost {
  const { price, currency } = items;
  const surcharge = priced(1n, price.get("per_request") ?? "0", 1n);
  if ([...price.keys()].every((unit) => unit === "per_request")) {
    return { status: "counted", currency, cost: surcharge };
  }
  const input = call.input ?? null;
  const output = call.output ?? null;
  if (input === null && output === null) {
    return { status: "left_out", currency, reason: withoutUsage(call) };
  }
  if (input !== null && big(input) === 0n && big(output) > 0n) {
    return { status: "left_out", currency, reason: "input_missing" };
  }
  const normal = big(input) - big(call.cacheRead) - big(call.cacheWrite);
  const components: Array<[bigint, PriceUnit, UsageUnpricedReason]> = [
    [normal > 0n ? normal : 0n, "input_tokens_per_million", "missing_price"],
    [big(output), "output_tokens_per_million", "missing_price"],
    [big(call.cacheRead), "cached_input_tokens_per_million", "missing_cache_read_price"],
    [big(call.cacheWrite) - big(call.cacheWrite1h), "cache_write_tokens_per_million", "missing_cache_write_price"],
    [big(call.cacheWrite1h), "cache_write_1h_tokens_per_million", "missing_cache_write_1h_price"],
  ];
  const gone = components.find(([quantity, unit]) => quantity > 0n && !price.has(unit));
  if (gone !== undefined) {
    return { status: "left_out", currency, reason: gone[2] };
  }
  const cost = add(surcharge, sumTerms(components.map(([quantity, unit]) => [quantity, price.get(unit), MILLION])));
  return { status: "counted", currency, cost };
}

function costAsr(call: Extract<ReferenceCall, { modality: "asr" }>, items: Items): ReferenceCost {
  const { price, currency } = items;
  const surcharge = priced(1n, price.get("per_request") ?? "0", 1n);
  if ([...price.keys()].every((unit) => unit === "per_request")) {
    return { status: "counted", currency, cost: surcharge };
  }
  const audioDivisors: Array<[PriceUnit, bigint]> = [["audio_per_second", 1000n], ["audio_per_minute", 60_000n], ["audio_per_hour", 3_600_000n]];
  const audio = audioDivisors.find(([unit]) => price.has(unit));
  if (audio === undefined) {
    const billedIn = call.billedInput ?? null;
    const billedOut = call.billedOutput ?? null;
    if (billedIn === null && billedOut === null) {
      return { status: "left_out", currency, reason: withoutUsage(call) };
    }
    if (big(billedIn) > 0n && !price.has("input_tokens_per_million")) {
      return { status: "left_out", currency, reason: "missing_price" };
    }
    if (big(billedOut) > 0n && !price.has("output_tokens_per_million")) {
      return { status: "left_out", currency, reason: "missing_price" };
    }
    return {
      status: "counted",
      currency,
      cost: add(surcharge, sumTerms([[big(billedIn), price.get("input_tokens_per_million"), MILLION], [big(billedOut), price.get("output_tokens_per_million"), MILLION]])),
    };
  }
  const billed = call.billedAudioMs ?? null;
  if (billed === null && resultOf(call) !== "succeeded") {
    return { status: "left_out", currency, reason: withoutUsage(call) };
  }
  const milliseconds = billed !== null ? big(billed) : big(call.audioMs);
  return { status: "counted", currency, cost: add(surcharge, priced(milliseconds, price.get(audio[0]) as string, audio[1])) };
}

export function referenceCost(call: ReferenceCall): ReferenceCost {
  const items = readItems(call);
  if (items === "none") {
    return { status: "no_snapshot" };
  }
  if ("invalid" in items) {
    return { status: "left_out", currency: items.invalid, reason: "conflicting_units" };
  }
  return call.modality === "llm" ? costLlm(call, items) : costAsr(call, items);
}

// The figures the page shows, as plain sums over calls ---------------------------------------

export interface ReferenceCell {
  amount: string | null;
  counted: number;
  inCurrency: number;
  otherCurrency: number;
  unknownCurrency: number;
  topReason: UsageUnpricedReason | null;
  /** In-currency requests left out, by reason; `no_snapshot` counts the unknown-currency ones. */
  leftOut: Map<UsageUnpricedReason, number>;
  coverage: { llmTokens: [bigint, bigint]; asrTokens: [bigint, bigint]; audioMs: [bigint, bigint] };
}

export function referenceCell(calls: readonly ReferenceCall[], currency: PriceCurrency): ReferenceCell {
  let sum = ZERO;
  const cell: ReferenceCell = {
    amount: null,
    counted: 0,
    inCurrency: 0,
    otherCurrency: 0,
    unknownCurrency: 0,
    topReason: null,
    leftOut: new Map(),
    coverage: { llmTokens: [0n, 0n], asrTokens: [0n, 0n], audioMs: [0n, 0n] },
  };
  for (const call of calls) {
    const cost = referenceCost(call);
    if (cost.status === "no_snapshot") {
      cell.unknownCurrency += 1;
      cell.leftOut.set("no_snapshot", (cell.leftOut.get("no_snapshot") ?? 0) + 1);
      continue;
    }
    if (cost.currency !== null && cost.currency !== currency) {
      cell.otherCurrency += 1;
      continue;
    }
    cell.inCurrency += 1;
    const tokens = big(call.modality === "llm" ? call.input : call.billedInput) + big(call.modality === "llm" ? call.output : call.billedOutput);
    const slot = call.modality === "llm" ? cell.coverage.llmTokens : cell.coverage.asrTokens;
    slot[1] += tokens;
    const audio = call.modality === "asr" ? big(call.audioMs) : 0n;
    cell.coverage.audioMs[1] += audio;
    if (cost.status === "counted") {
      cell.counted += 1;
      sum = add(sum, cost.cost);
      slot[0] += tokens;
      cell.coverage.audioMs[0] += audio;
    } else {
      cell.leftOut.set(cost.reason, (cell.leftOut.get(cost.reason) ?? 0) + 1);
    }
  }
  cell.amount = cell.counted === 0 ? null : format(sum);
  let best = 0;
  for (const reason of USAGE_UNPRICED_REASONS) {
    const count = reason === "no_snapshot" ? 0 : (cell.leftOut.get(reason) ?? 0);
    if (count > best) {
      best = count;
      cell.topReason = reason;
    }
  }
  if (cell.topReason === null && cell.inCurrency === 0 && cell.otherCurrency === 0 && cell.unknownCurrency > 0) {
    cell.topReason = "no_snapshot";
  }
  return cell;
}

// A seeded generator of varied calls ---------------------------------------------------------

/** mulberry32: small, fast and the same sequence everywhere. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

function pick<T>(random: Random, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function decimal(random: Random): string {
  const whole = Math.floor(random() * 40);
  const fractionDigits = Math.floor(random() * 11);
  if (fractionDigits === 0) {
    return String(whole);
  }
  const fraction = Array.from({ length: fractionDigits }, () => Math.floor(random() * 10)).join("");
  return `${whole}.${fraction}`;
}

const LLM_UNITS: PriceUnit[] = [
  "input_tokens_per_million",
  "output_tokens_per_million",
  "cached_input_tokens_per_million",
  "cache_write_tokens_per_million",
  "cache_write_1h_tokens_per_million",
  "per_request",
];
const ASR_UNITS: PriceUnit[] = ["input_tokens_per_million", "output_tokens_per_million", "audio_per_second", "audio_per_minute", "audio_per_hour", "per_request"];

function snapshotFor(random: Random, modality: "llm" | "asr"): object | string | null {
  const roll = random();
  if (roll < 0.12) {
    return null;
  }
  if (roll < 0.15) {
    // Valid JSON the schema refuses: a currency nobody offers, or items that are not a list.
    return pick(random, ['{"currency":"EUR","items":[{"unit":"per_request","amount":"1"}]}', '{"currency":"USD","items":"none"}', "[1,2]"]);
  }
  if (roll < 0.18) {
    // Audio units on an LLM model, or cache units on a transcription: both are unusable.
    return { currency: "CNY", items: [{ unit: modality === "llm" ? "audio_per_second" : "cached_input_tokens_per_million", amount: "1" }] };
  }
  const units = modality === "llm" ? LLM_UNITS : ASR_UNITS;
  const items: Array<{ unit: PriceUnit; amount: string }> = [];
  for (const unit of units) {
    const taken = items.some((item) => item.unit === unit);
    const audioTaken = items.some((item) => item.unit.startsWith("audio_"));
    const tokenTaken = items.some((item) => item.unit.endsWith("tokens_per_million"));
    const clash = modality === "asr" && ((unit.startsWith("audio_") && (audioTaken || tokenTaken)) || (unit.endsWith("tokens_per_million") && audioTaken));
    if (!taken && !clash && random() < 0.55) {
      items.push({ unit, amount: decimal(random) });
    }
  }
  if (items.length === 0) {
    items.push({ unit: "per_request", amount: decimal(random) });
  }
  return { currency: random() < 0.7 ? "CNY" : "USD", items };
}

function tokens(random: Random): bigint | null {
  const roll = random();
  if (roll < 0.08) {
    return null;
  }
  if (roll < 0.12) {
    return 0n;
  }
  if (roll < 0.3) {
    // Beyond what a double holds exactly, so any lossy step shows.
    return 2n ** 53n + BigInt(Math.floor(random() * 1e9)) * 3n + 1n;
  }
  return BigInt(Math.floor(random() * 5_000_000));
}

function llmCall(random: Random, index: number, sentAt: number): ReferenceCall {
  const input = tokens(random);
  const withCache = random() < 0.5;
  const cacheRead = withCache && input !== null ? BigInt(Math.floor(random() * Number(input > 1_000_000n ? 1_000_000n : input))) : null;
  const cacheWrite = withCache && random() < 0.5 ? BigInt(Math.floor(random() * 100_000)) : null;
  return {
    modality: "llm",
    id: `l${index}`,
    profileId: pick(random, ["p-1", "p-2"]),
    modelId: pick(random, ["model-a", "model-b"]),
    outcome: pick(random, ["succeeded", "succeeded", "failed", "outcome_unknown"]),
    input,
    output: random() < 0.1 ? null : tokens(random),
    cacheRead,
    cacheWrite,
    cacheWrite1h: cacheWrite !== null && random() < 0.4 ? BigInt(Math.floor(random() * Number(cacheWrite))) : null,
    reasoning: random() < 0.3 ? 5n : null,
    sentAt,
    snapshot: snapshotFor(random, "llm"),
  };
}

function asrCall(random: Random, index: number, sentAt: number): ReferenceCall {
  const withJob = random() < 0.6;
  const jobOutcome = withJob ? pick(random, [null, null, "succeeded", "failed", "cancelled"]) : null;
  return {
    modality: "asr",
    id: `a${index}`,
    profileId: pick(random, ["ap-1", "ap-2", null]),
    modelId: pick(random, ["scribe_v2", "fun-asr"]),
    outcome: pick(random, ["succeeded", "succeeded", "failed", "outcome_unknown"]),
    jobId: withJob ? `job-${index}` : null,
    jobOutcome,
    audioMs: BigInt(Math.floor(random() * 4 * 3_600_000)) + (random() < 0.2 ? 2n ** 53n : 0n),
    billedInput: random() < 0.35 ? tokens(random) : null,
    billedOutput: random() < 0.35 ? tokens(random) : null,
    billedAudioMs: random() < 0.35 ? BigInt(Math.floor(random() * 3_600_000)) : null,
    sentAt,
    snapshot: snapshotFor(random, "asr"),
  };
}

/** `count` calls with both modalities, mixed snapshots and currencies, every outcome and huge quantities. */
export function generateCalls(seed: number, count: number, from: number, to: number): ReferenceCall[] {
  const random = prng(seed);
  return Array.from({ length: count }, (_, index) => {
    const sentAt = from + Math.floor(random() * (to - from));
    return random() < 0.65 ? llmCall(random, index, sentAt) : asrCall(random, index, sentAt);
  });
}
