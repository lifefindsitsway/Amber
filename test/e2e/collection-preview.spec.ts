import { expect, test } from "@playwright/test";
import { installMockBackend } from "./mock-backend.ts";
import { PREVIEW_COLLECTION, PREVIEW_ENTRY_COUNT, PREVIEW_LIST_TITLE, PREVIEW_LIST_URL, previewEntryId } from "./mock-collection-preview.ts";
import { COLLECTION_PREVIEW_PAGE_SIZE } from "../../src/shared/defaults.ts";

/** Positions the fake playlist lists as already in the collection, in the trash or unavailable. */
const NOT_CHOSEN_BY_DEFAULT = [4, 6, 8];

test("collection preview: choose entries across pages, set the processing order, import and open the collection", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/new");

  await page.getByTestId("new-url-input").fill(PREVIEW_LIST_URL);
  await expect(page.getByTestId("link-recognition-text")).toHaveText("已识别 1 个合集，开始处理前可以挑选内容并安排顺序");
  await page.getByRole("button", { name: "预览合集" }).click();

  const dialog = page.getByRole("dialog", { name: PREVIEW_LIST_TITLE });
  const rows = dialog.getByTestId("preview-entry");
  await expect(rows).toHaveCount(COLLECTION_PREVIEW_PAGE_SIZE);
  const defaultChosen = COLLECTION_PREVIEW_PAGE_SIZE - NOT_CHOSEN_BY_DEFAULT.length;
  await expect(dialog.getByTestId("preview-chosen-count")).toHaveText(`· 已选 ${defaultChosen} 项`);
  await expect(rows.nth(4)).toHaveAttribute("data-chosen", "false");
  await expect(rows.nth(6).getByRole("checkbox")).toBeDisabled();

  // Leave out the first entry.
  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute("data-chosen", "false");

  // The end of the list in view reads the second page; one of its entries is chosen too.
  await dialog.getByTestId("preview-more").scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(PREVIEW_ENTRY_COUNT);
  await expect(dialog.getByTestId("preview-more")).toHaveCount(0);
  const late = PREVIEW_ENTRY_COUNT - 2;
  await expect(rows.nth(late)).toHaveAttribute("data-chosen", "false");
  await rows.nth(late).click();
  await expect(rows.nth(0)).toHaveAttribute("data-chosen", "false");
  await expect(dialog.getByTestId("preview-chosen-count")).toHaveText(`· 已选 ${defaultChosen} 项`);

  // The last of the processing order goes first.
  await dialog.getByRole("tab", { name: `处理顺序 · ${defaultChosen}` }).click();
  const orderRows = dialog.getByTestId("preview-order-row");
  await expect(orderRows).toHaveCount(defaultChosen);
  await orderRows.last().getByRole("button", { name: "移到最前" }).click();
  await expect(orderRows.first()).toHaveAttribute("data-entry-id", previewEntryId(late));

  await dialog.getByRole("button", { name: `开始处理 ${defaultChosen} 项` }).click();
  await expect(page).toHaveURL(new RegExp(`/collections/${PREVIEW_COLLECTION}$`));

  const firstPage = Array.from({ length: COLLECTION_PREVIEW_PAGE_SIZE }, (_, index) => index).filter((index) => index !== 0 && !NOT_CHOSEN_BY_DEFAULT.includes(index));
  const imports = backend.mutations.filter((mutation) => mutation.path === "/api/contents/import");
  expect(imports).toHaveLength(1);
  expect(imports[0]?.body).toMatchObject({
    items: [{ url: PREVIEW_LIST_URL, entries: [previewEntryId(late), ...firstPage.map(previewEntryId)], previewId: "mock-preview-1" }],
    confirmCollections: true,
  });
  // The collection itself lists the members in the platform's order.
  await expect(page.getByTestId("collection-item").first()).toContainText("第 2 讲");
});
