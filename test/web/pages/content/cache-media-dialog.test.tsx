import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaAssetDto } from "../../../../src/shared/dto/content.ts";
import { CACHE_INSPECT_DEBOUNCE_MS } from "../../../../src/shared/defaults.ts";
import type { CacheMediaInspectDto } from "../../../../src/shared/dto/media.ts";
import { CacheMediaDialog, cacheBlockers, cacheMediaRequest, cacheRowsOf, defaultCacheQuality, needsReview, qualityOptionLabel } from "../../../../src/web/pages/content/cache-media-dialog.tsx";
import { zhCN } from "../../../../src/shared/i18n/zh-CN/index.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";
import { task } from "../../../fixtures/web/shell-data.ts";

const GB = 1024 ** 3;
const DISK = { cache: { freeBytes: 100 * GB, lowWaterBytes: 10 * GB }, ok: true };

function inspection(overrides: Partial<CacheMediaInspectDto> = {}): CacheMediaInspectDto {
  return {
    inspectionId: "01JINSPECTION0000000000000",
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
/** Tiers of a standard 16:9 source, each with the picture size of its stream. */
const tiers = (...values: number[]) => values.map((tier) => ({ tier, width: Math.round((tier * 16) / 9), height: tier }));
/** An ultra-wide source: each tier's stream is lower than the tier by its pixel height. */
const ULTRA_WIDE = [
  { tier: 360, width: 640, height: 206 },
  { tier: 480, width: 854, height: 274 },
  { tier: 720, width: 1280, height: 410 },
];
/** The probe answer that keeps the general-purpose tiers and their default. */
const GENERAL = { body: { status: "available", qualities: tiers(360, 480, 720, 1080) } };

/** A request the test holds until it answers it; an abort does not stop a late answer. */
interface Held {
  signal: AbortSignal | undefined;
  body: unknown;
  answer: (body: unknown, status?: number) => void;
}

/**
 * Takes over the matching requests from the stubbed API: each one waits until the test
 * answers it, and nothing here honours the abort signal, so an aborted request can still
 * answer late.
 */
function hold(match: (url: string, method: string) => boolean): Held[] {
  const held: Held[] = [];
  const answered = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (!match(String(input), (init?.method ?? "GET").toUpperCase())) return answered(input, init);
    return new Promise<Response>((resolve) => {
      held.push({
        signal: init?.signal ?? undefined,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        answer: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
      });
    });
  });
  return held;
}

const isQualities = (url: string): boolean => url.endsWith("/cache-media/qualities");
const isInspect = (url: string, method: string): boolean => method === "POST" && url.endsWith("/cache-media/inspect");
const isStart = (url: string, method: string): boolean => method === "POST" && url.endsWith("/cache-media");

/**
 * Renders the dialog and waits until the quality probe has answered and the background
 * check of the preselected choice has finished, unless `holdProbes` / `holdInspections`
 * leave those requests to the test.
 */
async function show(routes: Parameters<typeof mockApi>[0], media: MediaAssetDto[] = [], options: { holdProbes?: boolean; holdInspections?: boolean; holdStarts?: boolean } = {}) {
  const api = mockApi({ [QUALITIES]: GENERAL, [START]: { status: 202, body: { taskId: "t1" } }, ...routes });
  const probes = options.holdProbes === true ? hold(isQualities) : [];
  const inspections = options.holdInspections === true ? hold(isInspect) : [];
  const starts = options.holdStarts === true ? hold(isStart) : [];
  const onStarted = vi.fn<(taskId: string) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  renderApp(<CacheMediaDialog contentId="c1" title="第一讲" media={media} open onOpenChange={onOpenChange} onStarted={onStarted} />);
  const dialog = screen.getByRole("dialog", { name: "缓存本视频" });
  if (options.holdProbes !== true) await settled(dialog);
  if (options.holdProbes !== true && options.holdInspections !== true) await checked(dialog);
  return { ...api, probes, inspections, starts, onStarted, onOpenChange, dialog };
}

/** Waits until the quality probe has answered. */
async function settled(dialog: HTMLElement): Promise<void> {
  await waitFor(() => expect(within(dialog).queryByText(PROBING)).toBeNull());
}

const CHECKING = "正在核对文件大小…";

/** Waits until the background check has answered or failed (the status line then no longer says it is checking). */
async function checked(dialog: HTMLElement): Promise<void> {
  await waitFor(() => expect(within(dialog).queryByTestId("cache-preflight")?.textContent ?? "").not.toBe(CHECKING));
}

const optionsOf = (dialog: HTMLElement): Array<string | null> => [...(within(dialog).getByTestId("cache-quality") as HTMLSelectElement).options].map((option) => option.textContent);

/** Holds the answers to the matching requests until `release` is called; stub the API first. */
function holdRequests(match: (url: string, method: string) => boolean): () => void {
  let release: (value: unknown) => void = () => undefined;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const answered = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (match(String(input), (init?.method ?? "GET").toUpperCase())) await held;
    return answered(input, init);
  });
  return () => release(undefined);
}

/** The dialog as a page opens it: closing it unmounts the form. */
function Opened(props: { onStarted: (taskId: string) => void }) {
  const [open, setOpen] = useState(true);
  return <CacheMediaDialog contentId="c1" title="第一讲" media={[]} open={open} onOpenChange={setOpen} onStarted={props.onStarted} />;
}

const REPLACED = { assetId: "old", fileName: "第一讲 [1080P].mp4", height: 1080, sizeBytes: GB };
const TOKEN = "01JINSPECTION0000000000000";

/** The answer of the held inspection `index`, with a token of its own. */
const answerInspection = (held: Held | undefined, overrides: Partial<CacheMediaInspectDto> = {}): void => held?.answer(inspection(overrides));

/** Paths and bodies of the POSTs a test made, in order. */
const postsOf = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]);
const startsOf = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.path === "/api/contents/c1/cache-media");
const inspectsOf = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.path === "/api/contents/c1/cache-media/inspect");

/** The panel with the answer, which appears by itself when the answer needs the user. */
async function review(dialog: HTMLElement): Promise<HTMLButtonElement> {
  return (await within(dialog).findByTestId("cache-confirm")) as HTMLButtonElement;
}

const preflight = (dialog: HTMLElement): string | undefined => within(dialog).queryByTestId("cache-preflight")?.textContent ?? undefined;

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

describe("qualityOptionLabel", () => {
  const i18n = i18next.createInstance();
  beforeAll(async () => {
    await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
  });
  it("names a standard picture by its tier alone and a non-standard one with its real size", () => {
    const t = i18n.t.bind(i18n);
    expect(qualityOptionLabel({ tier: 720 }, t)).toBe("720P");
    expect(qualityOptionLabel({ tier: 720, width: 1280, height: 720 }, t)).toBe("720P");
    // A few lines short of the tier is still a standard picture.
    expect(qualityOptionLabel({ tier: 720, width: 1280, height: 714 }, t)).toBe("720P");
    expect(qualityOptionLabel({ tier: 1080, width: 1920, height: 1072 }, t)).toBe("1080P");
    // Portrait: the short side is the tier.
    expect(qualityOptionLabel({ tier: 1080, width: 1080, height: 1920 }, t)).toBe("1080P");
    expect(qualityOptionLabel({ tier: 720, width: 1280, height: 410 }, t)).toBe("720P（1280×410）");
    expect(qualityOptionLabel({ tier: 720, width: 1280, height: 534 }, t)).toBe("720P（1280×534）");
    expect(qualityOptionLabel({ tier: 360, width: 640, height: 206 }, t)).toBe("360P（640×206）");
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
  const OK = { [INSPECT]: { body: inspection() } };
  const SIZED = inspection({ expected: { type: "video", height: 1080, ext: "mp4", sizeBytes: Math.round(1.2 * GB) } });
  const idOf = (n: number): string => `01JINSPECTION${String(n).padStart(12, "0")}`;

  it("checks the complete choice in the background and says what it will be", async () => {
    const { dialog, calls } = await show({ [INSPECT]: { body: SIZED } });
    expect(preflight(dialog)).toBe("预计 1.2 GB · 保存为 «第一讲 [1080P].mp4»");
    expect(postsOf(calls)).toEqual([["/api/contents/c1/cache-media/inspect", { type: "video", quality: 1080, fileName: "第一讲" }]]);
    // Nothing for the user to decide: no panel, and the button still says what it does.
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so when the size is not known yet, and in red when the disk lacks room", async () => {
    const plain = await show(OK);
    expect(preflight(plain.dialog)).toBe("保存为 «第一讲 [1080P].mp4»");
    expect(within(plain.dialog).getByTestId("cache-preflight").className).not.toContain("text-danger");
    cleanup();
    const low = await show({ [INSPECT]: { body: inspection({ expected: SIZED.expected, disk: { ...DISK, ok: false } }) } });
    expect(preflight(low.dialog)).toBe("预计 1.2 GB · 保存为 «第一讲 [1080P].mp4» · 磁盘剩余空间不足");
    expect(within(low.dialog).getByTestId("cache-preflight").className).toContain("text-danger");
  });

  it("starts right away on the click when the check is ready, with its token, and never says it probes the qualities", async () => {
    const { dialog, calls, onStarted, onOpenChange } = await show(OK);
    const release = holdRequests(isStart);
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    const button = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    await waitFor(() => expect(button.textContent).toBe("正在开始缓存…"));
    expect(button.disabled).toBe(true);
    expect((within(dialog).getByTestId("cache-file-name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).disabled).toBe(true);
    expect(within(dialog).queryByText(PROBING)).toBeNull();
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    expect(within(dialog).queryByTestId("cache-confirm")).toBeNull();
    release();
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const posts = calls.filter((call) => call.method === "POST");
    // One check, made before the click; the click only submits it.
    expect(posts.map((call) => [call.path, call.body])).toEqual([
      ["/api/contents/c1/cache-media/inspect", { type: "video", quality: 1080, fileName: "第一讲" }],
      ["/api/contents/c1/cache-media", { type: "video", quality: 1080, fileName: "第一讲", inspectionId: TOKEN }],
    ]);
    expect(posts[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(posts[1]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("starts an audio cache right away", async () => {
    const audio = await show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }) } });
    fireEvent.click(within(audio.dialog).getByTestId("cache-type-audio"));
    await checked(audio.dialog);
    await waitFor(() => expect(preflight(audio.dialog)).toBe("保存为 «第一讲.mp3»"));
    expect(inspectsOf(audio.calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲" }, { type: "audio", fileName: "第一讲" }]);
    fireEvent.click(within(audio.dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(audio.onStarted).toHaveBeenCalledWith("t1"));
    expect(startsOf(audio.calls).map((call) => call.body)).toEqual([{ type: "audio", fileName: "第一讲", inspectionId: TOKEN }]);
  });

  it("waits for a check still running, saying so, and submits once it answers", async () => {
    const { dialog, calls, inspections, onStarted } = await show({}, [], { holdInspections: true });
    await waitFor(() => expect(inspections).toHaveLength(1));
    expect(preflight(dialog)).toBe(CHECKING);
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    const button = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    expect(button.textContent).toBe("正在核对文件大小与磁盘空间…");
    expect(button.disabled).toBe(true);
    expect((within(dialog).getByTestId("cache-file-name") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByTestId("cache-cancel-wait").textContent).toBe("取消等待");
    expect(within(dialog).queryByText(PROBING)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startsOf(calls)).toEqual([]);
    answerInspection(inspections[0]);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    // The click joined the running check instead of starting another.
    expect(inspections).toHaveLength(1);
    expect(startsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲", inspectionId: TOKEN }]);
  });

  it("stops waiting on request: the form opens up again and no Task starts, even when the check answers", async () => {
    const { dialog, calls, inspections, onStarted } = await show({ [START]: { status: 202, body: { taskId: "t1" } } }, [], { holdInspections: true });
    await waitFor(() => expect(inspections).toHaveLength(1));
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    fireEvent.click(within(dialog).getByTestId("cache-cancel-wait"));
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
    expect((within(dialog).getByTestId("cache-file-name") as HTMLInputElement).disabled).toBe(false);
    expect(within(dialog).queryByTestId("cache-cancel-wait")).toBeNull();
    answerInspection(inspections[0]);
    await waitFor(() => expect(preflight(dialog)).toBe("保存为 «第一讲 [1080P].mp4»"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startsOf(calls)).toEqual([]);
    expect(onStarted).not.toHaveBeenCalled();
    // The answer is kept: a new click submits it without checking again.
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(inspections).toHaveLength(1);
  });

  it("starts nothing when the dialog is closed while the click waits for the check", async () => {
    const { calls } = mockApi({ [QUALITIES]: GENERAL, [START]: { status: 202, body: { taskId: "t1" } } });
    const inspections = hold(isInspect);
    const onStarted = vi.fn<(taskId: string) => void>();
    renderApp(<Opened onStarted={onStarted} />);
    const dialog = screen.getByRole("dialog", { name: "缓存本视频" });
    await settled(dialog);
    await waitFor(() => expect(inspections).toHaveLength(1));
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("正在核对文件大小与磁盘空间…");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "缓存本视频" })).toBeNull());
    expect(inspections[0]?.signal?.aborted).toBe(true);
    answerInspection(inspections[0]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startsOf(calls)).toEqual([]);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("aborts the running check and drops its answer when the tier changes, then when the name changes", async () => {
    const { dialog, inspections } = await show({}, [], { holdInspections: true });
    await waitFor(() => expect(inspections).toHaveLength(1));
    expect(inspections[0]?.body).toEqual({ type: "video", quality: 1080, fileName: "第一讲" });

    fireEvent.change(within(dialog).getByTestId("cache-quality"), { target: { value: "480" } });
    expect(inspections[0]?.signal?.aborted).toBe(true);
    await waitFor(() => expect(inspections).toHaveLength(2));
    expect(inspections[1]?.body).toEqual({ type: "video", quality: 480, fileName: "第一讲" });
    // The old answer arrives late and changes nothing.
    answerInspection(inspections[0], { expectedFileName: "旧.mp4" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(preflight(dialog)).toBe(CHECKING);
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    answerInspection(inspections[1], { expected: { type: "video", height: 480, ext: "mp4" }, expectedFileName: "第一讲 [480P].mp4" });
    await waitFor(() => expect(preflight(dialog)).toBe("保存为 «第一讲 [480P].mp4»"));

    // Typing aborts at once and asks again only after the typing pauses, once.
    const input = within(dialog).getByTestId("cache-file-name");
    fireEvent.change(input, { target: { value: "第二" } });
    fireEvent.change(input, { target: { value: "第二讲" } });
    expect(preflight(dialog)).toBe(CHECKING);
    expect(inspections).toHaveLength(2);
    await waitFor(() => expect(inspections).toHaveLength(3));
    expect(inspections[2]?.body).toEqual({ type: "video", quality: 480, fileName: "第二讲" });
    fireEvent.change(input, { target: { value: "第三讲" } });
    expect(inspections[2]?.signal?.aborted).toBe(true);
    await waitFor(() => expect(inspections).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, CACHE_INSPECT_DEBOUNCE_MS + 100));
    expect(inspections).toHaveLength(4);
    answerInspection(inspections[2], { expectedFileName: "第二讲 [480P].mp4" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(preflight(dialog)).toBe(CHECKING);
    answerInspection(inspections[3], { expectedFileName: "第三讲 [1080P].mp4" });
    await waitFor(() => expect(preflight(dialog)).toBe("保存为 «第三讲 [1080P].mp4»"));
  });

  it("stops on a video whose height is unknown until the download, and starts it once confirmed", async () => {
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { body: inspection({ expected: { type: "video", ext: "mp4" }, expectedFileName: "第一讲 [?P].mp4" }) } });
    const confirm = await review(dialog);
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [?P].mp4，实际画质下载后确定");
    expect(within(dialog).queryByTestId("cache-expected-differs")).toBeNull();
    expect(startsOf(calls)).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(startsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲", inspectionId: TOKEN }]);
  });

  it("stops when the estimate differs from the chosen quality, says so, and submits the chosen cap once confirmed", async () => {
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { body: inspection({ expected: { type: "video", height: 720, ext: "mp4" }, expectedFileName: "第一讲 [720P].mp4" }) } });
    const confirm = await review(dialog);
    expect(within(dialog).getByTestId("cache-expected-differs").textContent).toBe("预计实际画质为 720P，与所选 1080P 不同。");
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [720P].mp4（预估，以下载后的实际画质为准）");
    expect(startsOf(calls)).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(startsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲", inspectionId: TOKEN }]);
  });

  it("stops on a cache it would replace, then starts the cache the user confirmed", async () => {
    const { dialog, calls, onStarted, onOpenChange } = await show({ [INSPECT]: { body: inspection({ replaces: [REPLACED] }) } });
    // The answer is on screen before any click, and nothing starts on its own.
    const confirm = await review(dialog);
    expect(within(dialog).queryByTestId("cache-inspect")).toBeNull();
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [1080P].mp4（预估，以下载后的实际画质为准）");
    expect(within(dialog).getByTestId("cache-replaces").textContent).toBe("将替换现有 1080P 缓存");
    expect(confirm.textContent).toBe("确认缓存");
    expect(confirm.disabled).toBe(false);
    expect(startsOf(calls)).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => [call.path, call.body])).toEqual([
      ["/api/contents/c1/cache-media/inspect", { type: "video", quality: 1080, fileName: "第一讲" }],
      ["/api/contents/c1/cache-media", { type: "video", quality: 1080, fileName: "第一讲", inspectionId: TOKEN }],
    ]);
    expect(posts[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(posts[1]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("stops on an audio cache it would replace", async () => {
    const { dialog, calls } = await show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3", replaces: [{ assetId: "aud", fileName: "第一讲.mp3", sizeBytes: GB }] }) } });
    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    const confirm = await review(dialog);
    expect(within(dialog).getByTestId("cache-replaces").textContent).toBe("将替换现有音频缓存");
    expect(confirm.disabled).toBe(false);
    expect(startsOf(calls)).toEqual([]);
  });

  it("says when a picture-less source becomes an MP3", async () => {
    const { dialog } = await show({ [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }) } });
    await review(dialog);
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("源无画面，将缓存为 MP3：第一讲.mp3");
  });

  it("overwrites another Content's cache only once the user ticks the confirmation", async () => {
    const overwrite = { assetId: "x1", contentId: "c9", title: "另一讲", fileName: "第一讲 [1080P].mp4", sizeBytes: 2 * GB };
    const { dialog, calls } = await show({ [INSPECT]: { body: inspection({ overwrite }) } });
    const confirm = await review(dialog);
    const area = within(dialog).getByTestId("cache-overwrite");
    expect(area.textContent).toContain("另一条内容「另一讲」已有同名缓存 第一讲 [1080P].mp4（2.0 GB）");
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(area).getByTestId("cache-overwrite-confirm"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(startsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲", overwriteAssetId: "x1", inspectionId: TOKEN }]));
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
    const confirm = await review(dialog);
    expect(confirm.disabled).toBe(true);
    const reasons = [...within(dialog).getByTestId("cache-blocked").querySelectorAll("li")].map((item) => item.textContent);
    expect(reasons).toEqual([
      "缓存目录中已有同名文件，但它不是 Amber 登记的缓存：请先把它移走或改名，或改用其它文件名。",
      "另一个缓存任务正在使用这个文件名：请等它结束后再试，或改用其它文件名。",
      "这个文件有一次未完成的替换等待处理：请先到「功能设置 › 存储」处理。",
      "磁盘剩余空间不足，暂不能缓存。 缓存所在磁盘剩余 5.0 GB，需保留 10.0 GB; 数据目录所在磁盘剩余 8.0 GB，需保留 10.0 GB",
    ]);
  });

  describe("a token the server no longer knows", () => {
    const expired = { class: "conflict", code: "conflict.cache_inspection_expired", retryDisposition: "never", userMessage: "缓存核对结果已过期，正在重新核对" };

    it("checks again once and submits the same intent with the new token", async () => {
      let checks = 0;
      let submitted = 0;
      const { dialog, calls, onStarted } = await show({
        [INSPECT]: () => ({ body: inspection({ inspectionId: idOf((checks += 1)) }) }),
        [START]: () => ((submitted += 1) === 1 ? { status: 409, body: { error: expired } } : { status: 202, body: { taskId: "t1" } }),
      });
      fireEvent.click(within(dialog).getByTestId("cache-inspect"));
      await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
      expect(inspectsOf(calls)).toHaveLength(2);
      expect(startsOf(calls).map((call) => (call.body as { inspectionId: string }).inspectionId)).toEqual([idOf(1), idOf(2)]);
      // Each submission is its own intent for the server's replay protection.
      expect(new Set(startsOf(calls).map((call) => call.headers["idempotency-key"])).size).toBe(2);
    });

    it("shows the error when the second token is refused too, and creates no Task", async () => {
      let checks = 0;
      const { dialog, calls, onStarted } = await show({
        [INSPECT]: () => ({ body: inspection({ inspectionId: idOf((checks += 1)) }) }),
        [START]: { status: 409, body: { error: expired } },
      });
      fireEvent.click(within(dialog).getByTestId("cache-inspect"));
      expect(await within(dialog).findByText(expired.userMessage)).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(inspectsOf(calls)).toHaveLength(2);
      expect(startsOf(calls)).toHaveLength(2);
      expect(onStarted).not.toHaveBeenCalled();
      expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
      expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(false);
    });

    it("resubmits what the user confirmed when the new answer shows the same thing", async () => {
      let checks = 0;
      let submitted = 0;
      const overwrite = { assetId: "x1", contentId: "c9", title: "另一讲", fileName: "第一讲 [1080P].mp4", sizeBytes: GB };
      const { dialog, calls, onStarted } = await show({
        [INSPECT]: () => ({ body: inspection({ inspectionId: idOf((checks += 1)), overwrite, replaces: [REPLACED] }) }),
        [START]: () => ((submitted += 1) === 1 ? { status: 409, body: { error: expired } } : { status: 202, body: { taskId: "t1" } }),
      });
      const confirm = await review(dialog);
      fireEvent.click(within(dialog).getByTestId("cache-overwrite-confirm"));
      fireEvent.click(confirm);
      await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
      expect(startsOf(calls).map((call) => call.body)).toEqual([
        { type: "video", quality: 1080, fileName: "第一讲", overwriteAssetId: "x1", inspectionId: idOf(1) },
        { type: "video", quality: 1080, fileName: "第一讲", overwriteAssetId: "x1", inspectionId: idOf(2) },
      ]);
    });

    it("leaves the decision to the user when the new answer shows something else", async () => {
      let checks = 0;
      const { dialog, calls, onStarted } = await show({
        [INSPECT]: () => ({
          body: inspection({ inspectionId: idOf((checks += 1)), replaces: [REPLACED], ...(checks > 1 ? { expected: { type: "video", height: 720, ext: "mp4" }, expectedFileName: "第一讲 [720P].mp4" } : {}) }),
        }),
        [START]: { status: 409, body: { error: expired } },
      });
      fireEvent.click(await review(dialog));
      await waitFor(() => expect(within(dialog).getByTestId("cache-expected-name").textContent).toContain("第一讲 [720P].mp4"));
      expect(startsOf(calls)).toHaveLength(1);
      expect(inspectsOf(calls)).toHaveLength(2);
      expect((within(dialog).getByTestId("cache-confirm") as HTMLButtonElement).disabled).toBe(false);
      expect(onStarted).not.toHaveBeenCalled();
    });
  });

  it("shows a name conflict found at submit and checks again on the next click", async () => {
    const conflict = { class: "conflict", code: "conflict.cache_name_taken", retryDisposition: "never", userMessage: "缓存目录中已有同名的缓存文件，请确认覆盖或改用其它文件名" };
    const { dialog, calls } = await show({ [INSPECT]: { body: inspection({ replaces: [REPLACED] }) }, [START]: { status: 409, body: { error: conflict } } });
    fireEvent.click(await review(dialog));
    expect(await within(dialog).findByText("缓存目录中已有同名的缓存文件，请确认覆盖或改用其它文件名")).toBeTruthy();
    // The answer is out of date: gone, and not asked again until the user clicks.
    await waitFor(() => expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存"));
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inspectsOf(calls)).toHaveLength(1);
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(inspectsOf(calls)).toHaveLength(2));
  });

  it("shows a conflict refusing the automatic start, and checks again on the next click", async () => {
    const conflict = { class: "conflict", code: "conflict.mutation_lane", retryDisposition: "never", userMessage: "这条内容还有任务在进行" };
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { body: inspection() }, [START]: { status: 409, body: { error: conflict } } });
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    expect(await within(dialog).findByText("这条内容还有任务在进行")).toBeTruthy();
    expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存");
    expect(within(dialog).queryByTestId("cache-inspection")).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    expect(inspectsOf(calls)).toHaveLength(1);
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(inspectsOf(calls)).toHaveLength(2));
    await waitFor(() => expect(startsOf(calls)).toHaveLength(2));
  });

  it("keeps the answer on screen when the automatic start fails otherwise, so it can be retried", async () => {
    const failure = { class: "internal", code: "internal", retryDisposition: "safe", userMessage: "内部错误" };
    const { dialog, calls } = await show({ [INSPECT]: { body: inspection() }, [START]: { status: 500, body: { error: failure } } });
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    const confirm = (await within(dialog).findByTestId("cache-confirm")) as HTMLButtonElement;
    expect(within(dialog).getByTestId("cache-expected-name").textContent).toBe("将保存为 第一讲 [1080P].mp4（预估，以下载后的实际画质为准）");
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(startsOf(calls)).toHaveLength(2));
  });

  it("shows a failed check without a click, creates no Task, and checks again on the click", async () => {
    const failure = { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "无法访问来源" };
    const { dialog, calls, onStarted } = await show({ [INSPECT]: { status: 502, body: { error: failure } } });
    expect(within(dialog).getByText("无法访问来源")).toBeTruthy();
    expect(within(dialog).queryByTestId("cache-preflight")).toBeNull();
    expect(inspectsOf(calls)).toHaveLength(1);
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(inspectsOf(calls)).toHaveLength(2));
    await waitFor(() => expect(within(dialog).getByTestId("cache-inspect").textContent).toBe("开始缓存"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startsOf(calls)).toEqual([]);
    expect(onStarted).not.toHaveBeenCalled();
    expect(within(dialog).getByText("无法访问来源")).toBeTruthy();
  });

  it("lists the Content's caches and deletes one after confirmation, then checks the choice again", async () => {
    const media = [cache("hd", { quality: "1080", sizeBytes: GB }), cache("aud", { mimeType: "audio/mpeg", displayName: "第一讲.mp3", sizeBytes: 50 * 1024 ** 2 })];
    const caches: CacheMediaInspectDto["caches"] = [
      { assetId: "hd", type: "video", height: 1080, verified: true, fileName: "hd.mp4", sizeBytes: GB, createdAt: 2 },
      { assetId: "aud", type: "audio", verified: true, fileName: "第一讲.mp3", sizeBytes: 50 * 1024 ** 2, createdAt: 1 },
    ];
    const { dialog, calls } = await show(
      { [INSPECT]: { body: inspection({ caches }) }, "DELETE /api/media/hd": { status: 204 }, "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } } },
      media,
    );
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
    // What was checked may no longer hold once a cache is gone.
    await waitFor(() => expect(inspectsOf(calls)).toHaveLength(2));
  });

  it("lists the caches the check reports, and keeps deleting off while the Content has unfinished Tasks", async () => {
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
    const list = within(dialog).getByTestId("cache-list");
    expect([...list.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent)).toEqual(["720P", "未知画质"]);
    const remove = within(list).getByTestId("cache-delete-sd") as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(true));
    expect(remove.getAttribute("title")).toBe("这条内容还有未结束的任务，结束后才能删除缓存");
  });
});

describe("CacheMediaDialog, the source's qualities", () => {
  const OK = { [INSPECT]: { body: inspection() } };

  it("checks nothing for a video while probing, keeps the quality and a video start off, and lets audio check and start", async () => {
    const { dialog, onStarted, calls, probes } = await show(
      { [INSPECT]: { body: inspection({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "第一讲.mp3" }) } },
      [],
      { holdProbes: true },
    );
    await waitFor(() => expect(probes).toHaveLength(1));
    const quality = within(dialog).getByTestId("cache-quality") as HTMLSelectElement;
    expect(quality.disabled).toBe(true);
    expect(optionsOf(dialog)).toEqual([PROBING]);
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByTestId("cache-preflight")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inspectsOf(calls)).toEqual([]);
    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    const start = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await waitFor(() => expect(preflight(dialog)).toBe("保存为 «第一讲.mp3»"));
    fireEvent.click(start);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(inspectsOf(calls).map((call) => call.body)).toEqual([{ type: "audio", fileName: "第一讲" }]);
    expect(startsOf(calls).map((call) => call.body)).toEqual([{ type: "audio", fileName: "第一讲", inspectionId: TOKEN }]);
  });

  it("checks the preselected tier once the probe answers", async () => {
    const { dialog, calls, probes } = await show(OK, [], { holdProbes: true });
    await waitFor(() => expect(probes).toHaveLength(1));
    probes[0]?.answer({ status: "available", qualities: tiers(360, 480, 720) });
    await waitFor(() => expect(preflight(dialog)).toBe("保存为 «第一讲 [1080P].mp4»"));
    expect(inspectsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 720, fileName: "第一讲" }]);
  });

  it("lists only the source's qualities and preselects the highest up to the default cap", async () => {
    const three = await show({ [QUALITIES]: { body: { status: "available", qualities: tiers(360, 480, 720) } } });
    expect(optionsOf(three.dialog)).toEqual(["360P", "480P", "720P"]);
    expect((within(three.dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("720");
    expect(within(three.dialog).getByTestId("cache-qualities-hint").textContent).toBe(
      "只列出这个视频当前能下载的画质，选哪档就缓存哪档；超宽或竖屏视频按等效画质标注，括号内为实际分辨率。",
    );
    expect(within(three.dialog).queryByTestId("cache-qualities-unknown")).toBeNull();
    cleanup();

    const four = await show({ [QUALITIES]: { body: { status: "available", qualities: tiers(360, 720, 1080, 1440) } } });
    expect(optionsOf(four.dialog)).toEqual(["360P", "720P", "1080P", "1440P"]);
    expect((within(four.dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("1080");
  });

  it("offers no video quality for an audio-only source, checks nothing for a video and keeps its start off", async () => {
    const { dialog, calls } = await show({ ...OK, [QUALITIES]: { body: { status: "audio_only", qualities: [] } } });
    await within(dialog).findByTestId("cache-qualities-audio-only");
    expect(within(dialog).getByTestId("cache-qualities-audio-only").textContent).toBe("这个来源只有音频、没有视频画面，请选择「仅音频」。");
    expect(within(dialog).queryByTestId("cache-quality")).toBeNull();
    expect(within(dialog).queryByTestId("cache-preflight")).toBeNull();
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inspectsOf(calls)).toEqual([]);
    fireEvent.click(within(dialog).getByTestId("cache-type-audio"));
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(false);
    expect(within(dialog).queryByTestId("cache-qualities-audio-only")).toBeNull();
    await waitFor(() => expect(inspectsOf(calls).map((call) => call.body)).toEqual([{ type: "audio", fileName: "第一讲" }]));
  });

  it("checks with the general-purpose cap when the format list is unknown, saying the result decides", async () => {
    const { dialog, calls } = await show({ [QUALITIES]: { body: { status: "unknown", qualities: [] } }, ...OK });
    expect(within(dialog).getByTestId("cache-qualities-unknown").textContent).toBe("无法探测这个视频的画质，以下为通用档位，以下载后的实际画质为准。");
    expect(optionsOf(dialog)).toEqual(["360P", "480P", "720P", "1080P"]);
    expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("1080");
    expect(within(dialog).queryByTestId("cache-qualities-hint")).toBeNull();
    expect(inspectsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲" }]);
    expect(preflight(dialog)).toBe("保存为 «第一讲 [1080P].mp4»");
    expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/qualities")).toHaveLength(1);
  });

  it("falls back to the general-purpose tiers after a failed probe without checking by itself, and checks on the click", async () => {
    const failed = { status: 500, body: { error: { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "无法访问来源" } } };
    const { dialog, calls, onStarted } = await show({ [QUALITIES]: failed, ...OK });
    expect(within(dialog).getByTestId("cache-qualities-unknown").textContent).toBe("无法探测这个视频的画质，以下为通用档位，以下载后的实际画质为准。");
    expect(optionsOf(dialog)).toEqual(["360P", "480P", "720P", "1080P"]);
    expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("1080");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inspectsOf(calls)).toEqual([]);
    expect(within(dialog).queryByTestId("cache-preflight")).toBeNull();
    const start = within(dialog).getByTestId("cache-inspect") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(inspectsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲" }]);
    expect(startsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 1080, fileName: "第一讲", inspectionId: TOKEN }]);
    // Probed once per opening, never retried.
    expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/qualities")).toHaveLength(1);
  });

  it("checks with the quality the user picked and submits that check", async () => {
    const { dialog, calls, onStarted } = await show({
      [QUALITIES]: { body: { status: "available", qualities: tiers(360, 480, 720) } },
      [INSPECT]: { body: inspection({ expected: { type: "video", height: 480, ext: "mp4" }, expectedFileName: "第一讲 [480P].mp4" }) },
    });
    fireEvent.change(within(dialog).getByTestId("cache-quality"), { target: { value: "480" } });
    await waitFor(() => expect(inspectsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 720, fileName: "第一讲" }, { type: "video", quality: 480, fileName: "第一讲" }]));
    await waitFor(() => expect(preflight(dialog)).toBe("保存为 «第一讲 [480P].mp4»"));
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    // The estimate matches the pick, so it starts without a second click.
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    expect(startsOf(calls).map((call) => call.body)).toEqual([{ type: "video", quality: 480, fileName: "第一讲", inspectionId: TOKEN }]);
  });

  it("aborts the probe when the dialog closes, and a late answer leaves the next opening's form alone", async () => {
    mockApi({ [START]: { status: 202, body: { taskId: "t1" } } });
    const probes = hold(isQualities);
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
    probes[0]?.answer({ status: "available", qualities: tiers(360, 480, 720) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(optionsOf(dialog)).toEqual([PROBING]);
    expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(true);
    probes[1]?.answer({ status: "available", qualities: tiers(480, 1440) });
    await waitFor(() => expect(optionsOf(dialog)).toEqual(["480P", "1440P"]));
    expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("480");
    expect(probes[1]?.signal?.aborted).toBe(false);
  });

  it("labels the choice 「画质」 and names the tiers of an ultra-wide source with their real size", async () => {
    const wide = await show({ [QUALITIES]: { body: { status: "available", qualities: ULTRA_WIDE } } });
    expect(within(wide.dialog).getByText("画质")).toBeTruthy();
    expect(within(wide.dialog).queryByText("画质上限")).toBeNull();
    expect(optionsOf(wide.dialog)).toEqual(["360P（640×206）", "480P（854×274）", "720P（1280×410）"]);
    expect((within(wide.dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("720");
    cleanup();

    const standard = await show({ [QUALITIES]: { body: { status: "available", qualities: tiers(480, 720, 1080) } } });
    expect(optionsOf(standard.dialog)).toEqual(["480P", "720P", "1080P"]);
    cleanup();

    const portrait = await show({ [QUALITIES]: { body: { status: "available", qualities: [{ tier: 720, width: 720, height: 1280 }, { tier: 1080, width: 1080, height: 1920 }] } } });
    expect(optionsOf(portrait.dialog)).toEqual(["720P", "1080P"]);
  });

  describe("a tier the source no longer offers", () => {
    const unavailable = {
      class: "invalid_request",
      code: "invalid_request.cache_quality_unavailable",
      retryDisposition: "never",
      userMessage: "这个视频当前没有 480P 画质可以缓存，请在缓存对话框中重新选择画质",
    };
    /** The inspection that finds 480P gone, and answers any other tier. */
    const without480 = (call: { body?: unknown }) => {
      const tier = (call.body as { quality: number }).quality;
      return tier === 480 ? { status: 400, body: { error: unavailable } } : { body: inspection({ expected: { type: "video", height: tier, ext: "mp4" } }) };
    };

    it("shows the error, probes the list again without checking by itself, and starts nothing", async () => {
      let probed = 0;
      const { dialog, calls, onStarted } = await show({
        [QUALITIES]: () => {
          probed += 1;
          // The second probe finds 480P gone.
          return { body: { status: "available", qualities: probed === 1 ? ULTRA_WIDE : [ULTRA_WIDE[0], ULTRA_WIDE[2]] } };
        },
        [INSPECT]: without480,
      });
      fireEvent.change(within(dialog).getByTestId("cache-quality"), { target: { value: "480" } });
      await within(dialog).findByText(unavailable.userMessage);
      await waitFor(() => expect(optionsOf(dialog)).toEqual(["360P（640×206）", "720P（1280×410）"]));
      expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/qualities")).toHaveLength(2);
      // The gone tier is replaced by the default among what is left; the error stays.
      expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("720");
      expect(within(dialog).getByText(unavailable.userMessage)).toBeTruthy();
      expect((within(dialog).getByTestId("cache-inspect") as HTMLButtonElement).disabled).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(inspectsOf(calls).map((call) => (call.body as { quality: number }).quality)).toEqual([720, 480]);
      expect(startsOf(calls)).toEqual([]);
      expect(onStarted).not.toHaveBeenCalled();
      // The user's next click checks the new choice.
      fireEvent.click(within(dialog).getByTestId("cache-inspect"));
      await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t1"));
    });

    it("keeps the chosen tier when the probe after it still lists it, and does not loop", async () => {
      const { dialog, calls } = await show({ [QUALITIES]: { body: { status: "available", qualities: ULTRA_WIDE } }, [INSPECT]: without480 });
      fireEvent.change(within(dialog).getByTestId("cache-quality"), { target: { value: "480" } });
      await within(dialog).findByText(unavailable.userMessage);
      await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/qualities")).toHaveLength(2));
      await settled(dialog);
      expect((within(dialog).getByTestId("cache-quality") as HTMLSelectElement).value).toBe("480");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/qualities")).toHaveLength(2);
      expect(inspectsOf(calls)).toHaveLength(2);
    });
  });

  it("does not probe the qualities again for another check failure", async () => {
    const failure = { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "无法访问来源" };
    const { dialog, calls } = await show({ [INSPECT]: { status: 502, body: { error: failure } } });
    expect(within(dialog).getByText("无法访问来源")).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId("cache-inspect"));
    await waitFor(() => expect(inspectsOf(calls)).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.path === "/api/contents/c1/cache-media/qualities")).toHaveLength(1);
  });
});
