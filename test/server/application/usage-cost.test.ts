import { describe, expect, it } from "vitest";
import { priceGroup, SnapshotReader, toMoney, type GroupPricing } from "../../../src/server/application/usage-cost.ts";
import { USAGE_COMPONENT, USAGE_FLAG, type UsageClassFields, type UsageMeasures } from "../../../src/server/domain/usage-analytics.ts";
import type { UsageModality } from "../../../src/shared/dto/usage-analytics.ts";

type Group = UsageClassFields & UsageMeasures & { modality: UsageModality };

function group(modality: UsageModality, fields: Partial<Group> = {}): Group {
  return {
    modality,
    snapshotJson: null,
    bitmap: 0,
    flags: 0,
    result: "succeeded",
    requests: 1n,
    rawInput: 0n,
    input: 0n,
    output: 0n,
    reasoning: 0n,
    cacheRead: 0n,
    cacheWrite: 0n,
    cacheWrite1h: 0n,
    audioBilledMs: 0n,
    audioLocalMs: 0n,
    lastAt: 0,
    ...fields,
  };
}

function price(fields: Group, items: Array<[string, string]>, currency = "CNY"): GroupPricing {
  const json = JSON.stringify({ currency, items: items.map(([unit, amount]) => ({ unit, amount })) });
  return priceGroup(fields, new SnapshotReader().read(json, fields.modality));
}

function reasonOf(pricing: GroupPricing): string | undefined {
  return pricing.kind === "left_out" ? pricing.reason : pricing.kind === "no_snapshot" ? "no_snapshot" : undefined;
}

const LLM_USAGE = { rawInput: 1000n, input: 1000n, output: 500n, bitmap: USAGE_COMPONENT.input | USAGE_COMPONENT.output };

describe("a request without a snapshot", () => {
  it("has no currency and no cost", () => {
    expect(priceGroup(group("llm", LLM_USAGE), new SnapshotReader().read(null, "llm"))).toEqual({ kind: "no_snapshot" });
  });
});

describe("a snapshot with only a per-request price", () => {
  const surcharge: Array<[string, string]> = [["per_request", "0.5"]];

  it("counts every request whatever its usage was", () => {
    for (const [modality, result, flags] of [
      ["llm", "failed", USAGE_FLAG.usageAbsent],
      ["llm", "outcome_unknown", USAGE_FLAG.usageAbsent],
      ["llm", "succeeded", USAGE_FLAG.inputMissing],
      ["asr", "failed", 0],
      ["asr", "cancelled", 0],
    ] as const) {
      const pricing = price(group(modality, { result, flags, requests: 4n }), surcharge);
      expect(pricing.kind, `${modality} ${result}`).toBe("counted");
      // 4 requests x 0.5 over the common denominator.
      expect(pricing.kind === "counted" && toMoney("CNY", pricing.cost).amount).toBe("2");
    }
  });
});

describe("LLM requests", () => {
  const input: [string, string] = ["input_tokens_per_million", "2"];
  const output: [string, string] = ["output_tokens_per_million", "8"];

  it("prices normal input, output and the surcharge exactly", () => {
    const pricing = price(group("llm", { ...LLM_USAGE, requests: 3n }), [input, output, ["per_request", "0.01"]]);
    // 1000 x 2 / 1e6 + 500 x 8 / 1e6 = 0.006, plus 3 x 0.01.
    expect(pricing.kind === "counted" && toMoney("CNY", pricing.cost).amount).toBe("0.036");
  });

  it("prices the cache parts at their own prices", () => {
    const fields = group("llm", {
      ...LLM_USAGE,
      input: 400n,
      cacheRead: 500n,
      cacheWrite: 60n,
      cacheWrite1h: 40n,
      bitmap: USAGE_COMPONENT.input | USAGE_COMPONENT.output | USAGE_COMPONENT.cacheRead | USAGE_COMPONENT.cacheWrite | USAGE_COMPONENT.cacheWrite1h,
    });
    const pricing = price(fields, [input, output, ["cached_input_tokens_per_million", "1"], ["cache_write_tokens_per_million", "3"], ["cache_write_1h_tokens_per_million", "5"]]);
    // (400 x 2 + 500 x 8 + 500 x 1 + 60 x 3 + 40 x 5) / 1e6
    expect(pricing.kind === "counted" && toMoney("CNY", pricing.cost).amount).toBe("0.00568");
  });

  it("reports the first missing price, input and output before the cache parts", () => {
    const everything = USAGE_COMPONENT.input | USAGE_COMPONENT.output | USAGE_COMPONENT.cacheRead | USAGE_COMPONENT.cacheWrite | USAGE_COMPONENT.cacheWrite1h;
    const fields = group("llm", { ...LLM_USAGE, cacheRead: 5n, cacheWrite: 5n, cacheWrite1h: 5n, bitmap: everything });
    const cases: Array<[Array<[string, string]>, string]> = [
      [[output, ["cached_input_tokens_per_million", "1"]], "missing_price"],
      [[input, ["cached_input_tokens_per_million", "1"]], "missing_price"],
      [[input, output, ["cache_write_tokens_per_million", "1"], ["cache_write_1h_tokens_per_million", "1"]], "missing_cache_read_price"],
      [[input, output, ["cached_input_tokens_per_million", "1"], ["cache_write_1h_tokens_per_million", "1"]], "missing_cache_write_price"],
      [[input, output, ["cached_input_tokens_per_million", "1"], ["cache_write_tokens_per_million", "1"]], "missing_cache_write_1h_price"],
    ];
    for (const [items, reason] of cases) {
      expect(reasonOf(price(fields, items))).toBe(reason);
    }
  });

  it("needs no price for a part that is zero", () => {
    const pricing = price(group("llm", { rawInput: 10n, input: 10n, bitmap: USAGE_COMPONENT.input }), [input]);
    expect(pricing.kind).toBe("counted");
  });

  it("prices the whole input as normal input when the upstream reported no cache fields", () => {
    const pricing = price(group("llm", { ...LLM_USAGE, rawInput: 1_000_000n, input: 1_000_000n, output: 0n, bitmap: USAGE_COMPONENT.input }), [input]);
    expect(pricing.kind === "counted" && toMoney("CNY", pricing.cost).amount).toBe("2");
  });

  it("leaves out a request that reported output but no input, whatever else it priced", () => {
    const fields = group("llm", { output: 9n, bitmap: USAGE_COMPONENT.output, flags: USAGE_FLAG.inputMissing });
    expect(reasonOf(price(fields, [input, output]))).toBe("input_missing");
  });

  it("explains a request without usage by how it ended", () => {
    const absent = (result: Group["result"]) => group("llm", { result, flags: USAGE_FLAG.usageAbsent });
    expect(reasonOf(price(absent("outcome_unknown"), [input, output]))).toBe("unknown_without_usage");
    expect(reasonOf(price(absent("failed"), [input, output]))).toBe("failed_without_usage");
    expect(reasonOf(price(absent("cancelled"), [input, output]))).toBe("failed_without_usage");
    expect(reasonOf(price(absent("succeeded"), [input, output]))).toBe("usage_missing");
  });
});

describe("unusable snapshots", () => {
  it("are conflicting units, keeping the currency when the text still names one", () => {
    const reader = new SnapshotReader();
    const llmWithAudio = JSON.stringify({ currency: "USD", items: [{ unit: "audio_per_second", amount: "1" }] });
    const asrWithCache = JSON.stringify({ currency: "CNY", items: [{ unit: "cached_input_tokens_per_million", amount: "1" }] });
    const asrBothKinds = JSON.stringify({
      currency: "CNY",
      items: [{ unit: "input_tokens_per_million", amount: "1" }, { unit: "audio_per_second", amount: "1" }],
    });
    const notAPrice = JSON.stringify({ currency: "EUR", items: [] });
    expect(priceGroup(group("llm"), reader.read(llmWithAudio, "llm"))).toEqual({ kind: "left_out", currency: "USD", reason: "conflicting_units" });
    expect(priceGroup(group("asr"), reader.read(asrWithCache, "asr"))).toEqual({ kind: "left_out", currency: "CNY", reason: "conflicting_units" });
    expect(priceGroup(group("asr"), reader.read(asrBothKinds, "asr"))).toEqual({ kind: "left_out", currency: "CNY", reason: "conflicting_units" });
    expect(priceGroup(group("asr"), reader.read(notAPrice, "asr"))).toEqual({ kind: "left_out", currency: null, reason: "conflicting_units" });
  });
});

describe("transcriptions", () => {
  const tokens = USAGE_COMPONENT.input | USAGE_COMPONENT.output;
  const perSecond: Array<[string, string]> = [["audio_per_second", "0.00022"]];

  it("prices billed tokens when the snapshot prices tokens, and needs a price for each positive part", () => {
    const fields = group("asr", { flags: USAGE_FLAG.billedTokens, rawInput: 2_000_000n, input: 2_000_000n, output: 1_000_000n, bitmap: tokens });
    const both: Array<[string, string]> = [["input_tokens_per_million", "1.5"], ["output_tokens_per_million", "4"]];
    const counted = price(fields, both);
    expect(counted.kind === "counted" && toMoney("CNY", counted.cost).amount).toBe("7");
    expect(reasonOf(price(fields, [["output_tokens_per_million", "4"]]))).toBe("missing_price");
    expect(reasonOf(price(fields, [["input_tokens_per_million", "1.5"]]))).toBe("missing_price");
  });

  it("explains missing billed tokens by how the request ended", () => {
    const priceTokens: Array<[string, string]> = [["input_tokens_per_million", "1"]];
    expect(reasonOf(price(group("asr", { result: "succeeded" }), priceTokens))).toBe("usage_missing");
    expect(reasonOf(price(group("asr", { result: "outcome_unknown" }), priceTokens))).toBe("unknown_without_usage");
    expect(reasonOf(price(group("asr", { result: "cancelled" }), priceTokens))).toBe("failed_without_usage");
  });

  it("prefers billed audio time over the local duration", () => {
    const fields = group("asr", { flags: USAGE_FLAG.billedAudio, audioBilledMs: 10_000n, audioLocalMs: 99_000n });
    const pricing = price(fields, perSecond);
    expect(pricing.kind === "counted" && toMoney("CNY", pricing.cost).amount).toBe("0.0022");
  });

  it("falls back to the local duration for a succeeded request only, accepted jobs included", () => {
    const local = { audioLocalMs: 60_000n };
    const succeeded = price(group("asr", local), perSecond);
    expect(succeeded.kind === "counted" && toMoney("CNY", succeeded.cost).amount).toBe("0.0132");
    const accepted = price(group("asr", { ...local, flags: USAGE_FLAG.accepted }), perSecond);
    expect(accepted.kind).toBe("counted");
    expect(reasonOf(price(group("asr", { ...local, result: "failed" }), perSecond))).toBe("failed_without_usage");
    expect(reasonOf(price(group("asr", { ...local, result: "outcome_unknown" }), perSecond))).toBe("unknown_without_usage");
  });

  it("converts minutes and hours from milliseconds", () => {
    const fields = group("asr", { audioLocalMs: 90n * 60_000n });
    const perMinute = price(fields, [["audio_per_minute", "0.1"]]);
    const perHour = price(fields, [["audio_per_hour", "6"]]);
    expect(perMinute.kind === "counted" && toMoney("CNY", perMinute.cost).amount).toBe("9");
    expect(perHour.kind === "counted" && toMoney("CNY", perHour.cost).amount).toBe("9");
  });
});

describe("exactness", () => {
  it("adds ten-fraction-digit prices over a count past 2^53 without rounding", () => {
    const huge = 2n ** 60n + 1n;
    const pricing = price(group("llm", { rawInput: huge, input: huge, bitmap: USAGE_COMPONENT.input }), [["input_tokens_per_million", "0.0000000001"]]);
    // huge x 1e-10 / 1e6 = huge / 1e16
    expect(pricing.kind === "counted" && toMoney("CNY", pricing.cost).amount).toBe("115.29215046");
  });
});

describe("toMoney", () => {
  const denominator = 10n ** 10n * 18_000_000n;

  it("rounds half up to eight fraction digits and trims trailing zeros", () => {
    const unit = denominator / 10n ** 9n; // 1e-9 of a currency unit
    expect(toMoney("CNY", 5n * unit)).toEqual({ currency: "CNY", amount: "0.00000001" });
    expect(toMoney("CNY", 4n * unit)).toEqual({ currency: "CNY", amount: "0" });
    expect(toMoney("USD", denominator * 3n + denominator / 2n)).toEqual({ currency: "USD", amount: "3.5" });
    expect(toMoney("USD", 0n)).toEqual({ currency: "USD", amount: "0" });
  });
});
