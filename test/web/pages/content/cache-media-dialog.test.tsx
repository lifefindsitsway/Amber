import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MediaAssetDto } from "../../../../src/shared/dto/content.ts";
import type { CacheMediaInspectDto } from "../../../../src/shared/dto/media.ts";
import { CacheMediaDialog, cacheBlockers, cacheMediaRequest, cacheRowsOf, defaultCacheQuality, needsReview } from "../../../../src/web/pages/content/cache-media-dialog.tsx";
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
const QUALITIES = "GET /api/contents/c1/cache-media/qualities";
const PROBING = "正在探测可用画质…";
/** The probe answer that keeps the general-purpose caps and their default. */
const GENERAL = { body: { status: "available", qualities: [360, 480, 720, 1080] } };

/**
 * Renders the dialog and waits until the quality probe has answered, unless `holdProbes`
 * leaves the probes to the test.
 */
async function show(routes: Parameters<typeof mockApi>[0], media: MediaAssetDto[] = [], options: { holdProbes?: boolean } = {}) {
  const api = mockApi({ [QUALITIES]: GENERAL, [START]: { status: 202, body: { taskId: "t1" } }, ...routes });
  const probes = options.holdProbes === true ? holdProbes() : [];
  const onStarted = vi.fn<(taskId: string) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  renderApp(<CacheMediaDialog contentId="c1" title="第一讲" media={media} open onOpenChange={onOpenChange} onStarted={onStarted} />);
  const dialog = screen.getByRole("dialog", { name: "缓存本视频" });
  if (options.holdProbes !== true) await settled(dialog);
  return { ...api, probes, onStarted, onOpenChange, dialog };
}

/** Waits until the quality probe has answered. */
async function settled(dialog: HTMLElement): Promise<void> {
  await waitFor(() => expect(within(dialog).queryByText(PROBING)).toBeNull());
}

/**
 * Takes over the quality probes from the stubbed API: each one waits until the test answers
 * it, and nothing here honours the abort signal, so an aborted probe can still answer late.
 */
function holdProbes(): Array<{ signal: AbortSignal | undefined; answer: (body: unknown, status?: number) => void }> {
  const probes: Array<{ signal: AbortSignal | undefined; answer: (body: unknown, status?: number) => void }> = [];
  const answered = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (!String(input).endsWith("/cache-media/qualities")) return answered(input, init);
    return new Promise<Response>((resolve) => {
      probes.push({
        signal: init?.signal ?? undefined,
        answer: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
      });
    });
  });
  return probes;
}

const optionsOf = (dialog: HTMLElement): Array<string | null> => [...(within(dialog).getByTestId("cache-quality") as HTMLSelectElement).options].map((option) => option.textContent);

/** Holds the answers to the matching requests until `release` is called; stub the API first. */
function holdRequests(match: (url: string) => boolean): () => void {
  let release: (value: unknown) => void = () => undefined;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const answered = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (match(String(input))) await held;
    return answered(input, init);
  });
  return () => release(undefined);
}

const isInspect = (url: string): boolean => url.endsWith("/cache-media/inspect");
const isStart = (url: string): boolean => url.endsWith("/cache-media");

/** The dialog as a page opens it: closing it unmounts the form. */
function Opened(props: { onStarted: (taskId: string) => void }) {
  const [open, setOpen] = useState(true);
  return <CacheMediaDialog contentId="c1" title="第一讲" media={[]} open={open} onOpenChange={setOpen} onStarted={props.onStarted} />;
}

const REPLACED = { assetId: "old", fileName: "第一讲 [1080P].mp4", height: 1080, sizeBytes: GB };

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

describe("needsReview", () => {
  const overwrite = { assetId: "x1", contentId: "c9", fileName: "第一讲 [1080P].mp4", sizeBytes: GB };
  it.each([
    ["nothing to decide", inspection(), "video", false],
    ["an unknown height", inspection({ expected: { type: "video", ext: "mp4" }, expectedFileName: "第一讲 [?P].mp4" }), "video", false],
    ["audio asked and expected", inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }), "audio", false],
    ["a cache of this Content replaced", inspection({ replaces: [REPLACED] }), "video", true],
    ["another Content's cache overwritten", inspection({ overwrite }), "video", true],
    ["a foreign file", inspection({ foreignFile: true }), "video", true],
    ["another Content's unfinished Task", inspection({ pendingName: true }), "video", true],
    ["an interrupted replacement", inspection({ recoveryHold: true }), "video", true],
    ["a low disk", inspection({ disk: { ...DISK, ok: false } }), "video", true],
    ["audio where a video was asked", inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }), "video", true],
  ] as const)("%s → %s", (_case, answer, type, expected) => {
    expect(needsReview(answer, type)).toBe(expected);
  });

  it.each([
    ["the requested height", inspection(), "video", 1080, false],
    ["another height than requested", inspection({ expected: { type: "video", height: 720, ext: "mp4" } }), "video", 1080, true],
    ["a higher height than requested", inspection(), "video", 720, true],
    ["an unknown height", inspection({ expected: { type: "video", ext: "mp4" }, expectedFileName: "第一讲 [?P].mp4" }), "video", 1080, true],
    ["audio asked and expected", inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }), "audio", 1080, false],
  ] as const)("given the requested quality, %s → %s", (_case, answer, type, quality, expected) => {
    expect(needsReview(answer, type, quality)).toBe(expected);
  });
});

describe("defaultCacheQuality", () => {
  it("takes the highest quality up to the default cap, else the highest there is", () => {
    expect(defaultCacheQuality([360, 480, 720])).toBe(720);
    expect(defaultCacheQuality([360, 720, 1080, 1440])).toBe(1080);
    expect(defaultCacheQuality([1440, 360, 2160])).toBe(360);
    expect(defaultCacheQuality([1440, 2160])).toBe(2160);
    expect(defaultCacheQuality([240])).toBe(240);
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
  it("starts right after the inspection when nothing needs the user", async () => {
    const { dialog, calls, onStarted, onOpenChange } = await show({ [INSPECT]: { body: inspection() } });
    const release = holdRequests(isStart);
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    const button = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    await waitFor(() => expect(button.textContent).toBe("正在开始缓存…"));
    expect(button.disabled).toBe(true);
    expect((within(dialog).getByTestId("cache-file-name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).disabled).toBe(true);
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    expect(within(dialog).queryByTestId("cache-confirm")).toBeNull();
    release();
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(within(dialog).queryByTestId("cache-confirm")).toBeNull();
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => [call.path, call.body])).toEqual([
      ["/api/contents/c1/cache-media/inspect", { type: "video", quality: 1080, fileName: "第一讲" }],
      ["/api/contents/c1/cache-media", { type: "video", quality: 1080, fileName: "第一讲" }],
    ]);
    expect(posts[1]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("starts an audio cache right away", async () => {
    const audio = await show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }) } });
    fireEvent.click(within(audio.dialog).getByTestId("cache-type-audio"));
    fireEvent.click(within(audio.dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(audio.onStarted).toHaveBeenCalledWith("t1"));
    expect(audio.calls.find((call) => call.path === "/api/contents/c1/cache-media")?.body).toEqual({ type: "audio", fileName: "第一讲" });
  });

  it("stops on a video whose height is unknown until the download, and starts it once confirmed", async () => {
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { body: inspection({ expected: { type: "video", ext: "mp4" }, expectedFileName: "第一讲 [?P].mp4" }) } });
    const confirm = await inspect(dialog);
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [?P].mp4，实际画质下载后确定");
    expect(within(dialog).queryByTestId("cache-expected-differs")).toBeNull();
    expect(calls.some((call) => call.path === "/api/contents/c1/cache-media")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(calls.find((call) => call.path === "/api/contents/c1/cache-media")?.body).toEqual({ type: "video", quality: 1080, fileName: "第一讲" });
  });

  it("stops when the estimate differs from the chosen quality, says so, and submits the chosen cap once confirmed", async () => {
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { body: inspection({ expected: { type: "video", height: 720, ext: "mp4" }, expectedFileName: "第一讲 [720P].mp4" }) } });
    const confirm = await inspect(dialog);
    expect(within(dialog).getByTestId("cache-expected-differs").textContent).toBe("预计实际画质为 720P，与所选 1080P 不同。");
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [720P].mp4（预估，以下载后的实际画质为准）");
    expect(calls.some((call) => call.path === "/api/contents/c1/cache-media")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(calls.find((call) => call.path === "/api/contents/c1/cache-media")?.body).toEqual({ type: "video", quality: 1080, fileName: "第一讲" });
  });

  it("stops on a cache it would replace, then starts the cache the user confirmed", async () => {
    const { dialog, calls, onStarted, onOpenChange } = await show({ [INSPECT]: { body: inspection({ replaces: [REPLACED] }) } });
    // Nothing is sent before the user asks.
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(within(dialog).queryByTestId("cache-confirm")).toBeNull();
    const confirm = await inspect(dialog);
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [1080P].mp4（预估，以下载后的实际画质为准）");
    expect(within(dialog).getByTestId("cache-replaces").textContent).toBe("将替换现有 1080P 缓存");
    expect(confirm.textContent).toBe("确认缓存");
    expect(confirm.disabled).toBe(false);
    expect(calls.some((call) => call.path === "/api/contents/c1/cache-media")).toBe(false);
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

  it("says while inspecting, and drops the answer when the choice changes meanwhile", async () => {
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { body: inspection() } });
    const release = holdRequests(isInspect);
    const button = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("正在探测可用画质…"));
    expect(button.disabled).toBe(true);
    // The choice stays editable while the server inspects.
    fireEvent.change(within(dialog).getByTestId("cache-file-name"), { target: { value: "第二讲" } });
    release();
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/inspect")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/contents/c1/cache-media/inspect"]);
  });

  it("starts nothing when the dialog is closed during the inspection", async () => {
    const { calls } = mockApi({ [QUALITIES]: GENERAL, [INSPECT]: { body: inspection() }, [START]: { status: 202, body: { taskId: "t1" } } });
    const release = holdRequests(isInspect);
    const onStarted = vi.fn<(taskId: string) => void>();
    renderApp(<Opened onStarted={onStarted} />);
    const dialog = screen.getByRole("dialog", { name: "缓存本视频" });
    await settled(dialog);
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("正在探测可用画质…"));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "缓存本视频" })).toBeNull());
    release();
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/inspect")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.some((call) => call.path === "/api/contents/c1/cache-media")).toBe(false);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("stops on an audio cache it would replace", async () => {
    const { dialog, calls } = await show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3", replaces: [{ assetId: "aud", fileName: "第一讲.mp3", sizeBytes: GB }] }) } });
    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    const confirm = await inspect(dialog);
    expect(within(dialog).getByTestId("cache-replaces").textContent).toBe("将替换现有音频缓存");
    expect(confirm.disabled).toBe(false);
    expect(calls.some((call) => call.path === "/api/contents/c1/cache-media")).toBe(false);
  });

  it("says when a picture-less source becomes an MP3", async () => {
    const { dialog } = await show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }) } });
    await inspect(dialog);
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("源无画面，将缓存为 MP3：第一讲.mp3");
  });

  it("overwrites another Content's cache only once the user ticks the confirmation", async () => {
    const overwrite = { assetId: "x1", contentId: "c9", title: "另一讲", fileName: "第一讲 [1080P].mp4", sizeBytes: 2 * GB };
    const { dialog, calls } = await show({ [INSPECT]: { body: inspection({ overwrite }) } });
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
    const { dialog } = await show({
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
      "这个文件有一次未完成的替换等待处理：请先到「功能设置 › 存储」处理。",
      "磁盘剩余空间不足，暂不能缓存。 缓存所在磁盘剩余 5.0 GB，需保留 10.0 GB; 数据目录所在磁盘剩余 8.0 GB，需保留 10.0 GB",
    ]);
  });

  it("shows a name conflict found at submit and inspects again on the next click", async () => {
    const conflict = { class: "conflict", code: "conflict.cache_name_taken", retryDisposition: "never", userMessage: "缓存目录中已有同名的缓存文件，请确认覆盖或改用其它文件名" };
    const { dialog } = await show({ [INSPECT]: { body: inspection({ replaces: [REPLACED] }) }, [START]: { status: 409, body: { error: conflict } } });
    fireEvent.click(await inspect(dialog));
    expect(await within(dialog).findByText("缓存目录中已有同名的缓存文件，请确认覆盖或改用其它文件名")).toBeTruthy();
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
  });

  it("shows a conflict refusing the automatic start, and inspects again on the next click", async () => {
    const conflict = { class: "conflict", code: "conflict.mutation_lane", retryDisposition: "never", userMessage: "这条内容还有任务在进行" };
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { body: inspection() }, [START]: { status: 409, body: { error: conflict } } });
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    expect(await within(dialog).findByText("这条内容还有任务在进行")).toBeTruthy();
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/inspect")).toHaveLength(2));
  });

  it("keeps the answer on screen when the automatic start fails otherwise, so it can be retried", async () => {
    const failure = { class: "internal", code: "internal", retryDisposition: "safe", userMessage: "内部错误" };
    const { dialog, calls } = await show({ [INSPECT]: { body: inspection() }, [START]: { status: 500, body: { error: failure } } });
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    const confirm = (await within(dialog).findByTestId("cache-confirm")) as HTMLButtonElement;
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [1080P].mp4（预估，以下载后的实际画质为准）");
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media")).toHaveLength(2));
  });

  it("lists the Content's caches and deletes one after confirmation", async () => {
    const media = [cache("hd", { quality: "1080", sizeBytes: GB }), cache("aud", { mimeType: "audio/mpeg", displayName: "第一讲.mp3", sizeBytes: 50 * 1024 ** 2 })];
    const { dialog, calls } = await show({ "DELETE /api/media/hd": { status: 204 }, "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } } }, media);
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
    const { dialog } = await show({
      [INSPECT]: {
        body: inspection({
          replaces: [{ assetId: "sd", fileName: "第一讲 [720P].mp4", height: 720, sizeBytes: GB }],
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

describe("CacheMediaDialog, the source's qualities", () => {
  it("keeps the quality and a video start off while probing, and lets audio only start right away", async () => {
    const { dialog, onStarted, calls, probes } = await show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }) } }, [], { holdProbes: true });
    await waitFor(() => expect(probes).toHaveLength(1));
    const quality = within(dialog).getByTestId("cache-quality") as HTMLSelectElement;
    expect(quality.disabled).toBe(true);
    expect(optionsOf(dialog)).toEqual([PROBING]);
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    const start = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(calls.find((call) => call.path === "/api/contents/c1/cache-media")?.body).toEqual({ type: "audio", fileName: "第一讲" });
  });

  it("lists only the source's qualities and preselects the highest up to the default cap", async () => {
    const three = await show({ [QUALITIES]: { body: { status: "available", qualities: [360, 480, 720] } } });
    expect(optionsOf(three.dialog)).toEqual(["360P", "480P", "720P"]);
    expect((within(three.dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("720");
    expect(within(three.dialog).getByTestId("cache-qualities-hint").textContent).toBe("只列出这个视频当前能下载的画质；竖屏视频按短边计。");
    expect(within(three.dialog).queryByTestId("cache-qualities-unknown")).toBeNull();
    cleanup();

    const four = await show({ [QUALITIES]: { body: { status: "available", qualities: [360, 720, 1080, 1440] } } });
    expect(optionsOf(four.dialog)).toEqual(["360P", "720P", "1080P", "1440P"]);
    expect((within(four.dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("1080");
  });

  it("offers no video quality for an audio-only source and keeps a video start off", async () => {
    const { dialog } = await show({ [QUALITIES]: { body: { status: "audio_only", qualities: [] } } });
    await within(dialog).findByTestId("cache-qualities-audio-only");
    expect(within(dialog).getByTestId("cache-qualities-audio-only").textContent).toBe("这个来源只有音频、没有视频画面，请选择「仅音频」。");
    expect(within(dialog).queryByTestId("cache-quality")).toBeNull();
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(false);
    expect(within(dialog).queryByTestId("cache-qualities-audio-only")).toBeNull();
  });

  it.each([
    ["a failed probe", { status: 500, body: { error: { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "无法访问来源" } } }],
    ["an unknown format list", { body: { status: "unknown", qualities: [] } }],
  ] as const)("falls back to the general-purpose caps after %s, saying the result decides", async (_case, reply) => {
    const { dialog, calls } = await show({ [QUALITIES]: reply, [INSPECT]: { body: inspection() } });
    await within(dialog).findByTestId("cache-qualities-unknown");
    expect(within(dialog).getByTestId("cache-qualities-unknown").textContent).toBe("无法探测这个视频的画质，以下为通用档位，以下载后的实际画质为准。");
    expect(optionsOf(dialog)).toEqual(["360P", "480P", "720P", "1080P"]);
    expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("1080");
    expect(within(dialog).queryByTestId("cache-qualities-hint")).toBeNull();
    const start = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(calls.find((call) => call.path === "/api/contents/c1/cache-media/inspect")?.body).toEqual({ type: "video", quality: 1080, fileName: "第一讲" }));
    // Probed once per opening, never retried.
    expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/qualities")).toHaveLength(1);
  });

  it("inspects with the quality the user picked", async () => {
    const { dialog, calls, onStarted } = await show({
      [QUALITIES]: { body: { status: "available", qualities: [360, 480, 720] } },
      [INSPECT]: { body: inspection({ expected: { type: "video", height: 480, ext: "mp4" }, expectedFileName: "第一讲 [480P].mp4" }) },
    });
    fireEvent.change(within(dialog).getByTestId("cache-quality"), { target: { value: "480" } });
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    // The estimate matches the pick, so it starts without a second click.
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(calls.find((call) => call.path === "/api/contents/c1/cache-media/inspect")?.body).toEqual({ type: "video", quality: 480, fileName: "第一讲" });
    expect(calls.find((call) => call.path === "/api/contents/c1/cache-media")?.body).toEqual({ type: "video", quality: 480, fileName: "第一讲" });
  });

  it("aborts the probe when the dialog closes, and a late answer leaves the next opening's form alone", async () => {
    mockApi({ [START]: { status: 202, body: { taskId: "t1" } } });
    const probes = holdProbes();
    function Reopenable() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <CacheMediaDialog contentId="c1" title="第一讲" media={[]} open={open} onOpenChange={setOpen} onStarted={() => undefined} />
        </>
      );
    }
    renderApp(<Reopenable />);
    await waitFor(() => expect(probes).toHaveLength(1));
    fireEvent.click(within(screen.getByRole("dialog", { name: "缓存本视频" })).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "缓存本视频" })).toBeNull());
    expect(probes[0]?.signal?.aborted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    const dialog = await screen.findByRole("dialog", { name: "缓存本视频" });
    await waitFor(() => expect(probes).toHaveLength(2));
    probes[0]?.answer({ status: "available", qualities: [360, 480, 720] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(optionsOf(dialog)).toEqual([PROBING]);
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(true);
    probes[1]?.answer({ status: "available", qualities: [480, 1440] });
    await waitFor(() => expect(optionsOf(dialog)).toEqual(["480P", "1440P"]));
    expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("480");
    expect(probes[1]?.signal?.aborted).toBe(false);
  });
});
