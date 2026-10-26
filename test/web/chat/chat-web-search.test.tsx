import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { WebSourceDto } from "../../../src/shared/dto/chat.ts";
import { WebSearchStatusLine, WebSearchToggle, type WebSearchView } from "../../../src/web/chat/chat-web-search.tsx";

const SOURCES: WebSourceDto[] = [
  { id: "w1", index: 1, url: "https://news.example/a", title: "第一篇报道", excerpt: "", publishedAt: Date.UTC(2026, 9, 25, 17, 0), fetchedAt: 1 },
  { id: "w2", index: 2, url: "https://blog.example/b", title: "第二篇", excerpt: "", fetchedAt: 1 },
];

const status = (view: WebSearchView) => {
  render(<WebSearchStatusLine view={view} />);
  return screen.getByTestId("chat-search-status");
};

describe("WebSearchStatusLine", () => {
  it("names the queries while searching", () => {
    expect(status({ phase: "searching", queries: ["A 股 今日", "汇率"] }).textContent).toBe("正在搜索：A 股 今日 · 汇率");
  });

  it("counts the sources and lists them on request, each opening in a new window", () => {
    const line = status({ phase: "done", status: "searched", sources: SOURCES });
    expect(line.textContent).toContain("搜索到 2 个来源");
    expect(screen.queryByTestId("chat-sources")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-sources-toggle"));
    const links = screen.getAllByTestId("chat-source-link");
    expect(links.map((link) => link.textContent)).toEqual(["第一篇报道", "第二篇"]);
    expect(links.every((link) => link.getAttribute("target") === "_blank" && link.getAttribute("rel") === "noopener noreferrer")).toBe(true);
    const list = screen.getByTestId("chat-sources").textContent ?? "";
    expect(list).toContain("[1]");
    expect(list).toContain("news.example");
    // The publish date reads in Beijing time.
    expect(list).toContain("2026-10-26");
  });

  it("says when some queries failed", () => {
    expect(status({ phase: "done", status: "partial", sources: SOURCES.slice(0, 1) }).textContent).toContain("部分查询失败，搜索到 1 个来源");
  });

  it("explains why no web material was used, and makes a failed search stand out", () => {
    const failed = status({
      phase: "done",
      status: "failed",
      sources: [],
      error: { class: "web_search_failed", code: "web_search_failed.quota", retryDisposition: "never", userMessage: "联网搜索服务的额度已用完" },
    });
    expect(failed.textContent).toBe("本轮未取得网页资料：联网搜索服务的额度已用完");
    expect(failed.querySelector(".text-danger")).not.toBeNull();
  });

  it.each([
    ["skipped", "not_needed", "本轮未取得网页资料：模型判断这一问无需联网"],
    ["skipped", "unconfigured", "本轮未取得网页资料：未配置联网搜索服务"],
    ["skipped", "planner_failed", "本轮未取得网页资料：未能规划搜索查询"],
    ["dropped", "budget", "本轮未取得网页资料：上下文空间不足，网页资料未送入模型"],
  ] as const)("names the reason of a %s search (%s)", (state, reason, text) => {
    const line = status({ phase: "done", status: state, reason, sources: [] });
    expect(line.textContent).toBe(text);
    expect(line.querySelector(".text-danger")).toBeNull();
  });
});

describe("WebSearchToggle", () => {
  it("offers off, auto and this-message-only", () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <WebSearchToggle mode="auto" available onChange={onChange} />
      </MemoryRouter>,
    );
    const trigger = screen.getByTestId("chat-web-search");
    expect(trigger.getAttribute("data-mode")).toBe("auto");
    expect(trigger.textContent).toContain("自动");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((item) => item.querySelector(".flex-col > span")?.textContent)).toEqual(["关闭", "自动", "本轮搜索"]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    fireEvent.click(screen.getByTestId("chat-web-search-force"));
    expect(onChange).toHaveBeenCalledWith("force");
  });

  it("is greyed out with a way to the settings when no search service is configured", () => {
    render(
      <MemoryRouter>
        <WebSearchToggle mode="off" available={false} onChange={() => undefined} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId("chat-web-search") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("chat-web-search-configure").getAttribute("href")).toBe("/settings/web-search");
  });
});
