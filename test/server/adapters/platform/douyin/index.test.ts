import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DouyinAdapter } from "../../../../../src/server/adapters/platform/douyin/index.ts";
import type { PlatformDownloadRequest, PlatformMediaDownload } from "../../../../../src/server/adapters/platform/download.ts";
import { amberError, isAmberError } from "../../../../../src/server/domain/errors.ts";
import { OutboundHttpError } from "../../../../../src/server/ports/outbound-http.ts";
import { COLLECTION_PREVIEW_ITEMS_MAX, DOUYIN_BLOCK_COOLDOWN_MS, PLATFORM_JSON_MAX_BYTES } from "../../../../../src/shared/defaults.ts";
import { apiParams, fakeDouyin, mixPage, videoDetail, type FakeDouyin } from "../../../../fixtures/platform/douyin/fake-platform.ts";
import { signal } from "../../../../fixtures/platform/scripted-io.ts";

const ID = "7900000000000000001";
const REF = { platformContentId: ID };
const MIX = "douyin:7900000000000000100";
const API_HOSTS = new Set(["www.douyin.com", "v.douyin.com", "www.iesdouyin.com"]);
/** The adapter's own proxy table, which every request and download must carry. */
const TRUSTED = ["douyin.com", "iesdouyin.com", "douyinvod.com", "zjcdn.com", "douyinpic.com"];

type DownloadOutcome = { sizeBytes: number; mimeType: string } | Error;

interface Setup {
  adapter: DouyinAdapter;
  fake: FakeDouyin;
  downloads: Array<Omit<PlatformDownloadRequest, "signal" | "onProgress">>;
  /** Decides each download by its URL; succeeds with the declared size by default. */
  outcome: (request: PlatformDownloadRequest) => DownloadOutcome;
  advance: (ms: number) => void;
}

const created: FakeDouyin[] = [];
const setups: Setup[] = [];

afterEach(() => {
  // Every request any adapter test made went to the platform's own hosts, over https, public only.
  for (const fake of created.splice(0)) {
    for (const request of fake.http.requests) {
      const url = new URL(request.url);
      expect(url.protocol).toBe("https:");
      expect(API_HOSTS.has(url.hostname), url.hostname).toBe(true);
      expect(request.publicOnly).toBe(true);
      expect(request.redirect).toBe("manual");
      expect(request.trustedHosts).toEqual(TRUSTED);
    }
  }
  // Every media and cover download carries the same table, and it is the adapter's own.
  for (const state of setups.splice(0)) {
    expect(state.adapter.trustedHosts).toEqual(TRUSTED);
    for (const download of state.downloads) {
      expect(download.trustedHosts).toEqual(TRUSTED);
    }
  }
});

function setup(): Setup {
  const fake = fakeDouyin();
  created.push(fake);
  let now = 1_800_000_000_000;
  const state: Setup = {
    fake,
    downloads: [],
    outcome: (request) => ({ sizeBytes: request.expectedBytes ?? 1234, mimeType: request.kind === "audio" ? "audio/mp4" : request.kind === "image" ? "image/jpeg" : "video/mp4" }),
    advance: (ms) => {
      now += ms;
    },
    adapter: undefined as unknown as DouyinAdapter,
  };
  const download: PlatformMediaDownload = async (_http, request) => {
    const { signal: _signal, onProgress, ...rest } = request;
    state.downloads.push(rest);
    onProgress?.(1, 2);
    const answer = state.outcome(request);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  state.adapter = new DouyinAdapter({ http: fake.http, download, now: () => now });
  setups.push(state);
  return state;
}

async function failureOf(promise: Promise<unknown>): Promise<{ code: string; error: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return { code: error.appError.code, error };
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  return (await failureOf(promise)).code;
}

function detailWith(change: (detail: Record<string, unknown>, video: Record<string, unknown>) => void) {
  const body = videoDetail();
  const detail = body.aweme_detail as Record<string, unknown>;
  change(detail, detail["video"] as Record<string, unknown>);
  return body;
}

const imagePost = () =>
  detailWith((detail, video) => {
    detail["images"] = [{ url_list: ["https://p3-pc-sign.douyinpic.com/TESTONLY/image.jpeg?x-signature=<signature>"] }];
    video["bit_rate"] = [];
    video["bit_rate_audio"] = [];
  });

const scratch = () => mkdtempSync(join(tmpdir(), "amber-douyin-test-"));

describe("precheck", () => {
  it("reports a video with its metadata and the collection it belongs to", async () => {
    const { adapter, fake } = setup();
    const check = await adapter.precheck(REF, undefined, signal());
    expect(check).toMatchObject({
      result: "video",
      metadata: { title: "《守灯人：在礁石上住了三十年》", durationMs: 190800 },
      relatedCollection: {
        platformCollectionId: MIX,
        title: "灯塔守望录",
        itemCount: 4,
        index: 1,
        canonicalUrl: "https://www.douyin.com/collection/7900000000000000100",
      },
    });
    expect(fake.api("detail")).toHaveLength(1);
    expect(apiParams(fake.api("detail")[0]!)).toEqual({ aweme_id: ID, aid: "6383" });
  });

  it("has no related collection for a video outside any collection", async () => {
    const { adapter, fake } = setup();
    fake.detail = () => ({ body: detailWith((detail) => (detail["mix_info"] = null)) });
    const check = await adapter.precheck(REF, undefined, signal());
    expect(check.result).toBe("video");
    expect(check).not.toHaveProperty("relatedCollection");
  });

  it("rejects an image post as not a video", async () => {
    const { adapter, fake } = setup();
    fake.detail = () => ({ body: imagePost() });
    expect(await adapter.precheck(REF, undefined, signal())).toEqual({ result: "rejected", reason: "not_video" });
  });

  it("cannot tell for a filtered answer, risk control, transport failures and unreadable answers", async () => {
    const answers = [
      () => ({ body: { aweme_detail: null, filter_detail: { aweme_id: ID, filter_reason: "core_dep" }, status_code: 0 } }),
      () => ({ status: 412 }),
      () => ({ status: 429 }),
      () => ({ status: 500, body: "{}" }),
      () => ({ status: 200, body: "" }),
      () => ({ status: 200, body: "<html>verify</html>" }),
      () => new OutboundHttpError("before_send", "network"),
    ];
    for (const answer of answers) {
      const { adapter, fake } = setup();
      fake.detail = answer as FakeDouyin["detail"];
      expect(await adapter.precheck(REF, undefined, signal())).toEqual({ result: "unverified" });
    }
  });

  it("throws a refused signature and the cooldown after it instead of reporting unverified", async () => {
    const { adapter, fake, advance } = setup();
    fake.refuseAll = true;
    expect(await codeOf(adapter.precheck(REF, undefined, signal()))).toBe("platform_blocked.access_changed");
    const sent = fake.http.requests.length;
    advance(DOUYIN_BLOCK_COOLDOWN_MS / 2);
    expect(await codeOf(adapter.precheck(REF, undefined, signal()))).toBe("platform_blocked.access_changed");
    expect(fake.http.requests).toHaveLength(sent);
  });

  it("lets a cancellation through", async () => {
    const { adapter, fake } = setup();
    const controller = new AbortController();
    fake.detail = () => {
      controller.abort();
      return new OutboundHttpError("after_send", "aborted");
    };
    await expect(adapter.precheck(REF, undefined, controller.signal)).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("related collection of a video already in the library", () => {
  it("names the collection from one detail read, the same source as the import check", async () => {
    const { adapter, fake } = setup();
    const check = await adapter.precheck(REF, undefined, signal());
    const related = await adapter.findRelatedCollection(REF, undefined, signal());
    expect(related).toEqual({
      platformCollectionId: MIX,
      title: "灯塔守望录",
      itemCount: 4,
      index: 1,
      canonicalUrl: "https://www.douyin.com/collection/7900000000000000100",
    });
    expect(check.result === "video" ? check.relatedCollection : undefined).toEqual(related);
    expect(fake.api("detail")).toHaveLength(2);
    expect(apiParams(fake.api("detail")[1]!)).toEqual(apiParams(fake.api("detail")[0]!));
  });

  it("names nothing outside a collection, for an image post, a filtered answer or any failure", async () => {
    const answers: Array<FakeDouyin["detail"]> = [
      () => ({ body: detailWith((detail) => (detail["mix_info"] = null)) }),
      () => ({ body: imagePost() }),
      () => ({ body: { aweme_detail: null, filter_detail: { aweme_id: ID, filter_reason: "core_dep" }, status_code: 0 } }),
      () => ({ status: 429 }),
      () => ({ status: 200, body: "<html>verify</html>" }),
      () => new OutboundHttpError("before_send", "network"),
    ];
    for (const answer of answers) {
      const { adapter, fake } = setup();
      fake.detail = answer;
      expect(await adapter.findRelatedCollection(REF, undefined, signal())).toBeUndefined();
    }
    const refused = setup();
    refused.fake.refuseAll = true;
    expect(await refused.adapter.findRelatedCollection(REF, undefined, signal())).toBeUndefined();
  });

  it("lets a cancellation through", async () => {
    const { adapter, fake } = setup();
    const controller = new AbortController();
    fake.detail = () => {
      controller.abort();
      return new OutboundHttpError("after_send", "aborted");
    };
    await expect(adapter.findRelatedCollection(REF, undefined, controller.signal)).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("refreshed cover link", () => {
  it("reads the current cover on the image hosts from a fresh detail read", async () => {
    const { adapter, fake } = setup();
    expect(await adapter.refreshCoverUrl(REF, undefined, signal())).toBe("https://p3-pc-sign.douyinpic.com/TESTONLY/cover-0.jpeg?x-expires=<expires>&x-signature=<signature>");
    expect(fake.api("detail")).toHaveLength(1);
  });

  it("names no cover when the detail offers none on the image hosts", async () => {
    const { adapter, fake } = setup();
    fake.detail = () => ({
      body: detailWith((_detail, video) => {
        video["cover"] = { url_list: ["https://evil.example/cover.jpeg"] };
        video["origin_cover"] = null;
      }),
    });
    expect(await adapter.refreshCoverUrl(REF, undefined, signal())).toBeUndefined();
  });

  it("fails like fetchMetadata: hidden, not a video, refused", async () => {
    const hidden = setup();
    hidden.fake.detail = () => ({ body: { aweme_detail: null, filter_detail: { aweme_id: ID, filter_reason: "core_dep" }, status_code: 0 } });
    expect(await codeOf(hidden.adapter.refreshCoverUrl(REF, undefined, signal()))).toBe("source_unreachable");
    const image = setup();
    image.fake.detail = () => ({ body: imagePost() });
    expect(await codeOf(image.adapter.refreshCoverUrl(REF, undefined, signal()))).toBe("invalid_request.not_video");
    const limited = setup();
    limited.fake.detail = () => ({ status: 429 });
    expect(await codeOf(limited.adapter.refreshCoverUrl(REF, undefined, signal()))).toBe("platform_blocked.visitor_refused");
  });
});

describe("metadata and description", () => {
  it("reads metadata and the description each in one detail request of the same kind", async () => {
    const { adapter, fake } = setup();
    const metadata = await adapter.fetchMetadata(REF, undefined, signal());
    expect(fake.api("detail")).toHaveLength(1);
    const description = await adapter.fetchDescription(REF, undefined, signal());
    expect(fake.api("detail")).toHaveLength(2);
    expect(apiParams(fake.api("detail")[1]!)).toEqual(apiParams(fake.api("detail")[0]!));
    expect(description).toEqual(metadata.description);
    expect(metadata.subtitleTracks).toEqual([]);
    expect(metadata.chapters).toHaveLength(6);
  });

  it("maps every failure shape of the platform to its error, one fixture per row", async () => {
    const rows: Array<[string, FakeDouyin["detail"] | "refuse", string]> = [
      ["signature refused after a rebuild", "refuse", "platform_blocked.access_changed"],
      ["200 with an empty, filtered detail", () => ({ body: { aweme_detail: null, filter_detail: { filter_reason: "core_dep" }, status_code: 0 } }), "source_unreachable"],
      ["412", () => ({ status: 412 }), "platform_blocked.visitor_refused"],
      ["429", () => ({ status: 429 }), "platform_blocked.visitor_refused"],
      ["no playable video stream", () => ({ body: imagePost() }), "invalid_request.not_video"],
      ["empty answer", () => ({ status: 200, body: "" }), "source_unreachable"],
      ["not JSON", () => ({ status: 200, body: "<html>verify</html>" }), "source_unreachable"],
      ["other 4xx", () => ({ status: 404, body: "{}" }), "source_unreachable"],
      ["403 without a signature refusal", () => ({ status: 403, body: "Forbidden" }), "source_unreachable"],
      ["5xx", () => ({ status: 502, body: "{}" }), "source_unreachable"],
      ["a used field of the wrong type", () => ({ body: detailWith((detail) => (detail["desc"] = 42)) }), "source_unreachable"],
      ["an answer over the JSON cap", () => ({ body: "x".repeat(PLATFORM_JSON_MAX_BYTES + 1) }), "source_html_error_page"],
    ];
    for (const [name, answer, code] of rows) {
      const { adapter, fake } = setup();
      if (answer === "refuse") {
        fake.refuseAll = true;
      } else {
        fake.detail = answer;
      }
      expect(await codeOf(adapter.fetchMetadata(REF, undefined, signal())), name).toBe(code);
    }
    const unreachable = await failureOf(setup().adapter.fetchMetadata({ platformContentId: "12" }, undefined, signal()));
    expect(unreachable.code).toBe("source_unsupported_url");
  });

  it("has no platform subtitles", async () => {
    const { adapter } = setup();
    await expect(adapter.fetchSubtitle(REF, { locator: "x", language: "zh", autoGenerated: false, translated: false }, undefined, signal())).rejects.toThrow();
  });
});

/** A collection entry like the recorded ones, under a new id and episode. */
function entry(id: string, episode: number, total: number): Record<string, unknown> {
  const item = structuredClone(mixPage().aweme_list[0]) as Record<string, unknown>;
  item["aweme_id"] = id;
  item["item_title"] = `第${episode}集`;
  item["mix_info"] = { mix_id: "7900000000000000100", mix_name: "灯塔守望录", statis: { current_episode: episode, updated_to_episode: total } };
  return item;
}

function idOf(n: number): string {
  return `78000000000000${String(n).padStart(5, "0")}`;
}

/** Pages of `size` synthetic entries over `total` entries; the cursor is the next offset. */
function paged(total: number, size: number, reported = total): FakeDouyin["mix"] {
  return (cursor) => {
    const entries = [];
    for (let n = cursor; n < Math.min(total, cursor + size); n++) {
      entries.push(entry(idOf(n), n + 1, reported));
    }
    const next = cursor + entries.length;
    return { body: { aweme_list: entries, cursor: next, has_more: next < total ? 1 : 0, status_code: 0 } };
  };
}

describe("collections", () => {
  it("lists the recorded collection in one request with titles, durations and covers", async () => {
    const { adapter, fake } = setup();
    const listing = await adapter.listCollection(MIX, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect(fake.api("mix")).toHaveLength(1);
    expect(apiParams(fake.api("mix")[0]!)).toMatchObject({ mix_id: "7900000000000000100", cursor: "0", aid: "6383" });
    expect(listing).toMatchObject({ title: "灯塔守望录", totalCount: 4, truncated: false });
    expect(listing.entries.map((item) => [item.index, item.platformContentId, item.title, item.durationMs])).toEqual([
      [0, "7900000000000000001", "《守灯人：在礁石上住了三十年》", 190800],
      [1, "7900000000000000002", "《造船匠：一条没下水的船》", 200867],
      [2, "7900000000000000003", "《渡口邮差：信比人先到岸》", 200867],
      [3, "7900000000000000004", "《雾港医生：每个夜里都有人敲门》", 215967],
    ]);
    for (const item of listing.entries) {
      expect(item.canonicalUrl).toBe(`https://www.douyin.com/video/${item.platformContentId}`);
      expect(item.coverUrl).toMatch(/^https:\/\/[a-z0-9-]+\.douyinpic\.com\//);
      expect(item).not.toHaveProperty("unavailable");
    }
  });

  it("reads page after page until the platform has no more, in the platform's order", async () => {
    const { adapter, fake } = setup();
    fake.mix = paged(20, 10);
    const listing = await adapter.listCollection(MIX, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect(listing.entries.map((item) => item.platformContentId)).toEqual(Array.from({ length: 20 }, (_, n) => idOf(n)));
    expect(listing).toMatchObject({ totalCount: 20, truncated: false });
    expect(fake.api("mix").map((request) => apiParams(request)["cursor"])).toEqual(["0", "10"]);
  });

  it("stops once the limit is filled and reports the platform's total", async () => {
    const { adapter, fake } = setup();
    fake.mix = paged(40, 10);
    const listing = await adapter.listCollection(MIX, undefined, signal(), 15);
    expect(listing.entries).toHaveLength(15);
    expect(listing).toMatchObject({ truncated: true, totalCount: 40 });
    expect(fake.api("mix")).toHaveLength(2);
  });

  it("counts what was actually listed when the platform's total disagrees", async () => {
    const { adapter, fake } = setup();
    fake.mix = paged(4, 10, 99);
    expect(await adapter.listCollection(MIX, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX)).toMatchObject({ totalCount: 4, truncated: false });
  });

  it("stops when the cursor does not move", async () => {
    const { adapter, fake } = setup();
    fake.mix = (cursor) => ({ body: { aweme_list: [entry(idOf(cursor), cursor + 1, 50)], cursor: cursor === 0 ? 5 : 5, has_more: 1, status_code: 0 } });
    const listing = await adapter.listCollection(MIX, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect(fake.api("mix")).toHaveLength(2);
    expect(listing.entries.map((item) => item.platformContentId)).toEqual([idOf(0), idOf(5)]);
  });

  it("drops repeated entries by video id and never reads more pages than the item cap allows", async () => {
    const { adapter, fake } = setup();
    // Every page repeats the same entries while claiming there is more.
    fake.mix = (cursor) => ({ body: { aweme_list: [entry(idOf(1), 1, 3), entry(idOf(2), 2, 3), entry(idOf(1), 1, 3)], cursor: cursor + 3, has_more: 1, status_code: 0 } });
    const listing = await adapter.listCollection(MIX, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect(listing.entries.map((item) => item.platformContentId)).toEqual([idOf(1), idOf(2)]);
    const pageSize = Number(apiParams(fake.api("mix")[0]!)["count"]);
    expect(fake.api("mix").length).toBeLessThanOrEqual(Math.ceil(COLLECTION_PREVIEW_ITEMS_MAX / pageSize));
    expect(listing.truncated).toBe(true);
  });

  it("marks only the entries that cannot be imported: image posts, removed, private and unreadable ones", async () => {
    const { adapter, fake } = setup();
    fake.mix = () => {
      const page = mixPage();
      const [first, second, third, fourth] = page.aweme_list as Array<Record<string, unknown>>;
      (second!["video"] as Record<string, unknown>)["bit_rate"] = [];
      second!["images"] = [{ url_list: [] }];
      third!["status"] = { is_delete: true };
      fourth!["status"] = { private_status: 1 };
      page.aweme_list = [first!, second!, third!, fourth!, { aweme_id: idOf(9), video: "broken" }];
      return { body: page };
    };
    const listing = await adapter.listCollection(MIX, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
    expect(listing.entries.map((item) => item.unavailable)).toEqual([undefined, "not_video", "removed", "private", "unknown"]);
    expect(listing.entries[1]?.title).toBe("《造船匠：一条没下水的船》");
    // What cannot be read shows neither a title nor a duration.
    expect(listing.entries[2]).not.toHaveProperty("title");
    expect(listing.entries[2]).not.toHaveProperty("durationMs");

    const before = fake.http.requests.length;
    const items = await adapter.resolveCollectionEntries(MIX, listing.entries, undefined, signal());
    expect(fake.http.requests).toHaveLength(before);
    expect(items[0]).toMatchObject({ platformContentId: listing.entries[0]?.platformContentId, title: listing.entries[0]?.title, durationMs: 190800 });
    expect(items[0]?.coverUrl).toBe(listing.entries[0]?.coverUrl);
    expect(items.map((item) => item.unavailable)).toEqual([undefined, "not_video", "removed", "private", "unknown"]);
    expect(items[0]).not.toHaveProperty("index");
  });

  it("maps collection failures like detail failures", async () => {
    for (const [answer, code] of [
      [() => ({ status: 429 }), "platform_blocked.visitor_refused"],
      [() => ({ status: 200, body: "" }), "source_unreachable"],
      [() => ({ body: { aweme_list: null, cursor: 0, has_more: 0, status_code: 0 } }), "source_unreachable"],
    ] as const) {
      const { adapter, fake } = setup();
      fake.mix = answer as FakeDouyin["mix"];
      expect(await codeOf(adapter.listCollection(MIX, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX))).toBe(code);
    }
    expect(await codeOf(setup().adapter.listCollection("7900000000000000100", undefined, signal(), 10))).toBe("source_unsupported_url");
  });
});

describe("media", () => {
  it("downloads the separate sound stream from the CDN without cookies, the detail read again first", async () => {
    const { adapter, fake, downloads } = setup();
    const dir = scratch();
    const progress: number[] = [];
    const result = await adapter.fetchAudio(REF, undefined, { path: join(dir, "audio.part") }, (value) => progress.push(value), signal(), { maxBytes: 5_000_000 });
    expect(result).toEqual({ sizeBytes: 1112927 });
    expect(fake.api("detail")).toHaveLength(1);
    expect(downloads).toHaveLength(1);
    const [request] = downloads;
    expect(request).toMatchObject({ kind: "audio", expectedBytes: 1112927, maxBytes: 5_000_000, headers: { Referer: "https://www.douyin.com/" } });
    expect(request?.url).toMatch(/^https:\/\/v95-web-sz\.douyinvod\.com\/TESTONLY\/audio\//);
    expect(request?.allowedHosts).toEqual(["douyinvod.com", "zjcdn.com", "douyin.com"]);
    expect(Object.keys(request?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(request?.output.path).toBe(join(dir, "audio.part"));
    expect(progress).toEqual([0.5]);
    // The adapter's own scratch directory is gone afterwards.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("falls back to the smallest combined stream when there is no separate sound", async () => {
    const { adapter, fake, downloads } = setup();
    fake.detail = () => ({ body: detailWith((_detail, video) => (video["bit_rate_audio"] = null)) });
    await adapter.fetchAudio(REF, undefined, { path: join(scratch(), "audio.part") }, () => {}, signal());
    expect(downloads[0]).toMatchObject({ kind: "video", expectedBytes: 26911981 });
    expect(downloads[0]?.url).toContain("/lower_540_0-mp4/");
    expect(await adapter.inspectAudio(REF, undefined, signal())).toEqual({ sizeBytes: 26911981 });
  });

  it("tries the next address after a failure, but not after a size or disk failure", async () => {
    const state = setup();
    state.outcome = (request) => (request.url.includes("v95-web-sz") ? amberError("source_unreachable", "stalled") : { sizeBytes: 7, mimeType: "audio/mp4" });
    await state.adapter.fetchAudio(REF, undefined, { path: join(scratch(), "a") }, () => {}, signal());
    expect(state.downloads.map((request) => new URL(request.url).hostname)).toEqual(["v95-web-sz.douyinvod.com", "v11-weba.douyinvod.com"]);

    for (const final of [amberError("media_too_large", "too large"), amberError("disk_low", "full")]) {
      const again = setup();
      again.outcome = () => final;
      expect(await codeOf(again.adapter.fetchAudio(REF, undefined, { path: join(scratch(), "a") }, () => {}, signal()))).toBe(final.appError.code);
      expect(again.downloads).toHaveLength(1);
    }
  });

  it("skips addresses off the media hosts and fails when none is left", async () => {
    const { adapter, fake, downloads } = setup();
    fake.detail = () => ({
      body: detailWith((_detail, video) => {
        video["bit_rate_audio"] = [{ audio_meta: { size: 10, bitrate: 1, url_list: { main_url: "https://cdn.example.com/a", backup_url: "http://v1.douyinvod.com/a", fallback_url: "https://evildouyinvod.com/a" } } }];
      }),
    });
    expect(await codeOf(adapter.fetchAudio(REF, undefined, { path: join(scratch(), "a") }, () => {}, signal()))).toBe("source_unreachable");
    expect(downloads).toHaveLength(0);
  });

  it("lists combined H.264 MP4 tiers and downloads exactly the chosen one", async () => {
    const { adapter, fake, downloads } = setup();
    expect(await adapter.listVideoQualities(REF, undefined, signal())).toEqual([
      { tier: 720, width: 1280, height: 720 },
      { tier: 1080, width: 1920, height: 1080 },
    ]);
    expect(await adapter.inspectVideo(REF, undefined, { tier: 1080 }, signal())).toEqual({ hasVideo: true, mimeType: "video/mp4", sizeBytes: 50569864, height: 1080, width: 1920 });
    const dir = scratch();
    const result = await adapter.fetchVideo(REF, undefined, { tier: 1080, maxBytes: 60_000_000, output: { path: join(dir, "v.mp4"), scratchDir: dir } }, () => {}, signal());
    expect(result).toEqual({ sizeBytes: 50569864, mimeType: "video/mp4", height: 1080, acquisition: "guest" });
    expect(downloads[0]).toMatchObject({ kind: "video", expectedBytes: 50569864, maxBytes: 60_000_000, output: { path: join(dir, "v.mp4"), scratchDir: dir } });
    expect(downloads[0]?.url).toContain("/normal_1080_0-mp4/");
    // Each call read the detail again.
    expect(fake.api("detail")).toHaveLength(3);
  });

  it("refuses a tier the video no longer offers instead of taking another", async () => {
    const { adapter, downloads } = setup();
    const dir = scratch();
    expect(await codeOf(adapter.fetchVideo(REF, undefined, { tier: 1440, maxBytes: 1, output: { path: join(dir, "v.mp4"), scratchDir: dir } }, () => {}, signal()))).toBe(
      "invalid_request.cache_quality_unavailable",
    );
    expect(await codeOf(adapter.inspectVideo(REF, undefined, { tier: 480 }, signal()))).toBe("invalid_request.cache_quality_unavailable");
    expect(downloads).toHaveLength(0);
  });

  it("takes the best tier within a height cap", async () => {
    const { adapter } = setup();
    expect(await adapter.inspectVideo(REF, undefined, { maxHeight: 720 }, signal())).toMatchObject({ height: 720 });
  });

  it("refuses media of an image post as not a video", async () => {
    const { adapter, fake, downloads } = setup();
    fake.detail = () => ({ body: imagePost() });
    expect(await codeOf(adapter.fetchAudio(REF, undefined, { path: join(scratch(), "a") }, () => {}, signal()))).toBe("invalid_request.not_video");
    expect(await codeOf(adapter.listVideoQualities(REF, undefined, signal()))).toBe("invalid_request.not_video");
    expect(downloads).toHaveLength(0);
  });

  it("never runs yt-dlp", () => {
    const source = readFileSync(new URL("../../../../../src/server/adapters/platform/douyin/index.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import [^;]* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports.filter((path) => /yt-dlp|process-runner/.test(path ?? ""))).toEqual([]);
    expect(source).not.toMatch(/ytDlp|ProcessRunner/);
  });
});

describe("covers", () => {
  it("downloads an https cover on the platform's image hosts without any cookie", async () => {
    const { adapter, fake, downloads } = setup();
    const dir = scratch();
    const url = "https://p3-pc-sign.douyinpic.com/TESTONLY/cover.jpeg?x-expires=<expires>&x-signature=<signature>";
    expect(await adapter.fetchCover(url, { path: join(dir, "cover") }, { maxBytes: 1000 }, signal())).toEqual({ sizeBytes: 1234 });
    expect(downloads).toEqual([
      { url, allowedHosts: ["douyinpic.com"], trustedHosts: TRUSTED, kind: "image", maxBytes: 1000, output: { path: join(dir, "cover"), scratchDir: expect.any(String) } },
    ]);
    expect(fake.http.requests).toHaveLength(0);
    expect(existsSync(downloads[0]!.output.scratchDir)).toBe(false);
  });

  it("refuses any other address before a request", async () => {
    for (const url of [
      "http://p3-pc-sign.douyinpic.com/a.jpeg",
      "https://evildouyinpic.com/a.jpeg",
      "https://p3.douyinpic.com:8443/a.jpeg",
      "https://user:pw@p3.douyinpic.com/a.jpeg",
      "https://v95-web-sz.douyinvod.com/a.jpeg",
      "https://example.com/a.jpeg",
    ]) {
      const { adapter, fake, downloads } = setup();
      expect(await codeOf(adapter.fetchCover(url, { path: join(scratch(), "cover") }, { maxBytes: 1000 }, signal())), url).toBe("source_unreachable");
      expect(downloads).toHaveLength(0);
      expect(fake.http.requests).toHaveLength(0);
    }
  });
});

describe("short links", () => {
  it("follows a short link hop by hop to the video it names", async () => {
    const { adapter, fake } = setup();
    fake.shortLink = () => ({ status: 302, headers: { Location: `https://www.iesdouyin.com/share/video/${ID}/?region=CN&mid=1` } });
    expect(await adapter.resolveUrl("https://v.douyin.com/TESTabc/ 复制此链接", signal())).toBeNull();
    expect(await adapter.resolveUrl("http://v.douyin.com/TESTabc", signal())).toBe(`https://www.douyin.com/video/${ID}`);
    expect(fake.http.requests.map((request) => request.url)).toEqual(["https://v.douyin.com/TESTabc/"]);
  });

  it("stops at a hop off the platform's hosts without requesting it", async () => {
    const { adapter, fake } = setup();
    fake.shortLink = () => ({ status: 302, headers: { Location: "https://evil.example/landing" } });
    expect(await adapter.resolveUrl("https://v.douyin.com/TESTabc/", signal())).toBeNull();
    expect(fake.http.requests).toHaveLength(1);
  });

  it("is not a short link: no request", async () => {
    const { adapter, fake } = setup();
    expect(await adapter.resolveUrl(`https://www.douyin.com/video/${ID}`, signal())).toBeNull();
    expect(fake.http.requests).toHaveLength(0);
  });
});

describe("secrets stay out of errors and logs", () => {
  it("never repeats session values, signatures or signed media parameters", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const errors: unknown[] = [];
      const collect = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (error) {
          errors.push(error);
        }
      };
      const ok = setup();
      await ok.adapter.precheck(REF, undefined, signal());
      await ok.adapter.fetchMetadata(REF, undefined, signal());
      ok.outcome = () => amberError("source_unreachable", "failed");
      await collect(ok.adapter.fetchAudio(REF, undefined, { path: join(scratch(), "a") }, () => {}, signal()));
      await collect(ok.adapter.fetchCover("https://p3.douyinpic.com/a.jpeg?x-signature=TESTONLY_sig", { path: join(scratch(), "c") }, { maxBytes: 1 }, signal()));
      ok.fake.refuseAll = true;
      await collect(ok.adapter.fetchMetadata(REF, undefined, signal()));
      await collect(ok.adapter.precheck(REF, undefined, signal()));
      const refused = setup();
      refused.fake.detail = () => ({ status: 429 });
      await collect(refused.adapter.fetchMetadata(REF, undefined, signal()));

      expect(errors.length).toBeGreaterThan(0);
      const text = JSON.stringify(
        errors.map((error) => ({ message: (error as Error).message, appError: isAmberError(error) ? error.appError : undefined })),
      );
      const values = [...ok.fake.handedOut, ...refused.fake.handedOut, "TESTONLY_sig", "<sign>", "<request>"];
      for (const value of values) {
        expect(text).not.toContain(value);
      }
      expect(text).not.toMatch(/x-secsdk-web-signature|uifid|passport_csrf_token|ttwid|[?&]sign=/i);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
