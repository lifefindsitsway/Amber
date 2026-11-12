import { describe, expect, it } from "vitest";
import { SPEAKER_REVIEW_SAMPLES_PER_SPEAKER } from "../../../../../../src/shared/defaults.ts";
import { reviewSamples, type SampleSentence } from "../../../../../../src/web/pages/content/speakers/review/review-samples.ts";

/** Sentences laid end to end from `turns`: [speaker (undefined = unassigned), sentence lengths in seconds]. */
function transcript(turns: ReadonlyArray<[string | undefined, readonly number[]]>): SampleSentence[] {
  const sentences: SampleSentence[] = [];
  let at = 0;
  for (const [speakerId, lengths] of turns) {
    for (const seconds of lengths) {
      sentences.push({ id: `s${sentences.length}`, startMs: at, endMs: at + seconds * 1000, ...(speakerId === undefined ? {} : { speakerId }) });
      at += seconds * 1000;
    }
  }
  return sentences;
}

describe("reviewSamples", () => {
  it("lists speakers in order of first appearance and never samples unassigned sentences", () => {
    const samples = reviewSamples(transcript([[undefined, [3]], ["b", [2, 2]], ["a", [4]], [undefined, [5]], ["b", [3]]]));
    expect(samples.map((entry) => entry.speakerId)).toEqual(["b", "a"]);
    expect(samples.flatMap((entry) => entry.clips.map((clip) => clip.segmentId))).not.toContain("s0");
    expect(samples.flatMap((entry) => entry.clips.map((clip) => clip.segmentId))).not.toContain("s4");
  });

  it("gives a speaker with few sentences all of them, in time order", () => {
    const samples = reviewSamples(transcript([["a", [2, 3]], ["b", [1]], ["a", [4]]]));
    expect(samples[0]?.clips).toEqual([
      { segmentId: "s0", startMs: 0, endMs: 2_000 },
      { segmentId: "s1", startMs: 2_000, endMs: 5_000 },
      { segmentId: "s3", startMs: 6_000, endMs: 10_000 },
    ]);
  });

  it("takes the configured number per speaker, spread along the timeline, with the middle of the longest turn", () => {
    // Speaker a: ten short turns of 3 sentences around one long turn of 9 sentences in the middle.
    const turns: Array<[string, number[]]> = [];
    for (let index = 0; index < 10; index += 1) {
      turns.push(["a", [2, 2, 2]], ["b", [3]]);
      if (index === 4) turns.push(["a", [2, 2, 2, 2, 2, 2, 2, 2, 2]], ["b", [3]]);
    }
    const sentences = transcript(turns);
    const samples = reviewSamples(sentences);
    const clips = samples.find((entry) => entry.speakerId === "a")?.clips ?? [];
    expect(clips).toHaveLength(SPEAKER_REVIEW_SAMPLES_PER_SPEAKER);
    // In time order and all different.
    expect(clips.map((clip) => clip.startMs)).toEqual([...clips.map((clip) => clip.startMs)].sort((x, y) => x - y));
    expect(new Set(clips.map((clip) => clip.segmentId)).size).toBe(clips.length);
    // The fifth sentence of the long turn (the only run of nine) sits under its midpoint.
    const longStart = sentences.findIndex((_sentence, index) => sentences.slice(index, index + 9).filter((s) => s.speakerId === "a").length === 9);
    expect(clips.map((clip) => clip.segmentId)).toContain(sentences[longStart + 4]?.id);
    // One clip in each fifth of the speaker's span.
    const from = sentences.find((sentence) => sentence.speakerId === "a")?.startMs ?? 0;
    const to = [...sentences].reverse().find((sentence) => sentence.speakerId === "a")?.endMs ?? 0;
    const width = (to - from) / SPEAKER_REVIEW_SAMPLES_PER_SPEAKER;
    const stretches = clips.map((clip) => Math.min(SPEAKER_REVIEW_SAMPLES_PER_SPEAKER - 1, Math.floor(((clip.startMs + clip.endMs) / 2 - from) / width)));
    expect(new Set(stretches).size).toBe(SPEAKER_REVIEW_SAMPLES_PER_SPEAKER);
  });

  it("prefers a sentence inside a turn to one at a change of speaker, then the longer one", () => {
    // Two stretches, one turn each: each takes its turn's inner sentence over the ends.
    const sentences = transcript([["a", [1, 5, 1]], ["b", [2]], ["a", [1, 2, 1]]]);
    const [entry] = reviewSamples(sentences, 2);
    expect(entry?.clips.map((clip) => clip.segmentId)).toEqual(["s1", "s5"]);
  });

  it("fills a stretch where the speaker says nothing with the sentences farthest from the others", () => {
    // All of a's speech sits at both ends; the middle stretches are b's alone.
    const sentences = transcript([["a", [1, 1, 1, 1]], ["b", [60]], ["a", [1, 1, 1, 1]]]);
    const [entry] = reviewSamples(sentences, 4);
    expect(entry?.clips).toHaveLength(4);
    const ids = entry?.clips.map((clip) => clip.segmentId) ?? [];
    expect(ids.some((id) => ["s0", "s1", "s2", "s3"].includes(id))).toBe(true);
    expect(ids.some((id) => ["s5", "s6", "s7", "s8"].includes(id))).toBe(true);
  });

  it("is deterministic and copes with a zero count", () => {
    const sentences = transcript([["a", [2, 3, 1, 4, 2, 2, 5, 1]], ["b", [1]]]);
    expect(reviewSamples(sentences)).toEqual(reviewSamples(sentences));
    expect(reviewSamples(sentences, 0)[0]?.clips).toEqual([]);
  });
});
