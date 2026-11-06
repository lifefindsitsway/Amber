import { z } from "zod";
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
  words?: TranscriptWord[];
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

/**
 * Assigns each word to a sentence by its midpoint: `(startMs + endMs) / 2`,
 * or `startMs` for a zero-length word, falls in exactly one sentence's `[startMs, endMs)`;
 * a midpoint in a gap goes to the sentence with the nearer boundary (the earlier one on a
 * tie), one before the first or after the last sentence to that sentence. Sentences must
 * be ordered and must not overlap. Returns one word list per sentence, in input order.
 */
export function assignWordsToSentences(
  sentences: ReadonlyArray<{ startMs: number; endMs: number }>,
  words: readonly TranscriptWord[],
): TranscriptWord[][] {
  const assigned: TranscriptWord[][] = sentences.map(() => []);
  if (sentences.length === 0) {
    return assigned;
  }
  for (const word of words) {
    const midpoint = word.endMs > word.startMs ? (word.startMs + word.endMs) / 2 : word.startMs;
    (assigned[sentenceIndexAt(sentences, midpoint)] as TranscriptWord[]).push(word);
  }
  return assigned;
}

function sentenceIndexAt(sentences: ReadonlyArray<{ startMs: number; endMs: number }>, at: number): number {
  // The last sentence starting at or before `at`, by binary search.
  let low = 0;
  let high = sentences.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((sentences[middle] as { startMs: number }).startMs <= at) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate === -1) {
    return 0;
  }
  const current = sentences[candidate] as { startMs: number; endMs: number };
  const next = sentences[candidate + 1];
  if (at < current.endMs || next === undefined) {
    return candidate;
  }
  return next.startMs - at < at - current.endMs ? candidate + 1 : candidate;
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
 * remote end state found later can be filled into it.
 */
export const asrSubmitRecordSchema = z.union([
  asrJobHandleSchema,
  z.object({ handle: asrJobHandleSchema, usageId: z.string().min(1) }).strict(),
]);
export type AsrSubmitRecord = z.infer<typeof asrSubmitRecordSchema>;

/** A submit record read in either form: the handle, and the usage row when the record names one. */
export function parseAsrSubmitRecord(value: unknown): { handle: AsrJobHandleRecord; usageId?: string } | undefined {
  const parsed = asrSubmitRecordSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const record = parsed.data;
  return "handle" in record ? { handle: record.handle, usageId: record.usageId } : { handle: record };
}
