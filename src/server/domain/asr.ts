import { z } from "zod";
import { diarizationDecisionSchema, type DiarizationDecision } from "./asr-diarization.ts";
import type { TerminologyEntry } from "./terminology.ts";
import type { TranscriptWord } from "./transcript.ts";

/**
 * Invariant: the ASR boundary. Transcripts and everything
 * after them consume only this shape; provider response types stay inside their adapter.
 */
export interface CanonicalAsrResult {
  text: string;
  language: string;
  segments: Array<{ startMs: number; endMs: number; text: string; speakerId?: string }>;
  /**
   * A word's `speakerId` (the same label as the segments use) only helps assign the word to a
   * sentence where sentences of different speakers overlap; revisions do not store it.
   */
  words?: Array<TranscriptWord & { speakerId?: string }>;
  provider: string;
  model: string;
  /** File-backed raw response location; not stored in the database. */
  rawResponseRef?: string;
  durationMs: number;
}

/** Terminology limits an ASR provider declares in its `AsrProviderCapabilities`. */
export interface AsrTerminologyLimits {
  maxTerminologyEntries?: number;
  maxTerminologyTermChars?: number;
  maxTerminologyWords?: number;
}

export interface TruncatedTerminology {
  entries: TerminologyEntry[];
  /** Entries dropped because a single term exceeds the per-term character or word limit. */
  droppedTooLong: number;
  /** Valid entries cut off by the entry limit. */
  cutOff: number;
}

/**
 * The terminology actually sent to an ASR provider: terms over the
 * per-term limits are dropped, then the first `min(entryLimit, maxTerminologyEntries)` of
 * the rest are kept in the effective set's stable order. Deterministic for the same input,
 * so the result can be part of a WorkUnit's input digest. Callers report any loss.
 */
export function truncateTerminologyForAsr(
  entries: readonly TerminologyEntry[],
  limits: AsrTerminologyLimits,
  entryLimit: number,
): TruncatedTerminology {
  const fitting = entries.filter((entry) => termFits(entry.term, limits));
  const max = Math.min(entryLimit, limits.maxTerminologyEntries ?? entryLimit);
  const kept = fitting.slice(0, Math.max(0, max));
  return { entries: kept, droppedTooLong: entries.length - fitting.length, cutOff: fitting.length - kept.length };
}

function termFits(term: string, limits: AsrTerminologyLimits): boolean {
  const trimmed = term.trim();
  if (trimmed === "") {
    return false;
  }
  if (limits.maxTerminologyTermChars !== undefined && [...trimmed].length > limits.maxTerminologyTermChars) {
    return false;
  }
  return limits.maxTerminologyWords === undefined || trimmed.split(/\s+/u).length <= limits.maxTerminologyWords;
}

/** A sentence span for word assignment; `speakerId` is the label the provider used. */
export interface SentenceSpan {
  startMs: number;
  endMs: number;
  speakerId?: string;
}

/** A word to assign; `speakerId` is the provider's label for who said it. */
export type SpeakerWord = TranscriptWord & { speakerId?: string };

/**
 * Assigns each word to a sentence by its midpoint: `(startMs + endMs) / 2`,
 * or `startMs` for a zero-length word, falls in exactly one sentence's `[startMs, endMs)`;
 * a midpoint in a gap goes to the sentence with the nearer boundary (the earlier one on a
 * tie), one before the first or after the last sentence to that sentence. Sentences must
 * be ordered by start and must not overlap. Returns one word list per sentence, in input
 * order. Sentences of different speakers may overlap: use `assignWordsAcrossSpeakers`.
 */
export function assignWordsToSentences<W extends SpeakerWord>(sentences: ReadonlyArray<SentenceSpan>, words: readonly W[]): W[][] {
  return assignWordsAcrossSpeakers(sentences, words).assigned;
}

/**
 * `assignWordsToSentences` for sentences that may overlap (those of different speakers).
 * A midpoint inside exactly one sentence, or in none, is handled as there. A midpoint inside
 * several goes to the one sentence whose `speakerId` equals the word's; when none or more
 * than one does, the word cannot be placed and is dropped, which `dropped` counts. Sentences
 * must be ordered by start.
 */
export function assignWordsAcrossSpeakers<W extends SpeakerWord>(
  sentences: ReadonlyArray<SentenceSpan>,
  words: readonly W[],
): { assigned: W[][]; dropped: number } {
  const assigned: W[][] = sentences.map(() => []);
  if (sentences.length === 0) {
    return { assigned, dropped: 0 };
  }
  // The latest end among a sentence and all before it: once it is at or before a point, no
  // earlier sentence can contain that point.
  const endUpTo: number[] = [];
  let latest = -Infinity;
  for (const sentence of sentences) {
    latest = Math.max(latest, sentence.endMs);
    endUpTo.push(latest);
  }
  let dropped = 0;
  for (const word of words) {
    const midpoint = word.endMs > word.startMs ? (word.startMs + word.endMs) / 2 : word.startMs;
    const last = lastStartingAtOrBefore(sentences, midpoint);
    const containing: number[] = [];
    for (let index = last; index >= 0 && (endUpTo[index] as number) > midpoint; index -= 1) {
      if ((sentences[index] as SentenceSpan).endMs > midpoint) {
        containing.push(index);
      }
    }
    let target: number | undefined;
    if (containing.length === 1) {
      target = containing[0];
    } else if (containing.length > 1) {
      const same = word.speakerId === undefined ? [] : containing.filter((index) => (sentences[index] as SentenceSpan).speakerId === word.speakerId);
      target = same.length === 1 ? same[0] : undefined;
      if (target === undefined) {
        dropped += 1;
        continue;
      }
    } else {
      target = nearestAcrossGap(sentences, endUpTo, last, midpoint);
    }
    (assigned[target as number] as W[]).push(word);
  }
  return { assigned, dropped };
}

/** The last sentence starting at or before `at` (-1 when none does), by binary search. */
function lastStartingAtOrBefore(sentences: ReadonlyArray<SentenceSpan>, at: number): number {
  let low = 0;
  let high = sentences.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((sentences[middle] as SentenceSpan).startMs <= at) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate;
}

/**
 * The sentence for a midpoint no sentence contains: the nearer boundary of the sentence that
 * ended last before it and the next one to start, the earlier on a tie; the first sentence
 * before everything, the last after everything.
 */
function nearestAcrossGap(sentences: ReadonlyArray<SentenceSpan>, endUpTo: readonly number[], last: number, at: number): number {
  if (last === -1) {
    return 0;
  }
  // The latest sentence among those that ended last: for ordered, non-overlapping sentences, `last` itself.
  const previousEnd = endUpTo[last] as number;
  let previous = last;
  while ((sentences[previous] as SentenceSpan).endMs !== previousEnd) {
    previous -= 1;
  }
  const next = sentences[last + 1];
  if (next === undefined) {
    return previous;
  }
  return next.startMs - at < at - previousEnd ? last + 1 : previous;
}

/**
 * A submitted job's handle as persisted in the submitting WorkUnit's result;
 * the shape of `AsrJobHandle`. Unknown versions are refused rather than guessed at.
 */
export const asrJobHandleSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1),
    jobId: z.string().min(1),
    submittedAt: z.number().int().nonnegative(),
  })
  .strict();
export type AsrJobHandleRecord = z.infer<typeof asrJobHandleSchema>;

/**
 * What `asr:submit` persists. The first form is the older record (the handle alone), still
 * read as is; the second also names the usage row of the job-creating request, so the
 * remote end state found later can be filled into it, and the speaker identification
 * decision the job was submitted with. A record without a decision (made before it was
 * recorded) was submitted without identification.
 */
export const asrSubmitRecordSchema = z.union([
  asrJobHandleSchema,
  z.object({ handle: asrJobHandleSchema, usageId: z.string().min(1), diarization: diarizationDecisionSchema.exactOptional() }).strict(),
]);
export type AsrSubmitRecord = z.infer<typeof asrSubmitRecordSchema>;

/** A submit record read in either form: the handle, and the usage row and decision when the record names them. */
export function parseAsrSubmitRecord(
  value: unknown,
): { handle: AsrJobHandleRecord; usageId?: string; diarization?: DiarizationDecision } | undefined {
  const parsed = asrSubmitRecordSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const record = parsed.data;
  if (!("handle" in record)) {
    return { handle: record };
  }
  return { handle: record.handle, usageId: record.usageId, ...(record.diarization === undefined ? {} : { diarization: record.diarization }) };
}
