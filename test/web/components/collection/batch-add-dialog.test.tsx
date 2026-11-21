import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BatchAddDialog } from "../../../../src/web/components/collection/batch-add-dialog.tsx";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";
import { APP_SHARE, SHORT, UNSUPPORTED, VIDEO as SHARE_VIDEO, WEB_SHARE, WEB_SHARE_LINK } from "../../../fixtures/platform/share-text.ts";
import { baseRoutes, provider, SETTINGS } from "../../../fixtures/web/shell-data.ts";
import { providerWithoutWindow, windowRoutes } from "../../../fixtures/web/context-window.ts";

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
    const scope = screen.queryByTestId("link-scope")?.textContent ?? null;
    await waitFor(() => expect(add().disabled).toBe(false));
    fireEvent.click(add());
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/import")).toBe(true));
    const body = calls.find((call) => call.path === "/api/contents/import")?.body as { items: Array<{ url: string }>; collection: unknown };
    expect(body.collection).toEqual({ id: "col1" });
    return { urls: body.items.map((item) => item.url), scope };
  }

  it("sends links alone as they are, with nothing beside the action", async () => {
    const { calls } = importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    expect(await sent(calls, `${VIDEO}\n${SHARE_VIDEO}`)).toEqual({ urls: [VIDEO, SHARE_VIDEO], scope: null });
  });

  it("sends only the supported links when other links or words are around, and says so", async () => {
    const { calls } = importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    expect(await sent(calls, `${WEB_SHARE}\n${UNSUPPORTED}\n备注`)).toEqual({ urls: [WEB_SHARE_LINK], scope: "将处理 1 条链接，另有 1 条未加入·查看" });
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
    expect(screen.getByTestId("batch-add-paste-note").textContent).toBe("已提取分享内容里的 2 条链接");
    expect(screen.queryByTestId("link-scope")).toBeNull();
    fireEvent.change(box(), { target: { value: `${box().value}\n` } });
    expect(screen.queryByTestId("batch-add-paste-note")).toBeNull();
  });

  it("clears the paste note with the text once the links are added", async () => {
    const { calls } = importRoutes();
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.paste(box(), { clipboardData: { getData: () => WEB_SHARE } });
    expect(screen.getByTestId("batch-add-paste-note")).toBeTruthy();
    await waitFor(() => expect(add().disabled).toBe(false));
    fireEvent.click(add());
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/import")).toBe(true));
    await waitFor(() => expect(box().value).toBe(""));
    expect(screen.queryByTestId("batch-add-paste-note")).toBeNull();
  });
});
