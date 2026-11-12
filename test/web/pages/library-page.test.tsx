import { QueryClient, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_LIST_IDS_MAX } from "../../../src/shared/defaults.ts";
import { collectionDetailDtoSchema } from "../../../src/shared/dto/collection.ts";
import { useEffect } from "react";
import { useApi, useTaskHub } from "../../../src/web/api/context.tsx";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { Cover, LibraryPage } from "../../../src/web/pages/library-page.tsx";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { collectionDetail, stageRun, task } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const SEGMENT = "01JABCDEFGHJKMNPQRSTVWXYZ3";

const content = {
  id: "c1",
  source: { kind: "youtube" },
  title: "第一讲 检索增强",
  durationMs: 75_000,
  processingStatus: "succeeded",
  collections: [{ id: "k1", name: "生成式软件工程", itemId: "ki1" }],
  createdAt: 0,
  updatedAt: 0,
};

/** Keeps a collection's lecture list mounted, as the left column does while it is expanded. */
function CollectionProbe() {
  const api = useApi();
  useQuery({ queryKey: queryKeys.collection("k1"), queryFn: () => api.get("/api/collections/k1", collectionDetailDtoSchema) });
  return null;
}

function routes() {
  return mockApi({
    "GET /api/contents": { body: { items: [content], total: 1 } },
    "GET /api/collections": { body: { items: [{ id: "k1", name: "生成式软件工程", itemCount: 1, createdAt: 0, updatedAt: 0 }] } },
    "GET /api/tasks/events": { body: {} },
  });
}

describe("LibraryPage", () => {
  it("opens a row's notes from the 笔记 button right of 删除", async () => {
    routes();
    renderApp(
      <Routes>
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/notes" element={<Where />} />
      </Routes>,
      { route: "/library" },
    );
    const row = await screen.findByTestId("library-row");
    fireEvent.click(within(row).getByRole("button", { name: "笔记" }));
    expect((await screen.findByTestId("where")).textContent).toBe("/notes?contentId=c1");
  });

  it("passes URL filters to the API and writes changed filters back", async () => {
    const api = routes();
    renderApp(<LibraryPage />, { route: "/library?importBatchId=b1", path: "/library" });
    expect(await screen.findByText("第一讲 检索增强")).toBeTruthy();
    expect(api.calls.some((call) => call.path.startsWith("/api/contents?") && call.path.includes("importBatchId=b1"))).toBe(true);

    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "failed" } });
    await waitFor(() =>
      expect(api.calls.some((call) => call.path.includes("importBatchId=b1") && call.path.includes("status=failed"))).toBe(true),
    );

    fireEvent.click(screen.getByText("显示全部"));
    await waitFor(() =>
      expect(api.calls.at(-1)?.path.includes("importBatchId")).toBe(false),
    );

    // 「未加入合集」 is a choice of the collection filter and sent as the API's flag.
    fireEvent.change(screen.getByLabelText("合集"), { target: { value: "-uncollected" } });
    await waitFor(() => expect(api.calls.at(-1)?.path).toContain("uncollected=1"));
    expect(api.calls.at(-1)?.path.includes("collectionId")).toBe(false);
  });

  it("marks pinned Contents and renames one from its row", async () => {
    const api = mockApi({
      "GET /api/contents": { body: { items: [{ ...content, pinnedAt: 5 }], total: 1 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "GET /api/contents/c1": { body: { ...content, pinnedAt: 5, media: [] } },
      "PATCH /api/contents/c1": { body: { ...content, title: "我的第一讲", customTitle: "我的第一讲", pinnedAt: 5 } },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    expect(await screen.findByTestId("library-pinned")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const input = await screen.findByLabelText("标题");
    fireEvent.change(input, { target: { value: "  我的第一讲 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ title: "我的第一讲" }));
  });

  it("pins and unpins from the row, the pin button always as wide as its wider label", async () => {
    const pinnedItem = { ...content, id: "c2", title: "第二讲 操作系统", collections: [], pinnedAt: 5 };
    const api = mockApi({
      "GET /api/contents": { body: { items: [pinnedItem, content], total: 2 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "PATCH /api/contents/c1": { body: { ...content, pinnedAt: 9 } },
      "PATCH /api/contents/c2": { body: { ...pinnedItem, pinnedAt: undefined } },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("第一讲 检索增强");
    const [pinnedRow, plainRow] = screen.getAllByTestId("library-row") as [HTMLElement, HTMLElement];
    expect(within(pinnedRow).queryByRole("button", { name: "置顶" })).toBeNull();
    expect(within(plainRow).queryByRole("button", { name: "取消置顶" })).toBeNull();
    const unpin = within(pinnedRow).getByRole("button", { name: "取消置顶" });
    const pin = within(plainRow).getByRole("button", { name: "置顶" });

    // Both buttons hold both labels in one grid cell, the inactive one invisible, so they share a width.
    for (const [button, hidden] of [
      [unpin, "置顶"],
      [pin, "取消置顶"],
    ] as const) {
      const labels = [...button.querySelectorAll(".grid > span")];
      expect(labels.map((label) => label.textContent)).toEqual(["置顶", "取消置顶"]);
      const inactive = labels.find((label) => label.getAttribute("aria-hidden") === "true");
      expect(inactive?.textContent).toBe(hidden);
      expect(inactive?.className.split(" ")).toContain("invisible");
      expect(labels.every((label) => label.className.split(" ").includes("[grid-area:1/1]"))).toBe(true);
    }
    const classes = (row: HTMLElement): string[] => within(row).getAllByRole("button").map((button) => button.className);
    expect(classes(pinnedRow)).toEqual(classes(plainRow));

    fireEvent.click(unpin);
    await waitFor(() => expect(api.calls.find((call) => call.method === "PATCH" && call.path === "/api/contents/c2")?.body).toEqual({ pinned: false }));
    fireEvent.click(pin);
    await waitFor(() => expect(api.calls.find((call) => call.method === "PATCH" && call.path === "/api/contents/c1")?.body).toEqual({ pinned: true }));
  });

  it("labels the actions column and deletes a row after confirmation, refreshing collection lecture lists", async () => {
    const api = mockApi({
      "GET /api/contents": { body: { items: [content], total: 1 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "GET /api/collections/k1": { body: collectionDetail("k1", "生成式软件工程", ["c1"]) },
      "DELETE /api/contents/c1": { status: 204 },
    });
    const lectureReads = () => api.calls.filter((call) => call.path === "/api/collections/k1").length;
    renderApp(
      <>
        <LibraryPage />
        <CollectionProbe />
      </>,
      { route: "/library", path: "/library" },
    );
    await screen.findByText("第一讲 检索增强");
    await waitFor(() => expect(lectureReads()).toBe(1));
    expect(screen.getByRole("columnheader", { name: "操作" }).className).not.toContain("sr-only");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除这条内容？" });
    expect(dialog.textContent).toContain("第一讲 检索增强");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/api/contents/c1")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Lecture lists that showed the deleted content are read again.
    await waitFor(() => expect(lectureReads()).toBe(2));
  });

  it("keeps the dialog open with the reason when unfinished tasks block the deletion", async () => {
    const reason = "这条内容还有未结束的任务（排队中、处理中或等待中）。请先在左下角「任务」里取消它，再删除";
    mockApi({
      "GET /api/contents": { body: { items: [content], total: 1 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "DELETE /api/contents/c1": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.tasks_unfinished", retryDisposition: "never", userMessage: reason } },
      },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("第一讲 检索增强");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除这条内容？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(await within(dialog).findByText(reason)).toBeTruthy();
    expect(screen.getAllByTestId("library-row")).toHaveLength(1);
  });

  it("shares the width out in proportion, folds columns on narrow lists and opens collection management from the row", async () => {
    mockApi({
      "GET /api/contents": { body: { items: [content], total: 1 } },
      "GET /api/contents/c1": { body: { ...content, media: [] } },
      "GET /api/collections": { body: { items: [{ id: "k1", name: "生成式软件工程", itemCount: 1, createdAt: 0, updatedAt: 0 }] } },
      "GET /api/tasks/events": { body: {} },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("第一讲 检索增强");
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["封面", "标题", "来源", "时长", "状态", "归属合集", "更新时间", "操作"]);
    const header = (name: string): string[] => screen.getByRole("columnheader", { name }).className.split(" ");
    // Wide lists share the width out in proportion instead of giving it all to the title.
    expect(header("标题")).toEqual(expect.arrayContaining(["w-full", "@3xl:w-[45%]", "@5xl:w-[30%]"]));
    expect(header("归属合集")).toEqual(expect.arrayContaining(["@3xl:w-[30%]", "@5xl:w-[18%]"]));
    expect(header("操作")).toEqual(expect.arrayContaining(["w-px", "text-center", "pr-6", "@5xl:pr-10"]));
    expect(header("封面")).toEqual(expect.arrayContaining(["pl-6", "@5xl:pl-10"]));
    // Narrower lists fold source, duration and update time first, then hide cover and collections.
    for (const name of ["来源", "时长", "更新时间"]) {
      expect(header(name), name).toEqual(expect.arrayContaining(["hidden", "@5xl:table-cell"]));
    }
    for (const name of ["封面", "归属合集"]) {
      expect(header(name), name).toEqual(expect.arrayContaining(["hidden", "@3xl:table-cell"]));
    }
    expect(screen.getByRole("table").parentElement?.className.split(" ")).toContain("@container");
    const meta = screen.getByTestId("library-row-meta");
    expect(meta.className.split(" ")).toContain("@5xl:hidden");
    expect(meta.textContent).toMatch(/^YouTube · 1:15 · \S/u);
    const row = screen.getByTestId("library-row");
    // Accessible names, in order: the pin button's hidden alternative label is not part of its name.
    const actions = within(row).getAllByRole("button");
    const names = ["重命名", "置顶", "合集", "删除", "笔记"];
    expect(names.map((name) => actions.indexOf(within(row).getByRole("button", { name })))).toEqual([0, 1, 2, 3, 4]);
    expect(actions).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "合集" }));
    const dialog = await screen.findByRole("dialog", { name: "管理合集" });
    await waitFor(() => expect((within(dialog).getByRole("checkbox", { name: "生成式软件工程" }) as HTMLInputElement).checked).toBe(true));
  });

  it("shows collection chips, duration and links", async () => {
    routes();
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    expect(await screen.findByText("1:15")).toBeTruthy();
    expect(screen.getByRole("link", { name: "生成式软件工程" }).getAttribute("href")).toBe("/collections/k1");
  });

  it("searches with scope=library, lists only hit Contents with an excerpt and restores the list when cleared", async () => {
    const other = { ...content, id: "c2", title: "第二讲 操作系统", collections: [] };
    const api = mockApi({
      "GET /api/contents": { body: { items: [content, other], total: 2 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "GET /api/search": {
        body: {
          contents: [],
          segments: [
            {
              contentId: "c2",
              contentTitle: "第二讲 操作系统",
              transcriptRevisionId: "r2",
              segmentId: SEGMENT,
              startMs: 75_000,
              snippet: "进程调度靠时间片",
              ranges: [{ start: 0, end: 4 }],
            },
          ],
          summaries: [],
          collections: [],
        },
      },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    expect(await screen.findByText("第一讲 检索增强")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "进程调度" } });
    const snippet = await screen.findByTestId("search-snippet");
    expect(screen.queryByText("第一讲 检索增强")).toBeNull();
    expect(screen.getAllByTestId("library-row")).toHaveLength(1);
    expect(snippet.querySelector("mark")?.textContent).toBe("进程调度");
    expect(snippet.getAttribute("href")).toBe(`/contents/c2?tab=transcript&revision=r2&segment=${SEGMENT}&search=${encodeURIComponent("进程调度")}`);
    const search = new URL(api.calls.find((call) => call.path.startsWith("/api/search"))?.path ?? "", "http://x");
    expect(search.searchParams.get("scope")).toBe("library");

    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "" } });
    expect(await screen.findByText("第一讲 检索增强")).toBeTruthy();
    expect(screen.queryByTestId("search-snippet")).toBeNull();
  });

  it("opens a row's right-click menu with the Content's actions and keeps the row buttons", async () => {
    const platform = { ...content, source: { kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } };
    mockApi({
      "GET /api/contents": { body: { items: [platform], total: 1 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <LibraryPage />
      </ContextMenuHost>,
      { route: "/library", path: "/library" },
    );
    const row = (await screen.findByText("第一讲 检索增强")).closest("tr") as HTMLElement;
    rightClick(within(row).getByText("1:15"));
    expect(contextLabels()).toEqual(["打开", "在新标签页中打开", "复制来源链接", "重命名", "置顶", "删除", "合集归属"]);
    // Menu rows share one colour; only the confirmation dialog warns.
    expect(screen.getAllByRole("menuitem").filter((item) => item.className.includes("text-danger"))).toEqual([]);
    expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual(["重命名", "置顶取消置顶", "合集", "删除", "笔记"]);
    fireEvent.click(screen.getByTestId("context-menu-item-delete"));
    expect((await screen.findByRole("dialog", { name: "删除这条内容？" })).textContent).toContain("第一讲 检索增强");
  });

  it("opens the excerpt's sentence from a search result row, the same place as a new tab", async () => {
    const other = { ...content, id: "c2", title: "第二讲 操作系统", collections: [] };
    mockApi({
      "GET /api/contents": { body: { items: [content, other], total: 2 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "GET /api/search": {
        body: {
          contents: [],
          segments: [
            { contentId: "c2", contentTitle: "第二讲 操作系统", transcriptRevisionId: "r2", segmentId: SEGMENT, startMs: 75_000, snippet: "进程调度靠时间片", ranges: [{ start: 0, end: 4 }] },
          ],
          summaries: [],
          collections: [],
        },
      },
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <LibraryPage />
        <Where />
      </ContextMenuHost>,
      { route: "/library" },
    );
    await screen.findByText("第一讲 检索增强");
    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "进程调度" } });
    const snippet = await screen.findByTestId("search-snippet");
    const deep = snippet.getAttribute("href") ?? "";
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    rightClick(snippet);
    expect(contextLabels()).toEqual(["在新标签页中打开", "复制链接地址", "打开", "重命名", "置顶", "删除", "合集归属"]);
    fireEvent.click(screen.getByTestId("context-menu-item-open-new-tab"));
    expect(open).toHaveBeenCalledWith(`${window.location.origin}${deep}`, "_blank", "noopener");
    open.mockRestore();
    rightClick(snippet);
    fireEvent.click(screen.getByTestId("context-menu-item-open"));
    expect(screen.getByTestId("where").textContent).toBe(deep);
  });

  it("reads the list again on task events only, not on stage or unit events", async () => {
    const api = routes();
    const stream = taskStream();
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const seen: string[] = [];
    renderApp(
      <>
        <LibraryPage />
        <EventProbe seen={seen} />
      </>,
      { route: "/library", path: "/library" },
    );
    const listReads = () => api.calls.filter((call) => call.path.startsWith("/api/contents?")).length;
    await waitFor(() => expect(listReads()).toBe(1));
    await waitFor(() => expect(stream.opened()).toBe(true));

    stream.frame("stage.updated", { stageRun: stageRun("t1", "asr", "running", { progress: 0.5 }) });
    stream.frame("workunit.updated", { workUnit: { id: "w1", stageRunId: "t1-asr-1", key: "chunk-0", status: "succeeded", attempt: 1, retryCount: 0 } });
    // Listeners run synchronously per frame, so once the probe saw both the page has handled them.
    await waitFor(() => expect(seen).toEqual(["stage.updated", "workunit.updated"]));
    expect(invalidate).not.toHaveBeenCalled();
    expect(listReads()).toBe(1);

    stream.frame("task.updated", { task: task("t1", { statusProjection: "queued" }) });
    await waitFor(() => expect(listReads()).toBe(2));
    stream.frame("task.finished", { task: task("t1", { statusProjection: "succeeded", finishedAt: 2 }) });
    await waitFor(() => expect(listReads()).toBe(3));
  });

  it("says so when the search finds nothing", async () => {
    mockApi({
      "GET /api/contents": { body: { items: [content], total: 1 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "GET /api/search": { body: { contents: [], segments: [], summaries: [], collections: [] } },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("第一讲 检索增强");
    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "不存在" } });
    expect(await screen.findByText("没有找到相关内容")).toBeTruthy();
  });
});

describe("LibraryPage pages", () => {
  beforeEach(() => localStorage.clear());

  it("asks for the first page of ten rows and shows the pager under the list", async () => {
    const api = stubApi({ total: 25 });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await waitFor(() => expect(screen.getAllByTestId("library-row")).toHaveLength(10));
    expect(api.contentReads()).toEqual(["?limit=10&page=1"]);
    const pager = screen.getByRole("navigation", { name: "分页" });
    expect(pager.textContent).toContain("共 25 条");
    expect(within(pager).getByText("第 1 / 3 页").getAttribute("aria-current")).toBe("page");
    // A fixed footer after the scrolling list, not inside it.
    expect(pager.className.split(" ")).toEqual(expect.arrayContaining(["border-t", "border-line", "px-6", "py-3"]));
    expect(screen.getByRole("table").parentElement?.contains(pager)).toBe(false);
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("reads page and page size from the URL", async () => {
    const api = stubApi({ total: 45 });
    renderApp(<LibraryPage />, { route: "/library?page=2&pageSize=20", path: "/library" });
    expect(await screen.findByText("讲次 21")).toBeTruthy();
    expect(screen.getAllByTestId("library-row")).toHaveLength(20);
    expect(api.contentReads()).toEqual(["?limit=20&page=2"]);
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
  });

  it("turns to the next page through the URL and asks for that page", async () => {
    const api = stubApi({ total: 25 });
    renderApp(
      <>
        <LibraryPage />
        <Where />
      </>,
      { route: "/library" },
    );
    await screen.findByText("讲次 1");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("讲次 11")).toBeTruthy();
    expect(screen.queryByText("讲次 1")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/library?page=2&pageSize=10");
    expect(api.contentReads()).toEqual(["?limit=10&page=1", "?limit=10&page=2"]);
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
  });

  it("moves a page past the end to the last page once the total is known", async () => {
    const api = stubApi({ total: 25 });
    renderApp(
      <>
        <LibraryPage />
        <Where />
      </>,
      { route: "/library?page=9&pageSize=10" },
    );
    expect(await screen.findByText("讲次 21")).toBeTruthy();
    expect(screen.getAllByTestId("library-row")).toHaveLength(5);
    expect(api.contentReads()).toEqual(["?limit=10&page=9", "?limit=10&page=3"]);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/library?page=3&pageSize=10"));
  });

  it("never shows the empty state while a page past the end moves to the last page", async () => {
    stubApi({ total: 25 });
    // The empty answer of page 9 renders for one commit before the URL moves; watch every commit.
    let sawEmpty = false;
    const observer = new MutationObserver(() => {
      if (/还没有内容|没有符合筛选条件的内容/.test(document.body.textContent ?? "")) sawEmpty = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    renderApp(<LibraryPage />, { route: "/library?page=9&pageSize=10", path: "/library" });
    expect(await screen.findByText("讲次 21")).toBeTruthy();
    observer.disconnect();
    expect(sawEmpty).toBe(false);
  });

  it("shows loading, not the previous page's rows, while the next page is on its way", async () => {
    const api = stubApi({ total: 25, held: (url) => url.searchParams.get("page") === "2" });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("讲次 1");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryAllByTestId("library-row")).toHaveLength(0);
    // The pager stays, already on the page asked for.
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
    api.release();
    expect(await screen.findByText("讲次 11")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the error when a page cannot be read", async () => {
    stubApi({ total: 25, failed: (url) => url.searchParams.get("page") === "2" });
    renderApp(<LibraryPage />, { route: "/library?page=2&pageSize=10", path: "/library" });
    expect((await screen.findByRole("alert")).textContent).toContain("列表读取失败");
    expect(screen.queryAllByTestId("library-row")).toHaveLength(0);
  });

  it("cancels a page's request when the next page is asked for before it answered", async () => {
    const api = stubApi({ total: 35, held: (url) => url.searchParams.get("page") === "2" });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("讲次 1");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(api.contentReads()).toContain("?limit=10&page=2"));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("讲次 21")).toBeTruthy();
    const second = api.calls.find((call) => call.url.search === "?limit=10&page=2");
    expect(second?.signal?.aborted).toBe(true);
    expect(api.calls.find((call) => call.url.search === "?limit=10&page=3")?.signal?.aborted).toBe(false);
  });

  it("reads only the hit Contents while searching, by id, in relevance order and unpaged", async () => {
    const api = stubApi({
      total: 25,
      search: () =>
        searchResult({
          contents: [contentHit("c03")],
          segments: [segmentHit("c01"), segmentHit("c03")],
          summaries: [{ contentId: "c01", artifactId: "a1", templateId: "t1", summaryRevisionId: "sr1", snippet: "总结", ranges: [] }],
        }),
    });
    renderApp(<LibraryPage />, { route: "/library?status=succeeded", path: "/library" });
    await screen.findByText("讲次 1");
    const listReads = api.contentReads().length;
    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "讲次" } });
    await waitFor(() => expect(screen.getAllByTestId("library-row").map((row) => row.dataset["contentId"])).toEqual(["c03", "c01"]));
    expect(screen.queryByRole("navigation", { name: "分页" })).toBeNull();
    const reads = api.contentReads().slice(listReads);
    expect(reads).toHaveLength(1);
    const hitRead = new URLSearchParams(reads[0]);
    expect(hitRead.get("ids")).toBe("c03,c01");
    expect(hitRead.get("page")).toBe("1");
    expect(hitRead.get("limit")).toBe("2");
    // The filters keep applying.
    expect(hitRead.get("status")).toBe("succeeded");

    // Another filter while searching reads the hits again under it, never a page of the list.
    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "" } });
    await waitFor(() => expect(api.contentReads().slice(listReads)).toHaveLength(2));
    expect(api.contentReads().at(-1)).toBe("?ids=c03%2Cc01&page=1&limit=2");
    expect(api.contentReads().some((read) => read.includes("limit=1000"))).toBe(false);
  });

  it("names at most CONTENT_LIST_IDS_MAX hit Contents", async () => {
    const api = stubApi({
      total: 0,
      search: () => searchResult({ contents: Array.from({ length: CONTENT_LIST_IDS_MAX + 5 }, (_, index) => contentHit(`h${index}`)) }),
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("还没有内容");
    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "讲次" } });
    await waitFor(() => expect(api.contentReads().some((read) => read.includes("ids="))).toBe(true));
    const hitRead = new URLSearchParams(api.contentReads().find((read) => read.includes("ids=")));
    expect(hitRead.get("ids")?.split(",")).toHaveLength(CONTENT_LIST_IDS_MAX);
    expect(hitRead.get("limit")).toBe(String(CONTENT_LIST_IDS_MAX));
  });

  it("sends no id request for no hits, nor for the previous search's hits while a new one runs", async () => {
    let answer = searchResult({ segments: [segmentHit("c02")] });
    const api = stubApi({ total: 25, search: () => answer, held: (url) => url.pathname === "/api/search" && url.searchParams.get("q") === "第二次" });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("讲次 1");
    const search = screen.getByLabelText("搜索标题、字幕与总结");
    fireEvent.change(search, { target: { value: "第一次" } });
    await waitFor(() => expect(screen.getAllByTestId("library-row").map((row) => row.dataset["contentId"])).toEqual(["c02"]));
    const idReads = () => api.contentReads().filter((read) => read.includes("ids="));
    expect(idReads()).toHaveLength(1);

    // Back to the list under another filter, then a new search: until it answers, the previous
    // search's hits stand in; they are not read again under the new filter.
    fireEvent.change(search, { target: { value: "" } });
    await screen.findByText("讲次 1");
    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "succeeded" } });
    await waitFor(() => expect(api.contentReads().at(-1)).toBe("?status=succeeded&limit=10&page=1"));
    const listReads = api.contentReads().length;
    answer = searchResult({ segments: [segmentHit("c05")] });
    fireEvent.change(search, { target: { value: "第二次" } });
    await waitFor(() => expect(api.calls.some((call) => call.url.searchParams.get("q") === "第二次")).toBe(true));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryAllByTestId("library-row")).toHaveLength(0);
    expect(api.contentReads().slice(listReads)).toEqual([]);
    api.release();
    await waitFor(() => expect(screen.getAllByTestId("library-row").map((row) => row.dataset["contentId"])).toEqual(["c05"]));
    expect(api.contentReads().slice(listReads)).toEqual(["?status=succeeded&ids=c05&page=1&limit=1"]);

    // No hits: nothing to read.
    answer = searchResult({});
    fireEvent.change(search, { target: { value: "第三次" } });
    expect(await screen.findByText("没有找到相关内容")).toBeTruthy();
    expect(api.contentReads()).toHaveLength(listReads + 1);
  });
});

describe("Cover", () => {
  it("asks for a plain-http cover over https without a Referer", () => {
    const { container } = render(<Cover url="http://i1.hdslb.com/cover.jpg" />);
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://i1.hdslb.com/cover.jpg");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image?.className).toContain("max-w-none");
  });

  it("falls back to the placeholder when the image fails to load", () => {
    const { container } = render(<Cover url="https://i1.hdslb.com/cover.jpg" />);
    expect(screen.queryByTestId("cover-placeholder")).toBeNull();
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("cover-placeholder")).toBeTruthy();
  });
});

function rightClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
}

/** Rows of the open right-click menu, separators left out. */
function contextLabels(): (string | null)[] {
  return within(screen.getByTestId("context-menu")).getAllByRole("menuitem").map((item) => item.textContent);
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

/** Records the type of every task event the hub delivers. */
function EventProbe(props: { seen: string[] }) {
  const hub = useTaskHub();
  useEffect(() => hub.onEvent((event) => void props.seen.push(event.type)), [hub, props.seen]);
  return null;
}

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

/** Content `c01` … `c<total>` titled 讲次 1 …, in listing order. */
function lecture(n: number) {
  return { id: `c${String(n).padStart(2, "0")}`, source: { kind: "local" }, title: `讲次 ${n}`, processingStatus: "succeeded", collections: [], createdAt: 0, updatedAt: 0 };
}

function contentHit(contentId: string) {
  return { contentId, title: contentId, matchedIn: "title", snippet: contentId, ranges: [] };
}

function segmentHit(contentId: string) {
  return { contentId, transcriptRevisionId: "r1", segmentId: SEGMENT, startMs: 0, snippet: "片段", ranges: [] };
}

function searchResult(groups: { contents?: object[]; segments?: object[]; summaries?: object[] }) {
  return { contents: [], segments: [], summaries: [], collections: [], ...groups };
}

/**
 * A library of `total` Contents served page by page (`page` + `limit`, or `ids`), recording
 * each request with its abort signal. Requests `held` picks wait for `release()`; aborting
 * one rejects it as the browser would.
 */
function stubApi(options: { total: number; search?: () => object; held?: (url: URL) => boolean; failed?: (url: URL) => boolean }) {
  const library = Array.from({ length: options.total }, (_, index) => lecture(index + 1));
  const calls: Array<{ url: URL; signal: AbortSignal | undefined }> = [];
  const waiting: Array<() => void> = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://amber.test");
    const signal = init.signal ?? undefined;
    calls.push({ url, signal });
    if (url.pathname === "/api/tasks/events") {
      return new Response(new ReadableStream({ start: () => undefined }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (options.held?.(url) === true) {
      await new Promise<void>((resolve, reject) => {
        waiting.push(resolve);
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (options.failed?.(url) === true) {
      return reply(500, { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "列表读取失败" } });
    }
    if (url.pathname === "/api/collections") return reply(200, { items: [] });
    if (url.pathname === "/api/search") return reply(200, options.search?.() ?? searchResult({}));
    if (url.pathname === "/api/contents") {
      const ids = url.searchParams.get("ids")?.split(",");
      const rows = ids === undefined ? library : library.filter((item) => ids.includes(item.id));
      const limit = Number(url.searchParams.get("limit"));
      const page = Number(url.searchParams.get("page"));
      return reply(200, { items: rows.slice((page - 1) * limit, page * limit), total: rows.length });
    }
    return reply(404, { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } });
  });
  return {
    calls,
    release: () => waiting.splice(0).forEach((resolve) => resolve()),
    /** Query strings of the `GET /api/contents` requests, in order. */
    contentReads: () => calls.filter((call) => call.url.pathname === "/api/contents").map((call) => call.url.search),
  };
}

describe("LibraryPage search with speakers", () => {
  const SPEAKER_HIT = { contentId: "c1", contentTitle: "第一讲 检索增强", speakerId: "sp7", ordinal: 2, name: "陈明", colorIndex: 1, sentences: 12 };

  it("lists name matches as their own group, opening the reading view filtered to the speaker", async () => {
    mockApi({
      "GET /api/contents": { body: { items: [content], total: 1 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "GET /api/search": { body: { contents: [], segments: [], summaries: [], collections: [], speakers: [SPEAKER_HIT] } },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("第一讲 检索增强");
    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "陈明" } });
    const group = await screen.findByRole("region", { name: "发言人（姓名匹配）" });
    const link = within(group).getByTestId("speaker-hit");
    expect(link.getAttribute("href")).toBe("/contents/c1?tab=transcript&speaker=sp7");
    expect(link.textContent).toContain("第一讲 检索增强 · 12 句");
    // Only a name matched: no empty state, no Content rows.
    expect(screen.queryByText("没有找到相关内容")).toBeNull();
    expect(screen.queryAllByTestId("library-row")).toHaveLength(0);
  });

  it("names the speaker of a sentence hit, marks an unreviewed one, and flags a summary whose speaker basis changed", async () => {
    const other = { ...content, id: "c2", title: "第二讲 操作系统", collections: [] };
    mockApi({
      "GET /api/contents": { body: { items: [content, other], total: 2 } },
      "GET /api/collections": { body: { items: [] } },
      "GET /api/tasks/events": { body: {} },
      "GET /api/search": {
        body: {
          contents: [],
          segments: [
            {
              contentId: "c2",
              contentTitle: "第二讲 操作系统",
              transcriptRevisionId: "r2",
              segmentId: SEGMENT,
              startMs: 75_000,
              snippet: "进程调度靠时间片",
              ranges: [{ start: 0, end: 4 }],
              speaker: { id: "sp1", ordinal: 1, name: "李华", colorIndex: 0, confirmed: false },
            },
          ],
          summaries: [
            { contentId: "c1", contentTitle: "第一讲 检索增强", artifactId: "a1", templateId: "summary.core", summaryRevisionId: "sr1", snippet: "进程调度概述", ranges: [], speakerContextState: "names_changed" },
          ],
          collections: [],
          speakers: [SPEAKER_HIT],
        },
      },
    });
    renderApp(<LibraryPage />, { route: "/library", path: "/library" });
    await screen.findByText("第一讲 检索增强");
    fireEvent.change(screen.getByLabelText("搜索标题、字幕与总结"), { target: { value: "进程调度" } });
    await waitFor(() => expect(screen.getAllByTestId("search-snippet")).toHaveLength(2));
    const speaker = screen.getByTestId("hit-speaker");
    expect(speaker.getAttribute("data-confirmed")).toBe("false");
    expect(speaker.lastElementChild?.textContent).toBe("李华未核对");
    expect(screen.getByTestId("hit-basis-changed").textContent).toBe("人物依据已变化");
    expect(screen.getByTestId("speaker-hits")).toBeTruthy();
    expect(screen.getAllByTestId("library-row")).toHaveLength(2);
  });
});
