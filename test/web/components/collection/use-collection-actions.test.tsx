import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { useCollectionActions, type CollectionActionOptions } from "../../../../src/web/components/collection/use-collection-actions.tsx";
import { ContextMenuHost, useContextMenuTarget } from "../../../../src/web/ui/context-menu.tsx";
import { SETTINGS } from "../../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

function Harness(props: { options?: CollectionActionOptions }) {
  const actions = useCollectionActions({ id: "k1", name: "LLM", description: "大模型课程" }, props.options);
  const ownPage = props.options?.ownPage === true;
  const ref = useContextMenuTarget<HTMLDivElement>(() => ({ kind: "object", ...(ownPage ? {} : { href: "/collections/k1" }), entries: actions.menu("context") }));
  const location = useLocation();
  return (
    <>
      <div ref={ref} data-testid="target">
        LLM
      </div>
      <p data-testid="location">{location.pathname}</p>
      {actions.exportError === undefined ? null : <p data-testid="inline-error">{actions.exportError.userMessage}</p>}
      {actions.dialogs}
    </>
  );
}

function render(options?: CollectionActionOptions, route = "/library") {
  return renderApp(
    <ContextMenuHost blockNative={false}>
      <Harness {...(options === undefined ? {} : { options })} />
    </ContextMenuHost>,
    { route },
  );
}

function openMenu(): string[] {
  act(() => {
    screen.getByTestId("target").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  return screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
}

const choose = (id: string) => fireEvent.click(screen.getByTestId(`context-menu-item-${id}`));
/** A collection whose members all belong elsewhere too: deleting it is a plain confirmation. */
const deleteRoutes = {
  "GET /api/collections/k1/delete-plan": {
    body: { memberCount: 1, exclusiveContentIds: [], sharedCount: 1, trashedMemberCount: 0, exclusiveWithTasksCount: 0, collectionTaskCount: 0, blocked: [] },
  },
  "POST /api/collections/k1/delete": { body: { trashedIds: [], cancelledTaskCount: 0 } },
};
const failure = { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "导出时出错了" } } };

describe("useCollectionActions", () => {
  it("offers open, edit, batch add, export and delete for a collection elsewhere, without summarizing", () => {
    mockApi({});
    render();
    expect(openMenu()).toEqual(["打开", "在新标签页中打开", "编辑", "批量添加", "导出合集 Markdown", "删除合集"]);
    choose("open");
    expect(screen.getByTestId("location").textContent).toBe("/collections/k1");
  });

  it("edits name and description through the dialog when there is no inline edit", async () => {
    mockApi({});
    render();
    openMenu();
    choose("edit");
    const dialog = await screen.findByRole("dialog", { name: "编辑合集" });
    expect((within(dialog).getByLabelText("合集名称") as HTMLInputElement).value).toBe("LLM");
    expect((within(dialog).getByLabelText("说明（可选）") as HTMLTextAreaElement).value).toBe("大模型课程");
  });

  it("on the collection's own page: no open, inline edit and summarize (disabled while one runs)", () => {
    mockApi({});
    const inlineEdit = vi.fn();
    const summarize = vi.fn();
    render({ ownPage: true, inlineEdit, summarize }, "/collections/k1");
    expect(openMenu()).toEqual(["编辑", "批量添加", "重新归纳", "导出合集 Markdown", "删除合集"]);
    choose("edit");
    expect(inlineEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    openMenu();
    choose("summarize");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("disables summarizing while a summary runs", () => {
    mockApi({});
    render({ ownPage: true, summarize: vi.fn(), summarizeDisabled: true }, "/collections/k1");
    openMenu();
    expect(screen.getByTestId("context-menu-item-summarize").hasAttribute("data-disabled")).toBe(true);
  });

  it("leaves the page of the collection it deleted", async () => {
    const { calls } = mockApi(deleteRoutes);
    render(undefined, "/collections/k1");
    openMenu();
    choose("delete");
    const dialog = await screen.findByRole("dialog", { name: "删除合集「LLM」？" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "删除合集" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/collections"));
    expect(calls.find((call) => call.method === "POST" && call.path === "/api/collections/k1/delete")?.body).toEqual({ contents: "keep", cancelTasks: false });
  });

  it("stays where it is after deleting a collection that is not being viewed", async () => {
    const { calls } = mockApi(deleteRoutes);
    render(undefined, "/library");
    openMenu();
    choose("delete");
    fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "删除合集" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((call) => call.method === "POST" && call.path === "/api/collections/k1/delete")).toBe(true);
    expect(screen.getByTestId("location").textContent).toBe("/library");
  });

  it("shows an export failure in a dialog away from the collection page", async () => {
    const { calls } = mockApi({ "POST /api/collections/k1/export": failure });
    render();
    openMenu();
    choose("export");
    const dialog = await screen.findByRole("dialog", { name: "导出合集 Markdown 失败" });
    expect(within(dialog).getByText("导出时出错了")).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ backlinks: true });
    const close = within(dialog).getAllByRole("button", { name: "关闭" }).at(-1);
    fireEvent.click(close as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("leaves an export failure to the collection page to show inline", async () => {
    mockApi({ "POST /api/collections/k1/export": failure });
    render({ ownPage: true }, "/collections/k1");
    openMenu();
    choose("export");
    expect((await screen.findByTestId("inline-error")).textContent).toBe("导出时出错了");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("imports the batch-added links into the collection", async () => {
    const { calls } = mockApi({
      "GET /api/settings": { body: SETTINGS },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"] } },
    });
    render();
    openMenu();
    choose("batch-add");
    const dialog = await screen.findByRole("dialog", { name: "批量添加到合集" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "https://example.com/a\n\n https://example.com/b " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = calls.find((call) => call.method === "POST")?.body as { items: unknown; collection: unknown };
    expect(post.items).toEqual([{ url: "https://example.com/a" }, { url: "https://example.com/b" }]);
    expect(post.collection).toEqual({ id: "k1" });
  });
});
