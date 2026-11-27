import { describe, expect, it } from "vitest";
import {
  accessParamsOf,
  explorePageUrl,
  hasAccessToken,
  isXiaohongshuShortLink,
  mobileShareUrl,
  normalizeXiaohongshuShortLink,
  parseXiaohongshuUrl,
} from "../../../../../src/server/adapters/platform/xiaohongshu/url.ts";

const NOTE = "0123456789abcdef01234567";
const USER = "fedcba9876543210fedcba98";
const TOKEN = "TESTONLY_token1=";
const ENCODED_TOKEN = "TESTONLY_token1%3D";
const CANONICAL = `https://www.xiaohongshu.com/explore/${NOTE}`;

describe("parseXiaohongshuUrl", () => {
  it("accepts every note link form and canonicalizes it to the explore page", () => {
    for (const url of [
      `https://www.xiaohongshu.com/explore/${NOTE}`,
      `https://xiaohongshu.com/explore/${NOTE}/`,
      `http://www.xiaohongshu.com/explore/${NOTE}`,
      `https://www.xiaohongshu.com/discovery/item/${NOTE}`,
      `https://www.xiaohongshu.com/user/profile/${USER}/${NOTE}`,
      `  https://WWW.XIAOHONGSHU.COM/explore/${NOTE}#comments  `,
      `https://www.xiaohongshu.com:443/explore/${NOTE}`,
    ]) {
      expect(parseXiaohongshuUrl(url), url).toEqual({ platformContentId: NOTE, canonicalUrl: CANONICAL });
    }
  });

  it("keeps only xsec_token and xsec_source, in that order", () => {
    const url = `https://www.xiaohongshu.com/discovery/item/${NOTE}?app_platform=ios&xsec_source=app_share&share_id=abc&xsec_token=${ENCODED_TOKEN}&type=video`;
    expect(parseXiaohongshuUrl(url)).toEqual({
      platformContentId: NOTE,
      canonicalUrl: `${CANONICAL}?xsec_token=${ENCODED_TOKEN}&xsec_source=app_share`,
    });
    expect(parseXiaohongshuUrl(`${CANONICAL}?xsec_source=pc_feed`)?.canonicalUrl).toBe(`${CANONICAL}?xsec_source=pc_feed`);
  });

  it("is idempotent on its own canonical URL", () => {
    const canonical = explorePageUrl(NOTE, { xsecToken: TOKEN, xsecSource: "pc_feed" });
    expect(parseXiaohongshuUrl(canonical)).toEqual({ platformContentId: NOTE, canonicalUrl: canonical });
  });

  it("drops access parameters that are empty or not token-shaped", () => {
    for (const query of [
      "xsec_token=",
      "xsec_token=a%20b",
      "xsec_token=a+b",
      "xsec_token=%3Cscript%3E",
      "xsec_token=a%22b",
      `xsec_token=${"A".repeat(257)}`,
      "xsec_token=AB%3D%3D%3D",
    ]) {
      expect(parseXiaohongshuUrl(`${CANONICAL}?${query}`)?.canonicalUrl, query).toBe(CANONICAL);
    }
    expect(parseXiaohongshuUrl(`${CANONICAL}?xsec_token=${ENCODED_TOKEN}&xsec_source=pc%2Ffeed`)?.canonicalUrl).toBe(`${CANONICAL}?xsec_token=${ENCODED_TOKEN}`);
  });

  it("rejects everything else", () => {
    for (const url of [
      "not a url",
      `javascript:alert('${NOTE}')`,
      `data:text/html,https://www.xiaohongshu.com/explore/${NOTE}`,
      `ftp://www.xiaohongshu.com/explore/${NOTE}`,
      `https://xiaohongshu.com.evil.example/explore/${NOTE}`,
      `https://evilxiaohongshu.com/explore/${NOTE}`,
      `https://edith.xiaohongshu.com/explore/${NOTE}`,
      `https://m.xiaohongshu.com/explore/${NOTE}`,
      `https://user:pass@www.xiaohongshu.com/explore/${NOTE}`,
      `https://user@www.xiaohongshu.com/explore/${NOTE}`,
      `https://www.xiaohongshu.com:8443/explore/${NOTE}`,
      `https://www.xiaohongshu.com/explore/${NOTE.toUpperCase()}`,
      `https://www.xiaohongshu.com/explore/${NOTE.slice(1)}`,
      `https://www.xiaohongshu.com/explore/${NOTE}0`,
      "https://www.xiaohongshu.com/explore/0123456789abcdef0123456g",
      `https://www.xiaohongshu.com/explore/${NOTE}/extra`,
      `https://www.xiaohongshu.com/explore`,
      `https://www.xiaohongshu.com/discovery/${NOTE}`,
      `https://www.xiaohongshu.com/user/profile/${USER}`,
      `https://www.xiaohongshu.com/user/profile/not-an-id/${NOTE}`,
      `https://www.xiaohongshu.com/?noteId=${NOTE}`,
      "https://xhslink.com/a/AbCd1234",
    ]) {
      expect(parseXiaohongshuUrl(url), url).toBeNull();
    }
  });
});

describe("access parameters", () => {
  it("builds the mobile share page with the same parameters", () => {
    expect(mobileShareUrl(NOTE)).toBe(`https://www.xiaohongshu.com/discovery/item/${NOTE}`);
    expect(mobileShareUrl(NOTE, { xsecToken: TOKEN, xsecSource: "app_share" })).toBe(
      `https://www.xiaohongshu.com/discovery/item/${NOTE}?xsec_token=${ENCODED_TOKEN}&xsec_source=app_share`,
    );
    const canonical = parseXiaohongshuUrl(`${CANONICAL}?xsec_source=pc_feed&xsec_token=${ENCODED_TOKEN}`)?.canonicalUrl as string;
    expect(mobileShareUrl(NOTE, accessParamsOf(canonical))).toBe(`https://www.xiaohongshu.com/discovery/item/${NOTE}?xsec_token=${ENCODED_TOKEN}&xsec_source=pc_feed`);
  });

  it("never writes parameter values that are not token-shaped", () => {
    expect(mobileShareUrl(NOTE, { xsecToken: "a&b=c", xsecSource: "x y" })).toBe(`https://www.xiaohongshu.com/discovery/item/${NOTE}`);
  });

  it("reads the parameters and tells whether the token is present", () => {
    expect(accessParamsOf(`${CANONICAL}?xsec_token=${ENCODED_TOKEN}&xsec_source=pc_feed`)).toEqual({ xsecToken: TOKEN, xsecSource: "pc_feed" });
    expect(accessParamsOf("not a url")).toEqual({});
    const withToken = parseXiaohongshuUrl(`${CANONICAL}?xsec_token=${ENCODED_TOKEN}`);
    const withoutToken = parseXiaohongshuUrl(`${CANONICAL}?xsec_source=pc_feed`);
    expect(withToken !== null && hasAccessToken(withToken)).toBe(true);
    expect(withoutToken !== null && hasAccessToken(withoutToken)).toBe(false);
  });
});

describe("short links", () => {
  it("recognizes xhslink.com links and upgrades them to https", () => {
    const cases: Array<[string, string]> = [
      ["https://xhslink.com/a/AbCd1234", "https://xhslink.com/a/AbCd1234"],
      ["http://xhslink.com/a/AbCd1234?xhsshare=CopyLink#x", "https://xhslink.com/a/AbCd1234"],
      ["https://www.xhslink.com/m/Ab_Cd-12/", "https://www.xhslink.com/m/Ab_Cd-12"],
      ["https://xhslink.com/AbCd1234", "https://xhslink.com/AbCd1234"],
    ];
    for (const [url, normalized] of cases) {
      expect(normalizeXiaohongshuShortLink(url), url).toBe(normalized);
      expect(isXiaohongshuShortLink(url), url).toBe(true);
    }
  });

  it("rejects anything that is not an xhslink.com short link", () => {
    for (const url of [
      "https://xhslink.com/",
      "https://xhslink.com",
      "https://xhslink.com/a/b/c",
      "https://xhslink.com/a/%3Cx%3E",
      "https://xhslink.com.evil.example/a/AbCd1234",
      "https://evilxhslink.com/a/AbCd1234",
      "https://sub.xhslink.com/a/AbCd1234",
      "https://user@xhslink.com/a/AbCd1234",
      "https://xhslink.com:8443/a/AbCd1234",
      "javascript:alert(1)//xhslink.com/a/AbCd1234",
      CANONICAL,
    ]) {
      expect(isXiaohongshuShortLink(url), url).toBe(false);
    }
  });
});
