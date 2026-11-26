import { expect, test, type Locator } from "@playwright/test";
import { instanceSettingsDtoSchema } from "../../src/shared/dto/instance-settings.ts";
import { installMockBackend } from "./mock-backend.ts";

/*
 * A button that starts work keeps its size and place: the spinner takes the middle of the
 * button and the label stays (transparent), so neither the button nor its neighbours move.
 * jsdom has no layout, so this is measured in a real browser.
 */

const TOLERANCE = 0.5;

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const measured = await locator.boundingBox();
  if (measured === null) throw new Error("not laid out");
  return measured;
}

function expectSameBox(after: { x: number; width: number; height: number }, before: { x: number; width: number; height: number }): void {
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(TOLERANCE);
}

test("a loading button keeps its size, and its neighbour keeps its place", async ({ page }) => {
  await installMockBackend(page, { mode: "local" });
  // The old free-ratio default brings up the hint card; applying it is left pending.
  await page.route("**/api/instance-settings", async (route) => {
    if (route.request().method() === "GET") {
      const body = instanceSettingsDtoSchema.parse({
        concurrencyPipeline: 2,
        maxDataGB: 30,
        lowWaterFreeGB: 10,
        lowWaterFreeRatio: 0.2,
        uploadRetentionDefault: "keep",
        updatedAt: 0,
        envOverridden: [],
      });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    // Unanswered on purpose: the button stays in its loading state until the page closes.
    return undefined;
  });
  await page.goto("/settings/storage");
  const apply = page.getByTestId("low-water-hint-apply");
  const dismiss = page.getByTestId("low-water-hint-dismiss");
  await expect(apply).toBeVisible();
  const name = await apply.textContent();
  const [applyBefore, dismissBefore] = [await box(apply), await box(dismiss)];

  await apply.click();
  await expect(apply).toHaveAttribute("aria-busy", "true");
  await expect(apply.getByTestId("button-spinner")).toBeVisible();
  // Same accessible name while loading.
  await expect(apply).toHaveAccessibleName(name ?? "");
  expectSameBox(await box(apply), applyBefore);
  expectSameBox(await box(dismiss), dismissBefore);
});
