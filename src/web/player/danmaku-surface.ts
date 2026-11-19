import type { DanmakuSurface } from "./danmaku-clock.ts";
import type { PlacedDanmaku } from "./danmaku-scheduler.ts";

/** Below this relative luminance a danmaku's colour gets a light outline instead of a dark one. */
const DARK_TEXT_LUMINANCE = 0.2;

/** A one-pixel outline on four sides, so any colour reads on any picture. */
const outline = (color: string): string =>
  [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
    .map(([x, y]) => `${x}px ${y}px 1px ${color}`)
    .join(",");
const DARK_OUTLINE = outline("#000");
const LIGHT_OUTLINE = outline("#fff");

/** `0xRRGGBB` as CSS. */
export function danmakuColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function luminance(color: number): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((color >> 16) & 0xff) + 0.7152 * channel((color >> 8) & 0xff) + 0.0722 * channel(color & 0xff);
}

interface Drawn {
  element: HTMLElement;
  animation: Animation | undefined;
  startMs: number;
  durationMs: number;
}

/**
 * Draws danmaku into `layer`: one element per item, its text set as plain text (never markup),
 * moved by a linear `transform` animation that runs on the compositor. Animation time is media
 * time: an item's animation lasts its media duration and plays at the video's rate, so its
 * current time is simply how long it has been on screen. A finished item keeps its last frame
 * (off the picture, or held) until the clock removes it.
 */
export function createDomSurface(layer: HTMLElement): DanmakuSurface & { count(): number } {
  const drawn = new Map<number, Drawn>();
  let width = 0;
  const align = (item: Drawn, nowMs: number, rate: number): void => {
    if (item.animation === undefined) return;
    item.animation.playbackRate = rate;
    item.animation.currentTime = Math.max(0, nowMs - item.startMs);
  };
  return {
    setWidth(next) {
      width = next;
    },
    add(shown, nowMs, rate, running) {
      const element = document.createElement("div");
      element.textContent = shown.item.text;
      element.dataset["danmaku"] = shown.mode;
      const style = element.style;
      style.position = "absolute";
      style.top = `${shown.y}px`;
      style.left = shown.mode === "scroll" ? "0" : "50%";
      style.whiteSpace = "pre";
      style.willChange = "transform";
      style.color = danmakuColor(shown.item.color);
      style.textShadow = luminance(shown.item.color) < DARK_TEXT_LUMINANCE ? LIGHT_OUTLINE : DARK_OUTLINE;
      const frames: Keyframe[] =
        shown.mode === "scroll"
          ? [{ transform: `translateX(${width}px)` }, { transform: `translateX(${-shown.width}px)` }]
          : [{ transform: "translateX(-50%)" }, { transform: "translateX(-50%)" }];
      style.transform = String(frames[0]?.transform);
      layer.append(element);
      // A host without Web Animations still shows the item, held in place.
      const animation = typeof element.animate === "function" ? element.animate(frames, { duration: shown.durationMs, easing: "linear", fill: "forwards" }) : undefined;
      const item: Drawn = { element, animation, startMs: shown.startMs, durationMs: shown.durationMs };
      drawn.set(shown.key, item);
      align(item, nowMs, rate);
      if (!running) animation?.pause();
    },
    remove(key) {
      const item = drawn.get(key);
      if (item === undefined) return;
      item.animation?.cancel();
      item.element.remove();
      drawn.delete(key);
    },
    clear() {
      for (const item of drawn.values()) {
        item.animation?.cancel();
        item.element.remove();
      }
      drawn.clear();
    },
    pause(nowMs) {
      for (const item of drawn.values()) {
        item.animation?.pause();
        if (item.animation !== undefined) item.animation.currentTime = Math.max(0, nowMs - item.startMs);
      }
    },
    run(nowMs, rate) {
      for (const item of drawn.values()) {
        align(item, nowMs, rate);
        // play() on a finished animation would rewind it to its start.
        if (nowMs - item.startMs < item.durationMs) item.animation?.play();
      }
    },
    correct(nowMs, toleranceMs) {
      for (const item of drawn.values()) {
        const current = item.animation?.currentTime;
        if (item.animation === undefined || typeof current !== "number") continue;
        const target = nowMs - item.startMs;
        if (target < item.durationMs && Math.abs(current - target) > toleranceMs) item.animation.currentTime = Math.max(0, target);
      }
    },
    count() {
      return drawn.size;
    },
  };
}

/**
 * Text width at the layer's font, measured off-screen on a canvas so placing an item never
 * forces a layout. Without a canvas (tests) it estimates one em per character.
 */
export function createTextMeasure(font: string, fontPx: number): (text: string) => number {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  if (context === null) return (text) => text.length * fontPx;
  context.font = font;
  const measured = context;
  return (text) => measured.measureText(text).width;
}
