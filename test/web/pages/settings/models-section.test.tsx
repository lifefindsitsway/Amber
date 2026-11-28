import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_STATUS_REFRESH_MS } from "../../../../src/shared/defaults.ts";
import type { NetworkStatusDto } from "../../../../src/shared/dto/network.ts";
import { encodeModelKey } from "../../../../src/shared/dto/usage-analytics.ts";
import { ModelsSection } from "../../../../src/web/pages/settings/models-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { chooseOption, openSelect, selectGroups, selectOptionNames, stubSelectLayout } from "../../../fixtures/web/select.ts";
import { confirmTwoStep } from "../../../fixtures/web/two-step.ts";

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

const marks = (element: Element): Array<string | null> => [...element.querySelectorAll("svg[data-vendor-icon]")].map((icon) => icon.getAttribute("data-vendor-icon"));

beforeEach(stubSelectLayout);

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
    expect(screen.getByTestId("probe-check-tools").textContent).toBe("工具调用未能确认：被限流，稍后再试");
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
    confirmTwoStep(within(dialog).getByRole("button", { name: "清除价格" }));
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
    const select = await screen.findByRole("combobox", { name: "默认模型" });
    await chooseOption(select, "model-a");
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ defaultModelRef: { providerProfileId: "p1", modelId: "model-a" } }),
    );
  });

  it("lists the default model's choices by profile, model names only, and shows the mark with 「profile · model」 once chosen", async () => {
    const relay = { ...profile(true), presetId: "custom", models: [model("model-a"), model("gpt-6-sol")] };
    const deepseek = { ...profile(true), id: "p2", name: "DeepSeek", presetId: "deepseek", models: [model("deepseek-chat")] };
    let current: unknown = { ...SETTINGS, defaultModelRef: { providerProfileId: "p1", modelId: "gpt-6-sol" } };
    const api = mockApi({
      "GET /api/providers": { body: { items: [relay, deepseek] } },
      "GET /api/settings": () => ({ body: current }),
      "PATCH /api/settings": (call) => {
        const ref = (call.body as { defaultModelRef: unknown }).defaultModelRef;
        current = ref === null ? SETTINGS : { ...SETTINGS, defaultModelRef: ref };
        return { body: current };
      },
    });
    renderApp(<ModelsSection />);
    const select = await screen.findByRole("combobox", { name: "默认模型" });
    await waitFor(() => expect(select.textContent).toBe("Relay · gpt-6-sol"));
    expect(select.getAttribute("title")).toBe("Relay · gpt-6-sol");
    expect(marks(select)).toEqual(["openai"]);
    expect(select.id).toBe("default-model");
    expect(select.getAttribute("aria-describedby")).toBe("default-model-hint");
    expect(await selectGroups(select)).toEqual([
      { heading: "Relay", options: ["model-a", "gpt-6-sol"] },
      { heading: "DeepSeek", options: ["deepseek-chat"] },
    ]);
    expect(await selectOptionNames(select)).toEqual(["未设置", "model-a", "gpt-6-sol", "deepseek-chat"]);
    const listbox = await openSelect(select);
    // The model's own vendor first, else the profile's service, else neutral.
    expect(within(listbox).getAllByRole("option").map((option) => marks(option)[0] ?? null)).toEqual([null, "neutral", "openai", "deepseek"]);
    fireEvent.keyDown(listbox, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());

    // Unset, then back to the same model: the same reference as before.
    await chooseOption(select, "未设置");
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ defaultModelRef: null }));
    await waitFor(() => expect(select.textContent).toBe("未设置"));
    await chooseOption(select, "gpt-6-sol", "Relay");
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ defaultModelRef: { providerProfileId: "p1", modelId: "gpt-6-sol" } }));
    await waitFor(() => expect(select.textContent).toBe("Relay · gpt-6-sol"));
  });

  it.each([
    ["a model its profile no longer lists", { providerProfileId: "p1", modelId: "model-old" }, "Relay · model-old"],
    ["a deleted profile", { providerProfileId: "p9", modelId: "model-old" }, "model-old（配置已删除）"],
  ])("keeps showing a default that points at %s instead of another model", async (_case, defaultModelRef, shown) => {
    const api = mockApi({ "GET /api/providers": { body: { items: [profile(true)] } }, "GET /api/settings": { body: { ...SETTINGS, defaultModelRef } } });
    renderApp(<ModelsSection />);
    const select = await screen.findByRole("combobox", { name: "默认模型" });
    await waitFor(() => expect(select.textContent).toBe(shown));
    expect(await selectOptionNames(select)).toEqual(["未设置", shown, "model-a"]);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("puts a 14px mark before each model id: the model's vendor, else the profile's service", async () => {
    const relay = { ...profile(true), presetId: "deepseek", models: [model("claude-opus-5-5"), model("model-a")] };
    const plain = { ...profile(true), id: "p2", name: "Plain", models: [model("model-b")] };
    mockApi({ "GET /api/providers": { body: { items: [relay, plain] } }, "GET /api/settings": { body: SETTINGS } });
    renderApp(<ModelsSection />);
    await waitFor(() => expect(screen.getAllByTestId("profile-card")).toHaveLength(2));
    const row = (modelId: string) => document.querySelector(`li[data-model="${modelId}"]`) as HTMLElement;
    expect(["claude-opus-5-5", "model-a", "model-b"].map((modelId) => marks(row(modelId).firstElementChild as Element))).toEqual([["claude"], ["deepseek"], ["neutral"]]);
    const mark = row("model-a").querySelector("svg[data-vendor-icon]") as SVGElement;
    expect(mark.getAttribute("width")).toBe("14");
    // The mark sits beside the id, centred on its line, and the id alone is what gets cut short.
    expect(mark.parentElement?.className).toContain("items-center");
    expect(mark.nextElementSibling?.textContent).toBe("model-a");
    expect(mark.nextElementSibling?.className).toContain("truncate");
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

describe("ModelsSection network status line", () => {
  const PROXY = "127.0.0.1:7890";
  const NOW = Date.UTC(2026, 10, 28, 8, 0, 0);

  // A profile folded by an earlier test stays folded in this browser.
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "visibilityState");
  });

  async function lineFor(status: NetworkStatusDto, mode: "local" | "server" = "local"): Promise<HTMLElement> {
    mockApi({
      "GET /api/providers": { body: { items: [] } },
      "GET /api/network/status": { body: status },
    });
    renderApp(<ModelsSection />, { mode });
    return screen.findByTestId("network-status");
  }

  it.each<[string, NetworkStatusDto, string]>([
    ["the system proxy, one address for both protocols", { source: "system", state: "manual", proxy: { http: PROXY, https: PROXY } }, `网络：跟随 Windows 系统代理 · ${PROXY}`],
    [
      "the system proxy with a PAC script it ignores",
      { source: "system", state: "manual", proxy: { http: PROXY, https: PROXY }, pacIgnored: true },
      `网络：跟随 Windows 系统代理 · ${PROXY}（已忽略自动配置脚本）`,
    ],
    ["the system proxy for HTTP only", { source: "system", state: "manual", proxy: { http: PROXY } }, `网络：跟随 Windows 系统代理（仅 HTTP）· ${PROXY}`],
    ["the system proxy for HTTPS only", { source: "system", state: "manual", proxy: { https: PROXY } }, `网络：跟随 Windows 系统代理（仅 HTTPS）· ${PROXY}`],
    [
      "different addresses per protocol",
      { source: "system", state: "manual", proxy: { http: PROXY, https: "127.0.0.1:7891" } },
      `网络：跟随 Windows 系统代理 · HTTP ${PROXY}，HTTPS 127.0.0.1:7891`,
    ],
    ["no system proxy", { source: "system", state: "off" }, "网络：直连（Windows 系统代理未开启）"],
  ])("states %s in a quiet line", async (_name, status, text) => {
    const line = await lineFor(status);
    expect(line.textContent).toBe(text);
    expect(line.dataset["tone"]).toBe("plain");
    expect(line.className).toContain("text-muted");
    expect(line.getAttribute("role")).toBe("status");
  });

  it.each<[string, NetworkStatusDto, string]>([
    ["only a PAC script", { source: "system", state: "unsupported", reason: "pac" }, "网络：系统代理使用了自动配置脚本（PAC），Amber 暂不支持。请在代理软件中改用非 PAC 的系统代理模式"],
    ["only SOCKS", { source: "system", state: "unsupported", reason: "socks" }, "网络：系统代理只设置了 SOCKS，Amber 暂不支持。请在代理软件中开启 HTTP 系统代理"],
    ["a proxy address that is not http://", { source: "env", state: "unsupported", reason: "scheme" }, "网络：代理地址不是 http:// 开头，Amber 暂不支持"],
    ["settings it cannot make out", { source: "system", state: "unsupported", reason: "unparsable" }, "网络：无法识别系统代理的设置，Amber 不会改为直连"],
    ["settings it could not read", { source: "system", state: "error", reason: "read_failed" }, "网络：暂时无法读取系统代理设置，沿用上次的设置"],
  ])("warns about %s", async (_name, status, text) => {
    const line = await lineFor(status);
    expect(line.textContent).toBe(text);
    expect(line.dataset["tone"]).toBe("warn");
    expect(line.className).toContain("text-warn");
  });

  it("says when the last request through the system proxy failed, as a relative time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const line = await lineFor({ source: "system", state: "manual", proxy: { http: PROXY, https: PROXY }, lastProxyOutcome: { ok: false, at: NOW - 150_000, seq: 3 } });
    expect(line.textContent).toBe("网络：最近一次连接系统代理失败（2 分钟前），请确认代理软件正在运行");
    expect(line.dataset["tone"]).toBe("danger");
    expect(line.className).toContain("text-danger");
  });

  it("goes back to the configuration once a request through the proxy succeeded", async () => {
    const line = await lineFor({ source: "system", state: "manual", proxy: { http: PROXY, https: PROXY }, lastProxyOutcome: { ok: true, at: 1, seq: 3 } });
    expect(line.textContent).toBe(`网络：跟随 Windows 系统代理 · ${PROXY}`);
  });

  it("in server mode only says whether a proxy is used, never its address", async () => {
    expect((await lineFor({ source: "env", state: "manual", proxy: { http: PROXY } }, "server")).textContent).toBe("网络：经代理");
  });

  it("in server mode says it goes direct without a proxy", async () => {
    expect((await lineFor({ source: "env", state: "off" }, "server")).textContent).toBe("网络：直连");
  });

  it("in server mode words a failed proxy without the system proxy", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const line = await lineFor({ source: "env", state: "manual", lastProxyOutcome: { ok: false, at: NOW - 3 * 3_600_000, seq: 1 } }, "server");
    expect(line.textContent).toBe("网络：最近一次连接代理失败（3 小时前）");
    expect(line.dataset["tone"]).toBe("danger");
  });

  it("shows nothing when the status cannot be read", async () => {
    mockApi({ "GET /api/providers": { body: { items: [] } } });
    renderApp(<ModelsSection />);
    await screen.findByTestId("add-first-profile");
    expect(screen.queryByTestId("network-status")).toBeNull();
  });

  it("re-reads the status while the page is visible, stops while it is hidden and reads it again on return", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const api = mockApi({
      "GET /api/providers": { body: { items: [] } },
      "GET /api/network/status": { body: { source: "system", state: "off" } },
    });
    renderApp(<ModelsSection />);
    const reads = (): number => api.calls.filter((call) => call.path === "/api/network/status").length;
    await vi.waitFor(() => expect(reads()).toBe(1));
    await act(() => vi.advanceTimersByTimeAsync(NETWORK_STATUS_REFRESH_MS));
    expect(reads()).toBe(2);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(() => vi.advanceTimersByTimeAsync(NETWORK_STATUS_REFRESH_MS * 3));
    expect(reads()).toBe(2);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await vi.waitFor(() => expect(reads()).toBe(3));
    await act(() => vi.advanceTimersByTimeAsync(NETWORK_STATUS_REFRESH_MS));
    expect(reads()).toBe(4);
  });

  function probing(route: "direct" | "proxy" | undefined) {
    return {
      modelId: "model-a",
      basic: { status: "connected", latencyMs: 300 },
      checks: [],
      observed: {},
      observedAt: 2,
      ...(route === undefined ? {} : { route }),
    };
  }

  it.each<[string, "local" | "server", NetworkStatusDto, "direct" | "proxy" | undefined, string]>([
    ["through the system proxy in the desktop client", "local", { source: "system", state: "manual", proxy: { http: PROXY, https: PROXY } }, "proxy", "经系统代理"],
    ["direct in the desktop client", "local", { source: "system", state: "manual", proxy: { http: PROXY, https: PROXY } }, "direct", "直连"],
    ["direct when the result names no route", "local", { source: "system", state: "off" }, undefined, "直连"],
    ["through the proxy in server mode", "server", { source: "env", state: "manual" }, "proxy", "经代理"],
    ["direct in server mode", "server", { source: "env", state: "manual" }, "direct", "直连"],
  ])("tags a connection test that went %s", async (_name, mode, status, route, tag) => {
    mockApi({
      "GET /api/providers": { body: { items: [profile(true)] } },
      "GET /api/settings": { body: SETTINGS },
      "GET /api/network/status": { body: status },
      "POST /api/providers/p1/probe": { body: probing(route) },
    });
    renderApp(<ModelsSection />, { mode });
    await screen.findByTestId("network-status");
    fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
    const label = await screen.findByTestId("probe-route");
    expect(label.textContent).toBe(tag);
    expect(label.className).toContain("text-muted");
    expect(within(screen.getByTestId("probe-live")).getByTestId("probe-connected").textContent).toBe("连接成功 · 延迟 300 ms");
  });
});
