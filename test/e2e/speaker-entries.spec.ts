import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend, segmentId } from "./mock-backend.ts";
import { createdSpeakerId, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKERS_CONTENT, SPEAKERS_REVISION, speakersRequests } from "./mock-speakers.ts";

/*
 * Ways into speaker editing from the reading view, and what the editor opens once its list is
 * in place: the review panel's 「管理发言人…」 and the toolbar's 「标注发言人」 open the speaker
 * panel; a sentence's 「更改发言人…」 opens that sentence's speaker menu. Also deleting a speaker
 * the undo history still names: the confirmation says those steps go, and undo cannot bring
 * back sentences naming nobody.
 */

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;

const panel = (page: Page): Locator => page.getByTestId("speaker-panel");
const lead = (page: Page, index: number): Locator => page.getByTestId("sentence-rows").locator(`:scope > [data-sentence-index="${index}"]`).getByTestId("speaker-lead");

async function editorInPlace(page: Page): Promise<void> {
  await expect(page.getByTestId("draft-editor")).toBeVisible();
  await expect(page.getByTestId("sentence-rows")).toHaveAttribute("data-initial-scroll", /settled|edge|capped/);
}

test("「管理发言人…」 in the review panel opens the editor with the speaker panel open", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(READER);
  await page.getByRole("button", { name: /^发言人核对状态：/ }).click();
  await page.getByTestId("speaker-review-manage").click();
  await expect(page.getByTestId("draft-editor")).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "新增发言人" })).toBeFocused();
});

test("「标注发言人」 appears for a text nobody is assigned in and opens the speaker panel with the speaker column", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  server.sequence = [undefined, undefined, undefined, undefined];
  await page.goto(READER);
  const label = page.getByTestId("label-speakers");
  await expect(label).toHaveAccessibleName("标注发言人");
  await expect(page.getByTestId("speaker-filter")).toHaveCount(0);
  await label.click();
  await expect(page.getByTestId("draft-editor")).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(lead(page, 0)).toBeVisible();
});

test("「更改发言人…」 on a sentence opens the editor on it with its speaker menu", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(READER);
  const sentence = page.locator(`[data-segment-id="${segmentId(SPEAKERS_REVISION, 3)}"]`);
  await sentence.click({ button: "right" });
  await page.getByRole("menuitem", { name: "更改发言人…" }).click();
  await editorInPlace(page);
  const menu = page.getByTestId("speaker-menu");
  await expect(menu).toBeVisible();
  // The menu belongs to the sentence asked on, not the first one.
  await expect(lead(page, 3)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(lead(page, 3)).toBeFocused();
});

test("deleting a speaker the undo history names warns, and undo no longer brings it back", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  server.sequence = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_STUDENT, SPEAKER_STUDENT];
  await page.goto(READER);
  await page.getByTestId("transcript-edit").click();
  await expect(lead(page, 0)).toBeVisible();

  // A new speaker for the first sentence, unnamed, then the sentence goes back to the teacher.
  await lead(page, 0).click();
  await page.getByTestId("speaker-menu").getByTestId("speaker-menu-new").click();
  await page.keyboard.press("Escape");
  await expect(lead(page, 0)).toHaveAttribute("aria-label", "发言人：发言人 3");
  await lead(page, 0).click();
  await page.getByTestId("speaker-menu").getByTestId(`speaker-menu-item-${SPEAKER_TEACHER}`).click();
  await expect(lead(page, 0)).toHaveAttribute("aria-label", "发言人：林老师");
  // The draft as saved no longer names the new speaker.
  await expect.poll(() => server.draft?.segments.some((segment) => segment.speakerId === createdSpeakerId(1))).toBe(false);

  await page.getByTestId("speaker-panel-toggle").click();
  const row = panel(page).getByTestId("speaker-panel-unused").getByTestId("speaker-panel-row").filter({ hasText: "发言人 3" });
  await row.getByTestId("speaker-panel-delete").click();
  await expect(panel(page).getByTestId("speaker-panel-delete-undo")).toHaveText("此前涉及 TA 的修改将不能撤销");
  await panel(page).getByTestId("speaker-panel-delete-confirm-button").click();
  await expect(row).toHaveCount(0);
  expect(server.speakers.some((speaker) => speaker.id === createdSpeakerId(1))).toBe(false);
  await page.keyboard.press("Escape");

  // Both steps named the deleted speaker, so nothing is left to undo.
  await expect(page.getByTestId("editor-undo")).toBeDisabled();
  await expect(page.getByTestId("missing-speaker-notice")).toHaveCount(0);
});
