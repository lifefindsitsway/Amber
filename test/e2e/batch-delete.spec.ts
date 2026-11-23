import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend, syntheticContentId, syntheticContentTitle } from "./mock-backend.ts";

/*
 * The library's batch delete: pick rows, the dialog's pre-check counts what can go now and
 * what needs its Tasks cancelled first, one confirmation cancels and moves both, and the trash
 * then lists them.
 */

function libraryRow(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="library-row"][data-content-id="${contentId}"]`);
}

function trashRow(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="trash-row"][data-content-id="${contentId}"]`);
}

test("picked rows, one with an unfinished task, are cancelled and moved to the trash in one go", async ({ page }) => {
  const backend = await installMockBackend(page, { libraryContents: 3 });
  const plain = syntheticContentId(1);
  const busy = syntheticContentId(2);
  backend.trash.seedTasks(busy, 1);
  await page.goto("/library");

  await expect(libraryRow(page, plain)).toBeVisible();
  await page.getByTestId("library-select-mode").click();
  await page.getByRole("checkbox", { name: `选择「${syntheticContentTitle(1)}」` }).check();
  await page.getByRole("checkbox", { name: `选择「${syntheticContentTitle(2)}」` }).check();
  await expect(page.getByTestId("library-selection-count")).toHaveText("已选 2 项");

  await page.getByTestId("library-delete-selected").click();
  const dialog = page.getByTestId("delete-content-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("delete-plan-ready")).toHaveText("可直接删除 1 项");
  await expect(dialog.getByTestId("delete-plan-tasks")).toHaveText("需要先取消任务 1 项");
  await expect(dialog.getByTestId("delete-plan-blocked")).toHaveCount(0);
  await expect(dialog.getByTestId("delete-tasks-note")).toBeVisible();
  // Nothing is deleted before the confirmation.
  expect(backend.mutations.filter((mutation) => mutation.path === "/api/contents/trash")).toEqual([]);

  const confirm = dialog.getByTestId("delete-confirm");
  await expect(confirm).toHaveText("取消任务并删除 2 项");
  await confirm.click();
  await expect(dialog).toBeHidden();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("已将 2 项移入回收站");
  await expect(libraryRow(page, plain)).toHaveCount(0);
  await expect(libraryRow(page, busy)).toHaveCount(0);
  await expect(page.getByTestId("library-selection-bar")).toHaveCount(0);

  const sent = backend.mutations.filter((mutation) => mutation.method === "POST" && mutation.path === "/api/contents/trash");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toEqual({ contentIds: [plain, busy], cancelTasks: true });
  expect(backend.trash.unfinishedTasks(busy)).toBe(0);
  expect(backend.trash.ids().sort()).toEqual([plain, busy].sort());

  await toast.getByTestId("toast-action").click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(trashRow(page, plain)).toContainText(syntheticContentTitle(1));
  await expect(trashRow(page, busy)).toContainText(syntheticContentTitle(2));
});
