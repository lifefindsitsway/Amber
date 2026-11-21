import { expect, test, type Page } from "@playwright/test";
import { providerListDtoSchema, providerProfileDtoSchema, type ProviderProfileDto } from "../../src/shared/dto/provider.ts";
import { installMockBackend, providerProfile } from "./mock-backend.ts";

const UNKNOWN_FLAGS = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" } as const;

/**
 * The LLM profile routes, answered in memory on top of the shared mock backend (a later route
 * wins in Playwright): creating keeps the profile and only reports whether a key came with it.
 */
async function installProviderRoutes(page: Page) {
  const items: ProviderProfileDto[] = [providerProfile(128000)];
  const requests: Array<{ method: string; path: string; body: unknown; idempotencyKey: string | undefined }> = [];
  await page.route(/\/api\/providers(\/|$|\?)/u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body: unknown = method === "GET" ? undefined : request.postDataJSON();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (method !== "GET") requests.push({ method, path, body, idempotencyKey: request.headers()["idempotency-key"] });
    if (method === "GET" && path === "/api/providers") return json(providerListDtoSchema.parse({ items }));
    if (method === "POST" && path === "/api/providers") {
      const input = body as { name: string; protocol: string; baseURL: string; presetId?: string; models: Array<{ modelId: string }>; credential?: unknown };
      const created = providerProfileDtoSchema.parse({
        id: "01J0000000000000000000PRF2",
        name: input.name,
        protocol: input.protocol,
        baseURL: input.baseURL,
        ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
        models: input.models.map((model) => ({ modelId: model.modelId, flags: { declared: UNKNOWN_FLAGS }, limits: { declared: {} }, effective: { flags: UNKNOWN_FLAGS, limits: {} } })),
        createdAt: 1_790_000_000_000,
        credentialStatus: input.credential === undefined ? "missing" : "configured",
        hasCredential: input.credential !== undefined,
      });
      items.push(created);
      return json(created, 201);
    }
    const override = /^\/api\/providers\/([^/]+)\/models\/([^/]+)\/override$/u.exec(path);
    if (method === "PUT" && override !== null) {
      const limits = (body as { limits: { contextWindowTokens: number | null } }).limits;
      const index = items.findIndex((item) => item.id === override[1]);
      const profile = items[index] as ProviderProfileDto;
      const window = limits.contextWindowTokens === null ? {} : { contextWindowTokens: limits.contextWindowTokens };
      items[index] = providerProfileDtoSchema.parse({
        ...profile,
        models: profile.models.map((model) =>
          model.modelId === decodeURIComponent(override[2] ?? "") ? { ...model, limits: { declared: {}, userOverride: window }, effective: { ...model.effective, limits: window } } : model,
        ),
      });
      return json(items[index]);
    }
    if (method === "POST" && path.endsWith("/probe")) {
      return json({
        modelId: (body as { modelId: string }).modelId,
        basic: { status: "connected", latencyMs: 640 },
        checks: [
          { flag: "stream", result: "supported" },
          { flag: "structuredOutput", result: "unsupported" },
          { flag: "tools", result: "inconclusive", reason: "truncated" },
        ],
        observed: { stream: "supported", structuredOutput: "unsupported" },
        observedAt: 1_790_000_000_000,
      });
    }
    return route.fallback();
  });
  return { requests };
}

test("model prices: set on an AI model and a transcription model, shown as one line marked as the user's own", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/settings/models");
  const llm = page.locator('[data-model="mock-model"]');
  await expect(llm.getByTestId("model-pricing-summary")).toHaveText("未设置价格");
  await llm.getByRole("button", { name: "价格 · mock-model" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("单价 1").fill("0.8");
  await dialog.getByRole("button", { name: "添加计费项" }).click();
  await dialog.getByLabel("单价 2").fill("2.7");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  await expect(llm.getByTestId("model-pricing-summary")).toHaveText("0.8 元 / 百万输入 tokens · 2.7 元 / 百万输出 tokens");

  await page.goto("/settings/transcription");
  const fun = page.locator('[data-testid="asr-profile-model"][data-model="fun-asr"]');
  await fun.getByRole("button", { name: "价格 · fun-asr" }).click();
  await dialog.getByLabel("计费单位 1").selectOption("audio_per_second");
  await dialog.getByLabel("单价 1").fill("0.00022");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(fun.getByTestId("model-pricing-summary")).toHaveText("0.00022 元 / 秒");
  // Reading the page again keeps the price.
  await page.reload();
  await expect(fun.getByTestId("model-pricing-summary")).toHaveText("0.00022 元 / 秒");
  expect(backend.mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toEqual([
    "PUT /api/providers/01J0000000000000000000PRF1/model-pricing",
    "PUT /api/asr-profiles/01J0000000000000000000ASR1/model-pricing",
  ]);
});

test("AI models: a service fills in its official address, the key goes along on create, and the card asks for the context window", async ({ page }) => {
  await installMockBackend(page);
  const { requests } = await installProviderRoutes(page);
  await page.goto("/settings/models");
  await page.getByTestId("add-profile").click();
  const dialog = page.getByRole("dialog");
  const service = dialog.getByLabel("服务");
  await expect(service).toHaveText("未设置");
  await expect(dialog.getByText("选择服务后会自动填写连接地址")).toBeVisible();
  await expect(dialog.getByLabel("模型 ID")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();

  // Keyboard only: open, type ahead to Kimi, choose; focus stays on the service.
  await service.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option")).toHaveCount(9);
  await page.keyboard.press("k");
  await expect(page.getByRole("option", { name: "Kimi（月之暗面）" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(service).toHaveText("Kimi（月之暗面）");
  await expect(service).toBeFocused();
  await expect(dialog.getByTestId("connection-summary")).toHaveText("OpenAI 兼容 · api.moonshot.cn/v1 · 官方地址");
  await expect(dialog.getByLabel("名称")).toHaveValue("Kimi（月之暗面）");

  await dialog.getByLabel("地域").click();
  await page.getByRole("option", { name: "国际" }).click();
  await expect(dialog.getByTestId("connection-summary")).toHaveText("OpenAI 兼容 · api.moonshot.ai/v1 · 官方地址");
  await expect(dialog.getByTestId("address-changed")).toHaveText("已改为 Kimi（月之暗面） · 国际 官方地址 · 撤销");
  await dialog.getByRole("button", { name: "撤销" }).click();
  await expect(dialog.getByTestId("connection-summary")).toHaveText("OpenAI 兼容 · api.moonshot.cn/v1 · 官方地址");

  await dialog.getByLabel("API Key").fill("<placeholder-llm-key>");
  await dialog.getByLabel("模型 ID").fill("kimi-k2");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  const create = requests.find((request) => request.method === "POST" && request.path === "/api/providers");
  expect(create?.body).toEqual({
    name: "Kimi（月之暗面）",
    protocol: "openai_compatible",
    baseURL: "https://api.moonshot.cn/v1",
    presetId: "kimi",
    models: [{ modelId: "kimi-k2" }],
    credential: { value: "<placeholder-llm-key>" },
  });
  expect(create?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);

  const card = page.locator('[data-testid="profile-card"][data-profile="Kimi（月之暗面）"]');
  await expect(card.locator("h2 svg[data-vendor-icon='kimi']")).toHaveCount(1);
  await expect(card.getByTestId("profile-endpoint")).toContainText("中国");
  await expect(card.getByTestId("profile-credential-status")).toHaveText("已配置");
  const row = card.locator('[data-model="kimi-k2"]');
  await expect(row.getByTestId("model-limits")).toHaveText("上下文窗口 未填写 · 填写");
  await row.getByRole("button", { name: "填写 kimi-k2 的上下文窗口" }).click();
  await row.getByLabel("kimi-k2 的上下文窗口（tokens）").fill("256K");
  await row.getByRole("button", { name: "保存" }).click();
  await expect(row.getByTestId("model-limits")).toHaveText("上下文窗口 256,000（用户声明值，非实测）");
  expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ limits: { contextWindowTokens: 256000, maxOutputTokens: null } });

  await row.getByRole("button", { name: "测试连接" }).click();
  await expect(row.getByTestId("probe-connected")).toHaveText("连接成功 · 延迟 640 ms");
  await expect(row.getByTestId("probe-check-stream")).toHaveText("流式支持");
  await expect(row.getByTestId("probe-check-structuredOutput")).toHaveText("JSON不支持");
  await expect(row.getByTestId("probe-check-tools")).toHaveText("工具未能确认· 输出上限内没生成完");
});

test("AI models: Qwen in Tokyo needs a workspace id before it can be saved", async ({ page }) => {
  await installMockBackend(page);
  const { requests } = await installProviderRoutes(page);
  await page.goto("/settings/models");
  await page.getByTestId("add-profile").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("服务").click();
  await page.getByRole("option", { name: "Qwen（通义千问）" }).click();
  await dialog.getByLabel("地域").click();
  await page.getByRole("option", { name: "日本（东京）" }).click();
  await expect(dialog.getByTestId("workspace-required")).toHaveText("日本（东京）只提供专属域名，请填写工作空间 ID");
  await dialog.getByLabel("模型 ID").fill("qwen-plus");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("工作空间 ID（可选）").fill("WS1");
  // With no address the connection group opened, and it stays open once the address is back.
  await expect(dialog.getByLabel("Base URL")).toHaveValue("https://ws1.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  expect(requests.filter((request) => request.method === "POST").map((request) => (request.body as { baseURL: string }).baseURL)).toEqual([
    "https://ws1.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
  ]);
});

test("transcription models: a typed-in model is added with a family, then tested from its row", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/settings/transcription");
  await page.getByRole("button", { name: "编辑" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("添加模型");
  await input.fill("fun-asr-2026");
  await input.press("Enter");
  const family = dialog.getByLabel("参数兼容 · fun-asr-2026");
  await expect(family).toHaveValue("fun_asr");
  await family.selectOption("qwen_audio");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  expect(backend.mutations.at(-1)?.body).toEqual({
    models: [{ modelId: "qwen-audio-3.1-asr-flash-filetrans" }, { modelId: "fun-asr" }, { modelId: "fun-asr-2026", family: "qwen_audio" }],
  });

  const added = page.locator('[data-testid="asr-profile-model"][data-model="fun-asr-2026"]');
  await expect(added.getByText("千问 ASR（发送热词）")).toBeVisible();
  await expect(added.getByTestId("asr-model-tested")).toHaveText("未测试");
  await expect(page.getByTestId("asr-test-hint")).toHaveText("测试连接会发送 2 秒测试音频，可能产生少量费用。");
  await added.getByRole("button", { name: "测试连接 · fun-asr-2026" }).click();
  await expect(added.getByTestId("asr-model-test-result")).toHaveText("可用 · 延迟 1234 ms");
  await expect(added.getByTestId("asr-model-tested")).toHaveText(/^实测于 /);
  // The new model can be picked as the default.
  await page.getByRole("combobox", { name: "默认转录模型" }).click();
  await expect(page.getByRole("option", { name: "fun-asr-2026" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("other models: profiles are added, reordered and folded, and nothing there can be tested", async ({ page }) => {
  await installMockBackend(page);
  await page.goto("/settings/other-models");
  await expect(page.getByTestId("other-models-intro")).toContainText("Amber 目前没有功能会调用这些模型");
  for (const [name, modelId, kind] of [
    ["Voices", "tts-1", "tts"],
    ["Video", "veo", "video_generation"],
  ] as const) {
    await page.getByRole("button", { name: "添加 Profile" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("名称").fill(name);
    await dialog.getByLabel("模型 ID").fill(modelId);
    await dialog.getByLabel("类型").selectOption(kind);
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
  }
  const cards = page.getByTestId("other-model-profile-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1).getByText("视频生成")).toBeVisible();
  await expect(page.getByRole("button", { name: /测试连接/ })).toHaveCount(0);

  await page.getByRole("button", { name: "拖动调整「Video」的顺序" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(cards.first()).toHaveAttribute("data-profile", "Video");
  await page.reload();
  await expect(cards.first()).toHaveAttribute("data-profile", "Video");

  await cards.nth(1).getByRole("button", { name: "收起「Voices」" }).click();
  await expect(cards.nth(1).getByText("1 个模型")).toBeVisible();
  await page.reload();
  await expect(cards.nth(1).getByText("1 个模型")).toBeVisible();
  await expect(cards.nth(1).getByTestId("other-model")).toHaveCount(0);
});
