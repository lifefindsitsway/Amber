import { describe, expect, it } from "vitest";
import { capCitationRuns, stripCitations } from "../../src/shared/citation-runs.ts";

const seg = (id: string): string => `[[seg:${id}]]`;

describe("capCitationRuns", () => {
  it("keeps the first markers of a long run", () => {
    expect(capCitationRuns(`结论。${seg("a")}${seg("b")}${seg("c")}${seg("d")}${seg("e")} 下一句`, 2)).toBe(`结论。${seg("a")}${seg("b")} 下一句`);
  });

  it("treats space and list punctuation between markers as one run", () => {
    expect(capCitationRuns(`甲 ${seg("a")} ${seg("b")}、${seg("c")}，${seg("d")}`, 2)).toBe(`甲 ${seg("a")}${seg("b")}`);
  });

  it("leaves short runs and separate citations untouched", () => {
    const text = `甲${seg("a")}${seg("b")}。乙${seg("c")}。`;
    expect(capCitationRuns(text, 2)).toBe(text);
  });

  it("does not join runs across a line break", () => {
    const text = `甲${seg("a")}${seg("b")}\n${seg("c")}${seg("d")}`;
    expect(capCitationRuns(text, 2)).toBe(text);
  });

  it("drops repeated markers within a run before counting", () => {
    expect(capCitationRuns(`甲${seg("a")}${seg("a")}${seg("b")}`, 2)).toBe(`甲${seg("a")}${seg("b")}`);
  });

  it("counts unresolved markers as citations", () => {
    expect(capCitationRuns(`甲[[unresolved:s9]]${seg("a")}${seg("b")}`, 2)).toBe(`甲[[unresolved:s9]]${seg("a")}`);
  });

  it("leaves code and other bracketed text alone", () => {
    const text = "数组 [[1, 2]] 与 [s3] 不是引用";
    expect(capCitationRuns(text, 1)).toBe(text);
  });
});

describe("stripCitations", () => {
  it("removes every run and the space after it", () => {
    expect(stripCitations(`内卷。${seg("a")}${seg("b")} 最终提出[[s3]]、[[s4]] 方向。\n- 要点 ${seg("c")}\n`)).toBe("内卷。最终提出方向。\n- 要点\n");
  });

  it("keeps text without markers", () => {
    expect(stripCitations("没有引用的正文。")).toBe("没有引用的正文。");
  });
});
