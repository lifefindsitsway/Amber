import { describe, expect, it } from "vitest";
import type { AlignedSentence } from "../../../../src/shared/speaker-align.ts";
import {
  applyAlignment,
  assignSpeaker,
  effectiveSpeakers,
  filterCounts,
  filterVisible,
  mergeSpeaker,
  speakerCountOf,
  splitSegment,
  visibleRange,
  type DraftSegment,
} from "../../../../src/web/pages/content/speaker-draft.ts";

const seg = (id: string, startMs: number, endMs: number, extra: Partial<DraftSegment> = {}): DraftSegment => ({ id, startMs, endMs, text: `文${id}`, sourceSegmentIds: [id], speakerId: "a", ...extra });
const draft = (): DraftSegment[] => [seg("1", 0, 1_000), seg("2", 1_000, 2_000, { speakerId: "b" }), seg("3", 2_000, 3_000, { speakerId: "b" }), seg("4", 3_000, 4_000, { speakerId: null })];

describe("effectiveSpeakers", () => {
  it("reads an explicit speaker, null for none, and the first source's for a draft that does not say", () => {
    const base = new Map([["1", "x"]]);
    const segments: DraftSegment[] = [seg("1", 0, 1, { speakerId: "a" }), seg("2", 1, 2, { speakerId: null }), { id: "3", startMs: 2, endMs: 3, text: "", sourceSegmentIds: ["1"] }, { id: "4", startMs: 3, endMs: 4, text: "", sourceSegmentIds: [] }];
    expect(effectiveSpeakers(segments, base)).toEqual(["a", null, "x", null]);
  });
});

describe("assignSpeaker", () => {
  it("states the speaker and drops the review mark, leaving other sentences the same objects", () => {
    const segments = [seg("1", 0, 1, { speakerReview: "needs_review" }), seg("2", 1, 2)];
    const next = assignSpeaker(segments, [0], "b");
    expect(next[0]).toEqual({ id: "1", startMs: 0, endMs: 1, text: "文1", sourceSegmentIds: ["1"], speakerId: "b" });
    expect(next[1]).toBe(segments[1]);
  });

  it("returns the same array when nothing changes, so no empty undo step is made", () => {
    const segments = [seg("1", 0, 1)];
    expect(assignSpeaker(segments, [0], "a")).toBe(segments);
    // A confirmed speaker still clears the mark even when the same.
    expect(assignSpeaker([seg("1", 0, 1, { speakerReview: "needs_review" })], [0], "a")[0]).not.toHaveProperty("speakerReview");
  });
});

describe("mergeSpeaker", () => {
  it("gives every sentence of one speaker to the other, only in the draft", () => {
    const segments = draft();
    const merged = mergeSpeaker(segments, effectiveSpeakers(segments, undefined), "b", "a");
    expect(merged.map((item) => item.speakerId)).toEqual(["a", "a", "a", null]);
    expect(mergeSpeaker(segments, effectiveSpeakers(segments, undefined), "a", "a")).toBe(segments);
  });
});

describe("splitSegment", () => {
  const request = { offset: 2, atMs: 500, leftSpeakerId: "a", rightSpeakerId: "b", leftChosen: false, rightChosen: false, newId: () => "new" };

  it("cuts text and time, keeps the id on the left, points both halves at the same sources and drops review", () => {
    const segments = [seg("1", 0, 1_000, { text: "前半后半", speakerReview: "auto", sourceSegmentIds: ["s1", "s2"] })];
    const done = splitSegment(segments, 0, request);
    expect(done?.segments).toEqual([
      { id: "1", startMs: 0, endMs: 500, text: "前半", sourceSegmentIds: ["s1", "s2"], speakerId: "a" },
      { id: "new", startMs: 500, endMs: 1_000, text: "后半", sourceSegmentIds: ["s1", "s2"], speakerId: "b" },
    ]);
    expect(done?.rightKey).toBe("new");
  });

  it("hands a pending review on to each half whose speaker was not chosen, and clears it for a chosen one", () => {
    const waiting = [seg("1", 0, 1_000, { text: "前半后半", speakerReview: "needs_review" })];
    expect(splitSegment(waiting, 0, request)?.segments.map((item) => item.speakerReview)).toEqual(["needs_review", "needs_review"]);
    expect(splitSegment(waiting, 0, { ...request, rightChosen: true })?.segments.map((item) => item.speakerReview)).toEqual(["needs_review", undefined]);
    expect(splitSegment(waiting, 0, { ...request, leftChosen: true, rightChosen: true })?.segments.map((item) => item.speakerReview)).toEqual([undefined, undefined]);
  });

  it("drops any other review mark, chosen or not", () => {
    const confirmed = [seg("1", 0, 1_000, { text: "前半后半", speakerReview: "auto" })];
    expect(splitSegment(confirmed, 0, request)?.segments.map((item) => item.speakerReview)).toEqual([undefined, undefined]);
  });

  it("refuses a cut that leaves a half without text or without time", () => {
    const segments = [seg("1", 0, 1_000, { text: "前半后半" })];
    expect(splitSegment(segments, 0, { ...request, offset: 0 })).toBeUndefined();
    expect(splitSegment(segments, 0, { ...request, offset: 4 })).toBeUndefined();
    expect(splitSegment(segments, 0, { ...request, atMs: 1_000 })).toBeUndefined();
  });
});

describe("applyAlignment", () => {
  it("writes the speaker and review of each sentence, keeping texts, and records what changed and where to split", () => {
    const segments = draft();
    const aligned: AlignedSentence[] = [
      { id: "1", speakerId: "a", review: "auto" },
      { id: "2", speakerId: "a", review: "needs_review", changeAtMs: 1_500 },
      { id: "3", speakerId: null },
      { id: "4", speakerId: null, review: "needs_review" },
    ];
    const applied = applyAlignment(segments, effectiveSpeakers(segments, undefined), aligned);
    expect(applied.segments.map((item) => [item.speakerId, item.speakerReview ?? null])).toEqual([["a", "auto"], ["a", "needs_review"], [null, null], [null, null]]);
    expect(applied.segments.map((item) => item.text)).toEqual(segments.map((item) => item.text));
    // 2 changed b→a, 3 changed b→none; 1 and 4 stayed.
    expect([...applied.changedKeys]).toEqual(["2", "3"]);
    expect([...applied.changeAt]).toEqual([["2", 1_500]]);
    expect(applied.reviewCount).toBe(1);
    // The unassigned sentence with a suggestion of nobody is nothing to confirm.
    expect(applied.autoCount).toBe(1);
  });
});

describe("filters", () => {
  const segments = [seg("1", 0, 1_000), seg("2", 1_000, 2_000, { speakerId: "b", speakerReview: "needs_review" }), seg("3", 2_000, 3_000, { speakerId: null })];
  const resolved = effectiveSpeakers(segments, undefined);

  it("shows all, one speaker, those to confirm, the unassigned and the changed, by original index", () => {
    const changed = new Set(["3"]);
    expect(filterVisible(segments, resolved, { kind: "all" }, changed)).toBeUndefined();
    expect([...(filterVisible(segments, resolved, { kind: "speaker", speakerId: "b" }, changed) ?? [])]).toEqual([1]);
    expect([...(filterVisible(segments, resolved, { kind: "review" }, changed) ?? [])]).toEqual([1]);
    expect([...(filterVisible(segments, resolved, { kind: "unassigned" }, changed) ?? [])]).toEqual([2]);
    expect([...(filterVisible(segments, resolved, { kind: "changed" }, changed) ?? [])]).toEqual([2]);
  });

  it("counts each", () => {
    const counts = filterCounts(segments, resolved, new Set(["1", "3"]));
    expect(counts).toMatchObject({ all: 3, review: 1, unassigned: 1, changed: 2 });
    expect([...counts.bySpeaker]).toEqual([["a", 1], ["b", 1]]);
  });
});

describe("visibleRange and speakerCountOf", () => {
  it("selects only what is on screen, in either direction", () => {
    expect(visibleRange(4, 1, new Set([1, 3, 4]), 10)).toEqual([1, 3, 4]);
    expect(visibleRange(1, 3, undefined, 10)).toEqual([1, 2, 3]);
  });

  it("counts distinct speakers", () => {
    expect(speakerCountOf([{ speakerId: "a" }, { speakerId: "b" }, { speakerId: "a" }, {}, { speakerId: null }])).toBe(2);
  });
});
