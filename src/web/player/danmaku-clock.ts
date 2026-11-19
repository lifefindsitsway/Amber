import type { DanmakuItem } from "../../shared/dto/danmaku.ts";
import { DanmakuScheduler, type DanmakuBand, type DanmakuChange, type DanmakuStage, type PlacedDanmaku } from "./danmaku-scheduler.ts";

/**
 * Where danmaku are drawn. Each item moves by itself (an animation the compositor runs); the
 * clock only starts, stops and realigns them. `run` sets every item to where it belongs at
 * `nowMs` and lets them move at `rate`; `pause` holds them where they belong at `nowMs`;
 * `correct` moves back only items that drifted from `nowMs` by more than `toleranceMs`.
 */
export interface DanmakuSurface {
  setWidth(width: number): void;
  add(shown: PlacedDanmaku, nowMs: number, rate: number, running: boolean): void;
  remove(key: number): void;
  clear(): void;
  pause(nowMs: number): void;
  run(nowMs: number, rate: number): void;
  correct(nowMs: number, toleranceMs: number): void;
}

/** The `<video>` members the clock reads; a plain media element satisfies it. */
export type DanmakuVideo = Pick<
  HTMLVideoElement,
  "currentTime" | "paused" | "ended" | "seeking" | "readyState" | "playbackRate" | "addEventListener" | "removeEventListener"
> &
  Partial<Pick<HTMLVideoElement, "requestVideoFrameCallback" | "cancelVideoFrameCallback">>;

/**
 * How far an item may run ahead of or behind the video before it is put back. The picture
 * starts late after `play` and stalls briefly, while the items keep their own clock.
 */
const DRIFT_TOLERANCE_MS = 80;

/** `HAVE_FUTURE_DATA`: below it a playing element is stalled, and its picture stands still. */
const HAVE_FUTURE_DATA = 3;
/** `HAVE_METADATA`: the element knows its time. */
const HAVE_METADATA = 1;

const EVENTS = ["play", "playing", "pause", "waiting", "ended", "seeking", "seeked", "ratechange", "loadedmetadata", "emptied"] as const;

/**
 * Drives danmaku from a `<video>` element's own time. While the picture moves, the time is
 * read once per presented frame (`requestVideoFrameCallback`; an animation frame where there
 * is none) to bring new items on and take finished ones off; between frames the items move by
 * themselves at the element's playback rate. A pause, a stall or the end holds them; a seek
 * lays the screen out again for the new time; a rate change realigns them. `bind` moves the
 * clock to another element (a new quality mounts a new one) and picks up from that element's
 * time once it knows it, so nothing from its first frame at 0 flashes by.
 */
export class DanmakuClock {
  readonly scheduler = new DanmakuScheduler();
  private readonly surface: DanmakuSurface;
  private video: DanmakuVideo | null = null;
  private handle: number | undefined;
  private byVideoFrame = false;
  private readonly onEvent = (event: Event): void => this.handle_(event.type);

  constructor(surface: DanmakuSurface) {
    this.surface = surface;
  }

  bind(video: DanmakuVideo | null): void {
    if (video === this.video) return;
    if (this.video !== null) {
      this.stopFrames();
      for (const name of EVENTS) this.video.removeEventListener(name, this.onEvent);
    }
    this.video = video;
    this.apply(this.scheduler.clear());
    if (video === null) return;
    for (const name of EVENTS) video.addEventListener(name, this.onEvent);
    if (video.readyState >= HAVE_METADATA && !video.seeking) this.relayout();
  }

  dispose(): void {
    this.bind(null);
  }

  /** A new list: what is on screen stays; an empty screen (the first list, say) is laid out at once. */
  setItems(items: readonly DanmakuItem[]): void {
    const empty = this.scheduler.onScreen().length === 0;
    this.scheduler.replaceItems(items, this.nowMs());
    if (empty && this.ready()) this.relayout();
  }

  setStage(stage: DanmakuStage | undefined, measure: (text: string) => number): void {
    this.surface.setWidth(stage?.width ?? 0);
    const change = this.scheduler.setStage(stage, measure, this.nowMs());
    this.apply(this.ready() ? change : this.scheduler.clear());
  }

  setAvoid(band: DanmakuBand | undefined): void {
    this.scheduler.setAvoid(band);
  }

  setStaticOnly(staticOnly: boolean): void {
    const change = this.scheduler.setStaticOnly(staticOnly, this.nowMs());
    this.apply(this.ready() ? change : this.scheduler.clear());
  }

  private nowMs(): number {
    return this.video === null ? 0 : this.video.currentTime * 1000;
  }

  private ready(): boolean {
    return this.video !== null && this.video.readyState >= HAVE_METADATA && !this.video.seeking;
  }

  private running(): boolean {
    const video = this.video;
    return video !== null && !video.paused && !video.ended && !video.seeking && video.readyState >= HAVE_FUTURE_DATA;
  }

  private rate(): number {
    return this.video?.playbackRate ?? 1;
  }

  private apply(change: DanmakuChange, nowMs = this.nowMs()): void {
    if (change.cleared) this.surface.clear();
    for (const key of change.removed) this.surface.remove(key);
    const running = this.running();
    for (const shown of change.added) this.surface.add(shown, nowMs, this.rate(), running);
  }

  private relayout(): void {
    this.apply(this.scheduler.reset(this.nowMs()));
    this.resume();
  }

  /** Lets the items move again from where the element stands, or holds them when it does not move. */
  private resume(): void {
    if (this.running()) {
      this.surface.run(this.nowMs(), this.rate());
      this.schedule();
    } else {
      this.stopFrames();
      this.surface.pause(this.nowMs());
    }
  }

  private handle_(type: string): void {
    const video = this.video;
    if (video === null) return;
    switch (type) {
      case "seeking":
      case "emptied":
        this.stopFrames();
        this.apply(this.scheduler.clear());
        return;
      case "seeked":
      case "loadedmetadata":
        if (!video.seeking) this.relayout();
        return;
      case "pause":
      case "waiting":
      case "ended":
        this.stopFrames();
        if (this.ready()) this.apply(this.scheduler.advance(this.nowMs()));
        this.surface.pause(this.nowMs());
        return;
      default:
        // play, playing, ratechange: realign to the element's time and rate.
        if (!this.ready()) return;
        this.apply(this.scheduler.advance(this.nowMs()));
        this.resume();
    }
  }

  private schedule(): void {
    const video = this.video;
    if (this.handle !== undefined || video === null) return;
    this.byVideoFrame = typeof video.requestVideoFrameCallback === "function";
    if (this.byVideoFrame && video.requestVideoFrameCallback !== undefined) {
      this.handle = video.requestVideoFrameCallback((_now, metadata) => this.tick(metadata.mediaTime * 1000));
    } else {
      this.handle = requestAnimationFrame(() => this.tick(this.nowMs()));
    }
  }

  private stopFrames(): void {
    const video = this.video;
    if (this.handle === undefined) return;
    if (this.byVideoFrame && video?.cancelVideoFrameCallback !== undefined) video.cancelVideoFrameCallback(this.handle);
    else cancelAnimationFrame(this.handle);
    this.handle = undefined;
  }

  private tick(nowMs: number): void {
    this.handle = undefined;
    if (!this.running()) return;
    this.apply(this.scheduler.advance(nowMs), nowMs);
    this.surface.correct(nowMs, DRIFT_TOLERANCE_MS * this.rate());
    this.schedule();
  }
}
