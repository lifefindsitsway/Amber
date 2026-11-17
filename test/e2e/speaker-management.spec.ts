import { expect, test, type Locator, type Page } from "@playwright/test";
import { SPEAKER_PANEL_UNUSED_VISIBLE } from "../../src/shared/defaults.ts";
import { installMockBackend } from "./mock-backend.ts";
import { createdSpeakerId, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKERS_CONTENT, speakersRequests } from "./mock-speakers.ts";

/*
 * Managing speakers in the transcript editor: adding them in the speaker panel (named or not),
 * giving them sentences from a sentence's menu at each reach, naming one created from that
 * menu, deleting one nothing refers to, and the explanations where deleting is not possible.
 */

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
/** Where the content page keeps the output column's width, and a width that makes the editor narrow. */
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
const NARROW_OUTPUTS_PX = 380;

const leads = (page: Page): Locator => page.getByTestId("speaker-lead");
const lead = (page: Page, index: number): Locator => page.getByTestId("sentence-rows").locator(`:scope > [data-sentence-index="${index}"]`).getByTestId("speaker-lead");
const panel = (page: Page): Locator => page.getByTestId("speaker-panel");
const unusedRows = (page: Page): Locator => panel(page).getByTestId("speaker-panel-unused").getByTestId("speaker-panel-row");
const usedRows = (page: Page): Locator => panel(page).getByTestId("speaker-panel-used").getByTestId("speaker-panel-row");
const names = (page: Page): Promise<Array<string | null>> => leads(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));

async function openEditor(page: Page): Promise<void> {
  await page.goto(READER);
  await page.getByTestId("transcript-edit").click();
  await expect(page.getByTestId("draft-editor")).toBeVisible();
  await expect(leads(page).first()).toBeVisible();
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("speaker-panel-toggle").click();
  await expect(panel(page)).toBeVisible();
  // The panel opens on its first control.
  await expect(panel(page).getByRole("button", { name: "新增发言人" })).toBeFocused();
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
}

async function addInPanel(page: Page, name: string): Promise<void> {
  await panel(page).getByRole("button", { name: "新增发言人" }).click();
  const input = panel(page).getByRole("textbox", { name: "新发言人的姓名" });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press("Enter");
  await expect(input).toBeHidden();
}

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

/** Opens a sentence's speaker menu by clicking its column. */
async function openMenu(page: Page, index: number): Promise<Locator> {
  await lead(page, index).click();
  const menu = page.getByTestId("speaker-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("speaker panel: speakers added by name and blank, nothing on Esc or leaving the field; given sentences at each reach and committed", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  // Four sentences of the teacher, then two of the student.
  server.sequence = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_STUDENT, SPEAKER_STUDENT];
  await openEditor(page);
  await openPanel(page);
  await expect(panel(page).getByRole("heading", { name: "发言人" })).toBeVisible();
  await expect(panel(page)).toContainText("本稿已使用 · 2");
  await expect(panel(page)).not.toContainText("AI 总结与对话暂不读取发言人");

  // Leaving the field creates nothing, and Esc closes the form, not the panel.
  await panel(page).getByRole("button", { name: "新增发言人" }).click();
  const input = panel(page).getByRole("textbox", { name: "新发言人的姓名" });
  await input.fill("王教授");
  await panel(page).getByRole("heading", { name: "发言人" }).click();
  await expect(input).toBeVisible();
  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(panel(page)).toBeVisible();
  expect(server.creations).toEqual([]);

  await addInPanel(page, "王教授");
  await expect(panel(page).getByRole("button", { name: "新增发言人" })).toBeFocused();
  await addInPanel(page, "");
  expect(server.creations).toEqual([{ name: "王教授", nameConfirmed: true }, {}]);
  await expect(panel(page)).toContainText("本稿未使用 · 2");
  await expect(unusedRows(page)).toHaveText([/王教授\s*尚未分配句子/u, /发言人 4\s*尚未分配句子/u]);
  await closePanel(page);

  // The reaches of the second sentence, inside the teacher's turn of four.
  let menu = await openMenu(page, 1);
  await expect(menu.getByRole("menuitemradio")).toHaveText(["本句1 句 · 0:10–0:19", "本句到本轮结束3 句 · 0:10–0:39", "整轮4 句 · 0:00–0:39"]);
  await expect(menu.getByTestId("speaker-menu-scope-sentence")).toHaveAttribute("aria-checked", "true");
  await menu.getByTestId(`speaker-menu-item-${createdSpeakerId(1)}`).click();
  await expect(menu).toBeHidden();
  expect(await names(page)).toEqual(["发言人：林老师", "发言人：王教授", "发言人：林老师", "发言人：林老师", "发言人：发言人 2", "发言人：发言人 2"]);

  menu = await openMenu(page, 2);
  await menu.getByTestId("speaker-menu-scope-rest").click();
  await expect(menu.getByTestId("speaker-menu-scope-rest")).toHaveAttribute("aria-checked", "true");
  await menu.getByTestId(`speaker-menu-item-${createdSpeakerId(2)}`).click();
  expect(await names(page)).toEqual(["发言人：林老师", "发言人：王教授", "发言人：发言人 4", "发言人：发言人 4", "发言人：发言人 2", "发言人：发言人 2"]);

  menu = await openMenu(page, 5);
  await menu.getByTestId("speaker-menu-scope-run").click();
  await menu.getByTestId(`speaker-menu-item-${createdSpeakerId(1)}`).click();
  expect(await names(page)).toEqual(["发言人：林老师", "发言人：王教授", "发言人：发言人 4", "发言人：发言人 4", "发言人：王教授", "发言人：王教授"]);

  // The new speakers now count as used here, and still have no way to be deleted.
  await openPanel(page);
  await expect(panel(page)).toContainText("本稿已使用 · 3");
  await expect(panel(page).getByTestId("speaker-panel-used").getByTestId("speaker-panel-delete")).toHaveCount(0);
  await closePanel(page);

  await page.getByTestId("draft-commit").click();
  await expect.poll(() => server.manual.length).toBe(1);
  expect(server.manual[0]?.segments.map((segment) => segment.speakerId)).toEqual([SPEAKER_TEACHER, createdSpeakerId(1), createdSpeakerId(2), createdSpeakerId(2), createdSpeakerId(1), createdSpeakerId(1)]);
});

test("sentence menu: a new speaker is named beside its sentence (Enter saves, Esc skips) and numbered after the others", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  await openEditor(page);

  let menu = await openMenu(page, 5);
  await menu.getByTestId("speaker-menu-new").click();
  const naming = page.getByRole("dialog", { name: "给新发言人起名" });
  const input = naming.getByRole("textbox", { name: "给新发言人起名" });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", "发言人 3");
  await input.fill("赵同学");
  await input.press("Enter");
  await expect(naming).toBeHidden();
  await expect(lead(page, 5)).toHaveAttribute("aria-label", "发言人：赵同学");
  await expect(lead(page, 5)).toBeFocused();
  expect(server.speakers.find((speaker) => speaker.id === createdSpeakerId(1))).toMatchObject({ name: "赵同学", nameConfirmed: true });

  menu = await openMenu(page, 2);
  await menu.getByTestId("speaker-menu-new").click();
  await expect(naming.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(naming).toBeHidden();
  await expect(lead(page, 2)).toBeFocused();
  await expect(lead(page, 2)).toHaveAttribute("aria-label", "发言人：发言人 4");
  expect(server.speakers.find((speaker) => speaker.id === createdSpeakerId(2))?.name).toBeUndefined();

  // The roster keeps its order and appends the new ones; their digits work from the column.
  menu = await openMenu(page, 0);
  const digit = (id: string): Locator => menu.getByTestId(`speaker-menu-item-${id}`).locator("kbd");
  await expect(digit(SPEAKER_TEACHER)).toHaveText("1");
  await expect(digit(SPEAKER_STUDENT)).toHaveText("2");
  await expect(digit(createdSpeakerId(1))).toHaveText("3");
  await expect(digit(createdSpeakerId(2))).toHaveText("4");
  await page.keyboard.press("Escape");
  await expect(lead(page, 0)).toBeFocused();
  await page.keyboard.press("4");
  await expect(lead(page, 0)).toHaveAttribute("aria-label", "发言人：发言人 4");
});

test("deleting: an unused speaker nothing refers to goes after an inline confirmation; used and history-referenced ones cannot", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  server.speakers.push(
    { id: "01J0000000000000000000XTRA", ordinal: 3, name: "误建", colorIndex: 2, used: false, referenced: false },
    { id: "01J0000000000000000000HIST", ordinal: 4, name: "旧版嘉宾", colorIndex: 3, used: false, referenced: true },
  );
  server.archivedReferences.add("01J0000000000000000000HIST");
  await openEditor(page);
  await openPanel(page);

  await expect(usedRows(page)).toHaveCount(2);
  await expect(panel(page).getByTestId("speaker-panel-used").getByTestId("speaker-panel-delete")).toHaveCount(0);
  await expect(panel(page)).toContainText("本稿未使用 · 2");
  const history = unusedRows(page).filter({ hasText: "旧版嘉宾" });
  await expect(history).toContainText("历史字幕版本仍在引用，无法删除");
  await expect(history.getByTestId("speaker-panel-delete")).toHaveCount(0);

  const mistaken = unusedRows(page).filter({ hasText: "误建" });
  await mistaken.getByRole("button", { name: "删除发言人：误建" }).click();
  const confirm = mistaken.getByRole("group", { name: "删除「误建」？" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "取消" })).toBeFocused();
  await confirm.getByRole("button", { name: "删除" }).click();
  await expect(unusedRows(page).filter({ hasText: "误建" })).toHaveCount(0);
  await expect(panel(page)).toContainText("本稿未使用 · 1");
  await expect(panel(page).getByTestId("speaker-panel-status")).toHaveText("已删除「误建」");
  expect(server.deletions).toEqual(["01J0000000000000000000XTRA"]);
  expect(server.speakers.map((speaker) => speaker.id)).not.toContain("01J0000000000000000000XTRA");
});

test("deleting: a speaker something came to refer to meanwhile is refused, explained in its row and shown as it now is", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  const id = "01J0000000000000000000LATE";
  server.speakers.push({ id, ordinal: 3, name: "后来者", colorIndex: 2, used: false, referenced: false });
  await openEditor(page);
  await openPanel(page);
  const row = unusedRows(page).filter({ hasText: "后来者" });
  await row.getByRole("button", { name: "删除发言人：后来者" }).click();
  // Another window's version names the speaker before this one confirms.
  server.archivedReferences.add(id);
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await expect(row.getByRole("alert")).toHaveText("TA 刚被某个版本或草稿引用，无法删除；名单已刷新");
  await expect(row.getByTestId("speaker-panel-delete")).toHaveCount(0);
  expect(server.speakers.map((speaker) => speaker.id)).toContain(id);
});

test("speaker panel: unused speakers beyond the visible number are folded", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  const extra = SPEAKER_PANEL_UNUSED_VISIBLE + 2;
  for (let index = 0; index < extra; index += 1) {
    server.speakers.push({ id: `01J00000000000000000EXTR${String(index).padStart(2, "0")}`, ordinal: 3 + index, colorIndex: index % 8, used: false, referenced: false });
  }
  await openEditor(page);
  await openPanel(page);
  await expect(panel(page)).toContainText(`本稿未使用 · ${extra}`);
  await expect(unusedRows(page)).toHaveCount(SPEAKER_PANEL_UNUSED_VISIBLE);
  const more = panel(page).getByRole("button", { name: "再显示 2 位" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(unusedRows(page)).toHaveCount(extra);
  await expect(panel(page).getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");
});

test("speaker panel: keyboard only in a narrow window, with a very long name", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  const long = "一位名字非常非常非常非常非常非常非常非常长的特邀嘉宾老师";
  // The output column, and with it the editor, as narrow as it goes.
  await page.goto(READER);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [OUTPUTS_WIDTH_KEY, String(NARROW_OUTPUTS_PX)] as const);
  await openEditor(page);
  const editor = await page.getByTestId("draft-editor").boundingBox();
  expect(editor?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(520);
  const width = page.viewportSize()?.width ?? 0;
  await page.getByTestId("speaker-panel-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();
  const box = await panel(page).boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);

  await expect(panel(page).getByRole("button", { name: "新增发言人" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.type(long);
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("button", { name: "新增发言人" })).toBeFocused();
  const row = unusedRows(page).filter({ hasText: long });
  await expect(row.getByTestId("speaker-panel-name")).toHaveAttribute("title", long);
  // The long name is cut inside the row rather than widening the panel.
  const rowBox = await row.boundingBox();
  expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0));

  // To the row's delete button with Tab, confirm from the keyboard.
  const trash = row.getByRole("button", { name: `删除发言人：${long}` });
  for (let presses = 0; presses < 30 && !(await trash.evaluate((element) => element === document.activeElement)); presses += 1) await page.keyboard.press("Tab");
  await expect(trash).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row.getByRole("button", { name: "取消" })).toBeFocused();
  // Esc backs out of the confirmation, not out of the panel, and the focus returns to the button.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
  await expect(trash).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: "删除", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(unusedRows(page).filter({ hasText: long })).toHaveCount(0);
  expect(server.deletions).toEqual([createdSpeakerId(1)]);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(page.getByTestId("speaker-panel-toggle")).toBeFocused();
});

test("a speaker deleted in another window while a sentence here names it: the commit is refused, 「设为未分配」 clears it as one undoable step, and the commit goes through", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  const guest = "01J0000000000000000000GONE";
  server.speakers.push({ id: guest, ordinal: 3, name: "临时嘉宾", colorIndex: 2, used: false, referenced: false });
  await openEditor(page);

  // This window still lists the guest; another one deletes the guest meanwhile.
  const menu = await openMenu(page, 1);
  server.speakers = server.speakers.filter((speaker) => speaker.id !== guest);
  // Unused speakers are offered one step further, under 「更多发言人」.
  await expect(menu).toBeVisible();
  await pickOther(page, guest);
  await expect(lead(page, 1)).toHaveAttribute("aria-label", "发言人：临时嘉宾");
  await expect.poll(() => server.draft?.segments[1]?.speakerId).toBe(guest);
  const notice = page.getByTestId("missing-speaker-notice");
  await expect(notice).toHaveCount(0);

  await page.getByTestId("draft-commit").click();
  await expect(notice).toContainText("有 1 句指向已删除的发言人");
  expect(server.manual).toEqual([]);

  await notice.getByRole("button", { name: "设为未分配" }).click();
  await expect(notice).toHaveCount(0);
  await expect(lead(page, 1)).toHaveAttribute("aria-label", "发言人：未分配");
  // One step: undo brings back the sentence naming the deleted speaker, so the notice too; it is cleared again.
  await page.getByTestId("editor-undo").click();
  await expect(notice).toContainText("有 1 句指向已删除的发言人");
  await notice.getByRole("button", { name: "设为未分配" }).click();
  await expect(notice).toHaveCount(0);

  await page.getByTestId("draft-commit").click();
  await expect.poll(() => server.manual.length).toBe(1);
  expect(server.manual[0]?.segments.map((segment) => segment.speakerId)).toEqual([SPEAKER_TEACHER, undefined, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKER_TEACHER, undefined]);
});
