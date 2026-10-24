import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MediaAssetDto } from "../../../../src/shared/dto/content.ts";
import type { CacheMediaInspectDto } from "../../../../src/shared/dto/media.ts";
import { CacheMediaDialog, cacheBlockers, cacheMediaRequest, cacheRowsOf } from "../../../../src/web/pages/content/cache-media-dialog.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { task } from "../../../fixtures/web/shell-data.ts";

const GB = 1024 ** 3;
const DISK = { cache: { freeBytes: 100 * GB, lowWaterBytes: 10 * GB }, ok: true };

function inspection(overrides: Partial<CacheMediaInspectDto> = {}): CacheMediaInspectDto {
  return {
    expected: { type: "video", height: 1080, ext: "mp4" },
    expectedFileName: "第一讲 [1080P].mp4",
    replaces: [],
    foreignFile: false,
    pendingName: false,
    recoveryHold: false,
    disk: DISK,
    caches: [],
    ...overrides,
  };
}

function cache(id: string, overrides: Partial<MediaAssetDto>): MediaAssetDto {
  return {
    id,
    kind: "platform_cache",
    mimeType: "video/mp4",
    sizeBytes: GB,
    availability: "available",
    retentionPolicy: "evictable",
    createdAt: 1,
    displayName: `${id}.mp4`,
    ...overrides,
  };
}

const INSPECT = "POST /api/contents/c1/cache-media/inspect";
const START = "POST /api/contents/c1/cache-media";

function show(routes: Parameters<typeof mockApi>[0], media: MediaAssetDto[] = []) {
  const api = mockApi({ [START]: { status: 202, body: { taskId: "t1" } }, ...routes });
  const onStarted = vi.fn<(taskId: string) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  renderApp(<CacheMediaDialog contentId="c1" title="第一讲" media={media} open onOpenChange={onOpenChange} onStarted={onStarted} />);
  return { ...api, onStarted, onOpenChange, dialog: screen.getByRole("dialog", { name: "缓存本视频" }) };
}

async function inspect(dialog: HTMLElement): Promise<HTMLButtonElement> {
  fireEvent.click(within(dialog).getByTestId("cache-inspect"));
  return (await within(dialog).findByTestId("cache-confirm")) as HTMLButtonElement;
}

describe("cacheMediaRequest", () => {
  it("sends the height cap with a video only, and the overwrite confirmation when given", () => {
    expect(cacheMediaRequest("video", 480, "第一讲")).toEqual({ type: "video", quality: 480, fileName: "第一讲" });
    expect(cacheMediaRequest("audio", 480, "第一讲")).toEqual({ type: "audio", fileName: "第一讲" });
    expect(cacheMediaRequest("video", 720, "第一讲", "a9")).toEqual({ type: "video", quality: 720, fileName: "第一讲", overwriteAssetId: "a9" });
  });
});

describe("cacheBlockers", () => {
  it("lists every reason the request cannot start", () => {
    expect(cacheBlockers(inspection())).toEqual([]);
    expect(cacheBlockers(inspection({ foreignFile: true, pendingName: true, recoveryHold: true, disk: { ...DISK, ok: false } }))).toEqual([
      "foreignFile",
      "pendingName",
      "recoveryHold",
      "diskLow",
    ]);
  });
});

describe("cacheRowsOf", () => {
  it("lists the available caches, video by quality with unknown last, then audio", () => {
    const rows = cacheRowsOf([
      cache("old", { quality: "", createdAt: 9 }),
      cache("aud", { mimeType: "audio/mpeg", displayName: "第一讲.mp3" }),
      cache("sd", { quality: "720" }),
      cache("hd", { quality: "1080" }),
      cache("gone", { quality: "2160", availability: "evicted" }),
      cache("orig", { kind: "external_local" }),
    ]);
    expect(rows.map((row) => [row.assetId, row.type, row.height])).toEqual([
      ["hd", "video", 1080],
      ["sd", "video", 720],
      ["old", "video", undefined],
      ["aud", "audio", undefined],
    ]);
  });
});

describe("CacheMediaDialog", () => {
  it("inspects first, then starts the cache the user confirmed", async () => {
    const { dialog, calls, onStarted, onOpenChange } = show({ [INSPECT]: { body: inspection({ replaces: [{ assetId: "old", fileName: "第一讲 [1080P].mp4", height: 1080, sizeBytes: GB }] }) } });
    // Nothing is sent before the user asks.
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(within(dialog).queryByTestId("cache-confirm")).toBeNull();
    const confirm = await inspect(dialog);
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [1080P].mp4（预估，以下载后的实际画质为准）");
    expect(within(dialog).getByTestId("cache-replaces").textContent).toBe("将替换现有 1080P 缓存");
    expect(confirm.textContent).toBe("确认缓存");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => [call.path, call.body])).toEqual([
      ["/api/contents/c1/cache-media/inspect", { type: "video", quality: 1080, fileName: "第一讲" }],
      ["/api/contents/c1/cache-media", { type: "video", quality: 1080, fileName: "第一讲" }],
    ]);
    expect(posts[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(posts[1]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("says while inspecting, and inspects again after the choice changes", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    const { dialog, calls } = show({ [INSPECT]: { body: inspection({ expected: { type: "video", ext: "mp4" }, expectedFileName: "第一讲 [?P].mp4" }) } });
    // The inspection answers only when the test says so.
    const answered = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/inspect")) await pending;
      return answered(input, init);
    });
    const button = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("正在探测可用画质…"));
    expect(button.disabled).toBe(true);
    answer(undefined);
    expect((await within(dialog).findByTestId("cache-expected-name")).textContent).toBe("将保存为 第一讲 [?P].mp4，实际画质下载后确定");
    fireEvent.change(within(dialog).getByTestId("cache-file-name"), { target: { value: "第二讲" } });
    expect(within(dialog).queryByTestId("cache-expected-name")).toBeNull();
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/contents/c1/cache-media/inspect"]);
  });

  it("says when a picture-less source becomes an MP3", async () => {
    const { dialog } = show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }) } });
    await inspect(dialog);
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("源无画面，将缓存为 MP3：第一讲.mp3");
  });

  it("overwrites another Content's cache only once the user ticks the confirmation", async () => {
    const overwrite = { assetId: "x1", contentId: "c9", title: "另一讲", fileName: "第一讲 [1080P].mp4", sizeBytes: 2 * GB };
    const { dialog, calls } = show({ [INSPECT]: { body: inspection({ overwrite }) } });
    const confirm = await inspect(dialog);
    const area = within(dialog).getByTestId("cache-overwrite");
    expect(area.textContent).toContain("另一条内容「另一讲」已有同名缓存 第一讲 [1080P].mp4（2.0 GB）");
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(area).getByTestId("cache-overwrite-confirm"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.find((call) => call.path === "/api/contents/c1/cache-media")?.body).toEqual({ type: "video", quality: 1080, fileName: "第一讲", overwriteAssetId: "x1" }));
  });

  it("names every reason the cache cannot start and keeps it disabled", async () => {
    const { dialog } = show({
      [INSPECT]: {
        body: inspection({
          foreignFile: true,
          pendingName: true,
          recoveryHold: true,
          disk: { cache: { freeBytes: 5 * GB, lowWaterBytes: 10 * GB }, data: { freeBytes: 8 * GB, lowWaterBytes: 10 * GB }, ok: false },
        }),
      },
    });
    const confirm = await inspect(dialog);
    expect(confirm.disabled).toBe(true);
    const reasons = [...within(dialog).getByTestId("cache-blocked").querySelectorAll("li")].map((item) => item.textContent);
    expect(reasons).toEqual([
      "缓存目录中已有同名文件，但它不是 Amber 登记的缓存：请先把它移走或改名，或改用其它文件名。",
      "另一个缓存任务正在使用这个文件名：请等它结束后再试，或改用其它文件名。",
      "这个文件有一次未完成的替换等待处理：请先到「功能配置 › 存储」处理。",
      "磁盘剩余空间不足，暂不能缓存。 缓存所在磁盘剩余 5.0 GB，需保留 10.0 GB; 数据目录所在磁盘剩余 8.0 GB，需保留 10.0 GB",
    ]);
  });

  it("shows a name conflict found at submit and inspects again on the next click", async () => {
    const conflict = { class: "conflict", code: "conflict.cache_name_taken", retryDisposition: "never", userMessage: "缓存目录中已有同名的缓存文件，请确认覆盖或改用其它文件名" };
    const { dialog } = show({ [INSPECT]: { body: inspection() }, [START]: { status: 409, body: { error: conflict } } });
    fireEvent.click(await inspect(dialog));
    expect(await within(dialog).findByText("缓存目录中已有同名的缓存文件，请确认覆盖或改用其它文件名")).toBeTruthy();
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
  });

  it("lists the Content's caches and deletes one after confirmation", async () => {
    const media = [cache("hd", { quality: "1080", sizeBytes: GB }), cache("aud", { mimeType: "audio/mpeg", displayName: "第一讲.mp3", sizeBytes: 50 * 1024 ** 2 })];
    const { dialog, calls } = show({ "DELETE /api/media/hd": { status: 204 }, "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } } }, media);
    const list = within(dialog).getByTestId("cache-list");
    expect([...list.querySelectorAll("li")].map((row) => [...row.children].slice(0, 3).map((cell) => cell.textContent))).toEqual([
      ["1080P", "hd.mp4", "1.0 GB"],
      ["音频", "第一讲.mp3", "50.0 MB"],
    ]);
    const remove = within(list).getByTestId("cache-delete-hd") as HTMLButtonElement;
    await waitFor(() => expect(calls.some((call) => call.path === "/api/tasks?unfinished=1")).toBe(true));
    fireEvent.click(remove);
    const confirm = await screen.findByRole("dialog", { name: "删除这份缓存？" });
    expect(confirm.textContent).toContain("将从缓存目录删除 hd.mp4");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/media/hd"]));
  });

  it("lists the caches the inspection reports, and keeps deleting off while the Content has unfinished Tasks", async () => {
    const { dialog } = show({
      [INSPECT]: {
        body: inspection({
          caches: [
            { assetId: "sd", type: "video", height: 720, verified: true, fileName: "第一讲 [720P].mp4", sizeBytes: GB, createdAt: 2 },
            { assetId: "old", type: "video", verified: true, fileName: "第一讲.mp4", sizeBytes: GB, createdAt: 1 },
          ],
        }),
      },
      "GET /api/tasks?unfinished=1": { body: { items: [task("t9", { kind: "cache_media", contentId: "c1" })], eventSeq: 0 } },
    });
    expect(within(dialog).queryByTestId("cache-list")).toBeNull();
    await inspect(dialog);
    const list = within(dialog).getByTestId("cache-list");
    expect([...list.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent)).toEqual(["720P", "未知画质"]);
    const remove = within(list).getByTestId("cache-delete-sd") as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(true));
    expect(remove.getAttribute("title")).toBe("这条内容还有未结束的任务，结束后才能删除缓存");
  });
});
