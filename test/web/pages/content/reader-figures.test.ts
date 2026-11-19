import { describe, expect, it } from "vitest";
import { placementForGap } from "../../../../src/shared/figure-placement.ts";
import { FIGURE_WIDTH_DEFAULT } from "../../../../src/shared/defaults.ts";
import type { FigureDto, FigurePlacement } from "../../../../src/shared/dto/figure.ts";
import type { Paragraph } from "../../../../src/web/pages/content/content-data.ts";
import {
  captureSentence,
  clearOverride,
  estimateRowPx,
  gapOfPlacement,
  keepWhileMapping,
  revealStep,
  setOverride,
  withOverride,
  figureRowKey,
  layoutReaderFigures,
  placementAtCapture,
  placementMovedBy,
  readerFigure,
  readerRowKey,
  rowsWithFigures,
  samePlacement,
  targetAfterSentence,
  targetForTime,
  type FigureRow,
  type ReaderRow,
} from "../../../../src/web/pages/content/reader-figures.ts";
import { readerSections, viewRowKey, viewRows } from "../../../../src/web/pages/content/reader-rows.ts";
import { filteredRowKey, filteredViewRows, type FilteredRow } from "../../../../src/web/pages/content/speaker-filter.ts";
import { SPEAKER_SEGMENTS } from "../../../fixtures/web/reader-speakers.tsx";

const REVISION = "r1";
const chapters = [
  { startMs: 0, endMs: 60_000, title: "开场" },
  { startMs: 60_000, endMs: 600_000, title: "正文" },
];
// Paragraphs of the whole text: g1+g2 | g3 | g4 | g5 | g6 | g7, with 「正文」 before g7.
const rows = viewRows(readerSections(SPEAKER_SEGMENTS, chapters), { turns: true });
const paragraphs = rows.flatMap((row): Paragraph[] => (row.kind === "paragraph" ? [row.paragraph] : []));
const textKey = (row: FilteredRow): string => filteredRowKey(row, viewRowKey);

let next = 0;
function figure(placement: Partial<FigurePlacement> & { displayMs: number }, overrides: Partial<FigureDto> = {}): FigureDto {
  next += 1;
  return {
    id: `f${next}`,
    contentId: "c1",
    source: "capture",
    capturedAtMs: placement.displayMs,
    placement: { displayMs: placement.displayMs, anchor: placement.anchor ?? null, sortKey: placement.sortKey ?? 0 },
    widthRatio: FIGURE_WIDTH_DEFAULT,
    image: { width: 1600, height: 900, bytes: 1000, sha256: "a".repeat(64) },
    version: 1,
    createdAt: next,
    updatedAt: next,
    ...overrides,
  };
}

function layoutOf(dtos: readonly FigureDto[], deleted: ReadonlySet<string> = new Set()) {
  return layoutReaderFigures({ revisionId: REVISION, paragraphs, figures: dtos.map((dto) => readerFigure(dto, deleted.has(dto.id))) });
}

/** Rows as short labels: `#title`, the paragraph's sentence ids, `[figure id]`, `~gap`. */
function labels(list: readonly ReaderRow[]): string[] {
  return list.map((row) => {
    if (row.kind === "chapter") return `#${row.title}`;
    if (row.kind === "gap") return "~gap";
    if (row.kind === "figure") return `[${row.figure.id}${row.deleted ? " deleted" : ""}]`;
    return row.paragraph.segments.map((segment) => segment.id).join("+");
  });
}

describe("rowsWithFigures", () => {
  it("puts each figure after its paragraph, ahead of the next chapter heading, and gap 0 after the leading heading", () => {
    const first = figure({ displayMs: 0, anchor: { revisionId: REVISION, segmentId: "g1", side: "before" } });
    const afterG2 = figure({ displayMs: 4_000, anchor: { revisionId: REVISION, segmentId: "g2", side: "after" } });
    const beforeChapter = figure({ displayMs: 31_000 });
    const view = rowsWithFigures(rows, paragraphs, layoutOf([first, afterG2, beforeChapter]));
    expect(labels(view.rows)).toEqual(["#开场", `[${first.id}]`, "g1+g2", `[${afterG2.id}]`, "g3", "g4", "g5", "g6", `[${beforeChapter.id}]`, "#正文", "g7"]);
    expect(view.hidden.size).toBe(0);
    // Every text row keeps its index, mapped to where it now is among the rows.
    expect(view.displayIndex).toEqual([0, 2, 4, 5, 6, 7, 9, 10]);
    expect(view.displayIndex.map((index) => labels(view.rows)[index])).toEqual(["#开场", "g1+g2", "g3", "g4", "g5", "g6", "#正文", "g7"]);
  });

  it("orders figures in one gap and spaces them alike, the last keeping the turn's space", () => {
    const a = figure({ displayMs: 5_000, sortKey: 2 });
    const b = figure({ displayMs: 5_000, sortKey: 1 });
    const view = rowsWithFigures(rows, paragraphs, layoutOf([a, b]));
    const figures = view.rows.filter((row): row is FigureRow => row.kind === "figure");
    expect(figures.map((row) => row.figure.id)).toEqual([b.id, a.id]);
    expect(figures.map((row) => row.gap)).toEqual([1, 1]);
    // g1+g2 ends its turn: the space after the last figure is the turn's, between figures a paragraph's.
    expect(figures.map((row) => row.spaceAfterEm)).toEqual([0.75, 1]);
  });

  it("runs a turn on through a figure between two of its paragraphs, and not through one between turns", () => {
    const inside = figure({ displayMs: 10_000 });
    const between = figure({ displayMs: 15_000 + 9_000 });
    const view = rowsWithFigures(rows, paragraphs, layoutOf([inside, between]));
    const byId = new Map(view.rows.flatMap((row) => (row.kind === "figure" ? [[row.figure.id, row] as const] : [])));
    expect(byId.get(inside.id)?.turn).toEqual({ key: "g4", speakerId: "sp1" });
    expect(byId.get(between.id)?.turn).toBeUndefined();
  });

  it("keeps a figure's place when the speaker filter hides other text, and hides it with its paragraph", () => {
    const shown = filteredViewRows(SPEAKER_SEGMENTS, chapters, new Set(["sp1"]), { turns: true }).rows;
    const afterG4 = figure({ displayMs: 10_000 });
    const afterG3 = figure({ displayMs: 8_000 });
    const view = rowsWithFigures(shown, paragraphs, layoutOf([afterG4, afterG3]));
    expect(labels(view.rows).indexOf(`[${afterG4.id}]`)).toBe(labels(view.rows).indexOf("g4") + 1);
    expect(view.hidden).toEqual(new Set([afterG3.id]));
    expect(view.rows.some((row) => row.kind === "figure" && row.figure.id === afterG3.id)).toBe(false);
  });

  it("shows a figure deleted here in its place", () => {
    const gone = figure({ displayMs: 5_000 });
    const view = rowsWithFigures(rows, paragraphs, layoutOf([gone], new Set([gone.id])));
    expect(labels(view.rows)).toContain(`[${gone.id} deleted]`);
  });

  it("keys figure rows apart from every text row", () => {
    const dto = figure({ displayMs: 0 });
    const view = rowsWithFigures(rows, paragraphs, layoutOf([dto]));
    const keys = view.rows.map((row) => readerRowKey(row, textKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(figureRowKey(dto.id));
  });
});

describe("captureSentence", () => {
  const known = (id: string): boolean => ["g1", "g3", "g6"].includes(id);
  it("takes the selection's sentence first, then the one being followed, then the first in view", () => {
    expect(captureSentence({ selected: "g3", following: "g6", firstVisible: "g1" }, known)).toBe("g3");
    expect(captureSentence({ following: "g6", firstVisible: "g1" }, known)).toBe("g6");
    expect(captureSentence({ firstVisible: "g1" }, known)).toBe("g1");
    expect(captureSentence({}, known)).toBeUndefined();
  });
  it("passes over a candidate the revision does not have", () => {
    expect(captureSentence({ selected: "elsewhere", following: "g6" }, known)).toBe("g6");
  });
});

describe("insert targets", () => {
  it("puts a new figure after the paragraph of the sentence, last in that gap", () => {
    const there = figure({ displayMs: 9_000, sortKey: 4 });
    const target = targetAfterSentence({ layout: layoutOf([there]), paragraphs, revisionId: REVISION, segmentId: "g3" });
    expect(target).toEqual({ revisionId: REVISION, segmentId: "g3", side: "after", placement: { displayMs: 8_000, anchor: { revisionId: REVISION, segmentId: "g3", side: "after" }, sortKey: 5 } });
  });

  it("puts a frame after the paragraph holding its time, with the capture time as its time", () => {
    const target = targetForTime({ layout: layoutOf([]), paragraphs, revisionId: REVISION, atMs: 12_000 });
    expect(target?.segmentId).toBe("g4");
    expect(target?.placement.displayMs).toBe(12_000);
    expect(target?.side).toBe("after");
  });

  it("puts a frame before every sentence ahead of the first paragraph", () => {
    const late = SPEAKER_SEGMENTS.map((segment) => ({ ...segment, startMs: segment.startMs + 1_000 }));
    const lateParagraphs = viewRows(readerSections(late, []), { turns: false }).flatMap((row): Paragraph[] => (row.kind === "paragraph" ? [row.paragraph] : []));
    const target = targetForTime({ layout: layoutReaderFigures({ revisionId: REVISION, paragraphs: lateParagraphs, figures: [] }), paragraphs: lateParagraphs, revisionId: REVISION, atMs: 500 });
    expect(target).toMatchObject({ segmentId: "g1", side: "before", placement: { displayMs: 500 } });
  });
});

describe("moving placements", () => {
  it("moves a figure one paragraph at a time and stops at either end", () => {
    const dto = figure({ displayMs: 8_000 });
    const layout = layoutOf([dto]);
    const up = placementMovedBy({ layout, paragraphs, revisionId: REVISION, figureId: dto.id, direction: "up" });
    expect(up?.anchor).toEqual({ revisionId: REVISION, segmentId: "g2", side: "after" });
    const top = figure({ displayMs: 0, anchor: { revisionId: REVISION, segmentId: "g1", side: "before" } });
    expect(placementMovedBy({ layout: layoutOf([top]), paragraphs, revisionId: REVISION, figureId: top.id, direction: "up" })).toBeUndefined();
  });

  it("drops a figure last into any gap, gap 0 included, and its time falls back to the same gap", () => {
    const dto = figure({ displayMs: 30_000 });
    const other = figure({ displayMs: 0, anchor: { revisionId: REVISION, segmentId: "g1", side: "before" }, sortKey: 3 });
    const layout = layoutOf([dto, other]);
    const top = placementForGap({ layout, paragraphs, readingRevisionId: REVISION, figureId: dto.id, gap: 0, position: "end" });
    expect(top).toEqual({ displayMs: 0, anchor: { revisionId: REVISION, segmentId: "g1", side: "before" }, sortKey: 4 });
    const middle = placementForGap({ layout, paragraphs, readingRevisionId: REVISION, figureId: dto.id, gap: 3, position: "end" }) as FigurePlacement;
    expect(middle.anchor).toEqual({ revisionId: REVISION, segmentId: "g4", side: "after" });
    // Placed by time alone (another revision), it lands in the same gap.
    const byTime = layoutReaderFigures({ revisionId: "other", paragraphs, figures: [readerFigure({ ...dto, placement: { ...middle, anchor: null } })] });
    expect(byTime.placed[0]?.gap).toBe(3);
    expect(placementForGap({ layout, paragraphs, readingRevisionId: REVISION, figureId: dto.id, gap: paragraphs.length + 1, position: "end" })).toBeUndefined();
  });

  it("goes back to the capture time without an anchor, and only for a frame", () => {
    const moved = figure({ displayMs: 4_000, anchor: { revisionId: REVISION, segmentId: "g7", side: "after" } }, { capturedAtMs: 10_500 });
    const back = placementAtCapture({ layout: layoutOf([moved]), paragraphs, revisionId: REVISION, figure: moved });
    expect(back).toEqual({ displayMs: 10_500, anchor: null, sortKey: 0 });
    const upload = figure({ displayMs: 0 }, { source: "upload" });
    delete (upload as { capturedAtMs?: number }).capturedAtMs;
    expect(placementAtCapture({ layout: layoutOf([upload]), paragraphs, revisionId: REVISION, figure: upload })).toBeUndefined();
  });

  it("tells placements that say the same apart from those that do not", () => {
    const anchor = { revisionId: REVISION, segmentId: "g1", side: "after" as const };
    expect(samePlacement({ displayMs: 1, anchor, sortKey: 0 }, { displayMs: 1, anchor: { ...anchor }, sortKey: 0 })).toBe(true);
    expect(samePlacement({ displayMs: 1, anchor: null, sortKey: 0 }, { displayMs: 1, anchor: null, sortKey: 0 })).toBe(true);
    expect(samePlacement({ displayMs: 1, anchor, sortKey: 0 }, { displayMs: 1, anchor: null, sortKey: 0 })).toBe(false);
    expect(samePlacement({ displayMs: 1, anchor, sortKey: 0 }, { displayMs: 1, anchor: { ...anchor, side: "before" }, sortKey: 0 })).toBe(false);
  });
});

describe("estimateRowPx", () => {
  const metrics = { textPx: 600, fontPx: 16, lineHeight: 1.75, turnHeaderPx: 32 };
  it("reserves a figure's height from its width and aspect ratio, plus its time, caption and space", () => {
    const bare = { kind: "figure", figure: figure({ displayMs: 0 }, { source: "upload", widthRatio: 0.5 }), deleted: false, gap: 0, spaceAfterEm: 0.75 } as FigureRow;
    delete (bare.figure as { capturedAtMs?: number }).capturedAtMs;
    // 300 px wide at 16:9 is 168.75 px tall, then 12 px of space.
    expect(estimateRowPx(bare, metrics)).toBe(Math.round(168.75 + 12));
    const captured = { ...bare, figure: { ...bare.figure, capturedAtMs: 1_000 } };
    expect(estimateRowPx(captured, metrics)).toBeGreaterThan(estimateRowPx(bare, metrics));
    const captioned = { ...bare, figure: { ...bare.figure, caption: "很长的备注".repeat(40) } };
    expect(estimateRowPx(captioned, metrics)).toBeGreaterThan(estimateRowPx(bare, metrics) + 100);
    expect(estimateRowPx({ ...bare, deleted: true }, metrics)).toBeLessThan(60);
  });

  it("grows a paragraph's estimate with its text and its turn header", () => {
    const paragraphRows = rows.filter((row) => row.kind === "paragraph");
    const short = paragraphRows.find((row) => row.paragraph.segments[0]?.id === "g3") as FilteredRow;
    const long = paragraphRows.find((row) => row.paragraph.segments[0]?.id === "g5") as FilteredRow;
    expect(estimateRowPx(long, { ...metrics, textPx: 200 })).toBeGreaterThan(estimateRowPx(long, metrics));
    expect(estimateRowPx(short, metrics)).toBeGreaterThanOrEqual(32 + 28);
  });
});

describe("changes shown ahead of the server", () => {
  const base = figure({ displayMs: 0 });
  const moved = (segmentId: string): FigurePlacement => ({ displayMs: 0, anchor: { revisionId: REVISION, segmentId, side: "after" }, sortKey: 0 });

  it("keeps a second move on screen when the first one's answer comes back, and clears it with its own answer", () => {
    let overrides = setOverride(new Map(), base.id, "placement", moved("g3"), 1);
    overrides = setOverride(overrides, base.id, "placement", moved("g4"), 2);
    overrides = clearOverride(overrides, base.id, "placement", 1);
    expect(withOverride(base, overrides.get(base.id)).placement.anchor?.segmentId).toBe("g4");
    overrides = clearOverride(overrides, base.id, "placement", 2);
    expect(overrides.size).toBe(0);
    expect(withOverride(base, overrides.get(base.id))).toBe(base);
  });

  it("clears one field without touching the other", () => {
    let overrides = setOverride(new Map(), base.id, "placement", moved("g3"), 1);
    overrides = setOverride(overrides, base.id, "widthRatio", 0.4, 2);
    overrides = clearOverride(overrides, base.id, "widthRatio", 2);
    const shown = withOverride(base, overrides.get(base.id));
    expect([shown.widthRatio, shown.placement.anchor?.segmentId]).toEqual([base.widthRatio, "g3"]);
  });
});

describe("keepWhileMapping", () => {
  const elsewhere = { revisionId: "other", segmentId: "x1", side: "after" as const };
  const waiting = new Set(["other x1"]);

  it("keeps a figure where it stood in this revision while its new anchor's mapping is on its way", () => {
    const before = readerFigure(figure({ displayMs: 10_000, anchor: { revisionId: REVISION, segmentId: "g4", side: "after" } }));
    const now = readerFigure({ ...before.dto, placement: { displayMs: 70_000, anchor: elsewhere, sortKey: 3 }, version: 2 });
    const kept = keepWhileMapping([now], waiting, { revisionId: REVISION, figures: new Map([[before.id, before]]) }, REVISION);
    expect(kept).toHaveLength(1);
    expect([kept[0]?.anchor, kept[0]?.displayMs, kept[0]?.sortKey, kept[0]?.dto.version]).toEqual([before.anchor, 10_000, 0, 2]);
    // Laid out, it stays in its old gap: nothing jumps until the mapping is in.
    expect(layoutReaderFigures({ revisionId: REVISION, paragraphs, figures: kept }).placed[0]?.gap).toBe(3);
  });

  it("holds back a figure never placed here, and carries nothing over from another revision", () => {
    const now = readerFigure(figure({ displayMs: 0, anchor: elsewhere }));
    expect(keepWhileMapping([now], waiting, { revisionId: REVISION, figures: new Map() }, REVISION)).toEqual([]);
    expect(keepWhileMapping([now], waiting, { revisionId: "before", figures: new Map([[now.id, now]]) }, REVISION)).toEqual([]);
  });

  it("passes every figure through once nothing is waiting", () => {
    const now = readerFigure(figure({ displayMs: 0, anchor: elsewhere }));
    expect(keepWhileMapping([now], new Set(), { revisionId: REVISION, figures: new Map() }, REVISION)).toEqual([now]);
  });
});

describe("gapOfPlacement", () => {
  it("names the gap a placement lands in, for the move's read-out", () => {
    expect(gapOfPlacement(paragraphs, REVISION, "f", { displayMs: 0, anchor: { revisionId: REVISION, segmentId: "g4", side: "after" }, sortKey: 0 })).toBe(3);
    expect(gapOfPlacement(paragraphs, REVISION, "f", { displayMs: 0, anchor: { revisionId: REVISION, segmentId: "g1", side: "before" }, sortKey: 0 })).toBe(0);
  });
});

describe("revealStep", () => {
  const base = { inRows: false, hidden: false, known: false, fetched: true, waitedMs: 0, waitMs: 5000 };
  it("scrolls once the figure is a row, and clears the filter that hides it", () => {
    expect(revealStep({ ...base, inRows: true })).toEqual({ kind: "scroll" });
    expect(revealStep({ ...base, hidden: true })).toEqual({ kind: "clearFilter" });
  });
  it("looks again when the wait is over, never sooner and never in a tight loop", () => {
    expect(revealStep({ ...base, waitedMs: 1200 })).toEqual({ kind: "wait", retryInMs: 3800 });
    expect(revealStep({ ...base, waitedMs: 5000 })).toEqual({ kind: "giveUp", known: false });
    // Known but still not placeable when the wait is over (a mapping that never came): it gives up too.
    expect(revealStep({ ...base, known: true, waitedMs: 9000 })).toEqual({ kind: "giveUp", known: true });
  });
  it("waits without a timer while the list is still being read", () => {
    expect(revealStep({ ...base, fetched: false, waitedMs: 9000 })).toEqual({ kind: "wait" });
  });
});
