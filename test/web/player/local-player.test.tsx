import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYER_CONTROLS_IDLE_MS, PLAYER_SEEK_TOLERANCE_MS, PLAYER_SKIP_SECONDS, PLAYER_VOLUME_STEP } from "../../../src/shared/defaults.ts";
import type { AdvanceResult } from "../../../src/web/player/list-loop.ts";
import { LocalPlayer } from "../../../src/web/player/local-player.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import type { EndBehavior, PlayerSettings } from "../../../src/web/player/player-settings.ts";

const settings = vi.hoisted(() => ({ endBehavior: "pause" as EndBehavior, autoplay: false }));

vi.mock("../../../src/web/player/player-settings.ts", () => ({
  END_BEHAVIORS: ["pause", "loop_one", "loop_list"],
  usePlayerSettings: (): PlayerSettings => ({ ...settings, setEndBehavior: () => undefined, setAutoplay: () => undefined }),
}));

// Stand-ins for the menus: a trigger that opens / closes and picks a rate, recording where the popup would go.
const menus = vi.hoisted(() => ({ containers: [] as Array<HTMLElement | null> }));
vi.mock("../../../src/web/player/player-menus.tsx", () => ({
  PLAYBACK_RATES: [2, 1.5, 1.25, 1, 0.75, 0.5],
  PlaybackRateMenu: (props: { rate: number; onRate: (rate: number) => void; container: HTMLElement | null; onOpenChange?: (open: boolean) => void }) => {
    menus.containers.push(props.container);
    return (
      <>
        <button type="button" data-testid="rate-menu" onClick={() => props.onRate(1.5)}>
          {`${props.rate}×`}
        </button>
        <button type="button" data-testid="rate-menu-open" onClick={() => props.onOpenChange?.(true)} />
        <button type="button" data-testid="rate-menu-close" onClick={() => props.onOpenChange?.(false)} />
      </>
    );
  },
  PlayerSettingsMenu: (props: { container: HTMLElement | null }) => {
    menus.containers.push(props.container);
    return <button type="button" data-testid="settings-menu" />;
  },
  QualityMenu: (props: {
    sources: ReadonlyArray<{ assetId: string; label: string }>;
    activeId: string | undefined;
    onSelect: (assetId: string) => void;
    container: HTMLElement | null;
    onOpenChange?: (open: boolean) => void;
  }) => {
    menus.containers.push(props.container);
    return (
      <>
        <span data-testid="quality-active">{props.sources.find((source) => source.assetId === props.activeId)?.label}</span>
        {props.sources.map((source) => (
          <button key={source.assetId} type="button" data-testid={`quality-item-${source.assetId}`} onClick={() => props.onSelect(source.assetId)}>
            {source.label}
          </button>
        ))}
        <button type="button" data-testid="quality-menu-open" onClick={() => props.onOpenChange?.(true)} />
      </>
    );
  },
}));

function show(props: Parameters<typeof LocalPlayer>[0] = { src: "/fixture.mp4" }, controller = new PlayerController()) {
  const result = render(
    <PlayerControllerProvider controller={controller}>
      <LocalPlayer {...props} />
    </PlayerControllerProvider>,
  );
  const root = screen.getByTestId("player-local");
  const video = root.querySelector("video") as HTMLVideoElement;
  return { ...result, controller, root, video };
}

/** The clock as the user reads it: the editable current time, then the total. */
function clockText(): string {
  const input = screen.getByTestId("player-clock-input") as HTMLInputElement;
  return `${input.value}${screen.getByTestId("player-clock-total").textContent ?? ""}`;
}

/** Makes the video's play() / pause() flip `paused` and fire the media events, as a browser would. */
function playable(video: HTMLVideoElement) {
  let paused = true;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  const play = vi.spyOn(video, "play").mockImplementation(() => {
    paused = false;
    fireEvent.play(video);
    return Promise.resolve();
  });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
    fireEvent.pause(video);
  });
  return { play, pause };
}

/** A fake Fullscreen API: requesting makes the element the document's fullscreen element. */
function fakeFullscreen() {
  let current: Element | null = null;
  const change = (next: Element | null): void => {
    current = next;
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
  };
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => current });
  const request = vi.fn(function (this: Element) {
    change(this);
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    change(null);
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  return { request, exit };
}

beforeEach(() => {
  localStorage.clear();
  settings.endBehavior = "pause";
  settings.autoplay = false;
  menus.containers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "exitFullscreen");
  Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
});

describe("LocalPlayer", () => {
  it("has no subtitle menu, overlay or editor without subtitles", () => {
    const { root } = show();
    expect(root.querySelector("[data-subtitle-control]")).toBeNull();
    expect(screen.queryByTestId("subtitle-overlay")).toBeNull();
    expect(screen.queryByTestId("subtitle-editor")).toBeNull();
    expect([...root.querySelectorAll("[data-control]")].map((element) => element.getAttribute("data-control"))).toEqual(["play", "clock", "rate", "volume", "settings", "fullscreen"]);
  });

  it("seeks directly and skips with the arrow keys only while focused", () => {
    const { controller, root, video } = show();
    act(() => controller.seek(42_300));
    expect(Math.abs(video.currentTime * 1000 - 42_300)).toBeLessThanOrEqual(PLAYER_SEEK_TOLERANCE_MS);
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(Math.round(video.currentTime)).toBe(42 + PLAYER_SKIP_SECONDS);
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(Math.round(video.currentTime)).toBe(42);
    expect(controller.capabilities.timeTracking).toBe("supported");
  });

  it("lands a seek within the tolerance of its target", () => {
    const { controller, video } = show({ src: "asset://localhost/fixture.mp4" });
    for (const ms of [0, 1_234, 3_599_999]) {
      act(() => controller.seek(ms));
      expect(Math.abs(video.currentTime * 1000 - ms)).toBeLessThanOrEqual(PLAYER_SEEK_TOLERANCE_MS);
    }
  });

  it("has a seek bar showing current and total time; dragging seeks and is not overwritten by playback", () => {
    const { video } = show();
    const bar = screen.getByTestId("player-seek") as HTMLInputElement;
    // Until the duration is known there is nothing to seek in.
    expect(bar.disabled).toBe(true);
    expect(clockText()).toBe("0:00 / --:--");
    Object.defineProperty(video, "duration", { configurable: true, value: 3_725 });
    fireEvent.loadedMetadata(video);
    expect(bar.disabled).toBe(false);
    expect(bar.max).toBe("3725000");
    expect(clockText()).toBe("0:00 / 1:02:05");

    fireEvent.change(bar, { target: { value: "600000" } });
    expect(video.currentTime).toBe(600);
    // A late time update from before the drag does not pull the bar back while it is held.
    video.currentTime = 5;
    fireEvent.timeUpdate(video);
    expect(bar.value).toBe("600000");
    expect(clockText()).toBe("10:00 / 1:02:05");
    fireEvent.pointerUp(bar);
    expect(bar.value).toBe("5000");
  });

  it("lays the controls over the picture: seek bar, then play · time · speed on the left and volume · settings · fullscreen on the right", () => {
    const { root } = show();
    const controls = within(root).getByTestId("player-controls");
    expect(within(root).getByTestId("player-overlay").contains(controls)).toBe(true);
    const order = [...controls.querySelectorAll<HTMLElement>("[data-control]")].map((element) => element.dataset["control"]);
    expect(order).toEqual(["play", "clock", "rate", "volume", "settings", "fullscreen"]);
    // The seek bar spans the row above the buttons.
    const seek = within(controls).getByTestId("player-seek");
    const play = controls.querySelector("[data-control='play']") as HTMLElement;
    expect(seek.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No ±10 s buttons and no autoplay checkbox any more; the menus pop up inside the player.
    expect(within(root).queryByRole("checkbox")).toBeNull();
    expect(within(root).queryByRole("button", { name: `后退 ${PLAYER_SKIP_SECONDS} 秒` })).toBeNull();
    expect(menus.containers.at(-1)).toBe(root);
  });

  it("covers the empty picture of an audio-only file, keeps its controls and offers no fullscreen", () => {
    const { request } = fakeFullscreen();
    const controller = new PlayerController();
    const { rerender, root, video } = show({ src: "/fixture.mp3", audioOnly: true }, controller);
    expect(screen.getByTestId("player-audio-only").textContent).toBe("仅音频，没有画面");
    act(() => controller.seek(5_000));
    expect(Math.round(video.currentTime)).toBe(5);
    expect(screen.getByTestId("player-seek")).toBeTruthy();
    expect(screen.queryByTestId("player-fullscreen")).toBeNull();
    fireEvent.keyDown(root, { key: "f" });
    fireEvent.doubleClick(video);
    expect(request).not.toHaveBeenCalled();
    // Nothing to look at, so the controls never hide while it plays.
    vi.useFakeTimers();
    fireEvent.play(video);
    fireEvent.pointerMove(root);
    act(() => vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS));
    expect(root.dataset["controls"]).toBe("shown");
    rerender(
      <PlayerControllerProvider controller={controller}>
        <LocalPlayer src="/fixture.mp4" />
      </PlayerControllerProvider>,
    );
    expect(screen.queryByTestId("player-audio-only")).toBeNull();
    expect(screen.getByTestId("player-fullscreen")).toBeTruthy();
  });

  it("plays and pauses on a click anywhere on the picture, the audio-only cover included, but not on the controls", () => {
    const { root, video } = show({ src: "/fixture.mp3", audioOnly: true });
    const { play, pause } = playable(video);
    // The cover lets clicks through to the video underneath.
    expect(screen.getByTestId("player-audio-only").className).toContain("pointer-events-none");
    fireEvent.click(video);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.click(video);
    expect(pause).toHaveBeenCalledTimes(1);
    fireEvent.click(within(root).getByTestId("player-controls"));
    fireEvent.doubleClick(within(root).getByTestId("player-clock"));
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    // The play button names what it will do.
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("jumps to a time typed into the clock, keeping the player's keys and clicks out of the field", () => {
    const { root, video } = show();
    const { play } = playable(video);
    Object.defineProperty(video, "duration", { configurable: true, value: 3_725 });
    fireEvent.loadedMetadata(video);
    const input = screen.getByRole("textbox", { name: "跳转到时间" }) as HTMLInputElement;
    expect(within(screen.getByTestId("player-clock")).getByTestId("player-clock-input")).toBe(input);

    // Clicking into the field is not a click on the picture.
    fireEvent.click(input);
    fireEvent.doubleClick(input);
    act(() => input.focus());
    // Space, arrows and F type into the field instead of driving the player.
    fireEvent.keyDown(input, { key: " " });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(play).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(0);

    fireEvent.change(input, { target: { value: "1:02:00" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(video.currentTime).toBe(3_720);
    expect(document.activeElement).toBe(root);
    // Back on the player, its keys work again.
    fireEvent.keyDown(root, { key: " " });
    expect(play).toHaveBeenCalledTimes(1);

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(video.currentTime).toBe(3_720);
    expect(document.activeElement).toBe(root);
  });

  it("stays paused when the source refuses to play", async () => {
    const { video } = show({ src: "/missing.mp4" });
    Object.defineProperty(video, "paused", { configurable: true, get: () => true });
    const play = vi.spyOn(video, "play").mockRejectedValue(new DOMException("unsupported", "NotSupportedError"));
    fireEvent.click(video);
    await act(async () => {
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
  });

  it("restores the stored volume and mute, and keeps changes from the button, the slider and ↑ / ↓", () => {
    localStorage.setItem("amber.player.volume", "0.4");
    localStorage.setItem("amber.player.muted", "1");
    const { root, video, unmount } = show();
    expect(video.volume).toBe(0.4);
    expect(video.muted).toBe(true);
    expect(screen.getByTestId("player-volume-percent").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
    expect(video.muted).toBe(false);
    expect(localStorage.getItem("amber.player.muted")).toBe("0");
    expect(screen.getByTestId("player-volume-percent").textContent).toBe("40");

    fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(video.volume).toBeCloseTo(0.4 + PLAYER_VOLUME_STEP);
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(video.volume).toBeCloseTo(0.4 - PLAYER_VOLUME_STEP);
    expect(Number(localStorage.getItem("amber.player.volume"))).toBeCloseTo(0.4 - PLAYER_VOLUME_STEP);
    // The level never leaves 0–1.
    for (let index = 0; index < 20; index += 1) fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(video.volume).toBe(1);

    fireEvent.change(screen.getByTestId("player-volume-range"), { target: { value: "25" } });
    expect(video.volume).toBe(0.25);
    fireEvent.click(screen.getByRole("button", { name: "静音" }));
    expect(video.muted).toBe(true);
    unmount();

    const again = show();
    expect(again.video.volume).toBe(0.25);
    expect(again.video.muted).toBe(true);
  });

  it("sets the playback rate from the speed menu", () => {
    const { video } = show();
    fireEvent.click(screen.getByTestId("rate-menu"));
    expect(video.playbackRate).toBe(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);
    expect(screen.getByTestId("rate-menu").textContent).toBe("1.5×");
  });

  it("enters and leaves fullscreen on the player itself with F, the button and a double click on the picture", () => {
    const { request, exit } = fakeFullscreen();
    const { root, video } = show();
    fireEvent.keyDown(root, { key: "f" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.contexts[0]).toBe(root);
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeTruthy();
    fireEvent.keyDown(root, { key: "F" });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "全屏" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("player-fullscreen"));
    expect(request).toHaveBeenCalledTimes(2);
    // Escape leaves fullscreen even where the host does not do it itself.
    fireEvent.keyDown(root, { key: "Escape" });
    expect(exit).toHaveBeenCalledTimes(2);

    fireEvent.doubleClick(video);
    expect(request).toHaveBeenCalledTimes(3);
    // Another element going fullscreen is not this player's fullscreen.
    act(() => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => document.body });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(screen.getByRole("button", { name: "全屏" })).toBeTruthy();
  });

  it("ignores keys with Ctrl, Meta or Alt and keys meant for form controls", () => {
    const { request } = fakeFullscreen();
    const { root, video } = show();
    const { play } = playable(video);
    video.currentTime = 30;
    fireEvent.keyDown(root, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(root, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(root, { key: " ", altKey: true });
    fireEvent.keyDown(root, { key: "f", ctrlKey: true });
    fireEvent.keyDown(root, { key: "ArrowUp", altKey: true });
    expect(video.currentTime).toBe(30);
    expect(play).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(video.volume).toBe(1);
    // The volume slider is an input: its arrows move the slider, not the player.
    fireEvent.keyDown(screen.getByTestId("player-volume-range"), { key: "ArrowLeft" });
    expect(video.currentTime).toBe(30);
  });

  it("hides the controls while playing after the pointer rests or leaves, leaving a progress line", () => {
    vi.useFakeTimers();
    const { root, video } = show();
    playable(video);
    expect(root.dataset["controls"]).toBe("shown");
    fireEvent.play(video);
    // Playing without the pointer over the picture: hidden at once.
    expect(root.dataset["controls"]).toBe("hidden");
    expect(within(root).getByTestId("player-progress-line")).toBeTruthy();
    fireEvent.pointerMove(root);
    expect(root.dataset["controls"]).toBe("shown");
    expect(within(root).queryByTestId("player-progress-line")).toBeNull();
    act(() => vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS - 1));
    expect(root.dataset["controls"]).toBe("shown");
    act(() => vi.advanceTimersByTime(1));
    expect(root.dataset["controls"]).toBe("hidden");
    fireEvent.pointerMove(root);
    fireEvent.pointerLeave(root);
    expect(root.dataset["controls"]).toBe("hidden");

    // An open menu keeps them.
    fireEvent.pointerMove(root);
    fireEvent.click(screen.getByTestId("rate-menu-open"));
    act(() => vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS));
    expect(root.dataset["controls"]).toBe("shown");
    fireEvent.click(screen.getByTestId("rate-menu-close"));
    expect(root.dataset["controls"]).toBe("hidden");

    // Keyboard focus inside them keeps them; a mouse click's focus does not.
    const matches = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible";
    });
    act(() => screen.getByTestId("settings-menu").focus());
    expect(root.dataset["controls"]).toBe("shown");
    act(() => root.focus());
    expect(root.dataset["controls"]).toBe("hidden");
    matches.mockRestore();
    act(() => screen.getByTestId("settings-menu").focus());
    expect(root.dataset["controls"]).toBe("hidden");

    // Paused: always shown.
    fireEvent.pause(video);
    expect(root.dataset["controls"]).toBe("shown");
  });

  it("follows the play mode at the end: loops one file, or asks the list for the next and replays when it says so", async () => {
    settings.endBehavior = "loop_one";
    const first = show();
    expect(first.video.loop).toBe(true);
    first.unmount();

    settings.endBehavior = "loop_list";
    let answer: AdvanceResult = "replay";
    const onEndedAdvance = vi.fn(async () => answer);
    const { video, unmount } = show({ src: "/fixture.mp4", onEndedAdvance });
    expect(video.loop).toBe(false);
    const { play } = playable(video);
    video.currentTime = 99;
    fireEvent.ended(video);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onEndedAdvance).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    answer = "stay";
    video.currentTime = 99;
    fireEvent.ended(video);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onEndedAdvance).toHaveBeenCalledTimes(2);
    expect(video.currentTime).toBe(99);
    expect(play).toHaveBeenCalledTimes(1);
    unmount();

    settings.endBehavior = "pause";
    const paused = show({ src: "/fixture.mp4", onEndedAdvance });
    fireEvent.ended(paused.video);
    expect(onEndedAdvance).toHaveBeenCalledTimes(2);
  });

  it("starts by itself when the autoplay setting is on or the list loop asks for it", () => {
    const off = show();
    expect(off.video.autoplay).toBe(false);
    off.unmount();
    const forced = show({ src: "/fixture.mp4", autoplay: true });
    expect(forced.video.autoplay).toBe(true);
    forced.unmount();
    settings.autoplay = true;
    expect(show().video.autoplay).toBe(true);
  });

  describe("switching between cached qualities", () => {
    const SOURCES = [
      { assetId: "hd", label: "1080P" },
      { assetId: "sd", label: "720P" },
    ];
    const SRC: Record<string, string> = { hd: "/hd.mp4", sd: "/sd.mp4", ld: "/ld.mp4", hd2: "/hd.mp4" };

    /**
     * The page side: the chosen source becomes the active one, with its own file. `sources`
     * replaces the list; `dropOnSelect` removes a source from it once another is chosen, as
     * when a cache is deleted while the player switches.
     */
    function Switcher(props: {
      onSelect?: (assetId: string) => void;
      onEndedAdvance?: () => Promise<AdvanceResult>;
      sameSrc?: boolean;
      sources?: typeof SOURCES;
      dropOnSelect?: string;
    }) {
      const [active, setActive] = useState("hd");
      const [sources, setSources] = useState(props.sources ?? SOURCES);
      return (
        <LocalPlayer
          src={props.sameSrc === true ? "/same.mp4" : (SRC[active] ?? "")}
          sources={sources}
          activeSourceId={active}
          onSelectSource={(assetId) => {
            props.onSelect?.(assetId);
            // Like the page, a source that is no longer listed is not switched to.
            if (!sources.some((source) => source.assetId === assetId)) return;
            if (props.dropOnSelect !== undefined) setSources((list) => list.filter((source) => source.assetId !== props.dropOnSelect));
            setActive(assetId);
          }}
          {...(props.onEndedAdvance === undefined ? {} : { onEndedAdvance: props.onEndedAdvance })}
        />
      );
    }

    function showSwitcher(props: Parameters<typeof Switcher>[0] = {}, controller = new PlayerController()) {
      render(
        <PlayerControllerProvider controller={controller}>
          <Switcher {...props} />
        </PlayerControllerProvider>,
      );
      const root = screen.getByTestId("player-local");
      return { root, current: () => root.querySelector("video") as HTMLVideoElement };
    }

    /** The new file's metadata arrives with `seconds` of length. */
    function loaded(video: HTMLVideoElement, seconds: number): void {
      Object.defineProperty(video, "duration", { configurable: true, value: seconds });
      fireEvent.loadedMetadata(video);
    }

    it("puts the quality button first in the right-hand group, only when there are sources", () => {
      const { root } = showSwitcher();
      const order = [...root.querySelectorAll<HTMLElement>("[data-control]")].map((element) => element.dataset["control"]);
      expect(order).toEqual(["play", "clock", "rate", "quality", "volume", "settings", "fullscreen"]);
      expect(within(root).getByTestId("quality-active").textContent).toBe("1080P");
      expect(menus.containers.at(-1)).toBe(root);
    });

    it("offers no quality button for an audio-only file", () => {
      const { root } = show({ src: "/a.mp3", audioOnly: true, sources: SOURCES, activeSourceId: "hd" });
      expect(root.querySelector("[data-control='quality']")).toBeNull();
    });

    it("keeps the controls shown while the quality menu is open", () => {
      vi.useFakeTimers();
      const { root, current } = showSwitcher();
      playable(current()).play.call(current());
      fireEvent.pointerMove(root);
      fireEvent.click(within(root).getByTestId("quality-menu-open"));
      act(() => vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS + 1));
      expect(root.dataset["controls"]).toBe("shown");
    });

    it("loads the new file in a new element, resumes where it was and keeps playing and the speed", () => {
      settings.autoplay = true;
      const { root, current } = showSwitcher();
      const first = current();
      playable(first);
      void first.play();
      first.currentTime = 42;
      fireEvent.click(within(root).getByTestId("rate-menu"));
      expect(first.playbackRate).toBe(1.5);
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      const second = current();
      expect(second).not.toBe(first);
      expect(second.getAttribute("src")).toBe("/sd.mp4");
      // Nothing starts by itself while switching, whatever the autoplay setting says.
      expect(second.autoplay).toBe(false);
      expect(second.playbackRate).toBe(1.5);
      const { play } = playable(second);
      loaded(second, 100);
      expect(second.currentTime).toBe(42);
      expect(play).toHaveBeenCalledTimes(1);
      expect(second.autoplay).toBe(false);
      expect(within(root).getByTestId("quality-active").textContent).toBe("720P");
    });

    it("stays paused when it was paused, and clamps to the end of a shorter file", () => {
      const { root, current } = showSwitcher();
      const first = current();
      first.currentTime = 42;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      const second = current();
      const { play } = playable(second);
      loaded(second, 30);
      expect(second.currentTime).toBe(30);
      expect(play).not.toHaveBeenCalled();
    });

    it("reloads even when the new source has the same URL", () => {
      const { root, current } = showSwitcher({ sameSrc: true });
      const first = current();
      first.currentTime = 7;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      const second = current();
      expect(second).not.toBe(first);
      expect(second.getAttribute("src")).toBe("/same.mp4");
      loaded(second, 100);
      expect(second.currentTime).toBe(7);
    });

    it("goes back to the previous file with a notice when the new one fails to load", () => {
      const onSelect = vi.fn<(assetId: string) => void>();
      const { root, current } = showSwitcher({ onSelect });
      const first = current();
      playable(first);
      void first.play();
      first.currentTime = 12;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      fireEvent.error(current());
      expect(onSelect.mock.calls).toEqual([["sd"], ["hd"]]);
      const third = current();
      expect(third.getAttribute("src")).toBe("/hd.mp4");
      expect(within(root).getByTestId("player-notice").textContent).toBe("无法加载所选清晰度，已切回 1080P");
      const { play } = playable(third);
      loaded(third, 100);
      expect(third.currentTime).toBe(12);
      expect(play).toHaveBeenCalledTimes(1);
      // A failure outside a switch is not a reason to switch.
      fireEvent.error(third);
      expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it("keeps the position and play state of the first pick when another quality is picked before it loaded", () => {
      const onSelect = vi.fn<(assetId: string) => void>();
      const { root, current } = showSwitcher({ onSelect, sources: [...SOURCES, { assetId: "ld", label: "480P" }] });
      const first = current();
      playable(first);
      void first.play();
      first.currentTime = 42;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      // The 720p file is still loading: its element reads 0 and paused.
      const second = current();
      playable(second);
      expect(second.currentTime).toBe(0);
      fireEvent.click(within(root).getByTestId("quality-item-ld"));
      const third = current();
      expect(third.getAttribute("src")).toBe("/ld.mp4");
      const { play } = playable(third);
      loaded(third, 100);
      expect(third.currentTime).toBe(42);
      expect(play).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls).toEqual([["sd"], ["ld"]]);
    });

    it("falls back to the file that last played when a re-picked quality fails", () => {
      const onSelect = vi.fn<(assetId: string) => void>();
      const { root, current } = showSwitcher({ onSelect, sources: [...SOURCES, { assetId: "ld", label: "480P" }] });
      current().currentTime = 21;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      fireEvent.click(within(root).getByTestId("quality-item-ld"));
      fireEvent.error(current());
      expect(onSelect.mock.calls).toEqual([["sd"], ["ld"], ["hd"]]);
      expect(within(root).getByTestId("player-notice").textContent).toBe("无法加载所选清晰度，已切回 1080P");
      loaded(current(), 100);
      expect(current().currentTime).toBe(21);
    });

    it("ends the switch with a notice when the file to fall back to is gone too", async () => {
      settings.endBehavior = "loop_list";
      const onSelect = vi.fn<(assetId: string) => void>();
      const onEndedAdvance = vi.fn(async (): Promise<AdvanceResult> => "stay");
      const { root, current } = showSwitcher({ onSelect, onEndedAdvance, dropOnSelect: "hd" });
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      fireEvent.error(current());
      // Nothing to go back to: no request for the deleted file, and the plain failure notice.
      expect(onSelect.mock.calls).toEqual([["sd"]]);
      expect(within(root).getByTestId("player-notice").textContent).toBe("无法加载所选清晰度");
      // The switch is over, so the end of the video steps the list loop again.
      fireEvent.ended(current());
      await act(async () => {
        await Promise.resolve();
      });
      expect(onEndedAdvance).toHaveBeenCalledTimes(1);
    });

    it("lets a seek during the switch win over the carried position", () => {
      const controller = new PlayerController();
      const { root, current } = showSwitcher({}, controller);
      const first = current();
      playable(first);
      void first.play();
      first.currentTime = 42;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      act(() => controller.seek(90_000));
      const second = current();
      const { play } = playable(second);
      loaded(second, 100);
      expect(second.currentTime).toBe(90);
      expect(play).toHaveBeenCalledTimes(1);
    });

    it("steps the arrow keys from the carried position during the switch", () => {
      const { root, current } = showSwitcher();
      current().currentTime = 42;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      fireEvent.keyDown(root, { key: "ArrowRight" });
      loaded(current(), 100);
      expect(current().currentTime).toBe(42 + PLAYER_SKIP_SECONDS);
    });

    it("lets a pause during the switch win over the carried play state", () => {
      const { root, current } = showSwitcher();
      const first = current();
      playable(first);
      void first.play();
      first.currentTime = 42;
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      const second = current();
      const { play } = playable(second);
      fireEvent.click(root.querySelector("[data-control='play']") as HTMLElement);
      loaded(second, 100);
      expect(second.currentTime).toBe(42);
      expect(play).not.toHaveBeenCalled();
      expect(second.paused).toBe(true);
      expect(root.querySelector("[data-control='play']")?.getAttribute("aria-label")).toBe("播放");
    });

    it("does not step the list loop when the old file ends during the switch", async () => {
      settings.endBehavior = "loop_list";
      const onEndedAdvance = vi.fn(async (): Promise<AdvanceResult> => "stay");
      const { root, current } = showSwitcher({ onEndedAdvance });
      fireEvent.click(within(root).getByTestId("quality-item-sd"));
      fireEvent.ended(current());
      await act(async () => {
        await Promise.resolve();
      });
      expect(onEndedAdvance).not.toHaveBeenCalled();
      loaded(current(), 100);
      fireEvent.ended(current());
      await act(async () => {
        await Promise.resolve();
      });
      expect(onEndedAdvance).toHaveBeenCalledTimes(1);
    });

    it("carries the position over when the page replaces the file by itself", () => {
      const controller = new PlayerController();
      const view = (activeSourceId: string) => (
        <PlayerControllerProvider controller={controller}>
          <LocalPlayer src="/hd.mp4" sources={SOURCES} activeSourceId={activeSourceId} onSelectSource={() => undefined} />
        </PlayerControllerProvider>
      );
      const { rerender } = render(view("hd"));
      const root = screen.getByTestId("player-local");
      const first = root.querySelector("video") as HTMLVideoElement;
      first.currentTime = 33;
      rerender(view("hd2"));
      const second = root.querySelector("video") as HTMLVideoElement;
      expect(second).not.toBe(first);
      loaded(second, 100);
      expect(second.currentTime).toBe(33);
    });
  });
});
