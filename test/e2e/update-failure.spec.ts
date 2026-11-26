import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend } from "./mock-backend.ts";
import { installFakeDesktopShell, type FakeUpdateDriver } from "./mock-content-pack.ts";

/*
 * The desktop client's update card when the download has trouble: the reconnect line while
 * the shell resumes, the failure explained in plain words with the release page and the folded
 * technical details, 「稍后」 closing it, and a retry continuing from the kept bytes. Layout is
 * checked by geometry in a small window: the card stays inside it and nothing runs together.
 */

const MB = 1024 * 1024;
const TOTAL = 190 * MB;
const VERSION = "0.9.0";
/** Long enough that, uncapped, the card would not fit a short window. */
const NOTES = ["这一版重点改进了更新下载的稳定性。", "", "### 新增", "", ...Array.from({ length: 14 }, (_, index) => `- 第 ${index + 1} 项改进，说明文字稍长一些，用来占满卡片的说明区`)].join("\n");
const SMALL = { width: 1024, height: 640 };

const emit = (page: Page, message: unknown): Promise<unknown> =>
  page.evaluate((sent) => (window as unknown as { __AMBER_E2E_UPDATE__: FakeUpdateDriver }).__AMBER_E2E_UPDATE__.emit(sent), message);

const downloads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __AMBER_E2E_UPDATE__: FakeUpdateDriver }).__AMBER_E2E_UPDATE__.downloads);

async function openCard(page: Page): Promise<Locator> {
  await installFakeDesktopShell(page, { update: { version: VERSION, notes: NOTES } });
  await installMockBackend(page, { mode: "local" });
  await page.goto("/library");
  const card = page.getByTestId("update-prompt");
  await expect(card.getByTestId("update-version")).toHaveText(`v${VERSION}`);
  return card;
}

/** Starts the download and brings it to 120 MB of 190 MB, then to a reconnect. */
async function downloadUntilRetrying(page: Page, card: Locator): Promise<void> {
  await card.getByTestId("update-download").click();
  await expect.poll(() => downloads(page)).toBe(1);
  await emit(page, { event: "Started", data: { contentLength: TOTAL } });
  await emit(page, { event: "Progress", data: { chunkLength: 120 * MB } });
  await expect(card.getByTestId("update-progress")).toContainText("正在下载 63%（120.0 MB / 190.0 MB）");
  await expect(card.getByTestId("update-retrying")).toHaveCount(0);
  await emit(page, { event: "Retrying", data: { attempt: 2, delayMs: 2000 } });
  await expect(card.getByTestId("update-retrying")).toHaveText("网络中断，正在接着下载（第 2 次）");
  // The bar keeps its place while the shell reconnects.
  await expect(card.locator("progress")).toHaveJSProperty("value", 120 * MB);
}

async function failInterrupted(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      void (window as unknown as { __AMBER_E2E_UPDATE__: FakeUpdateDriver }).__AMBER_E2E_UPDATE__.fail({
        kind: "interrupted",
        attempts: 5,
        detail: "error decoding response body: https://release-assets.example/amber-setup.exe",
      }),
  );
}

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not laid out");
  return found;
}

function inside(inner: Box, outer: Box): boolean {
  const slack = 0.5;
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
}

test("a dropped download shows the reconnect, then the failure with a way on; a retry continues", async ({ page }) => {
  const card = await openCard(page);
  await downloadUntilRetrying(page, card);
  await failInterrupted(page);

  const failure = card.getByTestId("update-failure");
  await expect(failure).toHaveAttribute("role", "alert");
  await expect(failure).toContainText("下载没能完成");
  await expect(failure).toContainText("已自动重连 5 次，下载到 63%（120.0 MB / 190.0 MB）");
  await expect(card.getByTestId("update-progress")).toHaveCount(0);
  const link = card.getByTestId("update-browser-download");
  await expect(link).toHaveAttribute("href", `https://github.com/lifefindsitsway/Amber/releases/tag/v${VERSION}`);
  await expect(link).toHaveAttribute("target", "_blank");

  // The technical details stay folded until asked for, and carry no query string.
  const details = card.getByTestId("update-failure-details");
  await expect(details).not.toHaveAttribute("open");
  await expect(details.getByText("自动重连 5 次")).toBeHidden();
  await details.getByText("技术信息").click();
  await expect(details).toHaveAttribute("open");
  await expect(details).toContainText("步骤：下载");
  await expect(details).toContainText("自动重连 5 次");
  await expect(details).toContainText("error decoding response body: https://release-assets.example/amber-setup.exe");
  expect(await details.textContent()).not.toContain("?");

  // One primary action, the retry (the primary button's accent ground marks it).
  await expect(card.locator("button.bg-accent-glow")).toHaveCount(1);
  await expect(card.getByTestId("update-retry")).toHaveClass(/bg-accent-glow/);
  await card.getByTestId("update-retry").click();
  await expect.poll(() => downloads(page)).toBe(2);
  await expect(card.getByTestId("update-failure")).toHaveCount(0);
  await emit(page, { event: "Resumed", data: { downloaded: 120 * MB } });
  await emit(page, { event: "Started", data: { contentLength: TOTAL } });
  await expect(card.getByTestId("update-progress")).toContainText("63%");
  await emit(page, { event: "Progress", data: { chunkLength: 70 * MB } });
  await emit(page, { event: "Finished" });
  await page.evaluate(() => (window as unknown as { __AMBER_E2E_UPDATE__: FakeUpdateDriver }).__AMBER_E2E_UPDATE__.finish());
  await expect(card.getByTestId("update-install")).toBeVisible();
});

test("「稍后」 closes a failed card", async ({ page }) => {
  const card = await openCard(page);
  await card.getByTestId("update-download").click();
  await expect.poll(() => downloads(page)).toBe(1);
  await page.evaluate(
    () => void (window as unknown as { __AMBER_E2E_UPDATE__: FakeUpdateDriver }).__AMBER_E2E_UPDATE__.fail({ kind: "server", status: 503, attempts: 1, detail: "server returned 503" }),
  );
  await expect(card.getByTestId("update-failure")).toContainText("服务器返回 503");
  await card.getByTestId("update-later").click();
  await expect(page.getByTestId("update-prompt")).toHaveCount(0);
});

test("in a 1024×640 window the failed card fits, and its text, link and buttons do not run together", async ({ page }) => {
  await page.setViewportSize(SMALL);
  const card = await openCard(page);
  await downloadUntilRetrying(page, card);
  const viewport: Box = { x: 0, y: 0, ...SMALL };
  expect(inside(await box(card), viewport)).toBe(true);

  await failInterrupted(page);
  const failure = card.getByTestId("update-failure");
  await expect(failure).toBeVisible();
  await card.getByTestId("update-failure-details").getByText("技术信息").click();
  const cardBox = await box(card);
  expect(inside(cardBox, viewport)).toBe(true);
  // No horizontal overflow anywhere in the card.
  expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await failure.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

  // The link sits on its own line under the explanation, not glued to its end.
  const body = await box(failure.locator("p").first());
  const link = await box(card.getByTestId("update-browser-download"));
  expect(link.y).toBeGreaterThanOrEqual(body.y + body.height - 0.5);
  const details = await box(card.getByTestId("update-failure-details"));
  expect(details.y).toBeGreaterThanOrEqual(link.y + link.height - 0.5);
  expect(inside(await box(failure), cardBox)).toBe(true);

  // The footer: 先导出备份 · 稍后 · 重试, inside the card on one row, under the notice.
  const footer = [card.getByTestId("update-backup-first"), card.getByTestId("update-later"), card.getByTestId("update-retry")];
  const boxes = await Promise.all(footer.map(box));
  for (const entry of boxes) {
    expect(inside(entry, cardBox)).toBe(true);
    expect(entry.y).toBeGreaterThanOrEqual((await box(failure)).y + (await box(failure)).height);
  }
  expect(new Set(boxes.map((entry) => Math.round(entry.y))).size).toBe(1);
  // The notes gave way: they still show, shortened, with the fade saying there is more.
  await expect(card.getByTestId("update-notes")).toBeVisible();
  await expect(card.getByTestId("update-notes-fade")).toBeVisible();
});
