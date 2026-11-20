import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { encodeModelKey } from "../../../../src/shared/dto/usage-analytics.ts";
import { ModelsSection } from "../../../../src/web/pages/settings/models-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const FLAGS = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };

function model(modelId: string) {
  return {
    modelId,
    flags: { declared: FLAGS },
    limits: { declared: {}, userOverride: { contextWindowTokens: 128000 } },
    effective: { flags: FLAGS, limits: { contextWindowTokens: 128000 } },
  };
}

function profile(hasCredential: boolean) {
  return {
    id: "p1",
    name: "Relay",
    protocol: "openai_compatible",
    baseURL: "https://llm.example.com/v1",
    createdAt: 1,
    credentialStatus: hasCredential ? "configured" : "missing",
    hasCredential,
    models: [
      {
        modelId: "model-a",
        flags: { declared: FLAGS },
        limits: { declared: {}, userOverride: { contextWindowTokens: 128000 } },
        effective: { flags: FLAGS, limits: { contextWindowTokens: 128000 } },
      },
    ],
  };
}

const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 };

describe("ModelsSection", () => {
  it("shows the first-run wizard when there is no profile", async () => {
    mockApi({ "GET /api/providers": { body: { items: [] } } });
    renderApp(<ModelsSection />);
    expect(await screen.findByText("先配置一个 AI 模型")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加 Profile" })).toBeTruthy();
  });

  it("writes the key once, clears the field and only shows the credential status", async () => {
    const secret = "<placeholder-llm-key>";
    const api = mockApi({
      "GET /api/providers": { body: { items: [profile(false)] } },
      "GET /api/settings": { body: SETTINGS },
      "PUT /api/providers/p1/credential": { body: profile(true) },
    });
    const { container } = renderApp(<ModelsSection />);
    const input = (await screen.findByPlaceholderText("粘贴新的 Key，保存后不再显示")) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: secret } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0] as HTMLElement);
    await waitFor(() => expect(api.calls.some((call) => call.method === "PUT")).toBe(true));
    const put = api.calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe("/api/providers/p1/credential");
    expect(put?.body).toEqual({ value: secret });
    await waitFor(() => expect(container.innerHTML).not.toContain(secret));
    expect(screen.queryByPlaceholderText("粘贴新的 Key，保存后不再显示")).toBeNull();
  });

  it("runs the connection test on click with a fresh Idempotency-Key and shows the verdict and the three capability badges", async () => {
    const api = mockApi({
      "GET /api/providers": { body: { items: [profile(true)] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/providers/p1/probe": {
        body: {
          modelId: "model-a",
          basic: { status: "connected", latencyMs: 812 },
          checks: [
            { flag: "stream", result: "supported" },
            { flag: "structuredOutput", result: "supported" },
            { flag: "tools", result: "inconclusive", reason: "rate_limited" },
          ],
          observed: { stream: "supported", structuredOutput: "supported" },
          observedAt: 2,
        },
      },
    });
    renderApp(<ModelsSection />);
    // The live region is there before any result, so the first verdict is announced too.
    const live = await screen.findByTestId("probe-live");
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({ modelId: "model-a" }));
    expect(api.calls.find((call) => call.method === "POST")?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect((await screen.findByTestId("probe-connected")).textContent).toBe("连接成功 · 延迟 812 ms");
    expect(screen.getByTestId("probe-live")).toBe(live);
    expect(screen.getByTestId("probe-check-tools").textContent).toBe("工具未能确认· 被限流，稍后再试");
  });

  it("words a rate-limited connection test as advice to test again, not as a pipeline retry", async () => {
    mockApi({
      "GET /api/providers": { body: { items: [profile(true)] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/providers/p1/probe": {
        status: 429,
        body: {
          error: {
            class: "llm_rate_limited",
            code: "llm_rate_limited.retry_after",
            retryDisposition: "policy",
            userMessage: "已按服务端要求等待并自动重试仍未成功；可稍后从这步重跑",
            details: { retryAfterMs: 59000 },
          },
        },
      },
    });
    renderApp(<ModelsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
    const result = await screen.findByTestId("probe-unconfirmed");
    expect(result.textContent).toBe("无法确认：被限流，请约 59 秒后再测试");
    expect(screen.getByTestId("probe-result").textContent).not.toContain("重跑");
  });

  it("adds the region hint to a rejected key only for a service with several regions", async () => {
    const auth = {
      status: 401,
      body: { error: { class: "llm_failed", code: "llm_failed.auth", retryDisposition: "never", userMessage: "AI 模型的 API Key 无效或无权访问，请检查配置", upstreamMessage: "Invalid Authentication" } },
    };
    const qwen = { ...profile(true), presetId: "qwen", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" };
    mockApi({ "GET /api/providers": { body: { items: [qwen] } }, "GET /api/settings": { body: SETTINGS }, "POST /api/providers/p1/probe": auth });
    renderApp(<ModelsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
    expect((await screen.findByTestId("probe-unavailable")).textContent).toBe("模型不可用：API Key 无效，或没有该模型的使用权限");
    expect(screen.getByTestId("probe-region-hint").textContent).toBe("也可能是 Key 与所选地域不一致");
    expect(screen.getByTestId("probe-result").textContent).not.toContain("Invalid Authentication");
  });

  it("shows the conflict's wording when the configuration changed during the test", async () => {
    mockApi({
      "GET /api/providers": { body: { items: [profile(true)] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/providers/p1/probe": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.probe_config_changed", retryDisposition: "never", userMessage: "测试期间配置已更改，请重新测试" } },
      },
    });
    renderApp(<ModelsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
    expect((await screen.findByTestId("probe-conflict")).textContent).toBe("测试期间配置已更改，请重新测试");
  });

  it("puts the vendor mark before the name and says where the profile points", async () => {
    const kimi = { ...profile(true), id: "p2", name: "Kimi", presetId: "kimi", baseURL: "https://api.moonshot.ai/v1/" };
    const relay = { ...profile(true), id: "p3", name: "Relay", presetId: "openai", baseURL: "https://relay.example.com/v1" };
    const plain = { ...profile(true), id: "p4", name: "Plain" };
    mockApi({ "GET /api/providers": { body: { items: [kimi, relay, plain] } }, "GET /api/settings": { body: SETTINGS } });
    renderApp(<ModelsSection />);
    await waitFor(() => expect(screen.getAllByTestId("profile-card")).toHaveLength(3));
    const [kimiCard, relayCard, plainCard] = screen.getAllByTestId("profile-card") as [HTMLElement, HTMLElement, HTMLElement];
    const mark = (card: HTMLElement) => card.querySelector("h2 svg[data-vendor-icon]")?.getAttribute("data-vendor-icon");
    expect([mark(kimiCard), mark(relayCard), mark(plainCard)]).toEqual(["kimi", "openai", "neutral"]);
    expect(within(kimiCard).getByTestId("profile-endpoint").textContent).toBe("OpenAI 兼容·api.moonshot.ai/v1·国际");
    expect(within(kimiCard).queryByTestId("profile-custom-address")).toBeNull();
    expect(within(relayCard).getByTestId("profile-custom-address").textContent).toBe("自定义地址");
    expect(within(plainCard).queryByTestId("profile-custom-address")).toBeNull();
  });

  it.each([
    ["missing", "待配置"],
    ["configured", "已配置"],
    ["unavailable", "凭据不可用"],
  ] as const)("words a %s key as 「%s」", async (status, text) => {
    mockApi({ "GET /api/providers": { body: { items: [{ ...profile(status !== "missing"), credentialStatus: status }] } }, "GET /api/settings": { body: SETTINGS } });
    renderApp(<ModelsSection />);
    expect((await screen.findByTestId("profile-credential-status")).textContent).toBe(text);
  });

  it("fills in a missing context window on the card through the model's override", async () => {
    const bare = { ...profile(true), models: [{ ...model("model-a"), limits: { declared: {}, userOverride: { maxOutputTokens: 4096 } }, effective: { flags: FLAGS, limits: { maxOutputTokens: 4096 } } }] };
    const api = mockApi({
      "GET /api/providers": { body: { items: [bare] } },
      "GET /api/settings": { body: SETTINGS },
      "PUT /api/providers/p1/models/model-a/override": { body: profile(true) },
    });
    renderApp(<ModelsSection />);
    const limits = await screen.findByTestId("model-limits");
    expect(limits.textContent).toBe("上下文窗口 未填写 · 填写 · 最大输出 4,096");
    fireEvent.click(screen.getByRole("button", { name: "填写 model-a 的上下文窗口" }));
    const input = screen.getByLabelText("model-a 的上下文窗口（tokens）");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "200K" } });
    fireEvent.click(within(screen.getByTestId("model-limits-form")).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ limits: { contextWindowTokens: 200_000, maxOutputTokens: 4096 } }),
    );
  });

  it("shows a filled-in context window as a number", async () => {
    mockApi({ "GET /api/providers": { body: { items: [profile(true)] } }, "GET /api/settings": { body: SETTINGS } });
    renderApp(<ModelsSection />);
    expect((await screen.findByTestId("model-limits")).textContent).toBe("上下文窗口 128,000（用户声明值，非实测）");
  });

  it("shows a model's price and edits it with the units of AI models", async () => {
    const priced = { ...profile(true), models: [{ ...model("model-a"), pricing: { currency: "USD", items: [{ unit: "input_tokens_per_million", amount: "0.27" }], note: "cache hits cheaper" } }] };
    const api = mockApi({
      "GET /api/providers": { body: { items: [priced] } },
      "GET /api/settings": { body: SETTINGS },
      "PUT /api/providers/p1/model-pricing": { body: priced },
    });
    renderApp(<ModelsSection />);
    expect((await screen.findByTestId("model-pricing-summary")).textContent).toBe("0.27 美元 / 百万输入 tokens（cache hits cheaper）");
    fireEvent.click(screen.getByRole("button", { name: "价格 · model-a" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("币种") as HTMLSelectElement).value).toBe("USD");
    expect([...(within(dialog).getByLabelText("计费单位 1") as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      "input_tokens_per_million",
      "output_tokens_per_million",
      "cached_input_tokens_per_million",
      "cache_write_tokens_per_million",
      "cache_write_1h_tokens_per_million",
      "per_request",
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "清除价格" }));
    await waitFor(() => expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ modelId: "model-a", pricing: null }));
  });

  it("marks a model whose calls reported cache hits while its price has no cache-read unit, and says so in the price dialog", async () => {
    const priced = { ...profile(true), models: [{ ...model("model-a"), pricing: { currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "9" }] } }] };
    mockApi({
      "GET /api/providers": { body: { items: [priced] } },
      "GET /api/settings": { body: SETTINGS },
      "GET /api/usage/cache-observed": { body: { models: [{ modelKey: encodeModelKey(["llm", "p1", "model-a"]) }] } },
    });
    renderApp(<ModelsSection />);
    const marker = await screen.findByTestId("pricing-cache-marker");
    expect(marker.textContent).toBe("缓存读取未定价");
    fireEvent.click(screen.getByRole("button", { name: "价格 · model-a" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("pricing-cache-hint").textContent).toBe("该模型的调用出现过缓存命中，未填缓存读取单价时这些请求不计入估算费用");
  });

  it("shows no cache hint for a model that has no cache hits, or whose price already has a cache-read unit", async () => {
    const withCache = { ...profile(true), models: [{ ...model("model-a"), pricing: { currency: "CNY", items: [{ unit: "cached_input_tokens_per_million", amount: "0.9" }] } }] };
    mockApi({
      "GET /api/providers": { body: { items: [withCache] } },
      "GET /api/settings": { body: SETTINGS },
      "GET /api/usage/cache-observed": { body: { models: [{ modelKey: encodeModelKey(["llm", "p1", "model-a"]) }, { modelKey: encodeModelKey(["llm", "other", "model-a"]) }] } },
    });
    renderApp(<ModelsSection />);
    await screen.findByTestId("model-pricing-summary");
    expect(screen.queryByTestId("pricing-cache-marker")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "价格 · model-a" }));
    expect(within(await screen.findByRole("dialog")).queryByTestId("pricing-cache-hint")).toBeNull();
  });

  it("sets the default model through PATCH /api/settings", async () => {
    const api = mockApi({
      "GET /api/providers": { body: { items: [profile(true)] } },
      "GET /api/settings": { body: SETTINGS },
      "PATCH /api/settings": { body: { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "model-a" } } },
    });
    renderApp(<ModelsSection />);
    const select = (await screen.findByLabelText("默认模型")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: JSON.stringify(["p1", "model-a"]) } });
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ defaultModelRef: { providerProfileId: "p1", modelId: "model-a" } }),
    );
  });

  it("explains the default model below its select, without a second label, and puts the add button right below", async () => {
    mockApi({ "GET /api/providers": { body: { items: [profile(true)] } }, "GET /api/settings": { body: SETTINGS } });
    renderApp(<ModelsSection />);
    const select = await screen.findByLabelText("默认模型");
    const hint = screen.getByTestId("default-model-hint");
    expect(hint.textContent).toContain("AI 对话");
    expect(select.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 「默认模型」 appears once, as the block heading.
    expect(screen.getAllByText("默认模型")).toHaveLength(1);
    const add = screen.getByTestId("add-profile");
    expect(hint.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add.compareDocumentPosition(screen.getByTestId("profile-list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the key status beside its label and gives 「手动覆盖」 the same bordered look as the connection test", async () => {
    mockApi({ "GET /api/providers": { body: { items: [profile(true)] } }, "GET /api/settings": { body: SETTINGS } });
    renderApp(<ModelsSection />);
    const status = await screen.findByTestId("profile-credential-status");
    expect(status.textContent).toBe("已配置");
    expect(status.parentElement?.querySelector("label")?.textContent).toBe("API Key");
    const test = screen.getByRole("button", { name: "测试连接" });
    const override = screen.getByRole("button", { name: "手动覆盖" });
    expect(override.className).toContain("border");
    expect(override.className).toBe(test.className);
  });

  it("saves a new profile order when one is moved, and folds a profile to its heading for good", async () => {
    const second = { ...profile(true), id: "p2", name: "DeepSeek", models: [model("deepseek-flash")] };
    const api = mockApi({
      "GET /api/providers": { body: { items: [profile(true), second] } },
      "GET /api/settings": { body: SETTINGS },
      "PUT /api/providers/order": { body: { items: [second, profile(true)] } },
    });
    localStorage.removeItem("amber.settings.collapsedProfiles");
    renderApp(<ModelsSection />);
    const names = () => screen.getAllByTestId("profile-card").map((card) => card.dataset["profile"]);
    await waitFor(() => expect(names()).toEqual(["Relay", "DeepSeek"]));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动调整「DeepSeek」的顺序" }), { key: "ArrowUp" });
    await waitFor(() => expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ profileIds: ["p2", "p1"] }));
    await waitFor(() => expect(names()).toEqual(["DeepSeek", "Relay"]));

    const relay = screen.getAllByTestId("profile-card")[1] as HTMLElement;
    fireEvent.click(within(relay).getByRole("button", { name: "收起「Relay」" }));
    expect(within(relay).queryByText("API Key")).toBeNull();
    expect(within(relay).getByText("1 个模型")).toBeTruthy();
    expect(localStorage.getItem("amber.settings.collapsedProfiles")).toBe(JSON.stringify(["p1"]));
  });

  it("reorders models in the edit dialog and saves them in that order", async () => {
    const many = { ...profile(true), models: [model("model-a"), model("model-b"), model("model-c")] };
    const api = mockApi({
      "GET /api/providers": { body: { items: [many] } },
      "GET /api/settings": { body: SETTINGS },
      "PATCH /api/providers/p1": { body: many },
    });
    renderApp(<ModelsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "拖动调整模型顺序 · model-c" }), { key: "ArrowUp" });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "拖动调整模型顺序 · model-c" }), { key: "ArrowUp" });
    const ids = () => within(dialog).getAllByLabelText(/^模型 ID（第/u).map((input) => (input as HTMLInputElement).value);
    expect(ids()).toEqual(["model-c", "model-a", "model-b"]);
    // Nothing is saved until the dialog is.
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ models: [{ modelId: "model-c" }, { modelId: "model-a" }, { modelId: "model-b" }] }));
  });
});
