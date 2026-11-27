import { afterEach, describe, expect, it } from "vitest";
import { amberError } from "../../../../src/server/domain/errors.ts";
import { BilibiliQrLogin } from "../../../../src/server/adapters/platform/bilibili/qr-login.ts";
import { PlatformQrLoginService } from "../../../../src/server/application/platform-qr-login.ts";
import { QR_POLL_INTERVAL_MS } from "../../../../src/shared/defaults.ts";
import { GENERATE, POLL_CONFIRMED, QR_KEY, QR_URL } from "../../../fixtures/platform/bilibili-qr.ts";
import { ScriptedHttp } from "../../../fixtures/platform/scripted-io.ts";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { createServerApp, CSRF_HEADERS, type ServerApp } from "../../../fixtures/server/server-app.ts";
import { countRows } from "../../../tools/sqlite.ts";

// A distinctive cookie name so its plaintext can be searched for in responses and logs.
const COOKIE = "amber_test_cookie=<placeholder>";
const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const lines: string[] = [];
  const { app } = await h.app({ log: { write: (line) => void lines.push(line) } });
  return { h, app, lines };
}

describe("/api/platform-accounts", () => {
  it("lists the login platforms, stores cookies as unknown, checks them and deletes the account", async () => {
    const { h, app } = await setup();
    const empty = await app.inject({ method: "GET", url: "/api/platform-accounts", headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      accounts: [
        { platform: "bilibili", credentialStatus: "missing", hasCredential: false },
        { platform: "youtube", credentialStatus: "missing", hasCredential: false },
        { platform: "xiaohongshu", credentialStatus: "missing", hasCredential: false },
      ],
    });

    const put = await app.inject({ method: "PUT", url: "/api/platform-accounts/bilibili/cookies", headers: auth, payload: { value: COOKIE } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ platform: "bilibili", credentialStatus: "configured", hasCredential: true, status: "unknown" });
    expect(h.platforms.bilibili.callsOf("checkCredential")).toEqual([]);

    h.platforms.bilibili.credentialStatus = "expired";
    const check = await app.inject({ method: "POST", url: "/api/platform-accounts/bilibili/check", headers: auth });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({ status: "expired" });
    const listed = await app.inject({ method: "GET", url: "/api/platform-accounts", headers: auth });
    expect(listed.json().accounts[0]).toMatchObject({ platform: "bilibili", status: "expired", checkedAt: expect.any(Number) });

    // Another user sees and can remove nothing of it.
    expect((await app.inject({ method: "GET", url: "/api/platform-accounts", headers: bob })).json().accounts[0].hasCredential).toBe(false);
    expect((await app.inject({ method: "DELETE", url: "/api/platform-accounts/bilibili", headers: bob })).statusCode).toBe(404);

    const deleted = await app.inject({ method: "DELETE", url: "/api/platform-accounts/bilibili", headers: auth });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(countRows(h.db, "secret")).toBe(0);
    expect((await app.inject({ method: "DELETE", url: "/api/platform-accounts/bilibili", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/platform-accounts/bilibili/check", headers: auth })).statusCode).toBe(404);
  });

  it("answers 404 for a platform Amber does not support", async () => {
    const { app } = await setup();
    for (const request of [
      { method: "PUT" as const, url: "/api/platform-accounts/vimeo/cookies", payload: { value: COOKIE } },
      { method: "POST" as const, url: "/api/platform-accounts/vimeo/check" },
      { method: "DELETE" as const, url: "/api/platform-accounts/vimeo" },
    ]) {
      const response = await app.inject({ ...request, headers: auth });
      expect(response.statusCode, request.url).toBe(404);
      expect(response.json().error.class).toBe("not_found");
    }
  });

  it("answers 404 for a supported platform without login support, like an unknown one", async () => {
    const { app } = await setup();
    for (const request of [
      { method: "PUT" as const, url: "/api/platform-accounts/douyin/cookies", payload: { value: COOKIE } },
      { method: "POST" as const, url: "/api/platform-accounts/douyin/check" },
      { method: "DELETE" as const, url: "/api/platform-accounts/douyin" },
    ]) {
      const response = await app.inject({ ...request, headers: auth });
      expect(response.statusCode, request.url).toBe(404);
      expect(response.json().error.class).toBe("not_found");
    }
  });

  it("rejects malformed cookie bodies and cookie text without the platform's domains", async () => {
    const { app } = await setup();
    for (const payload of [{}, { value: "" }, { value: COOKIE, extra: true }]) {
      const response = await app.inject({ method: "PUT", url: "/api/platform-accounts/bilibili/cookies", headers: auth, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const foreign = "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tamber_test_cookie\t<placeholder>\n";
    const response = await app.inject({ method: "PUT", url: "/api/platform-accounts/bilibili/cookies", headers: auth, payload: { value: foreign } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request.cookie_format");
    expect(response.body).not.toContain("amber_test_cookie");
  });

  it("maps a failed check to its error without touching the stored status", async () => {
    const { h, app } = await setup();
    await app.inject({ method: "PUT", url: "/api/platform-accounts/bilibili/cookies", headers: auth, payload: { value: COOKIE } });
    h.platforms.bilibili.checkCredential = async () => Promise.reject(amberError("source_unreachable", "scripted"));
    const response = await app.inject({ method: "POST", url: "/api/platform-accounts/bilibili/check", headers: auth });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.class).toBe("source_unreachable");
    expect((await app.inject({ method: "GET", url: "/api/platform-accounts", headers: auth })).json().accounts[0].status).toBe("unknown");
  });

  it("never echoes the cookie in responses or logs", async () => {
    const { h, app, lines } = await setup();
    const responses = [
      await app.inject({ method: "PUT", url: "/api/platform-accounts/bilibili/cookies", headers: auth, payload: { value: COOKIE } }),
      await app.inject({ method: "PUT", url: "/api/platform-accounts/youtube/cookies", headers: auth, payload: { value: COOKIE } }),
      await app.inject({ method: "POST", url: "/api/platform-accounts/bilibili/check", headers: auth }),
      await app.inject({ method: "GET", url: "/api/platform-accounts", headers: auth }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("amber_test_cookie");
      expect(response.body).not.toContain("<placeholder>");
    }
    expect(h.platforms.bilibili.callsOf("checkCredential")).toEqual([{ method: "checkCredential", target: "", withAuth: true }]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("amber_test_cookie");
    expect(lines.join("\n")).not.toContain("<placeholder>");
  });
});

describe("/api/platform-accounts/bilibili/qr", () => {
  const servers: ServerApp[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  async function serverSetup() {
    const lines: string[] = [];
    const http = new ScriptedHttp((request) => (new URL(request.url).pathname.endsWith("/generate") ? GENERATE : POLL_CONFIRMED));
    const s = await createServerApp({
      log: { write: (line) => void lines.push(line) },
      platformQrLogin: (h, clock) =>
        new PlatformQrLoginService({ logins: [new BilibiliQrLogin({ http, now: () => clock.now })], accounts: h.platformAccounts, now: () => clock.now }),
    });
    servers.push(s);
    await s.addUser("alice");
    await s.addUser("bob");
    return { s, lines, alice: { ...CSRF_HEADERS, cookie: await s.login("alice") }, bob: { ...CSRF_HEADERS, cookie: await s.login("bob") } };
  }

  it("starts an attempt and reports it confirmed once the platform hands the login over (server mode)", async () => {
    const { s, lines, alice } = await serverSetup();
    const started = await s.app.inject({ method: "POST", url: "/api/platform-accounts/bilibili/qr", headers: alice });
    expect(started.statusCode).toBe(200);
    const { attemptId, qrUrl, expiresAt } = started.json();
    expect(qrUrl).toBe(QR_URL);
    expect(expiresAt).toBeGreaterThan(s.clock.now);

    s.clock.now += QR_POLL_INTERVAL_MS;
    const polled = await s.app.inject({ method: "GET", url: `/api/platform-accounts/bilibili/qr/${attemptId}`, headers: alice });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toEqual({ status: "confirmed" });
    const listed = await s.app.inject({ method: "GET", url: "/api/platform-accounts", headers: alice });
    expect(listed.json().accounts[0]).toMatchObject({ platform: "bilibili", hasCredential: true, status: "valid" });
    expect(listed.body).not.toContain("SESSDATA");

    // The login token in the code and the cookies stay out of the logs.
    const logged = lines.join("\n");
    expect(logged).not.toContain(QR_KEY);
    expect(logged).not.toContain("SESSDATA");
  });

  it("hides one user's attempt from another", async () => {
    const { s, alice, bob } = await serverSetup();
    const { attemptId } = (await s.app.inject({ method: "POST", url: "/api/platform-accounts/bilibili/qr", headers: alice })).json();
    const foreign = await s.app.inject({ method: "GET", url: `/api/platform-accounts/bilibili/qr/${attemptId}`, headers: bob });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.class).toBe("not_found");
    const listed = await s.app.inject({ method: "GET", url: "/api/platform-accounts", headers: bob });
    expect(listed.json().accounts[0].hasCredential).toBe(false);
  });

  it("does not exist in local mode", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/platform-accounts/bilibili/qr", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/platform-accounts/bilibili/qr/01UNKNOWNATTEMPT0000000000", headers: auth })).statusCode).toBe(404);
  });
});
