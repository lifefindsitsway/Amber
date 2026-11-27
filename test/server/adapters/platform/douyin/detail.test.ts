import { describe, expect, it } from "vitest";
import {
  audioStreams,
  combinedH264Streams,
  isPlayableVideo,
  metadataOf,
  parseJsonBody,
  qualitiesOf,
  readDetailResponse,
  readMixPage,
  relatedCollectionOf,
  smallestCombined,
  streamFor,
  titleOf,
  type DouyinDetail,
} from "../../../../../src/server/adapters/platform/douyin/detail.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { PLATFORM_TITLE_MAX_CHARS } from "../../../../../src/shared/defaults.ts";
import { douyinFixture, mixPage, videoDetail } from "../../../../fixtures/platform/douyin/fake-platform.ts";

function found(body: unknown): DouyinDetail {
  const read = readDetailResponse(body);
  if (read.kind !== "found") {
    throw new Error("expected a detail");
  }
  return read.detail;
}

function recorded(change: (detail: Record<string, unknown>) => void = () => {}): DouyinDetail {
  const body = videoDetail();
  change(body.aweme_detail as Record<string, unknown>);
  return found(body);
}

function video(detail: Record<string, unknown>): Record<string, unknown> {
  return detail["video"] as Record<string, unknown>;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a failure");
}

describe("video detail", () => {
  it("reads the recorded detail into metadata: title, duration, cover, date, author, chapters and description", () => {
    const metadata = metadataOf(recorded());
    expect(metadata.title).toBe("《守灯人：在礁石上住了三十年》");
    expect(metadata.durationMs).toBe(190800);
    expect(metadata.coverUrl).toMatch(/^https:\/\/p3-pc-sign\.douyinpic\.com\//);
    expect(metadata.publishedAt).toBe(1795512577000);
    expect(metadata).toMatchObject({ channelId: "TESTONLY_secuid", channelTitle: "TESTONLY_nickname", subtitleTracks: [] });
    expect(metadata.chapters).toEqual([
      { startMs: 0, endMs: 20000, title: "上岛" },
      { startMs: 20000, endMs: 60000, title: "断粮" },
      { startMs: 60000, endMs: 100000, title: "看云" },
      { startMs: 100000, endMs: 138000, title: "换灯" },
      { startMs: 138000, endMs: 166000, title: "救船" },
      { startMs: 166000, endMs: 190800, title: "交钥匙" },
    ]);
    expect(metadata.description.state).toBe("found");
    expect(metadata.description.state === "found" && metadata.description.text.startsWith("《守灯人")).toBe(true);
  });

  it("names the collection the video belongs to with its id, name, size and episode", () => {
    expect(relatedCollectionOf(recorded())).toEqual({
      platformCollectionId: "douyin:7900000000000000100",
      title: "灯塔守望录",
      itemCount: 4,
      index: 1,
      canonicalUrl: "https://www.douyin.com/collection/7900000000000000100",
    });
    expect(relatedCollectionOf(recorded((detail) => (detail["mix_info"] = null)))).toBeUndefined();
    expect(relatedCollectionOf(recorded((detail) => (detail["mix_info"] = { mix_id: "12", mix_name: "x" })))).toBeUndefined();
  });

  it("takes the first description line without topic tags when the platform title is empty", () => {
    const titled = (itemTitle: unknown, desc: string) =>
      titleOf(
        recorded((detail) => {
          detail["item_title"] = itemTitle;
          detail["desc"] = desc;
        }),
      );
    expect(titled("", "#知识 #海岛\n  守灯人的一生   #灯塔\n第二行")).toBe("守灯人的一生");
    expect(titled(null, "C#入门 第一课 #编程")).toBe("C#入门 第一课");
    expect(titled("  ", "\n\n第一行\n第二行")).toBe("第一行");
    expect(titled("", "#只有标签 #没有正文")).toBe("#只有标签 #没有正文");
    expect(titled("", "")).toBe("7900000000000000001");
  });

  it("cuts titles and chapter titles to PLATFORM_TITLE_MAX_CHARS at a grapheme boundary", () => {
    const family = "👨‍👩‍👧";
    const long = `${"标".repeat(PLATFORM_TITLE_MAX_CHARS - 2)}${family}尾`;
    const detail = recorded((raw) => {
      raw["item_title"] = long;
      raw["chapter_list"] = [{ desc: long, timestamp: 0 }];
      raw["mix_info"] = { mix_id: "7900000000000000100", mix_name: long, statis: null };
    });
    const metadata = metadataOf(detail);
    expect(metadata.title).toBe("标".repeat(PLATFORM_TITLE_MAX_CHARS - 2));
    expect(metadata.chapters?.[0]?.title).toBe(metadata.title);
    expect(relatedCollectionOf(detail)?.title).toBe(metadata.title);
  });

  it("drops chapters without a title or a valid offset and orders the rest", () => {
    const metadata = metadataOf(
      recorded((detail) => {
        detail["chapter_list"] = [
          { desc: "后", timestamp: 90000 },
          { desc: "", timestamp: 10000 },
          { desc: "负", timestamp: -1 },
          { desc: "超出", timestamp: 999999 },
          { desc: "前", timestamp: 0 },
        ];
      }),
    );
    expect(metadata.chapters).toEqual([
      { startMs: 0, endMs: 90000, title: "前" },
      { startMs: 90000, endMs: 190800, title: "后" },
    ]);
  });

  it("is a video only with an H.264 play address: the four shapes of video and image posts", () => {
    const withoutAddress = (detail: Record<string, unknown>) => {
      video(detail)["bit_rate"] = (video(detail)["bit_rate"] as Array<Record<string, unknown>>).map((entry) => ({
        ...entry,
        play_addr: { ...(entry["play_addr"] as object), url_list: [] },
      }));
    };
    const images = [{ url_list: ["https://p3-pc-sign.douyinpic.com/TESTONLY/image.jpeg?x-signature=<signature>"] }];
    // A plain video.
    expect(isPlayableVideo(recorded())).toBe(true);
    // A plain image post: no streams at all.
    expect(
      isPlayableVideo(
        recorded((detail) => {
          detail["images"] = images;
          detail["video"] = { cover: video(detail)["cover"], bit_rate: null, bit_rate_audio: null };
        }),
      ),
    ).toBe(false);
    // Images and a video block, but no play address.
    expect(
      isPlayableVideo(
        recorded((detail) => {
          detail["images"] = images;
          withoutAddress(detail);
        }),
      ),
    ).toBe(false);
    // Images and a play address: a video.
    expect(isPlayableVideo(recorded((detail) => (detail["images"] = images)))).toBe(true);
  });

  it("does not count H.265 or video-only streams as playable", () => {
    const only = (gears: string[]) =>
      recorded((detail) => {
        video(detail)["bit_rate"] = (video(detail)["bit_rate"] as Array<Record<string, unknown>>).filter((entry) => gears.includes(`${entry["gear_name"]}:${entry["format"]}`));
      });
    expect(isPlayableVideo(only(["adapt_lowest_1440_1:mp4", "adapt_lowest_1080_1:mp4"]))).toBe(false);
    expect(isPlayableVideo(only(["normal_1080_0:dash"]))).toBe(false);
    expect(isPlayableVideo(only(["normal_1080_0:mp4"]))).toBe(true);
  });

  it("lists combined H.264 MP4 tiers only, the larger picture per tier", () => {
    const detail = recorded();
    expect(combinedH264Streams(detail).map((stream) => `${stream.width}x${stream.height}`)).toEqual(["1920x1080", "1024x576", "1280x720", "1024x576"]);
    expect(qualitiesOf(detail)).toEqual([
      { tier: 720, width: 1280, height: 720 },
      { tier: 1080, width: 1920, height: 1080 },
    ]);
    expect(streamFor(detail, { tier: 1080 })?.urls[0]).toContain("/normal_1080_0-mp4/");
    expect(streamFor(detail, { tier: 1440 })).toBeUndefined();
    expect(streamFor(detail, { maxHeight: 720 })?.tier).toBe(720);
    expect(streamFor(detail, { maxHeight: 360 })?.tier).toBe(720);
    expect(streamFor(detail, { maxHeight: 2160 })?.tier).toBe(1080);
  });

  it("offers the separate sound stream first and the smallest combined stream as the fallback", () => {
    const detail = recorded();
    const [audio] = audioStreams(detail);
    expect(audio).toMatchObject({ sizeBytes: 1112927 });
    expect(audio?.urls).toHaveLength(3);
    expect(smallestCombined(detail)).toMatchObject({ width: 1024, height: 576, sizeBytes: 26911981 });
  });
});

describe("detail answers", () => {
  it("is hidden for the platform's empty, filtered answer", () => {
    expect(readDetailResponse(douyinFixture("detail-filtered.json"))).toEqual({ kind: "hidden" });
  });

  it("is hidden for a removed or prohibited video and for a non-zero status code", () => {
    expect(readDetailResponse({ ...videoDetail(), status_code: 8 })).toEqual({ kind: "hidden" });
    const removed = videoDetail();
    (removed.aweme_detail as Record<string, unknown>)["status"] = { is_delete: true };
    expect(readDetailResponse(removed)).toEqual({ kind: "hidden" });
  });

  it("fails when a used field has the wrong type", () => {
    for (const change of [
      (detail: Record<string, unknown>) => (detail["aweme_id"] = 7900000000000000001),
      (detail: Record<string, unknown>) => (detail["item_title"] = { text: "x" }),
      (detail: Record<string, unknown>) => (detail["chapter_list"] = "none"),
      (detail: Record<string, unknown>) => (video(detail)["bit_rate"] = [{ play_addr: { url_list: "https://v.douyinvod.com/x" } }]),
    ]) {
      const body = videoDetail();
      change(body.aweme_detail as Record<string, unknown>);
      expect(codeOf(() => readDetailResponse(body))).toBe("source_unreachable");
    }
    expect(codeOf(() => readDetailResponse({ status_code: "0", aweme_detail: null }))).toBe("source_unreachable");
  });

  it("treats an empty body or one that is not JSON as unreachable", () => {
    expect(codeOf(() => parseJsonBody(""))).toBe("source_unreachable");
    expect(codeOf(() => parseJsonBody("<html>verify</html>"))).toBe("source_unreachable");
  });
});

describe("collection pages", () => {
  it("reads the recorded page: entries, cursor and the end of the list", () => {
    const page = readMixPage(mixPage());
    expect(page.entries.map((entry) => entry.platformContentId)).toEqual(["7900000000000000001", "7900000000000000002", "7900000000000000003", "7900000000000000004"]);
    expect(page).toMatchObject({ cursor: 15, hasMore: false });
  });

  it("keeps an entry whose details do not parse by its id alone and drops one without an id", () => {
    const body = mixPage();
    body.aweme_list = [{ aweme_id: "7900000000000000002", video: "broken" }, { desc: "no id" }, ...body.aweme_list.slice(0, 1)];
    const page = readMixPage(body);
    expect(page.entries.map((entry) => [entry.platformContentId, entry.detail === undefined])).toEqual([
      ["7900000000000000002", true],
      ["7900000000000000001", false],
    ]);
  });

  it("fails for a page of the wrong shape or with a non-zero status code", () => {
    expect(codeOf(() => readMixPage({ aweme_list: "none" }))).toBe("source_unreachable");
    expect(codeOf(() => readMixPage({ ...mixPage(), status_code: 2053 }))).toBe("source_unreachable");
  });
});
