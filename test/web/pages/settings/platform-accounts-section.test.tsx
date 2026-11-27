import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_LOGIN_RECHECK_MS, QR_POLL_INTERVAL_MS } from "../../../../src/shared/defaults.ts";
import type { RunMode } from "../../../../src/shared/enums.ts";
import { formatDateTime } from "../../../../src/web/format.ts";
import { PlatformAccountsSection } from "../../../../src/web/pages/settings/platform-accounts-section.tsx";
import { fakeShell } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const LEAD = "登录后，Amber 能直接读取 B 站字幕，也能处理需要验证身份的视频；不登录也能处理大多数公开视频。";
const TRUST = "登录信息保存在当前 Amber 服务器，仅在信任该服务器管理员时导入";
const RISK = "使用登录信息访问可能触发小红书对账号的风控，建议使用不常用的账号";
const UNCONFIRMED = "已保存，正在确认是否有效…";
const QR_URL = "https://example.test/qr?token=<placeholder>";
const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 };

type LoginPlatform = "bilibili" | "youtube" | "xiaohongshu";
const LOGIN_PLATFORMS: readonly LoginPlatform[] = ["bilibili", "youtube", "xiaohongshu"];
type Account = { platform: LoginPlatform; credentialStatus: "missing" | "configured" | "unavailable"; hasCredential: boolean; status?: string; checkedAt?: number };

/** A moment well inside the recheck interval, so opening the page does not check it. */
const recent = () => Date.now() - 60_000;
/** A moment just past the recheck interval. */
const stale = () => Date.now() - PLATFORM_LOGIN_RECHECK_MS - 60_000;

const NONE = (platform: LoginPlatform): Account => ({ platform, credentialStatus: "missing", hasCredential: false });
const VALID = (platform: LoginPlatform, checkedAt = recent()): Account => ({ platform, credentialStatus: "configured", hasCredential: true, status: "valid", checkedAt });
const EXPIRED = (platform: LoginPlatform, checkedAt = recent()): Account => ({ platform, credentialStatus: "configured", hasCredential: true, status: "expired", checkedAt });
const SAVED = (platform: LoginPlatform): Account => ({ platform, credentialStatus: "configured", hasCredential: true, status: "unknown" });
const allNone = () => LOGIN_PLATFORMS.map(NONE);
const STORED = { platform: "bilibili", credentialStatus: "configured", hasCredential: true, status: "unknown" } as const;

function setup(mode: RunMode, accounts: Account[] | (() => Account[]), extra: Parameters<typeof mockApi>[0] = {}, route = "/settings/platform-accounts") {
  const api = mockApi({
    "GET /api/version": { body: { version: "0.1.0", mode } },
    "GET /api/settings": { body: SETTINGS },
    "GET /api/platform-accounts": () => ({ body: { accounts: typeof accounts === "function" ? accounts() : accounts } }),
    ...extra,
  });
  renderApp(<PlatformAccountsSection />, { mode, route });
  return api;
}

/** Holds every login check until `release` is called, so the checking state can be seen. */
function holdChecks(): { release: () => void } {
  const answer = globalThis.fetch;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/check")) await gate;
    return answer(input, init);
  });
  return { release: () => release() };
}

const checks = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.path.endsWith("/check")).map((call) => call.path);
const row = (platform: string) => screen.getByTestId(`account-row-${platform}`);
const toggle = (platform: string) => screen.getByTestId(`account-toggle-${platform}`);
const panel = (platform: string) => screen.getByTestId(`account-panel-${platform}`);
const detail = (platform: string) => screen.getByTestId(`account-detail-${platform}`).textContent;
const primaryButtons = () => screen.queryAllByRole("button").filter((button) => button.className.includes("bg-accent-glow"));

async function expand(platform: string): Promise<HTMLElement> {
  fireEvent.click(toggle(platform));
  await waitFor(() => expect(panel(platform).hidden).toBe(false));
  return panel(platform);
}

/** Advances the faked clock and lets React and the mocked fetch settle. */
async function tick(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PlatformAccountsSection layout", () => {
  it("leads with one sentence, then one list of the four platforms in order, with no import form open", async () => {
    setup("server", allNone());
    await screen.findByTestId("account-row-bilibili");
    expect(screen.getByText(LEAD)).toBeTruthy();
    const list = screen.getByRole("list", { name: "平台账号" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((item) => item.getAttribute("data-testid"))).toEqual(["account-row-bilibili", "account-row-youtube", "account-row-xiaohongshu", "account-row-douyin"]);
    expect(rows.map((item) => item.querySelector("p")?.textContent)).toEqual(["B 站", "YouTube", "小红书", "抖音"]);
    // Each row starts with its platform's mark, decorative only.
    for (const item of rows) {
      const icon = item.querySelector("svg[data-platform-icon]");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.closest("span")?.className).toContain("bg-sunken");
    }
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByText(TRUST)).toBeNull();
  });

  it("shows Douyin as needing no login, with nothing to do", async () => {
    setup("server", allNone());
    await screen.findByTestId("account-row-douyin");
    expect(detail("douyin")).toBe("公开视频与合集可以直接处理");
    expect(screen.getByTestId("account-douyin").textContent).toBe("无需登录");
    expect(within(row("douyin")).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("account-toggle-douyin")).toBeNull();
  });

  it("stands in four skeleton rows of the real rows' height while the list loads", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    renderApp(<PlatformAccountsSection />, { mode: "server" });
    const skeleton = screen.getByTestId("platform-accounts-skeleton");
    expect(skeleton.getAttribute("role")).toBe("status");
    const rows = skeleton.querySelectorAll("[data-skeleton-row]");
    expect(rows).toHaveLength(4);
    // The same row box as the real rows: same minimum height and the same narrow-width layout.
    for (const item of rows) {
      expect(item.className).toContain("min-h-21");
      expect(item.className).toContain("@min-[480px]:flex-row");
    }
    expect(screen.getByText(LEAD)).toBeTruthy();
  });

  it("moves status and actions under the text, aligned with it, when the list is narrow", async () => {
    setup("server", allNone());
    await screen.findByTestId("account-row-bilibili");
    expect(screen.getByRole("list", { name: "平台账号" }).className).toContain("@container");
    const main = row("bilibili").firstElementChild as HTMLElement;
    expect(main.className).toContain("min-h-21");
    expect(main.className).toContain("flex-col");
    expect(main.className).toContain("@min-[480px]:flex-row");
    const aside = toggle("bilibili").parentElement as HTMLElement;
    // 36 px icon tile plus its 12 px gap: the text column's left edge.
    expect(aside.className).toContain("pl-12");
    expect(aside.className).toContain("flex-wrap");
    expect(aside.className).toContain("@min-[480px]:pl-0");
  });
});

describe("PlatformAccountsSection states", () => {
  const time = (at: number) => formatDateTime(at, "zh-CN");

  it("says what no login means on each platform", async () => {
    setup("server", allNone());
    await screen.findByTestId("account-row-bilibili");
    expect(detail("bilibili")).toBe("字幕会用语音转录获取，消耗转录额度。登录后直接读取平台字幕，缓存清晰度也更高");
    expect(detail("youtube")).toBe("公开视频可以直接处理；平台要求验证身份时需要登录");
    expect(detail("xiaohongshu")).toBe("公开视频笔记可以直接处理；只在访问受限时才使用登录信息");
    for (const platform of LOGIN_PLATFORMS) {
      const status = screen.getByTestId(`account-${platform}`);
      expect(status.textContent).toBe("未登录");
      expect(status.querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("hollow-muted");
      expect(status.querySelector("[data-dot]")?.className).toContain("border-muted");
    }
  });

  it("says what a valid login is used for and when it was confirmed", async () => {
    const at = recent();
    setup("server", LOGIN_PLATFORMS.map((platform) => VALID(platform, at)));
    await screen.findByTestId("account-row-bilibili");
    expect(detail("bilibili")).toBe(`直接读取平台字幕 · ${time(at)}确认`);
    expect(detail("youtube")).toBe(`平台要求验证身份时使用 · ${time(at)}确认`);
    expect(detail("xiaohongshu")).toBe(`只在访问受限时使用 · ${time(at)}确认`);
    for (const platform of LOGIN_PLATFORMS) {
      const status = screen.getByTestId(`account-${platform}`);
      expect(status.textContent).toBe("登录有效");
      expect(status.querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("solid-ok");
      expect(status.querySelector("[data-dot]")?.className).toContain("bg-ok");
    }
  });

  it("says what an expired login costs on each platform", async () => {
    setup("server", LOGIN_PLATFORMS.map((platform) => EXPIRED(platform)));
    await screen.findByTestId("account-row-bilibili");
    expect(detail("bilibili")).toBe("登录已失效，字幕会改用语音转录。重新登录即可恢复");
    expect(detail("youtube")).toBe("登录已失效，需要验证身份的视频会处理失败");
    expect(detail("xiaohongshu")).toBe("登录已失效；公开视频笔记不受影响");
    for (const platform of LOGIN_PLATFORMS) {
      const status = screen.getByTestId(`account-${platform}`);
      expect(status.textContent).toBe("登录已失效");
      expect(status.querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("solid-danger");
      expect(status.querySelector("[data-dot]")?.className).toContain("bg-danger");
    }
  });

  it("confirms a saved but unconfirmed login by itself, saying so while it does", async () => {
    let status = "unknown";
    const at = recent();
    const { calls } = setup("server", () => [NONE("bilibili"), status === "unknown" ? SAVED("youtube") : VALID("youtube", at), NONE("xiaohongshu")], {
      "POST /api/platform-accounts/youtube/check": () => {
        status = "valid";
        return { body: { status: "valid" } };
      },
    });
    const { release } = holdChecks();
    await screen.findByTestId("account-row-youtube");
    expect(detail("youtube")).toBe(UNCONFIRMED);
    expect(screen.getByTestId("account-youtube").textContent).toBe("正在确认…");
    release();
    await waitFor(() => expect(screen.getByTestId("account-youtube").textContent).toBe("登录有效"));
    expect(detail("youtube")).toBe(`平台要求验证身份时使用 · ${time(at)}确认`);
    expect(checks(calls)).toEqual(["/api/platform-accounts/youtube/check"]);
    // The change is read out in place.
    expect(screen.getByTestId("account-live-youtube").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("account-live-youtube").textContent).toBe(`YouTube：登录有效。平台要求验证身份时使用 · ${time(at)}确认`);
  });

  it("keeps the saved state and says why when the check cannot tell", async () => {
    setup("local", [NONE("bilibili"), NONE("youtube"), SAVED("xiaohongshu")], {
      "POST /api/platform-accounts/xiaohongshu/check": { body: { status: "unknown" } },
    });
    await waitFor(() => expect(detail("xiaohongshu")).toBe("暂时无法确认登录状态（网络或平台临时问题），已保留原状态，稍后再试"));
    expect(screen.getByTestId("account-xiaohongshu").textContent).toBe("尚未确认");
  });
});

describe("PlatformAccountsSection actions", () => {
  it("makes the bilibili QR login the page's only main button on a server while bilibili has no login", async () => {
    setup("server", allNone());
    await screen.findByTestId("account-row-bilibili");
    expect(primaryButtons().map((button) => button.textContent)).toEqual(["扫码登录"]);
    expect(within(row("bilibili")).getByRole("button", { name: "扫码登录" })).toBe(primaryButtons()[0]);
    // bilibili's other way in sits behind the chevron.
    expect(toggle("bilibili").getAttribute("aria-label")).toBe("更多登录方式");
    expect(toggle("youtube").textContent).toBe("导入登录信息");
    expect(toggle("youtube").className).toContain("border-line");
    expect(toggle("xiaohongshu").textContent).toBe("导入登录信息");
    expect(toggle("xiaohongshu").className).toContain("text-link");
    // Opened panels add no second main button: import submits stay outlined.
    await expand("youtube");
    expect(primaryButtons()).toHaveLength(1);
  });

  it("makes the client's bilibili login window the only main button, and offers reading a browser for YouTube", async () => {
    fakeShell.desktop = true;
    setup("local", allNone());
    const login = await screen.findByTestId("bilibili-login");
    expect(login.textContent).toBe("登录");
    expect(primaryButtons()).toEqual([login]);
    await waitFor(() => expect(toggle("youtube").textContent).toBe("从浏览器读取"));
    expect(screen.queryByRole("button", { name: "扫码登录" })).toBeNull();
  });

  it("asks to log in again once a login has expired", async () => {
    setup("server", LOGIN_PLATFORMS.map((platform) => EXPIRED(platform)));
    await screen.findByTestId("account-row-bilibili");
    expect(primaryButtons().map((button) => button.textContent)).toEqual(["重新登录"]);
    expect(toggle("youtube").textContent).toBe("重新导入");
    expect(toggle("youtube").className).toContain("border-line");
    expect(toggle("xiaohongshu").textContent).toBe("重新导入");
    expect(toggle("xiaohongshu").className).toContain("text-link");
  });

  it("has no main button once bilibili is logged in, and manages each login from its panel", async () => {
    setup("server", LOGIN_PLATFORMS.map((platform) => VALID(platform)));
    await screen.findByTestId("account-row-bilibili");
    expect(primaryButtons()).toHaveLength(0);
    for (const platform of LOGIN_PLATFORMS) expect(toggle(platform).textContent).toBe("管理");
    const opened = await expand("bilibili");
    expect(within(opened).getAllByRole("button").map((button) => button.textContent)).toEqual(["重新检测", "重新登录", "移除登录", "选择 cookies.txt 文件", "导入"]);
    expect(within(opened).getByRole("group", { name: "其他方式" }).querySelector("textarea#cookies-bilibili")).not.toBeNull();
    expect(primaryButtons()).toHaveLength(0);
  });

  it("warns above the Xiaohongshu import form that a logged-in visit risks the account", async () => {
    setup("local", allNone());
    await screen.findByTestId("account-row-xiaohongshu");
    expect(screen.queryByText(RISK)).toBeNull();
    const opened = await expand("xiaohongshu");
    const risk = within(opened).getByText(RISK);
    const field = within(opened).getByLabelText("导入 cookies");
    expect(risk.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field.getAttribute("aria-describedby")).toContain("cookies-xiaohongshu-risk");
    // The cookie form is Xiaohongshu's own way in, not one of "other ways".
    expect(within(opened).queryByRole("group", { name: "其他方式" })).toBeNull();
  });
});

describe("PlatformAccountsSection panels", () => {
  it("opens one row at a time, moves focus into it and gives it back on Escape", async () => {
    setup("server", allNone());
    await screen.findByTestId("account-row-bilibili");
    for (const platform of LOGIN_PLATFORMS) {
      expect(toggle(platform).getAttribute("aria-expanded")).toBe("false");
      expect(toggle(platform).getAttribute("aria-controls")).toBe(`account-panel-${platform}`);
      expect(document.getElementById(`account-panel-${platform}`)).toBe(panel(platform));
      expect(panel(platform).hidden).toBe(true);
    }
    const youtube = await expand("youtube");
    expect(toggle("youtube").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(within(youtube).getByLabelText("导入 cookies"));
    // On a server, where the login is kept is said in the panel, beside its actions.
    expect(within(youtube).getByTestId("cookies-trust-hint").textContent).toBe(TRUST);
    expect(screen.getAllByText(TRUST)).toHaveLength(1);

    const xiaohongshu = await expand("xiaohongshu");
    expect(toggle("youtube").getAttribute("aria-expanded")).toBe("false");
    expect(toggle("xiaohongshu").getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(panel("youtube").hidden).toBe(true));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    const field = within(xiaohongshu).getByLabelText("导入 cookies");
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(toggle("xiaohongshu").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle("xiaohongshu"));
    await waitFor(() => expect(panel("xiaohongshu").hidden).toBe(true));
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("animates the panel's height unless reduced motion is asked for", async () => {
    setup("local", allNone());
    await screen.findByTestId("account-row-bilibili");
    const region = panel("bilibili");
    expect(region.className).toContain("duration-150");
    expect(region.className).toContain("transition-[grid-template-rows]");
    expect(region.className).toContain("motion-reduce:transition-none");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-labelledby")).toBe("account-name-bilibili");
    // The panel lines up with the text column and sits a level deeper than the list.
    const opened = await expand("bilibili");
    const body = opened.querySelector(".bg-panel") as HTMLElement;
    expect(body.className).toContain("ml-16");
    await waitFor(() => expect(region.className).toContain("grid-rows-[1fr]"));
  });

  it("keeps the cookies.txt import of bilibili under other ways, and the server hint out of the client", async () => {
    fakeShell.desktop = true;
    setup("local", allNone());
    await screen.findByTestId("bilibili-login");
    await screen.findByTestId("account-row-bilibili");
    const opened = await expand("bilibili");
    const other = within(opened).getByRole("group", { name: "其他方式" });
    expect(within(other).getByLabelText("导入 cookies")).toBeTruthy();
    expect(screen.queryByTestId("cookies-trust-hint")).toBeNull();
  });

  it("opens the row named by ?focus= and ignores values that are not a login platform", async () => {
    setup("server", allNone(), {}, "/settings/platform-accounts?focus=youtube");
    await screen.findByTestId("account-row-youtube");
    await waitFor(() => expect(panel("youtube").hidden).toBe(false));
    expect(toggle("youtube").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("bilibili").getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["douyin", "weibo", ""])("ignores ?focus=%s and shows the page as usual", async (value) => {
    setup("server", allNone(), {}, `/settings/platform-accounts?focus=${value}`);
    await screen.findByTestId("account-row-bilibili");
    for (const platform of LOGIN_PLATFORMS) expect(toggle(platform).getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("PlatformAccountsSection automatic checks", () => {
  it("checks once on opening only the logins confirmed longer ago than the recheck interval", async () => {
    const { calls } = setup(
      "server",
      [VALID("bilibili", stale()), VALID("youtube", recent()), EXPIRED("xiaohongshu", stale())],
      {
        "POST /api/platform-accounts/bilibili/check": { body: { status: "valid" } },
        "POST /api/platform-accounts/xiaohongshu/check": { body: { status: "expired" } },
      },
    );
    const { release } = holdChecks();
    await screen.findByTestId("account-row-bilibili");
    expect(screen.getByTestId("account-bilibili").textContent).toBe("正在确认…");
    expect(screen.getByTestId("account-xiaohongshu").textContent).toBe("正在确认…");
    expect(screen.getByTestId("account-youtube").textContent).toBe("登录有效");
    release();
    await waitFor(() => expect(checks(calls)).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("account-bilibili").textContent).toBe("登录有效"));
    // The refetched list is still old (the fake never moves its time): no second round.
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/platform-accounts").length).toBeGreaterThan(1));
    expect(checks(calls).sort()).toEqual(["/api/platform-accounts/bilibili/check", "/api/platform-accounts/xiaohongshu/check"]);
  });

  it("checks nothing when there is no login, nor for logins that cannot be read", async () => {
    const { calls } = setup("server", [NONE("bilibili"), { platform: "youtube", credentialStatus: "unavailable", hasCredential: true }, NONE("xiaohongshu")]);
    await screen.findByTestId("account-row-bilibili");
    await waitFor(() => expect(detail("youtube")).toBe("已保存但当前无法解密，请重设"));
    expect(screen.getByTestId("account-youtube").textContent).toBe("无法读取");
    expect(checks(calls)).toEqual([]);
  });
});

describe("PlatformAccountsSection logins", () => {
  it("checks or removes a login from its panel and updates the row in place", async () => {
    let removed = false;
    const at = recent();
    const { calls } = setup("local", () => [removed ? NONE("bilibili") : VALID("bilibili", at), NONE("youtube"), NONE("xiaohongshu")], {
      "POST /api/platform-accounts/bilibili/check": { body: { status: "valid" } },
      "DELETE /api/platform-accounts/bilibili": () => {
        removed = true;
        return { status: 204 };
      },
    });
    await screen.findByTestId("account-row-bilibili");
    // Local mode outside the client has neither the QR login nor the server trust hint.
    expect(screen.queryByRole("button", { name: "扫码登录" })).toBeNull();
    const opened = await expand("bilibili");
    fireEvent.click(within(opened).getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(checks(calls)).toEqual(["/api/platform-accounts/bilibili/check"]));
    await waitFor(() => expect(screen.getByTestId("account-bilibili").textContent).toBe("登录有效"));

    fireEvent.click(within(opened).getByRole("button", { name: "移除登录" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "移除登录" }));
    await waitFor(() => expect(screen.getByTestId("account-bilibili").textContent).toBe("未登录"));
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/platform-accounts/bilibili")).toBe(true);
    expect(toggle("bilibili").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("account-live-bilibili").textContent).toContain("B 站：未登录。");
    // Outside the desktop client there is no player session to clear.
    expect(fakeShell.clearBilibiliPlayerSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("imports pasted cookies write-only, then confirms them in place without a notice", async () => {
    const cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t<placeholder>";
    let stored: Account = NONE("youtube");
    const at = recent();
    const { calls } = setup("server", () => [NONE("bilibili"), stored, NONE("xiaohongshu")], {
      "PUT /api/platform-accounts/youtube/cookies": () => {
        stored = SAVED("youtube");
        return { body: stored };
      },
      "POST /api/platform-accounts/youtube/check": () => {
        stored = VALID("youtube", at);
        return { body: { status: "valid" } };
      },
    });
    await screen.findByTestId("account-row-youtube");
    const opened = await expand("youtube");
    const field = within(opened).getByLabelText("导入 cookies") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: cookies } });
    fireEvent.click(within(field.closest("form") as HTMLFormElement).getByRole("button", { name: "导入" }));
    await waitFor(() => expect(screen.getByTestId("account-youtube").textContent).toBe("登录有效"));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ value: cookies });
    expect(checks(calls)).toEqual(["/api/platform-accounts/youtube/check"]);
    expect(toggle("youtube").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle("youtube"));
    expect(screen.getByTestId("account-live-youtube").textContent).toContain("YouTube：登录有效。");
    expect(document.body.textContent).not.toContain("SID");
    expect(screen.queryByText(/已导入|登录成功/u)).toBeNull();
  });

  it("shows a failed import in the row's panel, beside the form", async () => {
    setup("server", allNone(), {
      "PUT /api/platform-accounts/xiaohongshu/cookies": {
        status: 422,
        body: { error: { class: "invalid_request", code: "invalid_request.cookie_format", retryDisposition: "never", userMessage: "" } },
      },
    });
    await screen.findByTestId("account-row-xiaohongshu");
    const opened = await expand("xiaohongshu");
    const field = within(opened).getByLabelText("导入 cookies");
    fireEvent.change(field, { target: { value: "a=b" } });
    fireEvent.click(within(opened).getByRole("button", { name: "导入" }));
    const alert = await within(opened).findByRole("alert");
    expect(alert.textContent).toContain("请求参数有误");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(toggle("xiaohongshu").getAttribute("aria-expanded")).toBe("true");
  });

  it("logs in by QR code: shows the code, follows the scan and closes once confirmed", async () => {
    const statuses = ["pending", "scanned", "confirmed"];
    const { calls } = setup("server", allNone(), {
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
    await tick(0);
    expect(calls.filter((call) => call.path === "/api/platform-accounts").length).toBeGreaterThan(listsBefore);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("offers a new code once the old one lapses and stops polling when closed", async () => {
    let attempts = 0;
    const { calls } = setup("server", allNone(), {
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
    const { calls } = setup("server", allNone(), {
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

  it("logs in to bilibili in the shell's window, hands the cookies straight to the backend and confirms them", async () => {
    fakeShell.desktop = true;
    fakeShell.openBilibiliLogin.mockResolvedValueOnce(null).mockResolvedValueOnce({ cookies: COOKIES });
    let stored = false;
    const { calls } = setup("local", () => [stored ? { ...STORED } : NONE("bilibili"), NONE("youtube"), NONE("xiaohongshu")], {
      "PUT /api/platform-accounts/bilibili/cookies": () => {
        stored = true;
        return { body: STORED };
      },
      "POST /api/platform-accounts/bilibili/check": { body: { status: "unknown" } },
    });
    const login = await screen.findByTestId("bilibili-login");
    expect(login.textContent).toBe("登录");
    expect(screen.queryByRole("button", { name: "扫码登录" })).toBeNull();
    // Closing the window first changes nothing.
    fireEvent.click(login);
    await waitFor(() => expect(fakeShell.openBilibiliLogin).toHaveBeenCalledTimes(1));
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    fireEvent.click(login);
    await waitFor(() => expect(checks(calls)).toEqual(["/api/platform-accounts/bilibili/check"]));
    await waitFor(() => expect(screen.getByTestId("account-bilibili").textContent).toBe("尚未确认"));
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
    const { calls } = setup("local", allNone(), {
      "PUT /api/platform-accounts/bilibili/cookies": {
        status: 422,
        body: { error: { class: "invalid_request", code: "invalid_request.cookie_format", retryDisposition: "never", userMessage: "" } },
      },
    });
    const login = await screen.findByTestId("bilibili-login");
    fireEvent.click(login);
    // The request error is what the user sees, in the row beside the button, even when clearing the session fails as well.
    const alert = await within(row("bilibili")).findByRole("alert");
    expect(alert.textContent).toContain("请求参数有误");
    expect(fakeShell.clearBilibiliPlayerSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((login as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(login);
    await waitFor(() => expect(fakeShell.clearBilibiliPlayerSession).toHaveBeenCalledTimes(2));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  it("clears the player session when the bilibili account is removed, and only then", async () => {
    fakeShell.desktop = true;
    fakeShell.clearBilibiliPlayerSession.mockRejectedValue("webview busy");
    let removed: string[] = [];
    const { calls } = setup("local", () => LOGIN_PLATFORMS.map((platform) => (removed.includes(platform) ? NONE(platform) : VALID(platform))), {
      "DELETE /api/platform-accounts/youtube": () => {
        removed = [...removed, "youtube"];
        return { status: 204 };
      },
      "DELETE /api/platform-accounts/bilibili": () => {
        removed = [...removed, "bilibili"];
        return { status: 204 };
      },
    });
    await screen.findByTestId("account-row-bilibili");
    const removeFrom = async (platform: "bilibili" | "youtube") => {
      const opened = await expand(platform);
      fireEvent.click(within(opened).getByRole("button", { name: "移除登录" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "移除登录" }));
      await waitFor(() => expect(screen.getByTestId(`account-${platform}`).textContent).toBe("未登录"));
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
    let stored: Account = NONE("youtube");
    const { calls } = setup("local", () => [NONE("bilibili"), stored, NONE("xiaohongshu")], {
      "GET /api/settings": { body: { ...SETTINGS, platformCookieBrowser: "edge" } },
      "PATCH /api/settings": { body: { ...SETTINGS, updatedAt: 2, platformCookieBrowser: "chrome" } },
      "POST /api/platform-accounts/youtube/import-browser": () => {
        if (unavailable) {
          return {
            status: 422,
            body: { error: { class: "browser_cookies_unavailable", code: "browser_cookies_unavailable", retryDisposition: "never", userMessage: "", action: "login_platform" } },
          };
        }
        stored = VALID("youtube");
        return { body: stored };
      },
      "POST /api/platform-accounts/youtube/check": { body: { status: "valid" } },
    });
    await waitFor(() => expect(toggle("youtube").textContent).toBe("从浏览器读取"));
    const opened = await expand("youtube");
    expect(within(opened).getByTestId("browser-import-notice").textContent).toContain("临时导出该浏览器中所有网站的登录信息");
    const select = within(opened).getByLabelText("从浏览器读取登录信息") as HTMLSelectElement;
    expect(document.activeElement).toBe(select);
    await waitFor(() => expect(select.value).toBe("edge"));
    expect([...select.options].map((option) => option.textContent)).toEqual(["Firefox", "Chrome", "Edge"]);
    fireEvent.click(within(opened).getByTestId("browser-import"));
    expect(await within(opened).findByText("无法从浏览器读取登录信息，请完全退出浏览器后重试，或导入 cookies.txt")).toBeTruthy();
    // The cookies.txt import stays available as the fallback, under other ways.
    const other = within(opened).getByRole("group", { name: "其他方式" });
    expect(within(other).getAllByRole("button", { name: "选择 cookies.txt 文件" })).toHaveLength(1);
    // Reading from the browser is one of several ways in, so it is outlined.
    expect(within(opened).getByTestId("browser-import").className).not.toContain("bg-accent-glow");
    fireEvent.change(select, { target: { value: "chrome" } });
    unavailable = false;
    fireEvent.click(within(opened).getByTestId("browser-import"));
    await waitFor(() => expect(screen.getByTestId("account-youtube").textContent).toBe("登录有效"));
    const reads = calls.filter((call) => call.path === "/api/platform-accounts/youtube/import-browser").map((call) => call.body);
    expect(reads).toEqual([{ browser: "edge" }, { browser: "chrome" }]);
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ platformCookieBrowser: "chrome" });
    expect(screen.queryByText(TRUST)).toBeNull();
  });

  it("defaults to Firefox when no browser was chosen before", async () => {
    fakeShell.desktop = true;
    setup("local", allNone());
    await waitFor(() => expect(toggle("youtube").textContent).toBe("从浏览器读取"));
    const opened = await expand("youtube");
    await waitFor(() => expect((within(opened).getByLabelText("从浏览器读取登录信息") as HTMLSelectElement).value).toBe("firefox"));
  });
});
