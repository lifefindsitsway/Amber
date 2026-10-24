import { describe, expect, it } from "vitest";
import type { SegmentId } from "../../../src/shared/ids.ts";
import {
  checkTranscriptInvariants,
  deletionOrder,
  descendantsOf,
  inheritedParagraphStarts,
  manualMergeChain,
  remapSourcesThroughChain,
  revisionBlockers,
  type RevisionReference,
  revisionTakesPrimary,
  rootRevisionTakesPrimary,
  timingFidelityFor,
  type TranscriptRevision,
  type TranscriptSegment,
} from "../../../src/server/domain/transcript.ts";

const PARENT = "01ARZ3NDEKTSV4RRFFQ69G5FA0" as SegmentId;

function revision(overrides: Partial<TranscriptRevision> = {}): TranscriptRevision {
  return {
    id: "rev",
    contentId: "content",
    kind: "corrected",
    parentRevisionId: "parent",
    language: "zh-CN",
    timingFidelity: "inherited_segment",
    generation: { kind: "manual" },
    segmentCount: 2,
    createdAt: 0,
    ...overrides,
  };
}

function segment(ordinal: number, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: `01ARZ3NDEKTSV4RRFFQ69G5FA${ordinal + 1}` as SegmentId,
    revisionId: "rev",
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text: "text",
    sourceSegmentIds: [PARENT],
    ...overrides,
  };
}

describe("timingFidelityFor", () => {
  it("claims word timing only for ASR originals", () => {
    expect(timingFidelityFor("asr")).toBe("exact_words");
    expect(timingFidelityFor("corrected")).toBe("inherited_segment");
    expect(timingFidelityFor("manual")).toBe("inherited_segment");
    expect(timingFidelityFor("platform")).toBe("segment_only");
    expect(timingFidelityFor("imported")).toBe("segment_only");
    expect(timingFidelityFor("translated")).toBe("segment_only");
  });
});

describe("checkTranscriptInvariants", () => {
  it("accepts a well-formed corrected revision", () => {
    expect(checkTranscriptInvariants(revision(), [segment(0), segment(1)])).toEqual([]);
  });

  it("reports every violated invariant", () => {
    const bad = [
      segment(0, { startMs: 500, endMs: 100, words: [{ text: "a", startMs: 0, endMs: 1 }] }),
      segment(0, { id: "s2" as SegmentId, revisionId: "other", sourceSegmentIds: [] }),
    ];
    expect(checkTranscriptInvariants(revision({ segmentCount: 3 }), bad).map((violation) => violation.rule)).toEqual([
      "segment_count_mismatch",
      "invalid_timing",
      "words_without_exact_timing",
      "segment_revision_mismatch",
      "segment_id_not_ulid",
      "ordinal_not_increasing",
      "source_count_mismatch",
    ]);
  });

  it("rejects fractional or negative timing", () => {
    const rules = checkTranscriptInvariants(revision({ segmentCount: 1 }), [segment(0, { startMs: -1, endMs: 10.5 })]);
    expect(rules.map((violation) => violation.rule)).toEqual(["invalid_timing"]);
  });

  it("rejects a zero-length segment", () => {
    const rules = checkTranscriptInvariants(revision({ segmentCount: 1 }), [segment(0, { startMs: 100, endMs: 100 })]);
    expect(rules.map((violation) => violation.rule)).toEqual(["invalid_timing"]);
  });

  it("requires root revisions to have no parent sentences", () => {
    const asr = revision({ kind: "asr", timingFidelity: "exact_words", segmentCount: 1 });
    expect(checkTranscriptInvariants(asr, [segment(0)]).map((violation) => violation.rule)).toEqual([
      "source_count_mismatch",
    ]);
    expect(checkTranscriptInvariants(asr, [segment(0, { sourceSegmentIds: [] })])).toEqual([]);
  });

  it("allows manual revisions to merge several parent sentences", () => {
    const manual = revision({ kind: "manual", segmentCount: 1 });
    const merged = segment(0, { sourceSegmentIds: [PARENT, "01ARZ3NDEKTSV4RRFFQ69G5FA9" as SegmentId] });
    expect(checkTranscriptInvariants(manual, [merged])).toEqual([]);
  });

  it("wants paragraph marks on every sentence or none, with the first sentence opening a paragraph", () => {
    const rules = (segments: TranscriptSegment[]) => checkTranscriptInvariants(revision(), segments).map((violation) => violation.rule);
    expect(rules([segment(0, { paragraphStart: true }), segment(1, { paragraphStart: false })])).toEqual([]);
    expect(rules([segment(0), segment(1)])).toEqual([]);
    expect(rules([segment(0, { paragraphStart: true }), segment(1)])).toEqual(["paragraph_marks_inconsistent"]);
    expect(rules([segment(0, { paragraphStart: false }), segment(1, { paragraphStart: true })])).toEqual(["paragraph_marks_inconsistent"]);
  });
});

describe("inheritedParagraphStarts", () => {
  const base = new Map<string, { paragraphStart?: boolean }>([
    ["a", { paragraphStart: true }],
    ["b", { paragraphStart: false }],
    ["c", { paragraphStart: true }],
    ["d", { paragraphStart: false }],
    ["e", { paragraphStart: true }],
  ]);
  const drafted = (...sources: string[][]) => sources.map((sourceSegmentIds) => ({ sourceSegmentIds }));

  it("takes each sentence's first source, lets only the first part of a split open a paragraph and forces the first sentence", () => {
    expect(inheritedParagraphStarts(base, drafted(["b"], ["c"], ["d"], ["e"], ["e"], []))).toEqual([true, true, false, true, false, false]);
  });

  it("drops a paragraph start swallowed by a merge, since the merged sentence begins with the earlier one", () => {
    expect(inheritedParagraphStarts(base, drafted(["a"], ["b", "c"], ["d"]))).toEqual([true, false, false]);
  });

  it("invents nothing for a base without marks", () => {
    const plain = new Map<string, { paragraphStart?: boolean }>([["a", {}], ["b", {}]]);
    expect(inheritedParagraphStarts(plain, drafted(["a"], ["b"], []))).toEqual([undefined, undefined, undefined]);
  });
});

describe("rootRevisionTakesPrimary", () => {
  it("lets a root working copy become primary only over nothing or another root working copy", () => {
    expect(rootRevisionTakesPrimary(undefined)).toBe(true);
    expect(rootRevisionTakesPrimary("platform")).toBe(true);
    expect(rootRevisionTakesPrimary("asr")).toBe(true);
    for (const kind of ["imported", "manual", "corrected", "translated"] as const) {
      expect(rootRevisionTakesPrimary(kind)).toBe(false);
    }
  });
});

describe("revisionTakesPrimary", () => {
  const primary = (kind: TranscriptRevision["kind"]) => ({ id: "current", kind });

  it("lets imported and committed manual revisions always take primary", () => {
    for (const kind of ["imported", "manual"] as const) {
      expect(revisionTakesPrimary({ kind }, undefined)).toBe(true);
      expect(revisionTakesPrimary({ kind }, primary("manual"))).toBe(true);
    }
  });

  it("lets a corrected revision take primary only when it corrects the current primary", () => {
    expect(revisionTakesPrimary({ kind: "corrected", parentRevisionId: "current" }, primary("asr"))).toBe(true);
    expect(revisionTakesPrimary({ kind: "corrected", parentRevisionId: "older" }, primary("asr"))).toBe(false);
    expect(revisionTakesPrimary({ kind: "corrected", parentRevisionId: "current" }, undefined)).toBe(false);
  });

  it("lets a root revision displace only nothing or another root working copy", () => {
    for (const kind of ["platform", "asr"] as const) {
      expect(revisionTakesPrimary({ kind }, undefined)).toBe(true);
      expect(revisionTakesPrimary({ kind }, primary("platform"))).toBe(true);
      expect(revisionTakesPrimary({ kind }, primary("asr"))).toBe(true);
      for (const held of ["imported", "manual", "corrected"] as const) {
        expect(revisionTakesPrimary({ kind }, primary(held))).toBe(false);
      }
    }
  });

  it("never lets a translation take primary", () => {
    expect(revisionTakesPrimary({ kind: "translated", parentRevisionId: "current" }, undefined)).toBe(false);
    expect(revisionTakesPrimary({ kind: "translated", parentRevisionId: "current" }, primary("asr"))).toBe(false);
  });
});

describe("revision lineage helpers", () => {
  // asr ← corrected ← m1 ← m2 ; corrected ← translated ; asr ← m0
  const lineage = [
    { id: "asr", kind: "asr" as const },
    { id: "corrected", kind: "corrected" as const, parentRevisionId: "asr" },
    { id: "m0", kind: "manual" as const, parentRevisionId: "asr" },
    { id: "m1", kind: "manual" as const, parentRevisionId: "corrected" },
    { id: "translated", kind: "translated" as const, parentRevisionId: "corrected" },
    { id: "m2", kind: "manual" as const, parentRevisionId: "m1" },
  ];

  it("lists descendants nearest first without the root", () => {
    expect(descendantsOf(lineage, "corrected")).toEqual(["m1", "translated", "m2"]);
    expect(descendantsOf(lineage, "m2")).toEqual([]);
  });

  it("orders a deletion leaves first", () => {
    const order = deletionOrder(lineage, new Set(["corrected", "m1", "m2", "translated"]));
    expect(order.indexOf("m2")).toBeLessThan(order.indexOf("m1"));
    expect(order.indexOf("m1")).toBeLessThan(order.indexOf("corrected"));
    expect(order.indexOf("translated")).toBeLessThan(order.indexOf("corrected"));
    expect(order.at(-1)).toBe("corrected");
  });

  it("counts a referencing row once and ignores children deleted along", () => {
    const references: RevisionReference[] = [
      { category: "children", revisionIds: ["m1"], holderRevisionId: "m2" },
      { category: "notes", revisionIds: ["m1", "m2"] },
      { category: "artifacts", revisionIds: ["corrected"] },
    ];
    expect(revisionBlockers(references, new Set(["m1"]))).toMatchObject({ children: 1, notes: 1, artifacts: 0 });
    expect(revisionBlockers(references, new Set(["m1", "m2"]))).toMatchObject({ children: 0, notes: 1, artifacts: 0 });
  });

  it("folds unreferenced manual revisions up to the first one that must stay", () => {
    const merged = manualMergeChain("m2", lineage, () => true);
    expect(merged).toEqual({ chain: ["m2", "m1"], anchorId: "corrected" });
    // A referenced member stops the chain and becomes the anchor.
    expect(manualMergeChain("m2", lineage, (id) => id !== "m1")).toEqual({ chain: ["m2"], anchorId: "m1" });
    // A base with a child other than the chain member below it is kept.
    const branched = [...lineage, { id: "m3", kind: "manual" as const, parentRevisionId: "m2" }];
    expect(manualMergeChain("m2", branched, () => true)).toEqual({ chain: [], anchorId: "m2" });
    // A non-manual base is never folded.
    expect(manualMergeChain("corrected", lineage, () => true)).toEqual({ chain: [], anchorId: "corrected" });
    // The callback sees the chain including the candidate.
    const seen: string[][] = [];
    manualMergeChain("m2", lineage, (_id, chain) => {
      seen.push([...chain]);
      return true;
    });
    expect(seen).toEqual([["m2"], ["m2", "m1"]]);
  });

  it("carries sources up through each folded level, in order and without repeats", () => {
    const id = (value: string) => value as SegmentId;
    const levels = [
      new Map([
        ["b1", [id("a1")]],
        ["b2", [id("a1"), id("a2")]],
        ["b3", []],
      ]),
      new Map([
        ["a1", [id("x1")]],
        ["a2", [id("x2")]],
      ]),
    ];
    expect(remapSourcesThroughChain([id("b2"), id("b1")], levels)).toEqual(["x1", "x2"]);
    expect(remapSourcesThroughChain([id("b3")], levels)).toEqual([]);
    expect(remapSourcesThroughChain([], levels)).toEqual([]);
    expect(remapSourcesThroughChain([id("b1")], [])).toEqual(["b1"]);
  });
});
