import { readFileSync } from "node:fs";
import { signDouyinQuery } from "../../../../src/server/adapters/platform/douyin/sign.ts";
import type { OutboundRequest } from "../../../../src/server/ports/outbound-http.ts";
import { ScriptedHttp, type ScriptedResponse } from "../scripted-io.ts";

/**
 * A scripted Douyin web platform for adapter tests. It hands out visitor sessions the way the
 * platform does (a `ttwid` cookie from the registration POST, a uifid in the homepage's trace
 * header), refuses an API request whose query is not exactly the one signed for the live
 * session with the platform's own refusal text, and answers the detail and collection APIs
 * through handlers a test replaces. Every value here is synthetic.
 */

export const SIGNATURE_REFUSAL = "Blocked by ArgusSecurityPlugin Sign Invalid";

export function douyinFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T;
}

export type DetailBody = { aweme_detail: Record<string, unknown> | null; [key: string]: unknown };

/** A fresh copy of the recorded video detail, for a test to change. */
export function videoDetail(): DetailBody {
  return douyinFixture<DetailBody>("detail-video.json");
}

/** A fresh copy of the recorded collection page. */
export function mixPage(): { aweme_list: Array<Record<string, unknown>>; cursor: number; has_more: number; [key: string]: unknown } {
  return douyinFixture("mix-page.json");
}

export interface FakeDouyin {
  http: ScriptedHttp;
  /** Synthetic session values handed out so far, for leak checks. */
  readonly handedOut: string[];
  /** Answers the detail API for an id; the recorded video by default. */
  detail: (awemeId: string, request: OutboundRequest) => ScriptedResponse | Error;
  /** Answers the collection API for a cursor; the recorded page by default. */
  mix: (cursor: number, request: OutboundRequest) => ScriptedResponse | Error;
  /** Answers the short link host; 404 by default. */
  shortLink: (request: OutboundRequest) => ScriptedResponse;
  register: () => ScriptedResponse | undefined;
  home: () => ScriptedResponse | undefined;
  /** While true every API request is refused as badly signed, whatever the session. */
  refuseAll: boolean;
  /** Uifids the platform no longer honours. */
  readonly revoked: Set<string>;
  /** Requests that reached the API paths. */
  api(path: "detail" | "mix"): OutboundRequest[];
  registrations(): OutboundRequest[];
  homepages(): OutboundRequest[];
}

const DETAIL_PATH = "/aweme/v1/web/aweme/detail/";
const MIX_PATH = "/aweme/v1/web/mix/aweme/";
const SIGNATURE_PARAM = "&x-secsdk-web-signature=";

/** The query as the platform would have expected it signed, from the params the client sent. */
function expectedQuery(search: string, liveUifids: ReadonlySet<string>): boolean {
  const query = search.slice(1);
  const cut = query.indexOf(SIGNATURE_PARAM);
  if (cut < 0) {
    return false;
  }
  const params = [...new URLSearchParams(query.slice(0, cut))];
  const uifid = params.find(([name]) => name === "uifid")?.[1];
  const timestamp = params.find(([name]) => name === "timestamp")?.[1];
  if (uifid === undefined || timestamp === undefined || !liveUifids.has(uifid)) {
    return false;
  }
  const rest = params.filter(([name]) => name !== "uifid" && name !== "timestamp");
  return signDouyinQuery(rest, uifid, Number(timestamp)) === query;
}

export function fakeDouyin(): FakeDouyin {
  let sessions = 0;
  const live = new Set<string>();
  const fake: FakeDouyin = {
    http: new ScriptedHttp(),
    handedOut: [],
    detail: () => ({ body: videoDetail() }),
    mix: () => ({ body: mixPage() }),
    shortLink: () => ({ status: 404 }),
    register: () => undefined,
    home: () => undefined,
    refuseAll: false,
    revoked: new Set<string>(),
    api: (path) => fake.http.to(path === "detail" ? DETAIL_PATH : MIX_PATH),
    registrations: () => fake.http.to("/ttwid/register"),
    homepages: () => fake.http.requests.filter((request) => request.url === "https://www.douyin.com/"),
  };
  fake.http.handler = (request) => {
    const url = new URL(request.url);
    if (url.hostname === "v.douyin.com") {
      return fake.shortLink(request);
    }
    if (url.hostname !== "www.douyin.com") {
      return { status: 404 };
    }
    if (url.pathname === "/ttwid/register" && request.method === "POST") {
      const scripted = fake.register();
      if (scripted !== undefined) {
        return scripted;
      }
      sessions += 1;
      const ttwid = `TESTONLY_ttwid${sessions}`;
      fake.handedOut.push(ttwid);
      return { body: { status_code: 0, message: "register success" }, setCookies: [`ttwid=${ttwid}; Path=/; Domain=douyin.com; HttpOnly; Secure`] };
    }
    if (url.pathname === "/" && request.method === "GET") {
      const scripted = fake.home();
      if (scripted !== undefined) {
        return scripted;
      }
      const uifid = `TESTONLYuifid${String(sessions).padStart(4, "0")}`;
      fake.handedOut.push(uifid);
      live.add(uifid);
      return { body: "<html></html>", headers: { "Content-Type": "text/html", "x-tt-trace-host": uifid }, setCookies: ["__ac_nonce=TESTONLY_nonce; Path=/"] };
    }
    const honoured = new Set([...live].filter((uifid) => !fake.revoked.has(uifid)));
    if (url.pathname === DETAIL_PATH || url.pathname === MIX_PATH) {
      if (fake.refuseAll || !expectedQuery(url.search, honoured)) {
        return { status: 403, body: SIGNATURE_REFUSAL, headers: { "Content-Type": "text/plain" } };
      }
      return url.pathname === DETAIL_PATH ? fake.detail(url.searchParams.get("aweme_id") ?? "", request) : fake.mix(Number(url.searchParams.get("cursor")), request);
    }
    return { status: 404 };
  };
  return fake;
}

/** The query parameters of an API request, without the session's. */
export function apiParams(request: OutboundRequest): Record<string, string> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  delete params["uifid"];
  delete params["timestamp"];
  delete params["x-secsdk-web-signature"];
  return params;
}
