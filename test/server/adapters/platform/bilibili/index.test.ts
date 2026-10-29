import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BILIBILI_EXTRACTORS, BilibiliAdapter } from "../../../../../src/server/adapters/platform/bilibili/index.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { OutboundHttpError, type OutboundRequest } from "../../../../../src/server/ports/outbound-http.ts";
import type { AppError } from "../../../../../src/shared/errors.ts";
import {
  argAfter,
  cookieLine,
  credential,
  ScriptedHttp,
  scriptedYtDlp,
  signal,
  type ProcessHandler,
  type ScriptedResponse,
} from "../../../../fixtures/platform/scripted-io.ts";

const BV = "BV1xx411c7mD";
const NOW = Date.UTC(2026, 9, 1);
const LOGIN = credential("bilibili", [cookieLine(".bilibili.com", "session"), cookieLine(".example.com", "foreign"), cookieLine(".bilibili.com", "stale", 1)]);

const PAGES = [
  { cid: 1001, page: 1, part: " Lecture 1 ", duration: 6000 },
  { cid: 1002, page: 2, part: "Lecture 2", duration: 5880 },
];

type Route = (request: OutboundRequest, url: URL) => ScriptedResponse | Error | undefined;

function setup(options: { routes?: Route; process?: ProcessHandler } = {}) {
  const { ytDlp, runner, dataDir } = scriptedYtDlp(options.process);
  const http = new ScriptedHttp((request) => {
    const url = new URL(request.url);
    const answer = options.routes?.(request, url);
    if (answer !== undefined) {
      return answer;
    }
    if (url.pathname === "/x/player/pagelist") {
      return { body: { code: 0, data: url.searchParams.get("bvid") === BV ? PAGES : [{ cid: 9, page: 1, part: "Only", duration: 60 }] } };
    }
    return { status: 404 };
  });
  return { adapter: new BilibiliAdapter({ ytDlp, http, now: () => NOW }), http, runner, dataDir };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
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

describe("BilibiliAdapter.resolveUrl", () => {
  it("follows short-link redirects hop by hop to a canonical URL", async () => {
    const { adapter, http } = setup({
      routes: (_, url) =>
        url.host === "b23.tv"
          ? { status: 302, headers: { Location: url.pathname === "/one" ? "/two" : `https://www.bilibili.com/video/${BV}?p=2&share_source=copy` } }
          : undefined,
    });
    expect(await adapter.resolveUrl("https://b23.tv/one", signal())).toBe(`https://www.bilibili.com/video/${BV}?p=2`);
    expect(http.requests.map((request) => request.url)).toEqual(["https://b23.tv/one", "https://b23.tv/two"]);
    expect(http.requests.map((request) => request.redirect)).toEqual(["manual", "manual"]);
  });

  it("gives up beyond SHORTLINK_MAX_HOPS, on a non-redirect, off-platform targets and non-short links", async () => {
    const loop = setup({ routes: (_, url) => ({ status: 301, headers: { Location: `https://b23.tv/${url.pathname.length}x` } }) });
    expect(await loop.adapter.resolveUrl("https://b23.tv/a", signal())).toBeNull();
    expect(loop.http.requests).toHaveLength(3);
    const ok = setup({ routes: () => ({ status: 200, body: "<html>" }) });
    expect(await ok.adapter.resolveUrl("https://b23.tv/a", signal())).toBeNull();
    const away = setup({ routes: () => ({ status: 302, headers: { Location: "https://evil.example/" } }) });
    expect(await away.adapter.resolveUrl("https://b23.tv/a", signal())).toBeNull();
    const plain = setup();
    expect(await plain.adapter.resolveUrl("https://example.com/v/1", signal())).toBeNull();
    expect(plain.http.requests).toEqual([]);
  });
});

describe("BilibiliAdapter.resolveParts", () => {
  it("reads cid, page, title and duration from pagelist", async () => {
    const { adapter, http } = setup();
    expect(await adapter.resolveParts({ platformContentId: BV }, undefined, signal())).toEqual([
      { platformPartId: "1001", index: 1, title: "Lecture 1", durationMs: 6_000_000, canonicalUrl: `https://www.bilibili.com/video/${BV}?p=1` },
      { platformPartId: "1002", index: 2, title: "Lecture 2", durationMs: 5_880_000, canonicalUrl: `https://www.bilibili.com/video/${BV}?p=2` },
    ]);
    expect(await adapter.resolveParts({ platformContentId: "BV1aa411c7mD" }, undefined, signal())).toEqual([
      { platformPartId: "9", index: 1, title: "Only", durationMs: 60_000, canonicalUrl: "https://www.bilibili.com/video/BV1aa411c7mD" },
    ]);
    expect(http.requests[0]?.headers).toMatchObject({ Referer: "https://www.bilibili.com/" });
    expect(http.requests[0]?.headers).not.toHaveProperty("Cookie");
  });

  it("sends only the platform's unexpired cookies when the user has a login", async () => {
    const { adapter, http } = setup();
    await adapter.resolveParts({ platformContentId: BV }, LOGIN, signal());
    expect(http.requests[0]?.headers?.["Cookie"]).toBe("session=<placeholder>");
  });

  it("maps API codes to source classes", async () => {
    const cases: Array<[number, string]> = [
      [-412, "platform_blocked"],
      [-352, "platform_blocked"],
      [-509, "platform_blocked"],
      [-101, "auth_required"],
      [-403, "auth_required"],
      [-404, "source_unreachable"],
    ];
    for (const [code, expected] of cases) {
      const { adapter } = setup({ routes: () => ({ body: { code, message: "x" } }) });
      expect((await errorOf(adapter.resolveParts({ platformContentId: BV }, undefined, signal()))).class, String(code)).toBe(expected);
    }
    const empty = setup({ routes: () => ({ body: { code: 0, data: [] } }) });
    expect((await errorOf(empty.adapter.resolveParts({ platformContentId: BV }, undefined, signal()))).class).toBe("source_unreachable");
  });
});

describe("BilibiliAdapter.fetchMetadata", () => {
  const INFO = {
    title: "Lecture 2",
    duration: 5880.4,
    // yt-dlp passes the cover on as the API gives it, over plain http.
    thumbnail: "http://i0.hdslb.com/cover.jpg",
    timestamp: 1_760_000_000,
    uploader: "jyy",
    uploader_id: 202224425,
    chapters: [
      { start_time: 0, end_time: 600, title: "Intro" },
      { start_time: 600, title: "Body" },
    ],
  };
  const PLAYER = {
    code: 0,
    data: {
      need_login_subtitle: false,
      subtitle: {
        subtitles: [
          { lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/1.json", type: 0 },
          { lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/2?auth_key=<placeholder>", type: 1, ai_type: 0 },
          { lan: "ai-en", lan_doc: "English (AI)", subtitle_url: "http://aisubtitle.hdslb.com/bfs/ai_subtitle/3", type: 1, ai_type: 1 },
          { lan: "ai-ja", subtitle_url: "" },
        ],
      },
    },
  };

  it("combines yt-dlp's info for the part with the player's subtitle list", async () => {
    let cookies: string | undefined;
    const { adapter, runner, http } = setup({
      routes: (_, url) => (url.pathname === "/x/player/wbi/v2" ? { body: PLAYER } : undefined),
      process: (spec) => {
        const file = argAfter(spec.args, "--cookies");
        cookies = file === undefined ? undefined : readFileSync(file, "utf8");
        return { stdout: JSON.stringify(INFO) };
      },
    });
    const metadata = await adapter.fetchMetadata({ platformContentId: BV, platformPartId: "1002" }, LOGIN, signal());
    expect(metadata).toEqual({
      title: "Lecture 2",
      durationMs: 5_880_400,
      coverUrl: "https://i0.hdslb.com/cover.jpg",
      publishedAt: 1_760_000_000_000,
      channelId: "202224425",
      channelTitle: "jyy",
      chapters: [
        { startMs: 0, endMs: 600_000, title: "Intro" },
        { startMs: 600_000, title: "Body" },
      ],
      subtitleTracks: [
        { locator: "https://aisubtitle.hdslb.com/bfs/subtitle/1.json", language: "zh-CN", label: "中文（中国）", autoGenerated: false, translated: false },
        {
          locator: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/2?auth_key=<placeholder>",
          language: "zh",
          label: "中文（自动生成）",
          autoGenerated: true,
          translated: false,
        },
        { locator: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/3", language: "en", label: "English (AI)", autoGenerated: true, translated: true },
      ],
    });
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(-4)).toEqual(["--dump-single-json", "--skip-download", "--no-playlist", `https://www.bilibili.com/video/${BV}?p=2`]);
    expect(args).not.toContain("--write-subs");
    expect(argAfter(args, "--use-extractors")).toBe(BILIBILI_EXTRACTORS.join(","));
    expect(cookies).toContain("session\t<placeholder>");
    const player = new URL(http.to("/x/player/wbi/v2")[0]?.url as string);
    expect(Object.fromEntries(player.searchParams)).toEqual({ bvid: BV, cid: "1002" });
    expect(http.to("/x/player/wbi/v2")[0]?.headers?.["Cookie"]).toBe("session=<placeholder>");
  });

  it("works as a guest: no cookies anywhere, an empty login-only subtitle list and the part's duration as fallback", async () => {
    const { adapter, runner, http } = setup({
      routes: (_, url) => (url.pathname === "/x/player/wbi/v2" ? { body: { code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } } } : undefined),
      process: () => ({ stdout: JSON.stringify({ title: "t" }) }),
    });
    const metadata = await adapter.fetchMetadata({ platformContentId: BV }, undefined, signal());
    expect(metadata).toMatchObject({ title: "t", durationMs: 6_000_000, chapters: [], subtitleTracks: [] });
    expect(runner.specs[0]?.args).not.toContain("--cookies");
    expect(http.requests.every((request) => request.headers?.["Cookie"] === undefined)).toBe(true);
    // Without a part id, the first part is meant.
    expect(runner.specs[0]?.args.at(-1)).toBe(`https://www.bilibili.com/video/${BV}?p=1`);
  });

  it("fails when the part is gone", async () => {
    const { adapter } = setup();
    expect((await errorOf(adapter.fetchMetadata({ platformContentId: BV, platformPartId: "7" }, undefined, signal()))).class).toBe("source_unreachable");
  });
});

describe("BilibiliAdapter.fetchSubtitle", () => {
  const TRACK = { locator: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/2?auth_key=<placeholder>", language: "zh", autoGenerated: true, translated: false };

  it("reads the signed subtitle JSON without sending cookies", async () => {
    const { adapter, http } = setup({
      routes: (_, url) =>
        url.host === "aisubtitle.hdslb.com"
          ? { body: { body: [{ from: 0.5, to: 2.25, content: "你好" }, { from: 2.25, content: "broken" }, { to: 3, content: "also broken" }] } }
          : undefined,
    });
    const subtitle = await adapter.fetchSubtitle({ platformContentId: BV }, TRACK, LOGIN, signal());
    expect(subtitle.language).toBe("zh");
    expect(subtitle.acquisition).toBe("authenticated");
    expect(subtitle.cues[0]).toEqual({ startMs: 500, endMs: 2250, text: "你好" });
    expect(subtitle.cues[1]?.endMs).toBeNaN();
    expect(subtitle.cues[2]?.startMs).toBeNaN();
    expect(http.requests[0]?.url).toBe(TRACK.locator);
    expect(http.requests[0]?.headers).toMatchObject({ Referer: "https://www.bilibili.com/" });
    expect(http.requests[0]?.headers).not.toHaveProperty("Cookie");

    const guest = await adapter.fetchSubtitle({ platformContentId: BV }, TRACK, undefined, signal());
    expect(guest.acquisition).toBe("guest");
  });

  it("classifies an expired signed URL as unreachable", async () => {
    const { adapter } = setup({ routes: () => ({ status: 403, body: "" }) });
    expect((await errorOf(adapter.fetchSubtitle({ platformContentId: BV }, TRACK, undefined, signal()))).class).toBe("source_unreachable");
  });
});

describe("BilibiliAdapter.checkCredential", () => {
  const nav = (answer: ScriptedResponse | Error) => setup({ routes: (_, url) => (url.pathname === "/x/web-interface/nav" ? answer : undefined) });

  it("asks nav whether the cookies are logged in", async () => {
    const valid = nav({ body: { code: 0, data: { isLogin: true } } });
    expect(await valid.adapter.checkCredential(LOGIN, signal())).toBe("valid");
    expect(valid.http.requests[0]?.headers?.["Cookie"]).toBe("session=<placeholder>");
    expect(await nav({ body: { code: -101, data: { isLogin: false } } }).adapter.checkCredential(LOGIN, signal())).toBe("expired");
    expect(await nav({ body: { code: 0, data: { isLogin: false } } }).adapter.checkCredential(LOGIN, signal())).toBe("expired");
  });

  it("answers unknown for anything unclear, but not for an abort", async () => {
    expect(await nav({ body: { code: -412 } }).adapter.checkCredential(LOGIN, signal())).toBe("unknown");
    expect(await nav({ status: 500, body: "" }).adapter.checkCredential(LOGIN, signal())).toBe("unknown");
    expect(await nav(new OutboundHttpError("before_send", "network")).adapter.checkCredential(LOGIN, signal())).toBe("unknown");
    const controller = new AbortController();
    controller.abort();
    await expect(nav(new OutboundHttpError("before_send", "aborted")).adapter.checkCredential(LOGIN, controller.signal)).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("BilibiliAdapter.fetchCollection", () => {
  it("lists entries flat and takes the first part of each", async () => {
    const { adapter, runner, http } = setup({
      process: () => ({
        stdout: JSON.stringify({
          title: "Course",
          entries: [{ url: `https://www.bilibili.com/video/${BV}` }, { id: "BV1aa411c7mD" }, { title: "no id" }],
        }),
      }),
    });
    expect(await adapter.fetchCollection("202224425_8942017", LOGIN, signal())).toEqual({
      title: "Course",
      items: [
        { platformContentId: BV, platformPartId: "1001", title: "Lecture 1", durationMs: 6_000_000, canonicalUrl: `https://www.bilibili.com/video/${BV}?p=1` },
        { platformContentId: "BV1aa411c7mD", platformPartId: "9", title: "Only", durationMs: 60_000, canonicalUrl: "https://www.bilibili.com/video/BV1aa411c7mD" },
      ],
    });
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(-3)).toEqual(["--dump-single-json", "--flat-playlist", "https://space.bilibili.com/202224425/lists/8942017"]);
    expect(args).toContain("--cookies");
    expect(http.to("/x/player/pagelist")).toHaveLength(2);
  });

  it("uses the series URL and the id as a fallback title, and refuses ids it does not issue", async () => {
    const { adapter, runner } = setup({ process: () => ({ stdout: JSON.stringify({ entries: [] }) }) });
    expect(await adapter.fetchCollection("1_series_2", undefined, signal())).toEqual({ title: "1_series_2", items: [] });
    expect(runner.specs[0]?.args.at(-1)).toBe("https://space.bilibili.com/1/lists/2?type=series");
    await expect(adapter.fetchCollection("PLabc", undefined, signal())).rejects.toBeInstanceOf(TypeError);
  });
});

describe("BilibiliAdapter.fetchAudio", () => {
  it("downloads the part located by cid, with the login", async () => {
    const { adapter, runner, dataDir } = setup({
      process: (spec) => {
        writeFileSync(argAfter(spec.args, "--output") as string, "abc");
        return {};
      },
    });
    const result = await adapter.fetchAudio({ platformContentId: BV, platformPartId: "1002" }, LOGIN, { path: `${dataDir}/audio.partial` }, () => undefined, signal());
    expect(result).toEqual({ sizeBytes: 3 });
    const args = runner.specs[0]?.args ?? [];
    expect(args.at(-1)).toBe(`https://www.bilibili.com/video/${BV}?p=2`);
    expect(argAfter(args, "--format")).toBe("ba/b");
    expect(args).toContain("--cookies");
  });

  it("refuses a track over maxBytes and removes it", async () => {
    const { adapter, dataDir } = setup({
      process: (spec) => {
        writeFileSync(argAfter(spec.args, "--output") as string, "abcdef");
        return { stdoutLines: ["amber-progress 6 6 NA"] };
      },
    });
    const failure = await errorOf(adapter.fetchAudio({ platformContentId: BV }, undefined, { path: `${dataDir}/a.partial` }, () => undefined, signal(), { maxBytes: 5 }));
    expect(failure.class).toBe("media_too_large");
    expect(existsSync(`${dataDir}/a.partial`)).toBe(false);
  });
});

describe("BilibiliAdapter.inspectVideo / inspectAudio", () => {
  it("inspect the part located by cid, with the login, without downloading", async () => {
    const { adapter, runner } = setup({
      process: (spec) => ({ stdoutLines: [argAfter(spec.args, "--format") === "ba/b" ? "amber-format 300" : "amber-format 2048 1080 mp4 hev1"] }),
    });
    const ref = { platformContentId: BV, platformPartId: "1002" };
    expect(await adapter.inspectVideo(ref, LOGIN, { maxHeight: 1080 }, signal())).toEqual({ hasVideo: true, mimeType: "video/mp4", sizeBytes: 2048, height: 1080 });
    expect(await adapter.inspectAudio(ref, LOGIN, signal())).toEqual({ sizeBytes: 300 });
    for (const spec of runner.specs) {
      expect(spec.args.at(-1)).toBe(`https://www.bilibili.com/video/${BV}?p=2`);
      expect(argAfter(spec.args, "--use-extractors")).toBe(BILIBILI_EXTRACTORS.join(","));
      expect(spec.args).toContain("--cookies");
      expect(spec.args).toContain("--print");
      expect(spec.args).not.toContain("--output");
    }
    expect(runner.specs).toHaveLength(2);
  });

  it("reports an audio-only part as a guest", async () => {
    const { adapter, runner } = setup({ process: () => ({ stdoutLines: ["amber-format 100 NA m4a none"] }) });
    expect(await adapter.inspectVideo({ platformContentId: BV }, undefined, { maxHeight: 720 }, signal())).toEqual({ hasVideo: false });
    expect(runner.specs[0]?.args).not.toContain("--cookies");
  });
});

describe("BilibiliAdapter.listVideoQualities", () => {
  const FORMATS = {
    formats: [
      { format_id: "30216", ext: "m4a", vcodec: "none" },
      { format_id: "30064", ext: "mp4", vcodec: "avc1.640028", height: 720, width: 1280 },
      { format_id: "30066", ext: "mp4", vcodec: "hvc1.1.6.L120.90", height: 720, width: 1280 },
    ],
  };

  it("lists the part located by cid from its metadata, with the login, without downloading", async () => {
    const { adapter, runner } = setup({ process: () => ({ stdout: JSON.stringify(FORMATS) }) });
    expect(await adapter.listVideoQualities({ platformContentId: BV, platformPartId: "1002" }, LOGIN, signal())).toEqual([{ tier: 720, width: 1280, height: 720 }]);
    expect(runner.specs).toHaveLength(1);
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(args.indexOf("--dump-single-json"))).toEqual(["--dump-single-json", "--skip-download", "--no-playlist", `https://www.bilibili.com/video/${BV}?p=2`]);
    expect(argAfter(args, "--use-extractors")).toBe(BILIBILI_EXTRACTORS.join(","));
    expect(args).toContain("--cookies");
    expect(args).not.toContain("--format");
  });

  it("lists as a guest without a login, and reports a document without a format list", async () => {
    const { adapter, runner } = setup({ process: () => ({ stdout: JSON.stringify({ id: BV }) }) });
    expect(await adapter.listVideoQualities({ platformContentId: BV }, undefined, signal())).toBeUndefined();
    expect(runner.specs[0]?.args).not.toContain("--cookies");
  });
});

describe("BilibiliAdapter.fetchVideo", () => {
  it("caches the part located by cid with the login, height-capped and merged to MP4 / WebM", async () => {
    const { adapter, runner, dataDir } = setup({
      process: (spec) => {
        if (spec.args.includes("--print")) {
          return { stdoutLines: ["amber-format 2048 720 mp4"] };
        }
        writeFileSync((argAfter(spec.args, "--output") as string).replace("%(ext)s", "mp4"), "video");
        return {};
      },
    });
    const result = await adapter.fetchVideo(
      { platformContentId: BV, platformPartId: "1002" },
      LOGIN,
      { maxHeight: 720, maxBytes: 4096, output: { path: `${dataDir}/video.partial`, scratchDir: `${dataDir}/.amber-tmp/01ASSET` } },
      () => undefined,
      signal(),
    );
    expect(result).toEqual({ sizeBytes: 5, mimeType: "video/mp4", height: 720, acquisition: "authenticated" });
    expect(readFileSync(`${dataDir}/video.partial`, "utf8")).toBe("video");
    for (const spec of runner.specs) {
      expect(spec.args.at(-1)).toBe(`https://www.bilibili.com/video/${BV}?p=2`);
      expect(argAfter(spec.args, "--format")).toMatch(/^bv\*\[height<=720\]\[ext=mp4\]\+ba\[ext=m4a\]\//);
      expect(argAfter(spec.args, "--merge-output-format")).toBe("mp4/webm");
      expect(argAfter(spec.args, "--use-extractors")).toBe(BILIBILI_EXTRACTORS.join(","));
      expect(spec.args).toContain("--cookies");
    }
    expect(runner.specs).toHaveLength(2);
  });

  it("downloads as a guest without a login and refuses an announced size over the limit", async () => {
    const { adapter, runner, dataDir } = setup({ process: () => ({ stdoutLines: ["amber-format 9999 1080 mp4"] }) });
    const failure = await errorOf(adapter.fetchVideo({ platformContentId: BV }, undefined, { maxHeight: 1080, maxBytes: 100, output: { path: `${dataDir}/v.partial`, scratchDir: `${dataDir}/.amber-tmp/01ASSET` } }, () => undefined, signal()));
    expect(failure.class).toBe("media_too_large");
    expect(runner.specs).toHaveLength(1);
    expect(runner.specs[0]?.args).not.toContain("--cookies");
  });

  it("caches exactly the stream of a tier: metadata of the part first, with the login, then the same exact selection for the check and the download", async () => {
    const formats = [
      { format_id: "30032", ext: "mp4", vcodec: "avc1.640033", width: 854, height: 274 },
      { format_id: "30033", ext: "mp4", vcodec: "hvc1.1.6.L120.90", width: 854, height: 274 },
      { format_id: "30064", ext: "mp4", vcodec: "avc1.640033", width: 1280, height: 410 },
    ];
    const { adapter, runner, dataDir } = setup({
      process: (spec) => {
        if (spec.args.includes("--dump-single-json")) {
          return { stdout: JSON.stringify({ id: BV, formats }) };
        }
        if (spec.args.includes("--print")) {
          return { stdoutLines: ["amber-format 2048 274 mp4 avc1.640033 854"] };
        }
        writeFileSync((argAfter(spec.args, "--output") as string).replace("%(ext)s", "mp4"), "video");
        return {};
      },
    });
    const result = await adapter.fetchVideo(
      { platformContentId: BV, platformPartId: "1002" },
      LOGIN,
      { tier: 480, maxBytes: 4096, output: { path: `${dataDir}/video.partial`, scratchDir: `${dataDir}/.amber-tmp/01ASSET` } },
      () => undefined,
      signal(),
    );
    expect(result).toEqual({ sizeBytes: 5, mimeType: "video/mp4", height: 274, acquisition: "authenticated" });
    expect(runner.specs).toHaveLength(3);
    const [dump, check, download] = runner.specs.map((spec) => spec.args);
    expect(dump?.slice(dump.indexOf("--dump-single-json"))).toEqual(["--dump-single-json", "--skip-download", "--no-playlist", `https://www.bilibili.com/video/${BV}?p=2`]);
    expect(argAfter(check ?? [], "--format")).toBe("30032+ba[ext=m4a]/30032+ba/30032");
    expect(argAfter(download ?? [], "--format")).toBe("30032+ba[ext=m4a]/30032+ba/30032");
    for (const spec of runner.specs) {
      expect(spec.args.at(-1)).toBe(`https://www.bilibili.com/video/${BV}?p=2`);
      expect(argAfter(spec.args, "--use-extractors")).toBe(BILIBILI_EXTRACTORS.join(","));
      expect(spec.args).toContain("--cookies");
    }
  });

  it("refuses a tier the part does not offer without downloading", async () => {
    const { adapter, runner, dataDir } = setup({ process: () => ({ stdout: JSON.stringify({ id: BV, formats: [{ format_id: "30064", ext: "mp4", vcodec: "avc1", width: 1280, height: 720 }] }) }) });
    const failure = await errorOf(adapter.fetchVideo({ platformContentId: BV }, undefined, { tier: 1080, maxBytes: 4096, output: { path: `${dataDir}/v.partial`, scratchDir: `${dataDir}/.amber-tmp/01ASSET` } }, () => undefined, signal()));
    expect(failure.code).toBe("invalid_request.cache_quality_unavailable");
    expect(runner.specs).toHaveLength(1);
    expect(runner.specs[0]?.args).not.toContain("--cookies");
  });
});
