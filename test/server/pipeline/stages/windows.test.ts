import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../../src/server/domain/token-estimate.ts";
import type { TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { SPEAKER_RULES_FRAGMENT } from "../../../../src/server/domain/prompts.ts";
import { attributionDigest, speakerFraming, type SpeakerContextSnapshot } from "../../../../src/server/domain/speaker-context.ts";
import { assertWindowFits, planSentenceWindows } from "../../../../src/server/pipeline/stages/windows.ts";
import { CONTEXT_SAFETY_RATIO, LLM_MAX_OUTPUT_TOKENS_DEFAULT, SPEAKER_NAME_MAX_GRAPHEMES } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";

const modelRef = { providerProfileId: "p", modelId: "m" };

function segments(texts: readonly string[]): TranscriptSegment[] {
  return texts.map((text, ordinal) => ({
    id: `seg${ordinal}` as SegmentId,
    revisionId: "r",
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text,
    sourceSegmentIds: [],
  }));
}

describe("planSentenceWindows", () => {
  it("fills windows greedily with global aliases, one physical line per sentence", () => {
    const input = segments(["甲甲甲甲", "乙\r\n乙", "丙丙丙丙", "丁丁丁丁"]);
    const line = estimateTokens("[[s1]] 甲甲甲甲\n");
    const fixedTokens = 40;
    const contextWindowTokens = Math.ceil((fixedTokens + 2.5 * line + 10) / CONTEXT_SAFETY_RATIO);
    const windows = planSentenceWindows(input, { fixedTokens, limits: { contextWindowTokens, maxOutputTokens: 10 }, modelRef });
    expect(windows.map((window) => [window.offset, window.lines])).toEqual([
      [0, ["[[s1]] 甲甲甲甲", "[[s2]] 乙 乙"]],
      [2, ["[[s3]] 丙丙丙丙", "[[s4]] 丁丁丁丁"]],
    ]);
    expect(windows[1]?.segments.map((segment) => segment.id)).toEqual(["seg2", "seg3"]);
  });

  it("puts everything in one window when it fits, reserving the default output when none is declared", () => {
    const windows = planSentenceWindows(segments(["一", "二"]), { fixedTokens: 10, limits: { contextWindowTokens: LLM_MAX_OUTPUT_TOKENS_DEFAULT * 4 }, modelRef });
    expect(windows).toHaveLength(1);
    // Without a declared maxOutputTokens the default is reserved, which a window that small cannot hold.
    expect(() => planSentenceWindows(segments(["一"]), { fixedTokens: 10, limits: { contextWindowTokens: LLM_MAX_OUTPUT_TOKENS_DEFAULT }, modelRef })).toThrow();
  });

  it("refuses an unknown window, a budget with no room and a sentence larger than the budget", () => {
    const code = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (error) {
        return (error as { appError?: { code?: string; details?: unknown } }).appError;
      }
      return undefined;
    };
    expect(code(() => planSentenceWindows(segments(["一"]), { fixedTokens: 1, limits: {}, modelRef }))).toMatchObject({
      code: "llm_capability.context_window_unknown",
      details: modelRef,
    });
    expect(code(() => planSentenceWindows(segments(["一"]), { fixedTokens: 1000, limits: { contextWindowTokens: 1000, maxOutputTokens: 1 }, modelRef }))).toMatchObject({
      code: "llm_capability.context_length",
    });
    expect(code(() => planSentenceWindows(segments(["长".repeat(500)]), { fixedTokens: 1, limits: { contextWindowTokens: 200, maxOutputTokens: 1 }, modelRef }))).toMatchObject({
      code: "llm_capability.context_length",
    });
  });
});

/** Sentences with speakers by index (`undefined` = unassigned), and the framing of a snapshot labelling them. */
function framed(texts: readonly string[], speakerOf: (position: number) => number | undefined, labels: readonly string[]) {
  const input = segments(texts).map((segment, position) => {
    const speaker = speakerOf(position);
    return speaker === undefined ? segment : { ...segment, speakerId: `spk${speaker}` };
  });
  const snapshot: SpeakerContextSnapshot = {
    version: 1,
    rules: SPEAKER_RULES_FRAGMENT.ref,
    attributionDigest: attributionDigest(input),
    speakers: labels.map((label, index) => ({ id: `spk${index}`, ordinal: index + 1, label })),
  };
  return { input, framing: speakerFraming(snapshot, SPEAKER_RULES_FRAGMENT, input) };
}

/** A deterministic pseudo-random sequence in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("planSentenceWindows with speakers", () => {
  it("pays a header for a sentence a cut makes a window's first, though it is no change of speaker", () => {
    const { input, framing } = framed(["甲甲甲甲", "乙乙乙乙", "丙丙丙丙", "丁丁丁丁"], () => 0, ["蒋炎岩"]);
    const line = estimateTokens("[[s1]] 甲甲甲甲\n");
    const header = estimateTokens("【发言人】蒋炎岩\n");
    const fixedTokens = 40;
    // Room for exactly one header and two lines: without pricing the header, all four would seem to fit two per window.
    const contextWindowTokens = Math.ceil((fixedTokens + header + 2 * line + 10) / CONTEXT_SAFETY_RATIO);
    const limits = { contextWindowTokens, maxOutputTokens: 10 };
    const windows = planSentenceWindows(input, { fixedTokens, limits, modelRef, speakers: framing });
    expect(windows.map((window) => window.offset)).toEqual([0, 2]);
    expect(framing.block(windows[1]?.lines ?? [], 2)).toEqual(["【发言人】蒋炎岩", "[[s3]] 丙丙丙丙", "[[s4]] 丁丁丁丁"]);
    // One line less of room and the second window's header no longer fits beside two lines.
    const tighter = { contextWindowTokens: Math.floor((fixedTokens + header + 2 * line + 10 - 1) / CONTEXT_SAFETY_RATIO), maxOutputTokens: 10 };
    expect(planSentenceWindows(input, { fixedTokens, limits: tighter, modelRef, speakers: framing }).map((window) => window.offset)).toEqual([0, 1, 2, 3]);
  });

  it("refuses a sentence that does not fit with its header", () => {
    const { input, framing } = framed(["甲甲甲甲"], () => 0, ["名".repeat(SPEAKER_NAME_MAX_GRAPHEMES)]);
    const line = estimateTokens("[[s1]] 甲甲甲甲\n");
    const limits = { contextWindowTokens: Math.ceil((10 + line + 10) / CONTEXT_SAFETY_RATIO), maxOutputTokens: 10 };
    expect(planSentenceWindows(input, { fixedTokens: 10, limits, modelRef })).toHaveLength(1);
    expect(() => planSentenceWindows(input, { fixedTokens: 10, limits, modelRef, speakers: framing })).toThrow();
  });

  it("keeps every window as sent within the budget, whatever the attributions (alternating, longest names, very short sentences)", () => {
    const longest = ["名".repeat(SPEAKER_NAME_MAX_GRAPHEMES), "Ｎ".repeat(SPEAKER_NAME_MAX_GRAPHEMES), "发言人 3"];
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      const count = 20 + Math.floor(next() * 80);
      const texts = Array.from({ length: count }, () => "字".repeat(1 + Math.floor(next() * (next() < 0.5 ? 3 : 40))));
      const pattern = seed % 3;
      const speakerOf = (position: number): number | undefined =>
        pattern === 0 ? position % 2 : pattern === 1 ? (next() < 0.15 ? undefined : Math.floor(next() * 3)) : Math.floor(position / 3) % 3;
      const { input, framing } = framed(texts, speakerOf, longest);
      const template = "固定部分。".repeat(5);
      const fixedTokens = estimateTokens(`${template}${framing.slotValue("")}`);
      const limits = { contextWindowTokens: Math.ceil((fixedTokens + 120 + Math.floor(next() * 400) + 10) / CONTEXT_SAFETY_RATIO), maxOutputTokens: 10 };
      const windows = planSentenceWindows(input, { fixedTokens, limits, modelRef, speakers: framing });
      expect(windows.flatMap((window) => window.segments).length).toBe(count);
      for (const window of windows) {
        const sent = `${template}${framing.slotValue(framing.block(window.lines, window.offset).join("\n"))}`;
        expect(() => assertWindowFits(sent, 0, limits)).not.toThrow();
      }
    }
  });
});

describe("assertWindowFits", () => {
  it("fails a rendered window over the budget with llm_capability.context_length, counting extra tokens", () => {
    const limits = { contextWindowTokens: Math.ceil((100 + 10) / CONTEXT_SAFETY_RATIO), maxOutputTokens: 10 };
    const prompt = "字".repeat(60);
    expect(() => assertWindowFits(prompt, 0, limits)).not.toThrow();
    let code: unknown;
    try {
      assertWindowFits(prompt, 20, limits);
    } catch (error) {
      code = (error as { appError?: { code?: string } }).appError?.code;
    }
    expect(code).toBe("llm_capability.context_length");
    expect(() => assertWindowFits(prompt, 1000, {})).not.toThrow();
  });
});
