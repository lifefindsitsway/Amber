import { afterEach, describe, expect, it } from "vitest";
import { ExportService, type ExportFile } from "../../../src/server/application/export.ts";
import type { SummaryRevision } from "../../../src/server/domain/artifact.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import { API_PAGE_SIZE_MAX } from "../../../src/shared/defaults.ts";
import type { ContentExportRequest } from "../../../src/shared/dto/export.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement, type SubtitleStyle } from "../../../src/shared/subtitle-style.ts";
import { addLocalFile, seedExportCollection, seedExportContent, type ExportFixture } from "../../fixtures/export/export-data.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

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
