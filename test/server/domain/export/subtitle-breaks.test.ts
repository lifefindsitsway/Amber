import { describe, expect, it } from "vitest";
import { breakSubtitleLine, type GlyphAdvances } from "../../../../src/server/domain/export/subtitle-breaks.ts";

/** A stand-in font: CJK and full-width forms 1 em, a space a quarter, everything else half an em. */
const GLYPHS: GlyphAdvances = {
  advanceEm(codePoint) {
    if (codePoint === 0x20) return 0.25;
    return codePoint >= 0x2e80 ? 1 : 0.5;
  },
};
/** 10 px per em: a CJK character is 10 px, a Latin letter 5, a space 2.5. */
const EM = 10;
const widthOf = (line: string): number => [...line].reduce((sum, char) => sum + (GLYPHS.advanceEm(char.codePointAt(0) as number) as number) * EM, 0);
const lines = (text: string, maxWidth: number): string[] => breakSubtitleLine(text, maxWidth, EM, GLYPHS);

describe("breakSubtitleLine", () => {
  it("returns a line that fits unchanged, trailing spaces and all", () => {
    expect(lines("今天我们来聊一聊", 80)).toEqual(["今天我们来聊一聊"]);
    expect(lines("short line ", 60)).toEqual(["short line "]);
  });

  it("takes the fewest lines, then evens them out instead of filling the first", () => {
    const text = "一二三四五六七八九十一二三四五六七八九十";
    // Greedy filling at 150 px would give 15 + 5 characters.
    expect(lines(text, 150)).toEqual(["一二三四五六七八九十", "一二三四五六七八九十"]);
    expect(lines(text, 150)).toEqual(lines(text, 150));
  });

  it("never starts a line with closing punctuation", () => {
    const text = "一二三四五六七八九十，一二三四五六七八九";
    const result = lines(text, 150);
    expect(result).toHaveLength(2);
    expect(result.every((line) => !line.startsWith("，"))).toBe(true);
    expect(result.join("")).toBe(text);
    for (const mark of ["。", "、", "！", "？", "）", "」", "』", "】", "》", "…", "ー", "っ", ",", ".", "!", "?", ")"]) {
      const marked = `一二三四五六七八九十${mark}一二三四五六七八九`;
      expect(lines(marked, 150).every((line) => !line.startsWith(mark))).toBe(true);
    }
  });

  it("never ends a line with opening punctuation", () => {
    for (const mark of ["（", "「", "『", "【", "《", "“", "(", "["]) {
      const text = `一二三四五六七八九${mark}十一二三四五六七八九`;
      const result = lines(text, 150);
      expect(result).toHaveLength(2);
      expect(result.every((line) => !line.endsWith(mark))).toBe(true);
      expect(result.join("")).toBe(text);
    }
  });

  it("breaks Latin text only at spaces and drops the space at each break", () => {
    const text = "alpha beta gamma delta epsilon zeta";
    const result = lines(text, 80);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((line) => !line.startsWith(" ") && !line.endsWith(" "))).toBe(true);
    expect(result.join(" ")).toBe(text);
  });

  it("breaks between a Latin word and CJK, never inside the word", () => {
    const result = lines("Amber 是一个借助AI整理音视频资料的工具", 120);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join("").replace(/ /g, "")).toBe("Amber是一个借助AI整理音视频资料的工具");
    expect(result.some((line) => line.includes("Amber"))).toBe(true);
    expect(result.some((line) => line.includes("AI"))).toBe(true);
  });

  it("breaks after a hyphen between letters", () => {
    const result = lines("state-of-the-art", 40);
    expect(result.length).toBeGreaterThan(1);
    expect(result.slice(0, -1).every((line) => line.endsWith("-"))).toBe(true);
    expect(result.join("")).toBe("state-of-the-art");
  });

  it("cuts a run with no break opportunity that is wider than the line on its own", () => {
    const text = "https://example.com/aaaaaaaaaaaaaaaa";
    const result = lines(text, 60);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join("")).toBe(text);
    expect(result.every((line) => widthOf(line) <= 60)).toBe(true);
  });

  it("keeps every line within the width and loses no text, for any mix of scripts", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const alphabet = [..."一二三四五六七八九十，。「」（）abcdefghij  -,.!?"];
    for (let round = 0; round < 300; round += 1) {
      const length = 1 + Math.floor(random() * 60);
      const text = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      const maxWidth = 40 + Math.floor(random() * 200);
      const result = lines(text, maxWidth);
      expect(result.every((line) => widthOf(line.trimEnd()) <= maxWidth)).toBe(true);
      expect(result.join("").replace(/ /g, "")).toBe(text.replace(/ /g, ""));
    }
  });

  it("counts a character the font lacks as a full em", () => {
    const lacking: GlyphAdvances = { advanceEm: (codePoint) => (codePoint === 0x41 ? undefined : 0.5) };
    // Ten A's at 10 px each are 100 px: they do not fit in 60.
    expect(breakSubtitleLine("AAAAA AAAAA", 60, EM, lacking)).toEqual(["AAAAA", "AAAAA"]);
  });
});
