import { expect, test, type Locator, type Page } from "@playwright/test";
import { COURSE, IMPORT_SCENARIO, LECTURE_1, LECTURE_2, LOCAL_TARGET, OTHER_TARGET, PREVIEW, SHARED_SCENARIO } from "./content-pack-fixtures.ts";
import { installMockBackend } from "./mock-backend.ts";
import { installContentPackMock, installFakeDesktopShell } from "./mock-content-pack.ts";

/*
 * Importing a content pack: a preview that leads with one conclusion per Content, details
 * only where the user has something to decide, then progress and a result that names every
 * Content and keeps the collections apart.
 */

const SHOTS = process.env["AMBER_E2E_SHOTS"];

function rowOf(dialog: Locator, key: string): Locator {
  return dialog.locator(`[data-testid="pack-import-row"][data-key="${key}"]`);
}

async function uploadPack(page: Page): Promise<Locator> {
  await page.getByTestId("new-pack-import").click();
  const dialog = page.getByRole("dialog", { name: "导入内容包" });
  await dialog.getByTestId("pack-import-file").setInputFiles({ name: "课程 20261118.amberpack", mimeType: "application/octet-stream", buffer: Buffer.from("amberpack") });
  await expect(dialog.getByTestId("pack-import-preview")).toBeVisible();
  return dialog;
}

test("server mode: upload, decide, import, read the result and retry the collection", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  const pack = await installContentPackMock(page, IMPORT_SCENARIO, { mode: "server" });
  await page.goto("/new");
  const dialog = await uploadPack(page);
  const upload = pack.calls.find((call) => call.path === "/api/content-packs/imports/upload");
  expect(upload?.headers?.["content-type"]).toBe("application/octet-stream");
  expect(decodeURIComponent(upload?.headers?.["x-amber-filename"] ?? "")).toBe("课程 20261118.amberpack");

  // One line of conclusion per Content, in the pack's order.
  await expect(dialog.getByTestId("pack-import-conclusion")).toHaveText([
    "本机没有 · 将新建",
    "匹配到《第一讲：检索增强生成》· 合并资料",
    "本机有 2 条可能对应的内容 · 需要你选择",
    /本机对应的内容在回收站中 · 先恢复或彻底删除/,
    "本机没有 · 将新建",
  ]);
  await expect(rowOf(dialog, "c-new").getByTestId("pack-import-changes")).toHaveText("新增字幕 1 份 · 新增插图 2 张 · 新增笔记 1 条 · 新增音视频 1 个");
  await expect(rowOf(dialog, "c-same").getByTestId("pack-import-changes")).toHaveText("新增字幕 1 份 · 新增发言人 1 位 · 新增插图 1 张 · 本机不同 3 项 · 冲突 1 项");
  // Details only where there is something to decide.
  await expect(rowOf(dialog, "c-new").getByTestId("pack-import-details")).toHaveCount(0);
  await expect(rowOf(dialog, "c-same").getByTestId("pack-import-details")).toBeVisible();
  await expect(rowOf(dialog, "c-trash").getByTestId("pack-import-action")).toBeDisabled();
  // No hash or id ever reaches the screen.
  await expect(dialog).not.toContainText("01J0000000");
  await expect(dialog.getByTestId("pack-import-expires")).toContainText("预览保留到");
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/import-preview-light.png` });

  // The three states of a merge.
  const same = rowOf(dialog, "c-same");
  await expect(same.locator('[data-testid="pack-import-revision"][data-state="existing"]')).toContainText("已在本机");
  await expect(same.locator('[data-testid="pack-import-revision"][data-state="differs"]')).toContainText("与本机同一来源的版本内容不同，不导入");
  await expect(same.locator('[data-testid="pack-import-revision"][data-state="new"]')).toContainText("新增");
  await expect(same.getByTestId("pack-import-figures")).toContainText("1 张的位置所依据的版本不在本机，会按时间落位");
  // 「采用包里的」 off by default, with what it changes.
  await expect(same.getByTestId("pack-import-adopt-toggle")).not.toBeChecked();
  await expect(same.getByTestId("pack-import-adopt")).toContainText("采用包里的（笔记 2 条、插图 1 张）");
  await same.getByTestId("pack-import-adopt-toggle").check();
  // The same-named speaker can be taken as the local one.
  await same.getByTestId("pack-import-same-speaker").check();
  // Making the carried revision current asks once more; cancelling leaves it off.
  await same.getByTestId("pack-import-set-primary").click();
  await page.getByRole("dialog", { name: "设为当前字幕稿？" }).getByRole("button", { name: "取消" }).click();
  await expect(same.getByTestId("pack-import-set-primary")).not.toBeChecked();
  await same.getByTestId("pack-import-set-primary").click();
  await page.getByTestId("pack-import-confirm-primary-ok").click();
  await expect(same.getByTestId("pack-import-set-primary")).toBeChecked();

  // Blocked until the candidate is chosen and the over-limit figures are left behind.
  const start = dialog.getByTestId("pack-import-start");
  await expect(start).toBeDisabled();
  await expect(dialog.getByTestId("pack-import-totals")).toContainText("还有 1 条需要你选择对应的内容。");
  await expect(rowOf(dialog, "c-over").getByTestId("pack-import-over-figures")).toContainText("插图超出上限 3 张（每条内容最多 100 张）");
  await rowOf(dialog, "c-over").getByTestId("pack-import-category-figures").uncheck();
  await rowOf(dialog, "c-media").getByLabel(/录屏（又一份）/).check();
  await expect(rowOf(dialog, "c-media").getByTestId("pack-import-conclusion")).toHaveText("音视频与《录屏（又一份）》相同 · 合并资料");
  await expect(start).toBeEnabled();

  // 「合并到其它内容…」 names a target by hand; a far-off duration is flagged.
  await rowOf(dialog, "c-new").getByTestId("pack-import-details-toggle").click();
  await rowOf(dialog, "c-new").getByTestId("pack-import-merge-other").click();
  const picker = page.getByRole("dialog", { name: "合并到其它内容" });
  const option = picker.getByTestId("pack-target-option").filter({ hasText: "第二讲：评测与对齐" });
  await expect(option).toContainText("两边时长相差较多");
  await option.getByRole("button").click();
  await expect(picker).toHaveCount(0);
  await expect(rowOf(dialog, "c-new").getByTestId("pack-import-conclusion")).toHaveText("合并到《第二讲：评测与对齐》");

  // A same-named collection is new unless the user joins it.
  const collection = dialog.getByTestId("pack-import-collection");
  await expect(collection).toContainText("本机有同名合集《生成式软件工程》，无法确认是同一个");
  await expect(collection.getByTestId("pack-import-collection-action")).toHaveValue("create");
  await collection.getByTestId("pack-import-collection-action").selectOption(`join:${COURSE}`);

  await start.click();
  await expect(dialog.getByTestId("pack-import-progress")).toBeVisible();
  const result = dialog.getByTestId("pack-import-result");
  await expect(result).toBeVisible();
  // The collection failed: never 「导入完成」.
  await expect(result).toHaveAttribute("data-all-ok", "false");
  await expect(dialog.getByTestId("pack-import-result-title")).toHaveText("部分内容没有导入成功");
  await expect(result.getByTestId("pack-import-result-row")).toHaveCount(PREVIEW.contents.length);
  await expect(result.getByTestId("pack-import-result-row").filter({ hasText: "第一讲" }).getByRole("link", { name: "打开" })).toHaveAttribute("href", `/contents/${LECTURE_1}`);
  await expect(result.getByTestId("pack-import-result-collection")).toContainText("写入合集时出错");
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/import-result-light.png` });
  await result.getByTestId("pack-import-retry-collections").click();
  await expect(result).toHaveAttribute("data-all-ok", "true");
  await expect(dialog.getByTestId("pack-import-result-title")).toHaveText("导入完成");

  const decisions = pack.decisions();
  expect(decisions?.contents.map((entry) => [entry.key, entry.action, entry.targetContentId])).toEqual([
    ["c-new", "merge", LECTURE_2],
    ["c-same", "merge", LECTURE_1],
    ["c-media", "merge", OTHER_TARGET],
    ["c-trash", "skip", undefined],
    ["c-over", "import", undefined],
  ]);
  expect(decisions?.contents[1]).toMatchObject({ adoptPack: true, setPrimaryRevisionKey: "rev-3", sameSpeakers: [{ speakerKey: "spk-1", localSpeakerId: "local-spk" }] });
  expect(decisions?.contents[4]).toMatchObject({ figures: false });
  expect(decisions?.collections).toEqual([{ key: "k-course", action: "join", targetCollectionId: COURSE }]);
  expect(decisions?.originalsDir).toBeUndefined();
});

test("a reload finds the import that waits for decisions again", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  await installContentPackMock(page, {
    ...IMPORT_SCENARIO,
    runningImport: { jobId: "01J0000000000000000PACKJ99", status: "awaiting_decisions", phase: "preview", bytesDone: 0, bytesTotal: 0, expiresAt: Date.now() + 3_600_000, preview: PREVIEW },
  });
  await page.goto("/library");
  const notice = page.getByTestId("pack-active-notice");
  await expect(notice).toHaveText("有一个内容包在等你确认导入查看");
  await notice.getByRole("button", { name: "查看" }).click();
  const dialog = page.getByRole("dialog", { name: "导入内容包" });
  await expect(dialog.getByTestId("pack-import-preview")).toBeVisible();
  // Closing it drops the staged pack, so the notice goes.
  await dialog.getByTestId("pack-import-discard").click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("library-row").first()).toBeVisible();
  await expect(page.getByTestId("pack-active-notice")).toHaveCount(0);
});

test("desktop client: the settings page picks the pack, and the originals directory only on 「开始导入」", async ({ page }) => {
  await installFakeDesktopShell(page, { source: "D:/Packs/录屏.amberpack", originalsParent: "D:/Videos" });
  await installMockBackend(page, { mode: "local" });
  const only = { ...PREVIEW, contents: [{ ...PREVIEW.contents[2], match: "new" as const, candidates: [] }].map((item) => ({ ...item, diff: { ...item.diff } })), collections: [] };
  const pack = await installContentPackMock(page, { ...IMPORT_SCENARIO, preview: only as typeof PREVIEW }, { mode: "local" });
  await page.goto("/settings/backup");
  await page.getByTestId("settings-pack-import").click();
  const dialog = page.getByRole("dialog", { name: "导入内容包" });
  await dialog.getByTestId("pack-import-pick-desktop").click();
  await expect(dialog.getByTestId("pack-import-preview")).toBeVisible();
  await expect(dialog).toContainText("包里带有原始音视频文件：开始导入时请选择存放位置");
  let shell = await page.evaluate(() => (window as unknown as { __AMBER_E2E_SHELL_CALLS__: Array<{ command: string }> }).__AMBER_E2E_SHELL_CALLS__.map((call) => call.command));
  expect(shell).not.toContain("pick_pack_originals_dir");
  await dialog.getByTestId("pack-import-start").click();
  await expect(dialog.getByTestId("pack-import-result")).toBeVisible();
  shell = await page.evaluate(() => (window as unknown as { __AMBER_E2E_SHELL_CALLS__: Array<{ command: string }> }).__AMBER_E2E_SHELL_CALLS__.map((call) => call.command));
  expect(shell).toContain("pick_pack_originals_dir");
  expect(pack.calls.find((call) => call.path === "/api/content-packs/imports")?.body).toMatchObject({ grant: { purpose: "pack_input", path: "D:/Packs/录屏.amberpack" } });
  expect(pack.decisions()?.originalsDir).toMatchObject({ purpose: "pack_originals_dir" });
  expect(pack.decisions()?.originalsDir?.path).toMatch(/^D:\/Videos\/Amber-Imported-\d{8}-\d{6}$/);
});

test("the import preview by keyboard and screen reader names", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  await installContentPackMock(page, IMPORT_SCENARIO, { mode: "server" });
  await page.goto("/new");
  const dialog = await uploadPack(page);
  // Every row's action and details control is named after its Content.
  await expect(dialog.getByRole("combobox", { name: "如何处理「第五讲：智能体」" })).toBeVisible();
  const details = dialog.getByRole("button", { name: "展开「第五讲：智能体」的细节" });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "收起「第五讲：智能体」的细节" })).toHaveAttribute("aria-expanded", "true");
  const action = dialog.getByRole("combobox", { name: "如何处理「第五讲：智能体」" });
  await action.focus();
  await action.selectOption("skip");
  await expect(rowOf(dialog, "c-new").getByTestId("pack-import-conclusion")).toHaveText("跳过");
  await expect(dialog.getByRole("combobox", { name: "如何处理合集「生成式软件工程」" })).toBeEnabled();
});

test("two carried Contents matching one local Content: each is decided apart, and both cannot merge into it", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  const pack = await installContentPackMock(page, SHARED_SCENARIO, { mode: "server" });
  await page.goto("/new");
  const dialog = await uploadPack(page);
  const first = rowOf(dialog, "c-twin-1");
  const second = rowOf(dialog, "c-twin-2");
  // Nothing chosen for either: not merged, not imported as new.
  for (const row of [first, second]) {
    await expect(row.getByTestId("pack-import-conclusion")).toHaveText("与《录屏（导入的副本）》匹配，包里还有别的内容也匹配到它 · 需要你选择");
    await expect(row.getByTestId("pack-import-action")).toHaveValue("");
  }
  await expect(first.getByTestId("pack-import-shared")).toHaveText("「录屏：下午场」和这一条都与本机《录屏（导入的副本）》匹配，请分别决定。");
  const start = dialog.getByTestId("pack-import-start");
  await expect(start).toBeDisabled();
  await expect(dialog.getByTestId("pack-import-totals")).toContainText("还有 2 条需要你选择对应的内容。");

  // The first goes into the local recording; the second chooses the same one and is stopped there.
  await first.getByLabel(/录屏（导入的副本）/).check();
  await expect(first.getByTestId("pack-import-conclusion")).toHaveText("音视频与《录屏（导入的副本）》相同 · 合并资料");
  await second.getByLabel(/录屏（导入的副本）/).check();
  await expect(second.getByTestId("pack-import-same-target")).toHaveText("「录屏：上午场」也要合并到《录屏（导入的副本）》。一次导入里，一条本机内容只能合并一条，请改选其中一条。");
  await expect(first.getByTestId("pack-import-same-target")).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(dialog.getByTestId("pack-import-totals")).toContainText("有 2 条内容要合并到同一条本机内容，请改选。");

  // A hand-picked target is held to the same rule.
  await second.getByTestId("pack-import-action").selectOption("import");
  await expect(start).toBeEnabled();
  await second.getByTestId("pack-import-merge-other").click();
  const picker = page.getByRole("dialog", { name: "合并到其它内容" });
  await picker.getByTestId("pack-target-option").filter({ hasText: "录屏（导入的副本）" }).getByRole("button").click();
  await expect(picker).toHaveCount(0);
  await expect(second.getByTestId("pack-import-conclusion")).toHaveText("合并到《录屏（导入的副本）》");
  await expect(second.getByTestId("pack-import-same-target")).toBeVisible();
  await expect(start).toBeDisabled();
  // Nothing was ever sent while two rows shared a target.
  expect(pack.calls.some((call) => call.path.endsWith("/commit"))).toBe(false);

  await second.getByTestId("pack-import-action").selectOption("import");
  await start.click();
  await expect(dialog.getByTestId("pack-import-result")).toBeVisible();
  expect(pack.decisions()?.contents.map((entry) => [entry.key, entry.action, entry.targetContentId])).toEqual([
    ["c-twin-1", "merge", LOCAL_TARGET],
    ["c-twin-2", "import", undefined],
  ]);
});
