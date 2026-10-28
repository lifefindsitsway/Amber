import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useTaskHub } from "../../../src/web/api/context.tsx";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { CollectionPage } from "../../../src/web/pages/collection-page.tsx";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { collection, content, stageRun, taskDetail } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";

const item = (n: number) => ({
  id: `i${n}`,
  contentId: `c${n}`,
  position: n,
  addedAt: 0,
  title: `第${n}讲`,
  durationMs: 60_000 * n,
  processingStatus: "succeeded",
  source: { kind: "bilibili" },
  updatedAt: 0,
});
const detail = { id: "k1", name: "生成式软件工程", itemCount: 3, createdAt: 0, updatedAt: 0, items: [item(1), item(2), item(3)] };
const SEGMENT = "01J00000000000000000000SEG";
const NOT_FOUND = { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } };
/** A published summary of the first member, fresh. */
const PUBLISHED = {
  artifactId: "a1",
  stale: false,
  current: {
    id: "s1",
    artifactId: "a1",
    body: "合集的脉络",
    citations: [],
    inputItems: [{ collectionItemId: "i1", contentId: "c1", transcriptRevisionId: "r1", position: 0 }],
    partials: [],
    quality: "normal",
    qualityReasons: [],
    stale: false,
    createdAt: 0,
  },
};

/** A synthetic collection of `count` lectures in course order. */
const course = (count: number) => ({ ...detail, itemCount: count, items: Array.from({ length: count }, (_, index) => item(index + 1)) });
/** The detail as the server answers a saved order. */
const reordered = (base: typeof detail, itemIds: string[]) => ({ ...base, items: itemIds.map((id) => base.items.find((entry) => entry.id === id)) });
const rowIds = () => screen.getAllByTestId("collection-item").map((row) => row.dataset["itemId"]);
const lectureNumbers = () => screen.getAllByTestId("collection-item").map((row) => within(row).getByText(/^第 \d+ 项$/).textContent);

/** jsdom has no scrollIntoView; the stub records which element each call scrolled to. */
function stubScrollIntoView() {
  const scroll = vi.fn();
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  HTMLElement.prototype.scrollIntoView = scroll;
  onTestFinished(() => {
    if (original === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
  });
  return scroll;
}

function routes(extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}) {
  return mockApi({
    "GET /api/collections/k1": { body: detail },
    "GET /api/collections/k1/summary": { body: { stale: false } },
    "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 0 } },
    "GET /api/tasks/events": { body: {} },
    ...extra,
  });
}

function render() {
  return renderApp(<CollectionPage />, { route: "/collections/k1", path: "/collections/:id" });
}

function renderWithMenus() {
  return renderApp(
    <ContextMenuHost blockNative={false}>
      <CollectionPage />
    </ContextMenuHost>,
    { route: "/collections/k1", path: "/collections/:id" },
  );
}

/** Right-clicks and reports whether the browser menu was replaced. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

beforeEach(() => {
  localStorage.clear();
});

describe("CollectionPage", () => {
  it("pages 25 lectures by their course number, without drag handles", async () => {
    routes({ "GET /api/collections/k1": { body: course(25) } });
    const scrolled = stubScrollIntoView();
    render();
    await screen.findByText("第 1 项");
    expect(lectureNumbers()).toEqual(Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 项`));
    expect(screen.getByText("第 1 / 3 页").getAttribute("aria-current")).toBe("page");
    expect(screen.queryAllByRole("button", { name: /^拖动排序/ })).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(lectureNumbers()[0]).toBe("第 11 项"));
    expect(lectureNumbers()).toHaveLength(10);
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
    expect(scrolled.mock.contexts.at(-1)).toBe(screen.getByRole("heading", { name: "内容" }).closest("section"));
    // The pager is the page foot outside the scrolling column, as on every paged list.
    const pager = screen.getByRole("navigation", { name: "分页" });
    expect(pager.className).toContain("border-t border-line px-6 py-3");
    expect(screen.getByRole("heading", { name: "内容" }).closest(".overflow-auto")?.contains(pager)).toBe(false);
  });

  it("rearranges a draft of every lecture and saves it as one complete order", async () => {
    const api = routes({
      "GET /api/collections/k1": { body: course(25) },
      "PUT /api/collections/k1/items/order": (call: RecordedCall) => ({ body: reordered(course(25), (call.body as { itemIds: string[] }).itemIds) }),
    });
    const scrolled = stubScrollIntoView();
    render();
    fireEvent.click(await screen.findByRole("button", { name: "调整顺序" }));
    expect(screen.getAllByTestId("collection-item")).toHaveLength(25);
    expect(screen.getByText("拖动把手或用方向键移动内容，保存后生效")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "分页" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第1讲" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第1讲" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第25讲" }), { key: "ArrowUp" });
    const expected = ["i2", "i3", "i1", ...Array.from({ length: 20 }, (_, index) => `i${index + 4}`), "i25", "i24"];
    expect(rowIds()).toEqual(expected);
    expect(lectureNumbers().slice(0, 3)).toEqual(["第 1 项", "第 2 项", "第 3 项"]);
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
    scrolled.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存顺序" })).toBeNull());
    const puts = api.calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("/api/collections/k1/items/order");
    expect(puts[0]?.body).toEqual({ itemIds: expected });
    // Back to the paged view in the saved order, scrolled to the lectures.
    expect(rowIds()).toEqual(expected.slice(0, 10));
    expect(screen.queryAllByRole("button", { name: /^拖动排序/ })).toEqual([]);
    expect(screen.getByText("第 1 / 3 页")).toBeTruthy();
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
  });

  it("discards the draft on 「取消」 without a request", async () => {
    const api = routes({ "GET /api/collections/k1": { body: course(25) } });
    render();
    fireEvent.click(await screen.findByRole("button", { name: "调整顺序" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第1讲" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(rowIds()).toEqual(Array.from({ length: 10 }, (_, index) => `i${index + 1}`));
    expect(screen.queryByRole("button", { name: "保存顺序" })).toBeNull();
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("keeps the draft with the reason when saving fails", async () => {
    const api = routes({
      "GET /api/collections/k1": { body: course(25) },
      "PUT /api/collections/k1/items/order": { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "服务暂不可用" } } },
    });
    render();
    fireEvent.click(await screen.findByRole("button", { name: "调整顺序" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第1讲" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    expect(await screen.findByText("服务暂不可用")).toBeTruthy();
    expect(rowIds().slice(0, 2)).toEqual(["i2", "i1"]);
    expect(screen.getAllByTestId("collection-item")).toHaveLength(25);
    expect(screen.getByRole("button", { name: "保存顺序" })).toBeTruthy();
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("drops the draft and reads the lectures again when the collection changed meanwhile", async () => {
    let reads = 0;
    const api = routes({
      "GET /api/collections/k1": () => {
        reads += 1;
        return { body: course(reads === 1 ? 25 : 26) };
      },
      "PUT /api/collections/k1/items/order": {
        status: 400,
        body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "请求参数有误：itemIds" } },
      },
    });
    render();
    fireEvent.click(await screen.findByRole("button", { name: "调整顺序" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第1讲" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    expect((await screen.findByTestId("collection-order-changed")).textContent).toBe("合集内容已变化，请重新调整顺序");
    await waitFor(() => expect(screen.getByText("共 26 条")).toBeTruthy());
    expect(reads).toBe(2);
    expect(screen.queryByRole("button", { name: "保存顺序" })).toBeNull();
    expect(rowIds()).toEqual(Array.from({ length: 10 }, (_, index) => `i${index + 1}`));
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("reorders a short collection the same way, its single page still under a pager", async () => {
    const api = routes({
      "PUT /api/collections/k1/items/order": (call: RecordedCall) => ({ body: reordered(detail, (call.body as { itemIds: string[] }).itemIds) }),
    });
    render();
    await screen.findByText("第 1 项");
    expect(within(screen.getByRole("navigation", { name: "分页" })).getByText("第 1 / 1 页")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "调整顺序" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第1讲" }), { key: "ArrowDown" });
    expect(api.calls.filter((call) => call.method === "PUT")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    await waitFor(() => expect(rowIds()).toEqual(["i2", "i1", "i3"]));
    expect(api.calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([{ itemIds: ["i2", "i1", "i3"] }]);
    expect(screen.queryByRole("button", { name: /^拖动排序/ })).toBeNull();
  });

  it("offers no reordering for a single lecture", async () => {
    routes({ "GET /api/collections/k1": { body: course(1) } });
    render();
    await screen.findByText("第 1 项");
    expect(screen.queryByRole("button", { name: "调整顺序" })).toBeNull();
  });

  it("names the lectures that lack a core summary when summarizing is refused", async () => {
    const api = routes({
      "POST /api/collections/k1/summary": {
        status: 400,
        body: {
          error: {
            class: "invalid_request",
            code: "invalid_request.collection_summary_missing",
            retryDisposition: "never",
            userMessage: "部分内容尚无核心总结，请先生成",
            details: { missingContentIds: ["c2"] },
          },
        },
      },
    });
    render();
    fireEvent.click(await screen.findByRole("button", { name: "立即归纳" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const list = await screen.findByTestId("missing-summaries");
    expect(list.textContent).toBe("第 2 项 · 第2讲");
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.headers["idempotency-key"]).toBeTruthy();
  });

  it("says the summary is hidden while a summarised lecture is in the trash, instead of offering to generate one", async () => {
    routes({
      "GET /api/collections/k1/summary": { body: { artifactId: "a1", stale: true, staleReason: "member_changed", hiddenReason: "member_trashed" } },
    });
    render();
    const hidden = await screen.findByTestId("collection-summary-hidden");
    expect(hidden.textContent).toBe("有内容在回收站中，归纳暂不显示；恢复这些内容后会重新显示");
    const card = screen.getByTestId("collection-summary");
    expect(within(card).queryByText("合集成员或某项内容的总结已变化，归纳可能已过时")).toBeNull();
    // A withheld summary still exists: it can be summarised again or deleted, but not generated anew.
    expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual(["重新归纳", "删除归纳"]);
    expect(within(card).queryByText("还没有归纳总结")).toBeNull();
    expect(within(card).queryByRole("button", { name: "立即归纳" })).toBeNull();
  });

  it("never posts on its own and renders the published summary, once opened, with partials and stale notice", async () => {
    const api = routes({
      "GET /api/collections/k1/summary": {
        body: {
          artifactId: "a1",
          stale: true,
          staleReason: "order_changed",
          current: {
            id: "s1",
            artifactId: "a1",
            body: "整门课的脉络",
            citations: [],
            inputItems: [{ collectionItemId: "i1", contentId: "c1", transcriptRevisionId: "r1", position: 0 }],
            partials: [{ id: "p0", index: 0, body: "第一组", citations: [], createdAt: 0 }],
            quality: "normal",
            qualityReasons: [],
            stale: true,
            staleReason: "order_changed",
            createdAt: 0,
          },
        },
      },
    });
    render();
    expect(await screen.findByText("内容顺序已调整，归纳可能已过时")).toBeTruthy();
    expect(screen.queryByText("整门课的脉络")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "合集归纳" }));
    expect(screen.getByText("整门课的脉络")).toBeTruthy();
    expect(document.querySelector("[data-citation]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "分组归纳（1 组）" }));
    expect(await screen.findByText("第一组")).toBeTruthy();
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("lays the page out up to 1280px with the members in a table under a header", async () => {
    routes();
    render();
    await screen.findByText("第 1 项");
    const column = screen.getByRole("heading", { name: "内容" }).closest("section")?.parentElement;
    expect(column?.className).toContain("max-w-7xl");
    expect(column?.className).not.toContain("max-w-4xl");
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["序号", "封面", "标题", "来源", "时长", "状态", "更新时间"]);
    expect(within(screen.getAllByTestId("collection-item")[0] as HTMLElement).getAllByRole("cell")[3]?.textContent).toBe("B 站");
  });

  it("offers 「立即归纳」 only before there is a summary, then 「重新归纳」 and 「删除归纳」, both disabled while summarising", async () => {
    const api = routes({ "GET /api/collections/k1/summary": { body: PUBLISHED }, "POST /api/collections/k1/summary": { status: 202, body: { taskId: "t1" } } });
    render();
    const card = await screen.findByTestId("collection-summary");
    const actions = await within(card).findByTestId("collection-summary-actions");
    expect(within(actions).getAllByRole("button").map((button) => button.textContent)).toEqual(["重新归纳", "删除归纳"]);
    expect(within(card).queryByRole("button", { name: "立即归纳" })).toBeNull();
    fireEvent.click(within(actions).getByRole("button", { name: "重新归纳" }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === "POST" && call.path === "/api/collections/k1/summary")).toHaveLength(1));
  });

  it("disables both card actions while a summary Task is unfinished", async () => {
    routes({ "GET /api/collections/k1/summary": { body: { ...PUBLISHED, activeTaskId: "t1" } }, "GET /api/tasks/t1": { status: 404, body: NOT_FOUND } });
    render();
    const actions = await screen.findByTestId("collection-summary-actions");
    for (const button of within(actions).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("deletes the summary after a confirmation, then shows the empty card and re-reads summary histories", async () => {
    let deleted = false;
    const api = routes({
      "GET /api/collections/k1/summary": () => ({ body: deleted ? { stale: false } : PUBLISHED }),
      "DELETE /api/collections/k1/summary": () => {
        deleted = true;
        return { status: 204 };
      },
    });
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    onTestFinished(() => invalidate.mockRestore());
    render();
    fireEvent.click(await screen.findByRole("button", { name: "删除归纳" }));
    const dialog = await screen.findByRole("dialog", { name: "删除合集归纳？" });
    expect(dialog.textContent).toContain("将删除这个合集的全部归纳版本与分组归纳，不可恢复；各项内容自己的总结不受影响，被归纳引用而不能删除的总结版本将解除限制");
    expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除归纳" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/collections/k1/summary"]);
    const card = screen.getByTestId("collection-summary");
    expect(within(card).getByText("还没有归纳总结")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "立即归纳" })).toBeTruthy();
    expect(within(card).queryByTestId("collection-summary-actions")).toBeNull();
    expect(invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(["summary-revisions"]))).toBe(true);
  });

  it("searches within the collection and lists hit lectures by relevance with an excerpt", async () => {
    const api = routes({
      "GET /api/search": {
        body: {
          contents: [],
          segments: [
            { contentId: "c3", contentTitle: "第3讲", transcriptRevisionId: "r3", segmentId: SEGMENT, startMs: 5_000, snippet: "讲到重排序", ranges: [{ start: 2, end: 5 }] },
            { contentId: "c1", contentTitle: "第1讲", transcriptRevisionId: "r1", segmentId: SEGMENT, startMs: 0, snippet: "重排序开场", ranges: [{ start: 0, end: 3 }] },
          ],
          summaries: [],
          collections: [],
        },
      },
    });
    render();
    await screen.findByRole("button", { name: "调整顺序" });
    fireEvent.change(screen.getByLabelText("在本合集中搜索"), { target: { value: "重排序" } });
    const hits = await screen.findAllByTestId("collection-hit");
    expect(hits.map((hit) => within(hit).getByRole("link", { name: /^第\d讲$/ }).textContent)).toEqual(["第3讲", "第1讲"]);
    expect(within(hits[0] as HTMLElement).getByText("第 3 项")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "调整顺序" })).toBeNull();
    const search = new URL(api.calls.find((call) => call.path.startsWith("/api/search"))?.path ?? "", "http://x");
    expect(search.searchParams.get("scope")).toBe("k1");
  });

  it("exports the collection Markdown with back-links through the download", async () => {
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
    const api = routes({ "POST /api/collections/k1/export": { file: { filename: "生成式软件工程.md", text: "# 生成式软件工程\n" } } });
    render();
    fireEvent.keyDown(await screen.findByRole("button", { name: "更多操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("collection-export"));
    await waitFor(() => expect(saved).toEqual(["生成式软件工程.md"]));
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({ backlinks: true });
  });

  it("offers the collection's actions on its name, editing in place, and none while the edit card is open", async () => {
    routes();
    renderWithMenus();
    const name = await screen.findByTestId("collection-name");
    expect(rightClick(within(name).getByText("生成式软件工程"))).toBe(true);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["编辑", "批量添加", "重新归纳", "导出合集 Markdown", "删除合集"]);
    fireEvent.click(screen.getByTestId("context-menu-item-edit"));
    const card = await screen.findByTestId("collection-edit-card");
    const input = within(card).getByLabelText("合集名称") as HTMLInputElement;
    expect(input.value).toBe("生成式软件工程");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rightClick(within(name).getByText("生成式软件工程"))).toBe(false);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("shows the description with its line breaks and edits both fields from it", async () => {
    const api = routes({
      "GET /api/collections/k1": { body: { ...detail, description: "南大课程\n第二学期" } },
      "PATCH /api/collections/k1": { body: { ...detail, name: "软件工程" } },
    });
    render();
    const shown = await screen.findByTestId("collection-description");
    expect(shown.textContent).toBe("南大课程\n第二学期");
    expect(shown.className).toContain("whitespace-pre-wrap");
    fireEvent.click(shown);
    const card = await screen.findByTestId("collection-edit-card");
    const description = within(card).getByLabelText("说明（可选）") as HTMLTextAreaElement;
    expect(description.value).toBe("南大课程\n第二学期");
    expect(document.activeElement).toBe(description);
    fireEvent.change(within(card).getByLabelText("合集名称"), { target: { value: "软件工程" } });
    fireEvent.change(description, { target: { value: "" } });
    fireEvent.click(within(card).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByTestId("collection-edit-card")).toBeNull());
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ name: "软件工程", description: null });
    expect(await screen.findByTestId("collection-add-description")).toBeTruthy();
  });

  it("does not open the editor when a click ends a selection inside the description", async () => {
    routes({ "GET /api/collections/k1": { body: { ...detail, description: "南大课程" } } });
    render();
    const shown = await screen.findByTestId("collection-description");
    const range = document.createRange();
    range.selectNodeContents(shown);
    // addRange is ignored while another range is selected.
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.click(shown);
    expect(screen.queryByTestId("collection-edit-card")).toBeNull();
    window.getSelection()?.removeAllRanges();
  });

  it("adds a description from the pencil or the add entry; Escape cancels without a request", async () => {
    const api = routes();
    render();
    fireEvent.click(await screen.findByTestId("collection-add-description"));
    const card = await screen.findByTestId("collection-edit-card");
    const description = within(card).getByLabelText("说明（可选）");
    expect(document.activeElement).toBe(description);
    fireEvent.change(description, { target: { value: "草稿" } });
    fireEvent.keyDown(description, { key: "Escape" });
    expect(screen.queryByTestId("collection-edit-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(document.activeElement).toBe(within(await screen.findByTestId("collection-edit-card")).getByLabelText("合集名称"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByTestId("collection-edit-card")).toBeNull();
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("keeps the edit card open with the reason when saving fails", async () => {
    routes({ "PATCH /api/collections/k1": { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "合集不存在" } } } });
    render();
    fireEvent.click(await screen.findByTestId("collection-add-description"));
    const card = await screen.findByTestId("collection-edit-card");
    fireEvent.change(within(card).getByLabelText("说明（可选）"), { target: { value: "说明" } });
    fireEvent.click(within(card).getByRole("button", { name: "保存" }));
    expect(await within(card).findByText("合集不存在")).toBeTruthy();
    expect(screen.getByTestId("collection-edit-card")).toBeTruthy();
  });

  it("keeps delete and export in the header 「⋯」", async () => {
    routes();
    render();
    fireEvent.keyDown(await screen.findByRole("button", { name: "更多操作" }), { key: "Enter" });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["删除合集", "导出合集 Markdown"]);
  });

  it("reads the lectures and summary again on task events only, and content lists once a task finishes", async () => {
    const api = routes();
    const stream = taskStream();
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const invalidated = (key: readonly unknown[]) => invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(key));
    const seen: string[] = [];
    renderApp(
      <>
        <CollectionPage />
        <EventProbe seen={seen} />
      </>,
      { route: "/collections/k1", path: "/collections/:id" },
    );
    const reads = (path: string) => api.calls.filter((call) => call.path === path).length;
    await screen.findByText("第 1 项");
    await waitFor(() => expect(reads("/api/collections/k1/summary")).toBe(1));
    await waitFor(() => expect(stream.opened()).toBe(true));
    expect(reads("/api/collections/k1")).toBe(1);

    // The collection summary is a Task too: its stage and unit progress alone refresh nothing.
    const summaryTask = { id: "t1", kind: "summarize_collection", collectionId: "k1", targetTitle: "生成式软件工程", createdAt: 1 };
    stream.frame("stage.updated", { stageRun: stageRun("t1", "collection_summary", "running", { progress: 0.5 }) });
    stream.frame("workunit.updated", {
      workUnit: { id: "w1", stageRunId: "t1-collection_summary-1", key: "partial-0", status: "succeeded", attempt: 1, retryCount: 0 },
    });
    // Listeners run synchronously per frame, so once the probe saw both the page has handled them.
    await waitFor(() => expect(seen).toEqual(["stage.updated", "workunit.updated"]));
    expect(invalidate).not.toHaveBeenCalled();
    expect(reads("/api/collections/k1")).toBe(1);
    expect(reads("/api/collections/k1/summary")).toBe(1);

    stream.frame("task.updated", { task: { ...summaryTask, statusProjection: "running" } });
    await waitFor(() => expect(reads("/api/collections/k1")).toBe(2));
    await waitFor(() => expect(reads("/api/collections/k1/summary")).toBe(2));
    expect(invalidated(queryKeys.contentsAll)).toBe(false);

    stream.frame("task.finished", { task: { ...summaryTask, statusProjection: "succeeded", finishedAt: 2 } });
    await waitFor(() => expect(reads("/api/collections/k1/summary")).toBe(3));
    expect(reads("/api/collections/k1")).toBe(3);
    expect(invalidated(queryKeys.contentsAll)).toBe(true);
  });

  it("offers the latest summary Task when it failed, and reads it again once a task event arrives", async () => {
    const LATEST = "/api/tasks?collectionId=k1&kind=summarize_collection&limit=1";
    const failure = { class: "llm_failed", code: "llm_failed", retryDisposition: "policy", userMessage: "AI 模型调用失败" } as const;
    const failed = { id: "f1", kind: "summarize_collection", statusProjection: "failed", collectionId: "k1", createdAt: 1 };
    let rerun = false;
    const api = routes({
      "GET /api/collections/k1/summary": () => ({ body: rerun ? { ...PUBLISHED, activeTaskId: "f1" } : PUBLISHED }),
      [`GET ${LATEST}`]: () => ({ body: { items: [{ ...failed, statusProjection: rerun ? "running" : "failed" }], eventSeq: 0 } }),
      "GET /api/tasks/f1": {
        body: taskDetail("f1", [stageRun("f1", "collection_summary", "failed", { error: failure })], { kind: "summarize_collection", statusProjection: "failed" }),
      },
    });
    const stream = taskStream();
    render();
    const notice = await screen.findByTestId("collection-summary-failed");
    expect(within(notice).getByText("上次归纳失败，可从失败的步骤重跑")).toBeTruthy();
    expect(await within(notice).findByTestId("task-flow")).toBeTruthy();
    expect(api.calls.filter((call) => call.path === LATEST)).toHaveLength(1);
    await waitFor(() => expect(stream.opened()).toBe(true));

    // Re-run elsewhere (or from the notice): the Task is unfinished again and the card follows it.
    rerun = true;
    stream.frame("task.updated", { task: { ...failed, statusProjection: "running" } });
    await waitFor(() => expect(screen.queryByTestId("collection-summary-failed")).toBeNull());
    expect(api.calls.filter((call) => call.path === LATEST).length).toBeGreaterThanOrEqual(2);
    expect(within(screen.getByTestId("collection-summary")).getByTestId("task-flow")).toBeTruthy();
  });

  it("keeps 「管理合集」 open after it removes the collection's last lecture", async () => {
    let left = false;
    const only = { ...detail, itemCount: 1, items: [item(1)] };
    const api = routes({
      "GET /api/collections/k1": () => ({ body: left ? { ...only, itemCount: 0, items: [] } : only }),
      "GET /api/collections": () => ({ body: { items: [collection("k1", "生成式软件工程"), collection("k2", "进阶")] } }),
      "GET /api/contents/c1": () => ({
        body: { ...content("c1", { title: "第1讲", collections: left ? [] : [{ id: "k1", name: "生成式软件工程", itemId: "i1" }] }), media: [] },
      }),
      "DELETE /api/collections/k1/items/i1": () => {
        left = true;
        return { status: 204 };
      },
    });
    renderWithMenus();
    rightClick(await screen.findByText("第 1 项"));
    fireEvent.click(screen.getByTestId("context-menu-item-membership"));
    const dialog = await screen.findByRole("dialog", { name: "管理合集" });
    const box = () => within(dialog).getByRole("checkbox", { name: "生成式软件工程" }) as HTMLInputElement;
    await waitFor(() => expect(box().checked).toBe(true));
    fireEvent.click(box());
    expect(await screen.findByText("合集里还没有内容")).toBeTruthy();
    await waitFor(() => expect(box().checked).toBe(false));
    expect(screen.getByRole("dialog", { name: "管理合集" })).toBe(dialog);
    expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/api/collections/k1/items/i1")).toBe(true);
  });
});

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
