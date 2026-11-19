import { expect, test, type Locator, type Page } from "@playwright/test";
import { BUSY, COURSE, EXPORT_SCENARIO, FAVOURITES, IMPORTED, LECTURE_1, LECTURE_2 } from "./content-pack-fixtures.ts";
import { installMockBackend } from "./mock-backend.ts";
import { installContentPackMock, installFakeDesktopShell } from "./mock-content-pack.ts";

/*
 * Exporting a content pack: picked in the library (or from a collection or a Content), decided
 * card by card, confirmed, then saved where the desktop client was told or downloaded as a
 * plain link in server mode.
 */

const SHOTS = process.env["AMBER_E2E_SHOTS"];

function row(page: Page, contentId: string): Locator {
  return page.locator(`[data-testid="library-row"][data-content-id="${contentId}"]`);
}

function card(dialog: Locator, contentId: string): Locator {
  return dialog.locator(`[data-testid="pack-export-card"][data-content-id="${contentId}"]`);
}

test("server mode: pick in the library, decide per card, confirm, download", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  const pack = await installContentPackMock(page, EXPORT_SCENARIO, { mode: "server" });
  await page.goto("/library");
  await expect(row(page, LECTURE_1)).toBeVisible();

  await page.getByTestId("library-select-mode").click();
  await page.getByRole("checkbox", { name: "选择「第一讲：检索增强生成」" }).check();
  await page.getByRole("checkbox", { name: "选择「第二讲：评测与对齐」" }).check();
  // A row's plain area picks it too.
  await row(page, BUSY).locator("td").nth(3).click();
  await expect(page.getByTestId("library-selection-count")).toHaveText("已选 3 项");
  await page.getByTestId("library-export-selected").click();

  const dialog = page.getByRole("dialog", { name: "导出内容包" });
  await expect(dialog.getByTestId("pack-export-card")).toHaveCount(3);
  const first = card(dialog, LECTURE_1);
  const second = card(dialog, LECTURE_2);
  // Only the first card is open; the others read as one line.
  await expect(first.getByTestId("pack-export-card-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(second.getByTestId("pack-export-card-summary")).toHaveText("字幕 1 版");
  // A Content whose task is still running says which task, and cannot be opened.
  await expect(card(dialog, BUSY)).toContainText("「翻译」任务还没有结束，结束或取消后才能导出这一条。");
  // The current English translation pulls in the transcript it was made from.
  await expect(first.getByTestId("pack-hint-translationParents")).toContainText("译文离不开它的原文，已一并带上");
  await expect(first.getByTestId("pack-export-card-summary")).toHaveText("字幕 2 版 · 译文 1 种 · 插图 4 张");
  // Leaving the transcript out (translations off too) warns where it matters.
  await first.getByRole("checkbox", { name: /翻译 · 英语/ }).uncheck();
  await expect(first.getByTestId("pack-hint-standalone")).toContainText("到新设备上它会成为一份独立的文稿");
  await expect(first.getByTestId("pack-hint-figuresOnUnselected")).toContainText("有 2 张插图的位置依据未选的版本");
  await first.getByTestId("pack-notes").check();
  await expect(first.getByTestId("pack-hint-notesOnUnselected")).toContainText("有 3 条笔记标在未选的版本上");
  await first.getByTestId("pack-hint-notesOnUnselected").getByRole("button", { name: "一并带上这些版本" }).click();
  await expect(first.getByTestId("pack-transcripts-pick")).toBeChecked();
  await expect(first.getByTestId("pack-hint-notesOnUnselected")).toHaveCount(0);
  await expect(first.getByTestId("pack-hint-standalone")).toHaveCount(0);
  // Files: the 720P cache goes along.
  await first.getByTestId("pack-media").filter({ hasText: "720P" }).getByRole("checkbox").check();
  await expect(first.getByTestId("pack-export-card-summary")).toHaveText("字幕 2 版 · 插图 4 张 · 笔记 4 条 · 视频 384.0 MB");
  // 「应用到全部」 says what it carries before it does it.
  await expect(first.getByText(/把这一条的选择套用到另外 1 条：字幕稿带当前版本（指定版本只适用于这一条）、译文不带、带插图与备注、带笔记、带全部清晰度的平台缓存/)).toBeVisible();
  await first.getByTestId("pack-apply-all").click();
  await expect(second.getByTestId("pack-export-card-summary")).toHaveText("字幕 1 版 · 笔记 2 条");

  // Collections: how many of their members go this time.
  const collections = dialog.getByTestId("pack-export-collections");
  await expect(collections).toContainText("生成式软件工程本次带 2 / 共 20 条");
  await expect(collections).toContainText("收藏本次带 1 / 共 7 条");
  await collections.locator(`[data-collection-id="${FAVOURITES}"]`).uncheck();
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/export-wizard-light.png` });

  await dialog.getByTestId("pack-export-next").click();
  const confirm = dialog.getByTestId("pack-export-confirm");
  await expect(confirm).toContainText("不导出：「第三讲：正在翻译的一讲」");
  await expect(confirm).toContainText("合集：「生成式软件工程」");
  await expect(confirm.getByTestId("pack-export-size")).toHaveText("合计约 384.0 MB（按登记大小估算，实际以导出时为准）");
  await expect(confirm.getByTestId("pack-export-notice")).toContainText("内容包未加密，包含你的文字与媒体。");
  await expect(confirm.getByTestId("pack-export-checks")).toContainText("所选资料之间没有缺失的依赖。");
  await confirm.getByTestId("pack-export-start").click();

  const job = dialog.getByTestId("pack-export-job");
  await expect(job).toHaveAttribute("data-status", "succeeded");
  const link = job.getByTestId("pack-export-download");
  await expect(link).toContainText("生成式软件工程 20261118-1030.amberpack");
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("生成式软件工程 20261118-1030.amberpack");

  const sent = pack.calls.find((call) => call.path === "/api/content-packs/exports")?.body as {
    selection: { contents: Array<{ contentId: string; revisionIds: string[]; notes: boolean; mediaAssetIds: string[] }>; collectionIds: string[] };
    grant?: unknown;
  };
  expect(sent.grant).toBeUndefined();
  expect(sent.selection.collectionIds).toEqual([COURSE]);
  expect(sent.selection.contents.map((item) => item.contentId)).toEqual([LECTURE_1, LECTURE_2]);
  expect(sent.selection.contents[0]).toMatchObject({ revisionIds: [`${LECTURE_1}A`, `${LECTURE_1}C`], notes: true, mediaAssetIds: [`${LECTURE_1}W`] });
});

test("desktop client: save where the user picks, with the file's name in the result", async ({ page }) => {
  await installFakeDesktopShell(page, { destination: "D:/Packs/第一讲.amberpack" });
  await installMockBackend(page, { mode: "local" });
  const pack = await installContentPackMock(page, { ...EXPORT_SCENARIO, exportFileName: "第一讲.amberpack" }, { mode: "local" });
  await page.goto("/library");
  await page.getByTestId("library-select-mode").click();
  await page.getByRole("checkbox", { name: "选择「从另一台电脑带来的讲座」" }).check();
  await page.getByTestId("library-export-selected").click();
  const dialog = page.getByRole("dialog", { name: "导出内容包" });
  const only = card(dialog, IMPORTED);
  // A file that is gone is listed, greyed, with why.
  await expect(only.getByTestId("pack-media").filter({ hasText: "lecture-04-old.mp4" })).toContainText("文件已不在原处，不可带");
  await expect(only.getByTestId("pack-media").filter({ hasText: "lecture-04-old.mp4" }).getByRole("checkbox")).toBeDisabled();
  // With neither transcript nor file a local Content cannot go.
  await only.getByTestId("pack-transcripts-none").check();
  await only.getByTestId("pack-media").filter({ hasText: "lecture-04.mp4" }).first().getByRole("checkbox").uncheck();
  await expect(only.getByTestId("pack-hint-nothing")).toBeVisible();
  await expect(dialog.getByTestId("pack-export-next")).toBeDisabled();
  await only.getByTestId("pack-transcripts-current").check();
  await expect(only.getByTestId("pack-hint-nothing")).toHaveCount(0);
  await dialog.getByTestId("pack-export-next").click();
  await dialog.getByRole("button", { name: "选择保存位置并导出" }).click();
  await expect(dialog.getByTestId("pack-export-saved")).toHaveText("已保存为 第一讲.amberpack");
  const shell = (await page.evaluate(() => (window as unknown as { __AMBER_E2E_SHELL_CALLS__: Array<{ command: string; args: Record<string, unknown> }> }).__AMBER_E2E_SHELL_CALLS__)).filter((call) => call.command === "pick_pack_destination");
  expect(shell).toHaveLength(1);
  expect(String(shell[0]?.args["suggestedName"])).toMatch(/^从另一台电脑带来的讲座 \d{8}-\d{4}\.amberpack$/);
  const sent = pack.calls.find((call) => call.path === "/api/content-packs/exports")?.body as { grant: { purpose: string; path: string } };
  expect(sent.grant).toMatchObject({ purpose: "pack_output", path: "D:/Packs/第一讲.amberpack" });
});

test("from a collection page every member and only that collection start ticked", async ({ page }) => {
  await installMockBackend(page);
  const pack = await installContentPackMock(page, EXPORT_SCENARIO);
  await page.goto(`/collections/${COURSE}`);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByTestId("collection-export-pack").click();
  const dialog = page.getByRole("dialog", { name: "导出内容包" });
  await expect(dialog.getByTestId("pack-export-card")).toHaveCount(2);
  const collections = dialog.getByTestId("pack-export-collections");
  await expect(collections.locator(`[data-collection-id="${COURSE}"]`)).toBeChecked();
  await expect(collections.locator(`[data-collection-id="${FAVOURITES}"]`)).not.toBeChecked();
  expect(pack.calls.find((call) => call.path === "/api/content-packs/export-plan")?.body).toEqual({ contentIds: [LECTURE_1, LECTURE_2], collectionId: COURSE });
});

test("「已导入」: its own status, a filter of its own, an empty reading view that holds for it", async ({ page }) => {
  await installMockBackend(page);
  await installContentPackMock(page, EXPORT_SCENARIO);
  await page.goto("/library");
  await expect(row(page, IMPORTED).getByText("已导入", { exact: true })).toBeVisible();
  await page.getByLabel("状态").selectOption({ label: "已导入" });
  await expect(page).toHaveURL(/status=none/);
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await page.goto(`/contents/${IMPORTED}?tab=subtitles`);
  await expect(page.getByText("处理完成，或转录、导入字幕之后，这里会显示原文")).toBeVisible();
});

test("the export wizard by keyboard: cards fold, choices toggle, the dialog closes back to the menu button", async ({ page }) => {
  await installMockBackend(page);
  await installContentPackMock(page, EXPORT_SCENARIO);
  await page.goto("/library");
  await page.getByTestId("library-select-mode").focus();
  await page.keyboard.press("Enter");
  const box = page.getByRole("checkbox", { name: "选择「第二讲：评测与对齐」" });
  await box.focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("library-selection-count")).toHaveText("已选 1 项");
  await page.getByTestId("library-export-selected").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "导出内容包" });
  const toggle = card(dialog, LECTURE_2).getByRole("button", { name: /第二讲：评测与对齐/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // The transcript choice is one radio group with a name.
  await expect(card(dialog, LECTURE_2).getByRole("radiogroup", { name: "字幕稿" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("library-export-selected")).toBeFocused();
  // Esc again (no dialog now) leaves the selection mode.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("library-selection-bar")).toHaveCount(0);
});
