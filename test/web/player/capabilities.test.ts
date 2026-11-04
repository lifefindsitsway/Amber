import { describe, expect, it } from "vitest";
import { bilibiliEmbedUrl, CAPABILITIES, playerSourceOf, youtubeEmbedUrl } from "../../../src/web/player/capabilities.ts";

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
    expect(CAPABILITIES.youtube).toEqual({ seekMode: "direct", timeTracking: "supported", remembersPosition: false });
    expect(CAPABILITIES.bilibili).toEqual({ seekMode: "reload", timeTracking: "unsupported", remembersPosition: false });
    expect(CAPABILITIES.local).toEqual({ seekMode: "direct", timeTracking: "supported", remembersPosition: true });
    expect(CAPABILITIES.none.remembersPosition).toBe(false);
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
