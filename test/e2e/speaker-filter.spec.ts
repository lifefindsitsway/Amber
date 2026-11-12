import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockBackend, segmentId } from "./mock-backend.ts";
import {
  SEGMENT_GAP_MS,
  SEGMENT_MS,
  SPEAKER_SEQUENCE,
  SPEAKER_STUDENT,
  SPEAKER_TEACHER,
  SPEAKERS_CONTENT,
  SPEAKERS_EARLIER_REVISION,
  SPEAKERS_REVISION,
  speakersRequests,
} from "./mock-speakers.ts";

const READER = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;

/** Presses Tab until `target` has the focus, as a keyboard user would reach it; fails if it never does. */
async function tabTo(page: Page, target: Locator, limit = 120): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

const reader = (page: Page): Locator => page.getByTestId("transcript-reader");
const sentence = (page: Page, index: number, revision = SPEAKERS_REVISION): Locator => reader(page).locator(`[data-segment-id="${segmentId(revision, index)}"]`);
/** The sentences the reading view shows, by their index in the revision. */
async function shownIndexes(page: Page, revision = SPEAKERS_REVISION): Promise<number[]> {
  const ids = await reader(page).locator("[data-segment-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-segment-id") ?? ""));
  return ids.map((id) => Array.from({ length: 400 }, (_, index) => index).find((index) => segmentId(revision, index) === id) ?? -1);
}
const trigger = (page: Page, chosen = 0): Locator =>
  page.getByRole("button", { name: chosen === 0 ? "只看某些发言人" : `只看某些发言人，已选 ${chosen} 人`, exact: true });
const popover = (page: Page): Locator => page.getByRole("dialog", { name: "只看某些发言人" });
const option = (page: Page, name: string): Locator => popover(page).getByRole("checkbox", { name: new RegExp(`^${name}`) });
/**
 * Ticks or unticks a speaker with a click. The box follows the address, which the router
 * updates a moment after the click, so the state is awaited rather than checked at once.
 */
async function setTicked(box: Locator, ticked: boolean): Promise<void> {
  await box.click();
  if (ticked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
}
const speakerParams = (page: Page): string[] => new URL(page.url()).searchParams.getAll("speaker");

const teacherIndexes = SPEAKER_SEQUENCE.flatMap((speaker, index) => (speaker === SPEAKER_TEACHER ? [index] : []));

test("speaker filter: several speakers are picked, kept in the address and read back from it", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(READER);
  await expect(sentence(page, 0)).toBeVisible();
  expect(await shownIndexes(page)).toEqual(SPEAKER_SEQUENCE.map((_, index) => index));

  await trigger(page).click();
  await expect(option(page, "林老师")).toHaveAccessibleName(/^林老师\s*4 句$/);
  await expect(option(page, "发言人 2")).toHaveAccessibleName(/^发言人 2\s*1 句$/);
  await setTicked(option(page, "发言人 2"), true);
  await expect.poll(() => speakerParams(page)).toEqual([SPEAKER_STUDENT]);
  await expect(page.getByTestId("speaker-filter-bar").getByRole("status")).toHaveText("只看 发言人 2 · 1 轮");
  expect(await shownIndexes(page)).toEqual([2]);

  await setTicked(option(page, "林老师"), true);
  // Written in the speakers' order, whatever order they were picked in.
  await expect.poll(() => speakerParams(page)).toEqual([SPEAKER_TEACHER, SPEAKER_STUDENT]);
  await expect(page.getByTestId("speaker-filter-bar").getByRole("status")).toHaveText("只看 林老师、发言人 2 · 3 轮");
  await expect(trigger(page, 2)).toBeVisible();
  // The unassigned last sentence belongs to neither.
  await expect.poll(() => shownIndexes(page)).toEqual([0, 1, 2, 3, 4]);
  expect(new URL(page.url()).searchParams.get("tab")).toBe("transcript");

  // A reload reads the same selection back from the address.
  await page.reload();
  await expect(page.getByTestId("speaker-filter-bar").getByRole("status")).toHaveText("只看 林老师、发言人 2 · 3 轮");
  await expect.poll(() => shownIndexes(page)).toEqual([0, 1, 2, 3, 4]);
  await trigger(page, 2).click();
  await expect(option(page, "林老师")).toBeChecked();
  await expect(option(page, "发言人 2")).toBeChecked();

  // Unticking both is the whole text again, and the address has no speaker left.
  await setTicked(option(page, "林老师"), false);
  await setTicked(option(page, "发言人 2"), false);
  await expect.poll(() => speakerParams(page)).toEqual([]);
  await expect(page.getByTestId("speaker-filter-bar")).toHaveCount(0);
  await expect.poll(() => shownIndexes(page)).toEqual(SPEAKER_SEQUENCE.map((_, index) => index));
});

test("speaker filter: unknown and repeated ids are dropped from the address; ?search= only marks", async ({ page }) => {
  await installMockBackend(page);
  // One sentence of the teacher's and the student's sentence mention 「函数」; no other does.
  speakersRequests(page).texts = { 0: "我们先讨论函数。", 2: "函数到底是什么？" };
  const unknown = "01J0000000000000000000SPK9";
  const search = "函数";
  const query = new URLSearchParams([
    ["tab", "transcript"],
    ["search", search],
    ["speaker", unknown],
    ["speaker", SPEAKER_TEACHER],
    ["speaker", SPEAKER_TEACHER],
  ]);
  await page.goto(`/contents/${SPEAKERS_CONTENT}?${query.toString()}`);
  // Rewritten in place: the known speaker once; the other parameters stay.
  await expect.poll(() => speakerParams(page)).toEqual([SPEAKER_TEACHER]);
  expect(new URL(page.url()).searchParams.get("search")).toBe(search);
  expect(new URL(page.url()).searchParams.get("tab")).toBe("transcript");
  await expect(page.getByTestId("speaker-filter-bar").getByRole("status")).toHaveText("只看 林老师 · 2 轮");

  // The speaker filter hides the student; the query hides nothing and only marks its match.
  await expect.poll(() => shownIndexes(page)).toEqual(teacherIndexes);
  await expect(sentence(page, 0).locator("mark")).toHaveText(search);
  await expect(reader(page).locator("mark")).toHaveCount(1);

  // Without the speaker filter, the query still shows every sentence and marks both matches.
  await page.getByTestId("speaker-filter-bar").getByRole("button", { name: "清除", exact: true }).click();
  await expect.poll(() => shownIndexes(page)).toEqual(SPEAKER_SEQUENCE.map((_, index) => index));
  expect(new URL(page.url()).searchParams.get("search")).toBe(search);
  await expect(reader(page).locator("mark")).toHaveText([search, search]);
});

/** The student speaks twice, far apart in a long lecture of the teacher. */
const GAP_SEQUENCE = [
  ...Array<string>(60).fill(SPEAKER_TEACHER),
  ...Array<string>(5).fill(SPEAKER_STUDENT),
  ...Array<string>(60).fill(SPEAKER_TEACHER),
  ...Array<string>(5).fill(SPEAKER_STUDENT),
  ...Array<string>(70).fill(SPEAKER_TEACHER),
];
const FIRST_SKIPPED = 65;
const NEXT_SHOWN = 125;

test("speaker filter: a gap bar says how long was skipped and, from the keyboard, returns to the full text there", async ({ page }) => {
  await installMockBackend(page);
  speakersRequests(page).sequence = GAP_SEQUENCE;
  await page.goto(`${READER}&speaker=${SPEAKER_STUDENT}`);
  await expect(page.getByTestId("speaker-filter-bar").getByRole("status")).toHaveText("只看 发言人 2 · 2 轮");
  await expect(sentence(page, 60)).toBeVisible();

  // From the end of the student's first turn to the start of the next: 125 slots less 65 slots, plus
  // the pause after the last sentence shown = 600.5 s, rounded to the second.
  expect(NEXT_SHOWN * SEGMENT_MS - (FIRST_SKIPPED * SEGMENT_MS - SEGMENT_GAP_MS)).toBe(600_500);
  const gap = page.getByRole("button", { name: "略过 10 分 1 秒，回到完整原文的这个位置", exact: true });
  await expect(gap).toHaveText("略过 10 分 1 秒");
  await expect(page.getByTestId("speaker-gap")).toHaveCount(1);

  await tabTo(page, gap);
  await page.keyboard.press("Enter");
  // The filter is gone, from the page and the address, and the full text stands at the first skipped sentence.
  await expect(page.getByTestId("speaker-filter-bar")).toHaveCount(0);
  await expect.poll(() => speakerParams(page)).toEqual([]);
  await expect(page.getByTestId("speaker-gap")).toHaveCount(0);
  await expect(sentence(page, FIRST_SKIPPED)).toBeInViewport();
  await expect(sentence(page, 0)).not.toBeInViewport();
});

test("speaker filter: a version where the picked speakers say nothing shows an empty state that clears the filter", async ({ page }) => {
  await installMockBackend(page);
  speakersRequests(page).earlierRevision = true;
  await page.goto(`${READER}&speaker=${SPEAKER_STUDENT}`);
  await expect.poll(() => shownIndexes(page)).toEqual([2]);

  // The earlier recognition gave every sentence to the teacher.
  await page.getByTestId("transcript-version").selectOption(SPEAKERS_EARLIER_REVISION);
  await expect.poll(() => new URL(page.url()).searchParams.get("revision")).toBe(SPEAKERS_EARLIER_REVISION);
  const empty = page.getByTestId("speaker-filter-empty");
  await expect(empty).toContainText("这份字幕稿里没有所选发言人的句子");
  expect(speakerParams(page)).toEqual([SPEAKER_STUDENT]);
  await expect(reader(page)).toHaveCount(0);

  await empty.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect.poll(() => speakerParams(page)).toEqual([]);
  await expect.poll(() => shownIndexes(page, SPEAKERS_EARLIER_REVISION)).toEqual([0, 1, 2, 3]);
  expect(new URL(page.url()).searchParams.get("revision")).toBe(SPEAKERS_EARLIER_REVISION);
});

test("speaker filter: the 只看 popover is opened, ticked and closed from the keyboard", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(READER);
  await expect(sentence(page, 0)).toBeVisible();

  const button = trigger(page);
  await tabTo(page, button);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(popover(page)).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");

  // The speakers are checkboxes named with their sentence counts.
  await expect(popover(page).getByRole("checkbox")).toHaveCount(2);
  await tabTo(page, option(page, "林老师"));
  await page.keyboard.press("Space");
  await expect(option(page, "林老师")).toBeChecked();
  await expect.poll(() => speakerParams(page)).toEqual([SPEAKER_TEACHER]);
  await page.keyboard.press("Tab");
  await expect(option(page, "发言人 2")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(option(page, "发言人 2")).toBeChecked();
  await expect.poll(() => speakerParams(page)).toEqual([SPEAKER_TEACHER, SPEAKER_STUDENT]);

  // Escape closes the popover and gives the focus back to the button, now naming the count.
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page, 2)).toBeFocused();
  await expect(page.getByTestId("speaker-filter-bar").getByRole("status")).toHaveText("只看 林老师、发言人 2 · 3 轮");

  // 「清除」 on the active line is reachable too.
  const clear = page.getByTestId("speaker-filter-bar").getByRole("button", { name: "清除", exact: true });
  await tabTo(page, clear);
  await page.keyboard.press("Enter");
  await expect.poll(() => speakerParams(page)).toEqual([]);
  await expect(trigger(page)).toBeVisible();
});

test("speaker filter: in the subtitle script tab the picked speakers and the keyword narrow the rows together", async ({ page }) => {
  await installMockBackend(page);
  // Sentences 0 and 3 are the teacher's, sentence 2 the student's: all three mention 「函数」.
  speakersRequests(page).texts = { 0: "我们先讨论函数。", 2: "函数到底是什么？", 3: "函数是一种映射。" };
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=subtitles&search=函数`);
  const rows = page.locator("[data-segment-id]");
  const indexes = async (): Promise<number[]> => {
    const ids = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-segment-id") ?? ""));
    return ids.map((id) => SPEAKER_SEQUENCE.findIndex((_, index) => segmentId(SPEAKERS_REVISION, index) === id));
  };
  // A search hit's query narrows this list from the start.
  const box = page.getByRole("searchbox", { name: "筛选字幕" });
  await expect(box).toHaveValue("函数");
  await expect.poll(indexes).toEqual([0, 2, 3]);

  await page.getByRole("button", { name: "只看某些发言人", exact: true }).click();
  await setTicked(popover(page).getByRole("checkbox", { name: /^林老师/ }), true);
  await expect.poll(indexes).toEqual([0, 3]);
  await expect(page.getByRole("button", { name: "只看某些发言人，已选 1 人", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Each alone: the keyword cleared leaves the teacher's sentences, the speaker unticked leaves the hits.
  await box.fill("");
  await expect.poll(indexes).toEqual(teacherIndexes);
  await box.fill("函数");
  await page.getByRole("button", { name: "只看某些发言人，已选 1 人", exact: true }).click();
  await setTicked(popover(page).getByRole("checkbox", { name: /^林老师/ }), false);
  await expect.poll(indexes).toEqual([0, 2, 3]);
  await setTicked(popover(page).getByRole("checkbox", { name: /^发言人 2/ }), true);
  await expect.poll(indexes).toEqual([2]);
  // The tab's own filter writes nothing to the address.
  expect(new URL(page.url()).searchParams.getAll("speaker")).toEqual([]);
});
