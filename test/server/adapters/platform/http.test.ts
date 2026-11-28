import { describe, expect, it } from "vitest";
import { BROWSER_USER_AGENT, platformGetBytes, platformGetHop, platformGetJson, platformGetText } from "../../../../src/server/adapters/platform/http.ts";
import { amberError, isAmberError } from "../../../../src/server/domain/errors.ts";
import { OutboundHttpError, type OutboundHttpClient } from "../../../../src/server/ports/outbound-http.ts";
import { PLATFORM_JSON_MAX_BYTES, PLATFORM_METADATA_TIMEOUT_MS } from "../../../../src/shared/defaults.ts";
import type { AppError } from "../../../../src/shared/errors.ts";
import { ScriptedHttp, signal, type ScriptedResponse } from "../../../fixtures/platform/scripted-io.ts";

const PAGELIST = "https://api.bilibili.com/x/player/pagelist?bvid=BV1xx411c7mD";
/** The calling adapter's table, as every helper must pass it on. */
const TRUSTED = ["api.example.com", "cdn.example.com"] as const;

const PROXY_ERRORS = [
  ["network_proxy_unsupported.pac", () => amberError("network_proxy_unsupported", "only a PAC script is configured", { code: "network_proxy_unsupported.pac" })],
  ["network_proxy_failed.unreachable", () => amberError("network_proxy_failed", "the proxy refused the connection", { code: "network_proxy_failed.unreachable" })],
] as const;

async function appErrorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

async function classOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.class;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("platformGetJson", () => {
  it("sends a GET with a browser identity, the caller's headers and the metadata timeout", async () => {
    const http = new ScriptedHttp(() => ({ body: { code: 0 } }));
    expect(await platformGetJson(http, { url: PAGELIST, headers: { Referer: "https://www.bilibili.com/", Cookie: "a=<placeholder>" }, signal: signal(), trustedHosts: TRUSTED })).toEqual({
      code: 0,
    });
    expect(http.requests[0]).toMatchObject({
      url: PAGELIST,
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT, Referer: "https://www.bilibili.com/", Cookie: "a=<placeholder>" },
      timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
    });
    expect(http.requests[0]?.redirect).toBeUndefined();
  });

  it("maps risk-control statuses, other HTTP errors and non-JSON bodies to source classes", async () => {
    const cases: Array<[ScriptedResponse, string]> = [
      [{ status: 412, body: "" }, "platform_blocked"],
      [{ status: 429, body: "" }, "platform_blocked"],
      [{ status: 404, body: "{}" }, "source_unreachable"],
      [{ status: 503, body: "{}" }, "source_unreachable"],
      [{ status: 302, body: "", headers: { Location: "https://example.com/" } }, "source_unreachable"],
      [{ status: 200, body: "<html><body>captcha</body></html>" }, "source_html_error_page"],
    ];
    for (const [answer, expected] of cases) {
      expect(await classOf(platformGetJson(new ScriptedHttp(() => answer), { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED })), JSON.stringify(answer)).toBe(expected);
    }
  });

  it("maps transport failures to source_unreachable but lets an abort through", async () => {
    for (const reason of ["network", "timeout"] as const) {
      const http = new ScriptedHttp(() => new OutboundHttpError("before_send", reason));
      expect(await classOf(platformGetJson(http, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED }))).toBe("source_unreachable");
    }
    const aborted = new ScriptedHttp(() => new OutboundHttpError("after_send", "aborted"));
    await expect(platformGetJson(aborted, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED })).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("platformGetJson limits", () => {
  it("discards an error status or an unfollowed redirect unread", async () => {
    for (const answer of [{ status: 503, body: "{}" }, { status: 302, headers: { Location: "https://example.com/" } }, { status: 412 }] as ScriptedResponse[]) {
      const http = new ScriptedHttp(() => answer);
      await classOf(platformGetJson(http, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED }));
      expect(http.destroyed, JSON.stringify(answer)).toEqual([PAGELIST]);
    }
  });

  it("reads within PLATFORM_JSON_MAX_BYTES unless told otherwise, refusing a larger declaration before reading", async () => {
    const declared = new ScriptedHttp(() => ({ body: "{}", headers: { "Content-Length": String(PLATFORM_JSON_MAX_BYTES + 1) } }));
    expect(await classOf(platformGetJson(declared, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED }))).toBe("source_html_error_page");
    expect(declared.destroyed).toEqual([PAGELIST]);
    const long = new ScriptedHttp(() => ({ body: { code: 0, data: "x".repeat(64) } }));
    expect(await classOf(platformGetJson(long, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED, maxBytes: 16 }))).toBe("source_html_error_page");
    const fits = new ScriptedHttp(() => ({ body: { code: 0 } }));
    expect(await platformGetJson(fits, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED, maxBytes: 16 })).toEqual({ code: 0 });
  });
});

describe("platformGetHop", () => {
  it("hands back a redirect's status and resolved target without following it, discarding the body unread", async () => {
    const http = new ScriptedHttp(() => ({ status: 302, headers: { Location: "/video/BV1xx411c7mD" }, body: "moved" }));
    const hop = await platformGetHop(http, { url: "https://b23.tv/abc", signal: signal(), trustedHosts: TRUSTED });
    expect(hop).toMatchObject({ status: 302, location: "https://b23.tv/video/BV1xx411c7mD" });
    expect(http.requests[0]?.headers).toEqual({ "User-Agent": BROWSER_USER_AGENT });
    // The caller walks the chain itself; the client must not follow it.
    expect(http.requests[0]?.redirect).toBe("manual");
    expect(http.destroyed).toEqual(["https://b23.tv/abc"]);
  });

  it("discards a non-redirect answer too and names no location", async () => {
    const http = new ScriptedHttp(() => ({ status: 200, body: "<html>" }));
    expect(await platformGetHop(http, { url: "https://b23.tv/abc", signal: signal(), trustedHosts: TRUSTED })).not.toHaveProperty("location");
    expect(http.destroyed).toHaveLength(1);
  });
});

describe("platformGetBytes", () => {
  const DM = "https://api.bilibili.com/x/v1/dm/list.so?oid=1";

  it("returns the body's bytes as sent with the headers, under the caller's timeout or the metadata one", async () => {
    const http = new ScriptedHttp(() => ({ body: "raw", headers: { "Content-Encoding": "deflate" } }));
    const answer = await platformGetBytes(http, { url: DM, signal: signal(), trustedHosts: TRUSTED, maxBytes: 3, timeoutMs: 1234 });
    expect(Buffer.from(answer.bytes).toString("utf8")).toBe("raw");
    expect(answer.headers.get("content-encoding")).toBe("deflate");
    expect(http.requests[0]).toMatchObject({ url: DM, method: "GET", timeoutMs: 1234, headers: { "User-Agent": BROWSER_USER_AGENT } });
    await platformGetBytes(http, { url: DM, signal: signal(), trustedHosts: TRUSTED, maxBytes: 3 });
    expect(http.requests[1]?.timeoutMs).toBe(PLATFORM_METADATA_TIMEOUT_MS);
  });

  it("refuses a body longer than the limit, by length or by declaration", async () => {
    const long = new ScriptedHttp(() => ({ body: "1234" }));
    expect(await classOf(platformGetBytes(long, { url: DM, signal: signal(), trustedHosts: TRUSTED, maxBytes: 3 }))).toBe("source_html_error_page");
    const declared = new ScriptedHttp(() => ({ body: "1", headers: { "Content-Length": "4" } }));
    expect(await classOf(platformGetBytes(declared, { url: DM, signal: signal(), trustedHosts: TRUSTED, maxBytes: 3 }))).toBe("source_html_error_page");
  });

  it("maps statuses like platformGetJson, even when the error page is over the limit", async () => {
    const cases: Array<[number, string]> = [
      [412, "platform_blocked"],
      [429, "platform_blocked"],
      [404, "source_unreachable"],
      [503, "source_unreachable"],
    ];
    for (const [status, expected] of cases) {
      const http = new ScriptedHttp(() => ({ status, body: "x".repeat(100) }));
      expect(await classOf(platformGetBytes(http, { url: DM, signal: signal(), trustedHosts: TRUSTED, maxBytes: 3 })), String(status)).toBe(expected);
    }
  });

  it("maps a transport failure while reading to source_unreachable but lets an abort through", async () => {
    const broken = (reason: "network" | "aborted") => ({
      async request() {
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: (async function* () {
            yield new Uint8Array([1]);
            throw new OutboundHttpError("after_send", reason);
          })(),
          text: async () => "",
        };
      },
    });
    expect(await classOf(platformGetBytes(broken("network"), { url: DM, signal: signal(), trustedHosts: TRUSTED, maxBytes: 10 }))).toBe("source_unreachable");
    await expect(platformGetBytes(broken("aborted"), { url: DM, signal: signal(), trustedHosts: TRUSTED, maxBytes: 10 })).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("platform requests", () => {
  const every = (http: OutboundHttpClient): Array<() => Promise<unknown>> => [
    () => platformGetJson(http, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED }),
    () => platformGetHop(http, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED }),
    () => platformGetBytes(http, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 }),
    () => platformGetText(http, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 }),
  ];

  it("are always marked public-only and carry the caller's trustedHosts, whatever the helper", async () => {
    const http = new ScriptedHttp(() => ({ body: { code: 0 } }));
    await Promise.all(every(http).map((call) => call()));
    expect(http.requests.map((request) => request.publicOnly)).toEqual([true, true, true, true]);
    expect(http.requests.map((request) => request.trustedHosts)).toEqual([TRUSTED, TRUSTED, TRUSTED, TRUSTED]);
  });

  it.each(PROXY_ERRORS)("pass %s from the outbound client through unchanged, whatever the helper", async (code, error) => {
    const http = new ScriptedHttp(() => error());
    for (const call of every(http)) {
      expect(await appErrorOf(call())).toMatchObject({ class: code.split(".")[0], code });
    }
  });

  it.each(PROXY_ERRORS)("pass %s raised while the body streams through unchanged", async (code, error) => {
    const broken: OutboundHttpClient = {
      async request() {
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: (async function* () {
            yield new Uint8Array([123]);
            throw error();
          })(),
          text: async () => "",
        };
      },
    };
    expect(await appErrorOf(platformGetText(broken, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 }))).toMatchObject({ code });
    expect(await appErrorOf(platformGetBytes(broken, { url: PAGELIST, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 }))).toMatchObject({ code });
  });
});

describe("platformGetText", () => {
  const PAGE = "https://www.example.com/discovery/item/0123";

  it("returns status, text and the resolved redirect target without following it", async () => {
    const http = new ScriptedHttp(() => ({ status: 302, body: "", headers: { location: "/login?redirectPath=x" } }));
    const answer = await platformGetText(http, { url: PAGE, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 });
    expect(answer).toMatchObject({ status: 302, location: "https://www.example.com/login?redirectPath=x", text: "" });
    expect(http.requests[0]?.redirect).toBe("manual");
  });

  it("discards a redirect's body unread and returns no text for it", async () => {
    const http = new ScriptedHttp(() => ({ status: 301, body: "moved", headers: { location: "https://www.example.com/next" } }));
    expect(await platformGetText(http, { url: PAGE, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 })).toMatchObject({ status: 301, text: "" });
    expect(http.destroyed).toEqual([PAGE]);
  });

  it("does not map error statuses: the adapter decides", async () => {
    const http = new ScriptedHttp(() => ({ status: 403, body: "refused" }));
    expect(await platformGetText(http, { url: PAGE, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 })).toMatchObject({ status: 403, text: "refused" });
  });

  it("refuses a body longer than the cap", async () => {
    const http = new ScriptedHttp(() => ({ body: "x".repeat(2048) }));
    expect(await classOf(platformGetText(http, { url: PAGE, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 }))).toBe("source_html_error_page");
  });

  it("maps a transport failure to source_unreachable", async () => {
    const http = new ScriptedHttp(() => new OutboundHttpError("before_send", "network"));
    expect(await classOf(platformGetText(http, { url: PAGE, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024 }))).toBe("source_unreachable");
  });

  it("gives up a body that stops sending for the request's timeout, and ends it", async () => {
    let ended = false;
    const trickle = {
      async request() {
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: {
            [Symbol.asyncIterator]() {
              let sent = false;
              return {
                next: () => {
                  if (!sent) {
                    sent = true;
                    return Promise.resolve({ done: false as const, value: new Uint8Array([120]) });
                  }
                  // Never another chunk, never the end.
                  return new Promise<IteratorResult<Uint8Array>>(() => undefined);
                },
                return: () => {
                  ended = true;
                  return Promise.resolve({ done: true as const, value: undefined });
                },
              };
            },
          },
          text: async () => "",
        };
      },
    };
    const started = Date.now();
    expect(await classOf(platformGetText(trickle, { url: PAGE, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1024, timeoutMs: 50 }))).toBe("source_unreachable");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ended).toBe(true);
  });

  it("gives up a body that keeps trickling past the request's timeout, and ends it", async () => {
    let ended = false;
    const trickle: OutboundHttpClient = {
      async request() {
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: {
            [Symbol.asyncIterator]() {
              return {
                // A byte every 10 ms: never a stall, never the end.
                next: () => new Promise<IteratorResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: false, value: new Uint8Array([120]) }), 10)),
                return: () => {
                  ended = true;
                  return Promise.resolve({ done: true as const, value: undefined });
                },
              };
            },
          },
          text: async () => "",
          destroy: () => {
            ended = true;
          },
        };
      },
    };
    const started = Date.now();
    expect(await classOf(platformGetText(trickle, { url: PAGE, signal: signal(), trustedHosts: TRUSTED, maxBytes: 1_000_000, timeoutMs: 100 }))).toBe("source_unreachable");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ended).toBe(true);
  });
});
