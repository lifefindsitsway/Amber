import { SPEAKER_SHORT_TURN_CHARS } from "./defaults.ts";
import { readingParagraphs, readingSections, type ReadingChapter, type ReadingParagraph, type ReadingSentence } from "./reading.ts";
import { graphemesOf } from "./speakers.ts";

/**
 * Consecutive reading paragraphs of one speaker. `speakerId` is absent for the sentences
 * nobody was assigned to: unassigned is its own kind of turn, never merged into a named one.
 */
export interface SpeakerTurn<T extends ReadingSentence> {
  speakerId?: string;
  startMs: number;
  /** The latest end among the turn's sentences; sentences of one turn may overlap each other. */
  endMs: number;
  paragraphs: ReadingParagraph<T>[];
}

/**
 * Groups reading paragraphs into speaker turns. Paragraph breaks are not decided here:
 * `ReadingBreaks` already breaks on every change of speaker, so a turn is a run of
 * paragraphs the shared rules cut for other reasons (pause, length, paragraph marks).
 */
export function speakerTurns<T extends ReadingSentence>(paragraphs: readonly ReadingParagraph<T>[]): SpeakerTurn<T>[] {
  const turns: SpeakerTurn<T>[] = [];
  for (const paragraph of paragraphs) {
    const end = paragraph.segments.reduce((latest, segment) => Math.max(latest, segment.endMs), paragraph.startMs);
    const current = turns.at(-1);
    if (current !== undefined && current.speakerId === paragraph.speakerId) {
      current.paragraphs.push(paragraph);
      current.endMs = Math.max(current.endMs, end);
    } else {
      turns.push({ ...(paragraph.speakerId === undefined ? {} : { speakerId: paragraph.speakerId }), startMs: paragraph.startMs, endMs: end, paragraphs: [paragraph] });
    }
  }
  return turns;
}

export interface SpeakerSection<T extends ReadingSentence> {
  /** Absent for the sentences before the first chapter. */
  chapter?: ReadingChapter;
  turns: SpeakerTurn<T>[];
}

/**
 * Chapter sections, each paragraphed on its own and grouped into turns: a chapter start
 * is a boundary above turns, so the speaker is shown again after a chapter heading.
 */
export function speakerSections<T extends ReadingSentence>(sentences: readonly T[], chapters: readonly ReadingChapter[]): SpeakerSection<T>[] {
  return readingSections(sentences, chapters).map((section) => ({
    ...(section.chapter === undefined ? {} : { chapter: section.chapter }),
    turns: speakerTurns(readingParagraphs(section.sentences)),
  }));
}

/**
 * Whether a turn is shown compactly: a single sentence of at most `SPEAKER_SHORT_TURN_CHARS`
 * grapheme clusters that carries no note and no search hit (`hasMarks`, which only the
 * caller knows). Length counts what a reader counts, not UTF-16 units.
 */
export function isShortTurn<T extends ReadingSentence>(turn: SpeakerTurn<T>, options: { hasMarks: boolean }): boolean {
  if (options.hasMarks || turn.paragraphs.length !== 1) return false;
  const segments = (turn.paragraphs[0] as ReadingParagraph<T>).segments;
  if (segments.length !== 1) return false;
  const text = (segments[0] as T).text.trim();
  // A cluster is at least one UTF-16 unit, so a text within the limit in units is within it in clusters.
  return text.length <= SPEAKER_SHORT_TURN_CHARS || graphemesOf(text).length <= SPEAKER_SHORT_TURN_CHARS;
}

/**
 * Whether a revision is read by turns: it references at least two distinct speakers, or at
 * least one speaker that has a name. A single anonymous speaker is not worth a turn layout.
 */
export function speakerModeFor(segments: ReadonlyArray<{ speakerId?: string }>, speakers: ReadonlyArray<{ id: string; name?: string }>): boolean {
  const used = new Set<string>();
  for (const segment of segments) {
    if (segment.speakerId !== undefined) used.add(segment.speakerId);
  }
  if (used.size >= 2) return true;
  return speakers.some((speaker) => used.has(speaker.id) && speaker.name !== undefined && speaker.name.trim() !== "");
}

/** What one speaker accounts for in a revision. */
export interface SpeakerShare {
  speakerId: string;
  sentences: number;
  durationMs: number;
  /** `durationMs` over the total duration of all assigned sentences, 0..1; 0 when there is none. */
  share: number;
}

/**
 * Sentence count and speaking-time share per speaker, in order of first appearance.
 * Unassigned sentences are not counted, so the shares of the speakers add up to 1.
 */
export function speakerShares(segments: ReadonlyArray<{ startMs: number; endMs: number; speakerId?: string }>): SpeakerShare[] {
  const byId = new Map<string, { sentences: number; durationMs: number }>();
  let total = 0;
  for (const segment of segments) {
    if (segment.speakerId === undefined) continue;
    const duration = Math.max(0, segment.endMs - segment.startMs);
    const entry = byId.get(segment.speakerId) ?? { sentences: 0, durationMs: 0 };
    entry.sentences += 1;
    entry.durationMs += duration;
    byId.set(segment.speakerId, entry);
    total += duration;
  }
  return Array.from(byId, ([speakerId, entry]) => ({ speakerId, ...entry, share: total === 0 ? 0 : entry.durationMs / total }));
}
