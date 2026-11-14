import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSubtitlePackage, withAssRestoreData, type SubtitlePackageSource } from "../../../../src/server/domain/export/ambersub.ts";
import { parseSubtitlePackage, serializeSubtitlePackage } from "../../../../src/server/domain/subtitle-package.ts";
import type { TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { SUBTITLE_ASS_DATA_CHUNK, SUBTITLE_IMPORT_MAX_BYTES } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";

function segment(id: string, ordinal: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { id: id as SegmentId, revisionId: "rev", ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, text, sourceSegmentIds: [], ...extra };
}

function translated(id: string, ordinal: number, source: string, text: string): TranscriptSegment {
  return segment(id, ordinal, text, { revisionId: "tr", sourceSegmentIds: [source as SegmentId] });
}

const SPEAKERS: SubtitlePackageSource["speakers"] = [
  { id: "spk-1", ordinal: 1, name: "张三", colorIndex: 0 },
  { id: "spk-2", ordinal: 2, colorIndex: 5 },
  // Same name as speaker 1, a different person.
  { id: "spk-3", ordinal: 3, name: "张三", colorIndex: 2 },
  // Never named by a sentence.
  { id: "spk-4", ordinal: 4, name: "李四", colorIndex: 3 },
];

describe("buildSubtitlePackage", () => {
  it("keys sentences by position in ordinal order and writes only the speakers they name, unnamed and same-named ones included", () => {
    const pkg = buildSubtitlePackage({
      revision: { language: "zh-CN" },
      // Out of order on purpose: the package follows the ordinals.
      segments: [
        segment("c", 2, "第三句", { speakerId: "spk-3" }),
        segment("a", 0, "第一句{\\b1}“引号”\n换行", { speakerId: "spk-1" }),
        segment("b", 1, "第二句", { speakerId: "spk-2" }),
        segment("d", 3, "没人说"),
      ],
      speakers: SPEAKERS,
      translations: [],
      version: "0.7.0",
    });
    expect(pkg).toEqual({
      format: "amber-subtitle",
      formatVersion: 1,
      generator: { app: "Amber", version: "0.7.0" },
      original: {
        language: "zh-CN",
        paragraphMarks: false,
        speakers: [
          { key: "s1", ordinal: 1, name: "张三", colorIndex: 0 },
          { key: "s2", ordinal: 2, colorIndex: 5 },
          { key: "s3", ordinal: 3, name: "张三", colorIndex: 2 },
        ],
        segments: [
          { key: "1", startMs: 0, endMs: 900, text: "第一句{\\b1}“引号”\n换行", speaker: "s1" },
          { key: "2", startMs: 1000, endMs: 1900, text: "第二句", speaker: "s2" },
          { key: "3", startMs: 2000, endMs: 2900, text: "第三句", speaker: "s3" },
          { key: "4", startMs: 3000, endMs: 3900, text: "没人说", speaker: null },
        ],
      },
      translations: [],
    });
    expect("name" in (pkg.original.speakers[1] as object)).toBe(false);
    expect(pkg.original.segments.every((line) => !("paragraphStart" in line))).toBe(true);
  });

  it("writes paragraphStart on every sentence exactly when the revision has paragraph marks", () => {
    const marked = buildSubtitlePackage({
      revision: { language: "en" },
      segments: [segment("a", 0, "A", { paragraphStart: true }), segment("b", 1, "B", { paragraphStart: false }), segment("c", 2, "C", { paragraphStart: true })],
      speakers: [],
      translations: [],
      version: "1",
    });
    expect(marked.original.paragraphMarks).toBe(true);
    expect(marked.original.segments.map((line) => line.paragraphStart)).toEqual([true, false, true]);
    const unmarked = buildSubtitlePackage({ revision: { language: "en" }, segments: [segment("a", 0, "A"), segment("b", 1, "B")], speakers: [], translations: [], version: "1" });
    expect(unmarked.original.paragraphMarks).toBe(false);
    expect(serializeSubtitlePackage(unmarked)).not.toContain("paragraphStart");
  });

  it("writes each translation by its sentences' single sources, languages in a fixed order, missing and blank lines left out", () => {
    const pkg = buildSubtitlePackage({
      revision: { language: "zh-CN" },
      segments: [segment("a", 0, "一"), segment("b", 1, "二"), segment("c", 2, "三")],
      speakers: [],
      translations: [
        { language: "ja", segments: [translated("j3", 2, "c", "さん"), translated("j1", 0, "a", "いち"), translated("j2", 1, "b", "  ")] },
        // Partial: the second sentence has no translation.
        { language: "en", segments: [translated("e1", 0, "a", "one"), translated("e3", 2, "c", "three")] },
      ],
      version: "1",
    });
    expect(pkg.translations).toEqual([
      { language: "en", segments: [{ sourceSegmentKey: "1", text: "one" }, { sourceSegmentKey: "3", text: "three" }] },
      { language: "ja", segments: [{ sourceSegmentKey: "1", text: "いち" }, { sourceSegmentKey: "3", text: "さん" }] },
    ]);
  });

  it("reads back field for field through the package reader, and serializes the same revision to the same bytes", () => {
    const source: SubtitlePackageSource = {
      revision: { language: "zh-CN" },
      segments: [
        segment("a", 0, "Hi, \"world\" <b>&", { speakerId: "spk-2", paragraphStart: true }),
        segment("b", 1, "同名不同人", { speakerId: "spk-3", paragraphStart: false }),
        segment("c", 2, "未分配", { paragraphStart: true }),
      ],
      speakers: SPEAKERS,
      translations: [{ language: "en", segments: [translated("e2", 1, "b", "Same name")] }],
      version: "0.7.0",
    };
    const pkg = buildSubtitlePackage(source);
    const serialized = serializeSubtitlePackage(pkg);
    expect(parseSubtitlePackage(serialized)).toEqual(pkg);
    expect(serializeSubtitlePackage(buildSubtitlePackage(source))).toBe(serialized);
  });
});

describe("buildSubtitlePackage with blank sentences", () => {
  it("leaves blank sentences out, with their translation lines and a speaker only they name, and the package still reads back", () => {
    const pkg = buildSubtitlePackage({
      revision: { language: "zh-CN" },
      segments: [
        segment("a", 0, "", { speakerId: "spk-4", paragraphStart: true }),
        segment("b", 1, "一", { speakerId: "spk-1", paragraphStart: false }),
        segment("c", 2, "  \n", { paragraphStart: true }),
        segment("d", 3, "二", { paragraphStart: false }),
        segment("e", 4, "三", { speakerId: "spk-2", paragraphStart: true }),
      ],
      speakers: SPEAKERS,
      translations: [{ language: "en", segments: [translated("ea", 0, "a", "blank"), translated("eb", 1, "b", "one"), translated("ec", 2, "c", "x"), translated("ee", 4, "e", "three")] }],
      version: "1",
    });
    expect(pkg.original.segments).toEqual([
      // The paragraph starts of the skipped sentences move to the next written one.
      { key: "1", startMs: 1000, endMs: 1900, text: "一", speaker: "s1", paragraphStart: true },
      { key: "2", startMs: 3000, endMs: 3900, text: "二", speaker: null, paragraphStart: true },
      { key: "3", startMs: 4000, endMs: 4900, text: "三", speaker: "s2", paragraphStart: true },
    ]);
    expect(pkg.original.speakers.map((speaker) => speaker.key)).toEqual(["s1", "s2"]);
    expect(pkg.translations).toEqual([{ language: "en", segments: [{ sourceSegmentKey: "1", text: "one" }, { sourceSegmentKey: "3", text: "three" }] }]);
    expect(parseSubtitlePackage(serializeSubtitlePackage(pkg))).toEqual(pkg);
  });

  it("has no sentence when every sentence is blank", () => {
    const pkg = buildSubtitlePackage({ revision: { language: "en" }, segments: [segment("a", 0, ""), segment("b", 1, " ")], speakers: SPEAKERS, translations: [], version: "1" });
    expect(pkg.original.segments).toEqual([]);
    expect(pkg.original.speakers).toEqual([]);
  });
});

describe("withAssRestoreData", () => {
  const DOCUMENT = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:02.00,Box,,0,0,0,,{\\an2\\pos(960,994)}甲",
    "Dialogue: 1,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an2\\pos(960,994)}甲",
    "",
  ].join("\n");
  const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
  const comments = (ass: string): string[] => ass.split(/\r?\n/).filter((line) => line.startsWith("Comment: "));

  it("appends the digest event and the package in base64 chunks, leaving the document before it untouched", () => {
    const serialized = `${JSON.stringify({ payload: "长".repeat(1500) })}\n`;
    const out = withAssRestoreData(DOCUMENT, serialized);
    expect(out.startsWith(DOCUMENT)).toBe(true);
    const events = comments(out);
    const prefix = "Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,amber-data,";
    expect(events.every((line) => line.startsWith(prefix))).toBe(true);
    const texts = events.map((line) => line.slice(prefix.length));
    const dialogue = DOCUMENT.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(texts[0]).toBe(`amber-data 1 ${sha256(dialogue.join("\n"))}`);
    const chunks = texts.slice(1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.slice(0, -1).every((chunk) => chunk.length === SUBTITLE_ASS_DATA_CHUNK)).toBe(true);
    expect((chunks.at(-1) as string).length).toBeLessThanOrEqual(SUBTITLE_ASS_DATA_CHUNK);
    expect(Buffer.from(chunks.join(""), "base64").toString("utf8")).toBe(serialized);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.slice(DOCUMENT.length).split("\n").filter(Boolean)).toEqual(events);
  });

  it("keeps CRLF line endings, digesting the dialogue without its carriage returns, and ends an unterminated document first", () => {
    const crlf = DOCUMENT.replace(/\n/g, "\r\n");
    const out = withAssRestoreData(crlf, "{}\n");
    expect(out.startsWith(crlf)).toBe(true);
    expect(out.slice(crlf.length)).toMatch(/^(Comment: [^\r\n]*\r\n)+$/);
    expect(comments(out)[0]).toBe(comments(withAssRestoreData(DOCUMENT, "{}\n"))[0]);
    const unterminated = DOCUMENT.trimEnd();
    expect(withAssRestoreData(unterminated, "{}\n").startsWith(`${unterminated}\nComment: `)).toBe(true);
  });

  it("returns the document unchanged when the restore data would push it past SUBTITLE_IMPORT_MAX_BYTES", () => {
    const serialized = `${JSON.stringify({ payload: "x".repeat(3000) })}\n`;
    const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
    const added = bytes(withAssRestoreData(DOCUMENT, serialized)) - bytes(DOCUMENT);
    const filler = `; ${"y".repeat(SUBTITLE_IMPORT_MAX_BYTES - bytes(DOCUMENT) - added - 3)}\n`;
    const fits = `${DOCUMENT}${filler}`;
    expect(bytes(withAssRestoreData(fits, serialized))).toBe(SUBTITLE_IMPORT_MAX_BYTES);
    const tooLarge = `${DOCUMENT}y${filler}`;
    expect(withAssRestoreData(tooLarge, serialized)).toBe(tooLarge);
  });
});

describe("package size", () => {
  it("fits a ten-hour transcript with two translations well under the import limit and reads back unchanged", () => {
    // One sentence every 2.5 s for 10 hours, with lengths typical of proofread Chinese lectures.
    const count = (10 * 3600 * 1000) / 2500;
    const original: TranscriptSegment[] = [];
    const english: TranscriptSegment[] = [];
    const japanese: TranscriptSegment[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `s${i}`;
      original.push({ ...segment(id, i, `第${i}句：这是一段用于估算体积的中文字幕，长度和真实课程相近。`, { speakerId: `spk-${(i % 3) + 1}` }), startMs: i * 2500, endMs: i * 2500 + 2400 });
      english.push(translated(`e${i}`, i, id, `Sentence ${i}: an English line of about the length a real translation of this sentence has.`));
      japanese.push(translated(`j${i}`, i, id, `第${i}文：実際の翻訳とほぼ同じ長さの日本語の字幕です。`));
    }
    const pkg = buildSubtitlePackage({
      revision: { language: "zh-CN" },
      segments: original,
      speakers: SPEAKERS,
      translations: [
        { language: "en", segments: english },
        { language: "ja", segments: japanese },
      ],
      version: "0.7.0",
    });
    const text = serializeSubtitlePackage(pkg);
    const bytes = Buffer.byteLength(text, "utf8");
    expect(pkg.original.segments).toHaveLength(count);
    expect(bytes).toBeLessThan(SUBTITLE_IMPORT_MAX_BYTES / 2);
    expect(parseSubtitlePackage(text)).toEqual(pkg);
  });
});
