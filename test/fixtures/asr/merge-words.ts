import type { MergeWord } from "../../../src/server/adapters/asr/elevenlabs/sentences.ts";

/**
 * A deterministic word stream for merge regression tests: mixed punctuation, pauses, short
 * overlaps between neighbouring words and occasional long words, none of it carrying a speaker.
 */
export function pseudoRandomWords(seed: number, count: number): MergeWord[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const endings = ["", "", "", "", ",", ".", "?", "。", "，"];
  const words: MergeWord[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const gap = next() < 0.12 ? 700 + Math.floor(next() * 1200) : Math.floor(next() * 200);
    const startMs = Math.max(0, cursor + gap - (next() < 0.08 ? 400 : 0));
    const endMs = startMs + Math.floor(next() * 600);
    const stem = next() < 0.3 ? "字" : "word";
    words.push({ text: `${stem}${index}${endings[Math.floor(next() * endings.length)]}`, startMs, endMs, spaceBefore: next() < 0.8 });
    cursor = Math.max(cursor, endMs);
  }
  return words;
}
