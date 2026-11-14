import { expect, test, type Locator, type Page } from "@playwright/test";
import { noteDtoSchema, noteListDtoSchema, type NoteDto } from "../../src/shared/dto/note.ts";
import { READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey, type ReaderTypography } from "../../src/shared/reader-typography.ts";
import { BILI_REVISION, BILIBILI_CONTENT, installMockBackend, segmentId } from "./mock-backend.ts";
import { SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKERS_CONTENT, SPEAKERS_REVISION, speakerSentence, speakersRequests, speakerStartMs, type SpeakerSequence } from "./mock-speakers.ts";

/*
 * The structure of the transcript reading view and what a reader does with it: turn headers,
 * paragraph times, chapter headings, the sticky speaker marker and selections across all of
 * them. Geometry of fonts and margins lives in the reader-font and reader-measure specs.
 */

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
/** The width the content page remembers for its output column, set before the page loads. */
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
/** One CSS pixel: box edges snap to the device grid. */
const SNAP_PX = 1;
/** The least height a paragraph time's clickable area must have, in CSS px. */
const TIME_HIT_MIN_PX = 24;

const sid = (index: number): string => segmentId(SPEAKERS_REVISION, index);
const reader = (page: Page): Locator => page.getByTestId("transcript-reader");
const sentence = (page: Page, index: number): Locator => reader(page).locator(`[data-segment-id="${sid(index)}"]`);
const paragraphOf = (page: Page, index: number): Locator => reader(page).locator("p[data-reader-text]", { has: page.locator(`[data-segment-id="${sid(index)}"]`) });
const timeOf = (page: Page, index: number): Locator => paragraphOf(page, index).locator("button[data-reading-time]");
/** Turns that alternate every sentence, so each sentence is a row of its own. */
const alternating = (count: number): string[] => Array.from({ length: count }, (_, index) => (index % 2 === 0 ? SPEAKER_TEACHER : SPEAKER_STUDENT));

/** `h:mm:ss` from an hour on, `m:ss` below: how the reader writes a media time, written out here independently. */
function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** A sentence long enough to end a paragraph on its own (paragraphs close after 200 characters at a sentence end). */
const longSentence = (index: number): string => `${speakerSentence(index)}${"这一段讲解很长，用来让同一轮的这一段占满好几行文字，".repeat(9)}到此为止。`;

/** Opens the reader with the stored typography and output column width; the first sentence is drawn when it returns. */
async function open(page: Page, options: { typography?: Partial<ReaderTypography>; outputsWidth?: number; query?: string; url?: string } = {}): Promise<void> {
  const url = `${options.url ?? READER}${options.query ?? ""}`;
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

async function openPanel(page: Page): Promise<Locator> {
  const panel = page.getByTestId("reader-typography-popover");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Aa 阅读排版" }).click();
  return panel;
}

/** Presses Tab (or Shift+Tab) until `target` has the focus, as a keyboard user would reach it; fails if it never does. */
async function tabTo(page: Page, target: Locator, key: "Tab" | "Shift+Tab" = "Tab", limit = 40): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

/** What a seek leaves behind: the sentence in the address and the player's start time. */
interface SeekState {
  segment: string | null;
  src: string | null;
}

async function seekState(page: Page): Promise<SeekState> {
  return { segment: new URL(page.url()).searchParams.get("segment"), src: await page.getByTestId("player-bilibili").getAttribute("src") };
}

/** The bilibili player has no time tracking: a seek shows as the sentence picked in the address, its highlight, and the player reloaded at its start. */
async function expectSeekTo(page: Page, index: number, startMs = speakerStartMs(speakersRequests(page), index)): Promise<void> {
  await expect.poll(() => new URL(page.url()).searchParams.get("segment")).toBe(sid(index));
  await expect(sentence(page, index)).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("player-bilibili")).toHaveAttribute("src", new RegExp(`[?&]t=${startMs / 1000}(&|$)`, "u"));
}

/** Nothing seeks: the address and the player stay as they were, and no other sentence takes the highlight. */
async function expectNoSeek(page: Page, before: SeekState): Promise<void> {
  // Give a stray click handler time to write the address or reload the player.
  await page.waitForTimeout(300);
  expect(await seekState(page)).toEqual(before);
  // The highlighted row may have been windowed away; whatever is highlighted is still the sentence picked before.
  const highlighted = await reader(page).locator("[aria-current='true']").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-segment-id")));
  for (const id of highlighted) expect(id).toBe(before.segment);
}

/**
 * The viewport point of a character boundary inside a sentence: `before` the character at
 * `offset`, or `after` the one ending at it. Offsets count the sentence's text nodes in order.
 */
async function boundaryPoint(page: Page, segment: string, offset: number, side: "before" | "after"): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ([id, at, edge]) => {
      const element = document.querySelector(`[data-testid="transcript-reader"] [data-segment-id="${id}"]`);
      if (element === null) return null;
      const target = edge === "before" ? Number(at) : Number(at) - 1;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
        if (target < seen + node.data.length) {
          const range = document.createRange();
          range.setStart(node, target - seen);
          range.setEnd(node, target - seen + 1);
          const box = range.getClientRects()[0];
          if (box === undefined) return null;
          return { x: edge === "before" ? box.left + 1 : box.right - 1, y: (box.top + box.bottom) / 2 };
        }
        seen += node.data.length;
      }
      return null;
    },
    [segment, String(offset), side] as const,
  );
  if (point === null) throw new Error(`no character ${offset} (${side}) in ${segment}`);
  return point;
}

/** Presses at one character boundary, moves to another in steps and releases: a real mouse selection. */
async function dragSelect(page: Page, from: { segment: string; offset: number }, to: { segment: string; offset: number }): Promise<void> {
  const start = await boundaryPoint(page, from.segment, from.offset, "before");
  const end = await boundaryPoint(page, to.segment, to.offset, "after");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

/** Selects with the mouse, presses 「解释」 and returns the text the question quotes. */
async function explained(page: Page): Promise<string> {
  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar).toBeVisible();
  await toolbar.getByTestId("selection-explain").click();
  const input = page.getByTestId("chat-panel").getByTestId("chat-input");
  await expect(input).toHaveValue(/^解释一下「[\s\S]+」$/u);
  return (await input.inputValue()).replace(/^解释一下「/u, "").replace(/」$/u, "");
}

/** Whitespace carries no meaning in the comparisons below: the sentences themselves contain spaces, and joins may add some. */
const squeeze = (text: string): string => text.replace(/\s+/gu, "");

/** The text of a sentence of the speakers lecture in this browser context. */
const textOf = (page: Page, index: number): string => speakersRequests(page).texts[index] ?? speakerSentence(index);

/**
 * Notes on the speakers lecture, answered in the spec: the shared fake keeps notes for its own
 * lectures only. A note is placed exactly on the sentences it covers, the way the server places
 * a note on the revision it was made on.
 */
async function routeSpeakerNotes(page: Page, seeded: Array<{ start: number; startOffset: number; end: number; endOffset: number }> = []): Promise<{ posts: unknown[] }> {
  const posts: unknown[] = [];
  const notes: NoteDto[] = [];
  const indexOf = (id: string): number => Number(id.slice(-4));
  const add = (anchor: { startSegmentId: string; startOffset: number; endSegmentId: string; endOffset: number; mark?: string; color?: string }): NoteDto => {
    const note = noteDtoSchema.parse({
      id: `01J00000000000000000SPN${String(notes.length + 1).padStart(3, "0")}`,
      contentId: SPEAKERS_CONTENT,
      contentTitle: "",
      transcriptRevisionId: SPEAKERS_REVISION,
      startSegmentId: anchor.startSegmentId,
      startOffset: anchor.startOffset,
      endSegmentId: anchor.endSegmentId,
      endOffset: anchor.endOffset,
      startMs: speakerStartMs(speakersRequests(page), indexOf(anchor.startSegmentId)),
      quote: "",
      mark: anchor.mark ?? "background",
      color: anchor.color ?? "yellow",
      createdAt: 1_790_000_000_000 + notes.length,
      updatedAt: 1_790_000_000_000 + notes.length,
    });
    notes.push(note);
    return note;
  };
  const view = (note: NoteDto) => {
    const first = indexOf(note.startSegmentId);
    const last = indexOf(note.endSegmentId);
    return {
      exact: true,
      segments: Array.from({ length: last - first + 1 }, (_, step) => first + step).map((index) => ({
        segmentId: sid(index),
        startOffset: index === first ? note.startOffset : 0,
        endOffset: index === last ? note.endOffset : textOf(page, index).length,
      })),
    };
  };
  for (const seed of seeded) add({ startSegmentId: sid(seed.start), startOffset: seed.startOffset, endSegmentId: sid(seed.end), endOffset: seed.endOffset });
  await page.route(`**/api/contents/${SPEAKERS_CONTENT}/notes*`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { startSegmentId: string; startOffset: number; endSegmentId: string; endOffset: number; mark: string; color: string };
      posts.push(body);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(add(body)) });
    }
    const revision = new URL(request.url()).searchParams.get("revision");
    const items = notes.map((note) => (revision === null ? note : { ...note, view: view(note) }));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(noteListDtoSchema.parse({ items })) });
  });
  return { posts };
}

/** Where each sentence of a revision starts, by segment id, as the time a paragraph opening with it shows. */
function timeLabels(ids: (index: number) => string, starts: (index: number) => number, count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [ids(index), clock(starts(index))]));
}

/**
 * Every way the paragraphs of the reader miss their structure: each opens with its time button
 * (first child, before any sentence), showing the start of its first sentence, in 12px
 * monospace on one line, with the first sentence following on the paragraph's first line.
 */
async function paragraphProblems(page: Page, labels: Record<string, string>): Promise<{ count: number; problems: string[] }> {
  return page.evaluate((expected) => {
    const problems: string[] = [];
    const paragraphs = [...document.querySelectorAll<HTMLElement>("[data-testid='transcript-reader'] p[data-reader-text]")];
    for (const paragraph of paragraphs) {
      const firstSentence = paragraph.querySelector<HTMLElement>("[data-segment-id]");
      const id = firstSentence?.getAttribute("data-segment-id") ?? "";
      const label = `paragraph ${id}`;
      const first = [...paragraph.childNodes].find((node) => !(node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === ""));
      if (!(first instanceof HTMLButtonElement) || !first.hasAttribute("data-reading-time")) {
        problems.push(`${label}: first child is ${first instanceof Element ? first.outerHTML.slice(0, 80) : String(first?.textContent)}`);
        continue;
      }
      if (paragraph.querySelectorAll("[data-reading-time]").length !== 1) problems.push(`${label}: ${paragraph.querySelectorAll("[data-reading-time]").length} times`);
      if (first.textContent !== expected[id]) problems.push(`${label}: time ${first.textContent}, want ${expected[id]}`);
      const style = getComputedStyle(first);
      if (style.fontSize !== "12px") problems.push(`${label}: time size ${style.fontSize}`);
      if (!/mono/iu.test(style.fontFamily)) problems.push(`${label}: time font ${style.fontFamily}`);
      if (first.getClientRects().length !== 1) problems.push(`${label}: time wraps over ${first.getClientRects().length} boxes`);
      if (firstSentence === null || (first.compareDocumentPosition(firstSentence) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
        problems.push(`${label}: no sentence after the time`);
        continue;
      }
      // The first sentence starts on the paragraph's first line, right after the time.
      const walker = document.createTreeWalker(firstSentence, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode() as Text | null;
      if (text === null) continue;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const glyph = range.getClientRects()[0];
      const box = paragraph.getBoundingClientRect();
      const top = box.top + Number.parseFloat(getComputedStyle(paragraph).paddingTop);
      const line = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
      const centre = glyph === undefined ? Number.NaN : (glyph.top + glyph.bottom) / 2;
      if (!(centre >= top && centre <= top + line)) problems.push(`${label}: first sentence not on the first line (${centre.toFixed(1)} vs ${top.toFixed(1)}+${line})`);
    }
    return { count: paragraphs.length, problems };
  }, labels);
}

/** Every way the turn headers miss their structure: a group of avatar and name alone, on a line above the text, with no time. */
async function headerProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const root of document.querySelectorAll<HTMLElement>("[data-testid='transcript-reader'] [data-turn-key]")) {
      const header = root.querySelector<HTMLElement>("[data-testid='turn-header']");
      const label = `turn ${root.getAttribute("data-turn-key")}`;
      if (header === null) continue;
      if (header.getAttribute("role") !== "group") problems.push(`${label}: header role ${header.getAttribute("role")}`);
      if (!header.hasAttribute("data-turn-header")) problems.push(`${label}: header without data-turn-header`);
      if (!header.hasAttribute("data-reader-meta")) problems.push(`${label}: header without data-reader-meta`);
      if (header.querySelector("[data-reading-time]") !== null || header.hasAttribute("data-reading-time")) problems.push(`${label}: header carries a time`);
      if (/\d:\d\d/u.test(header.textContent ?? "")) problems.push(`${label}: header text ${header.textContent}`);
      if (header.closest("p") !== null) problems.push(`${label}: header inside the paragraph`);
      if (header.querySelector("[data-testid='speaker-avatar']") === null) problems.push(`${label}: header without avatar`);
      const text = root.querySelector("p[data-reader-text]");
      if (text === null) problems.push(`${label}: no text`);
      // On a line of its own: the text starts below the header.
      else if (text.getBoundingClientRect().top < header.getBoundingClientRect().bottom - 1) problems.push(`${label}: text beside the header`);
    }
    return problems;
  });
}

/** The layouts the speaker rows use, one entry per paragraph row. */
async function layouts(page: Page): Promise<string[]> {
  return reader(page).locator("[data-turn-key]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-turn-layout") ?? "(none)"));
}

test.describe("reader layout: structure", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  /** A one-word turn, a short sentence with a note, a short one with a search hit and an unassigned sentence, around a two-paragraph turn. */
  const SEQUENCE: SpeakerSequence = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKER_STUDENT, undefined];
  const TEXTS = { 0: longSentence(0), 2: "好的。", 3: "短句。", 4: "函数呢？" };
  const NAMES = ["林老师", "发言人 2", "林老师", "发言人 2", "未分配"];

  test("turn headers name the speaker alone; every paragraph opens with its time, wide, narrow and plain; no compact rows", async ({ page }) => {
    test.setTimeout(120_000);
    await installMockBackend(page);
    const requests = speakersRequests(page);
    requests.sequence = SEQUENCE;
    requests.texts = TEXTS;
    await routeSpeakerNotes(page, [{ start: 3, startOffset: 0, end: 3, endOffset: 2 }]);
    const labels = timeLabels(sid, (index) => speakerStartMs(requests, index), SEQUENCE.length);
    const outputs = await outputsFor(page, 936);

    await open(page, { outputsWidth: outputs, query: "&search=函数" });
    // The note and the search hit are drawn: the short sentences that carry them are marked.
    await expect(sentence(page, 3).getByTestId("note-run")).toHaveText("短句");
    await expect(sentence(page, 4).locator("mark")).toHaveText("函数");
    // Two paragraphs for the first turn, then one per turn: every row wide, none compact.
    expect(await layouts(page)).toEqual(["wide", "wide", "wide", "wide", "wide", "wide"]);
    await expect(reader(page).locator("[data-turn-layout='compact']")).toHaveCount(0);
    const headers = reader(page).getByTestId("turn-header");
    await expect(headers).toHaveCount(NAMES.length);
    for (const [index, name] of NAMES.entries()) await expect(headers.nth(index)).toHaveAccessibleName(name);
    await expect(headers.nth(4).getByTestId("turn-speaker")).toHaveAttribute("data-unassigned", "true");
    // The one-word turn is laid out like any other: a header of its own above its paragraph.
    await expect(reader(page).locator("[data-turn-key]", { has: page.locator(`[data-segment-id="${sid(2)}"]`) }).getByTestId("turn-header")).toHaveCount(1);
    expect(await headerProblems(page)).toEqual([]);
    const wide = await paragraphProblems(page, labels);
    expect(wide.count).toBe(6);
    expect(wide.problems).toEqual([]);

    // A narrow pane puts the same header above the text; the paragraphs keep their times.
    const narrowOutputs = await outputsFor(page, 480);
    await open(page, { outputsWidth: narrowOutputs, query: "&search=函数" });
    expect(await layouts(page)).toEqual(["narrow", "narrow", "narrow", "narrow", "narrow", "narrow"]);
    await expect(reader(page).getByTestId("turn-header")).toHaveCount(NAMES.length);
    expect(await headerProblems(page)).toEqual([]);
    expect((await paragraphProblems(page, labels)).problems).toEqual([]);
    // The sticky marker belongs to the wide layout only.
    await reader(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(300);
    await expect(page.locator("[data-testid='turn-marker'][data-visible='true']")).toHaveCount(0);

    // 显示发言人 off: no turns, no headers, and every paragraph still opens with its time.
    await open(page, { outputsWidth: outputs, typography: { showSpeakers: false } });
    await expect(reader(page).locator("[data-turn-layout]")).toHaveCount(0);
    await expect(reader(page).getByTestId("turn-header")).toHaveCount(0);
    const plain = await paragraphProblems(page, labels);
    expect(plain.count).toBeGreaterThan(0);
    expect(plain.problems).toEqual([]);
  });

  test("a transcript without speakers opens every paragraph with its time and has no headers", async ({ page }) => {
    await installMockBackend(page);
    await open(page, { url: `/contents/${BILIBILI_CONTENT}?tab=transcript` });
    await expect(reader(page).locator("[data-turn-layout]")).toHaveCount(0);
    await expect(reader(page).getByTestId("turn-header")).toHaveCount(0);
    const result = await paragraphProblems(
      page,
      timeLabels((index) => segmentId(BILI_REVISION, index), (index) => index * 10_000, 12),
    );
    expect(result.count).toBeGreaterThan(0);
    expect(result.problems).toEqual([]);
  });

  test("a pane of 520px or more is wide, one pixel less is narrow", async ({ page }) => {
    test.setTimeout(90_000);
    await installMockBackend(page);
    const outputs = await outputsFor(page, 936);
    for (const [pane, layout] of [
      [521, "wide"],
      [520, "wide"],
      [519, "narrow"],
    ] as const) {
      // The output column and the pane differ by a constant, so the pane follows the column one for one.
      await open(page, { outputsWidth: outputs - 936 + pane });
      expect(Math.abs((await reader(page).evaluate((element) => element.getBoundingClientRect().width)) - pane)).toBeLessThanOrEqual(SNAP_PX);
      expect(new Set(await layouts(page)), `${pane}px`).toEqual(new Set([layout]));
    }
  });

  test("a time over an hour, a long speaker name and an unassigned turn keep the layout", async ({ page }) => {
    await installMockBackend(page);
    const requests = speakersRequests(page);
    // 1:02:03 for the first sentence; every later one follows ten seconds apart.
    requests.offsetMs = 3_723_000;
    requests.speakers = requests.speakers.map((speaker) => (speaker.id === SPEAKER_TEACHER ? { ...speaker, name: "林".repeat(40) } : speaker));
    await open(page, { outputsWidth: await outputsFor(page, 600) });
    await expect(timeOf(page, 0)).toHaveText("1:02:03");
    expect((await paragraphProblems(page, timeLabels(sid, (index) => speakerStartMs(requests, index), 6))).problems).toEqual([]);
    expect(await headerProblems(page)).toEqual([]);
    const headers = reader(page).getByTestId("turn-header");
    await expect(headers.first()).toHaveAccessibleName("林".repeat(40));
    await expect(headers.last()).toHaveAccessibleName("未分配");
    // The long name stays on one line inside the column: the header is no taller than its avatar and ends inside the column.
    const fit = await headers.first().evaluate((header) => {
      const avatar = header.querySelector("[data-testid='speaker-avatar']")?.getBoundingClientRect();
      const column = header.closest(".reader-column");
      const box = header.getBoundingClientRect();
      const content = column === null ? Number.NaN : column.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(column).paddingRight);
      return { height: box.height, avatar: avatar?.height ?? Number.NaN, right: box.right, content };
    });
    expect(fit.height).toBeLessThanOrEqual(fit.avatar + SNAP_PX);
    expect(fit.right).toBeLessThanOrEqual(fit.content + SNAP_PX);
  });
});

test.describe("reader layout: chapter headings", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  /** Long enough to window, with chapters close to the top and further down. */
  const CHAPTERS = [
    { start: 0, title: "第一章：开场" },
    { start: 3, title: "第二章：标题点击" },
    { start: 6, title: "第三章：播放按钮" },
    { start: 9, title: "第四章：键盘回车" },
    { start: 100, title: "第五章：键盘空格" },
    { start: 150, title: "第六章：结尾" },
  ];
  const heading = (page: Page, title: string): Locator => reader(page).getByTestId("transcript-chapter").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

  test.beforeEach(async ({ page }) => {
    await installMockBackend(page);
    const requests = speakersRequests(page);
    requests.sequence = alternating(200);
    requests.chapters = CHAPTERS;
    await open(page, { outputsWidth: 900 });
  });

  test("a heading is its title alone, the width of the column, with the play button outside the heading", async ({ page }) => {
    const shown = await reader(page).getByTestId("transcript-chapter").evaluateAll((roots) =>
      roots.map((root) => {
        const column = root.parentElement;
        const title = root.querySelector("[data-testid='chapter-title']");
        const play = root.querySelector("[data-testid='chapter-play']");
        const columnBox = column?.getBoundingClientRect();
        const style = column === null ? undefined : getComputedStyle(column);
        const contentWidth = columnBox === undefined || style === undefined ? Number.NaN : columnBox.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
        return {
          firstChild: column?.firstElementChild === root,
          indented: column?.hasAttribute("data-reader-indent") ?? false,
          widthOff: Math.abs(root.getBoundingClientRect().width - contentWidth),
          text: root.textContent,
          times: root.querySelectorAll("[data-reading-time]").length,
          inHeading: title?.closest("h3") !== null && title !== null,
          playInHeading: play?.closest("h3") !== null && play !== null,
          playMeta: play?.hasAttribute("data-reader-meta") ?? false,
          playLabel: play?.getAttribute("aria-label") ?? null,
        };
      }),
    );
    // Windowed: the headings near the top are mounted.
    expect(shown.length).toBeGreaterThanOrEqual(4);
    for (const [index, root] of shown.entries()) {
      const chapter = CHAPTERS[index];
      if (chapter === undefined) throw new Error("unexpected heading");
      expect(root).toEqual({
        firstChild: true,
        indented: true,
        widthOff: root.widthOff,
        text: chapter.title,
        times: 0,
        inHeading: true,
        playInHeading: false,
        playMeta: true,
        playLabel: `从 ${clock(speakerStartMs(speakersRequests(page), chapter.start))} 播放`,
      });
      expect(root.widthOff).toBeLessThanOrEqual(SNAP_PX);
    }
    // The heading is named by its title alone.
    await expect(page.getByRole("heading", { name: CHAPTERS[1]?.title ?? "", exact: true })).toHaveCount(1);
  });

  test("the title and the play button play from the first sentence under the heading; mouse, Enter and Space; a drag over the title does not", async ({ page }) => {
    test.setTimeout(90_000);
    const play = (title: string): Locator => heading(page, title).getByTestId("chapter-play");
    const opacity = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).opacity);
    expect(new URL(page.url()).searchParams.get("segment")).toBeNull();

    // Hidden until the heading row is hovered.
    await page.mouse.move(0, 0);
    await expect.poll(() => opacity(play("第二章：标题点击"))).toBe("0");
    await heading(page, "第二章：标题点击").hover();
    await expect.poll(() => opacity(play("第二章：标题点击"))).toBe("1");

    // A click on the title text.
    await heading(page, "第二章：标题点击").getByTestId("chapter-title").click();
    await expectSeekTo(page, 3);

    // A click on the play button.
    await play("第三章：播放按钮").click();
    await expectSeekTo(page, 6);

    // A drag over the title selects it and plays nothing.
    const before = await seekState(page);
    const ends = await heading(page, "第四章：键盘回车")
      .getByTestId("chapter-title")
      .evaluate((title) => {
        const text = document.createTreeWalker(title, NodeFilter.SHOW_TEXT).nextNode() as Text;
        const rectAt = (offset: number) => {
          const range = document.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          return range.getClientRects()[0] as DOMRect;
        };
        const first = rectAt(0);
        const last = rectAt(text.data.length - 1);
        return { from: { x: first.left + 1, y: (first.top + first.bottom) / 2 }, to: { x: last.right - 1, y: (last.top + last.bottom) / 2 } };
      });
    await page.mouse.move(ends.from.x, ends.from.y);
    await page.mouse.down();
    await page.mouse.move(ends.to.x, ends.to.y, { steps: 8 });
    await page.mouse.up();
    expect(squeeze(await page.evaluate(() => window.getSelection()?.toString() ?? ""))).toContain(squeeze("第四章：键盘回车").slice(1, -1));
    await expectNoSeek(page, before);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    // From the keyboard: Tab from the paragraph before reaches the play button, which shows itself, and Enter plays.
    await page.mouse.move(0, 0);
    await timeOf(page, 8).focus();
    await tabTo(page, play("第四章：键盘回车"));
    await expect.poll(() => opacity(play("第四章：键盘回车"))).toBe("1");
    await page.keyboard.press("Enter");
    await expectSeekTo(page, 9);

    // The outline moves the reader to a heading and plays nothing.
    const atNine = await seekState(page);
    await page.getByTestId("chapter-outline").click();
    const items = page.getByTestId("chapter-outline-item");
    await expect(items).toHaveCount(CHAPTERS.length);
    await expect(items.nth(4)).toContainText(clock(speakerStartMs(speakersRequests(page), 100)));
    await expect(items.nth(4)).toContainText("第五章：键盘空格");
    await items.nth(4).click();
    await expect(heading(page, "第五章：键盘空格")).toBeInViewport();
    const offset = await heading(page, "第五章：键盘空格").evaluate((root) => {
      const scroller = root.closest("[data-testid='transcript-reader']");
      return root.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? Number.NaN);
    });
    expect(offset).toBeGreaterThanOrEqual(-SNAP_PX);
    expect(offset).toBeLessThanOrEqual(48);
    await expectNoSeek(page, atNine);

    // Space on the play button plays as well; reached backwards from the paragraph under the heading.
    await timeOf(page, 100).focus();
    await tabTo(page, play("第五章：键盘空格"), "Shift+Tab");
    await expect.poll(() => opacity(play("第五章：键盘空格"))).toBe("1");
    await page.keyboard.press("Space");
    await expectSeekTo(page, 100);

    // A paragraph's time plays from its first sentence.
    await timeOf(page, 102).click();
    await expectSeekTo(page, 102);
  });
});

test("reader layout: under 只看 a fully filtered chapter shows no heading, and every heading shown plays from its first paragraph", async ({ page }) => {
  await installMockBackend(page);
  const requests = speakersRequests(page);
  // The middle chapter is the student's alone: picking the teacher leaves it nothing to show.
  requests.sequence = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_STUDENT, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKER_TEACHER];
  requests.chapters = [
    { start: 0, title: "开场" },
    { start: 3, title: "学生提问" },
    { start: 5, title: "总结" },
  ];
  await open(page, { outputsWidth: 900, query: `&speaker=${SPEAKER_TEACHER}` });
  await expect(page.getByTestId("speaker-filter-bar")).toBeVisible();
  const headings = await reader(page).evaluate((scroller) => {
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-row-index]")].sort((a, b) => Number(a.dataset["rowIndex"]) - Number(b.dataset["rowIndex"]));
    return rows.flatMap((row, index) => {
      const root = row.querySelector("[data-testid='transcript-chapter']");
      if (root === null) return [];
      let shown = false;
      for (const next of rows.slice(index + 1)) {
        if (next.querySelector("[data-testid='transcript-chapter']") !== null) break;
        if (next.querySelector("p[data-reader-text]") !== null) shown = true;
      }
      const play = root.querySelector("[data-testid='chapter-play']");
      return [{ title: root.textContent ?? "", shown, play: play !== null, label: play?.getAttribute("aria-label") ?? null }];
    });
  });
  // A chapter whose sentences are all filtered out shows no heading; every heading shown has a paragraph under it and plays from it.
  expect(headings.map((shown) => shown.title)).toEqual(["开场", "总结"]);
  for (const shown of headings) expect({ title: shown.title, shown: shown.shown, play: shown.play }).toEqual({ title: shown.title, shown: true, play: true });
  expect(headings.find((shown) => shown.title === "开场")?.label).toBe(`从 ${clock(0)} 播放`);
  expect(headings.find((shown) => shown.title === "总结")?.label).toBe(`从 ${clock(speakerStartMs(requests, 5))} 播放`);
  await expect(reader(page).getByRole("heading", { name: "学生提问", exact: true })).toHaveCount(0);
});

test.describe("reader layout: the sticky speaker marker", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  /**
   * Scrolls the reader from `from` to `to` in `step` px and records, through a mutation
   * observer, whether the marker was ever shown; at each step where it is shown, checks that it
   * covers no visible turn header's avatar and names the turn of the row beside it.
   */
  async function sweep(page: Page, range: { from: number; to: number; step: number }) {
    return page.evaluate(async ({ from, to, step }) => {
      const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
      const host = scroller?.parentElement;
      if (scroller == null || host == null) throw new Error("no reader");
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      let everShown = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) if (record.target instanceof Element && record.target.getAttribute("data-visible") === "true") everShown = true;
      });
      observer.observe(host, { subtree: true, attributes: true, attributeFilter: ["data-visible"] });
      if (host.querySelector("[data-testid='turn-marker'][data-visible='true']") !== null) everShown = true;
      const problems: string[] = [];
      const speakers = new Set<string>();
      let shownSteps = 0;
      const end = Math.min(to, scroller.scrollHeight - scroller.clientHeight);
      for (let y = from; y <= end; y += step) {
        scroller.scrollTop = y;
        // The marker follows the scroll on the next frames; a fade swap shows as not visible.
        await frame();
        await frame();
        await frame();
        const marker = host.querySelector<HTMLElement>("[data-testid='turn-marker']");
        if (marker?.getAttribute("data-visible") !== "true") continue;
        shownSteps += 1;
        const box = scroller.getBoundingClientRect();
        const m = marker.getBoundingClientRect();
        // A header still partly in view speaks for its turn itself: no marker beside it.
        for (const header of scroller.querySelectorAll("[data-turn-header]")) {
          const h = header.getBoundingClientRect();
          if (h.top < box.top && h.bottom > box.top) problems.push(`at ${y}: marker shown while a header is still ${(h.bottom - box.top).toFixed(1)}px in view`);
        }
        for (const avatar of scroller.querySelectorAll("[data-turn-header] [data-testid='speaker-avatar']")) {
          const a = avatar.getBoundingClientRect();
          if (a.bottom <= box.top || a.top >= box.bottom) continue;
          if (a.left < m.right && m.left < a.right && a.top < m.bottom && m.top < a.bottom) {
            problems.push(`at ${y}: marker ${m.top.toFixed(1)}–${m.bottom.toFixed(1)} over an avatar at ${a.top.toFixed(1)}–${a.bottom.toFixed(1)}`);
          }
        }
        const centre = (m.top + m.bottom) / 2;
        const beside = [...scroller.querySelectorAll<HTMLElement>("[data-turn-key]")].find((row) => {
          const r = row.getBoundingClientRect();
          return r.top <= centre && centre < r.bottom;
        });
        const named = marker.querySelector("[data-speaker-id]")?.getAttribute("data-speaker-id") ?? "(none)";
        speakers.add(named);
        if (beside !== undefined && beside.getAttribute("data-turn-speaker") !== named) {
          problems.push(`at ${y}: marker names ${named}, the row beside it is ${beside.getAttribute("data-turn-speaker")}`);
        }
      }
      observer.disconnect();
      return { everShown, shownSteps, speakers: [...speakers], problems, reached: scroller.scrollTop };
    }, range);
  }

  /** How far down the top of the `count`-th row is, in scroll px: the span of that many turns. */
  async function rowsSpan(page: Page, count: number): Promise<number> {
    return reader(page).evaluate((scroller, rows) => {
      const row = scroller.querySelector<HTMLElement>(`[data-row-index="${rows}"]`);
      if (row === null) throw new Error("row not mounted");
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    }, count);
  }

  test("one-line turns never show the marker, scrolled pixel by pixel at every size and line height", async ({ page }) => {
    test.setTimeout(240_000);
    await installMockBackend(page);
    speakersRequests(page).sequence = alternating(40);
    const problems: string[] = [];
    for (const fontSize of [12, 16, 32]) {
      for (const lineHeight of [1.5, 2.0]) {
        await open(page, { outputsWidth: 900, typography: { fontSize, lineHeight } });
        // Each turn is one line: the precondition of this test.
        const lines = await reader(page)
          .locator("p[data-reader-text]")
          .first()
          .evaluate((paragraph) => paragraph.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(paragraph).lineHeight));
        expect(lines, `${fontSize}px × ${lineHeight}`).toBeLessThan(1.5);
        const result = await sweep(page, { from: 0, to: await rowsSpan(page, 5), step: 2 });
        if (result.everShown) problems.push(`${fontSize}px × ${lineHeight}: marker shown (${result.shownSteps} steps)`);
        if (result.reached < 100) problems.push(`${fontSize}px × ${lineHeight}: only scrolled to ${result.reached}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("long turns show the marker after the header leaves, naming the speaker and never covering an avatar", async ({ page }) => {
    test.setTimeout(240_000);
    await installMockBackend(page);
    // Two long turns of several paragraphs, then short turns of a few lines each.
    // Enough short turns after them that the long ones can be scrolled to the very top.
    const triples = Array.from({ length: 30 }, (_, index) => Array<string>(3).fill(index % 2 === 0 ? SPEAKER_TEACHER : SPEAKER_STUDENT)).flat();
    speakersRequests(page).sequence = [...Array<string>(40).fill(SPEAKER_TEACHER), ...Array<string>(40).fill(SPEAKER_STUDENT), ...triples];
    const problems: string[] = [];
    for (const fontSize of [16, 32]) {
      await open(page, { outputsWidth: 900, typography: { fontSize, lineHeight: 1.7 } });
      const marker = page.getByTestId("turn-marker");
      await expect(marker).toHaveCSS("transition-duration", "0.15s");

      // Deep inside each long turn the marker names its speaker.
      for (const [index, speaker] of [
        [20, SPEAKER_TEACHER],
        [60, SPEAKER_STUDENT],
      ] as const) {
        await sentence(page, index).evaluate((element) => {
          const scroller = element.closest<HTMLElement>("[data-testid='transcript-reader']");
          if (scroller !== null) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
        await expect(marker).toHaveAttribute("data-visible", "true");
        await expect(marker.locator("[data-speaker-id]")).toHaveAttribute("data-speaker-id", speaker);
        await expect.poll(() => marker.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      }

      // Back at the start, from deep inside a long turn: the first turn's header shows again, so
      // the marker goes, although the rows of the start are mounted only after the jump's scroll event.
      await reader(page).evaluate((scroller) => (scroller.scrollTop = 0));
      await expect(marker).toHaveAttribute("data-visible", "false");

      // Both long turns and ten of the short ones after them.
      const result = await sweep(page, { from: 0, to: await rowsSpan(page, 16), step: 4 });
      problems.push(...result.problems.map((problem) => `${fontSize}px ${problem}`));
      if (result.shownSteps === 0) problems.push(`${fontSize}px: the marker never showed`);
      if (!(result.speakers.includes(SPEAKER_TEACHER) && result.speakers.includes(SPEAKER_STUDENT))) problems.push(`${fontSize}px: speakers named ${result.speakers.join(",")}`);
    }
    expect(problems).toEqual([]);
  });
});

test("reader layout: a turn whose first paragraph is one line gets the marker only once its header has fully left", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installMockBackend(page);
  const requests = speakersRequests(page);
  // The student answers, then the teacher speaks a one-line paragraph followed by a long one.
  // Short turns after it give the reader room to scroll the teacher's header past the top.
  requests.sequence = [SPEAKER_STUDENT, ...Array<string>(40).fill(SPEAKER_TEACHER), SPEAKER_STUDENT, SPEAKER_STUDENT, ...alternating(40)];
  requests.texts = { 0: "好的。", 1: "我们开始。" };
  requests.paragraphStarts = new Set([0, 1, 2, 41, ...Array.from({ length: 40 }, (_, index) => 43 + index)]);
  const marker = page.getByTestId("turn-marker");
  const turn = reader(page).locator("[data-turn-key]", { has: page.locator(`[data-segment-id="${sid(1)}"]`) });
  for (const fontSize of [12, 16, 32]) {
    await open(page, { outputsWidth: 900, typography: { fontSize, lineHeight: 1.7 } });
    // The precondition: the turn's first paragraph is one line and the turn goes on in a long second one.
    const shape = await reader(page).evaluate((scroller, ids) => {
      const paragraphOfId = (id: string) => scroller.querySelector(`[data-segment-id="${id}"]`)?.closest("p");
      const first = paragraphOfId(ids[0] ?? "");
      const second = paragraphOfId(ids[1] ?? "");
      const lines = (paragraph: Element | null | undefined) => (paragraph == null ? Number.NaN : paragraph.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(paragraph).lineHeight));
      return { first: lines(first), second: lines(second), sameTurn: first?.closest("[data-turn-key]")?.getAttribute("data-turn-key") === second?.closest("[data-turn-key]")?.getAttribute("data-turn-key") };
    }, [sid(1), sid(2)]);
    expect(shape.first, `${fontSize}px`).toBeLessThan(1.5);
    expect(shape.second, `${fontSize}px`).toBeGreaterThan(3);
    expect(shape.sameTurn).toBe(true);

    /** Scrolls so the teacher's header ends `below` px under the reader's top edge (negative: above it). */
    const placeHeader = async (below: number): Promise<void> => {
      const reached = await turn.getByTestId("turn-header").evaluate((header, offset) => {
        const scroller = header.closest<HTMLElement>("[data-testid='transcript-reader']");
        if (scroller === null) throw new Error("no reader");
        scroller.scrollTop += header.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top - offset;
        return header.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
      }, below);
      expect(Math.abs(reached - below), `${fontSize}px: header placed at ${reached}, want ${below}`).toBeLessThanOrEqual(SNAP_PX);
    };
    for (const below of [12, 4, 1]) {
      await placeHeader(below);
      await page.waitForTimeout(250);
      await expect(marker, `${fontSize}px, header ${below}px in view`).toHaveAttribute("data-visible", "false");
    }
    // Across the header leaving, pixel by pixel: never a marker while any of it shows.
    const start = await reader(page).evaluate((scroller) => scroller.scrollTop);
    const result = await (async () => {
      const header = await turn.getByTestId("turn-header").boundingBox();
      if (header === null) throw new Error("no header");
      return page.evaluate(
        async ({ from, to }) => {
          const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
          if (scroller === null) throw new Error("no reader");
          const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const problems: string[] = [];
          for (let y = from; y <= to; y += 1) {
            scroller.scrollTop = y;
            await frame();
            await frame();
            await frame();
            const shown = scroller.parentElement?.querySelector("[data-testid='turn-marker']")?.getAttribute("data-visible") === "true";
            const box = scroller.getBoundingClientRect();
            const straddling = [...scroller.querySelectorAll("[data-turn-header]")].some((element) => {
              const h = element.getBoundingClientRect();
              return h.top < box.top && h.bottom > box.top;
            });
            if (shown && straddling) problems.push(`at ${y}: marker over a header still in view`);
          }
          return problems;
        },
        { from: start - Math.ceil(header.height) - 8, to: start + 8 },
      );
    })();
    expect(result, `${fontSize}px`).toEqual([]);
    // Fully gone: the one-line first paragraph has too little left, the second paragraph speaks for the turn.
    await placeHeader(-1);
    await expect(marker, `${fontSize}px, header gone`).toHaveAttribute("data-visible", "true");
    await expect(marker.locator("[data-speaker-id]")).toHaveAttribute("data-speaker-id", SPEAKER_TEACHER);
  }
});

test.describe("reader layout: selections", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("「解释」 across two turns takes the sentences' words, without names or times", async ({ page }) => {
    await installMockBackend(page);
    await open(page, { outputsWidth: 900 });
    // From inside the teacher's sentence 2 into the student's sentence 3, over the student's header.
    await dragSelect(page, { segment: sid(1), offset: 2 }, { segment: sid(2), offset: 5 });
    const text = await explained(page);
    expect(squeeze(text)).toBe(squeeze(`${textOf(page, 1).slice(2)}${textOf(page, 2).slice(0, 5)}`));
    expect(text).not.toMatch(/林老师|发言人 2|\d:\d\d/u);
  });

  test("「解释」 across a chapter heading includes the title", async ({ page }) => {
    await installMockBackend(page);
    speakersRequests(page).chapters = [
      { start: 0, title: "开场" },
      { start: 2, title: "第二章：提问环节" },
    ];
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { segment: sid(1), offset: 2 }, { segment: sid(2), offset: 5 });
    const text = await explained(page);
    expect(squeeze(text)).toBe(squeeze(`${textOf(page, 1).slice(2)}第二章：提问环节${textOf(page, 2).slice(0, 5)}`));
  });

  test("「解释」 over rows a windowed reader unmounts during the drag keeps every sentence and no name or time", async ({ page }) => {
    // A known defect: 「解释」 reads its text off the page, and a windowed reader has unmounted the
    // rows between the two ends of a long drag, so their sentences are missing. Expected to fail
    // until the text is taken from the sentences the selection covers; it then reports as passing
    // unexpectedly, which is the cue to drop this line.
    test.fail(true, "「解释」 loses the sentences of rows a windowed reader has unmounted");
    await installMockBackend(page);
    speakersRequests(page).sequence = alternating(3000);
    const first = 1500;
    // Far enough that the rows next to the start leave the window's overscan.
    const last = first + 40;
    await open(page, { outputsWidth: 900, query: `&segment=${sid(first)}` });
    await expect(sentence(page, first)).toBeVisible();
    // Windowed: the rows near the top are not mounted.
    await expect(sentence(page, 0)).toHaveCount(0);

    const start = await boundaryPoint(page, sid(first), 2, "before");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y, { steps: 3 });
    const box = await reader(page).boundingBox();
    if (box === null) throw new Error("reader not laid out");
    for (let turn = 0; turn < 60; turn += 1) {
      const top = await sentence(page, last)
        .evaluate((element) => element.getBoundingClientRect().top, undefined, { timeout: 200 })
        .catch(() => Number.POSITIVE_INFINITY);
      if (top > box.y && top < box.y + box.height / 2) break;
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(50);
    }
    // The start row is out of view, and its neighbours have been windowed away.
    expect(await sentence(page, first).evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThan(box.y);
    await expect(sentence(page, first + 1)).toHaveCount(0);
    const end = await boundaryPoint(page, sid(last), 4, "after");
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();

    const text = await explained(page);
    const expected = Array.from({ length: last - first + 1 }, (_, step) => first + step)
      .map((index) => (index === first ? textOf(page, index).slice(2) : index === last ? textOf(page, index).slice(0, 4) : textOf(page, index)))
      .join("");
    expect(squeeze(text)).toBe(squeeze(expected));
  });

  test("a note from a selection across two turns anchors on the sentences either side", async ({ page }) => {
    await installMockBackend(page);
    const notes = await routeSpeakerNotes(page);
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { segment: sid(1), offset: 2 }, { segment: sid(2), offset: 5 });
    await page.getByTestId("selection-note-underline").click();
    await expect.poll(() => notes.posts.length).toBe(1);
    expect(notes.posts[0]).toMatchObject({ transcriptRevisionId: SPEAKERS_REVISION, startSegmentId: sid(1), startOffset: 2, endSegmentId: sid(2), endOffset: 5, mark: "underline" });
    await expect(sentence(page, 1).getByTestId("note-run")).toHaveText(textOf(page, 1).slice(2));
    await expect(sentence(page, 2).getByTestId("note-run")).toHaveText(textOf(page, 2).slice(0, 5));
  });

  test("「复制」 copies the selected words of both turns", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockBackend(page);
    await open(page, { outputsWidth: 900 });
    await dragSelect(page, { segment: sid(1), offset: 2 }, { segment: sid(2), offset: 5 });
    await page.getByTestId("selection-toolbar").getByTestId("selection-copy").click();
    const copied = squeeze(await page.evaluate(() => navigator.clipboard.readText()));
    const tail = squeeze(textOf(page, 1).slice(2));
    const head = squeeze(textOf(page, 2).slice(0, 5));
    expect(copied).toContain(tail);
    expect(copied).toContain(head);
    expect(copied.indexOf(tail)).toBeLessThan(copied.indexOf(head));
  });
});
