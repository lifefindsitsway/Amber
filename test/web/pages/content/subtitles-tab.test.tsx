import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX, SAVE_NOTICE_DISMISS_MS } from "../../../../src/shared/defaults.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../../src/shared/subtitle-style.ts";
import { resetSubtitlePrefsMemory, writeAppearance, writePlacement } from "../../../../src/web/player/subtitle-prefs.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { subtitleDownloads } from "../../../../src/web/pages/content/subtitles-tab.tsx";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";
import { CITED_SEGMENT_ID, contentDetail, contentRoutes, revision } from "../../../fixtures/web/content-data.ts";
import { fakeShell } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { stageRun, taskDetail } from "../../../fixtures/web/shell-data.ts";

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
    const filter = (await screen.findByLabelText("筛选字幕", { exact: false })) as HTMLInputElement;
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
    expect((await screen.findByTestId("burn-save-state")).textContent).toContain("未保存。导出结果保留在「功能配置 › 存储」中，可稍后另存或删除。");
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
