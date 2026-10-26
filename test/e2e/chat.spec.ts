import { expect, test } from "@playwright/test";
import {
  CHAT_ANSWER_PREFIX,
  CHAT_METADATA_ANSWER,
  CHAT_RETRY_PREFIX,
  CHAT_SUGGESTIONS,
  CHAT_WEB_SOURCE,
  setChatDelay,
  setContextWindowUnknown,
  setNoTranscript,
} from "./mock-chat.ts";
import { BILI_REVISION, BILIBILI_CONTENT, CITED_INDEX, installMockBackend, PROFILE, segmentId } from "./mock-backend.ts";

const CITED = segmentId(BILI_REVISION, CITED_INDEX);

test("chat: a streamed answer renders with a clickable citation, suggestions only fill the input, explain only pre-fills", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "full");
  const input = panel.getByTestId("chat-input");
  await input.fill("这一讲讲了什么？");
  await input.press("Enter");

  const answer = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(answer).toContainText(CHAT_ANSWER_PREFIX);
  await expect(answer).toHaveAttribute("data-status", "complete");
  const citation = answer.locator(`[data-citation="${CITED}"]`);
  await expect(citation).toHaveText("1:10");
  await expect(panel.getByTestId("chat-suggestion")).toHaveCount(CHAT_SUGGESTIONS.length);

  const posts = backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages"));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toEqual({ text: "这一讲讲了什么？", modelRef: { providerProfileId: PROFILE, modelId: "mock-model" } });

  // The citation opens the reading view on the cited sentence.
  await citation.click();
  await expect(page).toHaveURL(new RegExp(`segment=${CITED}`));
  await expect(page.getByTestId("output-tab-transcript")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`[data-segment-id="${CITED}"]`).first()).toHaveAttribute("aria-current", "true");

  // A suggestion fills the input and sends nothing.
  await panel.getByTestId("chat-suggestion").first().click();
  await expect(input).toHaveValue(CHAT_SUGGESTIONS[0] as string);

  // Selecting part of a sentence offers "explain": the question carries the selected text and the sentence is quoted.
  await input.fill("");
  const selected = await page.locator(`[data-segment-id="${CITED}"]`).first().evaluate((sentence) => {
    const text = sentence.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString().replace(/\s+/gu, " ").trim();
  });
  await page.getByTestId("selection-explain").click();
  await expect(input).toHaveValue(`解释一下「${selected}」`);
  await expect(panel.getByTestId("chat-quote")).toContainText(`第 ${CITED_INDEX + 1} 句模拟字幕。`);
  expect(backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages"))).toHaveLength(1);
});

test("chat: an unknown context window greys the input out with a way to configure, until an override exists", async ({ page }) => {
  const backend = await installMockBackend(page);
  setContextWindowUnknown(page, BILIBILI_CONTENT);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-unavailable")).toHaveAttribute("data-reason", "context_window_unknown");
  await expect(panel.getByTestId("chat-input")).toBeDisabled();
  await expect(panel.getByTestId("chat-send")).toBeDisabled();

  await panel.getByTestId("chat-configure").click();
  await expect(page).toHaveURL(/\/settings\/models/);
  // The model's context window is filled in through the Profile editor, which stores it as
  // the user override.
  const card = page.locator('[data-model="mock-model"]');
  await expect(card).toContainText("—");
  await page.getByRole("button", { name: "编辑" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("上下文窗口").fill("128000");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText("128000");
  expect(backend.mutations.filter((mutation) => mutation.method === "PATCH" && mutation.path === `/api/providers/${PROFILE}`)).toHaveLength(1);
  await page.goBack();

  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "full");
  await expect(panel.getByTestId("chat-unavailable")).toHaveCount(0);
  await expect(panel.getByTestId("chat-input")).toBeEnabled();
  expect(backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages"))).toEqual([]);
});

test("chat without a transcript: the user can still ask, and the answer is labelled as not grounded in the video", async ({ page }) => {
  await installMockBackend(page);
  setNoTranscript(page, BILIBILI_CONTENT);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "metadata");
  await expect(panel.getByTestId("chat-metadata-hint")).toBeVisible();
  const input = panel.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await input.fill("这一讲大概讲什么？");
  await input.press("Enter");

  const answer = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(answer).toContainText(CHAT_METADATA_ANSWER);
  await expect(answer).toHaveAttribute("data-status", "complete");
  await expect(answer.getByTestId("chat-ungrounded")).toHaveText("未依据视频原文");
});

test("chat threads: each thread keeps its history, an answer in flight survives switching away and back, a reload reopens the thread, and threads are pinned and renamed", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);
  const panel = page.getByTestId("chat-panel");
  const input = panel.getByTestId("chat-input");
  const answers = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "full");
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("新对话");

  await input.fill("第一个会话的问题");
  await input.press("Enter");
  await expect(answers).toHaveCount(1);
  await expect(answers.first()).toHaveAttribute("data-status", "complete");
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("第一个会话的问题");

  await panel.getByTestId("chat-new-thread").click();
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("新对话");
  await expect(answers).toHaveCount(0);

  // The second thread's answer is held back long enough to leave and come back meanwhile.
  setChatDelay(page, 2500);
  await input.fill("第二个会话的问题");
  await input.press("Enter");
  await expect(panel.getByTestId("chat-stop")).toBeVisible();
  const posts = backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages"));
  expect(posts).toHaveLength(2);
  expect((posts[1]?.body as { threadId?: string }).threadId).toBeTruthy();

  await panel.getByTestId("chat-thread-menu").click();
  const items = page.getByTestId("chat-thread-item");
  await expect(items).toHaveCount(2);
  await items.nth(1).getByText("第一个会话的问题").click();
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("第一个会话的问题");
  await expect(answers).toHaveCount(1);
  await expect(panel.getByTestId("chat-stop")).toHaveCount(0);
  await expect(panel.getByTestId("chat-send")).toBeVisible();

  await panel.getByTestId("chat-thread-menu").click();
  await items.nth(0).locator("button").first().click();
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("第二个会话的问题");
  await expect(answers.last()).toHaveAttribute("data-status", "complete", { timeout: 10_000 });
  await expect(answers.last()).toContainText(CHAT_ANSWER_PREFIX);
  setChatDelay(page, 0);

  await page.reload();
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("第二个会话的问题");
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveText(["第二个会话的问题"]);

  // Each row offers rename · pin · delete; pinning moves the thread to the top, the open one stays open.
  await panel.getByTestId("chat-thread-menu").click();
  expect(await items.nth(1).locator("button[data-testid]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-testid")))).toEqual([
    "chat-thread-rename",
    "chat-thread-pin",
    "chat-thread-delete",
  ]);
  await items.nth(1).getByRole("button", { name: "置顶会话「第一个会话的问题」" }).click();
  await expect(items.nth(0)).toContainText("第一个会话的问题");
  await expect(items.nth(0).getByTestId("chat-thread-pinned")).toBeVisible();
  await expect(items.nth(0).getByRole("button", { name: "取消置顶会话「第一个会话的问题」" })).toBeVisible();
  await expect(items.nth(1).getByTestId("chat-thread-pinned")).toHaveCount(0);
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("第二个会话的问题");
  await expect(panel.getByTestId("chat-thread-title-pinned")).toHaveCount(0);

  await items.nth(0).getByRole("button", { name: "重命名会话「第一个会话的问题」" }).click();
  const rename = page.getByTestId("chat-thread-rename-input");
  await expect(rename).toHaveValue("第一个会话的问题");
  await rename.fill("复习要点");
  await page.getByTestId("chat-thread-rename-save").click();
  await expect(rename).toHaveCount(0);
  const threadPatches = () => backend.mutations.filter((mutation) => mutation.method === "PATCH" && mutation.path.includes("/chat/threads/")).map((mutation) => mutation.body);
  expect(threadPatches()).toEqual([{ pinned: true }, { title: "复习要点" }]);

  await panel.getByTestId("chat-thread-menu").click();
  await expect(items.nth(0)).toContainText("复习要点");
  await items.nth(0).getByText("复习要点").click();
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("复习要点");
  await expect(panel.getByTestId("chat-thread-title-pinned")).toBeVisible();
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveText(["第一个会话的问题"]);

  // Saved blank, the thread is called after its first question again.
  await panel.getByTestId("chat-thread-menu").click();
  await items.nth(0).getByTestId("chat-thread-rename").click();
  await rename.fill("");
  await page.getByTestId("chat-thread-rename-save").click();
  await expect(panel.getByTestId("chat-thread-title")).toHaveText("第一个会话的问题");
  expect(threadPatches().at(-1)).toEqual({ title: null });
});

test.describe("chat turns, read in another time zone", () => {
  test.use({ timezoneId: "America/New_York" });

  test("each answer has copy · retry (last turn only) · delete · model · Beijing time; turns delete one by one, picked together, or all at once", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const backend = await installMockBackend(page);
    await page.goto(`/contents/${BILIBILI_CONTENT}`);
    const panel = page.getByTestId("chat-panel");
    const input = panel.getByTestId("chat-input");
    const turns = panel.getByTestId("chat-turn");
    await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "full");

    for (const question of ["第一问", "第二问"]) {
      await input.fill(question);
      await input.press("Enter");
      await expect(panel.getByTestId("chat-turn-footer")).toHaveCount(question === "第一问" ? 1 : 2);
    }
    const first = turns.nth(0);
    // Stamped 15:43 UTC: 23:43 in Beijing, still the afternoon in New York.
    await expect(first.getByTestId("chat-turn-time")).toHaveText("2026-10-26 23:43");
    await expect(first.getByTestId("chat-turn-model")).toHaveText("模拟模型 · mock-model");
    await expect(first.getByTestId("chat-turn-model")).toHaveAttribute("title", "OpenAI 兼容接口");
    await expect(panel.getByTestId("chat-turn-retry")).toHaveCount(1);
    await expect(turns.nth(1).getByTestId("chat-turn-retry")).toHaveCount(1);

    await first.getByTestId("chat-turn-copy").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${CHAT_ANSWER_PREFIX} [1:10]。`);

    await turns.nth(1).getByTestId("chat-turn-retry").click();
    await expect(turns.nth(1).locator('[data-role="assistant"]')).toContainText(CHAT_RETRY_PREFIX);
    await expect(turns).toHaveCount(2);
    expect(backend.mutations.filter((mutation) => mutation.path.endsWith("/retry"))).toHaveLength(1);

    await first.getByTestId("chat-turn-delete").click();
    await page.getByTestId("confirm-dialog-ok").click();
    await expect(turns).toHaveCount(1);
    await expect(turns.first()).toContainText("第二问");

    await input.fill("第三问");
    await input.press("Enter");
    await expect(turns).toHaveCount(2);
    await panel.getByTestId("chat-select").click();
    await panel.getByTestId("chat-turn-check").nth(0).check();
    await panel.getByTestId("chat-turn-check").nth(1).check();
    await expect(panel.getByTestId("chat-select-count")).toHaveText("已选 2 轮");
    await panel.getByTestId("chat-select-delete").click();
    await page.getByTestId("confirm-dialog-ok").click();
    await expect(turns).toHaveCount(0);
    await expect(panel.getByTestId("chat-select-bar")).toHaveCount(0);

    await input.fill("第四问");
    await input.press("Enter");
    await expect(turns).toHaveCount(1);
    await panel.getByTestId("chat-clear").click();
    await page.getByTestId("confirm-dialog-ok").click();
    await expect(turns).toHaveCount(0);
    await expect(panel.getByTestId("chat-thread-title")).toHaveText("新对话");
    expect(backend.mutations.some((mutation) => mutation.method === "DELETE" && mutation.path === `/api/contents/${BILIBILI_CONTENT}/chat`)).toBe(true);
  });
});

test("chat web search: configured from the switch's link, then searched answers show their status, sources and [n] links; a forced search applies once", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);
  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "full");
  await expect(panel.getByTestId("chat-web-search")).toBeDisabled();

  await panel.getByTestId("chat-web-search-configure").click();
  await expect(page).toHaveURL(/\/settings\/web-search$/);
  await expect(page.getByTestId("web-search-credential")).toHaveText("未配置");
  await page.getByLabel("API Key").fill("tvly-<placeholder>");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("web-search-credential")).toHaveText("已配置");
  await page.getByTestId("web-search-test").click();
  await expect(page.getByTestId("web-search-test-result")).toHaveText("测试成功，返回 5 条结果");
  await page.goBack();

  const toggle = panel.getByTestId("chat-web-search");
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("data-mode", "off");
  await toggle.click();
  await page.getByTestId("chat-web-search-auto").click();
  await expect(toggle).toHaveAttribute("data-mode", "auto");
  await expect.poll(() => backend.mutations.some((mutation) => mutation.method === "PATCH" && (mutation.body as { chatWebSearchMode?: string }).chatWebSearchMode === "auto")).toBe(true);

  const input = panel.getByTestId("chat-input");
  await input.fill("Amber 最近有什么消息？");
  await input.press("Enter");
  const answer = panel.locator('[data-testid="chat-message"][data-role="assistant"]').last();
  await expect(answer).toHaveAttribute("data-status", "complete");
  await expect(answer.getByTestId("chat-search-status")).toContainText("搜索到 1 个来源");
  const link = answer.locator("sup a[data-web-citation]");
  await expect(link).toHaveText("[1]");
  await expect(link).toHaveAttribute("href", CHAT_WEB_SOURCE.url);
  await expect(link).toHaveAttribute("target", "_blank");
  await answer.getByTestId("chat-sources-toggle").click();
  await expect(answer.getByTestId("chat-source-link")).toHaveText(CHAT_WEB_SOURCE.title);

  await toggle.click();
  await page.getByTestId("chat-web-search-force").click();
  await expect(toggle).toHaveAttribute("data-mode", "force");
  await input.fill("再搜一次");
  await input.press("Enter");
  await expect(panel.getByTestId("chat-turn-footer")).toHaveCount(2);
  await expect(toggle).toHaveAttribute("data-mode", "auto");
  const sent = backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages")).map((mutation) => (mutation.body as { webSearch?: string }).webSearch);
  expect(sent).toEqual(["auto", "force"]);
});
