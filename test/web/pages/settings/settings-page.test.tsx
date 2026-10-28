import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../../../src/web/pages/settings/settings-page.tsx";
import { fakeShell } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const VERSION = { version: "0.1.0", mode: "local" };

describe("SettingsPage", () => {
  it("redirects an unknown section to models", async () => {
    mockApi({ "GET /api/providers": { body: { items: [] } }, "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } } });
    const { container } = renderApp(<SettingsPage />, { route: "/settings/nope", path: "/settings/:section" });
    expect(await screen.findByText("先配置一个 AI 模型")).toBeTruthy();
    expect(container.querySelector("[data-settings-section]")?.getAttribute("data-settings-section")).toBe("models");
  });

  it("adds 「备份与恢复」 before the shortcuts in the desktop client only", async () => {
    fakeShell.desktop = true;
    mockApi({
      "GET /api/version": { body: VERSION },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
    });
    renderApp(<SettingsPage />, { route: "/settings/shortcuts", path: "/settings/:section" });
    const nav = screen.getByRole("navigation");
    await waitFor(() => expect([...nav.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toContain("/settings/backup"));
    const hrefs = [...nav.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs.slice(-3)).toEqual(["/settings/storage", "/settings/backup", "/settings/shortcuts"]);
    expect(screen.getByRole("link", { name: "备份与恢复" })).toBeTruthy();
  });

  it("sends /settings/backup to models in server mode", async () => {
    mockApi({ "GET /api/providers": { body: { items: [] } }, "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } } });
    const { container } = renderApp(<SettingsPage />, { route: "/settings/backup", path: "/settings/:section", mode: "server" });
    await waitFor(() => expect(container.querySelector("[data-settings-section]")?.getAttribute("data-settings-section")).toBe("models"));
  });

  it("lists the same feature sections in both run modes, without appearance, about, account or admin", async () => {
    const expected = ["/settings/models", "/settings/transcription", "/settings/other-models", "/settings/web-search", "/settings/platform-accounts", "/settings/templates", "/settings/terminology", "/settings/storage", "/settings/shortcuts"];
    for (const mode of ["local", "server"] as const) {
      mockApi({
        "GET /api/version": { body: { ...VERSION, mode } },
        "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode, mustChangePassword: false } },
        "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      });
      const { unmount } = renderApp(<SettingsPage />, { route: "/settings/shortcuts", path: "/settings/:section", mode });
      const nav = screen.getByRole("navigation");
      expect([...nav.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(expected);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("功能设置");
      expect(screen.getByRole("link", { name: "提示词模板" }).getAttribute("href")).toBe("/settings/templates");
      unmount();
    }
  });

  it("sends the sections that moved to the account menu to models", async () => {
    for (const moved of ["appearance", "about", "account"]) {
      mockApi({ "GET /api/providers": { body: { items: [] } }, "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } } });
      const { container, unmount } = renderApp(<SettingsPage />, { route: `/settings/${moved}`, path: "/settings/:section", mode: "server" });
      await waitFor(() => expect(container.querySelector("[data-settings-section]")?.getAttribute("data-settings-section")).toBe("models"));
      unmount();
    }
  });
});
