import { SPEAKER_ALIGN_MIN_SHARE, SPEAKER_COMPARE_DURATION_TOLERANCE_MS } from "./defaults.ts";
import { alignSpeakers, type AlignSource, type AlignTarget } from "./speaker-align.ts";
import type { AttributionComparison, AttributionDifference, AttributionDifferenceKind, SpeakerCorrespondence } from "./speaker-compare.ts";

/** A sentence of the transcription being checked; `speakerId: null` = unassigned. */
export interface ComparedSentence extends AlignTarget {
  speakerId: string | null;
}

/** A sentence of the other transcription; `speakerId` is that transcription's own speaker. */
export type OtherSentence = AlignSource;

/**
 * Whether a revision's `generation` marks a transcription made only to compare speakers
 * with. The mark lives on the immutable revision, so it is known after the Task that made
 * the revision is gone.
 */
export function isComparisonGeneration(generation: object): boolean {
  const fields = generation as { kind?: unknown; purpose?: unknown };
  return fields.kind === "asr" && fields.purpose === "comparison";
}

interface Timed {
  startMs: number;
  endMs: number;
}

/** Usable sentences with a speaker, by start, each with the running maximum end for the sweep. */
function sweepable<T extends Timed>(items: readonly T[], speakerOf: (item: T) => string | null | undefined): { sorted: Array<T & { speaker: string }>; maxEnd: number[] } {
  const sorted = items
    .flatMap((item) => {
      const speaker = speakerOf(item);
      return speaker === null || speaker === undefined || item.endMs <= item.startMs ? [] : [{ ...item, speaker }];
    })
    .sort((a, b) => a.startMs - b.startMs);
  const maxEnd: number[] = [];
  let running = Number.NEGATIVE_INFINITY;
  for (const item of sorted) {
    running = Math.max(running, item.endMs);
    maxEnd.push(running);
  }
  return { sorted, maxEnd };
}

/**
 * Proposes who each speaker of the other transcription is in this one, by time overlap: the
 * time a source speaker's sentences overlap sentences of each speaker here is summed, and the
 * source speaker is `matched` to the one with the most when that holds at least
 * `SPEAKER_ALIGN_MIN_SHARE` of all its overlapped time. Several source speakers may be
 * matched to the same person (one model split someone into two labels). A source speaker
 * spread over several people without a clear majority is `unreliable` (its label probably
 * mixes people) and is not forced onto anybody; one that overlaps nobody is `unmatched`.
 * Speakers are listed in the order they first speak in the other transcription. Only times
 * and labels are read, never text.
 */
export function proposeCorrespondences(target: readonly ComparedSentence[], source: readonly OtherSentence[]): SpeakerCorrespondence[] {
  const targets = sweepable(target, (item) => item.speakerId);
  const sources = sweepable(source, (item) => item.speakerId);
  const overlap = new Map<string, Map<string, number>>();
  let low = 0;
  for (const item of sources.sorted) {
    let times = overlap.get(item.speaker);
    if (times === undefined) {
      times = new Map();
      overlap.set(item.speaker, times);
    }
    while (low < targets.sorted.length && (targets.maxEnd[low] as number) <= item.startMs) low += 1;
    for (let at = low; at < targets.sorted.length; at += 1) {
      const sentence = targets.sorted[at] as Timed & { speaker: string };
      if (sentence.startMs >= item.endMs) break;
      const shared = Math.min(sentence.endMs, item.endMs) - Math.max(sentence.startMs, item.startMs);
      if (shared > 0) times.set(sentence.speaker, (times.get(sentence.speaker) ?? 0) + shared);
    }
  }
  return Array.from(overlap, ([sourceId, times]): SpeakerCorrespondence => {
    let best: string | null = null;
    let bestMs = 0;
    let total = 0;
    for (const [targetId, ms] of times) {
      total += ms;
      if (ms > bestMs) {
        best = targetId;
        bestMs = ms;
      }
    }
    if (best === null || total === 0) return { sourceId, targetId: null, status: "unmatched", share: 0 };
    const share = bestMs / total;
    return share >= SPEAKER_ALIGN_MIN_SHARE ? { sourceId, targetId: best, status: "matched", share } : { sourceId, targetId: null, status: "unreliable", share };
  });
}

/**
 * The correspondences with the user's choices in: a chosen target (or `null` for nobody)
 * replaces the proposed one. The status keeps saying what the overlap suggested, so the
 * view can still show why a proposal was made or withheld.
 */
export function withOverrides(correspondences: readonly SpeakerCorrespondence[], overrides: ReadonlyMap<string, string | null>): SpeakerCorrespondence[] {
  return correspondences.map((item) => (overrides.has(item.sourceId) ? { ...item, targetId: overrides.get(item.sourceId) ?? null } : item));
}

// The identity a source speaker without a counterpart here stands for. Never a stored id (ids
// are ULIDs), so it cannot collide with a speaker of this transcription.
const UNMAPPED = "\u0000unmapped";

function lastEnd(items: readonly Timed[]): number | undefined {
  let end: number | undefined;
  for (const item of items) end = end === undefined ? item.endMs : Math.max(end, item.endMs);
  return end;
}

/**
 * Compares, sentence by sentence, whom this transcription and the other one give each sentence
 * to, through the correspondences (user choices included). Each sentence is attributed from
 * the other transcription with the same algorithm and thresholds as applying speakers from
 * one version to another (`alignSpeakers`): a clear attribution to a different person here is
 * `different`; one to a speaker that corresponds to nobody here is `unmapped`; overlap
 * without a clear majority, or no attributed speech over a sentence that has a speaker here,
 * is `undetermined`. Sentences on which both agree, and unassigned sentences the other
 * transcription is silent on, are not listed. Nothing is modified.
 *
 * Whether the result can be trusted is judged first and reported, not enforced: when the two
 * last sentences end more than `SPEAKER_COMPARE_DURATION_TOLERANCE_MS` apart, or the other
 * transcription overlaps too few sentences here, the timelines probably differ and the list is
 * flagged `unreliable`.
 */
export function compareAttribution(target: readonly ComparedSentence[], source: readonly OtherSentence[], correspondences: readonly SpeakerCorrespondence[]): AttributionComparison {
  const mapping = new Map<string, string | null>();
  for (const item of source) {
    if (item.speakerId !== undefined) mapping.set(item.speakerId, UNMAPPED);
  }
  for (const item of correspondences) {
    if (mapping.has(item.sourceId)) mapping.set(item.sourceId, item.targetId ?? UNMAPPED);
  }
  const aligned = alignSpeakers(target, source, mapping);
  const differences: AttributionDifference[] = [];
  const counts: Record<AttributionDifferenceKind, number> = { different: 0, undetermined: 0, unmapped: 0 };
  const add = (difference: AttributionDifference): void => {
    differences.push(difference);
    counts[difference.kind] += 1;
  };
  aligned.sentences.forEach((result, index) => {
    const sentence = target[index] as ComparedSentence;
    const base = { segmentId: sentence.id, speakerId: sentence.speakerId };
    if (result.review === "auto") {
      if (result.speakerId === UNMAPPED) add({ ...base, kind: "unmapped", otherSpeakerId: null });
      else if (result.speakerId !== sentence.speakerId) add({ ...base, kind: "different", otherSpeakerId: result.speakerId });
    } else if (result.review === "needs_review" || sentence.speakerId !== null) {
      add({ ...base, kind: "undetermined", otherSpeakerId: null });
    }
  });
  const ends = [lastEnd(target), lastEnd(source)];
  const apart = ends[0] === undefined || ends[1] === undefined || Math.abs(ends[0] - ends[1]) > SPEAKER_COMPARE_DURATION_TOLERANCE_MS;
  const attributed = source.some((item) => item.speakerId !== undefined);
  return {
    differences,
    counts,
    coverage: aligned.coverage,
    unreliable: target.length === 0 || !attributed || aligned.lowCoverage || apart,
  };
}
