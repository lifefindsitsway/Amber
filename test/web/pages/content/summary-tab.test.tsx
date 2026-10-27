import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX, PARAGRAPH_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import type { ContentSummariesDto } from "../../../../src/shared/dto/summary.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { statusOf } from "../../../../src/web/pages/content/summary-tab.tsx";
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
    const section = await screen.findByTestId("chapter-section");
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
  it("disables regeneration while a Task works on chapters", async () => {
    const routes = contentRoutes();
    const chapters = routes["GET /api/contents/c1/chapters"]?.body as Record<string, unknown>;
    mockApi({
      ...routes,
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/chapters": { body: { ...chapters, activeTaskId: "t5" } },
      "GET /api/tasks/t5": { body: taskDetail("t5", [stageRun("t5", "chapter", "running")], { kind: "regenerate_chapters", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    const button = (await within(section).findByTestId("chapters-regenerate")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("正在重新生成…");
    // The Task's progress shows under the title, so waiting is never silent.
    expect(await within(section).findByTestId("task-flow")).toBeTruthy();
  });
  it("points to model configuration instead of regenerating without a model", async () => {
    mockApi({ ...contentRoutes(), "GET /api/providers": { body: { items: [] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const section = await screen.findByTestId("chapter-section");
    expect((await within(section).findByTestId("chapters-configure")).getAttribute("href")).toBe("/settings/models");
    expect(within(section).queryByTestId("chapters-regenerate")).toBeNull();
  });
  it("offers no regeneration without chapters", async () => {
    mockApi({ ...contentRoutes(), "GET /api/contents/c1/chapters": { body: { revisions: [] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    await screen.findByTestId("summary-body");
    expect(screen.queryByTestId("chapter-section")).toBeNull();
    expect(screen.queryByTestId("chapters-regenerate")).toBeNull();
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
    const badge = await within(body).findByRole("button", { name: "1:15" });
    const before = badge.previousSibling as Text;
    const after = badge.nextSibling as Text;
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
