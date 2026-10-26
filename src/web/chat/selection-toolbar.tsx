import { Copy, MessageCircleQuestion } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { CHAT_MESSAGE_MAX_CHARS } from "../../shared/defaults.ts";
import type { SegmentId } from "../../shared/ids.ts";
import { copyText } from "../ui/clipboard.ts";
import { coveredSentences, elementOf, selectionBounds, type SelectionBounds } from "../ui/dom-selection.ts";
import { useChatComposer, type QuoteDraft } from "./chat-composer.tsx";

/** What "explain" takes from a selection: its cleaned text, and the sentence it lies in. */
export interface ExplainableSelection {
  text: string;
  /** Present only when the selection stays inside one transcript sentence. */
  quote?: QuoteDraft;
}

/** Shown in the page but not part of what was said: citation badges and paragraph times. */
const NOT_TEXT = ["[data-citation]", "[data-reading-time]"].join(",");

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

/** The question "explain" pre-fills, cut so the whole question stays within the chat limit. */
export function explainSelectionQuestion(t: TFunction, text: string): string {
  const room = CHAT_MESSAGE_MAX_CHARS - t("chat.explainSelectionPrompt", { text: "" }).length;
  return t("chat.explainSelectionPrompt", { text: text.length <= room ? text : `${text.slice(0, room - 1)}…` });
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
}

interface Picked extends SelectionSnapshot {
  /** Distinguishes snapshots, so per-selection action state starts afresh for each. */
  seq: number;
}

/** Room left between the toolbar and the viewport edges. */
const EDGE_GAP_PX = 8;
/** How far above the selection the toolbar sits. */
const ABOVE_SELECTION_PX = 36;

function rectOf(range: Range): SelectionRect | undefined {
  // Environments without range geometry fall back to the start node's box.
  const rect =
    typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : elementOf(range.startContainer)?.getBoundingClientRect();
  if (rect === undefined) return undefined;
  return { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height };
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
  const [width, setWidth] = useState(0);
  const toolbar = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const update = (event: Event): void => {
      // Pressing a toolbar button must not re-take the snapshot its action works from.
      if (event.target instanceof Node && toolbar.current?.contains(event.target) === true) return;
      const selection = window.getSelection();
      const found = selectionForExplain(selection);
      if (found === undefined || selection === null) {
        setPicked(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = rectOf(range);
      if (rect === undefined) {
        setPicked(undefined);
        return;
      }
      const bounds = selectionBounds(range);
      seq.current += 1;
      setPicked({ ...found, copyText: selection.toString().trim(), rect, ...(bounds === undefined ? {} : { bounds }), seq: seq.current });
    };
    const cleared = (): void => {
      if (window.getSelection()?.isCollapsed !== false) setPicked(undefined);
    };
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("selectionchange", cleared);
    return () => {
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", cleared);
    };
  }, []);

  // Measured after each layout, so a toolbar grown by extra actions still fits the viewport.
  useLayoutEffect(() => {
    const measured = toolbar.current?.offsetWidth ?? 0;
    if (measured !== width) setWidth(measured);
  });

  if (picked === undefined) {
    return null;
  }
  const close = (): void => setPicked(undefined);
  const maxLeft = Math.max(EDGE_GAP_PX, window.innerWidth - width - EDGE_GAP_PX);
  const left = Math.min(Math.max(EDGE_GAP_PX, picked.rect.left), maxLeft);
  return (
    <div
      ref={toolbar}
      role="toolbar"
      aria-label={t("chat.toolbar.label")}
      data-testid="selection-toolbar"
      className="fixed z-30 flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-1 rounded-md border border-line bg-surface p-1 shadow-lg"
      style={{ top: Math.max(0, picked.rect.top - ABOVE_SELECTION_PX), left }}
      // Keeps the selection alive while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-sunken"
        data-testid="selection-explain"
        onClick={() => {
          composer.explain(picked.quote, explainSelectionQuestion(t, picked.text));
          window.getSelection()?.removeAllRanges();
          setPicked(undefined);
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
          setPicked(undefined);
        }}
      >
        <Copy size={14} />
        {t("chat.toolbar.copy")}
      </button>
      {props.actions === undefined ? null : <Fragment key={picked.seq}>{props.actions(picked, close)}</Fragment>}
    </div>
  );
}
