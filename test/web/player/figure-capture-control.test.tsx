import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FIGURES_PER_CONTENT_MAX } from "../../../src/shared/defaults.ts";
import type { ContentDetailDto, MediaAssetDto } from "../../../src/shared/dto/content.ts";
import { figureInsertStatus } from "../../../src/web/pages/content/figure-insert.ts";
import { useFigureCaptureExtension } from "../../../src/web/player/figure-capture-control.tsx";
import { frameSources } from "../../../src/web/player/figure-capture.ts";
import { DANMAKU_NARROW_PICTURE_PX } from "../../../src/web/player/danmaku-narrow.ts";
import type { PlayerExtensionContext, PlayerExtensions } from "../../../src/web/player/player-extensions.ts";
import { contentDetail } from "../../fixtures/web/content-data.ts";
import { figure, FigurePage, steeredApi, targetAfter } from "../../fixtures/web/figure-insert.tsx";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";

afterEach(() => figureInsertStatus.clear());

const VIDEO: MediaAssetDto = { id: "VID", kind: "managed_upload", mimeType: "video/mp4", sizeBytes: 1, durationMs: 130_000, availability: "available", retentionPolicy: "keep", createdAt: 1 };
const AUDIO: MediaAssetDto = { ...VIDEO, id: "A1", mimeType: "audio/mpeg" };

/** A `<video>` whose position and length the test sets (jsdom plays nothing). */
function videoAt(seconds: number, duration = 130): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: seconds, writable: true });
  Object.defineProperty(video, "duration", { value: duration });
  return video;
}

function context(overrides: Partial<PlayerExtensionContext> = {}): PlayerExtensionContext {
  return {
    video: videoAt(42.5),
    picture: { x: 0, y: 0, width: 640, height: 360 },
    audioOnly: false,
    fullscreen: false,
    playing: false,
    sourceId: "VID",
    container: null,
    onMenuOpenChange: () => undefined,
    ...overrides,
  };
}

/** Renders what the extension gives the player for `ctx`: the picture layer, the controls and the settings entries. */
function Player(props: { content: ContentDetailDto; ctx: PlayerExtensionContext; seen: { current: PlayerExtensions | undefined } }) {
  const extension = useFigureCaptureExtension(props.content);
  props.seen.current = extension;
  const settings = extension?.settingsItems?.(props.ctx) ?? null;
  return (
    <div>
      {extension?.pictureLayers?.(props.ctx) ?? null}
      <div data-testid="controls">{extension?.controls?.(props.ctx) ?? null}</div>
      {settings === null ? null : <SettingsMenu>{settings}</SettingsMenu>}
    </div>
  );
}

function SettingsMenu(props: { children: ReactNode }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger data-testid="settings">⚙</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>{props.children}</DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function show(input: { api?: boolean; transcript?: boolean; figures?: number; media?: MediaAssetDto[]; ctx?: PlayerExtensionContext; capture?: Parameters<typeof mockApi>[0][string] }) {
  const { api } = steeredApi(targetAfter("s1", 0));
  const seen = { current: undefined as PlayerExtensions | undefined };
  const server = mockApi({
    "GET /api/contents/c1/figures": { body: { items: Array.from({ length: input.figures ?? 0 }, () => figure()), recentlyDeleted: [], limit: FIGURES_PER_CONTENT_MAX } },
    "POST /api/contents/c1/figures/capture": input.capture ?? { status: 201, body: figure({ id: "SHOT", source: "capture", capturedAtMs: 42_500 }) },
  });
  renderApp(
    <FigurePage api={input.api === false ? undefined : api}>
      <Player
        content={input.transcript === false ? withoutTranscript(contentDetail({ media: input.media ?? [VIDEO] })) : contentDetail({ media: input.media ?? [VIDEO] })}
        ctx={input.ctx ?? context()}
        seen={seen}
      />
    </FigurePage>,
  );
  return { api, seen, server };
}

function withoutTranscript(content: ContentDetailDto): ContentDetailDto {
  const { primaryTranscriptRevisionId: _none, ...rest } = content;
  return rest;
}

const reasonOf = (element: HTMLElement): string | null | undefined => document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent;

const captures = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.path.endsWith("/figures/capture"));

describe("useFigureCaptureExtension", () => {
  it("captures from another tab too: without the reading view the server places the frame by its time", async () => {
    const { server } = show({ api: false });
    fireEvent.click(screen.getByTestId("player-figure-capture"));
    await waitFor(() => expect(captures(server.calls)).toHaveLength(1));
    expect(captures(server.calls)[0]?.body).toEqual({ assetId: "VID", atMs: 42_500, widthRatio: 0.7 });
    expect((await screen.findByTestId("player-figure-capture-notice")).textContent).toBe("已截图，插入原文细读");
  });

  it("is off without a transcript, saying why beside it", () => {
    const { server } = show({ api: false, transcript: false });
    const button = screen.getByTestId("player-figure-capture");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("有字幕稿后才能插图");
    expect(reasonOf(button)).toBe("有字幕稿后才能插图");
    fireEvent.click(button);
    expect(captures(server.calls)).toHaveLength(0);
  });

  it("is off at the cap, saying so, in the bar and in the settings menu", async () => {
    const { server } = show({ figures: FIGURES_PER_CONTENT_MAX });
    const button = screen.getByTestId("player-figure-capture");
    await waitFor(() => expect(reasonOf(button)).toBe(`插图已达 ${FIGURES_PER_CONTENT_MAX} 张上限（最近删除的也计在内）`));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(captures(server.calls)).toHaveLength(0);
    cleanup();
    show({ figures: FIGURES_PER_CONTENT_MAX, ctx: context({ picture: { x: 0, y: 0, width: DANMAKU_NARROW_PICTURE_PX - 1, height: 200 } }) });
    fireEvent.keyDown(screen.getByTestId("settings"), { key: "Enter" });
    const item = await screen.findByTestId("player-settings-figure-capture");
    await waitFor(() => expect(item.textContent).toBe(`截取当前画面插图已达 ${FIGURES_PER_CONTENT_MAX} 张上限（最近删除的也计在内）`));
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the button only for a picture of a video file the server has", () => {
    show({ ctx: context({ audioOnly: true, sourceId: "A1" }), media: [VIDEO, AUDIO] });
    expect(screen.queryByTestId("player-figure-capture")).toBeNull();
    expect(frameSources.snapshot()).toMatchObject({ kind: "audio", contentId: "c1" });
  });

  it("shows no button for a file that is not one of the Content's capturable videos", () => {
    show({ ctx: context({ sourceId: "elsewhere" }) });
    expect(screen.queryByTestId("player-figure-capture")).toBeNull();
    expect(frameSources.snapshot()).toBeUndefined();
  });

  it("captures the frame at the press, kept before the end, after the paragraph of that time, and reveals it", async () => {
    const { api, server } = show({ ctx: context({ video: videoAt(130) }) });
    const button = screen.getByTestId("player-figure-capture");
    expect(button.getAttribute("aria-label")).toBe("截取当前画面，插入原文细读");
    fireEvent.click(button);
    await waitFor(() => expect(captures(server.calls)).toHaveLength(1));
    expect(captures(server.calls)[0]?.body).toEqual({ assetId: "VID", atMs: 129_900, widthRatio: 0.7, placement: targetAfter("t129900", 129_900).placement });
    await waitFor(() => expect(api.revealFigure).toHaveBeenCalledWith("SHOT"));
    expect((await screen.findByTestId("player-figure-capture-notice")).textContent).toBe("已截图，插入原文细读");
  });

  it("says why a capture failed, over the picture", async () => {
    show({
      capture: { status: 400, body: { error: { class: "invalid_request", code: "invalid_request.figure_frame", retryDisposition: "never", userMessage: "", details: { reason: "past_end" } } } },
    });
    // Both live regions are there before anything is said.
    const alerts = screen.getByTestId("player-figure-capture-alerts");
    expect(alerts.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("player-figure-capture-polite").getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByTestId("player-figure-capture"));
    await waitFor(() => expect(alerts.textContent).toBe("已到片尾，没有可截取的画面，往前一点再试"));
  });

  it("ignores a press while a capture runs", () => {
    const { server } = show({});
    act(() => {
      figureInsertStatus.start({ contentId: "c1", origin: "player", kind: "capture" });
    });
    const button = screen.getByTestId("player-figure-capture");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("正在截取画面…");
    fireEvent.click(button);
    expect(captures(server.calls)).toHaveLength(0);
  });

  it("moves into the settings menu in a narrow player, at the danmaku button's width", async () => {
    const { server } = show({ ctx: context({ picture: { x: 0, y: 0, width: DANMAKU_NARROW_PICTURE_PX - 1, height: 200 } }) });
    expect(screen.queryByTestId("player-figure-capture")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("settings"), { key: "Enter" });
    const item = await screen.findByTestId("player-settings-figure-capture");
    expect(item.textContent).toBe("截取当前画面");
    fireEvent.click(item);
    await waitFor(() => expect(captures(server.calls)).toHaveLength(1));
  });

  it("keeps the button at exactly the danmaku threshold and before the picture is measured", () => {
    show({ ctx: context({ picture: { x: 0, y: 0, width: DANMAKU_NARROW_PICTURE_PX, height: 200 } }) });
    expect(screen.getByTestId("player-figure-capture")).toBeTruthy();
  });
});
