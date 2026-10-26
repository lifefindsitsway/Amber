import { describe, expect, it } from "vitest";
import { TavilyWebSearchProvider } from "../../../../../src/server/adapters/web-search/tavily/index.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundRequest, type OutboundResponse } from "../../../../../src/server/ports/outbound-http.ts";
import { WEB_SEARCH_RESPONSE_MAX_BYTES } from "../../../../../src/shared/defaults.ts";
import { TAVILY_CHINESE, TAVILY_ENGLISH, TAVILY_ERRORS, TAVILY_TERM, TAVILY_TIME_SENSITIVE } from "../../../../fixtures/web-search/tavily.ts";

const KEY = "tvly-test";
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);

function response(status: number, chunks: readonly Uint8Array[], headers: Record<string, string> = {}, onPull?: () => void): OutboundResponse {
  const body = (async function* () {
    for (const chunk of chunks) {
      onPull?.();
      yield chunk;
    }
  })();
  return {
    status,
    headers: new Map(Object.entries(headers)),
    body,
    text: async () => Buffer.concat([...chunks]).toString("utf8"),
  };
}

const json = (value: unknown): Uint8Array[] => [Buffer.from(JSON.stringify(value), "utf8")];

class FakeHttp implements OutboundHttpClient {
  readonly requests: OutboundRequest[] = [];
  private readonly answer: (request: OutboundRequest) => Promise<OutboundResponse>;
  constructor(answer: (request: OutboundRequest) => Promise<OutboundResponse>) {
    this.answer = answer;
  }
  request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    return this.answer(request);
  }
}

function provider(answer: (request: OutboundRequest) => Promise<OutboundResponse>, extra: { timeoutMs?: number } = {}) {
  const http = new FakeHttp(answer);
  return { http, tavily: new TavilyWebSearchProvider({ http, now: () => NOW, ...extra }) };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

const search = (tavily: TavilyWebSearchProvider, signal = new AbortController().signal) => tavily.search("query", { maxResults: 5, apiKey: KEY, signal });

describe("Tavily request", () => {
  it("posts the query to the fixed official endpoint with the key as a bearer token and basic depth", async () => {
    const { http, tavily } = provider(async () => response(200, json({ results: [] })));
    await tavily.search("注意力机制", { maxResults: 5, apiKey: KEY, signal: new AbortController().signal });
    expect(http.requests).toHaveLength(1);
    const request = http.requests[0] as OutboundRequest;
    expect(request.url).toBe("https://api.tavily.com/search");
    expect(request.method).toBe("POST");
    expect(request.headers?.["authorization"]).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(request.body as string)).toEqual({ query: "注意力机制", search_depth: "basic", max_results: 5, include_published_date: true });
  });
});

describe("Tavily answers", () => {
  it.each([
    ["Chinese", TAVILY_CHINESE],
    ["English", TAVILY_ENGLISH],
    ["time-sensitive", TAVILY_TIME_SENSITIVE],
  ])("decodes a %s answer into provider-neutral results", async (_name, fixture) => {
    const { tavily } = provider(async () => response(200, json(fixture)));
    const results = await search(tavily);
    expect(results.map((result) => result.url)).toEqual(fixture.results.map((result) => result.url));
    for (const [index, result] of results.entries()) {
      const wire = fixture.results[index] as { title: string; content: string; score: number; published_date?: string | null };
      expect(result).toMatchObject({ title: wire.title, content: wire.content, score: wire.score });
      const date = typeof wire.published_date === "string" ? Date.parse(wire.published_date) : Number.NaN;
      if (Number.isFinite(date)) {
        expect(result.publishedAt).toBe(date);
      } else {
        expect(result).not.toHaveProperty("publishedAt");
      }
      // Vendor field names never come out of the adapter.
      expect(Object.keys(result).every((key) => ["url", "title", "content", "score", "publishedAt"].includes(key))).toBe(true);
    }
  });

  it("skips entries without a URL and leaves URL checks to the application", async () => {
    const { tavily } = provider(async () => response(200, json(TAVILY_TERM)));
    const results = await search(tavily);
    expect(results.map((result) => result.url)).toEqual(["https://wiki.example.net/BM25", "ftp://files.example.net/bm25.pdf", "javascript:alert(1)"]);
    expect(results[0]?.title).toBe("");
  });

  it.each(TAVILY_ERRORS)("maps HTTP $status to $code without keeping the answer's text", async ({ status, body, code, reason }) => {
    const { tavily } = provider(async () => response(status, json(body), status === 429 ? { "retry-after": "30" } : {}));
    const error = await failure(search(tavily));
    expect(isAmberError(error) && error.appError.code).toBe(code);
    if (!isAmberError(error)) return;
    expect(error.appError.class).toBe("web_search_failed");
    expect(error.appError).not.toHaveProperty("upstreamMessage");
    expect(JSON.stringify(error.appError)).not.toContain(KEY);
    if (status === 429) expect(error.appError.details).toEqual({ retryAfterMs: 30_000 });
    if (reason !== undefined) expect(error.appError.details).toEqual({ reason });
    if (status === 401) expect(error.appError.action).toBe("configure_web_search");
  });

  it("reads Retry-After given as a date, and leaves it out when absent or unreadable", async () => {
    const at = new Date(NOW + 90_000).toUTCString();
    for (const [header, details] of [
      [{ "retry-after": at }, { retryAfterMs: 90_000 }],
      [{}, undefined],
      [{ "retry-after": "soon" }, undefined],
    ] as const) {
      const { tavily } = provider(async () => response(429, json({}), header));
      const error = await failure(search(tavily));
      expect(isAmberError(error) && error.appError.details).toEqual(details);
    }
  });

  it("calls other non-2xx answers unavailable: server errors as server_error, the rest as bad_response", async () => {
    for (const [status, reason] of [
      [503, "server_error"],
      [404, "bad_response"],
      [302, "bad_response"],
    ] as const) {
      const { tavily } = provider(async () => response(status, json({})));
      const error = await failure(search(tavily));
      expect(isAmberError(error) && error.appError).toMatchObject({ code: "web_search_failed.unavailable", details: { reason } });
    }
  });

  it("refuses an answer that is not JSON or has no result list as bad_response", async () => {
    for (const body of [[Buffer.from("<html>gateway</html>")], json({ answer: "x" }), json({ results: "none" })]) {
      const { tavily } = provider(async () => response(200, body));
      const error = await failure(search(tavily));
      expect(isAmberError(error) && error.appError).toMatchObject({ code: "web_search_failed.unavailable", details: { reason: "bad_response" } });
    }
  });

  it("stops reading an oversized answer at the limit: unavailable, too_large", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const count = Math.ceil(WEB_SEARCH_RESPONSE_MAX_BYTES / chunk.byteLength) + 50;
    let pulled = 0;
    const { http, tavily } = provider(async () => response(200, Array.from({ length: count }, () => chunk), {}, () => (pulled += 1)));
    const error = await failure(search(tavily));
    expect(isAmberError(error) && error.appError).toMatchObject({ code: "web_search_failed.unavailable", details: { reason: "too_large" } });
    expect(pulled).toBe(Math.floor(WEB_SEARCH_RESPONSE_MAX_BYTES / chunk.byteLength) + 1);
    // The exchange is aborted once reading stops.
    expect(http.requests[0]?.signal.aborted).toBe(true);
  });

  it("calls a transport failure or a timeout unreachable", async () => {
    const { tavily } = provider(async () => {
      throw new OutboundHttpError("before_send", "network");
    });
    const { tavily: slow } = provider(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new OutboundHttpError("before_send", "aborted")), { once: true });
        }),
      { timeoutMs: 20 },
    );
    for (const promise of [search(tavily), search(slow)]) {
      const error = await failure(promise);
      expect(isAmberError(error) && error.appError.code).toBe("web_search_failed.unreachable");
    }
  });

  it("rethrows the caller's cancellation as the transport raised it", async () => {
    const controller = new AbortController();
    const { tavily } = provider(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new OutboundHttpError("after_send", "aborted")), { once: true });
        }),
    );
    const pending = search(tavily, controller.signal);
    controller.abort();
    const error = await failure(pending);
    expect(error).toBeInstanceOf(OutboundHttpError);
  });
});
