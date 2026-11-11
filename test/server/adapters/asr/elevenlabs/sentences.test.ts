import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENTENCE_PARAMS,
  mergeSentences,
  resolveSpeakers,
  sentenceParamsFor,
  unitsOf,
  ZH_SENTENCE_PARAMS,
  type MergeWord,
  type SentenceParams,
} from "../../../../../src/server/adapters/asr/elevenlabs/sentences.ts";
import goldenRandom from "../../../../fixtures/asr/elevenlabs-merge-random-golden.json" with { type: "json" };
import { pseudoRandomWords } from "../../../../fixtures/asr/merge-words.ts";
import { createHash } from "node:crypto";

/** Words spaced `stepMs` apart, each `lengthMs` long, starting at `startMs`. */
function words(texts: readonly string[], options: { startMs?: number; stepMs?: number; lengthMs?: number; spaced?: boolean } = {}): MergeWord[] {
  const { startMs = 0, stepMs = 300, lengthMs = 250, spaced = true } = options;
  return texts.map((text, index) => ({
    text,
    startMs: startMs + index * stepMs,
    endMs: startMs + index * stepMs + lengthMs,
    spaceBefore: spaced && index > 0,
  }));
}

describe("sentence parameters", () => {
  it("stay inside the fixed ranges: pause 300–1500 ms, duration 15–60 s, 20–80 characters or 15–60 words", () => {
    for (const params of [ZH_SENTENCE_PARAMS, DEFAULT_SENTENCE_PARAMS]) {
      expect(params.pauseMs).toBeGreaterThanOrEqual(300);
      expect(params.pauseMs).toBeLessThanOrEqual(1500);
      expect(params.maxDurationMs).toBeGreaterThanOrEqual(15_000);
      expect(params.maxDurationMs).toBeLessThanOrEqual(60_000);
    }
    expect(ZH_SENTENCE_PARAMS.unit).toBe("chars");
    expect(ZH_SENTENCE_PARAMS.maxUnits).toBeGreaterThanOrEqual(20);
    expect(ZH_SENTENCE_PARAMS.maxUnits).toBeLessThanOrEqual(80);
    expect(DEFAULT_SENTENCE_PARAMS.unit).toBe("words");
    expect(DEFAULT_SENTENCE_PARAMS.maxUnits).toBeGreaterThanOrEqual(15);
    expect(DEFAULT_SENTENCE_PARAMS.maxUnits).toBeLessThanOrEqual(60);
  });

  it("are chosen by the main language only: Chinese gets its own set, everything else the default", () => {
    expect(sentenceParamsFor("zh")).toBe(ZH_SENTENCE_PARAMS);
    expect(sentenceParamsFor("zh-Hans-CN")).toBe(ZH_SENTENCE_PARAMS);
    for (const language of ["en", "en-US", "ja", "und", "yue"]) {
      expect(sentenceParamsFor(language)).toBe(DEFAULT_SENTENCE_PARAMS);
    }
  });

  it("count Chinese by characters (a Latin word inside as one) and others by words", () => {
    expect(unitsOf("生成式", ZH_SENTENCE_PARAMS)).toBe(3);
    expect(unitsOf("代码。", ZH_SENTENCE_PARAMS)).toBe(2);
    expect(unitsOf("Claude", ZH_SENTENCE_PARAMS)).toBe(1);
    expect(unitsOf("，", ZH_SENTENCE_PARAMS)).toBe(0);
    expect(unitsOf("specification", DEFAULT_SENTENCE_PARAMS)).toBe(1);
    expect(unitsOf("—", DEFAULT_SENTENCE_PARAMS)).toBe(0);
  });
});

describe("mergeSentences", () => {
  const params: SentenceParams = { name: "default", pauseMs: 800, maxDurationMs: 20_000, maxUnits: 6, unit: "words" };

  it("ends a sentence at sentence-final punctuation first", () => {
    const result = mergeSentences(words(["One", "two.", "Three", "four?", "Five!"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["One two.", "Three four?", "Five!"]);
  });

  it("does not end at a lone full stop followed by a lowercase word in spaced text", () => {
    const result = mergeSentences(words(["Use", "e.g.", "this.", "Next"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["Use e.g. this.", "Next"]);
  });

  it("ends a sentence at a pause of at least pauseMs when there is no punctuation", () => {
    const first = words(["so", "that", "is", "it"]);
    const second = words(["and", "then"], { startMs: (first.at(-1) as MergeWord).endMs + 800 });
    const result = mergeSentences([...first, ...second], params);
    expect(result.map((sentence) => sentence.text)).toEqual(["so that is it", "and then"]);
    const shorter = words(["and", "then"], { startMs: (first.at(-1) as MergeWord).endMs + 799 });
    expect(mergeSentences([...first, ...shorter], params)).toHaveLength(1);
  });

  it("cuts a sentence that would outgrow the unit limit at its last clause punctuation", () => {
    const result = mergeSentences(words(["a", "b,", "c", "d", "e", "f", "g", "h"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["a b,", "c d e f g h"]);
  });

  it("cuts right before the overflowing word when there is no clause punctuation", () => {
    const result = mergeSentences(words(["a", "b", "c", "d", "e", "f", "g", "h"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["a b c d e f", "g h"]);
  });

  it("cuts a sentence that would outgrow the duration limit", () => {
    const slow = mergeSentences(words(["a", "b", "c", "d"], { stepMs: 8_000, lengthMs: 7_500 }), { ...params, pauseMs: 1_500 });
    expect(slow.map((sentence) => sentence.text)).toEqual(["a b", "c d"]);
  });

  it("joins Chinese words without spaces and Latin words with the spacing the service gave", () => {
    const tokens: MergeWord[] = [
      { text: "我们", startMs: 0, endMs: 400, spaceBefore: false },
      { text: "用", startMs: 450, endMs: 600, spaceBefore: false },
      { text: "Claude", startMs: 650, endMs: 900, spaceBefore: true },
      { text: "来", startMs: 950, endMs: 1100, spaceBefore: true },
      { text: "写。", startMs: 1150, endMs: 1400, spaceBefore: false },
    ];
    expect(mergeSentences(tokens, ZH_SENTENCE_PARAMS)).toEqual([{ startMs: 0, endMs: 1400, text: "我们用 Claude 来写。" }]);
  });

  it("keeps every sentence ordered, non-overlapping and longer than zero", () => {
    const tokens: MergeWord[] = [
      { text: "A.", startMs: 100, endMs: 100, spaceBefore: false },
      { text: "B.", startMs: 90, endMs: 300, spaceBefore: true },
      { text: "C.", startMs: 300, endMs: 300, spaceBefore: true },
    ];
    const result = mergeSentences(tokens, params);
    expect(result).toEqual([
      { startMs: 100, endMs: 101, text: "A." },
      { startMs: 101, endMs: 300, text: "B." },
      { startMs: 300, endMs: 301, text: "C." },
    ]);
  });

  it("carries the speaker of the sentence's first word and returns nothing for no words", () => {
    const tokens = words(["Hi."]).map((word) => ({ ...word, speakerId: "speaker_0" }));
    expect(mergeSentences(tokens, params)[0]?.speakerId).toBe("speaker_0");
    expect(mergeSentences([], params)).toEqual([]);
  });

  it("gives the same output for the same input", () => {
    const tokens = words(["a", "b,", "c", "d.", "e", "f", "g", "h", "i", "j", "k"]);
    expect(JSON.stringify(mergeSentences(tokens, params))).toBe(JSON.stringify(mergeSentences(tokens, params)));
  });
});

/** Words of one speaker, in the same layout as `words`; no label when `speakerId` is undefined. */
function said(speakerId: string | undefined, texts: readonly string[], options: { startMs?: number; stepMs?: number; lengthMs?: number } = {}): MergeWord[] {
  return words(texts, options).map((word) => (speakerId === undefined ? word : { ...word, speakerId }));
}

describe("mergeSentences without speakers (as before speaker identification)", () => {
  it("is unchanged on a stream of words with pauses, overlaps and every kind of ending", () => {
    // The digests were taken from the merge as it was before speakers were handled.
    for (const [key, digest] of Object.entries(goldenRandom)) {
      const [seed, name] = key.split("-") as [string, "zh" | "default"];
      const params = name === "zh" ? ZH_SENTENCE_PARAMS : DEFAULT_SENTENCE_PARAMS;
      const output = JSON.stringify(mergeSentences(pseudoRandomWords(Number(seed), 400), params));
      expect(createHash("sha256").update(output).digest("hex"), key).toBe(digest);
    }
  });
});

describe("mergeSentences with speakers", () => {
  const params: SentenceParams = { name: "default", pauseMs: 800, maxDurationMs: 20_000, maxUnits: 35, unit: "words" };

  it("breaks a sentence where the speaker changes, even without punctuation or a pause", () => {
    const tokens = [...said("speaker_0", ["so", "we", "start"]), ...said("speaker_1", ["yes", "go", "on"], { startMs: 900 })];
    const result = mergeSentences(tokens, params);
    expect(result.map((sentence) => [sentence.speakerId, sentence.text])).toEqual([
      ["speaker_0", "so we start"],
      ["speaker_1", "yes go on"],
    ]);
  });

  it("keeps a two-word interjection as its own sentence and returns to the first speaker", () => {
    const tokens = [
      ...said("speaker_0", ["I", "think", "that", "we"], { startMs: 0 }),
      ...said("speaker_1", ["Right", "yes"], { startMs: 1200 }),
      ...said("speaker_0", ["should", "go", "now"], { startMs: 1800 }),
    ];
    const result = mergeSentences(tokens, params);
    expect(result.map((sentence) => [sentence.speakerId, sentence.text])).toEqual([
      ["speaker_0", "I think that we"],
      ["speaker_1", "Right yes"],
      ["speaker_0", "should go now"],
    ]);
  });

  it("keeps the real start of a sentence that begins while another speaker is still talking", () => {
    const first = said("speaker_0", ["we", "were", "saying", "that."], { startMs: 0, stepMs: 500, lengthMs: 450 });
    const interjection = said("speaker_1", ["Sure."], { startMs: 1000, lengthMs: 400 });
    const result = mergeSentences([first[0], first[1], first[2], interjection[0], first[3]] as MergeWord[], params);
    // Words arrive in start order; the interjection starts inside the first speaker's run.
    const spoken = result.find((sentence) => sentence.speakerId === "speaker_1");
    expect(spoken).toMatchObject({ startMs: 1000, text: "Sure." });
    const before = result.find((sentence) => sentence.speakerId === "speaker_0");
    expect(before?.startMs).toBe(0);
  });

  it("still clips a sentence to the previous end of the same speaker, across another speaker's sentence", () => {
    const tokens: MergeWord[] = [
      { text: "A.", startMs: 0, endMs: 1000, spaceBefore: false, speakerId: "s0" },
      { text: "B.", startMs: 200, endMs: 600, spaceBefore: true, speakerId: "s1" },
      { text: "C.", startMs: 800, endMs: 1500, spaceBefore: true, speakerId: "s0" },
    ];
    expect(mergeSentences(tokens, params)).toEqual([
      { startMs: 0, endMs: 1000, text: "A.", speakerId: "s0" },
      { startMs: 200, endMs: 600, text: "B.", speakerId: "s1" },
      // Same speaker as the first sentence: it starts no earlier than that one ended.
      { startMs: 1000, endMs: 1500, text: "C.", speakerId: "s0" },
    ]);
  });

  it("breaks at known to unknown switches in both directions", () => {
    const tokens = [
      ...said("speaker_0", ["yes", "we"], { startMs: 0 }),
      ...said(undefined, ["can", "do"], { startMs: 1900 }),
      ...said("speaker_0", ["it", "later"], { startMs: 3800 }),
    ];
    expect(mergeSentences(tokens, params).map((sentence) => [sentence.speakerId, sentence.text])).toEqual([
      ["speaker_0", "yes we"],
      [undefined, "can do"],
      ["speaker_0", "it later"],
    ]);
  });

  it("splits sentences with no punctuation only at speaker changes and pauses, not otherwise", () => {
    const tokens = [...said("a", ["one", "two", "three", "four"]), ...said("b", ["five", "six"], { startMs: 1200 })];
    expect(mergeSentences(tokens, params).map((sentence) => sentence.text)).toEqual(["one two three four", "five six"]);
  });

  it("clips overlapping words of one speaker as before", () => {
    const tokens: MergeWord[] = [
      { text: "A.", startMs: 100, endMs: 100, spaceBefore: false, speakerId: "s0" },
      { text: "B.", startMs: 90, endMs: 300, spaceBefore: true, speakerId: "s0" },
    ];
    expect(mergeSentences(tokens, params)).toEqual([
      { startMs: 100, endMs: 101, text: "A.", speakerId: "s0" },
      { startMs: 101, endMs: 300, text: "B.", speakerId: "s0" },
    ]);
  });
});

describe("resolveSpeakers", () => {
  const pause = { pauseMs: 800 };

  it("returns the words untouched when none has a speaker", () => {
    const tokens = words(["a", "b", "c"]);
    expect(resolveSpeakers(tokens, pause)).toBe(tokens);
  });

  it("keeps a word's own speaker", () => {
    const tokens = [...said("a", ["x"]), ...said("b", ["y"], { startMs: 300 })];
    expect(resolveSpeakers(tokens, pause).map((word) => word.speakerId)).toEqual(["a", "b"]);
  });

  it("lets a word without a speaker inherit it when the nearest known words on both sides agree and are close", () => {
    const tokens = [...said("a", ["x"]), ...said(undefined, ["gap"], { startMs: 300 }), ...said("a", ["y"], { startMs: 600 })];
    expect(resolveSpeakers(tokens, pause).map((word) => word.speakerId)).toEqual(["a", "a", "a"]);
  });

  it("bridges several unknown words in a row", () => {
    const tokens = [
      ...said("a", ["x"]),
      ...said(undefined, ["m1", "m2"], { startMs: 300 }),
      ...said("a", ["y"], { startMs: 900 }),
    ];
    expect(resolveSpeakers(tokens, pause).map((word) => word.speakerId)).toEqual(["a", "a", "a", "a"]);
  });

  it("leaves the word unknown when its neighbours name different speakers", () => {
    const tokens = [...said("a", ["x"]), ...said(undefined, ["gap"], { startMs: 300 }), ...said("b", ["y"], { startMs: 600 })];
    expect(resolveSpeakers(tokens, pause).map((word) => word.speakerId)).toEqual(["a", undefined, "b"]);
  });

  it("leaves the word unknown when it comes first or last, with no known word on one side", () => {
    const tokens = [...said(undefined, ["lead"]), ...said("a", ["x"], { startMs: 300 }), ...said(undefined, ["tail"], { startMs: 600 })];
    expect(resolveSpeakers(tokens, pause).map((word) => word.speakerId)).toEqual([undefined, "a", undefined]);
  });

  it("leaves a word unknown after a long pause on either side, at exactly the threshold included", () => {
    const before = [...said("a", ["x"]), ...said(undefined, ["late"], { startMs: 250 + 800 }), ...said("a", ["y"], { startMs: 1500 })];
    expect(resolveSpeakers(before, pause).map((word) => word.speakerId)).toEqual(["a", undefined, "a"]);
    const after = [...said("a", ["x"]), ...said(undefined, ["early"], { startMs: 300 }), ...said("a", ["y"], { startMs: 300 + 250 + 800 })];
    expect(resolveSpeakers(after, pause).map((word) => word.speakerId)).toEqual(["a", undefined, "a"]);
    const near = [...said("a", ["x"]), ...said(undefined, ["ok"], { startMs: 250 + 799 }), ...said("a", ["y"], { startMs: 1800 })];
    expect(resolveSpeakers(near, pause)[1]?.speakerId).toBe("a");
  });

  it("measures the pause to a word that overlaps its neighbour as zero", () => {
    const tokens: MergeWord[] = [
      { text: "x", startMs: 0, endMs: 600, spaceBefore: false, speakerId: "a" },
      { text: "mid", startMs: 400, endMs: 700, spaceBefore: true },
      { text: "y", startMs: 650, endMs: 900, spaceBefore: true, speakerId: "a" },
    ];
    expect(resolveSpeakers(tokens, pause)[1]?.speakerId).toBe("a");
  });
});
