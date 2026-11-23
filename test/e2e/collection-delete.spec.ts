import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend, syntheticContentId, syntheticContentTitle } from "./mock-backend.ts";
import { mockCollections } from "./mock-collections.ts";

/*
 * Deleting a collection: along with the members found in no other collection (they go to the
 * trash, shared ones stay), or the collection alone; and removing picked lectures from a
 * collection through the selection bar.
 */

const COURSE = "01J0000000000000000000KC01";
const OTHER = "01J0000000000000000000KC02";

function libraryRow(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="library-row"][data-content-id="${contentId}"]`);
}

function trashRow(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="trash-row"][data-content-id="${contentId}"]`);
}

function lecture(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="collection-item"][data-content-id="${contentId}"]`);
}

const member = (index: number) => ({ contentId: syntheticContentId(index), title: syntheticContentTitle(index) });

async function setUp(page: Page) {
  const backend = await installMockBackend(page, { libraryContents: 3 });
  const collections = mockCollections(page, backend.trash);
  collections.seed({ id: COURSE, name: "模拟课程", members: [member(1), member(2), member(3)] });
  // The second lecture is in another collection too: deleting the course keeps it.
  collections.seed({ id: OTHER, name: "精选", members: [member(2)] });
  return { backend, collections };
}

async function openDeleteDialog(page: Page): Promise<Locator> {
  await page.goto(`/collections/${COURSE}`);
  await expect(lecture(page, syntheticContentId(1))).toBeVisible();
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByTestId("collection-delete").click();
  const dialog = page.getByTestId("delete-collection-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("deleting a collection with its contents moves the ones found nowhere else to the trash", async ({ page }) => {
  const { backend, collections } = await setUp(page);
  const dialog = await openDeleteDialog(page);
  await expect(dialog.getByRole("radio", { name: "删除合集和其中的 2 项内容" })).toBeChecked();
  await expect(dialog.getByTestId("delete-collection-choice-exclusive")).toContainText("另有 1 项还在其它合集里，会保留。");
  const confirm = dialog.getByTestId("delete-collection-confirm");
  await expect(confirm).toHaveText("删除合集和 2 项内容");
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/collections$/);
  await expect(page.getByTestId("toast")).toContainText("已删除合集「模拟课程」，2 项内容移入回收站");

  expect(collections.ids()).toEqual([OTHER]);
  expect(backend.trash.ids().sort()).toEqual([syntheticContentId(1), syntheticContentId(3)].sort());
  const sent = backend.mutations.filter((mutation) => mutation.method === "POST" && mutation.path === `/api/collections/${COURSE}/delete`);
  expect(sent.map((mutation) => mutation.body)).toEqual([{ contents: "exclusive", cancelTasks: false, expectedContentIds: [syntheticContentId(1), syntheticContentId(3)] }]);

  await page.getByTestId("toast").getByTestId("toast-action").click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(trashRow(page, syntheticContentId(1))).toContainText(syntheticContentTitle(1));
  await expect(trashRow(page, syntheticContentId(3))).toContainText(syntheticContentTitle(3));
  await expect(trashRow(page, syntheticContentId(2))).toHaveCount(0);
});

test("deleting only the collection keeps every content in the library", async ({ page }) => {
  const { backend, collections } = await setUp(page);
  const dialog = await openDeleteDialog(page);
  await dialog.getByRole("radio", { name: "只删除合集" }).check();
  const confirm = dialog.getByTestId("delete-collection-confirm");
  await expect(confirm).toHaveText("删除合集");
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/collections$/);
  expect(collections.ids()).toEqual([OTHER]);
  expect(backend.trash.ids()).toEqual([]);

  await page.goto("/library");
  for (const index of [1, 2, 3]) await expect(libraryRow(page, syntheticContentId(index))).toBeVisible();
});

test("picked lectures leave the collection together and stay in the library", async ({ page }) => {
  const { backend, collections } = await setUp(page);
  await page.goto(`/collections/${COURSE}`);
  await expect(lecture(page, syntheticContentId(1))).toBeVisible();
  await page.getByTestId("collection-select-mode").click();
  await page.getByRole("checkbox", { name: `选择「${syntheticContentTitle(1)}」` }).check();
  await page.getByRole("checkbox", { name: `选择「${syntheticContentTitle(3)}」` }).check();
  await expect(page.getByTestId("collection-selection-count")).toHaveText("已选 2 项");
  await page.getByTestId("collection-remove-selected").click();
  await expect(page.getByTestId("toast")).toContainText("已将 2 项移出合集");
  await expect(lecture(page, syntheticContentId(1))).toHaveCount(0);
  await expect(lecture(page, syntheticContentId(3))).toHaveCount(0);
  await expect(lecture(page, syntheticContentId(2))).toBeVisible();
  expect(collections.members(COURSE)).toEqual([syntheticContentId(2)]);
  expect(backend.trash.ids()).toEqual([]);

  await page.goto("/library");
  await expect(libraryRow(page, syntheticContentId(1))).toBeVisible();
});
