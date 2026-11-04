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
});
