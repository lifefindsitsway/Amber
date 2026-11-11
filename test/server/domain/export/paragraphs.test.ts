import { describe, expect, it } from "vitest";
import { PARAGRAPH_GAP_MS, PARAGRAPH_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import { isMarked, joinReading, readingParagraphs } from "../../../../src/shared/reading.ts";
import { ParagraphBuilder, type Paragraph } from "../../../../src/server/domain/export/paragraphs.ts";

interface Sentence {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  paragraphStart?: boolean;
}

function paragraphs(sentences: Sentence[]): Paragraph[] {
  const builder = new ParagraphBuilder();
  const out: Paragraph[] = [];
  for (const sentence of sentences) {
    const closed = builder.push(sentence);
    if (closed !== undefined) out.push(closed);
  }
  const last = builder.flush();
  if (last !== undefined) out.push(last);
  return out;
}

/** Back-to-back one-second sentences with the given texts. */
function run(texts: string[], speakerId?: string): Sentence[] {
  return texts.map((text, index) => ({ startMs: index * 1000, endMs: index * 1000 + 1000, text, ...(speakerId === undefined ? {} : { speakerId }) }));
}

describe("ParagraphBuilder", () => {
  it("starts a paragraph after a gap longer than PARAGRAPH_GAP_MS, not at exactly the gap", () => {
    expect(
      paragraphs([
        { startMs: 0, endMs: 1000, text: "一。" },
        { startMs: 1000 + PARAGRAPH_GAP_MS, endMs: 4000, text: "二。" },
        { startMs: 4001 + PARAGRAPH_GAP_MS, endMs: 9000, text: "三。" },
      ]),
    ).toEqual([
      { startMs: 0, text: "一。二。" },
      { startMs: 4001 + PARAGRAPH_GAP_MS, text: "三。" },
    ]);
  });

  it("starts a paragraph when the speaker changes", () => {
    expect(
      paragraphs([
        { startMs: 0, endMs: 1000, text: "A", speakerId: "s1" },
        { startMs: 1000, endMs: 2000, text: "B", speakerId: "s2" },
      ]).map((paragraph) => paragraph.text),
    ).toEqual(["A", "B"]);
  });

  it("joins the way the reading view does: nothing after CJK punctuation, a space between unpunctuated CJK sentences", () => {
    expect(paragraphs(run(["你好。", "世界"]))[0]?.text).toBe("你好。世界");
    expect(paragraphs(run(["今天讲第一章", "先看定义"]))[0]?.text).toBe("今天讲第一章 先看定义");
    expect(paragraphs(run(["Hello.", "World"]))[0]?.text).toBe("Hello. World");
    expect(paragraphs(run(["你好", "World"]))[0]?.text).toBe("你好 World");
  });

  it("breaks at the soft cap only at a sentence end, and at twice the cap in any case", () => {
    const filler = "字".repeat(PARAGRAPH_MAX_CHARS - 1);
    // Over the cap after the second sentence, but neither ends a sentence: no break until "。".
    const soft = paragraphs(run([filler, "还没完", "到此为止。", "新段落"]));
    expect(soft.map((paragraph) => paragraph.text.length)).toEqual([filler.length + 1 + 3 + 1 + 5, 3]);
    const atCap = "字".repeat(PARAGRAPH_MAX_CHARS);
    const hard = paragraphs(run([atCap, atCap, atCap]));
    expect(hard.map((paragraph) => paragraph.text)).toEqual([`${atCap} ${atCap}`, atCap]);
  });

  it("follows paragraph marks when the revision has them, ignoring pauses and the cap", () => {
    const body = "字".repeat(PARAGRAPH_MAX_CHARS);
    const marked = run([body, body, body, body], undefined).map((sentence, index) => ({
      ...sentence,
      // A pause well past PARAGRAPH_GAP_MS before the third sentence must not break a marked revision.
      startMs: index < 2 ? sentence.startMs : sentence.startMs + PARAGRAPH_GAP_MS * 5,
      endMs: index < 2 ? sentence.endMs : sentence.endMs + PARAGRAPH_GAP_MS * 5,
      paragraphStart: index === 0 || index === 3,
    }));
    const out = paragraphs(marked);
    // Marked CJK sentences without closing punctuation join with no space between them.
    expect(out.map((paragraph) => paragraph.text.length)).toEqual([PARAGRAPH_MAX_CHARS * 3, PARAGRAPH_MAX_CHARS]);
  });

  it("starts afresh after a flush, so a chapter boundary resets the running length", () => {
    const body = "字".repeat(PARAGRAPH_MAX_CHARS);
    const builder = new ParagraphBuilder();
    const [first, second, third] = run([`${body}。`, body, body]) as [Sentence, Sentence, Sentence];
    builder.push(first);
    expect(builder.flush()?.text).toBe(`${body}。`);
    // Without the reset the second sentence would already sit at the cap and break before the third.
    expect(builder.push(second)).toBeUndefined();
    expect(builder.push(third)).toBeUndefined();
    expect(builder.flush()?.text).toBe(`${body} ${body}`);
  });

  it("joins CJK across a bare sentence end directly in a marked revision and with a space in an unmarked one", () => {
    const texts = ["但这样就等于你同时拒绝了你的老师", "和牛逼的网课，"];
    const marked = run(texts).map((sentence, index) => ({ ...sentence, paragraphStart: index === 0 }));
    expect(paragraphs(marked)).toEqual([{ startMs: 0, text: "但这样就等于你同时拒绝了你的老师和牛逼的网课，" }]);
    expect(paragraphs(run(texts))).toEqual([{ startMs: 0, text: "但这样就等于你同时拒绝了你的老师 和牛逼的网课，" }]);
  });

  it("keeps the space at a CJK–English boundary even in a marked revision", () => {
    const marked = run(["我们用", "React 写界面"]).map((sentence, index) => ({ ...sentence, paragraphStart: index === 0 }));
    expect(paragraphs(marked)).toEqual([{ startMs: 0, text: "我们用 React 写界面" }]);
  });

  it("produces the same paragraphs as the batch readingParagraphs for the same sentences", () => {
    const sentences: Sentence[] = [
      ...run(["我们开始。", "第一个问题是什么", "是定义。", "字".repeat(PARAGRAPH_MAX_CHARS), "结束了。", "下一句"], "a"),
      { startMs: 7000 + PARAGRAPH_GAP_MS, endMs: 9000, text: "换人说话", speakerId: "b" },
      { startMs: 9000, endMs: 10_000, text: "Line one\nline two", speakerId: "b" },
    ];
    const expected = readingParagraphs(sentences.map((sentence) => ({ ...sentence, text: sentence.text.replace(/\s*\n\s*/gu, " ") }))).map((paragraph) => ({
      startMs: paragraph.startMs,
      ...(paragraph.speakerId === undefined ? {} : { speakerId: paragraph.speakerId }),
      text: joinReading(
        paragraph.segments.map((segment) => segment.text),
        paragraph.segments.some(isMarked),
      ),
    }));
    expect(paragraphs(sentences)).toEqual(expected);
  });

  it("records the speaker of a paragraph, and a speaker change always starts one", () => {
    const out = paragraphs([
      { startMs: 0, endMs: 500, text: "一。", speakerId: "a" },
      { startMs: 600, endMs: 900, text: "二。", speakerId: "a" },
      { startMs: 1000, endMs: 1500, text: "三。", speakerId: "b" },
      { startMs: 1600, endMs: 1900, text: "四。" },
    ]);
    expect(out).toEqual([
      { startMs: 0, text: "一。二。", speakerId: "a" },
      { startMs: 1000, text: "三。", speakerId: "b" },
      { startMs: 1600, text: "四。" },
    ]);
    expect("speakerId" in (out[2] as object)).toBe(false);
  });
});
