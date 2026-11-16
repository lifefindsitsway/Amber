import { INITIAL_SCROLL_ATTRIBUTE, type InitialScroll, type InitialScrollOutcome } from "./edit-position.ts";

/** Pixels of deviation below which the row counts as in place. */
const ALIGN_TOLERANCE_PX = 1;
/** Consecutive frames the row has to stay in place (or against an edge) before the loop ends. */
const STABLE_FRAMES = 3;
/** Frames after which the loop gives up aligning exactly and only makes sure the row is in view. */
const MAX_FRAMES = 12;

/** The list and the target row as laid out right now. */
export interface InitialScrollGeometry {
  /** The row's top edge's distance below the list's visible top (negative when above it). */
  rowTop: number;
  rowHeight: number;
  /** The list's visible height. */
  clientHeight: number;
  scrollTop: number;
  maxScrollTop: number;
}

/** What the opening scroll needs from its surroundings; the DOM in the editor, fakes in tests. */
export interface InitialScrollEnv {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  /** `undefined` once the row is gone (filtered away, the draft replaced): the loop then stops. */
  measure: () => InitialScrollGeometry | undefined;
  scrollTo: (top: number) => void;
  /** Resolves when the web fonts have loaded; `undefined` when they already have, or there are none to wait for. */
  fontsReady: () => Promise<unknown> | undefined;
  /** Whether the focus sits in an input, textarea, select or editable element. */
  isEditableFocused: () => boolean;
  /** Calls `onInput` on the user's own scrolling or input; returns the unsubscribe. */
  listen: (onInput: () => void) => () => void;
  /** Puts the cursor in the row; absent = the caller did not ask for it. */
  focus?: (() => void) | undefined;
  /** Called once, when the loop ends for good. */
  onDone: (outcome: InitialScrollOutcome) => void;
}

export interface InitialScrollRun {
  /** Stops the loop without reporting anything (unmount). */
  dispose(): void;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/**
 * Scrolls a list so a row's top sits `offset` px below its visible top, correcting over the
 * following frames. One write is not enough: rows off screen are skipped by layout and only get
 * their real heights once near the viewport, and panels above the list can open meanwhile and
 * shrink it, so every frame measures again. The goal is clamped so the row stays in view where
 * the list is tall enough.
 *
 * Ends `settled` (in place for a few frames), `edge` (the list cannot scroll further that way),
 * `capped` (never steady: the row is at least brought into view) or `cancelled` (the user
 * scrolled, typed, pointed or touched, or the focus is in an editable element: their intent
 * wins and nothing moves or takes the focus any more). Web fonts still loading when a round
 * ends change the line heights later, so one more round runs once they are ready.
 *
 * The first frame runs synchronously, so a caller in a layout effect places the row before the
 * first paint.
 */
export function runInitialScroll(offset: number, env: InitialScrollEnv): InitialScrollRun {
  let frame: number | undefined;
  let finished = false;
  let fontsWaited = false;
  let frames = 0;
  let stable = 0;

  const stop = (): void => {
    finished = true;
    if (frame !== undefined) env.cancelFrame(frame);
    frame = undefined;
    unlisten();
  };

  const end = (outcome: InitialScrollOutcome, inView: boolean): void => {
    if (finished) return;
    stop();
    const placed = outcome === "settled" || outcome === "edge" || (outcome === "capped" && inView);
    // Focus the user already put somewhere editable is theirs to keep.
    if (placed && env.focus !== undefined && !env.isEditableFocused()) env.focus();
    env.onDone(outcome);
  };

  const roundEnded = (outcome: InitialScrollOutcome, inView: boolean): void => {
    const fonts = fontsWaited ? undefined : env.fontsReady();
    if (fonts === undefined) {
      end(outcome, inView);
      return;
    }
    fontsWaited = true;
    const again = (): void => {
      if (finished) return;
      frames = 0;
      stable = 0;
      pass();
    };
    fonts.then(again, again);
  };

  const goalOf = (geometry: InitialScrollGeometry): number => clamp(offset, 0, Math.max(0, geometry.clientHeight - geometry.rowHeight));

  /** The row wholly visible, or, taller than the list, its top at the list's top. */
  const inViewOf = (geometry: InitialScrollGeometry): boolean =>
    geometry.rowTop > -ALIGN_TOLERANCE_PX && geometry.rowTop + Math.min(geometry.rowHeight, geometry.clientHeight) < geometry.clientHeight + ALIGN_TOLERANCE_PX;

  function pass(): void {
    frame = undefined;
    if (finished) return;
    if (env.isEditableFocused()) {
      end("cancelled", false);
      return;
    }
    const geometry = env.measure();
    if (geometry === undefined) {
      end("cancelled", false);
      return;
    }
    frames += 1;
    const deviation = geometry.rowTop - goalOf(geometry);
    let kind: "settled" | "edge" | undefined;
    if (Math.abs(deviation) < ALIGN_TOLERANCE_PX) {
      kind = "settled";
    } else {
      const wanted = clamp(geometry.scrollTop + deviation, 0, geometry.maxScrollTop);
      // Already at the top or the bottom, the rest pointing beyond it.
      if (Math.abs(wanted - geometry.scrollTop) < ALIGN_TOLERANCE_PX) kind = "edge";
      else env.scrollTo(wanted);
    }
    // Steady at an edge counts too: rows still settling their heights can move the bottom edge.
    stable = kind === undefined ? 0 : stable + 1;
    if (kind !== undefined && stable >= STABLE_FRAMES) {
      roundEnded(kind, true);
      return;
    }
    if (frames >= MAX_FRAMES) {
      // This frame already wrote the clamped goal; whether the row really is in view decides the focus.
      const after = env.measure();
      roundEnded("capped", after !== undefined && inViewOf(after));
      return;
    }
    frame = env.requestFrame(pass);
  }

  const unlisten = env.listen(() => end("cancelled", false));
  pass();
  return { dispose: stop };
}

/** Events that mean the user is doing something themselves. */
const POINTER_EVENTS = ["wheel", "pointerdown", "mousedown", "touchstart"] as const;

function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  return element.isContentEditable || element.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Opens the editor's list (`list`, the scrolling element inside `editor`) on the row carrying
 * `data-sentence-index="<index>"`, writing the outcome on the list as `data-initial-scroll`.
 * Returns `undefined`, and writes nothing, when that row is not rendered (out of range or
 * filtered away).
 */
export function startInitialScroll(editor: HTMLElement, list: HTMLElement, target: InitialScroll): InitialScrollRun | undefined {
  const rowOf = (): HTMLElement | null => list.querySelector<HTMLElement>(`:scope > [data-sentence-index="${target.index}"]`);
  if (rowOf() === null) return undefined;
  const doc = editor.ownerDocument;
  return runInitialScroll(target.offset, {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    measure: () => {
      const row = rowOf();
      if (row === null) return undefined;
      const rect = row.getBoundingClientRect();
      // The visible top is inside the list's border; its padding scrolls with the rows.
      const top = list.getBoundingClientRect().top + list.clientTop;
      return {
        rowTop: rect.top - top,
        rowHeight: rect.height,
        clientHeight: list.clientHeight,
        scrollTop: list.scrollTop,
        maxScrollTop: Math.max(0, list.scrollHeight - list.clientHeight),
      };
    },
    scrollTo: (top) => {
      list.scrollTop = top;
    },
    fontsReady: () => {
      const fonts: FontFaceSet | undefined = doc.fonts;
      return fonts === undefined || fonts.status === "loaded" ? undefined : fonts.ready;
    },
    isEditableFocused: () => isEditable(doc.activeElement),
    listen: (onInput) => {
      const options = { capture: true, passive: true };
      for (const type of POINTER_EVENTS) editor.addEventListener(type, onInput, options);
      // Keys go to the focused element, which right after opening is usually the page body,
      // outside the editor: a key anywhere counts.
      doc.addEventListener("keydown", onInput, options);
      return () => {
        for (const type of POINTER_EVENTS) editor.removeEventListener(type, onInput, options);
        doc.removeEventListener("keydown", onInput, options);
      };
    },
    focus: target.focus
      ? () => {
          const input = rowOf()?.querySelector("textarea");
          if (input === null || input === undefined) return;
          // The list is already where it should be; letting focus scroll would move it again.
          input.focus({ preventScroll: true });
          input.setSelectionRange(0, 0);
        }
      : undefined,
    onDone: (outcome) => list.setAttribute(INITIAL_SCROLL_ATTRIBUTE, outcome),
  });
}
