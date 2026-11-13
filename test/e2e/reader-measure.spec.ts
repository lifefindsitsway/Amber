import { expect, test, type Page } from "@playwright/test";
import { READER_MARGIN_DEFAULT, READER_MARGIN_MAX, READER_MARGIN_MIN } from "../../src/shared/defaults.ts";
import { READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey } from "../../src/shared/reader-typography.ts";
import { installMockBackend } from "./mock-backend.ts";
import { SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKERS_CONTENT, speakerSentence, speakersRequests } from "./mock-speakers.ts";

/** The width the content page remembers for its output column, set before the page loads. */
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
/** One CSS pixel: box edges snap to the device grid. */
const SNAP_PX = 1;
/** What the text keeps when the pane is too narrow for the margin, and the least margin then, as the style sheet sets them (1rem = 16px). */
const TEXT_FLOOR_PX = 320;
const MARGIN_FLOOR_PX = 8;

/** Turns that alternate every sentence, so each sentence is a row of its own. */
const alternating = (count: number): string[] => Array.from({ length: count }, (_, index) => (index % 2 === 0 ? SPEAKER_TEACHER : SPEAKER_STUDENT));

/** The margin the style sheet gives a pane whose width inside the scrollbar gutters is `inner`. */
const expectedMargin = (margin: number, inner: number): number => Math.min(margin, Math.max(MARGIN_FLOOR_PX, (inner - TEXT_FLOOR_PX) / 2));

interface Geometry {
  /** The reading pane's box and its width inside the scrollbar gutters. */
  pane: { left: number; right: number; width: number };
  inner: { left: number; right: number; width: number };
  scrollbar: boolean;
  /** Each visible row's block (avatar gutter and text, or a chapter heading): its edges from the inner pane's edges. */
  rows: Array<{ chapter: boolean; left: number; right: number }>;
  /** Each visible sentence paragraph's edges from the inner pane's edges, and its width. */
  texts: Array<{ left: number; right: number; width: number }>;
  /** The floating jump buttons' box. */
  jump?: { left: number; right: number; top: number; bottom: number };
  /** Whether anything is wider than the pane (a horizontal scroll). */
  overflowX: boolean;
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
    if (scroller === null) throw new Error("no reader");
    const box = scroller.getBoundingClientRect();
    // Gutters are reserved on both edges alike, so each takes half of what the box loses to them.
    const gutter = (scroller.offsetWidth - scroller.clientWidth) / 2;
    const inner = { left: box.left + gutter, right: box.right - gutter, width: scroller.clientWidth };
    const visible = (rect: DOMRect): boolean => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
    const rows = [...scroller.querySelectorAll<HTMLElement>(".reader-column")].flatMap((column) => {
      const block = column.firstElementChild?.getBoundingClientRect();
      if (block === undefined || !visible(block)) return [];
      // A chapter heading is indented to the text's edge, so its block starts one speaker gutter in.
      return [{ chapter: column.hasAttribute("data-reader-indent"), left: block.left - inner.left, right: inner.right - block.right }];
    });
    const texts = [...scroller.querySelectorAll<HTMLElement>("p[data-reader-text]")]
      .map((element) => element.getBoundingClientRect())
      .filter(visible)
      .map((rect) => ({ left: rect.left - inner.left, right: inner.right - rect.right, width: rect.width }));
    const jump = document.querySelector("[data-testid='reader-to-top']")?.parentElement?.getBoundingClientRect();
    return {
      pane: { left: box.left, right: box.right, width: box.width },
      inner,
      scrollbar: scroller.scrollHeight > scroller.clientHeight,
      rows,
      texts,
      ...(jump === undefined ? {} : { jump: { left: jump.left, right: jump.right, top: jump.top, bottom: jump.bottom } }),
      overflowX: scroller.scrollWidth > scroller.clientWidth,
    };
  });
}

async function openPanel(page: Page) {
  const panel = page.getByTestId("reader-typography-popover");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Aa 阅读排版" }).click();
  return panel;
}

/** Opens the reader with the stored typography and output column width. */
async function open(page: Page, options: { fontSize: number; sideMargin?: number; showSpeakers?: boolean; outputsWidth: number }): Promise<void> {
  const typography = {
    ...READER_TYPOGRAPHY_DEFAULTS,
    fontSize: options.fontSize,
    showSpeakers: options.showSpeakers ?? true,
    ...(options.sideMargin === undefined ? {} : { sideMargin: options.sideMargin }),
  };
  await page.evaluate(
    ([key, value, widthKey, width]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(widthKey, width);
    },
    [readerTypographyKey("local"), JSON.stringify(typography), OUTPUTS_WIDTH_KEY, String(options.outputsWidth)] as const,
  );
  await page.reload();
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
}

/** The output column width that gives the reading pane `pane` px, found from one measurement. */
async function outputsFor(page: Page, pane: number): Promise<number> {
  await open(page, { fontSize: 16, outputsWidth: 900 });
  const measured = (await geometry(page)).pane.width;
  return pane + (900 - measured);
}

/** Every way the measured geometry misses the margin `margin` on both sides. */
function marginProblems(label: string, g: Geometry, margin: number, gutterPx: number): string[] {
  const problems: string[] = [];
  if (g.overflowX) problems.push(`${label}: horizontal scroll`);
  if (g.rows.filter((row) => !row.chapter).length === 0) problems.push(`${label}: no row measured`);
  for (const row of g.rows) {
    const left = row.chapter ? row.left - gutterPx : row.left;
    if (Math.abs(left - margin) > SNAP_PX) problems.push(`${label}: ${row.chapter ? "chapter" : "row"} left ${left.toFixed(1)}, want ${margin}`);
    if (Math.abs(row.right - margin) > SNAP_PX) problems.push(`${label}: ${row.chapter ? "chapter" : "row"} right ${row.right.toFixed(1)}, want ${margin}`);
  }
  // The text runs to the right margin; on the left it starts after the avatar gutter, if any.
  for (const text of g.texts) {
    if (Math.abs(text.right - margin) > SNAP_PX) problems.push(`${label}: text right ${text.right.toFixed(1)}, want ${margin}`);
    if (Math.abs(text.left - margin - gutterPx) > SNAP_PX) problems.push(`${label}: text left ${text.left.toFixed(1)}, want ${margin + gutterPx}`);
  }
  return problems;
}

/** The speaker gutter in px at a font size, read off the page: where the text starts beyond the row's block. */
async function gutterOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-turn-layout='wide'] .grid");
    const text = row?.querySelector("p[data-reader-text]");
    return row === null || row === undefined || text === null || text === undefined ? 0 : text.getBoundingClientRect().left - row.getBoundingClientRect().left;
  });
}

const SIZES = [12, 15, 16, 18, 20, 24, 32] as const;
const MARGINS = [READER_MARGIN_MIN, READER_MARGIN_DEFAULT, READER_MARGIN_MAX] as const;

for (const scrolling of [false, true]) {
  test(`reader column: both sides keep the chosen margin at every size, ${scrolling ? "with" : "without"} a scrollbar`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await installMockBackend(page);
    if (scrolling) speakersRequests(page).sequence = alternating(60);
    await page.goto(READER);
    await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
    const problems: string[] = [];
    for (const pane of [936, 1300]) {
      const outputs = await outputsFor(page, pane);
      for (const showSpeakers of [true, false]) {
        for (const size of SIZES) {
          for (const margin of MARGINS) {
            await open(page, { fontSize: size, sideMargin: margin, showSpeakers, outputsWidth: outputs });
            const g = await geometry(page);
            const label = `${pane}px ${showSpeakers ? "speakers" : "plain"} ${size}px margin ${margin}`;
            if (Math.abs(g.pane.width - pane) > SNAP_PX) problems.push(`${label}: pane is ${g.pane.width}`);
            if (g.scrollbar !== scrolling) problems.push(`${label}: scrollbar ${g.scrollbar}`);
            problems.push(...marginProblems(label, g, margin, showSpeakers ? await gutterOf(page) : 0));
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
}

test("reader column: wider panes widen the text and keep the margin; narrow ones give way on both sides alike, smoothly", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installMockBackend(page);
  speakersRequests(page).sequence = alternating(60);
  await page.goto(READER);
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
  const problems: string[] = [];
  for (const margin of [READER_MARGIN_DEFAULT, READER_MARGIN_MAX]) {
    const lefts = new Map<number, number>();
    for (const pane of [1300, 1000, 600, 521, 520, 519, 400]) {
      const outputs = await outputsFor(page, pane);
      await open(page, { fontSize: 16, sideMargin: margin, outputsWidth: outputs });
      const g = await geometry(page);
      const label = `${pane}px margin ${margin}`;
      const want = expectedMargin(margin, g.inner.width);
      const wide = (await page.locator("[data-turn-layout='wide']").count()) > 0;
      problems.push(...marginProblems(label, g, want, wide ? await gutterOf(page) : 0));
      // Below the margin the text block keeps the floor between the gutters.
      if (g.inner.width - 2 * want < Math.min(TEXT_FLOOR_PX, g.inner.width - 2 * MARGIN_FLOOR_PX) - SNAP_PX) problems.push(`${label}: text block ${g.inner.width - 2 * want}`);
      // At the default margin or more the text stays clear of the floating jump buttons.
      if (want >= READER_MARGIN_DEFAULT && g.jump !== undefined && g.texts.some((text) => g.inner.right - text.right > g.jump!.left + SNAP_PX)) problems.push(`${label}: text runs under the jump buttons`);
      const first = g.rows.find((row) => !row.chapter);
      if (first !== undefined) lefts.set(pane, first.left);
    }
    // One pixel of pane moves the left edge by at most a pixel, also across the narrow-layout switch.
    const at = (pane: number): number => lefts.get(pane) ?? Number.NaN;
    for (const [a, b] of [
      [521, 520],
      [520, 519],
    ] as const) {
      if (!(Math.abs(at(a) - at(b)) <= SNAP_PX)) problems.push(`margin ${margin}: left edge jumps between ${a} and ${b}: ${at(a)} / ${at(b)}`);
    }
  }
  expect(problems).toEqual([]);
});

test("reader column: the 「Aa」 margin control applies at once, survives a reload, and 恢复默认 brings the default back", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installMockBackend(page);
  await page.goto(READER);
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
  // A pane wide enough for every margin tried here, with no margin stored.
  await open(page, { fontSize: 16, outputsWidth: await outputsFor(page, 936) });
  const margin = async (): Promise<number> => {
    const g = await geometry(page);
    return g.rows.find((row) => !row.chapter)?.right ?? Number.NaN;
  };
  expect(Math.abs((await margin()) - READER_MARGIN_DEFAULT)).toBeLessThanOrEqual(SNAP_PX);
  const panel = await openPanel(page);
  // The control sits right under the line heights.
  const order = await panel.evaluate((element) => {
    const lineHeights = element.querySelector("[data-testid='reader-line-heights']");
    const slider = element.querySelector("[data-testid='reader-margin']");
    return lineHeights !== null && slider !== null && (lineHeights.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(order).toBe(true);
  await panel.getByTestId("reader-margin").fill("120");
  await expect(panel.getByTestId("reader-margin-value")).toHaveText("120 px");
  await expect.poll(margin).toBeCloseTo(120, 0);
  await panel.getByTestId("reader-margin-wider").click();
  await expect.poll(margin).toBeCloseTo(124, 0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
  await expect.poll(margin).toBeCloseTo(124, 0);
  const again = await openPanel(page);
  await again.getByTestId("reader-typography-reset").click();
  await expect(again.getByTestId("reader-margin-value")).toHaveText(`${READER_MARGIN_DEFAULT} px`);
  await expect.poll(margin).toBeCloseTo(READER_MARGIN_DEFAULT, 0);
});

/** Where the row with this key sits below the pane's top, if it is mounted. */
async function rowOffset(page: Page, key: string): Promise<number | undefined> {
  return page.evaluate((wanted) => {
    const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
    const row = [...(scroller?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])].find((element) => element.getAttribute("data-row-key") === wanted);
    return scroller === null || row === undefined ? undefined : row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, key);
}

/**
 * The first row the reading pane shows (the reader's own rule: the first whose bottom is below
 * the pane's top), and how far its top sits from the pane's top.
 */
async function firstVisible(page: Page): Promise<{ key: string; offset: number; scrollTop: number }> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
    if (scroller === null) throw new Error("no reader");
    const top = scroller.getBoundingClientRect().top;
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-row-key]")]
      .map((row) => ({ key: row.getAttribute("data-row-key") ?? "", rect: row.getBoundingClientRect() }))
      .filter((row) => row.rect.bottom > top)
      .sort((a, b) => a.rect.top - b.rect.top);
    const first = rows[0];
    if (first === undefined) throw new Error("no row");
    return { key: first.key, offset: first.rect.top - top, scrollTop: scroller.scrollTop };
  });
}

test("reader column: changing the size or the margin keeps the first visible row in place, windowed or not, and the scroll settles", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await installMockBackend(page);
  const requests = speakersRequests(page);
  // Rows besides the sentences (chapter headings) are counted once, so the sentence counts below give 149 / 150 / 151 rows.
  requests.sequence = alternating(100);
  await page.goto(READER);
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
  const extra = (await page.locator("[data-testid='transcript-reader'] [data-row-index]").count()) - 100;
  const problems: string[] = [];
  for (const rows of [149, 150, 151, 3000]) {
    requests.sequence = alternating(rows - extra);
    await open(page, { fontSize: 16, outputsWidth: 900 });
    const windowed = (await page.locator("[data-testid='transcript-reader'] [data-index]").count()) > 0;
    if (windowed !== rows >= 150) problems.push(`${rows} rows: windowed ${windowed}`);
    await page.getByTestId("transcript-reader").evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });
    await page.waitForTimeout(300);
    const panel = await openPanel(page);
    const steps: Array<{ size: number } | { margin: number }> = [{ size: 24 }, { margin: READER_MARGIN_MAX }, { size: 12 }, { margin: READER_MARGIN_MIN }, { size: 20 }];
    for (const step of steps) {
      // Each change keeps the row that was first just before it.
      const before = await firstVisible(page);
      if ("size" in step) {
        await panel.getByTestId("reader-font-size").fill(String(step.size));
        await expect(page.locator("[data-turn-key]").first()).toHaveCSS("font-size", `${step.size}px`);
      } else {
        await panel.getByTestId("reader-margin").fill(String(step.margin));
        await expect(page.locator(".reader-column").first()).toHaveCSS("padding-right", `${step.margin}px`);
      }
      const samples: number[] = [];
      for (let index = 0; index < 6; index += 1) {
        await page.waitForTimeout(100);
        samples.push((await firstVisible(page)).scrollTop);
      }
      // The row that was first keeps its distance from the top (a row partly scrolled off may
      // shrink out of view at a smaller size, which is the same place, not a jump).
      const offset = await rowOffset(page, before.key);
      const label = `${rows} rows ${"size" in step ? `${step.size}px` : `margin ${step.margin}`}`;
      if (offset === undefined) problems.push(`${label}: row ${before.key} is gone`);
      else if (Math.abs(offset - before.offset) > SNAP_PX) problems.push(`${label}: offset ${offset.toFixed(1)}, was ${before.offset.toFixed(1)}`);
      if (Math.max(...samples) - Math.min(...samples) > SNAP_PX) problems.push(`${label}: scroll moves after settling ${samples.join(",")}`);
    }
    await page.keyboard.press("Escape");
  }
  expect(problems).toEqual([]);
});

test("reader column: the sticky avatar sits over the avatar column at every size, margin and width", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installMockBackend(page);
  // One long turn of the teacher, so its header scrolls away while the turn goes on.
  speakersRequests(page).sequence = [...Array<string>(400).fill(SPEAKER_TEACHER), ...Array<string>(4).fill(SPEAKER_STUDENT)];
  await page.goto(READER);
  await expect(page.getByText(speakerSentence(0), { exact: true })).toBeVisible();
  const problems: string[] = [];
  for (const pane of [600, 936, 1300]) {
    const outputs = await outputsFor(page, pane);
    for (const [size, margin] of [
      [12, READER_MARGIN_MIN],
      [16, READER_MARGIN_DEFAULT],
      [24, READER_MARGIN_MAX],
      [32, READER_MARGIN_DEFAULT],
    ] as const) {
      await open(page, { fontSize: size, sideMargin: margin, outputsWidth: outputs });
      await page.getByTestId("transcript-reader").evaluate((element) => {
        element.scrollTop = 600;
      });
      await expect(page.getByTestId("turn-marker")).toHaveAttribute("data-visible", "true");
      const { marker, line } = await page.evaluate(() => {
        const centre = (element: Element | null | undefined): number => {
          const rect = element?.getBoundingClientRect();
          return rect === undefined ? Number.NaN : (rect.left + rect.right) / 2;
        };
        const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']");
        const top = scroller?.getBoundingClientRect().top ?? 0;
        const lines = [...document.querySelectorAll("[data-testid='turn-line']")].filter((element) => element.getBoundingClientRect().bottom > top);
        return { marker: centre(document.querySelector("[data-testid='turn-marker'] [data-speaker-id]")), line: centre(lines[0]) };
      });
      if (!(Math.abs(marker - line) <= SNAP_PX)) problems.push(`${pane}px ${size}px margin ${margin}: marker ${marker.toFixed(1)} vs avatar column ${line.toFixed(1)}`);
    }
  }
  expect(problems).toEqual([]);
});
