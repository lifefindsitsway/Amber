import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../src/web/api/client.ts";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { NewPage, routeAfterImport } from "../../../src/web/pages/new-page.tsx";
import { useOpenTasksRequest } from "../../../src/web/shell/task-panel.tsx";
import { usePasteGuard } from "../../../src/web/shell/paste-guard.ts";
import { baseRoutes, collection, content, provider, SETTINGS } from "../../fixtures/web/shell-data.ts";
import { fakeShell, pickedFile } from "../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";

type RecordedCalls = RecordedCall[];
import { DIGEST, packagePreview, prefixPreview, srtPreview } from "../../fixtures/web/subtitle-preview.ts";
import { providerWithoutWindow, windowRoutes } from "../../fixtures/web/context-window.ts";
import { chooseOption, selectOptionNames, stubSelectLayout } from "../../fixtures/web/select.ts";
import {
  APP_SHARE,
  DOUYIN_COLLECTION,
  DOUYIN_ID,
  DOUYIN_SHARE,
  DOUYIN_SHORT,
  DOUYIN_VIDEO,
  LONG_SHARE,
  SHORT,
  UNSUPPORTED,
  VIDEO_2,
  WEB_SHARE,
  WEB_SHARE_LINK,
  XHS_NOTE,
  XHS_VIDEO,
  YT_LIST,
  YT_VIDEO,
} from "../../fixtures/platform/share-text.ts";
import { IMPORT_CHECK_DEBOUNCE_MS, IMPORT_CHECK_QUIET_MS } from "../../../src/shared/defaults.ts";
import type { InspectRequest } from "../../../src/shared/dto/import.ts";
import { fakeInspect, newEntries, STALE_REPLY } from "../../fixtures/web/collection-preview.ts";

beforeEach(stubSelectLayout);

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
const PLAYLIST = "https://www.youtube.com/playlist?list=PL1234567890";

/** One page of a playlist preview: `count` new entries, `yt<n>`. */
function playlistPage(url: string, count: number, extra: Record<string, unknown> = {}) {
  return {
    kind: "collection",
    canonicalUrl: url,
    title: "播放列表",
    previewId: "pv1",
    itemCount: count,
    offset: 0,
    items: Array.from({ length: count }, (_, index) => ({
      platformContentId: `yt${index + 1}`,
      canonicalUrl: `https://www.youtube.com/watch?v=yt${index + 1}`,
      title: `第 ${index + 1} 讲`,
      durationMs: 600_000,
      index,
      state: "new",
    })),
    ...extra,
  };
}

/** Renders the page and waits, as a user would, until the settings and the model list are read. */
async function openPage(ui: Parameters<typeof renderApp>[0], options: Parameters<typeof renderApp>[1]) {
  const result = renderApp(ui, options);
  await waitFor(() => expect(document.querySelector("form[data-gate]")?.getAttribute("data-gate")).not.toBe("loading"));
  return result;
}

/** Waits for the collection preview to be read, then presses its 「开始处理」. */
async function confirmPreview(): Promise<void> {
  const dialog = await screen.findByTestId("collection-preview");
  const start = await within(dialog).findByTestId("preview-submit");
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
}

describe("NewPage", () => {
  it("imports one link with this run's settings and opens its detail page", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1"])] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "m1" }, defaultOutputLanguage: "en" } },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "AI 模型" }).textContent).toBe("我的模型 · m1"));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "输出语言" }).textContent).toBe("英语"));
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: `  ${VIDEO}  \n` } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    const post = calls.find((call) => call.method === "POST" && call.path === "/api/contents/import");
    expect(post?.body).toEqual({
      items: [{ url: VIDEO }],
      settings: { templateId: "summary.core", outputLanguage: "en", autoProofread: true, modelRef: { providerProfileId: "p1", modelId: "m1" } },
      confirmCollections: true,
    });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
    expect(screen.queryByTestId("no-llm-banner")).toBeNull();
  });

  it("shows the first-run banner without an LLM profile and still submits", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    await openPage(page(), { route: "/new" });
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
    await openPage(page(onOpenTasks), { route: "/new" });
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
    const { unmount } = await openPage(page(), { route: "/new" });
    const local = await screen.findByRole("tab", { name: "选择本地文件" });
    expect(local.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("tab", { name: "上传本地文件" })).toBeNull();
    unmount();
    mockApi(baseRoutes({ mode: "server" }));
    await openPage(page(), { route: "/new" });
    expect(await screen.findByRole("tab", { name: "上传本地文件" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "选择本地文件" })).toBeNull();
  });

  it("keeps the submit label while busy and says beside it whether a file uploads or links are submitted", async () => {
    mockApi({
      ...baseRoutes({ mode: "server" }),
      "POST /api/contents/upload": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c7"] } },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b2", taskIds: ["t2"], contentIds: ["c8"] } },
    });
    // Each request waits until released, so the busy state is seen.
    const base = globalThis.fetch;
    const gates = new Map<string, () => void>();
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/contents/upload" || path === "/api/contents/import") await new Promise<void>((resolve) => gates.set(path, resolve));
      return base(input, init);
    });
    const { unmount } = await openPage(page(), { route: "/new", mode: "server" });
    const tab = await screen.findByRole("tab", { name: "上传本地文件" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.change(await screen.findByTestId("upload-file"), { target: { files: [new File([new Uint8Array([1])], "lecture.mp4", { type: "video/mp4" })] } });
    expect(screen.queryByTestId("new-submit-status")).toBeNull();
    fireEvent.click(screen.getByTestId("new-submit"));
    const button = screen.getByTestId("new-submit");
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.textContent).toBe("开始处理");
    const uploading = screen.getByTestId("new-submit-status");
    expect(uploading.getAttribute("role")).toBe("status");
    expect(uploading.textContent).toBe("上传中…");
    await waitFor(() => expect(gates.has("/api/contents/upload")).toBe(true));
    gates.get("/api/contents/upload")?.();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c7"));
    expect(screen.queryByTestId("new-submit-status")).toBeNull();
    unmount();
    await openPage(page(), { route: "/new", mode: "server" });
    fireEvent.change(await screen.findByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("new-submit").getAttribute("aria-busy")).toBe("true"));
    expect(screen.getByTestId("new-submit").textContent).toBe("开始处理");
    expect(screen.getByTestId("new-submit-status").textContent).toBe("提交中…");
    await waitFor(() => expect(gates.has("/api/contents/import")).toBe(true));
    gates.get("/api/contents/import")?.();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c8"));
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
    await openPage(page(), { route: "/new", mode: "server" });
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
    // With a subtitle attached and the checkbox untouched, the text is not rewritten by AI.
    expect(JSON.parse(String(uploads[0]?.form?.[0]?.[1]))).toMatchObject({ templateId: "summary.core", autoProofread: false });
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
    await openPage(page(undefined, (value) => (client = value)), { route: "/new" });
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
      "POST /api/contents/inspect": { body: playlistPage(PLAYLIST, 4) },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: PLAYLIST } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await confirmPreview();
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
    await openPage(page(), { route: "/new" });
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
    await openPage(page(undefined, (value) => (client = value)), { route: "/new", mode: "server" });
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
    await openPage(page(), { route: "/new" });
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
      settings: { templateId: "summary.core", outputLanguage: "zh-CN", autoProofread: false },
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
    await openPage(page(), { route: "/new" });
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
    await openPage(page(undefined, (value) => (client = value)), { route: "/new" });
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
    await openPage(page(), { route: "/new" });
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
    await expect(routeAfterImport({ api, response: batch, urls: ["https://www.youtube.com/playlist?list=PL1234567890"], collection: undefined })).resolves.toEqual({ path: "/collections/k7", openTasks: false });
  });

  it("routes into a chosen existing collection without asking the server", async () => {
    const { calls } = mockApi({});
    await expect(routeAfterImport({ api, response: batch, urls: [VIDEO, VIDEO], collection: { id: "k1" } })).resolves.toEqual({ path: "/collections/k1", openTasks: false });
    expect(calls).toHaveLength(0);
  });

  it("finds a newly named collection by name", async () => {
    mockApi({ "GET /api/contents/c1": { body: { ...content("c1", { collections: [{ id: "old", name: "旧", itemId: "kio" }, { id: "k8", name: "新课", itemId: "ki8" }] }), media: [] } } });
    await expect(routeAfterImport({ api, response: batch, urls: [VIDEO, VIDEO], collection: { name: "新课" } })).resolves.toEqual({ path: "/collections/k8", openTasks: false });
  });

  it("sends loose items to the library filtered by batch, with the task panel open", async () => {
    mockApi({});
    await expect(routeAfterImport({ api, response: batch, urls: [VIDEO, VIDEO], collection: undefined })).resolves.toEqual({ path: "/library?importBatchId=b", openTasks: true });
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
  const NONE = "暂不选择（需要转录时将等待配置）";

  async function submittedAsr(
    routes: Record<string, unknown>,
    pick?: { name: string; group?: string },
  ): Promise<{ shown: string | undefined; first: string | undefined; sent: unknown }> {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
      ...(routes as Record<string, { body: unknown }>),
    });
    await openPage(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/asr-profiles")).toBe(true));
    // Give the list time to arrive before reading what the picker shows.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const select = screen.queryByRole("combobox", { name: "转录模型" });
    const shown = select?.textContent ?? undefined;
    const first = select === null ? undefined : (await selectOptionNames(select))[0];
    if (pick !== undefined && select !== null) await chooseOption(select, pick.name, pick.group);
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/contents/import")).toBe(true));
    const post = calls.find((call) => call.method === "POST" && call.path === "/api/contents/import");
    return { shown, first, sent: (post?.body as { settings: { asrModelRef?: unknown } }).settings.asrModelRef };
  }

  it("preselects the default model", async () => {
    const result = await submittedAsr({
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号"), asr("a2", "二号")] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultAsrModelRef: { asrProfileId: "a2", modelId: "fun-asr" } } },
    });
    expect(result).toEqual({ shown: "二号 · fun-asr", first: NONE, sent: { asrProfileId: "a2", modelId: "fun-asr" } });
  });

  it("chooses nothing when no default is set, and sends no model", async () => {
    expect(await submittedAsr({ "GET /api/asr-profiles": { body: { items: [asr("a1", "一号"), asr("a2", "二号")] } } })).toEqual({
      shown: NONE,
      first: NONE,
      sent: undefined,
    });
  });

  it("chooses nothing when the default model is gone", async () => {
    const result = await submittedAsr({
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号")] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultAsrModelRef: { asrProfileId: "gone", modelId: "fun-asr" } } },
    });
    expect(result.shown).toBe(NONE);
    expect(result.sent).toBeUndefined();
  });

  it("sends a model the user picks, and none when the user clears the default", async () => {
    const routes = {
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号")] } },
      "GET /api/settings": { body: { ...SETTINGS, defaultAsrModelRef: { asrProfileId: "a1", modelId: "fun-asr" } } },
    };
    expect((await submittedAsr(routes, { name: "qwen-audio-3.1-asr-flash-filetrans" })).sent).toEqual({ asrProfileId: "a1", modelId: "qwen-audio-3.1-asr-flash-filetrans" });
    cleanup();
    expect((await submittedAsr(routes, { name: NONE })).sent).toBeUndefined();
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
    await openPage(page(), { route: "/new" });
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

describe("NewPage with a subtitle", () => {
  const SRT = "1\n00:00:00,000 --> 00:00:01,000\n张三：你好\n";

  async function openTab(name: string) {
    const tab = await screen.findByRole("tab", { name });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
  }

  function settingsCheckbox(): HTMLInputElement | null {
    return screen.queryByRole("checkbox", { name: "自动校对" }) as HTMLInputElement | null;
  }

  it("starts 「自动校对」 unchecked under an attached subtitle, keeps the user's choice, and restores the default on removal", async () => {
    mockApi({ ...baseRoutes({ mode: "server" }), "POST /api/subtitles/inspect": { body: srtPreview() } });
    await openPage(page(), { route: "/new", mode: "server" });
    await openTab("上传本地文件");
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    expect(settingsCheckbox()?.checked).toBe(true);
    fireEvent.change(screen.getByTestId("upload-subtitle"), { target: { files: [new File([SRT], "lecture.srt")] } });
    const moved = await screen.findByTestId("subtitle-auto-proofread");
    expect(moved.textContent).toContain("已附带字幕，默认不用 AI 改写；总结和章节仍会生成");
    // One checkbox only, now under the subtitle.
    expect(screen.getAllByRole("checkbox", { name: "自动校对" })).toHaveLength(1);
    const box = within(moved).getByRole("checkbox", { name: "自动校对" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByTestId("upload-remove-subtitle"));
    expect(screen.queryByTestId("subtitle-auto-proofread")).toBeNull();
    expect(settingsCheckbox()?.checked).toBe(true);
    fireEvent.change(screen.getByTestId("upload-subtitle"), { target: { files: [new File([SRT], "lecture.srt")] } });
    expect((within(await screen.findByTestId("subtitle-auto-proofread")).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps a choice the user made before attaching a subtitle", async () => {
    mockApi({ ...baseRoutes({ mode: "server" }), "POST /api/subtitles/inspect": { body: srtPreview() } });
    await openPage(page(), { route: "/new", mode: "server" });
    await openTab("上传本地文件");
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    fireEvent.click(settingsCheckbox() as HTMLInputElement);
    fireEvent.click(settingsCheckbox() as HTMLInputElement);
    fireEvent.change(screen.getByTestId("upload-subtitle"), { target: { files: [new File([SRT], "lecture.srt")] } });
    expect((within(await screen.findByTestId("subtitle-auto-proofread")).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("previews the uploaded subtitle under it and sends the choices in the subtitleOptions part", async () => {
    const { calls } = mockApi({
      ...baseRoutes({ mode: "server" }),
      "POST /api/subtitles/inspect": { body: prefixPreview() },
      "POST /api/contents/upload": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c7"] } },
    });
    await openPage(page(), { route: "/new", mode: "server" });
    await openTab("上传本地文件");
    fireEvent.change(screen.getByTestId("upload-file"), { target: { files: [new File([new Uint8Array([1])], "lecture.mp4", { type: "video/mp4" })] } });
    fireEvent.change(screen.getByTestId("upload-subtitle"), { target: { files: [new File([SRT], "lecture.srt")] } });
    await screen.findByTestId("subtitle-preview");
    expect(calls.find((call) => call.path === "/api/subtitles/inspect")?.body).toEqual({ text: SRT, filename: "lecture.srt" });
    // A new Content has no existing speakers to map or current version to keep.
    expect(screen.queryByTestId("subtitle-preview-identities")).toBeNull();
    expect(screen.queryByTestId("subtitle-preview-set-current")).toBeNull();
    fireEvent.click(screen.getByTestId("subtitle-preview-unlabeled-unassigned"));
    fireEvent.change(screen.getByTestId("upload-subtitle-language"), { target: { value: "zh-CN" } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c7"));
    const form = calls.find((call) => call.path === "/api/contents/upload")?.form ?? [];
    expect(form.map(([name]) => name)).toEqual(["settings", "subtitleLanguage", "subtitleOptions", "subtitle", "file"]);
    expect(JSON.parse(String(form[2]?.[1]))).toEqual({ expectedDigest: DIGEST, speakers: { prefixNames: ["张三", "李四"], unlabeled: "unassigned" } });
  });

  it("takes a package's language from the package and sends it with the link", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/subtitles/inspect": { body: packagePreview() },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    await openPage(page(), { route: "/new" });
    await openTab("导入字幕");
    fireEvent.change(screen.getByLabelText("音视频链接"), { target: { value: VIDEO } });
    fireEvent.change(screen.getByTestId("subtitle-file"), { target: { files: [new File(["{}"], "第一讲.ambersub")] } });
    await screen.findByTestId("subtitle-preview-package");
    expect(screen.queryByTestId("subtitle-language")).toBeNull();
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    const body = calls.find((call) => call.path === "/api/contents/import")?.body as { items: unknown[]; settings: { autoProofread: boolean } };
    expect(body.items).toEqual([{ url: VIDEO, initialSubtitle: { text: "{}", language: "zh-CN", format: "ambersub", options: { expectedDigest: DIGEST } } }]);
    expect(body.settings.autoProofread).toBe(false);
  });

  it("holds the import while the preview asks for a decision", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/subtitles/inspect": { body: srtPreview({ format: "ass", bilingual: { source: "style", count: 3, samples: [] } }) } });
    await openPage(page(), { route: "/new" });
    await openTab("导入字幕");
    fireEvent.change(screen.getByLabelText("音视频链接"), { target: { value: VIDEO } });
    fireEvent.change(screen.getByTestId("subtitle-file"), { target: { files: [new File(["[Script Info]"], "第一讲.ass")] } });
    await screen.findByTestId("subtitle-preview-translation-pick");
    fireEvent.change(screen.getByTestId("subtitle-language"), { target: { value: "zh-CN" } });
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("请先处理字幕预览中的提示")).toBeTruthy();
    expect(calls.some((call) => call.path === "/api/contents/import")).toBe(false);
  });
});

describe("NewPage with a picked subtitle in the desktop client", () => {
  it("previews the picked subtitle under its grant and sends the choices with it", async () => {
    const MEDIA = "D:\\课程\\第一讲.mp4";
    const SUBTITLE = "D:\\课程\\第一讲.ass";
    fakeShell.desktop = true;
    fakeShell.pickLocalFile.mockResolvedValueOnce(pickedFile(MEDIA)).mockResolvedValueOnce(pickedFile(SUBTITLE));
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/subtitles/inspect-local": { body: srtPreview({ format: "ass", bilingual: { source: "style", count: 3, samples: [{ original: "你好", translation: "Hello" }] } }) },
      "POST /api/contents/local-file": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c9"] } },
    });
    await openPage(page(), { route: "/new" });
    const tab = await screen.findByRole("tab", { name: "选择本地文件" });
    await waitFor(() => expect(tab.hasAttribute("disabled")).toBe(false));
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.click(await screen.findByTestId("local-pick"));
    await waitFor(() => expect(screen.getByTestId("local-file-name").textContent).toBe("第一讲.mp4"));
    fireEvent.click(screen.getByTestId("local-pick-subtitle"));
    await screen.findByTestId("subtitle-preview");
    expect(calls.find((call) => call.path === "/api/subtitles/inspect-local")?.body).toEqual({ path: SUBTITLE, grant: expect.objectContaining({ path: SUBTITLE }) });
    fireEvent.change(screen.getByTestId("local-subtitle-language"), { target: { value: "zh-CN" } });
    fireEvent.change(screen.getByTestId("subtitle-preview-translation-language"), { target: { value: "en" } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c9"));
    const body = calls.find((call) => call.path === "/api/contents/local-file")?.body as { initialSubtitle: unknown };
    expect(body.initialSubtitle).toEqual({ path: SUBTITLE, grant: expect.objectContaining({ path: SUBTITLE }), language: "zh-CN", options: { expectedDigest: DIGEST, translationLanguage: "en" } });
  });
});

describe("NewPage model readiness", () => {
  function readinessRoutes() {
    const windows = windowRoutes([provider("p1", "主力", ["m1"]), providerWithoutWindow("p2", "备用", ["bare"])]);
    const { calls } = mockApi({
      ...baseRoutes(),
      ...windows.routes,
      "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p2", modelId: "bare" } } },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    return { calls, overrides: windows.overrides };
  }

  it("holds the import while the chosen model has no context window, and lets it go once filled in", async () => {
    const { calls, overrides } = readinessRoutes();
    await openPage(page(), { route: "/new" });
    // The settings stay folded: the notice still names the model the import would use.
    const notice = await screen.findByTestId("new-context-window");
    expect(notice.textContent).toContain("「备用 · bare」还没有填写上下文窗口");
    const submit = screen.getByTestId<HTMLButtonElement>("new-submit");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.submit(submit.closest("form") as HTMLFormElement);
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    fireEvent.change(within(notice).getByLabelText("上下文窗口"), { target: { value: "64000" } });
    fireEvent.click(within(notice).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByTestId("new-context-window")).toBeNull());
    expect(overrides[0]?.path).toBe("/api/providers/p2/models/bare/override");
    expect(overrides[0]?.body).toEqual({ limits: { contextWindowTokens: 64_000, maxOutputTokens: null } });
    expect(submit.disabled).toBe(false);
    // The notice took the focus with it: it moves on to the action it was holding back.
    await waitFor(() => expect(document.activeElement).toBe(submit));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    expect((calls.find((call) => call.path === "/api/contents/import")?.body as { settings: object }).settings).toMatchObject({ modelRef: { providerProfileId: "p2", modelId: "bare" } });
  });

  it("asks nothing when only transcribing, or with a model that has its window", async () => {
    readinessRoutes();
    await openPage(page(), { route: "/new" });
    await screen.findByTestId("new-context-window");
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    const model = screen.getByRole("combobox", { name: "AI 模型" });
    await waitFor(() => expect(model.textContent).toBe("备用 · bare"));
    await chooseOption(model, "暂不选择（AI 阶段将等待配置）");
    expect(screen.queryByTestId("new-context-window")).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>("new-submit").disabled).toBe(false);
    await chooseOption(model, "m1", "主力");
    expect(screen.queryByTestId("new-context-window")).toBeNull();
    await chooseOption(model, "bare", "备用");
    expect(screen.getByTestId("new-context-window")).toBeTruthy();
  });
});

describe("NewPage link box with share texts", () => {
  const importReply = { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } };
  const box = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>("new-url-input");
  const pasteInto = (field: HTMLElement, text: string): void => {
    fireEvent.paste(field, { clipboardData: { getData: () => text } });
  };
  const posted = (calls: Array<{ path: string; body?: unknown }>): string[] =>
    (calls.find((call) => call.path === "/api/contents/import")?.body as { items: Array<{ url: string }> }).items.map((item) => item.url);

  async function submitted(text: string): Promise<{ urls: string[] | undefined; scope: string | null }> {
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/import": importReply });
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: text } });
    const scope = screen.queryByTestId("link-recognition")?.textContent ?? null;
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/import") || screen.queryByText("请先粘贴至少一条链接") !== null).toBe(true));
    const sent = calls.some((call) => call.path === "/api/contents/import") ? posted(calls) : undefined;
    cleanup();
    return { urls: sent, scope };
  }

  it("leaves only the links of a pasted share text, unsupported ones too, with a note the next edit clears", async () => {
    mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    pasteInto(box(), LONG_SHARE);
    expect(box().value).toBe([WEB_SHARE_LINK, `${VIDEO_2}?p=3`, YT_VIDEO, UNSUPPORTED, YT_LIST].join("\n"));
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已从分享内容中提取 5 条链接，另有 1 条不支持、不会提交");
    fireEvent.change(box(), { target: { value: `${box().value} ` } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 1 个合集，开始处理前可以挑选内容并安排顺序，另有 1 条不支持、不会提交");
  });

  it("pastes a plain list of links as it is, with no note", async () => {
    mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => `${VIDEO}\n${YT_VIDEO}` } });
    box().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText(/已从分享内容中提取/)).toBeNull();
  });

  it("leaves a paste without a supported link to the browser", async () => {
    mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => `看这个 ${UNSUPPORTED}` } });
    box().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("inserts at the caret, over a selection, breaking lines so nothing runs on", async () => {
    mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: `${VIDEO_2}\n${YT_VIDEO}` } });
    // Caret at the end of the first line: the links go on lines of their own.
    box().setSelectionRange(VIDEO_2.length, VIDEO_2.length);
    pasteInto(box(), APP_SHARE);
    expect(box().value).toBe(`${VIDEO_2}\n${SHORT}\n${YT_VIDEO}`);
    await waitFor(() => expect(box().selectionStart).toBe(`${VIDEO_2}\n${SHORT}`.length));
    // A selection is replaced.
    const start = box().value.indexOf(SHORT);
    box().setSelectionRange(start, start + SHORT.length);
    pasteInto(box(), WEB_SHARE);
    expect(box().value).toBe(`${VIDEO_2}\n${WEB_SHARE_LINK}\n${YT_VIDEO}`);
  });

  it("inserts through the browser's own insert when it has one, so undo covers the paste", async () => {
    mockApi(baseRoutes());
    const execCommand = vi.fn((command: string, _ui: boolean, value: string) => {
      const field = document.activeElement as HTMLTextAreaElement;
      field.setRangeText(value, field.selectionStart, field.selectionEnd, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return command === "insertText";
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    try {
      await openPage(page(), { route: "/new" });
      fireEvent.change(box(), { target: { value: VIDEO } });
      box().setSelectionRange(VIDEO.length, VIDEO.length);
      pasteInto(box(), WEB_SHARE);
      expect(execCommand).toHaveBeenCalledWith("insertText", false, `\n${WEB_SHARE_LINK}`);
      expect(box().value).toBe(`${VIDEO}\n${WEB_SHARE_LINK}`);
      // The insert's own change event does not take the note away.
      expect(screen.getByTestId("link-recognition-text").textContent).toBe("已从分享内容中提取 1 条链接");
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("sends supported links alone as they are, saying only that they go as a batch", async () => {
    expect(await submitted(` ${VIDEO_2}\n\n${YT_VIDEO} ${SHORT} `)).toEqual({ urls: [VIDEO_2, YT_VIDEO, SHORT], scope: "已识别 3 条链接，将作为一批导入" });
  });

  it("sends only the supported links when unsupported links or words are around them, and says so", async () => {
    expect(await submitted(`${WEB_SHARE}\n${UNSUPPORTED}\n另一行文字`)).toEqual({ urls: [WEB_SHARE_LINK], scope: "已识别 1 条链接，另有 1 条不支持、不会提交·查看" });
    expect(await submitted(`${YT_VIDEO}\n另一行文字`)).toEqual({ urls: [YT_VIDEO], scope: "已识别 1 条链接，另有 1 行文字不会提交" });
    expect(await submitted(`${YT_VIDEO}。`)).toEqual({ urls: [YT_VIDEO], scope: "已识别 1 条链接，链接以外的文字不会提交" });
  });

  it("sends every line as written when no link is supported, as before, with no scope", async () => {
    expect(await submitted(` ${UNSUPPORTED} \n看这个`)).toEqual({ urls: [UNSUPPORTED, "看这个"], scope: null });
  });

  it("asks for a link when the box is empty", async () => {
    expect(await submitted("  \n ")).toEqual({ urls: undefined, scope: null });
  });

  it("lists the links left out on request, at most twenty, with the count of the rest and of lines without links", async () => {
    mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    const others = Array.from({ length: 25 }, (_, index) => `${UNSUPPORTED}/${index}`);
    fireEvent.change(box(), { target: { value: [YT_VIDEO, ...others, "一行字", "又一行"].join("\n") } });
    const scope = screen.getByTestId("link-recognition");
    expect(scope.textContent).toBe("已识别 1 条链接，另有 25 条不支持、不会提交·查看");
    // The box is described by the sentence, and the button stays usable.
    expect(document.getElementById(box().getAttribute("aria-describedby") ?? "")?.textContent).toBe("已识别 1 条链接，另有 25 条不支持、不会提交");
    const submit = screen.getByTestId<HTMLButtonElement>("new-submit");
    expect(submit.disabled).toBe(false);
    const toggle = within(scope).getByRole("button", { name: "查看" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const details = screen.getByTestId("link-recognition-details");
    expect(within(details).getAllByRole("listitem").map((item) => item.textContent)).toEqual(others.slice(0, 20));
    expect(details.textContent).toContain("还有 5 条未列出");
    expect(details.textContent).toContain("另有 2 行文字不含链接，也不会提交");
    fireEvent.click(within(scope).getByRole("button", { name: "收起" }));
    expect(screen.queryByTestId("link-recognition-details")).toBeNull();
  });

  it("counts supported links for the batch hint and spots a platform list among words", async () => {
    mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: `${WEB_SHARE}\n${UNSUPPORTED}\n${YT_VIDEO}` } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 2 条链接，将作为一批导入，另有 1 条不支持、不会提交");
    fireEvent.change(box(), { target: { value: `【播放列表】 ${YT_LIST}` } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 1 个合集，开始处理前可以挑选内容并安排顺序，链接以外的文字不会提交");
  });

  it("routes a platform list taken from a share text to its collection", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"] } },
      "GET /api/contents/c1": { body: { ...content("c1", { collections: [{ id: "k7", name: "播放列表", itemId: "ki7" }] }), media: [] } },
      "POST /api/contents/inspect": { body: playlistPage(YT_LIST, 2) },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: `【播放列表】 ${YT_LIST}` } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await confirmPreview();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k7"));
    expect(posted(calls)).toEqual([YT_LIST]);
  });

  it("asks about parts for the extracted link, and drops the choice once the link changes", async () => {
    let attempts = 0;
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 400, body: { error: { class: "invalid_request", code: "invalid_request.multipart_choice_required", retryDisposition: "never", userMessage: "该稿件有多个分 P" } } }
          : importReply;
      },
      "POST /api/contents/inspect": {
        body: { kind: "multipart", canonicalUrl: MULTI_P, title: "多 P 稿件", parts: [1, 2].map((index) => ({ platformPartId: `p${index}`, index, title: `P${index}`, durationMs: 1000 })) },
      },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: WEB_SHARE } });
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByTestId("parts-choice")).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/contents/inspect")?.body).toEqual({ url: WEB_SHARE_LINK });
    fireEvent.click(screen.getByLabelText("导入全部 2 个分 P"));
    // Another link in the box: the choice made for the old one neither shows nor is sent.
    fireEvent.change(box(), { target: { value: `【另一个】 ${VIDEO_2}` } });
    expect(screen.queryByTestId("parts-choice")).toBeNull();
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/import")).toHaveLength(2));
    expect(calls.filter((call) => call.path === "/api/contents/import").at(-1)?.body).toMatchObject({ items: [{ url: VIDEO_2 }] });
  });
});

describe("NewPage subtitle tab link", () => {
  async function openSubtitleTab() {
    const tab = await screen.findByRole("tab", { name: "导入字幕" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    return screen.getByLabelText<HTMLInputElement>("音视频链接");
  }

  it.each([
    ["two links", `${VIDEO_2} ${YT_VIDEO}`],
    ["two links glued together", `${VIDEO_2}${YT_VIDEO}`],
    ["a supported and an unsupported link", `${VIDEO_2} ${UNSUPPORTED}`],
  ])("refuses %s without sending anything", async (_name, value) => {
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/subtitles/inspect": { body: packagePreview() } });
    await openPage(page(), { route: "/new" });
    fireEvent.change(await openSubtitleTab(), { target: { value } });
    fireEvent.change(screen.getByTestId("subtitle-file"), { target: { files: [new File(["{}"], "第一讲.ambersub")] } });
    await screen.findByTestId("subtitle-preview-package");
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("这里只能填一条视频链接")).toBeTruthy();
    expect(calls.some((call) => call.path === "/api/contents/import")).toBe(false);
  });

  it("sends the link of one share text", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/subtitles/inspect": { body: packagePreview() },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(await openSubtitleTab(), { target: { value: WEB_SHARE } });
    fireEvent.change(screen.getByTestId("subtitle-file"), { target: { files: [new File(["{}"], "第一讲.ambersub")] } });
    await screen.findByTestId("subtitle-preview-package");
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    expect((calls.find((call) => call.path === "/api/contents/import")?.body as { items: Array<{ url: string }> }).items.map((item) => item.url)).toEqual([WEB_SHARE_LINK]);
  });

  it("takes the links out of a multi-line paste, separated by spaces, so the second one is still seen", async () => {
    const { calls } = mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    const field = await openSubtitleTab();
    fireEvent.paste(field, { clipboardData: { getData: () => `${WEB_SHARE}\n${APP_SHARE}` } });
    expect(field.value).toBe(`${WEB_SHARE_LINK} ${SHORT}`);
    expect(screen.getByTestId("subtitle-paste-note").textContent).toBe("已提取分享内容里的 2 条链接");
    fireEvent.click(screen.getByTestId("new-submit"));
    expect(await screen.findByText("这里只能填一条视频链接")).toBeTruthy();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("NewPage after a paste elsewhere", () => {
  function Shell() {
    usePasteGuard();
    const location = useLocation();
    return location.pathname === "/new" ? <NewPage /> : <p data-testid="elsewhere">{location.pathname}</p>;
  }

  it("arrives with every link of the paste, and the line under the box saying so and naming the links left out", async () => {
    mockApi(baseRoutes());
    renderApp(<Shell />, { route: "/library" });
    await screen.findByTestId("elsewhere");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => `${WEB_SHARE}\n讲义 ${UNSUPPORTED}` } });
    document.dispatchEvent(event);
    const field = await screen.findByTestId<HTMLTextAreaElement>("new-url-input");
    expect(field.value).toBe(`${WEB_SHARE_LINK}\n${UNSUPPORTED}`);
    expect(screen.getByTestId("link-recognition").textContent).toBe("已从分享内容中提取 2 条链接，另有 1 条不支持、不会提交·查看");
  });
});

describe("NewPage with collection links", () => {
  const SERIES = "https://space.bilibili.com/12345/lists/678?type=season";
  const imported = (calls: Array<{ path: string; method: string; body?: unknown; headers: Record<string, string> }>) => calls.filter((call) => call.method === "POST" && call.path === "/api/contents/import");
  const reply = (collectionIds: string[] = ["k9"]) => ({ status: 202, body: { importBatchId: "b1", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"], collectionIds } });
  const dialog = (): HTMLElement => screen.getByTestId("collection-preview");
  const entryRow = (id: string): HTMLElement => {
    const found = within(dialog()).getAllByTestId("preview-entry").find((element) => element.dataset["entryId"] === id);
    if (found === undefined) throw new Error(`no row ${id}`);
    return found;
  };
  const choiceError = (urls: string[]) => ({
    status: 400,
    body: { error: { class: "invalid_request", code: "invalid_request.collection_choice_required", retryDisposition: "never", userMessage: "导入合集前请先预览并选择要导入的内容", details: { urls } } },
  });

  it("opens the preview before sending, then imports the chosen entries in their order and opens the collection", async () => {
    const inspect = fakeInspect([{ url: YT_LIST, title: "示例播放列表", pageSize: 50, entries: newEntries(3, "y") }]);
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/inspect": inspect.reply, "POST /api/contents/import": reply(["k9"]) });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: `${VIDEO}\n${YT_LIST}` } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 1 个合集，开始处理前可以挑选内容并安排顺序");
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(3));
    expect(imported(calls)).toHaveLength(0);
    expect(inspect.requests[0]).toEqual({ url: YT_LIST });
    fireEvent.click(entryRow("y2"));
    fireEvent.mouseDown(within(dialog()).getByTestId("preview-tab-order"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "移到最前" }));
    // The other link shares the batch.
    expect(within(dialog()).getByTestId("preview-submit").textContent).toBe("开始处理 3 项");
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k9"));
    expect(imported(calls)[0]?.body).toEqual({
      items: [{ url: VIDEO }, { url: YT_LIST, entries: ["y3", "y1"], previewId: "pv1" }],
      settings: { templateId: "summary.core", outputLanguage: "zh-CN", autoProofread: true },
      confirmCollections: true,
    });
  });

  it("opens the preview from the line under the box", async () => {
    const inspect = fakeInspect([{ url: YT_LIST, pageSize: 50, entries: newEntries(2, "y") }]);
    mockApi({ ...baseRoutes(), "POST /api/contents/inspect": inspect.reply });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: YT_LIST } });
    fireEvent.click(screen.getByRole("button", { name: "预览合集" }));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(2));
  });

  it("goes back to the form on 「取消」 with the text and the choice kept", async () => {
    const inspect = fakeInspect([{ url: YT_LIST, pageSize: 50, entries: newEntries(3, "y") }]);
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/inspect": inspect.reply, "POST /api/contents/import": reply() });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: YT_LIST } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(3));
    fireEvent.click(entryRow("y1"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("collection-preview")).toBeNull());
    expect(screen.getByTestId<HTMLTextAreaElement>("new-url-input").value).toBe(YT_LIST);
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(3));
    expect(entryRow("y1").dataset["chosen"]).toBe("false");
    expect(inspect.requests).toHaveLength(1);
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    await waitFor(() => expect(imported(calls)).toHaveLength(1));
    expect((imported(calls)[0]?.body as { items: unknown[] }).items).toEqual([{ url: YT_LIST, entries: ["y2", "y3"], previewId: "pv1" }]);
  });

  it("previews afresh after an import that leaves the page open, instead of resending the last choice", async () => {
    const collection = { url: YT_LIST, pageSize: 50, entries: newEntries(3, "y") };
    const inspect = fakeInspect([collection]);
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/inspect": inspect.reply,
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"], collectionIds: ["k9"], skippedTrashedContentIds: ["c8"] } },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: YT_LIST } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await confirmPreview();
    await screen.findByTestId("new-skipped-trashed");
    expect(imported(calls)).toHaveLength(1);
    // What was imported is in the collection now.
    collection.entries = collection.entries.map((entry) => ({ ...entry, state: "in_collection" as const }));
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(3));
    await waitFor(() => expect(inspect.requests).toHaveLength(2));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry").map((row) => row.dataset["chosen"])).toEqual(["false", "false", "false"]));
    expect(imported(calls)).toHaveLength(1);
  });

  it("orders several collections as the box lists them, each as arranged", async () => {
    const inspect = fakeInspect([
      { url: SERIES, title: "合集一", pageSize: 50, entries: newEntries(2, "BV1a") },
      { url: YT_LIST, title: "列表二", pageSize: 50, entries: newEntries(2, "y") },
    ]);
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/inspect": inspect.reply, "POST /api/contents/import": reply(["k1", "k2"]) });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: `${SERIES}\n${VIDEO}\n${YT_LIST}` } });
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 2 个合集，开始处理前可以挑选内容并安排顺序");
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(2));
    fireEvent.click(within(dialog()).getByRole("button", { name: "下一个" }));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry").map((element) => element.dataset["entryId"])).toEqual(["y1", "y2"]));
    fireEvent.mouseDown(within(dialog()).getByTestId("preview-tab-order"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "移到最前" }));
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k1"));
    expect((imported(calls)[0]?.body as { items: unknown[] }).items).toEqual([
      { url: SERIES, entries: ["BV1a1", "BV1a2"], previewId: "pv1" },
      { url: VIDEO },
      { url: YT_LIST, entries: ["y2", "y1"], previewId: "pv2" },
    ]);
  });

  it("opens the preview for a short link the server found to be a collection, then sends the choice for it", async () => {
    const inspect = fakeInspect([{ url: SHORT, title: "短链合集", pageSize: 50, entries: newEntries(2, "BV1s") }]);
    let attempts = 0;
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/inspect": inspect.reply,
      "POST /api/contents/import": () => {
        attempts += 1;
        return attempts === 1 ? choiceError([SHORT]) : reply(["k5"]);
      },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: `${SHORT}\n${VIDEO}` } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(2));
    expect(imported(calls)[0]?.body).toMatchObject({ items: [{ url: SHORT }, { url: VIDEO }], confirmCollections: true });
    expect(inspect.requests[0]).toEqual({ url: SHORT });
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k5"));
    expect((imported(calls)[1]?.body as { items: unknown[] }).items).toEqual([{ url: SHORT, entries: ["BV1s1", "BV1s2"], previewId: "pv1" }, { url: VIDEO }]);
    // Two confirmations, two keys.
    expect(imported(calls)[0]?.headers["idempotency-key"]).not.toBe(imported(calls)[1]?.headers["idempotency-key"]);
  });

  it("asks about parts after the preview and sends both choices without previewing again", async () => {
    const inspect = fakeInspect([{ url: YT_LIST, pageSize: 50, entries: newEntries(2, "y") }]);
    let attempts = 0;
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/inspect": (call) =>
        (call.body as { url: string }).url === MULTI_P
          ? { body: { kind: "multipart", canonicalUrl: MULTI_P, title: "多 P 稿件", parts: [1, 2].map((index) => ({ platformPartId: `p${index}`, index, title: `P${index}`, durationMs: 1000 })) } }
          : inspect.reply(call),
      "POST /api/contents/import": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 400, body: { error: { class: "invalid_request", code: "invalid_request.multipart_choice_required", retryDisposition: "never", userMessage: "该稿件有多个分 P" } } }
          : reply(["k3"]);
      },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: `${YT_LIST}\n${MULTI_P}` } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(2));
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    expect(await screen.findByTestId("parts-choice")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("collection-preview")).toBeNull());
    // Only the multi-part link is asked about.
    expect(calls.filter((call) => call.path === "/api/contents/inspect").map((call) => (call.body as { url: string }).url)).toEqual([YT_LIST, MULTI_P]);
    fireEvent.click(screen.getByLabelText("仅第 1 P"));
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k3"));
    expect(screen.queryByTestId("collection-preview")).toBeNull();
    expect((imported(calls)[1]?.body as { items: unknown[] }).items).toEqual([{ url: YT_LIST, entries: ["y1", "y2"], previewId: "pv1" }, { url: MULTI_P, parts: "first" }]);
  });

  it("reads the collection again when the import finds the preview stale, and sends the new choice under a new key", async () => {
    const inspect = fakeInspect([{ url: YT_LIST, pageSize: 50, entries: newEntries(2, "y") }]);
    let attempts = 0;
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/inspect": inspect.reply,
      "POST /api/contents/import": () => {
        attempts += 1;
        return attempts === 1 ? STALE_REPLY : reply(["k9"]);
      },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: YT_LIST } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(2));
    fireEvent.click(entryRow("y1"));
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    await waitFor(() => expect(inspect.requests).toHaveLength(2));
    expect(inspect.requests[1]).toEqual({ url: YT_LIST });
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("合集内容已变化或预览已过期，请重新读取");
    await waitFor(() => expect(within(dialog()).getByTestId<HTMLButtonElement>("preview-submit").disabled).toBe(false));
    expect(entryRow("y1").dataset["chosen"]).toBe("false");
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k9"));
    const [first, second] = imported(calls);
    expect((second?.body as { items: unknown[] }).items).toEqual([{ url: YT_LIST, entries: ["y2"], previewId: "pv2" }]);
    expect(first?.headers["idempotency-key"]).not.toBe(second?.headers["idempotency-key"]);
  });

  it("retries a network failure with the same key and body, and takes a new key once the choice changes", async () => {
    const inspect = fakeInspect([{ url: YT_LIST, pageSize: 50, entries: newEntries(3, "y") }]);
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/inspect": inspect.reply, "POST /api/contents/import": reply(["k9"]) });
    const served = globalThis.fetch;
    let drops = 2;
    vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
      const result = served(input, init);
      if (String(input) === "/api/contents/import" && drops > 0) {
        drops -= 1;
        // Sent and recorded, but the answer is lost on the way back.
        return result.then(() => Promise.reject(new TypeError("network")));
      }
      return result;
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: YT_LIST } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(within(dialog()).getAllByTestId("preview-entry")).toHaveLength(3));
    const submit = within(dialog()).getByTestId<HTMLButtonElement>("preview-submit");
    fireEvent.click(submit);
    expect((await within(dialog()).findByRole("alert")).textContent).toBeTruthy();
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(imported(calls)).toHaveLength(2));
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(entryRow("y3"));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k9"));
    const [first, retry, changed] = imported(calls);
    expect(retry?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    expect(retry?.body).toEqual(first?.body);
    expect(changed?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
    expect((changed?.body as { items: unknown[] }).items).toEqual([{ url: YT_LIST, entries: ["y1", "y2"], previewId: "pv1" }]);
  });

  it("goes to the chosen collection's page for loose links, and to the new one by the answer's collections", async () => {
    await expect(
      routeAfterImport({ api: new ApiClient({ baseUrl: "" }, "local"), response: { importBatchId: "b", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"], collectionIds: ["k2"] }, urls: [VIDEO, YT_VIDEO], collection: { name: "新课" } }),
    ).resolves.toEqual({ path: "/collections/k2", openTasks: false });
    await expect(
      routeAfterImport({
        api: new ApiClient({ baseUrl: "" }, "local"),
        response: { importBatchId: "b", taskIds: ["t1"], contentIds: ["c1"], collectionIds: ["k3", "k1"] },
        urls: [YT_LIST],
        collection: { id: "k1" },
        collectionImport: true,
      }),
    ).resolves.toEqual({ path: "/collections/k3", openTasks: false });
  });
});

describe("NewPage form checks and settings", () => {
  it("shows a missing link right under the box, marking the box invalid", async () => {
    mockApi(baseRoutes());
    await openPage(page(), { route: "/new" });
    fireEvent.click(screen.getByTestId("new-submit"));
    const message = await screen.findByTestId("new-problem-links");
    expect(message.textContent).toBe("请先粘贴至少一条链接");
    const box = screen.getByTestId("new-url-input");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(message.id);
    // Right under the box, before the line about what it holds and the settings.
    expect(box.nextElementSibling).toBe(message);
  });

  it("shows a link the server cannot take under the box, not at the foot of the form", async () => {
    const userMessage = "暂不支持这个链接。目前支持：bilibili, youtube";
    mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": {
        status: 422,
        body: { error: { class: "source_unsupported_url", code: "source_unsupported_url", retryDisposition: "never", userMessage } },
      },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: "not a link at all" } });
    fireEvent.click(screen.getByTestId("new-submit"));
    const message = await screen.findByTestId("new-problem-links");
    expect(message.textContent).toBe(userMessage);
    const box = screen.getByTestId("new-url-input");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(message.id);
    expect(screen.queryAllByText(userMessage)).toHaveLength(1);
  });

  it("shows a missing collection name under its field, opening the settings", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "GET /api/collections": { body: { items: [] } } });
    await openPage(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    await chooseOption(screen.getByRole("combobox", { name: "加入合集" }), "新建合集");
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    const message = await screen.findByTestId("new-problem-collectionName");
    expect(message.textContent).toBe("请填写新合集名称");
    expect(screen.getByLabelText("新合集名称").getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("starts the settings menus at their defaults and sends what is chosen in them", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/settings": { body: { ...SETTINGS, defaultSummaryTemplateId: "t2", defaultOutputLanguage: "ja" } },
      "GET /api/summary-templates": {
        body: {
          items: [
            { id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false },
            { id: "t2", builtin: false, name: "我的模板", currentVersion: 1, deleted: false },
          ],
        },
      },
      "GET /api/collections": { body: { items: [collection("k1", "第一门课"), collection("k2", "第二门课")] } },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    const template = screen.getByRole("combobox", { name: "总结模板" });
    const language = screen.getByRole("combobox", { name: "输出语言" });
    const target = screen.getByRole("combobox", { name: "加入合集" });
    await waitFor(() => expect(template.textContent).toBe("我的模板"));
    expect(language.textContent).toBe("日语");
    expect(target.textContent).toBe("不加入合集");
    await waitFor(async () => expect(await selectOptionNames(target)).toEqual(["不加入合集", "第一门课", "第二门课", "新建合集"]));
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/import")).toBe(true));
    expect(calls.find((call) => call.path === "/api/contents/import")?.body).toMatchObject({ settings: { templateId: "t2", outputLanguage: "ja" } });
    expect(calls.find((call) => call.path === "/api/contents/import")?.body).not.toHaveProperty("collection");
    cleanup();

    const second = mockApi({
      ...baseRoutes(),
      "GET /api/collections": { body: { items: [collection("k1", "第一门课")] } },
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
    });
    await openPage(page(), { route: "/new" });
    fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "总结模板" }).textContent).toBe("核心总结"));
    await chooseOption(screen.getByRole("combobox", { name: "总结模板" }), "核心总结");
    await chooseOption(screen.getByRole("combobox", { name: "输出语言" }), "英语");
    await waitFor(async () => expect(await selectOptionNames(screen.getByRole("combobox", { name: "加入合集" }))).toContain("第一门课"));
    await chooseOption(screen.getByRole("combobox", { name: "加入合集" }), "第一门课");
    fireEvent.change(screen.getByTestId("new-url-input"), { target: { value: VIDEO } });
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(second.calls.some((call) => call.path === "/api/contents/import")).toBe(true));
    expect(second.calls.find((call) => call.path === "/api/contents/import")?.body).toMatchObject({
      settings: { templateId: "summary.core", outputLanguage: "en" },
      collection: { id: "k1" },
    });
  });
});

describe("NewPage checking a pasted link", () => {
  const box = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>("new-url-input");
  const type = (text: string): void => {
    fireEvent.change(box(), { target: { value: text } });
  };
  const inspected = (calls: RecordedCalls): unknown[] => calls.filter((call) => call.method === "POST" && call.path === "/api/contents/inspect").map((call) => call.body);
  const imported = (calls: RecordedCalls) => calls.filter((call) => call.method === "POST" && call.path === "/api/contents/import");
  const line = (): string | null => screen.queryByTestId("link-recognition")?.textContent ?? null;
  /** Longer than the pause before a check, so a check that was going to be sent has been. */
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, IMPORT_CHECK_DEBOUNCE_MS + 150));
  const video = (title: string, durationMs: number, extra: Record<string, unknown> = {}) => ({
    body: { kind: "single", canonicalUrl: DOUYIN_VIDEO, title, check: { result: "video", title, durationMs }, ...extra },
  });
  const XHS_OTHER = XHS_VIDEO.replace(XHS_NOTE, "0123456789abcdef0123456f");
  const importError = (code: string, userMessage: string, urls: string[]) => ({
    status: 400,
    body: { error: { class: "invalid_request", code, retryDisposition: "never", userMessage, details: { urls } } },
  });

  it("checks a single Xiaohongshu or Douyin link once typing pauses, once per link, and shows the video's title and length", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/inspect": (call) => {
        const url = (call.body as InspectRequest).url;
        return url === XHS_VIDEO ? video("示例笔记", 83_000) : video("另一条", 3_725_000);
      },
    });
    await openPage(page(), { route: "/new" });
    type(XHS_VIDEO);
    // Not before the pause.
    expect(inspected(calls)).toEqual([]);
    expect(await screen.findByTestId("import-check-video")).toBeTruthy();
    expect(inspected(calls)).toEqual([{ url: XHS_VIDEO }]);
    expect(line()).toBe("示例笔记·1:23");
    // The box is described by what the check found.
    expect(box().getAttribute("aria-describedby")).toContain("-more");
    // The same link again, after other edits: the result is reused, not asked for again.
    type(`${XHS_VIDEO}\n`);
    type(XHS_OTHER);
    await waitFor(() => expect(line()).toBe("另一条·1:02:05"));
    type(XHS_VIDEO);
    expect(line()).toBe("示例笔记·1:23");
    await pause();
    expect(inspected(calls)).toEqual([{ url: XHS_VIDEO }, { url: XHS_OTHER }]);
  });

  it("restarts the pause on every edit and stops a check under way once the link changes", async () => {
    mockApi({ ...baseRoutes(), "POST /api/contents/inspect": video("示例", 1000) });
    const base = globalThis.fetch;
    const sent: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if (String(input) === "/api/contents/inspect") {
        sent.push({ url: (JSON.parse(String(init.body)) as InspectRequest).url, signal: init.signal ?? undefined });
        // Never answers; only an abort ends it.
        return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return base(input, init);
    });
    await openPage(page(), { route: "/new" });
    await screen.findByTestId("new-submit");
    type("https://www.douyin.com/video/1");
    type(DOUYIN_VIDEO.slice(0, -1));
    type(DOUYIN_VIDEO);
    expect(await screen.findByTestId("import-check-checking")).toBeTruthy();
    expect(line()).toBe("正在确认链接…");
    // Only the link standing after the edits was sent.
    expect(sent.map((request) => request.url)).toEqual([DOUYIN_VIDEO]);
    // While checking, 「开始处理」 stays usable.
    expect(screen.getByTestId<HTMLButtonElement>("new-submit").disabled).toBe(false);
    type(XHS_VIDEO);
    expect(sent[0]?.signal?.aborted).toBe(true);
    await waitFor(() => expect(sent.map((request) => request.url)).toEqual([DOUYIN_VIDEO, XHS_VIDEO]));
    type("");
    expect(sent[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByTestId("import-check-checking")).toBeNull();
  });

  it("does not check bilibili or YouTube links, several links, a collection, or the subtitle tab's link", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/inspect": video("示例", 1000) });
    await openPage(page(), { route: "/new" });
    for (const text of [VIDEO, YT_VIDEO, SHORT, YT_LIST, DOUYIN_COLLECTION, `${XHS_VIDEO}\n${DOUYIN_VIDEO}`, `${DOUYIN_VIDEO}\n${UNSUPPORTED}`]) {
      type(text);
      await pause();
    }
    expect(inspected(calls)).toEqual([]);
  });

  it("checks the short link of an app share", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/inspect": video("示例", 1000) });
    await openPage(page(), { route: "/new" });
    type(DOUYIN_SHARE);
    await screen.findByTestId("import-check-video");
    expect(inspected(calls)).toEqual([{ url: DOUYIN_SHORT }]);
  });

  it.each([
    ["already in the library", { body: { kind: "single", canonicalUrl: DOUYIN_VIDEO, contentId: "c9" } }, "已在资料库·打开"],
    ["an image post", { body: { kind: "single", canonicalUrl: DOUYIN_VIDEO, check: { result: "rejected", reason: "not_video" } } }, "这是图文笔记，Amber 目前只处理视频"],
    [
      "an incomplete or expired link",
      { body: { kind: "single", canonicalUrl: DOUYIN_VIDEO, check: { result: "rejected", reason: "link_expired" } } },
      "链接可能不完整或已经失效，请重新复制完整的分享链接",
    ],
  ])("shows a link %s on the line under the box", async (_name, reply, expected) => {
    mockApi({ ...baseRoutes(), "POST /api/contents/inspect": reply });
    await openPage(page(), { route: "/new" });
    type(DOUYIN_VIDEO);
    await waitFor(() => expect(line()).toBe(expected));
    if (expected.startsWith("已在资料库")) {
      expect(screen.getByTestId("import-check-open").getAttribute("href")).toBe("/contents/c9");
    } else {
      // Shown as a field error, and still only a hint: the submit stays usable.
      expect(screen.getByTestId("import-check-rejected").className).toContain("text-danger");
      expect(screen.getByTestId<HTMLButtonElement>("new-submit").disabled).toBe(false);
    }
  });

  it("says nothing when the check could not tell, failed, or found something else", async () => {
    for (const reply of [
      { body: { kind: "single", canonicalUrl: DOUYIN_VIDEO, check: { result: "unverified" } } },
      { body: { kind: "single", canonicalUrl: DOUYIN_VIDEO } },
      { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } },
    ]) {
      const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/inspect": reply });
      const { unmount } = await openPage(page(), { route: "/new" });
      type(DOUYIN_VIDEO);
      await waitFor(() => expect(inspected(calls)).toHaveLength(1));
      await waitFor(() => expect(screen.queryByTestId("import-check-checking")).toBeNull());
      expect(line()).toBe("");
      unmount();
    }
  });

  it("gives up quietly on a check that does not answer in time, and does not ask again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi(baseRoutes());
      const base = globalThis.fetch;
      const sent: Array<AbortSignal | undefined> = [];
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        if (String(input) === "/api/contents/inspect") {
          sent.push(init.signal ?? undefined);
          return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        }
        return base(input, init);
      });
      await openPage(page(), { route: "/new" });
      await screen.findByTestId("new-submit");
      type(XHS_VIDEO);
      expect(await screen.findByTestId("import-check-checking")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(IMPORT_CHECK_QUIET_MS);
      });
      expect(screen.queryByTestId("import-check-checking")).toBeNull();
      expect(line()).toBe("");
      expect(sent[0]?.aborted).toBe(true);
      type(`${XHS_VIDEO} `);
      await act(async () => {
        vi.advanceTimersByTime(IMPORT_CHECK_DEBOUNCE_MS * 2);
      });
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers to import a link the import could not verify, and sends it again marked so under a new key", async () => {
    let attempts = 0;
    const { calls } = mockApi({
      ...baseRoutes(),
      "POST /api/contents/inspect": { body: { kind: "single", canonicalUrl: DOUYIN_VIDEO, check: { result: "unverified" } } },
      "POST /api/contents/import": () => {
        attempts += 1;
        return attempts === 1
          ? importError("invalid_request.link_unverified", "暂时无法确认这条链接能否处理", [DOUYIN_VIDEO])
          : { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } };
      },
    });
    await openPage(page(), { route: "/new" });
    type(DOUYIN_VIDEO);
    fireEvent.click(screen.getByTestId("new-submit"));
    const prompt = await screen.findByTestId("new-unverified");
    expect(prompt.textContent).toBe("暂时无法确认这条链接能否处理仍然导入");
    // Said once, under the box, not as an error at the foot of the form.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(imported(calls)).toHaveLength(1);
    fireEvent.click(within(prompt).getByRole("button", { name: "仍然导入" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    const [first, second] = imported(calls);
    expect(first?.body).toMatchObject({ items: [{ url: DOUYIN_VIDEO }] });
    expect((first?.body as { items: object[] }).items[0]).not.toHaveProperty("acceptUnverified");
    expect(second?.body).toMatchObject({ items: [{ url: DOUYIN_VIDEO, acceptUnverified: true }] });
    expect(second?.headers["idempotency-key"]).toBeTruthy();
    expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
  });

  it("drops the offer once the link leaves the box", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": importError("invalid_request.link_unverified", "暂时无法确认这条链接能否处理", [XHS_VIDEO]),
    });
    await openPage(page(), { route: "/new" });
    type(XHS_VIDEO);
    fireEvent.click(screen.getByTestId("new-submit"));
    await screen.findByTestId("new-unverified");
    type(YT_VIDEO);
    expect(screen.queryByTestId("new-unverified")).toBeNull();
  });

  it.each([
    ["invalid_request.not_video", "这是图文笔记，Amber 目前只处理视频"],
    ["invalid_request.link_expired", "链接可能不完整或已经失效，请重新复制完整的分享链接"],
  ])("shows %s under the box and sends nothing more", async (code, message) => {
    const { calls } = mockApi({ ...baseRoutes(), "POST /api/contents/import": importError(code, message, [XHS_VIDEO]) });
    await openPage(page(), { route: "/new" });
    type(XHS_VIDEO);
    fireEvent.click(screen.getByTestId("new-submit"));
    expect((await screen.findByTestId("new-problem-links")).textContent).toBe(message);
    expect(box().getAttribute("aria-invalid")).toBe("true");
    await pause();
    expect(imported(calls)).toHaveLength(1);
    expect(screen.queryByTestId("new-unverified")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/new");
  });

  it("drops a refusal once the box says something else, and never says it twice", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/contents/inspect": { body: { kind: "single", canonicalUrl: XHS_VIDEO, check: { result: "rejected", reason: "not_video" } } },
      "POST /api/contents/import": importError("invalid_request.not_video", "这是图文笔记，Amber 目前只处理视频", [XHS_VIDEO]),
    });
    await openPage(page(), { route: "/new" });
    type(XHS_VIDEO);
    await screen.findByTestId("import-check-rejected");
    fireEvent.click(screen.getByTestId("new-submit"));
    await screen.findByTestId("new-problem-links");
    expect(screen.queryByTestId("import-check-rejected")).toBeNull();
    type(YT_VIDEO);
    expect(screen.queryByTestId("new-problem-links")).toBeNull();
    expect(box().getAttribute("aria-invalid")).not.toBe("true");
  });

  it.each([
    ["updated", "已更新保存的来源链接", "success"],
    ["kept", "新链接暂时无法确认，保留了原来的链接", "info"],
  ])("tells once after the import that the stored source link was %s, and reads the Content afresh", async (result, message, tone) => {
    mockApi({
      ...baseRoutes(),
      "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: [], contentIds: ["c1"], sourceUrlUpdates: [{ contentId: "c1", result }] } },
    });
    let client: QueryClient | undefined;
    await openPage(
      page(undefined, (found) => {
        client = found;
      }),
      { route: "/new" },
    );
    client?.setQueryData(queryKeys.content("c1"), content("c1"));
    type(XHS_VIDEO);
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    const toasts = screen.getAllByTestId("toast");
    expect(toasts.map((toast) => toast.textContent)).toEqual([message]);
    expect(toasts[0]?.dataset["tone"]).toBe(tone);
    expect(client?.getQueryState(queryKeys.content("c1"))?.isInvalidated).toBe(true);
  });

  it("shows no source link notice when the import did not touch one", async () => {
    mockApi({ ...baseRoutes(), "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } } });
    await openPage(page(), { route: "/new" });
    type(XHS_VIDEO);
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1"));
    expect(screen.queryAllByTestId("toast")).toHaveLength(0);
  });
});

describe("NewPage choosing from the collection of a pasted video", () => {
  const box = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>("new-url-input");
  const dialog = (): HTMLElement => screen.getByTestId("collection-preview");
  const rows = (): HTMLElement[] => within(dialog()).queryAllByTestId("preview-entry");
  const chosen = (): string[] => rows().filter((element) => element.dataset["chosen"] === "true").map((element) => element.dataset["entryId"] ?? "");
  const imported = (calls: RecordedCalls) => calls.filter((call) => call.method === "POST" && call.path === "/api/contents/import");
  const OTHER_1 = "7301234567890123401";
  const OTHER_2 = "7301234567890123402";
  const RELATED = { platformCollectionId: `douyin:${DOUYIN_COLLECTION.split("/").pop() ?? ""}`, title: "示例合集", itemCount: 3, index: 2, canonicalUrl: DOUYIN_COLLECTION };
  const entryUrl = (id: string): string => `https://www.douyin.com/video/${id}`;

  /** The inspect route: the video's check (with `related`, if any), and the collection's preview. */
  function routes(related: Record<string, unknown> | undefined) {
    const collection = fakeInspect([
      {
        url: DOUYIN_COLLECTION,
        title: "示例合集",
        pageSize: 50,
        entries: [
          { id: OTHER_1, title: "第 1 集", canonicalUrl: entryUrl(OTHER_1) },
          { id: DOUYIN_ID, title: "第 2 集", canonicalUrl: DOUYIN_VIDEO, state: "in_library" },
          { id: OTHER_2, title: "第 3 集", canonicalUrl: entryUrl(OTHER_2) },
        ],
      },
    ]);
    const single = {
      kind: "single",
      canonicalUrl: DOUYIN_VIDEO,
      title: "第 2 集",
      check: { result: "video", title: "第 2 集", durationMs: 60_000 },
      ...(related === undefined ? {} : { relatedCollection: related }),
    };
    return {
      collection,
      routes: {
        ...baseRoutes(),
        "POST /api/contents/inspect": (call: RecordedCalls[number]) => ((call.body as InspectRequest).url === DOUYIN_COLLECTION ? collection.reply(call) : { body: single }),
        "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1", "t2"], contentIds: ["c1", "c2"], collectionIds: ["k5"] } },
      },
    };
  }

  it("names the collection on the line under the box, and without choosing sends the video alone", async () => {
    const { routes: table } = routes(RELATED);
    const { calls } = mockApi(table);
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: DOUYIN_VIDEO } });
    await screen.findByTestId("import-check-collection");
    expect(screen.getByTestId("link-recognition").textContent).toBe("属于合集「示例合集」·共 3 集·选择合集中的视频");
    fireEvent.click(screen.getByTestId("new-submit"));
    await waitFor(() => expect(imported(calls)).toHaveLength(1));
    expect((imported(calls)[0]?.body as { items: unknown[] }).items).toEqual([{ url: DOUYIN_VIDEO }]);
    expect(screen.queryByTestId("collection-preview")).toBeNull();
  });

  it("leaves the count out when the platform does not give it, and the sentence out for a video in no collection", async () => {
    const { itemCount: _count, ...uncounted } = RELATED;
    mockApi(routes(uncounted).routes);
    const { unmount } = await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: DOUYIN_VIDEO } });
    await screen.findByTestId("import-check-collection");
    expect(screen.getByTestId("link-recognition").textContent).toBe("属于合集「示例合集」·选择合集中的视频");
    unmount();
    mockApi(routes(undefined).routes);
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: DOUYIN_VIDEO } });
    await screen.findByTestId("import-check-video");
    expect(screen.queryByTestId("import-check-collection")).toBeNull();
    expect(screen.getByTestId("link-recognition").textContent).toBe("第 2 集·1:00");
  });

  it("opens the collection's preview with only this video chosen; cancelling sends nothing", async () => {
    const { routes: table, collection } = routes(RELATED);
    const { calls } = mockApi(table);
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: DOUYIN_VIDEO } });
    fireEvent.click(await screen.findByTestId("import-check-choose"));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(collection.requests[0]).toEqual({ url: DOUYIN_COLLECTION });
    await waitFor(() => expect(chosen()).toEqual([DOUYIN_ID]));
    // No other link is in the batch: the video's place is taken by the collection.
    expect(within(dialog()).getByTestId("preview-submit").textContent).toBe("开始处理 1 项");
    fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("collection-preview")).toBeNull());
    expect(imported(calls)).toHaveLength(0);
  });

  it("sends the entries chosen in the preview in the video's place, the video once", async () => {
    const { routes: table } = routes(RELATED);
    const { calls } = mockApi(table);
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: DOUYIN_VIDEO } });
    fireEvent.click(await screen.findByTestId("import-check-choose"));
    await waitFor(() => expect(chosen()).toEqual([DOUYIN_ID]));
    const row = rows().find((element) => element.dataset["entryId"] === OTHER_2);
    if (row === undefined) throw new Error("no row");
    fireEvent.click(row);
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/k5"));
    expect(imported(calls)).toHaveLength(1);
    const body = imported(calls)[0]?.body as { items: Array<{ url: string; entries?: string[] }> };
    expect(body.items).toEqual([{ url: DOUYIN_COLLECTION, entries: [DOUYIN_ID, OTHER_2], previewId: "pv1" }]);
    expect(body.items.flatMap((item) => item.entries ?? []).filter((id) => id === DOUYIN_ID)).toHaveLength(1);
    expect(body.items.some((item) => item.url === DOUYIN_VIDEO)).toBe(false);
  });
});

describe("NewPage bilibili login hint", () => {
  const box = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>("new-url-input");
  const accounts = (bilibili: Record<string, unknown>) => ({
    body: {
      accounts: [
        { platform: "bilibili", ...bilibili },
        { platform: "youtube", credentialStatus: "missing", hasCredential: false },
        { platform: "xiaohongshu", credentialStatus: "missing", hasCredential: false },
        { platform: "douyin", credentialStatus: "missing", hasCredential: false },
      ],
    },
  });
  const NONE = { credentialStatus: "missing", hasCredential: false };
  const EXPIRED = { credentialStatus: "configured", hasCredential: true, status: "expired", checkedAt: 1 };
  const VALID = { credentialStatus: "configured", hasCredential: true, status: "valid", checkedAt: 1 };

  it.each([
    [NONE, "未登录 B 站，字幕会用语音转录获取·去登录"],
    [EXPIRED, "B 站登录已失效·重新登录"],
  ])("ends the line with a pointer to the bilibili login when it is not valid", async (bilibili, expected) => {
    mockApi({ ...baseRoutes(), "GET /api/platform-accounts": accounts(bilibili) });
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: MULTI_P } });
    const hint = await screen.findByTestId("bilibili-login-hint");
    expect(hint.textContent).toBe(expected);
    expect(screen.getByTestId("bilibili-login-link").getAttribute("href")).toBe("/settings/platform-accounts?focus=bilibili");
    // A quiet line, not a dialog, and nothing is held back.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>("new-submit").disabled).toBe(false);
    // After the batch sentence, at the end of the same line.
    fireEvent.change(box(), { target: { value: `${MULTI_P}\n${YT_VIDEO}` } });
    expect(screen.getByTestId("link-recognition").textContent).toBe(`已识别 2 条链接，将作为一批导入·${expected}`);
  });

  it("says nothing with a valid login", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "GET /api/platform-accounts": accounts(VALID) });
    await openPage(page(), { route: "/new" });
    fireEvent.change(box(), { target: { value: MULTI_P } });
    await waitFor(() => expect(calls.some((call) => call.path === "/api/platform-accounts")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("bilibili-login-hint")).toBeNull();
  });

  it("says nothing for YouTube, Xiaohongshu or Douyin links, and does not read the logins for them", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "GET /api/platform-accounts": accounts(NONE) });
    await openPage(page(), { route: "/new" });
    for (const text of [YT_VIDEO, XHS_VIDEO, DOUYIN_VIDEO]) {
      fireEvent.change(box(), { target: { value: text } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByTestId("bilibili-login-hint")).toBeNull();
    }
    expect(calls.some((call) => call.path === "/api/platform-accounts")).toBe(false);
  });
});

describe("NewPage before the settings and the model list are read", () => {
  type Read = "settings" | "providers";
  const READ_PATHS: Readonly<Record<string, Read>> = { "/api/settings": "settings", "/api/providers": "providers" };
  const INTERNAL = { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } };
  const M1 = { providerProfileId: "p1", modelId: "m1" };
  const UNVERIFIED = {
    status: 400,
    body: { error: { class: "invalid_request", code: "invalid_request.link_unverified", retryDisposition: "never", userMessage: "", details: { urls: [DOUYIN_VIDEO] } } },
  };
  const DUPLICATE = {
    status: 409,
    body: { error: { class: "conflict", code: "conflict.duplicate_file", retryDisposition: "never", userMessage: "已有相同的文件", details: { duplicateOfContentId: "c0" } } },
  };
  const ACCEPTED = { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } };
  const sent = (calls: RecordedCalls) => calls.filter((call) => call.method === "POST" && ["/api/contents/import", "/api/contents/upload", "/api/contents/local-file"].includes(call.path));
  const form = (): HTMLFormElement => screen.getByTestId("new-submit").closest("form") as HTMLFormElement;
  const submitButton = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>("new-submit");
  const box = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>("new-url-input");
  const gateOf = (): string | null => form().getAttribute("data-gate");

  /**
   * The routes, with the two reads answering only when let go (`hold`) or failing (`fail`);
   * `client` is the page's query client, for reading them again as a background refresh would.
   */
  function reads(routes: Record<string, unknown>) {
    const { calls } = mockApi(routes as Parameters<typeof mockApi>[0]);
    const routed = globalThis.fetch;
    const holding = new Set<Read>();
    const failing = new Set<Read>();
    const waiting: Array<{ read: Read; go: () => void }> = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      const read = (init.method ?? "GET").toUpperCase() === "GET" ? READ_PATHS[String(input)] : undefined;
      if (read !== undefined && holding.has(read)) await new Promise<void>((go) => waiting.push({ read, go }));
      if (read !== undefined && failing.has(read)) return new Response(JSON.stringify(INTERNAL), { status: 500, headers: { "content-type": "application/json" } });
      return routed(input, init);
    });
    const state = { client: undefined as QueryClient | undefined };
    return {
      calls,
      state,
      hold: (read: Read) => holding.add(read),
      release: (read: Read) => {
        holding.delete(read);
        for (const entry of waiting.splice(0).filter((candidate) => candidate.read === read)) entry.go();
      },
      fail: (read: Read) => failing.add(read),
      heal: (read: Read) => failing.delete(read),
      /** Reads `read` afresh with nothing kept, the way it is read for the first time. */
      reread: async (read: Read) => {
        await act(async () => {
          void state.client?.resetQueries({ queryKey: read === "settings" ? queryKeys.settings : queryKeys.providers });
        });
      },
      render: (options: { mode?: "local" | "server" } = {}) =>
        renderApp(
          page(undefined, (found) => {
            state.client = found;
          }),
          { route: "/new", ...(options.mode === undefined ? {} : { mode: options.mode }) },
        ),
    };
  }

  async function openSettings(): Promise<HTMLElement> {
    if (screen.queryByRole("combobox", { name: "AI 模型" }) === null) fireEvent.click(screen.getByRole("button", { name: "本次设置" }));
    return screen.findByRole("combobox", { name: "AI 模型" });
  }

  /** Opens the preview from the line under the box and presses its 「开始处理」. */
  async function confirmFromLine(): Promise<void> {
    fireEvent.change(box(), { target: { value: YT_LIST } });
    fireEvent.click(screen.getByRole("button", { name: "预览合集" }));
    await confirmPreview();
    await waitFor(() => expect(screen.queryByTestId("collection-preview")).toBeNull());
  }

  /** Gets the unverified offer on screen with everything read, by an import the server could not verify. */
  async function offerUnverified(): Promise<void> {
    fireEvent.change(box(), { target: { value: DOUYIN_VIDEO } });
    fireEvent.click(submitButton());
    await screen.findByTestId("new-unverified");
  }

  /** Gets the duplicate offer on screen with everything read, by an upload of a file already imported. */
  async function offerDuplicate(): Promise<void> {
    const tab = await screen.findByRole("tab", { name: "上传本地文件" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.change(await screen.findByTestId("upload-file"), { target: { files: [new File([new Uint8Array([1])], "lecture.mp4", { type: "video/mp4" })] } });
    fireEvent.click(submitButton());
    await screen.findByTestId("upload-anyway");
  }

  const routesWithModel = (extra: Record<string, unknown> = {}) => ({
    ...baseRoutes({ mode: "server" }),
    "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1", "m2"])] } },
    "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: M1 } },
    "POST /api/contents/inspect": fakeInspect([{ url: YT_LIST, title: "示例播放列表", pageSize: 50, entries: newEntries(2, "y") }]).reply,
    ...extra,
  });

  it.each<Read>(["settings", "providers"])("sends nothing from any of the five ways while %s is still being read, the model menu saying so", async (read) => {
    let uploads = 0;
    const api = reads(
      routesWithModel({
        "POST /api/contents/import": UNVERIFIED,
        "POST /api/contents/upload": () => {
          uploads += 1;
          return DUPLICATE;
        },
      }),
    );
    api.hold(read);
    api.render({ mode: "server" });
    await screen.findByTestId("new-url-input");
    expect(gateOf()).toBe("loading");
    expect((await openSettings()).textContent).toBe("正在读取…");
    fireEvent.change(box(), { target: { value: VIDEO } });
    expect(submitButton().disabled).toBe(true);
    // Enter in the box submits the form, whatever the button shows.
    fireEvent.submit(form());
    fireEvent.click(submitButton());
    await confirmFromLine();
    expect(sent(api.calls)).toHaveLength(0);

    // The two 「仍然导入」 appear only after an import was answered: read once, then read again from nothing.
    api.release(read);
    await waitFor(() => expect(gateOf()).toBe("ready"));
    await offerUnverified();
    api.hold(read);
    await api.reread(read);
    await waitFor(() => expect(gateOf()).toBe("loading"));
    fireEvent.click(screen.getByTestId("new-import-unverified"));
    expect(sent(api.calls)).toHaveLength(1);

    api.release(read);
    await waitFor(() => expect(gateOf()).toBe("ready"));
    await offerDuplicate();
    expect(uploads).toBe(1);
    api.hold(read);
    await api.reread(read);
    await waitFor(() => expect(gateOf()).toBe("loading"));
    expect(screen.getByTestId<HTMLButtonElement>("upload-anyway").disabled).toBe(true);
    fireEvent.click(screen.getByTestId("upload-anyway"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads).toBe(1);
    api.release(read);
  });

  it.each<Read>(["settings", "providers"])("says in place that %s could not be read, sends nothing, and sends with the model once 「重试」 reads it", async (read) => {
    const api = reads(routesWithModel({ "POST /api/contents/import": ACCEPTED }));
    api.fail(read);
    api.render();
    expect((await screen.findByTestId("new-settings-failed")).textContent).toBe("没有读取到设置或模型列表，暂时无法提交重试");
    expect(gateOf()).toBe("failed");
    fireEvent.change(box(), { target: { value: VIDEO } });
    fireEvent.submit(form());
    expect(submitButton().disabled).toBe(true);
    await confirmFromLine();
    expect(sent(api.calls)).toHaveLength(0);

    api.heal(read);
    fireEvent.click(screen.getByTestId("new-settings-retry"));
    await waitFor(() => expect(gateOf()).toBe("ready"));
    expect(screen.queryByTestId("new-settings-failed")).toBeNull();
    fireEvent.change(box(), { target: { value: VIDEO } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(sent(api.calls)).toHaveLength(1));
    expect((sent(api.calls)[0]?.body as { settings: unknown }).settings).toMatchObject({ modelRef: M1 });
  });

  it("holds both 「仍然导入」 while a read made again fails, and lets them go once it is read", async () => {
    let imports = 0;
    let uploads = 0;
    const api = reads(
      routesWithModel({
        "POST /api/contents/import": () => {
          imports += 1;
          return imports === 1 ? UNVERIFIED : ACCEPTED;
        },
        "POST /api/contents/upload": () => {
          uploads += 1;
          return uploads === 1 ? DUPLICATE : ACCEPTED;
        },
      }),
    );
    api.render({ mode: "server" });
    await waitFor(() => expect(gateOf()).toBe("ready"));
    await offerUnverified();
    api.fail("settings");
    await api.reread("settings");
    await screen.findByTestId("new-settings-failed");
    fireEvent.click(screen.getByTestId("new-import-unverified"));
    expect(imports).toBe(1);
    api.heal("settings");
    fireEvent.click(screen.getByTestId("new-settings-retry"));
    await waitFor(() => expect(gateOf()).toBe("ready"));
    fireEvent.click(screen.getByTestId("new-import-unverified"));
    await waitFor(() => expect(imports).toBe(2));
    expect(sent(api.calls).at(-1)?.body).toMatchObject({ items: [{ url: DOUYIN_VIDEO, acceptUnverified: true }], settings: { modelRef: M1 } });
  });

  it("submits without a model when there is no model service, saying so in other words than a failed read", async () => {
    const api = reads({ ...baseRoutes(), "POST /api/contents/import": ACCEPTED });
    api.render();
    const banner = await screen.findByTestId("no-llm-banner");
    await waitFor(() => expect(gateOf()).toBe("ready"));
    expect(screen.queryByTestId("new-settings-failed")).toBeNull();
    expect(banner.textContent).not.toContain("没有读取到设置或模型列表");
    fireEvent.change(box(), { target: { value: VIDEO } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(sent(api.calls)).toHaveLength(1));
    expect((sent(api.calls)[0]?.body as { settings: object }).settings).not.toHaveProperty("modelRef");
  });

  it("keeps a default model that is gone shown as unavailable, sends nothing until another is chosen, then sends that one", async () => {
    const api = reads(
      routesWithModel({
        "GET /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "gone" } } },
        "POST /api/contents/import": ACCEPTED,
      }),
    );
    api.render();
    await waitFor(() => expect(gateOf()).toBe("model_gone"));
    // The settings open by themselves to show the choice to make.
    const select = await screen.findByRole("combobox", { name: "AI 模型" });
    expect(select.textContent).toBe("我的模型 · gone（不可用）");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("new-model-gone").textContent).toBe("原默认模型已不可用，请重新选择模型");
    expect(select.getAttribute("aria-describedby")).toBe(screen.getByTestId("new-model-gone").id);
    fireEvent.change(box(), { target: { value: VIDEO } });
    fireEvent.submit(form());
    expect(submitButton().disabled).toBe(true);
    await confirmFromLine();
    expect(sent(api.calls)).toHaveLength(0);

    await chooseOption(select, "m2");
    await waitFor(() => expect(gateOf()).toBe("ready"));
    expect(screen.queryByTestId("new-model-gone")).toBeNull();
    fireEvent.change(box(), { target: { value: VIDEO } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(sent(api.calls)).toHaveLength(1));
    expect((sent(api.calls)[0]?.body as { settings: unknown }).settings).toMatchObject({ modelRef: { providerProfileId: "p1", modelId: "m2" } });
  });

  it("holds both 「仍然导入」 once the default model disappears from a list read again", async () => {
    let uploads = 0;
    const api = reads(
      routesWithModel({
        "POST /api/contents/import": UNVERIFIED,
        "POST /api/contents/upload": () => {
          uploads += 1;
          return DUPLICATE;
        },
      }),
    );
    api.render({ mode: "server" });
    await waitFor(() => expect(gateOf()).toBe("ready"));
    await offerUnverified();
    act(() => {
      api.state.client?.setQueryData(queryKeys.providers, { items: [provider("p1", "我的模型", ["m2"])] });
    });
    await waitFor(() => expect(gateOf()).toBe("model_gone"));
    fireEvent.click(screen.getByTestId("new-import-unverified"));
    expect(sent(api.calls)).toHaveLength(1);
    act(() => {
      api.state.client?.setQueryData(queryKeys.providers, { items: [provider("p1", "我的模型", ["m1", "m2"])] });
    });
    await waitFor(() => expect(gateOf()).toBe("ready"));
    await offerDuplicate();
    act(() => {
      api.state.client?.setQueryData(queryKeys.providers, { items: [provider("p1", "我的模型", ["m2"])] });
    });
    await waitFor(() => expect(gateOf()).toBe("model_gone"));
    fireEvent.click(screen.getByTestId("upload-anyway"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads).toBe(1);
  });

  it("chooses the first model without a default, and keeps the user's choice when both are read again", async () => {
    const api = reads(
      routesWithModel({
        "GET /api/settings": { body: SETTINGS },
        "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1", "m2"]), provider("p2", "备用", ["m3"])] } },
        "POST /api/contents/import": ACCEPTED,
      }),
    );
    api.render();
    await waitFor(() => expect(gateOf()).toBe("ready"));
    const select = await openSettings();
    expect(select.textContent).toBe("我的模型 · m1");
    await chooseOption(select, "m3", "备用");
    expect(select.textContent).toBe("备用 · m3");
    await act(async () => {
      await api.state.client?.refetchQueries({ queryKey: queryKeys.settings });
      await api.state.client?.refetchQueries({ queryKey: queryKeys.providers });
    });
    expect(api.calls.filter((call) => call.path === "/api/providers").length).toBeGreaterThan(1);
    expect(screen.getByRole("combobox", { name: "AI 模型" }).textContent).toBe("备用 · m3");
    fireEvent.change(box(), { target: { value: VIDEO } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(sent(api.calls)).toHaveLength(1));
    expect((sent(api.calls)[0]?.body as { settings: unknown }).settings).toMatchObject({ modelRef: { providerProfileId: "p2", modelId: "m3" } });
  });
});
