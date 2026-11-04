import { describe, expect, it } from "vitest";
import {
  applyCuts,
  applyDelete,
  applyReplace,
  cleanupAtCut,
  FILLER_WORDS,
  fillerCandidates,
  fillerCounts,
  findMatches,
  hitContext,
  wholeSentenceFillers,
} from "../../../../src/web/pages/content/find-replace.ts";
import { TRANSCRIPT_FILLER_WORDS_ZH } from "../../../../src/shared/defaults.ts";

describe("findMatches", () => {
  it("finds plain text left to right, without overlap, case-insensitive by default", () => {
    expect(findMatches(["aaaa", "Abc abc"], "aa", false)).toEqual([
      { index: 0, start: 0, end: 2 },
      { index: 0, start: 2, end: 4 },
    ]);
    expect(findMatches(["Abc abc"], "abc", false).map((m) => m.start)).toEqual([0, 4]);
    expect(findMatches(["Abc abc"], "abc", true).map((m) => m.start)).toEqual([4]);
  });

  it("treats the query as plain text, not a pattern", () => {
    expect(findMatches(["a.c abc (x)"], ".", false)).toEqual([{ index: 0, start: 1, end: 2 }]);
    expect(findMatches(["a.c abc (x)"], "(x)", false)).toEqual([{ index: 0, start: 8, end: 11 }]);
  });

  it("does nothing for an empty query", () => {
    expect(findMatches(["abc"], "", false)).toEqual([]);
  });

  it("counts offsets in UTF-16 units, as setSelectionRange does", () => {
    const text = "😀闫学通😀闫学通";
    const matches = findMatches([text], "闫学通", false);
    expect(matches.map((m) => [m.start, m.end])).toEqual([
      [2, 5],
      [7, 10],
    ]);
    expect(text.slice(7, 10)).toBe("闫学通");
    // A capital whose lower case is longer does not shift later offsets.
    expect(findMatches(["İx x"], "x", false).map((m) => m.start)).toEqual([1, 3]);
  });
});

describe("applyReplace", () => {
  it("replaces several hits in one sentence and shares untouched sentences", () => {
    const texts = ["闫学通说，闫学通认为", "无关的句子", "还是闫学通"];
    const matches = findMatches(texts, "闫学通", false);
    expect(matches).toHaveLength(3);
    const next = applyReplace(texts, matches, "阎学通");
    expect(next).toEqual(["阎学通说，阎学通认为", "无关的句子", "还是阎学通"]);
    expect(next[1]).toBe(texts[1]);
    expect(texts[0]).toBe("闫学通说，闫学通认为");
  });

  it("handles a replacement of another length", () => {
    expect(applyReplace(["ab ab ab"], findMatches(["ab ab ab"], "ab", true), "xyz")).toEqual(["xyz xyz xyz"]);
    expect(applyReplace(["ab ab ab"], findMatches(["ab ab ab"], "ab", true), "")).toEqual(["  "]);
  });
});

describe("cleanupAtCut", () => {
  const cut = (text: string, word: string): string => {
    const start = text.indexOf(word);
    return cleanupAtCut(text, start, start + word.length);
  };
  it.each([
    ["嗯，我们开始", "嗯", "我们开始"],
    ["嗯、我们开始", "嗯", "我们开始"],
    ["好。嗯，我们开始", "嗯", "好。我们开始"],
    ["我们，嗯，开始", "嗯", "我们，开始"],
    ["我们、嗯，开始", "嗯", "我们，开始"],
    ["我们，嗯；开始", "嗯", "我们；开始"],
    ["我们；嗯，开始", "嗯", "我们；开始"],
    ["我们、嗯、开始", "嗯", "我们、开始"],
    ["就这样，嗯。", "嗯", "就这样。"],
    ["就这样，嗯", "嗯", "就这样"],
    ["就这样，嗯？", "嗯", "就这样？"],
    ["我们嗯开始", "嗯", "我们开始"],
    ["“嗯，”他说", "嗯", "“，”他说"],
    ["（嗯，）他说", "嗯", "（，）他说"],
    ["就这样，嗯……", "嗯", "就这样，……"],
    ["so, um, yes", "um", "so, , yes"],
  ])("%s − %s → %s", (text, word, expected) => {
    expect(cut(text, word)).toBe(expected);
  });

  it("applies several cuts in one sentence right to left", () => {
    const text = "嗯，我们，啊，开始吧";
    expect(applyCuts(text, [{ start: 0, end: 1 }, { start: 5, end: 6 }])).toBe("我们，开始吧");
    expect(applyDelete([text, "不变"], [{ index: 0, start: 0, end: 1 }, { index: 0, start: 5, end: 6 }])).toEqual(["我们，开始吧", "不变"]);
  });
});

describe("filler words", () => {
  it("lists the configured words in order", () => {
    expect(FILLER_WORDS).toEqual(TRANSCRIPT_FILLER_WORDS_ZH.split(" "));
  });

  const hitsOf = (text: string) => fillerCandidates([text]).map((hit) => [text.slice(hit.start, hit.end), hit.start, hit.confidence]);

  it("takes hesitation sounds as high confidence", () => {
    expect(hitsOf("嗯，我们呃开始额")).toEqual([
      ["嗯", 0, "high"],
      ["呃", 4, "high"],
      ["额", 7, "high"],
    ]);
  });

  it("takes particles as high confidence at a start, before a pause and when doubled, else as maybe meaningful", () => {
    expect(hitsOf("啊我们开始")).toEqual([["啊", 0, "high"]]);
    expect(hitsOf("我们呢，开始")).toEqual([["呢", 2, "high"]]);
    expect(hitsOf("那个啊啊就是")).toEqual([
      ["啊", 2, "high"],
      ["啊", 3, "high"],
    ]);
    expect(hitsOf("你说呢？")).toEqual([["呢", 2, "maybe"]]);
    expect(hitsOf("真的啊？")).toEqual([["啊", 2, "maybe"]]);
    expect(hitsOf("好吧。")).toEqual([["吧", 1, "maybe"]]);
    expect(hitsOf("我们走吧")).toEqual([["吧", 3, "maybe"]]);
    expect(hitsOf("他呀就是这样")).toEqual([["呀", 1, "maybe"]]);
  });

  it.each(["额度", "额外", "金额", "名额", "酒吧", "网吧", "吧台", "哈密", "哈佛", "哈尔滨", "呢子", "呢绒", "干嘛", "喇嘛", "哎呀"])(
    "never offers a filler inside the word %s",
    (word) => {
      expect(fillerCandidates([`这是${word}的问题`])).toEqual([]);
    },
  );

  it("still offers a real filler next to an exception word", () => {
    expect(hitsOf("嗯，去酒吧")).toEqual([["嗯", 0, "high"]]);
  });

  it("finds sentences made only of fillers and leaves them out of the per-word hits", () => {
    const texts = ["嗯。", "啊，呃……", "嗯，好的", "？", "哈哈"];
    expect(wholeSentenceFillers(texts)).toEqual([0, 1, 4]);
    expect(fillerCandidates(texts).map((hit) => hit.index)).toEqual([2]);
  });

  it("counts hits per word in list order and gives a hit its context", () => {
    const hits = fillerCandidates(["啊，嗯，那个嗯"]);
    expect(fillerCounts(hits)).toEqual([
      { word: "嗯", count: 2 },
      { word: "啊", count: 1 },
    ]);
    expect(hitContext("一二三四五六七八九十", { start: 5, end: 6 }, 2)).toEqual({ before: "四五", hit: "六", after: "七八", clippedStart: true, clippedEnd: true });
  });
});
