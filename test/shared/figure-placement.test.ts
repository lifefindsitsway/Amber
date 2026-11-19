import { describe, expect, it } from "vitest";
import { gapOf, moveByParagraph, placeAfterSentence, placeFigures, placementForGap, type PlaceableFigure, type PlacementParagraph } from "../../src/shared/figure-placement.ts";

const R = "rev-read";

/** Three paragraphs: p0 = s1 s2 (0, 1000), p1 = s3 (5000), p2 = s4 s5 (9000, 12000). */
const PARAGRAPHS: PlacementParagraph[] = [
  { segments: [{ id: "s1", startMs: 0 }, { id: "s2", startMs: 1000 }] },
  { segments: [{ id: "s3", startMs: 5000 }] },
  { segments: [{ id: "s4", startMs: 9000 }, { id: "s5", startMs: 12000 }] },
];

let seq = 0;
function fig(over: Partial<PlaceableFigure> & { id: string }): PlaceableFigure {
  seq += 1;
  return { createdAt: seq, displayMs: 0, sortKey: 0, anchor: null, ...over };
}

function gaps(figures: PlaceableFigure[], options: { paragraphs?: PlacementParagraph[]; map?: (rev: string, seg: string) => string | undefined; reading?: string } = {}) {
  const layout = placeFigures({
    readingRevisionId: options.reading ?? R,
    paragraphs: options.paragraphs ?? PARAGRAPHS,
    figures,
    ...(options.map === undefined ? {} : { mapSentence: options.map }),
  });
  return { layout, at: (id: string) => gapOf(layout, id), via: (id: string) => layout.placed.find((entry) => entry.figure.id === id)?.via };
}

describe("placeFigures", () => {
  it("places a figure anchored in the revision being read before or after its sentence's paragraph", () => {
    const { at, via } = gaps([
      fig({ id: "after", anchor: { revisionId: R, segmentId: "s3", side: "after" }, displayMs: 99_000 }),
      fig({ id: "before", anchor: { revisionId: R, segmentId: "s5", side: "before" } }),
    ]);
    expect(at("after")).toBe(2);
    expect(at("before")).toBe(2);
    expect(via("after")).toBe("anchor");
  });

  it("maps an anchor from another revision, and falls back to time when the mapping fails", () => {
    const map = (rev: string, seg: string) => (rev === "other" && seg === "x1" ? "s1" : undefined);
    const { at, via } = gaps(
      [
        fig({ id: "mapped", anchor: { revisionId: "other", segmentId: "x1", side: "after" }, displayMs: 12_000 }),
        fig({ id: "unmapped", anchor: { revisionId: "other", segmentId: "x9", side: "after" }, displayMs: 5_500 }),
      ],
      { map },
    );
    expect([at("mapped"), via("mapped")]).toEqual([1, "mapped"]);
    expect([at("unmapped"), via("unmapped")]).toEqual([2, "time"]);
  });

  it("places by time after the paragraph of the last sentence starting no later, and at the top before every sentence", () => {
    const shifted: PlacementParagraph[] = [{ segments: [{ id: "a", startMs: 2000 }] }, { segments: [{ id: "b", startMs: 4000 }] }];
    const { at } = gaps([fig({ id: "early", displayMs: 1000 }), fig({ id: "exact", displayMs: 4000 }), fig({ id: "mid", displayMs: 3000 })], { paragraphs: shifted });
    expect([at("early"), at("mid"), at("exact")]).toEqual([0, 1, 2]);
  });

  it("keeps a figure between two paragraphs that start at the same time where it was put (anchor beats time)", () => {
    const twins: PlacementParagraph[] = [{ segments: [{ id: "t1", startMs: 3000 }] }, { segments: [{ id: "t2", startMs: 3000 }] }, { segments: [{ id: "t3", startMs: 6000 }] }];
    const placed = fig({ id: "f", displayMs: 3000, anchor: { revisionId: R, segmentId: "t1", side: "after" } });
    // Laid out again (a reload), it is still between t1 and t2, although its time alone would put it after t2.
    expect(gaps([placed], { paragraphs: twins }).at("f")).toBe(1);
    expect(gaps([{ ...placed, anchor: null }], { paragraphs: twins }).at("f")).toBe(2);
  });

  it("follows the revision the reader switches to: another version, a translation, a split or deleted paragraph, a deleted anchor revision", () => {
    const anchored = fig({ id: "f", displayMs: 5000, anchor: { revisionId: "orig", segmentId: "o3", side: "after" } });
    // Proofread version or translation: the sentence maps one to one.
    expect(gaps([anchored], { map: (_rev, seg) => (seg === "o3" ? "s3" : undefined) }).at("f")).toBe(2);
    // The paragraph was split: s3 now opens a paragraph of its own further down.
    const split: PlacementParagraph[] = [...PARAGRAPHS.slice(0, 2), { segments: [{ id: "s4", startMs: 9000 }] }, { segments: [{ id: "s5", startMs: 12000 }] }];
    expect(gaps([anchored], { paragraphs: split, map: () => "s5" }).at("f")).toBe(4);
    // The anchored sentence was deleted in the edit: no mapping, its time decides.
    expect(gaps([anchored], { map: () => undefined }).at("f")).toBe(2);
    // The anchor's revision is gone: the same.
    expect(gaps([anchored]).at("f")).toBe(2);
    // A sentence hidden by a filter is not in the paragraphs: time again.
    expect(gaps([{ ...anchored, anchor: { revisionId: R, segmentId: "s3", side: "after" } }], { paragraphs: [PARAGRAPHS[0]!, PARAGRAPHS[2]!] }).at("f")).toBe(1);
  });

  it("orders figures in one gap by sort key, side, time, creation and id", () => {
    const { layout } = gaps([
      fig({ id: "z-time", displayMs: 5000, createdAt: 1 }),
      fig({ id: "before", anchor: { revisionId: R, segmentId: "s4", side: "before" }, createdAt: 2 }),
      fig({ id: "after", anchor: { revisionId: R, segmentId: "s3", side: "after" }, createdAt: 3 }),
      fig({ id: "a-time", displayMs: 5000, createdAt: 1 }),
      fig({ id: "late-time", displayMs: 6000, createdAt: 0 }),
      fig({ id: "first", displayMs: 8000, sortKey: -1 }),
    ]);
    expect(layout.byGap.get(2)?.map((figure) => figure.id)).toEqual(["first", "after", "a-time", "z-time", "late-time", "before"]);
    expect(layout.placed.map((entry) => entry.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("puts every figure at the top when there are no paragraphs", () => {
    const { layout } = gaps([fig({ id: "a", displayMs: 9000 }), fig({ id: "b", anchor: { revisionId: R, segmentId: "s1", side: "after" } })], { paragraphs: [] });
    expect(layout.paragraphCount).toBe(0);
    expect(layout.byGap.get(0)?.length).toBe(2);
  });
});

describe("moving a figure", () => {
  const figures = [fig({ id: "m", anchor: { revisionId: R, segmentId: "s3", side: "after" } }), fig({ id: "n", anchor: { revisionId: R, segmentId: "s2", side: "after" }, sortKey: 4 })];
  const layout = placeFigures({ readingRevisionId: R, paragraphs: PARAGRAPHS, figures });
  const move = (figureId: string, direction: "up" | "down", at = layout) => moveByParagraph({ layout: at, paragraphs: PARAGRAPHS, readingRevisionId: R, figureId, direction });

  it("moves up to the end of the gap above and down to the start of the gap below", () => {
    expect(move("m", "up")).toEqual({ displayMs: 0, anchor: { revisionId: R, segmentId: "s2", side: "after" }, sortKey: 5 });
    expect(move("m", "down")).toEqual({ displayMs: 9000, anchor: { revisionId: R, segmentId: "s5", side: "after" }, sortKey: 0 });
    expect(move("n", "down")).toEqual({ displayMs: 5000, anchor: { revisionId: R, segmentId: "s3", side: "after" }, sortKey: -1 });
  });

  it("moves into the top gap before the first sentence, and stops at the top and bottom", () => {
    const top = placeFigures({ readingRevisionId: R, paragraphs: PARAGRAPHS, figures: [fig({ id: "t", anchor: { revisionId: R, segmentId: "s2", side: "after" } })] });
    expect(move("t", "up", top)).toEqual({ displayMs: 0, anchor: { revisionId: R, segmentId: "s1", side: "before" }, sortKey: 0 });
    // Laid out by time alone, it is still above the first paragraph, whose first sentence starts at 0.
    expect(gapOf(placeFigures({ readingRevisionId: "other", paragraphs: PARAGRAPHS, figures: [fig({ id: "t", ...move("t", "up", top)! })] }), "t")).toBe(0);
    const atTop = placeFigures({ readingRevisionId: R, paragraphs: PARAGRAPHS, figures: [fig({ id: "t", anchor: { revisionId: R, segmentId: "s1", side: "before" } })] });
    expect(move("t", "up", atTop)).toBeUndefined();
    const atBottom = placeFigures({ readingRevisionId: R, paragraphs: PARAGRAPHS, figures: [fig({ id: "b", anchor: { revisionId: R, segmentId: "s5", side: "after" } })] });
    expect(move("b", "down", atBottom)).toBeUndefined();
    expect(move("missing", "down")).toBeUndefined();
  });

  it("round-trips: a moved figure laid out again lands in the target gap", () => {
    const placement = move("m", "up");
    const again = placeFigures({ readingRevisionId: R, paragraphs: PARAGRAPHS, figures: [{ ...figures[0]!, ...placement! }, figures[1]!] });
    expect(again.byGap.get(1)?.map((figure) => figure.id)).toEqual(["n", "m"]);
  });

  it("places after a given sentence, last in that gap, anchored to that very sentence", () => {
    expect(placeAfterSentence({ layout, paragraphs: PARAGRAPHS, readingRevisionId: R, segmentId: "s1" })).toEqual({
      displayMs: 0,
      anchor: { revisionId: R, segmentId: "s1", side: "after" },
      sortKey: 5,
    });
    expect(placeAfterSentence({ layout, paragraphs: PARAGRAPHS, readingRevisionId: R, segmentId: "s3", figureId: "m" })?.sortKey).toBe(0);
    expect(placeAfterSentence({ layout, paragraphs: PARAGRAPHS, readingRevisionId: R, segmentId: "nope" })).toBeUndefined();
  });

  it("puts a figure first or last into any gap, and nowhere past the paragraphs", () => {
    const at = (gap: number, position: "start" | "end") => placementForGap({ layout, paragraphs: PARAGRAPHS, readingRevisionId: R, figureId: "x", gap, position });
    expect(at(1, "end")).toEqual({ displayMs: 0, anchor: { revisionId: R, segmentId: "s2", side: "after" }, sortKey: 5 });
    expect(at(1, "start")?.sortKey).toBe(3);
    expect(at(3, "end")).toEqual({ displayMs: 9000, anchor: { revisionId: R, segmentId: "s5", side: "after" }, sortKey: 0 });
    expect(at(-1, "end")).toBeUndefined();
    expect(at(PARAGRAPHS.length + 1, "end")).toBeUndefined();
  });
});

describe("the time fallback of a figure above the first paragraph", () => {
  // Every revision the figure may be read against: one whose first sentence starts at 0, one later.
  const AT_ZERO = PARAGRAPHS;
  const LATER: PlacementParagraph[] = [{ segments: [{ id: "l1", startMs: 700 }] }, { segments: [{ id: "l2", startMs: 4000 }] }];

  it("stays above the first paragraph by time alone, also when the first sentence starts at 0", () => {
    for (const paragraphs of [AT_ZERO, LATER]) {
      const empty = placeFigures({ readingRevisionId: R, paragraphs, figures: [] });
      const top = placementForGap({ layout: empty, paragraphs, readingRevisionId: R, figureId: "f", gap: 0, position: "end" });
      expect(top?.displayMs).toBe(paragraphs[0]?.segments[0]?.startMs);
      // Read against a revision that cannot follow the anchor (another version, the anchor's revision deleted).
      const elsewhere = placeFigures({ readingRevisionId: "other", paragraphs, figures: [fig({ id: "f", ...top })] });
      expect([gapOf(elsewhere, "f"), elsewhere.placed[0]?.via]).toEqual([0, "time"]);
    }
  });

  it("falls back ahead of a sentence starting at its time with a before anchor, after it otherwise", () => {
    const before = fig({ id: "before", displayMs: 5000, anchor: { revisionId: "gone", segmentId: "x", side: "before" } });
    const after = fig({ id: "after", displayMs: 5000, anchor: { revisionId: "gone", segmentId: "x", side: "after" } });
    const timed = fig({ id: "timed", displayMs: 5000 });
    const { at } = gaps([before, after, timed]);
    expect([at("before"), at("after"), at("timed")]).toEqual([1, 2, 2]);
  });
});
