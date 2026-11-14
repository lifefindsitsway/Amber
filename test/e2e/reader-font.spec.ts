import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey, type ReaderFont } from "../../src/shared/reader-typography.ts";
import { installMockBackend } from "./mock-backend.ts";
import { SPEAKERS_CONTENT, speakerSentence, speakersRequests } from "./mock-speakers.ts";

// The bundled fonts as the dev setup places them; the CI e2e job restores the same directory.
const FONTS_DIR = join(import.meta.dirname, "..", "..", ".amber-tools", "fonts");

/** Serves the reading fonts from the dev tools directory and records every font request. */
async function serveFonts(page: Page, options: { failKai?: boolean } = {}): Promise<string[]> {
  const requested: string[] = [];
  await page.route("**/api/fonts/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    if (path === "/api/fonts/reader/kai" && options.failKai === true) return route.fulfill({ status: 404, json: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } });
    const file = { "/api/fonts/subtitle": "NotoSansSC-Regular.otf", "/api/fonts/reader/serif": "NotoSerifSC-Regular.otf", "/api/fonts/reader/kai": "LXGWWenKaiLite-Regular.ttf" }[path];
    if (file === undefined) return route.fulfill({ status: 404 });
    return route.fulfill({ path: join(FONTS_DIR, file), headers: { "content-type": file.endsWith(".ttf") ? "font/ttf" : "font/otf", "cache-control": "private, no-cache" } });
  });
  return requested;
}

/** The computed font families of the body text, the UI around it and the page itself. */
async function families(page: Page): Promise<{ body: string; sentence: string; names: string[]; times: string[] }> {
  return page.evaluate((text) => {
    const family = (element: Element): string => getComputedStyle(element).fontFamily;
    // Empty while the reading view has not drawn the sentence yet (after a reload), so a poll keeps waiting.
    const sentence = [...document.querySelectorAll("[data-segment-id]")].find((element) => element.textContent === text);
    return {
      body: family(document.body),
      sentence: sentence === undefined ? "" : family(sentence),
      names: [...document.querySelectorAll("[data-testid='turn-speaker']")].map(family),
      times: [...document.querySelectorAll("[data-reading-time]")].map(family),
    };
  }, speakerSentence(0));
}

async function openPanel(page: Page) {
  const panel = page.getByTestId("reader-typography-popover");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Aa 阅读排版" }).click();
  return panel;
}

test("reader font: the default reads no font and draws as before; bundled faces apply to the sentences only, survive a reload and reset", async ({ page }) => {
  await installMockBackend(page);
  const requested = await serveFonts(page, { failKai: true });
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript`);
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();

  // The default: the sentence inherits the page's font, and no font is read.
  const before = await families(page);
  expect(before.sentence).toBe(before.body);
  const panel = await openPanel(page);
  await expect(panel.getByRole("radio", { name: "默认" })).toBeChecked();
  expect(requested).toEqual([]);
  await expect(page.locator("[data-reader-font]")).toHaveCount(0);

  // 宋体 is read, then applied to the sentences; names and times keep the UI font.
  await panel.getByRole("radio", { name: "宋体" }).click({ force: true });
  await expect(panel.getByRole("radio", { name: "宋体" })).toBeChecked({ timeout: 15_000 });
  expect(requested).toEqual(["/api/fonts/reader/serif"]);
  const serif = await families(page);
  expect(serif.sentence).toMatch(/^"Amber Latin Quotes", "Noto Serif SC", /u);
  expect(serif.names).toEqual(before.names);
  expect(serif.times).toEqual(before.times);
  expect(await page.evaluate(() => document.fonts.check('16px "Noto Serif SC"', "永"))).toBe(true);

  // A face that cannot be read leaves the font in use and says so.
  await panel.getByRole("radio", { name: "楷体" }).click({ force: true });
  await expect(panel.getByTestId("reader-font-failed")).toHaveText("字体加载失败");
  await expect(panel.getByRole("radio", { name: "宋体" })).toBeChecked();
  expect((await families(page)).sentence).toBe(serif.sentence);

  // A reload keeps 宋体: it is read again and applied once ready.
  await page.reload();
  await expect.poll(async () => (await families(page)).sentence, { timeout: 15_000 }).toBe(serif.sentence);

  // 恢复默认 puts the text back in the page's font.
  await (await openPanel(page)).getByTestId("reader-typography-reset").click();
  await expect.poll(async () => (await families(page)).sentence).toBe(before.sentence);
  await expect(page.locator("[data-reader-font]")).toHaveCount(0);
});

test("reader font: 自选 takes a local font name, hints whether it is installed and puts it first", async ({ page }) => {
  await installMockBackend(page);
  const requested = await serveFonts(page);
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript`);
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
  const before = await families(page);
  const panel = await openPanel(page);
  await panel.getByRole("radio", { name: "自选" }).click({ force: true });
  const input = panel.getByRole("textbox", { name: "本机字体名" });
  await input.fill("Amber No Such Font");
  await expect(panel.getByTestId("reader-custom-font-status")).toHaveText("未检测到，仍可使用；本机没有这个字体时显示默认字体");
  await expect.poll(async () => (await families(page)).sentence).toBe(`"Amber No Such Font", ${before.body}`);
  await input.fill("a;b");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect.poll(async () => (await families(page)).sentence).toBe(`"Amber No Such Font", ${before.body}`);
  expect(requested).toEqual([]);

  // A font the page can draw with is found by the measurement: here the bundled serif face, once read.
  await panel.getByRole("radio", { name: "宋体" }).click({ force: true });
  await expect(panel.getByRole("radio", { name: "宋体" })).toBeChecked({ timeout: 15_000 });
  await panel.getByRole("radio", { name: "自选" }).click({ force: true });
  await expect(input).toHaveValue("Amber No Such Font");
  await input.fill("Noto Serif SC");
  await expect(panel.getByTestId("reader-custom-font-status")).toHaveText("已找到");
});


/** Vertical extent of a box, in CSS px from the top of the viewport. */
interface Span {
  top: number;
  bottom: number;
  centre: number;
}

/** One paragraph of the reader: where its time and first line of text sit, and the lines it is set on. */
interface ParagraphBoxes {
  /** A turn's first paragraph (under the header), a later paragraph of a turn, or a paragraph without turns. */
  kind: "first" | "follow" | "plain";
  segmentId: string;
  /** The first line box the text is set in: the paragraph's content top plus one computed line height. */
  line: Span;
  /** The first character of the paragraph's first sentence. */
  glyph: Span;
  timeBaseline: number;
  textBaseline: number;
  timeSize: string;
  /** One computed line, and the tops of the distinct lines the sentences' glyphs are set on, in order. */
  lineHeight: number;
  lineTops: number[];
  /** The paragraph's content box: its height, and its left edge, where the time and so the text start. */
  contentHeight: number;
  left: number;
}

/** A turn header: its avatar, its name, and the text of its row below it. */
interface HeaderBoxes {
  avatar: Span & { left: number; right: number };
  name: Span;
  /** The left edge of the name's first character. */
  nameLeft: number;
  bottom: number;
  textTop: number;
  textLeft: number;
}

/** A chapter heading: its title's type and left edge, and the space its row keeps above and below the title. */
interface ChapterBoxes {
  first: boolean;
  size: number;
  weight: number;
  left: number;
  above: number;
  below: number;
}

interface Measured {
  paragraphs: ParagraphBoxes[];
  headers: HeaderBoxes[];
  chapters: ChapterBoxes[];
  /** Space from a paragraph's text to what the next row starts with: the next turn's header, or the turn's next paragraph. */
  gaps: Array<{ after: "turn" | "paragraph"; px: number; at: string }>;
  /** Where a turn's line stops short: between two rows of the turn, or above the end of its last paragraph's text. */
  lineBreaks: Array<{ at: string; px: number }>;
  /** Horizontal centres of the turn lines. */
  lineCentres: number[];
}

/**
 * Measures every row of the reader. A baseline is read from an empty inline-block put in for
 * the measurement and taken out at once: such a box sits with its bottom edge on the baseline of
 * the line it is in.
 */
async function measureRows(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    const span = (rect: DOMRect): Span => ({ top: rect.top, bottom: rect.bottom, centre: (rect.top + rect.bottom) / 2 });
    const px = (value: string): number => Number.parseFloat(value) || 0;
    /** The first non-blank text node inside `element`, outside anything matching `skip`. */
    const firstText = (element: Element, skip?: string): Text => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          (node.textContent ?? "").trim() === "" || (skip !== undefined && node.parentElement?.closest(skip) != null) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
      });
      const node = walker.nextNode();
      if (node === null) throw new Error("no text");
      return node as Text;
    };
    const firstGlyph = (node: Text): DOMRect => {
      const offset = (node.textContent ?? "").search(/\S/u);
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getClientRects()[0];
      if (rect === undefined) throw new Error("no glyph box");
      return rect;
    };
    const baselineOf = (node: Text): number => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0";
      node.before(probe);
      const baseline = probe.getBoundingClientRect().bottom;
      probe.remove();
      return baseline;
    };
    const contentBox = (element: Element): { top: number; bottom: number; left: number } => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { top: rect.top + px(style.paddingTop) + px(style.borderTopWidth), bottom: rect.bottom - px(style.paddingBottom) - px(style.borderBottomWidth), left: rect.left + px(style.paddingLeft) + px(style.borderLeftWidth) };
    };
    const measureParagraph = (paragraph: Element, kind: ParagraphBoxes["kind"]): ParagraphBoxes => {
      const sentence = paragraph.querySelector("[data-segment-id]");
      const time = paragraph.querySelector("button[data-reading-time]");
      if (sentence === null) throw new Error("paragraph without a sentence");
      const box = contentBox(paragraph);
      const lineHeight = px(getComputedStyle(paragraph).lineHeight);
      const tops: number[] = [];
      for (const run of paragraph.querySelectorAll("[data-segment-id]")) {
        const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) if (rect.width > 0) tops.push(rect.top);
        }
      }
      const lineTops = tops.sort((a, b) => a - b).filter((top, index, all) => index === 0 || top - (all[index - 1] as number) > 2);
      const text = firstText(sentence);
      return {
        kind,
        segmentId: sentence.getAttribute("data-segment-id") ?? "",
        line: { top: box.top, bottom: box.top + lineHeight, centre: box.top + lineHeight / 2 },
        glyph: span(firstGlyph(text)),
        timeBaseline: time === null ? Number.NaN : baselineOf(firstText(time)),
        textBaseline: baselineOf(text),
        timeSize: time === null ? "(no time)" : getComputedStyle(time).fontSize,
        lineHeight,
        lineTops,
        contentHeight: box.bottom - box.top,
        left: box.left,
      };
    };
    const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
    if (scroller === null) throw new Error("no reader");
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-row-index]")].sort((a, b) => Number(a.dataset["rowIndex"]) - Number(b.dataset["rowIndex"]));
    const measured: Measured = { paragraphs: [], headers: [], chapters: [], gaps: [], lineBreaks: [], lineCentres: [] };
    rows.forEach((row, index) => {
      const content = row.querySelector(".reader-column")?.firstElementChild;
      if (content == null) return;
      if (content.matches("[data-testid='transcript-chapter']")) {
        const title = content.querySelector("[data-testid='chapter-title']");
        if (title === null) throw new Error("heading without a title");
        const style = getComputedStyle(title);
        const box = title.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        measured.chapters.push({ first: index === 0, size: px(style.fontSize), weight: Number(style.fontWeight), left: firstGlyph(firstText(title)).left, above: box.top - rowBox.top, below: rowBox.bottom - box.bottom });
        return;
      }
      if (content.matches("p[data-reader-text]")) {
        measured.paragraphs.push(measureParagraph(content, "plain"));
        return;
      }
      const root = content.matches("[data-turn-key]") ? content : null;
      const paragraph = root?.querySelector("p[data-reader-text]");
      if (root == null || paragraph == null) return;
      const header = root.querySelector("[data-testid='turn-header']");
      const text = contentBox(paragraph);
      measured.paragraphs.push(measureParagraph(paragraph, header === null ? "follow" : "first"));
      if (header !== null) {
        const avatar = header.querySelector("[data-testid='speaker-avatar']");
        if (avatar === null) throw new Error("turn header without an avatar");
        const name = firstText(header, "[data-testid='speaker-avatar']");
        const avatarBox = avatar.getBoundingClientRect();
        measured.headers.push({
          avatar: { ...span(avatarBox), left: avatarBox.left, right: avatarBox.right },
          name: span((name.parentElement as Element).getBoundingClientRect()),
          nameLeft: firstGlyph(name).left,
          bottom: header.getBoundingClientRect().bottom,
          textTop: text.top,
          textLeft: text.left,
        });
      }
      const line = root.querySelector("[data-testid='turn-line']");
      if (line !== null) {
        const lineBox = line.getBoundingClientRect();
        measured.lineCentres.push((lineBox.left + lineBox.right) / 2);
      }
      // What the next row starts with decides the gap after this paragraph.
      const next = rows[index + 1]?.querySelector(".reader-column")?.firstElementChild;
      const nextRoot = next?.matches("[data-turn-key]") === true ? next : null;
      const at = paragraph.querySelector("[data-segment-id]")?.getAttribute("data-segment-id") ?? "";
      const nextHeader = nextRoot?.querySelector("[data-testid='turn-header']") ?? null;
      const nextParagraph = nextRoot?.querySelector("p[data-reader-text]") ?? null;
      if (nextRoot != null && nextHeader !== null) measured.gaps.push({ after: "turn", px: nextHeader.getBoundingClientRect().top - text.bottom, at });
      else if (nextRoot != null && nextParagraph !== null) measured.gaps.push({ after: "paragraph", px: contentBox(nextParagraph).top - text.bottom, at });
      if (line !== null) {
        const nextLine = nextHeader === null ? (nextRoot?.querySelector("[data-testid='turn-line']") ?? null) : null;
        // Within a turn the line runs on into the next row; at the turn's end it reaches the end of the text.
        if (nextLine !== null) measured.lineBreaks.push({ at, px: nextLine.getBoundingClientRect().top - line.getBoundingClientRect().bottom });
        else measured.lineBreaks.push({ at: `${at} (end)`, px: text.bottom - line.getBoundingClientRect().bottom });
      }
    });
    return measured;
  });
}

/** Rounding of a box edge to the device pixel grid, in CSS px; the checks below allow one such step. */
const SNAP_PX = 1;
/** The least height a paragraph time's clickable area must have, in CSS px. */
const TIME_HIT_MIN_PX = 24;
/** The chapter title's size at a reading size: 1.25 times it, within 18 and 36 px. */
const chapterTitleSize = (size: number): number => Math.min(36, Math.max(18, 1.25 * size));

/**
 * What "aligned" means for the rows, as a list of violations (empty when aligned):
 * - every paragraph's time sits on the baseline of its first line of text, in 12px, and does not
 *   make that line taller than the others: the lines follow one another at the line height;
 * - a header centres avatar and name on one axis, ends above its text, and starts the name at the
 *   text's left edge, as the chapter titles do; the avatars and the turn lines share one column;
 * - a turn keeps 1em after its last paragraph and 0.75em between paragraphs, its line unbroken;
 * - a chapter title is set at the clamped size, semibold, with 1.5em above (0.25em as the first row) and 0.5em below.
 */
function alignmentProblems(m: Measured, size: number, mode: "speakers" | "plain"): string[] {
  const problems: string[] = [];
  const near = (what: string, a: number, b: number, tolerance = SNAP_PX): void => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > tolerance) problems.push(`${what}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);
  };
  const kinds = mode === "speakers" ? (["first", "follow"] as const) : (["plain"] as const);
  for (const kind of kinds) if (!m.paragraphs.some((paragraph) => paragraph.kind === kind)) problems.push(`no ${kind} paragraph measured`);
  if (!m.paragraphs.some((paragraph) => paragraph.lineTops.length >= 3)) problems.push("no paragraph of three lines or more measured");
  for (const paragraph of m.paragraphs) {
    const at = `${paragraph.kind} ${paragraph.segmentId}`;
    near(`${at} time baseline / text baseline`, paragraph.timeBaseline, paragraph.textBaseline);
    if (paragraph.timeSize !== "12px") problems.push(`${at}: time size ${paragraph.timeSize}`);
    // The text's first character is drawn on the first line, not pushed down by the time before it.
    if (paragraph.glyph.top < paragraph.line.top - SNAP_PX || paragraph.glyph.bottom > paragraph.line.bottom + SNAP_PX) problems.push(`${at}: first character outside the first line`);
    paragraph.lineTops.slice(1).forEach((top, index) => near(`${at} line ${index + 2} pitch`, top - (paragraph.lineTops[index] as number), paragraph.lineHeight));
    near(`${at} height of ${paragraph.lineTops.length} lines`, paragraph.contentHeight, paragraph.lineTops.length * paragraph.lineHeight);
  }
  const textLeft = m.paragraphs[0]?.left ?? Number.NaN;
  if (mode === "speakers") {
    if (m.headers.length === 0) problems.push("no header measured");
    const avatarLeft = m.headers[0]?.avatar.left ?? Number.NaN;
    const avatarAxis = m.headers[0] === undefined ? Number.NaN : (m.headers[0].avatar.left + m.headers[0].avatar.right) / 2;
    for (const header of m.headers) {
      near("header avatar / name", header.avatar.centre, header.name.centre);
      if (header.bottom > header.textTop + SNAP_PX) problems.push("header overlaps the text");
      near("name left / text left", header.nameLeft, header.textLeft);
      near("avatar left / first avatar left", header.avatar.left, avatarLeft);
    }
    for (const centre of m.lineCentres) near("turn line / avatar axis", centre, avatarAxis);
    for (const after of ["turn", "paragraph"] as const) if (!m.gaps.some((gap) => gap.after === after)) problems.push(`no gap after a ${after} measured`);
    for (const gap of m.gaps) near(`gap after the ${gap.after} of ${gap.at}`, gap.px, (gap.after === "turn" ? 1 : 0.75) * size);
    if (!m.lineBreaks.some((entry) => !entry.at.endsWith("(end)"))) problems.push("no turn line across two rows measured");
    for (const entry of m.lineBreaks) if (entry.px > SNAP_PX) problems.push(`turn line breaks at ${entry.at} by ${entry.px.toFixed(2)}`);
  }
  if (!m.chapters.some((chapter) => chapter.first) || !m.chapters.some((chapter) => !chapter.first)) problems.push("not both a first and a later chapter heading measured");
  for (const chapter of m.chapters) {
    const at = chapter.first ? "first chapter" : "chapter";
    near(`${at} title size`, chapter.size, chapterTitleSize(size), 0.5);
    if (!(chapter.weight >= 600)) problems.push(`${at} title weight ${chapter.weight}`);
    near(`${at} title left / text left`, chapter.left, textLeft);
    near(`${at} space above`, chapter.above, (chapter.first ? 0.25 : 1.5) * size);
    near(`${at} space below`, chapter.below, 0.5 * size);
  }
  return problems;
}

/**
 * How tall each paragraph time's clickable area is: scrolled into view, the page is asked which
 * element is under points above and below the middle of the time's glyphs, half a pixel apart.
 */
async function timeHitHeights(page: Page): Promise<Array<{ at: string; height: number }>> {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
    if (scroller === null) throw new Error("no reader");
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const heights: Array<{ at: string; height: number }> = [];
    for (const button of scroller.querySelectorAll<HTMLElement>("p[data-reader-text] button[data-reading-time]")) {
      button.scrollIntoView({ block: "center" });
      await frame();
      await frame();
      const range = document.createRange();
      range.selectNodeContents(button);
      const glyphs = range.getClientRects()[0];
      if (glyphs === undefined) continue;
      const x = (glyphs.left + glyphs.right) / 2;
      const middle = (glyphs.top + glyphs.bottom) / 2;
      const hits = (y: number): boolean => {
        const element = document.elementFromPoint(x, y);
        return element !== null && (element === button || button.contains(element));
      };
      let top = middle;
      let bottom = middle;
      if (hits(middle)) {
        while (top - 0.5 > middle - 40 && hits(top - 0.5)) top -= 0.5;
        while (bottom + 0.5 < middle + 40 && hits(bottom + 0.5)) bottom += 0.5;
      }
      heights.push({ at: button.closest("p")?.querySelector("[data-segment-id]")?.getAttribute("data-segment-id") ?? "", height: hits(middle) ? bottom - top : 0 });
    }
    scroller.scrollTop = 0;
    await frame();
    return heights;
  });
}

/** The width the content page remembers for its output column, set before the page loads. */
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
const OUTPUTS_WIDTH_PX = 900;

const PRESETS: ReadonlyArray<ReaderFont | undefined> = [undefined, "sans", "serif", "kai", "custom"];
const SIZES = [12, 16, 24, 32] as const;
// A font this machine may or may not have: either way the name is used and the stack falls through.
const CUSTOM_FONT = "DejaVu Serif";
/** A first sentence long enough to close its paragraph (paragraphs end after 200 characters at a sentence end) and to run over several lines. */
const LONG_FIRST = `${speakerSentence(0)}${"这一段讲解很长，用来让同一轮的第一段占满好几行文字，".repeat(9)}到此为止。`;

for (const scale of [1, 2]) {
  test.describe(`reader font alignment at ${scale * 100}%`, () => {
    test.use({ deviceScaleFactor: scale, viewport: { width: 1920, height: 1080 } });

    test("keeps time and text on one baseline, the header centred and every left edge shared, for every font and size", async ({ page }) => {
      test.setTimeout(240_000);
      await installMockBackend(page);
      await serveFonts(page);
      const requests = speakersRequests(page);
      // The teacher's first turn gets two paragraphs (a first and a later one); the student answers in one word.
      requests.texts = { 0: LONG_FIRST, 2: "好的。" };
      // A chapter opens the list and another starts mid-way, so both heading spacings are measured.
      requests.chapters = [
        { start: 0, title: "第一章：开场白" },
        { start: 3, title: "第二章：继续讲解" },
      ];
      await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript`);
      await expect(page.getByText(speakerSentence(1), { exact: true })).toBeVisible();
      const problems: string[] = [];
      const check = (label: string, measured: Measured, size: number, mode: "speakers" | "plain"): void => {
        problems.push(...alignmentProblems(measured, size, mode).map((problem) => `${label}: ${problem}`));
      };
      const checkHits = async (label: string): Promise<void> => {
        const heights = await timeHitHeights(page);
        if (heights.length === 0) problems.push(`${label}: no time measured`);
        for (const entry of heights) if (entry.height < TIME_HIT_MIN_PX - SNAP_PX) problems.push(`${label}: time of ${entry.at} clickable over ${entry.height}px`);
      };
      for (const preset of PRESETS) {
        const stored = { ...READER_TYPOGRAPHY_DEFAULTS, fontSize: SIZES[0], showSpeakers: true, ...(preset === undefined ? {} : { font: preset }), ...(preset === "custom" ? { customFont: CUSTOM_FONT } : {}) };
        await page.evaluate(
          ([key, value, widthKey, width]) => {
            localStorage.setItem(key, value);
            localStorage.setItem(widthKey, width);
          },
          [readerTypographyKey("local"), JSON.stringify(stored), OUTPUTS_WIDTH_KEY, String(OUTPUTS_WIDTH_PX)] as const,
        );
        await page.reload();
        await expect(page.getByText(speakerSentence(1), { exact: true })).toBeVisible();
        if (preset === undefined) await expect(page.locator("[data-reader-font]")).toHaveCount(0);
        else await expect(page.locator(`[data-reader-font='${preset}']`)).toHaveCount(1, { timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        for (const size of SIZES) {
          const label = `${preset ?? "default"} ${size}px`;
          const panel = await openPanel(page);
          await panel.getByTestId("reader-font-size").fill(String(size));
          await expect(page.locator("[data-turn-layout='wide']").first()).toHaveCSS("font-size", `${size}px`);
          // Every paragraph row is laid out wide, the one-word turn included.
          await expect(page.locator("[data-turn-layout='wide']")).toHaveCount(5);
          await expect(page.locator("[data-turn-layout]:not([data-turn-layout='wide'])")).toHaveCount(0);
          check(label, await measureRows(page), size, "speakers");
          // The open panel would stand between the pointer and the rows it hit-tests.
          await page.keyboard.press("Escape");
          await expect(panel).toBeHidden();
          await checkHits(label);
          await (await openPanel(page)).getByRole("switch", { name: "显示发言人" }).click({ force: true });
          await expect(page.locator("[data-turn-layout]")).toHaveCount(0);
          check(`${label} without speakers`, await measureRows(page), size, "plain");
          await page.keyboard.press("Escape");
          await expect(panel).toBeHidden();
          await checkHits(`${label} without speakers`);
          await (await openPanel(page)).getByRole("switch", { name: "显示发言人" }).click({ force: true });
          await expect(page.locator("[data-turn-layout='wide']")).toHaveCount(5);
        }
      }
      expect(problems).toEqual([]);
    });
  });
}
