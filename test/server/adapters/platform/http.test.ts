import { describe, expect, it } from "vitest";
import { BROWSER_USER_AGENT, platformGet, platformGetBytes, platformGetJson, platformGetText } from "../../../../src/server/adapters/platform/http.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { OutboundHttpError } from "../../../../src/server/ports/outbound-http.ts";
import { PLATFORM_METADATA_TIMEOUT_MS } from "../../../../src/shared/defaults.ts";
import { ScriptedHttp, signal, type ScriptedResponse } from "../../../fixtures/platform/scripted-io.ts";

const PAGELIST = "https://api.bilibili.com/x/player/pagelist?bvid=BV1xx411c7mD";

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
    expect(await platformGetJson(http, { url: PAGELIST, headers: { Referer: "https://www.bilibili.com/", Cookie: "a=<placeholder>" }, signal: signal() })).toEqual({
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
      expect(await classOf(platformGetJson(new ScriptedHttp(() => answer), { url: PAGELIST, signal: signal() })), JSON.stringify(answer)).toBe(expected);
    }
  });

  it("maps transport failures to source_unreachable but lets an abort through", async () => {
    for (const reason of ["network", "timeout"] as const) {
      const http = new ScriptedHttp(() => new OutboundHttpError("before_send", reason));
      expect(await classOf(platformGetJson(http, { url: PAGELIST, signal: signal() }))).toBe("source_unreachable");
    }
    const aborted = new ScriptedHttp(() => new OutboundHttpError("after_send", "aborted"));
    await expect(platformGetJson(aborted, { url: PAGELIST, signal: signal() })).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("platformGet", () => {
  it("hands back redirects and error statuses as responses", async () => {
    const http = new ScriptedHttp(() => ({ status: 302, headers: { Location: "https://www.bilibili.com/video/BV1xx411c7mD" } }));
    const response = await platformGet(http, { url: "https://b23.tv/abc", signal: signal() });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(http.requests[0]?.headers).toEqual({ "User-Agent": BROWSER_USER_AGENT });
    // The caller walks the chain itself; the client must not follow it.
    expect(http.requests[0]?.redirect).toBe("manual");
  });
});

describe("platformGetBytes", () => {
  const DM = "https://api.bilibili.com/x/v1/dm/list.so?oid=1";

  it("returns the body's bytes as sent with the headers, under the caller's timeout or the metadata one", async () => {
    const http = new ScriptedHttp(() => ({ body: "raw", headers: { "Content-Encoding": "deflate" } }));
    const answer = await platformGetBytes(http, { url: DM, signal: signal(), maxBytes: 3, timeoutMs: 1234 });
    expect(Buffer.from(answer.bytes).toString("utf8")).toBe("raw");
    expect(answer.headers.get("content-encoding")).toBe("deflate");
    expect(http.requests[0]).toMatchObject({ url: DM, method: "GET", timeoutMs: 1234, headers: { "User-Agent": BROWSER_USER_AGENT } });
    await platformGetBytes(http, { url: DM, signal: signal(), maxBytes: 3 });
    expect(http.requests[1]?.timeoutMs).toBe(PLATFORM_METADATA_TIMEOUT_MS);
  });

  it("refuses a body longer than the limit, by length or by declaration", async () => {
    const long = new ScriptedHttp(() => ({ body: "1234" }));
    expect(await classOf(platformGetBytes(long, { url: DM, signal: signal(), maxBytes: 3 }))).toBe("source_html_error_page");
    const declared = new ScriptedHttp(() => ({ body: "1", headers: { "Content-Length": "4" } }));
    expect(await classOf(platformGetBytes(declared, { url: DM, signal: signal(), maxBytes: 3 }))).toBe("source_html_error_page");
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
      expect(await classOf(platformGetBytes(http, { url: DM, signal: signal(), maxBytes: 3 })), String(status)).toBe(expected);
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
    expect(await classOf(platformGetBytes(broken("network"), { url: DM, signal: signal(), maxBytes: 10 }))).toBe("source_unreachable");
    await expect(platformGetBytes(broken("aborted"), { url: DM, signal: signal(), maxBytes: 10 })).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("platform requests", () => {
  it("are always marked public-only, whatever the helper", async () => {
    const http = new ScriptedHttp(() => ({ body: { code: 0 } }));
    await platformGetJson(http, { url: PAGELIST, signal: signal() });
    await platformGet(http, { url: PAGELIST, signal: signal() });
    await platformGetBytes(http, { url: PAGELIST, signal: signal(), maxBytes: 1024 });
    await platformGetText(http, { url: PAGELIST, signal: signal(), maxBytes: 1024 });
    expect(http.requests.map((request) => request.publicOnly)).toEqual([true, true, true, true]);
  });
});

describe("platformGetText", () => {
  const PAGE = "https://www.example.com/discovery/item/0123";

  it("returns status, text and the resolved redirect target without following it", async () => {
    const http = new ScriptedHttp(() => ({ status: 302, body: "", headers: { location: "/login?redirectPath=x" } }));
    const answer = await platformGetText(http, { url: PAGE, signal: signal(), maxBytes: 1024 });
    expect(answer).toMatchObject({ status: 302, location: "https://www.example.com/login?redirectPath=x", text: "" });
    expect(http.requests[0]?.redirect).toBe("manual");
  });

  it("does not map error statuses: the adapter decides", async () => {
    const http = new ScriptedHttp(() => ({ status: 403, body: "refused" }));
    expect(await platformGetText(http, { url: PAGE, signal: signal(), maxBytes: 1024 })).toMatchObject({ status: 403, text: "refused" });
  });

  it("refuses a body longer than the cap", async () => {
    const http = new ScriptedHttp(() => ({ body: "x".repeat(2048) }));
    expect(await classOf(platformGetText(http, { url: PAGE, signal: signal(), maxBytes: 1024 }))).toBe("source_html_error_page");
  });

  it("maps a transport failure to source_unreachable", async () => {
    const http = new ScriptedHttp(() => new OutboundHttpError("before_send", "network"));
    expect(await classOf(platformGetText(http, { url: PAGE, signal: signal(), maxBytes: 1024 }))).toBe("source_unreachable");
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
    expect(await classOf(platformGetText(trickle, { url: PAGE, signal: signal(), maxBytes: 1024, timeoutMs: 50 }))).toBe("source_unreachable");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ended).toBe(true);
  });
});
