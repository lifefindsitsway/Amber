import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX, SAVE_NOTICE_DISMISS_MS } from "../../../../src/shared/defaults.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../../src/shared/subtitle-style.ts";
import { resetSubtitlePrefsMemory, writeAppearance, writePlacement } from "../../../../src/web/player/subtitle-prefs.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { subtitleDownloads } from "../../../../src/web/pages/content/subtitles-tab.tsx";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";
import { CITED_SEGMENT_ID, contentDetail, contentRoutes, revision, segment } from "../../../fixtures/web/content-data.ts";
import { fakeShell } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { stageRun, taskDetail } from "../../../fixtures/web/shell-data.ts";
import { stubResizeObserver } from "../../../fixtures/web/speaker-fetch.ts";

vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
  resetSubtitlePrefsMemory();
});

describe("SubtitlesTab with a search query", () => {
  it("prefills the subtitle filter with the query", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: `/contents/c1?tab=subtitles&search=${encodeURIComponent("向量")}`, path: "/contents/:id" });
    // The first test in this file also pays for loading the content page; under a full parallel run that alone can pass the default second.
    const filter = (await screen.findByLabelText("筛选字幕", { exact: false }, { timeout: 5_000 })) as HTMLInputElement;
    expect(filter.value).toBe("向量");
    const rows = await screen.findByTestId("subtitle-rows");
    await waitFor(() => expect(rows.querySelectorAll("[data-segment-id]")).toHaveLength(1));
    expect(rows.querySelector("mark")?.textContent).toBe("向量");
    fireEvent.change(filter, { target: { value: "" } });
    await waitFor(() => expect(rows.querySelectorAll("[data-segment-id]")).toHaveLength(3));
  });
});

describe("SubtitlesTab toolbar", () => {
  it("lays the controls out in two rows whose leading selects share one column", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    await screen.findByTestId("subtitles-version");
    const toolbar = screen.getByTestId("subtitles-toolbar");
    const cells = [...toolbar.children] as HTMLElement[];
    expect(cells).toHaveLength(4);
    expect(toolbar.className).toContain("grid-cols-");
    expect(within(cells[0] as HTMLElement).getByTestId("subtitles-version")).toBeTruthy();
    expect((cells[0] as HTMLElement).getAttribute("data-testid")).toBe("subtitles-toolbar-version");
    expect((cells[2] as HTMLElement).getAttribute("data-testid")).toBe("subtitles-toolbar-asr");
    const firstRow = cells[1] as HTMLElement;
    expect(within(firstRow).getByLabelText("筛选字幕")).toBeTruthy();
    expect(firstRow.textContent?.trim().endsWith("导入字幕")).toBe(true);
    const secondRow = [...(cells[3] as HTMLElement).querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(secondRow).toEqual(["重新转录", "导出字幕", "导出视频"]);
  });
});

describe("subtitle downloads", () => {
  it("offers the plain formats of a version and, for a translation, bilingual files paired with its parent", () => {
    expect(subtitleDownloads(revision("r1")).map((item) => item.format)).toEqual(["srt", "ass", "vtt", "txt"]);
    const translated = subtitleDownloads(revision("t1", { kind: "translated", language: "en", parentRevisionId: "r1" }));
    expect(translated.map((item) => item.format)).toEqual(["srt", "ass", "vtt", "txt", "srt-bilingual", "ass-bilingual"]);
    expect(translated.find((item) => item.format === "ass-bilingual")).toEqual({ format: "ass-bilingual", revisionId: "r1", translationRevisionId: "t1" });
  });

  it("lists translations among the versions and downloads a bilingual SRT of the selected one", async () => {
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = () => "blob:mock";
    URL.revokeObjectURL = () => undefined;
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      click.mockRestore();
    });
    // Local times, so the labels read the same in any time zone.
    const translated = revision("t1", { kind: "translated", language: "en", parentRevisionId: "r1", generation: { kind: "llm", modelRef: { modelId: "m", modelDisplaySnapshot: "gpt-5.6-sol" } }, createdAt: new Date(2026, 9, 4, 12, 26).getTime() });
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1", { createdAt: new Date(2026, 9, 4, 11, 24).getTime() }), translated] } },
      "GET /api/transcript/revisions/t1/segments": { body: { revision: translated, items: [] } },
      "POST /api/contents/c1/export": { file: { filename: "第一讲.srt", text: "1\n" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const version = (await screen.findByTestId("subtitles-version")) as HTMLSelectElement;
    expect([...version.options].map((option) => option.textContent)).toEqual(["平台字幕 · 10-04 11:24（当前）", "翻译 · 英语 · gpt-5.6-sol · 10-04 12:26"]);
    expect([...version.options].map((option) => option.title)).toEqual(["", "基于：平台字幕 · 10-04 11:24"]);
    fireEvent.change(version, { target: { value: "t1" } });
    fireEvent.keyDown(screen.getByTestId("subtitles-download"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("subtitles-download-srt-bilingual"));
    await waitFor(() => expect(saved).toEqual(["第一讲.srt"]));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ format: "srt-bilingual", revisionId: "r1", translationRevisionId: "t1" });
  });
});

describe("exporting a subtitled video in the desktop client", () => {
  const GRANT = { path: "/data/assets/tmp/burn.mp4", purpose: "burn_output", expiresAt: Date.now() + 60_000, sig: "test-signature" };
  const translated = revision("t1", { kind: "translated", language: "en", parentRevisionId: "r1" });
  const CACHE = { id: "a1", kind: "platform_cache", displayName: "第一讲.mp4", mimeType: "video/mp4", sizeBytes: 50 * 1024 * 1024, availability: "available", retentionPolicy: "evictable", createdAt: 1 } as const;
  const STYLE = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };

  function routes() {
    return {
      ...contentRoutes(contentDetail({ media: [CACHE] })),
      "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), translated] } },
      "POST /api/contents/c1/burn": { status: 202, body: { taskId: "t7" } },
      "GET /api/tasks/t7": { body: taskDetail("t7", [stageRun("t7", "burn", "succeeded", { progress: 1 })], { kind: "burn", contentId: "c1", statusProjection: "succeeded" }) },
      "GET /api/media/burn-outputs": {
        body: [
          { assetId: "m0", contentId: "c0", taskId: "t0", mimeType: "video/mp4", sizeBytes: 1, createdAt: 1 },
          { assetId: "m1", contentId: "c1", taskId: "t7", title: "第一讲", mimeType: "video/mp4", sizeBytes: 10, createdAt: 2 },
        ],
      },
      "POST /api/media/m1/save-grant": { body: { grant: GRANT } },
      "DELETE /api/media/m1": { status: 204 },
    };
  }

  async function openDialog() {
    const burn = (await screen.findByTestId("subtitles-burn")) as HTMLButtonElement;
    expect(burn.textContent).toBe("导出视频");
    await waitFor(() => expect(burn.disabled).toBe(false));
    fireEvent.click(burn);
    return screen.findByRole("dialog", { name: "导出字幕视频" });
  }

  async function exportBilingual() {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByLabelText("双语"));
    expect((within(dialog).getByTestId("burn-translation") as HTMLSelectElement).value).toBe("t1");
    await waitFor(() => expect((within(dialog).getByTestId("burn-start") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByTestId("burn-start"));
  }

  it("exports both lines with the full output choice, then saves the product where the user chooses and removes the copy", async () => {
    fakeShell.desktop = true;
    fakeShell.saveBurnOutput.mockResolvedValue({ savedPath: "D:\\视频\\第一讲.mp4" });
    const { calls } = mockApi(routes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    await exportBilingual();
    expect((await screen.findByTestId("burn-save-state")).textContent).toContain("已保存到 D:\\视频\\第一讲.mp4");
    const post = calls.find((call) => call.path === "/api/contents/c1/burn");
    expect(post?.body).toEqual({ revisionId: "r1", sourceAssetId: "a1", translationRevisionId: "t1", mode: "bilingual", delivery: "hard", container: "mp4", style: STYLE });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
    expect(fakeShell.saveBurnOutput).toHaveBeenCalledWith(GRANT, "第一讲.mp4");
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/media/m1"]);
  });

  it("keeps the product listed when the save dialog is cancelled", async () => {
    fakeShell.desktop = true;
    fakeShell.saveBurnOutput.mockResolvedValue(null);
    const { calls } = mockApi(routes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    await exportBilingual();
    expect((await screen.findByTestId("burn-save-state")).textContent).toContain("未保存。导出结果保留在「功能设置 › 存储」中，可稍后另存或删除。");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  /**
   * Fakes the clock just before the export starts and lets the save finish without moving it,
   * so the notice's dismiss timer starts at a known time.
   */
  async function exportOnFakeClock(): Promise<(ms: number) => Promise<void>> {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByLabelText("双语"));
    await waitFor(() => expect((within(dialog).getByTestId("burn-start") as HTMLButtonElement).disabled).toBe(false));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    fireEvent.click(within(dialog).getByTestId("burn-start"));
    for (let round = 0; round < 50 && !settled(); round += 1) await tick(0);
    expect(settled()).toBe(true);
    return tick;
  }

  /** Whether the save has come to an end: a notice other than "saving", or a failure. */
  function settled(): boolean {
    const tracker = screen.queryByTestId("burn-tracker");
    if (tracker === null) return false;
    if (within(tracker).queryByRole("alert") !== null) return true;
    const state = within(tracker).queryByTestId("burn-save-state");
    return state !== null && !(state.textContent ?? "").includes("正在");
  }

  it("closes the saved notice on its own after a while", async () => {
    fakeShell.desktop = true;
    fakeShell.saveBurnOutput.mockResolvedValue({ savedPath: "D:\\视频\\第一讲.mp4" });
    mockApi(routes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const tick = await exportOnFakeClock();
    expect(screen.getByTestId("burn-save-state").textContent).toContain("已保存到 D:\\视频\\第一讲.mp4");
    await tick(SAVE_NOTICE_DISMISS_MS - 1);
    expect(screen.getByTestId("burn-save-state")).toBeTruthy();
    await tick(1);
    expect(screen.queryByTestId("burn-tracker")).toBeNull();
  });

  it("keeps the notice of a cancelled or failed save until it is closed", async () => {
    fakeShell.desktop = true;
    fakeShell.saveBurnOutput.mockResolvedValue(null);
    mockApi(routes());
    const kept = renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    let tick = await exportOnFakeClock();
    expect(screen.getByTestId("burn-save-state").textContent).toContain("未保存");
    await tick(SAVE_NOTICE_DISMISS_MS);
    expect(screen.getByTestId("burn-save-state").textContent).toContain("未保存");
    kept.unmount();
    vi.useRealTimers();

    fakeShell.saveBurnOutput.mockRejectedValue(new Error("disk full"));
    mockApi(routes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    tick = await exportOnFakeClock();
    const tracker = screen.getByTestId("burn-tracker");
    expect(within(tracker).getByRole("alert")).toBeTruthy();
    await tick(SAVE_NOTICE_DISMISS_MS);
    expect(within(screen.getByTestId("burn-tracker")).getByRole("alert")).toBeTruthy();
  });

  it("offers only the original without a translation, and nothing outside the client", async () => {
    mockApi(contentRoutes());
    const outside = renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const disabled = (await screen.findByTestId("subtitles-burn")) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    expect(disabled.getAttribute("title")).toBe("仅客户端可用");
    outside.unmount();
    fakeShell.desktop = true;
    mockApi({ ...contentRoutes(contentDetail({ media: [CACHE] })), "GET /api/auth/me": routes()["GET /api/auth/me"] });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const dialog = await openDialog();
    expect((within(dialog).getByLabelText("仅原文") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText("仅译文") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("双语") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText("该字幕版本还没有译文，只能导出原文")).toBeTruthy();
  });
});

describe("styled subtitle downloads", () => {
  it("sends the current subtitle style with an ASS download and none with an SRT one", async () => {
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = () => "blob:mock";
    URL.revokeObjectURL = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      click.mockRestore();
    });
    const appearance = { ...defaultSubtitleAppearance(), original: { fontSize: 72, color: "#FFEE00" } };
    const placement = { version: 1, xBp: 2500, yBp: 1000, anchor: "top" } as const;
    writeAppearance("u1", appearance);
    writePlacement("u1", "c1", placement);
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
      "POST /api/contents/c1/export": { file: { filename: "第一讲.ass", text: "[Script Info]\n" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    fireEvent.keyDown(await screen.findByTestId("subtitles-download"), { key: "Enter" });
    expect((await screen.findByTestId("subtitles-ass-hint")).textContent).toBe("ASS 带当前字幕样式，位置按 16:9 参考画布");
    const ass = screen.getByTestId("subtitles-download-ass");
    await waitFor(() => expect(ass.hasAttribute("data-disabled")).toBe(false));
    fireEvent.click(ass);
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    fireEvent.keyDown(screen.getByTestId("subtitles-download"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("subtitles-download-srt"));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      { format: "ass", revisionId: "r1", style: { appearance, placement } },
      { format: "srt", revisionId: "r1" },
    ]);
  });
});


/** Fires a right click and reports whether the browser menu was prevented. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function stubClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

describe("SubtitlesTab context menu", () => {
  it("copies a row with and without its time, explains it, and plays from it", async () => {
    const writeText = stubClipboard();
    const { calls } = mockApi(contentRoutes());
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=subtitles", path: "/contents/:id" },
    );
    const rows = await screen.findByTestId("subtitle-rows");
    const row = await waitFor(() => rows.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`) as HTMLElement);
    // Inside the row's text, not on the row itself: the sentence is found from any child.
    expect(rightClick(within(row).getByText("再看重排序。"))).toBe(true);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["从这里播放", "复制这句", "复制这句（带时间）", "解释这句"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence-with-time"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("[1:15] 再看重排序。"));
    rightClick(row);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("再看重排序。"));
    rightClick(row);
    fireEvent.click(screen.getByTestId("context-menu-item-explain-sentence"));
    await waitFor(() => expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("解释一下这句话"));
    expect(screen.getByTestId("chat-quote").textContent).toContain("再看重排序。");
    rightClick(row);
    fireEvent.click(screen.getByTestId("context-menu-item-play-from-here"));
    await waitFor(() => expect(new URL(screen.getByTestId("player-bilibili").getAttribute("src") ?? "").searchParams.get("t")).toBe("75"));
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("leaves the toolbar to the browser menu", async () => {
    mockApi(contentRoutes());
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=subtitles", path: "/contents/:id" },
    );
    expect(rightClick(await screen.findByTestId("subtitles-version"))).toBe(false);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });
});

describe("re-transcribing", () => {
  const asr = (id: string, name: string) => ({
    id,
    name,
    provider: "dashscope",
    models: [
      { modelId: "qwen-audio-3.1-asr-flash-filetrans", available: true },
      { modelId: "fun-asr", available: true },
    ],
    credentialStatus: "configured",
    hasCredential: true,
    inUse: false,
    createdAt: 1,
  });
  const key = (asrProfileId: string, modelId: string) => JSON.stringify([asrProfileId, modelId]);

  it("is unavailable without a transcription model and links to its settings", async () => {
    mockApi({ ...contentRoutes(), "GET /api/asr-profiles": { body: { items: [] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const link = await screen.findByTestId("retranscribe-configure");
    expect(link.getAttribute("href")).toBe("/settings/transcription");
    expect((screen.getByTestId("retranscribe") as HTMLButtonElement).disabled).toBe(true);
  });

  it("starts with the default model and sends the chosen one", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号"), asr("a2", "二号")] } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, defaultAsrModelRef: { asrProfileId: "a2", modelId: "fun-asr" }, updatedAt: 1 } },
      "POST /api/contents/c1/transcript/retranscribe": { status: 202, body: { taskId: "t9" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const select = (await screen.findByTestId("retranscribe-model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(key("a2", "fun-asr")));
    fireEvent.change(select, { target: { value: key("a1", "qwen-audio-3.1-asr-flash-filetrans") } });
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST" && call.path.endsWith("/retranscribe"))?.body).toEqual({
        asrModelRef: { asrProfileId: "a1", modelId: "qwen-audio-3.1-asr-flash-filetrans" },
        // The setting is on by default, so the switch starts on.
        diarization: { mode: "required" },
      }),
    );
  });

  it("waits for a model to be chosen when there is no default", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号")] } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const select = (await screen.findByTestId("retranscribe-model")) as HTMLSelectElement;
    expect(select.value).toBe("");
    const button = screen.getByTestId("retranscribe") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.change(select, { target: { value: key("a1", "fun-asr") } });
    expect(button.disabled).toBe(false);
  });
});

describe("SubtitlesTab version list", () => {
  const asr = revision("r1", { kind: "asr", createdAt: 1 });
  const m0 = revision("m0", { kind: "manual", parentRevisionId: "r1", createdAt: 2 });
  const m1 = revision("m1", { kind: "manual", parentRevisionId: "r1", createdAt: 3 });
  const later = revision("r2", { kind: "asr", createdAt: 9 });

  function routes(list: ReturnType<typeof revision>[]) {
    return {
      ...contentRoutes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "m1", revisions: list } },
      ...Object.fromEntries(list.map((item) => [`GET /api/transcript/revisions/${item.id}/segments`, { body: { revision: item, items: [] } }])),
    };
  }

  it("lists one manual revision, reveals history on demand, and shows the ASR banner", async () => {
    mockApi(routes([asr, m0, m1, later]));
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const version = (await screen.findByTestId("subtitles-version")) as HTMLSelectElement;
    expect([...version.options].map((option) => option.value)).toEqual(["r1", "m1", "r2"]);
    fireEvent.click(screen.getByTestId("revision-history-toggle"));
    await waitFor(() => expect([...version.options].map((option) => option.value)).toEqual(["r1", "m0", "m1", "r2"]));
    expect(await screen.findByTestId("asr-banner")).toBeTruthy();
    expect(screen.getByTestId("revision-actions")).toBeTruthy();
  });

  it("says a linked revision no longer exists", async () => {
    mockApi(routes([asr, m1]));
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles&revision=gone", path: "/contents/:id" });
    expect((await screen.findByTestId("revision-missing")).textContent).toBe("版本不存在或已删除");
    expect(((await screen.findByTestId("subtitles-version")) as HTMLSelectElement).value).toBe("m1");
  });
});

describe("SubtitlesTab translation editing", () => {
  it("offers 「编辑译文」 while a translation is shown, and opens its editor in place", async () => {
    const translated = revision("t-en", { kind: "translated", language: "en", parentRevisionId: "r1" });
    const enRow = { id: "e1", revisionId: "t-en", ordinal: 0, startMs: 0, endMs: 4_000, text: "Today.", sourceSegmentIds: ["s1"] };
    mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), translated] } },
      "GET /api/contents/c1/translations": {
        body: { activeTasks: [], translations: [{ artifactId: "a-en", targetLanguage: "en", current: translated, revisions: [translated], stale: false }] },
      },
      "GET /api/transcript/revisions/t-en/segments": { body: { revision: translated, items: [enRow] } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const version = (await screen.findByTestId("subtitles-version")) as HTMLSelectElement;
    expect(screen.queryByTestId("translation-edit")).toBeNull();
    fireEvent.change(version, { target: { value: "t-en" } });
    const edit = await screen.findByTestId("translation-edit");
    expect(edit.textContent).toBe("编辑译文");
    fireEvent.click(edit);
    expect(await screen.findByTestId("translation-draft-editor")).toBeTruthy();
  });
});

describe("SubtitlesTab speakers", () => {
  const speakers = [
    { id: "p1", ordinal: 1, name: "林老师", colorIndex: 0, used: true },
    { id: "p2", ordinal: 2, colorIndex: 1, used: true },
  ];
  const rows = [
    segment("s1", 0, 0, 4_000, "今天讲检索。", { speakerId: "p1" }),
    segment("s2", 1, 4_000, 8_000, "先看向量库。", { speakerId: "p1" }),
    segment("s3", 2, 8_000, 12_000, "为什么？", { speakerId: "p2" }),
    segment("s4", 3, 12_000, 16_000, "再看重排序。", { speakerId: "p1" }),
    segment("s5", 4, 16_000, 20_000, "没有归属的一句。"),
  ];
  const asrRevision = revision("r1", { kind: "asr", generation: { kind: "asr", modelId: "fun-asr", diarization: { status: "applied" } }, segmentCount: rows.length });

  function speakerRoutes() {
    return {
      ...contentRoutes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [asrRevision] } },
      "GET /api/transcript/revisions/r1/segments": { body: { revision: asrRevision, items: rows } },
      "GET /api/contents/c1/speakers": { body: { items: speakers } },
    };
  }

  it("tags the first row of each turn with the speaker and leaves the other rows alone", async () => {
    mockApi(speakerRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const list = await screen.findByTestId("subtitle-rows");
    await waitFor(() => expect(list.querySelectorAll("[data-testid=subtitle-turn-tag]")).toHaveLength(4));
    const tagged = [...list.querySelectorAll("[data-segment-id]")].map((row) => [row.getAttribute("data-segment-id"), row.querySelector("[data-testid=subtitle-turn-name]")?.textContent ?? null]);
    // A speaker coming back after someone else starts a new turn; sentences nobody was assigned to are a neutral turn of their own.
    expect(tagged).toEqual([["s1", "林老师"], ["s2", null], ["s3", "发言人 2"], ["s4", "林老师"], ["s5", "未分配"]]);
    expect(list.querySelector("[data-segment-id=s5] [data-testid=subtitle-turn-tag]")?.getAttribute("data-unassigned")).toBe("true");
    // Timestamps stay a column of their own beside the text.
    expect(list.querySelector("[data-segment-id=s2]")?.textContent).toBe("0:04先看向量库。");
    expect(list.querySelector("[data-segment-id=s1] [data-testid=subtitle-turn-tag]")?.getAttribute("data-speaker-id")).toBe("p1");
  });

  it("leaves unassigned sentences unmarked while a single anonymous speaker does not make a turn layout", async () => {
    mockApi({ ...speakerRoutes(), "GET /api/contents/c1/speakers": { body: { items: [speakers[1]] } }, "GET /api/transcript/revisions/r1/segments": { body: { revision: asrRevision, items: [segment("s1", 0, 0, 4_000, "只有一人。", { speakerId: "p2" }), segment("s2", 1, 4_000, 8_000, "没有归属。")] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const list = await screen.findByTestId("subtitle-rows");
    await waitFor(() => expect(list.querySelectorAll("[data-segment-id]")).toHaveLength(2));
    await waitFor(() => expect(list.querySelector("[data-segment-id=s1] [data-testid=subtitle-turn-tag]")).not.toBeNull());
    expect(list.querySelector("[data-unassigned]")).toBeNull();
  });

  it("downloads a version with speakers naming them on the first cue of each turn, as the export dialog does by default", async () => {
    const { calls } = mockApi({
      ...speakerRoutes(),
      "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
      "POST /api/contents/c1/export": { file: { filename: "第一讲.srt", text: "1\n" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    await waitFor(() => expect(screen.getByTestId("subtitle-rows").querySelectorAll("[data-testid=subtitle-turn-tag]")).toHaveLength(4));
    for (const format of ["srt", "vtt"] as const) {
      fireEvent.keyDown(screen.getByTestId("subtitles-download"), { key: "Enter" });
      expect((await screen.findByTestId("subtitles-speakers-hint")).textContent).toBe("导出的字幕会标出发言人，SRT 和 TXT 只在换人时标一次。要每句都标或不带发言人，请到「总结」页点「导出」。");
      fireEvent.click(await screen.findByTestId(`subtitles-download-${format}`));
    }
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    // VTT names every cue with its own voice tag, so it takes no label mode.
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      { format: "srt", revisionId: "r1", includeSpeakers: true, speakerLabels: "turn" },
      { format: "vtt", revisionId: "r1", includeSpeakers: true },
    ]);
  });

  it("leaves speakers out of the download, and its hint out of the menu, for a version without speakers", async () => {
    const { calls } = mockApi({ ...contentRoutes(), "POST /api/contents/c1/export": { file: { filename: "第一讲.srt", text: "1\n" } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    await waitFor(() => expect(screen.getByTestId("subtitle-rows").querySelectorAll("[data-segment-id]")).toHaveLength(3));
    fireEvent.keyDown(screen.getByTestId("subtitles-download"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("subtitles-download-srt"));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(screen.queryByTestId("subtitles-speakers-hint")).toBeNull();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ format: "srt", revisionId: "r1" });
  });

  it("shows no tags for a revision without speakers", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const list = await screen.findByTestId("subtitle-rows");
    await waitFor(() => expect(list.querySelectorAll("[data-segment-id]")).toHaveLength(3));
    expect(list.querySelector("[data-testid=subtitle-turn-tag]")).toBeNull();
    expect(list.querySelector("[data-unassigned]")).toBeNull();
  });

  it("repeats the tag on the first row left of a turn when the filter hides its first row", async () => {
    mockApi(speakerRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles&search=" + encodeURIComponent("向量"), path: "/contents/:id" });
    const list = await screen.findByTestId("subtitle-rows");
    await waitFor(() => expect(list.querySelectorAll("[data-segment-id]")).toHaveLength(1));
    await waitFor(() => expect(list.querySelector("[data-segment-id=s2] [data-testid=subtitle-turn-name]")?.textContent).toBe("林老师"));
  });

  it("leads the new-recognition banner's speaker action to the transcript tab", async () => {
    const manual = revision("m1", { kind: "manual", parentRevisionId: "r1", createdAt: 5 });
    const newer = revision("r2", { kind: "asr", createdAt: 9, generation: { kind: "asr", diarization: { status: "applied" } }, segmentCount: rows.length });
    mockApi({
      ...speakerRoutes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "m1", revisions: [asrRevision, manual, newer] } },
      "GET /api/transcript/revisions/m1/segments": { body: { revision: manual, items: [] } },
      "GET /api/transcript/revisions/r2/segments": { body: { revision: newer, items: rows } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("asr-banner-apply-speakers"));
    await waitFor(() => expect(screen.getByTestId("output-tab-transcript").getAttribute("aria-selected")).toBe("true"));
  });

  it("states how the speakers of a version were identified in its version info", async () => {
    mockApi(speakerRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const version = (await screen.findByTestId("subtitles-version")) as HTMLSelectElement;
    expect(version.title).toBe("发言人识别：已识别发言人");
  });

  describe("picking speakers beside the keyword box", () => {
    const shown = (list: HTMLElement): Array<string | null> => [...list.querySelectorAll("[data-segment-id]")].map((row) => row.getAttribute("data-segment-id"));
    const keyword = (): HTMLInputElement => screen.getByLabelText("筛选字幕") as HTMLInputElement;

    async function open(routes: Parameters<typeof mockApi>[0] = speakerRoutes()) {
      stubResizeObserver();
      const api = mockApi(routes);
      renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
      const list = await screen.findByTestId("subtitle-rows", {}, { timeout: 5_000 });
      await waitFor(() => expect(list.querySelectorAll("[data-segment-id]").length).toBeGreaterThan(0));
      return { ...api, list };
    }

    async function pick(id: string) {
      if (screen.queryByTestId("speaker-filter-popover") === null) fireEvent.click(screen.getByTestId("speaker-filter"));
      const popover = await screen.findByTestId("speaker-filter-popover");
      const option = within(popover).getAllByTestId("speaker-filter-option").find((item) => item.getAttribute("data-speaker-id") === id) as HTMLElement;
      fireEvent.click(within(option).getByRole("checkbox"));
    }

    it("sits right after the keyword box in speaker mode", async () => {
      await open();
      const trigger = await screen.findByTestId("speaker-filter");
      expect(trigger.previousElementSibling).toBe(keyword());
      expect(trigger.getAttribute("aria-label")).toBe("只看某些发言人");
    });

    it("is not offered for a version without speakers or with a single anonymous one", async () => {
      const { list } = await open(contentRoutes());
      await waitFor(() => expect(list.querySelectorAll("[data-segment-id]")).toHaveLength(3));
      expect(screen.queryByTestId("speaker-filter")).toBeNull();
      cleanup();
      const single = await open({
        ...speakerRoutes(),
        "GET /api/contents/c1/speakers": { body: { items: [speakers[1]] } },
        "GET /api/transcript/revisions/r1/segments": { body: { revision: asrRevision, items: [segment("s1", 0, 0, 4_000, "只有一人。", { speakerId: "p2" }), segment("s2", 1, 4_000, 8_000, "没有归属。")] } },
      });
      await waitFor(() => expect(single.list.querySelector("[data-testid=subtitle-turn-tag]")).not.toBeNull());
      expect(screen.queryByTestId("speaker-filter")).toBeNull();
    });

    it("narrows the rows together with the keyword, and leaves them alone while nobody is picked", async () => {
      const { list, calls } = await open();
      await waitFor(() => expect(shown(list)).toEqual(["s1", "s2", "s3", "s4", "s5"]));
      fireEvent.change(keyword(), { target: { value: "看" } });
      await waitFor(() => expect(shown(list)).toEqual(["s2", "s4"]));
      await pick("p2");
      await waitFor(() => expect(shown(list)).toEqual([]));
      await pick("p1");
      await waitFor(() => expect(shown(list)).toEqual(["s2", "s4"]));
      fireEvent.change(keyword(), { target: { value: "" } });
      // Both speakers: every assigned row, the unassigned one left out.
      await waitFor(() => expect(shown(list)).toEqual(["s1", "s2", "s3", "s4"]));
      await pick("p1");
      await waitFor(() => expect(shown(list)).toEqual(["s3"]));
      await pick("p2");
      await waitFor(() => expect(shown(list)).toEqual(["s1", "s2", "s3", "s4", "s5"]));
      // Filtering is done on the page; nothing is asked of the server for it.
      expect(calls.every((call) => call.method === "GET" && !call.path.includes("speaker="))).toBe(true);
    });
  });
});

describe("SubtitlesTab re-transcribe speaker options", () => {
  const profile = (id: string, provider: string, modelIds: string[]) => ({
    id,
    name: id === "bl" ? "百炼" : "ElevenLabs",
    provider,
    models: modelIds.map((modelId) => ({ modelId, available: true })),
    credentialStatus: "configured",
    hasCredential: true,
    inUse: false,
    createdAt: 1,
  });
  const profiles = [profile("bl", "dashscope", ["fun-asr", "custom-asr"]), profile("el", "elevenlabs", ["scribe_v2"])];
  const key = (asrProfileId: string, modelId: string) => JSON.stringify([asrProfileId, modelId]);
  const settings = (extra: Record<string, unknown> = {}) => ({ body: { theme: "light", language: "zh-CN", shortcuts: {}, defaultAsrModelRef: { asrProfileId: "bl", modelId: "fun-asr" }, updatedAt: 1, ...extra } });

  function routes(extra: Record<string, unknown> = {}, duration = 600_000, settingsExtra: Record<string, unknown> = {}) {
    return {
      ...contentRoutes(contentDetail({ durationMs: duration })),
      "GET /api/asr-profiles": { body: { items: profiles } },
      "GET /api/settings": settings(settingsExtra),
      "POST /api/contents/c1/transcript/retranscribe": { status: 202, body: { taskId: "t9" } },
      ...extra,
    };
  }
  const posted = (calls: Array<{ method: string; path: string; body?: unknown }>) => calls.filter((call) => call.method === "POST" && call.path.endsWith("/retranscribe")).map((call) => call.body);

  async function opened(extra: Record<string, unknown> = {}, duration?: number, settingsExtra?: Record<string, unknown>) {
    const api = mockApi(routes(extra, duration, settingsExtra));
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    const select = (await screen.findByTestId("retranscribe-model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(key("bl", "fun-asr")));
    return { ...api, select, toggle: (await screen.findByTestId("diarization-switch")) as HTMLInputElement };
  }

  it("starts from the setting and asks for identification with a reference count for a 百炼 model", async () => {
    const { calls, toggle } = await opened();
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(screen.getByText("参考人数 2–100")).toBeTruthy();
    const count = screen.getByLabelText("参考人数（2–100）") as HTMLInputElement;
    expect(count.placeholder).toBe("自动");
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() => expect(posted(calls)).toEqual([{ asrModelRef: { asrProfileId: "bl", modelId: "fun-asr" }, diarization: { mode: "required" } }]));
    fireEvent.change(count, { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() => expect(posted(calls).at(-1)).toEqual({ asrModelRef: { asrProfileId: "bl", modelId: "fun-asr" }, diarization: { mode: "required", speakerCount: 3 } }));
  });

  it("words the count as an upper bound for an ElevenLabs model", async () => {
    const { select } = await opened();
    fireEvent.change(select, { target: { value: key("el", "scribe_v2") } });
    const count = (await screen.findByLabelText("最多人数（1–32）")) as HTMLInputElement;
    expect(screen.getByText("最多")).toBeTruthy();
    expect(screen.getByText("人")).toBeTruthy();
    expect(count.closest("label")?.getAttribute("data-semantics")).toBe("maximum");
  });

  it("sends off when the switch is turned off, and starts off when the setting is", async () => {
    const first = await opened();
    fireEvent.click(first.toggle);
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() => expect(posted(first.calls)).toEqual([{ asrModelRef: { asrProfileId: "bl", modelId: "fun-asr" }, diarization: { mode: "off" } }]));
    expect(screen.queryByTestId("diarization-count")).toBeNull();
    cleanup();
    const second = await opened({}, undefined, { asrDiarization: false });
    expect(second.toggle.checked).toBe(false);
  });

  it("disables the switch with the reason for a model that does not offer identification", async () => {
    const { select, calls } = await opened();
    fireEvent.change(select, { target: { value: key("bl", "custom-asr") } });
    await waitFor(() => expect((screen.getByTestId("diarization-switch") as HTMLInputElement).disabled).toBe(true));
    const toggle = screen.getByTestId("diarization-switch") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId("diarization-reason").textContent).toBe("此模型不识别发言人");
    expect(toggle.getAttribute("aria-describedby")).toBe(screen.getByTestId("diarization-reason").id);
    expect(toggle.closest("label")?.title).toBe("此模型不识别发言人");
    // Still wanted by the user's setting, so it is a preference the server records as unsupported, not a plain off.
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() => expect(posted(calls)).toEqual([{ asrModelRef: { asrProfileId: "bl", modelId: "custom-asr" }, diarization: { mode: "preferred" } }]));
  });

  it("sends off for a locked switch the user had turned off, or whose setting is off", async () => {
    const first = await opened();
    fireEvent.click(first.toggle);
    fireEvent.change(first.select, { target: { value: key("bl", "custom-asr") } });
    await waitFor(() => expect((screen.getByTestId("diarization-switch") as HTMLInputElement).disabled).toBe(true));
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() => expect(posted(first.calls)).toEqual([{ asrModelRef: { asrProfileId: "bl", modelId: "custom-asr" }, diarization: { mode: "off" } }]));
    cleanup();
    const second = await opened({}, undefined, { asrDiarization: false });
    fireEvent.change(second.select, { target: { value: key("bl", "custom-asr") } });
    await waitFor(() => expect((screen.getByTestId("diarization-switch") as HTMLInputElement).disabled).toBe(true));
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() => expect(posted(second.calls)).toEqual([{ asrModelRef: { asrProfileId: "bl", modelId: "custom-asr" }, diarization: { mode: "off" } }]));
  });

  it("sends a preference for a content longer than the model recommends", async () => {
    const { toggle, calls } = await opened({}, 7_200_001);
    await waitFor(() => expect(toggle.disabled).toBe(true));
    fireEvent.click(screen.getByTestId("retranscribe"));
    await waitFor(() => expect(posted(calls)).toEqual([{ asrModelRef: { asrProfileId: "bl", modelId: "fun-asr" }, diarization: { mode: "preferred" } }]));
  });

  it("waits for the settings before the switch and the button can be used", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = mockApi({
      ...routes(),
      "GET /api/asr-profiles": { body: { items: profiles } },
    });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "/api/settings") await gate;
      return original(input, init);
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=subtitles", path: "/contents/:id" });
    // Nothing to pick or send yet: the default model arrives with the settings.
    await screen.findByTestId("subtitles-toolbar");
    expect((screen.getByTestId("retranscribe") as HTMLButtonElement).disabled).toBe(true);
    release();
    const toggle = (await screen.findByTestId("diarization-switch")) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    await waitFor(() => expect((screen.getByTestId("retranscribe") as HTMLButtonElement).disabled).toBe(false));
    expect(posted(api.calls)).toEqual([]);
  });

  it("disables the switch for a content longer than the model recommends", async () => {
    const { toggle } = await opened({}, 7_200_001);
    await waitFor(() => expect(toggle.disabled).toBe(true));
    expect(screen.getByTestId("diarization-reason").textContent).toBe("时长超过建议上限，不识别发言人");
  });

  it("keeps a speaker count outside the model's range from being sent", async () => {
    const { calls } = await opened();
    fireEvent.change(screen.getByLabelText("参考人数（2–100）"), { target: { value: "1" } });
    expect((await screen.findByTestId("diarization-count-error")).textContent).toBe("人数需为 2–100 之间的整数");
    expect((screen.getByTestId("retranscribe") as HTMLButtonElement).disabled).toBe(true);
    expect(posted(calls)).toEqual([]);
  });

  it("explains a refusal and lets the user continue without identification or cancel", async () => {
    let attempts = 0;
    const { calls } = await opened({
      "POST /api/contents/c1/transcript/retranscribe": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 400, body: { error: { class: "invalid_request", code: "invalid_request.diarization_unavailable", retryDisposition: "never", userMessage: "", details: { reason: "over_recommended" } } } }
          : { status: 202, body: { taskId: "t9" } };
      },
    });
    fireEvent.click(screen.getByTestId("retranscribe"));
    const notice = await screen.findByTestId("diarization-unavailable");
    expect(notice.getAttribute("data-reason")).toBe("over_recommended");
    expect(notice.textContent).toContain("内容时长超过该模型建议识别发言人的上限");
    fireEvent.click(within(notice).getByTestId("diarization-cancel"));
    await waitFor(() => expect(screen.queryByTestId("diarization-unavailable")).toBeNull());

    // Cancelling sent nothing more; asking again is refused again, and continuing without identification resubmits with it off.
    expect(posted(calls)).toHaveLength(1);
    attempts = 0;
    fireEvent.click(screen.getByTestId("retranscribe"));
    fireEvent.click(await within(await screen.findByTestId("diarization-unavailable")).findByRole("button", { name: "不识别发言人，继续转录" }));
    await waitFor(() => expect(posted(calls).at(-1)).toEqual({ asrModelRef: { asrProfileId: "bl", modelId: "fun-asr" }, diarization: { mode: "off" } }));
    await waitFor(() => expect(screen.queryByTestId("diarization-unavailable")).toBeNull());
    expect((screen.getByTestId("diarization-switch") as HTMLInputElement).checked).toBe(false);
  });
});
