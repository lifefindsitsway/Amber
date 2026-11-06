import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeModelKey } from "../../../../src/shared/dto/usage-analytics.ts";
import { UsagePage } from "../../../../src/web/pages/usage/usage-page.tsx";
import { USAGE_CURRENCY_STORAGE_KEY } from "../../../../src/web/pages/usage/usage-state.ts";
import { usageReply } from "../../../fixtures/usage/handler.ts";
import { beijing, group, llmCall, model, profile, SCENARIO_NOW } from "../../../fixtures/usage/builders.ts";
import { SCENARIOS } from "../../../fixtures/usage/scenarios.ts";
import type { FixtureScenario } from "../../../fixtures/usage/types.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

function Probe() {
  const location = useLocation();
  return <p data-testid="probe">{location.search}</p>;
}

function mount(scenario: FixtureScenario, route = "/usage") {
  const reply = (call: { path: string }) => usageReply(scenario, call.path) ?? { status: 404, body: {} };
  const api = mockApi({
    "GET /api/usage/summary": reply,
    "GET /api/usage/activities": reply,
    "GET /api/usage/calls": reply,
    "GET /api/usage/cache-observed": reply,
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
    expect((calls[0]?.querySelectorAll("td")[1] as HTMLElement).textContent).toBe("Auth2API · gpt-5.6-sol · 11-03 起");
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
    expect(within(popover).getAllByRole("listitem")).toHaveLength(7);
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
