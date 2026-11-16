import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import { captureAnchor, restoreAnchor as restoreDomAnchor, ROW_KEY_ATTRIBUTE, TOLERANCE_PX, type ScrollAnchor } from "./scroll-anchor.ts";

/** Below this many rows everything renders; long transcripts switch to windowing. */
const VIRTUALIZE_FROM_ROWS = 150;

/** Upper bound on the animation frames a restored anchor keeps being corrected over, should the rows never settle. */
const RESTORE_MAX_FRAMES = 30;
/** Consecutive frames the anchor row has to be mounted and in place before the correction ends. */
const RESTORE_STABLE_FRAMES = 2;

/**
 * Records the mounted rows' sizes straight from the layout. The virtualizer's own paths miss
 * some: `measureElement` skips rows while the list counts as scrolling and hands back the
 * remembered size of a row it measured before, and the resize observer only reports after the
 * next layout. Without scroll compensation: the caller places the anchor itself, and
 * compensating here would write the scroll position, and flush a render, once per row.
 */
function measureMountedRows(virtualizer: Virtualizer<HTMLDivElement, Element>, box: HTMLElement): void {
  const compensate = virtualizer.shouldAdjustScrollPositionOnItemSizeChange;
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  try {
    for (const node of Array.from(box.children)) virtualizer.resizeItem(virtualizer.indexFromElement(node), Math.round(node.getBoundingClientRect().height));
  } finally {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = compensate;
  }
}

/**
 * How a restore loop ended: `settled` in place; `edge` stopped short at the top or the end of
 * the list; `capped` still moving at the frame limit; `cancelled` ended by another scroll, a
 * newer restore or the user's input; `missing` the row (or the sentence) is not there.
 */
export type RestoreLoopResult = "settled" | "edge" | "capped" | "cancelled" | "missing";

/** Input on the list that means the user has taken over the scroll position. */
const USER_INPUT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * The rect of an element's first line: its first client rect that takes height, else its
 * bounding box. A sentence wrapping over lines has one rect per line; its first line is what a
 * reader sees as "where the sentence starts".
 */
export function firstLineRect(element: Element): DOMRect {
  for (const rect of Array.from(element.getClientRects())) if (rect.height > 0) return rect;
  return element.getBoundingClientRect();
}

/** The `[data-segment-id]` element for `segmentId` inside `row`; compared by attribute, ids may hold any character. */
function sentenceIn(row: Element, segmentId: string): Element | undefined {
  return Array.from(row.querySelectorAll("[data-segment-id]")).find((element) => element.getAttribute("data-segment-id") === segmentId);
}

/** Imperative scrolling for controls outside the list (a chapter outline, jump-to-end buttons). */
export interface VirtualRowsHandle {
  /** `start` puts the row at the top of the list; `center` (the default) centres it. Ends a running restore. */
  scrollToIndex(index: number, align?: "start" | "center"): void;
  /** Ends a running restore. */
  scrollToTop(): void;
  /** Ends a running restore. */
  scrollToBottom(): void;
  /**
   * The first visible row (by `keyOf`) and its top edge's distance from the viewport top, to
   * hand back to `restoreAnchor` after the rows' sizes changed. `undefined` for an empty list.
   */
  anchor(): ScrollAnchor | undefined;
  /**
   * Scrolls so the anchor's row sits at the same distance from the viewport top again. Call it
   * after the change has rendered (a layout effect): a windowed list measures its mounted rows
   * again and keeps correcting over the next frames, until the anchor row is mounted and in
   * place, as the rows around it settle their sizes. Ends a running restore; `onDone` reports
   * how this one ended.
   */
  restoreAnchor(anchor: ScrollAnchor, onDone?: (result: RestoreLoopResult) => void): void;
  /**
   * Scrolls so the first line of the sentence `segmentId`, inside the row `rowKey`, sits
   * `offset` px below the viewport top (negative: the sentence starts above it). Corrects over
   * the next frames like `restoreAnchor`. Ends a running restore; `onDone` reports how this one ended.
   */
  restoreSegment(target: { rowKey: string; segmentId: string; offset: number }, onDone?: (result: RestoreLoopResult) => void): void;
  /** Ends a running restore, reporting `cancelled`. */
  cancelRestore(): void;
}

/** The restore loop currently correcting the scroll position; at most one runs at a time. */
interface RestoreLoop {
  frame: number | undefined;
  onDone: ((result: RestoreLoopResult) => void) | undefined;
  detach: () => void;
}

/**
 * A scrolling list that windows long content (a 5-hour lecture has thousands of sentences)
 * and scrolls `scrollToIndex` into view whenever it changes.
 */
export function VirtualRows<T>(props: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  estimateSize: number;
  scrollToIndex?: number | undefined;
  /**
   * Rows (by `keyOf`) kept mounted even when they scroll out of the window, so a text selection
   * keeps the nodes its two ends sit in however far the list scrolls. By key, not by index: the
   * rows stay the same ones when rows are added or removed around them.
   */
  pinnedKeys?: readonly string[] | undefined;
  /** Receives the scrolling element. */
  scrollerRef?: ((element: HTMLDivElement | null) => void) | undefined;
  className?: string;
  testId?: string;
  ref?: Ref<VirtualRowsHandle> | undefined;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const windowed = props.items.length >= VIRTUALIZE_FROM_ROWS;
  // The keys as one string, so a new array holding the same keys does not look like a change.
  const pinnedKeyList = (props.pinnedKeys ?? []).join("\n");
  const rows = props.items;
  // Callers rebuild `keyOf` on every render; read at call time, it does not make the indexes look stale.
  const rowKey = useRef(props.keyOf);
  rowKey.current = props.keyOf;
  const pinned = useMemo(() => {
    if (pinnedKeyList === "") return [];
    const wanted = new Set(pinnedKeyList.split("\n"));
    const found: number[] = [];
    rows.forEach((item, index) => {
      if (wanted.has(rowKey.current(item))) found.push(index);
    });
    return found;
  }, [pinnedKeyList, rows]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      const extra = pinned.filter((index) => index < range.count && !indexes.includes(index));
      return extra.length === 0 ? indexes : [...indexes, ...extra].sort((a, b) => a - b);
    },
    [pinned],
  );
  const virtualizer = useVirtualizer({
    count: windowed ? props.items.length : 0,
    getScrollElement: () => parent.current,
    estimateSize: () => props.estimateSize,
    overscan: 8,
    rangeExtractor,
  });
  const { scrollerRef } = props;
  // Stable while the caller's callback is: a ref that changed every render would be detached and attached again each time.
  const setScroller = useCallback(
    (element: HTMLDivElement | null) => {
      parent.current = element;
      scrollerRef?.(element);
    },
    [scrollerRef],
  );
  const target = props.scrollToIndex;
  const rowsBox = useRef<HTMLDivElement>(null);
  // Props the handle reads at call time: it is created once per list mode, not per render.
  const latest = useRef({ items: props.items, keyOf: props.keyOf });
  latest.current = { items: props.items, keyOf: props.keyOf };
  // One owner of the scroll position: two loops correcting it at once would fight each other,
  // and a loop still correcting after the reader (or the user) moved elsewhere would drag the
  // view back.
  const restoreLoop = useRef<RestoreLoop | undefined>(undefined);
  const endRestore = useCallback((result: RestoreLoopResult, notify = true): void => {
    const loop = restoreLoop.current;
    if (loop === undefined) return;
    restoreLoop.current = undefined;
    if (loop.frame !== undefined) cancelAnimationFrame(loop.frame);
    loop.detach();
    if (notify) loop.onDone?.(result);
  }, []);
  const startRestore = useCallback(
    (list: HTMLElement, onDone: ((result: RestoreLoopResult) => void) | undefined): RestoreLoop => {
      endRestore("cancelled");
      const loop: RestoreLoop = { frame: undefined, onDone, detach: () => undefined };
      // Listened for only while the loop runs; capture, so a row that stops the event still ends it.
      const interrupt = (): void => {
        if (restoreLoop.current === loop) endRestore("cancelled");
      };
      for (const type of USER_INPUT_EVENTS) list.addEventListener(type, interrupt, { capture: true, passive: true });
      loop.detach = () => {
        for (const type of USER_INPUT_EVENTS) list.removeEventListener(type, interrupt, { capture: true });
      };
      restoreLoop.current = loop;
      return loop;
    },
    [endRestore],
  );
  // Unmounting stops the loop quietly: whoever asked for it is going away too.
  useEffect(() => () => endRestore("cancelled", false), [endRestore]);
  // Whether the handle scrolled while the current commit was being laid out. The caller's
  // layout effects run after this list's own and before its passive effects: a scroll they make
  // (back from a filter to a sentence, a kept anchor) answers the very change that also moved
  // `scrollToIndex` (the same row at a new index), and centring that row afterwards would undo it.
  const scrolledInCommit = useRef(false);
  useLayoutEffect(() => {
    scrolledInCommit.current = false;
  });
  // Windowed rows go through the virtualizer: its scroll methods keep correcting the target
  // as rows are measured, so a jump lands on the real position rather than the estimate.
  useImperativeHandle(
    props.ref,
    () => ({
      scrollToIndex(index, align = "center") {
        scrolledInCommit.current = true;
        endRestore("cancelled");
        if (windowed) {
          virtualizer.scrollToIndex(index, { align });
          return;
        }
        const element = parent.current?.querySelector(`[data-row-index="${index}"]`);
        if (!(element instanceof HTMLElement) || parent.current === null) return;
        if (align === "start") {
          // Only the list scrolls; scrollIntoView would also scroll every scrollable ancestor.
          parent.current.scrollTop += element.getBoundingClientRect().top - parent.current.getBoundingClientRect().top;
        } else if (typeof element.scrollIntoView === "function") {
          element.scrollIntoView({ block: "center" });
        }
      },
      scrollToTop() {
        scrolledInCommit.current = true;
        endRestore("cancelled");
        if (windowed) virtualizer.scrollToOffset(0);
        else if (parent.current !== null) parent.current.scrollTop = 0;
      },
      scrollToBottom() {
        scrolledInCommit.current = true;
        endRestore("cancelled");
        if (windowed) virtualizer.scrollToEnd();
        else if (parent.current !== null) parent.current.scrollTop = parent.current.scrollHeight;
      },
      anchor() {
        // Read from the layout in both modes: it is what the user sees, and the windowed rows
        // sit below the list's padding, which the virtualizer's own positions leave out.
        return parent.current === null ? undefined : captureAnchor(parent.current);
      },
      restoreAnchor(anchor, onDone) {
        const list = parent.current;
        if (list === null) {
          onDone?.("missing");
          return;
        }
        scrolledInCommit.current = true;
        endRestore("cancelled");
        if (!windowed) {
          // Evaluated apart from the call: `onDone?.(…)` would skip its argument without a callback.
          const found = restoreDomAnchor(list, anchor);
          onDone?.(found ? "settled" : "missing");
          return;
        }
        const { items, keyOf } = latest.current;
        const index = items.findIndex((item) => keyOf(item) === anchor.key);
        const box = rowsBox.current;
        if (index < 0 || box === null) {
          onDone?.("missing");
          return;
        }
        const loop = startRestore(list, onDone);
        // The scroll position is computed from the virtualizer's positions rather than read off
        // the anchor row: right after the change the row is still drawn where the old sizes put
        // it, or not mounted at all. Sizes are kept, not forgotten: the rows out of the window
        // keep the sizes they had (the resize observer corrects each as it mounts again), so the
        // positions around the anchor shift by no more than the mounted rows grew or shrank and
        // the window stays on it.
        let frames = 0;
        let stable = 0;
        let previousGoal: number | undefined;
        const place = (): void => {
          if (restoreLoop.current !== loop) return;
          loop.frame = undefined;
          measureMountedRows(virtualizer, box);
          // Reading the total makes the virtualizer rebuild its positions now, not at its next render.
          virtualizer.getTotalSize();
          const start = virtualizer.measurementsCache[index]?.start;
          if (start === undefined) {
            endRestore("missing");
            return;
          }
          // Rows are positioned inside the list's border and padding.
          const origin = list.clientTop + box.offsetTop;
          const goal = origin + start - anchor.offset;
          const before = list.scrollTop;
          if (Math.abs(goal - before) >= TOLERANCE_PX) list.scrollTop = goal;
          const row = box.querySelector<HTMLElement>(`:scope > [data-row-index="${index}"]`);
          // Done once the row is mounted and drawn where the virtualizer now puts it, and neither
          // the sizes nor the scroll position moved for a few frames. A scroll position the list
          // cannot reach (the end of the text) counts as reached once writing it changes nothing.
          const drawn = row !== null && Math.abs(row.getBoundingClientRect().top - list.getBoundingClientRect().top - (origin + start - list.scrollTop)) < TOLERANCE_PX;
          stable = drawn && goal === previousGoal && list.scrollTop === before ? stable + 1 : 0;
          previousGoal = goal;
          frames += 1;
          if (stable >= RESTORE_STABLE_FRAMES) endRestore("settled");
          else if (frames >= RESTORE_MAX_FRAMES) endRestore("capped");
          else loop.frame = requestAnimationFrame(place);
        };
        place();
      },
      restoreSegment(target, onDone) {
        const list = parent.current;
        if (list === null) {
          onDone?.("missing");
          return;
        }
        scrolledInCommit.current = true;
        endRestore("cancelled");
        const { items, keyOf } = latest.current;
        const index = items.findIndex((item) => keyOf(item) === target.rowKey);
        const box = windowed ? rowsBox.current : list;
        if (index < 0 || box === null) {
          onDone?.("missing");
          return;
        }
        const loop = startRestore(list, onDone);
        let frames = 0;
        let stable = 0;
        // One loop for both steps: first the row is brought into the window from the
        // virtualizer's positions (it may not be mounted yet), then, once it is, the sentence's
        // first line is put at `offset`. Lines inside a row wrap and settle late (fonts, notes),
        // so the sentence itself is measured each frame rather than derived from the row.
        const place = (): void => {
          if (restoreLoop.current !== loop) return;
          loop.frame = undefined;
          const listTop = list.getBoundingClientRect().top;
          let rowGoal: number | undefined;
          let drawn = true;
          if (windowed) {
            measureMountedRows(virtualizer, box);
            virtualizer.getTotalSize();
            const start = virtualizer.measurementsCache[index]?.start;
            if (start !== undefined) {
              // Rows are positioned inside the list's border and padding.
              const origin = list.clientTop + box.offsetTop;
              rowGoal = origin + start - target.offset;
              const mounted = box.querySelector<HTMLElement>(`:scope > [data-row-index="${index}"]`);
              // A row still drawn where older sizes put it moves once the list renders again.
              drawn = mounted !== null && Math.abs(mounted.getBoundingClientRect().top - listTop - (origin + start - list.scrollTop)) < TOLERANCE_PX;
            }
          }
          const row = box.querySelector<HTMLElement>(`:scope > [data-row-index="${index}"]`);
          if (!windowed && row !== null) rowGoal = list.scrollTop + row.getBoundingClientRect().top - listTop - target.offset;
          const sentence = row === null ? undefined : sentenceIn(row, target.segmentId);
          const before = list.scrollTop;
          const goal = sentence === undefined ? rowGoal : before + firstLineRect(sentence).top - listTop - target.offset;
          const deviation = goal === undefined ? 0 : goal - before;
          const max = list.scrollHeight - list.clientHeight;
          // The list cannot scroll any further the way the sentence would need it to.
          const atEdge = (deviation <= -TOLERANCE_PX && before <= 0) || (deviation >= TOLERANCE_PX && before >= max - TOLERANCE_PX);
          const inPlace = sentence !== undefined && drawn && (Math.abs(deviation) < TOLERANCE_PX || atEdge);
          stable = inPlace ? stable + 1 : 0;
          if (!inPlace && goal !== undefined && Math.abs(deviation) >= TOLERANCE_PX) list.scrollTop = goal;
          frames += 1;
          if (stable >= RESTORE_STABLE_FRAMES) endRestore(atEdge ? "edge" : "settled");
          // A sentence that never showed up in its row is not there to restore.
          else if (frames >= RESTORE_MAX_FRAMES) endRestore(sentence === undefined ? "missing" : "capped");
          else loop.frame = requestAnimationFrame(place);
        };
        place();
      },
      cancelRestore() {
        endRestore("cancelled");
      },
    }),
    [virtualizer, windowed, endRestore, startRestore],
  );

  useEffect(() => {
    if (target === undefined || target < 0 || scrolledInCommit.current) return;
    // The reader's own navigation: a restore still correcting would pull the view back.
    endRestore("cancelled");
    if (windowed) {
      virtualizer.scrollToIndex(target, { align: "center" });
      return;
    }
    const element = parent.current?.querySelector(`[data-row-index="${target}"]`);
    if (element instanceof HTMLElement && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center" });
    }
  }, [target, windowed, virtualizer, endRestore]);

  return (
    <div ref={setScroller} className={`overflow-auto ${props.className ?? ""}`} data-testid={props.testId}>
      {windowed ? (
        <div ref={rowsBox} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = props.items[row.index] as T;
            return (
              <div
                key={props.keyOf(item)}
                ref={virtualizer.measureElement}
                data-index={row.index}
                data-row-index={row.index}
                {...{ [ROW_KEY_ATTRIBUTE]: props.keyOf(item) }}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {props.render(item, row.index)}
              </div>
            );
          })}
        </div>
      ) : (
        props.items.map((item, index) => (
          <div key={props.keyOf(item)} data-row-index={index} {...{ [ROW_KEY_ATTRIBUTE]: props.keyOf(item) }}>
            {props.render(item, index)}
          </div>
        ))
      )}
    </div>
  );
}
