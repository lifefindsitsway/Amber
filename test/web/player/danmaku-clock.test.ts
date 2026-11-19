import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DANMAKU_SCROLL_MS } from "../../../src/shared/defaults.ts";
import type { DanmakuItem } from "../../../src/shared/dto/danmaku.ts";
import { DanmakuClock, type DanmakuSurface } from "../../../src/web/player/danmaku-clock.ts";
import type { PlacedDanmaku } from "../../../src/web/player/danmaku-scheduler.ts";

/** A media element as far as the clock looks at it: time, state and events, moved by hand. */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  playbackRate = 1;

  emit(...types: string[]): void {
    for (const type of types) this.dispatchEvent(new Event(type));
  }
  play(): void {
    this.paused = false;
    this.emit("play", "playing");
  }
  pause(): void {
    this.paused = true;
    this.emit("pause");
  }
  seek(seconds: number): void {
    this.seeking = true;
    this.currentTime = seconds;
    this.emit("seeking");
    this.seeking = false;
    this.emit("seeked");
  }
}

/** Records what the clock asks of the surface. */
class FakeSurface implements DanmakuSurface {
  shown = new Map<number, PlacedDanmaku>();
  running = false;
  rate = 1;
  alignedAt: number | undefined;
  setWidth(): void {}
  add(shown: PlacedDanmaku, _nowMs: number, rate: number, running: boolean): void {
    this.shown.set(shown.key, shown);
    this.rate = rate;
    this.running = running;
  }
  remove(key: number): void {
    this.shown.delete(key);
  }
  clear(): void {
    this.shown.clear();
  }
  pause(nowMs: number): void {
    this.running = false;
    this.alignedAt = nowMs;
  }
  corrected: number[] = [];
  correct(nowMs: number): void {
    this.corrected.push(nowMs);
  }
  run(nowMs: number, rate: number): void {
    this.running = true;
    this.rate = rate;
    this.alignedAt = nowMs;
  }
  texts(): string[] {
    return [...this.shown.values()].map((shown) => shown.item.text);
  }
}

const item = (timeMs: number, text: string): DanmakuItem => ({ timeMs, mode: "scroll", color: 0xffffff, weight: 5, text });
const ITEMS = [item(1000, "one"), item(5000, "five"), item(30_000, "thirty"), item(31_000, "thirty-one")];
const STAGE = { width: 640, height: 360, laneHeight: 26, gap: 20 };

let frames: Array<() => void> = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frames[handle - 1] = () => undefined;
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Runs the pending animation frames once, as the browser would on its next frame. */
function frame(): void {
  const pending = frames;
  frames = [];
  for (const callback of pending) callback();
}

function setup(video = new FakeVideo()) {
  const surface = new FakeSurface();
  const clock = new DanmakuClock(surface);
  clock.setStage(STAGE, (text) => text.length * 10);
  clock.setItems(ITEMS);
  clock.bind(video as unknown as HTMLVideoElement);
  return { video, surface, clock };
}

describe("DanmakuClock", () => {
  it("brings items on as the video's own time passes them, frame by frame while it plays", () => {
    const { video, surface } = setup();
    video.play();
    expect(surface.running).toBe(true);
    video.currentTime = 1.2;
    frame();
    expect(surface.texts()).toEqual(["one"]);
    video.currentTime = 5.0;
    frame();
    expect(surface.texts()).toEqual(["one", "five"]);
    // Every frame puts back items that drifted from the picture's own time.
    expect(surface.corrected).toEqual([1200, 5000]);
    // Gone once its crossing (from the frame it came on) is over.
    video.currentTime = (1200 + DANMAKU_SCROLL_MS) / 1000;
    frame();
    expect(surface.texts()).toEqual(["five"]);
  });

  it("holds the items while paused or stalled, and realigns them to the video's time when it moves again", () => {
    const { video, surface } = setup();
    video.play();
    video.currentTime = 1.5;
    frame();
    video.currentTime = 1.6;
    video.pause();
    expect(surface.running).toBe(false);
    // Held where the paused picture is, not wherever their own clock had taken them.
    expect(surface.alignedAt).toBe(1600);
    // No frames while paused: time is read only on events.
    frame();
    expect(frames).toHaveLength(0);
    video.play();
    expect(surface.alignedAt).toBe(1600);
    video.readyState = 2;
    video.emit("waiting");
    expect(surface.running).toBe(false);
    video.readyState = 4;
    video.emit("playing");
    expect(surface.running).toBe(true);
  });

  it("follows the playback rate", () => {
    const { video, surface } = setup();
    video.play();
    video.playbackRate = 2;
    video.emit("ratechange");
    expect(surface.rate).toBe(2);
    video.currentTime = 1.1;
    frame();
    expect(surface.rate).toBe(2);
  });

  it("lays the screen out again for the time a seek lands on", () => {
    const { video, surface } = setup();
    video.play();
    video.currentTime = 1.2;
    frame();
    video.currentTime = 5.5;
    frame();
    expect(surface.texts()).toEqual(["one", "five"]);
    video.seek(31.5);
    expect(surface.texts()).toEqual(["thirty", "thirty-one"]);
    video.seek(0.5);
    expect(surface.texts()).toEqual([]);
  });

  it("rebinds to a new element (another quality) and picks up from its restored time, never from its first 0", () => {
    const { video, surface, clock } = setup();
    video.play();
    video.currentTime = 1.1;
    frame();
    video.currentTime = 5.2;
    frame();
    const next = new FakeVideo();
    next.readyState = 0;
    clock.bind(next as unknown as HTMLVideoElement);
    expect(surface.texts()).toEqual([]);
    // The old element no longer drives anything.
    video.currentTime = 31;
    video.emit("seeked");
    expect(surface.texts()).toEqual([]);
    // The player restores the position while the metadata event is handled, so the clock waits for the seek.
    next.readyState = 1;
    next.seeking = true;
    next.currentTime = 5.2;
    next.emit("loadedmetadata");
    expect(surface.texts()).toEqual([]);
    next.seeking = false;
    next.readyState = 4;
    next.emit("seeked");
    expect(surface.texts()).toEqual(["one", "five"]);
    next.play();
    expect(surface.running).toBe(true);
    expect(surface.alignedAt).toBe(5200);
  });

  it("shows a new list's current items at once when nothing was on screen", () => {
    const { video, surface, clock } = setup();
    clock.setItems([]);
    video.seek(5.1);
    expect(surface.texts()).toEqual([]);
    clock.setItems(ITEMS);
    expect(surface.texts()).toEqual(["one", "five"]);
  });
});
