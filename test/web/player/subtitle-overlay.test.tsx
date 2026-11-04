import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAYER_SKIP_SECONDS,
  SUBTITLE_ASS_EM_RATIO,
  SUBTITLE_NUDGE_BP,
  SUBTITLE_NUDGE_FAST_BP,
  SUBTITLE_ORIGINAL_FONT_SIZE,
  SUBTITLE_PLACEMENT_X_BP,
  SUBTITLE_PLACEMENT_Y_BP,
  SUBTITLE_WRAP_RATIO,
} from "../../../src/shared/defaults.ts";
import { sliceCues, type TimedSubtitle } from "../../../src/shared/subtitle-geometry.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import { LocalPlayer } from "../../../src/web/player/local-player.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import type { SubtitleStatus, SubtitleTrackModel } from "../../../src/web/player/subtitle-overlay.tsx";
import { readPlacement, resetSubtitlePrefsMemory, useSubtitlePrefs, writeAppearance, type SubtitleDisplayMode } from "../../../src/web/player/subtitle-prefs.ts";

const SLICES: TimedSubtitle[] = [
  { startMs: 0, endMs: 1_000, original: "一" },
  { startMs: 1_000, endMs: 2_000, original: "二" },
  { startMs: 3_000, endMs: 4_000, original: "三" },
];

/** A page-assembled model over the real preferences, with the mode and editor state held here. */
function Harness(props: { slices: readonly TimedSubtitle[]; mode?: SubtitleDisplayMode; editing?: boolean; status?: SubtitleStatus; retry?: () => void; audioOnly?: boolean }) {
  const prefs = useSubtitlePrefs("u1", "c1");
  const [mode, setMode] = useState<SubtitleDisplayMode>(props.mode ?? "original");
  const [editing, setEditing] = useState(props.editing === true);
  const model: SubtitleTrackModel = {
    mode,
    setMode,
    originals: [{ id: "r1", label: "r1" }],
    originalId: "r1",
    setOriginal: () => undefined,
    translations: [],
    translationId: undefined,
    translationLocked: false,
    followTranslation: () => undefined,
    lockTranslation: () => undefined,
    goTranslate: () => undefined,
    status: props.status ?? "ready",
    retry: props.retry ?? (() => undefined),
    slices: props.slices,
    fontFallback: false,
    appearance: prefs.appearance,
    setAppearance: prefs.setAppearance,
    resetAppearance: prefs.resetAppearance,
    placement: prefs.placement,
    placementOverridden: prefs.placementOverridden,
    setPlacement: prefs.setPlacement,
    setDefaultPlacement: prefs.setDefaultPlacement,
    resetPlacement: prefs.resetPlacement,
    editing,
    startEditing: () => setEditing(true),
    stopEditing: () => setEditing(false),
  };
  return (
    <PlayerControllerProvider controller={new PlayerController()}>
      <LocalPlayer src="/fixture.mp4" subtitles={model} audioOnly={props.audioOnly === true} />
    </PlayerControllerProvider>
  );
}

function show(props: Parameters<typeof Harness>[0]) {
  render(<Harness {...props} />);
  const root = screen.getByTestId("player-local");
  return { root, video: root.querySelector("video") as HTMLVideoElement };
}

/** Gives the `<video>` a box and an intrinsic size, as layout and metadata would. */
function layout(video: HTMLVideoElement, box: { width: number; height: number }, intrinsic: { width: number; height: number }) {
  for (const [key, value] of Object.entries({ clientWidth: box.width, clientHeight: box.height, videoWidth: intrinsic.width, videoHeight: intrinsic.height })) {
    Object.defineProperty(video, key, { configurable: true, value });
  }
  fireEvent.loadedMetadata(video);
}

function playable(video: HTMLVideoElement) {
  let paused = true;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  const play = vi.spyOn(video, "play").mockImplementation(() => {
    paused = false;
    fireEvent.play(video);
    return Promise.resolve();
  });
  vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
    fireEvent.pause(video);
  });
  return play;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

const lines = (): string[] => [...screen.getByTestId("subtitle-text").querySelectorAll("[data-line]")].map((line) => `${line.getAttribute("data-line")}:${line.textContent}`);

beforeEach(() => {
  localStorage.clear();
  resetSubtitlePrefsMemory();
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
});

describe("subtitle overlay", () => {
  it("lays subtitles out on the picture without the letterbox bars, sized by the picture height", () => {
    const { video } = show({ slices: SLICES });
    layout(video, { width: 1280, height: 720 }, { width: 1080, height: 1080 });
    const overlay = screen.getByTestId("subtitle-overlay");
    expect([overlay.style.left, overlay.style.top, overlay.style.width, overlay.style.height]).toEqual(["280px", "0px", "720px", "720px"]);
    // Paused at 0: the first slice is current.
    const block = screen.getByTestId("subtitle-block");
    expect([block.style.left, block.style.top, block.style.transform]).toEqual([`${SUBTITLE_PLACEMENT_X_BP / 100}%`, `${SUBTITLE_PLACEMENT_Y_BP / 100}%`, "translate(-50%, -100%)"]);
    const text = screen.getByTestId("subtitle-text");
    expect(parseFloat(text.style.maxWidth)).toBeCloseTo(SUBTITLE_WRAP_RATIO * 720);
    const line = text.querySelector("[data-line='original']") as HTMLElement;
    expect(parseFloat(line.style.fontSize)).toBeCloseTo((SUBTITLE_ORIGINAL_FONT_SIZE * SUBTITLE_ASS_EM_RATIO * 720) / 1080);
    expect(parseFloat(line.style.lineHeight)).toBeCloseTo((SUBTITLE_ORIGINAL_FONT_SIZE * 720) / 1080);
    // Not editing: the overlay never takes a click from the picture.
    expect(overlay.className).toContain("pointer-events-none");
    expect(block.getAttribute("tabindex")).toBeNull();
  });

  it("uses the whole box for an audio-only file", () => {
    const { video } = show({ slices: SLICES, audioOnly: true });
    layout(video, { width: 640, height: 360 }, { width: 0, height: 0 });
    const overlay = screen.getByTestId("subtitle-overlay");
    expect([overlay.style.left, overlay.style.width, overlay.style.height]).toEqual(["0px", "640px", "360px"]);
  });

  it("follows playback once per video frame and re-reads the time at once on a paused seek", async () => {
    const { video } = show({ slices: SLICES });
    const frames: Array<() => void> = [];
    Object.defineProperty(video, "requestVideoFrameCallback", { configurable: true, value: vi.fn((callback: () => void) => frames.push(callback)) });
    Object.defineProperty(video, "cancelVideoFrameCallback", { configurable: true, value: vi.fn() });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    playable(video);
    expect(lines()).toEqual(["original:一"]);
    await act(async () => video.play());
    expect(frames.length).toBeGreaterThan(0);
    video.currentTime = 1.5;
    act(() => frames.splice(0).forEach((frame) => frame()));
    expect(lines()).toEqual(["original:二"]);
    expect(raf).not.toHaveBeenCalled();

    act(() => video.pause());
    video.currentTime = 3.5;
    fireEvent.seeked(video);
    expect(lines()).toEqual(["original:三"]);
    video.currentTime = 2.5;
    fireEvent.seeked(video);
    expect(screen.queryByTestId("subtitle-block")).toBeNull();
  });

  it("falls back to animation frames without video-frame callbacks or without a picture", async () => {
    const { video } = show({ slices: SLICES, audioOnly: true });
    const rvfc = vi.fn(() => 1);
    Object.defineProperty(video, "requestVideoFrameCallback", { configurable: true, value: rvfc });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    playable(video);
    await act(async () => video.play());
    video.currentTime = 1.2;
    act(() => frames.splice(0).forEach((frame) => frame(0)));
    expect(lines()).toEqual(["original:二"]);
    expect(rvfc).not.toHaveBeenCalled();
  });

  it("stacks overlapping sentences in one block and orders bilingual lines as the user chose", () => {
    const overlapping = sliceCues([
      { startMs: 0, endMs: 2_000, original: "A", translation: "甲" },
      { startMs: 1_000, endMs: 3_000, original: "B", translation: "乙" },
    ]);
    const { video } = show({ slices: overlapping, mode: "bilingual" });
    video.currentTime = 1.5;
    fireEvent.seeked(video);
    expect(lines()).toEqual(["original:A\nB", "translation:甲\n乙"]);
    expect((screen.getByTestId("subtitle-text") as HTMLElement).style.whiteSpace).toBe("pre-line");
    act(() => writeAppearance("u1", { ...defaultSubtitleAppearance(), bilingualOrder: "translation_first" }));
    expect(lines()).toEqual(["translation:甲\n乙", "original:A\nB"]);
  });

  describe("background box scope", () => {
    const BILINGUAL: TimedSubtitle[] = [{ startMs: 0, endMs: 1_000, original: "Hello", translation: "你好" }];
    const FILL = "rgba(16, 32, 48, 0.4)";

    /** A 1280×720 picture of a 1920×1080 video, so one 1080p pixel is 720 / 1080 px. */
    function boxed(mode: SubtitleDisplayMode, scope: "both" | "original" | "translation", options: { slices?: readonly TimedSubtitle[]; padding?: number; order?: "original_first" | "translation_first"; editing?: boolean } = {}) {
      const defaults = defaultSubtitleAppearance();
      writeAppearance("u1", {
        ...defaults,
        bilingualOrder: options.order ?? defaults.bilingualOrder,
        background: { ...defaults.background, enabled: true, color: "#102030", opacityPct: 40, padding: options.padding ?? 12, scope },
      });
      const shown = show({ slices: options.slices ?? BILINGUAL, mode, editing: options.editing === true });
      layout(shown.video, { width: 1280, height: 720 }, { width: 1920, height: 1080 });
      return shown;
    }
    const spreadOf = (element: HTMLElement): number => {
      const match = /^0(?:px)? 0(?:px)? 0(?:px)? ([\d.]+)px (.+)$/u.exec(element.style.boxShadow);
      expect(match?.[2]).toBe(FILL);
      return Number(match?.[1]);
    };

    it("keeps one block box around both lines when the scope is both", () => {
      boxed("bilingual", "both");
      const block = screen.getByTestId("subtitle-background");
      expect(block.style.background).toBe(FILL);
      expect(parseFloat(block.style.inset)).toBeCloseTo(-8);
      expect(screen.queryByTestId("subtitle-line-background")).toBeNull();
    });

    it("boxes only the translation line through a hidden layer beneath the text", () => {
      boxed("bilingual", "translation");
      expect(screen.queryByTestId("subtitle-background")).toBeNull();
      const boxes = screen.getAllByTestId("subtitle-line-background");
      expect(boxes).toHaveLength(1);
      const box = boxes[0] as HTMLElement;
      expect([box.getAttribute("data-line"), box.textContent]).toEqual(["translation", "你好"]);
      expect(box.style.background).toBe(FILL);
      expect(spreadOf(box)).toBeCloseTo((12 * 720) / 1080);
      // The layer repeats every line so it wraps like the text, but shows none of it and takes no pointer.
      const layer = box.parentElement?.parentElement as HTMLElement;
      expect(layer.getAttribute("aria-hidden")).toBe("true");
      expect([layer.style.position, layer.style.zIndex, layer.style.pointerEvents, layer.style.color]).toEqual(["absolute", "-1", "none", "transparent"]);
      expect(layer.textContent).toBe("Hello你好");
      const text = screen.getByTestId("subtitle-text");
      expect(text.querySelector("[data-line='translation']")?.textContent).toBe("你好");
      expect((text.querySelector("[data-line='translation']") as HTMLElement).style.color).not.toBe("transparent");
    });

    it("boxes only the original line, following the user's line order", () => {
      boxed("bilingual", "original", { order: "translation_first" });
      expect(screen.queryByTestId("subtitle-background")).toBeNull();
      const box = screen.getByTestId("subtitle-line-background");
      expect([box.getAttribute("data-line"), box.textContent]).toEqual(["original", "Hello"]);
      const layerLines = [...(box.parentElement?.parentElement as HTMLElement).children].map((line) => line.textContent);
      expect(layerLines).toEqual(["你好", "Hello"]);
    });

    it("falls back to the block box when only one language is shown", () => {
      boxed("translation", "translation", { slices: [{ startMs: 0, endMs: 1_000, translation: "你好" }] });
      expect(screen.getByTestId("subtitle-background")).toBeTruthy();
      expect(screen.queryByTestId("subtitle-line-background")).toBeNull();
    });

    it("draws no box when the slice lacks the boxed line", () => {
      boxed("bilingual", "translation", { slices: [{ startMs: 0, endMs: 1_000, original: "Hello" }] });
      expect(screen.queryByTestId("subtitle-background")).toBeNull();
      expect(screen.queryByTestId("subtitle-line-background")).toBeNull();
      expect(screen.getByTestId("subtitle-text").querySelector("[aria-hidden]")).toBeNull();
    });

    it("spreads a one-line box by at least one 1080p pixel, as the export must", () => {
      boxed("bilingual", "translation", { padding: 0 });
      expect(spreadOf(screen.getByTestId("subtitle-line-background"))).toBeCloseTo(720 / 1080);
    });

    it("still drags the block by the grab point", () => {
      const { root } = boxed("bilingual", "translation", { editing: true });
      const overlay = screen.getByTestId("subtitle-overlay");
      const block = screen.getByTestId("subtitle-block");
      vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1280, 720));
      vi.spyOn(block, "getBoundingClientRect").mockReturnValue(rect(440, 662.4 - 50, 400, 50));
      fireEvent.pointerDown(block, { pointerId: 1, button: 0, clientX: 500, clientY: 630 });
      expect(root.getAttribute("data-controls")).toBe("hidden");
      fireEvent.pointerMove(block, { pointerId: 1, clientX: 500, clientY: 330 });
      fireEvent.pointerUp(block, { pointerId: 1, clientX: 500, clientY: 330 });
      expect(readPlacement("u1", "c1")).toEqual({ version: 1, xBp: 5000, yBp: Math.round(((330 - 17.6 + 25) / 720) * 10000), anchor: "center" });
      expect(screen.getByTestId("subtitle-line-background").textContent).toBe("你好");
    });
  });

  it("reports loading, a retryable failure and an empty revision", () => {
    const retry = vi.fn();
    const { unmount } = render(<Harness slices={[]} status="loading" />);
    expect(screen.getByTestId("subtitle-status").textContent).toBe("字幕加载中…");
    unmount();
    const second = render(<Harness slices={[]} status="error" retry={retry} />);
    expect(screen.getByTestId("subtitle-status").textContent).toContain("字幕加载失败");
    fireEvent.click(screen.getByTestId("subtitle-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    second.unmount();
    render(<Harness slices={[]} status="empty" />);
    expect(screen.getByTestId("subtitle-status").textContent).toBe("该版本没有字幕");
  });

  it("shows nothing while subtitles are off", () => {
    show({ slices: SLICES, mode: "off" });
    expect(screen.queryByTestId("subtitle-overlay")).toBeNull();
    expect(screen.getByTestId("player-subtitles")).toBeTruthy();
  });
});

describe("subtitle editing on the player", () => {
  /** A 1280×720 picture at the viewport origin and a 400×50 block where the default placement puts it. */
  function editable() {
    const shown = show({ slices: SLICES, editing: true });
    layout(shown.video, { width: 1280, height: 720 }, { width: 1920, height: 1080 });
    const overlay = screen.getByTestId("subtitle-overlay");
    const block = screen.getByTestId("subtitle-block");
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1280, 720));
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue(rect(440, 662.4 - 50, 400, 50));
    return { ...shown, block };
  }

  it("keeps the block on screen with sample lines and marks the picture's edge", () => {
    const { video } = show({ slices: [], editing: true, mode: "bilingual" });
    layout(video, { width: 1280, height: 720 }, { width: 1920, height: 1080 });
    expect(lines()).toEqual(["original:This is a sample subtitle", "translation:这是一句示例字幕"]);
    expect(screen.getByTestId("subtitle-picture-edge")).toBeTruthy();
    expect(screen.getByTestId("subtitle-block").getAttribute("tabindex")).toBe("0");
    expect(screen.getByTestId("subtitle-block").style.touchAction).toBe("none");
  });

  it("drags by the grab point, hides the controls meanwhile and saves only on release", () => {
    const { root, video, block } = editable();
    const play = playable(video);
    expect(root.getAttribute("data-controls")).toBe("shown");
    fireEvent.pointerDown(block, { pointerId: 1, button: 0, clientX: 500, clientY: 630 });
    expect(root.getAttribute("data-controls")).toBe("hidden");
    fireEvent.pointerMove(block, { pointerId: 1, clientX: 500, clientY: 330 });
    // The block moved with the pointer, its centre kept 140 px right of it: no snapping to the pointer.
    expect(block.getAttribute("data-anchor")).toBe("center");
    expect(block.style.left).toBe("50%");
    expect(block.style.top).toBe(`${Math.round(((330 - 17.6 + 25) / 720) * 10000) / 100}%`);
    expect(readPlacement("u1", "c1")).toEqual(defaultSubtitlePlacement());
    fireEvent.pointerUp(block, { pointerId: 1, clientX: 500, clientY: 330 });
    fireEvent.click(block);
    fireEvent.doubleClick(block);
    expect(readPlacement("u1", "c1")).toEqual({ version: 1, xBp: 5000, yBp: Math.round(((330 - 17.6 + 25) / 720) * 10000), anchor: "center" });
    expect(root.getAttribute("data-controls")).toBe("shown");
    expect(play).not.toHaveBeenCalled();
    expect(document.fullscreenElement ?? null).toBeNull();
  });

  it("puts the block back when the pointer is cancelled", () => {
    const { root, block } = editable();
    fireEvent.pointerDown(block, { pointerId: 1, button: 0, clientX: 500, clientY: 630 });
    fireEvent.pointerMove(block, { pointerId: 1, clientX: 900, clientY: 100 });
    expect(block.getAttribute("data-anchor")).toBe("top");
    fireEvent.pointerCancel(block, { pointerId: 1 });
    expect(block.getAttribute("data-anchor")).toBe("bottom");
    expect([block.style.left, block.style.top]).toEqual([`${SUBTITLE_PLACEMENT_X_BP / 100}%`, `${SUBTITLE_PLACEMENT_Y_BP / 100}%`]);
    expect(readPlacement("u1", "c1")).toEqual(defaultSubtitlePlacement());
    expect(root.getAttribute("data-controls")).toBe("shown");
  });

  it("nudges with the arrow keys while the block has focus, leaving other keys to the player", () => {
    const { root, video, block } = editable();
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    video.currentTime = 30;
    block.focus();
    fireEvent.keyDown(block, { key: "ArrowRight" });
    fireEvent.keyDown(block, { key: "ArrowUp", shiftKey: true });
    expect(readPlacement("u1", "c1")).toEqual({ version: 1, xBp: SUBTITLE_PLACEMENT_X_BP + SUBTITLE_NUDGE_BP, yBp: SUBTITLE_PLACEMENT_Y_BP - SUBTITLE_NUDGE_FAST_BP, anchor: "bottom" });
    expect(video.currentTime).toBe(30);
    // Not a nudge: the player still skips, and F still asks for fullscreen.
    fireEvent.keyDown(block, { key: "ArrowRight", ctrlKey: true });
    expect(readPlacement("u1", "c1").xBp).toBe(SUBTITLE_PLACEMENT_X_BP + SUBTITLE_NUDGE_BP);
    fireEvent.keyDown(block, { key: "f" });
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(video.currentTime).toBe(30 + PLAYER_SKIP_SECONDS);
  });

  it("previews the final look without panel or controls, and returns on a click or Escape", () => {
    const { root } = editable();
    fireEvent.click(screen.getByTestId("subtitle-preview"));
    expect(screen.queryByTestId("subtitle-editor")).toBeNull();
    expect(root.getAttribute("data-controls")).toBe("hidden");
    expect(screen.queryByTestId("player-progress-line")).toBeNull();
    expect(screen.queryByTestId("subtitle-picture-edge")).toBeNull();
    expect(lines()).toEqual(["original:一"]);
    fireEvent.click(screen.getByTestId("subtitle-preview-exit"));
    expect(screen.getByTestId("subtitle-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("subtitle-preview"));
    fireEvent.keyDown(screen.getByTestId("subtitle-preview-exit"), { key: "Escape" });
    expect(screen.getByTestId("subtitle-editor")).toBeTruthy();
    expect(root.getAttribute("data-controls")).toBe("shown");
  });

  it("docks the panel away from the subtitles and keeps it through clicks elsewhere", () => {
    const { video } = editable();
    const play = playable(video);
    expect(screen.getByTestId("subtitle-editor").getAttribute("data-side")).toBe("right");
    fireEvent.click(screen.getByTestId("subtitle-preset-bottomRight"));
    expect(screen.getByTestId("subtitle-editor").getAttribute("data-side")).toBe("left");
    fireEvent.click(video);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("subtitle-editor")).toBeTruthy();
    // Keys inside the panel stay there: Space on its buttons neither plays nor pauses.
    fireEvent.keyDown(screen.getByTestId("subtitle-preset-bottom"), { key: " " });
    expect(video.paused).toBe(false);
  });

  it("warns when the block leaves the picture", () => {
    const { block } = editable();
    expect(screen.queryByTestId("subtitle-out-of-bounds")).toBeNull();
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue(rect(1100, 600, 400, 50));
    fireEvent.keyDown(block, { key: "ArrowRight" });
    expect(screen.getByTestId("subtitle-out-of-bounds").textContent).toBe("字幕超出画面，导出时会被裁切");
  });
});
