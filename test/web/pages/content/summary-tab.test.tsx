import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX, PARAGRAPH_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import type { ChapterRevisionDto, ChaptersDto } from "../../../../src/shared/dto/chapter.ts";
import type { ContentSummariesDto } from "../../../../src/shared/dto/summary.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { restorablePlatformRevision, statusOf } from "../../../../src/web/pages/content/summary-tab.tsx";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";
import { CITED_SEGMENT_ID, contentDetail, contentRoutes, revision, SEGMENTS, segment } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { stageRun, task, taskDetail } from "../../../fixtures/web/shell-data.ts";

const PROVIDERS = { body: { items: [{ id: "p1", name: "P", protocol: "openai_compatible", baseURL: "https://x", credentialStatus: "configured", hasCredential: true, models: [], createdAt: 1 }] } };

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
});

describe("ChapterSection", () => {
  it("expands a chapter into reading paragraphs with the sentences separated like the transcript", async () => {
    // Five punctuated sentences of a quarter of the cap each: the first paragraph closes after the fourth.
    const sentence = `${"讲".repeat(PARAGRAPH_MAX_CHARS / 4 - 1)}。`;
    const opening = ["o1", "o2", "o3", "o4", "o5"].map((id, index) => segment(id, index, index * 1_000, (index + 1) * 1_000, sentence));
    const body = [segment("b1", 5, 60_000, 64_000, "再看重排序"), segment(CITED_SEGMENT_ID, 6, 64_000, 68_000, "最后总结")];
    mockApi({ ...contentRoutes(), "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: [...opening, ...body] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    // The first test in this file also pays for loading the content page; under a full parallel run that alone can pass the default second.
    const section = await screen.findByTestId("chapter-section", {}, { timeout: 5_000 });
    const toggles = await waitFor(() => {
      const buttons = within(section).getAllByRole("button", { expanded: false });
      expect(buttons).toHaveLength(2);
      return buttons;
    });
    fireEvent.click(toggles[0] as HTMLElement);
    fireEvent.click(toggles[1] as HTMLElement);
    const [first, second] = await waitFor(() => {
      const texts = screen.getAllByTestId("chapter-text");
      expect(texts).toHaveLength(2);
      return texts;
    });
    const openingParagraphs = [...(first as HTMLElement).querySelectorAll("p")].map((node) => node.textContent ?? "");
    expect(openingParagraphs).toHaveLength(2);
    expect(openingParagraphs[0]).toBe(sentence.repeat(4));
    expect(openingParagraphs[1]).toBe(sentence);
    expect([...(second as HTMLElement).querySelectorAll("p")].map((node) => node.textContent)).toEqual(["再看重排序 最后总结"]);
  });
  it("runs a proofread CJK sentence that spans two time slices on without a space in an expanded chapter", async () => {
    const items = [
      segment("o1", 0, 0, 1_000, "开场。", { paragraphStart: true }),
      segment("b1", 1, 60_000, 64_000, "但这样就等于你同时拒绝了你的老师", { paragraphStart: true }),
      segment(CITED_SEGMENT_ID, 2, 64_000, 68_000, "和牛逼的网课，进入恶性循环。", { paragraphStart: false }),
    ];
    mockApi({ ...contentRoutes(), "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    fireEvent.click(await within(section).findByRole("button", { name: /^正文/ }));
    const text = await screen.findByTestId("chapter-text");
    expect([...text.querySelectorAll("p")].map((node) => node.textContent)).toEqual(["但这样就等于你同时拒绝了你的老师和牛逼的网课，进入恶性循环。"]);
  });
  it("opens a chapter from anywhere on its heading; the timestamp only seeks and the open text does not close it", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const heading = await within(section).findByRole("button", { name: /^开场/ });
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(within(section).getAllByRole("button", { name: "0:00" })[0] as HTMLElement);
    expect(screen.queryByTestId("chapter-text")).toBeNull();
    fireEvent.click(within(heading).getByText("开场"));
    const text = await screen.findByTestId("chapter-text");
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(text);
    expect(screen.getByTestId("chapter-text")).toBe(text);
    fireEvent.click(heading);
    expect(screen.queryByTestId("chapter-text")).toBeNull();
    expect(heading.getAttribute("aria-expanded")).toBe("false");
  });
  it("regenerates chapters with the default model next to the section title", async () => {
    const model = { providerProfileId: "p1", modelId: "m1" };
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, defaultModelRef: model, updatedAt: 1 } },
      "GET /api/providers": PROVIDERS,
      "POST /api/contents/c1/chapters/regenerate": { status: 202, body: { taskId: "t9" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const button = await within(section).findByTestId("chapters-regenerate");
    expect(button.textContent).toBe("重新生成");
    await waitFor(() => expect(calls.some((call) => call.path === "/api/settings")).toBe(true));
    await act(async () => undefined);
    fireEvent.click(button);
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.path).toBe("/api/contents/c1/chapters/regenerate"));
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({ modelRef: model });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.path === "/api/contents/c1/chapters")).toHaveLength(2));
  });
  it("shows the server's refusal to regenerate chapters", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "POST /api/contents/c1/chapters/regenerate": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.mutation_lane", retryDisposition: "never", userMessage: "另一个任务正在处理" } },
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    fireEvent.click(await within(section).findByTestId("chapters-regenerate"));
    expect((await within(section).findByRole("alert")).textContent).toContain("另一个任务正在处理");
  });
  it("disables regeneration while a Task works on chapters, with the Task's flow shown once above", async () => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as Record<string, unknown>;
    mockApi({
      ...routes,
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...chapters, activeTaskId: "t5", activeStage: "running" } },
      "GET /api/tasks/t5": { body: taskDetail("t5", [stageRun("t5", "chapter", "running")], { kind: "regenerate_chapters", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const button = (await within(section).findByTestId("chapters-regenerate")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("正在重新生成…");
    // The chapter area carries no stage flow of its own.
    expect(within(section).queryByTestId("task-flow")).toBeNull();
  });
  it("points to model configuration instead of regenerating without a model", async () => {
    mockApi({ ...contentRoutes(), "GET /api/providers": { body: { items: [] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    expect((await within(section).findByTestId("chapters-configure")).getAttribute("href")).toBe("/settings/models");
    expect(within(section).queryByTestId("chapters-regenerate")).toBeNull();
  });
  it("stays in place without chapters: an empty state and a button to generate them", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { revisions: [] } },
      "POST /api/contents/c1/chapters/regenerate": { status: 202, body: { taskId: "t9" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    expect(await within(section).findByTestId("chapters-empty")).toBeTruthy();
    expect(within(section).queryByTestId("chapters-needs-transcript")).toBeNull();
    const button = (await within(section).findByTestId("chapters-regenerate")) as HTMLButtonElement;
    expect(button.textContent).toBe("生成章节");
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/contents/c1/chapters/regenerate")).toBe(true));
  });
  it("disables the button and says why when there is no transcript to generate from", async () => {
    const { primaryTranscriptRevisionId: _primary, ...withoutPrimary } = contentDetail();
    mockApi({
      ...contentRoutes(withoutPrimary),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { revisions: [] } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    expect((await within(section).findByTestId("chapters-needs-transcript")).textContent).toBe("需要先有字幕或转录稿");
    expect((within(section).getByTestId("chapters-regenerate") as HTMLButtonElement).disabled).toBe(true);
    expect(within(section).queryByTestId("chapters-empty")).toBeNull();
  });
  it.each([
    ["queued", true, "排队中…"],
    ["running", true, "正在重新生成…"],
    ["running", false, "正在生成…"],
    ["waiting", true, "等待处理完成"],
  ] as const)("labels chapter work that is %s (chapters present: %s) and keeps the button off", async (activeStage, withChapters, label) => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as Record<string, unknown>;
    mockApi({
      ...routes,
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...(withChapters ? chapters : { revisions: [] }), activeTaskId: "t5", activeStage } },
      "GET /api/tasks/t5": { body: taskDetail("t5", [stageRun("t5", "chapter", "running")], { kind: "regenerate_chapters", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const button = (await within(section).findByTestId("chapters-regenerate")) as HTMLButtonElement;
    expect(button.textContent).toBe(label);
    expect(button.disabled).toBe(true);
    // Only waiting explains itself in a tooltip.
    expect(button.parentElement?.getAttribute("title")).toBe(activeStage === "waiting" ? "章节要等当前的处理任务完成后才会生成" : null);
  });
  it("offers a line for a failed last attempt that opens the chapter stage's error, with the button still ready to retry", async () => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as Record<string, unknown>;
    const failure = { class: "llm_failed", code: "llm_failed", retryDisposition: "policy", userMessage: "章节模型调用失败" } as const;
    const { calls } = mockApi({
      ...routes,
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...chapters, lastFailedTaskId: "t7" } },
      "GET /api/tasks/t7": {
        body: taskDetail("t7", [stageRun("t7", "source", "succeeded"), stageRun("t7", "chapter", "failed", { error: failure })], { kind: "regenerate_chapters", contentId: "c1" }),
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const line = await within(section).findByTestId("chapters-failed");
    expect(line.textContent).toContain("上次生成章节失败");
    // The failed Task is read only once the reason is asked for.
    expect(calls.some((call) => call.path === "/api/tasks/t7")).toBe(false);
    const toggle = within(line).getByRole("button", { name: "查看原因" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect((await within(line).findByRole("alert")).textContent).toContain("章节模型调用失败");
    expect(within(line).getByRole("button", { name: "收起原因" }).getAttribute("aria-expanded")).toBe("true");
    expect((within(section).getByTestId("chapters-regenerate") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(line).getByRole("button", { name: "收起原因" }));
    expect(within(line).queryByRole("alert")).toBeNull();
  });
  it("hides the failed-attempt line while a retry is under way", async () => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as Record<string, unknown>;
    mockApi({
      ...routes,
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...chapters, lastFailedTaskId: "t7", activeTaskId: "t8", activeStage: "running" } },
      "GET /api/tasks/t8": { body: taskDetail("t8", [stageRun("t8", "chapter", "running")], { kind: "regenerate_chapters", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    expect((await within(section).findByTestId("chapters-regenerate")).textContent).toBe("正在重新生成…");
    expect(within(section).queryByTestId("chapters-failed")).toBeNull();
  });
  it("reads the chapters again on a stage event of the Task working on them, and on no other", async () => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as Record<string, unknown>;
    const api = mockApi({
      ...routes,
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...chapters, activeTaskId: "t5", activeStage: "waiting" } },
    });
    const stream = taskStream();
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const reads = (): number => api.calls.filter((call) => call.path === "/api/contents/c1/chapters").length;
    await screen.findByTestId("chapter-section");
    await waitFor(() => expect(stream.opened()).toBe(true));
    await waitFor(() => expect(reads()).toBe(1));
    stream.frame("stage.updated", { stageRun: stageRun("other", "chapter", "running") });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(reads()).toBe(1);
    stream.frame("stage.updated", { stageRun: stageRun("t5", "summary", "succeeded") });
    await waitFor(() => expect(reads()).toBe(2));
  });
  it("shows one stage flow for a Task that both the template and the chapters wait on", async () => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as Record<string, unknown>;
    const summaries = routes["GET /api/contents/c1/summaries"]?.body as { templates: Array<Record<string, unknown>> };
    mockApi({
      ...routes,
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...chapters, activeTaskId: "t5", activeStage: "running" } },
      "GET /api/contents/c1/summaries": { body: { templates: summaries.templates.map((entry, index) => (index === 0 ? { ...entry, activeTaskId: "t5" } : entry)) } },
      "GET /api/tasks/t5": { body: taskDetail("t5", [stageRun("t5", "chapter", "running"), stageRun("t5", "summary", "pending")], { contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    await screen.findByTestId("task-flow");
    await within(await screen.findByTestId("chapter-section")).findByTestId("chapters-regenerate");
    expect(screen.getAllByTestId("task-flow")).toHaveLength(1);
  });
  it("words stale chapters as built on an older transcript", async () => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as { current: Record<string, unknown> };
    const current = { ...chapters.current, origin: { kind: "ai", transcriptRevisionId: "r0" }, stale: true, staleReason: "transcript_changed" };
    mockApi({ ...routes, "GET /api/contents/c1/chapters": { body: { ...chapters, current } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    expect(await within(await screen.findByTestId("chapter-section")).findByText("章节基于旧版原文生成，可能已过期，可按需重新生成")).toBeTruthy();
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

describe("summary copy and context menu", () => {
  function setup() {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mockApi(contentRoutes());
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=summary", path: "/contents/:id" },
    );
    return writeText;
  }

  it("copies the whole summary with citations as timestamps from the button and the menu", async () => {
    const writeText = setup();
    const body = await screen.findByTestId("summary-body");
    // Wait for the cited sentence's time, so the copy carries it.
    await within(body).findByRole("button", { name: "1:15" });
    const copy = screen.getByRole("button", { name: "复制" });
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("## 摘要\n讲了重排序 [1:15]。"));
    await waitFor(() => expect(copy.textContent).toBe("已复制"));

    expect(rightClick(within(body).getByText(/讲了重排序/))).toBe(true);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["复制全文", "导出…"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-all"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith("## 摘要\n讲了重排序 [1:15]。");
  });

  it("opens the export dialog from the menu", async () => {
    setup();
    const body = await screen.findByTestId("summary-body");
    rightClick(body);
    fireEvent.click(screen.getByTestId("context-menu-item-export"));
    expect(await screen.findByTestId("export-dialog")).toBeTruthy();
  });

  /** Selects within `body` from the start of `from` to the end of `to`, and aims the next right click into it. */
  function selectAcross(from: Text, to: Text): void {
    const range = document.createRange();
    range.setStart(from, 0);
    range.setEnd(to, to.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: from, offset: 1 });
  }

  it("explains a summary selection without the citation badge and without a quote", async () => {
    setup();
    const body = await screen.findByTestId("summary-body");
    // A known cited sentence wraps its badge in the citation card's anchor.
    const badge = await waitFor(() => {
      const found = within(body).getByRole("button", { name: "1:15" });
      expect(found.parentElement?.tagName).toBe("SPAN");
      return found;
    });
    const before = badge.parentElement?.previousSibling as Text;
    const after = badge.parentElement?.nextSibling as Text;
    selectAcross(before, after);
    expect(window.getSelection()?.toString()).toContain("1:15");
    fireEvent.mouseUp(document);
    expect(await screen.findByTestId("selection-toolbar")).toBeTruthy();
    expect(rightClick(before.parentElement as HTMLElement)).toBe(true);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["复制选中内容", "解释选中内容", "复制全文", "导出…"]);
    fireEvent.click(screen.getByTestId("context-menu-item-explain-selection"));
    await waitFor(() => expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("解释一下「讲了重排序。」"));
    expect(screen.queryByTestId("chat-quote")).toBeNull();
    expect(window.getSelection()?.isCollapsed).toBe(true);
    delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
  });

  it("explains a selection in an opened chapter, and leaves other right clicks there to the browser", async () => {
    setup();
    const section = await screen.findByTestId("chapter-section");
    fireEvent.click(await within(section).findByRole("button", { name: /^开场/ }));
    const paragraph = (await screen.findByTestId("chapter-text")).querySelector("p") as HTMLElement;
    expect(rightClick(paragraph)).toBe(false);
    selectAcross(paragraph.firstChild as Text, paragraph.firstChild as Text);
    expect(rightClick(paragraph)).toBe(true);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["复制选中内容", "解释选中内容"]);
    fireEvent.click(screen.getByTestId("context-menu-item-explain-selection"));
    await waitFor(() => expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe(`解释一下「${paragraph.textContent ?? ""}」`));
    delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
  });
});

describe("template status", () => {
  type Entry = ContentSummariesDto["templates"][number];
  const template = { id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false };
  const idle: Entry = { template, stale: false };
  const active: Entry = { ...idle, activeTaskId: "t1" };
  const withSummary = (status: Parameters<typeof stageRun>[2]) => taskDetail("t1", [stageRun("t1", "asr", "running"), stageRun("t1", "summary", status)]);

  it("tells generating from waiting for earlier stages or for a model", () => {
    expect(statusOf(idle, undefined)).toBe("notGenerated");
    expect(statusOf(active, undefined)).toBe("generating");
    expect(statusOf(active, withSummary("pending"))).toBe("queued");
    expect(statusOf(active, taskDetail("t1", [stageRun("t1", "asr", "running")]))).toBe("queued");
    expect(statusOf(active, withSummary("waiting_configuration"))).toBe("waitingConfiguration");
    expect(statusOf(active, withSummary("running"))).toBe("generating");
    // Once its own stage is over, the template reads as its artifact does even while the Task goes on.
    expect(statusOf(active, withSummary("succeeded"))).toBe("notGenerated");
  });

  it("labels a template whose Task waits for a model 等待配置 in the switcher", async () => {
    const routes = contentRoutes();
    const summaries = routes["GET /api/contents/c1/summaries"]?.body as ContentSummariesDto;
    const templates = summaries.templates.map((entry) => (entry.template.id === "summary.detailed" ? { ...entry, activeTaskId: "t9" } : entry));
    mockApi({
      ...routes,
      "GET /api/contents/c1/summaries": { body: { templates } },
      "GET /api/tasks/t9": { body: taskDetail("t9", [stageRun("t9", "summary", "waiting_configuration")]) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const pill = await screen.findByTestId("summary-template-summary.detailed");
    await waitFor(() => expect(pill.textContent).toContain("等待配置"));
    expect(pill.textContent).not.toContain("生成中");
  });
});

describe("summary empty state", () => {
  it("shows the stages of the latest process_content Task even when a newer cache_media Task exists", async () => {
    const routes = contentRoutes();
    const summaries = routes["GET /api/contents/c1/summaries"]?.body as ContentSummariesDto;
    const templates = summaries.templates.map(({ current: _current, artifactId: _artifact, ...entry }) => entry);
    const processing = task("t1", { contentId: "c1", createdAt: 1 });
    const caching = task("t2", { kind: "cache_media", contentId: "c1", createdAt: 2 });
    const { calls } = mockApi({
      ...routes,
      "GET /api/contents/c1/summaries": { body: { templates } },
      // Answers like the server: newest first, narrowed by kind when the client asks for one.
      "GET /api/tasks": (call) => {
        const kind = new URL(call.path, "http://amber.test").searchParams.get("kind");
        const items = [caching, processing].filter((item) => kind === null || item.kind === kind);
        return { body: { items: items.slice(0, 1), eventSeq: 0 } };
      },
      "GET /api/tasks/t1": { body: taskDetail("t1", [stageRun("t1", "source", "succeeded"), stageRun("t1", "asr", "running")], { contentId: "c1" }) },
      "GET /api/tasks/t2": { body: taskDetail("t2", [stageRun("t2", "cache_media", "running")], { kind: "cache_media", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const empty = await screen.findByTestId("summary-empty");
    await waitFor(() => expect(within(empty).getByTestId("stage-asr")).toBeTruthy());
    expect(within(empty).queryByTestId("stage-cache_media")).toBeNull();
    expect(calls.map((call) => call.path)).toContain("/api/tasks?contentId=c1&kind=process_content&limit=1");
  });

  it("folds a later reproofread and a same-template summary redo into their rows, and leaves other templates, translate, burn and cache Tasks out", async () => {
    const routes = contentRoutes();
    const summaries = routes["GET /api/contents/c1/summaries"]?.body as ContentSummariesDto;
    const templates = summaries.templates.map(({ current: _current, artifactId: _artifact, ...entry }) => entry);
    const processing = task("t1", { contentId: "c1", createdAt: 1, statusProjection: "succeeded", templateId: "summary.core" });
    const later = 5_000;
    const others = [
      task("r1", { kind: "reproofread", contentId: "c1", createdAt: later, statusProjection: "running" }),
      // Newest first: another template's redo is skipped in favour of the processing Task's template.
      task("r2", { kind: "regenerate_summary", contentId: "c1", createdAt: later + 1, statusProjection: "failed", templateId: "summary.detailed" }),
      task("r6", { kind: "regenerate_summary", contentId: "c1", createdAt: later, statusProjection: "succeeded", templateId: "summary.core" }),
      task("r3", { kind: "translate", contentId: "c1", createdAt: later }),
      task("r4", { kind: "burn", contentId: "c1", createdAt: later }),
      task("r5", { kind: "cache_media", contentId: "c1", createdAt: later }),
    ];
    const { calls } = mockApi({
      ...routes,
      "GET /api/contents/c1/summaries": { body: { templates } },
      "GET /api/tasks": (call) => {
        const kind = new URL(call.path, "http://amber.test").searchParams.get("kind");
        const limit = Number(new URL(call.path, "http://amber.test").searchParams.get("limit") ?? "1");
        const items = [...others, processing].filter((item) => kind === null || item.kind === kind);
        return { body: { items: items.slice(0, limit), eventSeq: 0 } };
      },
      "GET /api/tasks/t1": {
        body: taskDetail(
          "t1",
          [stageRun("t1", "source", "succeeded", { startedAt: 2 }), stageRun("t1", "proofread", "skipped"), stageRun("t1", "summary", "failed", { startedAt: 3 })],
          { contentId: "c1", statusProjection: "succeeded" },
        ),
      },
      "GET /api/tasks/r1": {
        body: taskDetail("r1", [stageRun("r1", "proofread", "running", { startedAt: later })], { kind: "reproofread", contentId: "c1", createdAt: later }),
      },
      "GET /api/tasks/r6": {
        body: taskDetail("r6", [stageRun("r6", "summary", "succeeded", { startedAt: later })], { kind: "regenerate_summary", contentId: "c1", createdAt: later, templateId: "summary.core" }),
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const empty = await screen.findByTestId("summary-empty");
    await waitFor(() => expect(within(empty).getByTestId("stage-proofread").dataset.status).toBe("running"));
    expect(within(within(empty).getByTestId("stage-proofread")).getByTestId("stage-source").textContent).toContain("重新校对");
    expect(within(empty).getByTestId("task-flow").dataset.status).toBe("running");
    await waitFor(() => expect(within(empty).getByTestId("stage-summary").dataset.status).toBe("succeeded"));
    expect(within(within(empty).getByTestId("stage-summary")).getByTestId("stage-source").textContent).toContain("生成总结");
    const paths = calls.map((call) => call.path);
    expect(paths).toContain("/api/tasks?contentId=c1&kind=reproofread&limit=1");
    for (const kind of ["translate", "burn", "cache_media", "recompute_highlights"]) {
      expect(paths.some((path) => path.includes(`kind=${kind}`))).toBe(false);
    }
    expect(paths.some((path) => /^\/api\/tasks\/r[2-5]$/.test(path))).toBe(false);
  });
});

describe("citations of a summary written on a former primary", () => {
  it("still open the cited sentence on the revision the summary was written against", async () => {
    const routes = contentRoutes(contentDetail({ primaryTranscriptRevisionId: "r2" }));
    const summaries = (routes["GET /api/contents/c1/summaries"] as { body: ContentSummariesDto }).body;
    const [core, ...others] = summaries.templates;
    const stale = { ...core, stale: true, staleReason: "transcript_changed" } as ContentSummariesDto["templates"][number];
    // The new primary has the same words a minute later under other ids: the old citation must not land there.
    const moved = [segment("n1", 0, 0, 4_000, "今天讲检索。", { revisionId: "r2" }), segment("n2", 1, 135_000, 140_000, "再看重排序。", { revisionId: "r2" })];
    const { calls } = mockApi({
      ...routes,
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r2", revisions: [revision("r1"), revision("r2", { kind: "manual", parentRevisionId: "r1" })] } },
      "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
      "GET /api/transcript/revisions/r2/segments": { body: { revision: revision("r2"), items: moved } },
      "GET /api/contents/c1/summaries": { body: { templates: [stale, ...others] } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    expect(await screen.findByTestId("summary-stale")).toBeTruthy();
    const body = await screen.findByTestId("summary-body");
    fireEvent.click(await within(body).findByRole("button", { name: "1:15" }));
    const frame = screen.getByTestId("player-bilibili");
    await waitFor(() => expect(new URL(frame.getAttribute("src") ?? "").searchParams.get("t")).toBe("75"));
    expect(calls.some((call) => call.path.startsWith("/api/transcript/revisions/r1/segments"))).toBe(true);
  });
});

describe("summary history", () => {
  const summaryRevision = (id: string, createdAt: number) => ({
    id,
    artifactId: "a1",
    body: `版本 ${id}`,
    citations: [],
    transcriptRevisionId: "r1",
    quality: "normal",
    qualityReasons: [],
    stale: false,
    createdAt,
  });
  const LIST = {
    artifactId: "a1",
    currentRevisionId: "sr1",
    items: [summaryRevision("sr-frozen", 1), summaryRevision("sr-old", 2), summaryRevision("sr1", 3)],
    frozenRevisionIds: ["sr-frozen"],
  };

  async function openHistory(): Promise<HTMLElement[]> {
    fireEvent.click(await screen.findByRole("button", { name: "历史版本" }));
    return waitFor(() => {
      const rows = screen.getAllByTestId("summary-history-item");
      expect(rows).toHaveLength(3);
      return rows;
    });
  }
  const row = (id: string): HTMLElement => screen.getAllByTestId("summary-history-item").find((item) => item.dataset.revisionId === id) as HTMLElement;

  it("offers delete only on earlier revisions, disabled on one a collection summary was built from", async () => {
    mockApi({ ...contentRoutes(), "GET /api/summaries/a1/revisions": { body: LIST } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    await openHistory();
    expect(within(row("sr1")).queryByTestId("summary-history-delete")).toBeNull();
    const old = within(row("sr-old")).getByTestId("summary-history-delete") as HTMLButtonElement;
    expect(old.disabled).toBe(false);
    expect(old.getAttribute("aria-label")).toBe("删除这个历史版本");
    const frozen = within(row("sr-frozen")).getByTestId("summary-history-delete") as HTMLButtonElement;
    expect(frozen.disabled).toBe(true);
    expect(frozen.title).toBe("已被合集归纳引用，不能删除");
  });

  it("deletes after a second click and shows the list the server answers", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/summaries/a1/revisions": { body: LIST },
      "DELETE /api/summaries/a1/revisions/sr-old": { body: { ...LIST, items: LIST.items.filter((item) => item.id !== "sr-old") } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    await openHistory();
    const reads = (path: string): number => calls.filter((call) => call.method === "GET" && call.path === path).length;
    const summaries = reads("/api/contents/c1/summaries");
    const transcripts = reads("/api/contents/c1/transcript/revisions");
    fireEvent.click(within(row("sr-old")).getByTestId("summary-history-delete"));
    expect(within(row("sr-old")).getByText("删除后无法恢复")).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(row("sr-old")).getByRole("button", { name: "取消" }));
    expect(within(row("sr-old")).queryByTestId("summary-history-delete-confirm")).toBeNull();
    fireEvent.click(within(row("sr-old")).getByTestId("summary-history-delete"));
    fireEvent.click(within(row("sr-old")).getByTestId("summary-history-delete-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("summary-history-item").map((item) => item.dataset.revisionId)).toEqual(["sr1", "sr-frozen"]));
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/summaries/a1/revisions/sr-old"]);
    // The list came from the answer, not another read.
    expect(reads("/api/summaries/a1/revisions")).toBe(1);
    await waitFor(() => expect(reads("/api/contents/c1/summaries")).toBeGreaterThan(summaries));
    await waitFor(() => expect(reads("/api/contents/c1/transcript/revisions")).toBeGreaterThan(transcripts));
  });

  it("shows the server's refusal to delete", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/summaries/a1/revisions": { body: LIST },
      "DELETE /api/summaries/a1/revisions/sr-old": {
        status: 409,
        body: {
          error: {
            class: "conflict",
            code: "conflict.summary_revision_in_use",
            retryDisposition: "never",
            userMessage: "这个总结版本正在使用（是当前版本，或已被合集归纳引用），不能删除",
            details: { reason: "collection_summary" },
          },
        },
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    await openHistory();
    fireEvent.click(within(row("sr-old")).getByTestId("summary-history-delete"));
    fireEvent.click(within(row("sr-old")).getByTestId("summary-history-delete-confirm"));
    expect(await screen.findByText("这个总结版本正在使用（是当前版本，或已被合集归纳引用），不能删除")).toBeTruthy();
    expect(row("sr-old")).toBeTruthy();
  });
});

/** Answers the task stream with one the test writes frames into; other calls keep the route table. */
function taskStream() {
  const routed = globalThis.fetch;
  let push: ((text: string) => void) | undefined;
  let seq = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/api/tasks/events")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return routed(input, init);
  });
  return {
    opened: () => push !== undefined,
    frame: (type: string, data: object) => {
      seq += 1;
      push?.(`event: ${type}\ndata: ${JSON.stringify(data)}\nid: ${seq}\n\n`);
    },
  };
}

describe("speakers around the summary", () => {
  const CHEN = { id: "sp1", ordinal: 1, name: "陈明", colorIndex: 0, used: true };
  const LI = { id: "sp2", ordinal: 2, name: "李华", colorIndex: 1, used: true };
  // Two named speakers, so the primary is read by speakers; the cited sentence is 李华's.
  const SPOKEN = [segment("s1", 0, 0, 4_000, "今天讲检索。", { speakerId: "sp1" }), segment(CITED_SEGMENT_ID, 2, 75_000, 80_000, "再看重排序。", { speakerId: "sp2" })];

  function routes(options: { confirmed?: boolean; speakerContext?: Record<string, unknown>; stale?: boolean; chapterContext?: Record<string, unknown>; configured?: boolean } = {}) {
    const base = contentRoutes();
    const summaries = (base["GET /api/contents/c1/summaries"] as { body: ContentSummariesDto }).body;
    const [core, ...others] = summaries.templates as [ContentSummariesDto["templates"][number], ...ContentSummariesDto["templates"]];
    const current = { ...core.current, ...(options.speakerContext === undefined ? {} : { speakerContext: options.speakerContext }), ...(options.stale === true ? { stale: true, staleReason: "transcript_changed" } : {}) };
    const chapters = (base["GET /api/contents/c1/chapters"] as { body: { current: Record<string, unknown> } }).body;
    const primary = revision("r1", options.confirmed === true ? { speakersConfirmedAt: 5 } : {});
    return {
      ...base,
      ...(options.configured === false ? {} : { "GET /api/providers": PROVIDERS }),
      "GET /api/contents/c1/speakers": { body: { items: [CHEN, LI] } },
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [primary] } },
      "GET /api/transcript/revisions/r1/segments": { body: { revision: primary, items: SPOKEN } },
      "GET /api/contents/c1/summaries": { body: { templates: [{ ...core, current, stale: options.stale === true }, ...others] } },
      "GET /api/contents/c1/chapters": {
        body: {
          ...chapters,
          current: {
            ...chapters.current,
            origin: { kind: "ai", transcriptRevisionId: "r1" },
            ...(options.chapterContext === undefined ? {} : { speakerContext: options.chapterContext }),
          },
        },
      },
    };
  }

  it("shows the summary's speaker basis notice and the chapters' own", async () => {
    mockApi(
      routes({
        confirmed: true,
        speakerContext: { state: "attribution_changed", speakers: [{ id: "sp1", label: "陈明" }], changedSentences: 4 },
        chapterContext: { state: "names_changed", speakers: [{ id: "sp2", label: "发言人 2" }], renamed: [{ id: "sp2", was: "发言人 2", now: "李华" }] },
      }),
    );
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const line = await screen.findByTestId("summary-speaker-basis", {}, { timeout: 5_000 });
    expect(line.textContent).toBe("生成后有 4 句改了发言人，其中的人物观点可能不再准确");
    expect(line.getAttribute("role")).toBe("note");
    expect((await screen.findByTestId("chapters-speaker-basis")).textContent).toBe("生成时为发言人 2，现为李华");
    // Reviewed: nothing to say beside the entries.
    expect(screen.queryByTestId("summary-speakers-not-read")).toBeNull();
  });

  it("suggests regenerating with speakers for a summary made without them once the primary is reviewed", async () => {
    mockApi(routes({ confirmed: true }));
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    expect((await screen.findByTestId("summary-speaker-basis", {}, { timeout: 5_000 })).textContent).toBe("重新生成可带上发言人");
    expect((await screen.findByTestId("chapters-speaker-basis")).getAttribute("data-state")).toBe("can_include");
  });

  it("says nothing about speakers on a stale summary", async () => {
    mockApi(routes({ confirmed: true, stale: true, speakerContext: { state: "evidence_removed", speakers: [], removedCitations: 1 } }));
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    expect(await screen.findByTestId("summary-stale", {}, { timeout: 5_000 })).toBeTruthy();
    await screen.findByTestId("summary-body");
    expect(screen.queryByTestId("summary-speaker-basis")).toBeNull();
  });

  it("tells beside the summary and chapter entries that unreviewed speakers are not read, without asking anything", async () => {
    const { calls } = mockApi({ ...routes(), "POST /api/contents/c1/summaries": { status: 202, body: { taskId: "t9" } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    expect((await screen.findByTestId("summary-speakers-not-read", {}, { timeout: 5_000 })).textContent).toBe("发言人未核对，本次不读取");
    expect((await screen.findByTestId("chapters-speakers-not-read")).textContent).toBe("发言人未核对，本次不读取");
    expect(screen.queryByTestId("summary-speaker-basis")).toBeNull();
    fireEvent.click(screen.getByTestId("summary-generate"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/contents/c1/summaries")).toBe(true));
  });

  it("shows the cited sentence's speaker on the citation's card, with 跳到这句 for the embedded Bilibili player", async () => {
    mockApi(routes({ confirmed: true }));
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const body = await screen.findByTestId("summary-body", {}, { timeout: 5_000 });
    await waitFor(() => {
      // The badge is wrapped once the cited sentence is known, so it is looked up each time.
      fireEvent.pointerEnter(within(body).getByRole("button", { name: "1:15" }));
      expect(screen.getByTestId("citation-card-speaker").textContent).toBe("李华");
    });
    fireEvent.click(screen.getByRole("button", { name: "跳到这句" }));
    const frame = screen.getByTestId("player-bilibili");
    await waitFor(() => expect(new URL(frame.getAttribute("src") ?? "").searchParams.get("t")).toBe("75"));
  });
});

describe("restoring the video's own chapters", () => {
  const chapterRevision = (id: string, origin: ChapterRevisionDto["origin"], createdAt: number, titles: string[]): ChapterRevisionDto => ({
    id,
    artifactId: "a-ch",
    origin,
    chapters: titles.map((title, index) => ({ startMs: index * 60_000, endMs: (index + 1) * 60_000, title })),
    quality: "normal",
    qualityReasons: [],
    stale: false,
    createdAt,
  });
  const ai = chapterRevision("ch-ai", { kind: "ai", transcriptRevisionId: "r1" }, 30, ["AI 开场", "AI 正文"]);
  const olderPlatform = chapterRevision("ch-p1", { kind: "platform" }, 10, ["旧开场"]);
  const newerPlatform = chapterRevision("ch-p2", { kind: "platform" }, 20, ["开场", "正文"]);
  /** AI chapters current over two platform fetches; the newer one is listed first on purpose. */
  const aiOverPlatform: ChaptersDto = { artifactId: "a-ch", current: ai, revisions: [newerPlatform, olderPlatform, ai] };

  it("offers only the newest platform revision, and only while AI chapters are current", () => {
    expect(restorablePlatformRevision(aiOverPlatform)?.id).toBe("ch-p2");
    expect(restorablePlatformRevision({ ...aiOverPlatform, revisions: [olderPlatform, newerPlatform, ai] })?.id).toBe("ch-p2");
    expect(restorablePlatformRevision({ ...aiOverPlatform, revisions: [ai] })).toBeUndefined();
    expect(restorablePlatformRevision({ ...aiOverPlatform, current: newerPlatform })).toBeUndefined();
    expect(restorablePlatformRevision({ artifactId: "a-ch", revisions: [olderPlatform] })).toBeUndefined();
  });

  it("marks platform chapters as the video's own and offers no way back to them", async () => {
    mockApi({ ...contentRoutes(), "GET /api/providers": PROVIDERS });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    expect((await within(section).findByTestId("chapters-platform-tag")).textContent).toBe("视频自带");
    await within(section).findByTestId("chapters-regenerate");
    expect(within(section).queryByTestId("chapters-restore-platform")).toBeNull();
  });

  it("offers nothing for AI chapters of a Content without platform chapters", async () => {
    mockApi({ ...contentRoutes(), "GET /api/providers": PROVIDERS, "GET /api/contents/c1/chapters": { body: { artifactId: "a-ch", current: ai, revisions: [ai] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    await within(section).findByRole("button", { name: /^AI 开场/ });
    expect(within(section).queryByTestId("chapters-restore-platform")).toBeNull();
    expect(within(section).queryByTestId("chapters-platform-tag")).toBeNull();
  });

  it("sits beside 重新生成 over AI chapters, and is off with a reason while chapter work is unfinished", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...aiOverPlatform, activeTaskId: "t5", activeStage: "queued" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const button = (await within(section).findByTestId("chapters-restore-platform")) as HTMLButtonElement;
    expect(button.textContent).toBe("恢复视频自带章节");
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.getAttribute("title")).toBe("章节生成结束后才能恢复视频自带章节");
    expect(button.parentElement?.parentElement?.contains(within(section).getByTestId("chapters-regenerate"))).toBe(true);
  });

  it("switches to the newest platform chapters on the server's answer, re-reads the summaries and tells the other tabs", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: unknown = null;
        postMessage(data: unknown): void {
          posted.push(data);
        }
        close(): void {}
      },
    );
    const restored: ChaptersDto = { ...aiOverPlatform, current: newerPlatform };
    const api = mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: aiOverPlatform },
      "PUT /api/contents/c1/chapters/current": { body: restored },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const button = (await within(section).findByTestId("chapters-restore-platform")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(within(section).queryByTestId("chapters-platform-tag")).toBeNull();
    const reads = (path: string): number => api.calls.filter((call) => call.method === "GET" && call.path === path).length;
    await waitFor(() => expect(reads("/api/contents/c1/summaries")).toBeGreaterThan(0));
    const summaryReads = reads("/api/contents/c1/summaries");
    const chapterReads = reads("/api/contents/c1/chapters");
    fireEvent.click(button);
    expect((await within(section).findByTestId("chapters-platform-tag")).textContent).toBe("视频自带");
    const put = api.calls.filter((call) => call.method === "PUT");
    expect(put.map((call) => [call.path, call.body])).toEqual([["/api/contents/c1/chapters/current", { revisionId: "ch-p2" }]]);
    expect(within(section).getByRole("button", { name: /^开场/ })).toBeTruthy();
    expect(within(section).queryByRole("button", { name: /^AI 开场/ })).toBeNull();
    expect(within(section).queryByTestId("chapters-restore-platform")).toBeNull();
    await waitFor(() => expect(reads("/api/contents/c1/summaries")).toBe(summaryReads + 1));
    // The answer is the chapters as they now are: no further read of them is needed.
    expect(reads("/api/contents/c1/chapters")).toBe(chapterReads);
    expect(posted).toEqual([{ type: "chaptersChanged", contentId: "c1" }]);
  });

  it("says chapter work is under way when the server refuses for it, and keeps the current chapters", async () => {
    const api = mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: aiOverPlatform },
      "PUT /api/contents/c1/chapters/current": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.tasks_unfinished", retryDisposition: "never", userMessage: "还有未完成的任务" } },
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    fireEvent.click(await within(section).findByTestId("chapters-restore-platform"));
    // Not the code's generic wording, which is about deleting.
    expect((await within(section).findByTestId("chapters-restore-busy")).textContent).toBe("章节正在生成，生成结束后才能恢复视频自带章节");
    expect(within(section).queryByText(/还有未完成的任务/)).toBeNull();
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(within(section).getByRole("button", { name: /^AI 开场/ })).toBeTruthy();
    expect(within(section).queryByTestId("chapters-platform-tag")).toBeNull();
    expect(((await within(section).findByTestId("chapters-restore-platform")) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows any other refusal as an error and keeps the current chapters", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: aiOverPlatform },
      "PUT /api/contents/c1/chapters/current": {
        status: 404,
        body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "找不到这份章节" } },
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    fireEvent.click(await within(section).findByTestId("chapters-restore-platform"));
    expect((await within(section).findByRole("alert")).textContent).toContain("找不到这份章节");
    expect(within(section).getByRole("button", { name: /^AI 开场/ })).toBeTruthy();
  });
});
