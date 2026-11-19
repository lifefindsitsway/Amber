import type { FigureAnchor, FigurePlacement } from "./dto/figure.ts";

/**
 * Where figures fall in a reading of a transcript. The reading view and the figure export both
 * place figures with these functions, so a figure stands between the same paragraphs on screen
 * and in an exported file.
 *
 * Figures only ever stand between paragraphs. Gap `k` is the space before paragraph `k`: gap 0
 * is above the first paragraph, gap `paragraphs.length` below the last one.
 */

/** A sentence as placement needs it: its id and start. */
export interface PlacementSentence {
  id: string;
  startMs: number;
}

/**
 * A paragraph in reading order. The reading view's paragraphs (`{ segments }` of transcript
 * segments) fit as they are; a streaming exporter records each paragraph's sentence ids and
 * starts while it builds them.
 */
export interface PlacementParagraph {
  segments: readonly PlacementSentence[];
}

/**
 * The fields placement reads. A stored figure fits as it is; a figure DTO is spread from its
 * `placement` with its `id` and `createdAt`. Extra fields ride along untouched.
 */
export interface PlaceableFigure {
  id: string;
  createdAt: number;
  displayMs: number;
  anchor?: FigureAnchor | null | undefined;
  sortKey: number;
}

/**
 * Maps a sentence of another revision of the same Content to the sentence of the revision
 * being read, or `undefined` when there is no such sentence (the caller's segment map).
 */
export type SentenceMapper = (fromRevisionId: string, segmentId: string) => string | undefined;

/** How a figure found its gap: its own anchor, its anchor mapped from another revision, or its time. */
export type PlacementVia = "anchor" | "mapped" | "time";

export interface PlacedFigure<F extends PlaceableFigure> {
  figure: F;
  gap: number;
  /** Position within the gap, from 0. */
  order: number;
  via: PlacementVia;
}

export interface FigureLayout<F extends PlaceableFigure> {
  /** Every figure, by gap and then by order. */
  placed: ReadonlyArray<PlacedFigure<F>>;
  /** The figures of each non-empty gap, in order. */
  byGap: ReadonlyMap<number, readonly F[]>;
  /** Number of paragraphs the layout was made for. */
  paragraphCount: number;
}

interface SentenceIndex {
  paragraphOf: ReadonlyMap<string, number>;
}

function indexSentences(paragraphs: readonly PlacementParagraph[]): SentenceIndex {
  const paragraphOf = new Map<string, number>();
  paragraphs.forEach((paragraph, index) => {
    for (const sentence of paragraph.segments) paragraphOf.set(sentence.id, index);
  });
  return { paragraphOf };
}

/**
 * The gap a time falls in, for a figure whose anchor cannot be followed. Reading order, never
 * the earliest match: sentences of different paragraphs may share a start time.
 *
 * - No anchor, or an `after` anchor: after the paragraph of the last sentence that starts no
 *   later than `displayMs` (a frame captured at a sentence's very start belongs after it).
 * - A `before` anchor: after the paragraph of the last sentence that starts strictly earlier,
 *   that is, ahead of the first sentence starting at `displayMs` or later. A figure put above
 *   the first paragraph keeps the first sentence's start as its time, and so falls back above
 *   it in every revision, also when that sentence starts at 0, where no earlier time exists.
 *
 * Before every sentence → gap 0.
 */
function gapForTime(paragraphs: readonly PlacementParagraph[], displayMs: number, side: FigureAnchor["side"] | undefined): number {
  const reached = side === "before" ? (startMs: number) => startMs < displayMs : (startMs: number) => startMs <= displayMs;
  let gap = 0;
  paragraphs.forEach((paragraph, index) => {
    for (const sentence of paragraph.segments) {
      if (reached(sentence.startMs)) gap = index + 1;
    }
  });
  return gap;
}

/** Within a gap: after-anchored figures follow the paragraph above, before-anchored ones lead into the one below, timed ones sit between. */
function sideRank(figure: PlaceableFigure, via: PlacementVia): number {
  if (via === "time" || figure.anchor === undefined || figure.anchor === null) return 1;
  return figure.anchor.side === "after" ? 0 : 2;
}

/**
 * Places every figure for one reading. An anchor on the revision being read wins; an anchor
 * on another revision is mapped to this one; a figure with neither (or whose sentence is not
 * shown, e.g. filtered out or its revision deleted) falls back to its display time. The order
 * inside a gap is fully determined: sort key, side, display time, creation, id.
 */
export function placeFigures<F extends PlaceableFigure>(input: {
  readingRevisionId: string;
  paragraphs: readonly PlacementParagraph[];
  figures: readonly F[];
  mapSentence?: SentenceMapper;
}): FigureLayout<F> {
  const { paragraphs, readingRevisionId, mapSentence } = input;
  const { paragraphOf } = indexSentences(paragraphs);
  const located = input.figures.map((figure) => {
    const anchor = figure.anchor ?? undefined;
    if (paragraphs.length === 0) return { figure, gap: 0, via: "time" as PlacementVia };
    if (anchor !== undefined) {
      const local = anchor.revisionId === readingRevisionId ? anchor.segmentId : mapSentence?.(anchor.revisionId, anchor.segmentId);
      const paragraph = local === undefined ? undefined : paragraphOf.get(local);
      if (paragraph !== undefined) {
        const via: PlacementVia = anchor.revisionId === readingRevisionId ? "anchor" : "mapped";
        return { figure, gap: anchor.side === "before" ? paragraph : paragraph + 1, via };
      }
    }
    return { figure, gap: gapForTime(paragraphs, figure.displayMs, anchor?.side), via: "time" as PlacementVia };
  });
  located.sort(
    (a, b) =>
      a.gap - b.gap ||
      a.figure.sortKey - b.figure.sortKey ||
      sideRank(a.figure, a.via) - sideRank(b.figure, b.via) ||
      a.figure.displayMs - b.figure.displayMs ||
      a.figure.createdAt - b.figure.createdAt ||
      (a.figure.id < b.figure.id ? -1 : a.figure.id > b.figure.id ? 1 : 0),
  );
  const byGap = new Map<number, F[]>();
  const placed: Array<PlacedFigure<F>> = [];
  for (const entry of located) {
    const list = byGap.get(entry.gap) ?? [];
    placed.push({ figure: entry.figure, gap: entry.gap, order: list.length, via: entry.via });
    list.push(entry.figure);
    byGap.set(entry.gap, list);
  }
  return { placed, byGap, paragraphCount: paragraphs.length };
}

/** The gap a figure was placed in, or `undefined` when the layout does not hold it. */
export function gapOf(layout: FigureLayout<PlaceableFigure>, figureId: string): number | undefined {
  return layout.placed.find((entry) => entry.figure.id === figureId)?.gap;
}

function sortKeyAtEnd(layout: FigureLayout<PlaceableFigure>, gap: number, exclude: string): number {
  const keys = (layout.byGap.get(gap) ?? []).filter((figure) => figure.id !== exclude).map((figure) => figure.sortKey);
  return keys.length === 0 ? 0 : Math.max(...keys) + 1;
}

function sortKeyAtStart(layout: FigureLayout<PlaceableFigure>, gap: number, exclude: string): number {
  const keys = (layout.byGap.get(gap) ?? []).filter((figure) => figure.id !== exclude).map((figure) => figure.sortKey);
  return keys.length === 0 ? 0 : Math.min(...keys) - 1;
}

/**
 * The placement that puts a figure into `gap` (a move or a drop), anchored to the revision being
 * read so it stays there after a reload: after the last sentence of the paragraph above, or for
 * gap 0 before the first sentence. `position` puts it first or last among the figures already
 * there (the figure itself excluded). Its time is chosen so the time fallback (another revision,
 * or this one deleted) lands in the same gap: the start of the paragraph above, or for gap 0
 * the first sentence's own start, which a `before` anchor falls back ahead of. `undefined` for
 * a gap the paragraphs do not have.
 */
export function placementForGap(input: {
  layout: FigureLayout<PlaceableFigure>;
  paragraphs: readonly PlacementParagraph[];
  readingRevisionId: string;
  figureId: string;
  gap: number;
  position: "start" | "end";
}): FigurePlacement | undefined {
  const { layout, paragraphs, readingRevisionId, figureId, gap } = input;
  const sortKey = input.position === "end" ? sortKeyAtEnd : sortKeyAtStart;
  if (gap < 0 || gap > paragraphs.length) return undefined;
  if (gap === 0) {
    const first = paragraphs[0]?.segments[0];
    if (first === undefined) return undefined;
    return { displayMs: first.startMs, anchor: { revisionId: readingRevisionId, segmentId: first.id, side: "before" }, sortKey: sortKey(layout, 0, figureId) };
  }
  const above = paragraphs[gap - 1];
  const last = above?.segments.at(-1);
  const head = above?.segments[0];
  if (last === undefined || head === undefined) return undefined;
  return { displayMs: head.startMs, anchor: { revisionId: readingRevisionId, segmentId: last.id, side: "after" }, sortKey: sortKey(layout, gap, figureId) };
}

/**
 * Moves a figure one paragraph up or down. Moving up lands at the end of the gap above, moving
 * down at the start of the gap below, so repeated moves walk the figure past every paragraph
 * one at a time. `undefined` at the top or bottom, or when the figure is not in the layout.
 */
export function moveByParagraph(input: {
  layout: FigureLayout<PlaceableFigure>;
  paragraphs: readonly PlacementParagraph[];
  readingRevisionId: string;
  figureId: string;
  direction: "up" | "down";
}): FigurePlacement | undefined {
  const current = gapOf(input.layout, input.figureId);
  if (current === undefined) return undefined;
  const target = input.direction === "up" ? current - 1 : current + 1;
  if (target < 0 || target > input.paragraphs.length) return undefined;
  return placementForGap({ layout: input.layout, paragraphs: input.paragraphs, readingRevisionId: input.readingRevisionId, figureId: input.figureId, gap: target, position: input.direction === "up" ? "end" : "start" });
}

/**
 * Puts a figure after the paragraph holding `segmentId` (moving it to the playback position,
 * or placing a new upload after the target paragraph), last in that gap. The anchor is that
 * very sentence, so the figure keeps following it if the paragraphs are cut differently later.
 * `undefined` when the sentence is not in the reading.
 */
export function placeAfterSentence(input: {
  layout: FigureLayout<PlaceableFigure>;
  paragraphs: readonly PlacementParagraph[];
  readingRevisionId: string;
  segmentId: string;
  /** The figure being moved, excluded from the sort key; absent for a new one. */
  figureId?: string;
}): FigurePlacement | undefined {
  const { paragraphOf } = indexSentences(input.paragraphs);
  const paragraph = paragraphOf.get(input.segmentId);
  if (paragraph === undefined) return undefined;
  const sentence = input.paragraphs[paragraph]?.segments.find((candidate) => candidate.id === input.segmentId);
  if (sentence === undefined) return undefined;
  return {
    displayMs: sentence.startMs,
    anchor: { revisionId: input.readingRevisionId, segmentId: input.segmentId, side: "after" },
    sortKey: sortKeyAtEnd(input.layout, paragraph + 1, input.figureId ?? ""),
  };
}
