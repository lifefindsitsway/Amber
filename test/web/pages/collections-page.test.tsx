import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../../src/web/format.ts";
import { CollectionsPage } from "../../../src/web/pages/collections-page.tsx";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

describe("CollectionsPage", () => {
  it("lists collections and creates one with a trimmed name", async () => {
    const api = mockApi({
      "GET /api/collections": { body: { items: [{ id: "k1", name: "生成式软件工程", itemCount: 6, createdAt: 0, updatedAt: 0 }] } },
      "POST /api/collections": { status: 201, body: { id: "k2", name: "新课", itemCount: 0, createdAt: 0, updatedAt: 0, items: [] } },
    });
    renderApp(<CollectionsPage />, { route: "/collections", path: "/collections" });
    expect(await screen.findByText("6 项", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新合集" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("合集名称"), { target: { value: "  新课 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "新建" }));
    await waitFor(() => expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({ name: "新课" }));
  });

  it("pages the collection cards with the pager at the page foot", async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({ id: `k${index + 1}`, name: `合集${index + 1}`, itemCount: 1, createdAt: 0, updatedAt: 0 }));
    mockApi({ "GET /api/collections": { body: { items } } });
    renderApp(<CollectionsPage />, { route: "/collections", path: "/collections" });
    await waitFor(() => expect(screen.getAllByTestId("collection-card")).toHaveLength(10));
    expect(screen.getByText("第 1 / 3 页").getAttribute("aria-current")).toBe("page");
    const grid = screen.getAllByTestId("collection-card")[0]?.closest("ul")?.parentElement as HTMLElement;
    grid.scrollTop = 200;
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.getAllByTestId("collection-card")[0]?.textContent).toContain("合集11"));
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
    expect(grid.scrollTop).toBe(0);
    // The pager sits outside the scrolling grid, so it stays at the page foot.
    expect(grid.contains(screen.getByRole("navigation", { name: "分页" }))).toBe(false);
  });

  it("gives each card the sidebar's collection menu", async () => {
    mockApi({ "GET /api/collections": { body: { items: [{ id: "k1", name: "生成式软件工程", itemCount: 6, createdAt: 0, updatedAt: 0 }] } } });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <CollectionsPage />
      </ContextMenuHost>,
      { route: "/collections", path: "/collections" },
    );
    const card = await screen.findByTestId("collection-card");
    act(() => {
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "在新标签页中打开",
      "复制链接地址",
      "打开",
      "编辑",
      "批量添加",
      "导出合集 Markdown",
      "删除合集",
    ]);
    fireEvent.click(screen.getByTestId("context-menu-item-edit"));
    expect(await screen.findByRole("dialog", { name: "编辑合集" })).toBeTruthy();
  });

  it("shows when each collection last changed, not when it was created", async () => {
    const createdAt = Date.UTC(2026, 9, 6, 2, 43);
    const updatedAt = Date.UTC(2026, 9, 8, 9, 15);
    mockApi({ "GET /api/collections": { body: { items: [{ id: "k1", name: "生成式软件工程", itemCount: 7, createdAt, updatedAt }] } } });
    renderApp(<CollectionsPage />, { route: "/collections", path: "/collections" });
    const card = await screen.findByTestId("collection-card");
    expect(card.textContent).toContain(`7 项 · 更新于 ${formatDateTime(updatedAt, "zh-CN")}`);
    expect(card.textContent).not.toContain("创建于");
  });

  it("shows the whole description with its line breaks", async () => {
    mockApi({ "GET /api/collections": { body: { items: [{ id: "k1", name: "生成式软件工程", description: "南大课程\n第二学期\n第三行", itemCount: 6, createdAt: 0, updatedAt: 0 }] } } });
    renderApp(<CollectionsPage />, { route: "/collections", path: "/collections" });
    const description = await screen.findByText((_, element) => element?.tagName === "P" && element.textContent === "南大课程\n第二学期\n第三行");
    expect(description.className).toContain("whitespace-pre-wrap");
    expect(description.className).not.toContain("line-clamp");
  });

  it("edits a card's name and description from its edit button without opening the collection", async () => {
    const api = mockApi({
      "GET /api/collections": { body: { items: [{ id: "k1", name: "生成式软件工程", description: "南大课程", itemCount: 6, createdAt: 0, updatedAt: 0 }] } },
      "PATCH /api/collections/k1": { body: { id: "k1", name: "生成式软件工程", description: "南大课程\n第二学期", itemCount: 6, createdAt: 0, updatedAt: 0, items: [] } },
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <CollectionsPage />
      </ContextMenuHost>,
      { route: "/collections", path: "/collections" },
    );
    const edit = await screen.findByRole("button", { name: "编辑" });
    // A button inside the card link would be invalid and would also follow the link.
    expect(edit.closest("a")).toBeNull();
    // The button belongs to the card: right-clicking it offers the card's menu.
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    act(() => {
      edit.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
    });
    fireEvent.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "编辑合集" });
    expect(screen.getByTestId("collection-card")).toBeTruthy();
    const description = within(dialog).getByLabelText("说明（可选）") as HTMLTextAreaElement;
    expect(description.value).toBe("南大课程");
    fireEvent.change(description, { target: { value: "南大课程\n第二学期" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ description: "南大课程\n第二学期" });
  });
});
