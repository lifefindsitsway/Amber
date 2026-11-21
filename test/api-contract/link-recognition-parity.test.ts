import { describe, expect, it } from "vitest";
import { isShortLink, parseBilibiliUrl } from "../../src/server/adapters/platform/bilibili/url.ts";
import { parseYoutubeUrl } from "../../src/server/adapters/platform/youtube/url.ts";
import { parseLinkText, recognizeLink } from "../../src/web/links.ts";
import { APP_SHARE, BV, LONG_SHARE, PART_THEN_TITLE, WEB_SHARE } from "../fixtures/platform/share-text.ts";

/**
 * The new page sends only the links it recognizes when other text is around them, and names the
 * rest as not added. A link the client accepts but the server refuses would be sent and fail;
 * one the server accepts but the client refuses would be left out. Both recognizers are run on
 * the same samples here.
 */
function server(url: string) {
  return parseBilibiliUrl(url) ?? parseYoutubeUrl(url);
}

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

  it("on every link taken out of share texts", () => {
    const parsed = parseLinkText([WEB_SHARE, APP_SHARE, PART_THEN_TITLE, LONG_SHARE].join("\n"));
    expect(parsed.links.length).toBeGreaterThan(0);
    for (const link of parsed.links) {
      if (link.kind === "shortlink") expect(isShortLink(link.url), link.url).toBe(true);
      else expect(server(link.url), link.url).not.toBeNull();
    }
    for (const url of parsed.unsupported) {
      expect(server(url), url).toBeNull();
      expect(isShortLink(url), url).toBe(false);
    }
  });
});
