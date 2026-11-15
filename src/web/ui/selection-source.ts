import { useCallback, useRef } from "react";
import type { ChatQuote } from "../../shared/dto/chat.ts";
import type { SelectionBounds } from "./dom-selection.ts";

/** A sentence a selection quotes: its ids, and its text for the card that shows it. */
export interface SelectionQuote extends ChatQuote {
  text: string;
}

/**
 * The current selection of a region that keeps its own account of it, instead of having it read
 * off the page: a windowed list, where the page holds only some of the selected rows.
 */
export interface RegionSelection {
  /** Changes whenever the selected range does: two reads with the same version are the same selection. */
  version: number;
  /** What "explain" takes: the selected text as one running line. */
  text: string;
  /** Present when everything selected lies in one sentence. */
  quote?: SelectionQuote;
  /** What the selection toolbar's "copy" takes. */
  copyText: string;
  /** What the context menu's "copy selection" takes, and Ctrl+C when the region answers it itself. */
  menuCopyText: string;
  /** Where the selection starts and ends in sentence terms, for a region that takes notes. */
  bounds?: SelectionBounds;
  /** Sentences the selection shares text with. */
  sentenceCount: number;
  /** Whether text the region does not show lies between the selection's first and last sentence. */
  crossesGap: boolean;
}

/** A region's own reading of the selection; undefined when it has nothing an action could work on. */
export interface SelectionSource {
  read: () => RegionSelection | undefined;
}

const sources = new WeakMap<Element, { current: SelectionSource }>();

/** Registers `element` as answering for the selections inside it. Returns the undo. */
export function registerSelectionSource(element: Element, source: { current: SelectionSource }): () => void {
  sources.set(element, source);
  return () => {
    if (sources.get(element) === source) sources.delete(element);
  };
}

/** The nearest registered region around a node, itself included. */
export function selectionSourceAt(node: Node | null): { element: Element; source: SelectionSource } | undefined {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (!(current instanceof Element)) continue;
    const found = sources.get(current);
    if (found !== undefined) return { element: current, source: found.current };
  }
  return undefined;
}

/**
 * The region that answers for a selection: the nearest registered one around the whole of it.
 * A selection that reaches outside every region has none and is read off the page as before.
 */
export function selectionSourceFor(selection: Selection | null): { element: Element; source: SelectionSource } | undefined {
  if (selection === null || selection.rangeCount === 0) return undefined;
  return selectionSourceAt(selection.getRangeAt(0).commonAncestorContainer);
}

/**
 * A callback ref that registers the element it is attached to. The source is read at call time,
 * so it may be rebuilt on every render.
 */
export function useSelectionSource<T extends Element = HTMLElement>(source: SelectionSource): (element: T | null) => (() => void) | undefined {
  const latest = useRef(source);
  latest.current = source;
  return useCallback((element: T | null) => (element === null ? undefined : registerSelectionSource(element, latest)), []);
}
