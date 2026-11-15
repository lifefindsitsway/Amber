import { Copy, MessageCircleQuestion } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { CHAT_MESSAGE_MAX_CHARS } from "../../shared/defaults.ts";
import type { SegmentId } from "../../shared/ids.ts";
import { copyText } from "../ui/clipboard.ts";
import { coveredSentences, elementOf, selectionBounds, type SelectionBounds } from "../ui/dom-selection.ts";
import { selectionSourceFor, type RegionSelection } from "../ui/selection-source.ts";
import { useChatComposer, type QuoteDraft } from "./chat-composer.tsx";

/** What "explain" takes from a selection: its cleaned text, and the sentence it lies in. */
export interface ExplainableSelection {
  text: string;
  /** Present only when the selection stays inside one transcript sentence. */
  quote?: QuoteDraft;
}

/**
 * Shown in the page but not part of what was said: citation badges, paragraph times
 * (`data-reading-time`) and the reader's other furniture (`data-reader-meta`: a turn's speaker
 * header, a play button). Chapter titles are not marked: a heading is text the reader may want.
 */
const NOT_TEXT = ["[data-citation]", "[data-reading-time]", "[data-reader-meta]"].join(",");

/**
 * The selection "explain" can work on: it must lie inside a `[data-explainable]` region (the
 * transcript reading view, the summary). The text is what the reader selected, without the
 * badges and times rendered among it. A selection whose text lies in one sentence of a view
 * naming its revision with `data-revision-id` also quotes that sentence; the quote
 * carries ids only, the server reads the text itself. An element that shows more than the
 * sentence (an AI highlight with its reason) names it in `data-segment-text`.
 */
export function selectionForExplain(selection: Selection | null): ExplainableSelection | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  const region = elementOf(range.commonAncestorContainer)?.closest("[data-explainable]");
  if (region == null) {
    return undefined;
  }
  const fragment = range.cloneContents();
  for (const skipped of Array.from(fragment.querySelectorAll(NOT_TEXT))) {
    skipped.remove();
  }
  // A removed badge leaves the space that preceded it; drop such spaces before closing punctuation.
  const text = (fragment.textContent ?? "")
    .replace(/\s+/gu, " ")
    .replace(/ (?=[，。、；：！？）」』》,.;:!?)])/gu, "")
    .trim();
  if (text === "") {
    return undefined;
  }
  const covered = coveredSentences(range, region);
  const sentence = covered.length === 1 ? covered[0] : undefined;
  const revisionId = sentence?.closest<HTMLElement>("[data-revision-id]")?.dataset["revisionId"];
  const segmentId = sentence?.dataset["segmentId"];
  if (sentence === undefined || revisionId === undefined || segmentId === undefined) {
    return { text };
  }
  return { text, quote: { transcriptRevisionId: revisionId, segmentId: segmentId as SegmentId, text: sentence.dataset["segmentText"] ?? sentence.textContent?.trim() ?? text } };
}

/** How much selected text fits into the explain question within the chat limit. */
function explainRoom(t: TFunction): number {
  return CHAT_MESSAGE_MAX_CHARS - t("chat.explainSelectionPrompt", { text: "" }).length;
}

/** Whether "explain" will take only the beginning of `text`. */
export function explainIsTruncated(t: TFunction, text: string): boolean {
  return text.length > explainRoom(t);
}

/** The question "explain" pre-fills, cut so the whole question stays within the chat limit. */
export function explainSelectionQuestion(t: TFunction, text: string): string {
  if (!explainIsTruncated(t, text)) return t("chat.explainSelectionPrompt", { text });
  // One unit goes to the ellipsis; a cut between the halves of a surrogate pair would leave a lone half.
  let cut = explainRoom(t) - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return t("chat.explainSelectionPrompt", { text: `${text.slice(0, cut)}…` });
}

/** The box a snapshot was taken at, in viewport coordinates; a plain copy, never a live DOMRect. */
export interface SelectionRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

/**
 * The selection as it was when the user let go: every toolbar action works from this copy,
 * never from the live selection, which may change or vanish (a windowed row unmounting).
 */
export interface SelectionSnapshot extends ExplainableSelection {
  copyText: string;
  rect: SelectionRect;
  /** Present only in a reading view that takes notes (`data-notes`). */
  bounds?: SelectionBounds;
  /** The following are present only for a region that keeps its own account of the selection. */
  sentenceCount?: number;
  crossesGap?: boolean;
  version?: number;
}

/** Where a selection kept by its region lay on screen when the snapshot was taken or refreshed. */
interface SourcedGeometry {
  first: SelectionRect | undefined;
  focus: SelectionRect | undefined;
  region: SelectionRect;
}

interface Picked extends SelectionSnapshot {
  /** Distinguishes snapshots, so per-selection action state starts afresh for each. */
  seq: number;
  /** The region answering for the selection, when one does. */
  regionElement?: Element;
  /** Undefined where there is no range geometry: the toolbar then sits where an unsourced one would. */
  geometry?: SourcedGeometry | undefined;
}

/** Room left between the toolbar and the viewport (or region) edges. */
const EDGE_GAP_PX = 8;
/** How far above the selection the toolbar sits. */
const ABOVE_SELECTION_PX = 36;
/** How far below a line the toolbar sits when it cannot go above. */
const BELOW_GAP_PX = 6;
/** How long after the last resize event the page counts as laid out again. */
const RESIZE_SETTLE_MS = 150;

function plainRect(rect: DOMRect | DOMRectReadOnly): SelectionRect {
  return { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height };
}

/** Whether a box shows in the region, vertically: the reader scrolls only up and down. */
function shows(rect: SelectionRect | undefined, region: SelectionRect): rect is SelectionRect {
  return rect !== undefined && rect.bottom > region.top && rect.top < region.bottom;
}

/**
 * Where the toolbar of a selection kept by its region goes. The selection may run far beyond
 * the screen, so it sits above the first line when that shows, else beside the end the user let
 * go, else at the top of the region; it never leaves the region.
 */
export function toolbarPosition(input: {
  /** First line of the selection (the range's first client rect); undefined when unknown. */
  first: SelectionRect | undefined;
  /** The caret box of the end the user released (the selection's focus); undefined when unknown. */
  focus: SelectionRect | undefined;
  /** The visible box of the region the selection lives in (the reader's scroll element). */
  region: SelectionRect;
  size: { width: number; height: number };
  viewportWidth: number;
}): { top: number; left: number; anchor: "first" | "focus" | "region" } {
  const { first, focus, region, size } = input;
  let top: number;
  let left: number;
  let anchor: "first" | "focus" | "region";
  if (shows(first, region)) {
    anchor = "first";
    left = first.left;
    top = first.top - ABOVE_SELECTION_PX;
    if (top < region.top + EDGE_GAP_PX) top = first.bottom + BELOW_GAP_PX;
  } else if (shows(focus, region)) {
    anchor = "focus";
    left = focus.left;
    const below = focus.bottom + BELOW_GAP_PX;
    top = below + size.height <= region.bottom - EDGE_GAP_PX ? below : focus.top - ABOVE_SELECTION_PX;
  } else {
    anchor = "region";
    top = region.top + EDGE_GAP_PX;
    left = region.left + EDGE_GAP_PX;
  }
  // Lower bounds win when the region is smaller than the toolbar.
  const maxTop = region.bottom - size.height - EDGE_GAP_PX;
  const minLeft = Math.max(EDGE_GAP_PX, region.left + EDGE_GAP_PX);
  const maxLeft = Math.min(input.viewportWidth, region.right) - size.width - EDGE_GAP_PX;
  return {
    top: Math.max(region.top + EDGE_GAP_PX, Math.min(top, maxTop)),
    left: Math.max(minLeft, Math.min(left, maxLeft)),
    anchor,
  };
}

/** Plain copies of the boxes `toolbarPosition` needs; undefined without range geometry. */
function geometryOf(selection: Selection, range: Range, region: Element): SourcedGeometry | undefined {
  if (typeof range.getClientRects !== "function" || typeof region.getBoundingClientRect !== "function") return undefined;
  const firstRect = range.getClientRects()[0];
  let focus: SelectionRect | undefined;
  const focusNode = selection.focusNode;
  if (focusNode !== null) {
    const caret = document.createRange();
    caret.setStart(focusNode, selection.focusOffset);
    caret.collapse(true);
    // A caret at an element boundary may have no box of its own.
    const caretRect = typeof caret.getClientRects === "function" ? caret.getClientRects()[0] : undefined;
    const box = caretRect ?? elementOf(focusNode)?.getBoundingClientRect();
    focus = box === undefined ? undefined : plainRect(box);
  }
  // Above the first line, the toolbar starts at the left edge of the whole selection (for
  // several lines, the column's), not where the first line happens to begin.
  const edge = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect().left : undefined;
  const first = firstRect === undefined ? undefined : { ...plainRect(firstRect), ...(edge === undefined ? {} : { left: edge }) };
  return { first, focus, region: plainRect(region.getBoundingClientRect()) };
}

/**
 * The box a selection's follow-up (a note draft's popover) hangs on. A selection inside its
 * region is its own box; one running beyond it is taller than the screen, which leaves nothing
 * a popover could be placed beside, so the end in view stands for it: the one let go, else the
 * first line, else the region's top edge.
 */
function followUpRect(rect: SelectionRect, geometry: SourcedGeometry | undefined): SelectionRect {
  if (geometry === undefined) return rect;
  const { first, focus, region } = geometry;
  if (rect.top >= region.top && rect.bottom <= region.bottom) return rect;
  if (shows(focus, region)) return focus;
  if (shows(first, region)) return first;
  return { top: region.top, left: region.left, bottom: region.top, right: region.left, width: 0, height: 0 };
}

function rectOf(range: Range): SelectionRect | undefined {
  // Environments without range geometry fall back to the start node's box.
  const rect =
    typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : elementOf(range.startContainer)?.getBoundingClientRect();
  if (rect === undefined) return undefined;
  return plainRect(rect);
}

function snapshotOf(read: RegionSelection): Omit<SelectionSnapshot, "rect"> {
  return {
    text: read.text,
    ...(read.quote === undefined ? {} : { quote: read.quote }),
    copyText: read.copyText,
    ...(read.bounds === undefined ? {} : { bounds: read.bounds }),
    sentenceCount: read.sentenceCount,
    crossesGap: read.crossesGap,
    version: read.version,
  };
}

/**
 * The selection toolbar: explain (into the chat input, not sent) and copy;
 * `actions` adds more for the snapshot (notes in the reading view) and gets
 * `close` to dismiss the toolbar once done.
 */
export function SelectionToolbar(props: { actions?: (snapshot: SelectionSnapshot, close: () => void) => ReactNode }) {
  const { t } = useTranslation();
  const composer = useChatComposer();
  const [picked, setPicked] = useState<Picked | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const toolbar = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  // The snapshot as last chosen, readable from the document listeners without waiting for a render.
  const current = useRef<Picked | undefined>(undefined);

  useEffect(() => {
    const choose = (next: Picked | undefined): void => {
      current.current = next;
      setPicked(next);
    };
    const update = (event: Event): void => {
      // Pressing a toolbar button must not re-take the snapshot its action works from.
      if (event.target instanceof Node && toolbar.current?.contains(event.target) === true) return;
      const selection = window.getSelection();
      const region = selectionSourceFor(selection);
      if (region !== undefined && selection !== null) {
        const read = region.source.read();
        const range = selection.getRangeAt(0);
        const rect = read === undefined ? undefined : rectOf(range);
        if (read === undefined || rect === undefined) {
          choose(undefined);
          return;
        }
        const geometry = geometryOf(selection, range, region.element);
        const previous = current.current;
        if (previous !== undefined && previous.version === read.version && previous.regionElement === region.element) {
          // The same selection (a modifier key let go, a second release): keep the snapshot, so
          // the actions' state survives, and only follow where it now lies on screen.
          choose({ ...previous, rect: followUpRect(rect, geometry), geometry });
          return;
        }
        seq.current += 1;
        choose({ ...snapshotOf(read), rect: followUpRect(rect, geometry), regionElement: region.element, geometry, seq: seq.current });
        return;
      }
      const found = selectionForExplain(selection);
      if (found === undefined || selection === null) {
        choose(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = rectOf(range);
      if (rect === undefined) {
        choose(undefined);
        return;
      }
      const bounds = selectionBounds(range);
      seq.current += 1;
      choose({ ...found, copyText: selection.toString().trim(), rect, ...(bounds === undefined ? {} : { bounds }), seq: seq.current });
    };
    const cleared = (): void => {
      if (window.getSelection()?.isCollapsed !== false) choose(undefined);
    };
    // A resized window moves the region and the selection in it: the toolbar of a selection its
    // region keeps follows once the page has settled, instead of staying where the region was.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const resized = (event: Event): void => {
      if (settle !== undefined) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = undefined;
        if (current.current?.version !== undefined) update(event);
      }, RESIZE_SETTLE_MS);
    };
    // Scrolling moves the selection under a toolbar that is fixed on screen. A region that keeps
    // its selection keeps it however far it scrolls, so its toolbar follows: above the first line
    // while that shows, beside the end let go, else at the region's edge. Once per frame.
    let frame: number | undefined;
    const scrolled = (event: Event): void => {
      const shown = current.current;
      if (frame !== undefined || shown?.version === undefined || shown.regionElement === undefined) return;
      if (!(event.target instanceof Node) || !event.target.contains(shown.regionElement)) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const selection = window.getSelection();
        const now = current.current;
        if (now?.regionElement === undefined || selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        const geometry = geometryOf(selection, range, now.regionElement);
        if (geometry !== undefined) choose({ ...now, rect: followUpRect(rectOf(range) ?? now.rect, geometry), geometry });
      });
    };
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("selectionchange", cleared);
    window.addEventListener("resize", resized);
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", cleared);
      window.removeEventListener("resize", resized);
      document.removeEventListener("scroll", scrolled, { capture: true });
      if (settle !== undefined) clearTimeout(settle);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  // Measured after each layout, so a toolbar grown by extra actions still fits the viewport.
  useLayoutEffect(() => {
    const width = toolbar.current?.offsetWidth ?? 0;
    const height = toolbar.current?.offsetHeight ?? 0;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  });

  if (picked === undefined) {
    return null;
  }
  const close = (): void => {
    current.current = undefined;
    setPicked(undefined);
  };
  const sourced = picked.version !== undefined;
  let top: number;
  let left: number;
  // A toolbar wider than its region wraps inside it instead of running to the window's edge.
  const maxWidth = picked.geometry === undefined ? undefined : Math.max(0, picked.geometry.region.width - 2 * EDGE_GAP_PX);
  if (picked.geometry === undefined) {
    const maxLeft = Math.max(EDGE_GAP_PX, window.innerWidth - size.width - EDGE_GAP_PX);
    left = Math.min(Math.max(EDGE_GAP_PX, picked.rect.left), maxLeft);
    top = Math.max(0, picked.rect.top - ABOVE_SELECTION_PX);
  } else {
    ({ top, left } = toolbarPosition({ ...picked.geometry, size, viewportWidth: window.innerWidth }));
  }
  // A selection reaching off screen, or one "explain" cannot take whole, says how much it holds.
  const truncated = sourced && explainIsTruncated(t, picked.text);
  const endHidden = picked.geometry !== undefined && !(shows(picked.geometry.first, picked.geometry.region) && shows(picked.geometry.focus, picked.geometry.region));
  const count = picked.sentenceCount ?? 0;
  const showCount = sourced && (truncated || (count >= 2 && endHidden));
  return (
    <div
      ref={toolbar}
      role="toolbar"
      aria-label={t("chat.toolbar.label")}
      data-testid="selection-toolbar"
      {...(sourced ? { "data-selection-version": picked.version } : {})}
      className="fixed z-30 flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-1 rounded-md border border-line bg-surface p-1 shadow-lg"
      style={{ top, left, ...(maxWidth === undefined ? {} : { maxWidth }) }}
      // Keeps the selection alive while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      {showCount ? (
        // A line of its own above the buttons: beside them it would push the last button onto a line by
        // itself. No width of its own, so the toolbar stays as wide as its buttons.
        <span className="w-0 min-w-full px-2 pt-0.5 text-xs text-muted" data-testid="selection-count">
          {truncated ? t("chat.toolbar.selectedTruncated", { count }) : t("chat.toolbar.selected", { count })}
        </span>
      ) : null}
      <button
        type="button"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-sunken"
        data-testid="selection-explain"
        onClick={() => {
          composer.explain(picked.quote, explainSelectionQuestion(t, picked.text));
          window.getSelection()?.removeAllRanges();
          close();
        }}
      >
        <MessageCircleQuestion size={14} />
        {t("chat.toolbar.explain")}
      </button>
      <button
        type="button"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-sunken"
        data-testid="selection-copy"
        onClick={() => {
          // Copying keeps the selection: only the toolbar goes away.
          void copyText(picked.copyText);
          close();
        }}
      >
        <Copy size={14} />
        {t("chat.toolbar.copy")}
      </button>
      {props.actions === undefined ? null : <Fragment key={picked.seq}>{props.actions(picked, close)}</Fragment>}
    </div>
  );
}
