import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QR_POLL_INTERVAL_MS } from "../../../../src/shared/defaults.ts";
import type { RunMode } from "../../../../src/shared/enums.ts";
import { PlatformAccountsSection } from "../../../../src/web/pages/settings/platform-accounts-section.tsx";
import { fakeShell } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const TRUST = "登录信息保存在当前 Amber 服务器，仅在信任该服务器管理员时导入";
const QR_URL = "https://example.test/qr?token=<placeholder>";

type Account = { platform: "bilibili" | "youtube"; credentialStatus: "missing" | "configured" | "unavailable"; hasCredential: boolean; status?: string; checkedAt?: number };

const NONE = (platform: Account["platform"]): Account => ({ platform, credentialStatus: "missing", hasCredential: false });

function setup(mode: RunMode, accounts: Account[], extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    "GET /api/version": { body: { version: "0.1.0", mode } },
    "GET /api/platform-accounts": { body: { accounts } },
    ...extra,
  });
  renderApp(<PlatformAccountsSection />, { mode });
  return api;
}

/** Advances the faked clock and lets React and the mocked fetch settle. */
async function tick(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PlatformAccountsSection", () => {
  it("shows each platform's login state and checks or removes it on request", async () => {
    const { calls } = setup("local", [
      { platform: "bilibili", credentialStatus: "configured", hasCredential: true, status: "valid", checkedAt: Date.UTC(2026, 9, 1) },
      NONE("youtube"),
    ], {
      "POST /api/platform-accounts/bilibili/check": { body: { status: "valid" } },
      "DELETE /api/platform-accounts/bilibili": { status: 204 },
    });
    const bilibili = await screen.findByTestId("account-bilibili");
    expect(bilibili.textContent).toContain("登录有效");
    expect(bilibili.textContent).toContain("上次检测");
    expect(screen.getByTestId("account-youtube").textContent).toContain("未登录");
    // Local mode has neither the QR login nor the server trust hint.
    expect(screen.queryByRole("button", { name: "扫码登录" })).toBeNull();
    expect(screen.queryByText(TRUST)).toBeNull();
    // Only the account that exists can be checked or removed.
    expect(screen.getAllByRole("button", { name: "检测" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    expect(await screen.findByText("检测通过，登录有效")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/platform-accounts/bilibili/check"]);

    fireEvent.click(screen.getByRole("button", { name: "移除登录" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "移除登录" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/platform-accounts/bilibili")).toBe(true));
    // Outside the desktop client there is no player session to clear.
    expect(fakeShell.clearBilibiliPlayerSession).not.toHaveBeenCalled();
  });

  it("tells the user to log in again once a login has expired", async () => {
    setup("local", [{ platform: "bilibili", credentialStatus: "configured", hasCredential: true, status: "expired", checkedAt: 1 }, NONE("youtube")]);
    const bilibili = await screen.findByTestId("account-bilibili");
    expect(bilibili.textContent).toContain("登录已失效，请重新登录");
  });

  it("imports pasted cookies write-only and shows the trust hint on a server", async () => {
    const cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t<placeholder>";
    const { calls } = setup("server", [NONE("bilibili"), NONE("youtube")], {
      "PUT /api/platform-accounts/youtube/cookies": { body: { platform: "youtube", credentialStatus: "configured", hasCredential: true, status: "unknown" } },
    });
    await screen.findByTestId("account-youtube");
    expect(screen.getAllByText(TRUST)).toHaveLength(2);
    const field = screen.getByLabelText("导入 cookies", { selector: "#cookies-youtube" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: cookies } });
    const form = field.closest("form") as HTMLFormElement;
    fireEvent.click(within(form).getByRole("button", { name: "导入" }));
    expect(await screen.findByText("已导入，可点「检测」确认登录是否有效")).toBeTruthy();
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ value: cookies });
    expect(field.value).toBe("");
  });

  it("logs in by QR code: shows the code, follows the scan and closes once confirmed", async () => {
    const statuses = ["pending", "scanned", "confirmed"];
    const { calls } = setup("server", [NONE("bilibili"), NONE("youtube")], {
      "POST /api/platform-accounts/bilibili/qr": { body: { attemptId: "a1", qrUrl: QR_URL, expiresAt: Date.now() + 180_000 } },
      "GET /api/platform-accounts/bilibili/qr/a1": () => ({ body: { status: statuses.shift() ?? "confirmed" } }),
    });
    const open = await screen.findByRole("button", { name: "扫码登录" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(open);
    await tick(0);
    const dialog = screen.getByRole("dialog", { name: "扫码登录 B 站" });
    await tick(0);
    expect(within(dialog).getByTestId("qr-image").getAttribute("src")).toMatch(/^data:image\/svg\+xml/u);
    expect(within(dialog).getByRole("status").textContent).toBe("请用哔哩哔哩 App 扫码");
    // Nothing is polled before the first interval has passed.
    expect(calls.filter((call) => call.path.endsWith("/qr/a1"))).toHaveLength(0);

    await tick(QR_POLL_INTERVAL_MS);
    expect(within(dialog).getByRole("status").textContent).toBe("请用哔哩哔哩 App 扫码");
    await tick(QR_POLL_INTERVAL_MS);
    expect(within(dialog).getByRole("status").textContent).toBe("已扫码，请在手机上确认");
    const listsBefore = calls.filter((call) => call.path === "/api/platform-accounts").length;
    await tick(QR_POLL_INTERVAL_MS);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("登录成功")).toBeTruthy();
    await tick(0);
    expect(calls.filter((call) => call.path === "/api/platform-accounts").length).toBeGreaterThan(listsBefore);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("offers a new code once the old one lapses and stops polling when closed", async () => {
    let attempts = 0;
    const { calls } = setup("server", [NONE("bilibili"), NONE("youtube")], {
      "POST /api/platform-accounts/bilibili/qr": () => {
        attempts += 1;
        return { body: { attemptId: `a${attempts}`, qrUrl: QR_URL, expiresAt: Date.now() + 180_000 } };
      },
      "GET /api/platform-accounts/bilibili/qr/a1": { body: { status: "expired" } },
      "GET /api/platform-accounts/bilibili/qr/a2": { body: { status: "pending" } },
    });
    const open = await screen.findByRole("button", { name: "扫码登录" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(open);
    await tick(0);
    await tick(QR_POLL_INTERVAL_MS);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status").textContent).toBe("二维码已过期");
    // An expired code is not polled again.
    await tick(QR_POLL_INTERVAL_MS * 3);
    expect(calls.filter((call) => call.path.endsWith("/qr/a1"))).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "刷新二维码" }));
    await tick(0);
    await tick(QR_POLL_INTERVAL_MS);
    expect(calls.filter((call) => call.path.endsWith("/qr/a2"))).toHaveLength(1);
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("请用哔哩哔哩 App 扫码");

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }));
    await tick(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    await tick(QR_POLL_INTERVAL_MS * 5);
    expect(calls.filter((call) => call.path.endsWith("/qr/a2"))).toHaveLength(1);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });

  it("treats a code past its expiry time as expired without asking the server", async () => {
    const { calls } = setup("server", [NONE("bilibili"), NONE("youtube")], {
      "POST /api/platform-accounts/bilibili/qr": { body: { attemptId: "a1", qrUrl: QR_URL, expiresAt: Date.now() - 1 } },
    });
    const open = await screen.findByRole("button", { name: "扫码登录" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(open);
    await tick(0);
    await tick(QR_POLL_INTERVAL_MS);
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("二维码已过期");
    expect(calls.filter((call) => call.path.includes("/qr/"))).toHaveLength(0);
  });
});

describe("PlatformAccountsSection in the desktop client", () => {
  const COOKIES = "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\t<placeholder>\n";
  const STORED = { platform: "bilibili", credentialStatus: "configured", hasCredential: true, status: "unknown" } as const;

  it("logs in to bilibili in the shell's window and hands the cookies straight to the backend", async () => {
    fakeShell.desktop = true;
    fakeShell.openBilibiliLogin.mockResolvedValueOnce(null).mockResolvedValueOnce({ cookies: COOKIES });
    let stored = false;
    const { calls } = mockApi({
      "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      "GET /api/platform-accounts": () => ({ body: { accounts: [stored ? STORED : NONE("bilibili"), NONE("youtube")] } }),
      "PUT /api/platform-accounts/bilibili/cookies": () => {
        stored = true;
        return { body: STORED };
      },
    });
    renderApp(<PlatformAccountsSection />, { mode: "local" });
    const login = await screen.findByTestId("bilibili-login");
    expect(login.textContent).toBe("登录");
    expect(screen.queryByRole("button", { name: "扫码登录" })).toBeNull();
    // Closing the window first changes nothing.
    fireEvent.click(login);
    await waitFor(() => expect(fakeShell.openBilibiliLogin).toHaveBeenCalledTimes(1));
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    fireEvent.click(login);
    expect(await screen.findByText("登录成功，可点「检测」确认登录是否有效")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("account-bilibili").textContent).toContain("已保存，尚未检测"));
    const put = calls.filter((call) => call.method === "PUT");
    expect(put).toHaveLength(1);
    expect(put[0]?.body).toEqual({ value: COOKIES });
    expect(put[0]?.path).toBe("/api/platform-accounts/bilibili/cookies");
    expect(document.body.textContent).not.toContain("SESSDATA");
    // A stored login keeps the player session the shell set up.
    expect(fakeShell.clearBilibiliPlayerSession).not.toHaveBeenCalled();
  });

  it("takes the player session back when the backend does not store the login", async () => {
    fakeShell.desktop = true;
    fakeShell.openBilibiliLogin.mockResolvedValue({ cookies: COOKIES });
    fakeShell.clearBilibiliPlayerSession.mockRejectedValueOnce("webview busy").mockResolvedValueOnce(undefined);
    const { calls } = mockApi({
      "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      "GET /api/platform-accounts": { body: { accounts: [NONE("bilibili"), NONE("youtube")] } },
      "PUT /api/platform-accounts/bilibili/cookies": {
        status: 422,
        body: { error: { class: "invalid_request", code: "invalid_request.cookie_format", retryDisposition: "never", userMessage: "" } },
      },
    });
    renderApp(<PlatformAccountsSection />, { mode: "local" });
    const login = await screen.findByTestId("bilibili-login");
    fireEvent.click(login);
    // The request error is what the user sees, even when clearing the session fails as well.
    expect((await screen.findByRole("alert")).textContent).toContain("请求参数有误");
    expect(fakeShell.clearBilibiliPlayerSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("登录成功，可点「检测」确认登录是否有效")).toBeNull();
    await waitFor(() => expect((login as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(login);
    await waitFor(() => expect(fakeShell.clearBilibiliPlayerSession).toHaveBeenCalledTimes(2));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  it("clears the player session when the bilibili account is removed, and only then", async () => {
    fakeShell.desktop = true;
    fakeShell.clearBilibiliPlayerSession.mockRejectedValue("webview busy");
    let removed: string[] = [];
    const { calls } = mockApi({
      "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      "GET /api/platform-accounts": () => ({
        body: { accounts: (["bilibili", "youtube"] as const).map((platform) => (removed.includes(platform) ? NONE(platform) : { ...STORED, platform })) },
      }),
      "DELETE /api/platform-accounts/youtube": () => {
        removed = [...removed, "youtube"];
        return { status: 204 };
      },
      "DELETE /api/platform-accounts/bilibili": () => {
        removed = [...removed, "bilibili"];
        return { status: 204 };
      },
    });
    renderApp(<PlatformAccountsSection />, { mode: "local" });
    const removeFrom = async (platform: "bilibili" | "youtube") => {
      const block = (await screen.findByTestId(`account-${platform}`)).closest("section") as HTMLElement;
      fireEvent.click(within(block).getByRole("button", { name: "移除登录" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "移除登录" }));
      await waitFor(() => expect(screen.getByTestId(`account-${platform}`).textContent).toContain("未登录"));
    };
    await removeFrom("youtube");
    expect(fakeShell.clearBilibiliPlayerSession).not.toHaveBeenCalled();
    await removeFrom("bilibili");
    expect(fakeShell.clearBilibiliPlayerSession).toHaveBeenCalledTimes(1);
    // A failed clear is left to the shell's log; the removal stands without an error.
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/platform-accounts/youtube", "/api/platform-accounts/bilibili"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the YouTube login from the chosen browser, remembers the choice and explains a failure", async () => {
    fakeShell.desktop = true;
    let unavailable = true;
    const { calls } = mockApi({
      "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1, platformCookieBrowser: "edge" } },
      "PATCH /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 2, platformCookieBrowser: "chrome" } },
      "GET /api/platform-accounts": { body: { accounts: [NONE("bilibili"), NONE("youtube")] } },
      "POST /api/platform-accounts/youtube/import-browser": () =>
        unavailable
          ? {
              status: 422,
              body: { error: { class: "browser_cookies_unavailable", code: "browser_cookies_unavailable", retryDisposition: "never", userMessage: "", action: "login_platform" } },
            }
          : { body: { platform: "youtube", credentialStatus: "configured", hasCredential: true, status: "valid" } },
    });
    renderApp(<PlatformAccountsSection />, { mode: "local" });
    expect((await screen.findByTestId("browser-import-notice")).textContent).toContain("临时导出该浏览器中所有网站的登录信息");
    const select = (await screen.findByLabelText("从浏览器读取登录信息")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("edge"));
    expect([...select.options].map((option) => option.textContent)).toEqual(["Firefox", "Chrome", "Edge"]);
    fireEvent.click(screen.getByTestId("browser-import"));
    expect(await screen.findByText("无法从浏览器读取登录信息，请完全退出浏览器后重试，或导入 cookies.txt")).toBeTruthy();
    // The cookies.txt import stays available as the fallback.
    expect(screen.getAllByText("选择 cookies.txt 文件")).toHaveLength(2);
    fireEvent.change(select, { target: { value: "chrome" } });
    unavailable = false;
    fireEvent.click(screen.getByTestId("browser-import"));
    expect(await screen.findByText("已从浏览器读取登录信息，可点「检测」确认登录是否有效")).toBeTruthy();
    const reads = calls.filter((call) => call.path === "/api/platform-accounts/youtube/import-browser").map((call) => call.body);
    expect(reads).toEqual([{ browser: "edge" }, { browser: "chrome" }]);
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ platformCookieBrowser: "chrome" });
    expect(screen.queryByText(TRUST)).toBeNull();
  });

  it("defaults to Firefox when no browser was chosen before", async () => {
    fakeShell.desktop = true;
    mockApi({
      "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      "GET /api/platform-accounts": { body: { accounts: [NONE("bilibili"), NONE("youtube")] } },
    });
    renderApp(<PlatformAccountsSection />, { mode: "local" });
    expect(((await screen.findByLabelText("从浏览器读取登录信息")) as HTMLSelectElement).value).toBe("firefox");
  });
});

