import { expect, test, type Locator, type Page } from "@playwright/test";
import { CHAT_MESSAGE_MAX_CHARS, NOTE_SPAN_MAX_SEGMENTS } from "../../src/shared/defaults.ts";
import { noteDtoSchema, noteListDtoSchema, type NoteDto } from "../../src/shared/dto/note.ts";
import { READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey, type ReaderTypography } from "../../src/shared/reader-typography.ts";
import { readingSeparator } from "../../src/shared/reading.ts";
import { installMockBackend, segmentId } from "./mock-backend.ts";
import {
  SPEAKER_SEQUENCE,
  SPEAKER_STUDENT,
  SPEAKER_TEACHER,
  SPEAKERS_CONTENT,
  SPEAKERS_EARLIER_REVISION,
  SPEAKERS_REVISION,
  speakerSentence,
  speakersRequests,
  speakerStartMs,
  type SpeakerSequence,
} from "./mock-speakers.ts";

/*
 * Selections in the transcript reading view, made with a real mouse and keyboard: what 「解释」,
 * the toolbar's 「复制」, the context menu's 「复制选中内容」 and Ctrl+C take from them, how a
 * selection lives on while the windowed list scrolls and re-lays out, and when it ends. Long
 * texts window their rows from 150 rows on, so the rows between the two ends of a long
 * selection are not in the page; every text a selection yields must still hold all of them.
 */

// A missing button or menu row fails the test promptly instead of waiting out its whole timeout.
test.use({ actionTimeout: 10_000 });
// Long lectures are scrolled with the wheel, a notch at a time.
test.describe.configure({ timeout: 90_000 });

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
/** The width the content page remembers for its output column, set before the page loads. */
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
/** One CSS pixel: box edges snap to the device grid. */
const SNAP_PX = 1;
/** The rows a list holds before it starts windowing them. */
const WINDOWED_FROM_ROWS = 150;
/** What the chat input reads after 「解释」, around the selected text. */
const EXPLAIN_PREFIX = "解释一下「";
const EXPLAIN_SUFFIX = "」";
/** What a filter gap reads in an explained text. */
const SKIPPED_MARKER = "（略过未显示的内容）";
/** Why the note buttons refuse a selection that spans text the filter hides. */
const CROSSES_GAP_REASON = "选区包含未显示的原文，请显示完整原文后再建笔记";
const TOO_LONG_REASON = `一条笔记最多跨 ${NOTE_SPAN_MAX_SEGMENTS} 句`;
/** The rows a selection offers in the context menu, in order. */
const SELECTION_ITEMS = ["context-menu-item-copy-selection", "context-menu-item-explain-selection"];
const SENTENCE_ITEMS = ["context-menu-item-play-from-here", "context-menu-item-copy-sentence", "context-menu-item-copy-sentence-with-time", "context-menu-item-copy-sentence-with-speaker"];
/** Two chapters around the student's question in the default lecture. */
const CHAPTERS = [
  { start: 0, title: "开场白" },
  { start: 2, title: "学生提问" },
];
/** English in the teacher's second turn, with an emoji, so joins between Latin sentences show. */
const ENGLISH = { 3: "Third sentence in English.", 4: "Fourth one follows 😀 here." };

const sid = (index: number): string => segmentId(SPEAKERS_REVISION, index);
const reader = (page: Page): Locator => page.getByTestId("transcript-reader");
const sentence = (page: Page, index: number): Locator => reader(page).locator(`[data-segment-id="${sid(index)}"]`);
const toolbar = (page: Page): Locator => page.getByTestId("selection-toolbar");
const chatInput = (page: Page): Locator => page.getByTestId("chat-panel").getByTestId("chat-input");
/** Turns that alternate every sentence, so each sentence is a row of its own. */
const alternating = (count: number, from = 0): string[] => Array.from({ length: count }, (_, index) => ((index + from) % 2 === 0 ? SPEAKER_TEACHER : SPEAKER_STUDENT));
/** The text of a sentence of the speakers lecture in this browser context. */
const textOf = (page: Page, index: number): string => speakersRequests(page).texts[index] ?? speakerSentence(index);
/** Whitespace carries no meaning where a comparison squeezes it out. */
const squeeze = (text: string): string => text.replace(/\s+/gu, "");
/** A sentence long enough to end a paragraph on its own (paragraphs close after 200 characters at a sentence end). */
const longSentence = (index: number): string => `${speakerSentence(index)}${"这一段讲解很长，用来让同一轮的这一段占满好几行文字，".repeat(9)}到此为止。`;

/** `h:mm:ss` from an hour on, `m:ss` below: how the reader writes a media time, written out here independently. */
function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Opens the reader with the stored typography and output column width; the first sentence is drawn when it returns. */
async function open(page: Page, options: { typography?: Partial<ReaderTypography>; outputsWidth?: number; query?: string } = {}): Promise<void> {
  const url = `${READER}${options.query ?? ""}`;
  if (!page.url().startsWith("http")) await page.goto(url);
  const typography = { ...READER_TYPOGRAPHY_DEFAULTS, ...options.typography };
  await page.evaluate(
    ([key, value, widthKey, width]) => {
      localStorage.setItem(key, value);
      if (width === "") localStorage.removeItem(widthKey);
      else localStorage.setItem(widthKey, width);
    },
    [readerTypographyKey("local"), JSON.stringify(typography), OUTPUTS_WIDTH_KEY, options.outputsWidth === undefined ? "" : String(options.outputsWidth)] as const,
  );
  await page.goto(url);
  await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
}

/** The output column width that gives the reading pane `pane` px, found from one measurement. */
async function outputsFor(page: Page, pane: number): Promise<number> {
  await open(page, { outputsWidth: 900 });
  const measured = await reader(page).evaluate((element) => element.getBoundingClientRect().width);
  return pane + (900 - measured);
}

/** Opens a long lecture of one-sentence turns on sentence `at`. */
async function openLong(page: Page, at: number, count = 3000): Promise<void> {
  speakersRequests(page).sequence = alternating(count);
  await open(page, { outputsWidth: 900, query: `&segment=${sid(at)}` });
  await expect(sentence(page, at)).toBeVisible();
  // Windowed: the rows near the top are not mounted.
  await expect(sentence(page, 0)).toHaveCount(0);
}

interface Point {
  x: number;
  y: number;
}

/** The box of the character at `offset` of a sentence, counting its text nodes in order. */
async function charBox(page: Page, index: number, offset: number): Promise<{ left: number; right: number; top: number; bottom: number }> {
  const box = await page.evaluate(
    ([id, at]) => {
      const element = document.querySelector(`[data-testid="transcript-reader"] [data-segment-id="${id}"]`);
      if (element === null) return null;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
        if (at < seen + node.data.length) {
          const range = document.createRange();
          range.setStart(node, at - seen);
          range.setEnd(node, at - seen + 1);
          const rect = range.getClientRects()[0];
          return rect === undefined ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }
        seen += node.data.length;
      }
      return null;
    },
    [sid(index), offset] as const,
  );
  if (box === null) throw new Error(`no character ${offset} in sentence ${index}`);
  return box;
}

/**
 * The viewport point of a character boundary inside a sentence: `before` the character at
 * `offset`, or `after` the one ending at it.
 */
async function boundaryPoint(page: Page, index: number, offset: number, side: "before" | "after"): Promise<Point> {
  const box = await charBox(page, index, side === "before" ? offset : offset - 1);
  return { x: side === "before" ? box.left + 1 : box.right - 1, y: (box.top + box.bottom) / 2 };
}

/** The viewport point before (or after) the character at `offset` of a chapter title. */
async function titlePoint(page: Page, title: string, offset: number, side: "before" | "after"): Promise<Point> {
  const point = await reader(page)
    .getByTestId("chapter-title")
    .filter({ hasText: title })
    .evaluate(
      (element, [at, edge]) => {
        const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() as Text;
        const range = document.createRange();
        const index = edge === "before" ? Number(at) : Number(at) - 1;
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const rect = range.getClientRects()[0] as DOMRect;
        return { x: edge === "before" ? rect.left + 1 : rect.right - 1, y: (rect.top + rect.bottom) / 2 };
      },
      [String(offset), side] as const,
    );
  return point;
}

/** Presses at one point, moves to another in steps and releases: a real mouse selection. */
async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** Drags from a character boundary of one sentence to one of another, both in view. */
async function dragSelect(page: Page, from: { index: number; offset: number }, to: { index: number; offset: number }): Promise<void> {
  await drag(page, await boundaryPoint(page, from.index, from.offset, "before"), await boundaryPoint(page, to.index, to.offset, "after"));
}

/** Where a sentence's top edge is, or nothing while its row is not mounted. */
/** Whether a sentence is out of the reader's view: above or below it, or not mounted at all. */
async function outOfView(page: Page, index: number): Promise<boolean> {
  const box = await readerBox(page);
  return sentence(page, index)
    .evaluate((element, [top, bottom]) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom <= Number(top) || rect.top >= Number(bottom);
    }, [box.y, box.y + box.height] as const, { timeout: 200 })
    .catch(() => true);
}

async function topOf(page: Page, index: number): Promise<number | undefined> {
  return sentence(page, index)
    .evaluate((element) => element.getBoundingClientRect().top, undefined, { timeout: 200 })
    .catch(() => undefined);
}

/**
 * Wheels the reader (with the mouse where it is) until sentence `index` sits in the middle band
 * of the reader. The list mounts rows on the scroll events a wheel notch causes, so each notch
 * is given a moment before the next look.
 */
async function wheelTo(page: Page, index: number, direction: 1 | -1, notches = 120): Promise<void> {
  const box = await readerBox(page);
  for (let turn = 0; turn < notches; turn += 1) {
    const top = await topOf(page, index);
    if (top !== undefined && top > box.y + box.height * 0.3 && top < box.y + box.height * 0.6) return;
    const step = top === undefined ? 250 : Math.min(250, Math.max(40, Math.abs(top - (box.y + box.height * 0.45))));
    await page.mouse.wheel(0, direction * step);
    // Wheel scrolling lands asynchronously; the next look needs the rows of the new position.
    await page.waitForTimeout(50);
  }
  throw new Error(`sentence ${index} never reached the middle of the reader`);
}

/**
 * A drag across screens: presses at `press`, starts the gesture, wheels with the button held
 * until the sentence of `release` is in view and lets go there. `release` is before `press` for
 * an upward drag.
 */
async function longDrag(page: Page, press: { index: number; offset: number; side: "before" | "after" }, release: { index: number; offset: number; side: "before" | "after" }): Promise<void> {
  const start = await boundaryPoint(page, press.index, press.offset, press.side);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A user starts dragging before scrolling; the selection gesture begins with this move.
  await page.mouse.move(start.x + 20, start.y, { steps: 3 });
  await wheelTo(page, release.index, release.index > press.index ? 1 : -1);
  const end = await boundaryPoint(page, release.index, release.offset, release.side);
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

/** Moves the mouse over the reader (no button held) and wheels until sentence `index` is in the middle band. */
async function scrollReaderTo(page: Page, index: number, direction: 1 | -1, notches = 300): Promise<void> {
  const box = await readerBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await wheelTo(page, index, direction, notches);
}

/** What the clipboard holds after `action`, both flavours; waits until the action has written it. */
async function copied(page: Page, action: () => Promise<void>): Promise<{ plain: string; html: string | undefined }> {
  const sentinel = "\u2063nothing copied yet";
  await page.evaluate((value) => navigator.clipboard.writeText(value), sentinel);
  await action();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(sentinel);
  return page.evaluate(async () => {
    const out: { plain: string; html: string | undefined } = { plain: "", html: undefined };
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("text/plain")) out.plain = await (await item.getType("text/plain")).text();
      if (item.types.includes("text/html")) out.html = await (await item.getType("text/html")).text();
    }
    return out;
  });
}

const copyByKeys = (page: Page) => copied(page, () => page.keyboard.press("Control+c"));
const copyByToolbar = (page: Page) =>
  copied(page, async () => {
    await toolbar(page).getByTestId("selection-copy").click();
  });
/** Right clicks at `at` and takes 「复制选中内容」. */
const copyByMenu = (page: Page, at: Point) =>
  copied(page, async () => {
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await page.getByTestId("context-menu-item-copy-selection").click();
  });

/** Presses 「解释」 and returns the text the question quotes; the chat input is emptied again afterwards. */
async function explained(page: Page): Promise<string> {
  await expect(toolbar(page)).toBeVisible();
  await toolbar(page).getByTestId("selection-explain").click();
  const input = chatInput(page);
  await expect(input).toHaveValue(/^解释一下「[\s\S]+」$/u);
  const value = await input.inputValue();
  await input.fill("");
  return value.slice(EXPLAIN_PREFIX.length, -EXPLAIN_SUFFIX.length);
}

/** The context menu's rows by test id, once it is open. */
async function menuItems(page: Page): Promise<string[]> {
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  return menu.locator("[data-testid^='context-menu-item-']").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid") ?? ""));
}

/** The browser's own selected text. */
const browserText = (page: Page): Promise<string> => page.evaluate(() => window.getSelection()?.toString() ?? "");
/** The toolbar's selection version, a number that changes only with the selected range. */
const selectionVersion = (page: Page): Promise<string | null> => toolbar(page).getAttribute("data-selection-version");

/** The key of the row holding a sentence, while it is mounted. */
const rowKeyOf = (page: Page, index: number): Promise<string | null> => sentence(page, index).evaluate((element) => element.closest("[data-row-key]")?.getAttribute("data-row-key") ?? null);
const rowWithKey = (page: Page, key: string): Locator => reader(page).locator(`[data-row-key="${key}"]`);
/** Scrolls the reader to its very top or bottom and waits for the rows there. */
async function scrollToEnd(page: Page, end: "top" | "bottom", edgeSentence: number): Promise<void> {
  // A windowed list grows as it measures the rows it reaches, so the end is set again until its last row is there.
  await expect
    .poll(async () => {
      await reader(page).evaluate((element, where) => {
        element.scrollTop = where === "top" ? 0 : element.scrollHeight;
      }, end);
      return sentence(page, edgeSentence).count();
    })
    .toBe(1);
}

/** Every one of `parts` occurs in `text`, in this order and without overlapping. */
function expectInOrder(text: string, parts: readonly string[]): void {
  let from = 0;
  for (const [index, part] of parts.entries()) {
    const at = text.indexOf(part, from);
    expect(at, `part ${index} ${JSON.stringify(part.slice(0, 40))} after ${from}`).toBeGreaterThanOrEqual(0);
    from = at + part.length;
  }
}

/** The selected piece of each sentence from `first`/`firstOffset` to `last`/`lastOffset` (exclusive). */
function pieces(page: Page, first: number, firstOffset: number, last: number, lastOffset: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, step) => first + step).map((index) => {
    const text = textOf(page, index);
    if (index === first && index === last) return text.slice(firstOffset, lastOffset);
    if (index === first) return text.slice(firstOffset);
    if (index === last) return text.slice(0, lastOffset);
    return text;
  });
}

/** 「解释」's text for a run of sentences: their selected pieces joined as running text. */
function explainOfSentences(page: Page, first: number, firstOffset: number, last: number, lastOffset: number): string {
  return pieces(page, first, firstOffset, last, lastOffset).reduce(
    (joined, piece, step) => (step === 0 ? piece : `${joined}${readingSeparator(textOf(page, first + step - 1), textOf(page, first + step), false)}${piece}`),
    "",
  );
}

/** The copied text of a run of one-sentence turns of the alternating lecture: the browser's format of turn headers and paragraph times. */
function copyOfAlternating(page: Page, first: number, firstOffset: number, last: number, lastOffset: number): string {
  const parts = pieces(page, first, firstOffset, last, lastOffset);
  return parts.reduce((joined, piece, step) => {
    if (step === 0) return piece;
    const index = first + step;
    const name = index % 2 === 0 ? "林老师" : "发言人 2";
    return `${joined}\n\n\n${name}\n${clock(speakerStartMs(speakersRequests(page), index))}${piece}`;
  }, "");
}

/** Whether a string holds half of a surrogate pair on its own. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * Notes on the speakers lecture, answered in the spec: the shared fake keeps notes for its own
 * lectures only. A note is placed exactly on the sentences it covers.
 */
async function routeSpeakerNotes(page: Page): Promise<{ posts: unknown[] }> {
  const posts: unknown[] = [];
  const notes: NoteDto[] = [];
  const indexOf = (id: string): number => Number(id.slice(-4));
  await page.route(`**/api/contents/${SPEAKERS_CONTENT}/notes*`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { startSegmentId: string; startOffset: number; endSegmentId: string; endOffset: number; mark: string; color: string };
      posts.push(body);
      const note = noteDtoSchema.parse({
        id: `01J00000000000000000SPN${String(notes.length + 1).padStart(3, "0")}`,
        contentId: SPEAKERS_CONTENT,
        contentTitle: "",
        transcriptRevisionId: SPEAKERS_REVISION,
        startSegmentId: body.startSegmentId,
        startOffset: body.startOffset,
        endSegmentId: body.endSegmentId,
        endOffset: body.endOffset,
        startMs: speakerStartMs(speakersRequests(page), indexOf(body.startSegmentId)),
        quote: "",
        mark: body.mark,
        color: body.color,
        createdAt: 1_790_000_000_000 + notes.length,
        updatedAt: 1_790_000_000_000 + notes.length,
      });
      notes.push(note);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(note) });
    }
    const revision = new URL(request.url()).searchParams.get("revision");
    const items = notes.map((note) => {
      if (revision === null) return note;
      const first = indexOf(note.startSegmentId);
      const last = indexOf(note.endSegmentId);
      const segments = Array.from({ length: last - first + 1 }, (_, step) => first + step).map((index) => ({
        segmentId: sid(index),
        startOffset: index === first ? note.startOffset : 0,
        endOffset: index === last ? note.endOffset : textOf(page, index).length,
      }));
      return { ...note, view: { exact: true, segments } };
    });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(noteListDtoSchema.parse({ items })) });
  });
  return { posts };
}

/** The reader's box in the viewport. */
async function readerBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await reader(page).boundingBox();
  if (box === null) throw new Error("reader not laid out");
  return box;
}

/** Every way the toolbar sticks out of the reader's box. */
async function toolbarOutside(page: Page): Promise<string[]> {
  const bar = await toolbar(page).boundingBox();
  const box = await readerBox(page);
  if (bar === null) return ["no toolbar"];
  const problems: string[] = [];
  if (bar.x < box.x - SNAP_PX) problems.push(`left ${bar.x} < ${box.x}`);
  if (bar.y < box.y - SNAP_PX) problems.push(`top ${bar.y} < ${box.y}`);
  if (bar.x + bar.width > box.x + box.width + SNAP_PX) problems.push(`right ${bar.x + bar.width} > ${box.x + box.width}`);
  if (bar.y + bar.height > box.y + box.height + SNAP_PX) problems.push(`bottom ${bar.y + bar.height} > ${box.y + box.height}`);
  return problems;
}

test.describe("reader selection: a long text is complete", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  const FIRST = 1500;
  const LAST = FIRST + 40;

  test("a downward drag over 40 rows: 「解释」 holds every selected sentence in order, without names or times", async ({ page }) => {
    await installMockBackend(page);
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: LAST, offset: 4, side: "after" });
    // The rows next to the start have been windowed away.
    await expect(sentence(page, FIRST + 1)).toHaveCount(0);
    expect(await explained(page)).toBe(explainOfSentences(page, FIRST, 2, LAST, 4));
  });

  test("a downward drag over 40 rows: 复制, 复制选中内容 and Ctrl+C give the same complete text without surrounding whitespace", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: LAST, offset: 4, side: "after" });
    await expect(sentence(page, FIRST + 1)).toHaveCount(0);
    const expected = copyOfAlternating(page, FIRST, 2, LAST, 4);
    expect((await copyByKeys(page)).plain).toBe(expected);
    expect((await copyByToolbar(page)).plain).toBe(expected);
    expect((await copyByMenu(page, await boundaryPoint(page, LAST, 1, "before"))).plain).toBe(expected);
  });

  test("an upward drag over 40 rows yields the same complete texts as a downward one", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await openLong(page, LAST);
    await longDrag(page, { index: LAST, offset: 4, side: "after" }, { index: FIRST, offset: 2, side: "before" });
    await expect(sentence(page, LAST - 1)).toHaveCount(0);
    const expected = copyOfAlternating(page, FIRST, 2, LAST, 4);
    expect((await copyByKeys(page)).plain).toBe(expected);
    expect((await copyByToolbar(page)).plain).toBe(expected);
    expect((await copyByMenu(page, await boundaryPoint(page, FIRST, 3, "before"))).plain).toBe(expected);
    await scrollReaderTo(page, LAST, 1);
    await longDrag(page, { index: LAST, offset: 4, side: "after" }, { index: FIRST, offset: 2, side: "before" });
    expect(await explained(page)).toBe(explainOfSentences(page, FIRST, 2, LAST, 4));
  });

  test("a click and a Shift+click a few screens further select everything between them", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await openLong(page, FIRST);
    const shiftSelect = async (): Promise<void> => {
      const start = await boundaryPoint(page, FIRST, 2, "before");
      await page.mouse.click(start.x, start.y);
      await scrollReaderTo(page, LAST, 1);
      await expect(sentence(page, FIRST + 1)).toHaveCount(0);
      const end = await boundaryPoint(page, LAST, 4, "after");
      await page.keyboard.down("Shift");
      await page.mouse.click(end.x, end.y);
      await page.keyboard.up("Shift");
    };
    await shiftSelect();
    expect((await copyByKeys(page)).plain).toBe(copyOfAlternating(page, FIRST, 2, LAST, 4));
    // 「解释」 ends the selection: a click inside a selection would only clear it, leaving nothing to extend from.
    expect(await explained(page)).toBe(explainOfSentences(page, FIRST, 2, LAST, 4));
    await scrollReaderTo(page, FIRST, -1);
    await shiftSelect();
    expect((await copyByToolbar(page)).plain).toBe(copyOfAlternating(page, FIRST, 2, LAST, 4));
  });

  test("the hint counts the sentences when an end of the selection is out of view, and stays away for a short one", async ({ page }) => {
    await installMockBackend(page);
    await openLong(page, FIRST);
    // The short selection lies clear of where the long drag starts: a press inside a selection drags its text instead of selecting.
    await dragSelect(page, { index: FIRST + 2, offset: 2 }, { index: FIRST + 3, offset: 4 });
    await expect(toolbar(page)).toBeVisible();
    await expect(toolbar(page).getByTestId("selection-count")).toBeHidden();
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: LAST, offset: 4, side: "after" });
    await expect(toolbar(page).getByTestId("selection-count")).toHaveText(`已选 ${LAST - FIRST + 1} 句`);
  });
});

/** The lecture a same-rows comparison opens: the rows under test, then filler turns up to a row count. */
interface Variant {
  sequence: SpeakerSequence;
  texts?: Record<number, string>;
  chapters?: ReadonlyArray<{ start: number; title: string }>;
  paragraphStarts?: ReadonlySet<number>;
  typography?: Partial<ReaderTypography>;
  /** Extra query of the reader's address (a speaker filter). */
  query?: string;
  /** The reading pane's width; absent = 900 px. */
  pane?: number;
  /** Where the drag starts: inside a sentence, or before the time of the paragraph a sentence opens. */
  start: { index: number; offset: number } | { beforeTimeOf: number };
}

/** How far into the filler the selection ends: far enough that a windowed list unmounts rows between the ends. */
const FILLER_END = 40;

/** The point left of a paragraph's time, at the height of its first line. */
async function beforeTime(page: Page, index: number): Promise<Point> {
  return reader(page)
    .locator("p[data-reader-text]", { has: page.locator(`[data-segment-id="${sid(index)}"]`) })
    .locator("button[data-reading-time]")
    .evaluate((time) => {
      const box = time.getBoundingClientRect();
      return { x: box.left - 4, y: (box.top + box.bottom) / 2 };
    });
}

/** The data-row-index of the row holding a sentence. */
const rowIndexOf = (page: Page, index: number): Promise<number> => sentence(page, index).evaluate((element) => Number(element.closest("[data-row-index]")?.getAttribute("data-row-index")));

/**
 * Opens the variant padded to `rows` rows and makes its selection, from its start to inside the
 * sentence `FILLER_END` filler rows on. Returns the end sentence and whether every row between
 * the two ends was mounted when the selection was made.
 */
async function selectVariant(page: Page, variant: Variant, end: number): Promise<{ allMounted: boolean }> {
  await reader(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  const startIndex = "index" in variant.start ? variant.start.index : variant.start.beforeTimeOf;
  await expect(sentence(page, startIndex)).toBeVisible();
  const startRow = await rowIndexOf(page, startIndex);
  const press = "index" in variant.start ? await boundaryPoint(page, variant.start.index, variant.start.offset, "before") : await beforeTime(page, variant.start.beforeTimeOf);
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(press.x + 20, press.y, { steps: 3 });
  await wheelTo(page, end, 1);
  const release = await boundaryPoint(page, end, 4, "after");
  await page.mouse.move(release.x, release.y, { steps: 6 });
  await page.mouse.up();
  const endRow = await rowIndexOf(page, end);
  const mounted = await reader(page).evaluate((element) => [...element.querySelectorAll("[data-row-index]")].map((row) => Number(row.getAttribute("data-row-index"))));
  const between = Array.from({ length: endRow - startRow - 1 }, (_, step) => startRow + 1 + step);
  return { allMounted: between.every((row) => mounted.includes(row)) };
}

/** Builds the lecture's sequence for a variant padded with alternating turns to `rows` rows, given the rows the variant's own sentences take. */
function paddedSequence(variant: Variant, fillerSentences: number): SpeakerSequence {
  const last = variant.sequence.at(-1);
  // The filler alternates starting with the other speaker, so each filler sentence is a row of its own.
  return [...variant.sequence, ...alternating(fillerSentences, last === SPEAKER_TEACHER ? 1 : 0)];
}

/**
 * Makes the same selection over the same rows at the start of a 149-, 150-, 151- and 3000-row
 * lecture. The short one keeps every row mounted; in the windowed ones the selection is long
 * enough (it ends `FILLER_END` rows into the filler, more than a screen and the list's overscan)
 * that rows between its ends are unmounted when it is copied, which the test checks.
 */
async function sameRows(page: Page, variant: Variant): Promise<void> {
  const requests = speakersRequests(page);
  requests.texts = { ...variant.texts };
  if (variant.chapters !== undefined) requests.chapters = variant.chapters;
  if (variant.paragraphStarts !== undefined) requests.paragraphStarts = variant.paragraphStarts;
  const outputsWidth = variant.pane === undefined ? 900 : await outputsFor(page, variant.pane);
  // The rows the variant's own sentences take, measured once with ten filler turns after them.
  requests.sequence = paddedSequence(variant, 10);
  await open(page, { outputsWidth, ...(variant.typography === undefined ? {} : { typography: variant.typography }), ...(variant.query === undefined ? {} : { query: variant.query }) });
  const ownRows = (await reader(page).locator("[data-row-index]").count()) - 10;
  const end = variant.sequence.length + FILLER_END;

  const results: Array<{ rows: number; keys: string; menu: string; toolbar: string; explain: string }> = [];
  for (const rows of [WINDOWED_FROM_ROWS - 1, WINDOWED_FROM_ROWS, WINDOWED_FROM_ROWS + 1, 3000]) {
    requests.sequence = paddedSequence(variant, rows - ownRows);
    await open(page, { outputsWidth, ...(variant.typography === undefined ? {} : { typography: variant.typography }), ...(variant.query === undefined ? {} : { query: variant.query }) });
    const mountedRows = await reader(page).locator("[data-row-index]").count();
    if (rows < WINDOWED_FROM_ROWS) expect(mountedRows, "a short lecture mounts every row").toBe(rows);
    else expect(mountedRows, "a long lecture windows its rows").toBeLessThan(rows);

    const { allMounted } = await selectVariant(page, variant, end);
    expect(allMounted, `${rows} rows: rows between the ends are ${rows < WINDOWED_FROM_ROWS ? "all mounted" : "partly unmounted"}`).toBe(rows < WINDOWED_FROM_ROWS);
    const keys = (await copyByKeys(page)).plain;
    const bar = (await copyByToolbar(page)).plain;
    const menu = (await copyByMenu(page, await boundaryPoint(page, end, 1, "before"))).plain;
    await selectVariant(page, variant, end);
    const explain = await explained(page);
    results.push({ rows, keys, menu, toolbar: bar, explain });
  }
  const [reference] = results;
  if (reference === undefined) throw new Error("no result");
  // The text runs to the end sentence's selected piece and holds every filler sentence before it in full.
  const fillerFrom = variant.sequence.length;
  const filler = paddedSequence(variant, FILLER_END + 1).slice(fillerFrom);
  // Under 只看 the student's filler sentences are hidden; the teacher's all show.
  expectInOrder(reference.toolbar, pieces(page, fillerFrom, 0, end, 4).filter((_, step) => variant.query === undefined || filler[step] === SPEAKER_TEACHER));
  for (const result of results) {
    expect(result.toolbar, `${result.rows} rows: 复制`).toBe(reference.toolbar);
    expect(result.menu.trim(), `${result.rows} rows: 复制选中内容`).toBe(reference.toolbar);
    expect(result.keys.trim(), `${result.rows} rows: Ctrl+C`).toBe(reference.toolbar);
    expect(result.explain, `${result.rows} rows: 解释`).toBe(reference.explain);
  }
}

test.describe("reader selection: the same rows give the same texts, short or windowed", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
  });

  test("across speakers", async ({ page }) => {
    await sameRows(page, { sequence: SPEAKER_SEQUENCE, start: { index: 1, offset: 2 } });
  });

  test("across a chapter heading", async ({ page }) => {
    await sameRows(page, { sequence: SPEAKER_SEQUENCE, chapters: CHAPTERS, start: { index: 1, offset: 2 } });
  });

  test("across several paragraphs of one turn", async ({ page }) => {
    await sameRows(page, { sequence: [SPEAKER_TEACHER, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_STUDENT], texts: { 2: longSentence(2), 3: longSentence(3) }, start: { index: 2, offset: 2 } });
  });

  test("into an unassigned turn, with English sentences", async ({ page }) => {
    await sameRows(page, { sequence: SPEAKER_SEQUENCE, texts: ENGLISH, start: { index: 4, offset: 2 } });
  });

  test("starting before a paragraph's time", async ({ page }) => {
    await sameRows(page, { sequence: SPEAKER_SEQUENCE, chapters: CHAPTERS, start: { beforeTimeOf: 2 } });
  });

  test("with the speakers hidden", async ({ page }) => {
    await sameRows(page, { sequence: SPEAKER_SEQUENCE, chapters: CHAPTERS, typography: { showSpeakers: false }, start: { index: 1, offset: 2 } });
  });

  test("in a narrow pane", async ({ page }) => {
    await sameRows(page, { sequence: SPEAKER_SEQUENCE, chapters: CHAPTERS, pane: 480, start: { index: 1, offset: 2 } });
  });

  test("under 只看, across a gap", async ({ page }) => {
    await sameRows(page, { sequence: SPEAKER_SEQUENCE, chapters: CHAPTERS, query: `&speaker=${SPEAKER_TEACHER}`, start: { index: 1, offset: 2 } });
  });
});

test.describe("reader selection: short selections copy what the browser copies", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    speakersRequests(page).chapters = CHAPTERS;
    speakersRequests(page).texts = ENGLISH;
    await open(page, { outputsWidth: 900 });
  });

  /** Every short case: the drag and the exact plain text the three copy entries give. */
  const CASES: Array<{ name: string; from: { index: number; offset: number }; to: { index: number; offset: number }; text: string; inside: { index: number; offset: number } }> = [
    { name: "inside one sentence", from: { index: 0, offset: 2 }, to: { index: 0, offset: 5 }, text: "1 句", inside: { index: 0, offset: 3 } },
    { name: "over two sentences of one paragraph", from: { index: 0, offset: 2 }, to: { index: 1, offset: 5 }, text: "1 句发言人模拟字幕。第 2 句", inside: { index: 1, offset: 2 } },
    { name: "across a chapter heading into the next turn", from: { index: 1, offset: 2 }, to: { index: 2, offset: 5 }, text: "2 句发言人模拟字幕。\n\n学生提问\n\n\n发言人 2\n0:20第 3 句", inside: { index: 2, offset: 2 } },
    { name: "into an unassigned turn from an English sentence with an emoji", from: { index: 4, offset: 2 }, to: { index: 5, offset: 3 }, text: "urth one follows 😀 here.\n\n未分配\n0:50第 6", inside: { index: 5, offset: 1 } },
    { name: "over two English sentences", from: { index: 3, offset: 0 }, to: { index: 4, offset: 12 }, text: "Third sentence in English. Fourth one f", inside: { index: 4, offset: 2 } },
  ];

  for (const sample of CASES) {
    test(`${sample.name}: Ctrl+C, 复制选中内容 and 复制 give the browser's text; Ctrl+C carries HTML too`, async ({ page }) => {
      await dragSelect(page, sample.from, sample.to);
      const keys = await copyByKeys(page);
      expect(keys.plain).toBe(sample.text);
      expect(keys.html, "Ctrl+C writes text/html").toBeDefined();
      const htmlText = squeeze((keys.html ?? "").replace(/<[^>]*>/gu, ""));
      for (const piece of pieces(page, sample.from.index, sample.from.offset, sample.to.index, sample.to.offset)) expect(htmlText).toContain(squeeze(piece));
      expect((await copyByToolbar(page)).plain).toBe(sample.text.trim());
      expect((await copyByMenu(page, await boundaryPoint(page, sample.inside.index, sample.inside.offset, "before"))).plain).toBe(sample.text);
    });
  }

  test("starting at a sentence's very end: 复制 trims the leading line break, 复制选中内容 and Ctrl+C keep it", async ({ page }) => {
    const end = textOf(page, 1).length;
    await drag(page, await boundaryPoint(page, 1, end, "after"), await boundaryPoint(page, 2, 5, "after"));
    const text = "\n学生提问\n\n\n发言人 2\n0:20第 3 句";
    expect((await copyByKeys(page)).plain).toBe(text);
    expect((await copyByToolbar(page)).plain).toBe(text.trim());
    expect((await copyByMenu(page, await boundaryPoint(page, 2, 2, "before"))).plain).toBe(text);
  });
});

test.describe("reader selection: 解释's text", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("a chapter title inside the selection has one space either side", async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).chapters = CHAPTERS;
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    expect(await explained(page)).toBe("2 句发言人模拟字幕。 学生提问 第 3 句");
  });

  test("the whole lecture reads as one line of titles and sentences, without names or times", async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).chapters = CHAPTERS;
    speakersRequests(page).texts = ENGLISH;
    await open(page, { outputsWidth: 900 });
    await drag(page, await titlePoint(page, "开场白", 0, "before"), await boundaryPoint(page, 5, textOf(page, 5).length, "after"));
    const sentences = (first: number, last: number) => explainOfSentences(page, first, 0, last, textOf(page, last).length);
    expect(await explained(page)).toBe(`开场白 ${sentences(0, 1)} 学生提问 ${sentences(2, 5)}`);
  });

  test("an English sentence and the next paragraph are joined with the reading separator", async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).texts = ENGLISH;
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 4, offset: 2 }, { index: 5, offset: 3 });
    expect(await explained(page)).toBe(`urth one follows 😀 here.${readingSeparator(ENGLISH[4], textOf(page, 5), false)}第 6`);
  });

  test("two English paragraphs of one turn do not run together", async ({ page }) => {
    await installMockBackend(page);
    const requests = speakersRequests(page);
    requests.sequence = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_TEACHER];
    requests.texts = { 0: "The first paragraph ends here.", 1: "The second one starts here.", 2: "第 3 句。" };
    requests.paragraphStarts = new Set([0, 1, 2]);
    await open(page, { outputsWidth: 900 });
    // Precondition: each sentence is a paragraph of its own.
    await expect(reader(page).locator("p[data-reader-text]")).toHaveCount(3);
    await dragSelect(page, { index: 0, offset: 4 }, { index: 1, offset: 10 });
    expect(await explained(page)).toBe(`first paragraph ends here.${readingSeparator(requests.texts[0] ?? "", requests.texts[1] ?? "", true)}The second`);
  });

  test("under 只看 a gap reads as skipped content, not as its length", async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).chapters = CHAPTERS;
    await open(page, { outputsWidth: 900, query: `&speaker=${SPEAKER_TEACHER}` });
    // The student's sentence leaves a gap; the unassigned last sentence is hidden at the very end, without one.
    await expect(page.getByTestId("speaker-gap")).toHaveCount(1);
    await drag(page, await titlePoint(page, "开场白", 0, "before"), await boundaryPoint(page, 4, textOf(page, 4).length, "after"));
    const text = await explained(page);
    expect(text).toContain(SKIPPED_MARKER);
    expect(text).not.toMatch(/略过 \d+ 秒|林老师|\d:\d\d/u);
    expect(squeeze(text)).toBe(squeeze(`开场白${textOf(page, 0)}${textOf(page, 1)}${SKIPPED_MARKER}学生提问${textOf(page, 3)}${textOf(page, 4)}`));
  });

  test("a selection over the chat limit is cut short without splitting an emoji, and the hint says so", async ({ page }) => {
    test.setTimeout(120_000);
    await installMockBackend(page);
    const first = 1500;
    const last = first + 34;
    // Emoji-only sentences of 300 UTF-16 units: 35 of them are well over the chat limit. The first
    // sentence leads with one Latin letter, so starting the selection before or after it shifts
    // every emoji by one unit and one of the two lands an emoji on any fixed cut.
    const texts: Record<number, string> = {};
    for (let index = first; index <= last; index += 1) texts[index] = `${index === first ? "a" : ""}${"😀".repeat(150)}`;
    speakersRequests(page).texts = texts;
    await openLong(page, first);
    for (const offset of [0, 1]) {
      await scrollReaderTo(page, first, -1);
      await longDrag(page, { index: first, offset, side: "before" }, { index: last, offset: 20, side: "after" });
      await expect(toolbar(page).getByTestId("selection-count")).toHaveText(`已选 ${last - first + 1} 句 · 解释只取开头部分`);
      await toolbar(page).getByTestId("selection-explain").click();
      const input = chatInput(page);
      await expect(input).toHaveValue(/^解释一下「[\s\S]+」$/u);
      const value = await input.inputValue();
      await input.fill("");
      expect(value.length, `offset ${offset}: within the chat limit`).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_CHARS);
      expect(value.length, `offset ${offset}: filled close to the limit`).toBeGreaterThan(CHAT_MESSAGE_MAX_CHARS - 10);
      expect(LONE_SURROGATE.test(value), `offset ${offset}: no half emoji`).toBe(false);
      const quoted = value.slice(EXPLAIN_PREFIX.length, -EXPLAIN_SUFFIX.length);
      expect(quoted.endsWith("…")).toBe(true);
      const full = explainOfSentences(page, first, offset, last, 20);
      expect(full.startsWith(quoted.slice(0, -1)), `offset ${offset}: the opening part of the selection`).toBe(true);
    }
  });
});

test.describe("reader selection: the quote 解释 attaches", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).chapters = CHAPTERS;
    await open(page, { outputsWidth: 900 });
  });

  test("words inside one sentence quote that sentence", async ({ page }) => {
    await dragSelect(page, { index: 2, offset: 2 }, { index: 2, offset: 5 });
    expect(await explained(page)).toBe("3 句");
    await expect(page.getByTestId("chat-quote")).toContainText(textOf(page, 2));
  });

  test("a whole sentence dragged to the start of the next one still quotes the one sentence", async ({ page }) => {
    await drag(page, await boundaryPoint(page, 0, 0, "before"), await boundaryPoint(page, 1, 0, "before"));
    expect(squeeze(await explained(page))).toBe(squeeze(textOf(page, 0)));
    await expect(page.getByTestId("chat-quote")).toContainText(textOf(page, 0));
  });

  test("a chapter title and one sentence attach no quote", async ({ page }) => {
    await drag(page, await titlePoint(page, "学生提问", 0, "before"), await boundaryPoint(page, 2, 5, "after"));
    const text = await explained(page);
    await expect(page.getByTestId("chat-quote")).toHaveCount(0);
    expect(text).toBe("学生提问 第 3 句");
  });
});

test.describe("reader selection: names and times alone are not a selection", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  // The name and the time are buttons, so a drag cannot start inside them; a user selects them
  // by dragging over them from the neighbouring text.

  test("a selection from the end of one turn to the start of the next, holding only the next turn's name and time, offers no toolbar", async ({ page }) => {
    await installMockBackend(page);
    await open(page, { outputsWidth: 900 });
    await drag(page, await boundaryPoint(page, 1, textOf(page, 1).length, "after"), await boundaryPoint(page, 2, 0, "before"));
    // The browser did select the header and the time; the reader offers nothing for them.
    expect(squeeze(await browserText(page))).toBe(squeeze("发言人 2 0:20"));
    await expect(toolbar(page)).toHaveCount(0);
  });

  test("a selection holding only a paragraph's time offers no toolbar", async ({ page }) => {
    await installMockBackend(page);
    await open(page, { outputsWidth: 900 });
    await drag(page, await beforeTime(page, 2), await boundaryPoint(page, 2, 0, "before"));
    expect((await browserText(page)).trim()).toBe("0:20");
    await expect(toolbar(page)).toHaveCount(0);
  });
});

test.describe("reader selection: a selection stays selected", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  const FIRST = 1500;
  const LAST = FIRST + 40;

  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: LAST, offset: 4, side: "after" });
    await expect(toolbar(page)).toBeVisible();
  });

  test("Ctrl, Shift, scrolling away and back, the context menu and Ctrl+C leave the selection version as it is; Shift+Arrow changes it", async ({ page }) => {
    const version = await selectionVersion(page);
    expect(version).toMatch(/^\d+$/u);
    await page.keyboard.press("Control");
    await page.keyboard.press("Shift");
    expect(await selectionVersion(page)).toBe(version);
    const box = await readerBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let notch = 0; notch < 20; notch += 1) await page.mouse.wheel(0, 400);
    await expect.poll(() => outOfView(page, LAST)).toBe(true);
    await wheelTo(page, LAST, -1);
    expect(await selectionVersion(page)).toBe(version);
    const inside = await boundaryPoint(page, LAST, 1, "before");
    await page.mouse.click(inside.x, inside.y, { button: "right" });
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("context-menu")).toHaveCount(0);
    expect(await selectionVersion(page)).toBe(version);
    await copyByKeys(page);
    expect(await selectionVersion(page)).toBe(version);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => selectionVersion(page)).not.toBe(version);
  });

  test("the rows holding the two ends stay mounted however far the list scrolls", async ({ page }) => {
    // The start row is out of view after the drag, yet still mounted.
    expect(await outOfView(page, FIRST)).toBe(true);
    await expect(sentence(page, FIRST)).toHaveCount(1);
    const startKey = await rowKeyOf(page, FIRST);
    const endKey = await rowKeyOf(page, LAST);
    if (startKey === null || endKey === null) throw new Error("the end rows are not mounted");
    await scrollToEnd(page, "bottom", 2999);
    await expect(rowWithKey(page, startKey)).toHaveCount(1);
    await expect(rowWithKey(page, endKey)).toHaveCount(1);
    await scrollToEnd(page, "top", 0);
    await expect(rowWithKey(page, startKey)).toHaveCount(1);
    await expect(rowWithKey(page, endKey)).toHaveCount(1);
    // Only the two ends: a row between them, far from the view, is not kept.
    await expect(sentence(page, FIRST + 20)).toHaveCount(0);
  });

  test("scrolled back into view, rows between the ends show the highlight and rows outside do not", async ({ page }) => {
    const box = await readerBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let notch = 0; notch < 30; notch += 1) await page.mouse.wheel(0, 400);
    await expect.poll(() => outOfView(page, LAST)).toBe(true);
    // Back up until the start row is in the middle: the row before it and rows after it show.
    await scrollReaderTo(page, FIRST, -1);
    const inside = await sentence(page, FIRST + 3).boundingBox();
    const outside = await sentence(page, FIRST - 2).boundingBox();
    if (inside === null || outside === null) throw new Error("rows not in view");
    const selectedInside = await page.screenshot({ clip: inside });
    const selectedOutside = await page.screenshot({ clip: outside });
    const contained = await page.evaluate(
      ([a, b]) => {
        const selection = window.getSelection();
        const find = (id: string) => document.querySelector(`[data-testid="transcript-reader"] [data-segment-id="${id}"]`);
        const x = find(a);
        const y = find(b);
        return { inside: y === null ? null : (selection?.containsNode(y, false) ?? null), outside: x === null ? null : (selection?.containsNode(x, true) ?? null) };
      },
      [sid(FIRST - 2), sid(FIRST + 3)] as const,
    );
    expect(contained).toEqual({ inside: true, outside: false });
    // The same rows without any selection: the highlight is the only difference.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect.poll(() => browserText(page)).toBe("");
    expect(selectedInside.equals(await page.screenshot({ clip: inside })), "a row inside the selection is painted as selected").toBe(false);
    expect(selectedOutside.equals(await page.screenshot({ clip: outside })), "a row outside the selection is painted as before").toBe(true);
  });
});

test.describe("reader selection: re-layout keeps the selection", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("narrowing the window across the wide and narrow layouts, and back, keeps the selected text, its highlight and the toolbar", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await open(page, { outputsWidth: await outputsFor(page, 560) });
    const layout = () => reader(page).locator("[data-turn-layout]").first().getAttribute("data-turn-layout");
    expect(await layout()).toBe("wide");
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    const selected = await browserText(page);
    expect(selected).toBe("2 句发言人模拟字幕。\n\n\n发言人 2\n0:20第 3 句");
    for (const [want, widths] of [
      ["narrow", [1900, 1880, 1860, 1840, 1820, 1800, 1760, 1720, 1680, 1640, 1600, 1500, 1400, 1300, 1200, 1100]],
      ["wide", [1200, 1300, 1400, 1500, 1600, 1700, 1800, 1920]],
    ] as const) {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1080 });
        if ((await layout()) === want) break;
      }
      await expect.poll(layout).toBe(want);
      await expect(toolbar(page)).toBeVisible();
      expect(await browserText(page), `${want}: the browser still selects the same words`).toBe(selected);
      const highlighted = await sentence(page, 2).evaluate((element) => window.getSelection()?.containsNode(element, true) ?? false);
      expect(highlighted).toBe(true);
    }
    // 「解释」 ends the selection, so the same words can be dragged over again for 复制.
    expect(await explained(page)).toBe("2 句发言人模拟字幕。第 3 句");
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    expect((await copyByToolbar(page)).plain).toBe(selected);
  });

  test("a larger font keeps the selected text, its highlight and the toolbar", async ({ page }) => {
    await installMockBackend(page);
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    const selected = await browserText(page);
    await page.getByTestId("reader-typography").click();
    const larger = page.getByTestId("reader-font-larger");
    await larger.click();
    await larger.click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader-typography-popover")).toBeHidden();
    expect(await browserText(page)).toBe(selected);
    await expect(toolbar(page)).toBeVisible();
    expect(await explained(page)).toBe("2 句发言人模拟字幕。第 3 句");
  });

  test("chapters arriving after the selection was made keep it", async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).chapters = CHAPTERS;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/contents/${SPEAKERS_CONTENT}/chapters`, async (route) => {
      await held;
      await route.fallback();
    });
    await open(page, { outputsWidth: 900 });
    await expect(reader(page).getByTestId("chapter-title")).toHaveCount(0);
    await dragSelect(page, { index: 3, offset: 2 }, { index: 5, offset: 3 });
    const selected = await browserText(page);
    release();
    await expect(reader(page).getByTestId("chapter-title")).toHaveCount(2);
    expect(await browserText(page)).toBe(selected);
    await expect(toolbar(page)).toBeVisible();
    expect(await explained(page)).toBe(explainOfSentences(page, 3, 2, 5, 3));
  });
});

test.describe("reader selection: what ends a selection", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  const FIRST = 1500;
  const LAST = FIRST + 40;

  /** A long selection whose start row is pinned far out of view; returns the keys of its end rows. */
  async function longSelection(page: Page): Promise<string[]> {
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: LAST, offset: 4, side: "after" });
    await expect(toolbar(page)).toBeVisible();
    const keys = [await rowKeyOf(page, LAST)];
    return keys.filter((key): key is string => key !== null);
  }

  /** No toolbar, no browser selection, and once the list is scrolled away no row of the former ends left mounted. */
  async function expectCleared(page: Page, keys: readonly string[], scroll: boolean): Promise<void> {
    await expect(toolbar(page)).toHaveCount(0);
    await expect.poll(() => browserText(page)).toBe("");
    if (!scroll) return;
    await reader(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(reader(page).locator("[data-row-index='0']")).toHaveCount(1);
    expect(await sentence(page, FIRST).count(), "the start row is no longer kept").toBe(0);
    for (const key of keys) await expect(rowWithKey(page, key)).toHaveCount(0);
  }

  test.beforeEach(async ({ page }) => {
    await installMockBackend(page);
  });

  test("switching the transcript version", async ({ page }) => {
    speakersRequests(page).earlierRevision = true;
    const keys = await longSelection(page);
    await page.getByTestId("transcript-version").selectOption(SPEAKERS_EARLIER_REVISION);
    await expect(reader(page).locator(`[data-segment-id="${segmentId(SPEAKERS_EARLIER_REVISION, 0)}"]`)).toBeVisible();
    await expectCleared(page, keys, false);
  });

  test("changing the speaker filter", async ({ page }) => {
    const keys = await longSelection(page);
    await page.getByRole("button", { name: "只看某些发言人", exact: true }).click();
    const box = page.getByRole("dialog", { name: "只看某些发言人" }).getByRole("checkbox", { name: /^林老师/u });
    await box.click();
    await expect(box).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("speaker-filter-bar")).toBeVisible();
    await expectCleared(page, keys, true);
  });

  test("turning the speaker display off", async ({ page }) => {
    const keys = await longSelection(page);
    await page.getByTestId("reader-typography").click();
    await page.getByTestId("reader-show-speakers").click({ force: true });
    await expect(reader(page).getByTestId("turn-header")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectCleared(page, keys, true);
  });

  test("switching to another tab and back", async ({ page }) => {
    await longSelection(page);
    await page.getByTestId("output-tab-summary").click();
    await expect(page.getByTestId("output-tab-summary")).toHaveAttribute("aria-selected", "true");
    await expect(toolbar(page)).toHaveCount(0);
    await expect.poll(() => browserText(page)).toBe("");
    await page.getByTestId("output-tab-transcript").click();
    await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
    await expect(toolbar(page)).toHaveCount(0);
    expect(await browserText(page)).toBe("");
  });
});

test.describe("reader selection: under 只看", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    speakersRequests(page).chapters = CHAPTERS;
  });

  test("a selection across a gap copies the gap line and explains with the marker, but refuses notes with the reason", async ({ page }) => {
    const notes = await routeSpeakerNotes(page);
    await open(page, { outputsWidth: 900, query: `&speaker=${SPEAKER_TEACHER}` });
    await expect(page.getByTestId("speaker-gap").first()).toBeVisible();
    await dragSelect(page, { index: 1, offset: 2 }, { index: 3, offset: 5 });
    for (const id of ["selection-note-underline", "selection-note-background", "selection-note-comment"]) {
      const button = toolbar(page).getByTestId(id);
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("title", CROSSES_GAP_REASON);
    }
    await expect(toolbar(page).getByTestId("selection-copy")).toBeEnabled();
    await expect(toolbar(page).getByTestId("selection-explain")).toBeEnabled();
    // 「解释」 ends the selection, so the same words can be dragged over again for 复制.
    const text = await explained(page);
    expect(text).toBe(`2 句发言人模拟字幕。${SKIPPED_MARKER} 学生提问 第 4 句`);
    await dragSelect(page, { index: 1, offset: 2 }, { index: 3, offset: 5 });
    const copy = (await copyByToolbar(page)).plain;
    expect(copy).toBe("2 句发言人模拟字幕。\n\n略过 11 秒\n学生提问\n\n\n林老师\n0:30第 4 句");
    expect(notes.posts).toEqual([]);
  });

  test("a selection that crosses no gap makes a note as before", async ({ page }) => {
    const notes = await routeSpeakerNotes(page);
    await open(page, { outputsWidth: 900, query: `&speaker=${SPEAKER_TEACHER}` });
    await dragSelect(page, { index: 0, offset: 2 }, { index: 1, offset: 5 });
    await expect(toolbar(page).getByTestId("selection-note-underline")).toBeEnabled();
    await toolbar(page).getByTestId("selection-note-underline").click();
    await expect.poll(() => notes.posts.length).toBe(1);
    expect(notes.posts[0]).toMatchObject({ transcriptRevisionId: SPEAKERS_REVISION, startSegmentId: sid(0), startOffset: 2, endSegmentId: sid(1), endOffset: 5, mark: "underline" });
  });
});

test.describe("reader selection: notes from long selections", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  const FIRST = 1500;

  test.beforeEach(async ({ page }) => {
    await installMockBackend(page);
  });

  test(`${NOTE_SPAN_MAX_SEGMENTS} sentences across screens: the note is anchored exactly on the first and last sentence`, async ({ page }) => {
    const notes = await routeSpeakerNotes(page);
    await openLong(page, FIRST);
    const last = FIRST + NOTE_SPAN_MAX_SEGMENTS - 1;
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: last, offset: 4, side: "after" });
    await expect(toolbar(page).getByTestId("selection-note-background")).toBeEnabled();
    await toolbar(page).getByTestId("selection-note-background").click();
    await expect.poll(() => notes.posts.length).toBe(1);
    expect(notes.posts[0]).toMatchObject({ transcriptRevisionId: SPEAKERS_REVISION, startSegmentId: sid(FIRST), startOffset: 2, endSegmentId: sid(last), endOffset: 4, mark: "background" });
  });

  test(`more than ${NOTE_SPAN_MAX_SEGMENTS} sentences: the note buttons are disabled with the reason`, async ({ page }) => {
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: FIRST + NOTE_SPAN_MAX_SEGMENTS, offset: 4, side: "after" });
    for (const id of ["selection-note-underline", "selection-note-background", "selection-note-comment"]) {
      await expect(toolbar(page).getByTestId(id)).toBeDisabled();
      await expect(toolbar(page).getByTestId(id)).toHaveAttribute("title", TOO_LONG_REASON);
    }
  });

  test("the comment draft for a selection longer than the screen opens inside the viewport", async ({ page }) => {
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: FIRST + NOTE_SPAN_MAX_SEGMENTS - 1, offset: 4, side: "after" });
    await toolbar(page).getByTestId("selection-note-comment").click();
    await expect(page.getByTestId("note-compose")).toBeVisible();
    const box = await page.getByTestId("note-popover").boundingBox();
    if (box === null) throw new Error("no popover");
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("no viewport");
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  });

  test("the comment draft stays inside the viewport when the selection was let go near the bottom of the reader", async ({ page }) => {
    await openLong(page, FIRST);
    const last = FIRST + NOTE_SPAN_MAX_SEGMENTS - 1;
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: last, offset: 4, side: "after" });
    // Bring the released end down to the last lines of the reader: no room is left below it.
    const pane = await readerBox(page);
    const before = await topOf(page, last);
    if (before === undefined) throw new Error("the released end is not mounted");
    const lowest = pane.y + pane.height - 60;
    await page.mouse.wheel(0, before - lowest);
    await expect.poll(async () => Math.abs(((await topOf(page, last)) ?? 0) - lowest)).toBeLessThan(30);
    await toolbar(page).getByTestId("selection-note-comment").click();
    await expect(page.getByTestId("note-compose")).toBeVisible();
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("no viewport");
    await expect
      .poll(async () => {
        const box = await page.getByTestId("note-popover").boundingBox();
        return box !== null && box.y >= 0 && box.x >= 0 && box.y + box.height <= viewport.height && box.x + box.width <= viewport.width;
      })
      .toBe(true);
  });
});

test.describe("reader selection: the context menu", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
  });

  test("a right click on a sentence inside the selection offers the selection's rows and the sentence's", async ({ page }) => {
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    const inside = await boundaryPoint(page, 2, 3, "before");
    await page.mouse.click(inside.x, inside.y, { button: "right" });
    expect(await menuItems(page)).toEqual([...SELECTION_ITEMS, ...SENTENCE_ITEMS]);
  });

  test("a right click on a chapter title inside the selection offers the selection's rows", async ({ page }) => {
    speakersRequests(page).chapters = CHAPTERS;
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    const title = await titlePoint(page, "学生提问", 1, "before");
    await page.mouse.click(title.x, title.y, { button: "right" });
    expect(await menuItems(page)).toEqual(SELECTION_ITEMS);
    await page.getByTestId("context-menu-item-copy-selection").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("2 句发言人模拟字幕。\n\n学生提问\n\n\n发言人 2\n0:20第 3 句");
  });

  test("a right click on a gap bar inside the selection offers the selection's rows", async ({ page }) => {
    await open(page, { outputsWidth: 900, query: `&speaker=${SPEAKER_TEACHER}` });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 3, offset: 5 });
    const gap = await page.getByTestId("speaker-gap").first().boundingBox();
    if (gap === null) throw new Error("no gap bar");
    await page.mouse.click(gap.x + gap.width / 2, gap.y + gap.height / 2, { button: "right" });
    expect(await menuItems(page)).toEqual(SELECTION_ITEMS);
  });

  test("a right click on blank space inside the selection offers the selection's rows", async ({ page }) => {
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 3, offset: 5 });
    // Right of the student's short paragraph, inside the reading column: no sentence there.
    const blank = await reader(page)
      .locator("p[data-reader-text]", { has: page.locator(`[data-segment-id="${sid(2)}"]`) })
      .evaluate((paragraph) => {
        const box = paragraph.getBoundingClientRect();
        return { x: box.right - 12, y: box.top + 4 };
      });
    const onSentence = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-segment-id]") !== null, blank);
    expect(onSentence, "the point is not on a sentence").toBe(false);
    await page.mouse.click(blank.x, blank.y, { button: "right" });
    expect(await menuItems(page)).toEqual(SELECTION_ITEMS);
  });

  test("Shift+F10 and the context-menu key open the menu with the selection's rows", async ({ page }) => {
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    for (const key of ["Shift+F10", "ContextMenu"]) {
      await page.keyboard.press(key);
      expect((await menuItems(page)).slice(0, 2), key).toEqual(SELECTION_ITEMS);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("context-menu")).toHaveCount(0);
    }
  });

  test("Shift+F10 after a drag across screens opens the menu with the selection's rows, and its copy is complete", async ({ page }) => {
    const first = 1500;
    const last = first + 40;
    await openLong(page, first);
    await longDrag(page, { index: first, offset: 2, side: "before" }, { index: last, offset: 4, side: "after" });
    await page.keyboard.press("Shift+F10");
    expect((await menuItems(page)).slice(0, 2)).toEqual(SELECTION_ITEMS);
    const text = await copied(page, () => page.getByTestId("context-menu-item-copy-selection").click());
    expect(text.plain).toBe(copyOfAlternating(page, first, 2, last, 4));
  });
});

test.describe("reader selection: where the toolbar sits", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  const FIRST = 1500;

  test.beforeEach(async ({ page }) => {
    await installMockBackend(page);
  });

  test("with the selection's first line in view, the toolbar sits just above it", async ({ page }) => {
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 3, offset: 2 }, { index: 4, offset: 5 });
    const line = await charBox(page, 3, 2);
    const bar = await toolbar(page).boundingBox();
    if (bar === null) throw new Error("no toolbar");
    expect(bar.y + bar.height).toBeLessThanOrEqual(line.top + SNAP_PX);
    expect(bar.y + bar.height).toBeGreaterThan(line.top - 40);
    expect(await toolbarOutside(page)).toEqual([]);
  });

  test("with the first line scrolled out and the released end in view, the toolbar sits beside that end", async ({ page }) => {
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: FIRST + 40, offset: 4, side: "after" });
    const end = await charBox(page, FIRST + 40, 3);
    const bar = await toolbar(page).boundingBox();
    if (bar === null) throw new Error("no toolbar");
    const lineHeight = end.bottom - end.top;
    expect(Math.abs(bar.y + bar.height / 2 - (end.top + end.bottom) / 2)).toBeLessThanOrEqual(bar.height + lineHeight);
    expect(await toolbarOutside(page)).toEqual([]);
  });

  test("with both ends out of view, the toolbar sits at the reader's top inner edge", async ({ page }) => {
    await openLong(page, FIRST);
    await longDrag(page, { index: FIRST, offset: 2, side: "before" }, { index: FIRST + 40, offset: 4, side: "after" });
    await wheelTo(page, FIRST + 20, -1);
    const box = await readerBox(page);
    await expect.poll(() => outOfView(page, FIRST + 40)).toBe(true);
    expect(await outOfView(page, FIRST)).toBe(true);
    await expect(toolbar(page)).toBeVisible();
    const bar = await toolbar(page).boundingBox();
    if (bar === null) throw new Error("no toolbar");
    expect(bar.y - box.y).toBeGreaterThanOrEqual(-SNAP_PX);
    expect(bar.y - box.y).toBeLessThanOrEqual(24);
    expect(await toolbarOutside(page)).toEqual([]);
  });

  test("the toolbar stays inside the reader in a narrow pane and at font size 32, near the top and the right edge", async ({ page }) => {
    speakersRequests(page).sequence = alternating(40);
    speakersRequests(page).texts = { 0: longSentence(0), 6: longSentence(6) };
    const narrow = await outputsFor(page, 480);
    for (const setup of [{ outputsWidth: narrow }, { outputsWidth: 900, typography: { fontSize: 32 } }]) {
      await open(page, setup);
      // The first line of the first paragraph: above it is the reader's top edge.
      await dragSelect(page, { index: 0, offset: 2 }, { index: 0, offset: 5 });
      await expect(toolbar(page)).toBeVisible();
      expect(await toolbarOutside(page), JSON.stringify(setup)).toEqual([]);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await expect(toolbar(page)).toHaveCount(0);
      // The last characters of the sentence's first line, at the right edge of the column.
      const lineEnd = await sentence(page, 0).evaluate((element) => {
        const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() as Text;
        const topAt = (offset: number): number => {
          const range = document.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          return range.getClientRects()[0]?.top ?? Number.NaN;
        };
        const first = topAt(0);
        let offset = 0;
        while (offset + 1 < text.data.length && Math.abs(topAt(offset + 1) - first) < 2) offset += 1;
        return offset + 1;
      });
      await dragSelect(page, { index: 0, offset: lineEnd - 3 }, { index: 0, offset: lineEnd });
      await expect(toolbar(page)).toBeVisible();
      expect(await toolbarOutside(page), JSON.stringify(setup)).toEqual([]);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await expect(toolbar(page)).toHaveCount(0);
      // A long paragraph scrolled up until its first line just touches the reader's top edge:
      // there is no room above that line inside the reader.
      await sentence(page, 6).evaluate((element) => {
        const scroller = element.closest<HTMLElement>("[data-testid='transcript-reader']");
        if (scroller !== null) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 2;
      });
      const box = await readerBox(page);
      await expect.poll(async () => (await charBox(page, 6, 2)).top - box.y).toBeLessThan(12);
      await dragSelect(page, { index: 6, offset: 2 }, { index: 6, offset: 5 });
      await expect(toolbar(page)).toBeVisible();
      expect(await toolbarOutside(page), `${JSON.stringify(setup)}, first line at the top edge`).toEqual([]);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    }
  });
});

test.describe("reader selection: Ctrl+C outside the reader", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 1, offset: 2 }, { index: 2, offset: 5 });
    await expect(toolbar(page)).toBeVisible();
  });

  test("in the typography popover's font field, Ctrl+C copies the field's text", async ({ page }) => {
    await page.getByTestId("reader-typography").click();
    const panel = page.getByTestId("reader-typography-popover");
    await panel.getByRole("radio", { name: "自选" }).click({ force: true });
    const field = panel.getByTestId("reader-custom-font");
    await field.fill("Arial");
    await field.press("Control+a");
    expect((await copied(page, () => field.press("Control+c"))).plain).toBe("Arial");
  });

  test("in the chat input, Ctrl+C copies the input's text", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("这一段怎么理解");
    await input.press("Control+a");
    expect((await copied(page, () => input.press("Control+c"))).plain).toBe("这一段怎么理解");
  });
});

test.describe("reader selection: the keyboard", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("Shift+Arrow extends a selection and 复制 and 解释 follow it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { index: 0, offset: 2 }, { index: 0, offset: 5 });
    for (let press = 0; press < 3; press += 1) await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => browserText(page)).toBe("1 句发言人");
    expect((await copyByToolbar(page)).plain).toBe("1 句发言人");
    await page.keyboard.press("Shift+ArrowRight");
    expect(await explained(page)).toBe("1 句发言人模");
  });
});
