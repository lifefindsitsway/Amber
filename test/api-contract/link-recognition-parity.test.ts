import { describe, expect, it } from "vitest";
import { isShortLink, parseBilibiliUrl } from "../../src/server/adapters/platform/bilibili/url.ts";
import { isDouyinShortLink, parseDouyinUrl } from "../../src/server/adapters/platform/douyin/url.ts";
import { isXiaohongshuShortLink, parseXiaohongshuUrl } from "../../src/server/adapters/platform/xiaohongshu/url.ts";
import { parseYoutubeUrl } from "../../src/server/adapters/platform/youtube/url.ts";
import { parseLinkText, recognizeLink } from "../../src/web/links.ts";
import { APP_SHARE, BV, DOUYIN_SHARE, LONG_SHARE, PART_THEN_TITLE, WEB_SHARE, XHS_SHARE } from "../fixtures/platform/share-text.ts";

/**
 * The new page sends only the links it recognizes when other text is around them, and names the
 * rest as not added. A link the client accepts but the server refuses would be sent and fail;
 * one the server accepts but the client refuses would be left out. Both recognizers are run on
 * the same samples here.
 */
function server(url: string) {
  return parseBilibiliUrl(url) ?? parseYoutubeUrl(url) ?? parseXiaohongshuUrl(url) ?? parseDouyinUrl(url);
}

/** Whether some platform's server side expands this short link. */
function serverShortLink(url: string): boolean {
  return isShortLink(url) || isXiaohongshuShortLink(url) || isDouyinShortLink(url);
}

/** Made-up ids in each platform's shape. */
const NOTE = "0123456789abcdef01234567";
const USER = "fedcba9876543210fedcba98";
const AWEME = "7301234567890123456";
const MIX = "7298765432109876543";

const VIDEOS = [
  `https://www.bilibili.com/video/${BV}`,
  `https://www.bilibili.com/video/${BV}/`,
  `http://bilibili.com/video/${BV}/?spm_id_from=333.1&vd_source=placeholder`,
  `https://m.bilibili.com/video/${BV}`,
  `https://WWW.BILIBILI.COM/video/${BV}?p=3&t=12`,
  `https://www.bilibili.com/video/${BV}?p=1`,
  `https://www.bilibili.com/video/${BV}?p=9999`,
  `https://www.bilibili.com/video/${BV}?p=0`,
  `https://www.bilibili.com/video/${BV}?p=`,
  `https://www.bilibili.com/video/${BV}?p=10000`,
  `https://www.bilibili.com/video/${BV}?p=01`,
  `https://www.bilibili.com/video/${BV}?p=2x`,
  `https://www.bilibili.com/video/${BV}/extra`,
  `https://www.bilibili.com/video/BV123`,
  "https://www.bilibili.com/read/cv1",
  "https://www.youtube.com/watch?v=UF8uR6Z6KLc",
  "https://youtube.com/watch?v=UF8uR6Z6KLc&list=PLabcdefghij&index=2",
  "https://m.youtube.com/watch?v=UF8uR6Z6KLc&t=30s",
  "https://www.youtube.com/watch?v=short",
  "https://www.youtube.com/watch",
  "https://www.youtube.com/watch/?v=UF8uR6Z6KLc",
  "https://youtu.be/UF8uR6Z6KLc",
  "https://youtu.be/UF8uR6Z6KLc?si=placeholder",
  "https://youtu.be/UF8uR6Z6KLc/",
  "https://youtu.be/",
  "https://example.com/watch?v=UF8uR6Z6KLc",
  "ftp://youtu.be/UF8uR6Z6KLc",
  "not a url",
  `https://www.xiaohongshu.com/explore/${NOTE}`,
  `https://xiaohongshu.com/explore/${NOTE}/`,
  `http://www.xiaohongshu.com/explore/${NOTE}?xsec_token=TESTONLY_token1=&xsec_source=pc_feed`,
  `https://www.xiaohongshu.com/discovery/item/${NOTE}?app_platform=ios&xsec_source=app_share`,
  `https://www.xiaohongshu.com/user/profile/${USER}/${NOTE}`,
  `https://WWW.XIAOHONGSHU.COM/explore/${NOTE}#comments`,
  `https://www.xiaohongshu.com:443/explore/${NOTE}`,
  `https://www.xiaohongshu.com:8443/explore/${NOTE}`,
  `https://user:pass@www.xiaohongshu.com/explore/${NOTE}`,
  `https://www.xiaohongshu.com/explore/${NOTE.toUpperCase()}`,
  `https://www.xiaohongshu.com/explore/${NOTE}0`,
  `https://www.xiaohongshu.com/explore/${NOTE}/extra`,
  `https://www.xiaohongshu.com/user/profile/not-an-id/${NOTE}`,
  `https://www.xiaohongshu.com/user/profile/${USER}`,
  `https://m.xiaohongshu.com/explore/${NOTE}`,
  `https://www.xiaohongshu.com.evil.example/explore/${NOTE}`,
  `https://www.douyin.com/video/${AWEME}`,
  `http://douyin.com/video/${AWEME}/?previous_page=app_code_link`,
  `https://www.douyin.com/note/${AWEME}`,
  `https://www.douyin.com/discover?modal_id=${AWEME}`,
  `https://www.douyin.com/collection/${MIX}?modal_id=${AWEME}`,
  `https://www.douyin.com/user/self?modal_id=abc`,
  `https://www.douyin.com/video/${AWEME}?modal_id=1`,
  `https://www.iesdouyin.com/share/video/${AWEME}/?region=CN`,
  `https://www.iesdouyin.com/share/video/${AWEME}/extra`,
  `https://iesdouyin.com/share/video/${AWEME}`,
  `https://www.douyin.com/video/12345678901234`,
  `https://www.douyin.com/video/123456789012345678901`,
  `https://www.douyin.com:8443/video/${AWEME}`,
  `https://m.douyin.com/video/${AWEME}`,
  `https://www.douyin.com/user/self`,
];

const COLLECTIONS = [
  "https://space.bilibili.com/202224425/lists/8942017",
  "https://space.bilibili.com/202224425/lists/8942017?type=season",
  "https://space.bilibili.com/1/lists/77?type=series",
  "https://space.bilibili.com/1/lists/77/",
  "https://space.bilibili.com/1/channel/collectiondetail?sid=5",
  "https://space.bilibili.com/1/channel/seriesdetail?sid=6",
  "https://space.bilibili.com/1/channel/collectiondetail",
  "https://space.bilibili.com/1/channel/seriesdetail?sid=x",
  "https://space.bilibili.com/1/channel/other?sid=6",
  "https://space.bilibili.com/abc/lists/77",
  "https://space.bilibili.com/1/lists/x",
  "https://space.bilibili.com/1",
  "https://www.youtube.com/playlist?list=PLabcdefghij0123456789",
  `https://www.youtube.com/playlist?list=${"P".repeat(10)}`,
  `https://www.youtube.com/playlist?list=${"P".repeat(64)}`,
  `https://www.youtube.com/playlist?list=${"P".repeat(9)}`,
  `https://www.youtube.com/playlist?list=${"P".repeat(65)}`,
  "https://www.youtube.com/playlist?list=PL!abcdefghij",
  "https://www.youtube.com/playlist",
  `https://www.douyin.com/collection/${MIX}`,
  `https://douyin.com/collection/${MIX}/?enter_from=z`,
  `https://www.iesdouyin.com/share/mix/detail/${MIX}/?schema_type=24`,
  `https://www.douyin.com/collection/abc`,
  `https://www.iesdouyin.com/share/mix/${MIX}`,
  `https://www.iesdouyin.com/share/mix/detail/${MIX}/extra`,
];

describe("client and server link recognition agree", () => {
  it.each(VIDEOS)("on the video link %s", (url) => {
    const client = recognizeLink(url);
    const parsed = server(url);
    expect(client === undefined ? undefined : client.kind).toBe(parsed !== null && parsed.platformContentId !== undefined ? "video" : undefined);
    // A part named in the link is a part chosen; the server reads the same part.
    if (client !== undefined && client.platform === "bilibili") {
      expect(client.partChosen).toBe(parsed?.partIndex !== undefined);
    }
  });

  it.each(COLLECTIONS)("on the collection link %s", (url) => {
    const client = recognizeLink(url);
    const parsed = server(url);
    expect(client === undefined ? undefined : client.kind).toBe(parsed !== null && parsed.platformCollectionId !== undefined ? "collection" : undefined);
  });

  it.each(["https://b23.tv/Ab3dE5f", "http://b23.tv/Ab3dE5f/", "https://B23.TV/x1", "https://b23.tv/", "https://b23.tv/a/b", "https://b23.tv/a-b"])(
    "on the short link %s: one the client calls short, the server expands",
    (url) => {
      if (recognizeLink(url)?.kind === "shortlink") {
        expect(isShortLink(url)).toBe(true);
      }
    },
  );

  it.each([
    "https://xhslink.com/a/AbC123",
    "http://xhslink.com/m/AbC123?share=1",
    "https://www.xhslink.com/AbC123",
    "https://xhslink.com/",
    "https://xhslink.com/a/b/c",
    "https://xhslink.com/a/b%20c",
    "https://xhslink.com:8443/a/AbC123",
    "https://v.douyin.com/iAbC123/",
    "http://v.douyin.com/iAbC123",
    "https://V.DOUYIN.COM/iAbC123/?x=1",
    "https://v.douyin.com/",
    "https://v.douyin.com/a/b",
    `https://v.douyin.com/${"a".repeat(33)}`,
    "https://user@v.douyin.com/iAbC123/",
  ])("on the short link %s: the client calls it short exactly when the server expands it", (url) => {
    expect(recognizeLink(url)?.kind === "shortlink").toBe(isXiaohongshuShortLink(url) || isDouyinShortLink(url));
  });

  it("on every link taken out of share texts", () => {
    const parsed = parseLinkText([WEB_SHARE, APP_SHARE, PART_THEN_TITLE, LONG_SHARE, XHS_SHARE, DOUYIN_SHARE].join("\n"));
    expect(parsed.links.length).toBeGreaterThan(0);
    for (const link of parsed.links) {
      if (link.kind === "shortlink") expect(serverShortLink(link.url), link.url).toBe(true);
      else expect(server(link.url), link.url).not.toBeNull();
    }
    for (const url of parsed.unsupported) {
      expect(server(url), url).toBeNull();
      expect(serverShortLink(url), url).toBe(false);
    }
  });
});
