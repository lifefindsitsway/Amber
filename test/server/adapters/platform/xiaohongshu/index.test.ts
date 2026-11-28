import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformDownloadRequest, PlatformDownloadResult } from "../../../../../src/server/adapters/platform/download.ts";
import { XiaohongshuAdapter } from "../../../../../src/server/adapters/platform/xiaohongshu/index.ts";
import { amberError, isAmberError } from "../../../../../src/server/domain/errors.ts";
import { expiringOnRefusal } from "../../../../../src/server/pipeline/stages/platform-access.ts";
import { OutboundHttpError } from "../../../../../src/server/ports/outbound-http.ts";
import type { PlatformContentRef, PlatformCredential } from "../../../../../src/server/ports/platform-source.ts";
import { PLATFORM_PAGE_MAX_BYTES } from "../../../../../src/shared/defaults.ts";
import { scriptedYtDlp } from "../../../../fixtures/platform/scripted-io.ts";
import {
  drainFakeRequests,
  FakeHttp,
  homePage,
  IMAGE_NOTE_ID,
  loginRedirect,
  mp4File,
  noteLink,
  page,
  rangeAnswer,
  SOURCE,
  TOKEN,
  VIDEO_NOTE_ID,
  type FakeAnswer,
} from "../../../../fixtures/platform/xiaohongshu/pages.ts";

const COOKIE_VALUE = "xxxxTESTONLYcookie";
const LOGIN: PlatformCredential = {
  platform: "xiaohongshu",
  cookies: async () => `# Netscape HTTP Cookie File\n.xiaohongshu.com\tTRUE\t/\tTRUE\t0\tweb_session\t${COOKIE_VALUE}\n`,
};
/** Values that must never show in an error: the access parameters, the login and the signed media query. */
const SECRETS = [TOKEN, SOURCE, COOKIE_VALUE, "xxxxsign"];
const PAGE_HOSTS = ["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.com"];
const ORIGINAL_HOST = "sns-video-bd.xhscdn.com";
/** The adapter's own proxy table, which every request and download must carry. */
const TRUSTED = ["xiaohongshu.com", "xhslink.com", "xhscdn.com"];
const allDownloads: PlatformDownloadRequest[] = [];

afterEach(() => {
  for (const request of drainFakeRequests()) {
    expect(request.trustedHosts, request.url).toEqual(TRUSTED);
  }
  for (const request of allDownloads.splice(0)) {
    expect(request.trustedHosts).toEqual(TRUSTED);
  }
});

const signal = () => new AbortController().signal;
const ref = (noteId = VIDEO_NOTE_ID, link = noteLink(noteId)): PlatformContentRef => ({ platformContentId: noteId, sourceUrl: link });

type Route = FakeAnswer | Error;

interface Script {
  mobile?: Route;
  desktop?: Route;
  /** The desktop page when the request carries a login. */
  desktopWithLogin?: Route;
  home?: Route;
  original?: Route | Uint8Array;
  short?: Route;
}

const MOBILE_OK: Route = { body: page("mobile-video") };
const DESKTOP_OK: Route = { body: page("desktop-video") };
/** The untranscoded upload: 1080×1440 H.264, header first. */
const original = mp4File({ width: 1080, height: 1440, mdatBytes: 4096 });
const BOTH_LOGIN: Script = { mobile: loginRedirect("https://www.xiaohongshu.com/discovery/item/x"), desktop: loginRedirect("https://www.xiaohongshu.com/explore/x") };

/** Answers note pages, the home feed, the untranscoded upload and short links from `script`; any other request fails the test. */
function scripted(script: Script): FakeHttp {
  return new FakeHttp((request) => {
    const url = new URL(request.url);
    expect(request.publicOnly).toBe(true);
    expect(url.protocol).toBe("https:");
    if (url.hostname === "www.xiaohongshu.com") {
      expect(request.redirect).toBe("manual");
      const withLogin = request.headers?.["Cookie"] !== undefined;
      if (url.pathname.startsWith("/discovery/item/")) {
        expect(withLogin).toBe(false);
        return script.mobile ?? { status: 404 };
      }
      if (url.pathname.startsWith("/explore/")) {
        return (withLogin ? script.desktopWithLogin : script.desktop) ?? { status: 404 };
      }
      if (url.pathname === "/explore") {
        return script.home ?? { status: 404 };
      }
    }
    if (url.hostname === ORIGINAL_HOST) {
      expect(request.headers?.["Cookie"]).toBeUndefined();
      const original = script.original;
      if (original instanceof Uint8Array) {
        return rangeAnswer(original, request);
      }
      return original ?? { status: 403 };
    }
    if (url.hostname === "xhslink.com") {
      return script.short ?? { status: 404 };
    }
    throw new Error(`unexpected request to ${url.hostname}`);
  });
}

interface DownloadCall {
  request: PlatformDownloadRequest;
}

/** A stand-in for the platform media downloader: records every call and answers from `answer`. */
function downloader(answer: (request: PlatformDownloadRequest, call: number) => PlatformDownloadResult | Error = (request) => ({ sizeBytes: request.expectedBytes ?? 1, mimeType: "video/mp4" })) {
  const calls: DownloadCall[] = [];
  const download = async (_http: unknown, request: PlatformDownloadRequest): Promise<PlatformDownloadResult> => {
    calls.push({ request });
    allDownloads.push(request);
    const result = answer(request, calls.length);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return { calls, download };
}

function adapter(http: FakeHttp, download = downloader().download) {
  return new XiaohongshuAdapter({ http, download });
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  const error = await failure(work);
  return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
}

function pageRequests(http: FakeHttp): Array<{ path: string; login: boolean; agent: string | undefined }> {
  return http.requests
    .filter((request) => new URL(request.url).hostname === "www.xiaohongshu.com")
    .map((request) => ({ path: new URL(request.url).pathname, login: request.headers?.["Cookie"] !== undefined, agent: request.headers?.["User-Agent"] }));
}

const outputDir = () => mkdtempSync(join(tmpdir(), "amber-xhs-"));

describe("XiaohongshuAdapter reading", () => {
  it("reads the mobile share page first, as a phone, with only the link's access parameters", async () => {
    const http = scripted({ mobile: MOBILE_OK });
    const check = await adapter(http).precheck(ref(VIDEO_NOTE_ID, `${noteLink(VIDEO_NOTE_ID)}&extra=1`), LOGIN, signal());
    expect(check).toMatchObject({ result: "video", metadata: { title: "周末在家做一碗番茄牛腩面", durationMs: 284867 } });
    expect(http.requests).toHaveLength(1);
    const url = new URL(http.requests[0]?.url as string);
    expect(url.pathname).toBe(`/discovery/item/${VIDEO_NOTE_ID}`);
    expect([...url.searchParams.keys()]).toEqual(["xsec_token", "xsec_source"]);
    expect(http.requests[0]?.headers?.["User-Agent"]).toMatch(/iPhone/);
    // A visitor read succeeded, so the stored login was never sent.
    expect(pageRequests(http).some((request) => request.login)).toBe(false);
  });

  it("reads the desktop page once when the mobile page redirects to the login page", async () => {
    const http = scripted({ mobile: loginRedirect("https://www.xiaohongshu.com/discovery/item/x"), desktop: DESKTOP_OK });
    const metadata = await adapter(http).fetchMetadata(ref(), LOGIN, signal());
    expect(metadata).toEqual({
      title: "周末在家做一碗番茄牛腩面",
      durationMs: 284866,
      coverUrl: expect.stringMatching(/^https:\/\/sns-webpic-qc\.xhscdn\.com\//),
      publishedAt: 1794830642000,
      channelId: "5f00000000000000000000b2",
      channelTitle: "厨房里的小王",
      subtitleTracks: [],
      description: { state: "found", text: "牛腩提前焯水，番茄炒出沙。\n小火炖一个半小时 #番茄牛腩 #家常菜" },
    });
    expect(metadata).not.toHaveProperty("chapters");
    expect(pageRequests(http).map((request) => [request.path, request.login])).toEqual([
      [`/discovery/item/${VIDEO_NOTE_ID}`, false],
      [`/explore/${VIDEO_NOTE_ID}`, false],
    ]);
  });

  it("follows a redirect between the note's own pages and nothing else", async () => {
    let hops = 0;
    const http = scripted({});
    http.handler = (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/discovery/item/") && hops++ === 0) {
        return { status: 302, headers: { location: `http://www.xiaohongshu.com/discovery/item/${VIDEO_NOTE_ID}?xsec_token=${TOKEN}&from=1` } };
      }
      return MOBILE_OK;
    };
    expect((await adapter(http).precheck(ref(), undefined, signal())).result).toBe("video");
    expect(http.requests.map((request) => new URL(request.url).protocol)).toEqual(["https:", "https:"]);

    const off = new FakeHttp(() => ({ status: 302, headers: { location: "https://xiaohongshu.com.evil.example/explore" } }));
    expect(await codeOf(adapter(off).precheck(ref(), undefined, signal()))).toBe("network_blocked_by_policy.redirect");
    expect(off.hosts()).toEqual(["www.xiaohongshu.com"]);
  });

  it("refuses a link of another note or without parameters only where it matters", async () => {
    // A stored link of another note is ignored: the page is read without parameters.
    const http = scripted({ mobile: MOBILE_OK });
    await adapter(http).fetchMetadata(ref(VIDEO_NOTE_ID, noteLink(IMAGE_NOTE_ID)), undefined, signal());
    expect(new URL(http.requests[0]?.url as string).search).toBe("");
  });

  it("titles, describes and caps like the page parser, without subtitles, chapters or parts", async () => {
    const http = scripted({ mobile: MOBILE_OK });
    const xhs = adapter(http);
    expect(await xhs.fetchDescription(ref(), undefined, signal())).toEqual({ state: "found", text: "牛腩提前焯水，番茄炒出沙。\n小火炖一个半小时 #番茄牛腩 #家常菜" });
    expect(xhs).not.toHaveProperty("resolveParts");
    expect(await codeOf(xhs.listCollection("any", undefined, signal(), 10))).toBe("invalid_request");
    expect(xhs.parse(noteLink(VIDEO_NOTE_ID))?.platformCollectionId).toBeUndefined();
  });
});

describe("XiaohongshuAdapter.precheck", () => {
  const cases: Array<[string, Script, PlatformCredential | undefined, unknown]> = [
    ["a video note with an H.264 stream", { mobile: MOBILE_OK }, undefined, "video"],
    ["an image note", { mobile: { body: page("mobile-image").replaceAll(IMAGE_NOTE_ID, VIDEO_NOTE_ID) } }, undefined, { result: "rejected", reason: "not_video" }],
    ["both pages behind the login page, no login stored", BOTH_LOGIN, undefined, { result: "unverified" }],
    ["a network failure", { mobile: new OutboundHttpError("before_send", "network") }, undefined, { result: "unverified" }],
    ["HTTP 412", { mobile: { status: 412 } }, undefined, { result: "unverified" }],
    ["HTTP 429", { mobile: { status: 429 } }, undefined, { result: "unverified" }],
    [
      "the desktop page at /404 and no mobile note",
      { mobile: { body: "<html><body>not found</body></html>" }, desktop: { status: 302, headers: { location: "https://www.xiaohongshu.com/404?source=note" } } },
      undefined,
      { result: "unverified" },
    ],
    ["a page over PLATFORM_PAGE_MAX_BYTES", { mobile: { body: "x".repeat(PLATFORM_PAGE_MAX_BYTES + 1) } }, undefined, { result: "unverified" }],
    ["a video note without H.264", { mobile: { body: page("mobile-video").replace('"h264":[{', '"h264":[],"x":[{') } }, undefined, { result: "unverified" }],
  ];

  it.each(cases)("%s", async (_name, script, auth, expected) => {
    const check = await adapter(scripted(script)).precheck(ref(), auth, signal());
    if (expected === "video") {
      expect(check.result).toBe("video");
    } else {
      expect(check).toEqual(expected);
    }
  });

  it("rejects a link without xsec_token as expired without any request", async () => {
    const http = scripted({ mobile: MOBILE_OK });
    expect(await adapter(http).precheck(ref(VIDEO_NOTE_ID, noteLink(VIDEO_NOTE_ID, { source: SOURCE })), LOGIN, signal())).toEqual({
      result: "rejected",
      reason: "link_expired",
    });
    expect(await adapter(http).precheck({ platformContentId: VIDEO_NOTE_ID }, undefined, signal())).toEqual({ result: "rejected", reason: "link_expired" });
    expect(http.requests).toHaveLength(0);
  });

  it("retries once with the login when both pages redirect to the login page", async () => {
    const http = scripted({ ...BOTH_LOGIN, desktopWithLogin: DESKTOP_OK });
    expect((await adapter(http).precheck(ref(), LOGIN, signal())).result).toBe("video");
    expect(pageRequests(http).map((request) => [request.path, request.login])).toEqual([
      [`/discovery/item/${VIDEO_NOTE_ID}`, false],
      [`/explore/${VIDEO_NOTE_ID}`, false],
      [`/explore/${VIDEO_NOTE_ID}`, true],
    ]);
    expect(http.requests[2]?.headers?.["Cookie"]).toBe(`web_session=${COOKIE_VALUE}`);
  });

  it("reports auth_required, and the account expired, when the login is still turned away", async () => {
    const http = scripted({ ...BOTH_LOGIN, desktopWithLogin: loginRedirect("https://www.xiaohongshu.com/explore/x") });
    let expired = 0;
    const wrapped = expiringOnRefusal(adapter(http), () => expired++);
    expect(await codeOf(wrapped.precheck?.(ref(), LOGIN, signal()) as Promise<unknown>)).toBe("auth_required");
    expect(expired).toBe(1);
    expect(pageRequests(http).filter((request) => request.login)).toHaveLength(1);
  });

  it("does not retry with a login when only one page redirects to the login page", async () => {
    const http = scripted({ mobile: { status: 500 }, desktop: loginRedirect("https://www.xiaohongshu.com/explore/x"), desktopWithLogin: DESKTOP_OK });
    expect(await adapter(http).precheck(ref(), LOGIN, signal())).toEqual({ result: "unverified" });
    expect(pageRequests(http).some((request) => request.login)).toBe(false);
  });
});

describe("XiaohongshuAdapter.fetchMetadata errors", () => {
  it("maps each outcome to its error", async () => {
    const image = { mobile: { body: page("mobile-image").replaceAll(IMAGE_NOTE_ID, VIDEO_NOTE_ID) } };
    expect(await codeOf(adapter(scripted(image)).fetchMetadata(ref(), undefined, signal()))).toBe("invalid_request.not_video");
    expect(await codeOf(adapter(scripted(BOTH_LOGIN)).fetchMetadata(ref(), undefined, signal()))).toBe("auth_required");
    expect(await codeOf(adapter(scripted({ mobile: { status: 429 } })).fetchMetadata(ref(), undefined, signal()))).toBe("platform_blocked.visitor_refused");
    expect(await codeOf(adapter(scripted({ mobile: { status: 503 }, desktop: { status: 503 } })).fetchMetadata(ref(), undefined, signal()))).toBe("source_unreachable");
    expect(await codeOf(adapter(scripted({ mobile: new OutboundHttpError("before_send", "timeout") })).fetchMetadata(ref(), undefined, signal()))).toBe(
      "source_unreachable",
    );
    // An oversized page or a note that does not validate yields no metadata at all.
    expect(await codeOf(adapter(scripted({ mobile: { body: "x".repeat(PLATFORM_PAGE_MAX_BYTES + 1) } })).fetchMetadata(ref(), undefined, signal()))).toBe(
      "source_html_error_page",
    );
    const invalid = { mobile: { body: page("mobile-video").replace('"type":"video"', '"type":null') }, desktop: { status: 404 } };
    expect(await codeOf(adapter(scripted(invalid)).fetchMetadata(ref(), undefined, signal()))).toBe("source_unreachable");
  });
});

describe("XiaohongshuAdapter.refreshCoverUrl", () => {
  it("reads the note's current cover over https on the media domain, like fetchMetadata", async () => {
    const http = scripted({ mobile: MOBILE_OK });
    expect(await adapter(http).refreshCoverUrl(ref(), undefined, signal())).toBe("https://sns-webpic-qc.xhscdn.com/202611270000/xxxxcover!h5_1080jpg");
    expect(pageRequests(http).map((request) => [request.path, request.login])).toEqual([[`/discovery/item/${VIDEO_NOTE_ID}`, false]]);
  });

  it("uses the stored login exactly as fetchMetadata does, only when both pages want one", async () => {
    const http = scripted({ ...BOTH_LOGIN, desktopWithLogin: DESKTOP_OK });
    expect(await adapter(http).refreshCoverUrl(ref(), LOGIN, signal())).toMatch(/^https:\/\/sns-webpic-qc\.xhscdn\.com\//);
    expect(pageRequests(http).map((request) => request.login)).toEqual([false, false, true]);
  });

  it("is link_expired for a source link without its access parameter, asking nothing", async () => {
    const http = scripted({ mobile: MOBILE_OK });
    expect(await codeOf(adapter(http).refreshCoverUrl(ref(VIDEO_NOTE_ID, noteLink(VIDEO_NOTE_ID, { source: SOURCE })), LOGIN, signal()))).toBe(
      "invalid_request.link_expired",
    );
    expect(await codeOf(adapter(http).refreshCoverUrl({ platformContentId: VIDEO_NOTE_ID }, undefined, signal()))).toBe("invalid_request.link_expired");
    expect(http.requests).toHaveLength(0);
  });

  it("names no cover off the media domain and fails with fetchMetadata's errors", async () => {
    const foreign = { mobile: { body: page("mobile-video").replaceAll("http://sns-webpic-qc.xhscdn.com/", "http://images.example.com/") } };
    expect(await adapter(scripted(foreign)).refreshCoverUrl(ref(), undefined, signal())).toBeUndefined();
    expect(await codeOf(adapter(scripted(BOTH_LOGIN)).refreshCoverUrl(ref(), undefined, signal()))).toBe("auth_required");
    expect(await codeOf(adapter(scripted({ mobile: { status: 429 } })).refreshCoverUrl(ref(), undefined, signal()))).toBe("platform_blocked.visitor_refused");
    const image = { mobile: { body: page("mobile-image").replaceAll(IMAGE_NOTE_ID, VIDEO_NOTE_ID) } };
    expect(await codeOf(adapter(scripted(image)).refreshCoverUrl(ref(), undefined, signal()))).toBe("invalid_request.not_video");
  });
});

describe("XiaohongshuAdapter media", () => {

  it("downloads the smallest H.264 stream for audio, main address first, without yt-dlp or a login", async () => {
    const { ytDlp, runner } = scriptedYtDlp();
    const fake = downloader();
    const http = scripted({ ...BOTH_LOGIN, desktopWithLogin: DESKTOP_OK });
    const xhs = new XiaohongshuAdapter({ http, download: fake.download, ...({ ytDlp } as object) });
    const dir = outputDir();
    const progress: number[] = [];
    const { sizeBytes } = await xhs.fetchAudio(ref(), LOGIN, { path: join(dir, "audio") }, (value) => progress.push(value), signal());
    expect(sizeBytes).toBe(9919338);
    expect(fake.calls).toHaveLength(1);
    const request = fake.calls[0]?.request as PlatformDownloadRequest;
    expect(request).toMatchObject({
      url: "https://sns-video-v3.xhscdn.com/stream/1/110/258/xxxxstream_258.mp4?sign=xxxxsign&t=xxxx",
      allowedHosts: ["xhscdn.com"],
      kind: "video",
      expectedBytes: 9919338,
      output: { path: join(dir, "audio") },
    });
    expect(request.output.scratchDir.startsWith(dir)).toBe(true);
    expect(JSON.stringify(request.headers ?? {})).not.toContain("Cookie");
    expect(runner.specs).toHaveLength(0);
    // The page was read with the login; the media request still went without one.
    expect(pageRequests(http).some((page) => page.login)).toBe(true);
  });

  it("tries the backup addresses in turn, and stops at a failure no other address can fix", async () => {
    const http = scripted({ mobile: MOBILE_OK });
    const flaky = downloader((request, call) => (call < 3 ? amberError("source_unreachable", "scripted") : { sizeBytes: request.expectedBytes ?? 0, mimeType: "video/mp4" }));
    await adapter(http, flaky.download).fetchAudio(ref(), undefined, { path: join(outputDir(), "audio") }, () => undefined, signal());
    expect(flaky.calls.map((call) => new URL(call.request.url).hostname)).toEqual(["sns-video-v3.xhscdn.com", "sns-bak-v1.xhscdn.com", "sns-bak-v6.xhscdn.com"]);

    const mismatch = downloader(() => amberError("source_unreachable", "length differs from the declared size"));
    expect(await codeOf(adapter(scripted({ mobile: MOBILE_OK }), mismatch.download).fetchAudio(ref(), undefined, { path: join(outputDir(), "a") }, () => undefined, signal()))).toBe(
      "source_unreachable",
    );
    expect(mismatch.calls.every((call) => call.request.expectedBytes === 7790374)).toBe(true);

    const large = downloader(() => amberError("media_too_large", "scripted"));
    expect(await codeOf(adapter(scripted({ mobile: MOBILE_OK }), large.download).fetchAudio(ref(), undefined, { path: join(outputDir(), "a") }, () => undefined, signal(), { maxBytes: 10 }))).toBe(
      "media_too_large",
    );
    expect(large.calls).toHaveLength(1);
    expect(large.calls[0]?.request.maxBytes).toBe(10);
  });

  it("lists the untranscoded upload and the transcoded stream, sizes from the file header and the page", async () => {
    const http = scripted({ mobile: MOBILE_OK, original });
    expect(await adapter(http).listVideoQualities(ref(), undefined, signal())).toEqual([
      { tier: 720, width: 720, height: 960 },
      { tier: 1080, width: 1080, height: 1440 },
    ]);
    const probes = http.requests.filter((request) => new URL(request.url).hostname === ORIGINAL_HOST);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((request) => /^bytes=\d+-\d+$/.test(request.headers?.["Range"] ?? "") && request.redirect === "manual")).toBe(true);
  });

  it("lists only the transcoded stream when the upload cannot be read or is not H.264", async () => {
    for (const unreadable of [{ status: 403 }, { status: 200, body: "<html></html>" }, mp4File({ width: 1080, height: 1440, codec: "hvc1" })] as const) {
      const http = scripted({ mobile: MOBILE_OK, original: unreadable });
      expect(await adapter(http).listVideoQualities(ref(), undefined, signal())).toEqual([{ tier: 720, width: 720, height: 960 }]);
    }
    // The desktop page does not name the upload, so nothing is probed.
    const desktop = scripted({ mobile: loginRedirect("https://www.xiaohongshu.com/discovery/item/x"), desktop: DESKTOP_OK, original });
    expect(await adapter(desktop).listVideoQualities(ref(), undefined, signal())).toEqual([{ tier: 720, width: 720, height: 960 }]);
    expect(desktop.hosts()).not.toContain(ORIGINAL_HOST);
  });

  it("caches exactly the chosen tier and refuses a tier no longer offered", async () => {
    const fake = downloader();
    const output = { path: join(outputDir(), "video.mp4"), scratchDir: outputDir() };
    const xhs = adapter(scripted({ mobile: MOBILE_OK, original }), fake.download);
    expect(await xhs.fetchVideo(ref(), undefined, { tier: 1080, maxBytes: 1e9, output }, () => undefined, signal())).toEqual({
      sizeBytes: original.byteLength,
      mimeType: "video/mp4",
      height: 1440,
      acquisition: "guest",
    });
    expect(fake.calls[0]?.request).toMatchObject({ url: `https://${ORIGINAL_HOST}/pre_post/xxxxoriginkey000000000000000000000000000000`, expectedBytes: original.byteLength, output, maxBytes: 1e9 });
    await xhs.fetchVideo(ref(), undefined, { tier: 720, maxBytes: 1e9, output }, () => undefined, signal());
    expect(fake.calls[1]?.request.url).toMatch(/^https:\/\/sns-video-v3\.xhscdn\.com\/.+259/);
    expect(await xhs.inspectVideo(ref(), undefined, { tier: 1080 }, signal())).toEqual({ hasVideo: true, mimeType: "video/mp4", sizeBytes: original.byteLength, height: 1440, width: 1080 });

    const gone = adapter(scripted({ mobile: MOBILE_OK, original: { status: 404 } }), fake.download);
    const before = fake.calls.length;
    expect(await codeOf(gone.fetchVideo(ref(), undefined, { tier: 1080, maxBytes: 1e9, output }, () => undefined, signal()))).toBe(
      "invalid_request.cache_quality_unavailable",
    );
    expect(await codeOf(gone.inspectVideo(ref(), undefined, { tier: 1080 }, signal()))).toBe("invalid_request.cache_quality_unavailable");
    expect(fake.calls.length).toBe(before);
  });

  it("never sends the login to media hosts, even after reading the page with it", async () => {
    const fake = downloader();
    const http = scripted({ ...BOTH_LOGIN, desktopWithLogin: MOBILE_OK_AS_DESKTOP, original });
    const xhs = adapter(http, fake.download);
    await xhs.fetchVideo(ref(), LOGIN, { tier: 720, maxBytes: 1e9, output: { path: join(outputDir(), "v"), scratchDir: outputDir() } }, () => undefined, signal());
    await xhs.fetchCover("https://sns-webpic-qc.xhscdn.com/202611270000/xxxxcover!h5_1080jpg", { path: join(outputDir(), "c") }, { maxBytes: 100 }, signal());
    for (const request of http.requests.filter((request) => new URL(request.url).hostname.endsWith("xhscdn.com"))) {
      expect(request.headers?.["Cookie"]).toBeUndefined();
    }
    for (const call of fake.calls) {
      expect(Object.keys(call.request.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    }
  });
});

/** The desktop page fixture carrying the mobile fixture's note, so the untranscoded upload is named after a login read. */
const MOBILE_OK_AS_DESKTOP: Route = {
  body: page("desktop-video").replace(
    '"video":{"capa":{"duration":284}',
    '"video":{"consumer":{"originVideoKey":"pre_post/xxxxoriginkey000000000000000000000000000000"},"capa":{"duration":284}',
  ),
};

describe("XiaohongshuAdapter.fetchCover", () => {
  it("downloads an https cover on the media domain as an image, without a login", async () => {
    const fake = downloader(() => ({ sizeBytes: 42, mimeType: "image/jpeg" }));
    const http = scripted({});
    const path = join(outputDir(), "cover");
    expect(await adapter(http, fake.download).fetchCover("https://sns-webpic-qc.xhscdn.com/x/xxxxcover", { path }, { maxBytes: 1000 }, signal())).toEqual({ sizeBytes: 42 });
    expect(fake.calls[0]?.request).toMatchObject({ url: "https://sns-webpic-qc.xhscdn.com/x/xxxxcover", allowedHosts: ["xhscdn.com"], kind: "image", maxBytes: 1000, output: { path } });
  });

  it("refuses any other address before a request is made", async () => {
    const fake = downloader();
    const http = scripted({});
    for (const url of [
      "http://sns-webpic-qc.xhscdn.com/x/cover",
      "https://evilxhscdn.com/x/cover",
      "https://sns-webpic-qc.xhscdn.com.evil.example/x/cover",
      "https://user:pass@sns-webpic-qc.xhscdn.com/x/cover",
      "https://sns-webpic-qc.xhscdn.com:8443/x/cover",
      "https://i0.hdslb.com/cover.jpg",
    ]) {
      expect(await codeOf(adapter(http, fake.download).fetchCover(url, { path: join(outputDir(), "c") }, { maxBytes: 10 }, signal())), url).toBe("invalid_request");
    }
    expect(fake.calls).toHaveLength(0);
    expect(http.requests).toHaveLength(0);
  });
});

describe("XiaohongshuAdapter.checkCredential", () => {
  it("reads the home feed once with the login and trusts only a clear answer", async () => {
    const cases: Array<[Route, string]> = [
      [{ body: homePage(true) }, "valid"],
      [{ body: homePage(false) }, "expired"],
      [loginRedirect("https://www.xiaohongshu.com/explore"), "expired"],
      [{ body: homePage(undefined) }, "unknown"],
      [{ status: 461 }, "unknown"],
      [{ status: 302, headers: { location: "https://www.xiaohongshu.com/website-captcha" } }, "unknown"],
      [new OutboundHttpError("before_send", "network"), "unknown"],
    ];
    for (const [home, expected] of cases) {
      const http = scripted({ home });
      expect(await adapter(http).checkCredential(LOGIN, signal()), JSON.stringify(home)).toBe(expected);
      expect(http.requests).toHaveLength(1);
      expect(http.requests[0]?.url).toBe("https://www.xiaohongshu.com/explore");
      expect(http.requests[0]?.headers?.["Cookie"]).toBe(`web_session=${COOKIE_VALUE}`);
    }
  });
});

describe("XiaohongshuAdapter.resolveUrl", () => {
  it("expands an xhslink.com short link to the note's canonical link", async () => {
    const http = scripted({ short: { status: 302, headers: { location: `https://www.xiaohongshu.com/discovery/item/${VIDEO_NOTE_ID}?app_platform=ios&xsec_token=${TOKEN}&xsec_source=app_share` } } });
    expect(await adapter(http).resolveUrl("http://xhslink.com/a/AbC123", signal())).toBe(
      `https://www.xiaohongshu.com/explore/${VIDEO_NOTE_ID}?xsec_token=${TOKEN}&xsec_source=app_share`,
    );
    expect(http.requests.map((request) => request.url)).toEqual(["https://xhslink.com/a/AbC123"]);
  });

  it("requests nothing for other links and follows no hop off the platform", async () => {
    const http = scripted({ short: { status: 302, headers: { location: "https://evil.example/explore/64e0a1b2c3d4e5f600112233" } } });
    expect(await adapter(http).resolveUrl("https://example.com/a/AbC123", signal())).toBeNull();
    expect(http.requests).toHaveLength(0);
    expect(await adapter(http).resolveUrl("https://xhslink.com/a/AbC123", signal())).toBeNull();
    expect(http.hosts()).toEqual(["xhslink.com"]);
  });
});

describe("XiaohongshuAdapter outbound hygiene", () => {
  it("keeps the access parameters, the login and signed media queries out of every error", async () => {
    const errors: unknown[] = [];
    const collect = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (error) {
        errors.push(error);
      }
    };
    const failing = downloader(() => amberError("source_unreachable", "scripted"));
    await collect(adapter(scripted(BOTH_LOGIN)).fetchMetadata(ref(), undefined, signal()));
    await collect(adapter(scripted({ ...BOTH_LOGIN, desktopWithLogin: loginRedirect(noteLink(VIDEO_NOTE_ID)) })).precheck(ref(), LOGIN, signal()));
    await collect(adapter(scripted({ mobile: { status: 429 } })).fetchMetadata(ref(), LOGIN, signal()));
    await collect(adapter(scripted({ mobile: { status: 302, headers: { location: `https://evil.example/?xsec_token=${TOKEN}` } } })).fetchMetadata(ref(), LOGIN, signal()));
    await collect(adapter(scripted({ mobile: MOBILE_OK }), failing.download).fetchAudio(ref(), LOGIN, { path: join(outputDir(), "a") }, () => undefined, signal()));
    await collect(adapter(scripted({ mobile: MOBILE_OK, original: { status: 404 } }), failing.download).fetchVideo(ref(), LOGIN, { tier: 1080, maxBytes: 1, output: { path: join(outputDir(), "v"), scratchDir: outputDir() } }, () => undefined, signal()));
    await collect(adapter(scripted({}), failing.download).fetchCover(`https://evil.example/?xsec_token=${TOKEN}`, { path: join(outputDir(), "c") }, { maxBytes: 1 }, signal()));
    expect(errors).toHaveLength(7);
    for (const error of errors) {
      expect(isAmberError(error)).toBe(true);
      if (!isAmberError(error)) continue;
      const exposed = JSON.stringify({ message: error.message, appError: error.appError });
      for (const secret of SECRETS) {
        expect(exposed).not.toContain(secret);
      }
    }
  });

  it("only ever requests the platform's page hosts and media domain, public addresses only", async () => {
    const http = scripted({ ...BOTH_LOGIN, desktopWithLogin: MOBILE_OK_AS_DESKTOP, original, home: { body: homePage(true) } });
    const xhs = adapter(http);
    await xhs.precheck(ref(), LOGIN, signal());
    await xhs.listVideoQualities(ref(), LOGIN, signal());
    await xhs.checkCredential(LOGIN, signal());
    expect(http.requests.every((request) => request.publicOnly === true)).toBe(true);
    for (const host of http.hosts()) {
      expect(PAGE_HOSTS.includes(host) || host.endsWith(".xhscdn.com"), host).toBe(true);
    }
  });
});
