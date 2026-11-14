import { describe, expect, it } from "vitest";
import { SPEAKER_NAME_MAX_GRAPHEMES, SPEAKER_PALETTE_SIZE, SPEAKERS_PER_CONTENT_MAX } from "../../../src/shared/defaults.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import {
  assDialogueDigest,
  parseSubtitlePackage,
  serializeSubtitlePackage,
  subtitleTextDigest,
  SUBTITLE_PACKAGE_VERSION,
  type SubtitlePackage,
} from "../../../src/server/domain/subtitle-package.ts";

function failure(run: () => unknown): { code: string; details?: unknown } {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) return { code: error.appError.code, details: error.appError.details };
    throw error;
  }
  throw new Error("expected a failure");
}

function sample(): SubtitlePackage {
  return {
    format: "amber-subtitle",
    formatVersion: 1,
    generator: { app: "Amber", version: "0.7.0" },
    original: {
      language: "zh-CN",
      paragraphMarks: true,
      speakers: [
        { key: "s1", ordinal: 1, name: "张三", colorIndex: 0 },
        { key: "s2", ordinal: 2, colorIndex: 1 },
      ],
      segments: [
        { key: "a", startMs: 0, endMs: 1000, text: "第一句。", speaker: "s1", paragraphStart: true },
        { key: "b", startMs: 1000, endMs: 2000, text: "第二句。", speaker: "s2", paragraphStart: false },
        { key: "c", startMs: 500, endMs: 2500, text: "第三句。", speaker: null, paragraphStart: true },
      ],
    },
    translations: [{ language: "en", segments: [{ sourceSegmentKey: "a", text: "First." }] }],
  };
}

/** The sample as JSON with one change applied to a plain copy. */
function variant(change: (raw: Record<string, any>) => void): string {
  const raw = JSON.parse(JSON.stringify(sample())) as Record<string, any>;
  change(raw);
  return JSON.stringify(raw);
}

describe("subtitle package", () => {
  it("reads back what it serializes, keeping sentence order", () => {
    const pkg = sample();
    const text = serializeSubtitlePackage(pkg);
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseSubtitlePackage(text)).toEqual(pkg);
    expect(parseSubtitlePackage(text).original.segments.map((segment) => segment.key)).toEqual(["a", "b", "c"]);
  });

  it("serializes the same package to the same bytes whatever the key order of its objects", () => {
    const pkg = sample();
    const shuffled = JSON.parse(JSON.stringify({ translations: pkg.translations, original: pkg.original, generator: pkg.generator, formatVersion: 1, format: pkg.format })) as SubtitlePackage;
    expect(serializeSubtitlePackage(shuffled)).toBe(serializeSubtitlePackage(pkg));
  });

  it("canonicalizes languages and normalizes names", () => {
    const pkg = parseSubtitlePackage(
      variant((raw) => {
        raw.original.language = "zh-cn";
        raw.translations[0].language = "EN-us";
        raw.original.speakers[0].name = "  张   三 ";
      }),
    );
    expect(pkg.original.language).toBe("zh-CN");
    expect(pkg.translations[0]?.language).toBe("en-US");
    expect(pkg.original.speakers[0]?.name).toBe("张 三");
  });

  it("ignores unknown optional fields of the same version", () => {
    const pkg = parseSubtitlePackage(
      variant((raw) => {
        raw.extra = { future: true };
        raw.original.segments[0].words = [{ text: "第一句", startMs: 0, endMs: 900 }];
        raw.original.speakers[0].avatar = "x";
        raw.translations[0].model = "m";
      }),
    );
    expect(pkg).toEqual(sample());
    expect(JSON.stringify(pkg)).not.toContain("future");
  });

  it("refuses a newer format version with its own code and both versions", () => {
    const error = failure(() => parseSubtitlePackage(variant((raw) => (raw.formatVersion = SUBTITLE_PACKAGE_VERSION + 1))));
    expect(error).toEqual({ code: "invalid_request.subtitle_newer", details: { formatVersion: 2, supportedVersion: 1 } });
  });

  const invalid: Array<[string, string | ((raw: Record<string, any>) => void)]> = [
    ["text that is not JSON", "{not json"],
    ["another format", (raw) => (raw.format = "other")],
    ["a version that is not a positive integer", (raw) => (raw.formatVersion = 0)],
    ["a fractional version", (raw) => (raw.formatVersion = 1.5)],
    ["a missing generator", (raw) => delete raw.generator],
    ["no sentences", (raw) => (raw.original.segments = [])],
    ["a time that is not a safe integer", (raw) => (raw.original.segments[0].endMs = Number.MAX_SAFE_INTEGER + 2)],
    ["a fractional time", (raw) => (raw.original.segments[0].endMs = 10.5)],
    ["a negative start", (raw) => (raw.original.segments[0].startMs = -1)],
    ["an end not after the start", (raw) => (raw.original.segments[0].endMs = 0)],
    ["blank text", (raw) => (raw.original.segments[0].text = " \n ")],
    ["a repeated segment key", (raw) => (raw.original.segments[1].key = "a")],
    ["an unknown speaker reference", (raw) => (raw.original.segments[0].speaker = "nobody")],
    ["a repeated speaker key", (raw) => (raw.original.speakers[1].key = "s1")],
    ["a repeated ordinal", (raw) => (raw.original.speakers[1].ordinal = 1)],
    ["an ordinal that is not positive", (raw) => (raw.original.speakers[1].ordinal = 0)],
    [
      "more speakers than a Content holds",
      (raw) => {
        raw.original.speakers = Array.from({ length: SPEAKERS_PER_CONTENT_MAX + 1 }, (_, index) => ({ key: `k${index}`, ordinal: index + 1, colorIndex: 0 }));
        raw.original.segments.forEach((segment: Record<string, unknown>) => (segment.speaker = null));
      },
    ],
    ["a color outside the palette", (raw) => (raw.original.speakers[0].colorIndex = SPEAKER_PALETTE_SIZE)],
    ["a name that is too long", (raw) => (raw.original.speakers[0].name = "名".repeat(SPEAKER_NAME_MAX_GRAPHEMES + 1))],
    ["an original language that is not BCP-47", (raw) => (raw.original.language = "zh_CN")],
    ["a translation language that is not BCP-47", (raw) => (raw.translations[0].language = "english!")],
    ["a translation in the original's language", (raw) => (raw.translations[0].language = "zh-TW")],
    [
      "a repeated translation language",
      (raw) => raw.translations.push({ language: "en", segments: [{ sourceSegmentKey: "b", text: "Second." }] }),
    ],
    ["a translation of an unknown sentence", (raw) => (raw.translations[0].segments[0].sourceSegmentKey = "zz")],
    ["two translation lines for one sentence", (raw) => raw.translations[0].segments.push({ sourceSegmentKey: "a", text: "Again." })],
    ["a blank translation line", (raw) => (raw.translations[0].segments[0].text = "  ")],
    ["paragraph marks missing on a sentence", (raw) => delete raw.original.segments[1].paragraphStart],
    [
      "paragraph marks without the flag",
      (raw) => {
        raw.original.paragraphMarks = false;
      },
    ],
    ["a first sentence that does not start a paragraph", (raw) => (raw.original.segments[0].paragraphStart = false)],
    ["a key that is too long", (raw) => (raw.original.segments[0].key = "k".repeat(65))],
  ];

  it.each(invalid)("refuses %s as a format error", (_name, change) => {
    const text = typeof change === "string" ? change : variant(change);
    expect(failure(() => parseSubtitlePackage(text)).code).toBe("invalid_request.subtitle_format");
  });

  it("accepts a package without paragraph marks when no sentence has one", () => {
    const pkg = parseSubtitlePackage(
      variant((raw) => {
        raw.original.paragraphMarks = false;
        raw.original.segments.forEach((segment: Record<string, unknown>) => delete segment.paragraphStart);
      }),
    );
    expect(pkg.original.segments.every((segment) => !("paragraphStart" in segment))).toBe(true);
  });
});

describe("restore data digests", () => {
  it("covers dialogue lines in order and ignores a trailing carriage return", () => {
    const lines = ["Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,a", "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,b"];
    expect(assDialogueDigest(lines)).toMatch(/^[0-9a-f]{64}$/);
    expect(assDialogueDigest(lines.map((line) => `${line}\r`))).toBe(assDialogueDigest(lines));
    expect(assDialogueDigest([...lines].reverse())).not.toBe(assDialogueDigest(lines));
  });

  it("digests subtitle text without its byte order mark", () => {
    expect(subtitleTextDigest("\uFEFFabc")).toBe(subtitleTextDigest("abc"));
    expect(subtitleTextDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
