import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey, type ReaderFont } from "../../src/shared/reader-typography.ts";
import { installMockBackend } from "./mock-backend.ts";
import { SPEAKERS_CONTENT, SPEAKERS_REVISION, speakerSegmentPage, speakerSentence } from "./mock-speakers.ts";

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

/** Vertical position of one part of a row, in CSS px from the top of the viewport. */
interface Span {
  top: number;
  bottom: number;
  centre: number;
}

/** One measured row: where its avatar, name, time and first line of text sit. */
interface RowBoxes {
  layout: "compact" | "wide" | "follow" | "plain";
  /** The first line box the row's text is set in: the paragraph's top plus one computed line height. */
  line: Span;
  /** The first character of the row's first sentence. */
  glyph: Span;
  /** The baselines of the time, the name (compact rows) and the text, where they share a line. */
  timeBaseline?: number;
  nameBaseline?: number;
  textBaseline: number;
  avatar?: Span;
  /** A wide row's header: its avatar, name label and time, and its bottom edge. */
  header?: { avatar: Span; name: Span; time: Span; bottom: number };
}

/**
 * Measures every speaker row (compact and wide) and, without turns, every plain paragraph. A
 * baseline is read from an empty inline-block put in for the measurement and taken out at once:
 * such a box sits with its bottom edge on the baseline of the line it is in.
 */
async function measureRows(page: Page): Promise<RowBoxes[]> {
  return page.evaluate(() => {
    const span = (rect: DOMRect): Span => ({ top: rect.top, bottom: rect.bottom, centre: (rect.top + rect.bottom) / 2 });
    const boxOf = (element: Element): Span => span(element.getBoundingClientRect());
    const firstText = (element: Element): Text => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: (node) => ((node.textContent ?? "").trim() === "" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT) });
      const node = walker.nextNode();
      if (node === null) throw new Error("no text");
      return node as Text;
    };
    const firstGlyph = (element: Element): Span => {
      const node = firstText(element);
      const offset = (node.textContent ?? "").search(/\S/u);
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getClientRects()[0];
      if (rect === undefined) throw new Error("no glyph box");
      return span(rect);
    };
    const baselineOf = (element: Element): number => {
      const node = firstText(element);
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0";
      node.before(probe);
      const baseline = probe.getBoundingClientRect().bottom;
      probe.remove();
      return baseline;
    };
    const lineOf = (paragraph: Element): Span => {
      const top = paragraph.getBoundingClientRect().top;
      const height = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
      return { top, bottom: top + height, centre: top + height / 2 };
    };
    const avatarOf = (scope: Element | null): Span | undefined => {
      const avatar = scope?.querySelector("[data-testid='speaker-avatar']");
      return avatar == null ? undefined : boxOf(avatar);
    };
    const rows: RowBoxes[] = [];
    for (const row of document.querySelectorAll("[data-turn-layout]")) {
      const layout = row.getAttribute("data-turn-layout");
      const paragraph = row.querySelector("p[data-reader-text]");
      const sentence = paragraph?.querySelector("[data-segment-id]");
      if (paragraph == null || sentence == null) continue;
      const time = paragraph.querySelector(":scope > button[data-reading-time]");
      const text = { line: lineOf(paragraph), glyph: firstGlyph(sentence), textBaseline: baselineOf(sentence), ...(time === null ? {} : { timeBaseline: baselineOf(time) }) };
      if (layout === "compact") {
        const name = paragraph.querySelector("[data-testid='turn-speaker']");
        const avatar = avatarOf(row.querySelector("[data-turn-header]"));
        if (name === null || avatar === undefined || time === null) throw new Error("compact row without its parts");
        rows.push({ layout, ...text, nameBaseline: baselineOf(name), avatar });
        continue;
      }
      const header = row.querySelector("[data-testid='turn-header']");
      if (header === null) {
        rows.push({ layout: "follow", ...text });
        continue;
      }
      const avatar = avatarOf(header);
      const name = header.querySelector("[data-testid='turn-speaker'] span.truncate");
      const headerTime = header.querySelector(":scope > button[data-reading-time]");
      if (avatar === undefined || name === null || headerTime === null) throw new Error("turn header without its parts");
      rows.push({ layout: "wide", ...text, header: { avatar, name: boxOf(name), time: boxOf(headerTime), bottom: header.getBoundingClientRect().bottom } });
    }
    if (rows.length === 0) {
      for (const paragraph of document.querySelectorAll("[data-testid='transcript-reader'] p[data-reader-text]")) {
        const time = paragraph.querySelector(":scope > button[data-reading-time]");
        const sentence = paragraph.querySelector("[data-segment-id]");
        if (time === null || sentence === null) continue;
        rows.push({ layout: "plain", line: lineOf(paragraph), glyph: firstGlyph(sentence), textBaseline: baselineOf(sentence), timeBaseline: baselineOf(time) });
      }
    }
    return rows;
  });
}

/** Rounding of a box edge to the device pixel grid, in CSS px; the checks below allow one such step. */
const SNAP_PX = 1;

/**
 * What "aligned" means for a row, as a list of violations (empty when aligned):
 * - the time, the compact row's name and the text sit on one baseline, on the first line;
 * - a compact row's avatar is centred on that first line, and so on its text;
 * - a wide row's header centres avatar, name and time on one axis and ends above the text.
 */
function misalignments(row: RowBoxes, size: number): string[] {
  const problems: string[] = [];
  const near = (what: string, a: number, b: number, tolerance = SNAP_PX): void => {
    if (Math.abs(a - b) > tolerance) problems.push(`${what}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);
  };
  if (row.timeBaseline !== undefined) near("time baseline / text baseline", row.timeBaseline, row.textBaseline);
  if (row.nameBaseline !== undefined) near("name baseline / text baseline", row.nameBaseline, row.textBaseline);
  // The text's first character is drawn on the first line, not pushed down by the parts before it.
  if (row.glyph.top < row.line.top - SNAP_PX || row.glyph.bottom > row.line.bottom + SNAP_PX) problems.push("first character outside the first line");
  if (row.avatar !== undefined) {
    near("avatar centre / first line centre", row.avatar.centre, row.line.centre);
    // Glyph boxes differ in how far they reach above and below the baseline from font to font; a tenth of the size covers that.
    near("avatar centre / first character centre", row.avatar.centre, row.glyph.centre, Math.max(SNAP_PX, size / 10));
  }
  if (row.header !== undefined) {
    near("header avatar / name", row.header.avatar.centre, row.header.name.centre);
    near("header avatar / time", row.header.avatar.centre, row.header.time.centre);
    if (row.header.bottom > row.line.top + SNAP_PX) problems.push("header overlaps the text");
  }
  return problems;
}

/** The width the content page remembers for its output column, set before the page loads. */
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
const OUTPUTS_WIDTH_PX = 900;

const PRESETS: ReadonlyArray<ReaderFont | undefined> = [undefined, "sans", "serif", "kai", "custom"];
const SIZES = [12, 16, 24, 32] as const;
// A font this machine may or may not have: either way the name is used and the stack falls through.
const CUSTOM_FONT = "DejaVu Serif";

for (const scale of [1, 2]) {
  test.describe(`reader font alignment at ${scale * 100}%`, () => {
    // Room for an output column wide enough that the reading pane keeps its gutter: compact rows only exist there.
    test.use({ deviceScaleFactor: scale, viewport: { width: 1920, height: 1080 } });

    test("keeps avatar, name, time and text on one line for every font and size", async ({ page }) => {
      test.setTimeout(120_000);
      await installMockBackend(page);
      await serveFonts(page);
      // A one-word answer makes the student's turn a compact row between the teacher's wide ones.
      await page.route(`**/api/transcript/revisions/${SPEAKERS_REVISION}/segments*`, (route) => route.fulfill({ json: speakerSegmentPage({ 2: "好的。" }) }));
      await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript`);
      await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
      const problems: string[] = [];
      const check = (label: string, rows: RowBoxes[], layouts: ReadonlyArray<RowBoxes["layout"]>, size: number): void => {
        for (const layout of layouts) {
          if (!rows.some((row) => row.layout === layout)) problems.push(`${label}: no ${layout} row measured`);
        }
        for (const row of rows) problems.push(...misalignments(row, size).map((problem) => `${label} ${row.layout}: ${problem}`));
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
        await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
        if (preset === undefined) await expect(page.locator("[data-reader-font]")).toHaveCount(0);
        else await expect(page.locator(`[data-reader-font='${preset}']`)).toHaveCount(1, { timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const panel = await openPanel(page);
        for (const size of SIZES) {
          const label = `${preset ?? "default"} ${size}px`;
          await panel.getByTestId("reader-font-size").fill(String(size));
          await expect(page.locator("[data-turn-layout='wide']").first()).toHaveCSS("font-size", `${size}px`);
          await expect(page.locator("[data-turn-layout='compact']")).toHaveCount(1);
          check(label, await measureRows(page), ["compact", "wide"], size);
          await panel.getByRole("switch", { name: "显示发言人" }).click({ force: true });
          await expect(page.locator("[data-turn-layout]")).toHaveCount(0);
          check(`${label} without speakers`, await measureRows(page), ["plain"], size);
          await panel.getByRole("switch", { name: "显示发言人" }).click({ force: true });
          await expect(page.locator("[data-turn-layout='compact']")).toHaveCount(1);
        }
      }
      expect(problems).toEqual([]);
    });
  });
}
