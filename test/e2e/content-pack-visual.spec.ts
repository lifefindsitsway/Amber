import { expect, test, type Page } from "@playwright/test";
import { THEMES, type Theme } from "../../src/shared/dto/settings.ts";
import { EXPORT_SCENARIO, IMPORT_SCENARIO, LECTURE_1 } from "./content-pack-fixtures.ts";
import { installMockBackend } from "./mock-backend.ts";
import { installContentPackMock } from "./mock-content-pack.ts";

/*
 * Screenshots of the export wizard and the import preview in every theme and in a narrow
 * window, for review by eye. Only runs when `AMBER_E2E_SHOTS` names a directory.
 */

const SHOTS = process.env["AMBER_E2E_SHOTS"];
test.skip(SHOTS === undefined, "screenshots only on request");

async function withTheme(page: Page, theme: Theme): Promise<void> {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ theme, language: "zh-CN", shortcuts: {}, updatedAt: 0 }) });
  });
}

for (const theme of THEMES) {
  test(`export wizard and import preview · ${theme}`, async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    await installContentPackMock(page, { ...EXPORT_SCENARIO, ...IMPORT_SCENARIO, plan: EXPORT_SCENARIO.plan ?? {} }, { mode: "server" });
    await withTheme(page, theme);
    await page.goto("/library");
    await page.getByTestId("library-select-mode").click();
    await page.getByRole("checkbox", { name: "选择本页全部内容" }).check();
    await page.screenshot({ path: `${SHOTS}/library-select-${theme}.png` });
    await page.getByTestId("library-export-selected").click();
    const wizard = page.getByRole("dialog", { name: "导出内容包" });
    await expect(wizard.locator(`[data-content-id="${LECTURE_1}"]`).getByTestId("pack-export-card-body")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/export-wizard-${theme}.png` });
    await wizard.getByTestId("pack-export-next").click();
    await expect(wizard.getByTestId("pack-export-confirm")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/export-confirm-${theme}.png` });
    await page.keyboard.press("Escape");

    await page.goto("/new");
    await page.getByTestId("new-pack-import").click();
    const dialog = page.getByRole("dialog", { name: "导入内容包" });
    await dialog.getByTestId("pack-import-file").setInputFiles({ name: "课程.amberpack", mimeType: "application/octet-stream", buffer: Buffer.from("amberpack") });
    await expect(dialog.getByTestId("pack-import-preview")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/import-preview-${theme}.png` });
  });
}

// A 960 px window at 200% zoom lays out like a 480 px one.
test("narrow window, as at 200% zoom", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await installMockBackend(page, { mode: "server" });
  await installContentPackMock(page, { ...EXPORT_SCENARIO, ...IMPORT_SCENARIO, plan: EXPORT_SCENARIO.plan ?? {} }, { mode: "server" });
  await withTheme(page, "dark");
  await page.goto("/library");
  await page.getByTestId("library-select-mode").click();
  await page.getByRole("checkbox", { name: "选择本页全部内容" }).check();
  await page.screenshot({ path: `${SHOTS}/library-select-narrow-dark.png` });
  await page.getByTestId("library-export-selected").click();
  await expect(page.getByRole("dialog", { name: "导出内容包" }).getByTestId("pack-export-card-body").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/export-wizard-narrow-dark.png` });
  await page.keyboard.press("Escape");
  await page.goto("/new");
  await page.getByTestId("new-pack-import").click();
  const dialog = page.getByRole("dialog", { name: "导入内容包" });
  await dialog.getByTestId("pack-import-file").setInputFiles({ name: "课程.amberpack", mimeType: "application/octet-stream", buffer: Buffer.from("amberpack") });
  await expect(dialog.getByTestId("pack-import-preview")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/import-preview-narrow-dark.png` });
});
