import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend } from "./mock-backend.ts";
import { SPEAKERS_CONTENT } from "./mock-speakers.ts";

/*
 * A two-step button confirms in place: arming it swaps its label for the confirmation, which
 * must not move or resize it or the buttons beside it, or the second press could land on a
 * neighbour that slid under the pointer.
 */

/** How far a box may move between renders, in CSS px (sub-pixel rounding only). */
const BOX_TOLERANCE_PX = 0.5;
/** The speakers lecture loads its whole draft before the editor takes input. */
const EDITOR_OPEN_TIMEOUT_MS = 60_000;

async function boxes(locators: readonly Locator[]): Promise<Array<{ x: number; width: number }>> {
  const result: Array<{ x: number; width: number }> = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    if (box === null) throw new Error("button not laid out");
    result.push({ x: box.x, width: box.width });
  }
  return result;
}

function expectSameBoxes(after: ReadonlyArray<{ x: number; width: number }>, before: ReadonlyArray<{ x: number; width: number }>): void {
  expect(after).toHaveLength(before.length);
  before.forEach((box, index) => {
    expect(Math.abs((after[index]?.x ?? Number.NaN) - box.x), `x of button ${index}`).toBeLessThanOrEqual(BOX_TOLERANCE_PX);
    expect(Math.abs((after[index]?.width ?? Number.NaN) - box.width), `width of button ${index}`).toBeLessThanOrEqual(BOX_TOLERANCE_PX);
  });
}

async function armAndCompare(page: Page, button: Locator, neighbours: readonly Locator[]): Promise<void> {
  const all = [button, ...neighbours];
  const before = await boxes(all);
  await button.click();
  await expect(button).toHaveAttribute("data-armed", "");
  expectSameBoxes(await boxes(all), before);
  // Esc puts the label back, again without moving anything.
  await page.keyboard.press("Escape");
  await expect(button).not.toHaveAttribute("data-armed", "");
  expectSameBoxes(await boxes(all), before);
}

test("the editor's 放弃草稿 keeps its place and width, and its neighbours theirs, when it asks for confirmation", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript`);
  await page.getByTestId("transcript-edit").click();
  const discard = page.getByTestId("draft-discard");
  await expect(discard).toBeEnabled({ timeout: EDITOR_OPEN_TIMEOUT_MS });
  await expect(discard).toHaveAccessibleName("放弃草稿");
  await armAndCompare(page, discard, [page.getByTestId("editor-undo"), page.getByTestId("draft-exit")]);
  // Esc on the armed button left the editor open.
  await expect(page.getByTestId("draft-editor")).toBeVisible();
});

test("清除价格 keeps its place and width when it asks for confirmation, and Esc then leaves the dialog open", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/settings/models");
  const llm = page.locator('[data-model="mock-model"]');
  await llm.getByRole("button", { name: "价格 · mock-model" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("单价 1").fill("0.8");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  await llm.getByRole("button", { name: "价格 · mock-model" }).click();
  const clear = dialog.getByTestId("pricing-clear");
  await expect(clear).toHaveAccessibleName("清除价格");
  await armAndCompare(page, clear, [dialog.getByRole("button", { name: "取消" }), dialog.getByRole("button", { name: "保存" })]);
  await expect(dialog).toBeVisible();
  // Arming sent nothing: only the save above reached the server.
  expect(backend.mutations.map((mutation) => mutation.method)).toEqual(["PUT"]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
