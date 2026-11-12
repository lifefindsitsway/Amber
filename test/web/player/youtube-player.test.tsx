import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import { YoutubePlayer } from "../../../src/web/player/youtube-player.tsx";

interface Events {
  onReady?: () => void;
  onStateChange?: (event: { data: number }) => void;
}

// A stand-in for the IFrame API that records what the player asked of it.
const api = vi.hoisted(() => ({
  events: undefined as Events | undefined,
  seekTo: vi.fn(),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  duration: 3_600,
  time: 0,
}));

vi.mock("../../../src/web/player/youtube-api.ts", () => ({
  loadYoutubeApi: () =>
    Promise.resolve({
      Player: class {
        constructor(_element: unknown, options: { events?: Events }) {
          api.events = options.events;
        }
        seekTo = api.seekTo;
        playVideo = api.playVideo;
        pauseVideo = api.pauseVideo;
        getDuration = () => api.duration;
        getCurrentTime = () => api.time;
        destroy = () => undefined;
      },
    }),
}));

beforeEach(() => {
  api.events = undefined;
  api.seekTo.mockReset();
  api.playVideo.mockReset();
  api.pauseVideo.mockReset();
  api.duration = 3_600;
  api.time = 0;
});

function show(controller: PlayerController) {
  return render(
    <PlayerControllerProvider controller={controller}>
      <YoutubePlayer videoId="UF8uR6Z6KLc" onFailure={() => undefined} />
    </PlayerControllerProvider>,
  );
}
const srcParams = (): URLSearchParams => new URL(screen.getByTestId("player-youtube").getAttribute("src") ?? "").searchParams;

describe("YoutubePlayer remembered position", () => {
  it("neither starts the embed at the remembered second nor seeks to it, and shows no notice", async () => {
    const controller = new PlayerController();
    controller.offerResume(754_900);
    show(controller);
    expect(srcParams().has("start")).toBe(false);
    expect(srcParams().has("autoplay")).toBe(false);
    expect(controller.resumeNotice).toBeUndefined();
    await vi.waitFor(() => expect(api.events).toBeDefined());
    act(() => api.events?.onReady?.());
    expect(api.seekTo).not.toHaveBeenCalled();
  });

  it("starts at 0 when nothing is remembered", () => {
    show(new PlayerController());
    expect(srcParams().has("start")).toBe(false);
  });

  it("does not resume over a position the user chose", async () => {
    const controller = new PlayerController();
    controller.offerResume(754_000);
    controller.seek(5_000);
    show(controller);
    expect(srcParams().has("start")).toBe(false);
    expect(controller.resumeNotice).toBeUndefined();
    await vi.waitFor(() => expect(api.events).toBeDefined());
    act(() => api.events?.onReady?.());
    expect(api.seekTo.mock.calls).toEqual([[5, true]]);
  });

  it("does not resume over a deep link", () => {
    const controller = new PlayerController();
    controller.suppressResume();
    controller.offerResume(754_000);
    show(controller);
    expect(srcParams().has("start")).toBe(false);
    expect(controller.resumeNotice).toBeUndefined();
  });

  it("puts a position carried from the player before it above the remembered one", async () => {
    const controller = new PlayerController();
    controller.offerResume(300_000);
    controller.request(90_000, "carry");
    show(controller);
    expect(srcParams().has("start")).toBe(false);
    await vi.waitFor(() => expect(api.events).toBeDefined());
    act(() => api.events?.onReady?.());
    expect(api.seekTo).toHaveBeenCalledWith(90, true);
  });
});

describe("YoutubePlayer reports", () => {
  it("passes on the media length, the time and the play, pause and end states", async () => {
    const controller = new PlayerController();
    const events: string[] = [];
    controller.onPlayback((event) => events.push(event));
    show(controller);
    await vi.waitFor(() => expect(api.events).toBeDefined());
    vi.useFakeTimers();
    try {
      act(() => api.events?.onReady?.());
      expect(controller.durationMs()).toBe(3_600_000);
      api.time = 61.4;
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(controller.currentTimeMs()).toBe(61_400);
    } finally {
      vi.useRealTimers();
    }
    act(() => api.events?.onStateChange?.({ data: 1 }));
    act(() => api.events?.onStateChange?.({ data: 2 }));
    act(() => api.events?.onStateChange?.({ data: 3 }));
    act(() => api.events?.onStateChange?.({ data: 0 }));
    expect(events).toEqual(["play", "pause", "ended"]);
  });

  it("starts playing on the restart button", async () => {
    const controller = new PlayerController();
    show(controller);
    await vi.waitFor(() => expect(api.events).toBeDefined());
    act(() => api.events?.onReady?.());
    act(() => controller.restart());
    expect(api.seekTo).toHaveBeenCalledWith(0, true);
    expect(api.playVideo).toHaveBeenCalledOnce();
  });

  it("plays a range through the IFrame API and pauses at its end; a seek in the embed hands playback back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const controller = new PlayerController();
      show(controller);
      await vi.waitFor(() => expect(api.events).toBeDefined());
      act(() => api.events?.onReady?.());
      expect(controller.rangePlayback).toBe("play");
      act(() => {
        controller.playRange(10_000, 14_000);
      });
      expect(api.seekTo).toHaveBeenCalledWith(10, true);
      expect(api.playVideo).toHaveBeenCalledOnce();
      act(() => api.events?.onStateChange?.({ data: 1 }));
      api.time = 10;
      act(() => vi.advanceTimersByTime(250));
      // Played on, polled every 250 ms.
      for (let step = 1; step <= 17; step += 1) {
        api.time = 10 + step * 0.25;
        act(() => vi.advanceTimersByTime(250));
        if (step === 15) expect(api.pauseVideo).not.toHaveBeenCalled();
      }
      expect(api.pauseVideo).toHaveBeenCalledOnce();

      act(() => {
        controller.playRange(20_000, 24_000);
      });
      api.time = 20;
      act(() => vi.advanceTimersByTime(250));
      // The user drags the embed's own bar far ahead: no pause at the range's end any more.
      api.time = 300;
      act(() => vi.advanceTimersByTime(250));
      expect(controller.playingRange()).toBeUndefined();
      expect(api.pauseVideo).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
