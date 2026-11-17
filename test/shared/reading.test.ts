import { describe, expect, it } from "vitest";
import { PARAGRAPH_GAP_MS, PARAGRAPH_MAX_CHARS } from "../../src/shared/defaults.ts";
import { JOIN_SAMPLES } from "../fixtures/transcripts/reading-join.ts";
import {
  ReadingBreaks,
  endsSentence,
  hasParagraphs,
  isMarked,
  isOnlyPunctuationChange,
  joinReading,
  readingParagraphs,
  readingSections,
  readingSeparator,
  type ReadingSentence,
} from "../../src/shared/reading.ts";

function sentences(texts: readonly string[], options: { gapMs?: number; speakerId?: string } = {}): ReadingSentence[] {
  const gap = options.gapMs ?? 100;
  let at = 0;
  return texts.map((text) => {
    const sentence: ReadingSentence = { startMs: at, endMs: at + 1000, text, ...(options.speakerId === undefined ? {} : { speakerId: options.speakerId }) };
    at += 1000 + gap;
    return sentence;
  });
}

describe("endsSentence", () => {
  it("accepts CJK and ASCII sentence marks, also before a closing quote or bracket", () => {
    expect(endsSentence("今天讲系统性崩溃。")).toBe(true);
    expect(endsSentence("Is it real?")).toBe(true);
    expect(endsSentence("他说“真的吗？”")).toBe(true);
    expect(endsSentence("(see above.)")).toBe(true);
    expect(endsSentence("等等……")).toBe(true);
  });

  it("rejects clause marks, bare text and lone closers", () => {
    expect(endsSentence("今天讲系统性崩溃，")).toBe(false);
    expect(endsSentence("今天讲系统性崩溃")).toBe(false);
    expect(endsSentence("”")).toBe(false);
    expect(endsSentence("")).toBe(false);
  });
});

describe("readingSeparator / joinReading", () => {
  it("runs CJK sentences together after punctuation and spaces them when there is none", () => {
    expect(readingSeparator("第一句。", "第二句", false)).toBe("");
    expect(readingSeparator("第一句，", "第二句", false)).toBe("");
    expect(readingSeparator("第一句", "第二句", false)).toBe(" ");
    expect(readingSeparator("第一句.", "第二句", false)).toBe("");
    expect(readingSeparator("ends with a period.", "然后", false)).toBe(" ");
    expect(readingSeparator("他说“好”。", "然后", false)).toBe("");
  });

  it("spaces non-CJK text and mixed scripts", () => {
    expect(readingSeparator("hello", "world", false)).toBe(" ");
    expect(readingSeparator("用 Stanford", "的课程", false)).toBe(" ");
    expect(readingSeparator("中文", "English", false)).toBe(" ");
  });

  it("joins a marked revision's CJK sentence that runs across two time slices", () => {
    expect(readingSeparator("但这样就等于你同时拒绝了你的老师", "和牛逼的网课，", true)).toBe("");
    expect(readingSeparator("一个比较松散的讨", "论和交流的过程。", true)).toBe("");
    expect(readingSeparator("他说", "「好」", true)).toBe("");
    expect(readingSeparator("ひらがな", "カタカナ", true)).toBe("");
  });

  it("keeps a marked revision's spaces at script changes and its punctuation rules", () => {
    expect(readingSeparator("比如", "Stanford、MIT", true)).toBe(" ");
    expect(readingSeparator("用 slop", "写满，", true)).toBe(" ");
    expect(readingSeparator("第 3", "个问题", true)).toBe(" ");
    expect(readingSeparator("hello", "world", true)).toBe(" ");
    expect(readingSeparator("第一句。", "第二句", true)).toBe("");
    expect(readingSeparator("ends with a period.", "然后", true)).toBe(" ");
    expect(readingSeparator("end.", "Next", true)).toBe(" ");
  });

  it("joins while skipping empty sentences", () => {
    expect(joinReading(["大学的崩溃是系统性的", "我有自己的理解", ""], false)).toBe("大学的崩溃是系统性的 我有自己的理解");
    expect(joinReading(["大学的崩溃是系统性的。", "我有自己的理解。"], false)).toBe("大学的崩溃是系统性的。我有自己的理解。");
    expect(joinReading([], false)).toBe("");
  });

  it("joins a marked revision's sentences without spaces inside a CJK sentence", () => {
    expect(joinReading(["但这样就等于你同时拒绝了你的老师", "和牛逼的网课，", "进入一种恶性循环。"], true)).toBe(
      "但这样就等于你同时拒绝了你的老师和牛逼的网课，进入一种恶性循环。",
    );
    expect(joinReading(["AI 替我上大学的诱惑力", "实在太大了。", "Stanford", "的课程"], true)).toBe("AI 替我上大学的诱惑力实在太大了。Stanford 的课程");
  });
});

describe("isMarked / hasParagraphs", () => {
  it("is true for any sentence of a revision with paragraph marks", () => {
    expect(isMarked({ paragraphStart: true })).toBe(true);
    expect(isMarked({ paragraphStart: false })).toBe(true);
    expect(isMarked({})).toBe(false);
  });

  it("separates having paragraphs from joining as a proofread revision", () => {
    expect(hasParagraphs({ paragraphStart: false })).toBe(true);
    expect(isMarked({ paragraphStart: false, looseJoin: true })).toBe(false);
    expect(isMarked({ paragraphStart: true, looseJoin: false })).toBe(true);
    expect(hasParagraphs({})).toBe(false);
  });

  it("joins the golden samples: marked as proofread, loose and unmarked alike", () => {
    for (const sample of JOIN_SAMPLES) {
      expect(joinReading(sample.texts, true), sample.name).toBe(sample.marked);
      expect(joinReading(sample.texts, false), sample.name).toBe(sample.unmarked);
      expect(joinReading(sample.texts, isMarked({ paragraphStart: true, looseJoin: true })), sample.name).toBe(sample.unmarked);
    }
  });
});

describe("ReadingBreaks / readingParagraphs", () => {
  const body = "字".repeat(20);
  const ended = `${body}。`;

  it("breaks on a long pause or a speaker change", () => {
    const paused = sentences(["甲", "乙"], { gapMs: PARAGRAPH_GAP_MS + 1 });
    expect(readingParagraphs(paused)).toHaveLength(2);
    const speakers = [
      { startMs: 0, endMs: 1000, text: "甲", speakerId: "a" },
      { startMs: 1100, endMs: 2000, text: "乙", speakerId: "b" },
    ];
    expect(readingParagraphs(speakers).map((p) => p.speakerId)).toEqual(["a", "b"]);
  });

  it("breaks at the first sentence end once the cap is reached, never before", () => {
    // 101 chars at the 5th sentence end: under the cap, no break. 202 at the 10th: cap reached and it ends a sentence.
    const texts = [body, body, body, body, ended, body, body, body, body, ended, "下一段开始"];
    const paragraphs = readingParagraphs(sentences(texts));
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.segments).toHaveLength(10);
    expect(paragraphs[1]?.segments[0]?.text).toBe("下一段开始");
  });

  it("keeps going past the cap while sentences have no end mark, up to twice the cap", () => {
    const unpunctuated = Array.from({ length: 30 }, () => body);
    const paragraphs = readingParagraphs(sentences(unpunctuated));
    const sizes = paragraphs.map((p) => p.segments.reduce((sum, s) => sum + s.text.length, 0));
    expect(sizes).toEqual([PARAGRAPH_MAX_CHARS * 2, 200]);
  });

  it("never splits a sentence: one oversize sentence is its own paragraph", () => {
    const giant = "字".repeat(PARAGRAPH_MAX_CHARS * 3) + "。";
    const paragraphs = readingParagraphs(sentences([giant, "后面一句。", "再一句。"]));
    expect(paragraphs[0]?.segments).toHaveLength(1);
    expect(paragraphs[1]?.segments.map((s) => s.text)).toEqual(["后面一句。", "再一句。"]);
  });

  it("streams one sentence at a time with the same result as the batch form", () => {
    const texts = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? ended : body));
    const list = sentences(texts);
    const breaks = new ReadingBreaks();
    const streamed: number[] = [];
    list.forEach((sentence, index) => {
      if (breaks.push(sentence)) streamed.push(index);
    });
    const batch = readingParagraphs(list);
    let index = 0;
    const batchStarts = batch.map((p) => {
      const start = index;
      index += p.segments.length;
      return start;
    });
    expect(streamed).toEqual(batchStarts);
    expect(streamed[0]).toBe(0);
  });
});

describe("readingParagraphs with paragraph marks", () => {
  const body = "字".repeat(PARAGRAPH_MAX_CHARS);
  const marked = (starts: readonly boolean[], options: { gapMs?: number } = {}): ReadingSentence[] =>
    sentences(starts.map(() => body), options).map((sentence, index) => ({ ...sentence, paragraphStart: starts[index] as boolean }));

  it("breaks exactly at marked sentences, never by length", () => {
    const paragraphs = readingParagraphs(marked([true, false, false, false, true, false]));
    expect(paragraphs.map((p) => p.segments.length)).toEqual([4, 2]);
  });

  it("ignores pauses once a revision carries marks, but still breaks on a speaker change", () => {
    expect(readingParagraphs(marked([true, false, false], { gapMs: PARAGRAPH_GAP_MS * 10 }))).toHaveLength(1);
    const speakers = marked([true, false, false]).map((sentence, index) => ({ ...sentence, speakerId: index === 2 ? "b" : "a" }));
    expect(readingParagraphs(speakers).map((p) => p.segments.length)).toEqual([2, 1]);
  });

  it("breaks a loosely joined revision at its marks too, never by pause or length", () => {
    const loose = marked([true, false, false, true], { gapMs: PARAGRAPH_GAP_MS * 10 }).map((sentence) => ({ ...sentence, looseJoin: true }));
    expect(readingParagraphs(loose).map((p) => p.segments.length)).toEqual([3, 1]);
  });

  it("decides the mode by the first sentence, since marks are all-or-nothing within a revision", () => {
    const breaks = new ReadingBreaks();
    const [first, second] = marked([true, true]) as [ReadingSentence, ReadingSentence];
    expect(breaks.push(first)).toBe(true);
    expect(breaks.push(second)).toBe(true);
    const fallback = new ReadingBreaks();
    const plain = sentences([body, body]);
    expect(fallback.push(plain[0] as ReadingSentence)).toBe(true);
    // Unmarked revision at the cap with no sentence end: no break yet.
    expect(fallback.push(plain[1] as ReadingSentence)).toBe(false);
  });
});

describe("readingSections", () => {
  const list = sentences(["一", "二", "三", "四"]);
  const at = (index: number) => (list[index] as ReadingSentence).startMs;

  it("gives each sentence to the latest chapter starting at or before it and keeps the lead-in untitled", () => {
    const sections = readingSections(list, [
      { startMs: at(2), title: "乙" },
      { startMs: at(1), title: "甲" },
    ]);
    expect(sections.map((section) => [section.chapter?.title, section.sentences.map((s) => s.text)])).toEqual([
      [undefined, ["一"]],
      ["甲", ["二"]],
      ["乙", ["三", "四"]],
    ]);
  });

  it("drops chapters without a sentence and lets the last of several same-start chapters take the sentence", () => {
    const sections = readingSections(list, [
      { startMs: 0, title: "首" },
      { startMs: at(1) - 1, title: "空" },
      { startMs: at(1), title: "甲" },
      { startMs: at(3) + 10_000, title: "尾" },
    ]);
    expect(sections.map((section) => section.chapter?.title)).toEqual(["首", "甲"]);
    expect(readingSections(list, [])).toEqual([{ sentences: list }]);
  });
});

describe("isOnlyPunctuationChange", () => {
  it("is true for added or changed syntax punctuation and whitespace", () => {
    expect(isOnlyPunctuationChange("大学的崩溃是系统性的我对这有一个理解", "大学的崩溃是系统性的，我对这有一个理解。")).toBe(true);
    expect(isOnlyPunctuationChange("he said yes", "He said yes")).toBe(false);
    expect(isOnlyPunctuationChange("他说真的吗", "他说“真的吗？”")).toBe(true);
    expect(isOnlyPunctuationChange("a b", "a  b")).toBe(true);
  });

  it("is false when content characters change, including technical symbols", () => {
    expect(isOnlyPunctuationChange("杠I", "-I")).toBe(false);
    expect(isOnlyPunctuationChange("10", "10%")).toBe(false);
    expect(isOnlyPunctuationChange("tag", "#tag")).toBe(false);
    expect(isOnlyPunctuationChange("name", "@name")).toBe(false);
    expect(isOnlyPunctuationChange("a b", "a_b")).toBe(false);
    expect(isOnlyPunctuationChange("同一句。", "同一句。")).toBe(false);
  });
});
