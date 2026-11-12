import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend, segmentId } from "./mock-backend.ts";
import { SEGMENT_MS, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKERS_CONTENT, SPEAKERS_REVISION, speakersRequests, speakerSentence } from "./mock-speakers.ts";

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;

/** The review mark, found by what it says to a screen reader: its state, and that it opens the panel. */
const badge = (page: Page, state: string): Locator => page.getByRole("button", { name: `发言人核对状态：${state}。打开核对面板`, exact: true });
const panel = (page: Page): Locator => page.getByRole("dialog", { name: "核对发言人" });

/** Presses Tab until `target` has the focus, as a keyboard user would reach it; fails if it never does. */
async function tabTo(page: Page, target: Locator, limit = 120): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

/** A sentence of the reading view, by its index in the primary revision. */
const sentence = (page: Page, index: number): Locator => page.getByTestId("transcript-reader").locator(`[data-segment-id="${segmentId(SPEAKERS_REVISION, index)}"]`);

test("speaker review: the mark reads one of three texts and the panel shows only the review's figures", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  await page.goto(READER);

  // Not reviewed: the mark says so in words, and opens the panel as a dialog.
  const unconfirmed = badge(page, "发言人未核对");
  await expect(unconfirmed).toHaveText("发言人未核对");
  await expect(unconfirmed).toHaveAttribute("aria-haspopup", "dialog");
  await unconfirmed.click();
  const dialog = panel(page);
  await expect(dialog).toBeVisible();

  // Speakers, unassigned sentences and names still to confirm, as the review endpoint counts them:
  // two speakers, the last sentence unassigned, the teacher's name never confirmed.
  const stats = dialog.getByLabel("核对概况");
  await expect(stats.getByRole("term")).toHaveText(["发言人", "未分配句", "姓名待确认"]);
  await expect(stats.getByRole("definition")).toHaveText(["2", "1", "1"]);
  await expect(dialog).not.toContainText("待确认句数");
  // No sentence waits in a draft, so there is no draft line.
  await expect(dialog.getByTestId("speaker-review-draft")).toHaveCount(0);

  // The roster, in order of first appearance: each speaker's sentences and share of the assigned time
  // (four sentences of the teacher against one of the student, all of one length).
  const teacher = dialog.getByRole("button", { name: "定位到 林老师 的第一轮", exact: true });
  const student = dialog.getByRole("button", { name: "定位到 发言人 2 的第一轮", exact: true });
  await expect(dialog.getByTestId("speaker-review-locate")).toHaveCount(2);
  await expect(dialog.getByTestId("speaker-review-locate").first()).toHaveAccessibleName("定位到 林老师 的第一轮");
  await expect(teacher).toContainText("4 句 · 占已标注时长 80%");
  await expect(teacher.getByTestId("speaker-review-name-pending")).toHaveText("姓名待确认");
  await expect(student).toContainText("1 句 · 占已标注时长 20%");
  await expect(student.getByTestId("speaker-review-name-pending")).toHaveCount(0);
  await expect(dialog.getByTestId("speaker-review-disclaimer")).toHaveText("确认表示你已检查这份字幕稿的发言人归属，不代表文字已校对");

  // Confirming names the roster it showed and also confirms the teacher's name: the mark reads 「已核对」.
  await dialog.getByRole("button", { name: "标记为已核对", exact: true }).click();
  await expect(badge(page, "已核对")).toHaveText("已核对");
  await expect(stats.getByRole("definition")).toHaveText(["2", "1", "0"]);
  await expect(dialog.getByTestId("speaker-review-confirmed-at")).toContainText("已于");
  expect(server.confirmations).toEqual([{ confirmed: true, expectedRosterDigest: expect.any(String) }]);

  // The student gets a name nobody confirmed (from another device) and a draft keeps three
  // sentences to review: after a reload the mark counts the name and the panel has the draft line.
  server.speakers = server.speakers.map((speaker) => (speaker.id === SPEAKER_STUDENT ? { ...speaker, name: "王同学" } : speaker));
  server.draftNeedsReview = 3;
  await page.reload();
  const pending = badge(page, "已核对 · 1 个姓名待确认");
  await expect(pending).toHaveText("已核对 · 1 个姓名待确认");
  await pending.click();
  await expect(panel(page).getByLabel("核对概况").getByRole("definition")).toHaveText(["2", "1", "1"]);
  await expect(panel(page).getByTestId("speaker-review-draft")).toHaveText("草稿里还有 3 句待处理");
  await expect(panel(page).getByRole("button", { name: "定位到 王同学 的第一轮", exact: true }).getByTestId("speaker-review-name-pending")).toBeVisible();
  await expect(panel(page)).not.toContainText("待确认句数");
});

test("speaker review: confirming and withdrawing in one tab updates the mark in another without a reload", async ({ page, context }) => {
  await installMockBackend(page);
  const other = await context.newPage();
  await installMockBackend(other);
  await page.goto(READER);
  await other.goto(READER);
  await expect(badge(other, "发言人未核对")).toBeVisible();
  // The second tab must not be reloaded: the mark would go with it.
  await other.evaluate(() => ((window as unknown as { __opened: boolean }).__opened = true));

  await badge(page, "发言人未核对").click();
  await panel(page).getByRole("button", { name: "标记为已核对", exact: true }).click();
  await expect(badge(page, "已核对")).toBeVisible();
  await expect(badge(other, "已核对")).toBeVisible();
  await expect(badge(other, "发言人未核对")).toHaveCount(0);

  // The other tab's panel shows the confirmed review too.
  await badge(other, "已核对").click();
  await expect(panel(other).getByRole("button", { name: "取消核对", exact: true })).toBeVisible();
  await other.keyboard.press("Escape");

  await panel(page).getByRole("button", { name: "取消核对", exact: true }).click();
  await expect(badge(page, "发言人未核对")).toBeVisible();
  await expect(badge(other, "发言人未核对")).toBeVisible();
  expect(await other.evaluate(() => (window as unknown as { __opened?: boolean }).__opened)).toBe(true);
  expect(speakersRequests(page).confirmations).toEqual([{ confirmed: true, expectedRosterDigest: expect.any(String) }, { confirmed: false }]);
});

test("speaker review: a window showing an old roster cannot confirm; it reads the roster again and says so", async ({ page }) => {
  await installMockBackend(page);
  const server = speakersRequests(page);
  await page.goto(READER);
  await badge(page, "发言人未核对").click();
  const dialog = panel(page);
  await expect(dialog.getByRole("button", { name: "定位到 发言人 2 的第一轮", exact: true })).toBeVisible();

  // Someone names the student elsewhere; this window still shows the roster it read.
  server.speakers = server.speakers.map((speaker) => (speaker.id === SPEAKER_STUDENT ? { ...speaker, name: "王同学", nameConfirmed: true } : speaker));
  const refused = page.waitForResponse((response) => response.url().endsWith(`/api/transcript/revisions/${SPEAKERS_REVISION}/speakers-confirmed`));
  await dialog.getByRole("button", { name: "标记为已核对", exact: true }).click();
  const response = await refused;
  expect(response.status()).toBe(409);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("conflict.speakers_changed");

  // Nothing is confirmed; the panel says why and now lists the roster as it is.
  await expect(dialog.getByRole("alert")).toHaveText("发言人名单刚刚有变化，已重新读取，请检查后再标记为已核对");
  await expect(dialog.getByRole("button", { name: "定位到 王同学 的第一轮", exact: true })).toBeVisible();
  await expect(badge(page, "发言人未核对")).toBeVisible();
  expect(server.confirmedAt.size).toBe(0);

  // Confirming what is shown now goes through.
  await dialog.getByRole("button", { name: "标记为已核对", exact: true }).click();
  await expect(badge(page, "已核对")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(server.confirmations).toHaveLength(2);
  expect(server.confirmedAt.has(SPEAKERS_REVISION)).toBe(true);
});

/** A long lecture: the teacher at length, a short turn of the student, then the teacher again. */
const LONG_SEQUENCE = [...Array<string>(150).fill(SPEAKER_TEACHER), ...Array<string>(5).fill(SPEAKER_STUDENT), ...Array<string>(45).fill(SPEAKER_TEACHER)];
const STUDENT_FIRST = 150;

test("speaker review: mark, panel, roster, 辅助核对, a sample and confirming all work from the keyboard", async ({ page }) => {
  await installMockBackend(page);
  speakersRequests(page).sequence = LONG_SEQUENCE;
  await page.goto(READER);
  await expect(sentence(page, 0)).toBeVisible();

  const mark = badge(page, "发言人未核对");
  await tabTo(page, mark);
  await expect(mark).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(mark).toHaveAttribute("aria-expanded", "true");

  // The roster's entries are buttons named for where they lead.
  const teacher = dialog.getByRole("button", { name: "定位到 林老师 的第一轮", exact: true });
  const student = dialog.getByRole("button", { name: "定位到 发言人 2 的第一轮", exact: true });
  await tabTo(page, teacher);
  await page.keyboard.press("Tab");
  await expect(student).toBeFocused();

  // 「辅助核对」 is a disclosure: folded until Enter, then its region holds the sampled clips.
  const assist = dialog.getByRole("button", { name: "辅助核对", exact: true });
  await page.keyboard.press("Tab");
  await expect(assist).toBeFocused();
  await expect(assist).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(assist).toHaveAttribute("aria-expanded", "true");
  const region = page.locator(`#${await assist.getAttribute("aria-controls")}`);
  await expect(region.getByRole("heading", { name: "抽样试听" })).toBeVisible();
  // The B 站 player can only be moved, never paused by the page: every clip says 「跳到」, and a line says why.
  await expect(region.getByTestId("speaker-review-samples-jump-only")).toHaveText("当前播放器只能跳到片段开头，不会在片段结束时自动暂停");
  const studentClips = region.getByRole("button", { name: /^跳到 发言人 2 在 \d+:\d{2} 的片段$/ });
  await expect(studentClips).toHaveCount(5);
  await expect(studentClips.first()).toHaveText("跳到");
  // The student's first clip is their first sentence: Enter on it moves the player there.
  const clip = studentClips.first();
  await expect(clip).toHaveAccessibleName("跳到 发言人 2 在 25:00 的片段");
  await tabTo(page, clip);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("player-bilibili")).toHaveAttribute("src", new RegExp(`[?&]t=${(STUDENT_FIRST * SEGMENT_MS) / 1000}(&|$)`));

  // Confirming from the keyboard; Escape then closes the panel and gives the focus back to the mark.
  const confirm = dialog.getByRole("button", { name: "标记为已核对", exact: true });
  await tabTo(page, confirm);
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "取消核对", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const confirmed = badge(page, "已核对");
  await expect(confirmed).toBeFocused();
  expect(speakersRequests(page).confirmations).toEqual([{ confirmed: true, expectedRosterDigest: expect.any(String) }]);

  // A roster entry, picked with Enter, closes the panel and brings the speaker's first turn into view.
  await page.keyboard.press("Enter");
  await tabTo(page, panel(page).getByRole("button", { name: "定位到 发言人 2 的第一轮", exact: true }));
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  await expect(sentence(page, STUDENT_FIRST)).toBeInViewport();
  await expect(sentence(page, STUDENT_FIRST)).toHaveText(new RegExp(speakerSentence(STUDENT_FIRST)));
  await expect(sentence(page, 0)).not.toBeInViewport();
});
