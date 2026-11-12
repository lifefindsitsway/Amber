import { describe, expect, it } from "vitest";
import { SPEAKER_ALIGN_MIN_SHARE, SPEAKER_COMPARE_DURATION_TOLERANCE_MS } from "../../src/shared/defaults.ts";
import { compareAttribution, isComparisonGeneration, proposeCorrespondences, withOverrides, type ComparedSentence, type OtherSentence } from "../../src/shared/speaker-comparison.ts";

// Fixtures are times and speaker ordinals only: [startMs, endMs, ordinal or null for unassigned].
type Row = readonly [number, number, number | null];

function mine(rows: readonly Row[]): ComparedSentence[] {
  return rows.map(([startMs, endMs, ordinal], index) => ({ id: `m${index + 1}`, startMs, endMs, speakerId: ordinal === null ? null : `mine-${ordinal}` }));
}

function theirs(rows: readonly Row[]): OtherSentence[] {
  return rows.map(([startMs, endMs, ordinal]) => ({ startMs, endMs, ...(ordinal === null ? {} : { speakerId: `other-${ordinal}` }) }));
}

/** Alternating turns of `ordinals`, `length` ms each, starting at 0. */
function turns(ordinals: ReadonlyArray<number | null>, length = 5_000): Row[] {
  return ordinals.map((ordinal, index) => [index * length, (index + 1) * length, ordinal] as const);
}

function compare(target: ComparedSentence[], source: OtherSentence[], overrides: ReadonlyMap<string, string | null> = new Map()) {
  const correspondences = withOverrides(proposeCorrespondences(target, source), overrides);
  return { correspondences, comparison: compareAttribution(target, source, correspondences) };
}

describe("speaker correspondence", () => {
  it("matches one to one and lists the one sentence the other transcription gives to someone else", () => {
    const target = mine(turns([1, 2, 1, 2, 1, 2, 1, 2]));
    const source = theirs(turns([1, 2, 1, 2, 2, 2, 1, 2]));
    const { correspondences, comparison } = compare(target, source);
    expect(correspondences).toEqual([
      { sourceId: "other-1", targetId: "mine-1", status: "matched", share: 1 },
      { sourceId: "other-2", targetId: "mine-2", status: "matched", share: 0.8 },
    ]);
    expect(comparison.differences).toEqual([{ segmentId: "m5", kind: "different", speakerId: "mine-1", otherSpeakerId: "mine-2" }]);
    expect(comparison.counts).toEqual({ different: 1, undetermined: 0, unmapped: 0 });
    expect(comparison).toMatchObject({ coverage: 1, unreliable: false });
  });

  it("does not report a difference when the same ordinal is a different person in the other transcription", () => {
    // Speaker 1 here is speaker 2 there and the other way round: nothing differs.
    const target = mine(turns([1, 2, 1, 2, 1]));
    const source = theirs(turns([2, 1, 2, 1, 2]));
    const { correspondences, comparison } = compare(target, source);
    expect(correspondences.map((item) => [item.sourceId, item.targetId, item.status])).toEqual([
      ["other-2", "mine-1", "matched"],
      ["other-1", "mine-2", "matched"],
    ]);
    expect(comparison.differences).toEqual([]);
    expect(comparison.counts).toEqual({ different: 0, undetermined: 0, unmapped: 0 });
  });

  it("lets several labels of the other transcription correspond to one person", () => {
    // The other model split speaker 1 into labels 1 and 3.
    const target = mine(turns([1, 2, 1, 2, 1, 2]));
    const source = theirs(turns([1, 2, 3, 2, 1, 2]));
    const { correspondences, comparison } = compare(target, source);
    expect(correspondences.map((item) => [item.sourceId, item.targetId, item.status])).toEqual([
      ["other-1", "mine-1", "matched"],
      ["other-2", "mine-2", "matched"],
      ["other-3", "mine-1", "matched"],
    ]);
    expect(comparison.differences).toEqual([]);
  });

  it("does not force a label that mixes two people onto either of them, and lists its sentences as unmapped", () => {
    // Label 1 covers speaker 1 and speaker 2 alike: a suspected merge.
    const target = mine(turns([1, 2, 3, 1, 2, 3]));
    const source = theirs(turns([1, 1, 3, 1, 1, 3]));
    const { correspondences, comparison } = compare(target, source);
    const merged = correspondences.find((item) => item.sourceId === "other-1");
    expect(merged).toEqual({ sourceId: "other-1", targetId: null, status: "unreliable", share: 0.5 });
    expect(merged?.share).toBeLessThan(SPEAKER_ALIGN_MIN_SHARE);
    expect(correspondences.find((item) => item.sourceId === "other-3")).toMatchObject({ targetId: "mine-3", status: "matched" });
    expect(comparison.differences.map((item) => [item.segmentId, item.kind])).toEqual([
      ["m1", "unmapped"],
      ["m2", "unmapped"],
      ["m4", "unmapped"],
      ["m5", "unmapped"],
    ]);
    expect(comparison.counts).toEqual({ different: 0, undetermined: 0, unmapped: 4 });
  });

  it("marks a label that overlaps nobody here as unmatched", () => {
    // Label 4 speaks only where this transcription has nobody assigned.
    const target = mine([...turns([1, 2, 1, 2]), [20_000, 25_000, null]]);
    const source = theirs([...turns([1, 2, 1, 2]), [20_000, 25_000, 4]]);
    const { correspondences, comparison } = compare(target, source);
    expect(correspondences.find((item) => item.sourceId === "other-4")).toEqual({ sourceId: "other-4", targetId: null, status: "unmatched", share: 0 });
    // The unassigned sentence the other gives to an unmatched label is a lead too.
    expect(comparison.differences).toEqual([{ segmentId: "m5", kind: "unmapped", speakerId: null, otherSpeakerId: null }]);
  });

  it("takes the user's choice for a correspondence, nobody included", () => {
    const target = mine(turns([1, 2, 3, 1, 2, 3]));
    const source = theirs(turns([1, 1, 3, 1, 1, 3]));
    const chosen = compare(target, source, new Map([["other-1", "mine-1"]]));
    expect(chosen.correspondences.find((item) => item.sourceId === "other-1")).toMatchObject({ targetId: "mine-1", status: "unreliable" });
    expect(chosen.comparison.differences.map((item) => [item.segmentId, item.kind, item.otherSpeakerId])).toEqual([
      ["m2", "different", "mine-1"],
      ["m5", "different", "mine-1"],
    ]);
    const nobody = compare(target, source, new Map([["other-3", null]]));
    expect(nobody.comparison.differences.filter((item) => item.speakerId === "mine-3").map((item) => item.kind)).toEqual(["unmapped", "unmapped"]);
  });

  it("lists a sentence the other transcription splits without a clear majority, or leaves unattributed, as undetermined", () => {
    const target = mine([[0, 10_000, 1], [10_000, 20_000, 2], [20_000, 30_000, 1], [30_000, 40_000, 2]]);
    const source = theirs([
      [0, 10_000, 1],
      [10_000, 20_000, 2],
      // Six to four over the third sentence: no clear majority.
      [20_000, 26_000, 1],
      [26_000, 30_000, 2],
      // Nothing attributed over the fourth.
      [30_000, 40_000, null],
    ]);
    const { comparison } = compare(target, source);
    expect(comparison.differences).toEqual([
      { segmentId: "m3", kind: "undetermined", speakerId: "mine-1", otherSpeakerId: null },
      { segmentId: "m4", kind: "undetermined", speakerId: "mine-2", otherSpeakerId: null },
    ]);
    expect(comparison.coverage).toBe(0.75);
  });

  it("never touches its input", () => {
    const target = mine(turns([1, 2, 1]));
    const source = theirs(turns([2, 1, 1]));
    const before = JSON.stringify([target, source]);
    compare(target, source, new Map([["other-2", "mine-2"]]));
    expect(JSON.stringify([target, source])).toBe(before);
  });
});

describe("comparison reliability", () => {
  it("flags timelines whose last sentences end too far apart", () => {
    const target = mine(turns([1, 2, 1, 2]));
    const within = theirs([...turns([1, 2, 1, 2]), [20_000, 20_000 + SPEAKER_COMPARE_DURATION_TOLERANCE_MS, null]]);
    expect(compare(target, within).comparison.unreliable).toBe(false);
    const beyond = theirs([...turns([1, 2, 1, 2]), [20_000, 20_001 + SPEAKER_COMPARE_DURATION_TOLERANCE_MS, null]]);
    expect(compare(target, beyond).comparison.unreliable).toBe(true);
  });

  it("flags a comparison that overlaps too few sentences, and one with nothing to compare", () => {
    // The other covers only the first two of five sentences, but ends at the same time.
    const target = mine(turns([1, 2, 1, 2, 1]));
    const sparse = theirs([...turns([1, 2]), [20_000, 25_000, null]]);
    const result = compare(target, sparse).comparison;
    expect(result.coverage).toBe(0.4);
    expect(result.unreliable).toBe(true);
    expect(compare(target, theirs(turns([null, null, null, null, null]))).comparison.unreliable).toBe(true);
    expect(compare([], theirs(turns([1]))).comparison.unreliable).toBe(true);
  });
});

describe("isComparisonGeneration", () => {
  it("recognizes only an ASR transcription marked for comparison", () => {
    expect(isComparisonGeneration({ kind: "asr", asrProfileId: "p", modelId: "m", purpose: "comparison" })).toBe(true);
    expect(isComparisonGeneration({ kind: "asr", asrProfileId: "p", modelId: "m" })).toBe(false);
    expect(isComparisonGeneration({ kind: "manual", purpose: "comparison" })).toBe(false);
    expect(isComparisonGeneration({})).toBe(false);
  });
});
