import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionSection } from "../../../../src/web/pages/settings/transcription-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 };
const QWEN = "qwen-audio-3.1-asr-flash-filetrans";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    name: "ElevenLabs",
    provider: "elevenlabs",
    models: [{ modelId: "scribe_v2", family: "scribe_v2", available: true }],
    credentialStatus: "configured",
    hasCredential: true,
    inUse: false,
    createdAt: 1,
    ...overrides,
  };
}

const BAILIAN = profile({
  id: "a2",
  name: "阿里云百炼",
  provider: "dashscope",
  models: [
    { modelId: QWEN, family: "qwen_audio", available: true },
    { modelId: "fun-asr", family: "fun_asr", available: true },
  ],
  baseURL: "https://dashscope.aliyuncs.com",
  createdAt: 2,
});

const key = (asrProfileId: string, modelId: string) => JSON.stringify([asrProfileId, modelId]);
const suggestions = (dialog: HTMLElement) => [...within(dialog).getByTestId("asr-model-suggestions").querySelectorAll("option")].map((option) => option.value);
const CONFLICT = { status: 409, body: { error: { class: "conflict", code: "conflict", retryDisposition: "never", userMessage: "" } } };

describe("TranscriptionSection", () => {
  // Folding is remembered per browser; every case starts unfolded.
  beforeEach(() => localStorage.removeItem("amber.settings.collapsedAsrProfiles"));

  it("offers to add a first profile when there is none", async () => {
    mockApi({ "GET /api/asr-profiles": { body: { items: [] } } });
    renderApp(<TranscriptionSection />);
    expect(await screen.findByText("还没有转录模型")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加 Profile" })).toBeTruthy();
  });

  it("lists every model of every profile as a default, unset until the user picks one, and saves the pick", async () => {
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [profile(), BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "PATCH /api/settings": { body: { ...SETTINGS, defaultAsrModelRef: { asrProfileId: "a2", modelId: "fun-asr" } } },
    });
    renderApp(<TranscriptionSection />);
    const select = (await screen.findByLabelText("默认转录模型")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(""));
    expect([...select.options].map((option) => option.textContent)).toEqual(["未设置", "ElevenLabs · scribe_v2", `阿里云百炼 · ${QWEN}`, "阿里云百炼 · fun-asr"]);
    fireEvent.change(select, { target: { value: key("a2", "fun-asr") } });
    await waitFor(() => expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ defaultAsrModelRef: { asrProfileId: "a2", modelId: "fun-asr" } }));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ defaultAsrModelRef: null }));
  });

  it("shows a profile's models in order with their family, and marks one its service no longer offers", async () => {
    mockApi({
      "GET /api/asr-profiles": { body: { items: [profile({ models: [{ modelId: "scribe_v2", family: "scribe_v2", available: true }, { modelId: "scribe_v1", available: false }] })] } },
      "GET /api/settings": { body: SETTINGS },
    });
    renderApp(<TranscriptionSection />);
    const models = await screen.findByTestId("asr-profile-models");
    expect(within(models).getAllByTestId("asr-model-id").map((item) => item.textContent)).toEqual(["scribe_v2", "scribe_v1"]);
    const [first, second] = within(models).getAllByTestId("asr-profile-model") as [HTMLElement, HTMLElement];
    expect(within(first).getByText("Scribe v2")).toBeTruthy();
    expect(within(first).queryByText("已不可用")).toBeNull();
    expect(within(second).getByText("已不可用")).toBeTruthy();
    // An unavailable model cannot be tested.
    expect((within(second).getByRole("button", { name: "测试连接 · scribe_v1" }) as HTMLButtonElement).disabled).toBe(true);
    // An unavailable model cannot become the default.
    const select = screen.getByLabelText("默认转录模型") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["未设置", "ElevenLabs · scribe_v2"]);
  });

  it("adds a Bailian profile with its recommended models and the Beijing region only, then stores the key", async () => {
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [profile()] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/asr-profiles": { status: 201, body: { ...BAILIAN, credentialStatus: "missing", hasCredential: false } },
      "PUT /api/asr-profiles/a2/credential": { body: BAILIAN },
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "添加 Profile" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "添加 Profile" })).toBeTruthy();
    expect((within(dialog).getByLabelText("服务") as HTMLSelectElement).value).toBe("dashscope");
    const drafts = () => within(dialog).getAllByTestId("asr-model-draft").map((row) => row.querySelector(".font-mono")?.textContent);
    expect(drafts()).toEqual([QWEN, "fun-asr"]);
    // Known models bring their own family, shown as fixed text.
    expect(within(dialog).getAllByTestId("asr-model-draft-family").map((item) => item.textContent)).toEqual(["千问 ASR（发送热词）", "Fun-ASR（不发送热词）"]);
    // Every suggested model is already in: nothing left to suggest.
    expect(suggestions(dialog)).toEqual([]);
    const region = within(dialog).getByLabelText("地域") as HTMLSelectElement;
    expect([...region.options].map((option) => option.textContent)).toEqual(["华北 2（北京）"]);
    fireEvent.change(within(dialog).getByLabelText("API Key"), { target: { value: "<placeholder-asr-key>" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "PUT")).toBe(true));
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      name: "阿里云百炼",
      provider: "dashscope",
      models: [{ modelId: QWEN }, { modelId: "fun-asr" }],
      baseURL: "https://dashscope.aliyuncs.com",
    });
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ value: "<placeholder-asr-key>" });
    // Adding a profile never sets a default.
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("starts an ElevenLabs profile with Scribe v2, suggests the models not yet added, and takes any typed-in model with a family", async () => {
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/asr-profiles": { status: 201, body: profile() },
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "添加 Profile" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("服务"), { target: { value: "elevenlabs" } });
    expect(suggestions(dialog)).toEqual(["scribe_v2_medical"]);
    const input = within(dialog).getByLabelText("添加模型") as HTMLInputElement;
    const add = within(dialog).getByRole("button", { name: "添加" });

    // A known model takes its own family, shown as text without a choice.
    fireEvent.change(input, { target: { value: "scribe_v2_medical" } });
    fireEvent.click(add);
    expect(input.value).toBe("");
    expect(suggestions(dialog)).toEqual([]);
    expect(within(dialog).queryByLabelText("参数兼容 · scribe_v2_medical")).toBeNull();
    expect(within(dialog).getAllByTestId("asr-model-draft-family").map((item) => item.textContent)).toEqual(["Scribe v2", "Scribe（通用）"]);

    // Malformed and repeated ids are refused.
    fireEvent.change(input, { target: { value: "-bad id" } });
    fireEvent.click(add);
    expect(within(dialog).getByRole("alert").textContent).toContain("模型 ID 只能包含");
    fireEvent.change(input, { target: { value: "scribe_v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(dialog).getByRole("alert").textContent).toBe("已添加这个模型");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);

    // Any other id is added with a family, starting at the one sending the fewest parameters.
    fireEvent.change(input, { target: { value: "scribe_v3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const family = within(dialog).getByLabelText("参数兼容 · scribe_v3") as HTMLSelectElement;
    expect(family.value).toBe("scribe");
    expect([...family.options].map((option) => option.textContent)).toEqual(["Scribe（通用）", "Scribe v2"]);
    expect(within(dialog).getByText(/决定是否发送热词与语言提示/)).toBeTruthy();
    fireEvent.change(family, { target: { value: "scribe_v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        name: "ElevenLabs",
        provider: "elevenlabs",
        models: [{ modelId: "scribe_v2" }, { modelId: "scribe_v2_medical" }, { modelId: "scribe_v3", family: "scribe_v2" }],
      }),
    );
  });

  it("shows a saved model's family as fixed text in the edit dialog", async () => {
    mockApi({
      "GET /api/asr-profiles": { body: { items: [profile({ models: [{ modelId: "scribe_v2", family: "scribe_v2", available: true }, { modelId: "my-scribe", family: "scribe", available: true }] })] } },
      "GET /api/settings": { body: SETTINGS },
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("参数兼容 · my-scribe")).toBeNull();
    expect(within(dialog).getAllByTestId("asr-model-draft-family").map((item) => item.textContent)).toEqual(["Scribe v2", "Scribe（通用）"]);
  });

  it("reorders and removes models in the edit dialog, keeps at least one, and saves them in that order", async () => {
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "PATCH /api/asr-profiles/a2": { body: BAILIAN },
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "编辑 Profile" })).toBeTruthy();
    const drafts = () => within(dialog).getAllByTestId("asr-model-draft").map((row) => row.querySelector(".font-mono")?.textContent);
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "拖动调整模型顺序 · fun-asr" }), { key: "ArrowUp" });
    await waitFor(() => expect(drafts()).toEqual(["fun-asr", QWEN]));
    fireEvent.click(within(dialog).getByRole("button", { name: `移除 · ${QWEN}` }));
    await waitFor(() => expect(drafts()).toEqual(["fun-asr"]));
    expect((within(dialog).getByRole("button", { name: "移除 · fun-asr" }) as HTMLButtonElement).disabled).toBe(true);
    // The removed model is suggested again.
    expect(suggestions(dialog)).toEqual([QWEN]);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ models: [{ modelId: "fun-asr" }] }));
  });

  it("saves a new profile order when one is moved, and folds a profile to its heading for good", async () => {
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [profile(), BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "PUT /api/asr-profiles/order": { body: { items: [BAILIAN, profile()] } },
    });
    renderApp(<TranscriptionSection />);
    const names = () => screen.getAllByTestId("asr-profile-card").map((card) => card.dataset["profile"]);
    await waitFor(() => expect(names()).toEqual(["ElevenLabs", "阿里云百炼"]));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动调整「阿里云百炼」的顺序" }), { key: "ArrowUp" });
    await waitFor(() => expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ profileIds: ["a2", "a1"] }));
    await waitFor(() => expect(names()).toEqual(["阿里云百炼", "ElevenLabs"]));

    const bailian = screen.getAllByTestId("asr-profile-card")[0] as HTMLElement;
    fireEvent.click(within(bailian).getByRole("button", { name: "收起「阿里云百炼」" }));
    expect(within(bailian).queryByText("API Key")).toBeNull();
    expect(within(bailian).getByText("2 个模型")).toBeTruthy();
    expect(localStorage.getItem("amber.settings.collapsedAsrProfiles")).toBe(JSON.stringify(["a2"]));
  });

  it("keeps the region of a profile in use, and says why", async () => {
    mockApi({
      "GET /api/asr-profiles": { body: { items: [{ ...BAILIAN, inUse: true }] } },
      "GET /api/settings": { body: SETTINGS },
    });
    renderApp(<TranscriptionSection />);
    expect(await screen.findByTestId("asr-profile-in-use")).toBeTruthy();
    expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("地域") as HTMLSelectElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("名称") as HTMLInputElement).disabled).toBe(false);
  });

  it("explains a refused model removal", async () => {
    mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "PATCH /api/asr-profiles/a2": CONFLICT,
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "移除 · fun-asr" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText(/有未完成的任务正在使用这个 Profile/)).toBeTruthy();
  });

  it("asks before deleting and explains a refusal", async () => {
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "DELETE /api/asr-profiles/a2": CONFLICT,
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/api/asr-profiles/a2")).toBe(true));
    expect(await screen.findByText(/有未完成的任务正在使用这个 Profile/)).toBeTruthy();
  });

  it("explains a refused key change while a submitted job awaits its result", async () => {
    mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "PUT /api/asr-profiles/a2/credential": CONFLICT,
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "重设" }));
    fireEvent.change(await screen.findByPlaceholderText("粘贴新的 Key，保存后不再显示"), { target: { value: "<placeholder-asr-key>" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/有未完成的任务正在使用这个 Profile/)).toBeTruthy();
  });

  it("checks a key on click and tells an upload-space check from an account lookup", async () => {
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/asr-profiles/a2/probe": { body: {} },
    });
    renderApp(<TranscriptionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "校验 Key" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.calls.some((call) => call.path === "/api/asr-profiles/a2/probe")).toBe(true));
    expect((await screen.findByRole("status")).textContent).toContain("可获取上传凭证");
  });

  it("tests one model on click, says it is running, then shows the outcome and the stored test time", async () => {
    const tested = { ...BAILIAN, models: [{ modelId: QWEN, family: "qwen_audio", available: true }, { modelId: "fun-asr", family: "fun_asr", available: true, testedAt: Date.UTC(2026, 9, 16, 2, 0) }] };
    let listed: unknown = BAILIAN;
    const api = mockApi({
      "GET /api/asr-profiles": () => ({ body: { items: [listed] } }),
      "GET /api/settings": { body: SETTINGS },
      "POST /api/asr-profiles/a2/test": () => {
        listed = tested;
        return { body: { modelId: "fun-asr", result: "transcribed", textPreview: "Amber", latencyMs: 1234, testedAt: 1 } };
      },
    });
    // Hold the test answer until the running state has been seen.
    const base = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/test")) await gate;
      return base(input, init);
    });
    renderApp(<TranscriptionSection />);
    expect((await screen.findByTestId("asr-test-hint")).textContent).toBe("测试连接会发送 2 秒测试音频，可能产生少量费用。");
    const row = (await screen.findAllByTestId("asr-profile-model"))[1] as HTMLElement;
    expect(within(row).getByTestId("asr-model-tested").textContent).toBe("未测试");
    fireEvent.click(within(row).getByRole("button", { name: "测试连接 · fun-asr" }));
    // No confirmation: the hint already says what it costs.
    expect(screen.queryByRole("dialog")).toBeNull();
    const running = (await within(row).findByRole("button", { name: "测试中… · fun-asr" })) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    // The other model stays testable meanwhile.
    expect((screen.getByRole("button", { name: `测试连接 · ${QWEN}` }) as HTMLButtonElement).disabled).toBe(false);
    release();
    const status = await within(row).findByTestId("asr-model-test-result");
    expect(status.textContent).toBe("可用 · 延迟 1234 ms识别文本：Amber");
    await waitFor(() => expect(within(row).getByTestId("asr-model-tested").textContent).toMatch(/^实测于 /));
    expect(api.calls.find((call) => call.path === "/api/asr-profiles/a2/test")?.body).toEqual({ modelId: "fun-asr" });
  });

  it("words a rate-limited model test as advice to test again, not as a pipeline retry", async () => {
    mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/asr-profiles/a2/test": {
        status: 429,
        body: {
          error: {
            class: "asr_failed",
            code: "asr_failed.rate_limited",
            retryDisposition: "policy",
            userMessage: "已按服务端要求等待并自动重试仍未成功；可稍后从这步重跑",
            details: { retryAfterMs: 30100 },
          },
        },
      },
    });
    renderApp(<TranscriptionSection />);
    const row = (await screen.findAllByTestId("asr-profile-model"))[1] as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "测试连接 · fun-asr" }));
    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toContain("请约 31 秒后再测试");
    expect(alert.textContent).not.toContain("重跑");
  });

  it("tells a sound without speech and an accepted job apart, and shows a refused test as an error", async () => {
    const replies = [
      { body: { modelId: "fun-asr", result: "no_speech", latencyMs: 900 } },
      { body: { modelId: "fun-asr", result: "accepted", latencyMs: 45000 } },
      { body: { modelId: "fun-asr", result: "accepted", latencyMs: 45000, remoteCancelled: true } },
      { status: 400, body: { error: { class: "asr_failed", code: "asr_failed.model_unavailable", retryDisposition: "never", userMessage: "所配置的转写模型不存在" } } },
    ];
    mockApi({
      "GET /api/asr-profiles": { body: { items: [BAILIAN] } },
      "GET /api/settings": { body: SETTINGS },
      "POST /api/asr-profiles/a2/test": () => replies.shift() ?? { status: 500 },
    });
    renderApp(<TranscriptionSection />);
    const row = (await screen.findAllByTestId("asr-profile-model"))[1] as HTMLElement;
    const button = within(row).getByRole("button", { name: "测试连接 · fun-asr" });
    fireEvent.click(button);
    await waitFor(() => expect(within(row).getByTestId("asr-model-test-result").textContent).toBe("可用（测试音频无语音内容）· 延迟 900 ms"));
    fireEvent.click(within(row).getByRole("button", { name: "测试连接 · fun-asr" }));
    await waitFor(() => expect(within(row).getByTestId("asr-model-test-result").textContent).toBe("测试超时，已尝试取消 · 计费量未知"));
    fireEvent.click(within(row).getByRole("button", { name: "测试连接 · fun-asr" }));
    await waitFor(() => expect(within(row).getByTestId("asr-model-test-result").textContent).toBe("测试超时，已取消"));
    fireEvent.click(within(row).getByRole("button", { name: "测试连接 · fun-asr" }));
    expect((await within(row).findByRole("alert")).textContent).toContain("所配置的转写模型不存在");
    expect(within(row).queryByTestId("asr-model-test-result")).toBeNull();
  });

  it("cannot test a model without a key", async () => {
    mockApi({
      "GET /api/asr-profiles": { body: { items: [{ ...BAILIAN, credentialStatus: "missing", hasCredential: false }] } },
      "GET /api/settings": { body: SETTINGS },
    });
    renderApp(<TranscriptionSection />);
    expect(((await screen.findByRole("button", { name: "测试连接 · fun-asr" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows each model's price and edits it with the units of transcription", async () => {
    const priced = {
      ...BAILIAN,
      models: [
        { modelId: QWEN, family: "qwen_audio", available: true, pricing: { currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "0.8" }, { unit: "output_tokens_per_million", amount: "2.7" }] } },
        { modelId: "fun-asr", family: "fun_asr", available: true },
      ],
    };
    const api = mockApi({
      "GET /api/asr-profiles": { body: { items: [priced] } },
      "GET /api/settings": { body: SETTINGS },
      "PUT /api/asr-profiles/a2/model-pricing": { body: priced },
    });
    renderApp(<TranscriptionSection />);
    const [qwen, fun] = (await screen.findAllByTestId("asr-profile-model")) as [HTMLElement, HTMLElement];
    expect(within(qwen).getByTestId("model-pricing-summary").textContent).toBe("0.8 元 / 百万输入 tokens · 2.7 元 / 百万输出 tokens");
    expect(within(fun).getByTestId("model-pricing-summary").textContent).toBe("未设置价格");
    fireEvent.click(within(fun).getByRole("button", { name: "价格 · fun-asr" }));
    const dialog = await screen.findByRole("dialog");
    expect([...(within(dialog).getByLabelText("计费单位 1") as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      "input_tokens_per_million",
      "output_tokens_per_million",
      "audio_per_second",
      "audio_per_minute",
      "audio_per_hour",
      "per_request",
    ]);
    fireEvent.change(within(dialog).getByLabelText("计费单位 1"), { target: { value: "audio_per_second" } });
    fireEvent.change(within(dialog).getByLabelText("单价 1"), { target: { value: "0.00022" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ modelId: "fun-asr", pricing: { currency: "CNY", items: [{ unit: "audio_per_second", amount: "0.00022" }] } }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
