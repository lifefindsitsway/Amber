import { describe, expect, it } from "vitest";
import { PARAGRAPH_GAP_MS } from "../../src/shared/defaults.ts";
import {
  chapterStartIndices,
  derivedParagraphStarts,
  hasExplicitParagraphs,
  inheritedParagraphStarts,
  materializeParagraphs,
  mergeParagraph,
  paragraphStartInfo,
  removeSentencesWithParagraphs,
  splitParagraph,
  splitSentenceWithParagraphs,
  validateParagraphState,
} from "../../src/shared/paragraph-marks.ts";
import type { ReadingSentence } from "../../src/shared/reading.ts";

interface Item {
  key: string;
  paragraphStart?: boolean;
}

const explicit = (...starts: boolean[]): Item[] => starts.map((paragraphStart, index) => ({ key: `k${index}`, paragraphStart }));
const plain = (count: number): Item[] => Array.from({ length: count }, (_, index) => ({ key: `k${index}` }));
const starts = (items: readonly Item[]): Array<boolean | undefined> => items.map((item) => item.paragraphStart);

describe("validateParagraphState", () => {
  it("accepts none, all with the first opening, and an empty draft", () => {
    expect(validateParagraphState([])).toBeUndefined();
    expect(validateParagraphState(plain(3))).toBeUndefined();
    expect(validateParagraphState(explicit(true, false, true))).toBeUndefined();
  });

  it("refuses a mix and a first sentence that does not open a paragraph", () => {
    expect(validateParagraphState([{ paragraphStart: true }, {}])).toBe("mixed");
    expect(validateParagraphState([{}, { paragraphStart: false }])).toBe("mixed");
    expect(validateParagraphState(explicit(false, true))).toBe("first_not_start");
  });

  it("tells the mode by the first sentence", () => {
    expect(hasExplicitParagraphs(explicit(true))).toBe(true);
    expect(hasExplicitParagraphs(plain(2))).toBe(false);
    expect(hasExplicitParagraphs([])).toBe(false);
  });
});

describe("materializeParagraphs", () => {
  it("freezes the given starts, the first always opening", () => {
    const items = plain(4);
    const next = materializeParagraphs(items, [false, false, true, false]);
    expect(starts(next)).toEqual([true, false, true, false]);
    expect(items[0]).not.toHaveProperty("paragraphStart");
  });

  it("leaves a draft with explicit paragraphs as it is", () => {
    const items = explicit(true, true, false);
    const next = materializeParagraphs(items, [true, false, false]);
    expect(starts(next)).toEqual([true, true, false]);
    expect(next[1]).toBe(items[1]);
  });
});

describe("splitParagraph / mergeParagraph", () => {
  it("sets and clears one start, sharing the other items", () => {
    const items = explicit(true, false, false);
    const split = splitParagraph(items, 2);
    expect(starts(split)).toEqual([true, false, true]);
    expect(split[0]).toBe(items[0]);
    expect(split[1]).toBe(items[1]);
    expect(starts(mergeParagraph(split, 2))).toEqual([true, false, false]);
  });

  it("round-trips back to equal marks", () => {
    const items = explicit(true, false, true, false);
    expect(starts(mergeParagraph(splitParagraph(items, 1), 1))).toEqual(starts(items));
  });

  it("refuses the first sentence, out of range and drafts without explicit paragraphs", () => {
    expect(() => splitParagraph(explicit(true, false), 0)).toThrow();
    expect(() => mergeParagraph(explicit(true, false), 2)).toThrow();
    expect(() => splitParagraph(plain(2), 1)).toThrow();
  });
});

describe("splitSentenceWithParagraphs", () => {
  it("keeps the left half's mark and sets the right half's", () => {
    // Sentence 1 (opening a paragraph) was cut in two: both halves carry its mark.
    const split = explicit(true, true, true, false);
    expect(starts(splitSentenceWithParagraphs(split, 1, false))).toEqual([true, true, false, false]);
    expect(starts(splitSentenceWithParagraphs(split, 1, true))).toEqual([true, true, true, false]);
    const inside = explicit(true, false, false);
    expect(starts(splitSentenceWithParagraphs(inside, 1, true))).toEqual([true, false, true]);
  });

  it("changes nothing without explicit paragraphs, and needs them to open one", () => {
    expect(starts(splitSentenceWithParagraphs(plain(3), 0, false))).toEqual([undefined, undefined, undefined]);
    expect(() => splitSentenceWithParagraphs(plain(3), 0, true)).toThrow();
  });
});

describe("removeSentencesWithParagraphs", () => {
  it("hands a dropped opener's start to the next kept sentence", () => {
    const items = explicit(true, false, true, false, false);
    expect(starts(removeSentencesWithParagraphs(items, new Set([2])))).toEqual([true, false, true, false]);
  });

  it("carries once over several dropped openers in a row", () => {
    const items = explicit(true, false, true, true, false, false);
    const next = removeSentencesWithParagraphs(items, new Set([2, 3]));
    expect(starts(next)).toEqual([true, false, true, false]);
    expect(next.map((item) => item.key)).toEqual(["k0", "k1", "k4", "k5"]);
  });

  it("makes the first kept sentence open and drops a start at the very end", () => {
    expect(starts(removeSentencesWithParagraphs(explicit(true, false, false), new Set([0])))).toEqual([true, false]);
    expect(starts(removeSentencesWithParagraphs(explicit(true, false, true), new Set([2])))).toEqual([true, false]);
  });

  it("only drops sentences of a draft without explicit paragraphs", () => {
    const next = removeSentencesWithParagraphs(plain(3), new Set([1]));
    expect(next.map((item) => item.key)).toEqual(["k0", "k2"]);
    expect(starts(next)).toEqual([undefined, undefined]);
  });

  it("removes then restores: undo is the earlier snapshot, so remove again gives the same result", () => {
    const items = explicit(true, false, true, false);
    const first = removeSentencesWithParagraphs(items, new Set([2]));
    const again = removeSentencesWithParagraphs(items, new Set([2]));
    expect(starts(again)).toEqual(starts(first));
  });
});

describe("inheritedParagraphStarts", () => {
  it("inherits through sources and carries a dropped opener", () => {
    const base = new Map(Object.entries({ a: { paragraphStart: true }, b: { paragraphStart: false }, c: { paragraphStart: true }, d: { paragraphStart: false } }));
    expect(inheritedParagraphStarts(base, [{ sourceSegmentIds: ["a"] }, { sourceSegmentIds: ["b"] }, { sourceSegmentIds: ["d"] }])).toEqual([true, false, true]);
  });

  it("yields none from an unmarked base", () => {
    const base = new Map(Object.entries({ a: {}, b: {} }));
    expect(inheritedParagraphStarts(base, [{ sourceSegmentIds: ["a"] }, { sourceSegmentIds: ["b"] }])).toEqual([undefined, undefined]);
  });
});

describe("derivedParagraphStarts / chapterStartIndices / paragraphStartInfo", () => {
  const at = (startMs: number, text = "一句话", speakerId?: string): ReadingSentence => ({ startMs, endMs: startMs + 1000, text, ...(speakerId === undefined ? {} : { speakerId }) });

  it("matches the reading view: pauses, speakers and chapters", () => {
    const sentences = [at(0), at(1100), at(1100 + 1000 + PARAGRAPH_GAP_MS + 1), at(10_000, "x", "b"), at(11_100, "y", "b"), at(20_000, "z", "b")];
    expect(derivedParagraphStarts(sentences, [{ startMs: 20_000, title: "第二章" }])).toEqual([true, false, true, true, false, true]);
    expect([...chapterStartIndices(sentences, [{ startMs: 20_000, title: "第二章" }])]).toEqual([5]);
    expect([...chapterStartIndices(sentences, [{ startMs: 0, title: "第一章" }])]).toEqual([0]);
  });

  it("ignores marks the sentences carry", () => {
    const marked = [at(0), at(1100)].map((sentence) => ({ ...sentence, paragraphStart: true }));
    expect(derivedParagraphStarts(marked, [])).toEqual([true, false]);
  });

  it("reports each start and why it cannot be merged", () => {
    const items = explicit(true, true, false, false, true);
    const info = paragraphStartInfo(items, ["a", "a", "a", "b", "b"], new Set([4]), []);
    expect(info).toEqual([
      { start: true, mergeBlock: "first" },
      { start: true },
      { start: false },
      { start: true, mergeBlock: "speaker" },
      { start: true, mergeBlock: "chapter" },
    ]);
  });

  it("uses the derived starts while the draft has no explicit paragraphs, with null and undefined both unassigned", () => {
    const info = paragraphStartInfo(plain(3), [null, undefined, null], new Set(), [true, false, true]);
    expect(info.map((entry) => entry.start)).toEqual([true, false, true]);
    expect(info[2]?.mergeBlock).toBeUndefined();
  });
});
