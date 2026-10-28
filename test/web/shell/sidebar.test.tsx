import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { itemsNear, Sidebar } from "../../../src/web/shell/sidebar.tsx";
import { requestOpenTasks } from "../../../src/web/shell/task-panel.tsx";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { baseRoutes, collection, collectionDetail, content, SETTINGS, task } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

describe("itemsNear", () => {
  it("returns a window around the current item clamped to the list", () => {
    const items = Array.from({ length: 30 }, (_, index) => index);
    expect(itemsNear(items, 0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(itemsNear(items, 15, 10)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(itemsNear(items, 29, 10)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(itemsNear([1, 2], 1, 10)).toEqual([1, 2]);
  });
});

describe("Sidebar", () => {
  it("lists collections, recent contents and the unfinished task count; only the browsed collection expands", async () => {
    const lectures = Array.from({ length: 25 }, (_, index) => `c${index}`);
    mockApi({
      ...baseRoutes(),
      "GET /api/collections": { body: { items: [collection("k1", "生成式软件工程", 25), collection("k2", "另一个合集", 2)] } },
      "GET /api/contents": { body: { items: [content("r1", { title: "最近一条", processingStatus: "running" })], total: 1 } },
      "GET /api/tasks": { body: { items: [task("a"), task("b")], eventSeq: 0 } },
      "GET /api/contents/c20": { body: { ...content("c20", { collections: [{ id: "k1", name: "生成式软件工程", itemId: "ki1" }] }), media: [] } },
      "GET /api/collections/k1": { body: collectionDetail("k1", "生成式软件工程", lectures) },
    });
    const onOpenTasks = vi.fn();
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={onOpenTasks} />, { route: "/contents/c20" });
    expect(await screen.findByText("最近一条")).toBeTruthy();
    expect(screen.getByText("另一个合集")).toBeTruthy();
    // The slogan is drawn as outlines; assistive technology still reads the text.
    expect(screen.getByRole("img", { name: "Knowledge finds its way" })).toBeTruthy();
    const expanded = await screen.findByTestId("sidebar-collection-items");
    const links = within(expanded).getAllByRole("link");
    // Ten lectures around the current one, plus "view all".
    expect(links).toHaveLength(11);
    expect(links.some((link) => link.getAttribute("href") === "/contents/c20")).toBe(true);
    expect(links.at(-1)?.getAttribute("href")).toBe("/collections/k1");
    await waitFor(() => expect(screen.getByTestId("sidebar-tasks").textContent).toContain("2"));
    fireEvent.click(screen.getByTestId("sidebar-tasks"));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    requestOpenTasks();
    expect(onOpenTasks).toHaveBeenCalledTimes(2);
  });

  it("lists the fixed items 全部内容 · 合集 · 笔记 · 回收站 under 新总结, 笔记 opening the notes page", async () => {
    mockApi(baseRoutes());
    localStorage.removeItem("amber.sidebar.collapsed");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/notes" });
    const notes = await screen.findByRole("link", { name: "笔记" });
    expect(notes.getAttribute("href")).toBe("/notes");
    expect(notes.getAttribute("aria-current")).toBe("page");
    const fixed = notes.parentElement as HTMLElement;
    expect(within(fixed).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["全部内容", "/library"],
      ["合集", "/collections"],
      ["笔记", "/notes"],
      ["回收站", "/trash"],
    ]);
    expect(screen.getByTestId("sidebar-trash").getAttribute("href")).toBe("/trash");
  });

  it("marks 回收站 current on the trash page", async () => {
    mockApi(baseRoutes());
    localStorage.removeItem("amber.sidebar.collapsed");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/trash" });
    const trash = await screen.findByTestId("sidebar-trash");
    expect(trash.getAttribute("aria-current")).toBe("page");
    expect(trash.getAttribute("title")).toBe("回收站");
  });

  it("shows each collection's lecture count and expands or collapses its lectures beside the link", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/collections": { body: { items: [collection("k1", "LLM", 3), collection("k2", "空合集")] } },
      "GET /api/collections/k1": { body: collectionDetail("k1", "LLM", ["c1", "c2", "c3"]) },
    });
    localStorage.removeItem("amber.sidebar.collapsed");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    const toggle = await screen.findByRole("button", { name: "展开「LLM」" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.closest("a")).toBeNull();
    const link = screen.getByRole("link", { name: /LLM/u });
    expect(link.getAttribute("href")).toBe("/collections/k1");
    expect(within(link).getByTitle("3 项").textContent).toBe("3");
    // An empty collection shows neither a count nor a button.
    const [, empty] = screen.getAllByTestId("sidebar-collection");
    expect(empty?.textContent).toBe("空合集");
    expect(within(empty as HTMLElement).queryByRole("button")).toBeNull();
    // Lectures are fetched only once the collection is expanded.
    expect(calls.some((call) => call.path === "/api/collections/k1")).toBe(false);
    fireEvent.click(toggle);
    const items = await screen.findByTestId("sidebar-collection-items");
    expect((await within(items).findAllByRole("link")).map((item) => item.getAttribute("href"))).toEqual(["/contents/c1", "/contents/c2", "/contents/c3"]);
    expect(screen.getByRole("button", { name: "收起「LLM」" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "收起「LLM」" }));
    expect(screen.queryByTestId("sidebar-collection-items")).toBeNull();
  });

  it("expands the browsed collection by default and lets it be collapsed", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/collections": { body: { items: [collection("k1", "LLM", 2)] } },
      "GET /api/collections/k1": { body: collectionDetail("k1", "LLM", ["c1", "c2"]) },
    });
    localStorage.removeItem("amber.sidebar.collapsed");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/collections/k1" });
    expect(await screen.findByTestId("sidebar-collection-items")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起「LLM」" }));
    expect(screen.queryByTestId("sidebar-collection-items")).toBeNull();
    expect(screen.getByRole("button", { name: "展开「LLM」" })).toBeTruthy();
  });

  it("offers the source link, rename, pin, delete and collection membership from a recent row's menu, beside the link rather than inside it", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/contents": { body: { items: [content("c9", { title: "Demo", source: { kind: "youtube", sourceUrl: WATCH } })], total: 1 } },
      "GET /api/contents/c9": { body: { ...content("c9", { title: "Demo" }), media: [] } },
      "GET /api/collections": { body: { items: [collection("k1", "Test")] } },
    });
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    const more = await screen.findByRole("button", { name: "「Demo」的更多操作" });
    expect(more.closest("a")).toBeNull();
    expect(more.className).toContain("group-hover:opacity-100");
    expect(more.className).toContain("pointer-coarse:opacity-100");
    expect(within(more.parentElement as HTMLElement).getByRole("link", { name: /Demo/u }).getAttribute("href")).toBe("/contents/c9");
    fireEvent.keyDown(more, { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["复制来源链接", "重命名", "置顶", "删除", "合集归属"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "合集归属" }));
    const dialog = await screen.findByRole("dialog", { name: "管理合集" });
    await waitFor(() => expect((within(dialog).getByRole("checkbox", { name: "Test" }) as HTMLInputElement).checked).toBe(false));
  });

  it("asks only for Contents in no collection, counts them, folds the group and links to the rest", async () => {
    const recent = Array.from({ length: 10 }, (_, index) => content(`r${index}`, { title: `第 ${index} 条` }));
    const { calls } = mockApi({ ...baseRoutes(), "GET /api/contents": { body: { items: recent, total: 12 } } });
    localStorage.removeItem("amber.sidebar.recentCollapsed");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    expect(await screen.findByText("第 0 条")).toBeTruthy();
    expect(calls.some((call) => call.path === "/api/contents?limit=10&uncollected=1")).toBe(true);
    expect(screen.getByTestId("recent-count").textContent).toBe("12");
    expect(screen.getByTestId("recent-view-all").getAttribute("href")).toBe("/library?uncollected=1");
    fireEvent.click(screen.getByRole("button", { name: "收起「最近」" }));
    expect(screen.queryByText("第 0 条")).toBeNull();
    expect(localStorage.getItem("amber.sidebar.recentCollapsed")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "展开「最近」" }));
    expect(screen.getByText("第 0 条")).toBeTruthy();
  });

  it("pins and unpins from the menu and marks pinned rows", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/contents": { body: { items: [content("p1", { title: "置顶的", pinnedAt: 5 }), content("n1", { title: "普通的" })], total: 2 } },
      "PATCH /api/contents/p1": { body: content("p1", { title: "置顶的" }) },
      "PATCH /api/contents/n1": { body: content("n1", { title: "普通的", pinnedAt: 6 }) },
    });
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    const pinnedRow = (await screen.findByText("置顶的")).closest("[data-testid='recent-row']") as HTMLElement;
    expect(within(pinnedRow).getByLabelText("已置顶")).toBeTruthy();
    fireEvent.keyDown(within(pinnedRow).getByRole("button", { name: "「置顶的」的更多操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "取消置顶" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH" && call.path === "/api/contents/p1")?.body).toEqual({ pinned: false }));
    fireEvent.keyDown(screen.getByRole("button", { name: "「普通的」的更多操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "置顶" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH" && call.path === "/api/contents/n1")?.body).toEqual({ pinned: true }));
  });

  it("renames from the menu, offering the original title back once renamed", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/contents": { body: { items: [content("c9", { title: "我的名字", customTitle: "我的名字" })], total: 1 } },
      "GET /api/contents/c9": { body: { ...content("c9", { title: "我的名字", customTitle: "我的名字" }), media: [] } },
      "PATCH /api/contents/c9": { body: content("c9", { title: "平台标题" }) },
    });
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    fireEvent.keyDown(await screen.findByRole("button", { name: "「我的名字」的更多操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    expect(((await screen.findByLabelText("标题")) as HTMLInputElement).value).toBe("我的名字");
    fireEvent.click(screen.getByRole("button", { name: "恢复原标题" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ title: null }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("deletes after confirmation and leaves the page of the deleted Content", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/contents": { body: { items: [content("c9", { title: "Demo" })], total: 1 } },
      "GET /api/contents/c9": { body: { ...content("c9", { title: "Demo" }), media: [] } },
      "DELETE /api/contents/c9": { status: 204 },
    });
    renderApp(
      <>
        <Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />
        <Where />
      </>,
      { route: "/contents/c9" },
    );
    fireEvent.keyDown(await screen.findByRole("button", { name: "「Demo」的更多操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/library"));
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/contents/c9"]);
  });

  it("gives the lectures of an expanded collection the same menu", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/collections": { body: { items: [collection("k1", "LLM", 1)] } },
      "GET /api/collections/k1": { body: collectionDetail("k1", "LLM", ["c1"]) },
    });
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/collections/k1" });
    const row = await screen.findByTestId("collection-item-row");
    fireEvent.keyDown(within(row).getByRole("button"), { key: "Enter" });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["重命名", "置顶", "删除", "合集归属"]);
  });

  it("opens a recent row's right-click menu with open, the source link and the row actions", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/contents": { body: { items: [content("c9", { title: "Demo", source: { kind: "youtube", sourceUrl: WATCH } })], total: 1 } },
      "GET /api/contents/c9": { body: { ...content("c9", { title: "Demo" }), media: [] } },
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />
        <Where />
      </ContextMenuHost>,
      { route: "/library" },
    );
    rightClick(await screen.findByText("Demo"));
    expect(contextLabels()).toEqual(["在新标签页中打开", "复制链接地址", "打开", "复制来源链接", "重命名", "置顶", "删除", "合集归属"]);
    fireEvent.click(screen.getByTestId("context-menu-item-open"));
    expect(screen.getByTestId("where").textContent).toBe("/contents/c9");
    rightClick(screen.getByText("Demo"));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    expect(((await screen.findByLabelText("标题")) as HTMLInputElement).value).toBe("Demo");
  });

  it("gives the lectures of an expanded collection the same right-click menu", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/collections": { body: { items: [collection("k1", "LLM", 1)] } },
      "GET /api/collections/k1": { body: collectionDetail("k1", "LLM", ["c1"]) },
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />
      </ContextMenuHost>,
      { route: "/collections/k1" },
    );
    const row = await screen.findByTestId("collection-item-row");
    rightClick(within(row).getByText("第 1 讲"));
    expect(contextLabels()).toEqual(["在新标签页中打开", "复制链接地址", "打开", "重命名", "置顶", "删除", "合集归属"]);
  });

  it("opens a collection row's right-click menu: open, edit (dialog), batch add, export, delete; no summarize", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/collections": { body: { items: [collection("k1", "LLM", 1), collection("k2", "空合集")] } },
      "GET /api/collections/k1": { body: collectionDetail("k1", "LLM", ["c1"]) },
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />
        <Where />
      </ContextMenuHost>,
      { route: "/library" },
    );
    rightClick(await screen.findByText("空合集"));
    expect(contextLabels()).toEqual(["在新标签页中打开", "复制链接地址", "打开", "编辑", "批量添加", "导出合集 Markdown", "删除合集"]);
    expect(screen.getByTestId("context-menu-item-delete").className).not.toContain("text-danger");
    fireEvent.click(screen.getByTestId("context-menu-item-open"));
    expect(screen.getByTestId("where").textContent).toBe("/collections/k2");
    rightClick(screen.getByText("LLM"));
    fireEvent.click(screen.getByTestId("context-menu-item-edit"));
    const dialog = await screen.findByRole("dialog", { name: "编辑合集" });
    expect((within(dialog).getByLabelText("合集名称") as HTMLInputElement).value).toBe("LLM");
  });

  it("drags its width within 200–400 px, remembers it and double-click restores 240", async () => {
    mockApi(baseRoutes());
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    localStorage.removeItem("amber.sidebar.collapsed");
    localStorage.removeItem("amber.sidebar.width");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    const nav = screen.getByTestId("sidebar");
    const splitter = screen.getByTestId("sidebar-splitter");
    expect(nav.style.width).toBe("240px");
    const drag = (dx: number) => {
      fireEvent.pointerDown(splitter, { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(splitter, { clientX: 500 + dx, pointerId: 1 });
      fireEvent.pointerUp(splitter, { clientX: 500 + dx, pointerId: 1 });
    };
    drag(60);
    expect(nav.style.width).toBe("300px");
    expect(localStorage.getItem("amber.sidebar.width")).toBe("300");
    drag(500);
    expect(nav.style.width).toBe("400px");
    drag(-1000);
    expect(nav.style.width).toBe("200px");
    fireEvent.doubleClick(splitter);
    expect(nav.style.width).toBe("240px");
    expect(localStorage.getItem("amber.sidebar.width")).toBe("240");
    // The icon bar has no handle.
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(screen.queryByTestId("sidebar-splitter")).toBeNull();
  });

  it("collapses to an icon bar and remembers it", async () => {
    mockApi(baseRoutes());
    localStorage.removeItem("amber.sidebar.collapsed");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(screen.getByTestId("sidebar").dataset["collapsed"]).toBe("true");
    expect(localStorage.getItem("amber.sidebar.collapsed")).toBe("1");
  });

  it("creates a collection from the sidebar", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/collections": { status: 201, body: collection("k9", "新课") } });
    localStorage.removeItem("amber.sidebar.collapsed");
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    fireEvent.click(screen.getByRole("button", { name: "新合集" }));
    fireEvent.change(await screen.findByLabelText("合集名称"), { target: { value: " 新课 " } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.path === "/api/collections")?.body).toEqual({ name: "新课" }));
  });

  it("names the signed-in administrator and offers the server menu in order; logout returns to /login", async () => {
    const { calls } = mockApi({ ...baseRoutes({ mode: "server" }), "POST /api/auth/logout": { status: 204 } });
    localStorage.removeItem("amber.sidebar.collapsed");
    renderApp(
      <>
        <Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />
        <Where />
      </>,
      { route: "/library", mode: "server" },
    );
    const card = await screen.findByTestId("account-card");
    await waitFor(() => expect(card.textContent).toBe("admin"));
    fireEvent.keyDown(card, { key: "Enter" });
    await screen.findByRole("menuitem", { name: "登出" });
    expect(menuLabels()).toEqual(["功能设置", "外观设置", "修改密码", "系统管理", "关于 Amberv0.0.0-test", "登出"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "登出" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/login"));
    expect(calls.find((call) => call.path === "/api/auth/logout")?.headers["x-amber-request"]).toBe("1");
  });

  it("shows a regular user's display name and leaves out the admin entry", async () => {
    mockApi({
      ...baseRoutes({ mode: "server" }),
      "GET /api/auth/me": { body: { userId: "u2", username: "alice", displayName: "Alice", role: "user", mode: "server", mustChangePassword: false } },
    });
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library", mode: "server" });
    const card = await screen.findByTestId("account-card");
    await waitFor(() => expect(card.textContent).toBe("Alice"));
    fireEvent.keyDown(card, { key: "Enter" });
    await screen.findByRole("menuitem", { name: "登出" });
    expect(menuLabels()).toEqual(["功能设置", "外观设置", "修改密码", "关于 Amberv0.0.0-test", "登出"]);
  });

  it("keeps the local menu to settings, appearance and about", async () => {
    mockApi(baseRoutes());
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    const card = await screen.findByTestId("account-card");
    expect(card.textContent).toBe("系统设置");
    fireEvent.keyDown(card, { key: "Enter" });
    await screen.findByRole("menuitem", { name: /关于 Amber/ });
    expect(menuLabels()).toEqual(["功能设置", "外观设置", "关于 Amberv0.0.0-test"]);
  });

  it("switches the theme from the appearance submenu and lists the bundled interface languages", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "PATCH /api/settings": { body: { ...SETTINGS, theme: "dark" } } });
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    fireEvent.keyDown(await screen.findByTestId("account-card"), { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "外观设置" }), { key: "ArrowRight" });
    const light = await screen.findByRole("menuitemradio", { name: "浅色" });
    expect(light.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "简体中文" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["浅色", "深色", "经典豆沙绿", "羊皮纸", "简体中文"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "深色" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH" && call.path === "/api/settings")?.body).toEqual({ theme: "dark" }));
  });

  it("switches to an eye-care theme from the appearance submenu", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "PATCH /api/settings": { body: { ...SETTINGS, theme: "bean-green" } } });
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    fireEvent.keyDown(await screen.findByTestId("account-card"), { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "外观设置" }), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "经典豆沙绿" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH" && call.path === "/api/settings")?.body).toEqual({ theme: "bean-green" }));
  });

  it("opens About Amber with the version, run mode and license", async () => {
    mockApi(baseRoutes());
    renderApp(<Sidebar onOpenOmnibox={() => undefined} onOpenTasks={() => undefined} />, { route: "/library" });
    fireEvent.keyDown(await screen.findByTestId("account-card"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /关于 Amber/ }));
    const dialog = await screen.findByRole("dialog", { name: "关于 Amber" });
    expect(within(dialog).getByTestId("about-version").textContent).toBe("0.0.0-test");
    expect(dialog.textContent).toContain("本地客户端");
    expect(dialog.textContent).toContain("AGPL-3.0");
    expect(dialog.textContent).not.toContain("遥测");
  });
});

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function rightClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
}

/** Rows of the open right-click menu, separators left out. */
function contextLabels(): (string | null)[] {
  return within(screen.getByTestId("context-menu")).getAllByRole("menuitem").map((item) => item.textContent);
}

/** Top-level entries of the open account menu, submenu triggers included, in order. */
function menuLabels(): (string | null)[] {
  return within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}
