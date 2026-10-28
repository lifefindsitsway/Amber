import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionItemDto } from "../../../../src/shared/dto/collection.ts";
import { useContentActions } from "../../../../src/web/components/use-content-actions.tsx";
import { ItemList, ReorderList } from "../../../../src/web/pages/collection/item-list.tsx";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const UPDATED = Date.UTC(2026, 9, 1, 4, 5);
const ITEMS: CollectionItemDto[] = [
  {
    id: "i1",
    contentId: "c1",
    position: 0,
    addedAt: 1,
    title: "第一讲",
    durationMs: 3_725_000,
    processingStatus: "succeeded",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    source: { kind: "youtube" },
    updatedAt: UPDATED,
  },
  { id: "i2", contentId: "c2", position: 1, addedAt: 1, title: "第二讲", processingStatus: "running", source: { kind: "local" }, updatedAt: UPDATED },
];
const COLUMNS = ["序号", "封面", "标题", "来源", "时长", "状态", "更新时间"];

function rightClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
}

function contextLabels(): (string | null)[] {
  return within(screen.getByTestId("context-menu")).getAllByRole("menuitem").map((item) => item.textContent);
}

function List(props: { startIndex?: number }) {
  const actions = useContentActions();
  return (
    <>
      <ItemList items={ITEMS} startIndex={props.startIndex ?? 0} actions={actions} />
      {actions.dialogs}
    </>
  );
}

/** The draft lives in the parent, as on the collection page; `onChange` records each draft. */
function Draft(props: { onChange: (order: string[]) => void }) {
  const actions = useContentActions();
  const [order, setOrder] = useState(() => ITEMS.map((item) => item.id));
  return (
    <>
      <ReorderList
        items={ITEMS}
        order={order}
        onChange={(next) => {
          props.onChange(next);
          setOrder(next);
        }}
        actions={actions}
      />
      {actions.dialogs}
    </>
  );
}

function renderList(startIndex?: number) {
  mockApi({});
  renderApp(
    <ContextMenuHost blockNative={false}>
      <List {...(startIndex === undefined ? {} : { startIndex })} />
    </ContextMenuHost>,
  );
}

function renderDraft(onChange = vi.fn()) {
  mockApi({});
  renderApp(
    <ContextMenuHost blockNative={false}>
      <Draft onChange={onChange} />
    </ContextMenuHost>,
  );
  return { onChange };
}

const numbers = () => screen.getAllByTestId("collection-item").map((row) => within(row).getByText(/^第 \d+ 项$/).textContent);
const headers = () => screen.getAllByRole("columnheader").map((header) => header.textContent);
const cells = (row: HTMLElement) => within(row).getAllByRole("cell");

const original = HTMLElement.prototype.setPointerCapture;
afterEach(() => {
  HTMLElement.prototype.setPointerCapture = original;
});

describe("ItemList", () => {
  it("offers the Content's actions on a right click and leaves removal to 「合集归属」", () => {
    renderList();
    const [first, second] = screen.getAllByTestId("collection-item");
    rightClick(within(first as HTMLElement).getByText("第 1 项"));
    expect(contextLabels()).toEqual(["打开", "在新标签页中打开", "复制来源链接", "重命名", "置顶", "删除", "合集归属"]);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
    });
    rightClick(within(second as HTMLElement).getByText("第二讲"));
    expect(contextLabels()).toEqual(["在新标签页中打开", "复制链接地址", "打开", "重命名", "置顶", "删除", "合集归属"]);
  });

  it("numbers the rows by their place in the whole collection and has no buttons on a row", () => {
    renderList(10);
    expect(numbers()).toEqual(["第 11 项", "第 12 项"]);
    expect(screen.queryByRole("button", { name: /移出合集/ })).toBeNull();
    for (const row of screen.getAllByTestId("collection-item")) {
      expect(within(row).queryAllByRole("button")).toEqual([]);
    }
  });
});

describe("member table", () => {
  it("has a header and the content list's columns, in order: number, cover, title, source, duration, status, update time", () => {
    renderList();
    expect(headers()).toEqual(COLUMNS);
    const [first, second] = screen.getAllByTestId("collection-item") as HTMLElement[];
    const row = cells(first as HTMLElement).map((cell) => cell.textContent);
    expect(row[0]).toBe("第 1 项");
    expect(row[2]).toContain("第一讲");
    expect(row.slice(3)).toEqual(["YouTube", "1:02:05", "已完成", expect.stringContaining("2026")]);
    expect(cells(second as HTMLElement).map((cell) => cell.textContent).slice(3, 5)).toEqual(["本地文件", ""]);
    expect(within(second as HTMLElement).getByText("处理中")).toBeTruthy();
  });

  it("folds source, duration and update time under the title, and the cover, at the content list's widths", () => {
    renderList();
    const header = screen.getAllByRole("columnheader");
    const byName = (name: string) => header[COLUMNS.indexOf(name)]?.className ?? "";
    for (const name of ["来源", "时长", "更新时间"]) expect(byName(name)).toContain("hidden @5xl:table-cell");
    expect(byName("封面")).toContain("hidden @3xl:table-cell");
    for (const name of ["序号", "标题", "状态"]) expect(byName(name)).not.toContain("hidden");
    expect(screen.getByTestId("collection-items").className).toContain("@container");
    const [first] = screen.getAllByTestId("collection-item") as HTMLElement[];
    const meta = within(first as HTMLElement).getByTestId("collection-item-meta");
    expect(meta.className).toContain("@5xl:hidden");
    expect(meta.textContent).toMatch(/^YouTube · 1:02:05 · .*2026/u);
  });

  it("links each title into the Content with the collection's list loop", () => {
    mockApi({});
    function Where() {
      const location = useLocation();
      return <p data-testid="where">{`${location.pathname} ${JSON.stringify(location.state)}`}</p>;
    }
    renderApp(
      <Routes>
        <Route path="/collections/:id" element={<List />} />
        <Route path="/contents/:contentId" element={<Where />} />
      </Routes>,
      { route: "/collections/k1" },
    );
    fireEvent.click(screen.getByRole("link", { name: "第二讲" }));
    expect(screen.getByTestId("where").textContent).toBe(`/contents/c2 ${JSON.stringify({ collectionId: "k1", autoplayLocal: false })}`);
  });
});

describe("ReorderList", () => {
  it("shows the same columns with a drag handle in front", () => {
    renderDraft();
    expect(headers()).toEqual(["拖动排序", ...COLUMNS]);
    const [first] = screen.getAllByTestId("collection-item") as HTMLElement[];
    const row = cells(first as HTMLElement);
    expect(within(row[0] as HTMLElement).getByRole("button", { name: "拖动排序 · 第一讲" })).toBeTruthy();
    expect(row[1]?.textContent).toBe("第 1 项");
    expect(row).toHaveLength(COLUMNS.length + 1);
  });

  it("hands each keyboard move's complete draft to its parent", () => {
    const { onChange } = renderDraft();
    expect(numbers()).toEqual(["第 1 项", "第 2 项"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第一讲" }), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(["i2", "i1"]);
    expect(screen.getAllByTestId("collection-item").map((row) => row.dataset["itemId"])).toEqual(["i2", "i1"]);
    // Rows are numbered by their place in the draft.
    expect(within(screen.getAllByTestId("collection-item")[0] as HTMLElement).getByText("第 1 项")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第一讲" }), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(["i1", "i2"]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does not report a move past either end", () => {
    const { onChange } = renderDraft();
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第一讲" }), { key: "ArrowUp" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the menu from the drag handle without starting a drag", () => {
    const capture = vi.fn();
    HTMLElement.prototype.setPointerCapture = capture;
    const { onChange } = renderDraft();
    const handle = screen.getByRole("button", { name: "拖动排序 · 第一讲" });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientY: 5 });
    rightClick(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 });
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("collection-item")[0]?.className).not.toContain("bg-accent-soft");
    expect(screen.getByTestId("context-menu-item-open")).toBeTruthy();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
