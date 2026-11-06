import { z } from "zod";

/**
 * Billing units a user may price a model in. Each names its quantity and
 * scale; a new billing basis is one more member here. Prices are shown in settings and
 * frozen onto each request as it is sent, which is what cost estimates are computed from.
 */
export const PRICE_UNITS = [
  "input_tokens_per_million",
  "output_tokens_per_million",
  "cached_input_tokens_per_million",
  "cache_write_tokens_per_million",
  "cache_write_1h_tokens_per_million",
  "audio_per_second",
  "audio_per_minute",
  "audio_per_hour",
  "characters_per_thousand",
  "characters_per_ten_thousand",
  "characters_per_million",
  "per_image",
  "video_per_second",
  "per_request",
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const PRICE_CURRENCIES = ["CNY", "USD"] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

/** Which settings section a priced model belongs to; each offers the units that fit its models. */
export const PRICING_SCOPES = ["llm", "asr", "other"] as const;
export type PricingScope = (typeof PRICING_SCOPES)[number];

const LLM_TOKEN_UNITS = [
  "input_tokens_per_million",
  "output_tokens_per_million",
  "cached_input_tokens_per_million",
  "cache_write_tokens_per_million",
  "cache_write_1h_tokens_per_million",
] as const;
/** ASR bills input and output tokens only; cache semantics do not exist for transcription. */
const ASR_TOKEN_UNITS = ["input_tokens_per_million", "output_tokens_per_million"] as const;
const AUDIO_UNITS = ["audio_per_second", "audio_per_minute", "audio_per_hour"] as const;
const CHARACTER_UNITS = ["characters_per_thousand", "characters_per_ten_thousand", "characters_per_million"] as const;

export const PRICE_UNITS_BY_SCOPE: Readonly<Record<PricingScope, readonly PriceUnit[]>> = {
  llm: [...LLM_TOKEN_UNITS, "per_request"],
  asr: [...ASR_TOKEN_UNITS, ...AUDIO_UNITS, "per_request"],
  other: PRICE_UNITS,
};

/** Most items one model's price may have: exactly the full set of units an LLM model offers. */
export const PRICE_ITEMS_MAX = 6;
/** Longest note on a price (free quota, tiers), in characters. */
export const PRICE_NOTE_MAX_CHARS = 200;

/**
 * A non-negative decimal kept as typed, so `0.00022` never shows as a float artifact:
 * up to 9 integer and 10 fraction digits.
 */
export const PRICE_AMOUNT_PATTERN = /^(0|[1-9]\d{0,8})(\.\d{1,10})?$/;

export const priceItemSchema = z
  .object({
    unit: z.enum(PRICE_UNITS),
    amount: z.string().regex(PRICE_AMOUNT_PATTERN),
  })
  .strict();
export type PriceItem = z.infer<typeof priceItemSchema>;

/** Why a price's units cannot go together; a unit set is either fine or has the first conflict found. */
export type PricingConflict = "audio_units" | "character_units" | "asr_tokens_and_audio";

function countIn(units: readonly PriceUnit[], group: readonly PriceUnit[]): number {
  return units.filter((unit) => group.includes(unit)).length;
}

/**
 * The first rule a price's units break, if any. Only one audio unit and one character unit
 * may be used, since each bills the same quantity at a different scale; for `asr`, token
 * units and audio units are alternative ways to bill one transcription, never both.
 * `per_request` is a surcharge and combines with anything.
 */
export function pricingConflict(pricing: ModelPricing, scope?: PricingScope): PricingConflict | undefined {
  const units = pricing.items.map((item) => item.unit);
  if (countIn(units, AUDIO_UNITS) > 1) {
    return "audio_units";
  }
  if (countIn(units, CHARACTER_UNITS) > 1) {
    return "character_units";
  }
  if (scope === "asr" && countIn(units, ASR_TOKEN_UNITS) > 0 && countIn(units, AUDIO_UNITS) > 0) {
    return "asr_tokens_and_audio";
  }
  return undefined;
}

/** The user's own price of one model; never verified. Cost estimates use the copy frozen onto each request. */
export const modelPricingSchema = z
  .object({
    currency: z.enum(PRICE_CURRENCIES),
    items: z
      .array(priceItemSchema)
      .min(1)
      .max(PRICE_ITEMS_MAX)
      .refine((items) => new Set(items.map((item) => item.unit)).size === items.length, { message: "units must not repeat" })
      .refine((items) => countIn(items.map((item) => item.unit), AUDIO_UNITS) <= 1, { message: "at most one audio unit" })
      .refine((items) => countIn(items.map((item) => item.unit), CHARACTER_UNITS) <= 1, { message: "at most one character unit" }),
    note: z.string().trim().min(1).max(PRICE_NOTE_MAX_CHARS).exactOptional(),
  })
  .strict();
export type ModelPricing = z.infer<typeof modelPricingSchema>;

/**
 * The price of a model as it stood when a request was sent. Recorded with that request and
 * never changed afterwards, so later price edits do not alter the estimate of past calls.
 */
export type PriceSnapshot = ModelPricing;
export const priceSnapshotSchema = modelPricingSchema;

/** Whether every item of a price uses a unit its section offers and the units combine under the section's rules. */
export function pricingFitsScope(pricing: ModelPricing, scope: PricingScope): boolean {
  const allowed = PRICE_UNITS_BY_SCOPE[scope];
  return pricing.items.every((item) => allowed.includes(item.unit)) && pricingConflict(pricing, scope) === undefined;
}
