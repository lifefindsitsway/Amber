import { amberError } from "../../../domain/errors.ts";
import { canonicalPlatformCookies, formatNetscapeCookies, parseSetCookie, type NetscapeCookie } from "../../../domain/platform-cookie.ts";
import type { OutboundHttpClient } from "../../../ports/outbound-http.ts";
import type { PlatformQrLogin, QrLoginTicket, QrPollResult } from "../../../ports/platform-login.ts";
import { z } from "zod";
import { apiError, bilibiliEnvelope, dataOf } from "./api.ts";
import { BILIBILI_COOKIE_DOMAINS } from "./index.ts";

const PASSPORT_HOST = "passport.bilibili.com";
const QR_API = `https://${PASSPORT_HOST}/x/passport-login/web/qrcode`;
const WEB_ORIGIN = { Origin: "https://www.bilibili.com", Referer: "https://www.bilibili.com/" };
/** The cookie that is the login itself; a confirmation without it handed nothing usable over. */
const SESSION_COOKIE = "SESSDATA";

/** `data.code` of a poll answer; the outer `code` stays 0 while the code is alive. */
const POLL_STATUS: Readonly<Record<number, "pending" | "scanned" | "expired" | "confirmed">> = {
  86101: "pending",
  86090: "scanned",
  86038: "expired",
  0: "confirmed",
};

const generateSchema = z.object({ url: z.string().nullish(), qrcode_key: z.string().nullish() }).nullish();
const pollSchema = z.object({ code: z.number().int().nullish() }).nullish();

export interface BilibiliQrLoginOptions {
  http: OutboundHttpClient;
  now?: () => number;
}

/**
 * The web QR login of bilibili's passport: `generate` hands out the code's
 * URL and a key, `poll` reports progress in `data.code` and, once the user confirms in the
 * app, sets the login cookies on its response. Only `Set-Cookie` is read; the `url` in the
 * confirmed answer repeats the cookies in its query string and is never touched. The
 * platform states no lifetime for the code, so `expiresAt` is left to the caller.
 */
export class BilibiliQrLogin implements PlatformQrLogin {
  readonly platform = "bilibili" as const;
  private readonly options: BilibiliQrLoginOptions;
  private readonly now: () => number;

  constructor(options: BilibiliQrLoginOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async start(signal: AbortSignal): Promise<QrLoginTicket> {
    const envelope = await bilibiliEnvelope(this.options.http, { url: `${QR_API}/generate`, headers: WEB_ORIGIN, signal });
    if (envelope.code !== 0) {
      throw apiError(envelope.code);
    }
    const { url, qrcode_key: key } = dataOf(generateSchema, envelope.data, "a QR code") ?? {};
    if (url === undefined || url === null || url === "" || key === undefined || key === null || key === "") {
      throw amberError("source_unreachable", "bilibili returned no QR code");
    }
    return { qrUrl: url, key };
  }

  async poll(key: string, signal: AbortSignal): Promise<QrPollResult> {
    const envelope = await bilibiliEnvelope(this.options.http, {
      url: `${QR_API}/poll?qrcode_key=${encodeURIComponent(key)}`,
      headers: WEB_ORIGIN,
      signal,
    });
    const { setCookies } = envelope;
    if (envelope.code !== 0) {
      throw apiError(envelope.code);
    }
    const pollCode = dataOf(pollSchema, envelope.data, "a QR poll")?.code;
    const status = pollCode === undefined || pollCode === null ? undefined : POLL_STATUS[pollCode];
    if (status === undefined) {
      throw amberError("source_unreachable", `bilibili QR poll answered code ${String(pollCode)}`);
    }
    if (status !== "confirmed") {
      return { status };
    }
    const now = this.now();
    const cookies = setCookies
      .map((header) => parseSetCookie(header, PASSPORT_HOST, now))
      .filter((cookie): cookie is NetscapeCookie => cookie !== undefined);
    if (!cookies.some((cookie) => cookie.name === SESSION_COOKIE)) {
      throw amberError("source_unreachable", "bilibili confirmed the QR login without a session cookie");
    }
    return { status, cookies: canonicalPlatformCookies(formatNetscapeCookies(cookies), BILIBILI_COOKIE_DOMAINS, now) };
  }
}
