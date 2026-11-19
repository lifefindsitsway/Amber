import { expect, test, type Locator, type Page } from "@playwright/test";
import { FIGURE_WIDTH_SMALL } from "../../src/shared/defaults.ts";
import { FIGURE_WIDTH_PREF_KEY } from "../../src/shared/danmaku-prefs.ts";
import { figurePatchRequestSchema } from "../../src/shared/dto/figure.ts";
import { transcriptSegmentPageDtoSchema } from "../../src/shared/dto/transcript.ts";
import { installMockBackend, LOCAL_CONTENT, segmentId } from "./mock-backend.ts";
import { changeFigureElsewhere, mockFigures, seedFigure } from "./mock-figures.ts";
import { SPEAKER_TEACHER, SPEAKERS_CONTENT, SPEAKERS_REVISION } from "./mock-speakers.ts";

/*
 * Figures in the transcript reading view of the local video: how a figure row shows (image,
 * capture time, caption), and everything done to it in place — caption editing, widths, moving
 * by menu, keys and drag, deleting and undoing, zooming — plus the regressions the figure rows
 * must not cause: a selection across a figure copies no figure, and a link to a figure far down a
 * long (windowed) text brings it into view.
 */

test.use({ actionTimeout: 15_000 });
test.describe.configure({ timeout: 120_000 });

const LOCAL_REVISION = "01J0000000000000000000REV3";
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
const CREATED_AT = 1_790_000_000_000;
/** One sentence every 10 s, each 3 s short of the next: a pause long enough to make every sentence a paragraph of its own. */
const SLOT_MS = 10_000;

interface Sentence {
  startMs: number;
  endMs: number;
  text: string;
}

function lecture(count: number, slotMs = SLOT_MS, gapMs = 3_000): Sentence[] {
  return Array.from({ length: count }, (_, index) => ({
    startMs: index * slotMs,
    endMs: (index + 1) * slotMs - gapMs,
    text: `第 ${index + 1} 句：这一段讲插图旁边的内容。`,
  }));
}

const sid = (index: number): string => segmentId(LOCAL_REVISION, index);

async function serveLecture(page: Page, sentences: readonly Sentence[]): Promise<void> {
  const items = sentences.map((sentence, index) => ({ id: sid(index), revisionId: LOCAL_REVISION, ordinal: index, startMs: sentence.startMs, endMs: sentence.endMs, text: sentence.text, sourceSegmentIds: [] }));
  const revision = { id: LOCAL_REVISION, contentId: LOCAL_CONTENT, kind: "platform", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "platform" }, segmentCount: items.length, createdAt: CREATED_AT };
  await page.route(new RegExp(`/api/transcript/revisions/${LOCAL_REVISION}/segments(\\?|$)`), (route) => route.fulfill({ json: transcriptSegmentPageDtoSchema.parse({ revision, items }) }));
}

const reader = (page: Page): Locator => page.getByTestId("transcript-reader");
const figureRow = (page: Page, id: string): Locator => reader(page).locator(`[data-figure-id="${id}"]`);
const video = (page: Page): Locator => page.getByTestId("player-local").locator("video");
const sentence = (page: Page, index: number): Locator => reader(page).locator(`[data-segment-id="${sid(index)}"]`);

/** Opens the local video's reading view (server mode, so the clip plays) with the given sentences. */
async function open(page: Page, sentences: readonly Sentence[], query = ""): Promise<void> {
  await installMockBackend(page, { mode: "server" });
  await serveLecture(page, sentences);
  const url = `/contents/${LOCAL_CONTENT}?tab=transcript${query}`;
  await page.goto(url);
  await page.evaluate((key) => localStorage.setItem(key, "900"), OUTPUTS_WIDTH_KEY);
  await page.goto(url);
  await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
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

/** What follows sentence `index`'s paragraph in the list. */
async function after(page: Page, index: number): Promise<string | undefined> {
  const rows = await order(page);
  return rows[rows.indexOf(String(index)) + 1];
}

/** Waits for PATCH requests of the figure to reach `count`, and gives back the last body. */
async function lastPatch(page: Page, count: number) {
  await expect.poll(() => mockFigures(page).patches.length).toBe(count);
  return figurePatchRequestSchema.parse(mockFigures(page).patches.at(-1)?.body);
}

async function seekClip(page: Page, seconds: number): Promise<void> {
  await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await video(page).evaluate(async (element: HTMLVideoElement, at) => {
    element.pause();
    const seeked = new Promise((resolve) => element.addEventListener("seeked", resolve, { once: true }));
    element.currentTime = at;
    await seeked;
  }, seconds);
  await expect(page.getByTestId("reader-locate")).not.toHaveAttribute("aria-disabled", /.*/);
}

test("shows a frame with its time after its paragraph, an upload without one, and the time plays from there", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 25_000, caption: "第三段的板书" });
  const upload = seedFigure(page, { contentId: LOCAL_CONTENT, source: "upload", placement: { displayMs: 50_000, anchor: { revisionId: LOCAL_REVISION, segmentId: sid(5), side: "after" } }, fixture: "portrait" });
  await open(page, lecture(13));
  await expect(figureRow(page, frame.id).getByTestId("figure-image")).toBeVisible();
  // 25 s lies in the third sentence (20 s): the frame follows its paragraph.
  expect(await after(page, 2)).toBe(`F:${frame.id}`);
  expect(await after(page, 5)).toBe(`F:${upload.id}`);
  await expect(figureRow(page, frame.id).getByTestId("figure-caption")).toHaveText("第三段的板书");
  await expect(figureRow(page, frame.id).getByTestId("figure-time")).toHaveText("0:25");
  await expect(figureRow(page, upload.id).getByTestId("figure-time")).toHaveCount(0);
  // Without a caption nothing below the image takes room.
  await expect(figureRow(page, upload.id).getByTestId("figure-caption")).toHaveCount(0);
  // The frame reserves its height from the aspect ratio: 640 × 360.
  const box = (await figureRow(page, frame.id).getByTestId("figure-zoom-open").boundingBox()) as { width: number; height: number };
  expect(Math.abs(box.height - (box.width * 360) / 640)).toBeLessThan(2);

  await figureRow(page, frame.id).getByTestId("figure-time").click();
  await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(25, 0);
});

test("edits a caption over several lines: Ctrl+Enter saves, Esc gives up, leaving the field saves", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 15_000, caption: "原来的备注" });
  const bare = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 45_000 });
  await open(page, lecture(13));
  const row = figureRow(page, frame.id);
  await row.getByTestId("figure-caption").click();
  const field = row.getByTestId("figure-caption-input");
  await expect(field).toBeFocused();
  await field.press("End");
  await page.keyboard.type("第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二行");
  // Esc: the edit is given up, nothing is sent.
  await page.keyboard.press("Escape");
  await expect(row.getByTestId("figure-caption")).toHaveText("原来的备注");
  // Focus is back on the caption, which stays closed.
  await expect(row.getByTestId("figure-caption")).toBeFocused();
  await expect(row.getByTestId("figure-caption-input")).toHaveCount(0);
  expect(mockFigures(page).patches).toHaveLength(0);

  await row.getByTestId("figure-caption").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("补充一行");
  await page.keyboard.press("Control+Enter");
  expect((await lastPatch(page, 1)).caption).toBe("原来的备注\n补充一行");
  await expect(row.getByTestId("figure-caption")).toHaveText("原来的备注\n补充一行");
  await expect(row.getByTestId("figure-caption-status")).toHaveAttribute("data-status", "saved");

  // A figure without a caption gets one from the toolbar; leaving the field saves it.
  const other = figureRow(page, bare.id);
  await other.hover();
  await other.getByTestId("figure-caption-add").click();
  await page.keyboard.type("新写的备注");
  await sentence(page, 0).click();
  expect((await lastPatch(page, 2)).caption).toBe("新写的备注");
  await expect(other.getByTestId("figure-caption")).toHaveText("新写的备注");
});

test("a caption changed in another window meanwhile is not overwritten: the latest shows, with a notice", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 15_000, caption: "旧" });
  await open(page, lecture(13));
  const row = figureRow(page, frame.id);
  await row.getByTestId("figure-caption").click();
  changeFigureElsewhere(page, frame.id, { caption: "另一个窗口写的" });
  await page.keyboard.type("这边写的");
  await page.keyboard.press("Control+Enter");
  await expect(row.getByTestId("figure-notice")).toHaveText("这张插图已在别处修改，已显示最新内容");
  await expect(row.getByTestId("figure-caption")).toHaveText("另一个窗口写的");
});

test("sets the width by the three presets and by dragging the handle, saved once on release and remembered", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 15_000 });
  await open(page, lecture(13));
  const row = figureRow(page, frame.id);
  const columnWidth = async (): Promise<number> => row.evaluate((element) => element.getBoundingClientRect().width);
  const frameWidth = async (): Promise<number> => ((await row.getByTestId("figure-frame").boundingBox()) as { width: number }).width;
  await row.hover();
  await row.getByTestId("figure-width-small").click();
  expect((await lastPatch(page, 1)).widthRatio).toBe(FIGURE_WIDTH_SMALL);
  await expect.poll(async () => (await frameWidth()) / (await columnWidth())).toBeCloseTo(FIGURE_WIDTH_SMALL, 2);
  expect(await page.evaluate((key) => localStorage.getItem(key), FIGURE_WIDTH_PREF_KEY)).toBe(String(FIGURE_WIDTH_SMALL));
  await expect(row.getByTestId("figure-width-small")).toHaveAttribute("aria-pressed", "true");

  // Drag the handle out to about 55 % of the column: nothing is saved until the button is let go.
  await row.hover();
  const handle = (await row.getByTestId("figure-width-handle").boundingBox()) as { x: number; y: number; width: number; height: number };
  const column = (await row.boundingBox()) as { x: number; width: number };
  const center = column.x + column.width / 2;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(center + column.width * 0.275, handle.y + handle.height / 2, { steps: 6 });
  await expect(row.getByTestId("figure-width-live")).toBeVisible();
  expect(mockFigures(page).patches).toHaveLength(1);
  await page.mouse.up();
  const dragged = (await lastPatch(page, 2)).widthRatio as number;
  expect(dragged).toBeGreaterThan(0.5);
  expect(dragged).toBeLessThan(0.6);
  // Dragged close to a preset, it snaps onto it.
  await row.hover();
  const again = (await row.getByTestId("figure-width-handle").boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(center + column.width * 0.49, again.y + again.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await lastPatch(page, 3)).widthRatio).toBe(1);
});

test("moves by the menu and by the keys on the move handle, to the playback position and back to the capture time", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 25_000 });
  await open(page, lecture(13));
  const row = figureRow(page, frame.id);
  expect(await after(page, 2)).toBe(`F:${frame.id}`);

  await row.hover();
  await row.getByTestId("figure-menu").click();
  await page.getByTestId("figure-menu-down").click();
  expect((await lastPatch(page, 1)).placement?.anchor).toMatchObject({ segmentId: sid(3), side: "after" });
  await expect.poll(() => after(page, 3)).toBe(`F:${frame.id}`);

  // The keys on the focused handle: one paragraph a press, focus stays on the handle.
  await row.getByTestId("figure-grip").focus();
  await page.keyboard.press("ArrowUp");
  await lastPatch(page, 2);
  await expect.poll(() => after(page, 2)).toBe(`F:${frame.id}`);
  await expect(page.getByTestId("figure-announcement")).toHaveText("插图已移到第 3 段之后");
  await page.keyboard.press("ArrowUp");
  await lastPatch(page, 3);
  await expect.poll(() => after(page, 1)).toBe(`F:${frame.id}`);
  await expect(row.getByTestId("figure-grip")).toBeFocused();
  // Read out with where it went, so two moves never sound the same.
  await expect(page.getByTestId("figure-announcement")).toHaveText("插图已移到第 2 段之后");

  // Playback at 85 s is in the ninth sentence.
  await seekClip(page, 85);
  await row.hover();
  await row.getByTestId("figure-menu").click();
  await page.getByTestId("figure-menu-playback").click();
  expect((await lastPatch(page, 4)).placement?.anchor).toMatchObject({ segmentId: sid(8), side: "after" });
  await expect.poll(() => after(page, 8)).toBe(`F:${frame.id}`);

  await row.hover();
  await row.getByTestId("figure-menu").click();
  await page.getByTestId("figure-menu-capture").click();
  const back = await lastPatch(page, 5);
  expect(back.placement).toMatchObject({ displayMs: 25_000, anchor: null });
  await expect.poll(() => after(page, 2)).toBe(`F:${frame.id}`);
  // Already at its capture time, the entry is off.
  await row.hover();
  await row.getByTestId("figure-menu").click();
  await expect(page.getByTestId("figure-menu-capture")).toHaveAttribute("data-disabled", "");
  await page.keyboard.press("Escape");
});

test("drags a figure by its handle to another paragraph, with a drop line, without selecting text", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 5_000, widthRatio: FIGURE_WIDTH_SMALL });
  await open(page, lecture(13));
  const row = figureRow(page, frame.id);
  expect(await after(page, 0)).toBe(`F:${frame.id}`);
  await row.hover();
  const grip = (await row.getByTestId("figure-grip").boundingBox()) as { x: number; y: number; width: number; height: number };
  // The fourth paragraph's row, the space after its text included.
  const target = (await reader(page).locator(`[data-row-key="${sid(3)}"]`).boundingBox()) as { x: number; y: number; height: number };
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  // Into the lower half of the fourth paragraph: the gap after it.
  await page.mouse.move(target.x + 40, target.y + target.height * 0.8, { steps: 10 });
  await expect(page.getByTestId("figure-drop-indicator")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("figure-drop-indicator")).toHaveCount(0);
  expect((await lastPatch(page, 1)).placement?.anchor).toMatchObject({ segmentId: sid(3), side: "after" });
  await expect.poll(() => after(page, 3)).toBe(`F:${frame.id}`);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("deletes from the menu, shows 「已删除 · 撤销」 in place, and undoes it", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 25_000, caption: "要删的图" });
  await open(page, lecture(13));
  const row = figureRow(page, frame.id);
  await row.hover();
  await row.getByTestId("figure-menu").click();
  await page.getByTestId("figure-menu-delete").click();
  const placeholder = reader(page).getByTestId("figure-deleted");
  await expect(placeholder).toContainText("已删除插图");
  expect(await after(page, 2)).toBe(`F:${frame.id}`);
  await expect.poll(() => mockFigures(page).deletions).toEqual([frame.id]);
  await expect(placeholder.getByTestId("figure-undo")).toBeFocused();
  await placeholder.getByTestId("figure-undo").click();
  await expect.poll(() => mockFigures(page).restorations).toEqual([frame.id]);
  await expect(row.getByTestId("figure-image")).toBeVisible();
  await expect(reader(page).getByTestId("figure-deleted")).toHaveCount(0);
});

test("zooms a figure on click and closes with Esc", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 25_000, caption: "放大看" });
  await open(page, lecture(13));
  await figureRow(page, frame.id).getByTestId("figure-image").click();
  const zoom = page.getByTestId("figure-zoom");
  await expect(zoom).toBeVisible();
  await expect(zoom.locator("img")).toBeVisible();
  await expect(zoom).toContainText("放大看");
  await page.keyboard.press("Escape");
  await expect(zoom).toHaveCount(0);
});

test("a selection across a figure copies the text around it and nothing of the figure", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 15_000, caption: "图注不该被复制", widthRatio: FIGURE_WIDTH_SMALL });
  await open(page, lecture(13));
  expect(await after(page, 1)).toBe(`F:${frame.id}`);
  const from = (await sentence(page, 1).boundingBox()) as { x: number; y: number; height: number };
  const to = (await sentence(page, 2).boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  const sentinel = "⁣nothing copied yet";
  await page.evaluate((value) => navigator.clipboard.writeText(value), sentinel);
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(sentinel);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("第 2 句");
  expect(text).toContain("第 3 句");
  expect(text).not.toContain("图注");
});

test("a link to a figure far down a long text scrolls it into view, highlights it and is spent", async ({ page }) => {
  const sentences = lecture(400, 3_000, 2_500);
  const far = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 350 * 3_000 + 100, caption: "很靠后的图" });
  await open(page, sentences, `&figure=${far.id}`);
  const row = figureRow(page, far.id);
  await expect(row).toBeInViewport();
  await expect(row.getByTestId("figure-frame")).toHaveClass(/ring-2/);
  expect(new URL(page.url()).searchParams.get("figure")).toBeNull();
  expect(await after(page, 350)).toBe(`F:${far.id}`);
});

test("a link to a figure that is gone says so", async ({ page }) => {
  await open(page, lecture(13), "&figure=01J00000000000000000FIG999");
  await expect(page.getByTestId("figure-locate-missing")).toHaveText("要查看的插图已删除或不存在", { timeout: 10_000 });
});

test.describe("with speakers", () => {
  const speakerSid = (index: number): string => segmentId(SPEAKERS_REVISION, index);

  test("「只看」 hides a figure with its paragraph and offers no moves; a link to it shows the whole text again", async ({ page }) => {
    await installMockBackend(page);
    // After the student's question (sentence 3) and inside the teacher's second turn.
    const student = seedFigure(page, { contentId: SPEAKERS_CONTENT, capturedAtMs: 21_000, placement: { displayMs: 20_000, anchor: { revisionId: SPEAKERS_REVISION, segmentId: speakerSid(2), side: "after" } } });
    const teacher = seedFigure(page, { contentId: SPEAKERS_CONTENT, capturedAtMs: 31_000, placement: { displayMs: 30_000, anchor: { revisionId: SPEAKERS_REVISION, segmentId: speakerSid(3), side: "after" } }, widthRatio: FIGURE_WIDTH_SMALL });
    await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript&speaker=${SPEAKER_TEACHER}`);
    await expect(figureRow(page, teacher.id)).toBeVisible();
    await expect(figureRow(page, student.id)).toHaveCount(0);
    await figureRow(page, teacher.id).hover();
    await figureRow(page, teacher.id).getByTestId("figure-menu").click();
    await expect(page.getByTestId("figure-menu-up")).toHaveAttribute("data-disabled", "");
    await expect(page.getByTestId("figure-menu-blocked")).toHaveText("显示完整原文后才能移动插图");
    await page.keyboard.press("Escape");

    await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript&speaker=${SPEAKER_TEACHER}&figure=${student.id}`);
    await expect(figureRow(page, student.id)).toBeInViewport();
    expect(new URL(page.url()).searchParams.getAll("speaker")).toEqual([]);
  });
});

test("two quick moves while the server is slow: the figure never jumps back, and neither move conflicts", async ({ page }) => {
  const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 45_000, widthRatio: FIGURE_WIDTH_SMALL });
  await open(page, lecture(13));
  // Every answer to a figure change takes a while; the mock backend answers it after the pause.
  await page.route(/\/api\/figures\/[^/]+$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fallback();
  });
  const row = figureRow(page, frame.id);
  expect(await after(page, 4)).toBe(`F:${frame.id}`);
  await row.getByTestId("figure-grip").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  // Shown two paragraphs up at once, and still there while the first answer comes back.
  await expect.poll(() => after(page, 2)).toBe(`F:${frame.id}`);
  const seen: Array<string | undefined> = [];
  for (let i = 0; i < 12; i += 1) {
    seen.push(await after(page, 2));
    await page.waitForTimeout(100);
  }
  expect(seen.every((entry) => entry === `F:${frame.id}`)).toBe(true);
  await expect.poll(() => mockFigures(page).patches.length).toBe(2);
  expect(mockFigures(page).patches.map((entry) => figurePatchRequestSchema.parse(entry.body).version)).toEqual([1, 2]);
  await expect(row.getByTestId("figure-notice")).toHaveCount(0);
  await expect.poll(() => after(page, 2)).toBe(`F:${frame.id}`);
});

test.describe("in a long, windowed text", () => {
  const LONG = lecture(400, 3_000, 2_500);

  test("a figure dragged far down stays mounted while the list scrolls under it, and lands where it is dropped", async ({ page }) => {
    const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 6_100, widthRatio: FIGURE_WIDTH_SMALL });
    await open(page, LONG);
    const row = figureRow(page, frame.id);
    await row.hover();
    const grip = (await row.getByTestId("figure-grip").boundingBox()) as { x: number; y: number; width: number; height: number };
    const list = (await reader(page).boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    // Held at the bottom edge: the list scrolls on by itself, far past where the figure's row was.
    await page.mouse.move(list.x + list.width / 2, list.y + list.height - 4, { steps: 8 });
    await expect.poll(() => reader(page).evaluate((element) => element.scrollTop), { timeout: 20_000 }).toBeGreaterThan(6_000);
    await expect(row).toHaveCount(1);
    await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2, { steps: 4 });
    await expect(page.getByTestId("figure-drop-indicator")).toBeVisible();
    await page.mouse.up();
    const anchor = (await lastPatch(page, 1)).placement?.anchor;
    expect(Number(anchor?.segmentId.slice(-4))).toBeGreaterThan(40);
    await expect(page.getByTestId("figure-drop-indicator")).toHaveCount(0);
  });

  test("a caption being edited keeps its draft when the list scrolls far away and back; leaving the tab saves it", async ({ page }) => {
    const frame = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 6_100, caption: "原来的备注" });
    await open(page, LONG);
    const row = figureRow(page, frame.id);
    await row.getByTestId("figure-caption").click();
    await page.keyboard.press("End");
    await page.keyboard.type("，还没写完");
    await reader(page).evaluate((element) => {
      element.scrollTop = 30_000;
    });
    await page.waitForTimeout(300);
    await expect(row.getByTestId("figure-caption-input")).toHaveCount(1);
    await reader(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(row.getByTestId("figure-caption-input")).toHaveValue("原来的备注，还没写完");
    expect(mockFigures(page).patches).toHaveLength(0);
    // Switching to another tab unmounts the reader with the draft still open: it is saved.
    await page.getByRole("tab", { name: "总结" }).click();
    expect((await lastPatch(page, 1)).caption).toBe("原来的备注，还没写完");
  });
});

test("a figure changed in another window above the screen leaves the text in view where it is, and the selected sentence is not centred again", async ({ page, context }) => {
  const above = seedFigure(page, { contentId: LOCAL_CONTENT, capturedAtMs: 1_000, widthRatio: FIGURE_WIDTH_SMALL });
  await open(page, lecture(30));
  await sentence(page, 20).click();
  const topOf = (index: number) => sentence(page, index).evaluate((element) => element.getBoundingClientRect().top);
  await expect.poll(async () => Math.round(await topOf(20))).toBe(Math.round(await topOf(20)));
  const before = await topOf(20);
  // The other window makes the figure far above the screen full width: much taller.
  const other = await context.newPage();
  await installMockBackend(other, { mode: "server" });
  await serveLecture(other, lecture(30));
  await other.goto(`/contents/${LOCAL_CONTENT}?tab=transcript`);
  const there = figureRow(other, above.id);
  await there.hover();
  await there.getByTestId("figure-width-large").click();
  await expect.poll(() => mockFigures(page).patches.length).toBe(1);
  // This window reads the change and lays out the taller figure above; the sentence stays put.
  await expect.poll(() => page.evaluate((id) => document.querySelector(`[data-figure-id="${id}"] [data-testid="figure-frame"]`)?.getAttribute("data-width"), above.id)).toBe("1");
  await page.waitForTimeout(400);
  expect(Math.abs((await topOf(20)) - before)).toBeLessThan(2);
});
