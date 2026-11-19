import { DANMAKU_FIXED_MS, DANMAKU_ONSCREEN_MAX, DANMAKU_QUEUE_MAX, DANMAKU_SCROLL_MS } from "../../shared/defaults.ts";
import type { DanmakuItem, DanmakuMode } from "../../shared/dto/danmaku.ts";

/**
 * How long an item may wait for a free lane before it is dropped: shown any later it would no
 * longer go with what is being said.
 */
export const DANMAKU_MAX_WAIT_MS = DANMAKU_SCROLL_MS / 4;

/** The picture the danmaku cross, in CSS pixels, and the lane geometry of the current font. */
export interface DanmakuStage {
  width: number;
  height: number;
  /** One line of danmaku text; lanes are stacked at this pitch. */
  laneHeight: number;
  /** The least room between two scrolling items of one lane. */
  gap: number;
}

/** A horizontal band of the picture no new danmaku is placed over (the subtitles), in stage pixels. */
export interface DanmakuBand {
  top: number;
  bottom: number;
}

/** A danmaku on screen. Times are media time; `mode` is how it is shown, which reduced motion may change. */
export interface PlacedDanmaku {
  key: number;
  item: DanmakuItem;
  mode: DanmakuMode;
  /** Top of its lane. */
  y: number;
  width: number;
  /** When it entered: its own time, or later when it waited for a lane. */
  startMs: number;
  durationMs: number;
}

/** What changed on screen: `cleared` removes everything first; `removed` are keys of `PlacedDanmaku`. */
export interface DanmakuChange {
  cleared: boolean;
  added: PlacedDanmaku[];
  removed: number[];
}

interface ScrollTail {
  startMs: number;
  width: number;
  speed: number;
}

/**
 * Decides which danmaku are on screen at a media time and where, without touching the DOM.
 * Items arrive in time order through a bounded queue (DANMAKU_QUEUE_MAX, oldest dropped
 * first; an item that waited DANMAKU_MAX_WAIT_MS is dropped), and at most
 * DANMAKU_ONSCREEN_MAX are on screen. A scrolling item crosses the picture in
 * DANMAKU_SCROLL_MS of media time, so a longer one moves faster; it takes the topmost lane
 * where it neither runs into the tail of the item ahead nor catches up with it before that one
 * has left, and that no top or bottom item is held over. A top or bottom item holds a lane for
 * DANMAKU_FIXED_MS, one no scrolling item is crossing when there is such a lane. No new item is placed on a
 * lane crossing the avoided band. With `staticOnly` (reduced motion) nothing scrolls: scrolling
 * items are shown held at the top instead.
 */
export class DanmakuScheduler {
  private items: readonly DanmakuItem[] = [];
  private cursor = 0;
  private queue: number[] = [];
  private active: PlacedDanmaku[] = [];
  private scrollTails: Array<ScrollTail | undefined> = [];
  private topEnds: number[] = [];
  private bottomEnds: number[] = [];
  private stage: DanmakuStage | undefined;
  private measure: (text: string) => number = () => 0;
  private widths = new Map<string, number>();
  private avoid: DanmakuBand | undefined;
  private staticOnly = false;
  private nextKey = 1;
  private lastMs = 0;

  /** The danmaku on screen, oldest first. */
  onScreen(): readonly PlacedDanmaku[] {
    return this.active;
  }

  /** Items waiting for a lane. */
  queued(): number {
    return this.queue.length;
  }

  /**
   * New items (a fetched snapshot, another density). What is on screen stays; the items
   * after `nowMs` follow the new list.
   */
  replaceItems(items: readonly DanmakuItem[], nowMs: number): void {
    this.items = items;
    this.queue = [];
    this.cursor = firstAfter(items, nowMs);
    this.lastMs = nowMs;
  }

  /** A new picture size or font: everything is laid out again for `nowMs`. */
  setStage(stage: DanmakuStage | undefined, measure: (text: string) => number, nowMs: number): DanmakuChange {
    this.stage = stage;
    this.measure = measure;
    this.widths.clear();
    return this.reset(nowMs);
  }

  /** Only new items keep out of the band; what is on screen stays where it is. */
  setAvoid(band: DanmakuBand | undefined): void {
    this.avoid = band;
  }

  setStaticOnly(staticOnly: boolean, nowMs: number): DanmakuChange {
    if (staticOnly === this.staticOnly) return { cleared: false, added: [], removed: [] };
    this.staticOnly = staticOnly;
    return this.reset(nowMs);
  }

  /** Nothing on screen and nothing waiting, until the next `reset`. */
  clear(): DanmakuChange {
    this.active = [];
    this.queue = [];
    this.clearLanes();
    return { cleared: true, added: [], removed: [] };
  }

  /**
   * The screen as it stands at `nowMs` (after a seek, a resize, a new clock): every item whose
   * time on screen covers `nowMs` is placed as it would have been, partway through, within
   * the on-screen cap (the newest kept).
   */
  reset(nowMs: number): DanmakuChange {
    this.clear();
    this.lastMs = nowMs;
    const longest = Math.max(DANMAKU_SCROLL_MS, DANMAKU_FIXED_MS);
    let index = firstAfter(this.items, nowMs - longest);
    const placed: PlacedDanmaku[] = [];
    for (; index < this.items.length; index += 1) {
      const item = this.items[index] as DanmakuItem;
      if (item.timeMs > nowMs) break;
      const shown = this.place(item, item.timeMs);
      if (shown !== undefined && shown.startMs + shown.durationMs > nowMs) placed.push(shown);
    }
    this.cursor = index;
    this.active = placed.slice(-DANMAKU_ONSCREEN_MAX);
    return { cleared: true, added: [...this.active], removed: [] };
  }

  /** Playback moved on to `nowMs`: what left the screen and what came onto it. */
  advance(nowMs: number): DanmakuChange {
    if (nowMs < this.lastMs) return this.reset(nowMs);
    this.lastMs = nowMs;
    const removed: number[] = [];
    this.active = this.active.filter((shown) => {
      if (shown.startMs + shown.durationMs > nowMs) return true;
      removed.push(shown.key);
      return false;
    });
    while (this.cursor < this.items.length && (this.items[this.cursor] as DanmakuItem).timeMs <= nowMs) {
      this.queue.push(this.cursor);
      this.cursor += 1;
    }
    this.queue = this.queue.filter((index) => nowMs - (this.items[index] as DanmakuItem).timeMs <= DANMAKU_MAX_WAIT_MS);
    if (this.queue.length > DANMAKU_QUEUE_MAX) this.queue = this.queue.slice(-DANMAKU_QUEUE_MAX);
    const added: PlacedDanmaku[] = [];
    if (this.stage !== undefined) {
      const waiting: number[] = [];
      for (const index of this.queue) {
        if (this.active.length >= DANMAKU_ONSCREEN_MAX) {
          waiting.push(index);
          continue;
        }
        const shown = this.place(this.items[index] as DanmakuItem, nowMs);
        if (shown === undefined) {
          waiting.push(index);
        } else {
          this.active.push(shown);
          added.push(shown);
        }
      }
      this.queue = waiting;
    }
    return { cleared: false, added, removed };
  }

  private clearLanes(): void {
    const lanes = this.stage === undefined ? 0 : Math.max(0, Math.floor(this.stage.height / this.stage.laneHeight));
    this.scrollTails = Array.from({ length: lanes }, () => undefined);
    this.topEnds = Array.from({ length: lanes }, () => Number.NEGATIVE_INFINITY);
    this.bottomEnds = Array.from({ length: lanes }, () => Number.NEGATIVE_INFINITY);
  }

  private widthOf(text: string): number {
    let width = this.widths.get(text);
    if (width === undefined) {
      width = this.measure(text);
      this.widths.set(text, width);
    }
    return width;
  }

  private blocked(y: number): boolean {
    const band = this.avoid;
    const stage = this.stage;
    if (band === undefined || stage === undefined) return false;
    return y < band.bottom && y + stage.laneHeight > band.top;
  }

  /** Takes a lane for `item` entering at `atMs`, or answers undefined when none is free. */
  private place(item: DanmakuItem, atMs: number): PlacedDanmaku | undefined {
    const stage = this.stage;
    if (stage === undefined) return undefined;
    const width = this.widthOf(item.text);
    const mode: DanmakuMode = this.staticOnly && item.mode === "scroll" ? "top" : item.mode;
    const lanes = this.scrollTails.length;
    if (mode === "scroll") {
      const speed = (stage.width + width) / DANMAKU_SCROLL_MS;
      for (let lane = 0; lane < lanes; lane += 1) {
        const y = lane * stage.laneHeight;
        if (this.blocked(y) || this.held(y, atMs) || !fitsBehind(this.scrollTails[lane], atMs, width, speed, stage)) continue;
        this.scrollTails[lane] = { startMs: atMs, width, speed };
        return this.shown(item, mode, y, width, atMs, DANMAKU_SCROLL_MS);
      }
      return undefined;
    }
    const ends = mode === "top" ? this.topEnds : this.bottomEnds;
    const yOf = (lane: number): number => (mode === "top" ? lane * stage.laneHeight : stage.height - (lane + 1) * stage.laneHeight);
    const free = (lane: number): boolean => !this.blocked(yOf(lane)) && (ends[lane] as number) <= atMs;
    // A lane no scrolling item is crossing, when there is one; any free lane otherwise.
    let chosen = -1;
    for (let lane = 0; lane < lanes && chosen < 0; lane += 1) if (free(lane) && !this.crossed(yOf(lane), atMs)) chosen = lane;
    for (let lane = 0; lane < lanes && chosen < 0; lane += 1) if (free(lane)) chosen = lane;
    if (chosen < 0) return undefined;
    ends[chosen] = atMs + DANMAKU_FIXED_MS;
    return this.shown(item, mode, yOf(chosen), width, atMs, DANMAKU_FIXED_MS);
  }

  /** Whether a top or bottom item is held over the lane at `y` at `atMs`, so a scrolling one would pass through it. */
  private held(y: number, atMs: number): boolean {
    const stage = this.stage;
    if (stage === undefined) return false;
    const pitch = stage.laneHeight;
    for (let lane = 0; lane < this.topEnds.length; lane += 1) {
      if ((this.topEnds[lane] as number) > atMs && overlaps(y, lane * pitch, pitch)) return true;
      if ((this.bottomEnds[lane] as number) > atMs && overlaps(y, stage.height - (lane + 1) * pitch, pitch)) return true;
    }
    return false;
  }

  /** Whether a scrolling item is still on screen in a lane overlapping `y` at `atMs`. */
  private crossed(y: number, atMs: number): boolean {
    const stage = this.stage;
    if (stage === undefined) return false;
    return this.scrollTails.some((tail, lane) => tail !== undefined && tail.startMs + DANMAKU_SCROLL_MS > atMs && overlaps(y, lane * stage.laneHeight, stage.laneHeight));
  }

  private shown(item: DanmakuItem, mode: DanmakuMode, y: number, width: number, startMs: number, durationMs: number): PlacedDanmaku {
    const key = this.nextKey;
    this.nextKey += 1;
    return { key, item, mode, y, width, startMs, durationMs };
  }
}

/**
 * Whether an item entering at `atMs` can follow `tail` in its lane: the one ahead has moved
 * clear by its own width and the gap, and a faster newcomer does not reach it before it has left.
 */
export function fitsBehind(tail: ScrollTail | undefined, atMs: number, width: number, speed: number, stage: Pick<DanmakuStage, "width" | "gap">): boolean {
  if (tail === undefined) return true;
  if (tail.speed * (atMs - tail.startMs) < tail.width + stage.gap) return false;
  if (speed <= tail.speed) return true;
  // The newcomer's left edge where the one ahead leaves the picture: not past its tail.
  return speed * (tail.startMs + DANMAKU_SCROLL_MS - atMs) <= stage.width;
}

/** Whether two bands of height `pitch`, starting at `a` and `b`, overlap. */
function overlaps(a: number, b: number, pitch: number): boolean {
  return a < b + pitch && b < a + pitch;
}

/** The index of the first item after `ms`, by binary search over time-ordered items. */
function firstAfter(items: readonly DanmakuItem[], ms: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((items[middle] as DanmakuItem).timeMs <= ms) low = middle + 1;
    else high = middle;
  }
  return low;
}
