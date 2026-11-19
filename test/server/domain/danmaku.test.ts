import { describe, expect, it } from "vitest";
import { capDanmakuItems, cleanDanmakuText } from "../../../src/server/domain/danmaku.ts";
import { DANMAKU_TEXT_MAX_CHARS } from "../../../src/shared/defaults.ts";
import type { DanmakuItem } from "../../../src/shared/dto/danmaku.ts";

const item = (timeMs: number, weight: number, text = `t${timeMs}`): DanmakuItem => ({ timeMs, mode: "scroll", color: 0xffffff, weight, text });

describe("cleanDanmakuText", () => {
  it("keeps plain text, markup included, as literal text", () => {
    expect(cleanDanmakuText("前方高能")).toBe("前方高能");
    expect(cleanDanmakuText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(cleanDanmakuText("&lt;b&gt;")).toBe("&lt;b&gt;");
  });

  it("turns breaks and tabs into one space, collapses spaces and trims", () => {
    expect(cleanDanmakuText("  a\r\n\tb  \u2028 c\u3000\u3000d ")).toBe("a b c d");
  });

  it("removes control, bidi, zero-width and blank filler characters but keeps emoji joiners", () => {
    expect(cleanDanmakuText("a\u0000b\u0007c\u007f\u0085d")).toBe("abc d");
    expect(cleanDanmakuText("\u202Egnp.exe\u202C\u2066x\u2069")).toBe("gnp.exex");
    expect(cleanDanmakuText("a\u200Bb\uFEFFc\u00ADd\u2060e")).toBe("abcde");
    expect(cleanDanmakuText("\u3164\u115F\u2800\uFFA0")).toBeUndefined();
    expect(cleanDanmakuText("x\uD800y")).toBe("xy");
    expect(cleanDanmakuText("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")).toBe("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
  });

  it("drops text that is empty once cleaned", () => {
    for (const blank of ["", "   ", "\u200B\u200B", "\n\t", "\u0001"]) expect(cleanDanmakuText(blank), JSON.stringify(blank)).toBeUndefined();
  });

  it("caps at the limit in UTF-16 units without splitting a character or an emoji sequence", () => {
    expect(cleanDanmakuText("a".repeat(DANMAKU_TEXT_MAX_CHARS + 50))).toHaveLength(DANMAKU_TEXT_MAX_CHARS);
    const astral = cleanDanmakuText("\u{1F600}".repeat(DANMAKU_TEXT_MAX_CHARS)) as string;
    expect(astral.length).toBe(DANMAKU_TEXT_MAX_CHARS);
    expect(astral).not.toMatch(/\p{Cs}/u);
    const odd = cleanDanmakuText(`a${"\u{1F600}".repeat(DANMAKU_TEXT_MAX_CHARS)}`) as string;
    expect(odd.length).toBe(DANMAKU_TEXT_MAX_CHARS - 1);
    expect(odd).not.toMatch(/\p{Cs}/u);
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const families = cleanDanmakuText(family.repeat(20)) as string;
    expect(families.length).toBeLessThanOrEqual(DANMAKU_TEXT_MAX_CHARS);
    expect(families).toBe(family.repeat(Math.floor(DANMAKU_TEXT_MAX_CHARS / family.length)));
  });
});

describe("capDanmakuItems", () => {
  it("sorts by time, ties in arrival order, and does not truncate within the limit", () => {
    const items = [item(30, 1, "c"), item(10, 1, "a"), item(30, 9, "d"), item(20, 5, "b")];
    expect(capDanmakuItems(items, 4)).toEqual({ items: [items[1], items[3], items[0], items[2]], truncated: false });
    expect(capDanmakuItems([], 4)).toEqual({ items: [], truncated: false });
  });

  it("drops the lowest weights first and spreads the straddling class over time", () => {
    const heavy = [item(5000, 9), item(100, 8)];
    const light = Array.from({ length: 100 }, (_, index) => item(index * 100, 3));
    const lightest = Array.from({ length: 50 }, (_, index) => item(index * 7, 1));
    const capped = capDanmakuItems([...lightest, ...light, ...heavy], 12);
    expect(capped.truncated).toBe(true);
    expect(capped.items).toHaveLength(12);
    expect(capped.items.filter((kept) => kept.weight === 1)).toEqual([]);
    expect(capped.items).toEqual(expect.arrayContaining(heavy));
    const spread = capped.items.filter((kept) => kept.weight === 3).map((kept) => kept.timeMs);
    // Ten of a hundred, one per tenth of the span.
    expect(spread).toEqual([500, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500, 9500]);
    expect(capped.items.map((kept) => kept.timeMs)).toEqual([...capped.items.map((kept) => kept.timeMs)].sort((a, b) => a - b));
  });

  it("keeps exactly the limit when one class alone overflows it", () => {
    const capped = capDanmakuItems(Array.from({ length: 7 }, (_, index) => item(index, 5)), 3);
    expect(capped).toEqual({ items: [item(1, 5), item(3, 5), item(5, 5)], truncated: true });
  });
});
