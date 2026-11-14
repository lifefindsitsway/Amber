import { describe, expect, it } from "vitest";
import { readAssDocument, unwrapLines } from "../../../../src/server/domain/subtitle-formats/ass.ts";

const HEADER = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname",
  "Style: Default,Noto Sans SC",
  "Style: Translation,Noto Sans SC",
  "Style: Speaker,Noto Sans SC",
  "Style: Box,Noto Sans SC",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
].join("\n");

const event = (layer: number, start: string, end: string, style: string, name: string, text: string): string => `Dialogue: ${layer},${start},${end},${style},${name},0,0,0,,${text}`;

describe("pre-wrapped lines", () => {
  it("joins them back as the export broke them", () => {
    expect(unwrapLines(["接下来我们要讨论的是", "一个非常长的句子。"])).toBe("接下来我们要讨论的是一个非常长的句子。");
    expect(unwrapLines(["a very long sentence", "that goes on"])).toBe("a very long sentence that goes on");
    expect(unwrapLines(["我用", "Python 写代码"])).toBe("我用Python 写代码");
    expect(unwrapLines(["Use Python", "写代码"])).toBe("Use Python写代码");
    expect(unwrapLines(["a well-", "known fact"])).toBe("a well-known fact");
    expect(unwrapLines(["Привет", "мир"])).toBe("Привет мир");
    expect(unwrapLines(["only"])).toBe("only");
    expect(unwrapLines([])).toBe("");
  });
});

describe("Amber styled ASS", () => {
  it("drops background events and position tags, and rebuilds one sentence across touching slices", () => {
    const text = [
      HEADER,
      event(0, "0:00:00.00", "0:00:01.00", "Box", "", "{\\an2\\pos(960,994)}甲"),
      event(1, "0:00:00.00", "0:00:01.00", "Default", "", "{\\an2\\pos(960,994)}甲"),
      event(1, "0:00:01.00", "0:00:02.00", "Default", "", "{\\an2\\pos(960,994)}甲\\N乙"),
      event(1, "0:00:02.00", "0:00:03.00", "Default", "", "{\\an2\\pos(960,994)}乙"),
      // Not touching the previous slice: a new sentence even with the same text.
      event(1, "0:00:04.00", "0:00:05.00", "Default", "", "{\\an2\\pos(960,994)}乙"),
    ].join("\n");
    const document = readAssDocument(text);
    expect(document.cues.map((cue) => [cue.startMs, cue.endMs, cue.lines])).toEqual([
      [0, 2000, ["甲"]],
      [1000, 3000, ["乙"]],
      [4000, 5000, ["乙"]],
    ]);
    expect(document.rebuiltFromSlices).toBe(true);
  });

  it("takes the voice from the Name of any slice of a sentence, else from its speaker row", () => {
    const text = [
      HEADER,
      event(1, "0:00:00.00", "0:00:01.00", "Speaker", "Ann", "{\\an2\\pos(960,994)}Ann\\N{\\rDefault}hello"),
      event(1, "0:00:01.00", "0:00:02.00", "Speaker", "", "{\\an2\\pos(960,994)}Ann\\N{\\rDefault}hello\\N{\\rSpeaker}Bo…\\N{\\rDefault}hi"),
      event(1, "0:00:02.00", "0:00:03.00", "Speaker", "", "{\\an2\\pos(960,994)}Bo…\\N{\\rDefault}hi"),
    ].join("\n");
    expect(readAssDocument(text).cues.map((cue) => [cue.startMs, cue.endMs, cue.lines[0], cue.voice])).toEqual([
      [0, 2000, "hello", "Ann"],
      [1000, 3000, "hi", "Bo…"],
    ]);
  });

  it("keeps rows of the same style as separate sentences", () => {
    const text = [HEADER, event(1, "0:00:00.00", "0:00:01.00", "Default", "", "{\\an2\\pos(960,994)}one\\N{\\rDefault}two")].join("\n");
    expect(readAssDocument(text).cues.map((cue) => cue.lines)).toEqual([["one"], ["two"]]);
  });

  it("reads a document of translation lines only as its text", () => {
    const text = [HEADER, event(1, "0:00:00.00", "0:00:01.00", "Translation", "", "{\\an2\\pos(960,994)}Hello")].join("\n");
    expect(readAssDocument(text).cues).toEqual([{ index: 0, startMs: 0, endMs: 1000, lines: ["Hello"] }]);
  });
});

describe("fixed-style ASS", () => {
  it("is one sentence per event, never rebuilt", () => {
    const text = [HEADER, event(0, "0:00:00.00", "0:00:01.00", "Default", "", "同"), event(0, "0:00:01.00", "0:00:02.00", "Default", "", "同")].join("\n");
    const document = readAssDocument(text);
    expect(document.cues).toHaveLength(2);
    expect(document.rebuiltFromSlices).toBeUndefined();
  });

  it("reads an unclosed brace as text and \\h as a space", () => {
    const text = [HEADER, event(0, "0:00:00.00", "0:00:01.00", "Default", "", "a{b\\hc")].join("\n");
    expect(readAssDocument(text).cues[0]?.lines).toEqual(["a{b c"]);
  });
});

/** Runs `work` and returns its result, failing when it takes longer than the budget. */
function within<T>(budgetMs: number, work: () => T): T {
  const started = performance.now();
  const result = work();
  expect(performance.now() - started).toBeLessThan(budgetMs);
  return result;
}

describe("hostile ASS", () => {
  const styled = (...texts: Array<[string, string, string]>): string =>
    [
      "[V4+ Styles]",
      "Format: Name",
      "Style: Default",
      "Style: Translation",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...texts.map(([start, end, text]) => event(1, start, end, "Default", "", `{\\an2\\pos(1,1)}${text}`)),
    ].join("\n");

  it("splits a slice of many joined lines without deep recursion or copies", () => {
    const text = styled(["0:00:00.00", "0:00:01.00", "a"], ["0:00:01.00", "0:00:02.00", Array.from({ length: 200 }, () => "a").join("\\N")]);
    const document = within(3000, () => readAssDocument(text));
    expect(document.cues).toHaveLength(200);
    expect(document.cues[0]).toMatchObject({ startMs: 0, endMs: 2000, lines: ["a"] });
  });

  it("keeps a run far longer than any export writes as one sentence", () => {
    for (const count of [20_000, 100_000]) {
      const text = styled(["0:00:00.00", "0:00:01.00", "a"], ["0:00:01.00", "0:00:02.00", Array.from({ length: count }, () => "a").join("\\N")]);
      const document = within(3000, () => readAssDocument(text));
      expect(document.cues.map((cue) => [cue.startMs, cue.endMs, cue.lines[0]?.length])).toEqual([
        [0, 1000, 1],
        [1000, 2000, 2 * count - 1],
      ]);
    }
  });

  it("stops splitting past its work budget and keeps the rest whole", () => {
    // Pairs of slices: one line `wK`, then the same line joined 200 times, each pair distinct.
    const pairs = 600;
    const lines = 200;
    const stamp = (second: number): string => `0:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.00`;
    const slices = Array.from({ length: pairs }, (_, pair): Array<[string, string, string]> => [
      [stamp(2 * pair), stamp(2 * pair + 1), `w${pair}`],
      [stamp(2 * pair + 1), stamp(2 * pair + 2), Array.from({ length: lines }, () => `w${pair}`).join("\\N")],
    ]).flat();
    const document = within(3000, () => readAssDocument(styled(...slices)));
    // The first pairs are split into every line, the later ones stay two sentences each.
    expect(document.cues.slice(0, lines).every((cue) => cue.lines[0] === "w0")).toBe(true);
    expect(document.cues.at(-1)?.lines[0]?.startsWith(`w${pairs - 1} w${pairs - 1}`)).toBe(true);
    expect(document.cues.length).toBeGreaterThan(pairs * 2);
    expect(document.cues.length).toBeLessThan((pairs * lines) / 4);
  });

  it("reads braces that are never closed in linear time", () => {
    const braces = "{".repeat(200_000);
    const document = within(3000, () => readAssDocument([HEADER, event(0, "0:00:00.00", "0:00:01.00", "Default", "", `x${braces}y`)].join("\n")));
    expect(document.cues[0]?.lines).toEqual([`x${braces}y`]);
  });
});
