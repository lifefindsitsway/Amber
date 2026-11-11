import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../src/web/api/client.ts";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { NewPage, routeAfterImport } from "../../../src/web/pages/new-page.tsx";
import { useOpenTasksRequest } from "../../../src/web/shell/task-panel.tsx";
import { baseRoutes, content, provider, SETTINGS } from "../../fixtures/web/shell-data.ts";
import { fakeShell, pickedFile } from "../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const VIDEO = "https://www.youtube.com/watch?v=UF8uR6Z6KLc";
const MULTI_P = "https://www.bilibili.com/video/BV1CQt365EzW";

function Where(props: { onOpenTasks?: () => void }) {
  const location = useLocation();
  useOpenTasksRequest(props.onOpenTasks ?? (() => undefined));
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function ClientProbe(props: { onClient: (client: QueryClient) => void }) {
  props.onClient(useQueryClient());
  return null;
}

function page(onOpenTasks?: () => void, onClient?: (client: QueryClient) => void) {
  return (
    <>
      <NewPage />
      <Where {...(onOpenTasks === undefined ? {} : { onOpenTasks })} />
      {onClient === undefined ? null : <ClientProbe onClient={onClient} />}
    </>
  );
}

const TRASH_LIST = [...queryKeys.trash, "list"];
const PLAYLIST = "https://www.youtube.com/playlist?list=PL1";

describe("NewPage", () => {
  it("imports one link with this run's settings and opens its detail page", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1"])] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "m1" }, defaultOutputLanguage: "en" } },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    renderApp(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    await waitFor(() => expect((screen.getByLabelText("AI 模型") as HTMLSelectElement).value).toBe(JSON.stringify(["p1", "m1"])));
    await waitFor(() => expect((screen.getByLabelText("输出语言") as HTMLSelectElement).value).toBe("en"));
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: `  ${VIDEO}  \n` } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    const post = calls.find((call) => call.method === "POST" && call.path === "/api/contents/import");
    expect(post?.body).toEqual({
      items: [{ url: VIDEO }],
      settings: { templateId: "summary.core", outputLanguage: "en", autoProofread: true, modelRef: { providerProfileId: "p1", modelId: "m1" } },
    });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
    expect(screen.queryByTestId("no-llm-banner")).toBeNull();
  });

  it("shows the first-run banner without an LLM profile and still submits", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    renderApp(page(), { route: "/new" });
    expect(await screen.findByTestId("no-llm-banner")).toBeTruthy();
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect((calls.find((call) => call.method === "POST")?.body as { settings: object }).settings).not.toHaveProperty("modelRef");
  });

  it("asks which parts of a multi-part submission to import, then resubmits with the choice", async () => {
    let attempts = 0;
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 400, body: { error: { class: "invalid_request", code: "invalid_request.multipart_choice_required", retryDisposition: "never", userMessage: "该稿件有多个分 P", details: { parts: ["a", "b", "c"] } } } }
          : { status: 202, body: { importBatchId: "b2", taskIds: ["t1", "t2", "t3"], contentIds: ["c1", "c2", "c3"] } };
      },
      "POST /api/contents/inspect": {
        body: {
          kind: "multipart",
          canonicalUrl: MULTI_P,
          title: "多 P 稿件",
          parts: [1, 2, 3].map((index) => ({ platformPartId: `p${index}`, index, title: `P${index}`, durationMs: 1000 })),
        },
      },
    });
    const onOpenTasks = vi.fn();
    renderApp(page(onOpenTasks), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: MULTI_P } });
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByTestId("parts-choice")).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/contents/inspect")?.body).toEqual({ url: MULTI_P });
    fireEvent.click(screen.getByLabelText("导入全部 3 个分 P"));
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/library?importBatchId=b2"));
    expect(calls.filter((call) => call.path === "/api/contents/import").at(-1)?.body).toMatchObject({ items: [{ url: MULTI_P, parts: "all" }] });
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it("shows the local-file tab disabled in local mode and the upload tab only in server mode", async () => {
    mockApi(baseRoutes());
    const { unmount } = renderApp(page(), { route: "/new" });
    const local = await screen.findByRole("tab", { name: "选择本地文件" });
    expect(local.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("tab", { name: "上传本地文件" })).toBeNull();
    unmount();
    mockApi(baseRoutes({ mode: "server" }));
    renderApp(page(), { route: "/new" });
    expect(await screen.findByRole("tab", { name: "上传本地文件" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "选择本地文件" })).toBeNull();
  });

  it("uploads a file with its subtitle in the fixed part order and offers a duplicate retry", async () => {
    let duplicate = true;
    const { calls } = mockApi({
      ...baseRoutes({ mode: "server" }),
      "POST /api/contents/upload": () =>
        duplicate
          ? {
              status: 409,
              body: { error: { class: "conflict", code: "conflict.duplicate_file", retryDisposition: "never", userMessage: "已有相同的文件，可选择仍然导入", details: { duplicateOfContentId: "c0" } } },
            }
          : { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c7"] } },
    });
    renderApp(page(), { route: "/new", mode: "server" });
    const tab = await screen.findByRole("tab", { name: "上传本地文件" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.click(await screen.findByTestId("new-submit"));
    expect(await screen.findByText("请选择要上传的文件")).toBeTruthy();
    const media = new File([new Uint8Array([1, 2, 3])], "lecture.mp4", { type: "video/mp4" });
    const subtitle = new File(["1\n00:00:00,000 --> 00:00:01,000\nhi\n"], "lecture.srt");
    fireEvent.change(screen.getByTestId("upload-file"), { target: { files: [media] } });
    fireEvent.change(screen.getByTestId("upload-subtitle"), { target: { files: [subtitle] } });
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("附带字幕时请选择字幕语言")).toBeTruthy();
    fireEvent.change(screen.getByTestId("upload-subtitle-language"), { target: { value: "en" } });
    fireEvent.click(screen.getByTestId("new-submit"));
    fireEvent.click(await screen.findByTestId("upload-anyway"));
    duplicate = false;
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c7"));
    const uploads = calls.filter((call) => call.path === "/api/contents/upload");
    expect(uploads[0]?.form?.map(([name]) => name)).toEqual(["settings", "subtitleLanguage", "subtitle", "file"]);
    expect(uploads.at(-1)?.form?.map(([name]) => name)).toEqual(["settings", "allowDuplicate", "subtitleLanguage", "subtitle", "file"]);
    expect(JSON.parse(String(uploads[0]?.form?.[0]?.[1]))).toMatchObject({ templateId: "summary.core", autoProofread: true });
    expect(uploads[0]?.headers["x-amber-request"]).toBe("1");
    expect(uploads[0]?.headers["idempotency-key"]).toBeTruthy();
    expect((uploads[0]?.form?.at(-1)?.[1] as File).name).toBe("lecture.mp4");
  });
});

describe("NewPage and the trash", () => {
  it("refreshes the trash and collection pages after a link import, since a direct link restores a trashed Content", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"], skippedTrashedContentIds: [] } },
    });
    let client: QueryClient | undefined;
    renderApp(page(undefined, (value) => (client = value)), { route: "/new" });
    client?.setQueryData(TRASH_LIST, { pages: [] });
    client?.setQueryData(queryKeys.collection("k1"), { items: [] });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    expect(client?.getQueryState(TRASH_LIST)?.isInvalidated).toBe(true);
    expect(client?.getQueryState(queryKeys.collection("k1"))?.isInvalidated).toBe(true);
    expect(screen.queryByTestId("new-skipped-trashed")).toBeNull();
  });

  it("stays on the page to say how many items were skipped for being in the trash, linking to it and to what was imported", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"], skippedTrashedContentIds: ["c8", "c9"] } },
      "GET /api/contents/c1": { body: { ...content("c1", { collections: [{ id: "k7", name: "播放列表", itemId: "ki7" }] }), media: [] } },
    });
    renderApp(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: PLAYLIST } });
    fireEvent.click(screen.getByTestId("new-submit"));
    const notice = await screen.findByTestId("new-skipped-trashed");
    expect(notice.textContent).toContain("2 项在回收站中，未导入");
    expect(within(notice).getByRole("link", { name: "打开回收站" }).getAttribute("href")).toBe("/trash");
    expect(within(notice).getByRole("link", { name: "查看已导入的内容" }).getAttribute("href")).toBe("/collections/k7");
    expect(screen.getByTestId("where").textContent).toBe("/new");
    expect(calls.filter((call) => call.path === "/api/contents/import")).toHaveLength(1);
    fireEvent.click(within(notice).getByRole("link", { name: "查看已导入的内容" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k7"));
  });

  it("offers only the trash when every item was skipped", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: [], contentIds: [], skippedTrashedContentIds: ["c9"] } },
    });
    renderApp(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    const notice = await screen.findByTestId("new-skipped-trashed");
    expect(notice.textContent).toContain("1 项在回收站中，未导入");
    expect(within(notice).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/trash"]);
    expect(screen.getByTestId("where").textContent).toBe("/new");
  });

  it("says when the duplicate of an uploaded file is in the trash, still offering to upload anyway", async () => {
    let duplicate = true;
    let client: QueryClient | undefined;
    mockApi({
      ...baseRoutes({ mode: "server" }),
      "POST /api/contents/upload": () =>
        duplicate
          ? {
              status: 409,
              body: { error: { class: "conflict", code: "conflict.duplicate_file", retryDisposition: "never", userMessage: "已有相同的文件，可选择仍然导入", details: { duplicateOfContentId: "c0", trashed: true } } },
            }
          : { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c7"] } },
    });
    renderApp(page(undefined, (value) => (client = value)), { route: "/new", mode: "server" });
    const tab = await screen.findByRole("tab", { name: "上传本地文件" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.change(await screen.findByTestId("upload-file"), { target: { files: [new File([new Uint8Array([1])], "lecture.mp4", { type: "video/mp4" })] } });
    fireEvent.click(screen.getByTestId("new-submit"));
    const notice = await screen.findByTestId("new-duplicate-in-trash");
    expect(notice.textContent).toContain("相同文件的内容在回收站中，可以去回收站恢复它，或选择仍然导入");
    expect(within(notice).getByRole("link", { name: "打开回收站" }).getAttribute("href")).toBe("/trash");
    client?.setQueryData(TRASH_LIST, { pages: [] });
    duplicate = false;
    fireEvent.click(screen.getByTestId("upload-anyway"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c7"));
    expect(client?.getQueryState(TRASH_LIST)?.isInvalidated).toBe(true);
  });
});

describe("NewPage in the desktop client", () => {
  const MEDIA = "D:\\课程\\第一讲.mp4";
  const SUBTITLE = "D:\\课程\\第一讲.srt";

  async function openLocalTab() {
    const tab = await screen.findByRole("tab", { name: "选择本地文件" });
    await waitFor(() => expect(tab.hasAttribute("disabled")).toBe(false));
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    return screen.findByTestId("local-pick");
  }

  it("references a picked file with an optional subtitle and opens the new Content", async () => {
    fakeShell.desktop = true;
    fakeShell.pickLocalFile.mockResolvedValueOnce(null).mockResolvedValueOnce(pickedFile(MEDIA)).mockResolvedValueOnce(pickedFile(SUBTITLE));
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/local-file": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c9"] } },
    });
    renderApp(page(), { route: "/new" });
    const pick = await openLocalTab();
    expect(screen.queryByText("选择本地文件需要在 Amber 客户端中进行。")).toBeNull();
    // A cancelled dialog changes nothing.
    fireEvent.click(pick);
    await waitFor(() => expect(fakeShell.pickLocalFile).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("local-file-name").textContent).toBe("尚未选择文件");
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("请先选择本地音视频文件")).toBeTruthy();
    fireEvent.click(pick);
    await waitFor(() => expect(screen.getByTestId("local-file-name").textContent).toBe("第一讲.mp4"));
    fireEvent.click(screen.getByTestId("local-pick-subtitle"));
    expect((await screen.findByTestId("local-subtitle-name")).textContent).toBe("第一讲.srt");
    expect(fakeShell.pickLocalFile.mock.calls.map(([kind]) => kind)).toEqual(["media", "media", "subtitle"]);
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("附带字幕时请选择字幕语言")).toBeTruthy();
    fireEvent.change(screen.getByTestId("local-subtitle-language"), { target: { value: "zh-CN" } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c9"));
    const post = calls.find((call) => call.path === "/api/contents/local-file");
    expect(post?.body).toEqual({
      path: MEDIA,
      grant: expect.objectContaining({ path: MEDIA, purpose: "local_file", sig: "test-signature" }),
      settings: { templateId: "summary.core", outputLanguage: "zh-CN", autoProofread: true },
      allowDuplicate: false,
      initialSubtitle: { path: SUBTITLE, grant: expect.objectContaining({ path: SUBTITLE }), language: "zh-CN" },
    });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
  });

  it("offers to import a duplicate anyway", async () => {
    fakeShell.desktop = true;
    fakeShell.pickLocalFile.mockResolvedValue(pickedFile(MEDIA));
    let duplicate = true;
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/local-file": () =>
        duplicate
          ? {
              status: 409,
              body: { error: { class: "conflict", code: "conflict.duplicate_file", retryDisposition: "never", userMessage: "已有相同的文件，可选择仍然导入", details: { duplicateOfContentId: "c0" } } },
            }
          : { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c8"] } },
    });
    renderApp(page(), { route: "/new" });
    fireEvent.click(await openLocalTab());
    await waitFor(() => expect(screen.getByTestId("local-file-name").textContent).toBe("第一讲.mp4"));
    fireEvent.click(screen.getByTestId("new-submit"));
    const anyway = await screen.findByTestId("local-anyway");
    expect(anyway.textContent).toBe("仍然导入");
    expect(screen.queryByTestId("new-duplicate-in-trash")).toBeNull();
    duplicate = false;
    fireEvent.click(anyway);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c8"));
    const posts = calls.filter((call) => call.path === "/api/contents/local-file").map((call) => (call.body as { allowDuplicate: boolean }).allowDuplicate);
    expect(posts).toEqual([false, true]);
  });

  it("says when the duplicate of a picked file is in the trash and refreshes the trash after importing anyway", async () => {
    fakeShell.desktop = true;
    fakeShell.pickLocalFile.mockResolvedValue(pickedFile(MEDIA));
    let duplicate = true;
    let client: QueryClient | undefined;
    mockApi({
      ...baseRoutes(),
      "POST /api/contents/local-file": () =>
        duplicate
          ? {
              status: 409,
              body: { error: { class: "conflict", code: "conflict.duplicate_file", retryDisposition: "never", userMessage: "已有相同的文件，可选择仍然导入", details: { duplicateOfContentId: "c0", trashed: true } } },
            }
          : { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c8"] } },
    });
    renderApp(page(undefined, (value) => (client = value)), { route: "/new" });
    fireEvent.click(await openLocalTab());
    await waitFor(() => expect(screen.getByTestId("local-file-name").textContent).toBe("第一讲.mp4"));
    fireEvent.click(screen.getByTestId("new-submit"));
    const notice = await screen.findByTestId("new-duplicate-in-trash");
    expect(within(notice).getByRole("link", { name: "打开回收站" }).getAttribute("href")).toBe("/trash");
    client?.setQueryData(TRASH_LIST, { pages: [] });
    duplicate = false;
    fireEvent.click(screen.getByTestId("local-anyway"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c8"));
    expect(client?.getQueryState(TRASH_LIST)?.isInvalidated).toBe(true);
  });

  it("asks for a new pick when the grant is refused or already expired", async () => {
    fakeShell.desktop = true;
    fakeShell.pickLocalFile.mockResolvedValueOnce(pickedFile(MEDIA)).mockResolvedValueOnce(pickedFile(MEDIA, "local_file", -1));
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/local-file": {
        status: 401,
        body: { error: { class: "unauthenticated", code: "unauthenticated.file_grant", retryDisposition: "never", userMessage: "文件授权无效或已过期，请重新选择文件" } },
      },
    });
    renderApp(page(), { route: "/new" });
    const pick = await openLocalTab();
    fireEvent.click(pick);
    await waitFor(() => expect(screen.getByTestId("local-file-name").textContent).toBe("第一讲.mp4"));
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("文件授权无效或已过期，请重新选择文件")).toBeTruthy();
    expect(screen.getByTestId("local-file-name").textContent).toBe("尚未选择文件");
    // An expired grant is caught before anything is sent.
    fireEvent.click(pick);
    await waitFor(() => expect(screen.getByTestId("local-file-name").textContent).toBe("第一讲.mp4"));
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("文件授权已过期，请重新选择文件")).toBeTruthy();
    expect(calls.filter((call) => call.path === "/api/contents/local-file")).toHaveLength(1);
  });
});

describe("routeAfterImport", () => {
  const api = new ApiClient({ baseUrl: "" }, "local");
  const batch = { importBatchId: "b", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"] };

  it("routes a platform list to the collection the import created", async () => {
    mockApi({ "GET /api/contents/c1": { body: { ...content("c1", { collections: [{ id: "k7", name: "播放列表", itemId: "ki7" }] }), media: [] } } });
    await expect(routeAfterImport({ api, response: batch, lines: ["https://www.youtube.com/playlist?list=PL1"], collection: undefined })).resolves.toEqual({ path: "/collections/k7", openTasks: false });
  });

  it("routes into a chosen existing collection without asking the server", async () => {
    const { calls } = mockApi({});
    await expect(routeAfterImport({ api, response: batch, lines: [VIDEO, VIDEO], collection: { id: "k1" } })).resolves.toEqual({ path: "/collections/k1", openTasks: false });
    expect(calls).toHaveLength(0);
  });

  it("finds a newly named collection by name", async () => {
    mockApi({ "GET /api/contents/c1": { body: { ...content("c1", { collections: [{ id: "old", name: "旧", itemId: "kio" }, { id: "k8", name: "新课", itemId: "ki8" }] }), media: [] } } });
    await expect(routeAfterImport({ api, response: batch, lines: [VIDEO, VIDEO], collection: { name: "新课" } })).resolves.toEqual({ path: "/collections/k8", openTasks: false });
  });

  it("sends loose items to the library filtered by batch, with the task panel open", async () => {
    mockApi({});
    await expect(routeAfterImport({ api, response: batch, lines: [VIDEO, VIDEO], collection: undefined })).resolves.toEqual({ path: "/library?importBatchId=b", openTasks: true });
  });
});

describe("NewPage transcription model", () => {
  const asr = (id: string, name: string) => ({
    id,
    name,
    provider: "dashscope",
    models: [
      { modelId: "qwen-audio-3.1-asr-flash-filetrans", available: true },
      { modelId: "fun-asr", available: true },
    ],
    baseURL: "https://dashscope.aliyuncs.com",
    credentialStatus: "configured",
    hasCredential: true,
    inUse: false,
    createdAt: 1,
  });
  const key = (asrProfileId: string, modelId: string) => JSON.stringify([asrProfileId, modelId]);

  async function submittedAsr(
    routes: Record<string, unknown>,
    pick?: string,
  ): Promise<{ shown: string | undefined; first: string | undefined; sent: unknown }> {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
      ...(routes as Record<string, { body: unknown }>),
    });
    renderApp(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/asr-profiles")).toBe(true));
    // Give the list time to arrive before reading what the picker shows.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const select = screen.queryByLabelText("转录模型") as HTMLSelectElement | null;
    const shown = select?.value;
    if (pick !== undefined && select !== null) fireEvent.change(select, { target: { value: pick } });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/contents/import")).toBe(true));
    const post = calls.find((call) => call.method === "POST" && call.path === "/api/contents/import");
    return { shown, first: select?.options[0]?.textContent ?? undefined, sent: (post?.body as { settings: { asrModelRef?: unknown } }).settings.asrModelRef };
  }

  it("preselects the default model", async () => {
    const result = await submittedAsr({
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号"), asr("a2", "二号")] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultAsrModelRef: { asrProfileId: "a2", modelId: "fun-asr" } } },
    });
    expect(result).toEqual({ shown: key("a2", "fun-asr"), first: "暂不选择（需要转录时将等待配置）", sent: { asrProfileId: "a2", modelId: "fun-asr" } });
  });

  it("chooses nothing when no default is set, and sends no model", async () => {
    expect(await submittedAsr({ "GET /api/asr-profiles": { body: { items: [asr("a1", "一号"), asr("a2", "二号")] } } })).toEqual({
      shown: "",
      first: "暂不选择（需要转录时将等待配置）",
      sent: undefined,
    });
  });

  it("chooses nothing when the default model is gone", async () => {
    const result = await submittedAsr({
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号")] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultAsrModelRef: { asrProfileId: "gone", modelId: "fun-asr" } } },
    });
    expect(result.shown).toBe("");
    expect(result.sent).toBeUndefined();
  });

  it("sends a model the user picks, and none when the user clears the default", async () => {
    const routes = {
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号")] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultAsrModelRef: { asrProfileId: "a1", modelId: "fun-asr" } } },
    };
    expect((await submittedAsr(routes, key("a1", "qwen-audio-3.1-asr-flash-filetrans"))).sent).toEqual({ asrProfileId: "a1", modelId: "qwen-audio-3.1-asr-flash-filetrans" });
    cleanup();
    expect((await submittedAsr(routes, "")).sent).toBeUndefined();
  });

  it("hides the picker and sends no model without any profile", async () => {
    expect(await submittedAsr({ "GET /api/asr-profiles": { body: { items: [] } } })).toEqual({ shown: undefined, first: undefined, sent: undefined });
  });
});

describe("NewPage speaker identification note", () => {
  const profile = (provider: string, modelId: string, extra: Record<string, unknown> = {}) => ({
    id: "a1",
    name: "转录",
    provider,
    models: [{ modelId, available: true }],
    ...extra,
    credentialStatus: "configured",
    hasCredential: true,
    inUse: false,
    createdAt: 1,
  });
  const ref = { asrProfileId: "a1", modelId: "fun-asr" };

  async function noteFor(items: unknown[], settings: Record<string, unknown>): Promise<string | null> {
    mockApi({
      ...baseRoutes(),
      "GET /api/asr-profiles": { body: { items } },
      "GET /api/settings": { body: { ...SETTINGS, ...settings } },
    });
    renderApp(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    await waitFor(() => expect(screen.queryByTestId("new-asr-model")).not.toBeNull());
    // Both queries have to land before the note can be told from "not yet".
    await new Promise((resolve) => setTimeout(resolve, 20));
    return screen.queryByTestId("new-diarization-note")?.textContent ?? null;
  }

  it("says the model will identify speakers when the setting is on and the model offers it", async () => {
    expect(await noteFor([profile("dashscope", "fun-asr")], { asrDiarization: true, defaultAsrModelRef: ref })).toBe("将识别发言人");
  });

  it("says a model without identification does not identify, whatever the content length", async () => {
    expect(await noteFor([profile("dashscope", "typed-in-model")], { asrDiarization: true, defaultAsrModelRef: { asrProfileId: "a1", modelId: "typed-in-model" } })).toBe("此模型不识别发言人");
  });

  it("says nothing while the setting is off or no model is chosen", async () => {
    expect(await noteFor([profile("dashscope", "fun-asr")], { asrDiarization: false, defaultAsrModelRef: ref })).toBeNull();
    cleanup();
    expect(await noteFor([profile("dashscope", "fun-asr")], { asrDiarization: true })).toBeNull();
  });
});
