import { describe, expect, it } from "vitest";
import { SUBTITLE_EDGE_ZONE_BP } from "../../src/shared/defaults.ts";
import {
  assColor,
  blockOrigin,
  pictureRect,
  placementFromBlock,
  sliceCues,
  sliceIndexAt,
  subtitleCues,
  subtitleGlyphText,
  type SubtitleSentence,
} from "../../src/shared/subtitle-geometry.ts";

describe("pictureRect", () => {
  it("drops the letterbox bars of a wide picture in a 16:9 box", () => {
    expect(pictureRect({ width: 1600, height: 900 }, { width: 2100, height: 900 })).toEqual({ x: 0, y: (900 - 1600 * (900 / 2100)) / 2, width: 1600, height: 1600 * (900 / 2100) });
  });

  it("drops the pillar bars of a portrait picture", () => {
    expect(pictureRect({ width: 1600, height: 900 }, { width: 720, height: 1280 })).toEqual({ x: (1600 - 506.25) / 2, y: 0, width: 506.25, height: 900 });
  });

  it("uses the whole box without intrinsic dimensions (audio only, metadata pending)", () => {
    expect(pictureRect({ width: 640, height: 360 }, undefined)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(pictureRect({ width: 640, height: 360 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });
});

describe("assColor", () => {
  it("writes blue-green-red with ASS alpha, 00 opaque", () => {
    expect(assColor("#FF8000")).toBe("&H000080FF");
    expect(assColor("#123456", 100)).toBe("&H00563412");
  });

  it("maps 0% opacity to FF and 50% to 80", () => {
    expect(assColor("#000000", 0)).toBe("&HFF000000");
    expect(assColor("#000000", 50)).toBe("&H80000000");
  });
});

describe("placementFromBlock / blockOrigin", () => {
  const picture = { width: 1920, height: 1080 };

  it("anchors a block near the bottom at its bottom edge", () => {
    expect(placementFromBlock({ x: 760, y: 900, width: 400, height: 90 }, picture)).toEqual({ version: 1, xBp: 5000, yBp: 9167, anchor: "bottom" });
  });

  it("anchors a block near the top at its top edge and one in the middle at its centre", () => {
    expect(placementFromBlock({ x: 0, y: 40, width: 400, height: 90 }, picture).anchor).toBe("top");
    expect(placementFromBlock({ x: 0, y: 500, width: 400, height: 90 }, picture)).toMatchObject({ anchor: "center", yBp: Math.round(((500 + 45) / 1080) * 10000) });
  });

  it("decides a block reaching both zones by the side its centre is on", () => {
    expect(placementFromBlock({ x: 0, y: 200, width: 400, height: 760 }, picture).anchor).toBe("bottom");
    expect(placementFromBlock({ x: 0, y: 100, width: 400, height: 760 }, picture).anchor).toBe("top");
  });

  it("round-trips a rectangle through any anchor", () => {
    for (const rect of [
      { x: 760, y: 900, width: 400, height: 90 },
      { x: 100, y: 40, width: 300, height: 60 },
      { x: 900, y: 480, width: 500, height: 120 },
    ]) {
      const origin = blockOrigin(placementFromBlock(rect, picture), rect, picture);
      expect(Math.abs(origin.left - rect.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(origin.top - rect.y)).toBeLessThanOrEqual(1);
    }
  });

  it("never jumps while a block of any height is dragged across both zone borders", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 200; run += 1) {
      const height = 20 + random() * 500;
      const width = 100 + random() * 1200;
      const x = random() * (picture.width - width);
      let y = -height / 2;
      while (y < picture.height - height / 2) {
        const rect = { x, y, width, height };
        const placement = placementFromBlock(rect, picture);
        const centreBp = ((y + height / 2) / picture.height) * 10000;
        const insidePicture = centreBp >= 0 && centreBp <= 10000 && y >= 0 && y + height <= picture.height;
        if (insidePicture) {
          const origin = blockOrigin(placement, rect, picture);
          expect(Math.abs(origin.top - y)).toBeLessThanOrEqual(1);
          expect(Math.abs(origin.left - x)).toBeLessThanOrEqual(1);
        }
        y += 3 + random() * 9;
      }
    }
  });

  it("uses the configured edge zone", () => {
    const bottomOfZone = ((10000 - SUBTITLE_EDGE_ZONE_BP) / 10000) * 1080;
    expect(placementFromBlock({ x: 0, y: bottomOfZone - 50, width: 10, height: 49 }, picture).anchor).toBe("center");
    expect(placementFromBlock({ x: 0, y: bottomOfZone - 50, width: 10, height: 52 }, picture).anchor).toBe("bottom");
  });
});

const sentence = (id: string, startMs: number, endMs: number, text: string, sources: string[] = []): SubtitleSentence => ({ id, startMs, endMs, text, sourceSegmentIds: sources });

describe("subtitleCues", () => {
  const original = [sentence("o1", 0, 1000, "Hello"), sentence("o2", 1000, 2000, "World")];
  const translation = [sentence("t2", 1000, 2000, "世界", ["o2"]), sentence("t1", 0, 1000, "你好", ["o1"])];

  it("pairs each original sentence with the translation sourced from it", () => {
    expect(subtitleCues("bilingual", original, translation)).toEqual([
      { startMs: 0, endMs: 1000, original: "Hello", translation: "你好" },
      { startMs: 1000, endMs: 2000, original: "World", translation: "世界" },
    ]);
  });

  it("shows an original without a translation alone", () => {
    expect(subtitleCues("bilingual", original, translation.slice(0, 1))[0]).toEqual({ startMs: 0, endMs: 1000, original: "Hello" });
  });

  it("uses one side for the single-language modes", () => {
    expect(subtitleCues("original", original, translation).map((cue) => cue.original)).toEqual(["Hello", "World"]);
    expect(subtitleCues("translation", original, translation).map((cue) => cue.translation)).toEqual(["世界", "你好"]);
  });
});

describe("sliceCues", () => {
  it("returns cues that never overlap unchanged, gaps included", () => {
    const cues = [
      { startMs: 0, endMs: 1000, original: "a" },
      { startMs: 1000, endMs: 1500, original: "b" },
      { startMs: 2000, endMs: 3000, original: "c" },
    ];
    expect(sliceCues(cues)).toEqual(cues);
  });

  it("stacks every cue active in an overlap, in input order", () => {
    expect(
      sliceCues([
        { startMs: 1000, endMs: 3000, original: "A", translation: "甲" },
        { startMs: 2500, endMs: 4000, original: "B", translation: "乙" },
      ]),
    ).toEqual([
      { startMs: 1000, endMs: 2500, original: "A", translation: "甲" },
      { startMs: 2500, endMs: 3000, original: "A\nB", translation: "甲\n乙" },
      { startMs: 3000, endMs: 4000, original: "B", translation: "乙" },
    ]);
  });

  it("handles containment and identical spans", () => {
    expect(
      sliceCues([
        { startMs: 0, endMs: 10, original: "outer" },
        { startMs: 3, endMs: 5, original: "inner" },
        { startMs: 3, endMs: 5, original: "twin" },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 3, original: "outer" },
      { startMs: 3, endMs: 5, original: "outer\ninner\ntwin" },
      { startMs: 5, endMs: 10, original: "outer" },
    ]);
  });

  it("keeps a translation missing on one stacked cue out of the joined line", () => {
    expect(sliceCues([{ startMs: 0, endMs: 2, original: "A" }, { startMs: 1, endMs: 3, original: "B", translation: "乙" }])[1]).toEqual({
      startMs: 1,
      endMs: 2,
      original: "A\nB",
      translation: "乙",
    });
  });
});

describe("sliceIndexAt", () => {
  const slices = sliceCues([
    { startMs: 0, endMs: 1000, original: "a" },
    { startMs: 2000, endMs: 3000, original: "b" },
  ]);

  it("finds the slice with start <= t < end and nothing in gaps", () => {
    expect(sliceIndexAt(slices, 0)).toBe(0);
    expect(sliceIndexAt(slices, 999)).toBe(0);
    expect(sliceIndexAt(slices, 1000)).toBe(-1);
    expect(sliceIndexAt(slices, 2500)).toBe(1);
    expect(sliceIndexAt(slices, 3000)).toBe(-1);
    expect(sliceIndexAt([], 0)).toBe(-1);
  });
});

describe("subtitleGlyphText", () => {
  it("straightens every curly quote of a line without CJK", () => {
    expect(subtitleGlyphText("They’re taking a make-up day off today.")).toBe("They're taking a make-up day off today.");
    expect(subtitleGlyphText("“Hello,” he said.")).toBe('"Hello," he said.');
    expect(subtitleGlyphText("rock ’n’ roll")).toBe("rock 'n' roll");
    expect(subtitleGlyphText("dogs’ bowls")).toBe("dogs' bowls");
    expect(subtitleGlyphText("‘x’ and “y”")).toBe("'x' and \"y\"");
  });

  it("leaves the curly quote pairs of a CJK line alone", () => {
    expect(subtitleGlyphText("这是“老秦”")).toBe("这是“老秦”");
    expect(subtitleGlyphText("他说“Hello”。")).toBe("他说“Hello”。");
    expect(subtitleGlyphText("こんにちは“Hello”")).toBe("こんにちは“Hello”");
  });

  it("still straightens an apostrophe between Latin letters or digits in a CJK line", () => {
    expect(subtitleGlyphText("我喜欢 don’t")).toBe("我喜欢 don't");
    expect(subtitleGlyphText("我喜欢 ‘x’ 和 don’t")).toBe("我喜欢 ‘x’ 和 don't");
    expect(subtitleGlyphText("’90s 的 rock’n’roll 和 90’s")).toBe("’90s 的 rock'n'roll 和 90's");
  });

  it("keeps an apostrophe with CJK on either side", () => {
    expect(subtitleGlyphText("日本語’s")).toBe("日本語’s");
    expect(subtitleGlyphText("a’日本語")).toBe("a’日本語");
  });

  it("returns text without curly quotes unchanged", () => {
    for (const text of ["", "plain 'text' and \"more\"", "你好，世界"]) {
      expect(subtitleGlyphText(text)).toBe(text);
    }
  });

  it("judges a piece of a line by the whole line", () => {
    expect(subtitleGlyphText("It’s", "我喜欢 It’s")).toBe("It's");
    expect(subtitleGlyphText("dogs’", "the dogs’ bowls")).toBe("dogs'");
    expect(subtitleGlyphText("dogs’", "我喜欢 dogs’ bowls")).toBe("dogs’");
    expect(subtitleGlyphText("“Hello”", "他说 “Hello”")).toBe("“Hello”");
  });
});

describe("sliceCues glyphs", () => {
  it("draws each cue's line on its own before joining overlapping cues", () => {
    const [first, second, third] = sliceCues([
      { startMs: 0, endMs: 2000, original: "It’s fine", translation: "他说“好”" },
      { startMs: 1000, endMs: 3000, original: "“Hi”", translation: "“嗨”" },
    ]);
    expect(first?.original).toBe("It's fine");
    expect(second).toMatchObject({ original: 'It\'s fine\n"Hi"', translation: "他说“好”\n“嗨”" });
    expect(third).toMatchObject({ original: '"Hi"', translation: "“嗨”" });
  });
});
