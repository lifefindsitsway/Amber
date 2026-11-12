import { SPEAKER_REVIEW_SAMPLES_PER_SPEAKER } from "../../../../../shared/defaults.ts";

/** What sampling needs of a sentence; sentences come in reading (`ordinal`) order. */
export interface SampleSentence {
  id: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
}

/** One clip to listen to: a whole sentence of the speaker. */
export interface SampleClip {
  segmentId: string;
  startMs: number;
  endMs: number;
}

/** A speaker's clips, in time order. */
export interface SpeakerSamples {
  speakerId: string;
  clips: SampleClip[];
}

interface Candidate {
  sentence: SampleSentence;
  /** Neither the first nor the last sentence of a turn of several: the least likely to be mis-cut at a change of speaker. */
  inner: boolean;
}

const durationOf = (sentence: SampleSentence): number => sentence.endMs - sentence.startMs;
const midpointOf = (sentence: SampleSentence): number => (sentence.startMs + sentence.endMs) / 2;

/**
 * Clips for checking by ear who says what: per speaker, `perSpeaker` sentences spread along
 * the timeline, one of them from the middle of the speaker's longest turn — the stretch most
 * surely theirs, to compare the others against.
 *
 * The speaker's span (first sentence to last) is cut into `perSpeaker` equal stretches; the
 * stretch holding the middle of the longest turn takes that sentence, every other stretch
 * its best sentence: one inside a turn rather than at a change of speaker, then the longest,
 * then the one nearest the stretch's centre. A stretch where the speaker says nothing is made
 * up from the sentences farthest from those already chosen. A speaker with no more sentences
 * than that gets all of them. Deterministic: the same sentences give the same clips.
 * Speakers are listed in order of first appearance; unassigned sentences are never sampled.
 */
export function reviewSamples(sentences: readonly SampleSentence[], perSpeaker: number = SPEAKER_REVIEW_SAMPLES_PER_SPEAKER): SpeakerSamples[] {
  const bySpeaker = new Map<string, Candidate[]>();
  const longestTurn = new Map<string, SampleSentence[]>();
  let turn: SampleSentence[] = [];
  const closeTurn = (): void => {
    const speakerId = turn[0]?.speakerId;
    if (speakerId !== undefined) {
      turn.forEach((sentence, index) => {
        const inner = turn.length > 2 && index > 0 && index < turn.length - 1;
        let list = bySpeaker.get(speakerId);
        if (list === undefined) {
          list = [];
          bySpeaker.set(speakerId, list);
        }
        list.push({ sentence, inner });
      });
      const best = longestTurn.get(speakerId);
      if (best === undefined || turnDuration(turn) > turnDuration(best)) longestTurn.set(speakerId, turn);
    }
    turn = [];
  };
  for (const sentence of sentences) {
    if (turn.length > 0 && turn[0]?.speakerId !== sentence.speakerId) closeTurn();
    turn.push(sentence);
  }
  closeTurn();

  return [...bySpeaker].map(([speakerId, candidates]) => ({
    speakerId,
    clips: pick(candidates, middleOf(longestTurn.get(speakerId) ?? []), perSpeaker).map(({ sentence }) => ({ segmentId: sentence.id, startMs: sentence.startMs, endMs: sentence.endMs })),
  }));
}

function turnDuration(turn: readonly SampleSentence[]): number {
  const first = turn[0];
  const last = turn[turn.length - 1];
  return first === undefined || last === undefined ? 0 : last.endMs - first.startMs;
}

/** The sentence of a turn under its midpoint in time, else the one closest to it. */
function middleOf(turn: readonly SampleSentence[]): SampleSentence | undefined {
  const first = turn[0];
  const last = turn[turn.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const middle = (first.startMs + last.endMs) / 2;
  let best = first;
  for (const sentence of turn) {
    if (distanceTo(sentence, middle) < distanceTo(best, middle)) best = sentence;
  }
  return best;
}

/** 0 inside the sentence, else how far its nearer end is. */
function distanceTo(sentence: SampleSentence, ms: number): number {
  if (ms < sentence.startMs) return sentence.startMs - ms;
  if (ms > sentence.endMs) return ms - sentence.endMs;
  return 0;
}

function pick(candidates: readonly Candidate[], anchor: SampleSentence | undefined, count: number): Candidate[] {
  if (candidates.length <= count) return [...candidates];
  if (count <= 0) return [];
  const from = candidates[0]?.sentence.startMs ?? 0;
  const to = candidates[candidates.length - 1]?.sentence.endMs ?? from;
  const width = Math.max(1, to - from) / count;
  const stretchOf = (sentence: SampleSentence): number => Math.min(count - 1, Math.max(0, Math.floor((midpointOf(sentence) - from) / width)));

  const chosen = new Set<Candidate>();
  const anchorCandidate = candidates.find((candidate) => candidate.sentence === anchor);
  const anchorStretch = anchorCandidate === undefined ? undefined : stretchOf(anchorCandidate.sentence);
  if (anchorCandidate !== undefined) chosen.add(anchorCandidate);
  for (let stretch = 0; stretch < count; stretch += 1) {
    if (stretch === anchorStretch) continue;
    const centre = from + (stretch + 0.5) * width;
    let best: Candidate | undefined;
    for (const candidate of candidates) {
      if (chosen.has(candidate) || stretchOf(candidate.sentence) !== stretch) continue;
      if (best === undefined || better(candidate, best, centre)) best = candidate;
    }
    if (best !== undefined) chosen.add(best);
  }
  // Stretches with nothing to offer: the sentences farthest from every clip so far.
  while (chosen.size < count) {
    let best: Candidate | undefined;
    let bestGap = -1;
    for (const candidate of candidates) {
      if (chosen.has(candidate)) continue;
      const gap = Math.min(...[...chosen].map((other) => Math.abs(midpointOf(other.sentence) - midpointOf(candidate.sentence))));
      if (gap > bestGap) {
        best = candidate;
        bestGap = gap;
      }
    }
    if (best === undefined) break;
    chosen.add(best);
  }
  return candidates.filter((candidate) => chosen.has(candidate));
}

function better(candidate: Candidate, current: Candidate, centre: number): boolean {
  if (candidate.inner !== current.inner) return candidate.inner;
  const length = durationOf(candidate.sentence) - durationOf(current.sentence);
  if (length !== 0) return length > 0;
  return Math.abs(midpointOf(candidate.sentence) - centre) < Math.abs(midpointOf(current.sentence) - centre);
}
