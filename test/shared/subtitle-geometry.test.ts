import { describe, expect, it } from "vitest";
import {
  SUBTITLE_EDGE_ZONE_BP,
  SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES,
  SUBTITLE_SPEAKER_LABEL_SCALE,
  SUBTITLE_SPEAKER_MAX_PARTS,
  SUBTITLE_SPEAKER_REPEAT_MS,
} from "../../src/shared/defaults.ts";
import {
  assColor,
  blockOrigin,
  labelSubtitleCues,
  pictureRect,
  placementFromBlock,
  sliceCues,
  sliceIndexAt,
  sliceSubtitleUnits,
  speakerLabelFontSize,
  subtitleCues,
  subtitleGlyphText,
  subtitleSpeakerLabel,
  subtitleUnitLines,
  type SubtitleSentence,
  type TimedSubtitle,
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

describe("subtitleSpeakerLabel", () => {
  it("keeps a label up to the limit and cuts a longer one there with an ellipsis", () => {
    const exact = "甲".repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES);
    expect(subtitleSpeakerLabel(exact)).toBe(exact);
    expect(subtitleSpeakerLabel(`${exact}乙丙`)).toBe(`${exact}…`);
    expect(subtitleSpeakerLabel("发言人 2")).toBe("发言人 2");
  });

  it("counts grapheme clusters, never splitting one", () => {
    const family = "👨‍👩‍👧";
    const label = family.repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES + 1);
    expect(subtitleSpeakerLabel(label)).toBe(`${family.repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES)}…`);
  });

  it("gives a cut label back unchanged when cut again", () => {
    const cut = subtitleSpeakerLabel("x".repeat(40));
    expect(subtitleSpeakerLabel(cut)).toBe(cut);
  });
});

describe("speaker label look", () => {
  it("is the first line the unit itself shows, in the user's order", () => {
    const head = (unit: { original?: string; translation?: string }, order: "original_first" | "translation_first") => subtitleUnitLines(unit, order)[0]?.line;
    expect(head({ original: "A" }, "translation_first")).toBe("original");
    expect(head({ translation: "甲" }, "original_first")).toBe("translation");
    expect(head({ original: "A", translation: "甲" }, "original_first")).toBe("original");
    expect(head({ original: "A", translation: "甲" }, "translation_first")).toBe("translation");
    // An empty line is not drawn, so it never heads a unit.
    expect(head({ original: "A", translation: "" }, "translation_first")).toBe("original");
    expect(subtitleUnitLines({ original: "A", translation: "甲" }, "translation_first")).toEqual([
      { line: "translation", text: "甲" },
      { line: "original", text: "A" },
    ]);
  });

  it("scales the font size to a whole pixel", () => {
    expect(speakerLabelFontSize(40)).toBe(Math.round(40 * SUBTITLE_SPEAKER_LABEL_SCALE));
    expect(Number.isInteger(speakerLabelFontSize(33))).toBe(true);
  });
});

describe("labelSubtitleCues", () => {
  const LABELS = new Map([
    ["a", "张三"],
    ["b", "李四"],
  ]);
  const cue = (startMs: number, endMs = startMs + 1000): TimedSubtitle => ({ startMs, endMs, original: String(startMs) });
  const shown = (cues: ReturnType<typeof labelSubtitleCues>) => cues.map((item) => (item.labeled ? item.label : undefined));

  it("on change, labels the first cue of each turn; an unassigned sentence ends a turn", () => {
    const cues = [cue(0), cue(1000), cue(2000), cue(3000), cue(4000), cue(5000)];
    expect(shown(labelSubtitleCues(cues, ["a", "a", "b", undefined, "b", "b"], LABELS, "change"))).toEqual(["张三", undefined, "李四", undefined, "李四", undefined]);
  });

  it("on change, labels a long turn again once more than the repeat time has passed since its last label", () => {
    const step = SUBTITLE_SPEAKER_REPEAT_MS / 2;
    const after = SUBTITLE_SPEAKER_REPEAT_MS + 1;
    const cues = [cue(0), cue(step), cue(SUBTITLE_SPEAKER_REPEAT_MS), cue(after), cue(after + step), cue(after * 2)];
    expect(shown(labelSubtitleCues(cues, ["a", "a", "a", "a", "a", "a"], LABELS, "change"))).toEqual(["张三", undefined, undefined, "张三", undefined, "张三"]);
  });

  it("every labels each cue with a speaker, never an unassigned one or one without a label", () => {
    const cues = [cue(0), cue(1000), cue(2000), cue(3000)];
    expect(shown(labelSubtitleCues(cues, ["a", "a", undefined, "unknown"], LABELS, "every"))).toEqual(["张三", "张三", undefined, undefined]);
  });

  describe("crowded cues", () => {
    const NAMES = new Map([
      ["a", "张三"],
      ["b", "李四"],
      ["c", "王五"],
      ["d", "赵六"],
    ]);
    const shownNames = (cues: TimedSubtitle[], ids: (string | undefined)[], mode: "change" | "every" = "change") => shown(labelSubtitleCues(cues, ids, NAMES, mode));
    /** `count` cues of different speakers all on screen during 1000–2000, then one more cue of the last speaker alone. */
    const overlap = (count: number) => {
      const ids = ["a", "b", "c", "d", "a", "b"].slice(0, count);
      const cues: TimedSubtitle[] = ids.map((_, index) => ({ startMs: index * 100, endMs: 2_000 + index * 100, original: `L${index}` }));
      cues.push({ startMs: 5_000, endMs: 6_000, original: "after" });
      return { cues, ids: [...ids, ids.at(-1)] };
    };

    it(`names each of ${SUBTITLE_SPEAKER_MAX_PARTS} overlapping cues, which are not crowded`, () => {
      const { cues, ids } = overlap(SUBTITLE_SPEAKER_MAX_PARTS);
      const labeled = labelSubtitleCues(cues, ids, NAMES, "change");
      expect(labeled.map((item) => item.crowded)).toEqual(cues.map(() => false));
      expect(shown(labeled)).toEqual(["张三", "李四", undefined]);
    });

    for (const count of [SUBTITLE_SPEAKER_MAX_PARTS + 1, SUBTITLE_SPEAKER_MAX_PARTS + 2]) {
      it(`names none of ${count} overlapping cues and gives the name owed to the last one's turn to its next cue`, () => {
        const { cues, ids } = overlap(count);
        const labeled = labelSubtitleCues(cues, ids, NAMES, "change");
        expect(labeled.map((item) => item.crowded)).toEqual([...cues.slice(0, -1).map(() => true), false]);
        const last = NAMES.get(ids.at(-1) as string);
        // Every crowded cue starts a turn; only the last turn goes on, and its next cue carries the name.
        expect(shown(labeled)).toEqual([...cues.slice(0, -1).map(() => undefined), last]);
        expect(labeled.map((item) => item.label)).toEqual(ids.map((id) => NAMES.get(id as string)));
      });
    }

    it("never names a turn that is crowded throughout", () => {
      const { cues, ids } = overlap(SUBTITLE_SPEAKER_MAX_PARTS + 1);
      // The cue after the crowd belongs to someone else: the crowded turns end unnamed.
      expect(shownNames(cues, [...ids.slice(0, -1), "d"])).toEqual([undefined, undefined, undefined, "赵六"]);
    });

    it("runs the repeat time from the last name shown, not from a name the crowd held back", () => {
      // b and c talk over a's first cue; a's turn goes on alone afterwards.
      const cues: TimedSubtitle[] = [
        { startMs: 0, endMs: 3_000, original: "b" },
        { startMs: 0, endMs: 3_000, original: "c" },
        { startMs: 1_000, endMs: 2_000, original: "a1" },
        { startMs: 3_000, endMs: 4_000, original: "a2" },
        { startMs: 3_000 + SUBTITLE_SPEAKER_REPEAT_MS, endMs: 4_000 + SUBTITLE_SPEAKER_REPEAT_MS, original: "a3" },
        { startMs: 3_001 + SUBTITLE_SPEAKER_REPEAT_MS, endMs: 4_001 + SUBTITLE_SPEAKER_REPEAT_MS, original: "a4" },
        { startMs: 5_000 + SUBTITLE_SPEAKER_REPEAT_MS * 2, endMs: 6_000 + SUBTITLE_SPEAKER_REPEAT_MS * 2, original: "a5" },
      ];
      expect(shownNames(cues, ["b", "c", "a", "a", "a", "a", "a"])).toEqual([undefined, undefined, undefined, "张三", undefined, "张三", "张三"]);
    });

    it("holds a repeat the crowd swallowed for the turn's next cue that is not crowded", () => {
      const late = SUBTITLE_SPEAKER_REPEAT_MS + 1;
      const cues: TimedSubtitle[] = [
        { startMs: 0, endMs: 1_000, original: "a0" },
        // Three cues of a's own, on screen together: the repeat falls due on the first of them.
        { startMs: late, endMs: late + 3_000, original: "a1" },
        { startMs: late + 100, endMs: late + 3_000, original: "a2" },
        { startMs: late + 200, endMs: late + 3_000, original: "a3" },
        { startMs: late + 4_000, endMs: late + 5_000, original: "a4" },
        { startMs: late + 6_000, endMs: late + 7_000, original: "a5" },
      ];
      expect(shownNames(cues, ["a", "a", "a", "a", "a", "a"])).toEqual(["张三", undefined, undefined, undefined, "张三", undefined]);
    });

    it("on every, only leaves out the crowded cues", () => {
      const { cues, ids } = overlap(SUBTITLE_SPEAKER_MAX_PARTS + 1);
      cues.push({ startMs: 7_000, endMs: 8_000, original: "next" });
      expect(shownNames(cues, [...ids, "a"], "every")).toEqual([undefined, undefined, undefined, "王五", "张三"]);
    });
  });

  it("cuts long labels and keeps the label on cues the rule leaves bare", () => {
    const long = new Map([["a", "很".repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES + 5)]]);
    const labeled = labelSubtitleCues([cue(0), cue(1000)], ["a", "a"], long, "change");
    expect(labeled.map((item) => [item.label, item.labeled])).toEqual([
      [`${"很".repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES)}…`, true],
      [`${"很".repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES)}…`, false],
    ]);
  });
});

describe("sliceSubtitleUnits", () => {
  const labeled = (cues: TimedSubtitle[], ids: (string | undefined)[]) =>
    labelSubtitleCues(cues, ids, new Map([["a", "张三"], ["b", "李四"], ["c", "王五"]]), "every");

  it("cuts the timeline exactly as sliceCues does", () => {
    const cues = [
      { startMs: 0, endMs: 10, original: "outer" },
      { startMs: 3, endMs: 5, original: "inner" },
      { startMs: 7, endMs: 12, original: "late" },
    ];
    const units = sliceSubtitleUnits(labeled(cues, ["a", "b", "c"]));
    expect(units.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual(sliceCues(cues).map(({ startMs, endMs }) => ({ startMs, endMs })));
  });

  it("keeps two overlapping cues as two units, each with its own speaker", () => {
    const units = sliceSubtitleUnits(
      labeled(
        [
          { startMs: 0, endMs: 2000, original: "A", translation: "甲" },
          { startMs: 1000, endMs: 3000, original: "B", translation: "乙" },
        ],
        ["a", "b"],
      ),
    );
    expect(units[1]).toEqual({
      startMs: 1000,
      endMs: 2000,
      units: [
        { cue: 0, original: "A", translation: "甲", label: "张三", speakerLabel: "张三" },
        { cue: 1, original: "B", translation: "乙", label: "李四", speakerLabel: "李四" },
      ],
    });
  });

  it("drops the labels of cues that ever share the screen with too many others, for their whole display", () => {
    const crowd = Array.from({ length: SUBTITLE_SPEAKER_MAX_PARTS + 1 }, (_, index) => ({ startMs: index * 1000, endMs: 10_000 + index * 1000, original: `L${index}` }));
    const loner = { startMs: 20_000, endMs: 21_000, original: "solo" };
    const units = sliceSubtitleUnits(labeled([...crowd, loner], ["a", "b", "c", "a"]));
    const crowdedSlices = units.filter((slice) => slice.units.some((unit) => unit.cue < crowd.length));
    expect(crowdedSlices.length).toBeGreaterThan(1);
    for (const slice of crowdedSlices) {
      for (const unit of slice.units) {
        expect(unit.speakerLabel).toBeUndefined();
        expect(unit.label).toBeUndefined();
      }
    }
    expect(units.at(-1)?.units).toEqual([{ cue: crowd.length, original: "solo", label: "张三", speakerLabel: "张三" }]);
  });

  it("draws every line and label in its drawn form", () => {
    const [slice] = sliceSubtitleUnits(labelSubtitleCues([{ startMs: 0, endMs: 1, original: "It’s", translation: "他说“好”" }], ["a"], new Map([["a", "O’Neil"]]), "every"));
    expect(slice?.units[0]).toEqual({ cue: 0, original: "It's", translation: "他说“好”", label: "O'Neil", speakerLabel: "O'Neil" });
  });

  it("finds the slice at a time like sliceIndexAt does for plain slices", () => {
    const units = sliceSubtitleUnits(labeled([{ startMs: 0, endMs: 1000, original: "x" }, { startMs: 2000, endMs: 3000, original: "y" }], ["a", "a"]));
    expect([sliceIndexAt(units, 500), sliceIndexAt(units, 1500), sliceIndexAt(units, 2000)]).toEqual([0, -1, 1]);
  });
});
