import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundledFontMetrics } from "../../../src/server/adapters/fonts/otf-advances.ts";
import { escapeFilterValue } from "../../../src/server/adapters/media-ingest/ffmpeg-burner.ts";
import { SUBTITLE_FONT_FILE } from "../../../src/server/api/routes/fonts.ts";
import { ExportService, type ExportFile } from "../../../src/server/application/export.ts";
import type { SummaryRevision } from "../../../src/server/domain/artifact.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { buildSubtitlePackage } from "../../../src/server/domain/export/ambersub.ts";
import { assDialogueDigest, parseSubtitlePackage, serializeSubtitlePackage, type SubtitlePackage } from "../../../src/server/domain/subtitle-package.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import { burnSubtitleRequest } from "../../../src/server/pipeline/stages/burn.ts";
import { API_PAGE_SIZE_MAX, SUBTITLE_ASS_DATA_CHUNK } from "../../../src/shared/defaults.ts";
import type { ContentExportRequest, SubtitleExportRequest } from "../../../src/shared/dto/export.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement, type SubtitleStyle } from "../../../src/shared/subtitle-style.ts";
import { addLocalFile, ASR_LINES, seedExportCollection, seedExportContent, type ExportFixture, type ExportLine } from "../../fixtures/export/export-data.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { toolPath, toolsBinDir } from "../../fixtures/tools.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

const NOW = new Date(2026, 9, 1, 12).getTime();
const VERSION = "9.9.9";
const URL = "https://www.bilibili.com/video/BV1export?p=2";
const at = (seconds: number): string => `${URL}&t=${seconds}`;

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function setup(): { h: Harness; exports: ExportService; fixture: ExportFixture } {
  const h = createHarness();
  open.push(h);
  return { h, exports: new ExportService({ repository: h.repository, version: VERSION, now: () => NOW }), fixture: seedExportContent(h) };
}

async function text(file: ExportFile): Promise<string> {
  let out = "";
  for await (const chunk of file.body) out += chunk;
  return out;
}

function refusal(run: () => unknown): { class: string; userMessage: string } {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) return { class: error.appError.class, userMessage: error.appError.userMessage };
    throw error;
  }
  throw new Error("not refused");
}

const dialogues = (ass: string): string[] => ass.split("\n").filter((line) => line.startsWith("Dialogue: "));
const styles = (ass: string): string[] => ass.split("\n").filter((line) => line.startsWith("Style: "));

describe("ExportService", () => {
  it("ASS of non-exact_words revisions has no {\\k}; the exact_words revision is timed by its real words", async () => {
    const { exports, fixture } = setup();
    const ass = async (revisionId: string) => text(exports.exportContent(LOCAL, fixture.contentId, { format: "ass", revisionId }));
    const corrected = await ass(fixture.corrected.revision.id);
    const translated = await ass(fixture.translated.revision.id);
    const exact = await ass(fixture.asr.revision.id);
    expect(fixture.corrected.revision.timingFidelity).toBe("inherited_segment");
    expect(fixture.translated.revision.timingFidelity).toBe("segment_only");
    expect(corrected.match(/\{\\k/g)).toBeNull();
    expect(translated.match(/\{\\k/g)).toBeNull();
    expect(exact.match(/\{\\k/g)?.length ?? 0).toBeGreaterThan(0);
    expect(dialogues(exact).slice(0, 3)).toEqual([
      "Dialogue: 0,0:00:01.00,0:00:02.60,Default,,0,0,0,,{\\k40}Hello{\\k20}{\\k90} world.",
      "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\k50}你好{\\k0}世界",
      "Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,{\\k100}第二段｛＼b1｝开始",
    ]);
  });

  it("bilingual ASS has one Dialogue per cue and refuses a translation of another revision", async () => {
    const { exports, fixture } = setup();
    const ass = await text(
      exports.exportContent(LOCAL, fixture.contentId, { format: "ass-bilingual", revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id }),
    );
    const lines = dialogues(ass);
    expect(lines).toHaveLength(fixture.corrected.segments.length);
    lines.forEach((line, index) => expect(line.endsWith(`\\N{\\rTranslation}EN ${index + 1}`)).toBe(true));
    expect(lines[0]).toBe("Dialogue: 0,0:00:01.00,0:00:02.60,Default,,0,0,0,,Hi world.\\N{\\rTranslation}EN 1");

    const srt = await text(
      exports.exportContent(LOCAL, fixture.contentId, { format: "srt-bilingual", revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id }),
    );
    expect(srt.startsWith("1\n00:00:01,000 --> 00:00:02,600\nHi world.\nEN 1\n\n2\n")).toBe(true);

    // The translation's parent is the corrected revision, not the ASR original.
    const refused = refusal(() =>
      exports.exportContent(LOCAL, fixture.contentId, { format: "ass-bilingual", revisionId: fixture.asr.revision.id, translationRevisionId: fixture.translated.revision.id }),
    );
    expect(refused).toMatchObject({ class: "invalid_request" });
    expect(refused.userMessage).toContain("translationRevisionId");
    // A non-translation as the second track is refused the same way.
    expect(
      refusal(() =>
        exports.exportContent(LOCAL, fixture.contentId, { format: "srt-bilingual", revisionId: fixture.asr.revision.id, translationRevisionId: fixture.corrected.revision.id }),
      ).class,
    ).toBe("invalid_request");
  });

  it("six-hour time stamps keep their hours in SRT, ASS and Markdown; Markdown switches to h:mm:ss at 100 minutes", async () => {
    const { exports, fixture } = setup();
    const revisionId = fixture.asr.revision.id;
    const srt = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "srt", revisionId }));
    const ass = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ass", revisionId }));
    const markdown = await text(
      exports.exportContent(LOCAL, fixture.contentId, { format: "markdown", sections: { subtitles: { revisionId } }, backlinks: false }),
    );
    expect(srt).toContain("6\n06:00:01,234 --> 06:00:03,000\n六小时\n");
    expect(ass).toContain("Dialogue: 0,6:00:01.23,6:00:03.00,Default,");
    expect(markdown).toContain("[6:00:01] 六小时\n");
    expect(markdown).toContain("[99:59] 九十九分\n");
    expect(markdown).toContain("[1:40:00] 一百分\n");
  });

  it("Markdown with every section, in the Markdown export format's order, with back-links on a platform Content", async () => {
    const { exports, fixture } = setup();
    const body: ContentExportRequest = {
      format: "markdown",
      sections: {
        subtitles: { revisionId: fixture.asr.revision.id },
        transcript: { revisionId: fixture.corrected.revision.id },
        chapters: true,
        summary: { templateId: "summary.core" },
      },
      backlinks: true,
    };
    const file = exports.exportContent(LOCAL, fixture.contentId, body);
    expect(file).toMatchObject({ filename: "示例课程：第一讲导论.md", contentType: "text/markdown; charset=utf-8" });
    expect(await text(file)).toBe(
      [
        "# 示例课程：第一讲/导论",
        "",
        `> 来源：${URL} · 时长 6:00:03 · 导出于 2026-10-01 · Amber ${VERSION}`,
        "",
        "## 总结（核心总结）",
        "",
        "## 摘要",
        `开场 [00:01](${at(1)})，结尾 [6:00:01](${at(21601)})，另有 [引用无法定位]。`,
        "",
        "## 章节",
        "",
        `- [00:01](${at(1)}) 开场 — 问候与介绍`,
        `- [99:59](${at(5999)}) 收尾`,
        "",
        "## 原文细读（校对稿 · m · 2026-10-01 12:00）",
        "",
        "### 开场",
        "",
        `**[00:01](${at(1)})** Hi world. 你好世界`,
        "",
        `**[00:09](${at(9)})** 第二段{\\b1}开始`,
        "",
        "### 收尾",
        "",
        `**[99:59](${at(5999)})** 九十九分 一百分`,
        "",
        `**[6:00:01](${at(21601)})** 六小时`,
        "",
        "## 字幕",
        "",
        "[00:01] Hello world.",
        "[00:03] 你好世界",
        "[00:09] 第二段{\\b1}开始",
        "[99:59] 九十九分",
        "[1:40:00] 一百分",
        "[6:00:01] 六小时",
        "",
      ].join("\n"),
    );
  });

  it("embeds chapter headings in the transcript only when chapters are exported too; TXT never carries them", async () => {
    const { exports, fixture } = setup();
    const transcriptOnly = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "markdown", sections: { transcript: { revisionId: fixture.corrected.revision.id } }, backlinks: false }));
    expect(transcriptOnly).toContain("## 原文细读（校对稿 · m · 2026-10-01 12:00）\n\n**[00:01]** Hi world. 你好世界\n");
    expect(transcriptOnly).not.toContain("###");
    expect(transcriptOnly).not.toContain("开场");
    const txt = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "txt", revisionId: fixture.corrected.revision.id }));
    expect(txt).not.toContain("开场");
    expect(txt).not.toContain("#");
  });

  it("reads a revision with paragraph marks by its marks: no length cap, a chapter start still closes the paragraph", async () => {
    const { h, exports, fixture } = setup();
    const revisionId = h.newId();
    const body = "字".repeat(150) + "。";
    const starts = [true, false, false, true, false, false];
    const segments: TranscriptSegment[] = starts.map((paragraphStart, ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId,
      ordinal,
      // Straddles the fixture's second chapter (5_999_000): sentences 4–5 fall into 收尾.
      startMs: ordinal < 4 ? 1000 + ordinal * 1000 : 5_999_000 + (ordinal - 4) * 1000,
      endMs: (ordinal < 4 ? 1000 + ordinal * 1000 : 5_999_000 + (ordinal - 4) * 1000) + 900,
      text: body,
      paragraphStart,
      sourceSegmentIds: [],
    }));
    const revision: TranscriptRevision = {
      id: revisionId,
      contentId: fixture.contentId,
      kind: "imported",
      language: "zh-CN",
      timingFidelity: "segment_only",
      generation: { kind: "imported", format: "srt" },
      segmentCount: segments.length,
      createdAt: NOW,
    };
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision, segments));

    // Marks win over the 200-char cap: three 151-char sentences stay one paragraph.
    const txt = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "txt", revisionId }));
    expect(txt).toBe(`${body}${body}${body}\n\n${body}${body}${body}\n`);

    const markdown = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "markdown", sections: { chapters: true, transcript: { revisionId } }, backlinks: false }));
    const transcript = markdown.slice(markdown.indexOf("## 原文细读"));
    expect(transcript).toBe(
      ["## 原文细读（导入字幕 · 2026-10-01 12:00）", "", "### 开场", "", `**[00:01]** ${body}${body}${body}`, "", `**[00:04]** ${body}`, "", "### 收尾", "", `**[99:59]** ${body}${body}`, ""].join("\n"),
    );
  });

  it("back-links off leave only time text; a local Content never links and names its file as the source", async () => {
    const { h, exports, fixture } = setup();
    const off = await text(
      exports.exportContent(LOCAL, fixture.contentId, { format: "markdown", sections: { summary: { templateId: "summary.core" }, chapters: true }, backlinks: false }),
    );
    expect(off).not.toContain("](");
    expect(off).toContain("开场 [00:01]，结尾 [6:00:01]，另有 [引用无法定位]。");
    expect(off).toContain("- [00:01] 开场 — 问候与介绍\n");

    const local = seedExportContent(h, LOCAL.userId, "local");
    addLocalFile(h, local.contentId, "第一讲.mp4");
    const file = exports.exportContent(LOCAL, local.contentId, {
      format: "markdown",
      sections: { summary: { templateId: "summary.core" }, transcript: { revisionId: local.corrected.revision.id } },
      backlinks: true,
    });
    const markdown = await text(file);
    expect(file.filename).toBe("第一讲.mp4.md");
    expect(markdown.startsWith(`# 第一讲.mp4\n\n> 来源：第一讲.mp4 · 时长 6:00:03 · 导出于 2026-10-01 · Amber ${VERSION}\n`)).toBe(true);
    expect(markdown).not.toContain("](");
    expect(markdown).toContain("**[00:01]** Hi world. 你好世界\n");
    expect(markdown).toContain("开场 [00:01]，结尾 [6:00:01]");
  });

  it("a summary stored with long citation runs is exported with each run cut to two, alone and inside a collection; storage is untouched", async () => {
    const { h, exports, fixture } = setup();
    const marks = fixture.corrected.segments.slice(0, 5).map((segment) => `[[seg:${segment.id}]]`);
    const stored = `## 摘要\n要点${marks.join("")}。另一处 ${marks[3]}、${marks[4]} ${marks[0]}，再一处${marks[2]}\n`;
    const revisionId = h.newId();
    h.repository.withTransaction((scope) => {
      const previous = scope.summaries.getRevision(LOCAL.userId, fixture.summaryRevisionId) as SummaryRevision;
      const citations = fixture.corrected.segments.slice(0, 5).map((segment) => ({ transcriptRevisionId: fixture.corrected.revision.id, segmentId: segment.id }));
      scope.summaries.insertRevision(LOCAL.userId, {
        contentId: fixture.contentId,
        templateId: "summary.core",
        artifactId: previous.artifactId,
        revision: { id: revisionId, provenance: previous.provenance, quality: "normal", body: stored, citations },
      });
      scope.summaries.setCurrent(LOCAL.userId, previous.artifactId, revisionId);
    });
    const stampsPerClause = (markdown: string) =>
      (markdown.split("\n").find((line) => line.startsWith("要点")) ?? "").split(/[。，]/).map((clause) => clause.match(/\[\d/g)?.length ?? 0);

    const alone = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "markdown", sections: { summary: { templateId: "summary.core" } }, backlinks: false }));
    expect(stampsPerClause(alone)).toEqual([2, 2, 1]);
    const local = seedExportContent(h, LOCAL.userId, "local");
    const collectionId = seedExportCollection(h, fixture, local);
    const inCollection = await text(exports.exportCollection(LOCAL, collectionId, { backlinks: false }));
    expect(stampsPerClause(inCollection)).toEqual([2, 2, 1]);
    expect(h.db.prepare("SELECT body FROM summary_revision WHERE id = ?").get(revisionId)).toEqual({ body: stored });
  });

  it("collection Markdown holds the collection summary and each lecture's title with its core summary inline", async () => {
    const { h, exports, fixture } = setup();
    const local = seedExportContent(h, LOCAL.userId, "local");
    addLocalFile(h, local.contentId, "第二讲.mp4");
    const collectionId = seedExportCollection(h, fixture, local);
    const bare = createLocalContent(h);
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId, contentId: bare, position: 2, addedAt: 1 }));

    const file = exports.exportCollection(LOCAL, collectionId, { backlinks: true });
    expect(file).toMatchObject({ filename: "示例合集.md", contentType: "text/markdown; charset=utf-8" });
    expect(await text(file)).toBe(
      [
        "# 示例合集",
        "",
        `> 导出于 2026-10-01 · Amber ${VERSION}`,
        "",
        "## 合集归纳",
        "",
        "## 这门课在讲什么",
        // Stored while collection summaries still cited; exported without the citation.
        "总起",
        "",
        "## 各项内容",
        "",
        `### [示例课程：第一讲/导论](${URL})`,
        "",
        "## 摘要",
        `开场 [00:01](${at(1)})，结尾 [6:00:01](${at(21601)})，另有 [引用无法定位]。`,
        "",
        "### 第二讲.mp4",
        "",
        "## 摘要",
        "开场 [00:01]，结尾 [6:00:01]，另有 [引用无法定位]。",
        "",
        "### 未命名",
        "",
        "（尚无核心总结）",
        "",
      ].join("\n"),
    );
    const plain = await text(exports.exportCollection(LOCAL, collectionId, { backlinks: false }));
    expect(plain).not.toContain("&t=");
  });

  it("VTT starts with WEBVTT and times cues HH:MM:SS.mmm; TXT has no time stamps and breaks paragraphs by PARAGRAPH_GAP_MS", async () => {
    const { exports, fixture } = setup();
    const revisionId = fixture.corrected.revision.id;
    const vtt = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "vtt", revisionId }));
    expect(vtt.startsWith("WEBVTT\n\n00:00:01.000 --> 00:00:02.600\nHi world.\n\n")).toBe(true);
    const cueLines = vtt.split("\n").filter((line) => line.includes("-->"));
    expect(cueLines).toHaveLength(6);
    cueLines.forEach((line) => expect(line).toMatch(/^\d{2,}:\d{2}:\d{2}\.\d{3} --> \d{2,}:\d{2}:\d{2}\.\d{3}$/));
    expect(cueLines.at(-1)).toBe("06:00:01.234 --> 06:00:03.000");

    const txt = exports.exportContent(LOCAL, fixture.contentId, { format: "txt", revisionId });
    expect(txt.contentType).toBe("text/plain; charset=utf-8");
    const body = await text(txt);
    expect(body).toBe("Hi world. 你好世界\n\n第二段{\\b1}开始\n\n九十九分 一百分\n\n六小时\n");
    expect(body).not.toMatch(/\d+:\d{2}/);
  });

  it("reads long revisions page by page and still pairs every translated line with its original", async () => {
    const { h, exports, fixture } = setup();
    const count = API_PAGE_SIZE_MAX * 2 + 7;
    const make = (kind: "imported" | "translated", parent?: { revision: TranscriptRevision; segments: TranscriptSegment[] }) => {
      const id = h.newId();
      const revision: TranscriptRevision = {
        id,
        contentId: fixture.contentId,
        kind,
        ...(parent === undefined ? {} : { parentRevisionId: parent.revision.id }),
        language: kind === "imported" ? "zh-CN" : "en",
        timingFidelity: "segment_only",
        generation: kind === "imported" ? { kind: "imported", format: "srt" } : { kind: "manual" },
        segmentCount: count,
        createdAt: 1,
      };
      const segments: TranscriptSegment[] = Array.from({ length: count }, (_, ordinal) => ({
        id: h.newId() as SegmentId,
        revisionId: id,
        ordinal,
        startMs: ordinal * 1000,
        endMs: ordinal * 1000 + 900,
        text: kind === "imported" ? `原${ordinal}` : `T${ordinal}`,
        sourceSegmentIds: parent === undefined ? [] : [(parent.segments[ordinal] as TranscriptSegment).id],
      }));
      h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision, segments));
      return { revision, segments };
    };
    const original = make("imported");
    const translation = make("translated", original);
    const srt = await text(
      exports.exportContent(LOCAL, fixture.contentId, { format: "srt-bilingual", revisionId: original.revision.id, translationRevisionId: translation.revision.id }),
    );
    const cues = srt.trimEnd().split("\n\n");
    expect(cues).toHaveLength(count);
    cues.forEach((cue, ordinal) => expect(cue.endsWith(`\n原${ordinal}\nT${ordinal}`)).toBe(true));
  });

  it("refuses before the first byte: foreign Content, foreign revision, a missing section", () => {
    const { h, exports, fixture } = setup();
    const other = seedExportContent(h, LOCAL.userId, "local");
    expect(refusal(() => exports.exportContent(BOB, fixture.contentId, { format: "srt", revisionId: fixture.asr.revision.id })).class).toBe("not_found");
    expect(refusal(() => exports.exportContent(LOCAL, fixture.contentId, { format: "srt", revisionId: other.asr.revision.id })).class).toBe("not_found");
    expect(
      refusal(() => exports.exportContent(LOCAL, fixture.contentId, { format: "markdown", sections: { transcript: { revisionId: other.asr.revision.id } }, backlinks: true })).class,
    ).toBe("not_found");

    const missingSummary = refusal(() =>
      exports.exportContent(LOCAL, fixture.contentId, { format: "markdown", sections: { summary: { templateId: "summary.detailed" } }, backlinks: true }),
    );
    expect(missingSummary.class).toBe("invalid_request");
    expect(missingSummary.userMessage).toContain("sections.summary");

    const bare = createLocalContent(h);
    const missingChapters = refusal(() => exports.exportContent(LOCAL, bare, { format: "markdown", sections: { chapters: true }, backlinks: true }));
    expect(missingChapters.userMessage).toContain("sections.chapters");
    expect(refusal(() => exports.exportCollection(BOB, h.newId(), { backlinks: true })).class).toBe("not_found");
  });
});

describe("ExportService, styled ASS", () => {
  const style: SubtitleStyle = {
    appearance: { ...defaultSubtitleAppearance(), original: { fontSize: 50, color: "#FF0000" }, translation: { fontSize: 40, color: "#00FF00" } },
    placement: defaultSubtitlePlacement(),
  };
  const styleOf = (ass: string, name: string) => ass.split("\n").find((line) => line.startsWith(`Style: ${name},`));

  it("writes the styled file on the 1920 x 1080 reference canvas, without karaoke, when a style is given", async () => {
    const { exports, fixture } = setup();
    const ass = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ass", revisionId: fixture.asr.revision.id, style }));
    expect(ass).toContain("PlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n");
    expect(styleOf(ass, "Default")).toContain(",50,&H000000FF,");
    expect(ass).not.toContain("{\\k");
    expect(dialogues(ass)[0]).toBe("Dialogue: 1,0:00:01.00,0:00:02.60,Default,,0,0,0,,{\\an2\\pos(960,994)}Hello world.");
    expect(dialogues(ass)[2]).toContain("第二段｛＼b1｝开始");
  });

  it("shows a translated revision alone in the translation appearance, and both lines bilingually", async () => {
    const { exports, fixture } = setup();
    const single = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ass", revisionId: fixture.translated.revision.id, style }));
    expect(dialogues(single)[0]).toBe("Dialogue: 1,0:00:01.00,0:00:02.60,Translation,,0,0,0,,{\\an2\\pos(960,994)}EN 1");
    const both = await text(
      exports.exportContent(LOCAL, fixture.contentId, { format: "ass-bilingual", revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id, style }),
    );
    expect(dialogues(both)[0]).toBe("Dialogue: 1,0:00:01.00,0:00:02.60,Default,,0,0,0,,{\\an2\\pos(960,994)}Hi world.\\N{\\rTranslation}EN 1");
  });

  it("boxes only the translation line of a bilingual download when the scope says so, and the whole block otherwise", async () => {
    const { exports, fixture } = setup();
    const download = (scope: SubtitleStyle["appearance"]["background"]["scope"]) =>
      text(
        exports.exportContent(LOCAL, fixture.contentId, {
          format: "ass-bilingual",
          revisionId: fixture.corrected.revision.id,
          translationRevisionId: fixture.translated.revision.id,
          style: { ...style, appearance: { ...style.appearance, background: { enabled: true, color: "#000000", opacityPct: 50, padding: 12, scope } } },
        }),
      );
    const line = await download("translation");
    expect(styleOf(line, "LineTranslation")).toBe("Style: LineTranslation,Noto Sans SC,40,&HFF000000,&HFF000000,&H80000000,&HFF000000,0,0,0,0,100,100,0,0,3,12,0,2,192,192,0,1");
    expect(styleOf(line, "Box")).toBeUndefined();
    expect(dialogues(line)[0]).toBe("Dialogue: 0,0:00:01.00,0:00:02.60,Ghost,,0,0,0,,{\\an2\\pos(960,994)}Hi world.\\N{\\rLineTranslation}EN 1");
    const block = await download("both");
    expect(styleOf(block, "BoxTranslation")).toBe("Style: BoxTranslation,Noto Sans SC,40,&HFF000000,&HFF000000,&HFF000000,&H80000000,0,0,0,0,100,100,0,0,4,12,0,2,192,192,0,1");
    expect(styleOf(block, "Line")).toBeUndefined();
    expect(dialogues(block)[0]).toBe("Dialogue: 0,0:00:01.00,0:00:02.60,Box,,0,0,0,,{\\an2\\pos(960,994)}Hi world.\\N{\\rBoxTranslation}EN 1");
  });

  it("renders the styled ASS of a subtitled video export on the given canvas, checking the translation like a bilingual export", async () => {
    const { exports, fixture } = setup();
    let out = "";
    for await (const piece of exports.styledAssOf(LOCAL.userId, fixture.contentId, {
      mode: "translation",
      revisionId: fixture.corrected.revision.id,
      translationRevisionId: fixture.translated.revision.id,
      style,
      playRes: { width: 608, height: 1080 },
      textOnly: true,
    })) {
      out += piece;
    }
    expect(out).toContain("PlayResX: 608\n");
    expect(dialogues(out)[0]).toBe("Dialogue: 1,0:00:01.00,0:00:02.60,Translation,,0,0,0,,{\\an2\\pos(304,994)}EN 1");
    expect(
      refusal(() =>
        exports.styledAssOf(LOCAL.userId, fixture.contentId, {
          mode: "bilingual", revisionId: fixture.asr.revision.id, translationRevisionId: fixture.translated.revision.id, style, playRes: { width: 1920, height: 1080 }, textOnly: false,
        }),
      ).class,
    ).toBe("invalid_request");
  });
});

describe("ExportService, styled ASS line breaking", () => {
  const style: SubtitleStyle = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };
  /** A font whose every character is ten em wide: on a 608-wide canvas no line of two characters or more fits. */
  const WIDE = { advances: () => ({ advanceEm: () => 10 }) };
  const styled = async (exports: ExportService, contentId: string, revisionId: string, textOnly: boolean): Promise<string> => {
    let out = "";
    for await (const piece of exports.styledAssOf(LOCAL.userId, contentId, { mode: "original", revisionId, style, playRes: { width: 608, height: 1080 }, textOnly })) {
      out += piece;
    }
    return out;
  };

  it("breaks styled lines by the bundled font's advances, and leaves text-only tracks and an unreadable font to the renderer", async () => {
    const { h, exports: plain, fixture } = setup();
    const withFont = new ExportService({ repository: h.repository, version: VERSION, now: () => NOW, fontMetrics: WIDE });
    const withoutFont = new ExportService({ repository: h.repository, version: VERSION, now: () => NOW, fontMetrics: { advances: () => undefined } });
    const revisionId = fixture.corrected.revision.id;
    const broken = await styled(withFont, fixture.contentId, revisionId, false);
    expect(dialogues(broken)[0]).toBe("Dialogue: 1,0:00:01.00,0:00:02.60,Default,,0,0,0,,{\\an2\\pos(304,994)}H\\Ni\\Nw\\No\\Nr\\Nl\\Nd\\N.");
    expect(await styled(withoutFont, fixture.contentId, revisionId, false)).toBe(await styled(plain, fixture.contentId, revisionId, false));
    expect(await styled(withFont, fixture.contentId, revisionId, true)).toBe(await styled(plain, fixture.contentId, revisionId, true));
  });
});

describe("ExportService with speakers", () => {
  const A = "spk-a";
  const B = "spk-b";
  /** Sentences 0-1 are A, 2-3 are B, 4 nobody, 5 A again; a long pause precedes 2, 3 and 5. */
  const OWNERS = [A, A, B, B, undefined, A] as const;
  const withSpeakers = (owners: ReadonlyArray<string | undefined>): ExportLine[] =>
    ASR_LINES.map((line, index) => ({ ...line, ...(owners[index] === undefined ? {} : { speakerId: owners[index] as string }) }));

  function setupSpeakers(options: { owners?: ReadonlyArray<string | undefined>; names?: Record<string, string>; language?: string } = {}): { exports: ExportService; fixture: ExportFixture } {
    const h = createHarness();
    open.push(h);
    const fixture = seedExportContent(h, LOCAL.userId, "bilibili", {
      lines: withSpeakers(options.owners ?? OWNERS),
      speakerNames: options.names ?? { [A]: "张三" },
      ...(options.language === undefined ? {} : { language: options.language }),
    });
    return { exports: new ExportService({ repository: h.repository, version: VERSION, now: () => NOW }), fixture };
  }

  const exportText = (exports: ExportService, fixture: ExportFixture, body: Record<string, unknown>): Promise<string> =>
    text(exports.exportContent(LOCAL, fixture.contentId, body as ContentExportRequest));
  const subtitle = (fixture: ExportFixture, format: string, extra: Record<string, unknown> = {}) => ({ format, revisionId: fixture.corrected.revision.id, ...extra });

  it("labels the first cue of each turn in SRT by default, with a full-width colon for a Chinese revision", async () => {
    const { exports, fixture } = setupSpeakers();
    const srt = await exportText(exports, fixture, subtitle(fixture, "srt", { includeSpeakers: true }));
    const lines = srt.split("\n\n").map((cue) => cue.split("\n")[2]);
    expect(lines.slice(0, 6)).toEqual(["张三：Hi world.", "你好世界", "发言人 2：第二段{\\b1}开始", "九十九分", "一百分", "张三：六小时"]);
    expect(await exportText(exports, fixture, subtitle(fixture, "srt", { includeSpeakers: true, speakerLabels: "turn" }))).toBe(srt);
  });

  it("labels every cue with speakerLabels every, but never an unassigned one", async () => {
    const { exports, fixture } = setupSpeakers();
    const srt = await exportText(exports, fixture, subtitle(fixture, "srt", { includeSpeakers: true, speakerLabels: "every" }));
    expect(srt.split("\n\n").slice(0, 6).map((cue) => cue.split("\n")[2])).toEqual([
      "张三：Hi world.",
      "张三：你好世界",
      "发言人 2：第二段{\\b1}开始",
      "发言人 2：九十九分",
      "一百分",
      "张三：六小时",
    ]);
  });

  it("uses `Name: ` for a revision that is not Chinese and never labels the translation line", async () => {
    const { exports, fixture } = setupSpeakers({ language: "en" });
    const srt = await exportText(exports, fixture, subtitle(fixture, "srt", { includeSpeakers: true }));
    expect(srt.startsWith("1\n00:00:01,000 --> 00:00:02,600\n张三: Hi world.\n\n")).toBe(true);
    const bilingual = await exportText(
      exports,
      fixture,
      subtitle(fixture, "srt-bilingual", { translationRevisionId: fixture.translated.revision.id, includeSpeakers: true, speakerLabels: "every" }),
    );
    expect(bilingual.startsWith("1\n00:00:01,000 --> 00:00:02,600\n张三: Hi world.\nEN 1\n\n2\n00:00:03,000 --> 00:00:04,000\n张三: 你好世界\nEN 2\n\n")).toBe(true);
    expect(bilingual).not.toMatch(/\n(张三|发言人 2)[:：] EN/);
  });

  it("writes voice tags in VTT for every cue with a speaker", async () => {
    const { exports, fixture } = setupSpeakers();
    const vtt = await exportText(exports, fixture, subtitle(fixture, "vtt", { includeSpeakers: true, speakerLabels: "turn" }));
    const bodies = vtt.split("\n\n").slice(1, 7).map((cue) => cue.split("\n")[1]);
    expect(bodies).toEqual(["<v 张三>Hi world.", "<v 张三>你好世界", "<v 发言人 2>第二段{\\b1}开始", "<v 发言人 2>九十九分", "一百分", "<v 张三>六小时"]);
  });

  it("labels TXT paragraphs: the first of each turn by default, each with every", async () => {
    const { exports, fixture } = setupSpeakers();
    const turn = await exportText(exports, fixture, subtitle(fixture, "txt", { includeSpeakers: true }));
    expect(turn).toBe("张三：Hi world. 你好世界\n\n发言人 2：第二段{\\b1}开始\n\n九十九分\n\n一百分\n\n张三：六小时\n");
    const every = await exportText(exports, fixture, subtitle(fixture, "txt", { includeSpeakers: true, speakerLabels: "every" }));
    expect(every).toBe("张三：Hi world. 你好世界\n\n发言人 2：第二段{\\b1}开始\n\n发言人 2：九十九分\n\n一百分\n\n张三：六小时\n");
  });

  it("fills the Name field in the fixed-style ASS, bilingual too", async () => {
    const { exports, fixture } = setupSpeakers();
    const names = (ass: string) => dialogues(ass).map((line) => line.split(",")[4]);
    expect(names(await exportText(exports, fixture, subtitle(fixture, "ass", { includeSpeakers: true })))).toEqual(["张三", "张三", "发言人 2", "发言人 2", "", "张三"]);
    const bilingual = await exportText(exports, fixture, subtitle(fixture, "ass-bilingual", { translationRevisionId: fixture.translated.revision.id, includeSpeakers: true }));
    expect(dialogues(bilingual)[0]).toBe("Dialogue: 0,0:00:01.00,0:00:02.60,Default,张三,0,0,0,,Hi world.\\N{\\rTranslation}EN 1");
    // The exact-words original keeps its karaoke timing next to the name.
    expect(dialogues(await exportText(exports, fixture, { format: "ass", revisionId: fixture.asr.revision.id, includeSpeakers: true }))[0]).toBe(
      "Dialogue: 0,0:00:01.00,0:00:02.60,Default,张三,0,0,0,,{\\k40}Hello{\\k20}{\\k90} world.",
    );
  });

  it("fills the Name field in styled ASS from the shown revision; a video export's ASS carries no names", async () => {
    const { exports, fixture } = setupSpeakers();
    const style = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };
    const names = (ass: string) => dialogues(ass).map((line) => line.split(",")[4]);
    const original = await exportText(exports, fixture, subtitle(fixture, "ass", { style, includeSpeakers: true }));
    expect(names(original)).toEqual(["张三", "张三", "发言人 2", "发言人 2", "", "张三"]);
    const bilingual = await exportText(exports, fixture, subtitle(fixture, "ass-bilingual", { style, translationRevisionId: fixture.translated.revision.id, includeSpeakers: true }));
    expect(names(bilingual)).toEqual(names(original));
    const translated = await exportText(exports, fixture, { format: "ass", revisionId: fixture.translated.revision.id, style, includeSpeakers: true });
    expect(names(translated)).toEqual(names(original));

    let burned = "";
    for await (const piece of exports.styledAssOf(LOCAL.userId, fixture.contentId, { mode: "original", revisionId: fixture.corrected.revision.id, style, playRes: { width: 1920, height: 1080 }, textOnly: false })) {
      burned += piece;
    }
    expect(names(burned)).toEqual(["", "", "", "", "", ""]);
  });

  it("draws label lines in a styled ASS download from the names as they are now, keeping the Name field rule", async () => {
    const { exports, fixture } = setupSpeakers({ names: { [A]: "张三", [B]: "很".repeat(20) } });
    const style = { appearance: { ...defaultSubtitleAppearance(), speaker: "change" as const }, placement: defaultSubtitlePlacement() };
    const rows = (ass: string) => dialogues(ass).map((line) => line.slice(line.indexOf("}") + 1).split("\\N").map((row) => row.replace(/^\{\\r[A-Za-z]+\}/u, "")));
    const ass = await exportText(exports, fixture, subtitle(fixture, "ass", { style }));
    const long = `${"很".repeat(16)}…`;
    // The pause before sentence 3 is longer than the repeat time, so its speaker is named again.
    expect(rows(ass)).toEqual([["张三", "Hi world."], ["你好世界"], [long, "第二段｛＼b1｝开始"], [long, "九十九分"], ["一百分"], ["张三", "六小时"]]);
    expect(styles(ass).map((line) => line.split(",")[0])).toContain("Style: Speaker");
    const named = await exportText(exports, fixture, subtitle(fixture, "ass", { style, includeSpeakers: true }));
    // The Name field keeps whole names: only the drawn label is cut.
    expect(dialogues(named).map((line) => line.split(",")[4])).toEqual(["张三", "张三", "很".repeat(20), "很".repeat(20), "", "张三"]);
  });

  it("draws a video export's label lines from the labels frozen with it, never the names as they are now", async () => {
    const { exports, fixture } = setupSpeakers();
    const style = { appearance: { ...defaultSubtitleAppearance(), speaker: "every" as const }, placement: defaultSubtitlePlacement() };
    let burned = "";
    for await (const piece of exports.styledAssOf(LOCAL.userId, fixture.contentId, {
      mode: "original",
      revisionId: fixture.corrected.revision.id,
      style,
      playRes: { width: 1920, height: 1080 },
      textOnly: false,
      speakerLabels: { [A]: "旧名" },
    })) {
      burned += piece;
    }
    expect(dialogues(burned).map((line) => line.split(",")[3])).toEqual(["Speaker", "Speaker", "Default", "Default", "Default", "Speaker"]);
    expect(burned).toContain("}旧名\\N{\\rDefault}Hi world.");
    expect(burned).not.toContain("张三");
  });

  it("leaves Name empty for a styled slice that mixes speakers", async () => {
    const h = createHarness();
    open.push(h);
    const lines: ExportLine[] = [
      { startMs: 0, endMs: 3000, text: "长话", speakerId: A },
      { startMs: 1000, endMs: 2000, text: "插话", speakerId: B },
      ...ASR_LINES.slice(2),
    ];
    const fixture = seedExportContent(h, LOCAL.userId, "bilibili", { lines, speakerNames: { [A]: "甲", [B]: "乙" } });
    const exports = new ExportService({ repository: h.repository, version: VERSION, now: () => NOW });
    const style = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };
    const ass = await exportText(exports, fixture, subtitle(fixture, "ass", { style, includeSpeakers: true }));
    expect(dialogues(ass).map((line) => line.split(",")[4]).slice(0, 4)).toEqual(["甲", "", "甲", ""]);
  });

  it("names the first paragraph of each turn in the Markdown transcript, again after a chapter heading", async () => {
    const { exports, fixture } = setupSpeakers();
    const body = { format: "markdown", sections: { transcript: { revisionId: fixture.corrected.revision.id } }, backlinks: false, includeSpeakers: true };
    const plain = await exportText(exports, fixture, body);
    expect(plain).toContain("\n\n**张三** · **[00:01]** Hi world. 你好世界\n\n**发言人 2** · **[00:09]** 第二段{\\b1}开始\n\n**[99:59]** 九十九分\n\n**[1:40:00]** 一百分\n\n**张三** · **[6:00:01]** 六小时\n");
    const chaptered = await exportText(exports, fixture, { ...body, sections: { ...body.sections, chapters: true } });
    // 「收尾」 starts at the sentence of the same speaker: the reading view shows the speaker again there.
    expect(chaptered).toContain("### 收尾\n\n**发言人 2** · **[99:59]** 九十九分\n\n**[1:40:00]** 一百分\n\n");
  });

  it("is byte for byte the same without includeSpeakers, with it false, and when no sentence has a speaker", async () => {
    const { exports, fixture } = setupSpeakers();
    const h = createHarness();
    open.push(h);
    const bare = seedExportContent(h);
    const bareExports = new ExportService({ repository: h.repository, version: VERSION, now: () => NOW });
    const style = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };
    const requests = (f: ExportFixture): Record<string, unknown>[] => [
      ...(["srt", "vtt", "txt", "ass"] as const).map((format) => subtitle(f, format)),
      subtitle(f, "ass", { style }),
      subtitle(f, "srt-bilingual", { translationRevisionId: f.translated.revision.id }),
      subtitle(f, "ass-bilingual", { translationRevisionId: f.translated.revision.id, style }),
      { format: "ass", revisionId: f.asr.revision.id },
      {
        format: "markdown",
        sections: { transcript: { revisionId: f.corrected.revision.id }, chapters: true, subtitles: { revisionId: f.corrected.revision.id } },
        backlinks: true,
      },
    ];
    const withFlag = (request: Record<string, unknown>, extra: Record<string, unknown>) => ({ ...request, ...extra });
    for (const [index, request] of requests(fixture).entries()) {
      const absent = await exportText(exports, fixture, request);
      expect(await exportText(exports, fixture, withFlag(request, { includeSpeakers: false, speakerLabels: "every" })), `${index} false`).toBe(absent);
    }
    for (const [index, request] of requests(bare).entries()) {
      const absent = await exportText(bareExports, bare, request);
      expect(await exportText(bareExports, bare, withFlag(request, { includeSpeakers: true })), `${index} no speakers`).toBe(absent);
      expect(await exportText(bareExports, bare, withFlag(request, { includeSpeakers: true, speakerLabels: "every" })), `${index} no speakers, every`).toBe(absent);
    }
    // Known output of the fixture, unchanged by the speaker code.
    expect(await exportText(bareExports, bare, subtitle(bare, "srt"))).toMatch(/^1\n00:00:01,000 --> 00:00:02,600\nHi world\.\n\n2\n/);
  });

  it("writes special names safely in every format", async () => {
    const names = ["Smith, John", "a\nb", "<b>&", "**x_y**", "‮evil", "👨‍👩‍👧"];
    const ids = names.map((_, index) => `spk-${index}`);
    const { exports, fixture } = setupSpeakers({ owners: ids, names: Object.fromEntries(ids.map((id, index) => [id, names[index] as string])) });
    const srt = await exportText(exports, fixture, subtitle(fixture, "srt", { includeSpeakers: true }));
    expect(srt.split("\n\n").slice(0, 6).map((cue) => cue.split("\n")[2]?.split("：")[0])).toEqual(["Smith, John", "a b", "<b>&", "**x_y**", "evil", "👨‍👩‍👧"]);
    const vtt = await exportText(exports, fixture, subtitle(fixture, "vtt", { includeSpeakers: true }));
    expect(vtt.split("\n\n").slice(1, 7).map((cue) => /^<v ([^>]*)>/.exec(cue.split("\n")[1] ?? "")?.[1])).toEqual([
      "Smith, John",
      "a b",
      "&lt;b&gt;&amp;",
      "**x_y**",
      "evil",
      "👨‍👩‍👧",
    ]);
    const ass = await exportText(exports, fixture, subtitle(fixture, "ass", { includeSpeakers: true }));
    expect(dialogues(ass).map((line) => line.split(",")[4])).toEqual(["Smith， John", "a b", "<b>&", "**x_y**", "evil", "👨‍👩‍👧"]);
    expect(dialogues(ass).every((line) => line.split(",").length === 10)).toBe(true);
    const markdown = await exportText(exports, fixture, { format: "markdown", sections: { transcript: { revisionId: fixture.corrected.revision.id } }, backlinks: false, includeSpeakers: true });
    expect([...markdown.matchAll(/^\*\*(.*?)\*\* · \*\*\[/gmu)].map((match) => match[1])).toEqual([
      "Smith, John",
      "a b",
      "\\<b\\>\\&",
      "\\*\\*x\\_y\\*\\*",
      "evil",
      "👨‍👩‍👧",
    ]);
    // No control or bidirectional character reaches any file.
    for (const file of [srt, vtt, ass, markdown]) expect(file).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/u);
  });

  it("falls back to 「发言人 N」 for an unnamed speaker by its ordinal in the Content", async () => {
    const { exports, fixture } = setupSpeakers({ owners: [B, B, A, A, undefined, A], names: {} });
    const srt = await exportText(exports, fixture, subtitle(fixture, "srt", { includeSpeakers: true }));
    expect(srt.split("\n\n").slice(0, 3).map((cue) => cue.split("\n")[2])).toEqual(["发言人 1：Hi world.", "你好世界", "发言人 2：第二段{\\b1}开始"]);
  });
});

describe("ExportService, unchanged formats", () => {
  /**
   * SHA-256 of every file below as exported before VTT escaping and restore data existed;
   * these formats must keep their bytes. The fixture has speakers, an unnamed and an
   * unassigned sentence, and markup characters in one sentence.
   */
  const BEFORE: Readonly<Record<string, string>> = {
    "asr-srt-false": "61b0d3ea5300ebb3de8403b443ed6504c26d51e16ec1f7b80aff096c0ff0771b",
    "asr-srt-true": "b999abcc2f898e7f23069c9d0151d4dac2a9927d73d7d77aa8c840b4a243f624",
    "asr-txt-false": "587384c74cfeae92e55916276266407f4a117bc863a0bbb3ad25f10f5f56812d",
    "asr-txt-true": "14fe0ad097cf4cf0b28675074362bb14a214ec74c16ed42011a0af068e35b655",
    "asr-ass-false": "b7d077e37448d40366c0f59b8fb204e219148cf5dcca91ea80c47c648dc44eeb",
    "asr-ass-true": "aebd48cbf0cad2d62cc753f73e972d01fe332de270d184b50ccfe76d2938c8d4",
    "corrected-srt-false": "cd4fbaf235dd85b5122baa97b70021d44cc6509877b963a82c57368e871b164a",
    "corrected-srt-true": "310c76e7c30904853ba2edca54d07924679c6f9f84b12bca487cae09fbf8b53e",
    "corrected-txt-false": "be1b4389f0f8d432b416f05ed86f924d7d1c6f2cd08e9b783d9580ff671234b1",
    "corrected-txt-true": "18b5718124f1523161be9f06383216198dc571006a71e8b63fce07093a1794ab",
    "corrected-ass-false": "a5f35837bdfa9e99a26b3c5c760ae0e690fce7cffa1a0d36872b0c3f036aedcd",
    "corrected-ass-true": "72e72f7a9d9a6ce6dd963139c4cf4ce74b90eeb40a2cfc666a3bc7b4aae03512",
    "translated-srt-false": "55abf4065cf4193a37e31948e16eab112a748f8a32b1d45f53736c15161799b2",
    "translated-srt-true": "2e12a613689ec783dcdddb810ce1ee86167d68f127a5188b1b387ef20e8b1613",
    "translated-txt-false": "3369f4f3549d646948f1ada8c3aec9ed5aaf0d8de2097df17a39edfa7cdffa49",
    "translated-txt-true": "19fb05eec29bde973221abb7d3e95df0a136f87f47241fc0932e94904f9e7317",
    "translated-ass-false": "1073afdf0da7cd03b4b5d7589dfac27f9650a562e1954a411d85f5ce3719d02a",
    "translated-ass-true": "47b993f817d139735e05fa6be660ca6fd1acd81ec44614632f6434896231e9c5",
    // The translated revision has no markup characters: its VTT is unchanged too.
    "translated-vtt-false": "667116f2b2d3ee64025183c1b0376095e49ce216011d4edbfcf2c093a10e58a0",
    "translated-vtt-true": "67540cf926f5d0e64874fde20398bdaa4903b6466a34ab172624d00d01524937",
    "srt-bilingual": "d87be5ac0a32ba07e388db58ee5b5fb634ff840ebbd0507410740ce37a8c1b0c",
    "ass-bilingual": "26a7934398ba1d8fb7bda45a79ad9ebb3c51059f87d422475e01ebcbb0271ae7",
    // Styled ASS as a video export reads it, which is the download before its restore data.
    styled: "6d8e578a23ab166b302fe469285ffe524a99086f17cd53eea75c80557f99c1ae",
    "styled-single": "30699659aef1b4c2801a5f9be4811f7f52d87583100d2c4fb6b6a61da18353ba",
  };
  const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

  it("exports SRT, TXT, fixed-style ASS and markup-free VTT byte for byte as before", async () => {
    const h = createHarness();
    open.push(h);
    const owners = ["a", "a", "b", undefined, "a", "b"];
    const fixture = seedExportContent(h, LOCAL.userId, "bilibili", {
      lines: ASR_LINES.map((line, index) => ({ ...line, text: index === 2 ? "x <b> & y" : line.text, ...(owners[index] === undefined ? {} : { speakerId: owners[index] as string }) })),
      speakerNames: { a: "张三" },
    });
    const exports = new ExportService({ repository: h.repository, version: "1.0.0", now: () => 0 });
    const style: SubtitleStyle = { appearance: { ...defaultSubtitleAppearance(), speaker: "change" }, placement: defaultSubtitlePlacement() };
    const actual: Record<string, string> = {};
    for (const { revision } of [fixture.asr, fixture.corrected, fixture.translated]) {
      for (const format of ["srt", "txt", "ass", "vtt"] as const) {
        if (format === "vtt" && revision.kind !== "translated") continue;
        for (const includeSpeakers of [false, true]) {
          actual[`${revision.kind}-${format}-${includeSpeakers}`] = sha256(await text(exports.exportContent(LOCAL, fixture.contentId, { format, revisionId: revision.id, includeSpeakers })));
        }
      }
    }
    const pair = { revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id, includeSpeakers: true };
    for (const format of ["srt-bilingual", "ass-bilingual"] as const) {
      actual[format] = sha256(await text(exports.exportContent(LOCAL, fixture.contentId, { format, ...pair })));
    }
    actual.styled = sha256(await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, { format: "ass-bilingual", ...pair, style })));
    actual["styled-single"] = sha256(await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, { format: "ass", revisionId: fixture.translated.revision.id, style })));
    expect(actual).toEqual(BEFORE);
  });
});

const PACKAGE_VERSION = "0.7.0-test";
const PKG_A = "spk-a";
const PKG_B = "spk-b";
const PKG_C = "spk-c";
/** A and C share a name but are different people; B is unnamed; sentence 3 is unassigned. */
const PKG_OWNERS = [PKG_A, PKG_B, PKG_C, undefined, PKG_A, PKG_C] as const;


type Revision = { revision: TranscriptRevision; segments: TranscriptSegment[] };

function setupPackage(): { h: Harness; exports: ExportService; fixture: ExportFixture } {
  const h = createHarness();
  open.push(h);
  const fixture = seedExportContent(h, LOCAL.userId, "bilibili", {
    lines: ASR_LINES.map((line, index) => ({ ...line, ...(PKG_OWNERS[index] === undefined ? {} : { speakerId: PKG_OWNERS[index] as string }) })),
    speakerNames: { [PKG_A]: "张三", [PKG_C]: "张三" },
  });
  // A speaker of the Content no sentence names.
  h.repository.withTransaction((scope) => scope.speakers.insert(LOCAL.userId, fixture.contentId, [{ id: "spk-d", name: "李四" }], 1));
  return { h, exports: new ExportService({ repository: h.repository, version: PACKAGE_VERSION, now: () => 1 }), fixture };
}

/** A translation of `parent` covering the sentences at `ordinals`, inserted (and made current for its language when asked). */
function addTranslation(h: Harness, fixture: ExportFixture, parent: Revision, language: string, ordinals: readonly number[], current: boolean): Revision {
  const id = h.newId();
  const revision: TranscriptRevision = {
    id,
    contentId: fixture.contentId,
    kind: "translated",
    parentRevisionId: parent.revision.id,
    language,
    timingFidelity: "segment_only",
    generation: { kind: "manual" },
    segmentCount: ordinals.length,
    createdAt: 1,
  };
  const segments: TranscriptSegment[] = ordinals.map((ordinal) => {
    const source = parent.segments[ordinal] as TranscriptSegment;
    return {
      id: h.newId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: source.startMs,
      endMs: source.endMs,
      text: `${language}:${ordinal}`,
      ...(source.speakerId === undefined ? {} : { speakerId: source.speakerId }),
      sourceSegmentIds: [source.id],
    };
  });
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    if (current) {
      const artifact = scope.translations.getArtifact(LOCAL.userId, fixture.contentId, language);
      scope.translations.setCurrent(LOCAL.userId, fixture.contentId, language, id, artifact?.id ?? h.newId());
    }
  });
  return { revision, segments };
}

function setCurrentTranslation(h: Harness, fixture: ExportFixture, translation: Revision): void {
  h.repository.withTransaction((scope) => {
    const artifact = scope.translations.getArtifact(LOCAL.userId, fixture.contentId, translation.revision.language);
    scope.translations.setCurrent(LOCAL.userId, fixture.contentId, translation.revision.language, translation.revision.id, artifact?.id ?? h.newId());
  });
}



const RESTORE_PREFIX = "Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,amber-data,";

/** The restore data of a styled ASS: the digest line's parts and the package it carries, or undefined without any. */
function restoreDataOf(ass: string): { header: string; chunks: string[]; pkg: SubtitlePackage; digestMatches: boolean } | undefined {
  const lines = ass.split("\n");
  const texts = lines.filter((line) => line.startsWith(RESTORE_PREFIX)).map((line) => line.slice(RESTORE_PREFIX.length));
  if (texts.length === 0) return undefined;
  const [header, ...chunks] = texts as [string, ...string[]];
  const digest = assDialogueDigest(lines.filter((line) => line.startsWith("Dialogue:")));
  return { header, chunks, pkg: parseSubtitlePackage(Buffer.from(chunks.join(""), "base64").toString("utf8")), digestMatches: header === `amber-data 1 ${digest}` };
}

describe("ExportService, Amber subtitle package", () => {
  it("packages the revision with its speakers and only the current translations made from it", async () => {
    const { h, exports, fixture } = setupPackage();
    setCurrentTranslation(h, fixture, fixture.translated);
    // Partial: the second and later sentences are missing.
    addTranslation(h, fixture, fixture.corrected, "ja", [0, 2], true);
    // Of another revision: not this package's.
    addTranslation(h, fixture, fixture.asr, "fr", [0, 1, 2, 3, 4, 5], true);
    // Made from this revision but no longer current: the current German one is of the ASR original.
    addTranslation(h, fixture, fixture.corrected, "de", [0], true);
    addTranslation(h, fixture, fixture.asr, "de", [0], true);

    const file = exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId: fixture.corrected.revision.id });
    expect(file).toMatchObject({ filename: "示例课程：第一讲导论.ambersub", contentType: "application/json; charset=utf-8" });
    const body = await text(file);
    expect(body.startsWith("\uFEFF")).toBe(false);
    const pkg = parseSubtitlePackage(body);
    expect(serializeSubtitlePackage(pkg)).toBe(body);
    expect(pkg.generator).toEqual({ app: "Amber", version: PACKAGE_VERSION });
    expect(pkg.original.language).toBe("zh-CN");
    expect(pkg.original.paragraphMarks).toBe(false);
    // Ordinals follow registration: A, B, C, then the unreferenced D (left out). Unnamed B has no name.
    expect(pkg.original.speakers).toEqual([
      { key: "s1", ordinal: 1, name: "张三", colorIndex: expect.any(Number) },
      { key: "s2", ordinal: 2, colorIndex: expect.any(Number) },
      { key: "s3", ordinal: 3, name: "张三", colorIndex: expect.any(Number) },
    ]);
    const stored = h.repository.withTransaction((scope) => scope.speakers.list(LOCAL.userId, fixture.contentId));
    expect(pkg.original.speakers.map((speaker) => speaker.colorIndex)).toEqual(stored.slice(0, 3).map((speaker) => speaker.colorIndex));
    expect(pkg.original.segments).toEqual(
      fixture.corrected.segments.map((segment, index) => ({
        key: String(index + 1),
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        speaker: new Map<string | undefined, string>([[PKG_A, "s1"], [PKG_B, "s2"], [PKG_C, "s3"]]).get(PKG_OWNERS[index]) ?? null,
      })),
    );
    // Stored text, not rendered: the ASS escape `{\b1}` and nothing turned full-width.
    expect(pkg.original.segments[2]?.text).toBe("第二段{\\b1}开始");
    expect(pkg.translations).toEqual([
      { language: "en", segments: fixture.translated.segments.map((segment, index) => ({ sourceSegmentKey: String(index + 1), text: segment.text })) },
      { language: "ja", segments: [{ sourceSegmentKey: "1", text: "ja:0" }, { sourceSegmentKey: "3", text: "ja:2" }] },
    ]);

    // From the ASR original: its own current translations only.
    const asr = parseSubtitlePackage(await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId: fixture.asr.revision.id })));
    expect(asr.translations.map((translation) => translation.language)).toEqual(["de", "fr"]);
    expect(asr.original.segments[0]?.text).toBe("Hello world.");
  });

  it("writes paragraph marks on every sentence when the revision has them", async () => {
    const { h, exports, fixture } = setupPackage();
    const id = h.newId();
    const marks = [true, false, true, false, false, true];
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { ...fixture.corrected.revision, id, kind: "manual", parentRevisionId: fixture.corrected.revision.id, generation: { kind: "manual" } },
        fixture.corrected.segments.map((segment, ordinal) => ({ ...segment, id: h.newId() as SegmentId, revisionId: id, paragraphStart: marks[ordinal] as boolean, sourceSegmentIds: [segment.id] })),
      ),
    );
    const pkg = parseSubtitlePackage(await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId: id })));
    expect(pkg.original.paragraphMarks).toBe(true);
    expect(pkg.original.segments.map((segment) => segment.paragraphStart)).toEqual(marks);
    expect(pkg.translations).toEqual([]);
  });

  it("is the same package the builder makes from the revision, byte for byte", async () => {
    const { h, exports, fixture } = setupPackage();
    setCurrentTranslation(h, fixture, fixture.translated);
    const body = await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId: fixture.corrected.revision.id }));
    const speakers = h.repository.withTransaction((scope) => scope.speakers.list(LOCAL.userId, fixture.contentId));
    expect(body).toBe(
      serializeSubtitlePackage(
        buildSubtitlePackage({
          revision: fixture.corrected.revision,
          segments: fixture.corrected.segments,
          speakers,
          translations: [{ language: "en", segments: fixture.translated.segments }],
          version: PACKAGE_VERSION,
        }),
      ),
    );
  });

  it("refuses a translation as the original, another owner's or Content's revision, before the first byte", () => {
    const { h, exports, fixture } = setupPackage();
    const translated = refusal(() => exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId: fixture.translated.revision.id }));
    expect(translated.class).toBe("invalid_request");
    expect(translated.userMessage).toContain("revisionId");
    expect(refusal(() => exports.exportContent(BOB, fixture.contentId, { format: "ambersub", revisionId: fixture.corrected.revision.id })).class).toBe("not_found");
    const other = seedExportContent(h, LOCAL.userId, "local");
    expect(refusal(() => exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId: other.corrected.revision.id })).class).toBe("not_found");
  });

  it("refuses with media_too_large a package larger than SUBTITLE_IMPORT_MAX_BYTES, which no import would take", () => {
    const { h, exports, fixture } = setupPackage();
    const id = h.newId();
    // Five sentences of 4.5 MB: 22.5 MB of text.
    const lines = Array.from({ length: 5 }, (_, ordinal) => ({ startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, text: `${ordinal}${"x".repeat(4.5 * 1024 * 1024)}` }));
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id, contentId: fixture.contentId, kind: "imported", language: "en", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: 5, createdAt: 1 },
        lines.map((line, ordinal) => ({ ...line, id: h.newId() as SegmentId, revisionId: id, ordinal, sourceSegmentIds: [] })),
      ),
    );
    const refused = refusal(() => exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId: id }));
    expect(refused.class).toBe("media_too_large");
    expect(refused.userMessage).toContain("20 MB");
  });
});

describe("ExportService, blank sentences in a package", () => {
  /** A manual revision of the corrected one with the given texts in place of its sentences'. */
  function withTexts(h: Harness, fixture: ExportFixture, texts: readonly string[]): string {
    const id = h.newId();
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { ...fixture.corrected.revision, id, kind: "manual", parentRevisionId: fixture.corrected.revision.id, generation: { kind: "manual" } },
        fixture.corrected.segments.map((segment, ordinal) => ({ ...segment, id: h.newId() as SegmentId, revisionId: id, text: texts[ordinal] as string, sourceSegmentIds: [segment.id] })),
      ),
    );
    return id;
  }
  const style: SubtitleStyle = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };

  it("packages a revision with an empty sentence without it, in a file the reader takes, and keeps restore data in its styled ASS", async () => {
    const { h, exports, fixture } = setupPackage();
    const revisionId = withTexts(h, fixture, ["一", "", "三", "四", "五", "六"]);
    const pkg = parseSubtitlePackage(await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId })));
    expect(pkg.original.segments.map((segment) => [segment.key, segment.text])).toEqual([["1", "一"], ["2", "三"], ["3", "四"], ["4", "五"], ["5", "六"]]);
    const restore = restoreDataOf(await text(exports.exportContent(LOCAL, fixture.contentId, { format: "ass", revisionId, style })));
    expect(restore?.digestMatches).toBe(true);
    expect(restore?.pkg).toEqual(pkg);
  });

  it("refuses the package of a revision whose every sentence is blank, and writes its styled ASS without restore data", async () => {
    const { h, exports, fixture } = setupPackage();
    const revisionId = withTexts(h, fixture, ["", " ", "", "\n", "", ""]);
    const refused = refusal(() => exports.exportContent(LOCAL, fixture.contentId, { format: "ambersub", revisionId }));
    expect(refused.class).toBe("invalid_request");
    expect(refused.userMessage).toContain("revisionId");
    const body = { format: "ass" as const, revisionId, style };
    const ass = await text(exports.exportContent(LOCAL, fixture.contentId, body));
    expect(ass).not.toContain("amber-data");
    expect(ass).toBe(await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, body)));
  });
});

describe("ExportService, restore data in a styled ASS download", () => {
  const style: SubtitleStyle = { appearance: { ...defaultSubtitleAppearance(), speaker: "change" }, placement: defaultSubtitlePlacement() };
  const download = (exports: ExportService, fixture: ExportFixture, body: Record<string, unknown>): Promise<string> =>
    text(exports.exportContent(LOCAL, fixture.contentId, body as ContentExportRequest));

  it("embeds the shown original and the paired translation after the dialogue, with a digest of every Dialogue line", async () => {
    const { h, exports, fixture } = setupPackage();
    setCurrentTranslation(h, fixture, fixture.translated);
    // Current, made from the same revision, but not the one this file shows: left out.
    addTranslation(h, fixture, fixture.corrected, "ja", [0], true);
    const ass = await download(exports, fixture, {
      format: "ass-bilingual",
      revisionId: fixture.corrected.revision.id,
      translationRevisionId: fixture.translated.revision.id,
      style: { ...style, appearance: { ...style.appearance, background: { enabled: true, color: "#000000", opacityPct: 50, padding: 8, scope: "both" } } },
      includeSpeakers: true,
    });
    const restore = restoreDataOf(ass);
    expect(restore?.digestMatches).toBe(true);
    // The restore events close the file, after every Dialogue line.
    const lines = ass.trimEnd().split("\n");
    const firstComment = lines.findIndex((line) => line.startsWith("Comment: "));
    expect(lines.slice(firstComment).every((line) => line.startsWith(RESTORE_PREFIX))).toBe(true);
    expect(lines.slice(0, firstComment).some((line) => line.startsWith("Dialogue: 0,"))).toBe(true);
    expect(restore?.chunks.slice(0, -1).every((chunk) => chunk.length === SUBTITLE_ASS_DATA_CHUNK)).toBe(true);
    const speakers = h.repository.withTransaction((scope) => scope.speakers.list(LOCAL.userId, fixture.contentId));
    expect(restore?.pkg).toEqual(
      buildSubtitlePackage({
        revision: fixture.corrected.revision,
        segments: fixture.corrected.segments,
        speakers,
        translations: [{ language: "en", segments: fixture.translated.segments }],
        version: PACKAGE_VERSION,
      }),
    );
  });

  it("embeds a translated revision shown alone as the original, without translations", async () => {
    const { exports, fixture } = setupPackage();
    const restore = restoreDataOf(await download(exports, fixture, { format: "ass", revisionId: fixture.translated.revision.id, style }));
    expect(restore?.digestMatches).toBe(true);
    expect(restore?.pkg.original.language).toBe("en");
    expect(restore?.pkg.original.segments.map((segment) => segment.text)).toEqual(fixture.translated.segments.map((segment) => segment.text));
    expect(restore?.pkg.original.speakers.map((speaker) => speaker.key)).toEqual(["s1", "s2", "s3"]);
    expect(restore?.pkg.translations).toEqual([]);
  });

  it("any change to a Dialogue line breaks the digest", async () => {
    const { exports, fixture } = setupPackage();
    const ass = await download(exports, fixture, { format: "ass", revisionId: fixture.corrected.revision.id, style });
    expect(restoreDataOf(ass)?.digestMatches).toBe(true);
    expect(restoreDataOf(ass.replace("Hi world.", "Hi world!"))?.digestMatches).toBe(false);
    expect(restoreDataOf(ass.replace(/^Dialogue: .*\n/m, ""))?.digestMatches).toBe(false);
    expect(restoreDataOf(ass.replace(/^Dialogue: 1,0:00:01\.00/m, "Dialogue: 1,0:00:01.10"))?.digestMatches).toBe(false);
  });

  it("leaves restore data out of a fixed-style ASS and of every ASS a subtitled video export reads", async () => {
    const { h, exports, fixture } = setupPackage();
    setCurrentTranslation(h, fixture, fixture.translated);
    const revisionId = fixture.corrected.revision.id;
    const translationRevisionId = fixture.translated.revision.id;
    for (const body of [
      { format: "ass", revisionId },
      { format: "ass-bilingual", revisionId, translationRevisionId, includeSpeakers: true },
    ]) {
      expect(await download(exports, fixture, body)).not.toContain("amber-data");
    }
    // Schema version 1 of a burn request: the fixed ASS through the Task path.
    for (const mode of ["original", "translation", "bilingual"] as const) {
      const request = burnSubtitleRequest({ mode, revisionId, translationRevisionId } as Parameters<typeof burnSubtitleRequest>[0]);
      expect(await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, request))).not.toContain("amber-data");
      // Even a styled body on the Task path stays without it.
      if (request.format === "ass" || request.format === "ass-bilingual") {
        expect(await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, { ...request, style }))).not.toContain("amber-data");
      }
    }
    // Schema version 2: the styled ASS of hard subtitles and of soft subtitle tracks.
    for (const textOnly of [false, true]) {
      for (const mode of ["original", "translation", "bilingual"] as const) {
        let out = "";
        for await (const piece of exports.styledAssOf(LOCAL.userId, fixture.contentId, {
          mode,
          revisionId,
          ...(mode === "original" ? {} : { translationRevisionId }),
          style,
          playRes: { width: 1920, height: 1080 },
          textOnly,
          speakerLabels: { [PKG_A]: "张三" },
        })) {
          out += piece;
        }
        expect(out).toContain("Dialogue: ");
        expect(out).not.toContain("amber-data");
        expect(out).not.toContain("Comment: ");
      }
    }
  });

  it("is the file without restore data, byte for byte, plus the appended events", async () => {
    const { exports, fixture } = setupPackage();
    const body = { format: "ass" as const, revisionId: fixture.corrected.revision.id, style, includeSpeakers: true };
    const withData = await download(exports, fixture, body);
    const without = await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, body));
    expect(withData.startsWith(without)).toBe(true);
    expect(withData.slice(without.length)).toMatch(/^(Comment: 0,0:00:00\.00,0:00:00\.00,Default,,0,0,0,amber-data,[^\n]*\n)+$/);
  });

  it("downloads without restore data when embedding it would pass SUBTITLE_IMPORT_MAX_BYTES", async () => {
    const { h, exports, fixture } = setupPackage();
    const id = h.newId();
    // 11 MB of text: the document fits, the document plus its base64 package does not.
    const lines = Array.from({ length: 2 }, (_, ordinal) => ({ startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, text: `${ordinal}${"x".repeat(5.5 * 1024 * 1024)}` }));
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id, contentId: fixture.contentId, kind: "imported", language: "en", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: 2, createdAt: 1 },
        lines.map((line, ordinal) => ({ ...line, id: h.newId() as SegmentId, revisionId: id, ordinal, sourceSegmentIds: [] })),
      ),
    );
    const body = { format: "ass" as const, revisionId: id, style: { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() } };
    const ass = await download(exports, fixture, body);
    expect(ass).not.toContain("amber-data");
    expect(ass).toBe(await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, body)));
  });
});

/** Per-frame MD5 lines of a synthetic clip with `ass` drawn by the `subtitles` filter, the way a burn draws it. */
function frameHashes(ass: string | undefined, fontsDir: string, dir: string, name: string): string[] {
  const filter =
    ass === undefined
      ? "null"
      : (() => {
          const path = join(dir, `${name}.ass`);
          writeFileSync(path, ass);
          return `subtitles=filename=${escapeFilterValue(path)}:fontsdir=${escapeFilterValue(fontsDir)}:wrap_unicode=1:force_style=WrapStyle=1`;
        })();
  const run = spawnSync(
    toolPath("ffmpeg"),
    ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x336699:size=1280x720:rate=10:duration=3", "-vf", filter, "-pix_fmt", "rgb24", "-f", "framemd5", "-"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
}

describe("restore data under the bundled FFmpeg", () => {
  it("draws a styled ASS with restore data frame for frame like the same file without it", async () => {
    const binDir = toolsBinDir(["ffmpeg"]);
    const fontsDir = join(binDir, "..", "fonts");
    const h = createHarness();
    open.push(h);
    const fixture = seedExportContent(h, LOCAL.userId, "bilibili", {
      lines: [
        { startMs: 0, endMs: 1400, text: "第一句，带发言人的原文", speakerId: "spk-a" },
        { startMs: 1000, endMs: 2200, text: "Overlapping second line <b>&", speakerId: "spk-b" },
        { startMs: 2300, endMs: 3000, text: "没有发言人" },
        // The fixture's summary cites six sentences; these fall after the rendered clip.
        { startMs: 4000, endMs: 5000, text: "四" },
        { startMs: 5000, endMs: 6000, text: "五" },
        { startMs: 6000, endMs: 7000, text: "六" },
      ],
      speakerNames: { "spk-a": "张三" },
    });
    const exports = new ExportService({ repository: h.repository, version: "0.7.0-test", fontMetrics: new BundledFontMetrics(join(fontsDir, SUBTITLE_FONT_FILE)) });
    const body: SubtitleExportRequest = {
      format: "ass-bilingual",
      revisionId: fixture.corrected.revision.id,
      translationRevisionId: fixture.translated.revision.id,
      includeSpeakers: true,
      style: {
        appearance: { ...defaultSubtitleAppearance(), speaker: "change", background: { enabled: true, color: "#000000", opacityPct: 60, padding: 10, scope: "both" } },
        placement: defaultSubtitlePlacement(),
      },
    };
    const withData = await text(exports.exportContent(LOCAL, fixture.contentId, body));
    const without = await text(exports.exportContentOf(LOCAL.userId, fixture.contentId, body));
    expect(withData).toContain(",amber-data,amber-data 1 ");
    expect(without).not.toContain("amber-data");

    const dir = tempDataDir("amber-restore-render-");
    const drawnWith = frameHashes(withData, fontsDir, dir, "with");
    const drawnWithout = frameHashes(without, fontsDir, dir, "without");
    const bare = frameHashes(undefined, fontsDir, dir, "bare");
    // Three seconds at ten frames per second.
    expect(drawnWith).toHaveLength(30);
    expect(drawnWith).toEqual(drawnWithout);
    // The subtitles were drawn at all: most frames differ from the clip without them.
    expect(drawnWith.filter((line, index) => line !== bare[index]).length).toBeGreaterThan(20);
  }, 60_000);
});
