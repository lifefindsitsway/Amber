import { describe, expect, it } from "vitest";
import { ASS_HEADER, assDialogue, assText, styledAssDocument, type StyledAssOptions } from "../../../../src/server/domain/export/ass.ts";
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
