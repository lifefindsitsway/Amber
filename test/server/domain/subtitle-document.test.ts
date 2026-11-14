import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUBTITLE_ASS_DATA_CHUNK, SUBTITLE_BILINGUAL_LINE_RATIO, SUBTITLE_SPEAKER_PREFIX_MIN } from "../../../src/shared/defaults.ts";
import type { SubtitleImportOptions } from "../../../src/shared/dto/subtitle-import.ts";
import { subtitleGlyphText, type TimedSubtitle } from "../../../src/shared/subtitle-geometry.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement, type SubtitleStyle } from "../../../src/shared/subtitle-style.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { ASS_HEADER, assDialogue, styledAssDocument, type StyledAssOptions } from "../../../src/server/domain/export/ass.ts";
import { buildSubtitlePackage, withAssRestoreData } from "../../../src/server/domain/export/ambersub.ts";
import { SpeakerLabeler, isChinese, speakerLabels, speakerPrefix } from "../../../src/server/domain/export/speaker-labels.ts";
import { srtCue } from "../../../src/server/domain/export/srt.ts";
import { VTT_HEADER, vttCue } from "../../../src/server/domain/export/vtt.ts";
import {
  inspectSubtitleDocument,
  planSubtitleImport,
  readSubtitleDocument,
  type SubtitleDocument,
  type SubtitleImportPlan,
} from "../../../src/server/domain/subtitle-document.ts";
import { importedTranscript, parseTimedSubtitle } from "../../../src/server/domain/subtitle-file.ts";
import { ASS_RESTORE_EFFECT, assDialogueDigest, parseSubtitlePackage, serializeSubtitlePackage, type SubtitlePackage } from "../../../src/server/domain/subtitle-package.ts";
import type { TranscriptSegment } from "../../../src/server/domain/transcript.ts";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("expected a failure");
}

/** The code of an AppError and its user message, which names the request field at fault. */
function errorOf(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) return { code: error.appError.code, message: error.appError.userMessage };
    throw error;
  }
  throw new Error("expected a failure");
}

const DIGEST = "a".repeat(64);
const withOptions = (options: Omit<SubtitleImportOptions, "expectedDigest"> = {}): SubtitleImportOptions => ({ expectedDigest: DIGEST, ...options });

/** The segments the plain import (before options existed) makes of a timed file. */
function legacySegments(text: string): SubtitleImportPlan["segments"] {
  const { segments } = importedTranscript({ revisionId: "r", contentId: "c", language: "zh", subtitle: parseTimedSubtitle(text), newId: () => "x", createdAt: 0 });
  return segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, speakerKey: null }));
}

function srt(cues: Array<[number, number, string]>): string {
  return cues.map(([start, end, text], index) => srtCue(index + 1, { startMs: start, endMs: end, text })).join("");
}

function read(text: string, hint: Parameters<typeof readSubtitleDocument>[1] = {}): SubtitleDocument {
  return readSubtitleDocument(text, hint);
}

const textsOf = (plan: SubtitleImportPlan): string[] => plan.segments.map((segment) => segment.text);
const speakersOf = (plan: SubtitleImportPlan): Array<string | null> => plan.segments.map((segment) => segment.speakerKey);

describe("format", () => {
  const SRT = "1\n00:00:01,000 --> 00:00:02,000\nhello\n";
  const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n";
  const ASS = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hello\n`;
  const PACKAGE = serializeSubtitlePackage({
    format: "amber-subtitle",
    formatVersion: 1,
    generator: { app: "Amber", version: "0.7.0" },
    original: { language: "en", paragraphMarks: false, speakers: [], segments: [{ key: "1", startMs: 1000, endMs: 2000, text: "hello", speaker: null }] },
    translations: [],
  });

  it("sniffs each format from the content", () => {
    expect(read(SRT).format).toBe("srt");
    expect(read(VTT).format).toBe("vtt");
    expect(read(ASS).format).toBe("ass");
    expect(read(PACKAGE).format).toBe("ambersub");
    expect(read(`\n  ${PACKAGE}`).format).toBe("ambersub");
  });

  it("goes by the extension, with ssa read as ass", () => {
    expect(read(ASS.replace("[Script Info]\n", ""), { filename: "x.SSA" }).format).toBe("ass");
    expect(read(PACKAGE, { filename: "lecture.ambersub" }).format).toBe("ambersub");
    // SRT and WebVTT still tell themselves apart by content.
    expect(read(VTT, { filename: "x.srt" }).format).toBe("vtt");
  });

  it("follows the hint and refuses content that is not that format", () => {
    expect(read(ASS, { format: "ass", filename: "x.srt" }).format).toBe("ass");
    expect(codeOf(() => read(VTT, { format: "srt" }))).toBe("invalid_request.subtitle_format");
    expect(codeOf(() => read(SRT, { format: "ambersub" }))).toBe("invalid_request.subtitle_format");
    expect(codeOf(() => read(SRT, { format: "ass" }))).toBe("invalid_request.subtitle_format");
  });

  it("refuses text that is no subtitle at all, or has no usable cue", () => {
    expect(codeOf(() => read("just some words"))).toBe("invalid_request.subtitle_format");
    expect(codeOf(() => read('{"format":"other"}'))).toBe("invalid_request.subtitle_format");
    expect(codeOf(() => read("1\n00:00:02,000 --> 00:00:01,000\nbackwards\n"))).toBe("invalid_request.subtitle_format");
    expect(codeOf(() => read(`${ASS_HEADER}Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,note\n`))).toBe("invalid_request.subtitle_format");
  });

  it("drops a leading byte order mark", () => {
    expect(read(`\uFEFF${SRT}`).cues[0]?.lines).toEqual(["hello"]);
    expect(read(`\uFEFF${ASS}`).format).toBe("ass");
    expect(read(`\uFEFF${PACKAGE}`).format).toBe("ambersub");
  });

  it("refuses a package of a newer format version with its own code", () => {
    const newer = PACKAGE.replace('"formatVersion":1', '"formatVersion":2');
    expect(codeOf(() => read(newer))).toBe("invalid_request.subtitle_newer");
  });
});

describe("SRT and WebVTT", () => {
  const MESSY = [
    "WEBVTT",
    "",
    "NOTE a comment",
    "",
    "00:00:05.000 --> 00:00:06.000",
    "<v Bob>later line",
    "",
    "00:00:01.000 --> 00:00:02.000 align:start",
    "<v.loud 张三>Hello &amp; <b>welcome</b>",
    "<i>world</i>",
    "",
    "00:00:03.000 --> 00:00:03.000",
    "zero length",
    "",
    "00:00:04.000 --> 00:00:04.500",
    "<v Bob></v>",
    "",
  ].join("\n");

  it("keeps cues in file order with cleaned lines, voices and dropped cues counted", () => {
    const document = read(MESSY);
    expect(document.cues).toEqual([
      { index: 0, startMs: 5000, endMs: 6000, lines: ["later line"], voice: "Bob" },
      { index: 1, startMs: 1000, endMs: 2000, lines: ["Hello & welcome", "world"], voice: "张三" },
    ]);
    expect(document.dropped).toEqual({ count: 2, samples: ["zero length", "00:00:04.000 --> 00:00:04.500"] });
  });

  it("keeps at most three short samples of dropped cues", () => {
    const text = srt([
      [0, 1000, "kept"],
      ...Array.from({ length: 5 }, (_, index): [number, number, string] => [2000, 2000, `${"长".repeat(100)}${index}`]),
    ]);
    const { dropped } = read(text);
    expect(dropped.count).toBe(5);
    expect(dropped.samples).toHaveLength(3);
    expect(dropped.samples[0]).toBe(`${"长".repeat(60)}…`);
  });

  it("reads voices: character references resolved, several different ones unassigned, an unusable one ignored", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "<v A &amp; B>one",
      "",
      "00:00:02.000 --> 00:00:03.000",
      "<v Ann>two",
      "<v Ben>three",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "<v Ann>four</v> <v  Ann >five",
      "",
      "00:00:04.000 --> 00:00:05.000",
      `<v ${"x".repeat(41)}>six`,
      "",
      "00:00:05.000 --> 00:00:06.000",
      "<v.a.b>seven",
      "",
    ].join("\n");
    expect(read(vtt).cues.map((cue) => cue.voice)).toEqual(["A & B", null, "Ann", undefined, undefined]);
  });

  it("imports exactly as the plain import without options, voices and leading names left in the text", () => {
    const vtt = [
      "WEBVTT - lecture",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "<v Ann>Second &lt;tag&gt;",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "张三：第一句",
      "接着说",
      "",
      "00:00:01.000 --> 00:00:01.500",
      "Same start",
      "",
    ].join("\n");
    const srtText = "1\r\n00:00:02,000 --> 00:00:03,000\r\nAlice: hi <b>there</b>\r\nyou\r\n\r\n2\r\n00:00:00,500 --> 00:00:01,000\r\n你好\r\n世界\r\n";
    for (const text of [vtt, srtText]) {
      const plan = planSubtitleImport(read(text), { language: "zh-cn" });
      expect(plan.segments).toEqual(legacySegments(text));
      expect(plan.speakers).toEqual([]);
      expect(plan.translations).toEqual([]);
      expect(plan.language).toBe("zh-CN");
      expect(plan.paragraphMarks).toBe(false);
    }
  });

  it("needs a language for any format but a package", () => {
    const document = read("1\n00:00:01,000 --> 00:00:02,000\nhello\n");
    for (const input of [{}, { language: "not a tag" }]) {
      const error = errorOf(() => planSubtitleImport(document, input));
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("language");
    }
  });

  it("uses voices only with options, each cue by the file, a multi-voice cue unassigned", () => {
    const vtt = ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "<v Ann>one", "", "00:00:02.000 --> 00:00:03.000", "<v Ann>a <v Ben>b", "", "00:00:03.000 --> 00:00:04.000", "none", "", "00:00:04.000 --> 00:00:05.000", "<v Ben>two", ""].join("\n");
    const document = read(vtt);
    expect(speakersOf(planSubtitleImport(document, { language: "en" }))).toEqual([null, null, null, null]);
    const plan = planSubtitleImport(document, { language: "en", options: withOptions({ speakers: { unlabeled: "inherit" } }) });
    expect(speakersOf(plan)).toEqual(["Ann", null, null, "Ben"]);
    expect(plan.speakers).toEqual([
      { key: "Ann", name: "Ann" },
      { key: "Ben", name: "Ben" },
    ]);
    const inspection = inspectSubtitleDocument(document);
    expect(inspection.speakers).toEqual({
      source: "explicit",
      candidates: [
        { key: "Ann", label: "Ann", count: 1, preselected: true },
        { key: "Ben", label: "Ben", count: 1, preselected: true },
      ],
      sequence: [
        [0, 1],
        [-1, 2],
        [1, 1],
      ],
    });
    expect(inspection.limits).toEqual(["speaker_identity", "multi_voice", "markup_removed"]);
    expect(inspection.bilingual).toBeUndefined();
  });
});

describe("long files", () => {
  it("previews more cues than a function call takes arguments", () => {
    const count = 300_000;
    const cues = Array.from({ length: count }, (_, index) => ({ index, startMs: index * 10 + 5, endMs: index * 10 + 9, lines: ["x"] }));
    const inspection = inspectSubtitleDocument({ format: "vtt", cues, dropped: { count: 0, samples: [] } });
    expect(inspection.rangeMs).toEqual({ start: 5, end: (count - 1) * 10 + 9 });
    expect(inspection.speakers.sequence).toEqual([[-1, count]]);
  });
});

describe("SRT leading names", () => {
  const FILE = srt([
    [0, 1000, "张三：大家好"],
    [1000, 2000, "接着说"],
    [2000, 3000, "李四：我来补充"],
    [3000, 4000, "注意：这里很重要"],
    [4000, 5000, "张三：好的"],
    [5000, 6000, "12：30 开会"],
    [6000, 7000, "见 https://example.com"],
    [7000, 8000, "李四："],
    [8000, 9000, "发言人 2：我是谁"],
    [9000, 10000, "发言人 2：还是我"],
  ]);

  it("offers names by count, preselecting those seen often enough, with label runs in file order", () => {
    const inspection = inspectSubtitleDocument(read(FILE));
    expect(SUBTITLE_SPEAKER_PREFIX_MIN).toBe(2);
    expect(inspection.speakers.source).toBe("prefix");
    expect(inspection.speakers.candidates).toEqual([
      { key: "张三", label: "张三", count: 2, preselected: true },
      { key: "李四", label: "李四", count: 2, preselected: true },
      { key: "注意", label: "注意", count: 1, preselected: false },
      { key: "发言人 2", label: "发言人 2", count: 2, preselected: true },
    ]);
    expect(inspection.speakers.sequence).toEqual([
      [0, 1],
      [-1, 1],
      [1, 1],
      [2, 1],
      [0, 1],
      [-1, 2],
      [1, 1],
      [3, 2],
    ]);
    expect(inspection.limits).toEqual(["speaker_identity", "unlabeled_inferred", "markup_removed"]);
  });

  it("takes selected names off the first line; unlabelled cues follow the previous speaker by default", () => {
    const plan = planSubtitleImport(read(FILE), { language: "zh", options: withOptions({ speakers: { prefixNames: ["张三", "李四", "发言人 2"] } }) });
    expect(textsOf(plan)).toEqual(["大家好", "接着说", "我来补充", "注意：这里很重要", "好的", "12：30 开会", "见 https://example.com", "李四：", "我是谁", "还是我"]);
    expect(speakersOf(plan)).toEqual(["张三", "张三", "李四", "李四", "张三", "张三", "张三", "李四", "发言人 2", "发言人 2"]);
    expect(plan.speakers).toEqual([
      { key: "张三", name: "张三" },
      { key: "李四", name: "李四" },
      { key: "发言人 2", ordinal: 2, fallbackName: "发言人 2" },
    ]);
  });

  it("leaves unlabelled cues unassigned when asked", () => {
    const plan = planSubtitleImport(read(FILE), { language: "zh", options: withOptions({ speakers: { prefixNames: ["张三", "注意"], unlabeled: "unassigned" } }) });
    expect(speakersOf(plan)).toEqual(["张三", null, null, "注意", "张三", null, null, null, null, null]);
    expect(textsOf(plan).slice(2, 4)).toEqual(["李四：我来补充", "这里很重要"]);
  });

  it("is the plain import when every name is deselected", () => {
    for (const options of [withOptions(), withOptions({ speakers: { prefixNames: [] } }), withOptions({ speakers: { prefixNames: [], unlabeled: "inherit" } })]) {
      const plan = planSubtitleImport(read(FILE), { language: "zh", options });
      expect(plan.segments).toEqual(legacySegments(FILE));
      expect(plan.speakers).toEqual([]);
    }
  });

  it("names nobody for a key that is not a candidate", () => {
    const plan = planSubtitleImport(read(FILE), { language: "zh", options: withOptions({ speakers: { prefixNames: ["王五"] } }) });
    expect(plan.segments).toEqual(legacySegments(FILE));
  });

  it("resolves who continues in file order, then sorts sentences by time", () => {
    const text = srt([
      [5000, 6000, "Bob: later"],
      [6000, 7000, "still Bob"],
      [0, 1000, "Ann: first"],
      [1000, 2000, "still Ann"],
    ]);
    const plan = planSubtitleImport(read(text), { language: "en", options: withOptions({ speakers: { prefixNames: ["Ann", "Bob"] } }) });
    expect(textsOf(plan)).toEqual(["first", "still Ann", "later", "still Bob"]);
    expect(speakersOf(plan)).toEqual(["Ann", "Ann", "Bob", "Bob"]);
    // Speakers are listed as the file first names them.
    expect(plan.speakers.map((speaker) => speaker.key)).toEqual(["Bob", "Ann"]);
  });

  it("reads a name only from a cue's first line", () => {
    const text = "1\n00:00:00,000 --> 00:00:01,000\nhello\nAnn: there\n\n2\n00:00:01,000 --> 00:00:02,000\nAnn: again\n\n3\n00:00:02,000 --> 00:00:03,000\nAnn:\nwhat\n";
    const document = read(text);
    expect(inspectSubtitleDocument(document).speakers.candidates).toEqual([{ key: "Ann", label: "Ann", count: 1, preselected: false }]);
    const plan = planSubtitleImport(document, { language: "en", options: withOptions({ speakers: { prefixNames: ["Ann"], unlabeled: "unassigned" } }) });
    expect(textsOf(plan)).toEqual(["hello Ann: there", "again", "Ann: what"]);
  });

  it("keeps the line as text for a cue that is only a name, and drops an empty first line otherwise", () => {
    const text = "1\n00:00:00,000 --> 00:00:01,000\n张三：\n\n2\n00:00:01,000 --> 00:00:02,000\n张三：\n你好\n";
    const plan = planSubtitleImport(read(text), { language: "zh", options: withOptions({ speakers: { prefixNames: ["张三"] } }) });
    expect(textsOf(plan)).toEqual(["张三：", "你好"]);
    expect(speakersOf(plan)).toEqual(["张三", "张三"]);
  });
});

describe("SRT translation lines", () => {
  const pairs: Array<[string, string?]> = [["你好", "Hello"], ["世界", "World"], ["张三：再见", "Bye"], ["独白"], ["最后", "Last"]];
  const FILE = pairs
    .map(([original, translation], index) => srtCue(index + 1, { startMs: index * 1000, endMs: index * 1000 + 1000, text: original, ...(translation === undefined ? {} : { translation }) }))
    .join("");

  it("suggests the second line as a translation from enough two-line cues, with real samples, never preselected", () => {
    expect(4 / 5).toBeGreaterThanOrEqual(SUBTITLE_BILINGUAL_LINE_RATIO);
    expect(inspectSubtitleDocument(read(FILE)).bilingual).toEqual({
      source: "lines",
      count: 4,
      samples: [
        { original: "你好", translation: "Hello" },
        { original: "世界", translation: "World" },
      ],
    });
    // Without a chosen language both lines stay the sentence, as before.
    expect(planSubtitleImport(read(FILE), { language: "zh" }).segments).toEqual(legacySegments(FILE));
  });

  it("makes no suggestion below the ratio", () => {
    const text = srt([
      [0, 1000, "一行"],
      [1000, 2000, "两行\nTwo"],
    ]);
    expect(inspectSubtitleDocument(read(text)).bilingual).toBeUndefined();
  });

  it("imports the second line of two-line cues in the chosen language, names taken off the first", () => {
    const plan = planSubtitleImport(read(FILE), { language: "zh", options: withOptions({ translationLanguage: "en-us", speakers: { prefixNames: ["张三"], unlabeled: "unassigned" } }) });
    expect(textsOf(plan)).toEqual(["你好", "世界", "再见", "独白", "最后"]);
    expect(speakersOf(plan)).toEqual([null, null, "张三", null, null]);
    expect(plan.translations).toEqual([
      {
        language: "en-US",
        lines: [
          { segmentIndex: 0, text: "Hello" },
          { segmentIndex: 1, text: "World" },
          { segmentIndex: 2, text: "Bye" },
          { segmentIndex: 4, text: "Last" },
        ],
      },
    ]);
  });

  it("refuses a translation language in the original's language", () => {
    const error = errorOf(() => planSubtitleImport(read(FILE), { language: "zh-CN", options: withOptions({ translationLanguage: "zh-TW" }) }));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("translationLanguage");
  });

  it("maps translation lines to sentences after sorting by time", () => {
    const text = [srtCue(1, { startMs: 5000, endMs: 6000, text: "后", translation: "After" }), srtCue(2, { startMs: 0, endMs: 1000, text: "前", translation: "Before" })].join("");
    const plan = planSubtitleImport(read(text), { language: "zh", options: withOptions({ translationLanguage: "en" }) });
    expect(textsOf(plan)).toEqual(["前", "后"]);
    expect(plan.translations[0]?.lines).toEqual([
      { segmentIndex: 0, text: "Before" },
      { segmentIndex: 1, text: "After" },
    ]);
  });
});

function style(appearance: Partial<SubtitleStyle["appearance"]> = {}): SubtitleStyle {
  return { appearance: { ...defaultSubtitleAppearance(), ...appearance }, placement: defaultSubtitlePlacement() };
}

const FILE_RES: Omit<StyledAssOptions, "style"> = { mode: "bilingual", playRes: { width: 1920, height: 1080 }, textOnly: false };

describe("ASS", () => {
  it("reads any ASS by its Format line: Text keeps its commas, overrides go, Name is the speaker", () => {
    const text = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname",
      "Style: Main,Arial",
      "Style: Alt,Arial",
      "",
      "[Events]",
      "Format: Layer, Style, Start, End, Name, Effect, Text",
      "Comment: 0,Main,0:00:00.00,0:00:05.00,Ann,,a comment",
      "Dialogue: 0,Alt,0:00:03.00,0:00:04.00,,,{\\p1}m 0 0 l 10 10{\\p0}drawn",
      "Dialogue: 0,Main,0:00:01.00,0:00:02.50,Ann,,{\\i1}Hello,{\\i0} world{\\rAlt}!\\Nsecond\\hline",
      "Dialogue: 0,Main,bad,0:00:02.00,Ann,,broken",
      "Dialogue: 0,Main,0:00:05.00,0:00:06.00,  ,,{\\b1}",
      "Dialogue: 0,Main,1:00:00.5,1:00:01.25,Bob,,late",
    ].join("\n");
    const document = read(text);
    expect(document.cues).toEqual([
      { index: 0, startMs: 3000, endMs: 4000, lines: ["drawn"] },
      { index: 1, startMs: 1000, endMs: 2500, lines: ["Hello, world!", "second line"], voice: "Ann" },
      { index: 2, startMs: 3_600_500, endMs: 3_601_250, lines: ["late"], voice: "Bob" },
    ]);
    expect(document.dropped).toEqual({ count: 2, samples: ["broken", "0:00:05.00 --> 0:00:06.00"] });
    expect(document.rebuiltFromSlices).toBeUndefined();
    const inspection = inspectSubtitleDocument(document);
    expect(inspection.limits).toEqual(["speaker_identity", "markup_removed", "centisecond_timing", "glyphs_changed"]);
    expect(inspection.speakers.source).toBe("explicit");
  });

  it("reads all text of another app's ASS as original, even in a style named like a translation", () => {
    const text = ["[V4+ Styles]", "Format: Name", "Style: Default", "Style: Translation", "Style: Sign", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,上\\N{\\rTranslation}下"].join("\n");
    expect(read(text).cues[0]).toEqual({ index: 0, startMs: 1000, endMs: 2000, lines: ["上", "下"] });
  });

  it("reads the fixed style: translation after {\\rTranslation}, karaoke removed, full-width escapes kept", () => {
    const text = [
      ASS_HEADER,
      assDialogue({ startMs: 1000, endMs: 2600, text: "Hello world.", words: [{ text: "Hello", startMs: 1000, endMs: 1400 }, { text: "world.", startMs: 1600, endMs: 2500 }], translation: "你好世界" }, { karaoke: true, speaker: "Smith, PhD" }),
      assDialogue({ startMs: 3000, endMs: 4000, text: "a \\ b = {x}" }, { karaoke: false }),
      assDialogue({ startMs: 5000, endMs: 6000, text: "单行" }, { karaoke: false, speaker: "发言人 4" }),
    ].join("");
    const document = read(text);
    expect(document.cues).toEqual([
      { index: 0, startMs: 1000, endMs: 2600, lines: ["Hello world."], translationLines: ["你好世界"], voice: "Smith， PhD" },
      { index: 1, startMs: 3000, endMs: 4000, lines: ["a ＼ b = ｛x｝"] },
      { index: 2, startMs: 5000, endMs: 6000, lines: ["单行"], voice: "发言人 4" },
    ]);
    expect(inspectSubtitleDocument(document).bilingual).toEqual({ source: "style", count: 1, samples: [{ original: "Hello world.", translation: "你好世界" }] });

    // Without options: speakers kept, a translation of unknown language dropped.
    const plain = planSubtitleImport(document, { language: "en" });
    expect(plain.segments).toEqual([
      { startMs: 1000, endMs: 2600, text: "Hello world.", speakerKey: "Smith， PhD" },
      { startMs: 3000, endMs: 4000, text: "a ＼ b = ｛x｝", speakerKey: null },
      { startMs: 5000, endMs: 6000, text: "单行", speakerKey: "发言人 4" },
    ]);
    expect(plain.speakers).toEqual([
      { key: "Smith， PhD", name: "Smith， PhD" },
      { key: "发言人 4", ordinal: 4, fallbackName: "发言人 4" },
    ]);
    expect(plain.translations).toEqual([]);
    const translated = planSubtitleImport(document, { language: "en", options: withOptions({ translationLanguage: "zh-cn" }) });
    expect(translated.translations).toEqual([{ language: "zh-CN", lines: [{ segmentIndex: 0, text: "你好世界" }] }]);
    expect(codeOf(() => planSubtitleImport(document, { language: "en", options: withOptions({ translationLanguage: "en-GB" }) }))).toBe("invalid_request");
  });

  it("reads a translation-first styled document by style, whatever the order", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 1000, original: "原文一", translation: "One" },
      { startMs: 1000, endMs: 2000, original: "原文二" },
      { startMs: 2000, endMs: 3000, original: "原文三", translation: "Three" },
    ];
    const text = styledAssDocument(cues, { ...FILE_RES, style: style({ bilingualOrder: "translation_first", background: { ...defaultSubtitleAppearance().background, enabled: true } }) });
    expect(text).toContain("{\\rDefault}原文一");
    const document = read(text);
    expect(document.cues.map((cue) => [cue.lines, cue.translationLines])).toEqual([
      [["原文一"], ["One"]],
      [["原文二"], undefined],
      [["原文三"], ["Three"]],
    ]);
    expect(document.rebuiltFromSlices).toBe(true);
    expect(inspectSubtitleDocument(document).limits).toContain("overlap_slices");
  });

  it("rebuilds overlapping sentences from slices that join them in one run of lines", () => {
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 3000, original: "First sentence", translation: "第一句" },
      { startMs: 1000, endMs: 2000, original: "inside", translation: "其中" },
      { startMs: 2500, endMs: 5000, original: "Third", translation: "第三" },
      { startMs: 5000, endMs: 6000, original: "Third", translation: "第三" },
    ];
    const text = styledAssDocument(cues, { ...FILE_RES, style: style() });
    expect(text).toContain("First sentence\\Ninside\\N{\\rTranslation}第一句\\N其中");
    const document = read(text);
    expect(document.cues.map((cue) => [cue.startMs, cue.endMs, cue.lines[0], cue.translationLines?.[0]])).toEqual([
      [0, 3000, "First sentence", "第一句"],
      [1000, 2000, "inside", "其中"],
      [2500, 6000, "Third", "第三"],
    ]);
  });

  it("rebuilds overlaps of a document with speaker rows unit by unit, and merges pre-wrapped lines", () => {
    const long = "This sentence is long enough that the export breaks it into several lines on a narrow picture";
    const cues: TimedSubtitle[] = [
      { startMs: 0, endMs: 2000, original: long, translation: "这一句很长，长到在窄画面上会被导出预先折成好几行，用来检验合并" },
      { startMs: 1000, endMs: 3000, original: "well-known reply", translation: "回答" },
    ];
    const ofCue = ["a", "b"];
    const names = new Map([
      ["a", "Ann, PhD"],
      ["b", "很长很长很长很长很长很长很长很长很长的名字"],
    ]);
    const text = styledAssDocument(cues, {
      mode: "bilingual",
      playRes: { width: 608, height: 1080 },
      textOnly: false,
      style: style({ speaker: "every", background: { ...defaultSubtitleAppearance().background, enabled: true, scope: "translation" } }),
      speakers: { ofCue, names },
      speakerLines: { ofCue, labels: names },
      glyphs: { advanceEm: () => 0.5 },
    });
    expect(text).toMatch(/This sentence[^,]*\\N/u);
    const document = read(text);
    expect(document.cues).toEqual([
      { index: 0, startMs: 0, endMs: 2000, lines: [long], translationLines: [cues[0]?.translation], voice: "Ann， PhD" },
      { index: 1, startMs: 1000, endMs: 3000, lines: ["well-known reply"], translationLines: ["回答"], voice: "很长很长很长很长很长很长很长很长很长的名字" },
    ]);
  });

  it("takes a speaker row's label when the Name field is empty", () => {
    const cues: TimedSubtitle[] = [{ startMs: 0, endMs: 1000, original: "你好" }];
    const labels = new Map([["a", "林晓"]]);
    const text = styledAssDocument(cues, { ...FILE_RES, style: style({ speaker: "change" }), speakerLines: { ofCue: ["a"], labels } });
    expect(read(text).cues).toEqual([{ index: 0, startMs: 0, endMs: 1000, lines: ["你好"], voice: "林晓" }]);
  });
});

describe("restore data", () => {
  const segment = (id: string, ordinal: number, startMs: number, endMs: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment =>
    ({ id, revisionId: "r", ordinal, startMs, endMs, text, sourceSegmentIds: [], ...extra }) as TranscriptSegment;
  const pkg = buildSubtitlePackage({
    revision: { language: "zh-CN" },
    segments: [segment("x1", 0, 0, 1000, "第一句", { speakerId: "a" }), segment("x2", 1, 500, 2000, "第二句", { speakerId: "b" })],
    speakers: [
      { id: "a", ordinal: 1, name: "张三", colorIndex: 3 },
      { id: "b", ordinal: 2, colorIndex: 1 },
    ],
    translations: [{ language: "en", segments: [segment("t1", 0, 0, 1000, "First", { sourceSegmentIds: ["x1"] as TranscriptSegment["sourceSegmentIds"] })] }],
    version: "0.7.0",
  });
  const cues: TimedSubtitle[] = [
    { startMs: 0, endMs: 1000, original: "第一句", translation: "First" },
    { startMs: 500, endMs: 2000, original: "第二句" },
  ];
  const plain = styledAssDocument(cues, { ...FILE_RES, style: style() });
  const withData = withAssRestoreData(plain, serializeSubtitlePackage(pkg));

  it("is used when its protocol and digest match: the file reads as the package", () => {
    expect(withData).toContain(`,${ASS_RESTORE_EFFECT},${ASS_RESTORE_EFFECT} 1 `);
    const document = read(withData);
    expect(document.package).toEqual(parseSubtitlePackage(serializeSubtitlePackage(pkg)));
    expect(document.restoreDataMismatch).toBeUndefined();
    expect(document.rebuiltFromSlices).toBeUndefined();
    const fromPackage = read(serializeSubtitlePackage(pkg));
    expect(planSubtitleImport(document, {})).toEqual({ ...planSubtitleImport(fromPackage, {}), format: "ass" });
    const inspection = inspectSubtitleDocument(document);
    expect(inspection.speakers.source).toBe("package");
    expect(inspection.bilingual).toEqual({ source: "package", count: 1, samples: [{ original: "第一句", translation: "First" }], languages: ["en"] });
    expect(inspection.limits).toEqual(["package_scope"]);
    expect(inspection.cueCount).toBe(2);
    expect(inspection.package?.language).toBe("zh-CN");
  });

  it("reads a large package across many chunks", () => {
    const long = buildSubtitlePackage({
      revision: { language: "en" },
      segments: Array.from({ length: 200 }, (_, index) => segment(`s${index}`, index, index * 1000, index * 1000 + 900, `Sentence number ${index} with some words.`)),
      speakers: [],
      translations: [],
      version: "0.7.0",
    });
    const text = withAssRestoreData(styledAssDocument([{ startMs: 0, endMs: 1000, original: "x" }], { ...FILE_RES, style: style() }), serializeSubtitlePackage(long));
    expect(text.split("\n").filter((line) => line.startsWith("Comment:")).length).toBeGreaterThan(3);
    expect(text.split("\n").find((line) => line.startsWith("Comment:") && !line.includes(" 1 "))?.length).toBeGreaterThan(SUBTITLE_ASS_DATA_CHUNK);
    expect(read(text).package?.original.segments).toHaveLength(200);
  });

  it("falls back to a plain read when any dialogue line changed", () => {
    const tampered = withData.replaceAll("第二句", "第二局");
    const document = read(tampered);
    expect(document.package).toBeUndefined();
    expect(document.restoreDataMismatch).toBe(true);
    expect(document.rebuiltFromSlices).toBe(true);
    expect(document.cues.map((cue) => cue.lines[0])).toEqual(["第一句", "第二局"]);
    expect(inspectSubtitleDocument(document).limits).toEqual(["markup_removed", "centisecond_timing", "glyphs_changed", "overlap_slices", "restore_data_mismatch"]);
    const reordered = withData.split("\n");
    const dialogueAt = reordered.findIndex((line) => line.startsWith("Dialogue:"));
    reordered.splice(dialogueAt, 1);
    expect(read(reordered.join("\n")).restoreDataMismatch).toBe(true);
  });

  it("falls back for another protocol, a broken payload or a payload that is no package", () => {
    const digest = assDialogueDigest(plain.split("\n").filter((line) => line.startsWith("Dialogue:")));
    const comment = (body: string): string => `Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,amber-data,${body}\n`;
    const variants = [
      withData.replace(`amber-data 1 ${digest}`, `amber-data 2 ${digest}`),
      `${plain}${comment(`amber-data 1 ${digest}`)}${comment("!!!not base64")}`,
      `${plain}${comment(`amber-data 1 ${digest}`)}${comment(Buffer.from('{"format":"amber-subtitle"}').toString("base64"))}`,
      `${plain}${comment(`amber-data 1 ${digest}`)}`,
      `${plain}${comment("something else")}`,
    ];
    for (const text of variants) {
      const document = read(text);
      expect(document.package).toBeUndefined();
      expect(document.restoreDataMismatch).toBe(true);
    }
  });

  it("reads a file whose restore data was removed as a plain styled ASS, without a mismatch", () => {
    const document = read(plain);
    expect(document.package).toBeUndefined();
    expect(document.restoreDataMismatch).toBeUndefined();
    expect(document.rebuiltFromSlices).toBe(true);
  });
});

describe("package", () => {
  const PACKAGE: SubtitlePackage = {
    format: "amber-subtitle",
    formatVersion: 1,
    generator: { app: "Amber", version: "0.7.0" },
    original: {
      language: "zh-CN",
      paragraphMarks: true,
      speakers: [
        { key: "s2", ordinal: 2, name: "张伟", colorIndex: 1 },
        { key: "s5", ordinal: 5, name: "张伟", colorIndex: 4 },
        { key: "s3", ordinal: 3, colorIndex: 2 },
        { key: "s9", ordinal: 9, name: "没人说话", colorIndex: 0 },
      ],
      segments: [
        { key: "1", startMs: 3000, endMs: 4000, text: "后来的句子", speaker: "s3", paragraphStart: true },
        { key: "2", startMs: 0, endMs: 1000, text: "张伟甲", speaker: "s2", paragraphStart: false },
        { key: "3", startMs: 1000, endMs: 2000, text: "张伟乙", speaker: "s5", paragraphStart: true },
        { key: "4", startMs: 2000, endMs: 3000, text: "没人", speaker: null, paragraphStart: false },
      ],
    },
    translations: [
      { language: "en", segments: [{ sourceSegmentKey: "3", text: "Zhang B" }, { sourceSegmentKey: "1", text: "Later" }] },
      { language: "ja", segments: [] },
    ],
  };
  const document = read(serializeSubtitlePackage(PACKAGE));

  it("plans every field as written, in package order, ignoring the requested language", () => {
    const plan = planSubtitleImport(document, { language: "fr" });
    expect(plan).toEqual({
      format: "ambersub",
      language: "zh-CN",
      paragraphMarks: true,
      speakers: [
        { key: "s2", ordinal: 2, name: "张伟", colorIndex: 1 },
        { key: "s5", ordinal: 5, name: "张伟", colorIndex: 4 },
        { key: "s3", ordinal: 3, colorIndex: 2 },
      ],
      segments: [
        { startMs: 3000, endMs: 4000, text: "后来的句子", speakerKey: "s3", paragraphStart: true },
        { startMs: 0, endMs: 1000, text: "张伟甲", speakerKey: "s2", paragraphStart: false },
        { startMs: 1000, endMs: 2000, text: "张伟乙", speakerKey: "s5", paragraphStart: true },
        { startMs: 2000, endMs: 3000, text: "没人", speakerKey: null, paragraphStart: false },
      ],
      translations: [
        {
          language: "en",
          lines: [
            { segmentIndex: 2, text: "Zhang B" },
            { segmentIndex: 0, text: "Later" },
          ],
        },
      ],
      droppedCues: 0,
    });
    expect(planSubtitleImport(document, { options: withOptions({ translationLanguage: null }) }).translations).toEqual([]);
    expect(planSubtitleImport(document, { options: withOptions({ translationLanguage: "de" }) }).translations).toHaveLength(1);
  });

  it("previews the package: summary, speakers by key with default labels, translations", () => {
    expect(inspectSubtitleDocument(document)).toEqual({
      format: "ambersub",
      cueCount: 4,
      droppedCues: { count: 0, samples: [] },
      rangeMs: { start: 0, end: 4000 },
      speakers: {
        source: "package",
        candidates: [
          { key: "s2", label: "张伟", count: 1, preselected: true },
          { key: "s5", label: "张伟", count: 1, preselected: true },
          { key: "s3", label: "发言人 3", count: 1, preselected: true },
        ],
        sequence: [
          [2, 1],
          [0, 1],
          [1, 1],
          [-1, 1],
        ],
      },
      bilingual: {
        source: "package",
        count: 2,
        samples: [
          { original: "张伟乙", translation: "Zhang B" },
          { original: "后来的句子", translation: "Later" },
        ],
        languages: ["en", "ja"],
      },
      package: { formatVersion: 1, generator: { app: "Amber", version: "0.7.0" }, language: "zh-CN", segmentCount: 4, speakerCount: 3, translationLanguages: ["en", "ja"] },
      limits: ["package_scope"],
    });
  });

  it("leaves paragraph marks out when the package has none", () => {
    const unmarked = {
      ...PACKAGE,
      original: { ...PACKAGE.original, paragraphMarks: false, segments: PACKAGE.original.segments.map(({ paragraphStart: _mark, ...rest }) => rest) },
    };
    const plan = planSubtitleImport(read(serializeSubtitlePackage(unmarked)), {});
    expect(plan.paragraphMarks).toBe(false);
    expect(plan.segments.every((segment) => !("paragraphStart" in segment))).toBe(true);
  });
});

describe("round trip through the current exporters", () => {
  interface Sentence {
    startMs: number;
    endMs: number;
    text: string;
    speaker?: string;
    translation?: string;
  }
  // Two speakers sharing a name, an unnamed one, an unassigned sentence, a sentence without
  // translation, an overlap, and text with markup characters.
  const speakers = [
    { id: "lin", ordinal: 1, name: "林晓" },
    { id: "alice", ordinal: 2, name: "Alice Smith-Johnson, PhD" },
    { id: "anon", ordinal: 3 },
    { id: "zhangA", ordinal: 4, name: "张伟" },
    { id: "zhangB", ordinal: 5, name: "张伟" },
  ];
  const labels = speakerLabels(speakers);
  const sentences: Sentence[] = [
    { startMs: 0, endMs: 2500, text: "大家好，欢迎。", speaker: "lin", translation: "Hello, welcome." },
    { startMs: 2500, endMs: 5000, text: "继续说。", speaker: "lin", translation: "Go on." },
    { startMs: 5000, endMs: 8000, text: "They’re “ok”: a < b & {x}.", speaker: "alice", translation: "他们“还行”。" },
    { startMs: 8000, endMs: 9000, text: "（掌声）", translation: "(Applause)" },
    { startMs: 9000, endMs: 11000, text: "我补充一点。", speaker: "anon", translation: "One more thing." },
    { startMs: 11000, endMs: 13000, text: "我同意。", speaker: "zhangA", translation: "I agree." },
    { startMs: 13000, endMs: 16000, text: "我也同意。", speaker: "zhangB" },
    { startMs: 15000, endMs: 18000, text: "最后一句。", speaker: "lin", translation: "Last one." },
    { startMs: 18000, endMs: 20000, text: "Sure, sounds good.", speaker: "alice", translation: "好的。" },
    { startMs: 20000, endMs: 22000, text: "谢谢大家。", speaker: "anon", translation: "Thanks." },
  ];
  const labelOf = (sentence: Sentence): string | undefined => (sentence.speaker === undefined ? undefined : labels.get(sentence.speaker));

  it("SRT with every cue named restores text, speakers and the chosen translation", () => {
    const labeler = new SpeakerLabeler("every");
    const text = sentences
      .map((sentence, index) => {
        const label = labelOf(sentence);
        const prefix = labeler.next(sentence.speaker) && label !== undefined ? speakerPrefix(label, isChinese("zh")) : "";
        return srtCue(index + 1, { startMs: sentence.startMs, endMs: sentence.endMs, text: sentence.text, ...(sentence.translation === undefined ? {} : { translation: sentence.translation }) }, prefix);
      })
      .join("");
    const document = read(text);
    const inspection = inspectSubtitleDocument(document);
    const prefixNames = inspection.speakers.candidates.filter((candidate) => candidate.preselected).map((candidate) => candidate.key);
    expect(prefixNames).toEqual(["林晓", "Alice Smith-Johnson, PhD", "发言人 3", "张伟"]);
    expect(inspection.bilingual?.source).toBe("lines");
    const plan = planSubtitleImport(document, { language: "zh", options: withOptions({ speakers: { prefixNames, unlabeled: "unassigned" }, translationLanguage: "en" }) });
    expect(textsOf(plan)).toEqual(sentences.map((sentence) => sentence.text.replace(/<[^>]*>/g, "")));
    expect(speakersOf(plan)).toEqual(sentences.map((sentence) => labelOf(sentence) ?? null));
    expect(plan.translations[0]?.lines).toEqual(sentences.flatMap((sentence, segmentIndex) => (sentence.translation === undefined ? [] : [{ segmentIndex, text: sentence.translation }])));
  });

  it("SRT named on turns restores turns, unlabelled cues following the previous name (inferred)", () => {
    const labeler = new SpeakerLabeler("turn");
    const text = sentences
      .map((sentence, index) => {
        const label = labelOf(sentence);
        const prefix = labeler.next(sentence.speaker) && label !== undefined ? speakerPrefix(label, true) : "";
        return srtCue(index + 1, { startMs: sentence.startMs, endMs: sentence.endMs, text: sentence.text }, prefix);
      })
      .join("");
    const document = read(text);
    const prefixNames = inspectSubtitleDocument(document)
      .speakers.candidates.filter((candidate) => candidate.preselected)
      .map((candidate) => candidate.key);
    const plan = planSubtitleImport(document, { language: "zh", options: withOptions({ speakers: { prefixNames } }) });
    const alice = "Alice Smith-Johnson, PhD";
    expect(speakersOf(plan)).toEqual(["林晓", "林晓", alice, alice, "发言人 3", "张伟", "张伟", "林晓", alice, "发言人 3"]);
  });

  it("VTT restores text and voices", () => {
    const text = VTT_HEADER + sentences.map((sentence) => vttCue({ startMs: sentence.startMs, endMs: sentence.endMs, text: sentence.text }, labelOf(sentence))).join("");
    const document = read(text);
    const plan = planSubtitleImport(document, { language: "zh", options: withOptions() });
    expect(textsOf(plan)).toEqual(sentences.map((sentence) => sentence.text));
    expect(speakersOf(plan)).toEqual(sentences.map((sentence) => labelOf(sentence) ?? null));
    // Without options, exactly the plain import.
    expect(planSubtitleImport(document, { language: "zh" }).segments).toEqual(legacySegments(text));
  });

  it("fixed-style ASS restores text as drawn, Name speakers and Translation lines", () => {
    const text =
      ASS_HEADER +
      sentences
        .map((sentence) => assDialogue({ startMs: sentence.startMs, endMs: sentence.endMs, text: sentence.text, ...(sentence.translation === undefined ? {} : { translation: sentence.translation }) }, { karaoke: false, ...(labelOf(sentence) === undefined ? {} : { speaker: labelOf(sentence) as string }) }))
        .join("");
    const plan = planSubtitleImport(read(text), { language: "zh", options: withOptions({ translationLanguage: "en" }) });
    const drawn = (value: string): string => subtitleGlyphText(value).replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");
    expect(textsOf(plan)).toEqual(sentences.map((sentence) => drawn(sentence.text)));
    expect(speakersOf(plan)).toEqual(sentences.map((sentence) => labelOf(sentence)?.replace(/,/g, "，") ?? null));
    expect(plan.translations[0]?.lines).toEqual(sentences.flatMap((sentence, segmentIndex) => (sentence.translation === undefined ? [] : [{ segmentIndex, text: drawn(sentence.translation) }])));
  });

  it("styled ASS with speaker rows restores sentences, overlaps and speakers", () => {
    const ofCue = sentences.map((sentence) => sentence.speaker);
    const cues: TimedSubtitle[] = sentences.map((sentence) => ({
      startMs: sentence.startMs,
      endMs: sentence.endMs,
      original: sentence.text,
      ...(sentence.translation === undefined ? {} : { translation: sentence.translation }),
    }));
    for (const appearance of [{ speaker: "change" as const }, { speaker: "every" as const, bilingualOrder: "translation_first" as const }, {}]) {
      const text = styledAssDocument(cues, { ...FILE_RES, style: style(appearance), speakers: { ofCue, names: labels }, speakerLines: { ofCue, labels } });
      const plan = planSubtitleImport(read(text), { language: "zh", options: withOptions({ translationLanguage: "en" }) });
      expect(plan.segments.map((segment) => [segment.startMs, segment.endMs, segment.text])).toEqual(sentences.map((sentence) => [sentence.startMs, sentence.endMs, subtitleGlyphText(sentence.text).replace(/\{/g, "｛").replace(/\}/g, "｝")]));
      expect(speakersOf(plan)).toEqual(sentences.map((sentence) => labelOf(sentence)?.replace(/,/g, "，") ?? null));
      expect(plan.translations[0]?.lines.map((line) => line.segmentIndex)).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9]);
    }
  });

  it("a package restores every field exactly", () => {
    const segments = sentences.map(
      (sentence, ordinal) =>
        ({
          id: `seg${ordinal}`,
          revisionId: "r",
          ordinal,
          startMs: sentence.startMs,
          endMs: sentence.endMs,
          text: sentence.text,
          sourceSegmentIds: [],
          paragraphStart: ordinal === 0 || sentence.speaker !== sentences[ordinal - 1]?.speaker,
          ...(sentence.speaker === undefined ? {} : { speakerId: sentence.speaker }),
        }) as unknown as TranscriptSegment,
    );
    const translation = (language: string, skip: number) =>
      sentences.flatMap((sentence, ordinal) =>
        sentence.translation === undefined || ordinal === skip
          ? []
          : [{ id: `${language}${ordinal}`, revisionId: language, ordinal, startMs: sentence.startMs, endMs: sentence.endMs, text: `${language}:${sentence.translation}`, sourceSegmentIds: [`seg${ordinal}`] } as unknown as TranscriptSegment],
      );
    const pkg = buildSubtitlePackage({
      revision: { language: "zh-CN" },
      segments,
      speakers: speakers.map((speaker) => ({ ...speaker, colorIndex: speaker.ordinal % 8 })),
      translations: [
        { language: "en", segments: translation("en", 3) },
        { language: "ja", segments: translation("ja", -1) },
      ],
      version: "0.7.0",
    });
    const plan = planSubtitleImport(read(serializeSubtitlePackage(pkg), { filename: "x.ambersub" }), {});
    expect(plan.language).toBe("zh-CN");
    expect(plan.paragraphMarks).toBe(true);
    expect(plan.segments).toEqual(
      segments.map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        speakerKey: segment.speakerId === undefined ? null : `s${speakers.find((speaker) => speaker.id === segment.speakerId)?.ordinal}`,
        paragraphStart: segment.paragraphStart,
      })),
    );
    expect(plan.speakers).toEqual(speakers.map((speaker) => ({ key: `s${speaker.ordinal}`, ordinal: speaker.ordinal, ...(speaker.name === undefined ? {} : { name: speaker.name }), colorIndex: speaker.ordinal % 8 })));
    expect(plan.translations.map((entry) => [entry.language, entry.lines.map((line) => line.segmentIndex)])).toEqual([
      ["en", [0, 1, 2, 4, 5, 7, 8, 9]],
      ["ja", [0, 1, 2, 3, 4, 5, 7, 8, 9]],
    ]);
    expect(plan.translations[0]?.lines[0]?.text).toBe("en:Hello, welcome.");
  });
});

/**
 * Files written by the export code of past releases from one synthetic source: each must read
 * back as far as its format can carry, with exactly the losses the format is known for.
 */

const ROOT = new URL("../../fixtures/subtitle-history/", import.meta.url);

interface SourceSentence {
  ordinal: number;
  startMs: number;
  endMs: number;
  speaker?: string;
  text: string;
  translation?: string;
}

interface HistorySource {
  original: { language: string };
  speakers: Array<{ key: string; exportedName: string }>;
  sentences: SourceSentence[];
}

interface ManifestFile {
  file: string;
  format: string;
  options: { includeSpeakers: boolean; speakerLabels?: "turn" | "every"; translationLanguage?: string; exportedRevision?: string };
  expect: {
    speakers: "none" | "prefix" | "voice" | "name";
    translation: boolean;
    overlapRebuilt: boolean;
    quotesStraightened: boolean;
    referenceTextOnly?: boolean;
    textIsTranslation?: boolean;
  };
}

const historySource = JSON.parse(readFileSync(new URL("source.json", ROOT), "utf8")) as HistorySource;
const manifest = JSON.parse(readFileSync(new URL("manifest.json", ROOT), "utf8")) as { files: ManifestFile[] };
const exportedName = new Map(historySource.speakers.map((speaker) => [speaker.key, speaker.exportedName]));

/** Text as an ASS export of that release drew it: quotes straightened from 0.4.0 on, `\ { }` full-width. */
function assDrawn(text: string, straightened: boolean): string {
  return (straightened ? subtitleGlyphText(text) : text).replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");
}

/** Text as SRT / VTT import reads it: tags removed. */
function lineRead(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

const timed = manifest.files.filter((entry) => entry.expect.referenceTextOnly !== true);

describe.each(timed)("historical export $file", (entry) => {
  const text = readFileSync(new URL(entry.file, ROOT), "utf8");
  const isAss = entry.file.endsWith(".ass");
  const document = readSubtitleDocument(text, { filename: entry.file });
  const inspection = inspectSubtitleDocument(document);
  const prefix = inspection.speakers.source === "prefix" && entry.expect.speakers === "prefix";
  const options: SubtitleImportOptions = {
    expectedDigest: DIGEST,
    ...(entry.expect.translation ? { translationLanguage: "en" } : {}),
    ...(prefix
      ? {
          speakers: {
            prefixNames: inspection.speakers.candidates.filter((candidate) => candidate.preselected).map((candidate) => candidate.key),
            unlabeled: entry.options.speakerLabels === "every" ? "unassigned" : "inherit",
          },
        }
      : {}),
  };
  const plan = planSubtitleImport(document, { language: historySource.original.language, options });
  const sentences = entry.expect.textIsTranslation === true ? historySource.sentences.filter((sentence) => sentence.translation !== undefined) : historySource.sentences;

  it("reads the format, count and the speaker source", () => {
    expect(document.format).toBe(isAss ? "ass" : entry.file.endsWith(".vtt") ? "vtt" : "srt");
    expect(inspection.cueCount).toBe(sentences.length);
    expect(inspection.droppedCues.count).toBe(0);
    if (entry.expect.speakers === "none" && inspection.speakers.source === "prefix") {
      // Sentences that open with "words:" are offered as candidates, but never preselected once.
      expect(inspection.speakers.candidates.map((candidate) => [candidate.key, candidate.count, candidate.preselected])).toEqual([
        ["Let me show the formula", 1, false],
        ["我想补充一点", 1, false],
      ]);
    } else {
      expect(inspection.speakers.source).toBe({ none: "none", prefix: "prefix", voice: "explicit", name: "explicit" }[entry.expect.speakers]);
    }
    expect(document.rebuiltFromSlices === true).toBe(entry.expect.overlapRebuilt);
    expect(document.package).toBeUndefined();
  });

  it("restores every sentence's time and text", () => {
    expect(plan.segments.map((segment) => [segment.startMs, segment.endMs])).toEqual(sentences.map((sentence) => [sentence.startMs, sentence.endMs]));
    const shown = (sentence: SourceSentence): string => (entry.expect.textIsTranslation === true ? (sentence.translation as string) : sentence.text);
    const expected = sentences.map((sentence) => (isAss ? assDrawn(shown(sentence), entry.expect.quotesStraightened) : lineRead(shown(sentence))));
    expect(plan.segments.map((segment) => segment.text)).toEqual(expected);
  });

  it("restores the translation lines it carries, sentence by sentence", () => {
    if (!entry.expect.translation) {
      expect(plan.translations).toEqual([]);
      expect(inspection.bilingual).toBeUndefined();
      return;
    }
    expect(inspection.bilingual?.source).toBe(isAss ? "style" : "lines");
    expect(inspection.bilingual?.languages).toBeUndefined();
    const lines = sentences.flatMap((sentence, segmentIndex) =>
      sentence.translation === undefined
        ? []
        : [{ segmentIndex, text: isAss ? assDrawn(sentence.translation, entry.expect.quotesStraightened) : lineRead(sentence.translation) }],
    );
    expect(plan.translations).toEqual([{ language: "en", lines }]);
  });

  it("restores speakers as far as the file names them", () => {
    const keyOf = (sentence: SourceSentence): string | null => {
      if (sentence.speaker === undefined) return null;
      const name = exportedName.get(sentence.speaker) as string;
      return isAss ? name.replace(/,/g, "，") : name;
    };
    let expected: Array<string | null>;
    if (entry.expect.speakers === "none") {
      expected = sentences.map(() => null);
    } else if (prefix && entry.options.speakerLabels !== "every") {
      // Names are written on turns only: an unlabelled sentence goes to the previous speaker (inferred).
      let previous: string | null = null;
      expected = sentences.map((sentence) => {
        const key = keyOf(sentence);
        // Sentence 9 is another speaker who shares the previous one's name: labelled as a new turn.
        const labelled = key !== null && (previous !== key || sentence.ordinal === 9);
        if (labelled) previous = key;
        return previous;
      });
    } else {
      expected = sentences.map(keyOf);
    }
    expect(plan.segments.map((segment) => segment.speakerKey)).toEqual(expected);
    // Two different speakers sharing a name become one in a standard format.
    if (entry.expect.speakers !== "none") {
      expect(plan.speakers.filter((speaker) => speaker.name === "张伟")).toHaveLength(1);
      expect(plan.speakers.find((speaker) => speaker.key === "发言人 3")).toEqual({ key: "发言人 3", ordinal: 3, fallbackName: "发言人 3" });
    }
  });

  if (!isAss) {
    it("imports exactly as the plain import without options", () => {
      const plain = planSubtitleImport(document, { language: historySource.original.language });
      const legacy = importedTranscript({ revisionId: "r", contentId: "c", language: "zh", subtitle: parseTimedSubtitle(text), newId: () => "x", createdAt: 0 });
      expect(plain.segments).toEqual(legacy.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, speakerKey: null })));
      expect(plain.speakers).toEqual([]);
      expect(plain.translations).toEqual([]);
    });
  }
});
