import { z } from "zod";
import type { CanonicalAsrResult } from "../../../domain/asr.ts";
import { amberError } from "../../../domain/errors.ts";
import type { TranscriptWord } from "../../../domain/transcript.ts";
import { inferLanguage } from "./language.ts";

const msSchema = z.number().finite().nonnegative();

const wordSchema = z.object({
  begin_time: msSchema,
  end_time: msSchema,
  text: z.string(),
  punctuation: z.string().optional(),
});

const sentenceSchema = z.object({
  begin_time: msSchema,
  end_time: msSchema,
  text: z.string(),
  speaker_id: z.union([z.number(), z.string()]).optional(),
  words: z.array(wordSchema).optional(),
});

/**
 * The recognition result file a finished job links to (official HTTP API reference).
 * Times are milliseconds. Fields Amber does not read are let through untouched.
 */
const resultFileSchema = z.object({
  properties: z.object({ original_duration_in_milliseconds: msSchema.optional() }).optional(),
  transcripts: z
    .array(
      z.object({
        channel_id: z.number().optional(),
        text: z.string().optional(),
        sentences: z.array(sentenceSchema),
      }),
    )
    .min(1),
});

type ResultSentence = z.infer<typeof sentenceSchema>;

/** What text and punctuation leave once spaces and punctuation are ignored; words must add up to their sentence. */
const IGNORED = /[\s\p{P}\p{S}]/gu;

function bare(text: string): string {
  return text.replace(IGNORED, "");
}

/**
 * Words of every sentence when all of them are consistent, else none: blank words left out,
 * each word has a start not after its end and not before the previous word's start, and the
 * words of a sentence (at least one) spell out exactly that sentence once spaces and
 * punctuation are ignored. A result whose words cannot be trusted keeps its sentences only,
 * with `segment_only` timing, rather than mixing real and doubtful word times.
 */
function consistentWords(sentences: readonly ResultSentence[]): Array<TranscriptWord & { speakerId?: string }> | undefined {
  const words: Array<TranscriptWord & { speakerId?: string }> = [];
  // Word starts are monotonic within one speaker's stream: sentences of different speakers
  // may overlap, so a word of one may start before a word of another.
  const previousStarts = new Map<string, number>();
  for (const sentence of sentences) {
    const stream = sentence.speaker_id === undefined ? "" : String(sentence.speaker_id);
    let previousStart = previousStarts.get(stream) ?? 0;
    const sentenceWords = sentence.words ?? [];
    if (sentenceWords.length === 0) {
      return undefined;
    }
    let spelled = "";
    let kept = 0;
    for (const word of sentenceWords) {
      const text = `${word.text.trim()}${(word.punctuation ?? "").trim()}`;
      // The service returns the space between an English word and the Chinese after it as a
      // word of its own; it spells nothing, so it is left out rather than failing the file.
      if (text === "") {
        continue;
      }
      if (word.begin_time > word.end_time || word.begin_time < previousStart) {
        return undefined;
      }
      kept += 1;
      previousStart = word.begin_time;
      previousStarts.set(stream, previousStart);
      spelled += text;
      // The word carries its sentence's speaker so that, where sentences of different
      // speakers overlap, the service layer can tell which sentence it belongs to.
      words.push({
        text,
        startMs: Math.round(word.begin_time),
        endMs: Math.round(word.end_time),
        ...(sentence.speaker_id === undefined ? {} : { speakerId: String(sentence.speaker_id) }),
      });
    }
    if (kept === 0 || bare(spelled) !== bare(sentence.text)) {
      return undefined;
    }
  }
  return words;
}

/**
 * The result file as `CanonicalAsrResult`: sentences become segments,
 * words are kept only when consistent, the duration is the service's own measurement of
 * the file when given. The file names no language; it is inferred from the script.
 */
export function canonicalFromResultFile(text: string, context: { provider: string; model: string }): CanonicalAsrResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw amberError("asr_failed", "dashscope result file is not JSON", { code: "asr_failed.job_failed", upstreamMessage: "result_unreadable" });
  }
  const checked = resultFileSchema.safeParse(parsed);
  if (!checked.success) {
    throw amberError("asr_failed", "dashscope result file does not have the documented shape", {
      code: "asr_failed.job_failed",
      upstreamMessage: "result_unreadable",
    });
  }
  const file = checked.data;
  // Only channel 0 is requested; a file without channel ids holds just that one.
  const transcript = file.transcripts.find((candidate) => candidate.channel_id === 0) ?? (file.transcripts[0] as (typeof file.transcripts)[number]);
  const sentences = transcript.sentences.filter((sentence) => sentence.text.trim() !== "");
  const segments = sentences.map((sentence) => ({
    startMs: Math.round(sentence.begin_time),
    endMs: Math.round(sentence.end_time),
    text: sentence.text.trim(),
    ...(sentence.speaker_id === undefined ? {} : { speakerId: String(sentence.speaker_id) }),
  }));
  const words = consistentWords(sentences);
  const fullText = transcript.text?.trim() || segments.map((segment) => segment.text).join(" ");
  return {
    text: fullText,
    language: inferLanguage(fullText),
    segments,
    ...(words === undefined ? {} : { words }),
    provider: context.provider,
    model: context.model,
    durationMs: Math.round(file.properties?.original_duration_in_milliseconds ?? segments.reduce((end, segment) => Math.max(end, segment.endMs), 0)),
  };
}
