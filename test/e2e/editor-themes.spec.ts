import { expect, test, type Locator, type Page } from "@playwright/test";
import { THEMES } from "../../src/shared/dto/settings.ts";
import { contrastOf } from "./contrast.ts";
import { installMockBackend } from "./mock-backend.ts";
import { SPEAKERS_CONTENT, speakersRequests } from "./mock-speakers.ts";
import { setTheme } from "./mock-usage.ts";

/*
 * The transcript editor's speaker panel, the notice about sentences naming a deleted speaker
 * and the paragraph controls, read in every theme: each text must stand out from what is
 * painted behind it.
 */

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
/** WCAG AA for normal-size text. */
const MIN_CONTRAST = 4.5;
const UNUSED = "01J0000000000000000000XTRA";
const HISTORY = "01J0000000000000000000HIST";
const GONE = "01J0000000000000000000GONE";

const rows = (page: Page): Locator => page.getByTestId("sentence-rows");
const row = (page: Page, index: number): Locator => rows(page).locator(`:scope > [data-sentence-index="${index}"]`);
const panel = (page: Page): Locator => page.getByTestId("speaker-panel");

/**
 * Picks a speaker from the menu's 「更多发言人」 submenu. The pointer travels there in steps, as a
 * hand does: a single jump leaves the submenu's trigger in a way that closes the submenu.
 */
async function pickOther(page: Page, speakerId: string): Promise<void> {
  await page.getByTestId("speaker-menu").getByTestId("speaker-menu-others").click();
  const item = page.getByTestId(`speaker-menu-item-${speakerId}`);
  await expect(item).toBeVisible();
  const box = await item.boundingBox();
  if (box === null) throw new Error("the submenu item has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.mouse.down();
  await page.mouse.up();
}

for (const theme of THEMES) {
  test(`contrast of the speaker panel, the deleted-speaker notice and the paragraph controls in the ${theme} theme`, async ({ page }, info) => {
    await installMockBackend(page);
    const server = speakersRequests(page);
    server.speakers.push(
      { id: UNUSED, ordinal: 3, name: "误建", colorIndex: 2, used: false, referenced: false },
      { id: HISTORY, ordinal: 4, name: "旧版嘉宾", colorIndex: 3, used: false, referenced: true },
      { id: GONE, ordinal: 5, name: "临时嘉宾", colorIndex: 4, used: false, referenced: false },
    );
    server.archivedReferences.add(HISTORY);
    await setTheme(page, theme);
    const ratios: Record<string, number> = {};
    const measure = async (name: string, locator: Locator): Promise<void> => {
      await expect(locator).toBeVisible();
      ratios[name] = Math.round((await contrastOf(locator)) * 100) / 100;
    };

    await page.goto(READER);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByTestId("transcript-edit").click();
    await expect(rows(page)).toHaveAttribute("data-initial-scroll", /.+/);

    // A sentence goes to a speaker another window then deletes; the panel reads the list again on opening.
    await row(page, 1).getByTestId("speaker-lead").click();
    await pickOther(page, GONE);
    await expect(row(page, 1).getByTestId("speaker-lead")).toHaveAttribute("aria-label", "发言人：临时嘉宾");
    server.speakers = server.speakers.filter((speaker) => speaker.id !== GONE);

    await page.getByTestId("speaker-panel-toggle").click();
    await expect(panel(page)).toBeVisible();
    await measure("panel title", panel(page).getByRole("heading", { name: "发言人", exact: true }));
    await measure("panel 「新增」", panel(page).getByTestId("speaker-panel-add"));
    await measure("group 「本稿已使用」", panel(page).getByRole("heading", { name: /^本稿已使用/ }));
    const used = panel(page).getByTestId("speaker-panel-used").getByTestId("speaker-panel-row").first();
    await measure("used row name", used.getByTestId("speaker-panel-name"));
    await measure("used row share", used.locator(".text-muted.tabular-nums"));
    const unused = panel(page).getByTestId("speaker-panel-unused");
    await measure("unused row 「尚未分配句子」", unused.getByTestId("speaker-panel-row").filter({ hasText: "误建" }).getByTestId("speaker-panel-detail"));
    await measure("unused row 「历史字幕版本仍在引用」", unused.getByTestId("speaker-panel-row").filter({ hasText: "旧版嘉宾" }).getByTestId("speaker-panel-detail"));
    await unused.getByRole("button", { name: "删除发言人：误建" }).click();
    const confirm = unused.getByRole("group", { name: "删除「误建」？" });
    await measure("delete question", confirm.getByText("删除「误建」？"));
    await measure("delete 「删除」", confirm.getByRole("button", { name: "删除", exact: true }));
    await measure("delete 「取消」", confirm.getByRole("button", { name: "取消" }));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();

    const notice = page.getByTestId("missing-speaker-notice");
    await measure("notice text", notice.getByText("有 1 句指向已删除的发言人"));
    await measure("notice 「设为未分配」", notice.getByTestId("missing-speaker-unassign"));

    // The first sentence cannot join a paragraph before it, and says why.
    await row(page, 0).locator("textarea").focus();
    await row(page, 0).locator("textarea").evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 2));
    await expect(row(page, 0).getByTestId("paragraph-action")).toBeDisabled();
    await measure("paragraph reason", row(page, 0).getByTestId("paragraph-blocked"));
    await measure("「后半句另起一段」", row(page, 0).locator("label").filter({ has: page.getByTestId("split-right-starts") }));

    info.annotations.push({ type: "contrast", description: JSON.stringify(ratios) });
    console.log(`contrast ${theme}: ${JSON.stringify(ratios)}`);
    for (const [name, ratio] of Object.entries(ratios)) {
      expect.soft(ratio, `${name} in ${theme}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
}
