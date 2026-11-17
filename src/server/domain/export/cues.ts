import type { TranscriptWord } from "../transcript.ts";

/** One subtitle line to export: a transcript sentence, optionally with its translation. */
export interface ExportCue {
  startMs: number;
  endMs: number;
  text: string;
  /** Present only for sentences of an `exact_words` revision. */
  words?: readonly TranscriptWord[];
  speakerId?: string;
  /** The sentence's paragraph mark, when its revision has them. */
  paragraphStart?: boolean;
  /** The revision's `looseJoin`: with marks, its sentences still join as unmarked ones do. */
  looseJoin?: true;
  translation?: string;
}

/** A sentence is one physical line in line-based formats; stored text is unchanged. */
export function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}
