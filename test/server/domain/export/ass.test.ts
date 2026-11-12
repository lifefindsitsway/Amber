import { describe, expect, it } from "vitest";
import { ASS_HEADER, assDialogue, assName, assText, styledAssDocument, type StyledAssOptions } from "../../../../src/server/domain/export/ass.ts";
import { labelSubtitleCues, sliceSubtitleUnits } from "../../../../src/shared/subtitle-geometry.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement, type SubtitleStyle } from "../../../../src/shared/subtitle-style.ts";

describe("ASS", () => {
  it("writes the fixed script info, styles and event format", () => {
    const lines = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "PlayResX: 1920",
      "PlayResY: 1080",
      "WrapStyle: 0",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Noto Sans SC,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,140,140,50,1",
      "Style: Translation,Noto Sans SC,26,&H0000FFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,140,140,50,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];
    expect(lines).toHaveLength(13);
    expect(ASS_HEADER).toBe(`${lines.join("\n")}\n`);
  });

  it("writes one Dialogue per cue, the translation after \\N{\\rTranslation}", () => {
    expect(assDialogue({ startMs: 23_320, endMs: 29_660, text: "原文", translation: "译文" }, { karaoke: false })).toBe(
      "Dialogue: 0,0:00:23.32,0:00:29.66,Default,,0,0,0,,原文\\N{\\rTranslation}译文\n",
    );
  });

  it("keeps user text from becoming override tags or line commands", () => {
    expect(assText("a{\\b1}b\\Nc\nd")).toBe("a｛＼b1｝b＼Nc\\Nd");
  });

  it("times karaoke from real words and gaps, only when asked, and only on the original line", () => {
    const cue = {
      startMs: 1000,
      endMs: 2600,
      text: "Hello world.",
      words: [
        { text: "Hello", startMs: 1000, endMs: 1400 },
        { text: "world.", startMs: 1600, endMs: 2500 },
      ],
      translation: "你好世界",
    };
    expect(assDialogue(cue, { karaoke: true })).toBe(
      "Dialogue: 0,0:00:01.00,0:00:02.60,Default,,0,0,0,,{\\k40}Hello{\\k20}{\\k90} world.\\N{\\rTranslation}你好世界\n",
    );
    expect(assDialogue(cue, { karaoke: false })).not.toContain("{\\k");
  });

  it("draws curly quotes of Latin lines straight, line by line, and leaves everything else as it was", () => {
    expect(assDialogue({ startMs: 0, endMs: 1000, text: "They’re here." }, { karaoke: false })).toBe("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,They're here.\n");
    // The original is Latin and the translation is Chinese: each line is judged on its own.
    expect(assDialogue({ startMs: 0, endMs: 1000, text: "“Hello,” he said.", translation: "他说“你好”" }, { karaoke: false })).toBe(
      'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,"Hello," he said.\\N{\\rTranslation}他说“你好”\n',
    );
    expect(assDialogue({ startMs: 0, endMs: 1000, text: "Hello", translation: "你好" }, { karaoke: false })).toBe("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello\\N{\\rTranslation}你好\n");
  });

  it("keeps karaoke words matching the sentence once its quotes are drawn straight", () => {
    const cue = {
      startMs: 0,
      endMs: 1500,
      text: "They’re “here”.",
      words: [
        { text: "They’re", startMs: 0, endMs: 500 },
        { text: "“here”.", startMs: 600, endMs: 1500 },
      ],
    };
    expect(assDialogue(cue, { karaoke: true })).toBe('Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,{\\k50}They\'re{\\k10}{\\k90} "here".\n');
    // A Chinese sentence keeps its quote pair; only the Latin apostrophe changes.
    const mixed = { startMs: 0, endMs: 1000, text: "他说“don’t”", words: [{ text: "他说“don’t”", startMs: 0, endMs: 1000 }] };
    expect(assDialogue(mixed, { karaoke: true })).toBe("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\k100}他说“don't”\n");
  });

  it("gives a zero-length word {\\k0} and keeps CJK text as spoken", () => {
    const line = assDialogue(
      {
        startMs: 3000,
        endMs: 4000,
        text: "你好世界",
        words: [
          { text: "你好", startMs: 3000, endMs: 3500 },
          { text: "世界", startMs: 3500, endMs: 3500 },
        ],
      },
      { karaoke: true },
    );
    expect(line.endsWith(",,{\\k50}你好{\\k0}世界\n")).toBe(true);
  });
});

function style(overrides: { appearance?: Partial<SubtitleStyle["appearance"]>; placement?: Partial<SubtitleStyle["placement"]> } = {}): SubtitleStyle {
  return {
    appearance: { ...defaultSubtitleAppearance(), ...overrides.appearance },
    placement: { ...defaultSubtitlePlacement(), ...overrides.placement },
  };
}

const FILE: Omit<StyledAssOptions, "style"> = { mode: "bilingual", playRes: { width: 1920, height: 1080 }, textOnly: false };

const dialogues = (document: string): string[] => document.split("\n").filter((line) => line.startsWith("Dialogue:"));
const styles = (document: string): string[] => document.split("\n").filter((line) => line.startsWith("Style:"));

describe("styled ASS", () => {
  it("writes the canvas, wrap margins and text styles from the style, without karaoke", () => {
    const document = styledAssDocument([{ startMs: 0, endMs: 1500, original: "原文" }], { ...FILE, style: style() });
    expect(document.startsWith("[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n")).toBe(true);
    // Margins: round((1 - 0.8) / 2 * 1920) = 192; Fontsize 48 / 44; outline on, width 2; Shadow 0; MarginV 0.
    expect(styles(document)).toEqual([
      "Style: Default,Noto Sans SC,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,2,192,192,0,1",
      "Style: Translation,Noto Sans SC,44,&H0000FFFF,&H0000FFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,2,192,192,0,1",
    ]);
    // Bottom anchor at (5000, 9200) bp of 1920 x 1080.
    expect(dialogues(document)).toEqual(["Dialogue: 1,0:00:00.00,0:00:01.50,Default,,0,0,0,,{\\an2\\pos(960,994)}原文"]);
    expect(document).toContain("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    expect(document).not.toContain("{\\k");
  });

  it("maps colours to &HAABBGGRR and drops the outline width when the outline is off", () => {
    const document = styledAssDocument([{ startMs: 0, endMs: 1000, original: "a" }], {
      ...FILE,
      style: style({
        appearance: {
          original: { fontSize: 60, color: "#123456" },
          outline: { enabled: false, color: "#ABCDEF", width: 5 },
        },
      }),
    });
    expect(styles(document)[0]).toBe("Style: Default,Noto Sans SC,60,&H00563412,&H00563412,&H00EFCDAB,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,2,192,192,0,1");
  });

  it("positions every anchor with its numpad alignment on the given canvas", () => {
    const cue = [{ startMs: 0, endMs: 1000, original: "a" }];
    const at = (anchor: SubtitleStyle["placement"]["anchor"]) =>
      dialogues(styledAssDocument(cue, { style: style({ placement: { xBp: 2500, yBp: 1000, anchor } }), mode: "original", playRes: { width: 1440, height: 1080 }, textOnly: false }))[0];
    expect(at("top")).toContain(",,{\\an8\\pos(360,108)}a");
    expect(at("center")).toContain(",,{\\an5\\pos(360,108)}a");
    expect(at("bottom")).toContain(",,{\\an2\\pos(360,108)}a");
    const header = styledAssDocument(cue, { style: style({ placement: { xBp: 2500, yBp: 1000, anchor: "top" } }), mode: "original", playRes: { width: 1440, height: 1080 }, textOnly: false });
    // round(0.1 * 1440) = 144; the style's own alignment agrees with the tag.
    expect(styles(header)[0]).toContain(",1,2,0,8,144,144,0,1");
  });

  it("draws the background box as its own layer-0 event under the layer-1 text, with the same position", () => {
    const boxed = style({ appearance: { background: { enabled: true, color: "#102030", opacityPct: 50, padding: 12, scope: "both" } } });
    const document = styledAssDocument([{ startMs: 0, endMs: 1000, original: "原文", translation: "译文" }], { ...FILE, style: boxed });
    expect(styles(document).slice(2)).toEqual([
      "Style: Box,Noto Sans SC,48,&HFF000000,&HFF000000,&HFF000000,&H80302010,0,0,0,0,100,100,0,0,4,12,0,2,192,192,0,1",
      "Style: BoxTranslation,Noto Sans SC,44,&HFF000000,&HFF000000,&HFF000000,&H80302010,0,0,0,0,100,100,0,0,4,12,0,2,192,192,0,1",
    ]);
    expect(dialogues(document)).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:01.00,Box,,0,0,0,,{\\an2\\pos(960,994)}原文\\N{\\rBoxTranslation}译文",
      "Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an2\\pos(960,994)}原文\\N{\\rTranslation}译文",
    ]);
  });

  it("leaves the box out entirely for a text-only track", () => {
    const boxed = style({ appearance: { background: { enabled: true, color: "#000000", opacityPct: 50, padding: 12, scope: "both" } } });
    const document = styledAssDocument([{ startMs: 0, endMs: 1000, original: "原文" }], { ...FILE, style: boxed, textOnly: true });
    expect(styles(document).map((line) => line.split(",")[0])).toEqual(["Style: Default", "Style: Translation"]);
    expect(dialogues(document)).toEqual(["Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an2\\pos(960,994)}原文"]);
  });

  it("boxes only the chosen bilingual line, laid out by a transparent ghost of the other", () => {
    const lineBoxed = (scope: "original" | "translation", bilingualOrder: "original_first" | "translation_first" = "original_first") =>
      style({ appearance: { bilingualOrder, background: { enabled: true, color: "#102030", opacityPct: 50, padding: 12, scope } } });
    const cue = [{ startMs: 0, endMs: 1000, original: "原文", translation: "译文" }];
    const translationOnly = styledAssDocument(cue, { ...FILE, style: lineBoxed("translation") });
    // Line*: BorderStyle 3, the box is the outline colour; Ghost*: everything transparent, no outline.
    expect(styles(translationOnly).slice(2)).toEqual([
      "Style: Line,Noto Sans SC,48,&HFF000000,&HFF000000,&H80302010,&HFF000000,0,0,0,0,100,100,0,0,3,12,0,2,192,192,0,1",
      "Style: LineTranslation,Noto Sans SC,44,&HFF000000,&HFF000000,&H80302010,&HFF000000,0,0,0,0,100,100,0,0,3,12,0,2,192,192,0,1",
      "Style: Ghost,Noto Sans SC,48,&HFF000000,&HFF000000,&HFF000000,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,2,192,192,0,1",
      "Style: GhostTranslation,Noto Sans SC,44,&HFF000000,&HFF000000,&HFF000000,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,2,192,192,0,1",
    ]);
    expect(dialogues(translationOnly)).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:01.00,Ghost,,0,0,0,,{\\an2\\pos(960,994)}原文\\N{\\rLineTranslation}译文",
      "Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an2\\pos(960,994)}原文\\N{\\rTranslation}译文",
    ]);
    expect(dialogues(styledAssDocument(cue, { ...FILE, style: lineBoxed("original") }))[0]).toBe(
      "Dialogue: 0,0:00:00.00,0:00:01.00,Line,,0,0,0,,{\\an2\\pos(960,994)}原文\\N{\\rGhostTranslation}译文",
    );
    expect(dialogues(styledAssDocument(cue, { ...FILE, style: lineBoxed("translation", "translation_first") }))).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:01.00,LineTranslation,,0,0,0,,{\\an2\\pos(960,994)}译文\\N{\\rGhost}原文",
      "Dialogue: 1,0:00:00.00,0:00:01.00,Translation,,0,0,0,,{\\an2\\pos(960,994)}译文\\N{\\rDefault}原文",
    ]);
    expect(dialogues(styledAssDocument(cue, { ...FILE, style: lineBoxed("original", "translation_first") }))[0]).toBe(
      "Dialogue: 0,0:00:00.00,0:00:01.00,GhostTranslation,,0,0,0,,{\\an2\\pos(960,994)}译文\\N{\\rLine}原文",
    );
  });

  it("skips the one-line box of a slice without the chosen line", () => {
    const boxed = style({ appearance: { background: { enabled: true, color: "#102030", opacityPct: 50, padding: 12, scope: "translation" } } });
    const cues = [
      { startMs: 0, endMs: 1000, original: "原文", translation: "译文" },
      { startMs: 1000, endMs: 2000, original: "未配对" },
    ];
    expect(dialogues(styledAssDocument(cues, { ...FILE, style: boxed }))).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:01.00,Ghost,,0,0,0,,{\\an2\\pos(960,994)}原文\\N{\\rLineTranslation}译文",
      "Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an2\\pos(960,994)}原文\\N{\\rTranslation}译文",
      "Dialogue: 1,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an2\\pos(960,994)}未配对",
    ]);
  });

  it("keeps a one-line box at least 1 wide, since BorderStyle 3 draws nothing at Outline 0", () => {
    const boxed = style({ appearance: { background: { enabled: true, color: "#102030", opacityPct: 50, padding: 0, scope: "original" } } });
    const lines = styles(styledAssDocument([{ startMs: 0, endMs: 1000, original: "原文", translation: "译文" }], { ...FILE, style: boxed }));
    expect(lines.filter((line) => line.startsWith("Style: Line")).map((line) => line.split(",").slice(15, 17).join(","))).toEqual(["3,1", "3,1"]);
  });

  it("boxes the whole block in a single-language mode whatever the scope", () => {
    const withScope = (scope: "both" | "translation") => style({ appearance: { background: { enabled: true, color: "#102030", opacityPct: 50, padding: 12, scope } } });
    const original = [{ startMs: 0, endMs: 1000, original: "原文" }];
    const translation = [{ startMs: 0, endMs: 1000, translation: "译文" }];
    const both = styledAssDocument(original, { ...FILE, mode: "original", style: withScope("both") });
    expect(styledAssDocument(original, { ...FILE, mode: "original", style: withScope("translation") })).toBe(both);
    expect(styles(both).slice(2).map((line) => line.split(",")[0])).toEqual(["Style: Box", "Style: BoxTranslation"]);
    expect(styledAssDocument(translation, { ...FILE, mode: "translation", style: withScope("translation") })).toBe(
      styledAssDocument(translation, { ...FILE, mode: "translation", style: withScope("both") }),
    );
  });

  it("leaves a one-line box out entirely for a text-only track", () => {
    const boxed = style({ appearance: { background: { enabled: true, color: "#102030", opacityPct: 50, padding: 12, scope: "translation" } } });
    const document = styledAssDocument([{ startMs: 0, endMs: 1000, original: "原文", translation: "译文" }], { ...FILE, style: boxed, textOnly: true });
    expect(styles(document).map((line) => line.split(",")[0])).toEqual(["Style: Default", "Style: Translation"]);
    expect(dialogues(document).map((line) => line.split(",")[0])).toEqual(["Dialogue: 1"]);
  });

  it("puts the translation first when asked, and shows a translation alone in its own appearance", () => {
    const boxed = style({ appearance: { bilingualOrder: "translation_first", background: { enabled: true, color: "#000000", opacityPct: 50, padding: 12, scope: "both" } } });
    expect(dialogues(styledAssDocument([{ startMs: 0, endMs: 1000, original: "原文", translation: "译文" }], { ...FILE, style: boxed }))).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:01.00,BoxTranslation,,0,0,0,,{\\an2\\pos(960,994)}译文\\N{\\rBox}原文",
      "Dialogue: 1,0:00:00.00,0:00:01.00,Translation,,0,0,0,,{\\an2\\pos(960,994)}译文\\N{\\rDefault}原文",
    ]);
    expect(dialogues(styledAssDocument([{ startMs: 0, endMs: 1000, translation: "译文" }], { ...FILE, style: style() }))).toEqual([
      "Dialogue: 1,0:00:00.00,0:00:01.00,Translation,,0,0,0,,{\\an2\\pos(960,994)}译文",
    ]);
  });

  it("cuts overlapping cues into slices that stack the active lines", () => {
    const document = styledAssDocument(
      [
        { startMs: 0, endMs: 2000, original: "一" },
        { startMs: 1000, endMs: 3000, original: "二" },
      ],
      { ...FILE, style: style() },
    );
    expect(dialogues(document).map((line) => line.replace(/,Default,,0,0,0,,\{[^}]*\}/u, " "))).toEqual([
      "Dialogue: 1,0:00:00.00,0:00:01.00 一",
      "Dialogue: 1,0:00:01.00,0:00:02.00 一\\N二",
      "Dialogue: 1,0:00:02.00,0:00:03.00 二",
    ]);
  });

  it("never lets subtitle text become tags or line commands", () => {
    const document = styledAssDocument([{ startMs: 0, endMs: 1000, original: "a{\\b1}b\\Nc\nd", translation: "{\\rDefault}x" }], { ...FILE, style: style() });
    expect(dialogues(document)).toEqual([
      "Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an2\\pos(960,994)}a｛＼b1｝b＼Nc\\Nd\\N{\\rTranslation}｛＼rDefault｝x",
    ]);
  });
});

describe("styled ASS glyphs", () => {
  it("draws each line of a slice straight or curly on its own before joining them", () => {
    const document = styledAssDocument(
      [
        { startMs: 0, endMs: 2000, original: "They’re here", translation: "他说“来了”" },
        { startMs: 1000, endMs: 3000, original: "“Hi,” she said", translation: "她说“嗨”" },
      ],
      { ...FILE, style: style() },
    );
    const texts = dialogues(document)
      .filter((line) => line.startsWith("Dialogue: 1,"))
      .map((line) => line.split("{\\an2\\pos(960,994)}")[1]);
    expect(texts).toEqual([
      "They're here\\N{\\rTranslation}他说“来了”",
      'They\'re here\\N"Hi," she said\\N{\\rTranslation}他说“来了”\\N她说“嗨”',
      '"Hi," she said\\N{\\rTranslation}她说“嗨”',
    ]);
  });

  it("is unchanged for text without curly quotes", () => {
    const document = styledAssDocument([{ startMs: 0, endMs: 1500, original: "a 'b' \"c\"", translation: "原文" }], { ...FILE, style: style() });
    expect(dialogues(document).at(-1)).toBe("Dialogue: 1,0:00:00.00,0:00:01.50,Default,,0,0,0,,{\\an2\\pos(960,994)}a 'b' \"c\"\\N{\\rTranslation}原文");
  });
});

describe("ASS speaker names", () => {
  const cue = { startMs: 0, endMs: 1000, text: "原文" };

  it("fills the Name field of the fixed-style Dialogue, and leaves it empty without a speaker", () => {
    expect(assDialogue(cue, { karaoke: false, speaker: "张三" })).toBe("Dialogue: 0,0:00:00.00,0:00:01.00,Default,张三,0,0,0,,原文\n");
    expect(assDialogue(cue, { karaoke: false })).toBe("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,原文\n");
  });

  it("keeps a name from breaking the field: commas become full-width, line breaks spaces", () => {
    expect(assName("Smith, John")).toBe("Smith， John");
    expect(assName("a\nb\r\nc")).toBe("a b c");
    expect(assName(undefined)).toBe("");
    expect(assName("**x_y** <b>& 👨‍👩‍👧")).toBe("**x_y** <b>& 👨‍👩‍👧");
    expect(assDialogue(cue, { karaoke: false, speaker: "A,B" }).split(",")).toHaveLength(10);
  });

  const speakers = (ofCue: readonly (string | undefined)[]) => ({ ofCue, names: new Map([["a", "甲"], ["b", "乙"], ["a2", "甲"]]) });
  const doc = (cues: Parameters<typeof styledAssDocument>[0], ofCue?: readonly (string | undefined)[], textOnly = false) =>
    styledAssDocument(cues, { ...FILE, mode: "original", textOnly, style: style(), ...(ofCue === undefined ? {} : { speakers: speakers(ofCue) }) });

  it("names styled slices and both layers of a boxed slice", () => {
    const boxed = styledAssDocument([{ startMs: 0, endMs: 1000, original: "x" }], {
      ...FILE,
      mode: "original",
      style: style({ appearance: { background: { ...defaultSubtitleAppearance().background, enabled: true, scope: "both" } } }),
      speakers: speakers(["a"]),
    });
    expect(dialogues(boxed).map((line) => line.split(",")[4])).toEqual(["甲", "甲"]);
    expect(dialogues(doc([{ startMs: 0, endMs: 1000, original: "x" }], ["a"]))[0]).toContain(",Default,甲,0,0,0,,");
  });

  it("leaves Name empty for a slice that mixes speakers, or a speaker and an unassigned sentence", () => {
    const cues = [
      { startMs: 0, endMs: 3000, original: "长" },
      { startMs: 1000, endMs: 2000, original: "插" },
      { startMs: 5000, endMs: 6000, original: "独" },
    ];
    expect(dialogues(doc(cues, ["a", "b", undefined])).map((line) => line.split(",")[4])).toEqual(["甲", "", "甲", ""]);
    // A speaker over an unassigned sentence is mixed too; an unassigned sentence alone has no name.
    expect(dialogues(doc(cues, ["a", undefined, undefined])).map((line) => line.split(",")[4])).toEqual(["甲", "", "甲", ""]);
    // The same speaker on both overlapping sentences is still one speaker.
    expect(dialogues(doc(cues, ["a", "a", "b"])).map((line) => line.split(",")[4])).toEqual(["甲", "甲", "甲", "乙"]);
  });

  it("compares speakers by id: two speakers with the same name are still two", () => {
    const cues = [{ startMs: 0, endMs: 2000, original: "一" }, { startMs: 1000, endMs: 3000, original: "二" }];
    expect(dialogues(doc(cues, ["a", "a2"])).map((line) => line.split(",")[4])).toEqual(["甲", "", "甲"]);
  });

  it("is byte for byte the output without speakers when none are given or none apply", () => {
    const cues = [{ startMs: 0, endMs: 3000, original: "长", translation: "T" }, { startMs: 1000, endMs: 2000, original: "插" }];
    const plain = styledAssDocument(cues, { ...FILE, style: style() });
    expect(plain).toBe(styledAssDocument(cues, { ...FILE, style: style(), speakers: { ofCue: [undefined, undefined], names: new Map() } }));
    expect(doc(cues, [undefined, undefined])).toBe(styledAssDocument(cues, { ...FILE, mode: "original", style: style() }));
  });
});

describe("legacy ASS", () => {
  it("is unchanged byte for byte", () => {
    expect(ASS_HEADER).toBe(
      "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\n" +
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
        "Style: Default,Noto Sans SC,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,140,140,50,1\n" +
        "Style: Translation,Noto Sans SC,26,&H0000FFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,140,140,50,1\n\n" +
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
  });
});

describe("styled ASS speaker label lines", () => {
  const LABELS = new Map([
    ["a", "张三"],
    ["b", "李四"],
    ["c", "王五"],
  ]);
  const labelled = (speaker: "change" | "every", appearance: Partial<SubtitleStyle["appearance"]> = {}) => style({ appearance: { ...appearance, speaker } });
  const withLines = (cues: Parameters<typeof styledAssDocument>[0], ofCue: readonly (string | undefined)[], options: Omit<StyledAssOptions, "playRes" | "textOnly"> & { textOnly?: boolean }) =>
    styledAssDocument(cues, { playRes: FILE.playRes, textOnly: options.textOnly ?? false, ...options, speakerLines: { ofCue, labels: LABELS } });
  const BOXES = {
    none: {},
    block: { background: { enabled: true, color: "#102030", opacityPct: 50, padding: 12, scope: "both" as const } },
    line: { background: { enabled: true, color: "#102030", opacityPct: 50, padding: 12, scope: "translation" as const } },
  };
  const cue = { startMs: 0, endMs: 1000, original: "原文", translation: "译文" };
  /** An event's rows with the style switches taken out: what both layers must lay out alike. */
  const rowsOf = (dialogue: string) => dialogue.slice(dialogue.indexOf("}") + 1).split("\\N").map((row) => row.replace(/^\{\\r[A-Za-z]+\}/u, ""));

  it("is byte for byte the output without labels while the appearance does not ask for them, or for a text-only track", () => {
    const cues = [cue, { startMs: 500, endMs: 1500, original: "插" }];
    for (const box of Object.values(BOXES)) {
      const plain = styledAssDocument(cues, { ...FILE, style: style({ appearance: box }) });
      expect(withLines(cues, ["a", "b"], { mode: "bilingual", style: style({ appearance: box }) })).toBe(plain);
      expect(styledAssDocument(cues, { ...FILE, style: labelled("every", box) })).toBe(plain);
      const textOnly = styledAssDocument(cues, { ...FILE, textOnly: true, style: style({ appearance: box }) });
      expect(withLines(cues, ["a", "b"], { mode: "bilingual", textOnly: true, style: labelled("every", box) })).toBe(textOnly);
    }
  });

  it("adds a Speaker style sized and coloured after the first line shown, and its box counterparts", () => {
    const sizeOf = (line: string) => line.split(",")[2];
    const plainStyles = styles(withLines([cue], ["a"], { mode: "bilingual", style: labelled("every") }));
    expect(plainStyles.map((line) => line.split(",")[0])).toEqual(["Style: Default", "Style: Translation", "Style: Speaker"]);
    // 48 × 0.7 rounded; the original's colour and the shared outline.
    expect(plainStyles[2]).toBe("Style: Speaker,Noto Sans SC,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,2,192,192,0,1");
    const translationFirst = styles(withLines([cue], ["a"], { mode: "bilingual", style: labelled("every", { bilingualOrder: "translation_first" }) }))[2] as string;
    expect([sizeOf(translationFirst), translationFirst.split(",")[3]]).toEqual(["31", styles(withLines([cue], ["a"], { mode: "bilingual", style: labelled("every") }))[1]?.split(",")[3]]);
    expect(sizeOf(styles(withLines([{ startMs: 0, endMs: 1, translation: "t" }], ["a"], { mode: "translation", style: labelled("every") }))[2] as string)).toBe("31");
    expect(styles(withLines([cue], ["a"], { mode: "bilingual", style: labelled("every", BOXES.block) })).map((line) => line.split(",")[0])).toEqual([
      "Style: Default",
      "Style: Translation",
      "Style: Speaker",
      "Style: Box",
      "Style: BoxTranslation",
      "Style: BoxSpeaker",
    ]);
    const lineStyles = styles(withLines([cue], ["a"], { mode: "bilingual", style: labelled("every", BOXES.line) }));
    expect(lineStyles.map((line) => line.split(",")[0])).toEqual([
      "Style: Default",
      "Style: Translation",
      "Style: Speaker",
      "Style: Line",
      "Style: LineTranslation",
      "Style: LineSpeaker",
      "Style: Ghost",
      "Style: GhostTranslation",
      "Style: GhostSpeaker",
    ]);
    expect(lineStyles[5]).toBe("Style: LineSpeaker,Noto Sans SC,34,&HFF000000,&HFF000000,&H80302010,&HFF000000,0,0,0,0,100,100,0,0,3,12,0,2,192,192,0,1");
  });

  it("writes the label line inside the same event, in all three modes and box kinds, both layers with the same rows", () => {
    const shapes = {
      original: { cue: { startMs: 0, endMs: 1000, original: "原文" }, rows: ["张三", "原文"] },
      translation: { cue: { startMs: 0, endMs: 1000, translation: "译文" }, rows: ["张三", "译文"] },
      bilingual: { cue, rows: ["张三", "原文", "译文"] },
    } as const;
    for (const [mode, shape] of Object.entries(shapes) as Array<[keyof typeof shapes, (typeof shapes)[keyof typeof shapes]]>) {
      for (const [kind, box] of Object.entries(BOXES)) {
        const events = dialogues(withLines([shape.cue], ["a"], { mode, style: labelled("change", box) }));
        expect(events.length, `${mode} ${kind}`).toBe(kind === "none" ? 1 : 2);
        for (const event of events) expect(rowsOf(event), `${mode} ${kind}`).toEqual(shape.rows);
      }
    }
    expect(dialogues(withLines([cue], ["a"], { mode: "bilingual", style: labelled("change", BOXES.block) }))).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:01.00,BoxSpeaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rBox}原文\\N{\\rBoxTranslation}译文",
      "Dialogue: 1,0:00:00.00,0:00:01.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rDefault}原文\\N{\\rTranslation}译文",
    ]);
  });

  it("boxes a label in a one-line box exactly when it boxes the line the label heads", () => {
    expect(dialogues(withLines([cue], ["a"], { mode: "bilingual", style: labelled("every", BOXES.line) }))[0]).toBe(
      "Dialogue: 0,0:00:00.00,0:00:01.00,GhostSpeaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rGhost}原文\\N{\\rLineTranslation}译文",
    );
    expect(dialogues(withLines([cue], ["a"], { mode: "bilingual", style: labelled("every", { ...BOXES.line, bilingualOrder: "translation_first" }) }))).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:01.00,LineSpeakerTranslation,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rLineTranslation}译文\\N{\\rGhost}原文",
      "Dialogue: 1,0:00:00.00,0:00:01.00,SpeakerTranslation,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rTranslation}译文\\N{\\rDefault}原文",
    ]);
    // A slice without the boxed line has no background event, label or not.
    expect(dialogues(withLines([{ startMs: 0, endMs: 1000, original: "未配对" }], ["a"], { mode: "bilingual", style: labelled("every", BOXES.line) }))).toEqual([
      "Dialogue: 1,0:00:00.00,0:00:01.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rDefault}未配对",
    ]);
  });

  it("stacks two overlapping cues as two units, each under its own label", () => {
    const cues = [
      { startMs: 0, endMs: 2000, original: "A" },
      { startMs: 1000, endMs: 3000, original: "B" },
    ];
    expect(dialogues(withLines(cues, ["a", "b"], { mode: "original", style: labelled("change") }))).toEqual([
      "Dialogue: 1,0:00:00.00,0:00:01.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rDefault}A",
      "Dialogue: 1,0:00:01.00,0:00:02.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rDefault}A\\N{\\rSpeaker}李四\\N{\\rDefault}B",
      "Dialogue: 1,0:00:02.00,0:00:03.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}李四\\N{\\rDefault}B",
    ]);
  });

  it("writes no label for cues that share the screen with too many others", () => {
    const cues = [
      { startMs: 0, endMs: 3000, original: "A" },
      { startMs: 1000, endMs: 3000, original: "B" },
      { startMs: 2000, endMs: 3000, original: "C" },
      { startMs: 4000, endMs: 5000, original: "D" },
    ];
    const events = dialogues(withLines(cues, ["a", "b", "c", "a"], { mode: "original", style: labelled("every") }));
    expect(events.slice(0, 3).every((event) => !event.includes("张三") && !event.includes("李四") && !event.includes("王五"))).toBe(true);
    expect(events[3]).toBe("Dialogue: 1,0:00:04.00,0:00:05.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rDefault}D");
  });

  describe("label look per cue", () => {
    const translationFirst = (box: Partial<SubtitleStyle["appearance"]> = {}) => labelled("every", { ...box, bilingualOrder: "translation_first" });
    const unpaired = { startMs: 0, endMs: 1000, original: "未配对" };
    const paired = { startMs: 2000, endMs: 3000, original: "原文", translation: "译文" };
    const names = (document: string) => styles(document).map((line) => line.split(",")[0]);

    it("labels a cue without a translation in the original's look even when the translation goes first", () => {
      const document = withLines([unpaired], ["a"], { mode: "bilingual", style: translationFirst() });
      // The original's size (48 × 0.7) and colour, never the translation's 31 and yellow.
      expect(styles(document)).toEqual([
        "Style: Default,Noto Sans SC,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,2,192,192,0,1",
        "Style: Translation,Noto Sans SC,44,&H0000FFFF,&H0000FFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,2,192,192,0,1",
        "Style: Speaker,Noto Sans SC,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,2,192,192,0,1",
      ]);
      expect(dialogues(document)).toEqual(["Dialogue: 1,0:00:00.00,0:00:01.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rDefault}未配对"]);
    });

    it("writes both label sets when cues head with either line, each event with its own", () => {
      const plain = withLines([unpaired, paired], ["a", "b"], { mode: "bilingual", style: translationFirst() });
      expect(names(plain)).toEqual(["Style: Default", "Style: Translation", "Style: Speaker", "Style: SpeakerTranslation"]);
      expect(styles(plain)[3]).toBe("Style: SpeakerTranslation,Noto Sans SC,31,&H0000FFFF,&H0000FFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,2,192,192,0,1");
      expect(dialogues(plain).map((line) => line.split(",")[3])).toEqual(["Speaker", "SpeakerTranslation"]);
      const block = withLines([unpaired, paired], ["a", "b"], { mode: "bilingual", style: translationFirst(BOXES.block) });
      expect(names(block)).toEqual(["Style: Default", "Style: Translation", "Style: Speaker", "Style: SpeakerTranslation", "Style: Box", "Style: BoxTranslation", "Style: BoxSpeaker", "Style: BoxSpeakerTranslation"]);
      expect(styles(block)[7]).toBe("Style: BoxSpeakerTranslation,Noto Sans SC,31,&HFF000000,&HFF000000,&HFF000000,&H80302010,0,0,0,0,100,100,0,0,4,12,0,2,192,192,0,1");
      expect(dialogues(block)).toEqual([
        "Dialogue: 0,0:00:00.00,0:00:01.00,BoxSpeaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rBox}未配对",
        "Dialogue: 1,0:00:00.00,0:00:01.00,Speaker,,0,0,0,,{\\an2\\pos(960,994)}张三\\N{\\rDefault}未配对",
        "Dialogue: 0,0:00:02.00,0:00:03.00,BoxSpeakerTranslation,,0,0,0,,{\\an2\\pos(960,994)}李四\\N{\\rBoxTranslation}译文\\N{\\rBox}原文",
        "Dialogue: 1,0:00:02.00,0:00:03.00,SpeakerTranslation,,0,0,0,,{\\an2\\pos(960,994)}李四\\N{\\rTranslation}译文\\N{\\rDefault}原文",
      ]);
      const line = withLines([unpaired, paired], ["a", "b"], { mode: "bilingual", style: translationFirst(BOXES.line) });
      expect(names(line)).toEqual([
        "Style: Default",
        "Style: Translation",
        "Style: Speaker",
        "Style: SpeakerTranslation",
        "Style: Line",
        "Style: LineTranslation",
        "Style: LineSpeaker",
        "Style: LineSpeakerTranslation",
        "Style: Ghost",
        "Style: GhostTranslation",
        "Style: GhostSpeaker",
        "Style: GhostSpeakerTranslation",
      ]);
      for (const document of [plain, block, line]) {
        const events = dialogues(document);
        const [first, second] = [events.filter((event) => event.includes("0:00:00.00")), events.filter((event) => event.includes("0:00:02.00"))];
        for (const group of [first, second]) for (const event of group) expect(rowsOf(event)).toEqual(rowsOf(group.at(-1) as string));
      }
    });

    it("writes only the original set when every label heads an original line, and none when no label is shown", () => {
      expect(names(withLines([paired], ["a"], { mode: "bilingual", style: labelled("every", BOXES.line) }))).toEqual([
        "Style: Default",
        "Style: Translation",
        "Style: Speaker",
        "Style: Line",
        "Style: LineTranslation",
        "Style: LineSpeaker",
        "Style: Ghost",
        "Style: GhostTranslation",
        "Style: GhostSpeaker",
      ]);
      const crowd = [0, 100, 200].map((startMs) => ({ startMs, endMs: 2000, original: String(startMs) }));
      const bare = withLines(crowd, ["a", "b", "c"], { mode: "original", style: labelled("every", BOXES.block) });
      expect(names(bare)).toEqual(["Style: Default", "Style: Translation", "Style: Box", "Style: BoxTranslation"]);
    });
  });

  it("gives the name the crowd held back to the turn's next cue, as the player's units do", () => {
    const cues = [
      { startMs: 0, endMs: 3000, original: "B" },
      { startMs: 0, endMs: 3000, original: "C" },
      { startMs: 1000, endMs: 2000, original: "A1" },
      { startMs: 3000, endMs: 4000, original: "A2" },
      { startMs: 4000, endMs: 5000, original: "A3" },
    ];
    const ofCue = ["b", "c", "a", "a", "a"];
    const events = dialogues(withLines(cues, ofCue, { mode: "original", style: labelled("change") }));
    expect(events.map(rowsOf)).toEqual([["B", "C"], ["B", "C", "A1"], ["B", "C"], ["张三", "A2"], ["A3"]]);
    // The same labels, slice by slice, as the units the player draws.
    const units = sliceSubtitleUnits(labelSubtitleCues(cues, ofCue, LABELS, "change"));
    expect(units.map((slice) => slice.units.flatMap((unit) => [...(unit.speakerLabel === undefined ? [] : [unit.speakerLabel]), unit.original]))).toEqual(events.map(rowsOf));
  });

  it("labels on change only the first cue of a turn and again after the repeat time", () => {
    const cues = [0, 1000, 31_000].map((startMs) => ({ startMs, endMs: startMs + 1000, original: String(startMs) }));
    expect(dialogues(withLines(cues, ["a", "a", "a"], { mode: "original", style: labelled("change") })).map(rowsOf)).toEqual([["张三", "0"], ["1000"], ["张三", "31000"]]);
    expect(dialogues(withLines(cues, ["a", "a", "a"], { mode: "original", style: labelled("every") })).map(rowsOf)).toEqual([["张三", "0"], ["张三", "1000"], ["张三", "31000"]]);
  });

  it("escapes labels like text and cuts long ones", () => {
    const labels = new Map([["x", "{\\b1}名\\N字"], ["y", "长".repeat(20)]]);
    const document = styledAssDocument(
      [
        { startMs: 0, endMs: 1000, original: "a" },
        { startMs: 2000, endMs: 3000, original: "b" },
      ],
      { ...FILE, mode: "original", style: labelled("every"), speakerLines: { ofCue: ["x", "y"], labels } },
    );
    expect(dialogues(document)[0]).toContain("}｛＼b1｝名＼N字\\N{\\rDefault}a");
    expect(dialogues(document)[1]).toContain(`}${"长".repeat(16)}…\\N{\\rDefault}b`);
  });

  it("keeps the Name field as it is without label lines", () => {
    const cues = [
      { startMs: 0, endMs: 3000, original: "长" },
      { startMs: 1000, endMs: 2000, original: "插" },
    ];
    const names = { ofCue: ["a", "b"], names: new Map([["a", "甲"], ["b", "乙"]]) };
    const nameOf = (document: string) => dialogues(document).map((line) => line.split(",")[4]);
    expect(nameOf(withLines(cues, ["a", "b"], { mode: "original", style: labelled("every"), speakers: names }))).toEqual(
      nameOf(styledAssDocument(cues, { ...FILE, mode: "original", style: style(), speakers: names })),
    );
  });
});
