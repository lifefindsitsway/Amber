import { describe, expect, it } from "vitest";
import { SPEAKER_SPLIT_MIN_MS } from "../../src/shared/defaults.ts";
import { canSplit, splitPoint } from "../../src/shared/speaker-split.ts";

const sentence = { startMs: 10_000, endMs: 14_000 };

describe("canSplit", () => {
  it("needs room for SPEAKER_SPLIT_MIN_MS on both sides", () => {
    expect(canSplit({ startMs: 0, endMs: 2 * SPEAKER_SPLIT_MIN_MS })).toBe(true);
    expect(canSplit({ startMs: 0, endMs: 2 * SPEAKER_SPLIT_MIN_MS - 1 })).toBe(false);
  });
});

describe("splitPoint", () => {
  it("prefers the recognized change, then the playhead, then the estimate", () => {
    expect(splitPoint(sentence, { changeAtMs: 11_000, playheadMs: 12_000, caretRatio: 0.9 })).toEqual({ atMs: 11_000, source: "recognized" });
    expect(splitPoint(sentence, { playheadMs: 12_000, caretRatio: 0.9 })).toEqual({ atMs: 12_000, source: "playhead" });
    expect(splitPoint(sentence, { caretRatio: 0.25 })).toEqual({ atMs: 11_000, source: "estimated" });
  });

  it("uses the playhead and the change point only strictly inside the sentence", () => {
    expect(splitPoint(sentence, { changeAtMs: 10_000, playheadMs: 14_000, caretRatio: 0.5 })).toEqual({ atMs: 12_000, source: "estimated" });
    expect(splitPoint(sentence, { changeAtMs: 20_000, playheadMs: 12_500, caretRatio: 0.5 })).toEqual({ atMs: 12_500, source: "playhead" });
  });

  it("clamps the point so both halves keep SPEAKER_SPLIT_MIN_MS, keeping the source", () => {
    expect(splitPoint(sentence, { changeAtMs: 10_050, caretRatio: 0.5 })).toEqual({ atMs: 10_000 + SPEAKER_SPLIT_MIN_MS, source: "recognized" });
    expect(splitPoint(sentence, { playheadMs: 13_990, caretRatio: 0.5 })).toEqual({ atMs: 14_000 - SPEAKER_SPLIT_MIN_MS, source: "playhead" });
    expect(splitPoint(sentence, { caretRatio: 1 }).atMs).toBe(14_000 - SPEAKER_SPLIT_MIN_MS);
    expect(splitPoint(sentence, { caretRatio: -3 }).atMs).toBe(10_000 + SPEAKER_SPLIT_MIN_MS);
  });

  it("estimates with an integer time, and falls back to the middle for a bad ratio", () => {
    expect(Number.isInteger(splitPoint({ startMs: 0, endMs: 1001 }, { caretRatio: 1 / 3 }).atMs)).toBe(true);
    expect(splitPoint(sentence, { caretRatio: Number.NaN }).atMs).toBe(12_000);
  });

  it("returns the middle of a sentence too short to split", () => {
    expect(splitPoint({ startMs: 0, endMs: 400 }, { caretRatio: 0.9 }).atMs).toBe(200);
  });
});
