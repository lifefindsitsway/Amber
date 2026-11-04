import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import { PlayerView } from "../../../src/web/player/player-view.tsx";
import type { SubtitleTrackModel } from "../../../src/web/player/subtitle-overlay.tsx";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";

// The IFrame API is blocked unless a test turns the stand-in on; it records what the embed is asked to do.
const youtube = vi.hoisted(() => ({ available: false, onReady: undefined as (() => void) | undefined, seekTo: vi.fn(), time: 0 }));
vi.mock("../../../src/web/player/youtube-api.ts", () => ({
  loadYoutubeApi: () =>
    youtube.available
      ? Promise.resolve({
          Player: class {
            constructor(_element: unknown, options: { events?: { onReady?: () => void } }) {
              youtube.onReady = options.events?.onReady;
            }
            seekTo = youtube.seekTo;
            playVideo = () => undefined;
            getDuration = () => 3_600;
            getCurrentTime = () => youtube.time;
            destroy = () => undefined;
          },
        })
      : Promise.reject(new Error("blocked")),
}));
vi.mock("../../../src/web/player/player-settings.ts", () => ({
  END_BEHAVIORS: ["pause", "loop_one", "loop_list"],
  usePlayerSettings: () => ({ endBehavior: "loop_list", setEndBehavior: () => undefined, autoplay: false, setAutoplay: () => undefined }),
}));

const YOUTUBE = { kind: "youtube", videoId: "UF8uR6Z6KLc", originalUrl: "https://www.youtube.com/watch?v=UF8uR6Z6KLc" } as const;

function show(props: Parameters<typeof PlayerView>[0]) {
  return render(
    <PlayerControllerProvider controller={new PlayerController()}>
      <PlayerView {...props} />
    </PlayerControllerProvider>,
  );
}

describe("PlayerView", () => {
  it("offers caching after an iframe failure only where caching exists", async () => {
    const onCache = vi.fn();
    const { unmount } = show({ source: YOUTUBE });
    const disabled = await screen.findByRole("button", { name: "缓存后播放" });
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
    expect(disabled.getAttribute("title")).toBe("仅客户端可用");
    unmount();
    show({ source: YOUTUBE, onCache });
    fireEvent.click(await screen.findByTestId("player-cache"));
    expect(onCache).toHaveBeenCalledTimes(1);
  });

  it("plays the cached copy after a failure or when the user switched to it", async () => {
    const { unmount } = show({ source: YOUTUBE, localSrc: "asset://localhost/c.mp4" });
    expect((await screen.findByTestId("player-local")).querySelector("video")?.getAttribute("src")).toBe("asset://localhost/c.mp4");
    unmount();
    show({ source: YOUTUBE, localSrc: "asset://localhost/c.mp4", preferLocal: true });
    expect(screen.getByTestId("player-local")).toBeTruthy();
  });

  it("plays a local file when it has a URL and says why not otherwise", () => {
    const { unmount } = show({ source: { kind: "local" }, localSrc: "asset://localhost/a.mp4" });
    expect(screen.getByTestId("player-local")).toBeTruthy();
    unmount();
    const second = show({ source: { kind: "local" } });
    expect(screen.getByTestId("player-unavailable").textContent).toBe("本地文件只能在 Amber 客户端中播放");
    second.unmount();
    show({ source: { kind: "local" }, localHint: "找不到本地文件，重新关联后即可播放" });
    expect(screen.getByTestId("player-unavailable").textContent).toBe("找不到本地文件，重新关联后即可播放");
  });

  it("reports the player on screen, following an iframe failure to the cache, and retries the iframe on request", async () => {
    const onActiveChange = vi.fn();
    const controller = new PlayerController();
    const view = (onlineAttempt: number) => (
      <PlayerControllerProvider controller={controller}>
        <PlayerView source={YOUTUBE} localSrc="asset://localhost/c.mp4" onlineAttempt={onlineAttempt} onActiveChange={onActiveChange} />
      </PlayerControllerProvider>
    );
    const { rerender } = render(view(0));
    // The mocked IFrame API fails to load, so the cached copy takes over and says so.
    const reported = () => onActiveChange.mock.calls.map(([active]) => active);
    expect(await screen.findByTestId("player-local")).toBeTruthy();
    await waitFor(() => expect(reported()).toEqual(["iframe", "local"]));
    // A new attempt shows the iframe again; the still-blocked API fails it back to the cache.
    rerender(view(1));
    await waitFor(() => expect(reported()).toEqual(["iframe", "local", "iframe", "local"]));
  });

  it("renders what goes below for the player of the same render, and hands chapters, autoplay and the list step to the local player", async () => {
    const below = (active: string) => <p data-testid="below">{active}</p>;
    const onEndedAdvance = vi.fn(async () => "stay" as const);
    const { unmount } = show({
      source: YOUTUBE,
      localSrc: "asset://localhost/c.mp4",
      preferLocal: true,
      autoplay: true,
      onEndedAdvance,
      chapters: [{ startMs: 0, endMs: 1_000, title: "开场" }],
      renderBelow: below,
    });
    const player = screen.getByTestId("player-local");
    // Already in the first render, not after an effect: no frame shows the other strip.
    expect(screen.getByTestId("below").textContent).toBe("local");
    expect(player.compareDocumentPosition(screen.getByTestId("below")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const video = player.querySelector("video") as HTMLVideoElement;
    expect(video.autoplay).toBe(true);
    fireEvent.ended(video);
    expect(onEndedAdvance).toHaveBeenCalledTimes(1);
    unmount();

    show({ source: { kind: "bilibili", bvid: "BV1xx411c7mD", page: 1, originalUrl: "https://www.bilibili.com/video/BV1xx411c7mD" }, renderBelow: below });
    expect(screen.getByTestId("below").textContent).toBe("iframe");
  });

  it("renders below the fallback local player after an iframe failure, and below nothing playable", async () => {
    const below = (active: string) => <p data-testid="below">{active}</p>;
    const { unmount } = show({ source: YOUTUBE, localSrc: "asset://localhost/c.mp4", renderBelow: below });
    expect(await screen.findByTestId("player-local")).toBeTruthy();
    expect(screen.getByTestId("below").textContent).toBe("local");
    unmount();
    show({ source: { kind: "local" }, renderBelow: below });
    expect(screen.getByTestId("below").textContent).toBe("none");
  });

  it("hands subtitles to the local player, and under an iframe says where they can be seen once wanted", () => {
    const subtitles = (mode: SubtitleTrackModel["mode"]): SubtitleTrackModel => ({
      mode,
      setMode: () => undefined,
      originals: [],
      originalId: undefined,
      setOriginal: () => undefined,
      translations: [],
      translationId: undefined,
      translationLocked: false,
      followTranslation: () => undefined,
      lockTranslation: () => undefined,
      goTranslate: () => undefined,
      status: "ready",
      retry: () => undefined,
      slices: [],
      fontFallback: false,
      appearance: defaultSubtitleAppearance(),
      setAppearance: () => undefined,
      resetAppearance: () => undefined,
      placement: defaultSubtitlePlacement(),
      placementOverridden: false,
      setPlacement: () => undefined,
      setDefaultPlacement: () => undefined,
      resetPlacement: () => undefined,
      editing: false,
      startEditing: () => undefined,
      stopEditing: () => undefined,
    });
    const bilibili = { kind: "bilibili", bvid: "BV1xx411c7mD", page: 1, originalUrl: "https://www.bilibili.com/video/BV1xx411c7mD" } as const;
    const first = show({ source: bilibili, subtitles: subtitles("off") });
    expect(screen.queryByTestId("player-subtitles-iframe-hint")).toBeNull();
    first.unmount();
    const second = show({ source: bilibili, subtitles: subtitles("bilingual") });
    expect(screen.getByTestId("player-subtitles-iframe-hint").textContent).toBe("切到本地缓存播放后可显示字幕");
    second.unmount();
    show({ source: { kind: "local" }, localSrc: "asset://localhost/a.mp4", subtitles: subtitles("original") });
    expect(screen.getByTestId("player-subtitles")).toBeTruthy();
    expect(screen.queryByTestId("player-subtitles-iframe-hint")).toBeNull();
  });

  it("gives the quality menu to a cached video only, never to the iframe or an audio-only file", async () => {
    const sources = [
      { assetId: "hd", label: "1080p" },
      { assetId: "sd", label: "720p" },
    ];
    const onSelect = vi.fn();
    const { unmount } = show({ source: YOUTUBE, localSrc: "asset://localhost/hd.mp4", preferLocal: true, localSources: sources, localSourceId: "hd", onSelectLocalSource: onSelect });
    const player = screen.getByTestId("player-local");
    expect(player.querySelector("[data-control='quality']")).not.toBeNull();
    expect(screen.getByTestId("player-quality").textContent).toBe("1080p");
    unmount();
    const audio = show({ source: YOUTUBE, localSrc: "asset://localhost/a.mp3", preferLocal: true, localAudioOnly: true, localSources: sources, localSourceId: "hd" });
    expect(screen.getByTestId("player-local").querySelector("[data-control='quality']")).toBeNull();
    audio.unmount();
    show({ source: YOUTUBE, localSources: sources, localSourceId: "hd" });
    await screen.findByTestId("player-failed");
    expect(screen.queryByTestId("player-quality")).toBeNull();
  });
});

describe("PlayerView switching players", () => {
  afterEach(() => {
    youtube.available = false;
    youtube.onReady = undefined;
    youtube.seekTo.mockReset();
    youtube.time = 0;
    vi.useRealTimers();
  });
  const page = (controller: PlayerController, props: Parameters<typeof PlayerView>[0]) => (
    <PlayerControllerProvider controller={controller}>
      <PlayerView {...props} />
    </PlayerControllerProvider>
  );

  it("takes the position from the local player to the embed", async () => {
    youtube.available = true;
    const controller = new PlayerController();
    const { rerender } = render(page(controller, { source: YOUTUBE, localSrc: "/cache.mp4", preferLocal: true }));
    const video = screen.getByTestId("player-local").querySelector("video") as HTMLVideoElement;
    video.currentTime = 120;
    fireEvent.timeUpdate(video);
    rerender(page(controller, { source: YOUTUBE, localSrc: "/cache.mp4", preferLocal: false }));
    expect(screen.getByTestId("player-youtube")).toBeTruthy();
    await vi.waitFor(() => expect(youtube.onReady).toBeDefined());
    act(() => youtube.onReady?.());
    expect(youtube.seekTo.mock.calls).toEqual([[120, true]]);
  });

  it("takes the position from the embed to the local player, which only places it", async () => {
    youtube.available = true;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const controller = new PlayerController();
    const { rerender } = render(page(controller, { source: YOUTUBE, localSrc: "/cache.mp4", preferLocal: false }));
    await vi.waitFor(() => expect(youtube.onReady).toBeDefined());
    act(() => youtube.onReady?.());
    youtube.time = 301.5;
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender(page(controller, { source: YOUTUBE, localSrc: "/cache.mp4", preferLocal: true }));
    const video = screen.getByTestId("player-local").querySelector("video") as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(301.5, 1);
    expect(video.autoplay).toBe(false);
  });

  it("does not carry a position into the Bilibili embed: its t= would force autoplay", () => {
    const bilibili = { kind: "bilibili", bvid: "BV1" } as const;
    const controller = new PlayerController();
    const { rerender } = render(page(controller, { source: bilibili, localSrc: "/cache.mp4", preferLocal: true }));
    const video = screen.getByTestId("player-local").querySelector("video") as HTMLVideoElement;
    video.currentTime = 754;
    fireEvent.timeUpdate(video);
    rerender(page(controller, { source: bilibili, localSrc: "/cache.mp4", preferLocal: false }));
    const src = new URL(screen.getByTestId("player-bilibili").getAttribute("src") ?? "");
    expect(src.searchParams.has("t")).toBe(false);
    expect(src.searchParams.get("autoplay")).toBe("0");
    expect(screen.queryByTestId("bili-resume")).toBeNull();
  });
});
