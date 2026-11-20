import { expect, test, type Page, type Route } from "@playwright/test";
import { providerListDtoSchema } from "../../src/shared/dto/provider.ts";
import { userSettingsDtoSchema } from "../../src/shared/dto/settings.ts";
import { BILIBILI_CONTENT, installMockBackend, PROFILE, providerProfile, YOUTUBE_CONTENT, YOUTUBE_URL } from "./mock-backend.ts";

const OVERRIDE = `/api/providers/${PROFILE}/models/mock-model/override`;

/**
 * Lists the fake model without a context window until the notice writes one through the
 * override route; registered after the mock backend, so these answers come first and every
 * other request falls through to it. `withDefault` also names the model as the default, the
 * one the content page's 「生成」 entries use.
 */
async function windowUnknown(page: Page, options: { withDefault?: boolean } = {}): Promise<{ overrides: unknown[] }> {
  let window: number | undefined;
  const overrides: unknown[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && path === "/api/providers") {
      await route.fulfill({ json: providerListDtoSchema.parse({ items: [providerProfile(window)] }) });
      return;
    }
    if (method === "PUT" && path === OVERRIDE) {
      const body = request.postDataJSON() as { limits: { contextWindowTokens: number | null } };
      overrides.push(body);
      window = body.limits.contextWindowTokens ?? undefined;
      await route.fulfill({ json: providerProfile(window) });
      return;
    }
    if (options.withDefault === true && method === "GET" && path === "/api/settings") {
      await route.fulfill({
        json: userSettingsDtoSchema.parse({
          theme: "light",
          language: "zh-CN",
          shortcuts: {},
          defaultModelRef: { providerProfileId: PROFILE, modelId: "mock-model" },
          updatedAt: 1,
        }),
      });
      return;
    }
    await route.fallback();
  });
  return { overrides };
}

test("model readiness on the new page: the import waits for the model's context window, filled in place", async ({ page }) => {
  const backend = await installMockBackend(page);
  const { overrides } = await windowUnknown(page);
  await page.goto("/new");
  await page.getByTestId("new-url-input").fill(YOUTUBE_URL);

  const notice = page.getByTestId("new-context-window");
  await expect(notice).toContainText("「模拟模型 · mock-model」还没有填写上下文窗口，总结、章节、高光与 AI 对话需要它。");
  const submit = page.getByTestId("new-submit");
  await expect(submit).toBeDisabled();

  // Only transcribing needs no window: with no model chosen the notice goes away.
  await page.getByRole("button", { name: "本次设置" }).click();
  const model = page.getByLabel("AI 模型");
  await model.selectOption("");
  await expect(notice).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await model.selectOption({ label: "模拟模型 · mock-model" });
  await expect(notice).toBeVisible();

  // A common size fills the field; Enter saves it without submitting the page's form.
  await notice.getByRole("button", { name: /^填入 128K/ }).click();
  const field = notice.getByLabel("上下文窗口");
  await expect(field).toHaveValue("128K");
  await field.press("Enter");
  await expect(notice).toHaveCount(0);
  expect(overrides).toEqual([{ limits: { contextWindowTokens: 128000, maxOutputTokens: null } }]);
  expect(backend.mutations.filter((mutation) => mutation.path === "/api/contents/import")).toEqual([]);

  await expect(submit).toBeEnabled();
  await expect(submit).toBeFocused();
  await submit.click();
  await expect(page).toHaveURL(new RegExp(`/contents/${YOUTUBE_CONTENT}`));
});

test("model readiness on the content page: one notice for the model, one fill frees summary, chapters and the chat", async ({ page }) => {
  await installMockBackend(page);
  const { overrides } = await windowUnknown(page, { withDefault: true });
  await page.goto(`/contents/${BILIBILI_CONTENT}?tab=summary`);

  const summaryNotice = page.getByTestId("summary-context-window");
  await expect(summaryNotice).toContainText("「模拟模型 · mock-model」");
  await expect(page.getByTestId("summary-generate")).toBeDisabled();
  await expect(page.getByTestId("chapters-regenerate")).toBeDisabled();

  // The chat beside it runs on the same model: it only points to the summary's notice, and the
  // question can be written meanwhile, just not sent.
  const panel = page.getByTestId("chat-panel");
  const chatNotice = panel.getByTestId("chat-context-window");
  await expect(chatNotice).toHaveAttribute("data-variant", "pointer");
  await expect(panel.getByTestId("chat-input")).toBeEnabled();
  await panel.getByTestId("chat-input").fill("这一讲讲了什么？");
  await expect(panel.getByTestId("chat-send")).toBeDisabled();
  await chatNotice.getByRole("button", { name: "去填写" }).click();
  const field = summaryNotice.getByLabel("上下文窗口");
  await expect(field).toBeFocused();

  // An invalid entry is refused in place, without a request.
  await field.fill("12.5");
  await summaryNotice.getByRole("button", { name: "保存" }).click();
  await expect(summaryNotice.getByRole("alert")).toHaveText("请填写正整数，例如 128000 或 128K");
  expect(overrides).toEqual([]);

  await field.fill("200K");
  await summaryNotice.getByRole("button", { name: "保存" }).click();
  await expect(summaryNotice).toHaveCount(0);
  await expect(page.getByTestId("summary-generate")).toBeEnabled();
  await expect(page.getByTestId("summary-generate")).toBeFocused();
  // One fill frees the chat as well, with the question kept.
  await expect(panel.getByTestId("chat-unavailable")).toHaveCount(0);
  await expect(panel.getByTestId("chat-send")).toBeEnabled();
  await expect(panel.getByTestId("chat-input")).toHaveValue("这一讲讲了什么？");
  expect(overrides).toEqual([{ limits: { contextWindowTokens: 200000, maxOutputTokens: null } }]);
});
