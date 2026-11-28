import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BILIBILI_EXTRACTORS, BilibiliAdapter } from "../../../../../src/server/adapters/platform/bilibili/index.ts";
import type { PlatformDownloadRequest, PlatformMediaDownload } from "../../../../../src/server/adapters/platform/download.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { COLLECTION_PREVIEW_ITEMS_MAX, PLATFORM_COLLECTION_RESOLVE_CONCURRENCY, PLATFORM_JSON_MAX_BYTES } from "../../../../../src/shared/defaults.ts";
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

type Route = (request: OutboundRequest, url: URL) => ScriptedResponse | Error | Promise<ScriptedResponse> | undefined;

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
    // Only the status and Location matter: each hop's body is discarded unread.
    expect(http.destroyed).toEqual(["https://b23.tv/one", "https://b23.tv/two"]);
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

describe("BilibiliAdapter: API answers", () => {
  it("are checked in two layers: an error code is classified whatever data comes with it", async () => {
    const { adapter } = setup({ routes: () => ({ body: { code: -412, data: "not an object" } }) });
    expect((await errorOf(adapter.resolveParts({ platformContentId: BV }, undefined, signal()))).class).toBe("platform_blocked");
  });

  it("refuse an envelope without an integer code, and data of the wrong shape, as unreachable", async () => {
    for (const body of [{ data: [] }, { code: "0", data: [] }, { code: 0.5 }, [], { code: 0, data: [{ cid: "1001", page: 1 }] }, { code: 0, data: { cid: 1 } }]) {
      const { adapter } = setup({ routes: () => ({ body }) });
      expect((await errorOf(adapter.resolveParts({ platformContentId: BV }, undefined, signal()))).class, JSON.stringify(body)).toBe("source_unreachable");
    }
  });

  it("are read within PLATFORM_JSON_MAX_BYTES, an error status discarded unread", async () => {
    const big = setup({ routes: () => ({ body: { code: 0, data: PAGES }, headers: { "Content-Length": String(PLATFORM_JSON_MAX_BYTES + 1) } }) });
    expect((await errorOf(big.adapter.resolveParts({ platformContentId: BV }, undefined, signal()))).class).toBe("source_html_error_page");
    const refused = setup({ routes: () => ({ status: 503, body: "<html>" }) });
    expect((await errorOf(refused.adapter.resolveParts({ platformContentId: BV }, undefined, signal()))).class).toBe("source_unreachable");
    expect(refused.http.destroyed).toHaveLength(1);
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
      description: { state: "unknown" },
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

describe("BilibiliAdapter: the description", () => {
  const PLAYER_ROUTE: Route = (_, url) => (url.pathname === "/x/player/wbi/v2" ? { body: { code: 0, data: { subtitle: { subtitles: [] } } } } : undefined);

  async function metadataWith(info: Record<string, unknown>) {
    const { adapter } = setup({ routes: PLAYER_ROUTE, process: () => ({ stdout: JSON.stringify({ title: "t", duration: 60, ...info }) }) });
    return (await adapter.fetchMetadata({ platformContentId: BV, platformPartId: "1001" }, undefined, signal())).description;
  }

  it("is read from the metadata document already fetched", async () => {
    expect(await metadataWith({ description: "  第一行  \r\n第二行\n\n" })).toEqual({ state: "found", text: "  第一行\n第二行" });
    expect(await metadataWith({ description: "" })).toEqual({ state: "empty" });
    expect(await metadataWith({ description: " \n " })).toEqual({ state: "empty" });
    expect(await metadataWith({ description: "-" })).toEqual({ state: "empty" });
    expect(await metadataWith({ description: null })).toEqual({ state: "unknown" });
    expect(await metadataWith({})).toEqual({ state: "unknown" });
    expect(await metadataWith({ description: 3 })).toEqual({ state: "unknown" });
  });

  it("takes only the top-level description, never the entries' of an interactive video", async () => {
    const entries = [{ title: "node 1", description: '{"node":1} 正文' }, { title: "node 2", description: '{"node":2} 正文' }];
    expect(await metadataWith({ description: "正文", entries })).toEqual({ state: "found", text: "正文" });
    expect(await metadataWith({ entries })).toEqual({ state: "unknown" });
  });

  it("fetchDescription reads the BV URL without p= once, without subtitle lists or the web API", async () => {
    let cookies: string | undefined;
    const { adapter, runner, http } = setup({
      process: (spec) => {
        const file = argAfter(spec.args, "--cookies");
        cookies = file === undefined ? undefined : readFileSync(file, "utf8");
        return { stdout: JSON.stringify({ title: "t", description: "简介", entries: [{ description: "{} 简介" }] }) };
      },
    });
    expect(await adapter.fetchDescription({ platformContentId: BV, platformPartId: "1002" }, LOGIN, signal())).toEqual({ state: "found", text: "简介" });
    expect(runner.specs).toHaveLength(1);
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(-4)).toEqual(["--dump-single-json", "--skip-download", "--no-playlist", `https://www.bilibili.com/video/${BV}`]);
    expect(args.some((arg) => arg.includes("sub"))).toBe(false);
    expect(argAfter(args, "--use-extractors")).toBe(BILIBILI_EXTRACTORS.join(","));
    expect(cookies).toContain("session\t<placeholder>");
    expect(http.requests).toEqual([]);
  });

  it("fetchDescription classifies like the metadata and goes without cookies as a guest", async () => {
    for (const [description, expected] of [
      ["-", { state: "empty" }],
      ["", { state: "empty" }],
      [null, { state: "unknown" }],
    ] as const) {
      const { adapter, runner } = setup({ process: () => ({ stdout: JSON.stringify({ title: "t", description }) }) });
      expect(await adapter.fetchDescription({ platformContentId: BV }, undefined, signal())).toEqual(expected);
      expect(runner.specs[0]?.args).not.toContain("--cookies");
    }
  });

  it("fetchDescription maps yt-dlp failures like fetchMetadata", async () => {
    const { adapter } = setup({ process: () => ({ exitCode: 1, stderr: `ERROR: [BiliBili] ${BV}: Unable to download JSON metadata: HTTP Error 412` }) });
    expect((await errorOf(adapter.fetchDescription({ platformContentId: BV }, undefined, signal()))).class).toBe("platform_blocked");
  });

  it("refuses an id that is not a BV id without running yt-dlp", async () => {
    const { adapter, runner } = setup();
    await expect(adapter.fetchDescription({ platformContentId: "BV1/../x" }, undefined, signal())).rejects.toThrow(TypeError);
    expect(runner.specs).toEqual([]);
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

describe("BilibiliAdapter collections", () => {
  const recorded = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../../fixtures/platform/recorded/${name}`, import.meta.url), "utf8")) as T;
  const FLAT = recorded<{ playlist: { title: string; entries: Array<{ id: string; url: string }> } }>("bilibili-collection-flat.json").playlist;
  const SEASON = recorded<{ answer: { code: number; data: { archives: Array<{ bvid: string; title: string; duration: number; pic: string }>; page: { total: number } } } }>(
    "bilibili-season-archives.json",
  ).answer;
  const PAGELIST = recorded<{ answer: { code: number; data: Array<{ cid: number; page: number; part: string; duration: number }> } }>("bilibili-pagelist-single.json").answer;
  const COLLECTION = "504934876_7985436";
  const IDS = FLAT.entries.map((entry) => entry.id);
  const SEASON_PATH = "/x/polymer/web-space/seasons_archives_list";
  /** The recorded part list for the recorded submission; every other one is a single part named after its id. */
  const partsOf = (bvid: string) => (bvid === "BV1WRo9BeErN" ? PAGELIST.data : [{ cid: 7000 + IDS.indexOf(bvid), page: 1, part: `part of ${bvid}`, duration: 600 }]);

  function recordedSetup(options: { season?: (url: URL) => ScriptedResponse | Error; pages?: (bvid: string) => ScriptedResponse | Error | Promise<ScriptedResponse> } = {}) {
    return setup({
      process: () => ({ stdout: JSON.stringify(FLAT) }),
      routes: (_, url) => {
        if (url.pathname === SEASON_PATH) {
          return options.season?.(url) ?? { body: SEASON };
        }
        if (url.pathname === "/x/player/pagelist") {
          const bvid = url.searchParams.get("bvid") as string;
          return options.pages?.(bvid) ?? { body: { code: 0, data: partsOf(bvid) } };
        }
        return undefined;
      },
    });
  }

  async function listAll(adapter: BilibiliAdapter, auth = LOGIN) {
    const listing = await adapter.listCollection(COLLECTION, auth, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    return { listing, items: await adapter.resolveCollectionEntries(COLLECTION, listing.entries, auth, signal()) };
  }

  it("lists the recorded collection flat, one past the limit, with the login", async () => {
    const { adapter, runner, http } = recordedSetup();
    const listing = await adapter.listCollection(COLLECTION, LOGIN, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect(listing).toEqual({
      title: FLAT.title,
      entries: IDS.map((id, index) => ({ index, platformContentId: id, canonicalUrl: `https://www.bilibili.com/video/${id}` })),
      totalCount: IDS.length,
      truncated: false,
    });
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(-5)).toEqual(["--dump-single-json", "--flat-playlist", "--playlist-items", `1:${COLLECTION_PREVIEW_ITEMS_MAX + 1}`, "https://space.bilibili.com/504934876/lists/7985436"]);
    expect(args).toContain("--cookies");
    // Listing asks nothing per entry.
    expect(http.requests).toEqual([]);
  });

  it("resolves entries with the submission's title and cover from the season list, matched by video id, and the first part's duration", async () => {
    const { adapter, http } = recordedSetup();
    const { items } = await listAll(adapter);
    expect(items.map((item) => item.platformContentId)).toEqual(IDS);
    const [first] = items;
    expect(first).toEqual({
      platformContentId: "BV1WRo9BeErN",
      platformPartId: String(PAGELIST.data[0]?.cid),
      canonicalUrl: "https://www.bilibili.com/video/BV1WRo9BeErN",
      title: SEASON.data.archives[0]?.title,
      durationMs: (PAGELIST.data[0]?.duration ?? 0) * 1000,
      // The archive list answers http; the cover is passed on as https.
      coverUrl: SEASON.data.archives[0]?.pic.replace(/^http:/, "https:"),
      partCount: 1,
    });
    for (const [index, item] of items.entries()) {
      const archive = SEASON.data.archives.find((candidate) => candidate.bvid === item.platformContentId);
      // A single part takes the submission's own title.
      expect(item).toMatchObject({ title: archive?.title, partCount: 1, coverUrl: expect.stringMatching(/^https:\/\/i\d\.hdslb\.com\//) });
      expect(item.displayTitle).toBeUndefined();
      expect(index).toBe(IDS.indexOf(item.platformContentId));
    }
    expect(http.to(SEASON_PATH).map((request) => Object.fromEntries(new URL(request.url).searchParams))).toEqual([
      { mid: "504934876", season_id: "7985436", page_num: "1", page_size: "100" },
    ]);
    expect(http.to("/x/player/pagelist")).toHaveLength(IDS.length);
  });

  it("keeps a multi-part submission's first part title for the Content and shows the submission's; its total duration is never used", async () => {
    const { adapter } = recordedSetup({ pages: (bvid) => ({ body: { code: 0, data: bvid === IDS[1] ? PAGES : partsOf(bvid) } }) });
    const { items } = await listAll(adapter);
    const archive = SEASON.data.archives.find((candidate) => candidate.bvid === IDS[1]);
    expect(items[1]).toEqual({
      platformContentId: IDS[1],
      platformPartId: "1001",
      canonicalUrl: `https://www.bilibili.com/video/${IDS[1]}?p=1`,
      title: "Lecture 1",
      displayTitle: archive?.title,
      durationMs: 6_000_000,
      coverUrl: archive?.pic.replace(/^http:/, "https:"),
      partCount: 2,
    });
    expect(items.map((item) => item.durationMs)).not.toContain((archive?.duration ?? 0) * 1000);
  });

  it("falls back to the part titles without covers when the season list fails, answers an error code or is malformed, keeping members and order", async () => {
    for (const season of [() => ({ status: 500 }), () => ({ body: { code: -352 } }), () => ({ body: "<html>" }), () => new OutboundHttpError("before_send", "network")]) {
      const { adapter } = recordedSetup({ season });
      const { items } = await listAll(adapter);
      expect(items.map((item) => item.platformContentId)).toEqual(IDS);
      expect(items[0]).toMatchObject({ title: PAGELIST.data[0]?.part, partCount: 1 });
      expect(items.every((item) => item.coverUrl === undefined && item.displayTitle === undefined)).toBe(true);
      expect(items[2]?.title).toBe(`part of ${IDS[2]}`);
    }
  });

  it("matches a partial, reordered or foreign answer by video id only", async () => {
    const shuffled = [...SEASON.data.archives].reverse().filter((archive) => archive.bvid !== IDS[3]);
    const foreign = { bvid: "BV1aa411c7mD", title: "not in this collection", pic: "https://i0.hdslb.com/x.jpg", duration: 1 };
    const { adapter } = recordedSetup({ season: () => ({ body: { code: 0, data: { archives: [foreign, ...shuffled], page: { total: 99 } } } }) });
    const { items } = await listAll(adapter);
    expect(items.map((item) => item.platformContentId)).toEqual(IDS);
    for (const item of items) {
      const archive = SEASON.data.archives.find((candidate) => candidate.bvid === item.platformContentId);
      expect(item.title).toBe(item.platformContentId === IDS[3] ? `part of ${IDS[3]}` : archive?.title);
    }
    expect(items[3]?.coverUrl).toBeUndefined();
  });

  it("passes on covers only from bilibili's image hosts", async () => {
    const pics = ["https://evil.example/a.jpg", "https://hdslb.com.evil.example/b.jpg", "https://user:pw@i0.hdslb.com/c.jpg", "ftp://i0.hdslb.com/d.jpg", "https://archive.biliimg.com/e.jpg", "//i1.hdslb.com/f.jpg"];
    const archives = SEASON.data.archives.slice(0, pics.length).map((archive, index) => ({ ...archive, pic: pics[index] }));
    const { adapter } = recordedSetup({ season: () => ({ body: { code: 0, data: { archives } } }) });
    const { items } = await listAll(adapter);
    expect(items.slice(0, pics.length).map((item) => item.coverUrl)).toEqual([undefined, undefined, undefined, undefined, "https://archive.biliimg.com/e.jpg", "https://i1.hdslb.com/f.jpg"]);
  });

  it(`resolves parts ${PLATFORM_COLLECTION_RESOLVE_CONCURRENCY} at a time and fails as a whole when one part list fails`, async () => {
    let inFlight = 0;
    let most = 0;
    const slow = async (bvid: string): Promise<ScriptedResponse> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { body: { code: 0, data: partsOf(bvid) } };
    };
    const { adapter } = recordedSetup({ pages: slow });
    await listAll(adapter);
    expect(most).toBe(PLATFORM_COLLECTION_RESOLVE_CONCURRENCY);

    const failing = recordedSetup({ pages: (bvid) => (bvid === IDS[4] ? { body: { code: -352 } } : slow(bvid)) });
    const listing = await failing.adapter.listCollection(COLLECTION, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect((await errorOf(failing.adapter.resolveCollectionEntries(COLLECTION, listing.entries, undefined, signal()))).class).toBe("platform_blocked");
    // Nothing is left running behind the failure, and nothing starts after it.
    expect(inFlight).toBe(0);
    expect(failing.http.to("/x/player/pagelist").length).toBeLessThan(IDS.length);
  });

  it("marks a removed (-404) or closed (-403) submission unavailable without a title, duration or cover of its own, and resolves the rest", async () => {
    // Constructed answers: the recorded season list still names both submissions, which must not show.
    const { adapter } = recordedSetup({
      pages: (bvid) => (bvid === IDS[1] ? { body: { code: -404, message: "啥都木有" } } : bvid === IDS[3] ? { body: { code: -403, message: "访问权限不足" } } : { body: { code: 0, data: partsOf(bvid) } }),
    });
    const { items } = await listAll(adapter);
    expect(items.map((item) => item.platformContentId)).toEqual(IDS);
    expect(items[1]).toEqual({ platformContentId: IDS[1], canonicalUrl: `https://www.bilibili.com/video/${IDS[1]}`, unavailable: "removed" });
    expect(items[3]).toEqual({ platformContentId: IDS[3], canonicalUrl: `https://www.bilibili.com/video/${IDS[3]}`, unavailable: "private" });
    expect(items.filter((item) => item.unavailable === undefined)).toHaveLength(IDS.length - 2);
    expect(items[0]).toMatchObject({ platformPartId: String(PAGELIST.data[0]?.cid), title: SEASON.data.archives[0]?.title });
  });

  it("still fails the whole resolution on risk control, login, unknown codes, an empty part list and network errors", async () => {
    // Codes the adapter has no evidence for (62002 here) are not taken as unavailable.
    const failures: Array<[ScriptedResponse | Error, string]> = [
      [{ body: { code: -412 } }, "platform_blocked"],
      [{ status: 429 }, "platform_blocked"],
      [{ body: { code: -101 } }, "auth_required"],
      [{ body: { code: 62002 } }, "source_unreachable"],
      [{ body: { code: 0, data: [] } }, "source_unreachable"],
      [{ status: 500 }, "source_unreachable"],
      [new OutboundHttpError("before_send", "network"), "source_unreachable"],
    ];
    for (const [answer, expected] of failures) {
      const { adapter } = recordedSetup({ pages: (bvid) => (bvid === IDS[2] ? answer : { body: { code: 0, data: partsOf(bvid) } }) });
      const listing = await adapter.listCollection(COLLECTION, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
      expect((await errorOf(adapter.resolveCollectionEntries(COLLECTION, listing.entries, undefined, signal()))).class, expected).toBe(expected);
    }
  });

  it("keeps a single submission's -403 and -404 as errors outside a collection", async () => {
    for (const [code, expected] of [
      [-403, "auth_required"],
      [-404, "source_unreachable"],
    ] as const) {
      const { adapter } = setup({ routes: () => ({ body: { code } }) });
      expect((await errorOf(adapter.resolveParts({ platformContentId: BV }, undefined, signal()))).class).toBe(expected);
    }
  });

  it("resolves only the entries asked for, reading the season list pages that hold them", async () => {
    const { adapter, http } = recordedSetup();
    const entries = [
      { index: 0, platformContentId: IDS[0] as string, canonicalUrl: "x" },
      { index: 150, platformContentId: IDS[1] as string, canonicalUrl: "x" },
      { index: 199, platformContentId: IDS[2] as string, canonicalUrl: "x" },
    ];
    const items = await adapter.resolveCollectionEntries(COLLECTION, entries, undefined, signal());
    expect(items.map((item) => item.platformContentId)).toEqual(IDS.slice(0, 3));
    expect(http.to(SEASON_PATH).map((request) => new URL(request.url).searchParams.get("page_num"))).toEqual(["1", "2"]);
    expect(http.to("/x/player/pagelist").map((request) => new URL(request.url).searchParams.get("bvid"))).toEqual(IDS.slice(0, 3));
  });

  it("reports truncation past the limit with the season list's total, and leaves a series' total unknown", async () => {
    const { adapter, http } = recordedSetup();
    const listing = await adapter.listCollection(COLLECTION, undefined, signal(), 3);
    expect(listing).toMatchObject({ truncated: true, totalCount: SEASON.data.page.total });
    expect(listing.entries.map((entry) => entry.platformContentId)).toEqual(IDS.slice(0, 3));
    expect(http.to(SEASON_PATH)).toHaveLength(1);

    const failing = recordedSetup({ season: () => ({ status: 500 }) });
    const unknown = await failing.adapter.listCollection(COLLECTION, undefined, signal(), 3);
    expect(unknown.truncated).toBe(true);
    expect(unknown.totalCount).toBeUndefined();

    const series = recordedSetup();
    const listed = await series.adapter.listCollection("504934876_series_7985436", undefined, signal(), 3);
    expect(listed).toMatchObject({ truncated: true });
    expect(listed.totalCount).toBeUndefined();
    expect(series.runner.specs[0]?.args.at(-1)).toBe("https://space.bilibili.com/504934876/lists/7985436?type=series");
    await series.adapter.resolveCollectionEntries("504934876_series_7985436", listed.entries, undefined, signal());
    expect(series.http.to(SEASON_PATH)).toEqual([]);
  });

  it("skips entries without a usable id and repeats, uses the id as a fallback title, and refuses ids it does not issue", async () => {
    const { adapter } = setup({
      process: () => ({ stdout: JSON.stringify({ entries: [{ url: `https://www.bilibili.com/video/${BV}` }, { id: "BV1aa411c7mD" }, { title: "no id" }, { id: "../x" }, { id: BV }] }) }),
    });
    const listing = await adapter.listCollection("1_series_2", undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect(listing).toEqual({
      title: "1_series_2",
      entries: [
        { index: 0, platformContentId: BV, canonicalUrl: `https://www.bilibili.com/video/${BV}` },
        { index: 1, platformContentId: "BV1aa411c7mD", canonicalUrl: "https://www.bilibili.com/video/BV1aa411c7mD" },
      ],
      totalCount: 2,
      truncated: false,
    });
    await expect(adapter.listCollection("PLabc", undefined, signal(), 1)).rejects.toBeInstanceOf(TypeError);
    await expect(adapter.resolveCollectionEntries("PLabc", [], undefined, signal())).rejects.toBeInstanceOf(TypeError);
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

describe("BilibiliAdapter.fetchCover", () => {
  it("downloads only from bilibili's image hosts, upgrading a plain-http cover, without the login", async () => {
    const { ytDlp } = scriptedYtDlp();
    const http = new ScriptedHttp();
    const requests: PlatformDownloadRequest[] = [];
    const download: PlatformMediaDownload = async (_http, request) => {
      requests.push(request);
      return { sizeBytes: 7, mimeType: "image/jpeg" };
    };
    const adapter = new BilibiliAdapter({ ytDlp, http, download });
    const output = { path: "/data/tmp/figures/job/input" };
    expect(await adapter.fetchCover("http://i0.hdslb.com/bfs/archive/a.jpg", output, { maxBytes: 99 }, signal())).toEqual({ sizeBytes: 7 });
    await adapter.fetchCover("https://archive.biliimg.com/bfs/b.png", output, { maxBytes: 99 }, signal());
    expect(requests.map((request) => [request.url, request.kind, request.maxBytes, request.allowedHosts])).toEqual([
      ["https://i0.hdslb.com/bfs/archive/a.jpg", "image", 99, ["hdslb.com", "biliimg.com"]],
      ["https://archive.biliimg.com/bfs/b.png", "image", 99, ["hdslb.com", "biliimg.com"]],
    ]);
    expect(requests.every((request) => !JSON.stringify(request.headers ?? {}).toLowerCase().includes("cookie"))).toBe(true);
    for (const foreign of ["https://i.ytimg.com/vi/x/hq.jpg", "https://www.bilibili.com/cover.jpg", "https://hdslb.com.evil.example/a.jpg"]) {
      const error = await adapter.fetchCover(foreign, output, { maxBytes: 99 }, signal()).catch((caught: unknown) => caught);
      expect([foreign, isAmberError(error)]).toEqual([foreign, true]);
    }
    expect(requests).toHaveLength(2);
    expect(http.requests).toEqual([]);
  });
});
