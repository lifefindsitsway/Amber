import { act, fireEvent, screen, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { CollectionItemDto } from "../../../../src/shared/dto/collection.ts";
import { useContentActions } from "../../../../src/web/components/use-content-actions.tsx";
import { SearchHits } from "../../../../src/web/pages/collection/search-hits.tsx";
import type { useSearch } from "../../../../src/web/search/search.ts";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const SEGMENT = "01JABCDEFGHJKMNPQRSTVWXYZ3";
const ITEMS: CollectionItemDto[] = [
  { id: "i1", contentId: "c1", position: 0, addedAt: 1, title: "第一讲", processingStatus: "succeeded", source: { kind: "local" }, updatedAt: 1 },
  { id: "i2", contentId: "c2", position: 1, addedAt: 1, title: "第二讲", durationMs: 90_000, processingStatus: "succeeded", source: { kind: "bilibili" }, updatedAt: 1 },
];
const SEARCH = {
  data: {
    contents: [],
    segments: [
      { contentId: "c1", contentTitle: "第一讲", transcriptRevisionId: "r1", segmentId: SEGMENT, startMs: 75_000, snippet: "进程调度靠时间片", ranges: [{ start: 0, end: 4 }] },
    ],
    summaries: [],
    collections: [],
  },
  isError: false,
  query: "进程调度",
} as unknown as ReturnType<typeof useSearch>;

function rightClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
}

function contextLabels(): (string | null)[] {
  return within(screen.getByTestId("context-menu")).getAllByRole("menuitem").map((item) => item.textContent);
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function Hits() {
  const actions = useContentActions();
  return (
    <>
      <SearchHits items={ITEMS} search={SEARCH} actions={actions} />
      {actions.dialogs}
    </>
  );
}

const RANKED = {
  ...SEARCH,
  data: {
    ...SEARCH.data,
    contents: [{ contentId: "c2", title: "第二讲", matchedIn: "title", snippet: "第二讲", ranges: [] }],
  },
} as unknown as ReturnType<typeof useSearch>;

describe("SearchHits", () => {
  it("lists hits best first in the member table's columns, each numbered by its place in the collection", () => {
    mockApi({});
    function Ranked() {
      const actions = useContentActions();
      return <SearchHits items={ITEMS} search={RANKED} actions={actions} />;
    }
    renderApp(<Ranked />, { route: "/collections/k1" });
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["序号", "封面", "标题", "来源", "时长", "状态", "更新时间"]);
    const rows = screen.getAllByTestId("collection-hit");
    expect(rows.map((row) => row.dataset["itemId"])).toEqual(["i2", "i1"]);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual(["第 2 项", "第 1 项"]);
    expect(within(rows[0] as HTMLElement).getAllByRole("cell").map((cell) => cell.textContent).slice(3, 5)).toEqual(["B 站", "1:30"]);
  });

  it("opens the excerpt's sentence from a hit's right-click menu, without a removal entry", () => {
    mockApi({});
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Hits />
        <Where />
      </ContextMenuHost>,
      { route: "/collections/k1" },
    );
    const [snippet] = screen.getAllByTestId("search-snippet") as HTMLElement[];
    if (snippet === undefined) throw new Error("no excerpt");
    rightClick(snippet);
    expect(contextLabels()).toEqual(["在新标签页中打开", "复制链接地址", "打开", "重命名", "置顶", "删除", "合集归属"]);
    fireEvent.click(screen.getByTestId("context-menu-item-open"));
    expect(screen.getByTestId("where").textContent).toBe(snippet.getAttribute("href"));
    rightClick(screen.getByText("第 1 项"));
    expect(contextLabels()).not.toContain("移出合集");
  });
});
