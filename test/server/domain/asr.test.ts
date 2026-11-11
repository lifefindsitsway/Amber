import { describe, expect, it } from "vitest";
import { ASR_KEYTERMS_MAX } from "../../../src/shared/defaults.ts";
import { assignWordsAcrossSpeakers, assignWordsToSentences, parseAsrSubmitRecord, truncateTerminologyForAsr } from "../../../src/server/domain/asr.ts";
import { normalizeTermKey, type TerminologyEntry } from "../../../src/server/domain/terminology.ts";
import type { TranscriptWord } from "../../../src/server/domain/transcript.ts";

const entry = (ordinal: number, term: string): TerminologyEntry => ({
  id: `term-${ordinal}`,
  ordinal,
  term,
  normalizedKey: normalizeTermKey(term),
});

// The limits ElevenLabs declares in its speech-to-text documentation.
const ELEVENLABS_LIMITS = { maxTerminologyEntries: 1000, maxTerminologyTermChars: 49, maxTerminologyWords: 5 };

describe("truncateTerminologyForAsr", () => {
  it("gives byte-identical output for the same terminology", () => {
    const entries = Array.from({ length: 1500 }, (_, index) => entry(index, `term ${index}`));
    const first = JSON.stringify(truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX));
    const second = JSON.stringify(truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX));
    expect(second).toBe(first);
  });

  it("keeps at most the smaller of the named limit and the provider's entry limit, in order", () => {
    const entries = Array.from({ length: 1500 }, (_, index) => entry(index, `term ${index}`));
    const truncated = truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX);
    expect(truncated.entries).toHaveLength(Math.min(ASR_KEYTERMS_MAX, ELEVENLABS_LIMITS.maxTerminologyEntries));
    expect(truncated.entries).toEqual(entries.slice(0, truncated.entries.length));
    expect(truncated).toMatchObject({ droppedTooLong: 0, cutOff: 1500 - truncated.entries.length });

    const tighter = truncateTerminologyForAsr(entries, { ...ELEVENLABS_LIMITS, maxTerminologyEntries: 3 }, ASR_KEYTERMS_MAX);
    expect(tighter.entries.map((kept) => kept.term)).toEqual(["term 0", "term 1", "term 2"]);
    expect(truncateTerminologyForAsr(entries, {}, 2).entries).toHaveLength(2);
  });

  it("drops terms over the character or word limit and blank terms, counting them", () => {
    const entries = [
      entry(0, "生成式软件工程"),
      entry(1, "x".repeat(49)),
      entry(2, "x".repeat(50)),
      entry(3, "one two three four five"),
      entry(4, "one two three four five six"),
      entry(5, "   "),
      entry(6, "Claude Opus 4.5"),
    ];
    const truncated = truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX);
    expect(truncated.entries.map((kept) => kept.ordinal)).toEqual([0, 1, 3, 6]);
    expect(truncated).toMatchObject({ droppedTooLong: 3, cutOff: 0 });
  });

  it("counts characters by code point, not UTF-16 unit", () => {
    const astral = "𝔸".repeat(49);
    expect(truncateTerminologyForAsr([entry(0, astral)], ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX).entries).toHaveLength(1);
  });

  it("drops dropped-for-length terms before applying the entry limit", () => {
    const entries = [entry(0, "x".repeat(60)), entry(1, "a"), entry(2, "b"), entry(3, "c")];
    const truncated = truncateTerminologyForAsr(entries, { ...ELEVENLABS_LIMITS, maxTerminologyEntries: 2 }, ASR_KEYTERMS_MAX);
    expect(truncated.entries.map((kept) => kept.term)).toEqual(["a", "b"]);
    expect(truncated).toMatchObject({ droppedTooLong: 1, cutOff: 1 });
  });
});

describe("assignWordsToSentences", () => {
  const word = (text: string, startMs: number, endMs: number): TranscriptWord => ({ text, startMs, endMs });
  // Two sentences with a gap between 1000 and 2000.
  const sentences = [
    { startMs: 0, endMs: 1000 },
    { startMs: 2000, endMs: 3000 },
  ];
  const texts = (assigned: TranscriptWord[][]): string[][] => assigned.map((words) => words.map((assignedWord) => assignedWord.text));

  it("puts a word in the sentence containing its midpoint", () => {
    // Starts in the first sentence but its midpoint (2100) lies in the second.
    expect(texts(assignWordsToSentences(sentences, [word("a", 100, 400), word("b", 900, 3300)]))).toEqual([["a"], ["b"]]);
  });

  it("uses startMs as the midpoint of a zero-length word", () => {
    expect(texts(assignWordsToSentences(sentences, [word("z", 2500, 2500)]))).toEqual([[], ["z"]]);
  });

  it("treats sentence spans as right-open", () => {
    // Midpoint exactly 1000 belongs to [1000, 2000), not to [0, 1000).
    expect(texts(assignWordsToSentences([{ startMs: 0, endMs: 1000 }, { startMs: 1000, endMs: 2000 }], [word("edge", 1000, 1000)]))).toEqual([
      [],
      ["edge"],
    ]);
  });

  it("assigns a midpoint in a gap to the sentence with the nearer boundary, the earlier one on a tie", () => {
    const assigned = assignWordsToSentences(sentences, [word("near-first", 1200, 1200), word("near-second", 1800, 1800), word("tie", 1500, 1500)]);
    expect(texts(assigned)).toEqual([["near-first", "tie"], ["near-second"]]);
  });

  it("assigns words before the first sentence to it and after the last sentence to that one", () => {
    const shifted = [
      { startMs: 500, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ];
    expect(texts(assignWordsToSentences(shifted, [word("early", 0, 200), word("late", 3500, 4000)]))).toEqual([["early"], ["late"]]);
  });

  it("keeps input order within each sentence and returns an empty list per sentence without words", () => {
    expect(texts(assignWordsToSentences(sentences, [word("x", 10, 20), word("y", 30, 40)]))).toEqual([["x", "y"], []]);
    expect(assignWordsToSentences([], [word("w", 0, 10)])).toEqual([]);
  });
});

/** The assignment as it was before sentences could overlap: kept here as the reference for non-overlapping sentences. */
function legacyAssign(sentences: ReadonlyArray<{ startMs: number; endMs: number }>, words: readonly TranscriptWord[]): TranscriptWord[][] {
  const assigned: TranscriptWord[][] = sentences.map(() => []);
  const indexAt = (at: number): number => {
    let candidate = -1;
    for (let index = 0; index < sentences.length; index += 1) {
      if ((sentences[index] as { startMs: number }).startMs <= at) candidate = index;
    }
    if (candidate === -1) return 0;
    const current = sentences[candidate] as { startMs: number; endMs: number };
    const next = sentences[candidate + 1];
    if (at < current.endMs || next === undefined) return candidate;
    return next.startMs - at < at - current.endMs ? candidate + 1 : candidate;
  };
  if (sentences.length === 0) return assigned;
  for (const word of words) {
    const midpoint = word.endMs > word.startMs ? (word.startMs + word.endMs) / 2 : word.startMs;
    (assigned[indexAt(midpoint)] as TranscriptWord[]).push(word);
  }
  return assigned;
}

describe("assignWordsAcrossSpeakers", () => {
  const word = (text: string, startMs: number, endMs: number, speakerId?: string): TranscriptWord & { speakerId?: string } => ({
    text,
    startMs,
    endMs,
    ...(speakerId === undefined ? {} : { speakerId }),
  });
  const texts = (assigned: Array<Array<{ text: string }>>): string[][] => assigned.map((words) => words.map((assignedWord) => assignedWord.text));

  it("gives exactly the result of the plain assignment for sentences that do not overlap, whatever the words", () => {
    let state = 7;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    for (let round = 0; round < 40; round += 1) {
      const sentences: Array<{ startMs: number; endMs: number; speakerId?: string }> = [];
      let cursor = 0;
      for (let index = 0; index < 8; index += 1) {
        const startMs = cursor + Math.floor(next() * 400);
        const endMs = startMs + 100 + Math.floor(next() * 900);
        sentences.push({ startMs, endMs, ...(next() < 0.5 ? { speakerId: String(index % 3) } : {}) });
        cursor = endMs;
      }
      const words = Array.from({ length: 60 }, (_, index) => {
        const startMs = Math.floor(next() * (cursor + 500)) - (next() < 0.1 ? 200 : 0);
        const endMs = startMs + (next() < 0.1 ? 0 : Math.floor(next() * 300));
        return word(`w${index}`, startMs, endMs, next() < 0.5 ? String(index % 3) : undefined);
      });
      const expected = legacyAssign(sentences, words);
      const across = assignWordsAcrossSpeakers(sentences, words);
      expect(across.assigned).toEqual(expected);
      expect(across.dropped).toBe(0);
      expect(assignWordsToSentences(sentences, words)).toEqual(expected);
    }
  });

  it("gives a word whose midpoint lies in several sentences to the one of its own speaker", () => {
    const sentences = [
      { startMs: 0, endMs: 5000, speakerId: "0" },
      { startMs: 2000, endMs: 3000, speakerId: "1" },
    ];
    const result = assignWordsAcrossSpeakers(sentences, [word("a", 100, 300, "0"), word("yes", 2200, 2600, "1"), word("b", 2300, 2500, "0"), word("c", 4000, 4400, "0")]);
    expect(texts(result.assigned)).toEqual([["a", "b", "c"], ["yes"]]);
    expect(result.dropped).toBe(0);
  });

  it("drops a word in several sentences that has no speaker, a speaker none of them has, or matches more than one", () => {
    const sentences = [
      { startMs: 0, endMs: 5000, speakerId: "0" },
      { startMs: 2000, endMs: 3000, speakerId: "1" },
      { startMs: 2000, endMs: 4000, speakerId: "1" },
    ];
    const result = assignWordsAcrossSpeakers(sentences, [word("none", 2400, 2600), word("other", 2400, 2600, "9"), word("two", 2400, 2600, "1"), word("one", 2400, 2600, "0"), word("solo", 4500, 4600, "1")]);
    expect(texts(result.assigned)).toEqual([["one", "solo"], [], []]);
    expect(result.dropped).toBe(3);
  });

  it("assigns by midpoint in a gap or outside the sentences as the plain assignment does, with overlap elsewhere", () => {
    const sentences = [
      { startMs: 0, endMs: 1000, speakerId: "0" },
      { startMs: 500, endMs: 1500, speakerId: "1" },
      { startMs: 3000, endMs: 4000, speakerId: "0" },
    ];
    const result = assignWordsAcrossSpeakers(sentences, [word("gap-early", 1700, 1700), word("gap-late", 2800, 2800), word("after", 5000, 5100), word("tie", 2250, 2250)]);
    expect(texts(result.assigned)).toEqual([[], ["gap-early", "tie"], ["gap-late", "after"]]);
  });

  it("treats a zero-length word at an overlap by its start", () => {
    const sentences = [
      { startMs: 0, endMs: 2000, speakerId: "0" },
      { startMs: 1000, endMs: 3000, speakerId: "1" },
    ];
    const result = assignWordsAcrossSpeakers(sentences, [word("z", 1500, 1500, "1"), word("edge", 1000, 1000, "0")]);
    expect(texts(result.assigned)).toEqual([["edge"], ["z"]]);
  });
});

describe("parseAsrSubmitRecord", () => {
  const handle = { version: 1, provider: "p", jobId: "j", submittedAt: 5 } as const;

  it("reads the older record as the handle alone, without a decision", () => {
    expect(parseAsrSubmitRecord(handle)).toEqual({ handle });
  });

  it("reads a record with a usage row but no decision (made before decisions were kept)", () => {
    expect(parseAsrSubmitRecord({ handle, usageId: "u1" })).toEqual({ handle, usageId: "u1" });
  });

  it("reads and keeps the decision the job was submitted with", () => {
    expect(parseAsrSubmitRecord({ handle, usageId: "u1", diarization: { effective: true, speakerCount: 3 } })).toEqual({
      handle,
      usageId: "u1",
      diarization: { effective: true, speakerCount: 3 },
    });
    expect(parseAsrSubmitRecord({ handle, usageId: "u1", diarization: { effective: false, status: "over_recommended" } })?.diarization).toEqual({
      effective: false,
      status: "over_recommended",
    });
  });

  it("refuses a decision it does not know", () => {
    expect(parseAsrSubmitRecord({ handle, usageId: "u1", diarization: { effective: false, status: "applied" } })).toBeUndefined();
  });
});
