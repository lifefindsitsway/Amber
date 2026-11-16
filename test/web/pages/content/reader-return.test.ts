import { describe, expect, it } from "vitest";
import type { TranscriptSegmentDto } from "../../../../src/shared/dto/transcript.ts";
import { captureEditEntry, mapAfterCommit, nearestByTime, nearestShownSentence } from "../../../../src/web/pages/content/reader-return.ts";
import { ROW_KEY_ATTRIBUTE } from "../../../../src/web/pages/content/scroll-anchor.ts";
import type { DraftSegment } from "../../../../src/web/pages/content/speaker-draft.ts";
import type { FilteredRow } from "../../../../src/web/pages/content/speaker-filter.ts";

const box = (top: number, height: number): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 300, height });

/**
 * A reader 400 px tall at y = 100, its rows and sentences laid out at given heights:
 * `lines` are a sentence's line rects, each 20 px tall, at the given tops (in screen coordinates).
 */
function reader(rows: Array<{ key: string; top: number; height: number; sentences: Array<{ id: string; lines: number[] }> }>): HTMLElement {
  const scroller = document.createElement("div");
  scroller.getBoundingClientRect = () => box(100, 400);
  for (const spec of rows) {
    const row = document.createElement("div");
    row.setAttribute(ROW_KEY_ATTRIBUTE, spec.key);
    row.getBoundingClientRect = () => box(spec.top, spec.height);
    for (const sentence of spec.sentences) {
      const span = document.createElement("span");
      span.setAttribute("data-segment-id", sentence.id);
      const rects = sentence.lines.map((top) => box(top, 20));
      span.getClientRects = () => Object.assign(rects.slice(), { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList;
      span.getBoundingClientRect = () => {
        const first = sentence.lines[0] ?? 0;
        const last = sentence.lines[sentence.lines.length - 1] ?? 0;
        return box(first, last + 20 - first);
      };
      row.append(span);
    }
    scroller.append(row);
  }
  return scroller;
}

const segments = ["a", "b", "c", "d", "e", "f"].map((id, index) => ({ id, startMs: index * 1000, endMs: index * 1000 + 900 }));
const base = { revisionId: "r1", navigation: 3, segments };

/** Sentence a starts 50 px above the reader (two lines, the second visible), b and c on screen, d below. */
const layout = () =>
  reader([
    { key: "p1", top: 40, height: 120, sentences: [{ id: "a", lines: [50, 70] }, { id: "b", lines: [90, 110, 130] }] },
    { key: "p2", top: 160, height: 400, sentences: [{ id: "c", lines: [170] }, { id: "d", lines: [520] }] },
  ]);

describe("captureEditEntry", () => {
  it("opens on the playing sentence when it is on screen", () => {
    const { target, back } = captureEditEntry(layout(), { ...base, playback: { known: true, currentId: "c" }, clickedId: "b" });
    expect(target).toEqual({ segmentId: "c", startMs: 2000, endMs: 2900, offset: 70, strong: true });
    expect(back.revisionId).toBe("r1");
    expect(back.navigation).toBe(3);
  });

  it("opens on the clicked sentence when no playback time is known", () => {
    const { target } = captureEditEntry(layout(), { ...base, playback: { known: false }, clickedId: "b" });
    expect(target).toMatchObject({ segmentId: "b", offset: -10, strong: true });
  });

  it("passes over the clicked sentence while playback is known, even with the current one off screen", () => {
    const { target } = captureEditEntry(layout(), { ...base, playback: { known: true, currentId: "d" }, clickedId: "c" });
    // b's first line pokes above the top (90 < 100); c is the first whose first line is wholly visible.
    expect(target).toEqual({ segmentId: "c", startMs: 2000, endMs: 2900, offset: 70, strong: false });
    const between = captureEditEntry(layout(), { ...base, playback: { known: true, currentId: undefined }, clickedId: "b" });
    expect(between.target).toMatchObject({ segmentId: "c", strong: false });
  });

  it("falls back to the first partly visible sentence, and to none on an empty reader", () => {
    const partly = reader([{ key: "p1", top: 0, height: 600, sentences: [{ id: "a", lines: [0, 20, 40, 60, 80, 100, 120, 480, 500] }] }]);
    const { target, back } = captureEditEntry(partly, { ...base, playback: { known: false }, clickedId: undefined });
    expect(target).toEqual({ segmentId: "a", startMs: 0, endMs: 900, offset: -100, strong: false });
    expect(back.top).toEqual({ segmentId: "a", startMs: 0, endMs: 900, offset: -100 });
    const empty = captureEditEntry(reader([]), { ...base, playback: { known: false }, clickedId: undefined });
    expect(empty.target).toBeUndefined();
    expect(empty.back).toEqual({ revisionId: "r1", anchor: undefined, top: undefined, navigation: 3 });
  });

  it("records the topmost sentence for the return, apart from the target, with a negative offset when it starts above", () => {
    const { target, back } = captureEditEntry(layout(), { ...base, playback: { known: true, currentId: "c" }, clickedId: undefined });
    expect(target?.segmentId).toBe("c");
    // a's lines end at 90, above the reader's top at 100: b, starting 10 px above it, is the topmost sentence on screen.
    expect(back.top).toEqual({ segmentId: "b", startMs: 1000, endMs: 1900, offset: -10 });
    expect(back.anchor).toEqual({ key: "p1", offset: -60 });
  });

  it("counts a sentence whose later line reaches into view, starting above it", () => {
    const scroller = reader([{ key: "p1", top: 0, height: 300, sentences: [{ id: "a", lines: [40, 60, 80, 100] }, { id: "b", lines: [130] }] }]);
    const { target, back } = captureEditEntry(scroller, { ...base, playback: { known: false }, clickedId: undefined });
    expect(back.top).toMatchObject({ segmentId: "a", offset: -60 });
    // a is on screen but its first line is not wholly visible: b, whose first line is, is the target.
    expect(target).toMatchObject({ segmentId: "b", offset: 30, strong: false });
  });

  it("ignores sentence elements of another revision and the clicked sentence when off screen", () => {
    const scroller = reader([{ key: "p1", top: 100, height: 100, sentences: [{ id: "zz", lines: [100] }, { id: "e", lines: [130] }] }]);
    const { target } = captureEditEntry(scroller, { ...base, playback: { known: false }, clickedId: "a" });
    expect(target).toMatchObject({ segmentId: "e", strong: false });
  });
});

const draft = (startMs: number, endMs: number, extra: Partial<DraftSegment> = {}): DraftSegment => ({ startMs, endMs, text: "x", sourceSegmentIds: [], ...extra });

describe("mapAfterCommit", () => {
  const committed = [draft(0, 900, { id: "a", sourceSegmentIds: ["a"] }), draft(1000, 1400, { sourceSegmentIds: ["b"] }), draft(1400, 1900, { sourceSegmentIds: ["b"] }), draft(2000, 2900, { id: "c", sourceSegmentIds: ["c"] })];
  const next = [
    { id: "n0", startMs: 0, endMs: 900 },
    { id: "n1", startMs: 1000, endMs: 1400 },
    { id: "n2", startMs: 1400, endMs: 1900 },
    { id: "n3", startMs: 2000, endMs: 2900 },
  ];

  it("maps one to one by draft index when the new revision lines up with the draft", () => {
    expect(mapAfterCommit({ committed, next, ref: { segmentId: "c", startMs: 2000, endMs: 2900 } })).toEqual({ segmentId: "n3", approximate: false });
    // b was split: the piece overlapping it the longest (the later, 500 ms) stands for it.
    expect(mapAfterCommit({ committed, next, ref: { segmentId: "b", startMs: 1000, endMs: 1900 } })).toEqual({ segmentId: "n2", approximate: false });
  });

  it("maps exactly when an earlier manual revision was folded into the draft's base", () => {
    // The draft was based on a manual revision whose sentence m1 is the one the reader showed.
    const folded = [draft(0, 900, { id: "m0", sourceSegmentIds: ["a"] }), draft(1000, 1900, { id: "m1", sourceSegmentIds: ["b"] })];
    const out = [
      { id: "x0", startMs: 0, endMs: 900 },
      { id: "x1", startMs: 1000, endMs: 1900 },
    ];
    expect(mapAfterCommit({ committed: folded, next: out, ref: { segmentId: "m1", startMs: 1000, endMs: 1900 } })).toEqual({ segmentId: "x1", approximate: false });
  });

  it("falls back by time when the count or the times do not line up", () => {
    const fewer = next.slice(0, 3);
    expect(mapAfterCommit({ committed, next: fewer, ref: { segmentId: "c", startMs: 2000, endMs: 2900 } })).toEqual({ segmentId: "n2", approximate: true });
    const shifted = next.map((segment, index) => (index === 3 ? { ...segment, endMs: 2950 } : segment));
    expect(mapAfterCommit({ committed, next: shifted, ref: { segmentId: "c", startMs: 2000, endMs: 2900 } })).toEqual({ segmentId: "n3", approximate: true });
  });

  it("finds a sentence deleted in the draft by time", () => {
    const without = [committed[0], committed[3]] as DraftSegment[];
    const out = [next[0], next[3]] as typeof next;
    // b (1000–1900) was deleted: the draft sentence nearest by time (a and c start 1000 ms away; the earlier) stands for it and
    // maps one to one, but b itself is gone, so the place is only near it.
    expect(mapAfterCommit({ committed: without, next: out, ref: { segmentId: "b", startMs: 1000, endMs: 1900 } })).toEqual({ segmentId: "n0", approximate: true });
    expect(mapAfterCommit({ committed: [], next: out, ref: { segmentId: "b", startMs: 1600, endMs: 1900 } })).toEqual({ segmentId: "n3", approximate: true });
  });

  it("has nothing to map onto in an empty revision", () => {
    expect(mapAfterCommit({ committed, next: [], ref: { segmentId: "c", startMs: 2000, endMs: 2900 } })).toBeUndefined();
  });
});

describe("nearestByTime", () => {
  const candidates = [
    { id: "a", startMs: 0, endMs: 1000 },
    { id: "b", startMs: 1000, endMs: 2000 },
    { id: "c", startMs: 3000, endMs: 4000 },
  ];

  it("prefers the longest overlap, then the nearest start, then the earlier", () => {
    expect(nearestByTime(candidates, { startMs: 900, endMs: 1500 })).toBe("b");
    expect(nearestByTime(candidates, { startMs: 500, endMs: 1500 })).toBe("a");
    expect(nearestByTime(candidates, { startMs: 2400, endMs: 2600 })).toBe("c");
    expect(nearestByTime(candidates, { startMs: 2000, endMs: 2500 })).toBe("b");
    expect(nearestByTime([], { startMs: 0, endMs: 1 })).toBeUndefined();
  });
});

describe("nearestShownSentence", () => {
  const sentence = (id: string, startMs: number): TranscriptSegmentDto => ({ id, revisionId: "r", ordinal: 0, startMs, endMs: startMs + 900, text: id, sourceSegmentIds: [] });
  const paragraph = (...segments: TranscriptSegmentDto[]): FilteredRow => ({ kind: "paragraph", paragraph: { startMs: segments[0]?.startMs ?? 0, segments } });

  it("picks the shown sentence nearest in time, skipping gap and chapter rows", () => {
    const rows: FilteredRow[] = [
      { kind: "chapter", startMs: 0, title: "One" },
      paragraph(sentence("a", 0), sentence("b", 1000)),
      { kind: "gap", firstSkippedId: "c", skippedMs: 3000 },
      paragraph(sentence("f", 5000)),
    ];
    expect(nearestShownSentence(rows, { startMs: 2000, endMs: 2900 })).toBe("b");
    expect(nearestShownSentence(rows, { startMs: 4000, endMs: 4900 })).toBe("f");
    expect(nearestShownSentence(rows, { startMs: 5000, endMs: 5900 })).toBe("f");
  });

  it("finds nothing when no sentence is shown", () => {
    expect(nearestShownSentence([{ kind: "chapter", startMs: 0, title: "One" }], { startMs: 0, endMs: 1 })).toBeUndefined();
    expect(nearestShownSentence([], { startMs: 0, endMs: 1 })).toBeUndefined();
  });
});
