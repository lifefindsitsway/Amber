import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { FIGURE_UPLOAD_MAX_BYTES } from "../../src/shared/defaults.ts";
import { contentDetailDtoSchema, transcriptRevisionListDtoSchema } from "../../src/shared/dto/content.ts";
import { transcriptSegmentPageDtoSchema } from "../../src/shared/dto/transcript.ts";
import { installMockBackend, LOCAL_CONTENT, segmentId } from "./mock-backend.ts";
import { DANMAKU_CONTENT, setupDanmaku } from "./mock-danmaku.ts";
import { FIGURE_FIXTURES, mockFigures, routeFigureUploads, seedFigure } from "./mock-figures.ts";

/*
 * Inserting figures into the reading view of the local video: the player's capture button
 * (where it shows, its place in a narrow player), the toolbar's 「插入图片」 menu (capture,
 * upload with the refusals said before sending, recently deleted), pasting an image (and a
 * link winning over it), the place fixed at the press while the video plays on, and the whole
 * flow by keyboard.
 */

test.use({ actionTimeout: 15_000 });
test.describe.configure({ timeout: 120_000 });

const LOCAL_REVISION = "01J0000000000000000000REV3";
const LOCAL_ASSET_PATH = /\/api\/contents\/01J0000000000000000000LC01$/;
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
const CREATED_AT = 1_790_000_000_000;
/** One sentence every 10 s, 3 s short of the next: every sentence is a paragraph of its own. */
const SLOT_MS = 10_000;
/** Wide enough for the player's buttons beside a 600 px reading column. */
const WIDE = { width: 1600, height: 900 };
const WEBP = readFileSync(new URL(FIGURE_FIXTURES.landscape.file, import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const LINK = "https://www.bilibili.com/video/BV1xx411c7mD";

const sid = (index: number): string => segmentId(LOCAL_REVISION, index);

async function serveLecture(page: Page, count = 13): Promise<void> {
  const items = Array.from({ length: count }, (_, index) => ({
    id: sid(index),
    revisionId: LOCAL_REVISION,
    ordinal: index,
    startMs: index * SLOT_MS,
    endMs: (index + 1) * SLOT_MS - 3_000,
    text: `第 ${index + 1} 句：这一段讲插图旁边的内容。`,
    sourceSegmentIds: [],
  }));
  const revision = { id: LOCAL_REVISION, contentId: LOCAL_CONTENT, kind: "platform", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "platform" }, segmentCount: items.length, createdAt: CREATED_AT };
  await page.route(new RegExp(`/api/transcript/revisions/${LOCAL_REVISION}/segments(\\?|$)`), (route) => route.fulfill({ json: transcriptSegmentPageDtoSchema.parse({ revision, items }) }));
}

/** The mock backend's file of the local lecture, which streams the e2e clip. */
const LOCAL_ASSET = "01J0000000000000000000AST1";

/** The local lecture as the mock serves it, but its file announced as sound only (no picture) or without a transcript. */
async function serveLocalDetail(page: Page, options: { audio?: boolean; transcript?: boolean }): Promise<void> {
  const detail = contentDetailDtoSchema.parse({
    id: LOCAL_CONTENT,
    source: { kind: "local" },
    title: "本地上传的模拟讲座",
    durationMs: 130_000,
    ...(options.transcript === false ? {} : { primaryTranscriptRevisionId: LOCAL_REVISION }),
    processingStatus: "succeeded",
    collections: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    media: [
      { id: LOCAL_ASSET, kind: "managed_upload", displayName: "lecture.webm", mimeType: options.audio === true ? "audio/webm" : "video/webm", sizeBytes: 1, durationMs: 130_000, availability: "available", retentionPolicy: "keep", createdAt: CREATED_AT },
    ],
  });
  await page.route(LOCAL_ASSET_PATH, (route) => (route.request().method() === "GET" ? route.fulfill({ json: detail }) : route.fallback()));
}

const reader = (page: Page): Locator => page.getByTestId("transcript-reader");
const figureRow = (page: Page, id: string): Locator => reader(page).locator(`[data-figure-id="${id}"]`);
const video = (page: Page): Locator => page.getByTestId("player-local").locator("video");
const captureButton = (page: Page): Locator => page.getByTestId("player-figure-capture");
const insertButton = (page: Page): Locator => page.getByTestId("figure-insert");
const status = (page: Page): Locator => page.getByTestId("figure-insert-status");

/** Opens the local video's reading view (server mode, so the clip plays). */
async function open(page: Page, options: { outputs?: number; viewport?: { width: number; height: number }; audio?: boolean; sentences?: number } = {}): Promise<void> {
  await page.setViewportSize(options.viewport ?? WIDE);
  await installMockBackend(page, { mode: "server" });
  await routeFigureUploads(page);
  await serveLecture(page, options.sentences);
  if (options.audio === true) await serveLocalDetail(page, { audio: true });
  await page.addInitScript(([key, width]) => localStorage.setItem(key as string, String(width)), [OUTPUTS_WIDTH_KEY, options.outputs ?? 700] as const);
  await page.goto(`/contents/${LOCAL_CONTENT}?tab=transcript`);
  if (options.sentences === 0) await expect(page.getByTestId("transcript-version")).toBeVisible();
  else await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
}

/** The mounted rows in list order: `F:<figure id>` for a figure, else the index of the paragraph's first sentence. */
function order(page: Page): Promise<string[]> {
  return reader(page).evaluate((list) =>
    Array.from(list.querySelectorAll("[data-row-key]")).map((row) => {
      const figure = row.querySelector("[data-figure-id]");
      if (row.hasAttribute("data-figure-row") && figure !== null) return `F:${figure.getAttribute("data-figure-id")}`;
      const id = row.querySelector("[data-segment-id]")?.getAttribute("data-segment-id") ?? "";
      return String(Number(id.slice(-4)));
    }),
  );
}

async function after(page: Page, index: number): Promise<string | undefined> {
  const rows = await order(page);
  return rows[rows.indexOf(String(index)) + 1];
}

async function seekClip(page: Page, seconds: number): Promise<void> {
  await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await video(page).evaluate(async (element: HTMLVideoElement, at) => {
    element.pause();
    const seeked = new Promise((resolve) => element.addEventListener("seeked", resolve, { once: true }));
    element.currentTime = at;
    await seeked;
  }, seconds);
  await expect(page.getByTestId("reader-locate")).not.toHaveAttribute("aria-disabled", /.*/);
}

/** Starts playback muted (autoplay rules) and waits until the clock moves. */
async function play(page: Page): Promise<void> {
  await video(page).evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0)).toBe(true);
}

/** The highlight a revealed figure gets for a moment. */
async function expectRevealed(page: Page, id: string): Promise<void> {
  await expect(figureRow(page, id).getByTestId("figure-frame")).toHaveClass(/ring-2/);
  await expect(figureRow(page, id)).toBeInViewport();
}

/** The figure the mock created last. */
function lastCreated(page: Page): string {
  return [...mockFigures(page).figures.keys()].at(-1) as string;
}

/** Pastes as a real clipboard paste would arrive outside any field: text and files. */
async function paste(page: Page, input: { text?: string; png?: boolean }): Promise<{ prevented: boolean; atSeconds: number }> {
  return page.evaluate(
    ({ text, bytes }) => {
      const data = new DataTransfer();
      if (text !== undefined) data.setData("text/plain", text);
      if (bytes !== undefined) data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      const at = document.querySelector<HTMLVideoElement>('[data-testid="player-local"] video')?.currentTime ?? 0;
      document.dispatchEvent(event);
      return { prevented: event.defaultPrevented, atSeconds: at };
    },
    { text: input.text, bytes: input.png === true ? [...PNG] : undefined },
  );
}

test.describe("the player's capture button", () => {
  test("captures the frame on screen into the paragraph of its time, scrolled to and highlighted", async ({ page }) => {
    await open(page);
    await seekClip(page, 85.25);
    await expect(captureButton(page)).toBeVisible();
    await expect(captureButton(page)).toHaveAccessibleName("截取当前画面，插入原文细读");
    await captureButton(page).click();
    await expect.poll(() => mockFigures(page).captures.length).toBe(1);
    const body = mockFigures(page).captures[0];
    // The frame on screen: the 10 fps clip shows the frame of 85.2 s.
    expect(body?.atMs).toBeGreaterThanOrEqual(85_100);
    expect(body?.atMs).toBeLessThanOrEqual(85_250);
    expect(body?.placement?.anchor).toMatchObject({ segmentId: sid(8), side: "after" });
    const id = lastCreated(page);
    await expectRevealed(page, id);
    await expect.poll(() => after(page, 8)).toBe(`F:${id}`);
    await expect(figureRow(page, id).getByTestId("figure-time")).toHaveText("1:25");
    await expect(page.getByTestId("player-figure-capture-notice")).toHaveText("已截图，插入原文细读");
  });

  test("at the very end of the video, captures the last frame instead of failing", async ({ page }) => {
    await open(page);
    await seekClip(page, 130);
    await captureButton(page).click();
    await expect.poll(() => mockFigures(page).captures.length).toBe(1);
    const atMs = mockFigures(page).captures[0]?.atMs as number;
    expect(atMs).toBeLessThanOrEqual(mockFigures(page).lastFrameMs);
    expect(atMs).toBeGreaterThanOrEqual(129_800);
    await expect(page.getByTestId("player-figure-capture-notice")).toHaveText("已截图，插入原文细读");
  });

  test("says a capture failure over the picture", async ({ page }) => {
    await open(page);
    mockFigures(page).lastFrameMs = 0;
    await seekClip(page, 40);
    await captureButton(page).click();
    await expect(page.getByTestId("player-figure-capture-notice")).toHaveText("已到片尾，没有可截取的画面，往前一点再试");
    expect(mockFigures(page).figures.size).toBe(0);
  });

  test("is not there for a file without a picture; upload still works", async ({ page }) => {
    await open(page, { audio: true });
    await expect(page.getByTestId("player-audio-only")).toBeVisible();
    await expect(captureButton(page)).toHaveCount(0);
    await insertButton(page).click();
    await expect(page.getByTestId("figure-insert-capture")).toHaveAttribute("data-disabled", "");
    await expect(page.getByTestId("figure-insert-capture")).toContainText("当前播放的文件没有画面，不能截图");
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("figure-insert-upload").click();
    await (await chooser).setFiles({ name: "图.webp", mimeType: "image/webp", buffer: WEBP });
    await expect.poll(() => mockFigures(page).uploads.length).toBe(1);
    await expectRevealed(page, lastCreated(page));
  });

  test("is not there while the video plays online; upload and paste still work", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await installMockBackend(page);
    await routeFigureUploads(page);
    await page.goto("/contents/01J0000000000000000000BL01?tab=transcript");
    await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
    await expect(page.getByTestId("player-local")).toHaveCount(0);
    await expect(captureButton(page)).toHaveCount(0);
    await insertButton(page).click();
    await expect(page.getByTestId("figure-insert-capture")).toContainText("本地播放视频时才能截取画面");
    await page.keyboard.press("Escape");
    expect((await paste(page, { png: true })).prevented).toBe(true);
    await expect.poll(() => mockFigures(page).uploads.length).toBe(1);
    await expect(status(page)).toHaveText("已插入粘贴的图片");
  });

  test("goes into the settings menu in a narrow player, together with the danmaku button", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await installMockBackend(page, { mode: "server" });
    setupDanmaku(page);
    // The reading column takes all it can: the player keeps its minimum column, under 400 px of picture.
    await page.addInitScript((key) => localStorage.setItem(key, "5000"), OUTPUTS_WIDTH_KEY);
    await page.goto(`/contents/${DANMAKU_CONTENT}?tab=transcript`);
    await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
    // Its cached copy plays in the local player.
    const inline = page.getByTestId("switch-player-local");
    if (await inline.isVisible()) {
      await inline.click();
    } else {
      await page.getByTestId("content-menu").click();
      await page.getByTestId("overflow-switch-player-local").click();
    }
    await expect(page.getByTestId("player-local")).toBeVisible();
    await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
    expect((await video(page).boundingBox())?.width).toBeLessThan(400);
    await expect(captureButton(page)).toHaveCount(0);
    await expect(page.getByTestId("player-danmaku")).toHaveCount(0);
    await page.getByTestId("player-settings").click();
    await page.getByTestId("player-settings-figure-capture").click();
    await expect.poll(() => mockFigures(page).captures.length).toBe(1);
    await expect(page.getByTestId("player-figure-capture-notice")).toHaveText("已截图，插入原文细读");
  });

  test("is off without a transcript to put the frame in, saying why", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await installMockBackend(page, { mode: "server" });
    await serveLocalDetail(page, { transcript: false });
    await page.route(/\/api\/contents\/01J0000000000000000000LC01\/transcript\/revisions$/, (route) => route.fulfill({ json: transcriptRevisionListDtoSchema.parse({ revisions: [] }) }));
    await page.addInitScript((key) => localStorage.setItem(key, "700"), OUTPUTS_WIDTH_KEY);
    await page.goto(`/contents/${LOCAL_CONTENT}?tab=transcript`);
    await expect(page.getByText("还没有字幕或转录稿")).toBeVisible();
    await expect(captureButton(page)).toBeVisible();
    await expect(captureButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(captureButton(page)).toHaveAttribute("title", "有字幕稿后才能插图");
    await expect(captureButton(page)).toHaveAccessibleDescription("有字幕稿后才能插图");
    // Pressing it anyway does nothing.
    await captureButton(page).dispatchEvent("click");
    expect((await paste(page, { png: true })).prevented).toBe(false);
    expect(mockFigures(page).captures).toHaveLength(0);
    expect(mockFigures(page).uploads).toHaveLength(0);
  });

  test("captures from another tab too, placed by its time, and the figure is there in the reading view", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await installMockBackend(page, { mode: "server" });
    await serveLecture(page);
    await page.addInitScript((key) => localStorage.setItem(key, "700"), OUTPUTS_WIDTH_KEY);
    await page.goto(`/contents/${LOCAL_CONTENT}?tab=summary`);
    await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await video(page).evaluate(async (element: HTMLVideoElement) => {
      const seeked = new Promise((resolve) => element.addEventListener("seeked", resolve, { once: true }));
      element.currentTime = 33;
      await seeked;
    });
    await captureButton(page).click();
    await expect.poll(() => mockFigures(page).captures.length).toBe(1);
    expect(mockFigures(page).captures[0]?.placement).toBeUndefined();
    await expect(page.getByTestId("player-figure-capture-notice")).toHaveText("已截图，插入原文细读");
    const id = lastCreated(page);
    await page.getByRole("tab", { name: "原文细读" }).click();
    await expect(figureRow(page, id).getByTestId("figure-image")).toBeVisible();
    await expect.poll(() => after(page, 3)).toBe(`F:${id}`);
  });
});

test.describe("the insert menu", () => {
  test("uploads an image after the paragraph followed when the menu opened, without a time; refusals are said before sending", async ({ page }) => {
    await open(page);
    await seekClip(page, 52);
    await insertButton(page).click();
    await expect(page.getByTestId("figure-insert-menu")).toContainText("也可以直接粘贴图片（Ctrl+V）");
    await expect(page.getByTestId("figure-insert-upload")).toContainText("PNG、JPEG、WebP，不超过 20 MB");
    let chooser = page.waitForEvent("filechooser");
    await page.getByTestId("figure-insert-upload").click();
    await (await chooser).setFiles({ name: "板书.webp", mimeType: "image/webp", buffer: WEBP });
    await expect.poll(() => mockFigures(page).uploads.length).toBe(1);
    expect(mockFigures(page).uploads[0]?.meta.placement.anchor).toMatchObject({ segmentId: sid(5), side: "after" });
    const id = lastCreated(page);
    await expectRevealed(page, id);
    await expect.poll(() => after(page, 5)).toBe(`F:${id}`);
    await expect(figureRow(page, id).getByTestId("figure-time")).toHaveCount(0);
    await expect(status(page)).toHaveText("已插入图片");

    // A text file named like a picture is refused by its bytes, before anything is sent.
    await insertButton(page).click();
    chooser = page.waitForEvent("filechooser");
    await page.getByTestId("figure-insert-upload").click();
    await (await chooser).setFiles({ name: "伪装.png", mimeType: "image/png", buffer: Buffer.from("这不是图片") });
    const alerts = page.getByTestId("figure-insert-alerts");
    await expect(alerts).toHaveText("只支持 PNG、JPEG、WebP 图片");
    await expect(alerts).toHaveAttribute("role", "alert");
    // The notice stays inside the toolbar, under the button's end when the button sits near the toolbar's end.
    const toolbar = (await insertButton(page).locator("xpath=../..").boundingBox()) as { x: number; width: number };
    const bubble = (await alerts.locator("xpath=..").boundingBox()) as { x: number; width: number };
    expect(bubble.x).toBeGreaterThanOrEqual(toolbar.x - 1);
    expect(bubble.x + bubble.width).toBeLessThanOrEqual(toolbar.x + toolbar.width + 1);

    // Too big: said at once, nothing sent.
    await insertButton(page).click();
    chooser = page.waitForEvent("filechooser");
    await page.getByTestId("figure-insert-upload").click();
    await (await chooser).setFiles({ name: "大图.png", mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.alloc(FIGURE_UPLOAD_MAX_BYTES)]) });
    await expect(alerts.getByTestId("figure-insert-line").last()).toHaveText("图片超过 20 MB，无法插入");
    expect(mockFigures(page).uploads).toHaveLength(1);
  });

  test("keeps the paragraph of the moment it opened while the video plays on", async ({ page }) => {
    await open(page);
    await seekClip(page, 36);
    mockFigures(page).holdUploads = new Promise(() => undefined);
    await play(page);
    const atOpen = await video(page).evaluate((element: HTMLVideoElement) => element.currentTime);
    await insertButton(page).click();
    const expected = Math.floor(atOpen / 10);
    // Playback moves into the next paragraph before the file is picked.
    await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan((expected + 1) * 10 + 0.5);
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("figure-insert-upload").click();
    await (await chooser).setFiles({ name: "图.webp", mimeType: "image/webp", buffer: WEBP });
    await expect.poll(() => mockFigures(page).uploads.length).toBe(1);
    expect(mockFigures(page).uploads[0]?.meta.placement.anchor?.segmentId).toBe(sid(expected));
    // Under way: said, and cancellable.
    await expect(status(page)).toContainText("正在上传图片…");
    await page.getByTestId("figure-insert-cancel").click();
    await expect(page.getByTestId("figure-insert-progress")).toHaveText("已取消上传");
  });

  test("captures from the menu the frame that was on screen when it opened", async ({ page }) => {
    await open(page);
    await seekClip(page, 63);
    await insertButton(page).click();
    await page.getByTestId("figure-insert-capture").click();
    await expect.poll(() => mockFigures(page).captures.length).toBe(1);
    const body = mockFigures(page).captures[0];
    expect(body?.atMs).toBeGreaterThanOrEqual(62_900);
    expect(body?.atMs).toBeLessThanOrEqual(63_000);
    expect(body?.placement?.anchor?.segmentId).toBe(sid(6));
    await expectRevealed(page, lastCreated(page));
    await expect(status(page)).toHaveText("已插入截图");
  });

  test("brings back a recently deleted figure, revealing it", async ({ page }) => {
    const gone = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 95_000, caption: "被删的板书", deleted: true });
    await open(page);
    await expect(figureRow(page, gone.id)).toHaveCount(0);
    await insertButton(page).click();
    await page.getByTestId("figure-insert-recent").click();
    const item = page.getByTestId("figure-insert-restore");
    // The pointer travels there in steps, as a hand does: a single jump off the submenu's trigger closes it.
    const box = (await item.boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => mockFigures(page).restorations).toEqual([gone.id]);
    await expectRevealed(page, gone.id);
    await expect(status(page)).toHaveText("已恢复插图");
    // Nothing left to restore.
    await insertButton(page).click();
    await expect(page.getByTestId("figure-insert-recent")).toHaveText("最近删除（0）没有最近删除的插图");
    await expect(page.getByTestId("figure-insert-recent")).toHaveAttribute("data-disabled", "");
  });

  test("the whole flow by keyboard: open, upload, restore, capture", async ({ page }) => {
    const gone = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 15_000, deleted: true });
    await open(page);
    await seekClip(page, 25);
    await insertButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("figure-insert-capture")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("figure-insert-upload")).toBeFocused();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await chooser).setFiles({ name: "图.webp", mimeType: "image/webp", buffer: WEBP });
    await expect.poll(() => mockFigures(page).uploads.length).toBe(1);
    await expect(insertButton(page)).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("figure-insert-capture")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("figure-insert-upload")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("figure-insert-recent")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("figure-insert-restore")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => mockFigures(page).restorations).toEqual([gone.id]);
    await expectRevealed(page, gone.id);

    await captureButton(page).focus();
    await expect(captureButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => mockFigures(page).captures.length).toBe(1);
  });

  test("is off with the reason while the transcript has no sentences", async ({ page }) => {
    await open(page, { sentences: 0 });
    await expect(insertButton(page)).toBeDisabled();
    await expect(insertButton(page)).toHaveAttribute("title", "这一版原文没有段落，无法插图");
    await expect(insertButton(page)).toHaveAccessibleDescription("这一版原文没有段落，无法插图");
  });
});

test.describe("pasting", () => {
  test("inserts a pasted image after the paragraph played at the press, while the video plays on", async ({ page }) => {
    await open(page);
    await seekClip(page, 46);
    mockFigures(page).holdUploads = new Promise(() => undefined);
    await play(page);
    const { prevented, atSeconds } = await paste(page, { png: true });
    expect(prevented).toBe(true);
    await expect.poll(() => mockFigures(page).uploads.length).toBe(1);
    expect(mockFigures(page).uploads[0]?.meta.placement.anchor?.segmentId).toBe(sid(Math.floor(atSeconds / 10)));
    await expect(status(page)).toContainText("正在插入粘贴的图片…");
  });

  test("inserts a pasted image once and reveals it", async ({ page }) => {
    await open(page);
    await seekClip(page, 72);
    expect((await paste(page, { png: true })).prevented).toBe(true);
    await expect.poll(() => mockFigures(page).uploads.length).toBe(1);
    const id = lastCreated(page);
    await expectRevealed(page, id);
    await expect.poll(() => after(page, 7)).toBe(`F:${id}`);
    await expect(status(page)).toHaveText("已插入粘贴的图片");
    expect(mockFigures(page).uploads).toHaveLength(1);
  });

  test("a clipboard with an image and a link only follows the link", async ({ page }) => {
    await open(page);
    expect((await paste(page, { text: LINK, png: true })).prevented).toBe(true);
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole("textbox").first()).toHaveValue(LINK);
    expect(mockFigures(page).uploads).toHaveLength(0);
    expect(mockFigures(page).figures.size).toBe(0);
  });

  test("leaves a paste into a caption field alone", async ({ page }) => {
    const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 15_000 });
    await open(page);
    const row = figureRow(page, frame.id);
    await row.hover();
    await row.getByTestId("figure-caption-add").click();
    await expect(row.getByTestId("figure-caption-input")).toBeFocused();
    expect((await paste(page, { png: true })).prevented).toBe(false);
    expect(mockFigures(page).uploads).toHaveLength(0);
  });
});
