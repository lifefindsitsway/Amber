import { describe, expect, it } from "vitest";
import {
  PRICE_ITEMS_MAX,
  PRICE_UNITS,
  PRICE_UNITS_BY_SCOPE,
  modelPricingSchema,
  priceSnapshotSchema,
  pricingConflict,
  pricingFitsScope,
  type PriceUnit,
} from "../../src/shared/model-pricing.ts";

function priced(...units: PriceUnit[]) {
  return { currency: "CNY" as const, items: units.map((unit) => ({ unit, amount: "1" })) };
}

const LLM_FULL: PriceUnit[] = [
  "input_tokens_per_million",
  "output_tokens_per_million",
  "cached_input_tokens_per_million",
  "cache_write_tokens_per_million",
  "cache_write_1h_tokens_per_million",
  "per_request",
];

describe("price units per section", () => {
  it("offers an LLM model exactly as many units as a price may have items", () => {
    expect([...PRICE_UNITS_BY_SCOPE.llm]).toEqual(LLM_FULL);
    expect(PRICE_UNITS_BY_SCOPE.llm).toHaveLength(PRICE_ITEMS_MAX);
  });

  it("offers ASR billed tokens, audio and a per-request charge, and no cache units", () => {
    expect([...PRICE_UNITS_BY_SCOPE.asr]).toEqual([
      "input_tokens_per_million",
      "output_tokens_per_million",
      "audio_per_second",
      "audio_per_minute",
      "audio_per_hour",
      "per_request",
    ]);
  });

  it("offers every unit to other models", () => {
    expect([...PRICE_UNITS_BY_SCOPE.other]).toEqual([...PRICE_UNITS]);
  });
});

describe("modelPricingSchema", () => {
  it("accepts the full LLM combination and it fits the llm section", () => {
    const parsed = modelPricingSchema.parse(priced(...LLM_FULL));
    expect(parsed.items).toHaveLength(PRICE_ITEMS_MAX);
    expect(pricingFitsScope(parsed, "llm")).toBe(true);
    expect(priceSnapshotSchema.safeParse(parsed).success).toBe(true);
  });

  it("rejects a seventh item", () => {
    expect(modelPricingSchema.safeParse(priced(...LLM_FULL, "per_image")).success).toBe(false);
  });

  it("rejects a repeated unit", () => {
    expect(modelPricingSchema.safeParse(priced("input_tokens_per_million", "input_tokens_per_million")).success).toBe(false);
  });

  it("rejects two audio units and two character units, but accepts one of each kind together", () => {
    expect(modelPricingSchema.safeParse(priced("audio_per_second", "audio_per_hour")).success).toBe(false);
    expect(modelPricingSchema.safeParse(priced("characters_per_thousand", "characters_per_million")).success).toBe(false);
    expect(modelPricingSchema.safeParse(priced("audio_per_minute", "characters_per_thousand", "per_image")).success).toBe(true);
  });

  it("lets a per-request charge sit beside any other unit", () => {
    for (const unit of PRICE_UNITS.filter((candidate) => candidate !== "per_request")) {
      expect(modelPricingSchema.safeParse(priced(unit, "per_request")).success, unit).toBe(true);
    }
  });
});

describe("pricingFitsScope", () => {
  it("keeps cache units out of the asr section", () => {
    for (const unit of ["cached_input_tokens_per_million", "cache_write_tokens_per_million", "cache_write_1h_tokens_per_million"] as const) {
      expect(pricingFitsScope(priced(unit), "asr"), unit).toBe(false);
      expect(pricingFitsScope(priced(unit), "llm"), unit).toBe(true);
    }
  });

  it("makes ASR tokens and audio alternatives, with a per-request charge beside either", () => {
    expect(pricingFitsScope(priced("input_tokens_per_million", "output_tokens_per_million", "per_request"), "asr")).toBe(true);
    expect(pricingFitsScope(priced("audio_per_minute", "per_request"), "asr")).toBe(true);
    expect(pricingFitsScope(priced("input_tokens_per_million", "audio_per_second"), "asr")).toBe(false);
    expect(pricingFitsScope(priced("output_tokens_per_million", "audio_per_hour"), "asr")).toBe(false);
  });

  it("allows tokens beside audio outside the asr section", () => {
    expect(pricingFitsScope(priced("input_tokens_per_million", "audio_per_second"), "other")).toBe(true);
  });

  it("rejects units that do not belong to the section", () => {
    expect(pricingFitsScope(priced("audio_per_second"), "llm")).toBe(false);
    expect(pricingFitsScope(priced("per_image"), "asr")).toBe(false);
  });
});

describe("pricingConflict", () => {
  it("names the first rule broken, and nothing for a sound price", () => {
    expect(pricingConflict(priced(...LLM_FULL), "llm")).toBeUndefined();
    expect(pricingConflict(priced("audio_per_second", "audio_per_minute"), "asr")).toBe("audio_units");
    expect(pricingConflict(priced("characters_per_thousand", "characters_per_ten_thousand"), "other")).toBe("character_units");
    expect(pricingConflict(priced("input_tokens_per_million", "audio_per_hour"), "asr")).toBe("asr_tokens_and_audio");
    expect(pricingConflict(priced("input_tokens_per_million", "audio_per_hour"), "other")).toBeUndefined();
    expect(pricingConflict(priced("input_tokens_per_million", "audio_per_hour"))).toBeUndefined();
  });
});
