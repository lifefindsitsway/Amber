import { expect, test } from "@playwright/test";
import { BILIBILI_CONTENT, installMockBackend } from "./mock-backend.ts";
import { BASIS_COLLECTION, BASIS_CONTENT, installSpeakerBasis } from "./mock-outputs.ts";
import { figureCaptions } from "./mock-search.ts";

const [CAPTURED, UPLOADED, IN_COLLECTION] = figureCaptions();

test("Omnibox search: figure captions are their own group, told apart within a Content, and open the reading view at the figure", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await page.keyboard.press("Control+K");
  const omnibox = page.getByTestId("omnibox");
  await omnibox.locator("input").fill("梯度下降");

  const group = omnibox.getByTestId("omnibox-group-figures");
  await expect(group).toBeVisible();
  await expect(group.getByText("插图备注", { exact: true })).toBeVisible();
  // Nothing else holds the words: the captions are the only hits.
  for (const other of ["contents", "segments", "summaries", "collections", "speakers"]) {
    await expect(omnibox.getByTestId(`omnibox-group-${other}`)).toHaveCount(0);
  }
  const options = group.getByRole("option");
  await expect(options).toHaveCount(2);
  // Two figures of one lecture: the capture by its time, the upload by its place.
  await expect(options.nth(0)).toHaveAccessibleName(`${CAPTURED.caption} ${CAPTURED.contentTitle} · 截图 1:20`);
  await expect(options.nth(1)).toHaveAccessibleName(`${UPLOADED.caption} ${UPLOADED.contentTitle} · 图 2`);
  await expect(options.nth(1).locator("mark")).toHaveText("梯度下降");

  // Keyboard only: down to the second, Enter opens it.
  await omnibox.locator("input").press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await omnibox.locator("input").press("Enter");
  await expect(page).toHaveURL(new RegExp(`/contents/${BILIBILI_CONTENT}\\?`));
  const url = new URL(page.url());
  expect(url.searchParams.get("tab")).toBe("transcript");
  expect(url.searchParams.get("figure")).toBe(UPLOADED.figureId);
  expect(url.searchParams.get("search")).toBe("梯度下降");
  await expect(page.getByTestId("output-tab-transcript")).toHaveAttribute("aria-selected", "true");
  expect(backend.mutations).toEqual([]);
});

test("Library search: a Content found only by a figure caption is listed once, its excerpt naming the figure", async ({ page }) => {
  await installMockBackend(page);
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(1);

  await page.getByTestId("library-search").fill("梯度下降");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  const snippet = page.getByTestId("search-snippet");
  await expect(snippet).toHaveCount(1);
  // The best hit stands for the Content: the captured figure, labelled with its time.
  await expect(snippet).toHaveText(`截图 1:20${CAPTURED.caption}`);
  await expect(snippet.locator("mark")).toHaveText("梯度下降");
  const href = new URL((await snippet.getAttribute("href")) ?? "", "http://x");
  expect(href.pathname).toBe(`/contents/${BILIBILI_CONTENT}`);
  expect(Object.fromEntries(href.searchParams)).toEqual({ tab: "transcript", figure: CAPTURED.figureId, search: "梯度下降" });

  await snippet.click();
  await expect(page).toHaveURL(new RegExp(`figure=${CAPTURED.figureId}`));
  await expect(page.getByTestId("output-tab-transcript")).toHaveAttribute("aria-selected", "true");
});

test("Collection search: a member found by a figure caption is listed with the figure's excerpt", async ({ page }) => {
  await installMockBackend(page);
  await installSpeakerBasis(page);
  await page.goto(`/collections/${BASIS_COLLECTION}`);
  await page.getByTestId("collection-search").fill("白板照片");
  const hits = page.getByTestId("collection-hit");
  await expect(hits).toHaveCount(1);
  const snippet = hits.getByTestId("search-snippet");
  await expect(snippet).toHaveText(`图 1${IN_COLLECTION.caption}`);
  const href = new URL((await snippet.getAttribute("href")) ?? "", "http://x");
  expect(href.pathname).toBe(`/contents/${BASIS_CONTENT}`);
  expect(href.searchParams.get("figure")).toBe(IN_COLLECTION.figureId);
  expect(href.searchParams.get("tab")).toBe("transcript");
});
