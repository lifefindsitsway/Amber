import { describe, expect, it } from "vitest";
import { PLATFORM_CAPABILITIES } from "../../../src/shared/platforms.ts";
import { PLATFORMS } from "../../../src/shared/enums.ts";
import { bilibiliEmbedUrl, CAPABILITIES, hasOnlinePlayer, isEmbedded, playerSourceOf, youtubeEmbedUrl } from "../../../src/web/player/capabilities.ts";

describe("player capabilities", () => {
  it("derives the player from the Content source", () => {
    expect(playerSourceOf({ source: { kind: "youtube", platformContentId: "abc", sourceUrl: "https://youtu.be/abc" } })).toEqual({
      kind: "youtube",
      videoId: "abc",
      originalUrl: "https://youtu.be/abc",
    });
    expect(playerSourceOf({ source: { kind: "bilibili", platformContentId: "BV1", platformPartId: "9", sourceUrl: "https://www.bilibili.com/video/BV1?p=3" } })).toEqual({
      kind: "bilibili",
      bvid: "BV1",
      page: 3,
      cid: "9",
      originalUrl: "https://www.bilibili.com/video/BV1?p=3",
    });
    expect(playerSourceOf({ source: { kind: "local" } })).toEqual({ kind: "local" });
    expect(playerSourceOf({ source: { kind: "youtube" } })).toEqual({ kind: "none" });
  });

  it("gives YouTube direct seeking with time tracking and Bilibili reload without tracking", () => {
    expect(CAPABILITIES.youtube).toEqual({ seekMode: "direct", timeTracking: "supported", remembersPosition: false, rangePlayback: "play" });
    expect(CAPABILITIES.bilibili).toEqual({ seekMode: "reload", timeTracking: "unsupported", remembersPosition: false, rangePlayback: "jump" });
    expect(CAPABILITIES.local).toEqual({ seekMode: "direct", timeTracking: "supported", remembersPosition: true, rangePlayback: "play" });
    expect(CAPABILITIES.none.remembersPosition).toBe(false);
    expect(CAPABILITIES.none.rangePlayback).toBe("unsupported");
  });

  it("puts a platform without an online player in its own category, whatever identifiers it has", () => {
    expect(
      playerSourceOf({ source: { kind: "xiaohongshu", platformContentId: "64f0c0ffee0000000000abcd", sourceUrl: "https://www.xiaohongshu.com/explore/64f0c0ffee0000000000abcd?xsec_token=TESTONLY_token1" } }),
    ).toEqual({ kind: "no_online_player", platform: "xiaohongshu", originalUrl: "https://www.xiaohongshu.com/explore/64f0c0ffee0000000000abcd?xsec_token=TESTONLY_token1" });
    expect(playerSourceOf({ source: { kind: "douyin", platformContentId: "7300000000000000001", sourceUrl: "https://www.douyin.com/video/7300000000000000001" } })).toEqual({
      kind: "no_online_player",
      platform: "douyin",
      originalUrl: "https://www.douyin.com/video/7300000000000000001",
    });
    expect(playerSourceOf({ source: { kind: "douyin" } })).toEqual({ kind: "no_online_player", platform: "douyin" });
    expect(isEmbedded(playerSourceOf({ source: { kind: "douyin" } }))).toBe(false);
    expect(CAPABILITIES.no_online_player).toEqual({ seekMode: "unsupported", timeTracking: "unsupported", remembersPosition: false, rangePlayback: "unsupported" });
  });

  it("reads whether a source has an online player from the platform capability table only", () => {
    for (const platform of PLATFORMS) {
      expect(hasOnlinePlayer(platform)).toBe(PLATFORM_CAPABILITIES[platform].onlinePlayer);
      // Every platform either embeds or falls into the cache-only category.
      const source = playerSourceOf({ source: { kind: platform, platformContentId: "id1" } });
      expect(source.kind === "no_online_player").toBe(!PLATFORM_CAPABILITIES[platform].onlinePlayer);
      expect(isEmbedded(source)).toBe(PLATFORM_CAPABILITIES[platform].onlinePlayer);
    }
    expect(hasOnlinePlayer("local")).toBe(false);
  });

  it("seeks Bilibili by reloading with t= in whole seconds and autoplay", () => {
    const url = new URL(bilibiliEmbedUrl({ kind: "bilibili", bvid: "BV1", page: 2 }, 75_900));
    expect(url.origin + url.pathname).toBe("https://player.bilibili.com/player.html");
    expect(url.searchParams.get("t")).toBe("75");
    expect(url.searchParams.get("autoplay")).toBe("1");
    expect(url.searchParams.get("p")).toBe("2");
    expect(new URL(bilibiliEmbedUrl({ kind: "bilibili", bvid: "BV1" }, undefined)).searchParams.get("t")).toBeNull();
  });

  it("embeds YouTube with the JS API enabled for our origin", () => {
    const url = new URL(youtubeEmbedUrl("abc", "http://localhost:4173"));
    expect(url.pathname).toBe("/embed/abc");
    expect(url.searchParams.get("enablejsapi")).toBe("1");
    expect(url.searchParams.get("origin")).toBe("http://localhost:4173");
    expect(url.searchParams.has("start")).toBe(false);
  });

});
