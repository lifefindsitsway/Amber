import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Link, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX, BREAKPOINT_SINGLE_PX, SAVE_NOTICE_DISMISS_MS } from "../../../../src/shared/defaults.ts";
import { ContentPage, defaultChatRect, parseChatRect } from "../../../../src/web/pages/content/content-page.tsx";
import type { MediaAssetDto } from "../../../../src/shared/dto/content.ts";
import { CITED_SEGMENT_ID, contentDetail, contentRoutes, highlightsBody } from "../../../fixtures/web/content-data.ts";
import { fakeShell, pickedFile } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { provider, stageRun, task, taskDetail } from "../../../fixtures/web/shell-data.ts";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";

vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

// The page state as handed to its provider, so a test can call what other parts of the page call.
const pageState = vi.hoisted(() => ({ current: undefined as { openSubtitleEditor(): void; playingAssetId?: string | undefined } | undefined }));
vi.mock("../../../../src/web/pages/content/content-context.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/web/pages/content/content-context.tsx")>();
  return {
    ...actual,
    ContentPageProvider: (props: Parameters<typeof actual.ContentPageProvider>[0]) => {
      pageState.current = props.value;
      return actual.ContentPageProvider(props);
    },
  };
});

// The page's list-loop wiring, without walking real lists.
const loop = vi.hoisted(() => ({
  entry: { autoplayLocal: false } as { collectionId?: string; autoplayLocal: boolean },
  advance: vi.fn<() => Promise<"navigated" | "replay" | "stay">>(),
}));
vi.mock("../../../../src/web/player/list-loop.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useListLoopEntry: () => loop.entry,
  usePlaylistAdvance: () => loop.advance,
}));

function media(id: string, overrides: Partial<MediaAssetDto>): MediaAssetDto {
  return { id, kind: "external_local", mimeType: "video/mp4", sizeBytes: 1, availability: "available", retentionPolicy: "never_delete", createdAt: 1, ...overrides };
}

const CACHE_DIR = "C:\\Users\\me\\AppData\\Roaming\\Amber\\media";
const VIDEO_CACHE = media("v1", {
  kind: "platform_cache",
  retentionPolicy: "evictable",
  displayName: "第一讲 [1080P].mp4",
  localPath: `${CACHE_DIR}\\第一讲 [1080P].mp4`,
  quality: "1080",
});
const AUDIO_CACHE = media("m1", {
  kind: "platform_cache",
  mimeType: "audio/mpeg",
  retentionPolicy: "evictable",
  displayName: "第一讲.mp3",
  localPath: `${CACHE_DIR}\\第一讲.mp3`,
});
const DISK = { cache: { freeBytes: 100 * 1024 ** 3, lowWaterBytes: 10 * 1024 ** 3 }, ok: true };
/** An inspection answer: nothing replaced, overwritten or blocking. */
function inspection(overrides: Record<string, unknown> = {}) {
  return {
    expected: { type: "video", height: 720, ext: "mp4" },
    expectedFileName: "第一讲 [720P].mp4",
    replaces: [],
    foreignFile: false,
    pendingName: false,
    recoveryHold: false,
    disk: DISK,
    caches: [],
    ...overrides,
  };
}
const INSPECT = { "POST /api/contents/c1/cache-media/inspect": { body: inspection() } };

/** Starts the cache request the dialog holds: inspected, then confirmed when the dialog asks. */
async function startCache(): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "缓存本视频" });
  fireEvent.click(within(dialog).getByTestId("cache-inspect"));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "缓存本视频" }) === null || within(dialog).queryByTestId("cache-confirm") !== null).toBe(true));
  const confirm = within(dialog).queryByTestId("cache-confirm");
  if (confirm !== null) fireEvent.click(confirm);
}
const EXPIRES_AT = Date.now() + 60_000;
const SAVE_GRANT = (path: string) => ({ grant: { path, purpose: "cache_save", expiresAt: EXPIRES_AT, sig: "test-signature" } });

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
  loop.entry = { autoplayLocal: false };
  loop.advance.mockReset();
  loop.advance.mockResolvedValue("stay");
});

describe("ContentPage", () => {
  it("hides cursor, following and current sentence under the Bilibili iframe and seeks by t= reload", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    expect(await screen.findByTestId("bili-hint")).toBeTruthy();
    const body = await screen.findByTestId("summary-body");
    const citation = await waitFor(() => {
      const button = body.querySelector(`[data-citation='${CITED_SEGMENT_ID}']`);
      expect(button?.textContent).toBe("1:15");
      return button as HTMLElement;
    });
    fireEvent.click(citation);
    const frame = screen.getByTestId("player-bilibili");
    expect(new URL(frame.getAttribute("src") ?? "").searchParams.get("t")).toBe("75");

    fireEvent.click(screen.getByTestId("output-tab-subtitles"));
    await screen.findByTestId("subtitle-rows");
    expect(screen.queryByTestId("timeline-cursor")).toBeNull();
    expect(screen.queryByTestId("follow-toggle")).toBeNull();
    expect(screen.queryByTestId("current-sentence")).toBeNull();
  });

  it("deletes the Content from the toolbar menu after confirmation and returns to the library", async () => {
    const { calls } = mockApi({ ...contentRoutes(), "DELETE /api/contents/c1": { status: 204 } });
    renderApp(
      <Routes>
        <Route path="/contents/:id" element={<ContentPage />} />
        <Route path="/library" element={<p data-testid="library-route" />} />
      </Routes>,
      { route: "/contents/c1" },
    );
    fireEvent.keyDown(await screen.findByRole("button", { name: "更多操作" }), { key: "Enter" });
    const deleteItem = await screen.findByRole("menuitem", { name: "删除" });
    expect(deleteItem.className).not.toContain("text-danger");
    fireEvent.click(deleteItem);
    const dialog = await screen.findByRole("dialog", { name: "删除这条内容？" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(await screen.findByTestId("library-route")).toBeTruthy();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/contents/c1"]);
  });

  it("puts collection management right after caching in the toolbar, with the menu last", async () => {
    mockApi({ ...contentRoutes(), "GET /api/collections": { body: { items: [{ id: "col1", name: "课程", itemCount: 1, createdAt: 0, updatedAt: 0 }] } } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const more = await screen.findByRole("button", { name: "更多操作" });
    const row = screen.getByTestId("toolbar-row");
    const labels = [...row.children].map((item) => item.textContent);
    expect(labels.slice(labels.indexOf("缓存本视频"))).toEqual(["缓存本视频", "管理合集"]);
    expect(row.nextElementSibling).toBe(more);
    fireEvent.click(screen.getByRole("button", { name: "管理合集" }));
    const dialog = await screen.findByRole("dialog", { name: "管理合集" });
    await waitFor(() => expect((within(dialog).getByRole("checkbox", { name: "课程" }) as HTMLInputElement).checked).toBe(true));
  });

  it("shows the five output tabs in one row with no rail", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const tablist = await screen.findByRole("tablist", { name: "产出物" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "output-tab-summary",
      "output-tab-transcript",
      "output-tab-subtitles",
      "output-tab-translation",
      "output-tab-ai-highlights",
    ]);
    expect(tabs.map((tab) => tab.textContent)).toEqual(["总结", "原文细读", "字幕脚本", "翻译", "AI 高光"]);
    expect(screen.getByTestId("output-tab-summary").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("navigation", { name: "产出物分组" })).toBeNull();
    expect(document.querySelector("[data-testid^='rail-']")).toBeNull();
  });

  it("keeps the tab in the URL and never posts while switching tabs", async () => {
    const { calls } = mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript", path: "/contents/:id" });
    expect((await screen.findByTestId("output-tab-transcript")).getAttribute("aria-selected")).toBe("true");
    await screen.findByTestId("transcript-reader");
    const tabs = ["summary", "subtitles", "translation", "ai-highlights", "transcript"];
    for (const tab of tabs) {
      fireEvent.click(screen.getByTestId(`output-tab-${tab}`));
      expect(screen.getByTestId(`output-tab-${tab}`).getAttribute("aria-selected")).toBe("true");
    }
    await waitFor(() => expect(calls.some((call) => call.path.includes("/segments"))).toBe(true));
    // Tab bodies may read what they show, but switching never starts work.
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("scrolls the current tab into view on mount and whenever the tab changes", async () => {
    // jsdom has no scrollIntoView; other parts of the page call it too, so keep only the tab row's calls.
    const scrolled: { testId: string; options: unknown }[] = [];
    const scrollIntoView = vi.fn(function (this: HTMLElement, options?: ScrollIntoViewOptions | boolean) {
      const testId = this.getAttribute("data-testid") ?? "";
      if (testId.startsWith("output-tab-")) {
        scrolled.push({ testId, options });
      }
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrollIntoView });
    try {
      mockApi(contentRoutes());
      renderApp(<ContentPage />, { route: "/contents/c1?tab=ai-highlights", path: "/contents/:id" });
      await screen.findByTestId("output-tab-ai-highlights");
      const nearest = { inline: "nearest", block: "nearest" };
      await waitFor(() => expect(scrolled).toEqual([{ testId: "output-tab-ai-highlights", options: nearest }]));
      fireEvent.click(screen.getByTestId("output-tab-translation"));
      await waitFor(() => expect(scrolled.at(-1)).toEqual({ testId: "output-tab-translation", options: nearest }));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("generates a missing summary on the first click and sends the template", async () => {
    const routes = contentRoutes();
    const { calls } = mockApi({
      ...routes,
      "GET /api/providers": { body: { items: [{ id: "p1", name: "P", protocol: "openai_compatible", baseURL: "https://x", credentialStatus: "configured", hasCredential: true, models: [], createdAt: 1 }] } },
      "POST /api/contents/c1/summaries": { status: 202, body: { taskId: "t9" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-template-summary.detailed"));
    fireEvent.click(await screen.findByTestId("summary-generate"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toEqual({ templateId: "summary.detailed" }));
    expect(calls.find((call) => call.method === "POST")?.headers["idempotency-key"]).toBeTruthy();
  });

  it("warns that the platform login has expired and links to the account settings", async () => {
    const accounts = (status: string) => ({
      accounts: [
        { platform: "bilibili", credentialStatus: "configured", hasCredential: true, status },
        { platform: "youtube", credentialStatus: "configured", hasCredential: true, status: "expired" },
      ],
    });
    mockApi({ ...contentRoutes(), "GET /api/platform-accounts": { body: accounts("expired") } });
    const { unmount } = renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const banner = await screen.findByTestId("platform-login-expired");
    expect(banner.textContent).toContain("B 站 登录已失效");
    expect(within(banner).getByRole("link", { name: "去重新登录" }).getAttribute("href")).toBe("/settings/platform-accounts");
    unmount();

    // Only this Content's own platform counts.
    const { calls } = mockApi({ ...contentRoutes(), "GET /api/platform-accounts": { body: accounts("valid") } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("content-title");
    await waitFor(() => expect(calls.some((call) => call.path === "/api/platform-accounts")).toBe(true));
    expect(screen.queryByTestId("platform-login-expired")).toBeNull();
  });

  it("keeps caching and the cached player client-only outside the desktop client", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    for (const id of ["cache-media", "switch-player-local"]) {
      const button = (await screen.findByTestId(id)) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toBe("仅客户端可用");
    }
    // The online half is what plays, and says so.
    const online = screen.getByTestId("switch-player-online");
    await waitFor(() => expect(online.getAttribute("aria-pressed")).toBe("true"));
    expect(online.textContent).toBe("在线");
    expect(screen.getByTestId("switch-player-local").textContent).toBe("本地缓存");
  });

  it("has no player switch for a local file, whose only player is the local one", async () => {
    mockApi(contentRoutes(contentDetail({ source: { kind: "local" }, media: [] })));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("content-title");
    expect(screen.queryByTestId("switch-player")).toBeNull();
  });

  it("shows the publish date in Beijing time between the source and the duration, with the time on hover", async () => {
    mockApi(contentRoutes(contentDetail({ publishedAt: Date.UTC(2024, 4, 17, 13, 25) })));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const published = await screen.findByTestId("content-published");
    expect(published.textContent).toBe("2024-05-17");
    expect(published.getAttribute("title")).toBe("发布时间：2024-05-17 21:25");
    const row = published.parentElement;
    expect([...(row?.children ?? [])].slice(0, 3).map((child) => child.textContent)).toEqual(["B 站", "2024-05-17", "10:00"]);
  });

  it("leaves the publish date out when the Content has none", async () => {
    mockApi(contentRoutes(contentDetail({ source: { kind: "local" }, media: [] })));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("content-title");
    expect(screen.queryByTestId("content-published")).toBeNull();
  });

  it("renames from the title row and marks a pinned Content", async () => {
    const { calls } = mockApi({
      ...contentRoutes(contentDetail({ pinnedAt: 5 })),
      "PATCH /api/contents/c1": { body: { ...contentDetail({ pinnedAt: 5 }), title: "新名字", customTitle: "新名字" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    expect(await screen.findByTestId("content-pinned")).toBeTruthy();
    fireEvent.click(screen.getByTestId("content-rename"));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ title: "新名字" }));
  });
});

describe("ContentPage middle column collapse", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
  });

  it("collapses the middle column to a strip without remounting it, and expands it again", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const middle = await screen.findByTestId("middle-column");
    const player = await screen.findByTestId("player-bilibili");
    // It leads the toolbar, right before 「隐藏播放器」.
    const slot = screen.getByTestId("collapse-middle").parentElement as HTMLElement;
    expect(slot.previousElementSibling).toBeNull();
    expect(slot.nextElementSibling?.firstElementChild).toBe(screen.getByTestId("toggle-player"));
    expect(screen.getByTestId("collapse-middle").textContent).toBe("收起中栏");
    expect(screen.getByTestId("outputs-column").style.width).not.toBe("");
    expect(screen.queryByTestId("middle-collapsed")).toBeNull();

    fireEvent.click(screen.getByTestId("collapse-middle"));
    expect(screen.getByTestId("middle-column")).toBe(middle);
    expect(middle.classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("player-bilibili")).toBe(player);
    expect(screen.queryByTestId("content-splitter")).toBeNull();
    expect(screen.getByTestId("outputs-column").style.width).toBe("");
    const strip = screen.getByTestId("middle-collapsed");
    expect(within(strip).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["展开中栏"]);
    // Not swapped: hidden middle, strip, outputs.
    expect(middle.nextElementSibling).toBe(strip);
    expect(strip.nextElementSibling).toBe(screen.getByTestId("outputs-column"));
    expect(localStorage.getItem("amber.content.middleCollapsed")).toBe("1");

    fireEvent.click(screen.getByTestId("expand-middle"));
    expect(screen.getByTestId("middle-column")).toBe(middle);
    expect(middle.classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("player-bilibili")).toBe(player);
    expect(screen.getByTestId("content-splitter")).toBeTruthy();
    expect(screen.getByTestId("outputs-column").style.width).not.toBe("");
    expect(screen.queryByTestId("middle-collapsed")).toBeNull();
    expect(localStorage.getItem("amber.content.middleCollapsed")).toBe("0");
  });

  it("remembers the collapsed middle column across visits", async () => {
    mockApi(contentRoutes());
    const { unmount } = renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("collapse-middle"));
    expect(localStorage.getItem("amber.content.middleCollapsed")).toBe("1");
    unmount();

    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    expect((await screen.findByTestId("middle-column")).classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("middle-collapsed")).toBeTruthy();
    expect(screen.queryByTestId("content-splitter")).toBeNull();
  });

  it("puts the strip on the right of the outputs when the columns are swapped", async () => {
    localStorage.setItem("amber.content.swapped", "1");
    localStorage.setItem("amber.content.middleCollapsed", "1");
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const strip = await screen.findByTestId("middle-collapsed");
    const outputs = screen.getByTestId("outputs-column");
    expect(outputs.nextElementSibling).toBe(strip);
    expect(strip.nextElementSibling).toBe(screen.getByTestId("middle-column"));
    expect(strip.className).toContain("border-l");
  });

  it("expands the collapsed middle column when a selection is explained, with the chat input focused", async () => {
    localStorage.setItem("amber.content.middleCollapsed", "1");
    const model = { providerProfileId: "p1", modelId: "m-chat" };
    // A usable chat model, so the input is enabled and can take focus.
    mockApi({
      ...contentRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "Relay", ["m-chat"])] } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, chatModelRef: model, defaultModelRef: model, updatedAt: 1 } },
      "GET /api/contents/c1/chat": { body: { thread: null, messages: [], context: { mode: "full", estimatedTokens: 1 } } },
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" },
    );
    const middle = await screen.findByTestId("middle-column");
    expect(middle.classList.contains("hidden")).toBe(true);
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    const reader = await screen.findByTestId("transcript-reader");
    const cited = await waitFor(() => reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`) as HTMLElement);
    const text = cited.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: text, offset: 3 });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    act(() => {
      cited.dispatchEvent(event);
    });
    fireEvent.click(screen.getByTestId("context-menu-item-explain-selection"));
    await waitFor(() => expect(input.value).toBe("解释一下「重排序」"));
    expect(screen.getByTestId("middle-column")).toBe(middle);
    expect(middle.classList.contains("hidden")).toBe(false);
    expect(screen.queryByTestId("middle-collapsed")).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(localStorage.getItem("amber.content.middleCollapsed")).toBe("0");
  });

  it("offers no collapse in the drawer layout and ignores a stored collapse there", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: Math.round((BREAKPOINT_SINGLE_PX + BREAKPOINT_DRAWER_PX) / 2) });
    localStorage.setItem("amber.content.middleCollapsed", "1");
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    expect(await screen.findByTestId("toggle-outputs")).toBeTruthy();
    expect(document.querySelector("[data-layout='drawer']")).not.toBeNull();
    expect(screen.queryByTestId("collapse-middle")).toBeNull();
    expect(screen.queryByTestId("middle-collapsed")).toBeNull();
    expect(screen.getByTestId("player-bilibili")).toBeTruthy();
    expect(document.querySelector(".hidden [data-testid='player-bilibili']")).toBeNull();
  });
});

describe("ContentPage in the desktop client", () => {
  beforeEach(() => {
    fakeShell.desktop = true;
  });

  it("caches a platform video at the chosen height and follows the task", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      ...INSPECT,
      "POST /api/contents/c1/cache-media": { status: 202, body: { taskId: "t5" } },
      "GET /api/tasks/t5": { body: taskDetail("t5", [stageRun("t5", "cache_media", "running", { progress: 0.5 })], { kind: "cache_media", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const cache = (await screen.findByTestId("cache-media")) as HTMLButtonElement;
    await waitFor(() => expect(cache.disabled).toBe(false));
    // Nothing is cached yet, so there is no local player to switch to.
    expect(screen.getByTestId("switch-player-local").getAttribute("title")).toBe("缓存本视频后可切换到本地播放器");
    fireEvent.click(cache);
    const dialog = await screen.findByRole("dialog", { name: "缓存本视频" });
    const quality = within(dialog).getByTestId("cache-quality") as HTMLSelectElement;
    expect(quality.value).toBe("1080");
    expect([...quality.options].map((option) => option.textContent)).toEqual(["360P", "480P", "720P", "1080P"]);
    fireEvent.change(quality, { target: { value: "720" } });
    // Nothing in the answer needs the user, so one click inspects and starts the Task.
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    expect(await screen.findByTestId("tracked-task")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "缓存本视频" })).toBeNull();
    expect(calls.find((call) => call.path === "/api/contents/c1/cache-media/inspect")?.body).toEqual({ type: "video", quality: 720, fileName: "第一讲" });
    expect(await screen.findByTestId("stage-cache_media")).toBeTruthy();
    const post = calls.find((call) => call.path === "/api/contents/c1/cache-media");
    expect(post?.body).toEqual({ type: "video", quality: 720, fileName: "第一讲" });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
  });

  it("caches audio only under the name the user typed, right after the inspection", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "POST /api/contents/c1/cache-media/inspect": { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "课程第 1 讲.mp3" }) },
      "POST /api/contents/c1/cache-media": { status: 202, body: { taskId: "t5" } },
      "GET /api/tasks/t5": { body: taskDetail("t5", [stageRun("t5", "cache_media", "running")], { kind: "cache_media", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const cache = (await screen.findByTestId("cache-media")) as HTMLButtonElement;
    await waitFor(() => expect(cache.disabled).toBe(false));
    fireEvent.click(cache);
    const dialog = await screen.findByRole("dialog", { name: "缓存本视频" });
    const name = within(dialog).getByTestId("cache-file-name") as HTMLInputElement;
    expect(name.value).toBe("第一讲");
    expect(name.maxLength).toBe(255);
    // No size cap on caches any more, and never a numbered name.
    expect(within(dialog).queryByText(/GB 时会先清理/u)).toBeNull();
    expect(within(dialog).queryByText(/「 \(2\)」/u)).toBeNull();

    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    expect(within(dialog).queryByTestId("cache-quality")).toBeNull();
    fireEvent.change(name, { target: { value: "课程:第 1 讲?.mp3" } });
    // Back to video brings the height cap back.
    fireEvent.click(within(dialog).getByTestId("cache-type-video"));
    expect(within(dialog).getByTestId("cache-quality")).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    expect(await screen.findByTestId("tracked-task")).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/contents/c1/cache-media")?.body).toEqual({ type: "audio", fileName: "课程:第 1 讲?.mp3" });
  });

  it("says so when a video was asked for but the Content has no picture", async () => {
    mockApi({
      ...contentRoutes(),
      ...INSPECT,
      "POST /api/contents/c1/cache-media": { status: 202, body: { taskId: "t6" } },
      "GET /api/tasks/t6": {
        body: taskDetail("t6", [stageRun("t6", "cache_media", "succeeded", { progress: 1, reasons: ["audio_only"] })], {
          kind: "cache_media",
          contentId: "c1",
          statusProjection: "succeeded",
        }),
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const cache = (await screen.findByTestId("cache-media")) as HTMLButtonElement;
    await waitFor(() => expect(cache.disabled).toBe(false));
    fireEvent.click(cache);
    await startCache();
    const notice = await screen.findByTestId("cache-audio-only");
    expect(notice.textContent).toContain("该内容没有画面，已缓存为 MP3");
    expect(screen.queryByTestId("tracked-task")).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("cache-audio-only")).toBeNull();
  });

  it("shows no notice when the cache Task got the video it asked for", async () => {
    mockApi({
      ...contentRoutes(),
      ...INSPECT,
      "POST /api/contents/c1/cache-media": { status: 202, body: { taskId: "t7" } },
      "GET /api/tasks/t7": {
        body: taskDetail("t7", [stageRun("t7", "cache_media", "succeeded", { progress: 1, reasons: [] })], {
          kind: "cache_media",
          contentId: "c1",
          statusProjection: "succeeded",
        }),
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const cache = (await screen.findByTestId("cache-media")) as HTMLButtonElement;
    await waitFor(() => expect(cache.disabled).toBe(false));
    fireEvent.click(cache);
    await startCache();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("tracked-task")).toBeNull());
    expect(screen.queryByTestId("cache-audio-only")).toBeNull();
  });

  it("saves the only cache under its file name and stays silent when the dialog is cancelled", async () => {
    fakeShell.saveCachedMedia.mockResolvedValueOnce(null).mockResolvedValueOnce({ savedPath: "D:\\视频\\第一讲.mp4" });
    const { calls } = mockApi({
      ...contentRoutes(contentDetail({ media: [VIDEO_CACHE] })),
      "POST /api/media/v1/save-grant": { body: SAVE_GRANT(VIDEO_CACHE.localPath as string) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const save = (await screen.findByTestId("save-cache")) as HTMLButtonElement;
    expect(save.textContent).toBe("另存为…");
    expect(save.getAttribute("title")).toBe("视频 1080P：第一讲 [1080P].mp4");
    fireEvent.click(save);
    await waitFor(() => expect(fakeShell.saveCachedMedia).toHaveBeenCalledTimes(1));
    expect(fakeShell.saveCachedMedia).toHaveBeenCalledWith(SAVE_GRANT(VIDEO_CACHE.localPath as string).grant, "第一讲 [1080P].mp4");
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(screen.queryByTestId("save-cache-saved")).toBeNull();
    fireEvent.click(save);
    expect((await screen.findByTestId("save-cache-saved")).textContent).toBe("已保存到 D:\\视频\\第一讲.mp4");
    // The grant comes first, and the cache itself is never deleted.
    expect(calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/media/v1/save-grant",
      "POST /api/media/v1/save-grant",
    ]);
  });

  it("offers both caches by file name and saves the one picked", async () => {
    fakeShell.saveCachedMedia.mockResolvedValue({ savedPath: "D:\\第一讲.mp3" });
    const { calls } = mockApi({
      ...contentRoutes(contentDetail({ media: [AUDIO_CACHE, VIDEO_CACHE] })),
      "POST /api/media/m1/save-grant": { body: SAVE_GRANT(AUDIO_CACHE.localPath as string) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.keyDown(await screen.findByTestId("save-cache"), { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["视频 1080P：第一讲 [1080P].mp4", "音频：第一讲.mp3"]);
    fireEvent.click(screen.getByTestId("save-cache-m1"));
    await waitFor(() => expect(fakeShell.saveCachedMedia).toHaveBeenCalledWith(SAVE_GRANT(AUDIO_CACHE.localPath as string).grant, "第一讲.mp3"));
    expect(await screen.findByTestId("save-cache-saved")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/media/m1/save-grant"]);
  });

  it("closes the saved notice when asked, or on its own after a while", async () => {
    fakeShell.saveCachedMedia.mockResolvedValue({ savedPath: "D:\\视频\\第一讲.mp4" });
    mockApi({
      ...contentRoutes(contentDetail({ media: [VIDEO_CACHE] })),
      "POST /api/media/v1/save-grant": { body: SAVE_GRANT(VIDEO_CACHE.localPath as string) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const save = (await screen.findByTestId("save-cache")) as HTMLButtonElement;
    fireEvent.click(save);
    fireEvent.click(within(await screen.findByTestId("save-cache-saved")).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByTestId("save-cache-saved")).toBeNull());
    expect(save.disabled).toBe(false);

    // The clock stands still while the save settles, so the dismiss timer starts at a known time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    fireEvent.click(save);
    for (let round = 0; round < 50 && screen.queryByTestId("save-cache-saved") === null; round += 1) await tick(0);
    expect(screen.getByTestId("save-cache-saved")).toBeTruthy();
    await tick(SAVE_NOTICE_DISMISS_MS - 1);
    expect(screen.getByTestId("save-cache-saved")).toBeTruthy();
    await tick(1);
    // The reset reaches the screen through React Query's batched notifications, which it
    // schedules on the (faked) timer queue a millisecond apart.
    for (let round = 0; round < 5; round += 1) await tick(1);
    expect(screen.queryByTestId("save-cache-saved")).toBeNull();
  });

  it("shows why a save failed", async () => {
    mockApi({
      ...contentRoutes(contentDetail({ media: [VIDEO_CACHE] })),
      "POST /api/media/v1/save-grant": { status: 409, body: { error: { class: "conflict", code: "conflict", retryDisposition: "never", userMessage: "" } } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("save-cache"));
    // Below the toolbar row, so it stays in sight when the button sits in the "⋯" menu.
    await waitFor(() => expect(screen.getByTestId("toolbar-row").parentElement?.nextElementSibling?.getAttribute("role")).toBe("alert"));
    expect(fakeShell.saveCachedMedia).not.toHaveBeenCalled();
  });

  it("plays an audio-only cache in the local player with a placeholder over the picture", async () => {
    mockApi(contentRoutes(contentDetail({ media: [AUDIO_CACHE] })));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const local = (await screen.findByTestId("switch-player-local")) as HTMLButtonElement;
    await waitFor(() => expect(local.disabled).toBe(false));
    expect(local.textContent).toBe("本地缓存（仅音频）");
    fireEvent.click(local);
    const player = await screen.findByTestId("player-local");
    expect(player.querySelector("video")?.getAttribute("src")).toBe(`asset://localhost/${encodeURIComponent(AUDIO_CACHE.localPath as string)}`);
    expect(within(player).getByTestId("player-audio-only").textContent).toBe("仅音频，没有画面");
    // Seeking and the clock still belong to the <video> element.
    expect(within(player).getByTestId("player-seek")).toBeTruthy();
  });

  it("plays the video cache when there is also an audio cache", async () => {
    mockApi(contentRoutes(contentDetail({ media: [AUDIO_CACHE, VIDEO_CACHE] })));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const local = (await screen.findByTestId("switch-player-local")) as HTMLButtonElement;
    await waitFor(() => expect(local.disabled).toBe(false));
    expect(local.textContent).toBe("本地缓存");
    fireEvent.click(local);
    const player = await screen.findByTestId("player-local");
    expect(player.querySelector("video")?.getAttribute("src")).toBe(`asset://localhost/${encodeURIComponent(VIDEO_CACHE.localPath as string)}`);
    expect(within(player).queryByTestId("player-audio-only")).toBeNull();
  });

  describe("with several cached qualities", () => {
    const cacheAt = (id: string, quality: string, createdAt: number) =>
      media(id, { kind: "platform_cache", retentionPolicy: "evictable", quality, createdAt, displayName: `${id}.mp4`, localPath: `${CACHE_DIR}\\${id}.mp4` });
    const HD = cacheAt("v1080", "1080", 1);
    const SD = cacheAt("v720", "720", 2);
    const OLD = cacheAt("vold", "", 3);
    const srcOf = (id: string) => `asset://localhost/${encodeURIComponent(`${CACHE_DIR}\\${id}.mp4`)}`;

    async function playLocal(): Promise<HTMLElement> {
      const local = (await screen.findByTestId("switch-player-local")) as HTMLButtonElement;
      await waitFor(() => expect(local.disabled).toBe(false));
      fireEvent.click(local);
      return screen.findByTestId("player-local");
    }

    async function pickQuality(player: HTMLElement, assetId: string): Promise<void> {
      fireEvent.keyDown(within(player).getByTestId("player-quality"), { key: "Enter" });
      fireEvent.click(within(await within(player).findByTestId("player-quality-menu")).getByTestId(`player-quality-item-${assetId}`));
    }

    it("plays the best quality, switches to the one picked and keeps it across players", async () => {
      mockApi(contentRoutes(contentDetail({ media: [SD, OLD, HD] })));
      renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
      const player = await playLocal();
      await waitFor(() => expect(player.querySelector("video")?.getAttribute("src")).toBe(srcOf("v1080")));
      const trigger = await within(player).findByTestId("player-quality");
      expect(trigger.textContent).toBe("1080P");
      expect(trigger.closest("[data-control]")?.nextElementSibling?.getAttribute("data-control")).toBe("volume");
      fireEvent.keyDown(trigger, { key: "Enter" });
      const menu = await within(player).findByTestId("player-quality-menu");
      expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["1080P", "720P", "未知画质"]);
      expect(within(menu).getByTestId("player-quality-item-v1080").getAttribute("aria-checked")).toBe("true");
      fireEvent.click(within(menu).getByTestId("player-quality-item-v720"));
      await waitFor(() => expect(player.querySelector("video")?.getAttribute("src")).toBe(srcOf("v720")));
      expect(within(player).getByTestId("player-quality").textContent).toBe("720P");
      // The export starts from what the player shows.
      await waitFor(() => expect(pageState.current?.playingAssetId).toBe("v720"));

      fireEvent.click(screen.getByTestId("switch-player-online"));
      await waitFor(() => expect(screen.queryByTestId("player-local")).toBeNull());
      await waitFor(() => expect(pageState.current?.playingAssetId).toBeUndefined());
      fireEvent.click(screen.getByTestId("switch-player-local"));
      const again = await screen.findByTestId("player-local");
      await waitFor(() => expect(again.querySelector("video")?.getAttribute("src")).toBe(srcOf("v720")));
    });

    it("goes back to the best quality with a notice once the chosen one is deleted", async () => {
      let media = [SD, OLD, HD];
      const { calls } = mockApi({
        ...contentRoutes(),
        "GET /api/contents/c1": () => ({ body: contentDetail({ media }) }),
        "DELETE /api/media/v720": () => {
          media = [OLD, HD];
          return { status: 204 };
        },
      });
      renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
      const player = await playLocal();
      await within(player).findByTestId("player-quality");
      await pickQuality(player, "v720");
      await waitFor(() => expect(player.querySelector("video")?.getAttribute("src")).toBe(srcOf("v720")));

      fireEvent.click(screen.getByTestId("cache-media"));
      const dialog = await screen.findByRole("dialog", { name: "缓存本视频" });
      const list = within(dialog).getByTestId("cache-list");
      expect([...list.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent)).toEqual(["1080P", "720P", "未知画质"]);
      fireEvent.click(within(list).getByTestId("cache-delete-v720"));
      fireEvent.click(within(await screen.findByRole("dialog", { name: "删除这份缓存？" })).getByRole("button", { name: "删除" }));
      expect((await screen.findByTestId("player-quality-notice")).textContent).toContain("所选画质已不可用，已切换到 1080P");
      await waitFor(() => expect(screen.getByTestId("player-local").querySelector("video")?.getAttribute("src")).toBe(srcOf("v1080")));
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/media/v720"]);
    });
  });

  it("switches between the platform iframe and the cached copy", async () => {
    const cached = contentDetail({ media: [media("pc1", { kind: "platform_cache", retentionPolicy: "evictable", localPath: "/data/assets/pc1.mp4" })] });
    mockApi(contentRoutes(cached));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const local = (await screen.findByTestId("switch-player-local")) as HTMLButtonElement;
    const online = screen.getByTestId("switch-player-online");
    await waitFor(() => expect(local.disabled).toBe(false));
    expect(screen.getByTestId("player-bilibili")).toBeTruthy();
    expect(online.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(local);
    const video = (await screen.findByTestId("player-local")).querySelector("video");
    expect(video?.getAttribute("src")).toBe(`asset://localhost/${encodeURIComponent("/data/assets/pc1.mp4")}`);
    await waitFor(() => expect(local.getAttribute("aria-pressed")).toBe("true"));
    expect(online.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(online);
    expect(await screen.findByTestId("player-bilibili")).toBeTruthy();
    await waitFor(() => expect(online.getAttribute("aria-pressed")).toBe("true"));
  });

  it("relinks a missing local original as soon as it is picked and reports a different file", async () => {
    const PATH = "E:\\备份\\第一讲.mp4";
    let relinked = false;
    let changed = true;
    const local = (available: boolean) =>
      contentDetail({
        source: { kind: "local" },
        media: [media("a1", { displayName: "第一讲.mp4", ...(available ? { localPath: PATH } : { availability: "missing" }) })],
      });
    fakeShell.pickRelinkFile.mockResolvedValue(pickedFile(PATH, "relink"));
    const { calls } = mockApi({
      ...contentRoutes(local(false)),
      "GET /api/contents/c1": () => ({ body: local(relinked) }),
      "PUT /api/media/a1/relink": () => {
        if (changed) {
          return { status: 422, body: { error: { class: "media_changed", code: "media_changed", retryDisposition: "never", userMessage: "" } } };
        }
        relinked = true;
        return { body: local(true).media[0] };
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const banner = await screen.findByTestId("relink-banner");
    expect(banner.textContent).toContain("找不到原文件「第一讲.mp4」");
    expect(screen.getByTestId("player-unavailable").textContent).toBe("找不到本地文件，重新关联后即可播放");
    fireEvent.click(within(banner).getByTestId("relink-pick"));
    expect(await within(banner).findByText("文件内容与导入时不一致，请重新导入")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    changed = false;
    fireEvent.click(within(banner).getByTestId("relink-pick"));
    const video = (await screen.findByTestId("player-local")).querySelector("video");
    expect(video?.getAttribute("src")).toBe(`asset://localhost/${encodeURIComponent(PATH)}`);
    expect(screen.queryByTestId("relink-banner")).toBeNull();
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.body)).toEqual([
      { path: PATH, grant: expect.objectContaining({ purpose: "relink", path: PATH }) },
      { path: PATH, grant: expect.objectContaining({ purpose: "relink", path: PATH }) },
    ]);
  });

  it("keeps the full timeline under the iframe and only the highlight band under the local player, whose seek bar has the chapters", async () => {
    mockApi({ ...contentRoutes(contentDetail({ media: [VIDEO_CACHE] })), "GET /api/contents/c1/highlights": { body: highlightsBody() } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    expect(await screen.findByTestId("timeline")).toBeTruthy();
    expect(await screen.findByTestId("timeline-highlights")).toBeTruthy();
    expect(screen.getByTestId("bili-hint")).toBeTruthy();
    const local = screen.getByTestId("switch-player-local") as HTMLButtonElement;
    await waitFor(() => expect(local.disabled).toBe(false));
    fireEvent.click(local);
    const player = await screen.findByTestId("player-local");
    expect(screen.queryByTestId("timeline")).toBeNull();
    expect(screen.queryByTestId("bili-hint")).toBeNull();
    const band = screen.getByTestId("timeline-highlights");
    expect(band.querySelectorAll("[data-highlight]").length).toBeGreaterThan(0);
    expect(player.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const video = player.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 600 });
    fireEvent.loadedMetadata(video);
    // The chapter boundary at 1:00 of 10:00 leaves a gap in the seek track.
    expect((within(player).getByTestId("player-seek") as HTMLInputElement).style.getPropertyValue("--seek-track")).toContain("transparent calc(10% - 1px)");
    fireEvent.click(screen.getByTestId("switch-player-online"));
    expect(await screen.findByTestId("timeline")).toBeTruthy();
  });

  it("opens straight into the playing cached copy when the list loop brought the user here, and hands the player the next step", async () => {
    loop.entry = { collectionId: "col1", autoplayLocal: true };
    localStorage.setItem("amber.player.endBehavior", "loop_list");
    mockApi(contentRoutes(contentDetail({ media: [VIDEO_CACHE] })));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const video = (await screen.findByTestId("player-local")).querySelector("video") as HTMLVideoElement;
    expect(video.autoplay).toBe(true);
    fireEvent.ended(video);
    await waitFor(() => expect(loop.advance).toHaveBeenCalledTimes(1));
    // Back online and to the cache again: no forced start the second time.
    fireEvent.click(screen.getByTestId("switch-player-online"));
    expect(await screen.findByTestId("player-bilibili")).toBeTruthy();
    fireEvent.click(screen.getByTestId("switch-player-local"));
    const again = (await screen.findByTestId("player-local")).querySelector("video") as HTMLVideoElement;
    expect(again.autoplay).toBe(false);
  });

  it("asks which collection to loop through when the Content belongs to several", async () => {
    loop.entry = { autoplayLocal: true };
    localStorage.setItem("amber.player.endBehavior", "loop_list");
    const collections = [
      { id: "col1", name: "课程", itemId: "ci1" },
      { id: "col2", name: "精选", itemId: "ci2" },
    ];
    mockApi(contentRoutes(contentDetail({ media: [VIDEO_CACHE], collections })));
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const player = await screen.findByTestId("player-local");
    fireEvent.keyDown(within(player).getByTestId("player-settings"), { key: "Enter" });
    const menu = within(player).getByTestId("player-settings-menu");
    expect(within(menu).getByText("循环合集")).toBeTruthy();
    expect(within(menu).getByRole("menuitemradio", { name: "课程" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "精选" }));
    fireEvent.keyDown(within(player).getByTestId("player-settings"), { key: "Enter" });
    const reopened = within(screen.getByTestId("player-local")).getByTestId("player-settings-menu");
    expect(within(reopened).getByRole("menuitemradio", { name: "精选" }).getAttribute("aria-checked")).toBe("true");
  });

  it("stays on the platform player after a list-loop arrival when nothing is cached", async () => {
    loop.entry = { autoplayLocal: true };
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    expect(await screen.findByTestId("player-bilibili")).toBeTruthy();
    expect(screen.queryByTestId("player-local")).toBeNull();
  });
});

describe("ContentPage cache progress card", () => {
  beforeEach(() => {
    fakeShell.desktop = true;
  });

  const UNFINISHED = "GET /api/tasks?contentId=c1&kind=cache_media&unfinished=1&limit=1";
  const running = (id: string) => ({ body: taskDetail(id, [stageRun(id, "cache_media", "running", { progress: 0.3 })], { kind: "cache_media", contentId: "c1" }) });
  const listed = (id: string | undefined) => ({ body: { items: id === undefined ? [] : [task(id, { kind: "cache_media", contentId: "c1" })], eventSeq: 0 } });
  const follows = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("brings back the card of an unfinished cache Task on load, under the title row and right above the chat", async () => {
    mockApi({ ...contentRoutes(), [UNFINISHED]: listed("t9"), "GET /api/tasks/t9": running("t9") });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const card = await screen.findByTestId("tracked-task");
    expect(await within(card).findByTestId("stage-cache_media")).toBeTruthy();
    const title = screen.getByTestId("content-title");
    const chat = screen.getByTestId("chat-panel");
    expect(follows(title, card)).toBe(true);
    expect(follows(card, chat)).toBe(true);
    expect(follows(card, screen.getByTestId("player-bilibili"))).toBe(false);
    // Still right above the chat with the player hidden.
    fireEvent.click(screen.getByTestId("toggle-player"));
    expect(follows(screen.getByTestId("tracked-task"), screen.getByTestId("chat-panel"))).toBe(true);
    // The chat is docked in its slot, the column's last child, which lays it out in the column.
    expect(card.parentElement?.lastElementChild).toBe(screen.getByTestId("chat-dock-host"));
    expect(screen.getByTestId("chat-panel").parentElement).toBe(screen.getByTestId("chat-dock-host"));
  });

  it("remembers a closed card across reloads, until another Task comes along", async () => {
    let listedId = "t9";
    const { calls } = mockApi({ ...contentRoutes(), [UNFINISHED]: () => listed(listedId), "GET /api/tasks/t9": running("t9"), "GET /api/tasks/t10": running("t10") });
    const first = renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(within(await screen.findByTestId("tracked-task")).getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("tracked-task")).toBeNull();
    expect(localStorage.getItem("amber.cache.dismissed.c1")).toBe("t9");
    first.unmount();

    const reads = () => calls.filter((call) => call.path.includes("kind=cache_media")).length;
    const before = reads();
    const second = renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await waitFor(() => expect(reads()).toBe(before + 1));
    await screen.findByTestId("content-title");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByTestId("tracked-task")).toBeNull();
    second.unmount();

    listedId = "t10";
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    expect(await screen.findByTestId("tracked-task")).toBeTruthy();
    expect(localStorage.getItem("amber.cache.dismissed.c1")).toBeNull();
  });

  it("handles the success of a second cache Task after the first one succeeded", async () => {
    let started = 0;
    mockApi({
      ...contentRoutes(),
      ...INSPECT,
      "POST /api/contents/c1/cache-media": () => {
        started += 1;
        return { status: 202, body: { taskId: started === 1 ? "ta" : "tb" } };
      },
      "GET /api/tasks/ta": {
        body: taskDetail("ta", [stageRun("ta", "cache_media", "succeeded", { progress: 1, reasons: [] })], { kind: "cache_media", contentId: "c1", statusProjection: "succeeded" }),
      },
      "GET /api/tasks/tb": {
        body: taskDetail("tb", [stageRun("tb", "cache_media", "succeeded", { progress: 1, reasons: ["audio_only"] })], {
          kind: "cache_media",
          contentId: "c1",
          statusProjection: "succeeded",
        }),
      },
    });
    localStorage.setItem("amber.cache.dismissed.c1", "old");
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const cache = (await screen.findByTestId("cache-media")) as HTMLButtonElement;
    await waitFor(() => expect(cache.disabled).toBe(false));
    fireEvent.click(cache);
    await startCache();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("tracked-task")).toBeNull());
    expect(screen.queryByTestId("cache-audio-only")).toBeNull();
    expect(localStorage.getItem("amber.cache.dismissed.c1")).toBeNull();

    fireEvent.click(cache);
    await startCache();
    expect(await screen.findByTestId("cache-audio-only")).toBeTruthy();
  });
});

describe("ContentPage toolbar overflow", () => {
  // jsdom has no layout: each toolbar item reports the line flex-wrap would have put it on.
  const wrapped = new Set<string>();
  // Only the toolbar's own observers: the menu's popper observes too and expects real entries.
  const observers: Array<{ callback: () => void; targets: Element[] }> = [];
  const lineOf = (element: HTMLElement): number => (wrapped.has(element.dataset["toolbarItem"] ?? "") ? 1 : 0);

  beforeEach(() => {
    wrapped.clear();
    observers.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly entry: { callback: () => void; targets: Element[] };
        constructor(callback: () => void) {
          this.entry = { callback, targets: [] };
          observers.push(this.entry);
        }
        observe(target: Element): void {
          this.entry.targets.push(target);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return 4 + lineOf(this) * 32;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const openMenu = async () => {
    fireEvent.keyDown(await screen.findByTestId("content-menu"), { key: "Enter" });
    return screen.findByRole("menu");
  };

  it("keeps only 「删除」 in the menu while every control fits", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("toolbar-row");
    expect(document.querySelectorAll("[data-toolbar-item][inert]")).toHaveLength(0);
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["删除"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  it("moves the controls that wrapped into the menu, in toolbar order above 「删除」", async () => {
    wrapped.add("cache-media").add("collections");
    mockApi({ ...contentRoutes(), "GET /api/collections": { body: { items: [] } } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("toolbar-row");
    const hidden = [...document.querySelectorAll<HTMLElement>("[data-toolbar-item][inert]")].map((item) => item.dataset["toolbarItem"]);
    expect(hidden).toEqual(["cache-media", "collections"]);
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.dataset["testid"])).toEqual(["overflow-cache-media", "overflow-collections", "content-menu-delete"]);
    expect(within(menu).getByRole("separator")).toBeTruthy();
    // Greyed as the button is, with the reason the button only shows on hover.
    const cache = within(menu).getByTestId("overflow-cache-media");
    expect(cache.hasAttribute("data-disabled")).toBe(true);
    expect(cache.textContent).toBe("缓存本视频仅客户端可用");
    fireEvent.click(within(menu).getByTestId("overflow-collections"));
    expect(await screen.findByRole("dialog", { name: "管理合集" })).toBeTruthy();
  });

  it("offers 「在线 | 本地缓存」 as a choice checked on the player on screen", async () => {
    wrapped.add("switch-player").add("cache-media").add("collections");
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    const menu = await openMenu();
    const online = within(menu).getByTestId("overflow-switch-player-online");
    const local = within(menu).getByTestId("overflow-switch-player-local");
    expect(online.getAttribute("aria-checked")).toBe("true");
    expect(local.getAttribute("aria-checked")).toBe("false");
    expect(local.hasAttribute("data-disabled")).toBe(true);
    expect(local.textContent).toBe("本地缓存仅客户端可用");
  });

  it("runs the same action from the menu as from the button, and puts controls back once there is room", async () => {
    wrapped.add("toggle-player").add("swap").add("switch-player").add("cache-media").add("collections");
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("player-bilibili");
    fireEvent.click(within(await openMenu()).getByTestId("overflow-toggle-player"));
    await waitFor(() => expect(screen.queryByTestId("player-bilibili")).toBeNull());
    expect(within(await openMenu()).getByTestId("overflow-toggle-player").textContent).toBe("显示播放器");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    wrapped.clear();
    act(() => {
      for (const observer of observers) if (observer.targets.includes(screen.getByTestId("toolbar-row"))) observer.callback();
    });
    expect(document.querySelectorAll("[data-toolbar-item][inert]")).toHaveLength(0);
    expect(screen.getByTestId("toggle-player").textContent).toBe("显示播放器");
  });
});

describe("ContentPage toolbar overflow in the desktop client", () => {
  beforeEach(() => {
    fakeShell.desktop = true;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    // 「另存为…」 and 「管理合集」 wrapped onto the second line.
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return ["save-cache", "collections"].includes(this.dataset["toolbarItem"] ?? "") ? 36 : 4;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("saves the only cache from the menu, naming the file, and says where it went", async () => {
    fakeShell.saveCachedMedia.mockResolvedValue({ savedPath: "D:\\视频\\第一讲.mp4" });
    mockApi({
      ...contentRoutes(contentDetail({ media: [VIDEO_CACHE] })),
      "POST /api/media/v1/save-grant": { body: SAVE_GRANT(VIDEO_CACHE.localPath as string) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.keyDown(await screen.findByTestId("content-menu"), { key: "Enter" });
    const item = await screen.findByTestId("overflow-save-cache");
    expect(item.textContent).toBe("另存为…视频 1080P：第一讲 [1080P].mp4");
    fireEvent.click(item);
    await waitFor(() => expect(fakeShell.saveCachedMedia).toHaveBeenCalledWith(SAVE_GRANT(VIDEO_CACHE.localPath as string).grant, "第一讲 [1080P].mp4"));
    expect((await screen.findByTestId("save-cache-saved")).textContent).toBe("已保存到 D:\\视频\\第一讲.mp4");
  });

  it("offers both caches in a submenu", async () => {
    fakeShell.saveCachedMedia.mockResolvedValue({ savedPath: "D:\\第一讲.mp3" });
    mockApi({
      ...contentRoutes(contentDetail({ media: [AUDIO_CACHE, VIDEO_CACHE] })),
      "POST /api/media/m1/save-grant": { body: SAVE_GRANT(AUDIO_CACHE.localPath as string) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.keyDown(await screen.findByTestId("content-menu"), { key: "Enter" });
    fireEvent.keyDown(await screen.findByTestId("overflow-save-cache"), { key: "ArrowRight" });
    const submenu = (await screen.findByTestId("overflow-save-cache-m1")).parentElement as HTMLElement;
    expect(within(submenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["视频 1080P：第一讲 [1080P].mp4", "音频：第一讲.mp3"]);
    fireEvent.click(within(submenu).getByTestId("overflow-save-cache-m1"));
    await waitFor(() => expect(fakeShell.saveCachedMedia).toHaveBeenCalledWith(SAVE_GRANT(AUDIO_CACHE.localPath as string).grant, "第一讲.mp3"));
    expect(await screen.findByTestId("save-cache-saved")).toBeTruthy();
  });

  describe("subtitle editor requests", () => {
    const ME = { "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } } };

    it("switches a platform Content to its cached copy, turns subtitles on and opens the editor", async () => {
      mockApi({ ...contentRoutes(contentDetail({ media: [VIDEO_CACHE] })), ...ME });
      renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
      const local = (await screen.findByTestId("switch-player-local")) as HTMLButtonElement;
      await waitFor(() => expect(local.disabled).toBe(false));
      fireEvent.click(screen.getByTestId("toggle-player"));
      expect(screen.queryByTestId("player-bilibili")).toBeNull();
      act(() => pageState.current?.openSubtitleEditor());
      const player = await screen.findByTestId("player-local");
      expect(await within(player).findByTestId("subtitle-editor")).toBeTruthy();
      // Without a translation the original line is shown; the cue at 0 s is the first sentence.
      await waitFor(() => expect(within(player).getByTestId("subtitle-text").textContent).toBe("今天讲检索。"));
      fireEvent.click(within(player).getByTestId("subtitle-editor-done"));
      expect(within(player).queryByTestId("subtitle-editor")).toBeNull();
      expect(within(player).getByTestId("player-subtitles").getAttribute("data-active")).toBe("true");
    });

    it("says under the iframe where subtitles show when there is no cached copy", async () => {
      mockApi({ ...contentRoutes(), ...ME });
      renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
      await screen.findByTestId("player-bilibili");
      expect(screen.queryByTestId("player-subtitles-iframe-hint")).toBeNull();
      await waitFor(() => expect(pageState.current).toBeDefined());
      act(() => pageState.current?.openSubtitleEditor());
      expect((await screen.findByTestId("player-subtitles-iframe-hint")).textContent).toBe("切到本地缓存播放后可显示字幕");
      expect(screen.getByTestId("player-bilibili")).toBeTruthy();
    });
  });
});

describe("ContentPage chat panel across layouts", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
  });

  const MODEL = { providerProfileId: "p1", modelId: "m-chat" };
  const COLUMNS_PX = BREAKPOINT_DRAWER_PX + 300;
  const DRAWER_PX = Math.round((BREAKPOINT_SINGLE_PX + BREAKPOINT_DRAWER_PX) / 2);
  const SINGLE_PX = BREAKPOINT_SINGLE_PX - 100;

  /** A usable chat model and an empty chat for each Content, so the input is enabled. */
  function chatRoutes(...ids: string[]) {
    return Object.assign(
      {
        "GET /api/providers": { body: { items: [provider("p1", "Relay", ["m-chat"])] } },
        "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, chatModelRef: MODEL, defaultModelRef: MODEL, updatedAt: 1 } },
      },
      ...ids.map((id) => ({
        [`GET /api/contents/${id}/chat`]: { body: { thread: null, messages: [], context: { mode: "full", estimatedTokens: 1 } } },
        [`GET /api/contents/${id}/chat/threads`]: { body: { threads: [] } },
      })),
    );
  }

  /** Answers every question with a stream that stays open; returns the requests' abort signals. */
  function holdAnswers(): AbortSignal[] {
    const signals: AbortSignal[] = [];
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if ((init.method ?? "GET") === "POST" && String(input).endsWith("/chat/messages")) {
        const signal = init.signal ?? new AbortController().signal;
        signals.push(signal);
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))),
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return base(input, init);
    });
    return signals;
  }

  async function resizeTo(width: number, layout: "columns" | "drawer" | "single"): Promise<void> {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(document.querySelector(`[data-layout='${layout}']`)).not.toBeNull());
  }

  const panel = () => screen.getByTestId("chat-panel");
  const chatInput = () => screen.getByTestId("chat-input") as HTMLTextAreaElement;
  const docked = () => panel().parentElement === screen.getByTestId("chat-dock-host");
  const floatingNow = () => panel().parentElement === document.body && panel().getAttribute("data-floating") === "true";

  it("keeps one chat panel, its draft and its answer in flight through every layout, tab, collapse, float and dock", async () => {
    mockApi({ ...contentRoutes(), ...chatRoutes("c1") });
    const signals = holdAnswers();
    const { unmount } = renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await waitFor(() => expect(chatInput().disabled).toBe(false));
    fireEvent.change(chatInput(), { target: { value: "第一问" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(signals).toHaveLength(1));
    await screen.findByTestId("chat-stop");
    fireEvent.change(chatInput(), { target: { value: "下一问的草稿" } });
    // The panel is what the page renders it as: the stop button and the draft live in its state.
    const intact = (): void => {
      expect(screen.getAllByTestId("chat-panel")).toHaveLength(1);
      expect(chatInput().value).toBe("下一问的草稿");
      expect(screen.getByTestId("chat-stop")).toBeTruthy();
      expect(signals[0]?.aborted).toBe(false);
    };
    expect(docked()).toBe(true);

    await resizeTo(DRAWER_PX, "drawer");
    expect(docked()).toBe(true);
    intact();

    await resizeTo(SINGLE_PX, "single");
    expect(docked()).toBe(true);
    intact();
    const [middleTab, outputsTab] = screen.getAllByRole("tab");
    fireEvent.click(outputsTab!);
    // Nowhere to dock: no chat on screen, but the panel lives on.
    expect(screen.queryByTestId("chat-panel")).toBeNull();
    expect(screen.queryByTestId("chat-input")).toBeNull();
    expect(signals[0]?.aborted).toBe(false);
    fireEvent.click(middleTab!);
    intact();

    await resizeTo(COLUMNS_PX, "columns");
    intact();
    fireEvent.click(screen.getByTestId("collapse-middle"));
    expect(screen.getByTestId("middle-column").classList.contains("hidden")).toBe(true);
    expect(signals[0]?.aborted).toBe(false);
    fireEvent.click(screen.getByTestId("expand-middle"));
    intact();

    fireEvent.click(screen.getByTestId("chat-float"));
    expect(floatingNow()).toBe(true);
    intact();
    fireEvent.click(screen.getByTestId("toggle-player"));
    fireEvent.click(screen.getByRole("button", { name: "左右交换" }));
    expect(floatingNow()).toBe(true);
    await resizeTo(DRAWER_PX, "drawer");
    expect(floatingNow()).toBe(true);
    intact();
    fireEvent.click(screen.getByTestId("chat-dock"));
    expect(docked()).toBe(true);
    intact();

    // Leaving the page is what stops it.
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("floats from the dock, leaves a line with 「停靠」 in the column, and docks from there", async () => {
    mockApi({ ...contentRoutes(), ...chatRoutes("c1") });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("chat-panel");
    expect(screen.queryByTestId("chat-floating-placeholder")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-float"));
    expect(floatingNow()).toBe(true);
    expect(localStorage.getItem("amber.content.chatFloating")).toBe("1");
    const line = screen.getByTestId("chat-floating-placeholder");
    expect(within(screen.getByTestId("middle-column")).getByTestId("chat-floating-placeholder")).toBe(line);
    expect(line.textContent).toBe("对话已悬浮停靠");
    // The first window: 480 wide, 60% of the viewport high, 16 px from the bottom right.
    const rect = defaultChatRect(window.innerWidth, window.innerHeight);
    expect(rect).toEqual({ left: window.innerWidth - 496, top: window.innerHeight - Math.round(window.innerHeight * 0.6) - 16, width: 480, height: Math.round(window.innerHeight * 0.6) });
    expect(panel().style.left).toBe(`${rect.left}px`);
    expect(panel().style.top).toBe(`${rect.top}px`);

    fireEvent.click(within(line).getByTestId("chat-floating-dock"));
    expect(docked()).toBe(true);
    expect(screen.queryByTestId("chat-floating-placeholder")).toBeNull();
    expect(localStorage.getItem("amber.content.chatFloating")).toBe("0");
  });

  it("stores where the window was dragged, and falls back to the first place for a broken stored value", async () => {
    localStorage.setItem("amber.content.chatFloating", "1");
    localStorage.setItem("amber.content.chatRect", "{not json");
    mockApi({ ...contentRoutes(), ...chatRoutes("c1") });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("chat-panel");
    const rect = defaultChatRect(window.innerWidth, window.innerHeight);
    expect(floatingNow()).toBe(true);
    expect(panel().style.left).toBe(`${rect.left}px`);
    const header = panel().querySelector("header") as HTMLElement;
    fireEvent.pointerDown(header, { pointerId: 1, button: 0, clientX: 1000, clientY: 400 });
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 900, clientY: 350 });
    fireEvent.pointerUp(header, { pointerId: 1, clientX: 900, clientY: 350 });
    expect(JSON.parse(localStorage.getItem("amber.content.chatRect") ?? "")).toEqual({ ...rect, left: rect.left - 100, top: rect.top - 50 });
  });

  it("reads back only a usable stored window", () => {
    expect(parseChatRect('{"left":10,"top":20,"width":400,"height":300}')).toEqual({ left: 10, top: 20, width: 400, height: 300 });
    expect(parseChatRect(undefined)).toBeUndefined();
    expect(parseChatRect("{not json")).toBeUndefined();
    expect(parseChatRect("null")).toBeUndefined();
    expect(parseChatRect("[1,2,3,4]")).toBeUndefined();
    expect(parseChatRect('{"left":10,"top":20,"width":0,"height":300}')).toBeUndefined();
    expect(parseChatRect('{"left":10,"top":20,"width":400,"height":-1}')).toBeUndefined();
    expect(parseChatRect('{"left":"10","top":20,"width":400,"height":300}')).toBeUndefined();
    expect(parseChatRect('{"left":10,"top":20,"width":400}')).toBeUndefined();
    expect(parseChatRect('{"left":1e999,"top":20,"width":400,"height":300}')).toBeUndefined();
    // A narrow viewport: the margins still hold.
    expect(defaultChatRect(400, 300)).toEqual({ left: 16, top: 104, width: 368, height: 180 });
  });

  it("keeps floating, at the same place, for another Content, whose own chat it shows", async () => {
    const stored = { left: 200, top: 100, width: 420, height: 360 };
    localStorage.setItem("amber.content.chatFloating", "1");
    localStorage.setItem("amber.content.chatRect", JSON.stringify(stored));
    const { calls } = mockApi({ ...contentRoutes(), ...contentRoutes(contentDetail({ id: "c2", title: "第二讲" })), ...chatRoutes("c1", "c2") });
    renderApp(
      <>
        <Link to="/contents/c2" data-testid="go-c2">
          go
        </Link>
        <ContentPage />
      </>,
      { route: "/contents/c1", path: "/contents/:id" },
    );
    await screen.findByTestId("chat-panel");
    expect(floatingNow()).toBe(true);
    expect([panel().style.left, panel().style.top, panel().style.width, panel().style.height]).toEqual(["200px", "100px", "420px", "360px"]);

    fireEvent.click(screen.getByTestId("go-c2"));
    expect(await screen.findByText("第二讲", { selector: "[data-testid='content-title'] *, [data-testid='content-title']" })).toBeTruthy();
    await screen.findByTestId("chat-panel");
    expect(floatingNow()).toBe(true);
    expect([panel().style.left, panel().style.top, panel().style.width, panel().style.height]).toEqual(["200px", "100px", "420px", "360px"]);
    await waitFor(() => expect(calls.some((call) => call.path.startsWith("/api/contents/c2/chat"))).toBe(true));
  });

  it("docks in the single layout without offering to float, and floats again once the window is wide", async () => {
    localStorage.setItem("amber.content.chatFloating", "1");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: SINGLE_PX });
    mockApi({ ...contentRoutes(), ...chatRoutes("c1") });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    await screen.findByTestId("chat-panel");
    expect(document.querySelector("[data-layout='single']")).not.toBeNull();
    expect(docked()).toBe(true);
    expect(screen.queryByTestId("chat-float")).toBeNull();
    expect(screen.queryByTestId("chat-floating-placeholder")).toBeNull();
    expect(localStorage.getItem("amber.content.chatFloating")).toBe("1");

    await resizeTo(DRAWER_PX, "drawer");
    expect(floatingNow()).toBe(true);
    expect(screen.getByTestId("chat-floating-placeholder")).toBeTruthy();
  });

  it("fills the floating window's input when a selection is explained, and focuses it", async () => {
    localStorage.setItem("amber.content.chatFloating", "1");
    mockApi({ ...contentRoutes(), ...chatRoutes("c1") });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" },
    );
    await waitFor(() => expect(chatInput().disabled).toBe(false));
    expect(floatingNow()).toBe(true);
    const reader = await screen.findByTestId("transcript-reader");
    const cited = await waitFor(() => reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`) as HTMLElement);
    const text = cited.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: text, offset: 3 });
    act(() => {
      cited.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    fireEvent.click(screen.getByTestId("context-menu-item-explain-selection"));
    await waitFor(() => expect(chatInput().value).toBe("解释一下「重排序」"));
    expect(floatingNow()).toBe(true);
    expect(document.activeElement).toBe(chatInput());
  });
});
