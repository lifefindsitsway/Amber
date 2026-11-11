import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
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

/** Imperative scrolling for controls outside the list (a chapter outline, jump-to-end buttons). */
export interface VirtualRowsHandle {
  /** `start` puts the row at the top of the list; `center` (the default) centres it. */
  scrollToIndex(index: number, align?: "start" | "center"): void;
  scrollToTop(): void;
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
   * place, as the rows around it settle their sizes.
   */
  restoreAnchor(anchor: ScrollAnchor): void;
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
   * A row kept mounted even when it scrolls out of the window, so a drag selection that
   * started in it keeps its anchor node while the list auto-scrolls.
   */
  pinnedIndex?: number | undefined;
  className?: string;
  testId?: string;
  ref?: Ref<VirtualRowsHandle> | undefined;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const windowed = props.items.length >= VIRTUALIZE_FROM_ROWS;
  const pinned = props.pinnedIndex;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (pinned === undefined || pinned < 0 || pinned >= range.count || indexes.includes(pinned)) return indexes;
      return [...indexes, pinned].sort((a, b) => a - b);
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
  const target = props.scrollToIndex;
  const rowsBox = useRef<HTMLDivElement>(null);
  const restoreFrame = useRef<number | undefined>(undefined);
  // Props the handle reads at call time: it is created once per list mode, not per render.
  const latest = useRef({ items: props.items, keyOf: props.keyOf });
  latest.current = { items: props.items, keyOf: props.keyOf };
  useEffect(
    () => () => {
      if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
    },
    [],
  );
  // Windowed rows go through the virtualizer: its scroll methods keep correcting the target
  // as rows are measured, so a jump lands on the real position rather than the estimate.
  useImperativeHandle(
    props.ref,
    () => ({
      scrollToIndex(index, align = "center") {
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
        if (windowed) virtualizer.scrollToOffset(0);
        else if (parent.current !== null) parent.current.scrollTop = 0;
      },
      scrollToBottom() {
        if (windowed) virtualizer.scrollToEnd();
        else if (parent.current !== null) parent.current.scrollTop = parent.current.scrollHeight;
      },
      anchor() {
        // Read from the layout in both modes: it is what the user sees, and the windowed rows
        // sit below the list's padding, which the virtualizer's own positions leave out.
        return parent.current === null ? undefined : captureAnchor(parent.current);
      },
      restoreAnchor(anchor) {
        const list = parent.current;
        if (list === null) return;
        if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
        restoreFrame.current = undefined;
        if (!windowed) {
          restoreDomAnchor(list, anchor);
          return;
        }
        const { items, keyOf } = latest.current;
        const index = items.findIndex((item) => keyOf(item) === anchor.key);
        const box = rowsBox.current;
        if (index < 0 || box === null) return;
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
          restoreFrame.current = undefined;
          measureMountedRows(virtualizer, box);
          // Reading the total makes the virtualizer rebuild its positions now, not at its next render.
          virtualizer.getTotalSize();
          const start = virtualizer.measurementsCache[index]?.start;
          if (start === undefined) return;
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
          if (stable < RESTORE_STABLE_FRAMES && frames < RESTORE_MAX_FRAMES) restoreFrame.current = requestAnimationFrame(place);
        };
        place();
      },
    }),
    [virtualizer, windowed],
  );

  useEffect(() => {
    if (target === undefined || target < 0) return;
    if (windowed) {
      virtualizer.scrollToIndex(target, { align: "center" });
      return;
    }
    const element = parent.current?.querySelector(`[data-row-index="${target}"]`);
    if (element instanceof HTMLElement && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center" });
    }
  }, [target, windowed, virtualizer]);

  return (
    <div ref={parent} className={`overflow-auto ${props.className ?? ""}`} data-testid={props.testId}>
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
