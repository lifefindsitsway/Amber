import { describe, expect, it } from "vitest";
import {
  audioCacheFileName,
  cacheExtensionOf,
  cacheFileNameOf,
  cacheQualityTier,
  CACHE_QUALITY_TIERS,
  cacheRefOf,
  fittedCacheStem,
  isCacheRef,
  isValidCacheFileName,
  labelledStem,
  sameCacheFileName,
  sanitizeCacheStem,
  videoCacheFileName,
  WINDOWS_MAX_PATH_UNITS,
} from "../../src/shared/cache-file-name.ts";
import { CACHE_FILE_NAME_MAX_CHARS } from "../../src/shared/defaults.ts";

describe("sanitizeCacheStem", () => {
  it("keeps readable titles and removes what Windows refuses", () => {
    expect(sanitizeCacheStem("从零开始学 Agent：第 1 讲")).toBe("从零开始学 Agent：第 1 讲");
    expect(sanitizeCacheStem("a: b")).toBe("a b");
    expect(sanitizeCacheStem('a<b>c:d"e/f\\g|h?i*j')).toBe("abcdefghij");
    expect(sanitizeCacheStem("a\u0000b\u001fc\u0085d")).toBe("abcd");
    expect(sanitizeCacheStem("  many   spaces\tand\nlines  ")).toBe("many spaces and lines");
    expect(sanitizeCacheStem("课程 #1 % 😀")).toBe("课程 #1 % 😀");
  });

  it("drops leading and trailing dots and spaces, and . / ..", () => {
    expect(sanitizeCacheStem("name. . ")).toBe("name");
    expect(sanitizeCacheStem("...hidden")).toBe("hidden");
    expect(sanitizeCacheStem(".")).toBeUndefined();
    expect(sanitizeCacheStem("..")).toBeUndefined();
    expect(sanitizeCacheStem(" ../ ")).toBeUndefined();
    expect(sanitizeCacheStem("")).toBeUndefined();
    expect(sanitizeCacheStem("\u0001\u0002")).toBeUndefined();
  });

  it("removes a media extension the user typed", () => {
    expect(sanitizeCacheStem("Lecture.MP4")).toBe("Lecture");
    expect(sanitizeCacheStem("talk.mp3")).toBe("talk");
    expect(sanitizeCacheStem("v1.2 release")).toBe("v1.2 release");
    expect(sanitizeCacheStem(".mp4")).toBe("mp4");
  });

  it("escapes device names, also before an inner dot", () => {
    expect(sanitizeCacheStem("CON")).toBe("CON_");
    expect(sanitizeCacheStem("nul")).toBe("nul_");
    expect(sanitizeCacheStem("com1")).toBe("com1_");
    expect(sanitizeCacheStem("LPT9.tar")).toBe("LPT9_.tar");
    expect(sanitizeCacheStem("console")).toBe("console");
    expect(sanitizeCacheStem("COM10")).toBe("COM10");
  });

  it("normalizes to NFC", () => {
    const decomposed = "e\u0301cole";
    expect(sanitizeCacheStem(decomposed)).toBe("\u00e9cole");
  });

  it("caps the stem in code points", () => {
    const long = "😀".repeat(CACHE_FILE_NAME_MAX_CHARS + 20);
    expect(Array.from(sanitizeCacheStem(long) ?? "")).toHaveLength(CACHE_FILE_NAME_MAX_CHARS);
  });

  it("produces only names the store accepts", () => {
    for (const input of ["CON", "a.mp4", "  x  ", "第 1 讲", "LPT1.x", "e\u0301", "a   b"]) {
      const stem = sanitizeCacheStem(input);
      expect(stem).toBeDefined();
      expect(isValidCacheFileName(`${stem}.mp4`), input).toBe(true);
    }
  });
});

describe("fittedCacheStem", () => {
  const dir = "C:\\Users\\someone\\AppData\\Roaming\\Amber\\media";

  it("keeps a short stem as it is and never numbers it", () => {
    expect(fittedCacheStem("课程", dir)).toBe("课程");
    expect(fittedCacheStem("课程 (2)", dir)).toBe("课程 (2)");
  });

  it("budgets the widest labelled partial path in UTF-16 units", () => {
    const longDir = `C:\\${"d".repeat(200)}`;
    const stem = fittedCacheStem("😀".repeat(40), longDir) as string;
    const path = `${longDir}\\${videoCacheFileName(stem, 2160, "webm")}.partial`;
    expect(path.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH_UNITS);
    expect(path.length).toBeGreaterThan(WINDOWS_MAX_PATH_UNITS - 4);
    // Never splits a surrogate pair.
    expect(/[\uD800-\uDBFF]$/u.test(stem)).toBe(false);
  });

  it("keeps the widest label within the budget too", () => {
    const longDir = `C:\\${"d".repeat(150)}`;
    const stem = fittedCacheStem("a".repeat(200), longDir) as string;
    expect(`${longDir}\\${videoCacheFileName(stem, 4320, "webm")}.partial`.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH_UNITS);
  });

  it("escapes a device name the truncation exposes", () => {
    const longDir = `C:\\${"d".repeat(200)}`;
    const budget = WINDOWS_MAX_PATH_UNITS - longDir.length - 1 - " [2160P].webm.partial".length - 1;
    const stem = fittedCacheStem(`CON${" ".repeat(budget - 3)}x`, longDir);
    expect(stem).toBe("CON_");
  });

  it("gives up when the directory alone is too long", () => {
    expect(fittedCacheStem("a", `C:\\${"d".repeat(250)}`)).toBeUndefined();
  });
});

describe("cacheQualityTier", () => {
  it("names a picture after the tier platforms would call it", () => {
    expect(cacheQualityTier(714, 1280)).toBe(720);
    expect(cacheQualityTier(1072, 1920)).toBe(1080);
    expect(cacheQualityTier(1080, 1920)).toBe(1080);
    expect(cacheQualityTier(360, 640)).toBe(360);
    expect(cacheQualityTier(756, 1280)).toBe(720);
    expect(cacheQualityTier(800, 1422)).toBe(1080);
  });

  it("judges portrait, wide-screen and 4:3 pictures by the same equivalent height", () => {
    expect(cacheQualityTier(1920, 1080)).toBe(1080);
    expect(cacheQualityTier(1280, 720)).toBe(720);
    expect(cacheQualityTier(534, 1280)).toBe(720);
    expect(cacheQualityTier(1080, 1440)).toBe(1080);
  });

  it("uses the height alone without a width, maps every tier to itself and keeps sizes beyond the largest tier", () => {
    expect(cacheQualityTier(714)).toBe(720);
    expect(cacheQualityTier(1072)).toBe(1080);
    for (const tier of CACHE_QUALITY_TIERS) expect(cacheQualityTier(tier)).toBe(tier);
    expect(cacheQualityTier(5000)).toBe(5000);
    expect(cacheQualityTier(100, 160)).toBe(144);
  });
});

describe("cache file names", () => {
  it("labels a video with its tier and an upper-case P, and leaves audio unlabelled", () => {
    expect(videoCacheFileName("第 1 讲", 720, "mp4")).toBe("第 1 讲 [720P].mp4");
    expect(videoCacheFileName("第 1 讲", 1080, "webm")).toBe("第 1 讲 [1080P].webm");
    expect(videoCacheFileName("第 1 讲", undefined, "mp4")).toBe("第 1 讲 [?P].mp4");
    expect(labelledStem("a", 2160)).toBe("a [2160P]");
    expect(audioCacheFileName("第 1 讲")).toBe("第 1 讲.mp3");
  });

  it("writes only labelled names the store accepts; the unknown label is for display", () => {
    expect(isValidCacheFileName(videoCacheFileName("a", 720, "mp4"))).toBe(true);
    expect(isValidCacheFileName(videoCacheFileName("a", undefined, "mp4"))).toBe(false);
    expect(isValidCacheFileName(audioCacheFileName("a"))).toBe(true);
  });

  it("compares names the way Windows does", () => {
    expect(sameCacheFileName("Lecture [720P].MP4", "lecture [720P].mp4")).toBe(true);
    expect(sameCacheFileName("a [720P].mp4", "a [1080P].mp4")).toBe(false);
  });
});

describe("cache refs", () => {
  it("builds and reads flat refs", () => {
    expect(cacheRefOf("a.b [720P].mp4")).toBe("media/a.b [720P].mp4");
    expect(isCacheRef("media/a.mp4")).toBe(true);
    expect(isCacheRef("media/a/b.mp4")).toBe(false);
    expect(isCacheRef("assets/u/c/a")).toBe(false);
    expect(cacheFileNameOf("media/a.b.mp4")).toBe("a.b.mp4");
    expect(cacheExtensionOf("video/mp4")).toBe("mp4");
    expect(cacheExtensionOf("video/webm")).toBe("webm");
    expect(cacheExtensionOf("audio/mpeg")).toBe("mp3");
    expect(cacheExtensionOf("audio/flac")).toBeUndefined();
  });

  it("validates names", () => {
    expect(isValidCacheFileName("a.mp4")).toBe(true);
    expect(isValidCacheFileName("a.txt")).toBe(false);
    expect(isValidCacheFileName("../a.mp4")).toBe(false);
    expect(isValidCacheFileName("aux.mp3")).toBe(false);
    expect(isValidCacheFileName("a .mp4")).toBe(false);
    expect(isValidCacheFileName(`${"a".repeat(260)}.mp4`)).toBe(false);
  });
});
