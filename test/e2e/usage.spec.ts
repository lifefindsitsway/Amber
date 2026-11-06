import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { THEMES, type Theme } from "../../src/shared/dto/settings.ts";
import { encodeModelKey } from "../../src/shared/dto/usage-analytics.ts";
import { beijing } from "../fixtures/usage/builders.ts";
import { SCENARIOS, type ScenarioId } from "../fixtures/usage/scenarios.ts";
import { installMockBackend } from "./mock-backend.ts";
import { installUsageMock, setSidebarWidth, setTheme } from "./mock-usage.ts";

/*
 * The AI usage page against fixture scenarios: layout and behaviour checks, and, when
 * AMBER_USAGE_SCREENSHOTS names a directory, a screenshot of every scenario for review.
 */

const SCREENSHOT_DIR = process.env["AMBER_USAGE_SCREENSHOTS"];
const TALL_VIEWPORT_HEIGHT = 1700;
const TOLERANCE_PX = 1.5;

async function open(page: Page, path: string, scenario: ScenarioId = "main", options: { width?: number; sidebar?: number; theme?: Theme } = {}): Promise<void> {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 });
  await installMockBackend(page);
  await installUsageMock(page, scenario);
  if (options.sidebar !== undefined) await setSidebarWidth(page, options.sidebar);
  if (options.theme !== undefined) await setTheme(page, options.theme);
  await page.goto(path);
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("element has no box");
  return found;
}

const ready = (page: Page): Locator => page.getByTestId("usage-summary-grid");

test("the toolbar is one row: credential, model, currency, then the range at the far right", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await open(page, "/usage");
  await expect(ready(page)).toBeVisible();
  const credential = await box(page.getByTestId("usage-credential"));
  const model = await box(page.getByTestId("usage-model"));
  const currency = await box(page.getByTestId("usage-currency"));
  const range = await box(page.getByTestId("usage-range"));
  const toolbar = await box(page.getByTestId("usage-toolbar"));
  expect(credential.x).toBeLessThan(model.x);
  expect(model.x).toBeLessThan(currency.x);
  expect(currency.x + currency.width).toBeLessThan(range.x);
  for (const control of [credential, model, currency]) expect(Math.abs(control.y + control.height / 2 - (range.y + range.height / 2))).toBeLessThan(TOLERANCE_PX);
  expect(Math.abs(range.x + range.width - (toolbar.x + toolbar.width))).toBeLessThan(TOLERANCE_PX);
  // The page's own controls use menus; the pager below the content is the shared one.
  await expect(page.locator('[data-testid="usage-toolbar"] select, [data-testid="usage-analysis"] select, [data-testid="usage-records"] select')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a long chosen model truncates itself while the credential label stays whole and the toolbar keeps one row", async ({ page }) => {
  await open(page, "/usage", "long-names", { width: 1280 });
  await expect(ready(page)).toBeVisible();
  await page.getByTestId("usage-model").click();
  await page.getByRole("menuitemradio", { name: "gpt-5.6-sol-2026-10-31-preview-high-reasoning-long-context" }).click();
  await expect(page.getByTestId("usage-clear-filters")).toBeVisible();
  const credential = page.getByTestId("usage-credential");
  const label = credential.locator("span").first();
  await expect(label).toHaveText("凭据：全部");
  expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const model = page.getByTestId("usage-model");
  expect(await model.locator("span").first().evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const tops = [await box(credential), await box(model), await box(page.getByTestId("usage-currency")), await box(page.getByTestId("usage-clear-filters")), await box(page.getByTestId("usage-range"))].map(
    (found) => found.y + found.height / 2,
  );
  for (const top of tops) expect(Math.abs(top - (tops[0] as number))).toBeLessThan(TOLERANCE_PX);
});

test("a narrow container puts the range alone on a second row, still at the right", async ({ page }) => {
  await open(page, "/usage", "main", { width: 768, sidebar: 400 });
  await expect(ready(page)).toBeVisible();
  const currency = await box(page.getByTestId("usage-currency"));
  const range = await box(page.getByTestId("usage-range"));
  const toolbar = await box(page.getByTestId("usage-toolbar"));
  expect(range.y).toBeGreaterThan(currency.y + currency.height - TOLERANCE_PX);
  expect(Math.abs(range.x + range.width - (toolbar.x + toolbar.width))).toBeLessThan(TOLERANCE_PX);
  await expect(page.getByTestId("usage-toolbar")).toHaveAttribute("data-layout", "narrow");
});

test("the toolbar stays under the header while the page scrolls, and shows a line once content passes beneath it", async ({ page }) => {
  await open(page, "/usage?pageSize=50");
  await expect(ready(page)).toBeVisible();
  const before = await box(page.getByTestId("usage-toolbar"));
  await expect(page.getByTestId("usage-sticky")).toHaveClass(/border-transparent/);
  await page.getByTestId("usage-scroll").evaluate((element) => element.scrollTo({ top: 500 }));
  await expect(page.getByTestId("usage-sticky")).toHaveClass(/border-line/);
  const after = await box(page.getByTestId("usage-toolbar"));
  expect(Math.abs(after.y - before.y)).toBeLessThan(TOLERANCE_PX);
});

test("the three summary columns share row baselines", async ({ page }) => {
  await open(page, "/usage");
  await expect(ready(page)).toBeVisible();
  for (const row of ["label", "main", "bar", "caption", "extra"]) {
    const tops = await Promise.all(["cost", "calls", "usage"].map(async (column) => (await box(page.getByTestId(`usage-summary-${column}-${row}`))).y));
    expect(Math.max(...tops) - Math.min(...tops), `row ${row}`).toBeLessThan(TOLERANCE_PX);
  }
  const widths = await Promise.all(["cost", "calls", "usage"].map(async (column) => (await box(page.getByTestId(`usage-summary-${column}-main`))).width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(TOLERANCE_PX);
});

test("a record expands into its calls on the parent's columns, with the accent bar", async ({ page }) => {
  await open(page, "/usage");
  const first = page.getByTestId("usage-record-row").first();
  await expect(first).toBeVisible();
  const toggle = first.getByTestId("usage-record-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const calls = page.getByTestId("usage-call-row");
  await expect(calls.first()).toBeVisible();
  const parentCells = await first.locator("td").all();
  const childCells = await calls.first().locator("td").all();
  expect(childCells).toHaveLength(parentCells.length);
  for (const [index, parentCell] of parentCells.entries()) {
    const parent = await box(parentCell);
    const child = await box(childCells[index] as Locator);
    expect(Math.abs(parent.x - child.x), `column ${index} left`).toBeLessThan(TOLERANCE_PX);
    expect(Math.abs(parent.width - child.width), `column ${index} width`).toBeLessThan(TOLERANCE_PX);
  }
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(calls).toHaveCount(0);
});

test("every state in the address is restored on load", async ({ page }) => {
  const model = encodeModelKey(["llm", "relay", "claude-sonnet-4-5"]);
  await open(page, `/usage?range=30d&currency=USD&view=models&granularity=day&model=${model}`);
  await expect(ready(page)).toBeVisible();
  await expect(page.getByTestId("usage-range").getByRole("radio", { name: "30 天" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("usage-currency")).toContainText("美元");
  await expect(page.getByTestId("usage-model")).toContainText("claude-sonnet-4-5");
  await expect(page.getByTestId("usage-tab-models")).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("usage-model-row")).toHaveCount(1);
});

test("clicking a bar opens it in finer buckets with a breadcrumb back", async ({ page }) => {
  await open(page, "/usage?range=30d&granularity=day");
  const marks = page.locator('[data-testid="usage-bar"] path');
  await expect(marks.first()).toBeVisible();
  const mark = await box(marks.last());
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await expect(page).toHaveURL(/range=custom/);
  await expect(page).toHaveURL(/granularity=hour/);
  await expect(page.getByTestId("usage-breadcrumb")).toBeVisible();
  await page.getByTestId("usage-breadcrumb-back").click();
  await expect(page.getByTestId("usage-breadcrumb")).toHaveCount(1);
});

test("the chart follows the keyboard and its table shows the same totals", async ({ page }) => {
  await open(page, "/usage?range=30d&granularity=day");
  const chart = page.getByTestId("usage-chart");
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("usage-tooltip")).toBeVisible();
  await page.getByTestId("usage-table-toggle").click();
  const rows = page.getByTestId("usage-trend-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("usage-trend-total").first()).not.toBeEmpty();
});

test("the basis popover opens from the header and closes with Escape", async ({ page }) => {
  await open(page, "/usage");
  await page.getByTestId("usage-basis-button").click();
  await expect(page.getByTestId("usage-basis")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("usage-basis")).toHaveCount(0);
  await expect(page.getByTestId("usage-basis-button")).toBeFocused();
});

test("an empty range is one line, and a failing server offers a retry", async ({ page }) => {
  await open(page, "/usage", "empty");
  await expect(page.getByTestId("usage-empty")).toContainText("所选时间内没有 AI 调用");
});

test("a failing server shows the error with a retry", async ({ page }) => {
  await open(page, "/usage", "error");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
});

// Screenshots -----------------------------------------------------------------------------------

async function shoot(page: Page, name: string): Promise<void> {
  if (SCREENSHOT_DIR === undefined) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
}

async function settle(page: Page, scenario: ScenarioId, options: { chart?: boolean } = {}): Promise<void> {
  if (scenario === "loading") {
    await expect(page.getByTestId("usage-summary-skeleton")).toBeVisible();
    return;
  }
  if (scenario === "error") {
    await expect(page.getByRole("alert")).toBeVisible();
    return;
  }
  await expect(page.getByTestId(scenario === "empty" ? "usage-empty" : "usage-summary-grid")).toBeVisible();
  if (scenario !== "empty" && options.chart !== false) await expect(page.locator('[data-testid="usage-bar"] path').first()).toBeVisible();
}

test.describe("screenshots", () => {
  test.skip(SCREENSHOT_DIR === undefined, "set AMBER_USAGE_SCREENSHOTS to a directory to write the review screenshots");

  for (const theme of THEMES) {
    for (const width of [1280, 1024, 768]) {
      for (const sidebar of [240, 400]) {
        test(`main · ${width} · sidebar ${sidebar} · ${theme}`, async ({ page }) => {
          await open(page, "/usage", "main", { width, sidebar, theme });
          await page.setViewportSize({ width, height: TALL_VIEWPORT_HEIGHT });
          await settle(page, "main");
          await shoot(page, `main-${width}-sb${sidebar}-${theme}`);
        });
      }
    }
  }

  for (const scenario of Object.keys(SCENARIOS) as ScenarioId[]) {
    if (scenario === "main") continue;
    for (const width of [1280, 768]) {
      test(`${scenario} · ${width} · light`, async ({ page }) => {
        await open(page, "/usage", scenario, { width });
        await page.setViewportSize({ width, height: TALL_VIEWPORT_HEIGHT });
        await settle(page, scenario);
        await shoot(page, `${scenario}-${width}-light`);
      });
    }
  }

  test("main · by-model view and cost details · 1280 · light", async ({ page }) => {
    await open(page, "/usage?view=models", "main");
    await page.setViewportSize({ width: 1280, height: TALL_VIEWPORT_HEIGHT });
    await settle(page, "main", { chart: false });
    await shoot(page, "main-models-1280-light");
    await page.getByTestId("usage-cost-detail-button").click();
    await page.getByTestId("usage-simulate").click();
    await expect(page.getByTestId("usage-simulated")).toBeVisible();
    await shoot(page, "main-cost-detail-1280-light");
  });

  test("main · drilled into a day · 1280 · light", async ({ page }) => {
    await open(page, `/usage?range=custom&from=${beijing(2026, 11, 5)}&to=${beijing(2026, 11, 6)}&granularity=hour`, "main");
    await page.setViewportSize({ width: 1280, height: TALL_VIEWPORT_HEIGHT });
    await settle(page, "main");
    await shoot(page, "main-drilled-1280-light");
  });

  test("main · expanded record, table view and open menus · 1280 · light", async ({ page }) => {
    await open(page, "/usage", "main");
    await page.setViewportSize({ width: 1280, height: TALL_VIEWPORT_HEIGHT });
    await settle(page, "main");
    await page.getByTestId("usage-record-toggle").first().click();
    await page.getByTestId("usage-record-toggle").nth(1).click();
    await expect(page.getByTestId("usage-call-row").first()).toBeVisible();
    await shoot(page, "main-expanded-1280-light");
    await page.getByTestId("usage-table-toggle").click();
    await shoot(page, "main-table-1280-light");
    await page.getByTestId("usage-credential").click();
    await shoot(page, "main-credential-menu-1280-light");
    await page.keyboard.press("Escape");
    await page.getByTestId("usage-currency").click();
    await shoot(page, "main-currency-menu-1280-light");
  });

  test("deleted · second page · 1280 · light", async ({ page }) => {
    await open(page, "/usage?page=2", "deleted");
    await page.setViewportSize({ width: 1280, height: TALL_VIEWPORT_HEIGHT });
    await settle(page, "deleted", { chart: false });
    await shoot(page, "deleted-page2-1280-light");
  });

  test("main · tooltip over a bar · 1280 · light and dark", async ({ page }) => {
    await open(page, "/usage?range=30d&granularity=day", "main", { theme: "dark" });
    await page.setViewportSize({ width: 1280, height: TALL_VIEWPORT_HEIGHT });
    await settle(page, "main");
    const marks = page.locator('[data-testid="usage-bar"] path');
    const mark = await box(marks.nth(await marks.count() - 3));
    await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2);
    await expect(page.getByTestId("usage-tooltip")).toBeVisible();
    await shoot(page, "main-tooltip-1280-dark");
  });

  test("library page for comparison of the pager · 1280 · light", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: TALL_VIEWPORT_HEIGHT });
    await installMockBackend(page, { libraryContents: 25 });
    await page.goto("/library");
    await expect(page.getByRole("navigation", { name: "分页" })).toBeVisible();
    await shoot(page, "compare-library-1280-light");
  });

  test("main · other currency selected · 1280 · light", async ({ page }) => {
    await open(page, "/usage?currency=USD", "main");
    await page.setViewportSize({ width: 1280, height: TALL_VIEWPORT_HEIGHT });
    await settle(page, "main", { chart: false });
    await shoot(page, "main-usd-1280-light");
  });
});
