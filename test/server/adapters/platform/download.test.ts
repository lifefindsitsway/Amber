import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DirectOutboundHttpClient } from "../../../../src/server/adapters/outbound-http/direct.ts";
import {
  createPlatformMediaDownload,
  downloadPlatformMedia,
  type PlatformDownloadEnvironment,
  type PlatformDownloadRequest,
} from "../../../../src/server/adapters/platform/download.ts";
import { amberError, isAmberError, type AmberError } from "../../../../src/server/domain/errors.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../../../src/server/ports/outbound-http.ts";
import { PLATFORM_DOWNLOAD_RESUME_MAX, PLATFORM_DOWNLOAD_STALL_TIMEOUT_MS } from "../../../../src/shared/defaults.ts";
import { useLocalServers, type LocalServer } from "../../../fixtures/http/local-server.ts";

// The downloader asks for https URLs on CDN host names; a forwarding client sends them to a
// plain HTTP server on 127.0.0.1 started by the test, so nothing leaves the machine.
const serve = useLocalServers();

const CDN = "media.cdn.test";
const ALLOWED = ["cdn.test"];
/** The calling adapter's table, passed on with every hop. */
const TRUSTED = ["cdn.test", "api.test"] as const;
/** Synthetic signed-URL parameters and a cookie that must never surface in errors or logs. */
const SECRETS = ["TESTONLY_xsec1", "TESTONLY_src1", "TESTONLY_sig1", "TESTONLY_uifid1", "TESTONLY_sign1", "TESTONLY_ck1"];
const SIGNED = "xsec_token=TESTONLY_xsec1&xsec_source=TESTONLY_src1&x-secsdk-web-signature=TESTONLY_sig1&uifid=TESTONLY_uifid1&sign=TESTONLY_sign1";
const mediaUrl = (path = "/media/file.mp4", host = CDN) => `https://${host}${path}?${SIGNED}`;

/** Deterministic, non-repeating bytes, so a misplaced or doubled range shows. */
function bytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

const BODY = bytes(40_000, 1);
const OTHER_BODY = bytes(40_000, 2);
const CUT = 10_000;
const ETAG = '"TESTONLY_etag1"';

interface RecordedRequest {
  host: string;
  headers: Record<string, string>;
  publicOnly: boolean | undefined;
  redirect: string | undefined;
  trustedHosts: readonly string[] | undefined;
}

/**
 * The OutboundHttpClient the downloader is given: records each request as the downloader sent
 * it and forwards it to the local server, telling it the original host in `x-test-host`.
 */
function forwardingClient(server: LocalServer): OutboundHttpClient & { requests: RecordedRequest[] } {
  const direct = new DirectOutboundHttpClient();
  const requests: RecordedRequest[] = [];
  return {
    requests,
    request(request: OutboundRequest) {
      const url = new URL(request.url);
      requests.push({
        host: url.hostname,
        headers: Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
        publicOnly: request.publicOnly,
        redirect: request.redirect,
        trustedHosts: request.trustedHosts,
      });
      return direct.request({ ...request, url: `http://127.0.0.1:${server.port}${url.pathname}${url.search}`, headers: { ...request.headers, "x-test-host": url.hostname } });
    },
  };
}

/** A client that answers every request itself, ignoring cancellation, for what a socket cannot show. */
function scriptedClient(answer: () => OutboundResponse): OutboundHttpClient & { requests: OutboundRequest[] } {
  const requests: OutboundRequest[] = [];
  return {
    requests,
    async request(request: OutboundRequest) {
      requests.push(request);
      return answer();
    },
  };
}

function scriptedResponse(headers: Record<string, string>, chunks: () => AsyncIterable<Uint8Array>): OutboundResponse {
  return { status: 200, headers: new Map(Object.entries(headers)), body: chunks(), text: async () => "" };
}

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body: Buffer;
  /** Body bytes sent before the connection is cut; the declared length stays the full one. */
  cut?: number;
}

function send(response: ServerResponse, answer: Answer): void {
  response.writeHead(answer.status, { ...answer.headers, "Content-Length": String(answer.body.length) });
  if (answer.cut === undefined) {
    response.end(answer.body);
    return;
  }
  response.write(answer.body.subarray(0, answer.cut), () => response.socket?.destroy());
}

interface Representation {
  body: Buffer;
  etag?: string;
  type?: string;
}

/**
 * A CDN serving `represent(n)` to the n-th request (from 0), honouring `Range` with `If-Range`
 * like a well-behaved server; `answers[n]` replaces the n-th answer, `cut(n)` cuts it short.
 */
function cdn(options: { represent?: (n: number) => Representation; answers?: Record<number, Answer>; cut?: (n: number) => number | undefined }): RequestListener {
  let count = 0;
  return (request: IncomingMessage, response: ServerResponse) => {
    const n = count++;
    const scripted = options.answers?.[n];
    if (scripted !== undefined) {
      send(response, scripted);
      return;
    }
    const representation = options.represent?.(n) ?? { body: BODY, etag: ETAG };
    const headers: Record<string, string> = { "Content-Type": representation.type ?? "video/mp4" };
    if (representation.etag !== undefined) headers.ETag = representation.etag;
    const range = /^bytes=(\d+)-$/u.exec(request.headers.range ?? "");
    const ifRange = request.headers["if-range"];
    const cut = options.cut?.(n);
    const strong = representation.etag !== undefined && !representation.etag.startsWith("W/");
    if (range !== null && strong && (ifRange === undefined || ifRange === representation.etag)) {
      const start = Number(range[1]);
      const total = representation.body.length;
      if (start >= total) {
        send(response, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` }, body: Buffer.alloc(0) });
        return;
      }
      send(response, {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${total - 1}/${total}` },
        body: representation.body.subarray(start),
        ...(cut === undefined ? {} : { cut }),
      });
      return;
    }
    send(response, { status: 200, headers, body: representation.body, ...(cut === undefined ? {} : { cut }) });
  };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "amber-download-"));
  return { path: join(dir, "media.mp4"), scratchDir: join(dir, "scratch") };
}

function downloadRequest(output: { path: string; scratchDir: string }, extra: Partial<PlatformDownloadRequest> = {}): PlatformDownloadRequest {
  return {
    url: mediaUrl(),
    allowedHosts: ALLOWED,
    trustedHosts: TRUSTED,
    kind: "video",
    maxBytes: 1_000_000,
    output,
    signal: new AbortController().signal,
    ...extra,
  };
}

async function scratchEntries(scratchDir: string): Promise<string[]> {
  try {
    return await readdir(scratchDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** The target path holds no file and no temporary file is left below the scratch directory. */
async function expectNothingLeft(output: { path: string; scratchDir: string }): Promise<void> {
  expect(existsSync(output.path)).toBe(false);
  expect(await scratchEntries(output.scratchDir)).toEqual([]);
}

async function expectDownloaded(output: { path: string; scratchDir: string }, body: Buffer): Promise<void> {
  expect((await readFile(output.path)).equals(body)).toBe(true);
  expect(await scratchEntries(output.scratchDir)).toEqual([]);
}

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

/** The AmberError a download failed with, checked to carry none of the synthetic secrets. */
async function failure(work: Promise<unknown>): Promise<AmberError> {
  const error = await work.then(
    () => {
      throw new Error("download unexpectedly succeeded");
    },
    (caught: unknown) => caught,
  );
  if (!isAmberError(error)) throw error;
  const { appError } = error;
  expectNoSecrets(JSON.stringify([error.message, appError.userMessage, appError.details ?? null, appError.upstreamMessage ?? null]));
  return error;
}

let consoleSpies: MockInstance[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});
afterEach(() => {
  // Nothing the downloader printed, on any path, carries a signed parameter or the cookie.
  for (const spy of consoleSpies) expectNoSecrets(JSON.stringify(spy.mock.calls));
  vi.restoreAllMocks();
});

describe("downloadPlatformMedia proxy errors", () => {
  it.each([
    ["network_proxy_unsupported", "network_proxy_unsupported.pac"],
    ["network_proxy_failed", "network_proxy_failed.unreachable"],
  ] as const)("passes %s from the outbound client through unchanged and leaves nothing behind", async (errorClass, code) => {
    const output = await workspace();
    const http: OutboundHttpClient = {
      async request() {
        throw amberError(errorClass, "the proxy could not be used", { code });
      },
    };
    const error = await failure(downloadPlatformMedia(http, downloadRequest(output)));
    expect(error.appError).toMatchObject({ class: errorClass, code });
    await expectNothingLeft(output);
  });
});

describe("downloadPlatformMedia hosts and redirects", () => {
  it("refuses URLs off the allowed hosts, plain http, user info and ports before any request", async () => {
    const server = await serve("127.0.0.1", cdn({}));
    const http = forwardingClient(server);
    const output = await workspace();
    for (const url of [
      `http://${CDN}/media/file.mp4?${SIGNED}`,
      `https://user:pw@${CDN}/media/file.mp4?${SIGNED}`,
      `https://${CDN}:8443/media/file.mp4?${SIGNED}`,
      `https://${CDN}:443/media/file.mp4?${SIGNED}`,
      mediaUrl("/media/file.mp4", "evilcdn.test"),
      mediaUrl("/media/file.mp4", "cdn.test.evil.test"),
      mediaUrl("/media/file.mp4", "other.test"),
      `https://127.0.0.1/media/file.mp4?${SIGNED}`,
    ]) {
      const error = await failure(downloadPlatformMedia(http, downloadRequest(output, { url })));
      expect(error.appError.code, url).toBe("network_blocked_by_policy");
    }
    expect(http.requests).toEqual([]);
    expect(server.received).toEqual([]);
    await expectNothingLeft(output);
  });

  it("sends every request publicOnly with manual redirects and no cookie, walking redirects within the allowed hosts", async () => {
    const server = await serve("127.0.0.1", (request, response) => {
      if (request.url?.startsWith("/start") === true) {
        response.writeHead(302, { Location: mediaUrl("/media/final.mp4", "edge.cdn.test") });
        response.end();
        return;
      }
      cdn({})(request, response);
    });
    const http = forwardingClient(server);
    const output = await workspace();
    const progress: Array<[number, number | undefined]> = [];
    const result = await downloadPlatformMedia(
      http,
      downloadRequest(output, {
        url: mediaUrl("/start"),
        headers: { Cookie: "sid=TESTONLY_ck1", Referer: "https://www.cdn.test/", "User-Agent": "amber-test" },
        onProgress: (received, total) => progress.push([received, total]),
      }),
    );
    expect(result).toEqual({ sizeBytes: BODY.length, mimeType: "video/mp4" });
    await expectDownloaded(output, BODY);
    expect(http.requests.map((entry) => entry.host)).toEqual([CDN, "edge.cdn.test"]);
    for (const entry of http.requests) {
      expect(entry.publicOnly).toBe(true);
      expect(entry.redirect).toBe("manual");
      expect(entry.trustedHosts).toEqual(TRUSTED);
      expect(entry.headers.cookie).toBeUndefined();
      expect(entry.headers).toMatchObject({ referer: "https://www.cdn.test/", "user-agent": "amber-test" });
    }
    for (const received of server.received) expect(received.headers.cookie).toBeUndefined();
    expect(progress.at(-1)).toEqual([BODY.length, BODY.length]);
  });

  it("refuses a redirect off the allowed hosts or to http without following it", async () => {
    for (const location of [mediaUrl("/x", "evil.test"), mediaUrl("/x", "evilcdn.test"), `http://${CDN}/x?${SIGNED}`, `https://${CDN}:8443/x`]) {
      const server = await serve("127.0.0.1", (_request, response) => {
        response.writeHead(302, { Location: location });
        response.end();
      });
      const http = forwardingClient(server);
      const output = await workspace();
      const error = await failure(downloadPlatformMedia(http, downloadRequest(output)));
      expect(error.appError.code, location).toBe("network_blocked_by_policy.redirect");
      expect(http.requests.map((entry) => entry.host)).toEqual([CDN]);
      expect(server.received).toHaveLength(1);
      await expectNothingLeft(output);
    }
  });
});

describe("downloadPlatformMedia completion", () => {
  it("moves a complete media body into place and reports its type without parameters", async () => {
    const server = await serve("127.0.0.1", cdn({ represent: () => ({ body: BODY, etag: ETAG, type: "video/mp4; codecs=avc1" }) }));
    const output = await workspace();
    const result = await downloadPlatformMedia(forwardingClient(server), downloadRequest(output, { expectedBytes: BODY.length }));
    expect(result).toEqual({ sizeBytes: BODY.length, mimeType: "video/mp4" });
    await expectDownloaded(output, BODY);
  });

  it("accepts audio streams labelled audio or video, and refuses a type of another kind", async () => {
    for (const type of ["audio/mp4", "video/mp4"]) {
      const server = await serve("127.0.0.1", cdn({ represent: () => ({ body: BODY, type }) }));
      const output = await workspace();
      expect(await downloadPlatformMedia(forwardingClient(server), downloadRequest(output, { kind: "audio" }))).toEqual({ sizeBytes: BODY.length, mimeType: type });
      await expectDownloaded(output, BODY);
    }
    const server = await serve("127.0.0.1", cdn({ represent: () => ({ body: BODY, type: "video/mp4" }) }));
    const output = await workspace();
    expect((await failure(downloadPlatformMedia(forwardingClient(server), downloadRequest(output, { kind: "image" })))).appError.code).toBe("source_html_error_page");
    await expectNothingLeft(output);
  });

  it("refuses an HTML error page, an error status and a body without a declared length", async () => {
    const page = Buffer.from("<html><body>blocked</body></html>");
    const cases: Array<[Answer, string]> = [
      [{ status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: page }, "source_html_error_page"],
      [{ status: 200, headers: { "Content-Type": "application/json" }, body: Buffer.from("{}") }, "source_html_error_page"],
      [{ status: 403, headers: { "Content-Type": "text/html" }, body: page }, "source_unreachable"],
      [{ status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-9/${BODY.length}` }, body: BODY.subarray(0, 10) }, "source_unreachable"],
    ];
    for (const [answer, code] of cases) {
      const server = await serve("127.0.0.1", cdn({ answers: { 0: answer } }));
      const output = await workspace();
      expect((await failure(downloadPlatformMedia(forwardingClient(server), downloadRequest(output)))).appError.code).toBe(code);
      await expectNothingLeft(output);
    }
    const chunked = await serve("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.end(BODY);
    });
    const output = await workspace();
    expect((await failure(downloadPlatformMedia(forwardingClient(chunked), downloadRequest(output)))).appError.code).toBe("source_unreachable");
    await expectNothingLeft(output);
  });

  it("refuses a total that differs from the size the platform declared", async () => {
    const server = await serve("127.0.0.1", cdn({}));
    const output = await workspace();
    const error = await failure(downloadPlatformMedia(forwardingClient(server), downloadRequest(output, { expectedBytes: BODY.length + 1 })));
    expect(error.appError.code).toBe("source_unreachable");
    await expectNothingLeft(output);
  });
});

describe("downloadPlatformMedia resuming", () => {
  it("resumes a cut-off body with Range and If-Range against a strong ETag", async () => {
    const server = await serve("127.0.0.1", cdn({ cut: (n) => (n === 0 ? CUT : undefined) }));
    const http = forwardingClient(server);
    const output = await workspace();
    expect(await downloadPlatformMedia(http, downloadRequest(output))).toEqual({ sizeBytes: BODY.length, mimeType: "video/mp4" });
    await expectDownloaded(output, BODY);
    expect(http.requests[0]?.headers.range).toBeUndefined();
    expect(http.requests[1]?.headers).toMatchObject({ range: `bytes=${CUT}-`, "if-range": ETAG });
    expect(http.requests).toHaveLength(2);
  });

  it("starts over on a 416 to a resume instead of taking the held bytes as complete", async () => {
    const server = await serve("127.0.0.1", cdn({ cut: (n) => (n === 0 ? CUT : undefined), answers: { 1: { status: 416, headers: { "Content-Range": `bytes */${BODY.length}` }, body: Buffer.alloc(0) } } }));
    const http = forwardingClient(server);
    const output = await workspace();
    await downloadPlatformMedia(http, downloadRequest(output));
    await expectDownloaded(output, BODY);
    expect(http.requests.map((entry) => entry.headers.range)).toEqual([undefined, `bytes=${CUT}-`, undefined]);
  });

  it("takes a 200 to a resume as a new start rather than appending it", async () => {
    const server = await serve("127.0.0.1", cdn({ cut: (n) => (n === 0 ? CUT : undefined), answers: { 1: { status: 200, headers: { "Content-Type": "video/mp4", ETag: ETAG }, body: BODY } } }));
    const http = forwardingClient(server);
    const output = await workspace();
    await downloadPlatformMedia(http, downloadRequest(output));
    await expectDownloaded(output, BODY);
    expect(http.requests).toHaveLength(2);
  });

  it("starts over when a 206 starts elsewhere, changes the total or changes the ETag", async () => {
    const partial = (contentRange: string, etag: string, body: Buffer): Answer => ({
      status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Range": contentRange, ETag: etag },
      body,
    });
    const total = BODY.length;
    const mismatches: Record<string, Answer> = {
      "start differs": partial(`bytes ${CUT - 100}-${total - 1}/${total}`, ETAG, BODY.subarray(CUT - 100)),
      "total changed": partial(`bytes ${CUT}-${total}/${total + 1}`, ETAG, Buffer.concat([BODY.subarray(CUT), Buffer.alloc(1)])),
      "etag changed": partial(`bytes ${CUT}-${total - 1}/${total}`, '"TESTONLY_etag2"', BODY.subarray(CUT)),
      "weak etag": partial(`bytes ${CUT}-${total - 1}/${total}`, `W/${ETAG}`, BODY.subarray(CUT)),
    };
    for (const [name, answer] of Object.entries(mismatches)) {
      const server = await serve("127.0.0.1", cdn({ cut: (n) => (n === 0 ? CUT : undefined), answers: { 1: answer } }));
      const http = forwardingClient(server);
      const output = await workspace();
      await downloadPlatformMedia(http, downloadRequest(output));
      await expectDownloaded(output, BODY);
      expect(http.requests.map((entry) => entry.headers.range), name).toEqual([undefined, `bytes=${CUT}-`, undefined]);
    }
  });

  it("never resumes behind a weak ETag or no ETag, downloading from the start instead", async () => {
    for (const etag of [`W/${ETAG}`, undefined]) {
      const server = await serve("127.0.0.1", cdn({ represent: () => ({ body: BODY, ...(etag === undefined ? {} : { etag }) }), cut: (n) => (n === 0 ? CUT : undefined) }));
      const http = forwardingClient(server);
      const output = await workspace();
      await downloadPlatformMedia(http, downloadRequest(output));
      await expectDownloaded(output, BODY);
      expect(http.requests).toHaveLength(2);
      for (const entry of http.requests) {
        expect(entry.headers.range).toBeUndefined();
        expect(entry.headers["if-range"]).toBeUndefined();
      }
    }
  });

  it("keeps none of the old bytes when the content behind the link changed", async () => {
    // A well-behaved server answers the stale If-Range with the whole new content.
    const changed = await serve("127.0.0.1", cdn({ represent: (n) => (n === 0 ? { body: BODY, etag: ETAG } : { body: OTHER_BODY, etag: '"TESTONLY_etag2"' }), cut: (n) => (n === 0 ? CUT : undefined) }));
    const output = await workspace();
    await downloadPlatformMedia(forwardingClient(changed), downloadRequest(output));
    await expectDownloaded(output, OTHER_BODY);

    // One that ignores If-Range and sends the rest of the new content is caught by its ETag.
    const careless = await serve(
      "127.0.0.1",
      cdn({
        represent: (n) => (n === 0 ? { body: BODY, etag: ETAG } : { body: OTHER_BODY, etag: '"TESTONLY_etag2"' }),
        cut: (n) => (n === 0 ? CUT : undefined),
        answers: {
          1: { status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${CUT}-${OTHER_BODY.length - 1}/${OTHER_BODY.length}`, ETag: '"TESTONLY_etag2"' }, body: OTHER_BODY.subarray(CUT) },
        },
      }),
    );
    const second = await workspace();
    const http = forwardingClient(careless);
    await downloadPlatformMedia(http, downloadRequest(second));
    await expectDownloaded(second, OTHER_BODY);
    expect(http.requests).toHaveLength(3);
  });

  it(`gives up after ${PLATFORM_DOWNLOAD_RESUME_MAX} further requests when the body keeps breaking off`, async () => {
    for (const etag of [ETAG, undefined]) {
      // Every answer, resumed or not, breaks off after a slice: the declared length is never reached.
      const server = await serve("127.0.0.1", cdn({ represent: () => ({ body: BODY, ...(etag === undefined ? {} : { etag }) }), cut: () => 1_000 }));
      const http = forwardingClient(server);
      const output = await workspace();
      expect((await failure(downloadPlatformMedia(http, downloadRequest(output)))).appError.code).toBe("source_unreachable");
      expect(http.requests).toHaveLength(1 + PLATFORM_DOWNLOAD_RESUME_MAX);
      if (etag !== undefined) {
        expect(http.requests.slice(1).map((entry) => entry.headers.range)).toEqual([1_000, 2_000, 3_000].map((start) => `bytes=${start}-`));
      }
      await expectNothingLeft(output);
    }
  });
});

describe("downloadPlatformMedia limits", () => {
  it("refuses a declared length over the limit before writing anything", async () => {
    const writes: number[] = [];
    const download = createPlatformMediaDownload({ writeChunk: async (_handle, chunk) => void writes.push(chunk.byteLength) });
    const server = await serve("127.0.0.1", cdn({}));
    const http = forwardingClient(server);
    const output = await workspace();
    const error = await failure(download(http, downloadRequest(output, { maxBytes: BODY.length - 1 })));
    expect(error.appError.code).toBe("media_too_large");
    expect(writes).toEqual([]);
    await expectNothingLeft(output);

    // A declared platform size over the limit is refused without a request.
    const early = forwardingClient(server);
    expect((await failure(download(early, downloadRequest(output, { maxBytes: 100, expectedBytes: 101 })))).appError.code).toBe("media_too_large");
    expect(early.requests).toEqual([]);
    await expectNothingLeft(output);
  });

  it("stops when the bytes received pass the limit", async () => {
    const written: number[] = [];
    const download = createPlatformMediaDownload({
      writeChunk: async (handle, chunk, position) => {
        written.push(chunk.byteLength);
        await handle.write(chunk, 0, chunk.byteLength, position);
      },
    });
    // The declaration fits the limit; the body does not stop where it said it would.
    const http = scriptedClient(() =>
      scriptedResponse({ "content-type": "video/mp4", "content-length": "100" }, async function* () {
        yield new Uint8Array(60);
        yield new Uint8Array(60);
        yield new Uint8Array(60);
      }),
    );
    const output = await workspace();
    const error = await failure(download(http, downloadRequest(output, { url: mediaUrl(), maxBytes: 100 })));
    expect(error.appError.code).toBe("media_too_large");
    expect(written).toEqual([60]);
    await expectNothingLeft(output);
  });

  it(`aborts after ${PLATFORM_DOWNLOAD_STALL_TIMEOUT_MS} ms without data, before and after the response headers`, async () => {
    const timers: Array<{ ms: number; fire: () => void; cleared: boolean }> = [];
    const environment: Partial<PlatformDownloadEnvironment> = {
      setTimer: (fire, ms) => {
        const timer = { ms, fire, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => void ((handle as { cleared: boolean }).cleared = true),
    };
    const fireLive = () => timers.filter((timer) => !timer.cleared).forEach((timer) => timer.fire());
    const download = createPlatformMediaDownload(environment);

    // Data stops after a first slice; the timer armed by the last chunk fires.
    const midway = await serve("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "Content-Type": "video/mp4", ETag: ETAG, "Content-Length": String(BODY.length) });
      response.write(BODY.subarray(0, CUT));
    });
    const output = await workspace();
    let received = 0;
    const stalled = download(forwardingClient(midway), downloadRequest(output, { onProgress: (bytes) => {
      received = bytes;
      if (bytes >= CUT) setImmediate(fireLive);
    } }));
    expect((await failure(stalled)).appError.code).toBe("source_unreachable");
    expect(received).toBe(CUT);
    await expectNothingLeft(output);

    // No response headers at all.
    const silent = await serve("127.0.0.1", () => setImmediate(fireLive));
    const quiet = await workspace();
    expect((await failure(download(forwardingClient(silent), downloadRequest(quiet)))).appError.code).toBe("source_unreachable");
    await expectNothingLeft(quiet);

    expect(new Set(timers.map((timer) => timer.ms))).toEqual(new Set([PLATFORM_DOWNLOAD_STALL_TIMEOUT_MS]));
  });

  it("reports a full disk as disk_low", async () => {
    // The first write lands, the next finds the disk full.
    let calls = 0;
    const download = createPlatformMediaDownload({
      writeChunk: async (handle, chunk, position) => {
        if (++calls > 1) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        await handle.write(chunk, 0, chunk.byteLength, position);
      },
    });
    const server = await serve("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(BODY.length) });
      response.write(BODY.subarray(0, CUT), () => setTimeout(() => response.end(BODY.subarray(CUT)), 20));
    });
    const output = await workspace();
    expect((await failure(download(forwardingClient(server), downloadRequest(output)))).appError.code).toBe("disk_low");
    await expectNothingLeft(output);
  });

  it("writes nothing that arrives after a cancellation", async () => {
    const written: number[] = [];
    const download = createPlatformMediaDownload({
      writeChunk: async (handle, chunk, position) => {
        written.push(chunk.byteLength);
        await handle.write(chunk, 0, chunk.byteLength, position);
      },
    });
    // This body keeps yielding after the abort, as data already in flight would.
    const http = scriptedClient(() =>
      scriptedResponse({ "content-type": "video/mp4", "content-length": "300" }, async function* () {
        yield new Uint8Array(100);
        yield new Uint8Array(100);
        yield new Uint8Array(100);
      }),
    );
    const controller = new AbortController();
    const reason = new Error("cancelled by the test");
    const output = await workspace();
    const outcome = await download(http, downloadRequest(output, { signal: controller.signal, onProgress: () => controller.abort(reason) })).catch((error: unknown) => error);
    expect(outcome).toBe(reason);
    expect(written).toEqual([100]);
    await expectNothingLeft(output);
  });

  it("stops a live transfer on cancellation and leaves nothing behind", async () => {
    const server = await serve("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(BODY.length) });
      response.write(BODY.subarray(0, CUT));
    });
    const controller = new AbortController();
    const output = await workspace();
    const outcome = await downloadPlatformMedia(
      forwardingClient(server),
      downloadRequest(output, { signal: controller.signal, onProgress: (bytes) => bytes >= CUT && controller.abort() }),
    ).catch((error: unknown) => error);
    expect(outcome).toBe(controller.signal.reason);
    await expectNothingLeft(output);
  });

  it("gives two simultaneous downloads of the same content separate temporary files", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = await serve("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "Content-Type": "video/mp4", ETag: ETAG, "Content-Length": String(BODY.length) });
      response.write(BODY.subarray(0, CUT), () => void gate.then(() => response.end(BODY.subarray(CUT))));
    });
    const output = await workspace();
    let halfway = 0;
    const onProgress = (bytes: number) => void (bytes >= CUT && bytes < BODY.length && (halfway += 1));
    const both = [
      downloadPlatformMedia(forwardingClient(server), downloadRequest(output, { onProgress })),
      downloadPlatformMedia(forwardingClient(server), downloadRequest(output, { onProgress })),
    ];
    await vi.waitFor(() => expect(halfway).toBeGreaterThanOrEqual(2));
    const inFlight = await scratchEntries(output.scratchDir);
    expect(new Set(inFlight).size).toBe(2);
    for (const entry of inFlight) expect((await readFile(join(output.scratchDir, entry, "media.part"))).length).toBe(CUT);
    expect(existsSync(output.path)).toBe(false);
    release();
    expect(await Promise.all(both)).toEqual([
      { sizeBytes: BODY.length, mimeType: "video/mp4" },
      { sizeBytes: BODY.length, mimeType: "video/mp4" },
    ]);
    await expectDownloaded(output, BODY);
  });
});
