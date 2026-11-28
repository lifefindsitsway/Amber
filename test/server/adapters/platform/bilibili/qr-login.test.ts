import { describe, expect, it } from "vitest";
import { BilibiliQrLogin } from "../../../../../src/server/adapters/platform/bilibili/qr-login.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { parseNetscapeCookies } from "../../../../../src/server/domain/platform-cookie.ts";
import type { AppError } from "../../../../../src/shared/errors.ts";
import { GENERATE, POLL_CONFIRMED, POLL_EXPIRED, POLL_PENDING, POLL_SCANNED, QR_KEY, QR_URL } from "../../../../fixtures/platform/bilibili-qr.ts";
import { ScriptedHttp, signal, type ScriptedResponse } from "../../../../fixtures/platform/scripted-io.ts";

const NOW = Date.UTC(2026, 9, 1);

function setup(poll: ScriptedResponse | Error, generate: ScriptedResponse = GENERATE) {
  const http = new ScriptedHttp((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/qrcode/generate")) return generate;
    if (path.endsWith("/qrcode/poll")) return poll;
    return { status: 404 };
  });
  return { login: new BilibiliQrLogin({ http, now: () => NOW }), http };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("BilibiliQrLogin", () => {
  it("runs a whole login from the recorded answers: code, pending, scanned, confirmed", async () => {
    const polls: ScriptedResponse[] = [POLL_PENDING, POLL_SCANNED, POLL_CONFIRMED];
    const http = new ScriptedHttp((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/qrcode/generate")) return GENERATE;
      if (path.endsWith("/qrcode/poll")) return polls.shift() ?? { status: 404 };
      return { status: 404 };
    });
    const login = new BilibiliQrLogin({ http, now: () => NOW });
    const ticket = await login.start(signal());
    expect(ticket).toEqual({ qrUrl: QR_URL, key: QR_KEY });
    expect((await login.poll(ticket.key, signal())).status).toBe("pending");
    expect((await login.poll(ticket.key, signal())).status).toBe("scanned");
    const confirmed = await login.poll(ticket.key, signal());
    expect(confirmed.status).toBe("confirmed");
    const cookies = parseNetscapeCookies(confirmed.status === "confirmed" ? confirmed.cookies : "");
    expect(cookies.map((cookie) => cookie.name)).toContain("SESSDATA");
    expect(http.requests).toHaveLength(4);
    for (const request of http.requests) {
      expect(request).toMatchObject({ method: "GET", publicOnly: true });
      expect(new URL(request.url).host).toBe("passport.bilibili.com");
    }
    // Every answer was read whole: none was discarded unread.
    expect(http.destroyed).toEqual([]);
  });

  it("asks the passport for a code from the web origin and leaves its lifetime to the caller", async () => {
    const { login, http } = setup(POLL_PENDING);
    expect(await login.start(signal())).toEqual({ qrUrl: QR_URL, key: QR_KEY });
    const [request] = http.requests;
    expect(new URL(request?.url ?? "").host).toBe("passport.bilibili.com");
    expect(request?.method).toBe("GET");
    expect(request?.headers).toMatchObject({ Referer: "https://www.bilibili.com/", Origin: "https://www.bilibili.com" });
  });

  it("maps the poll codes onto the attempt states, sending the key", async () => {
    for (const [answer, status] of [
      [POLL_PENDING, "pending"],
      [POLL_SCANNED, "scanned"],
      [POLL_EXPIRED, "expired"],
    ] as const) {
      const { login, http } = setup(answer);
      expect(await login.poll(QR_KEY, signal())).toEqual({ status });
      expect(new URL(http.requests[0]?.url ?? "").searchParams.get("qrcode_key")).toBe(QR_KEY);
    }
  });

  it("hands over the login from Set-Cookie as canonical cookies.txt of bilibili.com only", async () => {
    const foreign = { ...POLL_CONFIRMED, setCookies: [...(POLL_CONFIRMED.setCookies ?? []), "tracker=<placeholder>; Domain=example.com"] };
    const { login } = setup(foreign);
    const result = await login.poll(QR_KEY, signal());
    expect(result.status).toBe("confirmed");
    const cookies = parseNetscapeCookies(result.status === "confirmed" ? result.cookies : "");
    expect(cookies.map((cookie) => cookie.name)).toEqual(["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"]);
    expect(cookies.every((cookie) => cookie.domain === ".bilibili.com")).toBe(true);
    expect(cookies.find((cookie) => cookie.name === "SESSDATA")).toMatchObject({ httpOnly: true, secure: true });
  });

  it("refuses a confirmation that carries no session cookie", async () => {
    const { login } = setup({ ...POLL_CONFIRMED, setCookies: ["bili_jct=<placeholder>; Domain=bilibili.com"] });
    expect((await errorOf(login.poll(QR_KEY, signal()))).class).toBe("source_unreachable");
    const bare = setup({ ...POLL_CONFIRMED, setCookies: [] });
    expect((await errorOf(bare.login.poll(QR_KEY, signal()))).class).toBe("source_unreachable");
  });

  it("classifies risk control, unknown codes and missing data without echoing the key or URL", async () => {
    const blocked = setup({ body: { code: -412, message: "request was banned" } });
    expect((await errorOf(blocked.login.poll(QR_KEY, signal()))).class).toBe("platform_blocked");
    const http412 = setup({ status: 412 });
    expect((await errorOf(http412.login.poll(QR_KEY, signal()))).class).toBe("platform_blocked");
    const unknown = setup({ body: { code: 0, data: { code: 12345 } } });
    const error = await errorOf(unknown.login.poll(QR_KEY, signal()));
    expect(error.class).toBe("source_unreachable");
    expect(JSON.stringify(error)).not.toContain(QR_KEY);
    const empty = setup(POLL_PENDING, { body: { code: 0, data: {} } });
    expect((await errorOf(empty.login.start(signal()))).class).toBe("source_unreachable");
    const refused = setup(POLL_PENDING, { body: { code: -412 } });
    expect((await errorOf(refused.login.start(signal()))).class).toBe("platform_blocked");
  });
});
