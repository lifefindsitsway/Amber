import { act, cleanup as cleanupRender, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAYER_SKIP_SECONDS,
  SUBTITLE_ORIGINAL_COLOR,
  SUBTITLE_SPEAKER_MAX_PARTS,
  SUBTITLE_TRANSLATION_COLOR,
  SUBTITLE_TRANSLATION_FONT_SIZE,
  SUBTITLE_ASS_EM_RATIO,
  SUBTITLE_NUDGE_BP,
  SUBTITLE_NUDGE_FAST_BP,
  SUBTITLE_ORIGINAL_FONT_SIZE,
  SUBTITLE_PLACEMENT_X_BP,
  SUBTITLE_PLACEMENT_Y_BP,
  SUBTITLE_WRAP_RATIO,
} from "../../../src/shared/defaults.ts";
import {
  labelSubtitleCues,
  sliceCues,
  sliceSubtitleUnits,
  speakerLabelFontSize,
  type SlicedUnitSubtitle,
  type TimedSubtitle,
} from "../../../src/shared/subtitle-geometry.ts";
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
function Harness(props: {
  slices: readonly TimedSubtitle[];
  units?: readonly SlicedUnitSubtitle[];
  mode?: SubtitleDisplayMode;
  editing?: boolean;
  status?: SubtitleStatus;
  retry?: () => void;
  audioOnly?: boolean;
}) {
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
    ...(props.units === undefined ? {} : { units: props.units }),
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
  const view = render(<Harness {...props} />);
  const root = screen.getByTestId("player-local");
  return { root, video: root.querySelector("video") as HTMLVideoElement, rerender: (next: Parameters<typeof Harness>[0]) => view.rerender(<Harness {...next} />) };
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

  it("draws Latin lines with straight quotes and keeps the curly quotes of a CJK line", () => {
    const { video } = show({
      slices: [
        { startMs: 0, endMs: 1_000, original: "They’re “here”", translation: "他说“来了”" },
        { startMs: 1_000, endMs: 2_000, original: "他说“Hello”。", translation: "dogs’ bowls" },
      ],
      mode: "bilingual",
    });
    expect(lines()).toEqual(['original:They\'re "here"', "translation:他说“来了”"]);
    video.currentTime = 1.5;
    fireEvent.seeked(video);
    expect(lines()).toEqual(["original:他说“Hello”。", "translation:dogs' bowls"]);
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

describe("subtitle overlay with speaker labels", () => {
  const LABELS = new Map([
    ["a", "张三"],
    ["b", "李四"],
    ["c", "王五"],
  ]);
  /** Units as the content page builds them: cues labelled by the mode's rule, then sliced keeping each cue a unit. */
  const unitsOf = (cues: TimedSubtitle[], speakers: (string | undefined)[], mode: "change" | "every" = "change") => sliceSubtitleUnits(labelSubtitleCues(cues, speakers, LABELS, mode));
  const MONOLOGUE: TimedSubtitle[] = [
    { startMs: 0, endMs: 1_000, original: "一", translation: "one" },
    { startMs: 1_000, endMs: 2_000, original: "二", translation: "two" },
    { startMs: 3_000, endMs: 4_000, original: "三", translation: "three" },
  ];
  const FILL = "rgba(16, 32, 48, 0.4)";
  /** The drawn rows only, without the hidden line-box layer that repeats them. */
  const rows = (): string[] => [...screen.getByTestId("subtitle-text").querySelectorAll(":scope > [data-line]")].map((row) => `${row.getAttribute("data-line")}:${row.textContent}`);

  function labelled(props: { units: readonly SlicedUnitSubtitle[]; mode?: SubtitleDisplayMode; scope?: "both" | "original" | "translation"; order?: "original_first" | "translation_first" }) {
    const defaults = defaultSubtitleAppearance();
    writeAppearance("u1", {
      ...defaults,
      speaker: "change",
      bilingualOrder: props.order ?? defaults.bilingualOrder,
      ...(props.scope === undefined ? {} : { background: { ...defaults.background, enabled: true, color: "#102030", opacityPct: 40, scope: props.scope } }),
    });
    const mode = props.mode ?? "original";
    const shown = show({ slices: [], units: props.units, mode });
    layout(shown.video, { width: 1280, height: 720 }, { width: 1920, height: 1080 });
    return { video: shown.video, rerender: (units: readonly SlicedUnitSubtitle[]) => shown.rerender({ slices: [], units, mode }) };
  }
  const seek = (video: HTMLVideoElement, seconds: number) => {
    video.currentTime = seconds;
    fireEvent.seeking(video);
    fireEvent.seeked(video);
  };
  const playTo = (video: HTMLVideoElement, seconds: number) => {
    video.currentTime = seconds;
    fireEvent.timeUpdate(video);
  };

  it("draws the label above the cue's lines in the subtitle font, the first line's colour and the outline, scaled from its size", () => {
    labelled({ units: unitsOf(MONOLOGUE, ["a", "a", "a"]), mode: "bilingual", order: "translation_first" });
    expect(lines()).toEqual(["speaker:张三", "translation:one", "original:一"]);
    const text = screen.getByTestId("subtitle-text");
    const label = text.querySelector("[data-line='speaker']") as HTMLElement;
    const size = speakerLabelFontSize(SUBTITLE_TRANSLATION_FONT_SIZE);
    expect(parseFloat(label.style.fontSize)).toBeCloseTo((size * SUBTITLE_ASS_EM_RATIO * 720) / 1080);
    expect(parseFloat(label.style.lineHeight)).toBeCloseTo((size * 720) / 1080);
    expect(label.style.color).toBe((text.querySelector("[data-line='translation']") as HTMLElement).style.color);
    expect(label.style.getPropertyValue("-webkit-text-stroke")).toBe((text.querySelector("[data-line='original']") as HTMLElement).style.getPropertyValue("-webkit-text-stroke"));
    expect(label.style.getPropertyValue("-webkit-text-stroke")).not.toBe("");
    expect(SUBTITLE_TRANSLATION_COLOR).not.toBe(SUBTITLE_ORIGINAL_COLOR);
  });

  it("shows each mode's lines under the label with no box, a block box or a one-line box", () => {
    const shapes = {
      original: { cue: { startMs: 0, endMs: 1_000, original: "Hello" }, rows: ["speaker:张三", "original:Hello"] },
      translation: { cue: { startMs: 0, endMs: 1_000, translation: "你好" }, rows: ["speaker:张三", "translation:你好"] },
      bilingual: { cue: { startMs: 0, endMs: 1_000, original: "Hello", translation: "你好" }, rows: ["speaker:张三", "original:Hello", "translation:你好"] },
    } as const;
    for (const [mode, shape] of Object.entries(shapes) as Array<[keyof typeof shapes, (typeof shapes)[keyof typeof shapes]]>) {
      for (const scope of [undefined, "both", "translation"] as const) {
        cleanupRender();
        localStorage.clear();
        resetSubtitlePrefsMemory();
        labelled({ units: unitsOf([shape.cue], ["a"]), mode, ...(scope === undefined ? {} : { scope }) });
        expect(rows(), `${mode} ${scope}`).toEqual(shape.rows);
        // One language always takes the block box; two take the one-line box the scope asks for.
        const block = scope !== undefined && (scope === "both" || mode !== "bilingual");
        expect(screen.queryByTestId("subtitle-background") !== null, `${mode} ${scope}`).toBe(block);
        const lineBoxes = screen.queryAllByTestId("subtitle-line-background").map((box) => `${box.getAttribute("data-line")}:${box.textContent}`);
        // The label heads the original line here, which the translation box leaves bare.
        expect(lineBoxes, `${mode} ${scope}`).toEqual(scope === "translation" && mode === "bilingual" ? ["translation:你好"] : []);
      }
    }
  });

  it("boxes a label in a one-line box when the line it heads is boxed, and repeats it in the hidden layer", () => {
    labelled({ units: unitsOf([{ startMs: 0, endMs: 1_000, original: "Hello", translation: "你好" }], ["a"]), mode: "bilingual", scope: "translation", order: "translation_first" });
    const boxes = screen.getAllByTestId("subtitle-line-background");
    expect(boxes.map((box) => `${box.getAttribute("data-line")}:${box.textContent}`)).toEqual(["speaker:张三", "translation:你好"]);
    for (const box of boxes) expect(box.style.background).toBe(FILL);
    const layer = boxes[0]?.parentElement?.parentElement as HTMLElement;
    expect([...layer.children].map((row) => row.textContent)).toEqual(["张三", "你好", "Hello"]);
    // The block box, when on, holds the label: it spans the whole text box the label is in.
    cleanupRender();
    localStorage.clear();
    resetSubtitlePrefsMemory();
    labelled({ units: unitsOf([{ startMs: 0, endMs: 1_000, original: "Hello", translation: "你好" }], ["a"]), mode: "bilingual", scope: "both" });
    const background = screen.getByTestId("subtitle-background");
    expect(background.parentElement).toBe(screen.getByTestId("subtitle-text"));
    expect(background.parentElement?.querySelector("[data-line='speaker']")?.textContent).toBe("张三");
  });

  it("stacks two overlapping cues as two units, each under its own label, and names none in a crowd", () => {
    const pair = unitsOf(
      [
        { startMs: 0, endMs: 2_000, original: "A" },
        { startMs: 1_000, endMs: 3_000, original: "B" },
      ],
      ["a", "b"],
    );
    const { video } = labelled({ units: pair });
    seek(video, 1.5);
    expect(lines()).toEqual(["speaker:张三", "original:A", "speaker:李四", "original:B"]);
    cleanupRender();
    const crowd = Array.from({ length: SUBTITLE_SPEAKER_MAX_PARTS + 1 }, (_, index) => ({ startMs: index * 100, endMs: 2_000, original: `L${index}` }));
    const second = labelled({ units: unitsOf(crowd, ["a", "b", "c"]) });
    seek(second.video, 1.5);
    expect(lines()).toEqual(crowd.map((cue) => `original:${cue.original}`));
  });

  it("gives a name the crowd held back to the turn's next cue that is not crowded, from its start", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 3_000, original: "B" },
      { startMs: 0, endMs: 3_000, original: "C" },
      { startMs: 1_000, endMs: 2_000, original: "A1" },
      { startMs: 3_000, endMs: 4_000, original: "A2" },
      { startMs: 4_000, endMs: 5_000, original: "A3" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["b", "c", "a", "a", "a"]) });
    expect(lines()).toEqual(["original:B", "original:C"]);
    playTo(video, 1.5);
    expect(lines()).toEqual(["original:B", "original:C", "original:A1"]);
    playTo(video, 3.2);
    expect(lines()).toEqual(["speaker:张三", "original:A2"]);
    playTo(video, 4.2);
    expect(lines()).toEqual(["original:A3"]);
  });

  it("on change, names the first cue of a turn, and the first cue shown after a seek for as long as it is shown", () => {
    const originals = MONOLOGUE.map(({ translation: _translation, ...cue }) => cue);
    const { video } = labelled({ units: unitsOf(originals, ["a", "a", "a"]) });
    expect(lines()).toEqual(["speaker:张三", "original:一"]);
    seek(video, 1.4);
    expect(lines()).toEqual(["speaker:张三", "original:二"]);
    playTo(video, 1.9);
    expect(lines()).toEqual(["speaker:张三", "original:二"]);
    // A seek into a gap names the next cue shown.
    seek(video, 2.5);
    expect(screen.queryByTestId("subtitle-block")).toBeNull();
    playTo(video, 3.2);
    expect(lines()).toEqual(["speaker:张三", "original:三"]);
  });

  it("keeps a name earned by a seek on its cue when another cue joins it, and leaves the next cue to the rule", () => {
    // One speaker throughout, so on change only the first cue is named by the rule itself.
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "W" },
      { startMs: 1_000, endMs: 3_000, original: "X" },
      { startMs: 2_000, endMs: 4_000, original: "Y" },
      { startMs: 4_000, endMs: 5_000, original: "Z" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["a", "a", "a", "a"]) });
    seek(video, 1.5);
    expect(lines()).toEqual(["speaker:张三", "original:X"]);
    // Y joins: the slice changes, X is still the cue the seek landed on.
    playTo(video, 2.5);
    expect(lines()).toEqual(["speaker:张三", "original:X", "original:Y"]);
    // X has ended; Y was never the first cue after the seek, so the rule decides and leaves it bare.
    playTo(video, 3.5);
    expect(lines()).toEqual(["original:Y"]);
    playTo(video, 4.5);
    expect(lines()).toEqual(["original:Z"]);
  });

  it("names the next cue to appear after a seek into a gap, and only that cue", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "A" },
      { startMs: 2_000, endMs: 3_000, original: "B" },
      { startMs: 3_000, endMs: 4_000, original: "C" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["a", "a", "a"]) });
    playTo(video, 0.5);
    expect(lines()).toEqual(["speaker:张三", "original:A"]);
    seek(video, 1.5);
    expect(screen.queryByTestId("subtitle-block")).toBeNull();
    playTo(video, 1.8);
    expect(screen.queryByTestId("subtitle-block")).toBeNull();
    playTo(video, 2.2);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    playTo(video, 2.9);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    playTo(video, 3.2);
    expect(lines()).toEqual(["original:C"]);
  });

  it("never adds or removes a label while dragging within one cue", () => {
    const originals = MONOLOGUE.map(({ translation: _translation, ...cue }) => cue);
    const { video } = labelled({ units: unitsOf(originals, ["a", "a", "a"]) });
    // 二 is bare by the rule; seeks that stay within it change nothing.
    playTo(video, 1.2);
    expect(lines()).toEqual(["original:二"]);
    for (const at of [1.4, 1.1, 1.8]) {
      seek(video, at);
      expect(lines(), String(at)).toEqual(["original:二"]);
    }
    // 一 is named by the rule; dragging within it keeps the name.
    seek(video, 0.2);
    expect(lines()).toEqual(["speaker:张三", "original:一"]);
    seek(video, 0.8);
    expect(lines()).toEqual(["speaker:张三", "original:一"]);
    // A seek into 三 names it, and dragging within 三 keeps that name.
    seek(video, 3.1);
    expect(lines()).toEqual(["speaker:张三", "original:三"]);
    seek(video, 3.7);
    expect(lines()).toEqual(["speaker:张三", "original:三"]);
  });

  it("names only the cue a seek brings on screen; cues on screen before and after keep what they had", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 500, original: "W" },
      { startMs: 500, endMs: 4_000, original: "A" },
      { startMs: 1_000, endMs: 2_000, original: "B" },
      { startMs: 3_000, endMs: 4_000, original: "C" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["a", "a", "a", "a"]) });
    playTo(video, 1.5);
    expect(lines()).toEqual(["original:A", "original:B"]);
    // A stays on screen and stays bare; C is new and is named.
    seek(video, 3.5);
    expect(lines()).toEqual(["original:A", "speaker:张三", "original:C"]);
    seek(video, 3.8);
    expect(lines()).toEqual(["original:A", "speaker:张三", "original:C"]);
    // Seeking back: A keeps its state, B is new again and takes the name; C has left.
    seek(video, 1.5);
    expect(lines()).toEqual(["original:A", "speaker:张三", "original:B"]);
    // From W, A is the first new cue: it is named, and keeps the name as B joins after a further seek.
    seek(video, 0.2);
    seek(video, 0.7);
    expect(lines()).toEqual(["speaker:张三", "original:A"]);
    seek(video, 1.2);
    expect(lines()).toEqual(["speaker:张三", "original:A", "speaker:张三", "original:B"]);
    // A name leaves with its cue: back from W, A and C are both new, and only A, the first, is named.
    seek(video, 0.2);
    seek(video, 3.5);
    expect(lines()).toEqual(["speaker:张三", "original:A", "original:C"]);
  });

  it("judges a seek by what was on screen before it, even when a frame sees the new time before the seeking event", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "A" },
      { startMs: 1_000, endMs: 2_000, original: "B" },
      { startMs: 2_000, endMs: 3_000, original: "C" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["a", "a", "a"]) });
    let seeking = false;
    Object.defineProperty(video, "seeking", { configurable: true, get: () => seeking });
    playTo(video, 0.5);
    expect(lines()).toEqual(["speaker:张三", "original:A"]);
    // The time moves and the element is seeking; an update runs before the `seeking` event.
    seeking = true;
    playTo(video, 1.5);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    fireEvent.seeking(video);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    seeking = false;
    fireEvent.seeked(video);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    // The seeking event belonged to the seek the frame took, so it starts no second one and C is left to the rule.
    playTo(video, 2.5);
    expect(lines()).toEqual(["original:C"]);
  });

  it("follows the last of several seeks made while the element keeps seeking", () => {
    const cues: TimedSubtitle[] = [0, 1, 2, 3].map((at) => ({ startMs: at * 1_000, endMs: (at + 1) * 1_000, original: `C${at}` }));
    const { video } = labelled({ units: unitsOf(cues, ["a", "a", "a", "a"]) });
    let seeking = false;
    Object.defineProperty(video, "seeking", { configurable: true, get: () => seeking });
    playTo(video, 0.5);
    expect(lines()).toEqual(["speaker:张三", "original:C0"]);
    seeking = true;
    playTo(video, 1.5);
    expect(lines()).toEqual(["speaker:张三", "original:C1"]);
    fireEvent.seeking(video);
    // A second seek before the first one settles: a frame sees its time, then its own seeking event.
    playTo(video, 3.5);
    fireEvent.seeking(video);
    seeking = false;
    fireEvent.seeked(video);
    expect(lines()).toEqual(["speaker:张三", "original:C3"]);
  });

  it("names a cue on screen at a seek that left the screen and came back", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "A" },
      { startMs: 2_000, endMs: 3_000, original: "B" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["a", "a"]) });
    playTo(video, 0.5);
    expect(lines()).toEqual(["speaker:张三", "original:A"]);
    playTo(video, 2.5);
    expect(lines()).toEqual(["original:B"]);
    // Back into the gap before B: B leaves the screen, so it is new when it shows again.
    seek(video, 1.5);
    expect(screen.queryByTestId("subtitle-block")).toBeNull();
    playTo(video, 2.2);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
  });

  it("names the next cue to appear after a drag within a cue", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "A" },
      { startMs: 1_000, endMs: 2_000, original: "B" },
      { startMs: 2_000, endMs: 3_000, original: "C" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["a", "a", "a"]) });
    playTo(video, 0.2);
    expect(lines()).toEqual(["speaker:张三", "original:A"]);
    seek(video, 0.6);
    expect(lines()).toEqual(["speaker:张三", "original:A"]);
    playTo(video, 1.5);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    playTo(video, 2.5);
    expect(lines()).toEqual(["original:C"]);
  });

  it("names the first new cue that can carry a name, passing over unassigned and crowded ones", () => {
    // Hand-made: U is unassigned, so it has no label to show; X and Y may be named but the rule names neither.
    const handMade = sliceSubtitleUnits([
      { startMs: 0, endMs: 1_000, original: "W", label: "张三", labeled: true, crowded: false },
      { startMs: 2_000, endMs: 3_000, original: "U", labeled: false, crowded: false },
      { startMs: 2_000, endMs: 3_000, original: "X", label: "张三", labeled: false, crowded: false },
      { startMs: 2_000, endMs: 3_000, original: "Y", label: "张三", labeled: false, crowded: false },
    ]);
    const first = labelled({ units: handMade });
    seek(first.video, 2.5);
    expect(lines()).toEqual(["original:U", "speaker:张三", "original:X", "original:Y"]);
    cleanupRender();

    // K0 shares the screen with a crowd for a while, so it never carries a name; Z joins it later, uncrowded.
    const crowd = Array.from({ length: SUBTITLE_SPEAKER_MAX_PARTS }, (_, index) => ({ startMs: 2_000, endMs: 3_000, original: `K${index + 1}` }));
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "W" },
      { startMs: 2_000, endMs: 5_000, original: "K0" },
      ...crowd,
      { startMs: 3_500, endMs: 4_500, original: "Z" },
      { startMs: 5_000, endMs: 6_000, original: "Q" },
    ];
    const units = unitsOf(cues, cues.map(() => "a"));
    const second = labelled({ units });
    // Landing on K0 and Z together: K0 comes first but is crowded, so Z is named.
    seek(second.video, 3.8);
    expect(lines()).toEqual(["original:K0", "speaker:张三", "original:Z"]);
    cleanupRender();
    // Landing in the crowd names nobody there, and the seek waits for Z.
    const third = labelled({ units });
    playTo(third.video, 0.5);
    seek(third.video, 2.5);
    expect(lines()).toEqual(["original:K0", ...crowd.map((cue) => `original:${cue.original}`)]);
    playTo(third.video, 3.8);
    expect(lines()).toEqual(["original:K0", "speaker:张三", "original:Z"]);
    playTo(third.video, 5.5);
    expect(lines()).toEqual(["original:Q"]);
  });

  it("keeps a seek's name on its cue through a re-read of the subtitles, a renamed speaker included", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "A" },
      { startMs: 2_000, endMs: 3_000, original: "B" },
      { startMs: 5_000, endMs: 6_000, original: "D" },
    ];
    const speakers = ["a", "a", "b"];
    const { video, rerender } = labelled({ units: unitsOf(cues, speakers) });
    playTo(video, 0.5);
    seek(video, 2.2);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    // The same subtitles read again: new objects, equal content.
    rerender(sliceSubtitleUnits(labelSubtitleCues(cues.map((cue) => ({ ...cue })), [...speakers], new Map(LABELS), "change")));
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    // Another speaker renamed: B keeps its name line.
    rerender(sliceSubtitleUnits(labelSubtitleCues(cues, speakers, new Map([...LABELS, ["b", "赵六"]]), "change")));
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    playTo(video, 2.9);
    expect(lines()).toEqual(["speaker:张三", "original:B"]);
    // B's own speaker renamed: the line stays and reads the new name.
    rerender(sliceSubtitleUnits(labelSubtitleCues(cues, speakers, new Map([...LABELS, ["a", "钱七"]]), "change")));
    expect(lines()).toEqual(["speaker:钱七", "original:B"]);
  });

  it("never adds a name to a cue on screen when the subtitles are read again", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1_000, original: "A" },
      { startMs: 2_000, endMs: 3_000, original: "B" },
    ];
    const { video, rerender } = labelled({ units: unitsOf(cues, ["a", "a"]) });
    playTo(video, 0.5);
    playTo(video, 2.2);
    expect(lines()).toEqual(["original:B"]);
    // A drag within B leaves a seek waiting; a re-read is no new appearance of B.
    seek(video, 2.6);
    rerender(sliceSubtitleUnits(labelSubtitleCues(cues, ["a", "a"], new Map([...LABELS, ["b", "赵六"]]), "change")));
    expect(lines()).toEqual(["original:B"]);
    playTo(video, 2.9);
    expect(lines()).toEqual(["original:B"]);
  });

  it("labels each unit in the look of the first line it shows itself", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 2_000, original: "Alone" },
      { startMs: 1_000, endMs: 3_000, original: "Hello", translation: "你好" },
    ];
    const { video } = labelled({ units: unitsOf(cues, ["a", "b"]), mode: "bilingual", order: "translation_first" });
    seek(video, 1.5);
    expect(rows()).toEqual(["speaker:张三", "original:Alone", "speaker:李四", "translation:你好", "original:Hello"]);
    const text = screen.getByTestId("subtitle-text");
    const look = (selector: string) => {
      const element = text.querySelector(selector) as HTMLElement;
      return { fontSize: element.style.fontSize, lineHeight: element.style.lineHeight, color: element.style.color, stroke: element.style.getPropertyValue("-webkit-text-stroke") };
    };
    // Computed as the overlay does: 1080p pixels times the picture's scale.
    const scale = 720 / 1080;
    const px = (size: number) => ({ fontSize: `${size * SUBTITLE_ASS_EM_RATIO * scale}px`, lineHeight: `${size * scale}px` });
    const originalLook = look("[data-unit='0'][data-line='original']");
    const translationLook = look("[data-unit='1'][data-line='translation']");
    // A cue without a translation: its label copies the original line even with the translation first.
    expect(look("[data-unit='0'][data-line='speaker']")).toEqual({ ...px(speakerLabelFontSize(SUBTITLE_ORIGINAL_FONT_SIZE)), color: originalLook.color, stroke: originalLook.stroke });
    expect(look("[data-unit='1'][data-line='speaker']")).toEqual({ ...px(speakerLabelFontSize(SUBTITLE_TRANSLATION_FONT_SIZE)), color: translationLook.color, stroke: translationLook.stroke });
    expect(originalLook.color).not.toBe(translationLook.color);
  });

  it("names the sample in the editor so the label's look can be set before anyone speaks", () => {
    writeAppearance("u1", { ...defaultSubtitleAppearance(), speaker: "every" });
    const { video } = show({ slices: [], units: [], editing: true, mode: "original" });
    layout(video, { width: 1280, height: 720 }, { width: 1920, height: 1080 });
    expect(lines()).toEqual(["speaker:发言人 1", "original:This is a sample subtitle"]);
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
