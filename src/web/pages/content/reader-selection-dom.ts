import { elementOf, textOffsetIn } from "../../ui/dom-selection.ts";
import { READER_PART_ATTRIBUTE, type ReaderPart, type ReaderPoint } from "./reader-selection.ts";
import { ROW_KEY_ATTRIBUTE } from "./scroll-anchor.ts";

const ROW_SELECTOR = `[${ROW_KEY_ATTRIBUTE}]`;
/** Every element that is one part of a row: the marked ones and the sentences. */
const PART_SELECTOR = `[${READER_PART_ATTRIBUTE}],[data-segment-id]`;
const MARKED_PARTS = new Set<string>(["title", "speaker", "time", "gap"]);

/** A boundary point of the document, as a range or a selection gives it. */
export interface DomPoint {
  node: Node;
  offset: number;
}

/** The part an element is, or undefined for an element that carries an unknown mark. */
function partOf(element: Element): { part: ReaderPart; segmentId?: string } | undefined {
  const marked = element.getAttribute(READER_PART_ATTRIBUTE);
  if (marked !== null) return MARKED_PARTS.has(marked) ? { part: marked as ReaderPart } : undefined;
  const segmentId = element.getAttribute("data-segment-id");
  return segmentId === null ? undefined : { part: "sentence", segmentId };
}

function textLength(element: Element): number {
  let total = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) total += (node as Text).length;
  return total;
}

/** The mounted rows in document order, which is the list's order. */
function rowElements(scroller: Element): HTMLElement[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR));
}

function partElements(row: Element): Element[] {
  return Array.from(row.querySelectorAll(PART_SELECTOR)).filter((element) => partOf(element) !== undefined);
}

function pointIn(row: Element, element: Element, offset: number): ReaderPoint | undefined {
  const part = partOf(element);
  const rowKey = row.getAttribute(ROW_KEY_ATTRIBUTE);
  if (part === undefined || rowKey === null) return undefined;
  return { rowKey, ...part, offset };
}

/** The point at the start of the row's first part. */
function rowStart(row: Element): ReaderPoint | undefined {
  const first = partElements(row)[0];
  return first === undefined ? undefined : pointIn(row, first, 0);
}

/** The point at the end of the row's last part. */
function rowEnd(row: Element): ReaderPoint | undefined {
  const last = partElements(row).at(-1);
  return last === undefined ? undefined : pointIn(row, last, textLength(last));
}

/** The list key of the row a node sits in, when that row belongs to `scroller`. */
export function rowKeyAt(scroller: Element, node: Node): string | undefined {
  const row = elementOf(node)?.closest(ROW_SELECTOR);
  if (row == null || !scroller.contains(row)) return undefined;
  return row.getAttribute(ROW_KEY_ATTRIBUTE) ?? undefined;
}

/** The keys of the rows mounted right now. */
export function mountedRowKeys(scroller: Element): Set<string> {
  const keys = new Set<string>();
  for (const row of rowElements(scroller)) {
    const key = row.getAttribute(ROW_KEY_ATTRIBUTE);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/**
 * Where a boundary point of the document lies in reader terms. Inside a part it is that part
 * and the text offset; anywhere else in a row (the separator between two sentences, an avatar,
 * the padding) it is the start of the next part, or the end of the row's last part when none
 * follows — the same place as far as the selected text goes. Between rows it is the start of
 * the next mounted row. Undefined outside `scroller` or while no row is mounted.
 */
export function pointFromDom(scroller: Element, node: Node, offset: number): ReaderPoint | undefined {
  if (!scroller.contains(node)) return undefined;
  const element = elementOf(node);
  const row = element?.closest(ROW_SELECTOR) ?? null;
  const probe = document.createRange();
  probe.setStart(node, offset);
  // `comparePoint` places a point relative to the collapsed probe: positive means after it.
  const startsAfter = (target: Element): boolean => probe.comparePoint(target, 0) > 0;
  if (row !== null && scroller.contains(row)) {
    const own = element?.closest(PART_SELECTOR) ?? null;
    if (own !== null && row.contains(own) && partOf(own) !== undefined) return pointIn(row, own, textOffsetIn(own, node, offset));
    const next = partElements(row).find(startsAfter);
    return next === undefined ? rowEnd(row) : pointIn(row, next, 0);
  }
  const rows = rowElements(scroller);
  const following = rows.find(startsAfter);
  if (following !== undefined) return rowStart(following);
  const last = rows.at(-1);
  return last === undefined ? undefined : rowEnd(last);
}

/**
 * The boundary point of the document a reader point is at, for putting a selection back.
 * Undefined while the point's row is not mounted or no longer shows that part. An offset past
 * the part's text counts as its end.
 */
export function domFromPoint(scroller: Element, point: ReaderPoint): DomPoint | undefined {
  const row = rowElements(scroller).find((candidate) => candidate.getAttribute(ROW_KEY_ATTRIBUTE) === point.rowKey);
  if (row === undefined) return undefined;
  const element = partElements(row).find((candidate) => {
    const part = partOf(candidate);
    return part !== undefined && part.part === point.part && part.segmentId === point.segmentId;
  });
  if (element === undefined) return undefined;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let before = 0;
  let last: Text | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (point.offset <= before + text.length) return { node: text, offset: Math.max(0, point.offset - before) };
    before += text.length;
    last = text;
  }
  return last === undefined ? { node: element, offset: 0 } : { node: last, offset: last.length };
}
