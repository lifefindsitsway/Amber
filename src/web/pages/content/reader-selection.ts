import { isMarked, readingSeparator } from "../../../shared/reading.ts";
import type { SentencePoint } from "../../ui/dom-selection.ts";
import type { TurnPlace } from "./reader-rows.ts";
import type { FilteredRow, GapRow } from "./speaker-filter.ts";

/**
 * Marks an element of a reader row whose text is one part of the row: a chapter title
 * (`title`), a turn's speaker name (`speaker`), a paragraph's time (`time`) or a gap bar's
 * label (`gap`). Sentences are the `[data-segment-id]` elements and carry no mark of their own.
 * The element's text is exactly the part's text, so an offset into one is an offset into the
 * other.
 */
export const READER_PART_ATTRIBUTE = "data-reader-part";

/** The kinds of text a reader row is made of, in the order a paragraph row shows them: speaker, time, sentences. */
export type ReaderPart = "title" | "speaker" | "time" | "gap" | "sentence";

/**
 * A place in the reading view that does not depend on which rows are mounted: a row (by its
 * list key), a part of it and a UTF-16 offset into that part's text.
 */
export interface ReaderPoint {
  rowKey: string;
  part: ReaderPart;
  /** The sentence, for `part: "sentence"`. */
  segmentId?: string;
  offset: number;
}

/** A sentence as the selection needs it. */
export interface SelectionSentence {
  id: string;
  text: string;
}

/**
 * A row of the reading view as text, in the order the rows are shown. A selection's text is
 * written from these, so rows the windowed list has unmounted still count.
 */
export type SelectionRow =
  | { key: string; kind: "chapter"; title: string }
  | { key: string; kind: "gap"; label: string }
  | {
      key: string;
      kind: "paragraph";
      /** The paragraph's time as shown. */
      time: string;
      sentences: readonly SelectionSentence[];
      /** Whether the revision carries semantic paragraph marks; decides the separator between sentences. */
      marked: boolean;
      /**
       * Present on the row that opens a speaker turn: the name its header shows. `named` is a
       * speaker the list knows; sentences nobody was assigned to show a plain label instead.
       */
      speaker?: { name: string; named: boolean };
    };

/** What the rows show beside their data: built by the view, which owns the wording. */
export interface SelectionRowLabels {
  speaker: (turn: TurnPlace) => { name: string; named: boolean };
  time: (startMs: number) => string;
  gap: (row: GapRow) => string;
}

/** What a selection between two points comes to. */
export interface ReaderSelectionRead {
  /** Index of the first and last row the selection touches. */
  firstRow: number;
  lastRow: number;
  /**
   * What "explain" takes, as one running line: sentences and chapter titles, without speaker
   * names and times. Empty when no title or sentence character is selected.
   */
  explainText: string;
  /** The selection in the format a browser copies it in, written from the rows; no leading or trailing whitespace. */
  copyText: string;
  /** Sentences the selection shares text with. */
  sentenceCount: number;
  /** The first and last of those sentences with the offsets the selection starts and ends at; absent without one. */
  bounds?: { start: SentencePoint; end: SentencePoint };
  /** Present when everything selected lies in one sentence: no second sentence, no title, no gap. */
  quote?: SelectionSentence;
  /** Whether a gap bar lies between the first and the last selected sentence: text the filter hides is in between. */
  crossesGap: boolean;
}

/** The rows of the reading view as selection rows; `keyOf` is the list's own row key. */
export function selectionRows(rows: readonly FilteredRow[], keyOf: (row: FilteredRow) => string, labels: SelectionRowLabels): SelectionRow[] {
  return rows.map((row): SelectionRow => {
    const key = keyOf(row);
    if (row.kind === "chapter") return { key, kind: "chapter", title: row.title };
    if (row.kind === "gap") return { key, kind: "gap", label: labels.gap(row) };
    const { paragraph, turn } = row;
    return {
      key,
      kind: "paragraph",
      time: labels.time(paragraph.startMs),
      sentences: paragraph.segments.map(({ id, text }) => ({ id, text })),
      marked: paragraph.segments.some(isMarked),
      ...(turn?.first === true ? { speaker: labels.speaker(turn) } : {}),
    };
  });
}

/** Whether two points are the same place. */
export function samePoint(a: ReaderPoint, b: ReaderPoint): boolean {
  return a.rowKey === b.rowKey && a.part === b.part && a.segmentId === b.segmentId && a.offset === b.offset;
}

/** Whether the rows still hold the point's row, part and sentence (the offset is not checked). */
export function hasPoint(rows: readonly SelectionRow[], point: ReaderPoint): boolean {
  const row = rows.find((candidate) => candidate.key === point.rowKey);
  return row !== undefined && partIndex(row, point) >= 0;
}

/**
 * Reads the selection between `anchor` and `focus` (in either order) out of the rows.
 * `skipped` is what stands for a gap bar in the explain text. Undefined when an end is not in
 * the rows.
 */
export function readSelection(rows: readonly SelectionRow[], anchor: ReaderPoint, focus: ReaderPoint, options: { skipped: string }): ReaderSelectionRead | undefined {
  let anchorRow = -1;
  let focusRow = -1;
  for (let index = 0; index < rows.length && (anchorRow < 0 || focusRow < 0); index += 1) {
    const key = (rows[index] as SelectionRow).key;
    if (anchorRow < 0 && key === anchor.rowKey) anchorRow = index;
    if (focusRow < 0 && key === focus.rowKey) focusRow = index;
  }
  const a = anchorRow < 0 ? undefined : resolve(rows, anchorRow, anchor);
  const f = focusRow < 0 ? undefined : resolve(rows, focusRow, focus);
  if (a === undefined || f === undefined) return undefined;
  const [start, end] = compare(a, f) <= 0 ? [a, f] : [f, a];

  const pieces: Piece[] = [];
  const counted: CountedSentence[] = [];
  let titleSelected = false;
  let gapSelected = false;
  let copy = "";
  let previous: SelectionRow | undefined;
  for (let r = start.row; r <= end.row; r += 1) {
    const row = rows[r] as SelectionRow;
    const parts = partsOf(row);
    parts.forEach((part, p) => {
      const from = r === start.row && p === start.part ? start.offset : r > start.row || p > start.part ? 0 : part.text.length;
      const to = r === end.row && p === end.part ? end.offset : r < end.row || p < end.part ? part.text.length : 0;
      const slice = from < to ? part.text.slice(from, to) : "";
      if (slice.trim() === "") return;
      if (part.part === "title") {
        titleSelected = true;
        pieces.push({ kind: "title", text: slice });
      } else if (part.part === "gap") {
        gapSelected = true;
        pieces.push({ kind: "marker" });
      } else if (part.part === "sentence" && row.kind === "paragraph") {
        const sentence = { row: r, id: part.segmentId as string, text: part.text, from, to, marked: row.marked };
        counted.push(sentence);
        pieces.push({ kind: "sentence", slice, sentence });
      }
    });

    const layout = rowLayout(row, parts);
    const cutFrom = r === start.row ? (layout.starts[start.part] as number) + start.offset : 0;
    const cutTo = r === end.row ? (layout.starts[end.part] as number) + end.offset : layout.text.length;
    if (previous !== undefined) copy += "\n".repeat(breaksAfter(previous) + breaksBefore(row));
    copy += layout.text.slice(cutFrom, cutTo);
    previous = row;
  }

  const first = counted[0];
  const last = counted.at(-1);
  let crossesGap = false;
  if (first !== undefined && last !== undefined) {
    for (let r = first.row + 1; r < last.row && !crossesGap; r += 1) crossesGap = (rows[r] as SelectionRow).kind === "gap";
  }
  const single = counted.length === 1 ? counted[0] : undefined;
  return {
    firstRow: start.row,
    lastRow: end.row,
    explainText: explainText(pieces, options.skipped),
    copyText: copy.trim(),
    sentenceCount: counted.length,
    ...(first !== undefined && last !== undefined ? { bounds: { start: { segmentId: first.id, offset: first.from }, end: { segmentId: last.id, offset: last.to } } } : {}),
    ...(single !== undefined && !titleSelected && !gapSelected ? { quote: { id: single.id, text: single.text } } : {}),
    crossesGap,
  };
}

/** A point placed in the rows: row index, index of the part within the row, offset clamped to the part's text. */
interface Place {
  row: number;
  part: number;
  offset: number;
}

interface Part {
  part: ReaderPart;
  text: string;
  segmentId?: string;
}

interface CountedSentence {
  row: number;
  id: string;
  /** The sentence's full text: separators are decided on whole sentences, as the reading view joins them. */
  text: string;
  from: number;
  to: number;
  marked: boolean;
}

type Piece = { kind: "title"; text: string } | { kind: "sentence"; slice: string; sentence: CountedSentence } | { kind: "marker" };

/** The parts of a row in the order it shows them; a part's index here orders points within the row. */
function partsOf(row: SelectionRow): Part[] {
  if (row.kind === "chapter") return [{ part: "title", text: row.title }];
  if (row.kind === "gap") return [{ part: "gap", text: row.label }];
  const parts: Part[] = [];
  if (row.speaker !== undefined) parts.push({ part: "speaker", text: row.speaker.name });
  parts.push({ part: "time", text: row.time });
  for (const sentence of row.sentences) parts.push({ part: "sentence", text: sentence.text, segmentId: sentence.id });
  return parts;
}

/** Index of the point's part in `partsOf(row)`, or -1 when the row has no such part. */
function partIndex(row: SelectionRow, point: ReaderPoint): number {
  if (row.kind === "chapter") return point.part === "title" ? 0 : -1;
  if (row.kind === "gap") return point.part === "gap" ? 0 : -1;
  const lead = row.speaker === undefined ? 0 : 1;
  switch (point.part) {
    case "speaker":
      return row.speaker === undefined ? -1 : 0;
    case "time":
      return lead;
    case "sentence": {
      const index = row.sentences.findIndex((sentence) => sentence.id === point.segmentId);
      return index < 0 ? -1 : lead + 1 + index;
    }
    default:
      return -1;
  }
}

function resolve(rows: readonly SelectionRow[], rowIndex: number, point: ReaderPoint): Place | undefined {
  const row = rows[rowIndex] as SelectionRow;
  const part = partIndex(row, point);
  if (part < 0) return undefined;
  const length = (partsOf(row)[part] as Part).text.length;
  return { row: rowIndex, part, offset: Math.min(Math.max(point.offset, 0), length) };
}

function compare(a: Place, b: Place): number {
  return a.row - b.row || a.part - b.part || a.offset - b.offset;
}

/**
 * A row's text as the browser copies it, with where each part starts in it: the turn's name
 * on its own line, the time glued to the first sentence, sentences joined as the view reads them.
 */
function rowLayout(row: SelectionRow, parts: readonly Part[]): { text: string; starts: number[] } {
  if (row.kind !== "paragraph") return { text: (parts[0] as Part).text, starts: [0] };
  const starts: number[] = [];
  let text = "";
  if (row.speaker !== undefined) {
    starts.push(0);
    text += `${row.speaker.name}\n`;
  }
  starts.push(text.length);
  text += row.time;
  row.sentences.forEach((sentence, index) => {
    const before = row.sentences[index - 1];
    if (before !== undefined) text += readingSeparator(before.text, sentence.text, row.marked);
    starts.push(text.length);
    text += sentence.text;
  });
  return { text, starts };
}

/** Line breaks the browser puts after a row: block rows end a paragraph, a gap bar only a line. */
function breaksAfter(row: SelectionRow): number {
  return row.kind === "gap" ? 1 : 2;
}

/** A named speaker's turn header opens with one more line break of its own. */
function breaksBefore(row: SelectionRow): number {
  return row.kind === "paragraph" && row.speaker?.named === true ? 1 : 0;
}

/**
 * The selected titles and sentences as one running line, a marker where a gap bar lies between
 * them. Markers at either end are dropped: nothing shown was skipped between selected text there.
 */
function explainText(pieces: readonly Piece[], skipped: string): string {
  if (!pieces.some((piece) => piece.kind !== "marker")) return "";
  let from = 0;
  let to = pieces.length;
  while ((pieces[from] as Piece).kind === "marker") from += 1;
  while ((pieces[to - 1] as Piece).kind === "marker") to -= 1;
  let text = "";
  let before: Piece | undefined;
  for (const piece of pieces.slice(from, to)) {
    if (before !== undefined) text += joiner(before, piece);
    text += piece.kind === "title" ? piece.text : piece.kind === "sentence" ? piece.slice : skipped;
    before = piece;
  }
  return text.replace(/\s+/gu, " ").trim();
}

function joiner(before: Piece, after: Piece): string {
  if (before.kind === "sentence" && after.kind === "sentence") return readingSeparator(before.sentence.text, after.sentence.text, before.sentence.marked);
  if (before.kind === "title" || after.kind === "title") return " ";
  return before.kind === "marker" && after.kind === "marker" ? " " : "";
}
