import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BatchAddDialog } from "../../../../src/web/components/collection/batch-add-dialog.tsx";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";
import { APP_SHARE, SHORT, UNSUPPORTED, VIDEO as SHARE_VIDEO, WEB_SHARE, WEB_SHARE_LINK } from "../../../fixtures/platform/share-text.ts";
import { baseRoutes, provider, SETTINGS } from "../../../fixtures/web/shell-data.ts";
import { providerWithoutWindow, windowRoutes } from "../../../fixtures/web/context-window.ts";
import { fakeInspect, newEntries } from "../../../fixtures/web/collection-preview.ts";
import { stubSelectLayout } from "../../../fixtures/web/select.ts";

beforeEach(stubSelectLayout);

const VIDEO = "https://www.youtube.com/watch?v=UF8uR6Z6KLc";

function routes(defaultModelId: string) {
  const windows = windowRoutes([provider("p1", "主力", ["m1"]), providerWithoutWindow("p2", "备用", ["bare"])]);
  const defaultModelRef = defaultModelId === "m1" ? { providerProfileId: "p1", modelId: "m1" } : { providerProfileId: "p2", modelId: defaultModelId };
  const api = mockApi({
    ...baseRoutes(),
    ...windows.routes,
    "GET /api/settings": { body: { ...SETTINGS, defaultModelRef } },
    "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
  });
  return { calls: api.calls, overrides: windows.overrides };
}

describe("BatchAddDialog model readiness", () => {
  it("holds the import while the default model has no window, and adds once it is filled in", async () => {
    const { calls, overrides } = routes("bare");
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.change(screen.getByRole("textbox", { name: "批量添加到合集" }), { target: { value: VIDEO } });
    const notice = await screen.findByTestId("batch-add-context-window");
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "添加" });
    expect(add.disabled).toBe(true);
    // A dialog keeps to the field and 「保存」: the common sizes are input suggestions.
    expect(notice.dataset["variant"]).toBe("minimal");
    expect(within(notice).queryByRole("group", { name: "常用值" })).toBeNull();
    expect(within(notice).queryByTestId("batch-add-context-window-settings")).toBeNull();
    fireEvent.keyDown(within(notice).getByLabelText("上下文窗口"), { key: "ArrowDown" });
    expect(within(screen.getByRole("listbox", { name: "常用值" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["32K", "64K", "128K", "200K", "256K", "1M"]);
    fireEvent.change(within(notice).getByLabelText("上下文窗口"), { target: { value: "128000" } });
    fireEvent.click(within(notice).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByTestId("batch-add-context-window")).toBeNull());
    expect(overrides[0]?.path).toBe("/api/providers/p2/models/bare/override");
    expect(add.disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(add));
    fireEvent.click(add);
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/contents/import")).toBe(true));
  });

  it("asks nothing when the default model has its window", async () => {
    routes("m1");
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.change(screen.getByRole("textbox", { name: "批量添加到合集" }), { target: { value: VIDEO } });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "添加" }).disabled).toBe(false));
    expect(screen.queryByTestId("batch-add-context-window")).toBeNull();
  });
});

describe("BatchAddDialog reading links", () => {
  function importRoutes() {
    return mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "主力", ["m1"])] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "m1" } } },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
  }

  const box = (): HTMLTextAreaElement => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "批量添加到合集" });
  const add = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>("button", { name: "添加" });

  async function sent(calls: RecordedCall[], text: string): Promise<{ urls: string[]; scope: string | null }> {
    fireEvent.change(box(), { target: { value: text } });
    const scope = screen.queryByTestId("link-recognition")?.textContent ?? null;
    await waitFor(() => expect(add().disabled).toBe(false));
    fireEvent.click(add());
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/import")).toBe(true));
    const body = calls.find((call) => call.path === "/api/contents/import")?.body as { items: Array<{ url: string }>; collection: unknown; confirmCollections: unknown };
    expect(body.collection).toEqual({ id: "col1" });
    expect(body.confirmCollections).toBe(true);
    return { urls: body.items.map((item) => item.url), scope };
  }

  it("sends links alone as they are, saying only that they go as a batch", async () => {
    const { calls } = importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    expect(await sent(calls, `${VIDEO}\n${SHARE_VIDEO}`)).toEqual({ urls: [VIDEO, SHARE_VIDEO], scope: "已识别 2 条链接，将作为一批导入" });
  });

  it("sends only the supported links when other links or words are around, and says so", async () => {
    const { calls } = importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    expect(await sent(calls, `${WEB_SHARE}\n${UNSUPPORTED}\n备注`)).toEqual({ urls: [WEB_SHARE_LINK], scope: "已识别 1 条链接，另有 1 条不支持、不会提交·查看" });
  });

  it("sends every line as written when no link is supported, for the server to judge", async () => {
    const { calls } = importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    expect(await sent(calls, ` ${UNSUPPORTED} \n看这个`)).toEqual({ urls: [UNSUPPORTED, "看这个"], scope: null });
  });

  it("sends nothing while empty", async () => {
    importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.change(box(), { target: { value: "  \n " } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(add().disabled).toBe(true);
  });

  it("turns a pasted share text into its links, with a note that goes on the next edit", async () => {
    importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.paste(box(), { clipboardData: { getData: () => `${WEB_SHARE}\n${APP_SHARE}` } });
    expect(box().value).toBe(`${WEB_SHARE_LINK}\n${SHORT}`);
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已从分享内容中提取 2 条链接");
    expect(screen.queryByTestId("link-recognition-toggle")).toBeNull();
    fireEvent.change(box(), { target: { value: `${box().value}\n` } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 2 条链接，将作为一批导入");
  });

  it("clears the paste note with the text once the links are added", async () => {
    const { calls } = importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.paste(box(), { clipboardData: { getData: () => WEB_SHARE } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已从分享内容中提取 1 条链接");
    await waitFor(() => expect(add().disabled).toBe(false));
    fireEvent.click(add());
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/import")).toBe(true));
    await waitFor(() => expect(box().value).toBe(""));
    expect(screen.queryByTestId("link-recognition")).toBeNull();
  });
});

describe("BatchAddDialog with a collection link", () => {
  const LIST = "https://www.youtube.com/playlist?list=PLabcdefghij0123456789";

  it("chooses from the collection in the preview, judged against this collection, and adds the choice to it", async () => {
    const inspect = fakeInspect([{ url: LIST, title: "示例播放列表", pageSize: 50, entries: [...newEntries(2, "y"), { id: "y3", title: "第 3 讲", state: "in_collection" }] }]);
    const onOpenChange = vi.fn();
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "主力", ["m1"])] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "m1" } } },
      "POST /api/contents/inspect": inspect.reply,
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"], collectionIds: ["col1"] } },
    });
    renderApp(<BatchAddDialog open onOpenChange={onOpenChange} collectionId="col1" />);
    fireEvent.change(screen.getByRole("textbox", { name: "批量添加到合集" }), { target: { value: `${VIDEO}\n${LIST}` } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 1 个合集，开始处理前可以挑选内容并安排顺序");
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "添加" });
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    const dialog = await screen.findByTestId("collection-preview");
    await waitFor(() => expect(within(dialog).getAllByTestId("preview-entry")).toHaveLength(3));
    // The batch dialog steps aside while the preview is open.
    expect(screen.queryByRole("textbox", { name: "批量添加到合集" })).toBeNull();
    expect(inspect.requests[0]).toEqual({ url: LIST, collectionId: "col1" });
    expect(within(dialog).getAllByTestId("preview-entry").map((row) => row.dataset["chosen"])).toEqual(["true", "true", "false"]);
    expect(within(dialog).getByText("已在此合集")).toBeTruthy();
    // 「取消」 comes back to the batch dialog with its text.
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "批量添加到合集" })).value).toBe(`${VIDEO}\n${LIST}`);
    fireEvent.click(screen.getByRole("button", { name: "预览合集" }));
    const again = await screen.findByTestId("collection-preview");
    await waitFor(() => expect(within(again).getByTestId<HTMLButtonElement>("preview-submit").disabled).toBe(false));
    fireEvent.click(within(again).getByTestId("preview-submit"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const post = calls.find((call) => call.path === "/api/contents/import");
    expect(post?.body).toMatchObject({
      items: [{ url: VIDEO }, { url: LIST, entries: ["y1", "y2"], previewId: "pv1" }],
      collection: { id: "col1" },
      confirmCollections: true,
    });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
  });

  it("reads the collection afresh after an import, showing what was added as already in this collection", async () => {
    const collection = { url: LIST, pageSize: 50, entries: [...newEntries(2, "y"), { id: "y3", title: "第 3 讲", state: "in_collection" as const }] };
    const inspect = fakeInspect([collection]);
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "主力", ["m1"])] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "m1" } } },
      "POST /api/contents/inspect": inspect.reply,
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"], collectionIds: ["col1"] } },
    });
    // Mounted for good with its collection page, as the page holds it; only `open` changes.
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-testid="reopen" onClick={() => setOpen(true)} />
          <BatchAddDialog open={open} onOpenChange={setOpen} collectionId="col1" />
        </>
      );
    }
    renderApp(<Host />);
    const addLink = async (): Promise<HTMLElement> => {
      fireEvent.change(screen.getByRole("textbox", { name: "批量添加到合集" }), { target: { value: LIST } });
      const add = screen.getByRole<HTMLButtonElement>("button", { name: "添加" });
      await waitFor(() => expect(add.disabled).toBe(false));
      fireEvent.click(add);
      return screen.findByTestId("collection-preview");
    };
    const states = (dialog: HTMLElement): Array<string | undefined> => within(dialog).getAllByTestId("preview-entry").map((row) => row.dataset["chosen"]);
    const first = await addLink();
    await waitFor(() => expect(states(first)).toEqual(["true", "true", "false"]));
    await waitFor(() => expect(within(first).getByTestId<HTMLButtonElement>("preview-submit").disabled).toBe(false));
    fireEvent.click(within(first).getByTestId("preview-submit"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "批量添加到合集" })).toBeNull());
    expect(calls.filter((call) => call.path === "/api/contents/import")).toHaveLength(1);
    // The two imported entries are in this collection now.
    collection.entries = collection.entries.map((entry) => ({ ...entry, state: "in_collection" as const }));
    fireEvent.click(screen.getByTestId("reopen"));
    const again = await addLink();
    await waitFor(() => expect(inspect.requests).toHaveLength(2));
    await waitFor(() => expect(states(again)).toEqual(["false", "false", "false"]));
    expect(within(again).getAllByText("已在此合集")).toHaveLength(3);
    expect(within(again).getByTestId<HTMLButtonElement>("preview-submit").disabled).toBe(true);
  });

  it("opens the preview for a short link the server found to be a collection", async () => {
    const inspect = fakeInspect([{ url: SHORT, pageSize: 50, entries: newEntries(1, "BV1s") }]);
    let attempts = 0;
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "主力", ["m1"])] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "m1" } } },
      "POST /api/contents/inspect": inspect.reply,
      "POST /api/contents/import": () => {
        attempts += 1;
        return attempts === 1
          ? {
              status: 400,
              body: { error: { class: "invalid_request", code: "invalid_request.collection_choice_required", retryDisposition: "never", userMessage: "导入合集前请先预览并选择要导入的内容", details: { urls: [SHORT] } } },
            }
          : { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } };
      },
    });
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.change(screen.getByRole("textbox", { name: "批量添加到合集" }), { target: { value: SHORT } });
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "添加" });
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    const dialog = await screen.findByTestId("collection-preview");
    await waitFor(() => expect(within(dialog).getByTestId<HTMLButtonElement>("preview-submit").disabled).toBe(false));
    expect(inspect.requests[0]).toEqual({ url: SHORT, collectionId: "col1" });
    fireEvent.click(within(dialog).getByTestId("preview-submit"));
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/import")).toHaveLength(2));
    expect(calls.filter((call) => call.path === "/api/contents/import")[1]?.body).toMatchObject({ items: [{ url: SHORT, entries: ["BV1s1"], previewId: "pv1" }] });
  });
});
