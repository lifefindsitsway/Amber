import { expect, test, type Locator, type Page } from "@playwright/test";
import { TRASH_RETENTION_DAYS } from "../../src/shared/defaults.ts";
import { BILIBILI_CONTENT, installMockBackend } from "./mock-backend.ts";
import { EXPIRED_TRASH_CONTENT, EXPIRED_TRASH_TITLE } from "./mock-trash.ts";

/*
 * The trash: deleting only moves a Content there, it can be restored
 * until its retention runs out, and purging asks twice.
 */

const BILIBILI_TITLE = "第二讲：B 站模拟课程";

function libraryRow(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="library-row"][data-content-id="${contentId}"]`);
}

function trashRow(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="trash-row"][data-content-id="${contentId}"]`);
}

/**
 * The confirm action of an open ConfirmDialog: the last button, after 取消 (the close
 * icon comes first). Its label differs per dialog (删除 / 彻底删除 / 清空回收站), so it is
 * not matched by text.
 */
function confirmButton(dialog: Locator): Locator {
  return dialog.getByRole("button").last();
}

test("deleting moves a content to the trash, restoring brings it back", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/library");

  const row = libraryRow(page, BILIBILI_CONTENT);
  await expect(row).toBeVisible();
  // Deleting lives in the row's 「⋯」 menu, never on the row itself.
  await row.getByTestId("content-row-menu").click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  const dialog = page.getByRole("dialog");
  // The dialog says where the content goes and for how long.
  await expect(dialog).toContainText("回收站");
  await expect(dialog).toContainText(`${TRASH_RETENTION_DAYS} 天`);
  await expect(confirmButton(dialog)).not.toHaveText("取消");
  await confirmButton(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  expect(backend.trash.ids()).toEqual([BILIBILI_CONTENT]);

  await page.getByRole("link", { name: "回收站", exact: true }).click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(page.getByTestId("trash-page")).toBeVisible();
  const trashed = trashRow(page, BILIBILI_CONTENT);
  await expect(trashed).toContainText(BILIBILI_TITLE);
  // Just deleted: the whole retention is left, give or take the rounding of the last day.
  await expect(trashed.getByTestId("trash-status")).toHaveText(new RegExp(`^(${TRASH_RETENTION_DAYS}|${TRASH_RETENTION_DAYS - 1}) 天后彻底删除$`));
  // Nothing is purged without asking.
  expect(backend.mutations.filter((mutation) => mutation.path.startsWith("/api/trash"))).toEqual([]);

  await trashed.getByTestId("trash-restore").click();
  await expect(trashed).toHaveCount(0);
  await expect(page.getByTestId("trash-empty")).toBeVisible();
  expect(backend.mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toContain(`POST /api/trash/${BILIBILI_CONTENT}/restore`);
  expect(backend.trash.ids()).toEqual([]);

  await page.getByRole("link", { name: "全部内容", exact: true }).click();
  await expect(libraryRow(page, BILIBILI_CONTENT)).toBeVisible();
});

test("purging one item asks before it deletes; an empty trash cannot be emptied", async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.trash.seed(BILIBILI_CONTENT);
  await page.goto("/trash");

  const trashed = trashRow(page, BILIBILI_CONTENT);
  await expect(trashed).toBeVisible();
  await expect(page.getByTestId("trash-empty-all")).toBeEnabled();

  // First step: the button only opens the question; cancelling keeps the item.
  await trashed.getByTestId("trash-purge").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  await expect(trashed).toBeVisible();
  expect(backend.trash.purged()).toEqual([]);

  // Second step: confirming purges it.
  await trashed.getByTestId("trash-purge").click();
  await expect(dialog).toContainText(BILIBILI_TITLE);
  await confirmButton(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(trashed).toHaveCount(0);
  expect(backend.trash.purged()).toEqual([BILIBILI_CONTENT]);
  expect(backend.mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toContain(`DELETE /api/trash/${BILIBILI_CONTENT}`);

  await expect(page.getByTestId("trash-empty")).toBeVisible();
  await expect(page.getByTestId("trash-empty-all")).toBeDisabled();

  // Purged for good: it does not come back to the library either.
  await page.getByRole("link", { name: "全部内容", exact: true }).click();
  await expect(page.getByTestId("library-row")).toHaveCount(0);
});

test("emptying the trash purges every item after confirming", async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.trash.seedExpired();
  backend.trash.seed(BILIBILI_CONTENT);
  await page.goto("/trash");

  // Newest deletion first.
  const rows = page.getByTestId("trash-row");
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-content-id")))).toEqual([BILIBILI_CONTENT, EXPIRED_TRASH_CONTENT]);

  await page.getByTestId("trash-empty-all").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(backend.trash.purged()).toEqual([]);
  await confirmButton(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(0);
  expect(backend.mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toContain("DELETE /api/trash");
  expect([...backend.trash.purged()].sort()).toEqual([BILIBILI_CONTENT, EXPIRED_TRASH_CONTENT].sort());
  await expect(page.getByTestId("trash-empty")).toBeVisible();
  await expect(page.getByTestId("trash-empty-all")).toBeDisabled();
});

test("an expired item waits for the sweep and cannot be restored", async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.trash.seedExpired();
  await page.goto("/trash");

  const expired = trashRow(page, EXPIRED_TRASH_CONTENT);
  await expect(expired).toContainText(EXPIRED_TRASH_TITLE);
  await expect(expired.getByTestId("trash-status")).toHaveText("已到期，等待清理");
  await expect(expired.getByTestId("trash-restore")).toBeDisabled();
  // It can still be purged by hand.
  await expect(expired.getByTestId("trash-purge")).toBeEnabled();
  expect(backend.mutations).toEqual([]);
});

test("picked entries are restored together; the expired one is reported and stays picked", async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.trash.seedExpired();
  backend.trash.seed(BILIBILI_CONTENT);
  await page.goto("/trash");

  await expect(page.getByTestId("trash-row")).toHaveCount(2);
  await page.getByTestId("trash-select-mode").click();
  await page.getByTestId("trash-select-page").check();
  await expect(page.getByTestId("trash-selection-count")).toHaveText("已选 2 项");
  await page.getByTestId("trash-restore-selected").click();

  const report = page.getByTestId("trash-restore-report");
  await expect(report).toBeVisible();
  await expect(report).toContainText("已恢复 1 项，1 项未能恢复");
  const failed = report.getByTestId("trash-restore-report-item");
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText(EXPIRED_TRASH_TITLE);
  await expect(failed).toContainText("已到期，不能再恢复");
  expect(backend.mutations.filter((mutation) => mutation.path === "/api/trash/restore").map((mutation) => mutation.body)).toEqual([
    { contentIds: [BILIBILI_CONTENT, EXPIRED_TRASH_CONTENT] },
  ]);
  expect(backend.trash.ids()).toEqual([EXPIRED_TRASH_CONTENT]);

  await report.getByTestId("trash-restore-report-close").click();
  await expect(report).toBeHidden();
  await expect(trashRow(page, BILIBILI_CONTENT)).toHaveCount(0);
  await expect(page.getByTestId("trash-selection-count")).toHaveText("已选 1 项");

  await page.getByRole("link", { name: "全部内容", exact: true }).click();
  await expect(libraryRow(page, BILIBILI_CONTENT)).toBeVisible();
});
