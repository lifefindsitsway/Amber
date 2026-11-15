import { describe, expect, it, vi } from "vitest";
import { readingSeparator } from "../../../../src/shared/reading.ts";
import { readerSections, viewRowKey, viewRows, type TurnPlace } from "../../../../src/web/pages/content/reader-rows.ts";
import { hasPoint, readSelection, selectionRows, type ReaderPart, type ReaderPoint, type SelectionRow } from "../../../../src/web/pages/content/reader-selection.ts";
import { filteredRowKey, type FilteredRow, type GapRow } from "../../../../src/web/pages/content/speaker-filter.ts";
import { segment } from "../../../fixtures/web/content-data.ts";
import { SPEAKER_SEGMENTS } from "../../../fixtures/web/reader-speakers.tsx";

const SKIPPED = "（略过未显示的内容）";

const S1 = "第 1 句发言人模拟字幕。";
const S2 = "第 2 句发言人模拟字幕。";
const S3 = "第 3 句发言人模拟字幕。";
const S4 = "Third sentence in English.";
const S5 = "Fourth one follows 😀 here.";
const S6 = "第 6 句发言人模拟字幕。";
const S4_ZH = "第 4 句发言人模拟字幕。";

function chapter(key: string, title: string): SelectionRow {
  return { key, kind: "chapter", title };
}

function gap(key: string, label: string): SelectionRow {
  return { key, kind: "gap", label };
}

function para(key: string, time: string, sentences: Array<[string, string]>, options: { speaker?: string; named?: boolean; marked?: boolean } = {}): SelectionRow {
  return {
    key,
    kind: "paragraph",
    time,
    sentences: sentences.map(([id, text]) => ({ id, text })),
    marked: options.marked ?? false,
    ...(options.speaker === undefined ? {} : { speaker: { name: options.speaker, named: options.named ?? true } }),
  };
}

function at(rowKey: string, part: Exclude<ReaderPart, "sentence">, offset: number): ReaderPoint {
  return { rowKey, part, offset };
}

function sp(rowKey: string, segmentId: string, offset: number): ReaderPoint {
  return { rowKey, part: "sentence", segmentId, offset };
}

function read(rows: readonly SelectionRow[], anchor: ReaderPoint, focus: ReaderPoint) {
  const result = readSelection(rows, anchor, focus, { skipped: SKIPPED });
  if (result === undefined) throw new Error("selection is not in the rows");
  return result;
}

/** Reads both ways round and checks that the order of the ends does not matter. */
function readBoth(rows: readonly SelectionRow[], anchor: ReaderPoint, focus: ReaderPoint) {
  const forward = read(rows, anchor, focus);
  expect(read(rows, focus, anchor)).toEqual(forward);
  return forward;
}

/** title → named turn → next title → named turn → named turn → unassigned turn. */
const DOC: SelectionRow[] = [
  chapter("chapter:0", "开场白"),
  para("s1", "0:00", [["s1", S1], ["s2", S2]], { speaker: "林老师" }),
  chapter("chapter:15000", "学生提问"),
  para("s3", "0:20", [["s3", S3]], { speaker: "发言人 2" }),
  para("s4", "0:30", [["s4", S4], ["s5", S5]], { speaker: "林老师" }),
  para("s6", "0:50", [["s6", S6]], { speaker: "未分配", named: false }),
];

const DOC_ALL = "开场白\n\n\n林老师\n0:00第 1 句发言人模拟字幕。第 2 句发言人模拟字幕。\n\n学生提问\n\n\n发言人 2\n0:20第 3 句发言人模拟字幕。\n\n\n林老师\n0:30Third sentence in English. Fourth one follows 😀 here.\n\n未分配\n0:50第 6 句发言人模拟字幕。";

/** The same speaker's turn holds two paragraphs; only the first carries the header. */
const ONE_TURN: SelectionRow[] = [
  para("t1", "0:00", [["t1", "第 1 句发言人模拟字幕。"], ["t2", "第 2 句讲到此为止。"]], { speaker: "林老师" }),
  para("t3", "0:30", [["t3", S4_ZH]]),
];

/** A filter showing one speaker: a gap bar before a chapter heading. */
const FILTERED_BEFORE_CHAPTER: SelectionRow[] = [
  para("s1", "0:00", [["s1", S1], ["s2", S2]], { speaker: "林老师" }),
  gap("gap:s3", "略过 11 秒"),
  chapter("chapter:15000", "学生提问"),
  para("s4", "0:30", [["s4", S4_ZH]], { speaker: "林老师" }),
];

/** A filter showing one speaker: a gap bar straight before the next turn. */
const FILTERED_BEFORE_TURN: SelectionRow[] = [
  para("s1", "0:00", [["s1", S1]], { speaker: "林老师" }),
  gap("gap:s2", "略过 11 秒"),
  para("s3", "0:20", [["s3", S3]], { speaker: "林老师" }),
];

/** No speaker turns: no row has a header. */
const PLAIN: SelectionRow[] = [
  chapter("chapter:0", "开场白"),
  para("s1", "0:00", [["s1", S1], ["s2", S2]]),
  chapter("chapter:15000", "学生提问"),
  para("s3", "0:20", [["s3", S3]]),
  para("s4", "0:30", [["s4", S4_ZH]]),
];

describe("readSelection copy text", () => {
  it("writes a whole document the way the browser copies it", () => {
    expect(readBoth(DOC, at("chapter:0", "title", 0), sp("s6", "s6", S6.length)).copyText).toBe(DOC_ALL);
  });

  it("cuts inside sentences on both ends", () => {
    expect(readBoth(DOC, sp("s1", "s2", 2), sp("s3", "s3", 5)).copyText).toBe("2 句发言人模拟字幕。\n\n学生提问\n\n\n发言人 2\n0:20第 3 句");
  });

  it("starts inside a name, before a time or inside a title", () => {
    expect(readBoth(DOC, at("s3", "speaker", 1), sp("s3", "s3", 3)).copyText).toBe("言人 2\n0:20第 3");
    expect(readBoth(DOC, at("s3", "time", 0), sp("s3", "s3", 5)).copyText).toBe("0:20第 3 句");
    expect(readBoth(DOC, at("chapter:15000", "title", 2), sp("s3", "s3", 3)).copyText).toBe("提问\n\n\n发言人 2\n0:20第 3");
  });

  it("runs into an unassigned turn without the named header's extra line", () => {
    expect(readBoth(DOC, sp("s4", "s5", 2), sp("s6", "s6", 3)).copyText).toBe("urth one follows 😀 here.\n\n未分配\n0:50第 6");
  });

  it("puts a blank line between two paragraphs of one turn", () => {
    expect(readBoth(ONE_TURN, sp("t1", "t2", 0), sp("t3", "t3", 5)).copyText).toBe("第 2 句讲到此为止。\n\n0:30第 4 句");
  });

  it("gives a gap bar a single line after it", () => {
    expect(readBoth(FILTERED_BEFORE_CHAPTER, at("s1", "speaker", 0), sp("s4", "s4", 5)).copyText).toBe(
      "林老师\n0:00第 1 句发言人模拟字幕。第 2 句发言人模拟字幕。\n\n略过 11 秒\n学生提问\n\n\n林老师\n0:30第 4 句",
    );
    expect(readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 0), sp("s3", "s3", 5)).copyText).toBe("第 1 句发言人模拟字幕。\n\n略过 11 秒\n\n林老师\n0:20第 3 句");
  });

  it("writes the plain layout without names", () => {
    expect(readBoth(PLAIN, at("chapter:0", "title", 0), sp("s4", "s4", 5)).copyText).toBe("开场白\n\n0:00第 1 句发言人模拟字幕。第 2 句发言人模拟字幕。\n\n学生提问\n\n0:20第 3 句发言人模拟字幕。\n\n0:30第 4 句");
  });

  it("joins sentences of a row by the reading separator and trims the ends", () => {
    const rows = [para("m", "1:00", [["m1", "First."], ["m2", "第二句"], ["m3", "第三句"]], { marked: true })];
    expect(readBoth(rows, at("m", "time", 0), sp("m", "m3", 3)).copyText).toBe("1:00First. 第二句第三句");
    const spaced = [para("w", "1:00", [["w1", "  头  "], ["w2", "尾"]])];
    expect(readBoth(spaced, sp("w", "w1", 0), sp("w", "w2", 1)).copyText).toBe(`头  ${readingSeparator("  头  ", "尾", false)}尾`);
  });
});

describe("readSelection explain text", () => {
  it("reads titles and sentences as one line with a space around each title", () => {
    const result = readBoth(DOC, at("chapter:0", "title", 0), sp("s6", "s6", S6.length));
    expect(readingSeparator(S3, S4, false)).toBe("");
    expect(readingSeparator(S4, S5, false)).toBe(" ");
    expect(readingSeparator(S5, S6, false)).toBe(" ");
    expect(result.explainText).toBe("开场白 第 1 句发言人模拟字幕。第 2 句发言人模拟字幕。 学生提问 第 3 句发言人模拟字幕。Third sentence in English. Fourth one follows 😀 here. 第 6 句发言人模拟字幕。");
  });

  it("separates sentences of different rows by their full texts, not the selected slices", () => {
    // Only the "." of the first sentence is selected: on its own it would ask for a space, but
    // the whole sentence is CJK closed by ASCII punctuation and continued in CJK, which joins directly.
    const rows = [para("a", "0:00", [["a1", "中文句."]]), para("b", "0:10", [["b1", "然后呢"]])];
    expect(readingSeparator(".", "然后", false)).toBe(" ");
    expect(readBoth(rows, sp("a", "a1", 3), sp("b", "b1", 2)).explainText).toBe(".然后");
    // A marked revision joins a CJK sentence running across two rows without a space.
    const marked = [para("a", "0:00", [["a1", "这句没有结束"]], { marked: true }), para("b", "0:10", [["b1", "这里才结束。"]], { marked: true })];
    expect(readBoth(marked, sp("a", "a1", 0), sp("b", "b1", 6)).explainText).toBe("这句没有结束这里才结束。");
  });

  it("leaves names and times out", () => {
    expect(readBoth(DOC, at("s3", "speaker", 0), sp("s4", "s4", 5)).explainText).toBe("第 3 句发言人模拟字幕。Third");
  });

  it("puts the skipped marker where a gap bar lies between selected text", () => {
    expect(readBoth(FILTERED_BEFORE_CHAPTER, sp("s1", "s2", 0), sp("s4", "s4", S4_ZH.length)).explainText).toBe(`${S2}${SKIPPED} 学生提问 ${S4_ZH}`);
    expect(readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 0), sp("s3", "s3", S3.length)).explainText).toBe(`${S1}${SKIPPED}${S3}`);
  });

  it("drops a marker at either end", () => {
    expect(readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 0), at("gap:s2", "gap", 3)).explainText).toBe(S1);
    expect(readBoth(FILTERED_BEFORE_TURN, at("gap:s2", "gap", 0), sp("s3", "s3", 5)).explainText).toBe("第 3 句");
  });

  it("explains nothing when only names, times or gap labels are selected", () => {
    expect(readBoth(FILTERED_BEFORE_TURN, at("gap:s2", "gap", 0), at("gap:s2", "gap", 7)).explainText).toBe("");
    expect(readBoth(FILTERED_BEFORE_TURN, at("gap:s2", "gap", 1), at("s3", "time", 4)).explainText).toBe("");
  });

  it("collapses whitespace runs and trims", () => {
    const rows = [chapter("c", "  标题\n 二  "), para("w", "0:00", [["w1", "一句  话\n"], ["w2", "另一句"]])];
    expect(readBoth(rows, at("c", "title", 0), sp("w", "w2", 3)).explainText).toBe("标题 二 一句 话 另一句");
  });
});

describe("readSelection sentences", () => {
  it("counts the sentences that share text with the selection and bounds them", () => {
    const result = readBoth(DOC, sp("s1", "s2", 2), sp("s3", "s3", 5));
    expect(result.sentenceCount).toBe(2);
    expect(result.bounds).toEqual({ start: { segmentId: "s2", offset: 2 }, end: { segmentId: "s3", offset: 5 } });
    expect([result.firstRow, result.lastRow]).toEqual([1, 3]);
  });

  it("does not count a sentence the drag only reaches at offset 0", () => {
    const result = readBoth(DOC, sp("s1", "s1", 0), sp("s1", "s2", 0));
    expect(result.sentenceCount).toBe(1);
    expect(result.bounds).toEqual({ start: { segmentId: "s1", offset: 0 }, end: { segmentId: "s1", offset: S1.length } });
    expect(result.quote).toEqual({ id: "s1", text: S1 });
    expect(result.explainText).toBe(S1);
  });

  it("does not count a sentence of which only whitespace is selected", () => {
    const result = readBoth(DOC, sp("s4", "s4", 0), sp("s4", "s5", 0));
    expect(result.sentenceCount).toBe(1);
    const spaced = [para("w", "0:00", [["w1", "一句。 "], ["w2", "两句。"]])];
    expect(readBoth(spaced, sp("w", "w1", 3), sp("w", "w2", 0)).sentenceCount).toBe(0);
  });

  it("starts the bounds where a sentence's slice starts when an end is on a name, a time or a title", () => {
    const fromTitle = readBoth(DOC, at("chapter:15000", "title", 1), sp("s4", "s4", 5));
    expect(fromTitle.bounds).toEqual({ start: { segmentId: "s3", offset: 0 }, end: { segmentId: "s4", offset: 5 } });
    const toTime = readBoth(DOC, sp("s3", "s3", 2), at("s4", "time", 2));
    expect(toTime.bounds).toEqual({ start: { segmentId: "s3", offset: 2 }, end: { segmentId: "s3", offset: S3.length } });
    const toName = readBoth(DOC, sp("s3", "s3", 2), at("s4", "speaker", 2));
    expect(toName.bounds).toEqual(toTime.bounds);
    expect(toName.copyText).toBe("3 句发言人模拟字幕。\n\n\n林老");
    const toGap = readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 2), at("gap:s2", "gap", 2));
    expect(toGap.bounds).toEqual({ start: { segmentId: "s1", offset: 2 }, end: { segmentId: "s1", offset: S1.length } });
    expect(toGap.copyText).toBe("1 句发言人模拟字幕。\n\n略过");
  });

  it("selects inside one part", () => {
    const sentence = readBoth(DOC, sp("s3", "s3", 2), sp("s3", "s3", 4));
    expect(sentence).toMatchObject({ firstRow: 3, lastRow: 3, explainText: "3", copyText: "3", sentenceCount: 1, quote: { id: "s3", text: S3 }, crossesGap: false });
    expect(sentence.bounds).toEqual({ start: { segmentId: "s3", offset: 2 }, end: { segmentId: "s3", offset: 4 } });
    const title = readBoth(DOC, at("chapter:15000", "title", 1), at("chapter:15000", "title", 3));
    expect(title).toMatchObject({ explainText: "生提", copyText: "生提", sentenceCount: 0, crossesGap: false });
    expect(title.bounds).toBeUndefined();
    expect(title.quote).toBeUndefined();
  });

  it("selects within one row across its parts", () => {
    const result = readBoth(DOC, at("s4", "speaker", 1), sp("s4", "s5", 6));
    expect(result).toMatchObject({ firstRow: 4, lastRow: 4, copyText: "老师\n0:30Third sentence in English. Fourth", explainText: "Third sentence in English. Fourth", sentenceCount: 2 });
    expect(result.quote).toBeUndefined();
  });

  it("handles UTF-16 offsets around an emoji", () => {
    const emoji = S5.indexOf("😀");
    const result = readBoth(DOC, sp("s4", "s5", emoji), sp("s4", "s5", emoji + 2));
    expect(result.copyText).toBe("😀");
    expect(result.bounds).toEqual({ start: { segmentId: "s5", offset: emoji }, end: { segmentId: "s5", offset: emoji + 2 } });
  });

  it("reads a collapsed selection as empty", () => {
    for (const point of [sp("s3", "s3", 2), at("s3", "time", 1), at("chapter:0", "title", 0)]) {
      const result = read(DOC, point, point);
      expect(result).toEqual({ firstRow: result.firstRow, lastRow: result.firstRow, explainText: "", copyText: "", sentenceCount: 0, crossesGap: false });
    }
    // The end of one part and the start of the next are different points but select nothing.
    expect(readBoth(DOC, at("s3", "time", 4), sp("s3", "s3", 0))).toMatchObject({ copyText: "", explainText: "", sentenceCount: 0 });
  });

  it("clamps offsets to the part's text", () => {
    const result = readBoth(DOC, sp("s3", "s3", 99), sp("s4", "s4", 500));
    expect(result.copyText).toBe(`林老师\n0:30${S4}`);
    expect(result.bounds).toEqual({ start: { segmentId: "s4", offset: 0 }, end: { segmentId: "s4", offset: S4.length } });
    expect(readBoth(DOC, sp("s3", "s3", -3), sp("s3", "s3", 1)).copyText).toBe("第");
  });

  it("is undefined when an end is not in the rows", () => {
    expect(readSelection(DOC, sp("gone", "gone", 0), sp("s3", "s3", 1), { skipped: SKIPPED })).toBeUndefined();
    expect(readSelection(DOC, sp("s3", "s3", 0), sp("s1", "s3", 1), { skipped: SKIPPED })).toBeUndefined();
    expect(readSelection(DOC, at("s6", "time", 0), at("s1", "gap", 0), { skipped: SKIPPED })).toBeUndefined();
  });
});

describe("readSelection gaps and quotes", () => {
  it("crosses a gap that lies between the first and the last selected sentence", () => {
    const result = readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 2), sp("s3", "s3", 5));
    expect(result.crossesGap).toBe(true);
    expect(result.copyText).toContain("略过 11 秒");
    expect(result.explainText).toBe(`1 句发言人模拟字幕。${SKIPPED}第 3 句`);
    expect(result.quote).toBeUndefined();
  });

  it("does not cross a gap the selection only ends in", () => {
    const result = readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 2), at("gap:s2", "gap", 3));
    expect(result).toMatchObject({ crossesGap: false, sentenceCount: 1, explainText: "1 句发言人模拟字幕。" });
    expect(result.quote).toBeUndefined();
  });

  it("does not cross a gap when the sentences selected beyond it are none", () => {
    expect(readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 2), at("s3", "time", 2)).crossesGap).toBe(false);
  });

  it("selects only a gap label: nothing to explain, the label to copy", () => {
    const result = readBoth(FILTERED_BEFORE_TURN, at("gap:s2", "gap", 0), at("gap:s2", "gap", "略过 11 秒".length));
    expect(result).toMatchObject({ explainText: "", copyText: "略过 11 秒", sentenceCount: 0, crossesGap: false });
    expect(result.bounds).toBeUndefined();
  });

  it("selects only a name or only a time: nothing to explain, the characters to copy", () => {
    const name = readBoth(DOC, at("s3", "speaker", 0), at("s3", "speaker", 3));
    expect(name).toMatchObject({ explainText: "", copyText: "发言人", sentenceCount: 0, crossesGap: false });
    expect(name.bounds).toBeUndefined();
    expect(name.quote).toBeUndefined();
    const time = readBoth(DOC, at("s3", "speaker", 2), at("s3", "time", 4));
    expect(time).toMatchObject({ explainText: "", copyText: "人 2\n0:20", sentenceCount: 0 });
    expect(time.bounds).toBeUndefined();
  });

  it("quotes the whole sentence when one sentence holds everything selected", () => {
    expect(readBoth(DOC, sp("s3", "s3", 2), sp("s3", "s3", 5)).quote).toEqual({ id: "s3", text: S3 });
    expect(readBoth(DOC, sp("s3", "s3", 0), sp("s4", "s4", 0)).quote).toEqual({ id: "s3", text: S3 });
    expect(readBoth(DOC, at("s3", "speaker", 0), sp("s3", "s3", 3)).quote).toEqual({ id: "s3", text: S3 });
  });

  it("does not quote with a title, a gap label or a second sentence selected", () => {
    expect(readBoth(DOC, at("chapter:15000", "title", 3), sp("s3", "s3", 3)).quote).toBeUndefined();
    expect(readBoth(FILTERED_BEFORE_TURN, sp("s1", "s1", 0), at("gap:s2", "gap", 1)).quote).toBeUndefined();
    expect(readBoth(DOC, sp("s4", "s4", 20), sp("s4", "s5", 1)).quote).toBeUndefined();
  });

  it("quotes past a title of which only whitespace is selected", () => {
    const rows = [chapter("c", "标题 "), para("p", "0:00", [["p1", S1]])];
    expect(readBoth(rows, at("c", "title", 2), sp("p", "p1", 3)).quote).toEqual({ id: "p1", text: S1 });
  });
});

describe("hasPoint", () => {
  it("finds each kind of part on the row that has it", () => {
    expect(hasPoint(DOC, at("chapter:0", "title", 0))).toBe(true);
    expect(hasPoint(DOC, at("s1", "speaker", 1))).toBe(true);
    expect(hasPoint(DOC, at("s1", "time", 2))).toBe(true);
    expect(hasPoint(DOC, sp("s1", "s2", 3))).toBe(true);
    expect(hasPoint(FILTERED_BEFORE_TURN, at("gap:s2", "gap", 0))).toBe(true);
  });

  it("ignores the offset", () => {
    expect(hasPoint(DOC, sp("s1", "s2", 999))).toBe(true);
  });

  it("rejects a part the row does not have", () => {
    expect(hasPoint(DOC, at("chapter:0", "time", 0))).toBe(false);
    expect(hasPoint(DOC, at("s1", "title", 0))).toBe(false);
    expect(hasPoint(DOC, at("s1", "gap", 0))).toBe(false);
    expect(hasPoint(FILTERED_BEFORE_TURN, at("gap:s2", "title", 0))).toBe(false);
    expect(hasPoint(ONE_TURN, at("t3", "speaker", 0))).toBe(false);
    expect(hasPoint(PLAIN, at("s1", "speaker", 0))).toBe(false);
  });

  it("rejects a missing row and a sentence that moved to another row", () => {
    expect(hasPoint(DOC, at("gone", "time", 0))).toBe(false);
    expect(hasPoint(DOC, sp("s1", "s3", 0))).toBe(false);
    expect(hasPoint(DOC, { rowKey: "s1", part: "sentence", offset: 0 })).toBe(false);
  });
});

describe("selectionRows", () => {
  const chapters = [{ startMs: 0, endMs: 60_000, title: "开场" }, { startMs: 60_000, endMs: 600_000, title: "正文" }];
  const keyOf = (row: FilteredRow): string => filteredRowKey(row, viewRowKey);

  function labels() {
    return {
      speaker: vi.fn((turn: TurnPlace) => ({ name: turn.speakerId === undefined ? "未分配" : `名-${turn.speakerId}`, named: turn.speakerId !== undefined })),
      time: vi.fn((startMs: number) => `t${startMs}`),
      gap: vi.fn((row: GapRow) => `略过 ${row.skippedMs}`),
    };
  }

  it("keeps the order and keys, and gives the header only to a turn's first row", () => {
    const rows: FilteredRow[] = viewRows(readerSections(SPEAKER_SEGMENTS, chapters), { turns: true });
    const gapRow: GapRow = { kind: "gap", firstSkippedId: "x", skippedMs: 11_000 };
    rows.splice(3, 0, gapRow);
    const l = labels();
    const result = selectionRows(rows, keyOf, l);
    expect(result.map((row) => row.key)).toEqual(rows.map(keyOf));
    expect(result.map((row) => (row.kind === "paragraph" ? `${row.key}:${row.speaker?.name ?? "-"}` : row.kind === "chapter" ? `#${row.title}` : `~${row.label}`))).toEqual([
      "#开场",
      "g1:名-sp1",
      "g3:名-sp2",
      "~略过 11000",
      "g4:名-sp1",
      "g5:-",
      "g6:未分配",
      "#正文",
      "g7:名-sp1",
    ]);
    const g5 = result.find((row) => row.key === "g5");
    expect(g5 !== undefined && "speaker" in g5).toBe(false);
    expect(result.find((row) => row.key === "g6")).toMatchObject({ speaker: { name: "未分配", named: false } });
    expect(l.gap).toHaveBeenCalledWith(gapRow);
    const firstRows = rows.flatMap((row) => (row.kind === "paragraph" && row.turn?.first === true ? [row.turn] : []));
    expect(l.speaker.mock.calls.map(([turn]) => turn)).toEqual(firstRows);
    expect(l.time.mock.calls.map(([ms]) => ms)).toEqual(rows.flatMap((row) => (row.kind === "paragraph" ? [row.paragraph.startMs] : [])));
    expect(result.find((row) => row.key === "g1")).toEqual({
      key: "g1",
      kind: "paragraph",
      time: "t0",
      sentences: [{ id: "g1", text: "今天讲检索。" }, { id: "g2", text: "先看向量库。" }],
      marked: false,
      speaker: { name: "名-sp1", named: true },
    });
  });

  it("gives no row a header outside the turn layout", () => {
    const l = labels();
    const result = selectionRows(viewRows(readerSections(SPEAKER_SEGMENTS, chapters), { turns: false }), keyOf, l);
    expect(result.some((row) => "speaker" in row)).toBe(false);
    expect(l.speaker).not.toHaveBeenCalled();
  });

  it("marks a paragraph whose sentences carry paragraph marks", () => {
    const marked = [segment("m1", 0, 0, 1_000, "第一句。", { paragraphStart: true }), segment("m2", 1, 1_000, 2_000, "第二句。", { paragraphStart: false })];
    const result = selectionRows(viewRows(readerSections(marked, []), { turns: false }), keyOf, labels());
    expect(result.map((row) => row.kind === "paragraph" && row.marked)).toEqual([true]);
  });
});

/**
 * One document whose sentences each use a character no other text in it uses, so a sentence
 * shows up in a text exactly when one of its characters was selected.
 */
const UNIQUE: SelectionRow[] = [
  chapter("c0", "开场白"),
  para("u1", "0:00", [["u1", "甲甲甲甲"], ["u2", "乙乙 乙乙"]], { speaker: "林老师" }),
  para("u3", "0:10", [["u3", "丙丙丙"]]),
  gap("g", "略过 11 秒"),
  chapter("c1", "学生提问"),
  para("u4", "0:30", [["u4", "KKK KKK"], ["u5", "丁丁丁丁丁"]], { speaker: "发言人 2" }),
  para("u6", "0:40", [["u6", "戊戊"]], { speaker: "未分配", named: false }),
];
const UNIQUE_CHAR: Record<string, string> = { u1: "甲", u2: "乙", u3: "丙", u4: "K", u5: "丁", u6: "戊" };
const ORDER = ["u1", "u2", "u3", "u4", "u5", "u6"];

describe("readSelection consistency", () => {
  interface Cell {
    point: ReaderPoint;
    char: string;
    segmentId?: string;
  }
  // Every character of the document in reading order, built without the implementation's ordering.
  const cells: Cell[] = [];
  const points: ReaderPoint[] = [];
  for (const row of UNIQUE) {
    const parts: Array<{ part: ReaderPart; text: string; segmentId?: string }> =
      row.kind === "chapter"
        ? [{ part: "title", text: row.title }]
        : row.kind === "gap"
          ? [{ part: "gap", text: row.label }]
          : [
              ...(row.speaker === undefined ? [] : [{ part: "speaker" as const, text: row.speaker.name }]),
              { part: "time" as const, text: row.time },
              ...row.sentences.map((s) => ({ part: "sentence" as const, text: s.text, segmentId: s.id })),
            ];
    for (const { part, text, segmentId } of parts) {
      const point = (offset: number): ReaderPoint => ({ rowKey: row.key, part, offset, ...(segmentId === undefined ? {} : { segmentId }) });
      [...text].forEach((_, index) => cells.push({ point: point(index), char: text[index] as string, ...(segmentId === undefined ? {} : { segmentId }) }));
      for (const offset of new Set([0, 1, Math.floor(text.length / 2), text.length - 1, text.length])) points.push(point(offset));
    }
  }
  // A point's place: the cell it sits before; the end of a part sits before the next part's first cell.
  function place(point: ReaderPoint): number {
    const index = cells.findIndex((cell) => cell.point.rowKey === point.rowKey && cell.point.part === point.part && cell.point.segmentId === point.segmentId && cell.point.offset === point.offset);
    if (index >= 0) return index;
    const last = cells.findLastIndex((cell) => cell.point.rowKey === point.rowKey && cell.point.part === point.part && cell.point.segmentId === point.segmentId);
    return last + 1;
  }

  it("names the same sentences in the bounds, the count, the explain text and the copy text", () => {
    let checked = 0;
    for (const anchor of points) {
      for (const focus of points) {
        const [from, to] = [place(anchor), place(focus)].sort((x, y) => x - y) as [number, number];
        const selected = cells.slice(from, to);
        const expected = ORDER.filter((id) => selected.some((cell) => cell.segmentId === id && cell.char.trim() !== ""));
        const result = read(UNIQUE, anchor, focus);
        const label = `${JSON.stringify(anchor)} → ${JSON.stringify(focus)}`;
        expect(result.sentenceCount, label).toBe(expected.length);
        if (expected.length === 0) {
          expect(result.bounds, label).toBeUndefined();
        } else {
          const bounds = result.bounds;
          expect(bounds, label).toBeDefined();
          const span = ORDER.slice(ORDER.indexOf(bounds?.start.segmentId ?? ""), ORDER.indexOf(bounds?.end.segmentId ?? "") + 1);
          expect(span, label).toEqual(expected);
        }
        expect(ORDER.filter((id) => result.explainText.includes(UNIQUE_CHAR[id] as string)), label).toEqual(expected);
        expect(ORDER.filter((id) => result.copyText.includes(UNIQUE_CHAR[id] as string)), label).toEqual(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("readSelection on a long document", () => {
  it("reads a selection over many rows in order without slowing down", () => {
    const rows: SelectionRow[] = [];
    for (let index = 0; index < 3000; index += 1) {
      if (index % 50 === 0) rows.push(chapter(`c${index}`, `第 ${index} 章`));
      else if (index % 37 === 0) rows.push(gap(`g${index}`, "略过 5 秒"));
      else rows.push(para(`p${index}`, `${index}:00`, [[`a${index}`, `第 ${index} 句甲。`], [`b${index}`, `第 ${index} 句乙。`]], index % 3 === 1 ? { speaker: `人${index % 4}` } : {}));
    }
    expect(rows).toHaveLength(3000);
    const startedAt = performance.now();
    const result = read(rows, sp("p1481", "a1481", 2), sp("p1521", "b1521", 3));
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(200);
    expect([result.firstRow, result.lastRow]).toEqual([1481, 1521]);
    const paragraphs = rows.slice(1481, 1522).filter((row) => row.kind === "paragraph");
    expect(result.sentenceCount).toBe(paragraphs.length * 2);
    expect(result.bounds).toEqual({ start: { segmentId: "a1481", offset: 2 }, end: { segmentId: "b1521", offset: 3 } });
    expect(result.crossesGap).toBe(true);
    const sentences = paragraphs.flatMap((row) => (row.kind === "paragraph" ? row.sentences : [])).slice(0, -1);
    let cursor = 0;
    // Every sentence but the last, whose head is cut at "第 1", appears in order.
    for (const sentence of sentences) {
      const probe = sentence.text.slice(2, -1);
      const found = result.copyText.indexOf(probe, cursor);
      expect(found, sentence.id).toBeGreaterThanOrEqual(cursor);
      cursor = found + probe.length;
    }
    expect(result.copyText.startsWith("1481 句甲。")).toBe(true);
    expect(result.copyText.endsWith("第 1")).toBe(true);
    expect(result.explainText).toContain("。 第 1500 章 第 1501 句甲。");
  });
});
