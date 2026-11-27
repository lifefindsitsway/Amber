import { describe, expect, it } from "vitest";
import {
  collectionCanonicalUrl,
  collectionIdOf,
  isDouyinShortLink,
  normalizeDouyinShortLink,
  parseDouyinUrl,
  videoUrl,
} from "../../../../../src/server/adapters/platform/douyin/url.ts";

const VIDEO = "7301234567890123456";
const OTHER = "7309876543210987654";
const MIX = "7298765432109876543";
const VIDEO_URL = `https://www.douyin.com/video/${VIDEO}`;
const MIX_URL = `https://www.douyin.com/collection/${MIX}`;

describe("parseDouyinUrl", () => {
  it("accepts every content link form and canonicalizes it", () => {
    const cases: Array<[string, string]> = [
      [`https://www.douyin.com/video/${VIDEO}`, VIDEO],
      [`http://douyin.com/video/${VIDEO}/?previous_page=app_code_link&enter_from=x`, VIDEO],
      [`https://www.douyin.com/note/${VIDEO}`, VIDEO],
      [`https://www.douyin.com/user/MS4wLjABAAAA_placeholder?modal_id=${VIDEO}`, VIDEO],
      [`https://www.douyin.com/discover?modal_id=${VIDEO}&from=y`, VIDEO],
      // The video opened over a page wins over the page itself.
      [`https://www.douyin.com/collection/${MIX}?modal_id=${VIDEO}`, VIDEO],
      [`https://www.douyin.com/video/${OTHER}?modal_id=${VIDEO}`, VIDEO],
      [`https://www.iesdouyin.com/share/video/${VIDEO}/?region=CN&mid=1`, VIDEO],
      [`  https://WWW.DOUYIN.COM/video/${VIDEO}#top  `, VIDEO],
      [`https://www.douyin.com:443/video/${VIDEO}`, VIDEO],
      ["https://www.douyin.com/video/123456789012345", "123456789012345"],
      ["https://www.douyin.com/video/12345678901234567890", "12345678901234567890"],
    ];
    for (const [url, id] of cases) {
      expect(parseDouyinUrl(url), url).toEqual({ platformContentId: id, canonicalUrl: videoUrl(id) });
    }
    expect(parseDouyinUrl(`https://www.douyin.com/note/${VIDEO}`)?.canonicalUrl).toBe(VIDEO_URL);
  });

  it("accepts collection links and namespaces their ids", () => {
    for (const url of [
      MIX_URL,
      `https://douyin.com/collection/${MIX}/?enter_from=z`,
      `https://www.iesdouyin.com/share/mix/detail/${MIX}/?schema_type=24`,
    ]) {
      expect(parseDouyinUrl(url), url).toEqual({ platformCollectionId: `douyin:${MIX}`, canonicalUrl: MIX_URL });
    }
  });

  it("rejects everything else", () => {
    for (const url of [
      "not a url",
      `javascript:alert('${VIDEO}')`,
      `data:text/html,${VIDEO_URL}`,
      `ftp://www.douyin.com/video/${VIDEO}`,
      `https://www.douyin.com.evil.example/video/${VIDEO}`,
      `https://evildouyin.com/video/${VIDEO}`,
      `https://m.douyin.com/video/${VIDEO}`,
      `https://iesdouyin.com.evil.example/share/video/${VIDEO}`,
      `https://www.iesdouyin.com/video/${VIDEO}`,
      `https://www.iesdouyin.com/share/user/${VIDEO}`,
      `https://www.douyin.com/share/video/${VIDEO}`,
      `https://user:pass@www.douyin.com/video/${VIDEO}`,
      `https://www.douyin.com:8443/video/${VIDEO}`,
      "https://www.douyin.com/video/12345678901234",
      "https://www.douyin.com/video/123456789012345678901",
      "https://www.douyin.com/video/7301234567890abc456",
      `https://www.douyin.com/video/${VIDEO}/extra`,
      `https://www.douyin.com/video`,
      `https://www.douyin.com/?modal_id=abc`,
      `https://www.douyin.com/video/${VIDEO}?modal_id=`,
      `https://www.douyin.com/collection/${MIX}/extra`,
      "https://www.douyin.com/collection/123",
      "https://www.douyin.com/user/MS4wLjABAAAA_placeholder",
      `https://www.iesdouyin.com/share/mix/detail/x${MIX}`,
      "https://v.douyin.com/AbCd123/",
    ]) {
      expect(parseDouyinUrl(url), url).toBeNull();
    }
  });
});

describe("collection ids", () => {
  it("round-trips through the parser", () => {
    expect(collectionCanonicalUrl(MIX)).toBe(MIX_URL);
    expect(collectionIdOf(`douyin:${MIX}`)).toBe(MIX);
    const parsed = parseDouyinUrl(collectionCanonicalUrl(MIX));
    expect(collectionIdOf(parsed?.platformCollectionId as string)).toBe(MIX);
    expect(parseDouyinUrl(videoUrl(VIDEO))?.platformContentId).toBe(VIDEO);
  });

  it("refuses ids without the prefix or with a malformed mix id", () => {
    for (const id of [MIX, `douyin:`, `douyin:abc`, `douyin:123`, `bilibili:${MIX}`, `DOUYIN:${MIX}`, `douyin:${MIX}x`, "1_2"]) {
      expect(collectionIdOf(id), id).toBeNull();
    }
  });
});

describe("short links", () => {
  it("recognizes v.douyin.com links and upgrades them to https", () => {
    const cases: Array<[string, string]> = [
      ["https://v.douyin.com/iRNBho6u/", "https://v.douyin.com/iRNBho6u/"],
      ["https://v.douyin.com/iRNBho6u", "https://v.douyin.com/iRNBho6u/"],
      ["http://v.douyin.com/Ab-c_12/?utm=x#y", "https://v.douyin.com/Ab-c_12/"],
    ];
    for (const [url, normalized] of cases) {
      expect(normalizeDouyinShortLink(url), url).toBe(normalized);
      expect(isDouyinShortLink(url), url).toBe(true);
    }
  });

  it("rejects anything that is not a v.douyin.com short link", () => {
    for (const url of [
      "https://v.douyin.com/",
      "https://v.douyin.com/a/b/",
      `https://v.douyin.com/${"a".repeat(33)}/`,
      "https://v.douyin.com/%3Cx%3E/",
      "https://v.douyin.com.evil.example/iRNBho6u/",
      "https://douyin.com/iRNBho6u/",
      "https://www.douyin.com/iRNBho6u/",
      "https://user@v.douyin.com/iRNBho6u/",
      "https://v.douyin.com:8443/iRNBho6u/",
      "javascript:alert(1)//v.douyin.com/iRNBho6u/",
      VIDEO_URL,
    ]) {
      expect(isDouyinShortLink(url), url).toBe(false);
    }
  });
});
