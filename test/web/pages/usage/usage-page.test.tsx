import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeModelKey, encodeProfileKey } from "../../../../src/shared/dto/usage-analytics.ts";
import { UsagePage } from "../../../../src/web/pages/usage/usage-page.tsx";
import { USAGE_CURRENCY_STORAGE_KEY } from "../../../../src/web/pages/usage/usage-state.ts";
import { usageReply } from "../../../fixtures/usage/handler.ts";
import { asrCall, beijing, group, llmCall, model, profile, SCENARIO_NOW } from "../../../fixtures/usage/builders.ts";
import { SCENARIOS } from "../../../fixtures/usage/scenarios.ts";
import type { FixtureCall, FixturePrice, FixtureScenario } from "../../../fixtures/usage/types.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const PRICE: FixturePrice = { currency: "CNY", inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1 };
const SAVED_OLD = beijing(2026, 11, 2, 10);
const SAVED_NEW = beijing(2026, 11, 4, 9, 30);

/**
 * One relay profile that switched keys: GPT ran only on the old key, Claude only on the new one;
 * a second profile kept a single key, and its one call came back without an input count.
 */
function twoKeys(): FixtureScenario {
  const relay = profile("relay", "llm", "Auth2API", [
    ["relay-old", SAVED_OLD],
    ["relay-new", SAVED_NEW],
  ]);
  const single = profile("deepseek", "llm", "DeepSeek", [["deepseek-v1", beijing(2026, 10, 20)]]);
  const gpt = model(relay, "gpt-5.6-sol", PRICE);
  const claude = model(relay, "claude-sonnet-4-5", PRICE);
  const chat = model(single, "deepseek-v4-chat", PRICE);
  const gptGroup = group("g-gpt", "task", "GPT 任务", "content-gpt");
  const cached = llmCall(gptGroup, gpt, "proofread", beijing(2026, 11, 5, 10), { input: 1348, output: 139, cacheRead: 207, reasoning: 64, version: "relay-old" });
  const calls: FixtureCall[] = [
    { ...cached, llm: { ...(cached.llm as NonNullable<FixtureCall["llm"]>), cacheWrite: 120 } },
    llmCall(gptGroup, gpt, "summary", beijing(2026, 11, 5, 10, 0, 10), { input: 500, output: 50, version: "relay-old" }),
    llmCall(group("g-claude", "task", "Claude 任务", "content-claude"), claude, "summary", beijing(2026, 11, 5, 12), { input: 2000, output: 100, version: "relay-new" }),
    llmCall(group("g-deepseek", "chat", "DeepSeek 对话", "content-deepseek"), chat, "chat", beijing(2026, 11, 5, 13), { input: 0, output: 30 }),
  ];
  return { id: "two-keys", now: SCENARIO_NOW, calls, cacheObserved: [] };
}

/** A model whose name points at no vendor, on a profile whose service does, and a transcription. */
function unnamed(): FixtureScenario {
  const relay = profile("relay", "llm", "Auth2API", [["relay-v1", beijing(2026, 10, 1)]]);
  const bailian = profile("bailian", "asr", "阿里云百炼", [["bailian-v1", beijing(2026, 10, 1)]]);
  const house = model(relay, "house-model", PRICE);
  const funAsr = model(bailian, "fun-asr", { currency: "CNY", audioPerSecond: 0.0002 });
  return {
    id: "unnamed",
    now: SCENARIO_NOW,
    calls: [
      llmCall(group("g-house", "task", "自有模型", "content-house"), house, "summary", beijing(2026, 11, 5, 10), { input: 100, output: 10 }),
      asrCall(group("g-asr", "task", "转写", "content-asr"), funAsr, beijing(2026, 11, 5, 9), { audioMs: 750_000 }),
    ],
    cacheObserved: [],
  };
}

const PROVIDERS = {
  items: [
    {
      id: "relay",
      name: "Auth2API",
      protocol: "openai_compatible",
      baseURL: "https://relay.invalid/v1",
      presetId: "kimi",
      models: [],
      createdAt: 0,
      credentialStatus: "configured",
      hasCredential: true,
    },
  ],
};
const ASR_PROFILES = {
  items: [
    {
      id: "bailian",
      name: "阿里云百炼",
      provider: "dashscope",
      models: [{ modelId: "fun-asr", available: true }],
      credentialStatus: "configured",
      hasCredential: true,
      inUse: false,
      createdAt: 0,
    },
  ],
};

const marksIn = (element: Element): string[] => [...element.querySelectorAll("[data-vendor-icon]")].map((mark) => mark.getAttribute("data-vendor-icon") ?? "");

async function recordRow(title: string): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId("usage-record-row");
  const row = rows.find((item) => item.textContent?.includes(title));
  if (row === undefined) throw new Error(`no record row for ${title}`);
  return row;
}

async function modelRow(modelId: string): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId("usage-model-row");
  const row = rows.find((item) => within(item).queryByRole("button", { name: new RegExp(`· ${modelId}$`) }) !== null);
  if (row === undefined) throw new Error(`no model row for ${modelId}`);
  return row;
}

async function expand(title: string): Promise<HTMLElement[]> {
  fireEvent.click(within(await recordRow(title)).getByTestId("usage-record-toggle"));
  return screen.findAllByTestId("usage-call-row");
}

/** Lines of the open breakdown tooltip, as `label value unit` text. */
function breakdownLines(): string[] {
  const breakdown = within(screen.getByTestId("usage-breakdown-tooltip")).getByTestId("usage-breakdown");
  const cells = [...(breakdown.lastElementChild?.children ?? [])].map((cell) => cell.textContent ?? "");
  const lines: string[] = [];
  for (let index = 0; index < cells.length; index += 3) lines.push(cells.slice(index, index + 3).filter((cell) => cell !== "").join(" "));
  return lines;
}

/** Moves focus as the Tab key would, so the browser treats it as keyboard focus. */
function tabTo(element: HTMLElement): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
  act(() => element.focus());
  fireEvent.keyUp(element, { key: "Tab" });
}

/** Elements of `root` that the Tab key stops at. */
function tabStops(root: Element): Element[] {
  return [...root.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")].filter((element) => element.getAttribute("tabindex") !== "-1");
}

function Probe() {
  const location = useLocation();
  return <p data-testid="probe">{location.search}</p>;
}

/** Whether the page's profile lists answer, fail, or are not there at all; they only feed the model marks. */
type ProfileLists = "listed" | "failing" | "absent";

function mount(scenario: FixtureScenario, route = "/usage", lists: ProfileLists = "listed") {
  const reply = (call: { path: string }) => usageReply(scenario, call.path) ?? { status: 404, body: {} };
  const failing = { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } };
  const api = mockApi({
    "GET /api/usage/summary": reply,
    "GET /api/usage/activities": reply,
    "GET /api/usage/calls": reply,
    "GET /api/usage/cache-observed": reply,
    ...(lists === "listed" ? { "GET /api/providers": { body: PROVIDERS }, "GET /api/asr-profiles": { body: ASR_PROFILES } } : {}),
    ...(lists === "failing" ? { "GET /api/providers": failing, "GET /api/asr-profiles": failing } : {}),
  });
  renderApp(
    <>
      <UsagePage />
      <Probe />
    </>,
    { route },
  );
  return api;
}

const search = (): URLSearchParams => new URLSearchParams(screen.getByTestId("probe").textContent ?? "");
const cell = (column: string, row: string): HTMLElement => screen.getByTestId(`usage-summary-${column}-${row}`);

/** The container's width as the page measures it; unmeasurable (zero) otherwise, which reads as a wide window. */
function containerWidth(width: number): void {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
}

beforeEach(() => {
  // Saved dates show their year only outside the current one; the scenarios are set in the year of their own "now".
  vi.spyOn(Date, "now").mockReturnValue(SCENARIO_NOW);
});

afterEach(() => {
  localStorage.clear();
});

describe("the toolbar", () => {
  it("is credential, model, currency, then the range group at the far right", async () => {
    mount(SCENARIOS.main());
    const toolbar = await screen.findByTestId("usage-toolbar");
    expect(toolbar.getAttribute("data-layout")).toBe("wide");
    expect(toolbar.className).toContain("justify-between");
    const order = [...toolbar.querySelectorAll("[data-testid]")]
      .map((element) => element.getAttribute("data-testid"))
      .filter((id) => ["usage-credential", "usage-model", "usage-currency", "usage-range"].includes(id ?? ""));
    expect(order).toEqual(["usage-credential", "usage-model", "usage-currency", "usage-range"]);
    expect(toolbar.lastElementChild?.className).toContain("justify-end");
    expect(toolbar.lastElementChild?.contains(screen.getByTestId("usage-range"))).toBe(true);
    expect(within(screen.getByTestId("usage-range")).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["24 小时", "48 小时", "7 天", "30 天", "全部"]);
  });

  it("puts the range alone on a second row of a narrow container, still right-aligned", async () => {
    containerWidth(600);
    mount(SCENARIOS.main());
    const toolbar = await screen.findByTestId("usage-toolbar");
    expect(toolbar.getAttribute("data-layout")).toBe("narrow");
    const [first, second] = [...toolbar.children];
    expect(within(first as HTMLElement).getByTestId("usage-credential")).toBeTruthy();
    expect(within(first as HTMLElement).getByTestId("usage-currency")).toBeTruthy();
    expect(within(first as HTMLElement).queryByTestId("usage-range")).toBeNull();
    expect(within(second as HTMLElement).getByTestId("usage-range")).toBeTruthy();
    expect((second as HTMLElement).className).toContain("justify-end");
  });

  it("has no native select in the page's own controls (toolbar, analysis panel, records); the shared pager is not its to change", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    for (const id of ["usage-toolbar", "usage-analysis", "usage-records", "usage-summary"]) {
      expect(screen.getByTestId(id).querySelector("select"), id).toBeNull();
    }
  });

  it("offers the filter menus the options of the range, grouped, and clears them with one button", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    expect(screen.queryByTestId("usage-clear-filters")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("usage-credential"), { key: "Enter" });
    const items = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
    // The rows carry names only, no request counts.
    expect(items).toContain("Auth2API");
    expect(items).toContain("阿里云百炼");
    // A profile with several key versions lists them, indented.
    expect(items).toContain("11-03 起");
    expect(items).toContain("早期记录（未区分密钥）");
    for (const item of screen.getAllByRole("menuitemradio")) expect(item.textContent ?? "").not.toMatch(/\d+$/);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^DeepSeek/ }));
    await waitFor(() => expect(search().get("profile")).not.toBeNull());
    expect(screen.getByTestId("usage-credential").textContent).toContain("DeepSeek");
    expect(await screen.findByTestId("usage-clear-filters")).toBeTruthy();
    fireEvent.click(screen.getByTestId("usage-clear-filters"));
    await waitFor(() => expect(search().get("profile")).toBeNull());
  });

  it("marks the chosen menu item with a bar in a slot every item keeps, and outlines the currency trigger like its siblings", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    expect(screen.getByTestId("usage-currency").className).toContain("border-line");
    expect(screen.getByTestId("usage-currency").className).not.toContain("border-transparent");
    expect(screen.getByTestId("usage-credential").className).toContain("border-line");
    fireEvent.keyDown(screen.getByTestId("usage-credential"), { key: "Enter" });
    const items = await screen.findAllByRole("menuitemradio");
    const slot = (item: HTMLElement): Element | null => item.querySelector(":scope > span.flex.w-3\\.5.shrink-0");
    const all = items.find((item) => item.textContent === "全部") as HTMLElement;
    const other = items.find((item) => item.textContent === "Auth2API") as HTMLElement;
    expect(all.getAttribute("data-state")).toBe("checked");
    expect(other.getAttribute("data-state")).toBe("unchecked");
    expect(slot(all)).not.toBeNull();
    expect(slot(other)).not.toBeNull();
    expect(slot(all)?.querySelector("span.bg-accent.rounded-full")).not.toBeNull();
    expect(slot(other)?.querySelector("span")).toBeNull();
    expect(all.className).toContain("data-[state=checked]:bg-accent-soft");
  });

  it("never squeezes a trigger that shows “all” in the wide layout; only a chosen name may shrink", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    expect(screen.getByTestId("usage-toolbar").getAttribute("data-layout")).toBe("wide");
    expect(screen.getByTestId("usage-credential").className).toContain("shrink-0");
    expect(screen.getByTestId("usage-model").className).toContain("shrink-0");
    expect(screen.getByTestId("usage-currency").className).toContain("shrink-0");
    fireEvent.keyDown(screen.getByTestId("usage-model"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "fun-asr" }));
    await waitFor(() => expect(search().get("model")).not.toBeNull());
    expect(screen.getByTestId("usage-model").className).not.toContain("shrink-0");
    expect(screen.getByTestId("usage-model").className).toContain("max-w-[260px]");
    expect(screen.getByTestId("usage-credential").className).toContain("shrink-0");
    expect(screen.getByTestId("usage-clear-filters").className).toContain("shrink-0");
  });

  it("lists only the models of the chosen credential", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    fireEvent.keyDown(screen.getByTestId("usage-credential"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^DeepSeek/ }));
    await waitFor(() => expect(search().get("profile")).not.toBeNull());
    fireEvent.keyDown(screen.getByTestId("usage-model"), { key: "Enter" });
    const models = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
    expect(models).toEqual(["全部", "deepseek-v4-chat"]);
  });
});

describe("the summary", () => {
  it("has three equal columns with the same five rows each", async () => {
    mount(SCENARIOS.main());
    const grid = await screen.findByTestId("usage-summary-grid");
    expect(grid.className).toContain("grid-cols-3");
    for (const row of ["label", "main", "bar", "caption", "extra"]) {
      for (const column of ["cost", "calls", "usage"]) expect(cell(column, row).getAttribute("data-row")).toBe(row);
    }
    expect(grid.children).toHaveLength(15);
    // Row-major order: every row lists its three columns before the next row starts, which is what lines the rows up.
    expect([...grid.children].map((child) => child.getAttribute("data-row"))).toEqual(
      ["label", "main", "bar", "caption", "extra"].flatMap((row) => [row, row, row]),
    );
    expect(cell("cost", "main").textContent).toBe("¥45.78");
    expect(cell("calls", "main").textContent).toBe("62 次");
    expect(cell("usage", "main").textContent).toBe("150.9 万 / 28.2 万tokens");
    expect(cell("cost", "caption").textContent).toBe("已计入 53 / 58 次人民币计价请求");
    expect(cell("cost", "extra").textContent).toBe("另有 4 次无历史单价");
    expect(cell("calls", "caption").textContent).toBe("成功 59失败 1未知 1");
    expect(cell("calls", "extra").textContent).toBe("已取消 1");
  });

  it("stacks into three bands in a narrow container, each with the same parts", async () => {
    containerWidth(600);
    mount(SCENARIOS.main());
    const grid = await screen.findByTestId("usage-summary-grid");
    expect(grid.getAttribute("data-layout")).toBe("narrow");
    expect([...grid.children].map((child) => child.getAttribute("data-testid"))).toEqual(["usage-summary-cost", "usage-summary-calls", "usage-summary-usage"]);
    for (const band of grid.children) expect([...band.querySelectorAll("[data-part]")].map((part) => part.getAttribute("data-part"))).toEqual(["label", "main", "bar", "caption", "extra"]);
  });

  it("switches the usage column to processed audio when only transcription was used, and shows no zero for what is absent", async () => {
    mount(SCENARIOS["asr-only"]());
    await screen.findByTestId("usage-summary-grid");
    expect(cell("usage", "main").textContent).toBe("9.1 小时");
    expect(cell("usage", "caption").textContent).toBe("处理音频");
    expect(cell("usage", "extra").textContent).toBe("ASR 计费 46.3 万 / 2.1 万 tokens");
    expect(screen.getByTestId("usage-summary-usage-main").textContent).not.toMatch(/LLM|\b0\b/);
  });

  it("is one line when the range holds no calls, and hides the other layers", async () => {
    mount(SCENARIOS.empty());
    expect((await screen.findByTestId("usage-empty")).textContent).toBe("所选时间内没有 AI 调用去设置模型");
    expect(within(screen.getByTestId("usage-empty")).getByRole("link", { name: "去设置模型" }).getAttribute("href")).toBe("/settings/models");
    expect(screen.queryByTestId("usage-analysis")).toBeNull();
    expect(screen.queryByTestId("usage-records")).toBeNull();
  });

  it("opens the cost details: reasons grouped with counts and price links, coverage, and the simulation", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    fireEvent.click(screen.getByTestId("usage-cost-detail-button"));
    const detail = await screen.findByTestId("usage-cost-detail");
    expect(within(detail).getByTestId("usage-unpriced-price").textContent).toContain("缺缓存读取单价3 次设置价格");
    expect(within(detail).getByRole("link", { name: "设置价格" }).getAttribute("href")).toBe("/settings/models");
    expect(within(detail).getByTestId("usage-unpriced-usage").textContent).toContain("结果未知，无用量");
    expect(within(detail).getByTestId("usage-unpriced-history").textContent).toContain("无历史单价：调用时未设置价格，或是升级前的记录；可设置价格，或在费用详情中按当前单价模拟4 次");
    expect(within(detail).getByTestId("usage-coverage-llmTokens").textContent).toBe("LLM tokens162.3 万 / 179.1 万");
    expect(within(detail).queryByTestId("usage-simulated")).toBeNull();
    fireEvent.click(within(detail).getByTestId("usage-simulate"));
    await waitFor(() => expect(search().get("simulate")).toBe("1"));
    const simulated = await within(await screen.findByTestId("usage-cost-detail")).findByTestId("usage-simulated");
    expect(simulated.textContent).toContain("模拟金额（按当前单价，不是历史估算）¥50.37");
    // The main estimate stays what was recorded.
    expect(cell("cost", "main").textContent).toBe("¥45.78");
  });
});

describe("the display currency", () => {
  it("changes only the money: counts and usage stay, and the other currency offers the switch", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    const before = { calls: cell("calls", "main").textContent, usage: cell("usage", "main").textContent };
    fireEvent.keyDown(screen.getByTestId("usage-currency"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "美元（USD）" }));
    await waitFor(() => expect(search().get("currency")).toBe("USD"));
    await waitFor(() => expect(cell("cost", "main").textContent).toBe("—"));
    expect(cell("calls", "main").textContent).toBe(before.calls);
    expect(cell("usage", "main").textContent).toBe(before.usage);
    const switcher = await screen.findByTestId("usage-switch-currency");
    expect(switcher.textContent).toBe("以人民币计价 · 切换查看");
    // The records say the same in their own cost cells.
    const rows = await screen.findAllByTestId("usage-record-row");
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "以人民币计价" })).toBeTruthy();
    fireEvent.click(switcher);
    await waitFor(() => expect(search().get("currency")).toBe("CNY"));
    await waitFor(() => expect(cell("cost", "main").textContent).toBe("¥45.78"));
  });

  it("starts with the history's only currency, else yuan, and remembers it", async () => {
    const main = SCENARIOS.main();
    const dollars: FixtureScenario = { ...main, calls: main.calls.map((call) => ({ ...call, price: call.price === null ? null : { ...call.price, currency: "USD" } })) };
    mount(dollars);
    await waitFor(() => expect(search().get("currency")).toBe("USD"));
    expect(localStorage.getItem(USAGE_CURRENCY_STORAGE_KEY)).toBe("USD");
    expect(screen.getByTestId("usage-currency").textContent).toContain("$ 美元");
  });

  it("starts with yuan when both currencies are in the history", async () => {
    mount(SCENARIOS.dual());
    await waitFor(() => expect(search().get("currency")).toBe("CNY"));
    expect(screen.getByTestId("usage-currency").textContent).toContain("¥ 人民币");
    expect(cell("cost", "extra").textContent).toBe("另有 26 次美元计价 · 4 次无历史单价");
  });

  it("uses the remembered currency of an earlier visit and writes it into the address", async () => {
    localStorage.setItem(USAGE_CURRENCY_STORAGE_KEY, "USD");
    mount(SCENARIOS.dual());
    await waitFor(() => expect(search().get("currency")).toBe("USD"));
    expect(await screen.findByTestId("usage-currency")).toBeTruthy();
    expect(screen.getByTestId("usage-currency").textContent).toContain("$ 美元");
  });

  it("puts only the display currency in requests, with no footnote in the menu", async () => {
    const { calls } = mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    fireEvent.keyDown(screen.getByTestId("usage-currency"), { key: "Enter" });
    expect(await screen.findByRole("menuitemradio", { name: "人民币（CNY）" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "美元（USD）" })).toBeTruthy();
    expect(screen.queryByText("只切换费用显示，不换汇")).toBeNull();
    for (const call of calls.filter((entry) => entry.path.startsWith("/api/usage/"))) {
      expect(new URL(call.path, "http://x").searchParams.get("displayCurrency")).not.toBeNull();
    }
  });
});

describe("the analysis panel", () => {
  it("switches between the trend and the by-model view, with the controls of each in its own header row", async () => {
    mount(SCENARIOS.main());
    const panel = await screen.findByTestId("usage-analysis");
    const controls = within(panel).getByTestId("usage-analysis-controls");
    expect(within(controls).getByTestId("usage-metric")).toBeTruthy();
    expect(within(controls).getByTestId("usage-granularity")).toBeTruthy();
    expect(within(controls).getByRole("button", { name: "以表格查看" })).toBeTruthy();
    const models = within(panel).getByRole("tab", { name: "按模型" });
    fireEvent.mouseDown(models);
    fireEvent.click(models);
    await waitFor(() => expect(search().get("view")).toBe("models"));
    expect(within(await screen.findByTestId("usage-analysis-controls")).getByTestId("usage-sort")).toBeTruthy();
    expect(within(screen.getByTestId("usage-analysis-controls")).queryByTestId("usage-granularity")).toBeNull();
    expect(screen.getAllByTestId("usage-model-row")).toHaveLength(5);
  });

  it("a row of the by-model view becomes the model filter, and the toolbar follows", async () => {
    mount(SCENARIOS.main(), "/usage?view=models");
    const rows = await screen.findAllByTestId("usage-model-row");
    expect(rows).toHaveLength(5);
    const target = rows.find((row) => row.textContent?.includes("deepseek-v4-chat")) as HTMLElement;
    fireEvent.click(target);
    await waitFor(() => expect(search().get("model")).toBe(encodeModelKey(["llm", "deepseek", "deepseek-v4-chat"])));
    expect(screen.getByTestId("usage-model").textContent).toBe("模型：DeepSeek · deepseek-v4-chat");
    await waitFor(() => expect(screen.getAllByTestId("usage-model-row")).toHaveLength(1));
    expect(cell("calls", "main").textContent).toBe("4 次");
  });

  it("greys out a bucket size the range is too long for, and says why", async () => {
    mount(SCENARIOS.main(), "/usage?range=all");
    const group = await screen.findByTestId("usage-granularity");
    const hour = within(group).getByRole("radio", { name: "时" });
    expect(hour.getAttribute("aria-disabled")).toBe("true");
    expect(hour.getAttribute("title")).toBe("范围过长，点柱子可以放大查看");
    fireEvent.click(hour);
    expect(search().get("granularity")).toBeNull();
    expect(within(group).getByRole("radio", { name: "月" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the table view with the same numbers as the chart", async () => {
    mount(SCENARIOS.main(), "/usage?range=30d&granularity=day");
    await screen.findByTestId("usage-chart");
    const chartTotals = [...document.querySelectorAll('[data-testid="usage-bar"]')].map((bar) => bar.getAttribute("data-total"));
    fireEvent.click(screen.getByRole("button", { name: "以表格查看" }));
    const totals = (await screen.findAllByTestId("usage-trend-total")).map((total) => total.textContent);
    expect(totals).toHaveLength(chartTotals.length);
    const expected = chartTotals.map((total) => `¥${(Math.round(Number(total) * 100) / 100).toFixed(2)}`.replace(/^¥0\.00$/, "¥0.00"));
    expect(totals).toEqual(expected);
    expect(screen.queryByTestId("usage-chart")).toBeNull();
    // Each period is one row and each series one column, with the total last.
    const headers = within(screen.getByTestId("usage-trend-table")).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers[0]).toBe("时段");
    expect(headers.at(-1)).toBe("合计");
  });

  it("tells apart in the table the same model id under two profiles", async () => {
    const price = { currency: "CNY" as const, inputPerMillion: 4, outputPerMillion: 16 };
    const first = model(profile("relay-a", "llm", "中转站甲", [["a-v1", beijing(2026, 10, 1)]]), "claude-opus-5-5", price);
    const second = model(profile("relay-b", "llm", "中转站乙", [["b-v1", beijing(2026, 10, 1)]]), "claude-opus-5-5", price);
    const owner = group("twin", "task", "同名模型", "content-twin");
    const calls = [first, second].flatMap((target, index) => [llmCall(owner, target, "proofread", beijing(2026, 11, 5, 9 + index), { input: 1000, output: 500 })]);
    mount({ id: "twin-models", now: SCENARIO_NOW, calls, cacheObserved: [] }, "/usage?range=30d&granularity=day");
    await screen.findByTestId("usage-chart");
    fireEvent.click(screen.getByRole("button", { name: "以表格查看" }));
    const headers = within(await screen.findByTestId("usage-trend-table")).getAllByRole("columnheader");
    const names = headers.slice(1, -1).map((header) => header.getAttribute("title"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(headers.slice(1, -1).map((header) => header.textContent)).toEqual(["中转站甲·claude-opus-5-5", "中转站乙·claude-opus-5-5"]);
  });

  it("clicking a legend entry makes it the model filter", async () => {
    mount(SCENARIOS.main(), "/usage?range=30d");
    const legend = await screen.findByTestId("usage-legend");
    const entry = within(legend).getAllByTestId("usage-legend-item").find((item) => item.textContent?.includes("deepseek-v4-chat")) as HTMLElement;
    fireEvent.click(entry);
    await waitFor(() => expect(search().get("model")).toBe(encodeModelKey(["llm", "deepseek", "deepseek-v4-chat"])));
  });

  it("opens a bucket into finer buckets from the keyboard, and the breadcrumb leads back", async () => {
    mount(SCENARIOS.main(), "/usage?range=30d&granularity=day");
    const chart = await screen.findByTestId("usage-chart");
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(await screen.findByTestId("usage-tooltip")).toBeTruthy();
    fireEvent.keyDown(chart, { key: "Enter" });
    await waitFor(() => expect(search().get("range")).toBe("custom"));
    expect(search().get("granularity")).toBe("hour");
    const crumb = await screen.findByTestId("usage-breadcrumb");
    expect(crumb.textContent).toContain("全部");
    fireEvent.click(within(crumb).getByRole("button", { name: "全部" }));
    await waitFor(() => expect(search().get("range")).toBe("all"));
    expect(search().get("from")).toBeNull();
  });

  it("lists every series of the bucket under the keyboard, largest first, with the total", async () => {
    mount(SCENARIOS.main(), "/usage?range=30d&granularity=day");
    const chart = await screen.findByTestId("usage-chart");
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    const tooltip = await screen.findByTestId("usage-tooltip");
    const values = [...tooltip.querySelectorAll("li")].map((row) => Number(/¥([\d,.]+)/.exec(row.textContent ?? "")?.[1]?.replaceAll(",", "")));
    expect(values.length).toBeGreaterThan(1);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(tooltip.textContent).toContain("合计");
    fireEvent.keyDown(chart, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("usage-tooltip")).toBeNull());
  });
});

describe("the records", () => {
  it("lists each activity with its title, uses, models and the number of items", async () => {
    mount(SCENARIOS.main());
    const rows = await screen.findAllByTestId("usage-record-row");
    expect(rows).toHaveLength(10);
    expect(screen.getByTestId("usage-records").textContent).toContain("共 12 项");
    const first = rows[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: "第 3 讲：注意力机制与 Transformer" }).getAttribute("href")).toBe("/contents/content-attention");
    expect(first.textContent).toContain("联网搜索规划、对话 · gpt-5.6-sol");
    expect(rows[1]?.textContent).toContain("语音转写、AI 校对等 4 项 · gpt-5.6-sol 等 3 个 · 2 个密钥版本");
    // A mixed-modality task shows its LLM tokens, billed ASR tokens and audio, and a failed call shows its badge.
    expect(rows[1]?.querySelectorAll('[data-testid="usage-cell"] p')).toHaveLength(3);
    expect(within(rows[2] as HTMLElement).getByTestId("usage-badge-failed").textContent).toBe("失败 1");
    expect(within(rows[2] as HTMLElement).getByTestId("usage-badge-unknown").textContent).toBe("未知 1");
  });

  it("expands from the keyboard into one row per call on the parent's columns, each with its own cost", async () => {
    mount(SCENARIOS.main());
    const first = (await screen.findAllByTestId("usage-record-row"))[0] as HTMLElement;
    const toggle = within(first).getByTestId("usage-record-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const calls = await screen.findAllByTestId("usage-call-row");
    expect(calls).toHaveLength(3);
    // The same table, so the same column template; and the same number of cells.
    for (const call of calls) {
      expect(call.closest("table")).toBe(first.closest("table"));
      expect(call.querySelectorAll("td")).toHaveLength(first.querySelectorAll("td").length);
    }
    expect(calls.map((call) => (call.querySelectorAll("td")[4] as HTMLElement).textContent)).toEqual(["¥0.01", "¥0.70", "¥0.36"]);
    expect((calls[0]?.querySelectorAll("td")[0] as HTMLElement).textContent).toBe("09:52:00");
    expect(within(calls[0] as HTMLElement).getByTestId("usage-call-result").textContent).toBe("成功");
    // The profile had two keys in the range, so the call names the one it used.
    expect(within(calls[0] as HTMLElement).getByTestId("usage-call-model").textContent).toBe("Auth2API · gpt-5.6-sol密钥 · 11-03 起");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryAllByTestId("usage-call-row")).toHaveLength(0));
  });

  it("names the tested model on a test row instead of repeating the title", async () => {
    mount(SCENARIOS.main());
    const rows = await screen.findAllByTestId("usage-record-row");
    const test = rows.find((row) => row.getAttribute("data-kind") === "test") as HTMLElement;
    expect(within(test).getByText("测试连接")).toBeTruthy();
    expect(within(test).getByText("Auth2API · claude-sonnet-4-5")).toBeTruthy();
    expect(test.textContent?.match(/测试连接/g)).toHaveLength(1);
  });

  it("mutes a day of calls whose content is gone and does not link it", async () => {
    mount(SCENARIOS.deleted(), "/usage?range=30d&pageSize=50");
    const rows = await screen.findAllByTestId("usage-record-row");
    const gone = rows.find((row) => row.getAttribute("data-kind") === "deleted_day") as HTMLElement;
    expect(gone.textContent).toContain("已删除内容的调用");
    expect(gone.textContent).toContain("当日汇总，可能来自多个任务");
    expect(within(gone).queryByRole("link")).toBeNull();
    expect(within(gone).getByText("已删除内容的调用").className).toContain("text-muted");
  });

  it("says why a call is left out of the estimate and keeps the old record's currency unknown", async () => {
    mount(SCENARIOS.deleted(), "/usage?range=30d&pageSize=50");
    const rows = await screen.findAllByTestId("usage-record-row");
    const legacy = rows.find((row) => row.textContent?.includes("升级前转写的内容")) as HTMLElement;
    expect(within(legacy).getByTestId("usage-cost-cell").textContent).toBe("—无历史单价");
  });

  it("marks the profile of a call as deleted in the expanded rows", async () => {
    mount(SCENARIOS.deleted(), "/usage?range=30d&pageSize=50");
    const rows = await screen.findAllByTestId("usage-record-row");
    const gone = rows.find((row) => row.textContent?.includes("旧中转站处理过的课程")) as HTMLElement;
    fireEvent.click(within(gone).getByTestId("usage-record-toggle"));
    const calls = await screen.findAllByTestId("usage-call-row");
    expect((calls[0]?.querySelectorAll("td")[1] as HTMLElement).textContent).toContain("旧中转站（已删除）");
  });

  it("pages through the pager and keeps the page in the address", async () => {
    mount(SCENARIOS.main());
    await screen.findAllByTestId("usage-record-row");
    const pager = screen.getByRole("navigation", { name: "分页" });
    // The pager is the shared one, below the scrolling content, not inside the records section.
    expect(screen.getByTestId("usage-records").contains(pager)).toBe(false);
    expect(pager.className).toContain("border-t");
    fireEvent.click(within(pager).getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(search().get("page")).toBe("2"));
    await waitFor(() => expect(screen.getAllByTestId("usage-record-row")).toHaveLength(2));
  });

  it("returns to the first page when a filter changes", async () => {
    mount(SCENARIOS.main(), "/usage?page=2&pageSize=10");
    await screen.findAllByTestId("usage-record-row");
    fireEvent.click(within(screen.getByTestId("usage-range")).getByRole("radio", { name: "30 天" }));
    await waitFor(() => expect(search().get("range")).toBe("30d"));
    expect(search().get("page")).toBeNull();
  });
});

describe("states", () => {
  it("shows skeletons shaped like the content while loading", async () => {
    mount({ ...SCENARIOS.main(), delayMs: 200 });
    expect(await screen.findByTestId("usage-summary-skeleton")).toBeTruthy();
    expect(screen.getByTestId("usage-analysis-skeleton")).toBeTruthy();
    expect(screen.getAllByTestId("usage-record-skeleton")).toHaveLength(5);
    // The skeleton is made of the same rows as the summary it stands in for.
    expect(within(screen.getByTestId("usage-summary-skeleton")).getAllByTestId("usage-summary-skeleton-cost-main")).toHaveLength(1);
    expect(await screen.findByTestId("usage-summary", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("shows the failure in place with a retry that asks again", async () => {
    const calls: string[] = [];
    let failing = true;
    mockApi({
      "GET /api/usage/summary": (call) => {
        calls.push(call.path);
        return failing ? { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } } : (usageReply(SCENARIOS.main(), call.path) as { status: number; body: unknown });
      },
      "GET /api/usage/activities": (call) => usageReply(SCENARIOS.main(), call.path) as { status: number; body: unknown },
    });
    renderApp(<UsagePage />, { route: "/usage" });
    const error = await screen.findByTestId("usage-error");
    expect(error.textContent).toContain("重试");
    failing = false;
    fireEvent.click(within(error).getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("usage-summary")).toBeTruthy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the basis popover", () => {
  it("opens from the header button with every point and closes on Escape", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    const button = screen.getByRole("button", { name: /统计口径/ });
    fireEvent.click(button);
    const popover = await screen.findByTestId("usage-basis");
    expect(within(popover).getAllByRole("listitem")).toHaveLength(8);
    expect(popover.textContent).toContain("不是账单，也不是余额");
    expect(popover.textContent).toContain("币种只影响费用的显示，不换汇");
    expect(popover.textContent).toContain("联网搜索的费用不计入");
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("usage-basis")).toBeNull());
  });

  it("names the page in the document title", async () => {
    mount(SCENARIOS.main());
    await screen.findByTestId("usage-summary-grid");
    expect(document.title).toBe("AI 使用量 - Amber");
  });
});

describe("the usage breakdown of a record", () => {
  it("shows on hovering the usage: what input and output include, indented, with zero parts left out", async () => {
    mount(twoKeys());
    const row = await recordRow("GPT 任务");
    fireEvent.pointerMove(within(row).getByTestId("usage-record-usage"));
    const tooltip = await screen.findByTestId("usage-breakdown-tooltip");
    expect(within(tooltip).getByText("已记录的用量")).toBeTruthy();
    expect(breakdownLines()).toEqual(["输入 1,848 tokens", "其中缓存读取 207", "其中缓存写入 120", "输出 189 tokens", "其中推理 64"]);
    expect(tooltip.textContent).not.toContain("1 小时");
    expect(within(tooltip).getByTestId("usage-breakdown-cacheRead").className).toContain("pl-3");
    expect(within(tooltip).getByTestId("usage-breakdown-input").className).not.toContain("pl-");
  });

  it("shows while the row's expand button has keyboard focus, without adding a stop to the Tab order", async () => {
    mount(twoKeys());
    const row = await recordRow("GPT 任务");
    const toggle = within(row).getByTestId("usage-record-toggle");
    const before = tabStops(row);
    expect(before).toContain(toggle);
    tabTo(toggle);
    expect(await screen.findByTestId("usage-breakdown-tooltip")).toBeTruthy();
    expect(tabStops(row)).toEqual(before);
    expect(tabStops(screen.getByTestId("usage-breakdown-tooltip"))).toEqual([]);
    expect(within(row).getByTestId("usage-record-usage").hasAttribute("tabindex")).toBe(false);
    // A screen reader hears the same as the tooltip says, as the button's description.
    const description = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("已记录的用量：输入 1,848 tokens，其中缓存读取 207，其中缓存写入 120，输出 189 tokens，其中推理 64");
    act(() => toggle.blur());
    await waitFor(() => expect(screen.queryByTestId("usage-breakdown-tooltip")).toBeNull());
  });

  it("closes on Escape", async () => {
    mount(twoKeys());
    const toggle = within(await recordRow("GPT 任务")).getByTestId("usage-record-toggle");
    tabTo(toggle);
    await screen.findByTestId("usage-breakdown-tooltip");
    fireEvent.keyDown(toggle, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("usage-breakdown-tooltip")).toBeNull());
  });

  it("is not a way into the row: a click on the tooltip neither expands the record nor filters", async () => {
    mount(twoKeys());
    const row = await recordRow("GPT 任务");
    const toggle = within(row).getByTestId("usage-record-toggle");
    tabTo(toggle);
    const tooltip = await screen.findByTestId("usage-breakdown-tooltip");
    fireEvent.pointerDown(within(tooltip).getByText("已记录的用量"));
    fireEvent.click(within(tooltip).getByText("已记录的用量"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("usage-call-row")).toHaveLength(0);
  });

  it("says a transcription's audio is what Amber measured, and lists billed tokens when the service reported them", async () => {
    mount(SCENARIOS["asr-only"]());
    const row = await recordRow("第 2 讲：线性代数回顾");
    fireEvent.pointerMove(within(row).getByTestId("usage-record-usage"));
    await screen.findByTestId("usage-breakdown-tooltip");
    const lines = breakdownLines();
    expect(lines[0]).toBe("处理音频 1:37:00 （Amber 测得的音频时长）");
    expect(lines.slice(1).map((line) => line.split(" ")[0])).toEqual(["计费输入", "计费输出"]);
    const plain = await recordRow("第 1 讲：课程导论");
    fireEvent.pointerLeave(within(row).getByTestId("usage-record-usage"));
    fireEvent.pointerMove(within(plain).getByTestId("usage-record-usage"));
    await waitFor(() => expect(breakdownLines()).toEqual(["处理音频 41:00 （Amber 测得的音频时长）"]));
  });
});

describe("the parts of a single call", () => {
  it("are written on the call's own row with no interaction, and a call without parts takes no extra line", async () => {
    mount(twoKeys());
    const calls = await expand("GPT 任务");
    expect(calls).toHaveLength(2);
    expect(within(calls[0] as HTMLElement).getByTestId("usage-call-detail").textContent).toBe("缓存读取 207 · 缓存写入 120 · 推理 64");
    expect(within(calls[1] as HTMLElement).queryByTestId("usage-call-detail")).toBeNull();
    // The wide row keeps its height: the second line fits in it.
    expect((calls[0] as HTMLElement).className).toContain("h-12");
    // A screen reader reads the exact numbers in the usage cell, not the compact ones.
    const usage = within(calls[0] as HTMLElement).getByTestId("usage-call-usage");
    expect(usage.querySelector(".sr-only")?.textContent).toBe("输入 1,348 tokens，其中缓存读取 207，其中缓存写入 120，输出 139 tokens，其中推理 64");
  });

  it("says when the upstream sent no input count", async () => {
    mount(twoKeys());
    const [call] = await expand("DeepSeek 对话");
    expect(within(call as HTMLElement).getByTestId("usage-call-detail").textContent).toBe("上游未返回输入用量");
  });

  it("gives the exact numbers on hovering the call's usage", async () => {
    mount(twoKeys());
    const [call] = await expand("GPT 任务");
    fireEvent.pointerMove(within(call as HTMLElement).getByTestId("usage-call-usage"));
    await screen.findByTestId("usage-breakdown-tooltip");
    expect(breakdownLines()).toEqual(["输入 1,348 tokens", "其中缓存读取 207", "其中缓存写入 120", "输出 139 tokens", "其中推理 64"]);
  });

  it("puts the parts on the last line of a narrow row", async () => {
    containerWidth(600);
    mount(twoKeys());
    const [call] = await expand("GPT 任务");
    const content = (call as HTMLElement).querySelectorAll("td")[1] as HTMLElement;
    expect(content.lastElementChild?.getAttribute("data-testid")).toBe("usage-call-detail");
    expect(content.querySelector(".sr-only")?.textContent).toContain("输入 1,348 tokens");
  });
});

describe("the span under a record's time", () => {
  it("reads 「跨度」 in a wide row, with what it means for the pointer and for screen readers", async () => {
    mount(twoKeys());
    const span = within(await recordRow("GPT 任务")).getByTestId("usage-record-span");
    expect(span.textContent).toBe("跨度 10 秒调用跨度：本组第一次与最后一次调用相隔的时间，不是任务的总耗时");
    expect(span.querySelector(".sr-only")?.textContent).toBe("调用跨度：本组第一次与最后一次调用相隔的时间，不是任务的总耗时");
    // It may wrap within the time column rather than run into the content column.
    expect(span.className).not.toContain("whitespace-nowrap");
    fireEvent.pointerMove(span);
    expect((await screen.findByTestId("usage-span-tooltip")).textContent).toBe("调用跨度：本组第一次与最后一次调用相隔的时间，不是任务的总耗时");
  });

  it("keeps the bare value in the narrow time column", async () => {
    containerWidth(600);
    mount(twoKeys());
    const span = within(await recordRow("GPT 任务")).getByTestId("usage-record-span");
    expect(span.firstChild?.textContent).toBe("10 秒");
  });

  it("is not shown for a single call", async () => {
    mount(twoKeys());
    expect(within(await recordRow("Claude 任务")).queryByTestId("usage-record-span")).toBeNull();
  });
});

describe("credential versions in the records", () => {
  it("names the early records apart, without the key prefix, and keeps the record's version count", async () => {
    mount(SCENARIOS.main(), "/usage?range=30d&pageSize=50");
    const calls = await expand("提示词工程：结构化输出与约束");
    expect(within(calls[0] as HTMLElement).getByTestId("usage-version-tag").textContent).toBe("早期记录（未区分密钥）");
    expect((await recordRow("Scaling Laws")).textContent).toContain("2 个密钥版本");
  });
});

describe("model marks in the records", () => {
  it("marks a record of one model, the calls and the model menu, but not a record of several models nor the legend", async () => {
    mount(SCENARIOS.main(), "/usage?range=30d");
    const rows = await screen.findAllByTestId("usage-record-row");
    expect(marksIn(rows[0] as HTMLElement)).toEqual(["openai"]);
    expect(rows[1]?.textContent).toContain("等 3 个");
    expect(marksIn(rows[1] as HTMLElement)).toEqual([]);
    expect(marksIn(await screen.findByTestId("usage-legend"))).toEqual([]);
    const calls = await expand("第 3 讲：注意力机制与 Transformer");
    for (const call of calls) expect(marksIn(call)).toHaveLength(1);
    fireEvent.keyDown(screen.getByTestId("usage-model"), { key: "Enter" });
    const items = await screen.findAllByRole("menuitemradio");
    const models = items.filter((item) => item.textContent !== "全部");
    expect(models.length).toBeGreaterThan(0);
    for (const item of models) expect(marksIn(item)).toHaveLength(1);
    expect(marksIn(items.find((item) => item.textContent === "全部") as HTMLElement)).toEqual([]);
    // The mark is decorative: the entry is still named by the model alone.
    expect(screen.getByRole("menuitemradio", { name: "claude-sonnet-4-5" })).toBeTruthy();
  });
});

describe("the usage breakdown of a model", () => {
  it("shows on hovering the usage and while the model button has keyboard focus, described to screen readers", async () => {
    mount(twoKeys(), "/usage?view=models");
    const row = await modelRow("gpt-5.6-sol");
    const button = within(row).getByRole("button", { name: /gpt-5\.6-sol$/ });
    const before = tabStops(row);
    tabTo(button);
    await screen.findByTestId("usage-breakdown-tooltip");
    expect(breakdownLines()[0]).toBe("输入 1,848 tokens");
    expect(tabStops(row)).toEqual(before);
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toContain("已记录的用量：输入 1,848 tokens");
    act(() => button.blur());
    await waitFor(() => expect(screen.queryByTestId("usage-breakdown-tooltip")).toBeNull());
    fireEvent.pointerMove(within(row).getByTestId("usage-model-usage"));
    expect(await screen.findByTestId("usage-breakdown-tooltip")).toBeTruthy();
  });

  it("does not set the model filter when the tooltip is clicked", async () => {
    mount(twoKeys(), "/usage?view=models");
    const row = await modelRow("gpt-5.6-sol");
    tabTo(within(row).getByRole("button", { name: /gpt-5\.6-sol$/ }));
    const tooltip = await screen.findByTestId("usage-breakdown-tooltip");
    fireEvent.click(within(tooltip).getByText("已记录的用量"));
    expect(search().get("model")).toBeNull();
  });
});

describe("credential versions", () => {
  const relayKey = encodeProfileKey(["llm", "relay"]);
  it("tags each row of a profile with two keys with only the key it used, and leaves a single-key profile untagged", async () => {
    mount(twoKeys(), "/usage?view=models");
    expect(within(await modelRow("gpt-5.6-sol")).getByTestId("usage-version-tag").textContent).toBe("密钥 · 11-02 起");
    expect(within(await modelRow("claude-sonnet-4-5")).getByTestId("usage-version-tag").textContent).toBe("密钥 · 11-04 起");
    expect(within(await modelRow("deepseek-v4-chat")).queryByTestId("usage-version-tag")).toBeNull();
  });

  it("keeps the tag, unchanged, when filtering by that key", async () => {
    mount(twoKeys(), `/usage?view=models&profile=${relayKey}&credential=relay-old`);
    const rows = await screen.findAllByTestId("usage-model-row");
    await waitFor(() => expect(screen.getAllByTestId("usage-model-row")).toHaveLength(1));
    expect(rows[0]?.textContent).toContain("gpt-5.6-sol");
    expect(within(await modelRow("gpt-5.6-sol")).getByTestId("usage-version-tag").textContent).toBe("密钥 · 11-02 起");
    expect(screen.getByTestId("usage-credential").textContent).toBe("凭据：Auth2API · 11-02 起");
  });

  it("keeps the tag when filtering by the model", async () => {
    mount(twoKeys(), `/usage?view=models&model=${encodeModelKey(["llm", "relay", "claude-sonnet-4-5"])}`);
    await waitFor(() => expect(screen.getAllByTestId("usage-model-row")).toHaveLength(1));
    expect(within(await modelRow("claude-sonnet-4-5")).getByTestId("usage-version-tag").textContent).toBe("密钥 · 11-04 起");
  });

  it("names a version the same in the credential menu, the by-model rows and the call rows", async () => {
    mount(twoKeys(), "/usage?view=models");
    const rowTag = within(await modelRow("gpt-5.6-sol")).getByTestId("usage-version-tag").textContent;
    const [call] = await expand("GPT 任务");
    const callTag = within(call as HTMLElement).getByTestId("usage-version-tag").textContent;
    fireEvent.keyDown(screen.getByTestId("usage-credential"), { key: "Enter" });
    const items = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
    expect([...items].sort()).toEqual(["11-02 起", "11-04 起", "Auth2API", "DeepSeek", "全部"].sort());
    expect(rowTag).toBe("密钥 · 11-02 起");
    expect(callTag).toBe(rowTag);
  });

  it("explains on hover when the key was saved, and shows nothing of the key", async () => {
    mount(twoKeys(), "/usage?view=models");
    const tag = within(await modelRow("gpt-5.6-sol")).getByTestId("usage-version-tag");
    fireEvent.pointerMove(tag);
    expect((await screen.findByTestId("usage-version-hint")).textContent).toBe("这把 API Key 保存于 2026 年 11 月 2 日 10:00；这里统计的是使用它的调用");
    expect(tag.textContent).not.toContain("relay-old");
  });

  it("shows the year of a key saved in another year", async () => {
    const scenario = twoKeys();
    const lastYear = { ...scenario, calls: scenario.calls.map((call) => (call.version === "relay-old" ? { ...call, model: { ...call.model, profile: { ...call.model.profile, versions: [{ id: "relay-old", setAt: beijing(2025, 12, 30) }, { id: "relay-new", setAt: SAVED_NEW }] } } } : call)) };
    mount(lastYear, "/usage?view=models");
    expect(within(await modelRow("gpt-5.6-sol")).getByTestId("usage-version-tag").textContent).toBe("密钥 · 2025-12-30 起");
  });
});

describe("model marks in the by-model view", () => {
  it("marks the by-model rows by model name, and transcription by its service", async () => {
    mount(SCENARIOS.main(), "/usage?view=models");
    await waitFor(() => expect(marksIn(screen.getByTestId("usage-models"))).toHaveLength(5));
    expect(marksIn(await modelRow("claude-sonnet-4-5"))).toEqual(["claude"]);
    expect(marksIn(await modelRow("gpt-5.6-sol"))).toEqual(["openai"]);
    expect(marksIn(await modelRow("deepseek-v4-chat"))).toEqual(["deepseek"]);
    await waitFor(async () => expect(marksIn(await modelRow("fun-asr"))).toEqual(["dashscope"]));
  });
});

describe("model marks", () => {
  it("falls back to the profile's service for a name it does not know", async () => {
    mount(unnamed(), "/usage?view=models");
    await waitFor(async () => expect(marksIn(await modelRow("house-model"))).toEqual(["kimi"]));
    expect(marksIn(await modelRow("fun-asr"))).toEqual(["dashscope"]);
  });

  it("uses the neutral mark when the profile lists fail, and the numbers stay", async () => {
    mount(unnamed(), "/usage?view=models", "failing");
    const row = await modelRow("house-model");
    expect(marksIn(row)).toEqual(["neutral"]);
    expect(marksIn(await modelRow("fun-asr"))).toEqual(["neutral"]);
    expect(within(row).getByTestId("usage-model-usage").textContent).toContain("100 / 10");
    expect(within(row).getByTestId("usage-cost-cell").textContent).toBe("< ¥0.01");
  });

  it("still marks a deleted profile's model by its name, an unidentifiable transcription neutrally, and shows their numbers", async () => {
    mount(SCENARIOS.deleted(), "/usage?view=models&range=30d", "absent");
    const gone = await modelRow("gpt-5-mini");
    expect(gone.textContent).toContain("旧中转站（已删除）");
    expect(marksIn(gone)).toEqual(["openai"]);
    expect(within(gone).getByTestId("usage-model-usage").textContent).not.toBe("—");
    const rows = await screen.findAllByTestId("usage-model-row");
    const historic = rows.find((row) => row.textContent?.includes("历史档案不可区分")) as HTMLElement;
    expect(marksIn(historic)).toEqual(["neutral"]);
    expect(within(historic).getByTestId("usage-model-usage").textContent).toContain("55:00");
  });
});
