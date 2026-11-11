import { describe, expect, it } from "vitest";
import { readerSections, readingText, readingTextWithSpeakers, viewRowKey, viewRows } from "../../../../src/web/pages/content/reader-rows.ts";
import { SPEAKER_SEGMENTS } from "../../../fixtures/web/reader-speakers.tsx";
import { segment } from "../../../fixtures/web/content-data.ts";

const chapters = [{ startMs: 0, endMs: 60_000, title: "开场" }, { startMs: 60_000, endMs: 600_000, title: "正文" }];
const none = { hasMarks: () => false };

describe("viewRows", () => {
  it("lists a heading before its paragraphs and gives no row a turn outside the turn layout", () => {
    const rows = viewRows(readerSections(SPEAKER_SEGMENTS, chapters), { turns: false, ...none });
    expect(rows.map((row) => (row.kind === "chapter" ? `# ${row.title}` : row.paragraph.segments.map((s) => s.id).join("+")))).toEqual(["# 开场", "g1+g2", "g3", "g4", "g5", "g6", "# 正文", "g7"]);
    expect(rows.every((row) => row.kind === "chapter" || row.turn === undefined)).toBe(true);
  });

  it("marks the first and last paragraph of a turn and keeps one turn key across its paragraphs", () => {
    const rows = viewRows(readerSections(SPEAKER_SEGMENTS, chapters), { turns: true, ...none });
    const turns = rows.flatMap((row) => (row.kind === "paragraph" && row.turn !== undefined ? [{ id: row.paragraph.segments[0]?.id, ...row.turn }] : []));
    expect(turns.map((turn) => [turn.id, turn.key, turn.speakerId, turn.first, turn.last])).toEqual([
      ["g1", "g1", "sp1", true, true],
      ["g3", "g3", "sp2", true, true],
      ["g4", "g4", "sp1", true, false],
      ["g5", "g4", "sp1", false, true],
      ["g6", "g6", undefined, true, true],
      ["g7", "g7", "sp1", true, true],
    ]);
  });

  it("starts a new turn after a chapter heading even when the same speaker goes on", () => {
    const same = [segment("a", 0, 0, 1_000, "上一章的最后一句。", { speakerId: "sp1" }), segment("b", 1, 60_000, 61_000, "下一章的第一句，是同一个人。", { speakerId: "sp1" })];
    const rows = viewRows(readerSections(same, chapters), { turns: true, ...none });
    expect(rows.flatMap((row) => (row.kind === "paragraph" && row.turn !== undefined ? [row.turn.first] : []))).toEqual([true, true]);
  });

  it("shows a one-sentence short turn compactly unless a sentence in it carries a mark", () => {
    const sections = readerSections(SPEAKER_SEGMENTS, chapters);
    const compact = (hasMarks: (id: string) => boolean) =>
      viewRows(sections, { turns: true, hasMarks: (item) => hasMarks(item.id) }).flatMap((row) => (row.kind === "paragraph" && row.turn?.compact === true ? [row.paragraph.segments[0]?.id] : []));
    expect(compact(() => false)).toEqual(["g3"]);
    expect(compact((id) => id === "g3")).toEqual([]);
  });

  it("keys paragraphs by their first sentence and headings by their time", () => {
    const rows = viewRows(readerSections(SPEAKER_SEGMENTS, chapters), { turns: true, ...none });
    expect(rows.map(viewRowKey)).toEqual(["chapter:0", "g1", "g3", "g4", "g5", "g6", "chapter:60000", "g7"]);
  });
});

describe("copy text", () => {
  const sections = readerSections(SPEAKER_SEGMENTS, chapters);
  const prefixOf = (speakerId: string): string => `${speakerId === "sp1" ? "陈明" : "发言人 2"}：`;

  it("copies the body as the view reads: headings on their own line, blocks a blank line apart", () => {
    expect(readingText(viewRows(sections, { turns: true, ...none }))).toBe(
      [
        "开场",
        "今天讲检索。先看向量库。",
        "嗯。",
        "对，重排序是第二步，要把粗排的结果再精排一遍。",
        "第二段仍然是他在讲，所以还在同一个发言轮次里。",
        "这一句没有人认领，所以它属于未分配的轮次。",
        "正文",
        "再看重排序，它决定了最终展示给用户的排列顺序。",
      ].join("\n\n"),
    );
  });

  it("starts each turn, and only the turn, with its speaker's name; unassigned sentences stay bare", () => {
    expect(readingTextWithSpeakers(sections, prefixOf)).toBe(
      [
        "开场",
        "陈明：今天讲检索。先看向量库。",
        "发言人 2：嗯。",
        "陈明：对，重排序是第二步，要把粗排的结果再精排一遍。",
        "第二段仍然是他在讲，所以还在同一个发言轮次里。",
        "这一句没有人认领，所以它属于未分配的轮次。",
        "正文",
        "陈明：再看重排序，它决定了最终展示给用户的排列顺序。",
      ].join("\n\n"),
    );
  });
});
