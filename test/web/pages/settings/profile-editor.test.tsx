import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsSection } from "../../../../src/web/pages/settings/models-section.tsx";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

const FLAGS = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 };
const KEY = "<placeholder-llm-key>";

function model(modelId: string, limits: { contextWindowTokens?: number; maxOutputTokens?: number } = {}) {
  return {
    modelId,
    flags: { declared: FLAGS },
    limits: { declared: {}, ...(Object.keys(limits).length === 0 ? {} : { userOverride: limits }) },
    effective: { flags: FLAGS, limits },
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Kimi",
    protocol: "openai_compatible",
    baseURL: "https://api.moonshot.cn/v1",
    presetId: "kimi",
    createdAt: 1,
    credentialStatus: "configured",
    hasCredential: true,
    models: [model("kimi-k2", { contextWindowTokens: 128_000, maxOutputTokens: 8_000 })],
    ...overrides,
  };
}

/** Radix Select measures and positions its list with APIs jsdom lacks. */
function stubLayout(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
}

beforeEach(stubLayout);

async function openCreate(routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ "GET /api/providers": { body: { items: [] } }, ...routes });
  renderApp(<ModelsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 Profile" }));
  const dialog = await screen.findByRole("dialog");
  return { api, dialog, ...helpers(dialog) };
}

async function openEdit(item: ReturnType<typeof profile>, routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ "GET /api/providers": { body: { items: [item] } }, "GET /api/settings": { body: SETTINGS }, ...routes });
  renderApp(<ModelsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog");
  return { api, dialog, ...helpers(dialog) };
}

function helpers(dialog: HTMLElement) {
  const field = (label: string) => within(dialog).getByLabelText(label) as HTMLInputElement;
  const options = async (label: string): Promise<string[]> => {
    fireEvent.keyDown(field(label), { key: "Enter" });
    const listbox = await screen.findByRole("listbox");
    const names = within(listbox)
      .getAllByRole("option")
      .map((option) => option.textContent ?? "");
    fireEvent.keyDown(listbox, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    return names;
  };
  const choose = async (label: string, option: string): Promise<void> => {
    fireEvent.keyDown(field(label), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: option }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  };
  const type = (label: string, value: string): void => {
    fireEvent.change(field(label), { target: { value } });
  };
  const save = (): void => {
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  };
  const summary = (): string => within(dialog).getByTestId("connection-summary").textContent ?? "";
  const openConnection = (): void => {
    fireEvent.click(within(dialog).getByRole("button", { name: "修改" }));
  };
  return { field, options, choose, type, save, summary, openConnection };
}

function posted(calls: readonly RecordedCall[], method = "POST"): RecordedCall | undefined {
  return calls.find((call) => call.method === method && call.path.startsWith("/api/providers") && !call.path.endsWith("/order"));
}

describe("adding a profile", () => {
  it("starts with the service unset, showing only the service and a disabled save", async () => {
    const { dialog, field } = await openCreate();
    expect(field("服务").textContent).toBe("未设置");
    expect(field("服务").hasAttribute("data-placeholder")).toBe(true);
    expect(within(dialog).getByText("选择服务后会自动填写连接地址")).toBeTruthy();
    for (const label of ["API Key", "模型 ID（第 1 行）", "名称", "地域", "Base URL"]) {
      expect(within(dialog).queryByLabelText(label)).toBeNull();
    }
    expect(within(dialog).queryByTestId("profile-connection")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the nine services in order, each with its mark and full name", async () => {
    const { options } = await openCreate();
    expect(await options("服务")).toEqual(["DeepSeek", "Qwen（通义千问）", "Kimi（月之暗面）", "GLM（智谱）", "OpenAI", "Anthropic", "Gemini", "Grok（xAI）", "自定义"]);
    fireEvent.keyDown(screen.getByLabelText("服务"), { key: "Enter" });
    const marks = [...(await screen.findByRole("listbox")).querySelectorAll("svg[data-vendor-icon]")].map((icon) => icon.getAttribute("data-vendor-icon"));
    expect(marks).toEqual(["deepseek", "qwen", "kimi", "glm", "openai", "anthropic", "gemini", "grok", "neutral"]);
  });

  it("fills the official address, the name and the region once a service is chosen, keeping focus on the service", async () => {
    const { dialog, field, choose, summary } = await openCreate();
    await choose("服务", "Kimi（月之暗面）");
    expect(field("服务").textContent).toBe("Kimi（月之暗面）");
    expect(document.activeElement).toBe(field("服务"));
    expect(within(dialog).queryByText("选择服务后会自动填写连接地址")).toBeNull();
    expect(field("名称").value).toBe("Kimi（月之暗面）");
    expect(field("地域").textContent).toBe("中国");
    expect(within(dialog).getByText("各地域的 Key 不通用，请选择创建 Key 的地域")).toBeTruthy();
    expect(summary()).toBe("OpenAI 兼容 · api.moonshot.cn/v1 · 官方地址");
    // Collapsed by default: no Base URL field until 「修改」.
    expect(within(dialog).queryByLabelText("Base URL")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(dialog).queryByLabelText("工作空间 ID（可选）")).toBeNull();
  });

  it("keeps a name the user typed when the service changes", async () => {
    const { field, choose, type } = await openCreate();
    await choose("服务", "DeepSeek");
    type("名称", "My relay");
    await choose("服务", "Kimi（月之暗面）");
    expect(field("名称").value).toBe("My relay");
  });

  it("switches to the region's official address with a way back", async () => {
    const { dialog, choose, summary, field } = await openCreate();
    await choose("服务", "Kimi（月之暗面）");
    await choose("地域", "国际");
    expect(summary()).toBe("OpenAI 兼容 · api.moonshot.ai/v1 · 官方地址");
    const notice = within(dialog).getByTestId("address-changed");
    expect(notice.textContent).toBe("已改为 Kimi（月之暗面） · 国际 官方地址 · 撤销");
    fireEvent.click(within(notice).getByRole("button", { name: "撤销" }));
    expect(summary()).toBe("OpenAI 兼容 · api.moonshot.cn/v1 · 官方地址");
    expect(field("地域").textContent).toBe("中国");
    expect(within(dialog).queryByTestId("address-changed")).toBeNull();
  });

  it("marks a hand-edited address as custom, opens the connection group and restores the official one", async () => {
    const { dialog, choose, type, openConnection, field } = await openCreate();
    await choose("服务", "Kimi（月之暗面）");
    openConnection();
    type("Base URL", "https://relay.example.com/v1");
    expect(field("地域").textContent).toBe("自定义地址");
    const custom = within(dialog).getByTestId("address-custom");
    expect(custom.textContent).toBe("自定义地址 · 恢复官方地址");
    // Address and region disagree, so the group stays open.
    expect(within(dialog).queryByRole("button", { name: "收起" })).toBeNull();
    fireEvent.click(within(custom).getByRole("button", { name: "恢复官方地址" }));
    expect(field("Base URL").value).toBe("https://api.moonshot.cn/v1");
    expect(within(dialog).getByTestId("address-changed").textContent).toContain("撤销");
  });

  it("says an interface path at the end of the address is not needed", async () => {
    const { dialog, choose, type, openConnection } = await openCreate();
    await choose("服务", "OpenAI");
    openConnection();
    type("Base URL", "https://api.openai.com/v1/chat/completions/");
    expect(within(dialog).getByTestId("address-path-suffix").textContent).toBe("地址末尾不需要写接口路径（/chat/completions），请删掉，Amber 发送时会自己补上");
    expect(within(dialog).queryByRole("button", { name: "收起" })).toBeNull();
  });

  it("builds Qwen's workspace address from a valid id, refuses an invalid one, and requires one in Tokyo", async () => {
    const { api, dialog, choose, type, field, summary, save } = await openCreate();
    await choose("服务", "Qwen（通义千问）");
    expect(summary()).toBe("OpenAI 兼容 · dashscope.aliyuncs.com/compatible-mode/v1 · 官方地址");
    expect(within(dialog).getByText("填写后使用阿里云推荐的专属域名，需使用该工作空间的 Key")).toBeTruthy();

    type("工作空间 ID（可选）", " WS-Team1 ");
    expect(summary()).toBe("OpenAI 兼容 · ws-team1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 · 官方地址");
    expect(field("地域").textContent).toBe("中国（北京）");

    type("工作空间 ID（可选）", "-bad");
    expect(within(dialog).getByTestId("workspace-invalid").textContent).toContain("不能以连字符开头或结尾");
    expect(summary()).toContain("ws-team1.cn-beijing");

    type("工作空间 ID（可选）", "");
    expect(summary()).toBe("OpenAI 兼容 · dashscope.aliyuncs.com/compatible-mode/v1 · 官方地址");
    // One run of typing is one change to take back.
    expect(within(dialog).queryByTestId("address-changed")).toBeNull();

    await choose("地域", "日本（东京）");
    expect(field("地域").textContent).toBe("日本（东京）");
    expect(within(dialog).getByTestId("workspace-required").textContent).toBe("日本（东京）只提供专属域名，请填写工作空间 ID");
    // No address yet: the connection group opens, and the region switch can be taken back.
    expect(field("Base URL").value).toBe("");
    expect(within(dialog).getByTestId("address-changed").textContent).toBe("已清空连接地址 · 撤销");
    type("模型 ID（第 1 行）", "qwen-plus");
    save();
    await act(async () => undefined);
    expect(posted(api.calls)).toBeUndefined();

    type("工作空间 ID（可选）", "ws1");
    expect(field("Base URL").value).toBe("https://ws1.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1");
    expect(within(dialog).queryByTestId("workspace-required")).toBeNull();
    // Fixed now, yet the group stays open where the user is working.
    expect(within(dialog).getByRole("button", { name: "收起" })).toBeTruthy();
  });

  it("lists only the protocols the service serves, marking Grok's legacy one, and all three for a custom service", async () => {
    const { dialog, choose, options, openConnection, summary } = await openCreate();
    await choose("服务", "Grok（xAI）");
    expect(summary()).toBe("OpenAI Responses · api.x.ai/v1 · 官方地址");
    openConnection();
    expect(await options("协议")).toEqual(["OpenAI Responses", "OpenAI 兼容, 旧版"]);
    await choose("服务", "自定义");
    expect(within(dialog).getByLabelText("Base URL")).toBeTruthy();
    expect((within(dialog).getByLabelText("Base URL") as HTMLInputElement).value).toBe("");
    expect(await options("协议")).toEqual(["OpenAI 兼容", "Anthropic Messages", "OpenAI Responses"]);
  });

  it("switches DeepSeek's address with the protocol", async () => {
    const { dialog, choose, openConnection, field } = await openCreate();
    await choose("服务", "DeepSeek");
    openConnection();
    await choose("协议", "Anthropic Messages");
    expect(field("Base URL").value).toBe("https://api.deepseek.com/anthropic");
    expect(within(dialog).getByTestId("address-changed").textContent).toBe("已改为 DeepSeek 官方地址 · 撤销");
  });

  it("offers common context window sizes and explains why the window matters", async () => {
    const { dialog, choose, field } = await openCreate();
    await choose("服务", "DeepSeek");
    const input = field("上下文窗口（第 1 行）");
    // One way of writing each size, in the app's own menu style rather than the browser's list.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const list = screen.getByRole("listbox", { name: "常用上下文窗口" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["32K", "64K", "128K", "200K", "256K", "1M"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(input.value).toBe("128K");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(within(dialog).getByTestId("context-window-note").textContent).toBe("总结、章节、高光与 AI 对话需要它，可在厂商的模型说明里查到，也可以以后再填。");
  });

  it("creates the profile and its key in one request with an Idempotency-Key, leaving blank limits out", async () => {
    const { api, choose, type, save } = await openCreate({ "POST /api/providers": { status: 201, body: profile({ id: "p9", name: "DeepSeek", presetId: "deepseek" }) } });
    await choose("服务", "DeepSeek");
    type("API Key", KEY);
    type("模型 ID（第 1 行）", " deepseek-chat ");
    save();
    await waitFor(() => expect(posted(api.calls)).toBeDefined());
    const call = posted(api.calls);
    expect(call?.path).toBe("/api/providers");
    expect(call?.body).toEqual({
      name: "DeepSeek",
      protocol: "openai_compatible",
      baseURL: "https://api.deepseek.com",
      presetId: "deepseek",
      models: [{ modelId: "deepseek-chat" }],
      credential: { value: KEY },
    });
    expect(call?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reads 128K as 128000 tokens and refuses a non-number", async () => {
    const { api, dialog, choose, type, save } = await openCreate({ "POST /api/providers": { status: 201, body: profile() } });
    await choose("服务", "Kimi（月之暗面）");
    type("模型 ID（第 1 行）", "kimi-k2");
    type("上下文窗口（第 1 行）", "abc");
    expect(within(dialog).getByText("请填写正整数，可带 K 或 M")).toBeTruthy();
    save();
    await act(async () => undefined);
    expect(posted(api.calls)).toBeUndefined();
    type("上下文窗口（第 1 行）", "128K");
    type("最大输出（第 1 行）", "8,192");
    save();
    await waitFor(() => expect(posted(api.calls)?.body).toMatchObject({ models: [{ modelId: "kimi-k2", contextWindowTokens: 128_000, maxOutputTokens: 8_192 }] }));
    expect(posted(api.calls)?.body).not.toHaveProperty("credential");
  });

  it("saves without a key, after which the card waits for one", async () => {
    let items: unknown[] = [];
    const created = profile({ credentialStatus: "missing", hasCredential: false, models: [model("kimi-k2")] });
    mockApi({
      "GET /api/providers": () => ({ body: { items } }),
      "GET /api/settings": { body: SETTINGS },
      "POST /api/providers": () => {
        items = [created];
        return { status: 201, body: created };
      },
    });
    renderApp(<ModelsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "添加 Profile" }));
    const dialog = await screen.findByRole("dialog");
    const { choose, type, save } = helpers(dialog);
    await choose("服务", "Kimi（月之暗面）");
    type("模型 ID（第 1 行）", "kimi-k2");
    save();
    expect((await screen.findByTestId("profile-credential-status")).textContent).toBe("待配置");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps everything typed and shows the reason when saving fails", async () => {
    const { dialog, choose, type, save, field } = await openCreate({
      "POST /api/providers": { status: 400, body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "地址不可用" } } },
    });
    await choose("服务", "DeepSeek");
    type("API Key", KEY);
    type("模型 ID（第 1 行）", "deepseek-chat");
    save();
    expect((await within(dialog).findByRole("alert")).textContent).toContain("地址不可用");
    expect(field("API Key").value).toBe(KEY);
    expect(field("模型 ID（第 1 行）").value).toBe("deepseek-chat");
    expect(field("服务").textContent).toBe("DeepSeek");
  });

  it("takes back everything an automatic change touched: service, protocol, address and the name that followed it", async () => {
    const { dialog, choose, field, openConnection } = await openCreate();
    await choose("服务", "DeepSeek");
    openConnection();
    await choose("协议", "Anthropic Messages");
    await choose("服务", "Kimi（月之暗面）");
    expect(field("名称").value).toBe("Kimi（月之暗面）");
    fireEvent.click(within(within(dialog).getByTestId("address-changed")).getByRole("button", { name: "撤销" }));
    expect(field("服务").textContent).toBe("DeepSeek");
    expect(field("协议").textContent).toBe("Anthropic Messages");
    expect(field("Base URL").value).toBe("https://api.deepseek.com/anthropic");
    expect(field("名称").value).toBe("DeepSeek");
  });

  it("empties the address for a custom service on the default protocol, sends no preset, and can take it back", async () => {
    const { api, dialog, choose, field, type, save, openConnection } = await openCreate({ "POST /api/providers": { status: 201, body: profile() } });
    await choose("服务", "Grok（xAI）");
    openConnection();
    await choose("服务", "自定义");
    expect(field("Base URL").value).toBe("");
    expect(field("协议").textContent).toBe("OpenAI 兼容");
    expect(within(dialog).getByTestId("address-changed").textContent).toBe("已清空连接地址 · 撤销");
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销" }));
    expect(field("Base URL").value).toBe("https://api.x.ai/v1");
    await choose("服务", "自定义");
    type("Base URL", "https://relay.example.com/v1");
    type("模型 ID（第 1 行）", "any-model");
    save();
    await waitFor(() => expect(posted(api.calls)).toBeDefined());
    expect(posted(api.calls)?.body).not.toHaveProperty("presetId");
  });

  it("says a single-region service's own address is custom only once while the group is folded", async () => {
    const { dialog, choose, type, openConnection, summary } = await openCreate();
    await choose("服务", "DeepSeek");
    openConnection();
    type("Base URL", "https://relay.example.com");
    fireEvent.click(within(dialog).getByRole("button", { name: "收起" }));
    expect(summary()).toBe("OpenAI 兼容 · relay.example.com · 自定义地址");
    expect(within(dialog).getByTestId("address-custom").textContent).toBe("恢复官方地址");
  });

  it("links each hint to its control for screen readers", async () => {
    const { field, choose } = await openCreate();
    expect(document.getElementById(field("服务").getAttribute("aria-describedby") ?? "")?.textContent).toBe("选择服务后会自动填写连接地址");
    await choose("服务", "Kimi（月之暗面）");
    expect(document.getElementById(field("地域").getAttribute("aria-describedby") ?? "")?.textContent).toBe("各地域的 Key 不通用，请选择创建 Key 的地域");
    expect(document.getElementById(field("API Key").getAttribute("aria-describedby") ?? "")?.textContent).toBe("保存后不再显示；也可以先不填，以后在卡片上设置");
  });

  it("puts the focus in a new row's model id, back on a neighbour when a row goes, and names an empty row by its number", async () => {
    const { dialog, choose, field, type } = await openCreate();
    await choose("服务", "DeepSeek");
    expect(within(dialog).getByRole("button", { name: "拖动调整模型顺序（第 1 行）" })).toBeTruthy();
    type("模型 ID（第 1 行）", "a");
    fireEvent.click(within(dialog).getByRole("button", { name: "添加模型" }));
    expect(document.activeElement).toBe(field("模型 ID（第 2 行）"));
    fireEvent.click(within(dialog).getByRole("button", { name: "移除（第 2 行）" }));
    expect(document.activeElement).toBe(field("模型 ID（第 1 行）"));
    expect(within(dialog).getByRole("button", { name: "移除 · a" })).toBeTruthy();
    expect(within(dialog).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "排序",
      "模型 ID",
      "上下文窗口选填 · tokens",
      "最大输出选填 · tokens",
      "操作",
    ]);
  });

  it("refuses the same model id twice, saying so at the row", async () => {
    const { api, dialog, choose, type, save } = await openCreate();
    await choose("服务", "DeepSeek");
    type("模型 ID（第 1 行）", "deepseek-chat");
    fireEvent.click(within(dialog).getByRole("button", { name: "添加模型" }));
    type("模型 ID（第 2 行）", " deepseek-chat");
    expect(within(dialog).getAllByTestId("model-duplicate").map((item) => item.textContent)).toEqual(["已有同名模型", "已有同名模型"]);
    save();
    await act(async () => undefined);
    expect(posted(api.calls)).toBeUndefined();
  });

  it("stays open on a click outside once something was typed, but Esc still closes it", async () => {
    const { dialog, choose, type } = await openCreate();
    await choose("服务", "DeepSeek");
    type("API Key", KEY);
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.click(document.body);
    await act(async () => undefined);
    expect(screen.getByRole("dialog")).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("names the Hong Kong region as the vendor does", async () => {
    const { choose, options } = await openCreate();
    await choose("服务", "Qwen（通义千问）");
    expect(await options("地域")).toEqual(["中国（北京）", "新加坡", "中国香港", "美国（弗吉尼亚）", "日本（东京）", "德国（法兰克福）"]);
  });
});

describe("editing a profile", () => {
  it("keeps a renamed model's window by sending it, and clears a re-added model's blank window explicitly", async () => {
    const item = profile({ models: [model("kimi-k2", { contextWindowTokens: 128_000 }), model("kimi-old", { contextWindowTokens: 64_000 })] });
    const { api, dialog, type, save } = await openEdit(item, { "PATCH /api/providers/p1": { body: item } });
    type("模型 ID（第 1 行）", "kimi-k2.5");
    fireEvent.click(within(dialog).getByRole("button", { name: "移除 · kimi-old" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加模型" }));
    type("模型 ID（第 2 行）", "kimi-old");
    save();
    await waitFor(() =>
      expect(posted(api.calls, "PATCH")?.body).toEqual({
        models: [
          { modelId: "kimi-k2.5", contextWindowTokens: 128_000 },
          { modelId: "kimi-old", contextWindowTokens: null, maxOutputTokens: null },
        ],
      }),
    );
  });

  it("offers 「未指定」 instead of 「自定义」, and shows a custom profile as unspecified", async () => {
    const { dialog, field, options } = await openEdit(profile({ presetId: "custom", name: "Relay" }));
    expect(field("服务").textContent).toBe("未指定");
    const names = await options("服务");
    expect(names[0]).toBe("未指定");
    expect(names).not.toContain("自定义");
    expect(within(dialog).queryByLabelText("地域")).toBeNull();
  });

  it("sends only the new name when only the name changed", async () => {
    const { api, type, save } = await openEdit(profile(), { "PATCH /api/providers/p1": { body: profile({ name: "Moonshot" }) } });
    type("名称", "Moonshot");
    save();
    await waitFor(() => expect(posted(api.calls, "PATCH")?.body).toEqual({ name: "Moonshot" }));
  });

  it("clears a context window with null and leaves untouched limits out", async () => {
    const item = profile({ models: [model("kimi-k2", { contextWindowTokens: 128_000, maxOutputTokens: 8_000 }), model("kimi-latest", { contextWindowTokens: 256_000 })] });
    const { api, dialog, save } = await openEdit(item, { "PATCH /api/providers/p1": { body: item } });
    const windows = within(dialog).getAllByLabelText(/^上下文窗口（第/u) as HTMLInputElement[];
    expect(windows.map((input) => input.value)).toEqual(["128000", "256000"]);
    fireEvent.change(windows[0] as HTMLElement, { target: { value: "" } });
    save();
    await waitFor(() =>
      expect(posted(api.calls, "PATCH")?.body).toEqual({ models: [{ modelId: "kimi-k2", contextWindowTokens: null }, { modelId: "kimi-latest" }] }),
    );
  });

  it("changes the service for display only, and can clear it", async () => {
    const { api, dialog, choose, options, save } = await openEdit(profile(), { "PATCH /api/providers/p1": { body: profile() } });
    expect(within(dialog).getByText("只影响图标与显示，不会改动连接地址")).toBeTruthy();
    expect((await options("服务"))[0]).toBe("未指定");
    await choose("服务", "未指定");
    expect(within(dialog).queryByLabelText("地域")).toBeNull();
    save();
    await waitFor(() => expect(posted(api.calls, "PATCH")?.body).toEqual({ presetId: null }));
  });

  it("shows a profile without a service as unspecified and sets one without touching the address", async () => {
    const { api, field, choose, save } = await openEdit(profile({ presetId: undefined, name: "Relay" }), { "PATCH /api/providers/p1": { body: profile() } });
    expect(field("服务").textContent).toBe("未指定");
    await choose("服务", "Kimi（月之暗面）");
    expect(field("地域").textContent).toBe("中国");
    save();
    await waitFor(() => expect(posted(api.calls, "PATCH")?.body).toEqual({ presetId: "kimi" }));
  });

  it("reads the region from the address, switches it like a new profile, and keeps the protocol fixed", async () => {
    const { api, dialog, field, choose, openConnection, save } = await openEdit(profile({ baseURL: "https://api.moonshot.ai/v1" }), {
      "PATCH /api/providers/p1": { body: profile() },
    });
    expect(field("地域").textContent).toBe("国际");
    expect(within(dialog).queryByLabelText("API Key")).toBeNull();
    await choose("地域", "中国");
    expect(within(dialog).getByTestId("address-changed").textContent).toContain("撤销");
    openConnection();
    expect(field("协议").hasAttribute("disabled") || field("协议").getAttribute("data-disabled") !== null).toBe(true);
    expect(within(dialog).getByText("协议创建后不能修改；需要换协议时请新建一个 Profile")).toBeTruthy();
    save();
    await waitFor(() => expect(posted(api.calls, "PATCH")?.body).toEqual({ baseURL: "https://api.moonshot.cn/v1" }));
  });

  it("says once, beside the address, how many unfinished tasks keep it from changing, puts the saved address back and holds it", async () => {
    const message = "有 2 个未完成的任务正在使用它，等它们结束或取消后再修改连接地址";
    let patches = 0;
    const { api, dialog, field, choose, type, save } = await openEdit(profile(), {
      "PATCH /api/providers/p1": () => {
        patches += 1;
        return patches === 1
          ? { status: 409, body: { error: { class: "conflict", code: "conflict.profile_tasks_unfinished", retryDisposition: "never", userMessage: message, details: { taskCount: 2 } } } }
          : { body: profile({ name: "Moonshot" }) };
      },
    });
    await choose("地域", "国际");
    save();
    const conflict = await within(dialog).findByTestId("profile-tasks-conflict");
    expect(conflict.textContent).toBe(`${message} 已恢复为原来的连接地址，地域与地址暂时不能修改。`);
    expect(within(dialog).getAllByText(new RegExp(message, "u"))).toHaveLength(1);
    expect(field("Base URL").value).toBe("https://api.moonshot.cn/v1");
    expect(field("Base URL").disabled).toBe(true);
    expect(field("地域").textContent).toBe("中国");
    expect(field("地域").hasAttribute("data-disabled")).toBe(true);
    expect(field("Base URL").getAttribute("aria-describedby")).toBe(conflict.id);
    // The rest of the edit still saves, without the address.
    type("名称", "Moonshot");
    save();
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ name: "Moonshot" }));
  });
});
