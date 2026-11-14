import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { isMarked, joinReading, type ReadingChapter } from "../../../shared/reading.ts";
import { speakerSections, type SpeakerSection } from "../../../shared/speaker-turns.ts";
import type { Paragraph } from "./content-data.ts";

/** Where a paragraph sits in its speaker turn; present on every paragraph row of a turn layout. */
export interface TurnPlace {
  /** The id of the turn's first sentence: stable while the turn is read and unique in the revision. */
  key: string;
  /** Absent for the sentences nobody was assigned to. */
  speakerId?: string;
  /** Start of the turn; its header shows it. */
  startMs: number;
  /** The row that carries the turn header. */
  first: boolean;
  /** The row after which the next turn (or a chapter) starts. */
  last: boolean;
}

/** A row of the reading view: a chapter heading or a paragraph (with its turn when read by turns). */
export type ViewRow = { kind: "chapter"; startMs: number; title: string } | { kind: "paragraph"; paragraph: Paragraph; turn?: TurnPlace };

/** Chapters without a sentence are dropped before this, so a start time names one heading. */
export function viewRowKey(row: ViewRow): string {
  return row.kind === "chapter" ? `chapter:${row.startMs}` : (row.paragraph.segments[0]?.id ?? String(row.paragraph.startMs));
}

/** The chapter sections of a revision, each grouped into speaker turns. */
export function readerSections(segments: readonly TranscriptSegmentDto[], chapters: readonly ReadingChapter[]): SpeakerSection<TranscriptSegmentDto>[] {
  return speakerSections(segments, chapters);
}

/**
 * Flattens sections into rows: a chapter heading, then its paragraphs, one row per paragraph
 * so a long monologue still windows. With `turns` every paragraph row knows its turn, which
 * is how a layout draws one speaker line through a turn and shows its header once.
 */
export function viewRows(sections: readonly SpeakerSection<TranscriptSegmentDto>[], options: { turns: boolean }): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const section of sections) {
    if (section.chapter !== undefined) rows.push({ kind: "chapter", startMs: section.chapter.startMs, title: section.chapter.title });
    for (const turn of section.turns) {
      const key = turn.paragraphs[0]?.segments[0]?.id ?? String(turn.startMs);
      turn.paragraphs.forEach((paragraph, index) => {
        rows.push({
          kind: "paragraph",
          paragraph,
          ...(options.turns
            ? {
                turn: {
                  key,
                  ...(turn.speakerId === undefined ? {} : { speakerId: turn.speakerId }),
                  startMs: turn.startMs,
                  first: index === 0,
                  last: index === turn.paragraphs.length - 1,
                },
              }
            : {}),
        });
      });
    }
  }
  return rows;
}

/** What the copy button takes: the view as read, headings on their own line, blocks a blank line apart. */
export function readingText(rows: readonly ViewRow[]): string {
  return rows
    .map((row) => (row.kind === "chapter" ? row.title : joinReading(row.paragraph.segments.map((s) => s.text), row.paragraph.segments.some(isMarked))))
    .join("\n\n");
}

/**
 * The same text with each turn opening with its speaker's name (`prefixOf`, which brings its
 * own colon). Only the turn's first paragraph is labelled; sentences nobody was assigned to
 * stay unlabelled, as in the exports.
 */
export function readingTextWithSpeakers(sections: readonly SpeakerSection<TranscriptSegmentDto>[], prefixOf: (speakerId: string) => string): string {
  const blocks: string[] = [];
  for (const section of sections) {
    if (section.chapter !== undefined) blocks.push(section.chapter.title);
    for (const turn of section.turns) {
      turn.paragraphs.forEach((paragraph, index) => {
        const text = joinReading(paragraph.segments.map((s) => s.text), paragraph.segments.some(isMarked));
        blocks.push(index === 0 && turn.speakerId !== undefined ? `${prefixOf(turn.speakerId)}${text}` : text);
      });
    }
  }
  return blocks.join("\n\n");
}
