import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { UsageModalityUsage } from "../../../../src/shared/dto/usage-analytics.ts";
import { usageLines } from "../../../../src/web/pages/usage/usage-present.ts";

const t = ((key: string) => key) as unknown as TFunction;

const llm = { input: "1000", output: "20", reasoning: "0", cacheRead: "0", cacheWrite: "0", cacheWrite1h: "0" };
const asr = (billedInputTokens: string, billedOutputTokens: string) => ({ audioMs: "60000", billedInputTokens, billedOutputTokens });

describe("usageLines", () => {
  it("shows billed tokens ahead of the audio for a token-billed transcription", () => {
    const usage: UsageModalityUsage = { llm: null, asr: asr("12000", "300") };
    expect(usageLines(usage, t).map((line) => [line.modality, line.unit])).toEqual([
      ["asr-tokens", "usage.units.asrTokens"],
      ["asr", "usage.units.audio"],
    ]);
  });

  it("shows the billed tokens when only one side was reported", () => {
    expect(usageLines({ llm: null, asr: asr("0", "5") }, t).map((line) => line.modality)).toEqual(["asr-tokens", "asr"]);
  });

  it("keeps only the audio line when no tokens were billed", () => {
    expect(usageLines({ llm: null, asr: asr("0", "0") }, t).map((line) => line.modality)).toEqual(["asr"]);
  });

  it("lists LLM tokens first when both modalities are present", () => {
    expect(usageLines({ llm, asr: asr("12000", "300") }, t).map((line) => line.modality)).toEqual(["llm", "asr-tokens", "asr"]);
  });
});
