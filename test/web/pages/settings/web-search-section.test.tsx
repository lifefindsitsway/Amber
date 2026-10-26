import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebSearchSection } from "../../../../src/web/pages/settings/web-search-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const KEY = "tvly-<placeholder>";

/** A web search profile that the writes below change, as the server would. */
function setup(initial: { service?: "tavily"; credentialStatus: "missing" | "configured" | "unavailable" }, test?: { status: number; body: unknown }) {
  let profile = initial;
  const api = mockApi({
    "GET /api/web-search": () => ({ body: profile }),
    "PUT /api/web-search": (call) => {
      profile = { ...profile, service: (call.body as { service: "tavily" }).service };
      return { body: profile };
    },
    "PUT /api/web-search/credential": () => {
      profile = { ...profile, credentialStatus: "configured" };
      return { body: profile };
    },
    "DELETE /api/web-search": () => {
      profile = { credentialStatus: "missing" };
      return { status: 204 };
    },
    "POST /api/web-search/test": test ?? { body: { ok: true, resultCount: 5 } },
  });
  renderApp(<WebSearchSection />);
  return api;
}

describe("WebSearchSection", () => {
  it("sets a key for a service that was never chosen, never showing the key, and can then test it", async () => {
    const { calls } = setup({ credentialStatus: "missing" });
    expect((await screen.findByTestId("web-search-credential")).textContent).toBe("未配置");
    expect((screen.getByTestId("web-search-service") as HTMLSelectElement).value).toBe("tavily");
    expect((screen.getByTestId("web-search-test") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("web-search-test-hint").textContent).toContain("消耗一次搜索额度");

    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByTestId("web-search-credential").textContent).toBe("已配置"));
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /api/web-search", "PUT /api/web-search/credential"]);
    expect(writes[0]?.body).toEqual({ service: "tavily" });
    expect(writes[1]?.body).toEqual({ value: KEY });
    // The key is write-only: the page offers a reset, and the value appears nowhere.
    expect(screen.getByRole("button", { name: "重设" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(KEY);

    fireEvent.click(screen.getByTestId("web-search-test"));
    expect((await screen.findByTestId("web-search-test-result")).textContent).toBe("测试成功，返回 5 条结果");
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/web-search/test")).toHaveLength(1);
  });

  it("removes the service and its key after a confirmation", async () => {
    const { calls } = setup({ service: "tavily", credentialStatus: "configured" });
    await screen.findByTestId("web-search-credential");
    fireEvent.click(screen.getByTestId("web-search-remove"));
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByTestId("web-search-credential").textContent).toBe("未配置"));
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/web-search")).toBe(true);
  });

  it("shows a stored key that cannot be read, and offers no test for it", async () => {
    setup({ service: "tavily", credentialStatus: "unavailable" });
    expect((await screen.findByTestId("web-search-credential")).textContent).toBe("已保存但当前无法解密，请重设");
    expect((screen.getByTestId("web-search-test") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a failed test with the service's reason", async () => {
    setup(
      { service: "tavily", credentialStatus: "configured" },
      { status: 422, body: { error: { class: "web_search_failed", code: "web_search_failed.auth", retryDisposition: "never", userMessage: "联网搜索服务的 API Key 无效，请检查配置", action: "configure_web_search" } } },
    );
    fireEvent.click(await screen.findByTestId("web-search-test"));
    expect((await screen.findByRole("alert")).textContent).toContain("API Key 无效");
    expect(screen.queryByTestId("web-search-test-result")).toBeNull();
  });

  it("states what the model and the search service receive, and how searches are billed", async () => {
    setup({ credentialStatus: "missing" });
    const privacy = await screen.findByTestId("web-search-privacy");
    expect(privacy.textContent).toContain("所选模型：规划搜索时收到当前问题和最近 2 轮的提问");
    expect(privacy.textContent).toContain("搜索服务：只收到模型生成的搜索查询，每条最多 200 个字符");
    expect(privacy.textContent).toContain("不会把字幕原文、总结或对话历史发给搜索服务");
    expect(screen.getByTestId("web-search-billing").textContent).toContain("2026-10-26 查阅");
  });
});
