import { useEffect, useRef, useState } from "react";
import { ROW_KEY_ATTRIBUTE } from "./scroll-anchor.ts";

/** Set on the root of every paragraph row of a turn layout: the turn's key. */
export const TURN_KEY_ATTRIBUTE = "data-turn-key";
/** Set next to it: the turn's speaker id, empty for unassigned sentences. */
export const TURN_SPEAKER_ATTRIBUTE = "data-turn-speaker";
/** Set on a turn header, so a row can tell whether its header is still in view. */
export const TURN_HEADER_ATTRIBUTE = "data-turn-header";

/**
 * A row must show at least this much below the top edge to speak for the turn: the marker is
 * about this tall, and a row that is about to scroll out must not leave it on top of the next
 * turn's avatar.
 */
const MARKER_CLEARANCE_PX = 40;
/** Fade of the marker in and out. */
export const MARKER_FADE_MS = 150;

/** The turn the marker stands for. */
export interface StickyTurn {
  key: string;
  speakerId: string | undefined;
}

/**
 * The turn whose header has scrolled out of a list while the turn goes on, if any: the first
 * row that still has room below the top edge belongs to a turn, and that turn's header is not
 * (fully) in view. A chapter heading at the top, a first row of a turn whose header is in view
 * and an empty list all give `undefined`.
 */
export function stickyTurnAt(container: HTMLElement): StickyTurn | undefined {
  const top = container.getBoundingClientRect().top;
  for (const row of container.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`)) {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue;
    if (rect.bottom <= top + MARKER_CLEARANCE_PX) continue;
    const turn = row.querySelector<HTMLElement>(`[${TURN_KEY_ATTRIBUTE}]`);
    const key = turn?.getAttribute(TURN_KEY_ATTRIBUTE);
    if (turn == null || key == null) return undefined;
    const header = turn.querySelector<HTMLElement>(`[${TURN_HEADER_ATTRIBUTE}]`);
    if (header !== null && header.getBoundingClientRect().bottom > top) return undefined;
    const speaker = turn.getAttribute(TURN_SPEAKER_ATTRIBUTE);
    return { key, speakerId: speaker === null || speaker === "" ? undefined : speaker };
  }
  return undefined;
}

const sameTurn = (a: StickyTurn | undefined, b: StickyTurn | undefined): boolean => a?.key === b?.key && a?.speakerId === b?.speakerId;

/**
 * Follows the scrolling of an element and reports the turn the sticky marker stands for. `element`'s
 * first child is the scroller. Scroll events do not bubble, so they are caught on the way
 * down. `refresh` changes whenever the rows or their sizes did, so a re-layout without a
 * scroll is noticed too. The state only changes when the turn does.
 */
export function useStickyTurn(element: HTMLElement | null, enabled: boolean, refresh: unknown): StickyTurn | undefined {
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
      const next = scroller instanceof HTMLElement ? stickyTurnAt(scroller) : undefined;
      setTurn((previous) => (sameTurn(previous, next) ? previous : next));
    };
    const schedule = (): void => {
      if (frame.current === undefined) frame.current = requestAnimationFrame(update);
    };
    element.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      element.removeEventListener("scroll", schedule, true);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [element, enabled, refresh]);
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
