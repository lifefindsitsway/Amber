import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** A box fixed on the viewport, in CSS pixels. */
export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The edge or corner a resize handle moves. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_EDGES: readonly ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Movement or size change of one arrow key press. */
const KEY_STEP_PX = 16;

/** Pressing on a control inside the move handle uses that control instead of moving the box. */
const NO_DRAG_SELECTOR = ["button", "a", "input", "textarea", "select", "[role=menu]", "[role=menuitem]", "[role=listbox]", "[role=option]", "[contenteditable=true]"].join(",");

interface Viewport {
  width: number;
  height: number;
}

const viewportNow = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * The box as it can be shown in `viewport`: no smaller than the minimum size (or the
 * viewport, when that is smaller), no larger than the viewport, and wholly inside it.
 */
export function clampBox(rect: BoxRect, viewport: Viewport, minWidth: number, minHeight: number): BoxRect {
  const width = clamp(rect.width, Math.min(minWidth, viewport.width), viewport.width);
  const height = clamp(rect.height, Math.min(minHeight, viewport.height), viewport.height);
  return { left: clamp(rect.left, 0, viewport.width - width), top: clamp(rect.top, 0, viewport.height - height), width, height };
}

/**
 * `start` (already clamped) with `edge` moved by the pointer's travel. The opposite edges stay
 * where they are, so a box at its minimum size or at the viewport's edge stops instead of
 * sliding away.
 */
export function resizeBox(start: BoxRect, edge: ResizeEdge, dx: number, dy: number, viewport: Viewport, minWidth: number, minHeight: number): BoxRect {
  const minW = Math.min(minWidth, viewport.width);
  const minH = Math.min(minHeight, viewport.height);
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  let { left, top, width, height } = start;
  if (edge.includes("e")) width = clamp(start.width + dx, minW, viewport.width - start.left);
  if (edge.includes("w")) {
    left = clamp(start.left + dx, 0, right - minW);
    width = right - left;
  }
  if (edge.includes("s")) height = clamp(start.height + dy, minH, viewport.height - start.top);
  if (edge.includes("n")) {
    top = clamp(start.top + dy, 0, bottom - minH);
    height = bottom - top;
  }
  return { left, top, width, height };
}

const sameBox = (a: BoxRect, b: BoxRect): boolean => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

interface Gesture {
  pointerId: number;
  kind: "move" | ResizeEdge;
  x: number;
  y: number;
  start: BoxRect;
  latest: BoxRect;
  element: HTMLElement;
  /** Removes the window listeners of this gesture. */
  stop: () => void;
}

export interface FloatingBox {
  /** The box as shown: `rect` clamped to the current viewport, or the gesture in progress. */
  box: BoxRect;
  /** What a pointer gesture is changing, while one runs. */
  active: "move" | ResizeEdge | undefined;
  /** Spread on the element the box is moved by (a title bar). */
  moveHandle: { onPointerDown: (event: PointerEvent<HTMLElement>) => void };
  /** Spread on the handle of one edge or corner. */
  resizeHandle: (edge: ResizeEdge) => { onPointerDown: (event: PointerEvent<HTMLElement>) => void; "data-edge": ResizeEdge };
  /** For a focusable grip: arrows move the box, Shift + arrows resize it. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Moving and resizing a box fixed on the viewport with native pointer events. The box always
 * stays wholly visible: `rect` is clamped to the viewport, again whenever the window is
 * resized, but only what the user does is reported to `onCommit` (at the end of a gesture, or
 * per key press), so a narrow window never overwrites the stored size. Only the first pointer
 * of a gesture counts; Escape or a cancelled pointer puts the box back where the gesture began.
 * The window's own listeners follow the pointer, so the gesture keeps working where pointer
 * capture is unavailable; the caller covers the page while `active` is set, so frames under
 * the pointer cannot swallow its events.
 */
export function useFloatingBox(options: { rect: BoxRect; minWidth: number; minHeight: number; onCommit: (rect: BoxRect) => void }): FloatingBox {
  const { minWidth, minHeight } = options;
  const [viewport, setViewport] = useState(viewportNow);
  const [live, setLive] = useState<BoxRect | undefined>(undefined);
  const [active, setActive] = useState<FloatingBox["active"]>(undefined);
  const gesture = useRef<Gesture | undefined>(undefined);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const commitRef = useRef(options.onCommit);
  commitRef.current = options.onCommit;

  useEffect(() => {
    const onResize = (): void => setViewport(viewportNow());
    window.addEventListener("resize", onResize);
    // The window may have changed between the first render and this effect.
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const box = clampBox(live ?? options.rect, viewport, minWidth, minHeight);
  const boxRef = useRef(box);
  boxRef.current = box;

  const end = useCallback((commit: boolean): void => {
    const current = gesture.current;
    if (current === undefined) return;
    gesture.current = undefined;
    current.stop();
    try {
      if (current.element.hasPointerCapture?.(current.pointerId) === true) current.element.releasePointerCapture(current.pointerId);
    } catch {
      // The element may already be gone; its capture went with it.
    }
    setLive(undefined);
    setActive(undefined);
    if (commit && !sameBox(current.latest, current.start)) commitRef.current(current.latest);
  }, []);

  // A gesture never outlives the component: its window listeners go with it.
  useEffect(() => () => end(false), [end]);

  const begin = (event: PointerEvent<HTMLElement>, kind: "move" | ResizeEdge): void => {
    if (event.button !== 0 || gesture.current !== undefined) return;
    // React bubbles events from portaled content (a menu opened from a button on the handle)
    // through the handle, although that content is elsewhere in the DOM: only a press on the
    // handle's own elements may start a gesture, or it would capture the pointer and swallow
    // the menu's clicks.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (kind === "move") {
      const hit = event.target instanceof Element ? event.target.closest(NO_DRAG_SELECTOR) : null;
      if (hit !== null && event.currentTarget.contains(hit)) return;
    }
    // No text selection or focus change while dragging.
    event.preventDefault();
    const start = boxRef.current;
    const onMove = (move: globalThis.PointerEvent): void => {
      const current = gesture.current;
      if (current === undefined || move.pointerId !== current.pointerId) return;
      const dx = move.clientX - current.x;
      const dy = move.clientY - current.y;
      const view = viewportRef.current;
      current.latest =
        current.kind === "move"
          ? clampBox({ ...current.start, left: current.start.left + dx, top: current.start.top + dy }, view, minWidth, minHeight)
          : resizeBox(current.start, current.kind, dx, dy, view, minWidth, minHeight);
      setLive(current.latest);
    };
    const onUp = (up: globalThis.PointerEvent): void => {
      if (up.pointerId === gesture.current?.pointerId) end(true);
    };
    const onCancel = (cancel: globalThis.PointerEvent): void => {
      if (cancel.pointerId === gesture.current?.pointerId) end(false);
    };
    const onKey = (key: globalThis.KeyboardEvent): void => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    // Capture phase: Escape ends the gesture before anything else on the page reacts to it.
    window.addEventListener("keydown", onKey, true);
    const element = event.currentTarget;
    gesture.current = {
      pointerId: event.pointerId,
      kind,
      x: event.clientX,
      y: event.clientY,
      start,
      latest: start,
      element,
      stop: () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
      },
    };
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // Not capturable (a synthetic pointer): the window listeners still follow it.
    }
    setActive(kind);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (gesture.current !== undefined) return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP_PX, 0], ArrowRight: [KEY_STEP_PX, 0], ArrowUp: [0, -KEY_STEP_PX], ArrowDown: [0, KEY_STEP_PX] };
    const delta = step[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const [dx, dy] = delta;
    const next = event.shiftKey
      ? resizeBox(box, dx === 0 ? "s" : "e", dx, dy, viewport, minWidth, minHeight)
      : clampBox({ ...box, left: box.left + dx, top: box.top + dy }, viewport, minWidth, minHeight);
    if (!sameBox(next, box)) options.onCommit(next);
  };

  return {
    box,
    active,
    moveHandle: { onPointerDown: (event) => begin(event, "move") },
    resizeHandle: (edge) => ({ onPointerDown: (event) => begin(event, edge), "data-edge": edge }),
    onKeyDown,
  };
}
