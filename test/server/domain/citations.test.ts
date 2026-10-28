import { describe, expect, it } from "vitest";
import {
  markedSegmentIds,
  AliasTable,
  applyRepair,
  checkCitations,
  cappedCitations,
  finalizeCitations,
  markUnresolved,
  needsRepair,
  parseRepair,
  renderCandidates,
  repairCandidates,
  transcriptAliasTable,
  withoutCitations,
} from "../../../src/server/domain/citations.ts";
import type { TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import { CITATION_INVALID_RATIO_MAX, CITATION_REPAIR_CANDIDATES, CITATION_RUN_MAX } from "../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";

const seg = (n: number) => `01J00000000000000000000${String(n).padStart(3, "0")}` as SegmentId;

function segments(texts: readonly string[]): TranscriptSegment[] {
  return texts.map((text, ordinal) => ({ id: seg(ordinal + 1), revisionId: "r1", ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, text, sourceSegmentIds: [] }));
}

const TEXTS = ["检索增强生成把外部文档放进上下文", "向量数据库保存文本嵌入", "重排序模型提高召回质量", "评估要看事实一致性"];

describe("alias tables", () => {
  it("numbers a revision's sentences s1..sN by ordinal and renders one-line prompt lines", () => {
    const shuffled = segments(["第一句\n换行", "第二句"]).reverse();
    const table = transcriptAliasTable("r1", shuffled);
    expect(table.entries.map((entry) => [entry.alias, entry.citation.segmentId])).toEqual([
      [1, seg(1)],
      [2, seg(2)],
    ]);
    expect(table.line(1)).toBe("[[s1]] 第一句 换行");
    expect(table.aliasOf(seg(2))).toBe(2);
    expect(table.fingerprint()).toBe(`1:r1:${seg(1)},2:r1:${seg(2)}`);
    expect(() => new AliasTable([{ alias: 2, citation: { transcriptRevisionId: "r", segmentId: seg(1) }, text: "" }])).toThrow();
  });
});

describe("citations kept out or cut short", () => {
  it("strips every marker from text that must not cite, the one-bracket-short alias forms included", () => {
    const text = `结论甲 [[s3]]，结论乙[s4]] [[s5]、[[seg:${seg(1)}]] [[unresolved:s9]] [[unresolved:seg:gone]]。\n第二段 [[s1]]\n[s2] 不是别名`;
    expect(withoutCitations(text)).toBe("结论甲，结论乙。\n第二段\n[s2] 不是别名");
    expect(withoutCitations("没有引用")).toBe("没有引用");
  });

  it("cuts each run of a stored body to the cap and keeps only the citations still marked, in order", () => {
    const ids = [1, 2, 3, 4, 5].map(seg);
    const citations = ids.map((segmentId) => ({ transcriptRevisionId: "r1", segmentId }));
    const run = ids.map((id) => `[[seg:${id}]]`);
    const body = `甲${run.join("")}。乙${run[3]}、${run[4]}，丙 ${run[0]} ${run[1]} ${run[2]}\n丁${run[4]}`;
    expect(CITATION_RUN_MAX).toBe(2);
    const capped = cappedCitations(body, citations);
    expect(capped.body).toBe(`甲${run[0]}${run[1]}。乙${run[3]}、${run[4]}，丙 ${run[0]}${run[1]}\n丁${run[4]}`);
    expect(capped.citations).toEqual([0, 1, 3, 4].map((i) => citations[i]));
    expect(cappedCitations(`甲${run[2]}`, citations)).toEqual({ body: `甲${run[2]}`, citations });
  });
});

describe("citation checks", () => {
  const table = transcriptAliasTable("r1", segments(TEXTS));

  it("counts alias occurrences, not distinct aliases, and ignores carried unresolved markers", () => {
    const check = checkCitations("a [[s1]] b [[s9]] c [[s9]] [[s0]] [[unresolved:s7]] [[s2]]", table);
    expect(check).toEqual({ total: 5, invalid: 3, invalidAliases: ["s9", "s0"], ratio: 3 / 5 });
    expect(needsRepair(check)).toBe(true);
  });

  it("treats an output without citations as ratio 0 and a ratio at the limit as acceptable", () => {
    expect(checkCitations("没有引用", table)).toEqual({ total: 0, invalid: 0, invalidAliases: [], ratio: 0 });
    const atLimit = { total: 100, invalid: 5, invalidAliases: ["s9"], ratio: CITATION_INVALID_RATIO_MAX };
    expect(needsRepair(atLimit)).toBe(false);
    expect(needsRepair({ ...atLimit, invalid: 6, ratio: 0.06 })).toBe(true);
  });

  it("ranks candidates by trigram similarity with the paragraphs holding the invalid alias, ties to the lower alias", () => {
    const text = "开头段落 [[s1]]\n\n向量数据库保存嵌入 [[s42]]\n\n无关段落";
    const candidates = repairCandidates(text, ["s42"], table);
    expect(candidates.get("s42")?.[0]?.alias).toBe(2);
    expect(candidates.get("s42")).toHaveLength(Math.min(CITATION_REPAIR_CANDIDATES, TEXTS.length));
    const rendered = renderCandidates(candidates, table);
    expect(rendered.startsWith("s42：\n[[s2]] 向量数据库保存文本嵌入")).toBe(true);
    // Same input, same ranking.
    expect(repairCandidates(text, ["s42"], table)).toEqual(candidates);
  });

  it("keeps at most CITATION_REPAIR_CANDIDATES candidates", () => {
    const many = transcriptAliasTable("r1", segments(Array.from({ length: CITATION_REPAIR_CANDIDATES + 5 }, (_, i) => `句子 ${i}`)));
    expect(repairCandidates("x [[s999]]", ["s999"], many).get("s999")).toHaveLength(CITATION_REPAIR_CANDIDATES);
  });
});

describe("repair and finalization", () => {
  const table = transcriptAliasTable("r1", segments(TEXTS));

  it("accepts only asked aliases mapped to existing ones; null, unknown and garbage repair nothing", () => {
    expect(parseRepair('答案：{ "s42": "s2", "s43": null, "s44": "s99", "s1": "s3", "[[s45]]": "[[s4]]" }', ["s42", "s43", "s44", "s45"], table)).toEqual({
      s42: "s2",
      s45: "s4",
    });
    expect(parseRepair("不是 JSON", ["s42"], table)).toEqual({});
    expect(parseRepair("[1,2]", ["s42"], table)).toEqual({});
  });

  it("applies a mapping, then stores valid aliases as [[seg:]] with de-duplicated citations and invalid ones as unresolved", () => {
    const repaired = applyRepair("甲 [[s42]] 乙 [[s43]] 丙 [[s2]] [[s1]]", { s42: "s2" });
    expect(repaired).toBe("甲 [[s2]] 乙 [[s43]] 丙 [[s2]] [[s1]]");
    expect(finalizeCitations(repaired, table)).toEqual({
      body: `甲 [[seg:${seg(2)}]] 乙 [[unresolved:s43]] 丙 [[seg:${seg(2)}]] [[seg:${seg(1)}]]`,
      citations: [
        { transcriptRevisionId: "r1", segmentId: seg(2) },
        { transcriptRevisionId: "r1", segmentId: seg(1) },
      ],
    });
  });

  it("marks only invalid aliases unresolved in text fed to a later call", () => {
    expect(markUnresolved("[[s1]] [[s77]] [[unresolved:s5]]", table)).toBe("[[s1]] [[unresolved:s77]] [[unresolved:s5]]");
  });
});

describe("aliases with one bracket missing", () => {
  const table = transcriptAliasTable("r1", segments(TEXTS));

  it("finalizes a run of citations written as [[s1]][s2]][s3]] into canonical markers, as a model was seen to do", () => {
    expect(finalizeCitations("要点。[[s1]][s2]][s3]]", table)).toEqual({
      body: `要点。[[seg:${seg(1)}]][[seg:${seg(2)}]][[seg:${seg(3)}]]`,
      citations: [1, 2, 3].map((n) => ({ transcriptRevisionId: "r1", segmentId: seg(n) })),
    });
    expect(finalizeCitations("结尾 [[s4]", table).body).toBe(`结尾 [[seg:${seg(4)}]]`);
    expect(finalizeCitations("[[s1][s2]]", table).body).toBe(`[[seg:${seg(1)}]][[seg:${seg(2)}]]`);
  });

  it("counts and marks an invalid alias in either form, so it can trigger repair instead of staying as text", () => {
    expect(checkCitations("[[s1]][s999]] 与 [[s998]", table)).toEqual({ total: 3, invalid: 2, invalidAliases: ["s999", "s998"], ratio: 2 / 3 });
    expect(finalizeCitations("[s999]]", table)).toEqual({ body: "[[unresolved:s999]]", citations: [] });
    expect(repairCandidates("向量数据库保存嵌入 [s42]]", ["s42"], table).get("s42")?.[0]?.alias).toBe(2);
  });

  it("repairs and normalizes either form, and leaves [s1], canonical and unresolved markers alone", () => {
    expect(applyRepair("甲 [s42]] 乙 [[s43]", { s42: "s2" })).toBe("甲 [[s2]] 乙 [[s43]");
    expect(markUnresolved("[s1]] [[s77]", table)).toBe("[[s1]] [[unresolved:s77]]");
    const untouched = `[s1] 是正文，[[seg:${seg(1)}]] 与 [[unresolved:s1]] 不变`;
    expect(checkCitations(untouched, table).total).toBe(0);
    expect(finalizeCitations(untouched, table)).toEqual({ body: untouched, citations: [] });
  });
});

describe("markedSegmentIds", () => {
  it("takes ids from whole canonical markers only", () => {
    expect(markedSegmentIds("a [[seg:01A]] b [[seg:01B]] [[seg:01A]]")).toEqual(["01A", "01B", "01A"]);
    expect(markedSegmentIds("01A seg:01A [[unresolved:seg:01C]] [[seg:01D]")).toEqual([]);
  });
});
