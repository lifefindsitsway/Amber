import type { FigureDto, FigurePlacement } from "../../../shared/dto/figure.ts";
import { moveByParagraph, placeAfterSentence, placeFigures, type FigureLayout, type PlaceableFigure, type PlacementParagraph, type SentenceMapper } from "../../../shared/figure-placement.ts";
import type { FigureInsertTarget } from "./figure-context.ts";
import { PARAGRAPH_GAP_EM, TURN_GAP_EM } from "./reader-sentences.tsx";
import type { FilteredRow } from "./speaker-filter.ts";

/**
 * Figures in the reading view. The text rows (chapters, paragraphs, filter gaps) stay what
 * selections, copying and notes read; figure rows only join them on screen, between paragraphs.
 */

/** List keys of figure rows start with this; no text row key does (those are sentence ids, `chapter:` and `gap:`). */
const FIGURE_KEY_PREFIX = "figure:";

/** Set on the list's wrapper of a figure row: the selection, the scroll anchors and the drop targets tell it from text rows by it. */
export const FIGURE_ROW_ATTRIBUTE = "data-figure-row";

export const figureRowKey = (figureId: string): string => `${FIGURE_KEY_PREFIX}${figureId}`;

/** A figure as the reader places it: the placement fields, the figure, and whether it was just deleted here. */
export interface ReaderFigure extends PlaceableFigure {
  dto: FigureDto;
  /** Deleted in this view: it keeps its place, shown as 「已删除 · 撤销」 until the page is left. */
  deleted: boolean;
}

export function readerFigure(dto: FigureDto, deleted = false): ReaderFigure {
  return { id: dto.id, createdAt: dto.createdAt, displayMs: dto.placement.displayMs, anchor: dto.placement.anchor, sortKey: dto.placement.sortKey, dto, deleted };
}

/** A figure on screen. `turn` when it stands inside a speaker turn, whose line runs on through it. */
export interface FigureRow {
  kind: "figure";
  figure: FigureDto;
  deleted: boolean;
  /** Its gap: before paragraph `gap` of the whole text. */
  gap: number;
  turn?: { key: string; speakerId?: string };
  /** The space after it, in em: a paragraph's, or a turn's where the next row opens a turn. */
  spaceAfterEm: number;
}

/** A row of the list: a text row or a figure. */
export type ReaderRow = FilteredRow | FigureRow;

/** The list key of a row; text rows keep theirs. */
export function readerRowKey(row: ReaderRow, textKey: (row: FilteredRow) => string): string {
  return row.kind === "figure" ? figureRowKey(row.figure.id) : textKey(row);
}

/** Places the figures for the revision being read, against the paragraphs of the whole text (never the filtered ones). */
export function layoutReaderFigures(input: {
  revisionId: string;
  paragraphs: readonly PlacementParagraph[];
  figures: readonly ReaderFigure[];
  mapSentence?: SentenceMapper;
}): FigureLayout<ReaderFigure> {
  return placeFigures({ readingRevisionId: input.revisionId, paragraphs: input.paragraphs, figures: input.figures, ...(input.mapSentence === undefined ? {} : { mapSentence: input.mapSentence }) });
}

/** The rows on screen with the figures among them. */
export interface RowsWithFigures {
  rows: ReaderRow[];
  /** For each text row (index into the shown text rows), its index among `rows`. */
  displayIndex: number[];
  /** Figures the shown rows have no place for: the 「只看」 filter hides the paragraph they stand by. */
  hidden: ReadonlySet<string>;
}

/**
 * Puts the placed figures among the shown text rows. A figure of gap `k > 0` follows the row
 * holding the last shown sentence of paragraph `k - 1`, ahead of any chapter heading or filter
 * gap after it; gap 0 leads into the row holding the first shown sentence of the first
 * paragraph. With the speaker filter on, a figure whose paragraph shows no sentence is hidden.
 */
export function rowsWithFigures(shown: readonly FilteredRow[], paragraphs: readonly PlacementParagraph[], layout: FigureLayout<ReaderFigure>): RowsWithFigures {
  const rowOf = new Map<string, number>();
  shown.forEach((row, index) => {
    if (row.kind === "paragraph") for (const segment of row.paragraph.segments) rowOf.set(segment.id, index);
  });
  // The row each gap stands by, and whether its figures lead into that row (gap 0) or follow it.
  const hosts = new Map<number, { row: number; lead: boolean } | undefined>();
  const hostOf = (gap: number): { row: number; lead: boolean } | undefined => {
    if (hosts.has(gap)) return hosts.get(gap);
    let host: { row: number; lead: boolean } | undefined;
    if (gap === 0) {
      const row = paragraphs[0]?.segments.map((segment) => rowOf.get(segment.id)).find((index) => index !== undefined);
      host = row === undefined ? undefined : { row, lead: true };
    } else {
      let row: number | undefined;
      for (const segment of paragraphs[gap - 1]?.segments ?? []) row = rowOf.get(segment.id) ?? row;
      host = row === undefined ? undefined : { row, lead: false };
    }
    hosts.set(gap, host);
    return host;
  };
  const before = new Map<number, Array<{ figure: ReaderFigure; gap: number }>>();
  const after = new Map<number, Array<{ figure: ReaderFigure; gap: number }>>();
  const hidden = new Set<string>();
  // `placed` is ordered by gap and then within the gap, which is the order on screen.
  for (const entry of layout.placed) {
    const host = hostOf(entry.gap);
    if (host === undefined) {
      hidden.add(entry.figure.id);
      continue;
    }
    const into = host.lead ? before : after;
    into.set(host.row, [...(into.get(host.row) ?? []), { figure: entry.figure, gap: entry.gap }]);
  }
  const rows: ReaderRow[] = [];
  const displayIndex: number[] = [];
  shown.forEach((row, index) => {
    const turnOpens = row.kind === "paragraph" && row.turn !== undefined;
    pushFigures(rows, before.get(index), undefined, turnOpens ? TURN_GAP_EM : PARAGRAPH_GAP_EM);
    displayIndex.push(rows.length);
    rows.push(row);
    const following = after.get(index);
    if (following === undefined) return;
    // Inside a turn when the paragraph above goes on with the same speaker below.
    const inside = row.kind === "paragraph" && row.turn !== undefined && !row.turn.last ? row.turn : undefined;
    const endsTurn = row.kind === "paragraph" && row.turn?.last === true;
    pushFigures(rows, following, inside === undefined ? undefined : { key: inside.key, ...(inside.speakerId === undefined ? {} : { speakerId: inside.speakerId }) }, endsTurn ? TURN_GAP_EM : PARAGRAPH_GAP_EM);
  });
  return { rows, displayIndex, hidden };
}

function pushFigures(rows: ReaderRow[], figures: ReadonlyArray<{ figure: ReaderFigure; gap: number }> | undefined, turn: FigureRow["turn"], lastSpaceEm: number): void {
  if (figures === undefined) return;
  figures.forEach(({ figure, gap }, index) => {
    rows.push({
      kind: "figure",
      figure: figure.dto,
      deleted: figure.deleted,
      gap,
      ...(turn === undefined ? {} : { turn }),
      // Figures in one gap stand a paragraph's space apart; the last one keeps the space the text had there.
      spaceAfterEm: index === figures.length - 1 ? lastSpaceEm : PARAGRAPH_GAP_EM,
    });
  });
}

/** The sentence an upload or paste goes after: the selection's, else the one being followed, else the first one in view. */
export function captureSentence(candidates: { selected?: string | undefined; following?: string | undefined; firstVisible?: string | undefined }, known: (segmentId: string) => boolean): string | undefined {
  for (const id of [candidates.selected, candidates.following, candidates.firstVisible]) {
    if (id !== undefined && known(id)) return id;
  }
  return undefined;
}

function targetOf(revisionId: string, placement: FigurePlacement | undefined): FigureInsertTarget | undefined {
  const anchor = placement?.anchor;
  if (placement === undefined || anchor === null || anchor === undefined) return undefined;
  return { revisionId, segmentId: anchor.segmentId, side: anchor.side, placement };
}

/** Where a new figure goes when it is put after the paragraph of `segmentId`: last in that gap, anchored to the sentence. */
export function targetAfterSentence(input: { layout: FigureLayout<PlaceableFigure>; paragraphs: readonly PlacementParagraph[]; revisionId: string; segmentId: string }): FigureInsertTarget | undefined {
  return targetOf(input.revisionId, placeAfterSentence({ layout: input.layout, paragraphs: input.paragraphs, readingRevisionId: input.revisionId, segmentId: input.segmentId }));
}

/**
 * Where a frame captured at `atMs` goes: after the paragraph of the last sentence, in reading
 * order, that starts no later than `atMs` (before the first paragraph when none does). Its
 * display time is the capture time, so where the anchor cannot be followed (another revision)
 * it falls back to the same place by time.
 */
export function targetForTime(input: { layout: FigureLayout<PlaceableFigure>; paragraphs: readonly PlacementParagraph[]; revisionId: string; atMs: number }): FigureInsertTarget | undefined {
  let sentence: string | undefined;
  for (const paragraph of input.paragraphs) for (const segment of paragraph.segments) if (segment.startMs <= input.atMs) sentence = segment.id;
  if (sentence === undefined) {
    const first = input.paragraphs[0]?.segments[0];
    if (first === undefined) return undefined;
    const keys = (input.layout.byGap.get(0) ?? []).map((figure) => figure.sortKey);
    const placement: FigurePlacement = {
      displayMs: input.atMs,
      anchor: { revisionId: input.revisionId, segmentId: first.id, side: "before" },
      sortKey: keys.length === 0 ? 0 : Math.max(...keys) + 1,
    };
    return targetOf(input.revisionId, placement);
  }
  const target = targetAfterSentence({ layout: input.layout, paragraphs: input.paragraphs, revisionId: input.revisionId, segmentId: sentence });
  return target === undefined ? undefined : { ...target, placement: { ...target.placement, displayMs: input.atMs } };
}

/** The placement that moves a figure one paragraph up or down; `undefined` at either end. */
export function placementMovedBy(input: { layout: FigureLayout<PlaceableFigure>; paragraphs: readonly PlacementParagraph[]; revisionId: string; figureId: string; direction: "up" | "down" }): FigurePlacement | undefined {
  return moveByParagraph({ layout: input.layout, paragraphs: input.paragraphs, readingRevisionId: input.revisionId, figureId: input.figureId, direction: input.direction });
}


/**
 * 「回到截图时刻」: placed by its capture time again, with no anchor, so every revision places
 * it by that time; last among the figures already in that gap. `undefined` for an upload.
 */
export function placementAtCapture(input: { layout: FigureLayout<PlaceableFigure>; paragraphs: readonly PlacementParagraph[]; revisionId: string; figure: FigureDto }): FigurePlacement | undefined {
  const at = input.figure.capturedAtMs;
  if (at === undefined) return undefined;
  const probe = placeFigures({ readingRevisionId: input.revisionId, paragraphs: input.paragraphs, figures: [{ id: input.figure.id, createdAt: 0, displayMs: at, anchor: null, sortKey: 0 }] });
  const gap = probe.placed[0]?.gap ?? 0;
  const keys = (input.layout.byGap.get(gap) ?? []).filter((figure) => figure.id !== input.figure.id).map((figure) => figure.sortKey);
  return { displayMs: at, anchor: null, sortKey: keys.length === 0 ? 0 : Math.max(...keys) + 1 };
}

/** Whether two placements put a figure in the same place: moving it from one to the other would change nothing. */
export function samePlacement(a: FigurePlacement, b: FigurePlacement): boolean {
  if (a.displayMs !== b.displayMs || a.sortKey !== b.sortKey) return false;
  const x = a.anchor ?? null;
  const y = b.anchor ?? null;
  if (x === null || y === null) return x === y;
  return x.revisionId === y.revisionId && x.segmentId === y.segmentId && x.side === y.side;
}

/** What the reader's row height estimate reads: the reading column and its type. */
export interface RowMetrics {
  /** Width of the text inside the reading column, in px. */
  textPx: number;
  fontPx: number;
  lineHeight: number;
  /** Space a turn header takes above a turn's first paragraph, in px; 0 without turns. */
  turnHeaderPx: number;
}

/** Glyph width in em, roughly: CJK and full-width forms take a whole em, the rest about half. */
function textEm(text: string): number {
  let em = 0;
  for (const char of text) em += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.55;
  return em;
}

/** Caption type relative to the reading size, and its line height. */
export const CAPTION_SIZE_EM = 0.875;
const CAPTION_LINE = 1.5;
/** The capture time's line under a frame, in em of the reading size. */
const TIME_LINE_EM = 1.75;
/** Space between the image and what follows it, in em. */
export const FIGURE_INNER_GAP_EM = 0.5;

/**
 * A row's height before it is measured, so a long text's scrollbar and jumps start close to
 * the truth: figures from their width and aspect ratio (the frame reserves exactly that),
 * paragraphs from their text's length at the column width. Measured sizes replace these.
 */
export function estimateRowPx(row: ReaderRow, metrics: RowMetrics): number {
  const linePx = metrics.fontPx * metrics.lineHeight;
  const textPx = Math.max(1, metrics.textPx);
  switch (row.kind) {
    case "chapter":
      return Math.round(metrics.fontPx * 3.5);
    case "gap":
      return 40;
    case "paragraph": {
      const em = row.paragraph.segments.reduce((total, segment) => total + textEm(segment.text), 0) + 4;
      const lines = Math.max(1, Math.ceil((em * metrics.fontPx) / textPx));
      const header = row.turn?.first === true ? metrics.turnHeaderPx : 0;
      const space = (row.turn?.last === true ? TURN_GAP_EM : PARAGRAPH_GAP_EM) * metrics.fontPx;
      return Math.round(header + lines * linePx + space);
    }
    case "figure": {
      if (row.deleted) return Math.round(linePx + row.spaceAfterEm * metrics.fontPx);
      const width = textPx * row.figure.widthRatio;
      const image = (width * row.figure.image.height) / row.figure.image.width;
      const captionPx = metrics.fontPx * CAPTION_SIZE_EM;
      const caption = row.figure.caption === undefined ? 0 : FIGURE_INNER_GAP_EM * metrics.fontPx + Math.max(1, Math.ceil((textEm(row.figure.caption) * captionPx) / Math.max(1, width))) * captionPx * CAPTION_LINE;
      const time = row.figure.capturedAtMs === undefined ? 0 : TIME_LINE_EM * metrics.fontPx;
      return Math.round(image + caption + time + row.spaceAfterEm * metrics.fontPx);
    }
  }
}

/** A field shown before the server confirmed it, with the number of the request that set it. */
interface Pending<T> {
  value: T;
  seq: number;
}

/** The changes of one figure shown ahead of the server. */
export interface FigureOverride {
  placement?: Pending<FigurePlacement>;
  widthRatio?: Pending<number>;
}
export type FigureOverrides = ReadonlyMap<string, FigureOverride>;

/** The figure as shown: the server's, with the changes still on their way. */
export function withOverride(dto: FigureDto, override: FigureOverride | undefined): FigureDto {
  if (override === undefined) return dto;
  return { ...dto, ...(override.placement === undefined ? {} : { placement: override.placement.value }), ...(override.widthRatio === undefined ? {} : { widthRatio: override.widthRatio.value }) };
}

/** Shows `value` for the figure's field ahead of request `seq`. */
export function setOverride<K extends keyof FigureOverride>(overrides: FigureOverrides, figureId: string, field: K, value: NonNullable<FigureOverride[K]>["value"], seq: number): FigureOverrides {
  const next = new Map(overrides);
  next.set(figureId, { ...overrides.get(figureId), [field]: { value, seq } });
  return next;
}

/**
 * Request `seq` has been answered: its field goes back to the server's value, unless a later
 * request set the field again meanwhile (then that one's answer clears it).
 */
export function clearOverride(overrides: FigureOverrides, figureId: string, field: keyof FigureOverride, seq: number): FigureOverrides {
  const current = overrides.get(figureId);
  if (current?.[field]?.seq !== seq) return overrides;
  const rest: FigureOverride = { ...current };
  delete rest[field];
  const next = new Map(overrides);
  if (rest.placement === undefined && rest.widthRatio === undefined) next.delete(figureId);
  else next.set(figureId, rest);
  return next;
}

/**
 * The figures to place while some anchors' mappings to the revision being read are on their way
 * (`waiting`, by `revisionId segmentId`). A figure placed before in this same revision keeps that
 * place until its mapping is in, so a change made elsewhere does not make it vanish and come back
 * (the text around it jumping twice); one never placed here waits unshown.
 */
export function keepWhileMapping(
  figures: readonly ReaderFigure[],
  waiting: ReadonlySet<string>,
  previous: { revisionId: string; figures: ReadonlyMap<string, ReaderFigure> },
  revisionId: string,
): ReaderFigure[] {
  const kept: ReaderFigure[] = [];
  for (const figure of figures) {
    const anchor = figure.anchor;
    if (anchor === null || anchor === undefined || !waiting.has(`${anchor.revisionId} ${anchor.segmentId}`)) {
      kept.push(figure);
      continue;
    }
    const before = previous.revisionId === revisionId ? previous.figures.get(figure.id) : undefined;
    if (before !== undefined) kept.push({ ...figure, displayMs: before.displayMs, anchor: before.anchor, sortKey: before.sortKey });
  }
  return kept;
}

/** The gap a placement puts a figure in, read against the revision being read. */
export function gapOfPlacement(paragraphs: readonly PlacementParagraph[], revisionId: string, figureId: string, placement: FigurePlacement): number {
  const layout = placeFigures({ readingRevisionId: revisionId, paragraphs, figures: [{ id: figureId, createdAt: 0, ...placement }] });
  return layout.placed[0]?.gap ?? 0;
}

/**
 * What a figure reveal does next: scroll to the figure once it is a row; clear the speaker filter
 * that hides it; give up when the list is read and the figure is not in it after `waitMs` (a
 * just-created figure may take that long to arrive); else look again after `retryInMs`, or not
 * on a timer at all (`retryInMs` absent) while the list is still being read: its arrival runs
 * the check again.
 */
export type RevealStep = { kind: "scroll" } | { kind: "clearFilter" } | { kind: "giveUp"; known: boolean } | { kind: "wait"; retryInMs?: number };

export function revealStep(input: { inRows: boolean; hidden: boolean; known: boolean; fetched: boolean; waitedMs: number; waitMs: number }): RevealStep {
  if (input.inRows) return { kind: "scroll" };
  if (input.hidden) return { kind: "clearFilter" };
  if (!input.fetched) return { kind: "wait" };
  if (input.waitedMs >= input.waitMs) return { kind: "giveUp", known: input.known };
  return { kind: "wait", retryInMs: input.waitMs - input.waitedMs };
}
