import { expect, test, type Locator, type Page } from "@playwright/test";
import { READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey } from "../../src/shared/reader-typography.ts";
import { installMockBackend, LOCAL_CONTENT, segmentId } from "./mock-backend.ts";
import {
  manualRevisionId,
  SPEAKER_STUDENT,
  SPEAKER_TEACHER,
  SPEAKERS_CONTENT,
  SPEAKERS_EARLIER_REVISION,
  SPEAKERS_REVISION,
  speakersRequests,
} from "./mock-speakers.ts";

/*
 * 「编辑」 in the transcript reading view and the way back: the editor opens on the sentence the
 * user was looking at (the playing one, else the clicked one, else the first one on screen) at
 * the height it had in the reader, and closing the editor brings the reader back to the screen
 * it had, also after a commit replaced the text with a new revision. Long texts window their rows
 * from 150 rows on, so lectures just below and above that count are run too.
 */

test.use({ actionTimeout: 15_000 });
// A 3,000-sentence editor renders every row.
test.describe.configure({ timeout: 120_000 });

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
/** How far a row or sentence may land from where it belongs, in CSS px. */
const PLACE_TOLERANCE_PX = 1;
/** How far a centred or top-aligned row may sit from its place: the list's 0.5rem top padding is not part of the rows' positions. */
const CENTRE_TOLERANCE_PX = 10;
const RESTORE_ATTRIBUTE = "data-return-restore";
const EDITOR_OPEN_TIMEOUT_MS = 60_000;
const INITIAL_SCROLL_ATTRIBUTE = "data-initial-scroll";

const reader = (page: Page): Locator => page.getByTestId("transcript-reader");
/** The reader's root, which carries the shown revision and how the return ended. */
const readerRoot = (page: Page, revisionId?: string): Locator => page.locator(revisionId === undefined ? "[data-revision-id]" : `[data-revision-id="${revisionId}"]`);
const rows = (page: Page): Locator => page.getByTestId("sentence-rows");
const sentenceIn = (page: Page, revisionId: string, index: number): Locator => reader(page).locator(`[data-segment-id="${segmentId(revisionId, index)}"]`);
/** Segment ids of the lecture end in their four-digit index. */
const indexOf = (id: string): number => Number(id.slice(-4));
/** Turns that alternate every sentence, so each sentence is a row of its own. */
const alternating = (count: number): string[] => Array.from({ length: count }, (_, index) => (index % 2 === 0 ? SPEAKER_TEACHER : SPEAKER_STUDENT));
const params = (page: Page): URLSearchParams => new URL(page.url()).searchParams;

/** Opens the speakers lecture's reader with the default typography and a fixed output column. */
async function open(page: Page, query = ""): Promise<void> {
  const url = `${READER}${query}`;
  if (!page.url().startsWith("http")) await page.goto(url);
  await page.evaluate(
    ([key, value, widthKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(widthKey, "900");
    },
    [readerTypographyKey("local"), JSON.stringify(READER_TYPOGRAPHY_DEFAULTS), OUTPUTS_WIDTH_KEY] as const,
  );
  await page.goto(url);
  await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
}

interface SeenSentence {
  id: string;
  /** Its first line's top below the reader's top. */
  offset: number;
  firstLineFullyVisible: boolean;
}

interface ReaderScreen {
  /** The first row whose bottom is below the reader's top, and its top's distance from there. */
  row: { key: string; offset: number } | undefined;
  /** The sentences with a line on screen, in reading order. */
  sentences: SeenSentence[];
}

/** What the reader shows, read off the layout the way a user sees it. */
function readScreen(page: Page): Promise<ReaderScreen> {
  return reader(page).evaluate((scroller) => {
    const view = scroller.getBoundingClientRect();
    let row: ReaderScreen["row"];
    for (const element of Array.from(scroller.querySelectorAll("[data-row-key]"))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.bottom > view.top) {
        row = { key: element.getAttribute("data-row-key") ?? "", offset: rect.top - view.top };
        break;
      }
    }
    const sentences: SeenSentence[] = [];
    for (const element of Array.from(scroller.querySelectorAll("[data-segment-id]"))) {
      const lines = Array.from(element.getClientRects()).filter((line) => line.height > 0);
      const first = lines[0];
      if (first === undefined || !lines.some((line) => line.bottom > view.top && line.top < view.bottom)) continue;
      sentences.push({ id: element.getAttribute("data-segment-id") ?? "", offset: first.top - view.top, firstLineFullyVisible: first.top >= view.top && first.bottom <= view.bottom });
    }
    return { row, sentences };
  });
}

/** The screen once it has stopped moving: two reads 150 ms apart agree. */
async function settledScreen(page: Page): Promise<ReaderScreen> {
  let previous = await readScreen(page);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(150);
    const next = await readScreen(page);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  throw new Error("the reader never settled");
}

/** The first line's top of a sentence below the reader's top; `undefined` when it is not mounted. */
function sentenceOffset(page: Page, id: string): Promise<number | undefined> {
  return reader(page).evaluate((scroller, segment) => {
    const element = Array.from(scroller.querySelectorAll("[data-segment-id]")).find((candidate) => candidate.getAttribute("data-segment-id") === segment);
    if (element === undefined) return undefined;
    const first = Array.from(element.getClientRects()).find((line) => line.height > 0) ?? element.getBoundingClientRect();
    return first.top - scroller.getBoundingClientRect().top;
  }, id);
}

/** Scrolls the reader to a fraction of its height, as the scrollbar would, and waits for it to settle. */
async function scrollReader(page: Page, fraction: number): Promise<ReaderScreen> {
  await reader(page).evaluate((scroller, at) => {
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * at;
  }, fraction);
  return settledScreen(page);
}

/** The sentence a weak entry opens on: the first one on screen whose first line is wholly visible. */
function weakTarget(screen: ReaderScreen): SeenSentence {
  const target = screen.sentences.find((sentence) => sentence.firstLineFullyVisible) ?? screen.sentences[0];
  if (target === undefined) throw new Error("no sentence on screen");
  return target;
}

function topSentence(screen: ReaderScreen): SeenSentence {
  const top = screen.sentences[0];
  if (top === undefined) throw new Error("no sentence on screen");
  return top;
}

/** Times, in the page's own clock, from the click on 「编辑」 to the editor's opening scroll ending. */
async function timeEditorOpening(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record = window as unknown as { __editClick?: number; __editRows?: number; __editPlaced?: number };
    delete record.__editClick;
    delete record.__editRows;
    delete record.__editPlaced;
    document.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest('[data-testid="transcript-edit"]') !== null) record.__editClick = performance.now();
      },
      { capture: true, once: true },
    );
    const observer = new MutationObserver(() => {
      if (record.__editRows === undefined && document.querySelector('[data-testid="sentence-rows"]') !== null) record.__editRows = performance.now();
      if (document.querySelector('[data-testid="sentence-rows"][data-initial-scroll]') !== null) {
        record.__editPlaced = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-initial-scroll"] });
  });
}

/** From the click: when the editor's rows were in the page, and when its opening scroll ended. */
async function editorOpeningMs(page: Page): Promise<{ rows: number; placed: number }> {
  return page.evaluate(() => {
    const record = window as unknown as { __editClick?: number; __editRows?: number; __editPlaced?: number };
    const click = record.__editClick ?? Number.NaN;
    return { rows: (record.__editRows ?? Number.NaN) - click, placed: (record.__editPlaced ?? Number.NaN) - click };
  });
}

/** Where a row of the editor sits: its top below the list's visible top, and the sizes the goal is clamped by. */
function editorRow(page: Page, index: number): Promise<{ rowTop: number; rowHeight: number; clientHeight: number } | undefined> {
  return rows(page).evaluate((list, at) => {
    const row = list.querySelector(`:scope > [data-sentence-index="${at}"]`);
    if (row === null) return undefined;
    const rect = row.getBoundingClientRect();
    return { rowTop: rect.top - (list.getBoundingClientRect().top + list.clientTop), rowHeight: rect.height, clientHeight: list.clientHeight };
  }, index);
}

/**
 * The opening scroll put the row at `offset` below the list's top, kept wholly in view where the
 * list is tall enough. A list too short to scroll that far (`edge`) can only show the row in view.
 */
async function expectEditorRowAt(page: Page, index: number, offset: number): Promise<void> {
  const row = await editorRow(page, index);
  expect(row, `editor row ${index}`).toBeDefined();
  if (row === undefined) return;
  if ((await rows(page).getAttribute(INITIAL_SCROLL_ATTRIBUTE)) === "edge") {
    expect(row.rowTop).toBeGreaterThanOrEqual(-PLACE_TOLERANCE_PX);
    expect(row.rowTop + Math.min(row.rowHeight, row.clientHeight)).toBeLessThanOrEqual(row.clientHeight + PLACE_TOLERANCE_PX);
    return;
  }
  const goal = Math.min(Math.max(offset, 0), Math.max(0, row.clientHeight - row.rowHeight));
  expect(Math.abs(row.rowTop - goal), `editor row ${index} at ${row.rowTop}, expected ${goal}`).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
}

/** Where the focus is in the editor: the sentence index whose text has it, and the caret. */
function editorFocus(page: Page): Promise<{ index: number | undefined; start: number | null; end: number | null }> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const row = active instanceof HTMLTextAreaElement ? active.closest("[data-sentence-index]") : null;
    return {
      index: row === null ? undefined : Number(row.getAttribute("data-sentence-index")),
      start: active instanceof HTMLTextAreaElement ? active.selectionStart : null,
      end: active instanceof HTMLTextAreaElement ? active.selectionEnd : null,
    };
  });
}

/**
 * Waits for a condition with a plain query in the page. A locator assertion polling a page that
 * holds a 3,000-textarea editor keeps the main thread busy for seconds at a time and would hold
 * back the very work being waited for.
 */
async function waitInPage(page: Page, condition: (args: string[]) => unknown, args: string[] = []): Promise<unknown> {
  const handle = await page.waitForFunction(condition, args, { polling: 100, timeout: EDITOR_OPEN_TIMEOUT_MS });
  return handle.jsonValue();
}

/** Waits for the reader showing `revisionId` to say how its return ended, and returns that. */
async function returnOutcome(page: Page, revisionId: string): Promise<string> {
  return (await waitInPage(
    page,
    ([id, attribute]) => document.querySelector(`[data-revision-id="${id}"]`)?.getAttribute(attribute ?? "") ?? false,
    [revisionId, RESTORE_ATTRIBUTE],
  )) as string;
}

interface HeldFrames {
  held: Map<number, FrameRequestCallback>;
  raf: typeof requestAnimationFrame;
  caf: typeof cancelAnimationFrame;
}

/**
 * Holds the page's animation frames from now on, so a return that corrects the scroll position
 * frame by frame stays in progress until the test has acted; a slow machine looks the same to
 * the user. Playwright's own checks run in another world and are not held.
 */
async function holdFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = new Map<number, FrameRequestCallback>();
    let next = 1;
    (window as unknown as { __heldFrames?: HeldFrames }).__heldFrames = { held, raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window) };
    window.requestAnimationFrame = (callback) => {
      const id = next++;
      held.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      held.delete(id);
    };
  });
}

/** Lets the held frames run, and every later one as usual. */
async function releaseFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __heldFrames?: HeldFrames };
    const frames = store.__heldFrames;
    if (frames === undefined) return;
    delete store.__heldFrames;
    window.requestAnimationFrame = frames.raf;
    window.cancelAnimationFrame = frames.caf;
    for (const callback of frames.held.values()) frames.raf(callback);
    frames.held.clear();
  });
}

/** Clicks 「编辑」 and waits for the editor's opening scroll to end; returns how it ended. */
async function startEditing(page: Page): Promise<string> {
  await page.getByTestId("transcript-edit").click();
  return (await waitInPage(page, ([attribute]) => document.querySelector('[data-testid="sentence-rows"]')?.getAttribute(attribute ?? "") ?? false, [INITIAL_SCROLL_ATTRIBUTE])) as string;
}

/** Types at the start of the sentence at `index` of the editor. */
async function typeInto(page: Page, index: number, text: string): Promise<void> {
  const area = rows(page).locator(`:scope > [data-sentence-index="${index}"] textarea`);
  await area.focus();
  await area.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  await page.keyboard.type(text);
  expect(await area.evaluate((element: HTMLTextAreaElement) => element.value)).toMatch(new RegExp(`^${text}`));
}

/** The reader's top row is back where it was before editing, to the pixel. */
function expectSameRow(after: ReaderScreen, before: ReaderScreen): void {
  expect(after.row?.key).toBe(before.row?.key);
  expect(Math.abs((after.row?.offset ?? Number.NaN) - (before.row?.offset ?? Number.NaN))).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
}

/** A sentence stays at `offset` below the reader's top for about a second: no later jump moves it. */
async function expectStaysAt(page: Page, id: string, offset: number): Promise<void> {
  for (let sample = 0; sample < 10; sample += 1) {
    const at = await sentenceOffset(page, id);
    expect(at, `sentence ${id} on sample ${sample}`).toBeDefined();
    expect(Math.abs((at ?? Number.NaN) - offset), `sentence ${id} at ${at}, expected ${offset} on sample ${sample}`).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
    await page.waitForTimeout(100);
  }
}

test.describe("a 3,000-sentence lecture", () => {
  const COUNT = 3000;

  test("a weak entry opens the editor on the first wholly visible sentence at its height; 退出 brings the reader back to the pixel", async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).sequence = alternating(COUNT);
    await open(page);
    const before = await scrollReader(page, 0.5);
    const target = weakTarget(before);
    expect(indexOf(target.id)).toBeGreaterThan(1000);

    await timeEditorOpening(page);
    expect(await startEditing(page)).toBe("settled");
    const openingMs = await editorOpeningMs(page);
    console.log(`editor opening: rows in the page ${Math.round(openingMs.rows)} ms, settled ${Math.round(openingMs.placed)} ms after the click`);
    await expectEditorRowAt(page, indexOf(target.id), target.offset);
    // A weak entry does not take the focus.
    expect((await editorFocus(page)).index).toBeUndefined();

    const exitAt = Date.now();
    await page.getByTestId("draft-exit").click();
    expect(await returnOutcome(page, SPEAKERS_REVISION)).toBe("exact");
    console.log(`return after 退出, click to exact (test clock): ${Date.now() - exitAt} ms`);
    expectSameRow(await readScreen(page), before);
    expectSameRow(await settledScreen(page), before);
  });

  test("a clicked sentence opens the editor with the cursor at its start; 放弃草稿 brings the reader back to the pixel", async ({ page }) => {
    await installMockBackend(page);
    const state = speakersRequests(page);
    state.sequence = alternating(COUNT);
    await open(page);
    await scrollReader(page, 0.3);
    // The bilibili player reports no playback time, so the clicked sentence leads.
    const screen = await readScreen(page);
    const clicked = screen.sentences.at(-3);
    if (clicked === undefined) throw new Error("no sentence on screen");
    await reader(page).locator(`[data-segment-id="${clicked.id}"]`).click();
    await expect(reader(page).locator(`[data-segment-id="${clicked.id}"]`)).toHaveAttribute("aria-current", "true");
    const before = await settledScreen(page);
    const seen = before.sentences.find((sentence) => sentence.id === clicked.id);
    expect(seen).toBeDefined();

    expect(await startEditing(page)).toBe("settled");
    await expectEditorRowAt(page, indexOf(clicked.id), seen?.offset ?? Number.NaN);
    expect(await editorFocus(page)).toEqual({ index: indexOf(clicked.id), start: 0, end: 0 });

    // An edit reaches the server as a draft, which 放弃草稿 then deletes at its version.
    await typeInto(page, indexOf(clicked.id), "改");
    await waitInPage(page, () => document.querySelector('[data-testid="draft-save-status"]')?.textContent === "自动保存");
    expect(state.draft?.version).toBe(1);
    await page.getByTestId("draft-discard").click();
    await page.getByTestId("draft-discard").click();
    expect(await returnOutcome(page, SPEAKERS_REVISION)).toBe("exact");
    expect(state.draft).toBeUndefined();
    expectSameRow(await settledScreen(page), before);
    // The selection is untouched.
    await expect(reader(page).locator(`[data-segment-id="${clicked.id}"]`)).toHaveAttribute("aria-current", "true");
    expect(params(page).get("segment")).toBe(clicked.id);
  });

  test("完成 lands on the top sentence's counterpart in the new revision, at its height, and stays there", async ({ page }) => {
    await installMockBackend(page);
    const state = speakersRequests(page);
    state.sequence = alternating(COUNT);
    await open(page);
    await scrollReader(page, 0.6);
    const shown = await readScreen(page);
    const clicked = shown.sentences.at(-4);
    if (clicked === undefined) throw new Error("no sentence on screen");
    await reader(page).locator(`[data-segment-id="${clicked.id}"]`).click();
    const before = await settledScreen(page);
    const top = topSentence(before);

    expect(await startEditing(page)).toBe("settled");
    await typeInto(page, indexOf(clicked.id), "（已核对）");
    const commitAt = Date.now();
    await page.getByTestId("draft-commit").click();

    const manual = manualRevisionId(1);
    expect(await returnOutcome(page, manual)).toBe("exact");
    console.log(`return after 完成, click to exact (test clock): ${Date.now() - commitAt} ms`);
    await expectStaysAt(page, segmentId(manual, indexOf(top.id)), top.offset);
    // The new revision is the current text: the address names no revision, and the selection followed the sentence.
    expect(params(page).has("revision")).toBe(false);
    expect(params(page).get("segment")).toBe(segmentId(manual, indexOf(clicked.id)));
    await expect(sentenceIn(page, manual, indexOf(clicked.id))).toHaveAttribute("aria-current", "true");
    await expect(sentenceIn(page, manual, indexOf(clicked.id))).toContainText("（已核对）");
    expect(state.commits).toHaveLength(1);
  });
});

test.describe("around the windowing threshold", () => {
  for (const count of [149, 150, 151]) {
    test(`${count} sentences: settled entry, exact return after 退出 and after 完成`, async ({ page }) => {
      await installMockBackend(page);
      speakersRequests(page).sequence = alternating(count);
      await open(page);
      const before = await scrollReader(page, 0.5);
      const target = weakTarget(before);

      expect(await startEditing(page)).toBe("settled");
      await expectEditorRowAt(page, indexOf(target.id), target.offset);
      await page.getByTestId("draft-exit").click();
      expect(await returnOutcome(page, SPEAKERS_REVISION)).toBe("exact");
      expectSameRow(await settledScreen(page), before);

      const again = await settledScreen(page);
      const top = topSentence(again);
      expect(await startEditing(page)).toBe("settled");
      await typeInto(page, indexOf(weakTarget(again).id), "改");
      await page.getByTestId("draft-commit").click();
      const manual = manualRevisionId(1);
      expect(await returnOutcome(page, manual)).toBe("exact");
      await expectStaysAt(page, segmentId(manual, indexOf(top.id)), top.offset);
    });
  }
});

test.describe("a 320-sentence lecture with chapters", () => {
  const COUNT = 320;
  const CHAPTERS = [
    { start: 0, title: "开场" },
    { start: 80, title: "第二部分" },
    { start: 160, title: "第三部分" },
    { start: 240, title: "收尾" },
  ];

  async function openLecture(page: Page, query = ""): Promise<void> {
    const state = speakersRequests(page);
    state.sequence = alternating(COUNT);
    state.chapters = CHAPTERS;
    await open(page, query);
  }

  test("committing a version named in the address returns to the current text and clears the address; a reload keeps the sentence", async ({ page }) => {
    await installMockBackend(page);
    const state = speakersRequests(page);
    state.earlierRevision = true;
    await openLecture(page, `&revision=${SPEAKERS_EARLIER_REVISION}`);
    await expect(readerRoot(page, SPEAKERS_EARLIER_REVISION)).toBeVisible();
    await sentenceIn(page, SPEAKERS_EARLIER_REVISION, 2).click();
    expect(params(page).get("segment")).toBe(segmentId(SPEAKERS_EARLIER_REVISION, 2));
    const before = await settledScreen(page);
    const top = topSentence(before);

    // The earlier recognition has four sentences: the editor's list has nothing to scroll.
    expect(await startEditing(page)).toMatch(/^(settled|edge)$/);
    expect(await editorFocus(page)).toEqual({ index: 2, start: 0, end: 0 });
    await typeInto(page, 2, "改");
    await page.getByTestId("draft-commit").click();

    const manual = manualRevisionId(1);
    expect(await returnOutcome(page, manual)).toBe("exact");
    expect(state.commits).toEqual([{ expectedPrimaryRevisionId: SPEAKERS_REVISION, draftVersion: 1 }]);
    expect(params(page).has("revision")).toBe(false);
    expect(params(page).get("segment")).toBe(segmentId(manual, 2));
    await expect(sentenceIn(page, manual, 2)).toHaveAttribute("aria-current", "true");
    await expectStaysAt(page, segmentId(manual, indexOf(top.id)), top.offset);

    await page.reload();
    await expect(sentenceIn(page, manual, 2)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("locate-unmatched")).toHaveCount(0);
    await expect(page.getByTestId("revision-missing")).toHaveCount(0);
  });

  test("a commit that another window's change of the current text overtook is named in the address", async ({ page }) => {
    await installMockBackend(page);
    const state = speakersRequests(page);
    // Right after the commit, another window makes the ASR original current again.
    state.afterCommit = (current) => {
      current.primary = SPEAKERS_REVISION;
    };
    await openLecture(page);
    const before = await scrollReader(page, 0.4);
    const top = topSentence(before);
    expect(await startEditing(page)).toBe("settled");
    await typeInto(page, indexOf(weakTarget(before).id), "改");
    await page.getByTestId("draft-commit").click();

    const manual = manualRevisionId(1);
    expect(await returnOutcome(page, manual)).toBe("exact");
    expect(params(page).get("revision")).toBe(manual);
    await expectStaysAt(page, segmentId(manual, indexOf(top.id)), top.offset);
    await page.reload();
    await expect(readerRoot(page, manual)).toBeVisible();
    await expect(page.getByTestId("revision-missing")).toHaveCount(0);
  });

  test("two commits in a row: the second folds the first manual revision away, and selection and return follow both", async ({ page }) => {
    await installMockBackend(page);
    const state = speakersRequests(page);
    await openLecture(page);
    const first = await scrollReader(page, 0.3);
    const clicked = first.sentences.at(-3);
    if (clicked === undefined) throw new Error("no sentence on screen");
    await reader(page).locator(`[data-segment-id="${clicked.id}"]`).click();
    const index = indexOf(clicked.id);
    const screen1 = await settledScreen(page);

    expect(await startEditing(page)).toBe("settled");
    await typeInto(page, index, "一");
    await page.getByTestId("draft-commit").click();
    const manual1 = manualRevisionId(1);
    expect(await returnOutcome(page, manual1)).toBe("exact");
    await expectStaysAt(page, segmentId(manual1, indexOf(topSentence(screen1).id)), topSentence(screen1).offset);
    expect(params(page).get("segment")).toBe(segmentId(manual1, index));

    const screen2 = await settledScreen(page);
    expect(await startEditing(page)).toBe("settled");
    expect((await editorFocus(page)).index).toBe(index);
    await typeInto(page, index, "二");
    await page.getByTestId("draft-commit").click();
    const manual2 = manualRevisionId(2);
    expect(await returnOutcome(page, manual2)).toBe("exact");
    await expectStaysAt(page, segmentId(manual2, indexOf(topSentence(screen2).id)), topSentence(screen2).offset);
    expect(state.manual.map((item) => item.id)).toEqual([manual2]);
    expect(state.manual[0]?.parentRevisionId).toBe(SPEAKERS_REVISION);
    await expect(page.getByTestId("transcript-version").locator(`option[value="${manual1}"]`)).toHaveCount(0);
    expect(params(page).has("revision")).toBe(false);
    expect(params(page).get("segment")).toBe(segmentId(manual2, index));
    await expect(sentenceIn(page, manual2, index)).toHaveAttribute("aria-current", "true");
    await expect(sentenceIn(page, manual2, index)).toContainText("二一");

    await page.reload();
    await expect(sentenceIn(page, manual2, index)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("locate-unmatched")).toHaveCount(0);
  });

  test("when the revision list cannot be read after 完成, an error with 重试 shows instead of the old text, and 重试 finishes the return", async ({ page }) => {
    await installMockBackend(page);
    const state = speakersRequests(page);
    await openLecture(page);
    const before = await scrollReader(page, 0.5);
    const top = topSentence(before);
    expect(await startEditing(page)).toBe("settled");
    await typeInto(page, indexOf(weakTarget(before).id), "改");
    state.afterCommit = (current) => {
      current.failRevisionList = true;
    };
    await page.getByTestId("draft-commit").click();

    await expect(page.getByTestId("transcript-return-retry")).toBeVisible();
    await expect(page.getByTestId("transcript-return-failed")).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
    state.failRevisionList = false;
    await page.getByTestId("transcript-return-retry").click();

    const manual = manualRevisionId(1);
    expect(await returnOutcome(page, manual)).toBe("exact");
    await expectStaysAt(page, segmentId(manual, indexOf(top.id)), top.offset);
    expect(params(page).has("revision")).toBe(false);
  });

  test("「只看」 one speaker: a kept sentence comes back exactly, the filter stays", async ({ page }) => {
    await installMockBackend(page);
    await openLecture(page, `&speaker=${SPEAKER_TEACHER}`);
    await expect(page.getByTestId("speaker-filter-bar")).toBeVisible();
    const before = await scrollReader(page, 0.5);
    const top = topSentence(before);
    // Only the teacher's sentences (even indexes) are shown.
    expect(indexOf(top.id) % 2).toBe(0);
    expect(await startEditing(page)).toBe("settled");
    await typeInto(page, indexOf(weakTarget(before).id), "改");
    await page.getByTestId("draft-commit").click();

    const manual = manualRevisionId(1);
    expect(await returnOutcome(page, manual)).toBe("exact");
    await expectStaysAt(page, segmentId(manual, indexOf(top.id)), top.offset);
    expect(params(page).getAll("speaker")).toEqual([SPEAKER_TEACHER]);
    await expect(page.getByTestId("speaker-filter-bar")).toBeVisible();
  });

  test("「只看」 one speaker: a top sentence the edit gave to a hidden speaker gives way to the nearest shown one", async ({ page }) => {
    await installMockBackend(page);
    await openLecture(page, `&speaker=${SPEAKER_TEACHER}`);
    const before = await scrollReader(page, 0.5);
    const top = topSentence(before);
    const index = indexOf(top.id);
    expect(await startEditing(page)).toBe("settled");
    // The student (speaker 2) now says the top sentence: the filter hides it in the new revision.
    const lead = rows(page).locator(`:scope > [data-sentence-index="${index}"]`).getByTestId("speaker-lead");
    await lead.focus();
    await page.keyboard.press("2");
    await expect(lead).toHaveAttribute("aria-label", /发言人 2/);
    await page.getByTestId("draft-commit").click();

    const manual = manualRevisionId(1);
    expect(await returnOutcome(page, manual)).toBe("approximate");
    await expect(sentenceIn(page, manual, index)).toHaveCount(0);
    // The shown sentences nearest in time are the teacher's two around it, equally far: the earlier one takes its place.
    await expectStaysAt(page, segmentId(manual, index - 2), top.offset);
    expect(params(page).getAll("speaker")).toEqual([SPEAKER_TEACHER]);
    await expect(page.getByTestId("speaker-filter-bar")).toBeVisible();
  });

  test("a chapter picked from the outline while the reader is still being brought back wins", async ({ page }) => {
    await installMockBackend(page);
    await openLecture(page);
    const before = await scrollReader(page, 0.1);
    expect(await startEditing(page)).toBe("settled");
    await typeInto(page, indexOf(weakTarget(before).id), "改");
    await holdFrames(page);
    await page.getByTestId("draft-commit").click();
    const manual = manualRevisionId(1);
    await expect(readerRoot(page, manual)).toBeVisible();
    await expect(readerRoot(page, manual)).not.toHaveAttribute(RESTORE_ATTRIBUTE, /.*/);
    await page.getByTestId("chapter-outline").click();
    await page.getByTestId("chapter-outline-item").nth(2).click();
    await expect(readerRoot(page, manual)).toHaveAttribute(RESTORE_ATTRIBUTE, "cancelled");
    await releaseFrames(page);
    // The third chapter heading is at the top of the reader (below the list's top padding) and stays there.
    const heading = reader(page).locator("[data-row-key]", { hasText: CHAPTERS[2]?.title ?? "" });
    const headingTop = (): Promise<number> => heading.evaluate((row) => row.getBoundingClientRect().top - (row.closest('[data-testid="transcript-reader"]') as Element).getBoundingClientRect().top);
    await settledScreen(page);
    const landed = await headingTop();
    expect(landed).toBeGreaterThanOrEqual(-PLACE_TOLERANCE_PX);
    expect(landed).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    await page.waitForTimeout(500);
    expect(Math.abs((await headingTop()) - landed)).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
  });

  test("the topmost sentence deleted in the editor: 完成 lands on its neighbour, approximately", async ({ page }) => {
    await installMockBackend(page);
    await openLecture(page);
    const before = await scrollReader(page, 0.5);
    const top = topSentence(before);
    const index = indexOf(top.id);
    expect(await startEditing(page)).toBe("settled");
    // Left with nothing but a filler, the sentence is deleted whole from the filler panel.
    await rows(page).locator(`:scope > [data-sentence-index="${index}"] textarea`).fill("嗯。");
    await page.getByTestId("editor-find-toggle").click();
    await page.getByTestId("find-mode-filler").click();
    await page.getByTestId("filler-whole").check();
    await page.getByTestId("filler-review").click();
    await page.getByTestId("filler-apply").click();
    await expect(rows(page).locator(":scope > [data-sentence-index]")).toHaveCount(COUNT - 1);
    await page.getByTestId("draft-commit").click();

    const manual = manualRevisionId(1);
    expect(await returnOutcome(page, manual)).toBe("approximate");
    const speakers = speakersRequests(page);
    expect(speakers.manual[0]?.segments).toHaveLength(COUNT - 1);
    // Its neighbours start equally far from it; the earlier one takes its place, at its height.
    await expectStaysAt(page, segmentId(manual, index - 1), top.offset);
  });

  /** Opens the lecture in the middle, enters the editor and leaves it with the reader's return held in progress. */
  async function exitWithReturnHeld(page: Page, query = ""): Promise<void> {
    await installMockBackend(page);
    await openLecture(page, query);
    await scrollReader(page, 0.5);
    expect(await startEditing(page)).toBe("settled");
    await holdFrames(page);
    await page.getByTestId("draft-exit").click();
    await expect(readerRoot(page, SPEAKERS_REVISION)).toBeVisible();
    await expect(readerRoot(page, SPEAKERS_REVISION)).not.toHaveAttribute(RESTORE_ATTRIBUTE, /.*/);
  }

  /** The scroll position, and its maximum, of the reader. */
  const scrollOf = (page: Page): Promise<{ top: number; max: number }> =>
    reader(page).evaluate((scroller) => ({ top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight }));

  test("the wheel in the reader during the return ends it where the wheel took the view", async ({ page }) => {
    await exitWithReturnHeld(page);
    const start = await readScreen(page);
    const box = await reader(page).boundingBox();
    if (box === null) throw new Error("no reader");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    expect(await returnOutcome(page, SPEAKERS_REVISION)).toBe("cancelled");
    await page.waitForTimeout(500);
    const wheeled = await readScreen(page);
    expect(wheeled.row?.key).not.toBe(start.row?.key);
    await releaseFrames(page);
    expectSameRow(await settledScreen(page), wheeled);
    await page.waitForTimeout(500);
    expectSameRow(await settledScreen(page), wheeled);
  });

  test("a key pressed in the reader during the return ends it where the key took the view", async ({ page }) => {
    await exitWithReturnHeld(page);
    const start = await scrollOf(page);
    await reader(page).focus();
    expect(await reader(page).evaluate((scroller) => scroller === document.activeElement)).toBe(true);
    await page.keyboard.press("PageDown");
    expect(await returnOutcome(page, SPEAKERS_REVISION)).toBe("cancelled");
    await page.waitForTimeout(500);
    const paged = await readScreen(page);
    expect((await scrollOf(page)).top).toBeGreaterThan(start.top + 100);
    await releaseFrames(page);
    expectSameRow(await settledScreen(page), paged);
  });

  test("回到原文 from a gap of 「只看」 during the return ends it at the skipped sentence", async ({ page }) => {
    await exitWithReturnHeld(page, `&speaker=${SPEAKER_TEACHER}`);
    // A gap bar on screen, and the sentence it skipped: the one after the teacher's sentence above it.
    const view = await reader(page).boundingBox();
    if (view === null) throw new Error("no reader");
    const gaps = reader(page).getByTestId("speaker-gap");
    let skipped: number | undefined;
    let chosen: Locator | undefined;
    for (let at = 0; at < (await gaps.count()) && chosen === undefined; at += 1) {
      const gap = gaps.nth(at);
      const box = await gap.boundingBox();
      if (box === null || box.y < view.y + 40 || box.y + box.height > view.y + view.height - 80) continue;
      const before = await gap.evaluate((element) => {
        const ids = Array.from(element.closest("[data-row-key]")?.previousElementSibling?.querySelectorAll("[data-segment-id]") ?? []);
        return ids.at(-1)?.getAttribute("data-segment-id") ?? "";
      });
      skipped = indexOf(before) + 1;
      chosen = gap;
    }
    if (chosen === undefined || skipped === undefined) throw new Error("no gap bar on screen");
    await chosen.getByRole("button").click();
    expect(await returnOutcome(page, SPEAKERS_REVISION)).toBe("cancelled");
    await releaseFrames(page);
    await settledScreen(page);
    expect(params(page).getAll("speaker")).toEqual([]);
    // Its row (the turn, header included) is put at the top.
    const rowTop = (): Promise<number> =>
      sentenceIn(page, SPEAKERS_REVISION, skipped as number).evaluate((element) => {
        const row = element.closest("[data-row-key]") as Element;
        return row.getBoundingClientRect().top - (row.closest('[data-testid="transcript-reader"]') as Element).getBoundingClientRect().top;
      });
    const landed = await rowTop();
    expect(landed).toBeGreaterThanOrEqual(-PLACE_TOLERANCE_PX);
    expect(landed).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    await page.waitForTimeout(500);
    expect(Math.abs((await rowTop()) - landed)).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
  });

  for (const [button, edge] of [
    ["reader-to-top", "top"],
    ["reader-to-bottom", "bottom"],
  ] as const) {
    test(`the ${edge} jump button during the return ends it at the ${edge} of the text`, async ({ page }) => {
      await exitWithReturnHeld(page);
      await page.getByTestId(button).click();
      expect(await returnOutcome(page, SPEAKERS_REVISION)).toBe("cancelled");
      await releaseFrames(page);
      await settledScreen(page);
      const at = await scrollOf(page);
      if (edge === "top") expect(at.top).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
      else expect(at.top).toBeGreaterThanOrEqual(at.max - PLACE_TOLERANCE_PX);
      await page.waitForTimeout(500);
      expect(Math.abs((await scrollOf(page)).top - at.top)).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
    });
  }

  test("after coming back, a click on a sentence centres it as before", async ({ page }) => {
    await installMockBackend(page);
    await openLecture(page);
    await scrollReader(page, 0.5);
    await page.getByTestId("transcript-edit").click();
    await expect(rows(page)).toBeVisible();
    await page.getByTestId("draft-exit").click();
    await expect(reader(page)).toBeVisible();
    // Whatever the return does, it has finished by now.
    await page.waitForTimeout(800);
    const screen = await settledScreen(page);
    const low = [...screen.sentences].reverse().find((sentence) => sentence.firstLineFullyVisible);
    if (low === undefined) throw new Error("no sentence on screen");
    await reader(page).locator(`[data-segment-id="${low.id}"]`).click();
    await settledScreen(page);
    const centre = await reader(page).evaluate((scroller, id) => {
      const element = Array.from(scroller.querySelectorAll("[data-segment-id]")).find((candidate) => candidate.getAttribute("data-segment-id") === id);
      const row = element?.closest("[data-row-key]");
      const view = scroller.getBoundingClientRect();
      const box = row?.getBoundingClientRect();
      return box === undefined ? Number.NaN : box.top + box.height / 2 - (view.top + view.height / 2);
    }, low.id);
    // The list's top padding sits outside the windowed rows' own positions.
    expect(Math.abs(centre)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
  });
});

test("「只看」 a speaker the commit leaves with no sentence: the filter and its empty state stay, and clearing it brings the reader back once", async ({ page }) => {
  await installMockBackend(page);
  await open(page, `&speaker=${SPEAKER_STUDENT}`);
  // The student says only the third sentence of the default lecture.
  const before = await settledScreen(page);
  expect(before.sentences.map((sentence) => indexOf(sentence.id))).toEqual([2]);
  expect(await startEditing(page)).toMatch(/^(settled|edge)$/);
  const lead = rows(page).locator(':scope > [data-sentence-index="2"]').getByTestId("speaker-lead");
  await lead.focus();
  await page.keyboard.press("1");
  await expect(lead).toHaveAttribute("aria-label", /林老师/);
  await page.getByTestId("draft-commit").click();

  const manual = manualRevisionId(1);
  await expect(page.getByTestId("speaker-filter-empty")).toBeVisible();
  expect(params(page).getAll("speaker")).toEqual([SPEAKER_STUDENT]);
  await expect(readerRoot(page, manual)).not.toHaveAttribute(RESTORE_ATTRIBUTE, /.*/);
  await page.getByTestId("speaker-filter-empty-clear").click();
  expect(await returnOutcome(page, manual)).toBe("exact");
  await expectStaysAt(page, segmentId(manual, 2), topSentence(before).offset);
});

test.describe("a local video", () => {
  const LOCAL_REVISION = "01J0000000000000000000REV3";
  /** Inside the sixth sentence (10 s each), away from the second, which is clicked first. */
  const PLAYING_S = 55;

  async function openLocal(page: Page): Promise<Locator> {
    await installMockBackend(page, { mode: "server" });
    await page.goto(`/contents/${LOCAL_CONTENT}?tab=transcript`);
    const video = page.getByTestId("player-local").locator("video");
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
    await expect(sentenceIn(page, LOCAL_REVISION, 1)).toBeVisible();
    // A click selects the second sentence and seeks there; playback then moves on to the sixth.
    await sentenceIn(page, LOCAL_REVISION, 1).click();
    await video.evaluate(async (element: HTMLVideoElement, seconds) => {
      element.pause();
      element.currentTime = seconds;
      await new Promise((resolve) => element.addEventListener("seeked", resolve, { once: true }));
    }, PLAYING_S);
    await expect(page.getByTestId("current-sentence")).toHaveAttribute("data-segment-id", segmentId(LOCAL_REVISION, 5));
    return video;
  }

  test("the playing sentence, not the clicked one, is the one the editor opens on, with the cursor in it", async ({ page }) => {
    await openLocal(page);
    const before = await settledScreen(page);
    const playing = before.sentences.find((sentence) => sentence.id === segmentId(LOCAL_REVISION, 5));
    expect(playing).toBeDefined();
    expect(await startEditing(page)).toMatch(/^(settled|edge)$/);
    expect(await editorFocus(page)).toEqual({ index: 5, start: 0, end: 0 });
    await expectEditorRowAt(page, 5, playing?.offset ?? Number.NaN);
  });

  test("the play position is the same before 编辑, in the editor and after 退出", async ({ page }) => {
    const video = await openLocal(page);
    const time = (): Promise<number> => video.evaluate((element: HTMLVideoElement) => element.currentTime);
    const at = await time();
    expect(at).toBe(PLAYING_S);
    await page.getByTestId("transcript-edit").click();
    await expect(rows(page)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await time()).toBe(at);
    await page.getByTestId("draft-exit").click();
    await expect(reader(page)).toBeVisible();
    await page.waitForTimeout(500);
    expect(await time()).toBe(at);
    await expect(page.getByTestId("current-sentence")).toHaveAttribute("data-segment-id", segmentId(LOCAL_REVISION, 5));
  });
});
