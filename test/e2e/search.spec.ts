import { expect, test } from "@playwright/test";
import { BILI_REVISION, BILIBILI_CONTENT, installMockBackend, segmentId, YOUTUBE_URL } from "./mock-backend.ts";
import {
  BASIS_CONTENT,
  BASIS_LECTURE,
  BASIS_TITLE,
  installSpeakerBasis,
  NAMESAKE_CONTENT,
  NAMESAKE_LECTURE,
  NAMESAKE_PROFESSOR,
  NAMESAKE_TITLE,
  PROFESSOR,
  PROFESSOR_NAME,
} from "./mock-outputs.ts";

test("Omnibox search: a sentence hit opens the reading view on that sentence with the query", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/library");
  // The shortcut registry is live once the shell has rendered.
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await page.keyboard.press("Control+K");
  const omnibox = page.getByTestId("omnibox");
  await expect(omnibox).toBeVisible();
  await omnibox.locator("input").fill("第 8 句");

  const sentences = page.getByTestId("omnibox-group-segments");
  await expect(sentences).toBeVisible();
  await expect(sentences.getByRole("option")).toHaveCount(1);
  await sentences.getByRole("option").first().click();

  const target = segmentId(BILI_REVISION, 7);
  await expect(page).toHaveURL(new RegExp(`/contents/${BILIBILI_CONTENT}\\?.*segment=${target}`));
  const url = new URL(page.url());
  expect(url.searchParams.get("tab")).toBe("transcript");
  expect(url.searchParams.get("search")).toBe("第 8 句");
  await expect(page.getByTestId("output-tab-transcript")).toHaveAttribute("aria-selected", "true");
  const hit = page.getByTestId("transcript-reader").locator(`[data-segment-id="${target}"]`);
  await expect(hit).toHaveAttribute("aria-current", "true");
  await expect(hit.locator("mark").first()).toBeVisible();
  // Searching only reads.
  expect(backend.mutations).toEqual([]);
});

test("Library search: only hit Contents stay listed, each with an excerpt", async ({ page }) => {
  await installMockBackend(page);
  await page.goto("/new");
  await page.getByTestId("new-url-input").fill(YOUTUBE_URL);
  await page.getByTestId("new-submit").click();
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(2);

  await page.getByTestId("library-search").fill("B 站");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  const snippet = page.getByTestId("search-snippet");
  await expect(snippet).toHaveCount(1);
  await expect(snippet.locator("mark")).toHaveText(["B", "站"]);
  await expect(page.getByTestId("library-row").getByRole("link", { name: "第二讲：B 站模拟课程", exact: true })).toBeVisible();

  await page.getByTestId("library-search").fill("");
  await expect(page.getByTestId("library-row")).toHaveCount(2);
});

test("Omnibox search: sentence hits name their speaker, 「未核对」 while unreviewed; summary hits mark a changed speaker basis", async ({ page }) => {
  const backend = await installMockBackend(page);
  await installSpeakerBasis(page, { confirmed: true, basis: { state: "attribution_changed", speakers: [], changedSentences: 1 } });
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await page.keyboard.press("Control+K");
  const omnibox = page.getByTestId("omnibox");
  await omnibox.locator("input").fill("依据");

  const sentences = omnibox.getByTestId("omnibox-group-segments");
  await expect(sentences.getByRole("option")).toHaveCount(BASIS_LECTURE.sequence.length + NAMESAKE_LECTURE.sequence.length);
  const reviewed = sentences.getByRole("option").filter({ hasText: BASIS_TITLE });
  const unreviewed = sentences.getByRole("option").filter({ hasText: NAMESAKE_TITLE });
  // The reviewed lecture's speakers are names; the other's are labels, said in words.
  // The label follows a decorative letter avatar, which is not part of the text read out.
  await expect(reviewed.getByTestId("hit-speaker").locator("span.truncate")).toHaveText(BASIS_LECTURE.sequence.map((id) => (id === PROFESSOR ? PROFESSOR_NAME : "发言人 2")));
  await expect(reviewed.getByTestId("hit-speaker").first()).toHaveAttribute("data-confirmed", "true");
  await expect(unreviewed.getByTestId("hit-speaker").locator("span.truncate")).toHaveText(["发言人 2未核对", `${PROFESSOR_NAME}未核对`, `${PROFESSOR_NAME}未核对`]);
  await expect(unreviewed.getByTestId("hit-speaker").first()).toHaveAttribute("data-confirmed", "false");
  // The option's accessible name carries the speaker and the mark, not only its colour.
  await expect(unreviewed.first()).toHaveAccessibleName(/发言人 2\s*未核对/);

  const summaries = omnibox.getByTestId("omnibox-group-summaries");
  await expect(summaries.getByRole("option")).toHaveCount(2);
  await expect(summaries.getByRole("option").filter({ hasText: BASIS_TITLE }).getByTestId("hit-basis-changed")).toHaveText("人物依据已变化");
  // The namesake's summary still holds: no mark, and the marked one is not demoted.
  await expect(summaries.getByRole("option").filter({ hasText: NAMESAKE_TITLE }).getByTestId("hit-basis-changed")).toHaveCount(0);
  await expect(summaries.getByRole("option").first()).toContainText(BASIS_TITLE);
  // No name contains the query, so there is no speaker group.
  await expect(omnibox.getByTestId("omnibox-group-speakers")).toHaveCount(0);
  expect(backend.mutations).toEqual([]);
});

test("Omnibox search: a name match lists each lecture's namesake apart and opens the reading view filtered with speaker=", async ({ page }) => {
  await installMockBackend(page);
  await installSpeakerBasis(page);
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await page.keyboard.press("Control+K");
  const omnibox = page.getByTestId("omnibox");
  await omnibox.locator("input").fill(PROFESSOR_NAME);

  const group = omnibox.getByTestId("omnibox-group-speakers");
  await expect(group).toBeVisible();
  // The group's heading says it is a name match.
  await expect(group.getByText("发言人（姓名匹配）", { exact: true })).toBeVisible();
  // The same name in two lectures is two entries, never merged into one person.
  await expect(group.getByRole("option")).toHaveCount(2);
  await expect(group.getByRole("option").first()).toHaveAccessibleName(`${PROFESSOR_NAME} ${BASIS_TITLE} · 4 句`);
  await expect(group.getByRole("option").nth(1)).toHaveAccessibleName(`${PROFESSOR_NAME} ${NAMESAKE_TITLE} · 2 句`);
  // The name is not in the text corpus: nothing else is found.
  for (const other of ["contents", "segments", "summaries", "collections"]) {
    await expect(omnibox.getByTestId(`omnibox-group-${other}`)).toHaveCount(0);
  }

  // Keyboard only: the first entry is active, Enter opens it.
  await expect(group.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await omnibox.locator("input").press("Enter");
  await expect(page).toHaveURL(new RegExp(`/contents/${BASIS_CONTENT}\\?`));
  const url = new URL(page.url());
  expect(url.searchParams.get("tab")).toBe("transcript");
  expect(url.searchParams.getAll("speaker")).toEqual([PROFESSOR]);
  // A name is not words of the text, so the query does not travel along.
  expect(url.searchParams.has("search")).toBe(false);
  await expect(page.getByTestId("speaker-filter-bar").getByRole("status")).toHaveText(`只看 ${PROFESSOR_NAME} · 3 轮`);
});

test("Library search: the speaker group links with speaker=, and hit excerpts carry the speaker", async ({ page }) => {
  await installMockBackend(page);
  await installSpeakerBasis(page, { confirmed: false });
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(1);

  await page.getByTestId("library-search").fill(PROFESSOR_NAME);
  const group = page.getByRole("region", { name: "发言人（姓名匹配）" });
  await expect(group).toBeVisible();
  const links = group.getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute("href", `/contents/${BASIS_CONTENT}?tab=transcript&speaker=${PROFESSOR}`);
  await expect(links.nth(1)).toHaveAttribute("href", `/contents/${NAMESAKE_CONTENT}?tab=transcript&speaker=${NAMESAKE_PROFESSOR}`);
  // No sentence carries the name: no lecture row, only the group.
  await expect(page.getByTestId("library-row")).toHaveCount(0);

  await page.getByTestId("library-search").fill("依据");
  await expect(page.getByTestId("library-row")).toHaveCount(2);
  const speakers = page.getByTestId("search-snippet").getByTestId("hit-speaker");
  await expect(speakers).toHaveCount(2);
  // Neither lecture is reviewed now, so both first hits say so.
  for (const index of [0, 1]) await expect(speakers.nth(index)).toContainText("未核对");

  // Reachable by keyboard: Tab onwards from the search box reaches the group's first link.
  await page.getByTestId("library-search").fill(PROFESSOR_NAME);
  await expect(links.first()).toBeVisible();
  await page.getByTestId("library-search").focus();
  for (let step = 0; step < 10 && !(await links.first().evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(links.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`speaker=${PROFESSOR}`));
  await expect(page.getByTestId("speaker-filter-bar")).toContainText(PROFESSOR_NAME);
});
