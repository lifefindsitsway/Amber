import { afterEach, describe, expect, it, vi } from "vitest";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { PLATFORM_COOKIE_BROWSER_DEFAULT } from "../../../src/shared/defaults.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

// A distinctive cookie name so its plaintext can be searched for in every table.
const COOKIE = "amber_test_cookie=<placeholder>";
const NETSCAPE = [
  "# Netscape HTTP Cookie File",
  ".bilibili.com\tTRUE\t/\tTRUE\t0\tamber_test_cookie\t<placeholder>",
  ".example.com\tTRUE\t/\tTRUE\t0\tforeign_cookie\t<placeholder>",
  "",
].join("\n");
const signal = new AbortController().signal;

const open: Harness[] = [];
function harness(): Harness {
  const created = createHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

/** Every value of every table, as text, to prove a plaintext appears nowhere. */
function everyStoredValue(h: Harness): string {
  const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return tables
    .map(({ name }) =>
      (h.db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>)
        .map((row) => Object.values(row).map((value) => (Buffer.isBuffer(value) ? value.toString("latin1") : String(value))).join("|"))
        .join("\n"),
    )
    .join("\n");
}

function accountOf(h: Harness, platform: "bilibili" | "youtube", userId = LOCAL.userId) {
  return h.repository.withTransaction((scope) => scope.platformAccounts.get(userId, platform));
}

describe("PlatformAccountService", () => {
  it("lists every platform, with or without an account", () => {
    const h = harness();
    expect(h.platformAccounts.list(LOCAL)).toEqual({
      accounts: [
        { platform: "bilibili", credentialStatus: "missing", hasCredential: false },
        { platform: "youtube", credentialStatus: "missing", hasCredential: false },
        { platform: "xiaohongshu", credentialStatus: "missing", hasCredential: false },
      ],
    });
    h.platformAccounts.putCookies(LOCAL, "youtube", "amber_test_cookie=<placeholder>");
    expect(h.platformAccounts.list(LOCAL).accounts[1]).toEqual({ platform: "youtube", credentialStatus: "configured", hasCredential: true, status: "unknown" });
    // Another user's view is untouched.
    expect(h.platformAccounts.list(BOB).accounts.every((account) => !account.hasCredential)).toBe(true);
  });

  it("stores cookies as status unknown without checking them, and replaces them in place", async () => {
    const h = harness();
    const dto = h.platformAccounts.putCookies(LOCAL, "bilibili", COOKIE);
    expect(dto).toEqual({ platform: "bilibili", credentialStatus: "configured", hasCredential: true, status: "unknown" });
    expect(h.platforms.bilibili.callsOf("checkCredential")).toEqual([]);
    const first = accountOf(h, "bilibili");

    await h.platformAccounts.check(LOCAL, "bilibili", signal);
    expect(accountOf(h, "bilibili")?.status).toBe("valid");
    h.platformAccounts.putCookies(LOCAL, "bilibili", NETSCAPE);
    const second = accountOf(h, "bilibili");
    expect(second).toMatchObject({ id: first?.id, credentialRef: first?.credentialRef, status: "unknown" });
    expect(second?.checkedAt).toBeUndefined();
    expect(countRows(h.db, "secret")).toBe(1);
    expect(countRows(h.db, "platform_account")).toBe(1);
  });

  it("imports a Xiaohongshu login from cookies.txt or a Cookie header, keeping only its domain's cookies", async () => {
    const h = harness();
    const cookiesTxt = [
      "# Netscape HTTP Cookie File",
      ".xiaohongshu.com\tTRUE\t/\tTRUE\t0\tamber_test_cookie\t<placeholder>",
      "www.xiaohongshu.com\tFALSE\t/\tTRUE\t0\tamber_web_session\t<placeholder>",
      ".bilibili.com\tTRUE\t/\tTRUE\t0\tforeign_cookie\t<placeholder>",
      ".notxiaohongshu.com\tTRUE\t/\tTRUE\t0\tlookalike_cookie\t<placeholder>",
      "",
    ].join("\n");
    expect(h.platformAccounts.putCookies(LOCAL, "xiaohongshu", cookiesTxt)).toEqual({
      platform: "xiaohongshu",
      credentialStatus: "configured",
      hasCredential: true,
      status: "unknown",
    });
    const fromFile = (await h.platformAccounts.credentialFor(LOCAL.userId, "xiaohongshu")?.cookies()) ?? "";
    expect(fromFile).toContain("amber_test_cookie");
    expect(fromFile).toContain("amber_web_session");
    expect(fromFile).not.toContain("foreign_cookie");
    expect(fromFile).not.toContain("lookalike_cookie");

    expect(h.platformAccounts.putCookies(LOCAL, "xiaohongshu", "Cookie: amber_a1=<placeholder>; amber_web_session=<placeholder>")).toMatchObject({ hasCredential: true, status: "unknown" });
    const fromHeader = (await h.platformAccounts.credentialFor(LOCAL.userId, "xiaohongshu")?.cookies()) ?? "";
    expect(fromHeader).toMatch(/^\.xiaohongshu\.com\tTRUE\t\/\tTRUE\t\d+\tamber_a1\t<placeholder>$/m);
    expect(fromHeader).not.toContain("amber_test_cookie");
    expect(countRows(h.db, "secret")).toBe(1);
    expect(everyStoredValue(h)).not.toContain("amber_web_session");
    expect(JSON.stringify(h.platformAccounts.list(LOCAL))).not.toContain("placeholder");
    expect(await codeOf(() => h.platformAccounts.putCookies(LOCAL, "xiaohongshu", NETSCAPE))).toBe("invalid_request.cookie_format");
  });

  it("keeps only the platform's cookies, in canonical Netscape form, and rejects input with none", async () => {
    const h = harness();
    h.platformAccounts.putCookies(LOCAL, "bilibili", NETSCAPE);
    const cookies = await h.platformAccounts.credentialFor(LOCAL.userId, "bilibili")?.cookies();
    expect(cookies).toContain("amber_test_cookie");
    expect(cookies).not.toContain("foreign_cookie");
    expect(cookies?.startsWith("# Netscape HTTP Cookie File")).toBe(true);

    expect(await codeOf(() => h.platformAccounts.putCookies(LOCAL, "youtube", NETSCAPE))).toBe("invalid_request.cookie_format");
    expect(accountOf(h, "youtube")).toBeUndefined();
  });

  it("records valid and expired checks but leaves the status alone on unknown or a network error", async () => {
    const h = harness();
    expect(await codeOf(() => h.platformAccounts.check(LOCAL, "bilibili", signal))).toBe("not_found");
    h.platformAccounts.putCookies(LOCAL, "bilibili", COOKIE);

    h.platforms.bilibili.credentialStatus = "expired";
    expect(await h.platformAccounts.check(LOCAL, "bilibili", signal)).toEqual({ status: "expired" });
    const expired = accountOf(h, "bilibili");
    expect(expired?.status).toBe("expired");
    expect(typeof expired?.checkedAt).toBe("number");

    h.platforms.bilibili.credentialStatus = "unknown";
    expect(await h.platformAccounts.check(LOCAL, "bilibili", signal)).toEqual({ status: "unknown" });
    expect(accountOf(h, "bilibili")).toEqual(expired);

    h.platforms.bilibili.checkCredential = async () => Promise.reject(amberError("source_unreachable", "scripted"));
    expect(await codeOf(() => h.platformAccounts.check(LOCAL, "bilibili", signal))).toBe("source_unreachable");
    expect(accountOf(h, "bilibili")).toEqual(expired);
  });

  it("deletes the account together with its Secret, and answers not_found when there is none", async () => {
    const h = harness();
    expect(await codeOf(() => h.platformAccounts.delete(LOCAL, "bilibili"))).toBe("not_found");
    h.platformAccounts.putCookies(LOCAL, "bilibili", COOKIE);
    expect(await codeOf(() => h.platformAccounts.delete(BOB, "bilibili"))).toBe("not_found");
    h.platformAccounts.delete(LOCAL, "bilibili");
    expect(countRows(h.db, "platform_account")).toBe(0);
    expect(countRows(h.db, "secret")).toBe(0);
    expect(h.platformAccounts.credentialFor(LOCAL.userId, "bilibili")).toBeUndefined();
  });

  it("decrypts the cookie only when an adapter asks for it", async () => {
    const h = harness();
    h.platformAccounts.putCookies(LOCAL, "bilibili", COOKIE);
    const reveal = vi.spyOn(h.secrets, "reveal");
    const credential = h.platformAccounts.credentialFor(LOCAL.userId, "bilibili");
    expect(credential?.platform).toBe("bilibili");
    expect(reveal).not.toHaveBeenCalled();
    expect(await credential?.cookies()).toContain("amber_test_cookie\t<placeholder>");
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(h.platformAccounts.credentialFor(BOB.userId, "bilibili")).toBeUndefined();
  });

  it("keeps the cookie only as ciphertext and never in a DTO", () => {
    const h = harness();
    const dto = h.platformAccounts.putCookies(LOCAL, "bilibili", COOKIE);
    expect(JSON.stringify(dto)).not.toContain("amber_test_cookie");
    expect(JSON.stringify(h.platformAccounts.list(LOCAL))).not.toContain("amber_test_cookie");
    const secret = h.db.prepare("SELECT ciphertext FROM secret").get() as { ciphertext: Buffer };
    expect(Buffer.isBuffer(secret.ciphertext)).toBe(true);
    expect(secret.ciphertext.toString("latin1")).not.toContain("amber_test_cookie");
    const stored = everyStoredValue(h);
    expect(stored).not.toContain("amber_test_cookie");
    expect(stored).not.toContain("<placeholder>");
  });

  it("stores a confirmed login as valid, creating or replacing the account, ciphertext only", async () => {
    const h = harness();
    h.platformAccounts.saveConfirmedLogin(LOCAL.userId, "bilibili", NETSCAPE);
    const created = accountOf(h, "bilibili");
    expect(created).toMatchObject({ status: "valid", checkedAt: expect.any(Number) });
    expect(await h.platformAccounts.credentialFor(LOCAL.userId, "bilibili")?.cookies()).not.toContain("foreign_cookie");
    expect(everyStoredValue(h)).not.toContain("amber_test_cookie");

    h.platformAccounts.putCookies(LOCAL, "youtube", "amber_test_cookie=<placeholder>");
    const youtube = accountOf(h, "youtube");
    h.platformAccounts.saveConfirmedLogin(LOCAL.userId, "youtube", ".youtube.com\tTRUE\t/\tTRUE\t0\tamber_new_cookie\t<placeholder>");
    expect(accountOf(h, "youtube")).toMatchObject({ id: youtube?.id, credentialRef: youtube?.credentialRef, status: "valid" });
    expect(await h.platformAccounts.credentialFor(LOCAL.userId, "youtube")?.cookies()).toContain("amber_new_cookie");
    expect(countRows(h.db, "secret")).toBe(2);
    expect(await codeOf(() => h.platformAccounts.saveConfirmedLogin(LOCAL.userId, "bilibili", ".example.com\tTRUE\t/\tTRUE\t0\tforeign\tx"))).toBe(
      "invalid_request.cookie_format",
    );
  });

  it("marks an existing account expired and ignores a platform without one", () => {
    const h = harness();
    h.platformAccounts.saveConfirmedLogin(LOCAL.userId, "bilibili", NETSCAPE);
    h.platformAccounts.markExpired(LOCAL.userId, "bilibili");
    expect(accountOf(h, "bilibili")).toMatchObject({ status: "expired", checkedAt: expect.any(Number) });
    h.platformAccounts.markExpired(LOCAL.userId, "youtube");
    h.platformAccounts.markExpired(BOB.userId, "bilibili");
    expect(countRows(h.db, "platform_account")).toBe(1);
    expect(accountOf(h, "bilibili", BOB.userId)).toBeUndefined();
  });
});

describe("PlatformAccountService.importFromBrowser", () => {
  const BROWSER_JAR = [
    "# Netscape HTTP Cookie File",
    ".youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\t<placeholder>",
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tamber_test_cookie\t<placeholder>",
    ".google.com\tTRUE\t/\tTRUE\t0\tforeign_cookie\t<placeholder>",
    "",
  ].join("\n");

  /** Gives the fake YouTube adapter a scripted browser export and records the browsers asked for. */
  function withBrowserExport(h: Harness, jar: string | Error = BROWSER_JAR): string[] {
    const browsers: string[] = [];
    Object.assign(h.platforms.youtube, {
      importBrowserCookies: async (browser: string, given: AbortSignal) => {
        expect(given).toBe(signal);
        browsers.push(browser);
        if (jar instanceof Error) {
          throw jar;
        }
        return jar;
      },
    });
    return browsers;
  }

  it("asks the named browser, else the user's setting, else PLATFORM_COOKIE_BROWSER_DEFAULT", async () => {
    const h = harness();
    const browsers = withBrowserExport(h);
    await h.platformAccounts.importFromBrowser(LOCAL, "youtube", undefined, signal);
    h.userSettings.patch(LOCAL, { platformCookieBrowser: "edge" });
    await h.platformAccounts.importFromBrowser(LOCAL, "youtube", undefined, signal);
    await h.platformAccounts.importFromBrowser(LOCAL, "youtube", "chrome", signal);
    expect(browsers).toEqual([PLATFORM_COOKIE_BROWSER_DEFAULT, "edge", "chrome"]);
  });

  it("keeps only the platform's cookies and stores them like PUT cookies, status unknown, ciphertext only", async () => {
    const h = harness();
    withBrowserExport(h);
    h.platformAccounts.saveConfirmedLogin(LOCAL.userId, "youtube", ".youtube.com\tTRUE\t/\tTRUE\t0\told_cookie\t<placeholder>");
    const before = accountOf(h, "youtube");
    const dto = await h.platformAccounts.importFromBrowser(LOCAL, "youtube", "firefox", signal);
    expect(dto).toEqual({ platform: "youtube", credentialStatus: "configured", hasCredential: true, status: "unknown" });
    expect(accountOf(h, "youtube")).toMatchObject({ id: before?.id, credentialRef: before?.credentialRef, status: "unknown" });
    expect(accountOf(h, "youtube")?.checkedAt).toBeUndefined();
    const stored = await h.platformAccounts.credentialFor(LOCAL.userId, "youtube")?.cookies();
    expect(stored).toContain("LOGIN_INFO");
    expect(stored).toContain("amber_test_cookie");
    expect(stored).not.toContain("foreign_cookie");
    expect(stored).not.toContain("old_cookie");
    expect(everyStoredValue(h)).not.toContain("amber_test_cookie");
    expect(h.platforms.youtube.callsOf("checkCredential")).toEqual([]);
  });

  it("is browser_cookies_unavailable when nothing of the platform is left, and stores nothing", async () => {
    const h = harness();
    for (const jar of ["# Netscape HTTP Cookie File\n.google.com\tTRUE\t/\tTRUE\t0\tforeign_cookie\t<placeholder>\n", "# Netscape HTTP Cookie File\n"]) {
      withBrowserExport(h, jar);
      expect(await codeOf(() => h.platformAccounts.importFromBrowser(LOCAL, "youtube", "firefox", signal))).toBe("browser_cookies_unavailable");
    }
    withBrowserExport(h, amberError("browser_cookies_unavailable", "scripted"));
    expect(await codeOf(() => h.platformAccounts.importFromBrowser(LOCAL, "youtube", "firefox", signal))).toBe("browser_cookies_unavailable");
    expect(accountOf(h, "youtube")).toBeUndefined();
    expect(countRows(h.db, "secret")).toBe(0);
  });

  it("refuses a platform whose adapter cannot read a browser", async () => {
    const h = harness();
    expect((h.platforms.bilibili as PlatformSourceAdapter).importBrowserCookies).toBeUndefined();
    expect(await codeOf(() => h.platformAccounts.importFromBrowser(LOCAL, "bilibili", "firefox", signal))).toBe("not_found");
    expect(countRows(h.db, "platform_account")).toBe(0);
  });
});
