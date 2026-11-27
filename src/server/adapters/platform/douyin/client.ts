import { randomBytes } from "node:crypto";
import {
  DOUYIN_BLOCK_COOLDOWN_MS,
  DOUYIN_VISITOR_TTL_MS,
  PLATFORM_JSON_MAX_BYTES,
  PLATFORM_METADATA_TIMEOUT_MS,
  PLATFORM_PAGE_MAX_BYTES,
} from "../../../../shared/defaults.ts";
import { amberError } from "../../../domain/errors.ts";
import { OutboundHttpError, type OutboundHttpClient } from "../../../ports/outbound-http.ts";
import { BROWSER_USER_AGENT, platformGetText, type PlatformTextResponse } from "../http.ts";
import { signDouyinQuery } from "./sign.ts";

/** The web origin every API request goes to. */
export const DOUYIN_ORIGIN = "https://www.douyin.com";
/** Sent with API and media requests: the platform's CDN refuses some media requests without it. */
export const DOUYIN_REFERER = `${DOUYIN_ORIGIN}/`;
/** Hosts a short link may lead through before it names a supported page. */
export const DOUYIN_PAGE_HOSTS: readonly string[] = ["douyin.com", "iesdouyin.com"];
/**
 * Hosts media addresses are taken from: the video CDNs and the web API's play redirect, which
 * hands over to one of them. Every redirect hop of a download is checked against the same list.
 */
export const DOUYIN_MEDIA_HOSTS: readonly string[] = ["douyinvod.com", "zjcdn.com", "douyin.com"];
/** Where covers and chapter thumbnails are served from. */
export const DOUYIN_IMAGE_HOSTS: readonly string[] = ["douyinpic.com"];

/**
 * The web client's application id. The API answers the full list of quality tiers (1080P
 * included) only to this one; without it the list stops at the adaptive 720P streams.
 */
const WEB_AID = "6383";
const TTWID_REGISTER_URL = `${DOUYIN_ORIGIN}/ttwid/register`;
/** Cookie names the homepage may hand the uifid in; when none, the trace header carries an equivalent value. */
const UIFID_COOKIES: ReadonlySet<string> = new Set(["uifid", "uifid_temp", "uifidtemp"]);
const UIFID_HEADER = "x-tt-trace-host";
const UIFID_PATTERN = /^[0-9A-Za-z]{16,1024}$/;
/** A cookie value as RFC 6265 allows it unquoted, so it can be sent back verbatim. */
const TTWID_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,1024}$/;
/** How the platform words a request whose signature it refused. */
const SIGNATURE_REFUSED = /sign\s*invalid/i;

/**
 * True when `url` is an `https` URL without user info or port whose host is one of `hosts`
 * or below one of them at a domain boundary (`douyin.com` admits `www.douyin.com`, not
 * `evildouyin.com`).
 */
export function isOnHosts(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function refusedHost(): Error {
  return amberError("source_unreachable", "refused a platform address outside the allowed hosts");
}

export function accessChanged(): Error {
  return amberError("platform_blocked", "the platform refused the request signature after a fresh visitor session", {
    code: "platform_blocked.access_changed",
  });
}

export function visitorRefused(status: number): Error {
  return amberError("platform_blocked", `platform answered HTTP ${status}`, { code: "platform_blocked.visitor_refused" });
}

function unreachable(message: string): Error {
  return amberError("source_unreachable", message);
}

/** Visitor cookies and the uifid of one session; held in memory only, never written or logged. */
interface VisitorSession {
  readonly ttwid: string;
  readonly csrfToken: string;
  readonly uifid: string;
  readonly createdAt: number;
}

function cookieValue(setCookies: readonly string[], names: (name: string) => boolean): string | undefined {
  for (const header of setCookies) {
    const pair = header.split(";", 1)[0] ?? "";
    const equals = pair.indexOf("=");
    if (equals > 0 && names(pair.slice(0, equals).trim())) {
      return pair.slice(equals + 1).trim();
    }
  }
  return undefined;
}

function sessionCookie(session: VisitorSession): string {
  return `ttwid=${session.ttwid}; passport_csrf_token=${session.csrfToken}`;
}

/** The answer of one signed API request after the signature check passed. */
export interface DouyinApiResponse {
  status: number;
  text: string;
}

/**
 * Reads the platform's web API as a visitor, for the whole process: a visitor session serves
 * every user (the platform limits by network address, not by account) until
 * `DOUYIN_VISITOR_TTL_MS` passes. A request whose signature is refused rebuilds the session and
 * is sent once more; refused again, no request reaches the platform for
 * `DOUYIN_BLOCK_COOLDOWN_MS`, and every call fails with `platform_blocked.access_changed`.
 */
export class DouyinClient {
  private readonly http: OutboundHttpClient;
  private readonly now: () => number;
  private session: VisitorSession | undefined;
  private building: Promise<VisitorSession> | undefined;
  private blockedUntil = Number.NEGATIVE_INFINITY;

  constructor(http: OutboundHttpClient, now: () => number) {
    this.http = http;
    this.now = now;
  }

  /** Fails while a refused signature keeps the platform off limits. */
  assertOpen(): void {
    if (this.now() < this.blockedUntil) {
      throw accessChanged();
    }
  }

  /**
   * One signed GET of `path` under the web origin. Returns any answer except a refused
   * signature, which is handled here; the caller maps the status and parses the body.
   */
  async get(path: string, params: ReadonlyArray<readonly [string, string]>, signal: AbortSignal): Promise<DouyinApiResponse> {
    this.assertOpen();
    const first = await this.currentSession(signal);
    const answer = await this.send(path, params, first, signal);
    if (!isSignatureRefusal(answer)) {
      return answer;
    }
    this.drop(first);
    const second = await this.currentSession(signal);
    const retried = await this.send(path, params, second, signal);
    if (!isSignatureRefusal(retried)) {
      return retried;
    }
    this.drop(second);
    this.blockedUntil = this.now() + DOUYIN_BLOCK_COOLDOWN_MS;
    throw accessChanged();
  }

  private async send(path: string, params: ReadonlyArray<readonly [string, string]>, session: VisitorSession, signal: AbortSignal): Promise<DouyinApiResponse> {
    const query = signDouyinQuery([...params, ["aid", WEB_AID]], session.uifid, Math.floor(this.now() / 1000));
    const response = await platformGetText(this.http, {
      url: `${DOUYIN_ORIGIN}${path}?${query}`,
      headers: { Referer: DOUYIN_REFERER, Cookie: sessionCookie(session) },
      signal,
      maxBytes: PLATFORM_JSON_MAX_BYTES,
    });
    return { status: response.status, text: response.text };
  }

  private drop(stale: VisitorSession): void {
    if (this.session === stale) {
      this.session = undefined;
    }
  }

  /**
   * The live session, built when there is none or it has expired. Concurrent callers share one
   * build; a caller whose own request is still wanted builds again when the shared build was
   * cancelled by the request that started it.
   */
  private async currentSession(signal: AbortSignal): Promise<VisitorSession> {
    const session = this.session;
    if (session !== undefined && this.now() - session.createdAt < DOUYIN_VISITOR_TTL_MS) {
      return session;
    }
    this.session = undefined;
    try {
      return await this.sharedBuild(signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof OutboundHttpError && error.reason === "aborted")) {
        throw error;
      }
      return this.sharedBuild(signal);
    }
  }

  private sharedBuild(signal: AbortSignal): Promise<VisitorSession> {
    if (this.building === undefined) {
      const build = this.build(signal).then((session) => {
        this.session = session;
        return session;
      });
      this.building = build;
      const clear = () => {
        if (this.building === build) {
          this.building = undefined;
        }
      };
      build.then(clear, clear);
    }
    return this.building;
  }

  /**
   * A fresh visitor: the `ttwid` cookie from the platform's visitor registration, a random
   * CSRF token (the platform only checks that one is present), and the uifid the homepage hands
   * to a browser without a login, as a cookie or in its trace header.
   */
  private async build(signal: AbortSignal): Promise<VisitorSession> {
    const register = await this.postRegister(signal);
    const ttwid = cookieValue(register.setCookies, (name) => name === "ttwid");
    if (ttwid === undefined || !TTWID_PATTERN.test(ttwid)) {
      throw unreachable("the visitor registration set no usable cookie");
    }
    const csrfToken = randomBytes(16).toString("hex");
    const home = await platformGetText(this.http, {
      url: DOUYIN_REFERER,
      headers: { Cookie: `ttwid=${ttwid}; passport_csrf_token=${csrfToken}` },
      signal,
      maxBytes: PLATFORM_PAGE_MAX_BYTES,
    });
    statusCheck(home.status);
    const uifid = cookieValue(home.setCookies, (name) => UIFID_COOKIES.has(name.toLowerCase())) ?? home.headers.get(UIFID_HEADER);
    if (uifid === undefined || !UIFID_PATTERN.test(uifid)) {
      throw unreachable("the homepage handed out no usable visitor id");
    }
    return { ttwid, csrfToken, uifid, createdAt: this.now() };
  }

  /**
   * The visitor registration is the one POST the platform needs. It goes out like every other
   * platform request: a public address only, no redirect followed, the answer read within a cap.
   */
  private async postRegister(signal: AbortSignal): Promise<{ setCookies: readonly string[] }> {
    try {
      const response = await this.http.request({
        url: TTWID_REGISTER_URL,
        method: "POST",
        headers: { "User-Agent": BROWSER_USER_AGENT, "Content-Type": "application/json", Referer: DOUYIN_REFERER },
        body: JSON.stringify({ aid: Number(WEB_AID), service: "www.douyin.com" }),
        signal,
        timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
        redirect: "manual",
        publicOnly: true,
      });
      let read = 0;
      for await (const chunk of response.body) {
        read += chunk.byteLength;
        if (read > PLATFORM_JSON_MAX_BYTES) {
          throw amberError("source_html_error_page", `platform response exceeded ${PLATFORM_JSON_MAX_BYTES} bytes`);
        }
      }
      statusCheck(response.status);
      return { setCookies: response.setCookies ?? [] };
    } catch (error) {
      if (error instanceof OutboundHttpError && error.reason !== "aborted") {
        throw unreachable(error.message);
      }
      throw error;
    }
  }
}

/** 412 / 429 are the platform turning a visitor away; any other non-2xx answer is unreachable. */
export function statusCheck(status: number): void {
  if (status === 412 || status === 429) {
    throw visitorRefused(status);
  }
  if (status < 200 || status >= 300) {
    throw unreachable(`platform answered HTTP ${status}`);
  }
}

function isSignatureRefusal(answer: DouyinApiResponse): boolean {
  return answer.status === 403 && SIGNATURE_REFUSED.test(answer.text);
}

/** A short-link hop's answer, read within the page cap without following it. */
export async function getHop(http: OutboundHttpClient, url: string, signal: AbortSignal): Promise<PlatformTextResponse> {
  return platformGetText(http, { url, signal, maxBytes: PLATFORM_PAGE_MAX_BYTES });
}
