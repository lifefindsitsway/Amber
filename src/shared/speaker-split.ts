import { SPEAKER_SPLIT_MIN_MS } from "./defaults.ts";

/** Where a split point comes from: the recognizer's speaker change, the playhead, or a guess from the caret. */
export type SplitPointSource = "recognized" | "playhead" | "estimated";

export interface SplitPoint {
  atMs: number;
  source: SplitPointSource;
}

interface Timed {
  startMs: number;
  endMs: number;
}

/** A sentence can be split between two speakers only if both halves keep `SPEAKER_SPLIT_MIN_MS`. */
export function canSplit(sentence: Timed): boolean {
  return sentence.endMs - sentence.startMs >= 2 * SPEAKER_SPLIT_MIN_MS;
}

function strictlyInside(sentence: Timed, ms: number | undefined): ms is number {
  return ms !== undefined && ms > sentence.startMs && ms < sentence.endMs;
}

/**
 * The time to split a sentence between two speakers, by priority: the speaker change the
 * recognizer saw inside it, the current playback position, then an estimate from where the
 * caret stands in the text (`caretRatio`, 0..1, clamped). The first two count only when
 * strictly inside the sentence. Whatever is chosen is clamped so both halves keep
 * `SPEAKER_SPLIT_MIN_MS`; callers check `canSplit` first, and for a shorter sentence the
 * midpoint comes back.
 */
export function splitPoint(sentence: Timed, hints: { changeAtMs?: number; playheadMs?: number; caretRatio: number }): SplitPoint {
  let chosen: SplitPoint;
  if (strictlyInside(sentence, hints.changeAtMs)) {
    chosen = { atMs: hints.changeAtMs, source: "recognized" };
  } else if (strictlyInside(sentence, hints.playheadMs)) {
    chosen = { atMs: hints.playheadMs, source: "playhead" };
  } else {
    const ratio = Number.isFinite(hints.caretRatio) ? Math.min(1, Math.max(0, hints.caretRatio)) : 0.5;
    chosen = { atMs: sentence.startMs + (sentence.endMs - sentence.startMs) * ratio, source: "estimated" };
  }
  const low = sentence.startMs + SPEAKER_SPLIT_MIN_MS;
  const high = sentence.endMs - SPEAKER_SPLIT_MIN_MS;
  const atMs = low > high ? (sentence.startMs + sentence.endMs) / 2 : Math.min(high, Math.max(low, chosen.atMs));
  return { atMs: Math.round(atMs), source: chosen.source };
}
