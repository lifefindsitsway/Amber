import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { READER_LOCATE_PULSE_MS, READER_LOCATE_VIEWPORT_RATIO } from "../../../shared/defaults.ts";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { segmentsAt } from "./content-data.ts";
import { rowIndexOfSegment, type FilteredRow } from "./speaker-filter.ts";
import type { RestoreLoopResult, VirtualRowsHandle } from "./virtual-rows.tsx";

/**
 * The sentence 「定位到播放位置」 scrolls to at `ms`: the one the reader highlights as playing
 * (with overlapping sentences, the reader's own primary: the pinned one while it covers `ms`,
 * else the one that started last). Between sentences nothing is highlighted; the sentence whose
 * time span lies nearest to `ms` is taken instead, the later one when two are equally near, as
 * playback is heading for it. `undefined` without a time or without sentences; 0 ms is a time.
 */
export function locateTarget(segments: readonly TranscriptSegmentDto[], ms: number | undefined, pinnedId?: string): TranscriptSegmentDto | undefined {
  if (ms === undefined) return undefined;
  const { primary } = segmentsAt(segments, ms, pinnedId);
  if (primary !== undefined) return primary;
  let nearest: TranscriptSegmentDto | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    // End-exclusive like the highlight: a time at a sentence's end is just past it.
    const away = ms < segment.startMs ? segment.startMs - ms : Math.max(0, ms - segment.endMs);
    // `<=`: in reading order, a tie goes to the later sentence.
    if (away <= distance) {
      nearest = segment;
      distance = away;
    }
  }
  return nearest;
}

/**
 * Whether the locate button shows: `absent` when the player cannot tell the time (an iframe
 * without time tracking, no media, a hidden player), `waiting` while it can but has not reported
 * a time yet (nothing played or sought), `ready` otherwise.
 */
export type LocateAvailability = "absent" | "waiting" | "ready";

export function locateAvailability(tracking: boolean, ms: number | undefined): LocateAvailability {
  if (!tracking) return "absent";
  return ms === undefined ? "waiting" : "ready";
}

/** How far below the reading area's top the located sentence's first line is put, in px. */
export function locateOffset(viewportHeight: number): number {
  return viewportHeight * READER_LOCATE_VIEWPORT_RATIO;
}

/** Input on the reading area that means the user has gone somewhere else meanwhile. */
const CANCEL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

interface Waiting {
  segmentId: string;
  revisionId: string;
  /** The 「只看」 selection the locate was asked under; any other one means the filter moved. */
  filterKey: string;
  detach: () => void;
}

/**
 * A locate whose sentence the 「只看」 filter hides: the filter is cleared, and the scroll waits
 * for the rows that show the sentence again. One-shot, and only one at a time: registering
 * another replaces it. It is dropped when the user scrolls (wheel, touch, keys) or presses in
 * the reading area meanwhile, when the caller reports another navigation (`cancel`), and when
 * the rows next seen belong to another revision or another filter selection.
 */
export class PendingLocate {
  private waiting: Waiting | undefined;

  /** The sentence waited for, if any. */
  get segmentId(): string | undefined {
    return this.waiting?.segmentId;
  }

  register(input: { segmentId: string; revisionId: string; filterKey: string; area: EventTarget | null }): void {
    this.cancel();
    const { area } = input;
    const entry: Waiting = { segmentId: input.segmentId, revisionId: input.revisionId, filterKey: input.filterKey, detach: () => undefined };
    // Capture, so a control in the reading area that stops the event still cancels.
    const interrupt = (): void => {
      if (this.waiting === entry) this.cancel();
    };
    if (area !== null) {
      for (const type of CANCEL_EVENTS) area.addEventListener(type, interrupt, { capture: true, passive: true });
      entry.detach = () => {
        for (const type of CANCEL_EVENTS) area.removeEventListener(type, interrupt, { capture: true });
      };
    }
    this.waiting = entry;
  }

  /**
   * Called once the rows have rendered: the sentence to scroll to now, which spends the locate,
   * or `undefined` while it still waits for the filter to clear (or once it has been dropped).
   */
  take(view: { revisionId: string; filterKey: string; shows: (segmentId: string) => boolean }): string | undefined {
    const entry = this.waiting;
    if (entry === undefined) return undefined;
    if (view.revisionId !== entry.revisionId) {
      this.cancel();
      return undefined;
    }
    if (view.shows(entry.segmentId)) {
      this.cancel();
      return entry.segmentId;
    }
    // The filter changed and still hides the sentence: the user picked speakers again (or the
    // sentence is gone). Unchanged, the clear has not reached the rows yet.
    if (view.filterKey !== entry.filterKey) this.cancel();
    return undefined;
  }

  cancel(): void {
    const entry = this.waiting;
    this.waiting = undefined;
    entry?.detach();
  }
}

/** Marks the sentence a locate arrived at while its background fades; the style sheet draws it. */
export const LOCATE_PULSE_ATTRIBUTE = "data-locate-pulse";
/** The fade's length, handed to the style sheet so it has no number of its own. */
const PULSE_DURATION_PROPERTY = "--reader-locate-pulse";

/**
 * The arrival feedback: the sentence's background fades once. Set straight on the element (the
 * rows do not re-render for it) and removed after the fade, or at once by the next pulse, so a
 * row that unmounts meanwhile takes nothing with it and a later mount of it starts clean.
 */
export class LocatePulse {
  private current: { element: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;

  start(element: HTMLElement): void {
    this.stop();
    element.style.setProperty(PULSE_DURATION_PROPERTY, `${READER_LOCATE_PULSE_MS}ms`);
    // An animation only starts again once a style without it has been computed in between.
    void element.offsetWidth;
    element.setAttribute(LOCATE_PULSE_ATTRIBUTE, "");
    const timer = setTimeout(() => this.stop(), READER_LOCATE_PULSE_MS);
    this.current = { element, timer };
  }

  stop(): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    clearTimeout(current.timer);
    current.element.removeAttribute(LOCATE_PULSE_ATTRIBUTE);
    current.element.style.removeProperty(PULSE_DURATION_PROPERTY);
  }
}

/** The `[data-segment-id]` element of a sentence inside the scroller; compared by attribute, ids may hold any character. */
function sentenceElement(scroller: HTMLElement, segmentId: string): HTMLElement | undefined {
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-segment-id]")).find((element) => element.getAttribute("data-segment-id") === segmentId);
}

/** What the reader hands the locate button; `undefined` when the button is not shown. */
export interface LocateButton {
  /** No time yet: the button holds its place but does nothing. */
  waiting: boolean;
  /** 「只看」 hides the target sentence: the locate shows every speaker again first. */
  showsAll: boolean;
  onLocate: () => void;
}

/**
 * 「定位到播放位置」 for the reading view: the button's state and its action. The scroll goes
 * through the list's single scroll owner, so it ends any restore still correcting the position
 * and is itself ended by the user's input or a newer scroll. It neither seeks, nor selects, nor
 * touches the address.
 */
export function useReaderLocate(input: {
  reader: RefObject<VirtualRowsHandle | null>;
  /** The reading area: a press or scroll input in it drops a locate still waiting for the filter. */
  area: HTMLElement | null;
  /** The scrolling element, whose height the sentence is placed against. */
  scroller: () => HTMLElement | null;
  revisionId: string;
  segments: readonly TranscriptSegmentDto[];
  tracking: boolean;
  time: number | undefined;
  pinnedId: string | undefined;
  /** The rows on screen, after the 「只看」 filter. */
  rows: readonly FilteredRow[];
  rowKey: (row: FilteredRow) => string;
  filter: { active: boolean; key: string; clear: () => void };
  /** Called before every locate: it is a navigation of its own, so whatever else was bringing the screen somewhere ends. */
  onNavigate: () => void;
  /** The page's navigation count; a new navigation drops a locate still waiting. */
  navigation: number;
}): { button: LocateButton | undefined; cancel: () => void } {
  const [pending] = useState(() => new PendingLocate());
  const [pulse] = useState(() => new LocatePulse());
  const availability = locateAvailability(input.tracking, input.time);
  const target = availability === "ready" ? locateTarget(input.segments, input.time, input.pinnedId) : undefined;
  const { rows, rowKey, reader, scroller } = input;
  const hidden = target !== undefined && input.filter.active && rowIndexOfSegment(rows, target.id) < 0;

  const scrollTo = (segmentId: string): void => {
    const row = rows[rowIndexOfSegment(rows, segmentId)];
    const list = scroller();
    const handle = reader.current;
    if (row === undefined || list === null || handle === null) return;
    const arrived = (result: RestoreLoopResult): void => {
      if (result !== "settled" && result !== "edge" && result !== "capped") return;
      const element = sentenceElement(list, segmentId);
      if (element !== undefined) pulse.start(element);
    };
    handle.restoreSegment({ rowKey: rowKey(row), segmentId, offset: locateOffset(list.clientHeight) }, arrived);
  };

  // After the filter cleared, the first commit whose rows show the sentence scrolls to it. A
  // layout effect: the scroll lands before the list's own effects, which then leave it alone.
  useLayoutEffect(() => {
    const segmentId = pending.take({ revisionId: input.revisionId, filterKey: input.filter.key, shows: (id) => rowIndexOfSegment(rows, id) >= 0 });
    if (segmentId !== undefined) scrollTo(segmentId);
  });
  // Selecting a sentence anywhere on the page is a navigation; the first run is the mount.
  useEffect(() => {
    pending.cancel();
  }, [pending, input.navigation]);
  useEffect(
    () => () => {
      pending.cancel();
      pulse.stop();
    },
    [pending, pulse],
  );

  const onLocate = (): void => {
    if (target === undefined) return;
    pending.cancel();
    input.onNavigate();
    if (!hidden) {
      scrollTo(target.id);
      return;
    }
    pending.register({ segmentId: target.id, revisionId: input.revisionId, filterKey: input.filter.key, area: input.area });
    input.filter.clear();
  };

  return {
    button: availability === "absent" ? undefined : { waiting: target === undefined, showsAll: hidden, onLocate },
    cancel: () => pending.cancel(),
  };
}
