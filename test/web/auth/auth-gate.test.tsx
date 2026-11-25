import { fireEvent, screen, waitFor } from "@testing-library/react";
import { z } from "zod";
import { Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { useApi } from "../../../src/web/api/context.tsx";
import { AuthGate } from "../../../src/web/auth/auth-gate.tsx";
import { forgetNext } from "../../../src/web/auth/next-path.ts";
import { LoginPage } from "../../../src/web/pages/login-page.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 };
const UNAUTHENTICATED = { status: 401, body: { error: { class: "unauthenticated", code: "unauthenticated", retryDisposition: "never", userMessage: "未登录或登录已失效" } } };
const ME = { userId: "u1", role: "user", mode: "server", mustChangePassword: false };
const SETUP_PENDING = {
  status: 401,
  body: { error: { class: "unauthenticated", code: "unauthenticated.setup_token", retryDisposition: "never", userMessage: "setup token 无效或已过期" } },
};
const SETUP_LINK = { name: "首次部署？初始化管理员" };

function Where() {
  const location = useLocation();
  const api = useApi();
  return (
    <div>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      <button type="button" onClick={() => void api.get("/api/contents", z.unknown()).catch(() => undefined)}>
        load
      </button>
    </div>
  );
}

function routes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGate />}>
        <Route path="*" element={<Where />} />
      </Route>
    </Routes>
  );
}

function fillLogin(username: string, password: string): void {
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
}

describe("AuthGate and /login", () => {
  beforeEach(() => forgetNext());

  it("sends an unauthenticated visit to /login and returns there after logging in", async () => {
    let loggedIn = false;
    const { calls } = mockApi({
      "GET /api/auth/me": () => (loggedIn ? { body: ME } : UNAUTHENTICATED),
      "GET /api/settings": { body: SETTINGS },
      "GET /api/setup": SETUP_PENDING,
      "POST /api/auth/login": () => {
        loggedIn = true;
        return { body: ME };
      },
    });
    const { container } = renderApp(routes(), { route: "/contents/c1?tab=summary", mode: "server" });
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Amber - AI 音视频处理");
    expect(heading.className).toContain("text-center");
    expect((await screen.findByRole("link", SETUP_LINK)).getAttribute("href")).toBe("/setup");
    expect(container.querySelector(".border-t")?.contains(screen.getByRole("link", SETUP_LINK))).toBe(true);
    // The 401 of an uninitialized instance is expected: it must not bounce the login page.
    expect(screen.getByTestId("login-form")).toBeTruthy();
    fillLogin("alice", "correct horse battery");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/c1?tab=summary"));
    const login = calls.find((call) => call.path === "/api/auth/login");
    expect(login?.body).toEqual({ username: "alice", password: "correct horse battery" });
    expect(login?.headers["x-amber-request"]).toBe("1");
    // Only the login page's single status query touches setup; the boundary never probes it,
    // and clearing the cache on login does not refetch it.
    expect(calls.filter((call) => call.path.startsWith("/api/setup")).map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/setup"]);
  });

  it.each([
    ["an initialized instance", { "GET /api/setup": { body: { initialized: true } } }],
    ["local mode without the setup route (404)", {}],
    ["a 401 that is not about the setup token", { "GET /api/setup": UNAUTHENTICATED }],
  ])("hides the setup link for %s", async (_label, setupRoutes) => {
    const { calls } = mockApi({ "GET /api/auth/me": UNAUTHENTICATED, ...setupRoutes });
    const { container } = renderApp(routes(), { route: "/library", mode: "server" });
    await screen.findByTestId("login-form");
    await waitFor(() => expect(calls.some((call) => call.method === "GET" && call.path === "/api/setup")).toBe(true));
    // Let the answer settle before asserting that nothing appeared.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("link", SETUP_LINK)).toBeNull();
    // No footer at all, so no divider line under the form either.
    expect(container.querySelector(".border-t")).toBeNull();
    expect(screen.getByTestId("login-form")).toBeTruthy();
  });

  it("asks for a new password after a reset login, reusing the verified password", async () => {
    const { calls } = mockApi({
      "GET /api/auth/me": UNAUTHENTICATED,
      "GET /api/settings": { body: SETTINGS },
      "POST /api/auth/login": { body: { ...ME, mustChangePassword: true } },
      "POST /api/auth/change-password": { body: ME },
    });
    renderApp(routes(), { route: "/library", mode: "server" });
    await screen.findByTestId("login-form");
    fillLogin("alice", "temporary-password-1");
    expect(await screen.findByTestId("change-password-form")).toBeTruthy();
    // A new account and an admin reset both land here: the wording fits either.
    expect(screen.getByText("你正在使用临时密码。为了账号安全，请先设置一个只有你自己知道的新密码。")).toBeTruthy();
    expect(screen.queryByText(/重置/)).toBeNull();
    expect(screen.queryByLabelText("当前密码")).toBeNull();
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
    expect(await screen.findByText("新密码至少 12 个字符")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "a-new-long-password" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "a-new-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/library"));
    expect(calls.find((call) => call.path === "/api/auth/change-password")?.body).toEqual({
      currentPassword: "temporary-password-1",
      newPassword: "a-new-long-password",
    });
  });

  it("holds a session that must change its password at the change step", async () => {
    const { calls } = mockApi({ "GET /api/auth/me": { body: { ...ME, mustChangePassword: true } } });
    renderApp(routes(), { route: "/settings/models", mode: "server" });
    expect(await screen.findByTestId("change-password-form")).toBeTruthy();
    expect(screen.getByLabelText("当前密码")).toBeTruthy();
    // Preferences mount only behind the boundary.
    expect(calls.some((call) => call.path === "/api/settings")).toBe(false);
  });

  it("returns to /login when a session ends mid-use, then back to the page", async () => {
    let session = true;
    mockApi({
      "GET /api/auth/me": () => (session ? { body: ME } : UNAUTHENTICATED),
      "GET /api/settings": { body: SETTINGS },
      "GET /api/contents": () => (session ? { body: {} } : UNAUTHENTICATED),
      "POST /api/auth/login": () => {
        session = true;
        return { body: ME };
      },
    });
    renderApp(routes(), { route: "/collections/c9", mode: "server" });
    expect((await screen.findByTestId("where")).textContent).toBe("/collections/c9");
    session = false;
    fireEvent.click(screen.getByRole("button", { name: "load" }));
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    fillLogin("alice", "correct horse battery");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/collections/c9"));
  });

  it("shows how long to wait when logins are rate limited", async () => {
    mockApi({
      "GET /api/auth/me": UNAUTHENTICATED,
      "POST /api/auth/login": {
        status: 429,
        headers: { "retry-after": "4" },
        body: { error: { class: "rate_limited", code: "rate_limited", retryDisposition: "never", userMessage: "尝试过于频繁，请稍后再试" } },
      },
    });
    renderApp(routes(), { route: "/library", mode: "server" });
    await screen.findByTestId("login-form");
    fillLogin("alice", "wrong password!");
    expect(await screen.findByText("尝试过于频繁，请 4 秒后再试")).toBeTruthy();
  });

  it("lets the local principal straight in and never redirects on a local 401", async () => {
    mockApi({
      "GET /api/auth/me": { body: { userId: "local", role: "admin", mode: "local", mustChangePassword: false } },
      "GET /api/settings": { body: SETTINGS },
      "GET /api/contents": UNAUTHENTICATED,
    });
    renderApp(routes(), { route: "/library", mode: "local" });
    expect((await screen.findByTestId("where")).textContent).toBe("/library");
    fireEvent.click(screen.getByRole("button", { name: "load" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("where").textContent).toBe("/library");
  });
});
