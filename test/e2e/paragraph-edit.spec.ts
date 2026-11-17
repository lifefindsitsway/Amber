import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend, segmentId } from "./mock-backend.ts";
import { manualRevisionId, SEGMENT_GAP_MS, SEGMENT_MS, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKERS_CONTENT, SPEAKERS_REVISION, speakersRequests, type SpeakerSequence } from "./mock-speakers.ts";

/*
 * Paragraphs in the transcript editor: a sentence that opens a paragraph gets more space above
 * it; under the active sentence one action starts a paragraph there or merges it into the one
 * before (also Ctrl/⌘+Enter), off with a reason at the first sentence, a chapter start, a change
 * of speaker or behind a filter. Proofread transcripts open with their marks; unproofread ones
 * show the reading view's paragraphs and get marks of their own on the first paragraph action.
 */

test.use({ actionTimeout: 15_000 });

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
const T = SPEAKER_TEACHER;
const S = SPEAKER_STUDENT;

const rows = (page: Page): Locator => page.getByTestId("sentence-rows");
const row = (page: Page, index: number): Locator => rows(page).locator(`:scope > [data-sentence-index="${index}"]`);
const area = (page: Page, index: number): Locator => row(page, index).locator("textarea");
const action = (page: Page): Locator => page.getByTestId("paragraph-action");

/** Indices of the editor's rows that open a paragraph. */
const editorStarts = (page: Page): Promise<number[]> =>
  rows(page).evaluate((list) =>
    [...list.querySelectorAll(":scope > [data-sentence-index]")].flatMap((item) => (item.hasAttribute("data-paragraph-start") ? [Number(item.getAttribute("data-sentence-index"))] : [])),
  );

/** Ids of the sentences opening the reading view's paragraphs. */
const readerStarts = (page: Page): Promise<string[]> =>
  page.getByTestId("transcript-reader").evaluate((reader) => [...reader.querySelectorAll("p[data-reader-text]")].map((paragraph) => paragraph.querySelector("[data-segment-id]")?.getAttribute("data-segment-id") ?? ""));

async function expectStarts(page: Page, starts: number[]): Promise<void> {
  await expect.poll(() => editorStarts(page)).toEqual(starts);
}

async function openReader(page: Page): Promise<void> {
  await page.goto(READER);
  await expect(page.getByTestId("transcript-reader").locator("[data-segment-id]").first()).toBeVisible();
}

async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("transcript-edit").click();
  await expect(rows(page)).toHaveAttribute("data-initial-scroll", /.+/);
}

/** Makes the sentence at `index` the active one, with the caret at `caret`. */
async function activate(page: Page, index: number, caret = 0): Promise<void> {
  await area(page, index).focus();
  await area(page, index).evaluate((element: HTMLTextAreaElement, at) => element.setSelectionRange(at, at), caret);
  await expect(row(page, index).getByTestId("row-actions")).toBeVisible();
}

async function undo(page: Page): Promise<void> {
  await page.getByTestId("editor-undo").click();
}

/** The lecture's sentences: `sequence` says who speaks, `starts` which open a paragraph (absent = no marks). */
function lecture(page: Page, sequence: SpeakerSequence, starts?: readonly number[], texts: Record<number, string> = {}) {
  const state = speakersRequests(page);
  state.sequence = sequence;
  state.texts = texts;
  if (starts !== undefined) state.paragraphStarts = new Set(starts);
  return state;
}

test.describe("paragraph editing", () => {
  test("a proofread transcript: split, merge, Ctrl+Enter and the keypad's, the reasons an action is off, step-by-step undo, and a commit", async ({ page }) => {
    await installMockBackend(page);
    const state = lecture(page, [T, T, T, T, S, S, T, T], [0, 2, 4, 6]);
    state.chapters = [
      { start: 0, title: "开场" },
      { start: 7, title: "收尾" },
    ];
    await openReader(page);
    const reader = await readerStarts(page);
    await openEditor(page);
    // The editor shows the paragraphs the reader does: marks, the change of speaker and the chapter.
    await expectStarts(page, [0, 2, 4, 6, 7]);
    expect(reader).toEqual([0, 2, 4, 6, 7].map((index) => segmentId(SPEAKERS_REVISION, index)));
    // A start has clearly more space above it than a sentence inside a paragraph.
    const gap = (index: number) => row(page, index).evaluate((item) => parseFloat(getComputedStyle(item).marginTop));
    expect(await gap(2)).toBeGreaterThanOrEqual((await gap(1)) * 4);
    await expect(area(page, 2)).toHaveAttribute("aria-description", "段首");

    await activate(page, 1);
    await expect(action(page)).toHaveText(/从这句另起一段\s*Ctrl\+Enter/);
    await action(page).click();
    await expectStarts(page, [0, 1, 2, 4, 6, 7]);
    await expect(page.getByTestId("editor-undo")).toHaveAttribute("aria-label", "撤销：另起一段");

    await activate(page, 2);
    await expect(action(page)).toHaveText(/并入上一段/);
    await page.keyboard.press("Control+Enter");
    await expectStarts(page, [0, 1, 4, 6, 7]);
    await expect(page.getByTestId("editor-undo")).toHaveAttribute("aria-label", "撤销：合并段落");

    await activate(page, 3);
    await page.keyboard.press("Control+NumpadEnter");
    await expectStarts(page, [0, 1, 3, 4, 6, 7]);
    // Plain Enter is still a line break in the sentence, not a paragraph.
    const text = await area(page, 3).inputValue();
    await page.keyboard.press("Enter");
    await expect(area(page, 3)).toHaveValue(`\n${text}`);
    await page.keyboard.press("Backspace");
    await expect(area(page, 3)).toHaveValue(text);
    await expectStarts(page, [0, 1, 3, 4, 6, 7]);

    // Off, with the reason right next to it: the first sentence, a change of speaker, a chapter.
    for (const [index, reason] of [
      [0, "这是全文第一段"],
      [4, "这里换了发言人，不同发言人总是分段"],
      [7, "这里是章节开头，章节之间总是分段"],
    ] as const) {
      await activate(page, index);
      await expect(action(page)).toBeDisabled();
      await expect(row(page, index).getByTestId("paragraph-blocked")).toHaveText(reason);
      await expect(row(page, index).getByTestId("paragraph-blocked")).toBeVisible();
    }
    await activate(page, 4);
    await page.keyboard.press("Control+Enter");
    await expectStarts(page, [0, 1, 3, 4, 6, 7]);

    // Undo goes back one paragraph action at a time.
    await undo(page);
    await expectStarts(page, [0, 1, 4, 6, 7]);
    await undo(page);
    await expectStarts(page, [0, 1, 2, 4, 6, 7]);
    await undo(page);
    await expectStarts(page, [0, 2, 4, 6, 7]);
    await expect(page.getByTestId("editor-undo")).toBeDisabled();

    await activate(page, 1);
    await action(page).click();
    await page.getByTestId("draft-commit").click();
    await expect(page.locator(`[data-revision-id="${manualRevisionId(1)}"]`)).toBeVisible();
    expect(state.manual[0]?.segments.map((segment) => segment.paragraphStart)).toEqual([true, true, true, false, true, false, true, false]);
    expect(state.manual[0]?.segments.some((segment) => segment.looseJoin === true)).toBe(false);
    await expect.poll(() => readerStarts(page)).toEqual([0, 1, 2, 4, 6, 7].map((index) => segmentId(manualRevisionId(1), index)));
  });

  test("deleting a paragraph's first sentence hands the start to the next one; undo and deleting again give the same paragraphs", async ({ page }) => {
    await installMockBackend(page);
    const state = lecture(page, [T, T, T, T, T, T], [0, 2, 4], { 2: "嗯。" });
    await openReader(page);
    await openEditor(page);
    await expectStarts(page, [0, 2, 4]);
    const deleteFillerSentences = async (): Promise<void> => {
      // The panel stays open after a cleanup; only a closed one is opened.
      if (!(await page.getByTestId("find-panel").isVisible())) await page.getByTestId("editor-find-toggle").click();
      await page.getByTestId("find-mode-filler").click();
      await page.getByTestId("filler-whole").check();
      await page.getByTestId("filler-review").click();
      await page.getByTestId("filler-apply").click();
      await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(5);
    };
    await deleteFillerSentences();
    await expectStarts(page, [0, 2, 3]);
    await expect(area(page, 2)).toHaveValue("第 4 句发言人模拟字幕。");
    await undo(page);
    await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(6);
    await expectStarts(page, [0, 2, 4]);
    await expect(area(page, 2)).toHaveValue("嗯。");
    await deleteFillerSentences();
    await expectStarts(page, [0, 2, 3]);
    await expect.poll(() => state.draft?.segments.map((segment) => segment.paragraphStart)).toEqual([true, false, true, true, false]);
  });

  test("splitting a sentence with 「后半句另起一段」 opens a paragraph at the right half, and one undo takes both back", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, [T, T, T], [0]);
    await openReader(page);
    await openEditor(page);
    await expectStarts(page, [0]);
    await activate(page, 1, 5);
    await expect(page.getByTestId("split-speaker-left")).toBeVisible();
    await page.getByTestId("split-right-starts").check();
    await page.getByTestId("split-button").click();
    await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(4);
    await expectStarts(page, [0, 2]);
    await expect(area(page, 1)).toHaveValue("第 2 句");
    await undo(page);
    await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(3);
    await expectStarts(page, [0]);
  });

  test("a filter hiding the sentence before turns the action off and says so; a saved draft gets its inherited paragraphs without being saved", async ({ page }) => {
    await installMockBackend(page);
    const state = lecture(page, [T, T, T, T, T], [0, 3]);
    // A draft saved before drafts had paragraphs, two sentences waiting for their speaker to be confirmed.
    state.draft = {
      baseRevisionId: SPEAKERS_REVISION,
      version: 1,
      updatedAt: 1,
      segments: [0, 1, 2, 3, 4].map((index) => ({
        id: segmentId(SPEAKERS_REVISION, index),
        startMs: index * SEGMENT_MS,
        endMs: (index + 1) * SEGMENT_MS - SEGMENT_GAP_MS,
        text: `第 ${index + 1} 句发言人模拟字幕。`,
        sourceSegmentIds: [segmentId(SPEAKERS_REVISION, index)],
        speakerId: T,
        ...(index === 1 || index === 3 ? { speakerReview: "needs_review" as const } : {}),
      })),
    };
    await openReader(page);
    await openEditor(page);
    await expectStarts(page, [0, 3]);
    await page.getByTestId("draft-review-count").click();
    await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(2);
    for (const index of [1, 3]) {
      await activate(page, index);
      await expect(action(page)).toBeDisabled();
      await expect(row(page, index).getByTestId("paragraph-blocked")).toHaveText("上一句被筛选隐藏了，显示全部句子后才能调整这里的分段");
    }
    // Filling in the paragraphs is not an edit: nothing was saved.
    expect(state.draft?.version).toBe(1);
    expect(state.draft?.segments.some((segment) => "paragraphStart" in segment)).toBe(false);
  });

  test("paragraphs and speakers: a speaker reassigned after a paragraph action, one before it, and undoing the reassignment", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, [T, T, T, T], [0]);
    await openReader(page);
    await openEditor(page);
    await activate(page, 2);
    await action(page).click();
    await expectStarts(page, [0, 2]);
    // The paragraph's first sentence given to the student: their sentence now stands apart on both sides.
    await row(page, 2).locator("[data-speaker-lead]").focus();
    await page.keyboard.press("2");
    await expectStarts(page, [0, 2, 3]);
    await activate(page, 2);
    await expect(row(page, 2).getByTestId("paragraph-blocked")).toHaveText("这里换了发言人，不同发言人总是分段");
    await undo(page);
    await expectStarts(page, [0, 2]);
    await activate(page, 2);
    await expect(action(page)).toBeEnabled();
    await expect(action(page)).toHaveText(/并入上一段/);
    // Reassigned first, then a paragraph started after it.
    await row(page, 1).locator("[data-speaker-lead]").focus();
    await page.keyboard.press("2");
    await expectStarts(page, [0, 1, 2]);
    await activate(page, 3);
    await action(page).click();
    await expectStarts(page, [0, 1, 2, 3]);
    await undo(page);
    await expectStarts(page, [0, 1, 2]);
    await undo(page);
    await expectStarts(page, [0, 2]);
  });

  test("an unproofread transcript: the reading view's paragraphs, no marks after a plain commit, explicit marks after one paragraph action, the text unchanged", async ({ page }) => {
    await installMockBackend(page);
    // Long sentences, so the readability fallback opens paragraphs; the second one has no full stop.
    const texts: Record<number, string> = {};
    for (let index = 0; index < 12; index += 1) texts[index] = `第${index + 1}句${"的内容".repeat(25)}${index === 1 ? "" : "。"}`;
    const state = lecture(page, [T, T, T, T, T, T, S, S, T, T, T, T], undefined, texts);
    await openReader(page);
    const firstParagraph = await page.getByTestId("transcript-reader").locator("p[data-reader-text]").first().textContent();
    const reader = (await readerStarts(page)).map((id) => Number(id.slice(-4)));
    expect(reader.length).toBeGreaterThan(3);
    await openEditor(page);
    await expectStarts(page, reader);

    // A text edit only: the commit keeps the transcript without marks.
    await activate(page, 11, texts[11]?.length ?? 0);
    await page.keyboard.type("改");
    await page.getByTestId("draft-commit").click();
    await expect(page.locator(`[data-revision-id="${manualRevisionId(1)}"]`)).toBeVisible();
    expect(state.manual[0]?.segments.every((segment) => segment.paragraphStart === undefined && segment.looseJoin === undefined)).toBe(true);

    // Once more, with one paragraph started: every sentence is committed with a mark.
    await openEditor(page);
    await expectStarts(page, reader);
    await activate(page, 4);
    await action(page).click();
    const expected = [...new Set([...reader, 4])].sort((a, b) => a - b);
    await expectStarts(page, expected);
    await expect.poll(() => state.draft?.segments.every((segment) => typeof segment.paragraphStart === "boolean")).toBe(true);
    await page.getByTestId("draft-commit").click();
    await expect(page.locator(`[data-revision-id="${manualRevisionId(2)}"]`)).toBeVisible();
    const committed = state.manual.at(-1)?.segments ?? [];
    expect(committed.map((segment, index) => segment.paragraphStart === expected.includes(index))).toEqual(committed.map(() => true));
    expect(committed.every((segment) => segment.looseJoin === true)).toBe(true);
    await expect.poll(async () => (await readerStarts(page)).map((id) => Number(id.slice(-4)))).toEqual(expected);
    // Only where paragraphs start changed: the sentences still join as before.
    await expect(page.getByTestId("transcript-reader").locator("p[data-reader-text]").first()).toHaveText(firstParagraph ?? "");
  });

  test("a transcript without speakers: a long sentence is split at a calibrated time, without speaker pickers", async ({ page }) => {
    await installMockBackend(page);
    const state = lecture(page, [undefined, undefined, undefined]);
    state.speakers = [];
    await openReader(page);
    await openEditor(page);
    await expect(page.getByTestId("speaker-lead")).toHaveCount(0);
    await activate(page, 0, 5);
    await expect(page.getByTestId("split-control")).toBeVisible();
    await expect(page.getByTestId("split-speaker-left")).toHaveCount(0);
    await expect(page.getByTestId("split-speaker-right")).toHaveCount(0);
    await expect(page.getByTestId("split-source")).toHaveText("估算");
    const at = 4_321;
    await page.getByTestId("split-time").fill(String(at));
    await expect(page.getByTestId("split-source")).toHaveText("手动");
    await page.getByTestId("split-button").click();
    await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(4);
    await page.getByTestId("draft-commit").click();
    await expect(page.locator(`[data-revision-id="${manualRevisionId(1)}"]`)).toBeVisible();
    const [left, right] = state.manual[0]?.segments ?? [];
    expect([left?.text, left?.startMs, left?.endMs]).toEqual(["第 1 句", 0, at]);
    expect([right?.text, right?.startMs, right?.endMs]).toEqual(["发言人模拟字幕。", at, SEGMENT_MS - SEGMENT_GAP_MS]);
  });

  test("a narrow window, by keyboard only: the action and its reason stay in view and the shortcut and Tab reach it", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await installMockBackend(page);
    lecture(page, [T, T, S], [0]);
    await page.goto(READER);
    // A narrow window shows the player and the outputs one at a time.
    await page.getByRole("tab", { name: "产出物" }).click();
    await openEditor(page);
    await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(3);
    await area(page, 1).focus();
    await page.keyboard.press("Control+Enter");
    await expectStarts(page, [0, 1, 2]);
    // From the sentence, Tab reaches the action; Enter takes it.
    await page.keyboard.press("Tab");
    await expect(action(page)).toBeFocused();
    await expect(action(page)).toHaveText(/并入上一段/);
    await page.keyboard.press("Enter");
    await expectStarts(page, [0, 2]);
    await expect(action(page)).toBeFocused();
    const width = page.viewportSize()?.width ?? 0;
    for (const control of [action(page), page.getByTestId("split-control")]) {
      const box = await control.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(width);
    }
    await area(page, 2).focus();
    const reason = row(page, 2).getByTestId("paragraph-blocked");
    await expect(reason).toBeVisible();
    const box = await reason.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(width);
  });
});
