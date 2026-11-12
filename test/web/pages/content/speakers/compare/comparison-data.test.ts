import { describe, expect, it } from "vitest";
import { comparisonCandidates, recognitionModel, speakersInOrder } from "../../../../../../src/web/pages/content/speakers/compare/comparison-data.ts";
import { revision } from "../../../../../fixtures/web/content-data.ts";
import { recognition } from "../../../../../fixtures/web/speaker-compare.ts";

describe("comparisonCandidates", () => {
  it("offers recognitions with speakers other than the draft's own origin, comparison transcriptions first, newest first", () => {
    const origin = recognition("a0", "qwen-asr", { createdAt: 1 });
    const manual = revision("m1", { kind: "manual", parentRevisionId: "a0", generation: { kind: "manual" }, createdAt: 2 });
    const olderOther = recognition("a1", "fun-asr", { createdAt: 3 });
    const newerOther = recognition("a2", "fun-asr", { createdAt: 4 });
    const comparison = recognition("c1", "scribe_v2", { comparison: true, createdAt: 2 });
    const silent = revision("a3", { kind: "asr", generation: { kind: "asr", modelId: "x", diarization: { status: "no_speakers" } }, createdAt: 5 });
    const translated = revision("t1", { kind: "translated", generation: { kind: "asr", diarization: { status: "applied" } }, createdAt: 6 });
    const all = [origin, manual, olderOther, newerOther, comparison, silent, translated];
    expect(comparisonCandidates(all, "m1").map((item) => item.id)).toEqual(["c1", "a2", "a1"]);
    expect(comparisonCandidates(all, "a2").map((item) => item.id)).toEqual(["c1", "a1", "a0"]);
  });
});

describe("helpers", () => {
  it("reads a recognition's model and the speakers in order of first appearance", () => {
    expect(recognitionModel(recognition("a", "scribe_v2"))).toBe("scribe_v2");
    expect(recognitionModel(revision("m", { generation: { kind: "manual" } }))).toBeUndefined();
    expect(speakersInOrder([{ speakerId: "b" }, { speakerId: null }, { speakerId: "a" }, { speakerId: "b" }])).toEqual(["b", "a"]);
  });
});
