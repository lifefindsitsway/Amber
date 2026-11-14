import { useEffect, useRef, useState } from "react";
import { READER_TEXT_ATTRIBUTE } from "./reader-font.ts";
import type { ReaderTypography } from "./reader-typography.ts";
import { ROW_KEY_ATTRIBUTE } from "./scroll-anchor.ts";
import { avatarEmPx } from "./speakers/speaker-avatar.tsx";

/** Set on the root of every paragraph row of a turn layout: the turn's key. */
export const TURN_KEY_ATTRIBUTE = "data-turn-key";
/** Set next to it: the turn's speaker id, empty for unassigned sentences. */
export const TURN_SPEAKER_ATTRIBUTE = "data-turn-speaker";
/** Set on a turn header, so a row can tell whether its header is still in view. */
export const TURN_HEADER_ATTRIBUTE = "data-turn-header";

/** Fade of the marker in and out. */
export const MARKER_FADE_MS = 150;

/** The turn the marker stands for. */
export interface StickyTurn {
  key: string;
  speakerId: string | undefined;
}

/** What the marker rule measures with, in px at the current reading typography. */
export interface StickyMetrics {
  /** The marker's height: the reader avatar's diameter. */
  markerPx: number;
  /** One line of the reading text. */
  linePx: number;
}

/** The metrics at a reading font size and line height. */
export function stickyMetrics(typography: Pick<ReaderTypography, "fontSize" | "lineHeight">): StickyMetrics {
  return { markerPx: avatarEmPx(typography.fontSize), linePx: typography.fontSize * typography.lineHeight };
}

/**
 * The turn whose header has scrolled out of a list while the turn goes on, if any. A row speaks
 * for its turn while its text (not the space after it) still reaches at least a marker and a line
 * below the top edge: the marker then sits beside text of that turn, never on the next turn's
 * header, which only starts after that text; and a turn of one line, whose header leaves view
 * with the line's top, never gets one. The first row that has that much left decides. A header
 * still (partly) in view needs no stand-in whatever follows it: a short first paragraph must not
 * hand the turn to its next paragraph while the header shows. A chapter heading and an empty list
 * give `undefined` too.
 */
export function stickyTurnAt(container: HTMLElement, metrics: StickyMetrics): StickyTurn | undefined {
  const top = container.getBoundingClientRect().top;
  const needed = metrics.markerPx + metrics.linePx;
  for (const row of container.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`)) {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue;
    const header = row.querySelector<HTMLElement>(`[${TURN_HEADER_ATTRIBUTE}]`);
    if (header !== null && header.getBoundingClientRect().bottom > top) return undefined;
    const text = row.querySelector<HTMLElement>(`[${READER_TEXT_ATTRIBUTE}]`);
    const bottom = text === null ? rect.bottom : text.getBoundingClientRect().bottom;
    if (bottom - top < needed) continue;
    const turn = row.querySelector<HTMLElement>(`[${TURN_KEY_ATTRIBUTE}]`);
    const key = turn?.getAttribute(TURN_KEY_ATTRIBUTE);
    if (turn == null || key == null) return undefined;
    const speaker = turn.getAttribute(TURN_SPEAKER_ATTRIBUTE);
    return { key, speakerId: speaker === null || speaker === "" ? undefined : speaker };
  }
  return undefined;
}

const sameTurn = (a: StickyTurn | undefined, b: StickyTurn | undefined): boolean => a?.key === b?.key && a?.speakerId === b?.speakerId;

/**
 * Follows the scrolling of an element and reports the turn the sticky marker stands for. `element`'s
 * first child is the scroller. Scroll events do not bubble, so they are caught on the way
 * down. `refresh` changes whenever the rows or their sizes did, and `metrics` with the reading
 * typography, so a re-layout without a scroll is noticed too. A windowed list also mounts the rows
 * of a new position only after the scroll event that took it there, and nothing scrolls again:
 * the rows mounted or unmounted are watched as well, so the answer never rests on rows that have
 * since been replaced. The state only changes when the turn does.
 */
export function useStickyTurn(element: HTMLElement | null, enabled: boolean, refresh: unknown, metrics: StickyMetrics): StickyTurn | undefined {
  const { markerPx, linePx } = metrics;
  const [turn, setTurn] = useState<StickyTurn | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || element === null) {
      setTurn(undefined);
      return;
    }
    const update = (): void => {
      frame.current = undefined;
      const scroller = element.firstElementChild;
      const next = scroller instanceof HTMLElement ? stickyTurnAt(scroller, { markerPx, linePx }) : undefined;
      setTurn((previous) => (sameTurn(previous, next) ? previous : next));
    };
    const schedule = (): void => {
      if (frame.current === undefined) frame.current = requestAnimationFrame(update);
    };
    element.addEventListener("scroll", schedule, true);
    const scroller = element.firstElementChild;
    const rows = scroller === null || typeof MutationObserver === "undefined" ? undefined : new MutationObserver(schedule);
    if (scroller !== null) rows?.observe(scroller, { childList: true, subtree: true });
    schedule();
    return () => {
      element.removeEventListener("scroll", schedule, true);
      rows?.disconnect();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [element, enabled, refresh, markerPx, linePx]);
  return turn;
}

/**
 * The turn the marker draws, lagging `target` by one fade: a change of turn fades the old
 * marker out, swaps it, and fades the new one in; a turn that goes away keeps its content
 * while it fades out. `visible` drives the opacity.
 */
export function useFadedTurn(target: StickyTurn | undefined): { shown: StickyTurn | undefined; visible: boolean } {
  const [state, setState] = useState<{ shown: StickyTurn | undefined; visible: boolean }>({ shown: target, visible: target !== undefined });
  useEffect(() => {
    if (target === undefined) {
      setState((previous) => (previous.visible ? { ...previous, visible: false } : previous));
      return;
    }
    if (state.shown === undefined || sameTurn(state.shown, target)) {
      setState({ shown: target, visible: true });
      return;
    }
    setState((previous) => ({ ...previous, visible: false }));
    const timer = setTimeout(() => setState({ shown: target, visible: true }), MARKER_FADE_MS);
    return () => clearTimeout(timer);
    // `state.shown` is read as the previous turn only; a swap in flight must not restart on its own result.
  }, [target?.key, target?.speakerId]);
  return state;
}
