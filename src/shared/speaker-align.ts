import { SPEAKER_ALIGN_MIN_COVERAGE, SPEAKER_ALIGN_MIN_SHARE } from "./defaults.ts";
import type { SpeakerReviewState } from "./speakers.ts";

/** A sentence of the version speakers are applied to. */
export interface AlignTarget {
  id: string;
  startMs: number;
  endMs: number;
}

/** A sentence of the version the speakers come from; `speakerId` is the label in that version. */
export interface AlignSource {
  startMs: number;
  endMs: number;
  speakerId?: string;
}

export interface AlignedSentence {
  id: string;
  /** The target identity, or `null` when nobody was matched. */
  speakerId: string | null;
  /** `auto` = matched without review, `needs_review` = overlapped but not clearly; absent = unassigned. */
  review?: SpeakerReviewState;
  /** For `needs_review`: where the source's speaker changes inside the sentence, the natural split point. */
  changeAtMs?: number;
}

export interface AlignResult {
  /** In the order of the input targets. */
  sentences: AlignedSentence[];
  auto: number;
  needsReview: number;
  unassigned: number;
  /** Share of target sentences that overlap any source sentence with a speaker, 0..1. */
  coverage: number;
  /** The two timelines probably do not describe the same audio. */
  lowCoverage: boolean;
}

interface Piece {
  key: string | null;
  startMs: number;
  endMs: number;
}

/**
 * Applies the speakers of one version to the sentences of another by time overlap. Each
 * source speaker label is mapped to a target identity (`null` or a missing entry = no
 * identity; labels mapped to the same identity count together). For a target sentence the
 * overlapped time is summed per identity: when the top one covers at least
 * `SPEAKER_ALIGN_MIN_SHARE` of all overlapped time the sentence is `auto`, when there is
 * overlap but no clear top it is `needs_review` with the source's change point, and
 * without overlap it is unassigned. A top that maps to no identity leaves the sentence
 * unassigned too. Sources without a speaker take no part, so a stretch the recognizer left
 * unattributed does not count as covered.
 *
 * Both lists are swept in start order with the source's running maximum end, so typical
 * input costs a sort plus a pass; the inputs need not be sorted and are not modified.
 */
export function alignSpeakers(target: readonly AlignTarget[], source: readonly AlignSource[], mapping: ReadonlyMap<string, string | null>): AlignResult {
  const sources = source
    .filter((item): item is AlignSource & { speakerId: string } => item.speakerId !== undefined && item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const maxEnd: number[] = [];
  let running = Number.NEGATIVE_INFINITY;
  for (const item of sources) {
    running = Math.max(running, item.endMs);
    maxEnd.push(running);
  }
  const order = target.map((_, index) => index).sort((a, b) => (target[a] as AlignTarget).startMs - (target[b] as AlignTarget).startMs);
  const sentences: AlignedSentence[] = new Array<AlignedSentence>(target.length);
  let auto = 0;
  let needsReview = 0;
  let covered = 0;
  let low = 0;
  for (const index of order) {
    const sentence = target[index] as AlignTarget;
    while (low < sources.length && (maxEnd[low] as number) <= sentence.startMs) low += 1;
    const pieces: Piece[] = [];
    for (let at = low; at < sources.length && (sources[at] as AlignSource).startMs < sentence.endMs; at += 1) {
      const item = sources[at] as AlignSource & { speakerId: string };
      const startMs = Math.max(item.startMs, sentence.startMs);
      const endMs = Math.min(item.endMs, sentence.endMs);
      if (endMs > startMs) pieces.push({ key: mapping.get(item.speakerId) ?? null, startMs, endMs });
    }
    if (pieces.length === 0) {
      sentences[index] = { id: sentence.id, speakerId: null };
      continue;
    }
    covered += 1;
    const time = new Map<string | null, number>();
    let total = 0;
    for (const piece of pieces) {
      time.set(piece.key, (time.get(piece.key) ?? 0) + (piece.endMs - piece.startMs));
      total += piece.endMs - piece.startMs;
    }
    let top: string | null = null;
    let topTime = -1;
    for (const [key, ms] of time) {
      if (ms > topTime) {
        top = key;
        topTime = ms;
      }
    }
    if (topTime / total >= SPEAKER_ALIGN_MIN_SHARE) {
      if (top === null) {
        sentences[index] = { id: sentence.id, speakerId: null };
      } else {
        auto += 1;
        sentences[index] = { id: sentence.id, speakerId: top, review: "auto" };
      }
      continue;
    }
    needsReview += 1;
    const change = changePoint(pieces, sentence);
    // The suggestion a user may accept as is: the identity heard longest, never "nobody"
    // just because unmatched source speakers together outweigh it.
    let suggested: string | null = null;
    let suggestedTime = -1;
    for (const [key, ms] of time) {
      if (key !== null && ms > suggestedTime) {
        suggested = key;
        suggestedTime = ms;
      }
    }
    sentences[index] = { id: sentence.id, speakerId: suggested, review: "needs_review", ...(change === undefined ? {} : { changeAtMs: change }) };
  }
  const coverage = target.length === 0 ? 0 : covered / target.length;
  return {
    sentences,
    auto,
    needsReview,
    unassigned: target.length - auto - needsReview,
    coverage,
    lowCoverage: target.length > 0 && coverage < SPEAKER_ALIGN_MIN_COVERAGE,
  };
}

/** The first point inside the sentence where the source passes from one identity to another. */
function changePoint(pieces: readonly Piece[], sentence: AlignTarget): number | undefined {
  for (let index = 1; index < pieces.length; index += 1) {
    const before = pieces[index - 1] as Piece;
    const after = pieces[index] as Piece;
    if (before.key === after.key) continue;
    // The next speaker's start; when that lies on the sentence's edge, where the previous one stopped.
    if (after.startMs > sentence.startMs && after.startMs < sentence.endMs) return after.startMs;
    if (before.endMs > sentence.startMs && before.endMs < sentence.endMs) return before.endMs;
  }
  return undefined;
}
