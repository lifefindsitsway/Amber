import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { readingParagraphs, readingSections, type ReadingChapter } from "../../../shared/reading.ts";
import { speakerTurns, type SpeakerSection } from "../../../shared/speaker-turns.ts";
import { viewRows, type ViewRow } from "./reader-rows.ts";

/** The address parameter of the reading view's speaker filter, repeated once per speaker. */
export const SPEAKER_PARAM = "speaker";

/** What the filter needs of a speaker to order and validate a selection. */
export interface FilterSpeaker {
  id: string;
  ordinal: number;
}

/**
 * A selection as the filter keeps it: known speakers only, each once, in ordinal order. An id
 * the speaker list does not know (a stale or hand-edited address) is dropped.
 */
export function normalizeSelection(ids: Iterable<string>, speakers: readonly FilterSpeaker[]): string[] {
  const ordinals = new Map(speakers.map((speaker) => [speaker.id, speaker.ordinal]));
  return [...new Set(ids)].filter((id) => ordinals.has(id)).sort((a, b) => (ordinals.get(a) as number) - (ordinals.get(b) as number));
}

/** The selection an address asks for; see `normalizeSelection`. */
export function selectionFromParams(params: URLSearchParams, speakers: readonly FilterSpeaker[]): string[] {
  return normalizeSelection(params.getAll(SPEAKER_PARAM), speakers);
}

/**
 * The address with `ids` as the selection, every other parameter (`search`, `revision`,
 * `tab`…) kept as it was. The ids are written normalized, so equal selections give equal
 * addresses.
 */
export function paramsWithSelection(params: URLSearchParams, ids: Iterable<string>, speakers: readonly FilterSpeaker[]): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(SPEAKER_PARAM);
  for (const id of normalizeSelection(ids, speakers)) next.append(SPEAKER_PARAM, id);
  return next;
}

/** Whether a sentence passes the selection; an empty selection lets everything through. */
export function matchesSpeakers(segment: Pick<TranscriptSegmentDto, "speakerId">, selected: ReadonlySet<string>): boolean {
  return selected.size === 0 || (segment.speakerId !== undefined && selected.has(segment.speakerId));
}

/** Sentences per speaker in a revision; unassigned sentences are not counted. */
export function sentenceCounts(segments: ReadonlyArray<Pick<TranscriptSegmentDto, "speakerId">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    if (segment.speakerId !== undefined) counts.set(segment.speakerId, (counts.get(segment.speakerId) ?? 0) + 1);
  }
  return counts;
}

/**
 * A bar between two shown turns that were not next to each other in the full text: what was
 * skipped (`skippedMs`, from the end of the sentence before to the start of the one after),
 * and the first skipped sentence, where the full text is to be shown again.
 */
export interface GapRow {
  kind: "gap";
  firstSkippedId: string;
  skippedMs: number;
}

/** A row of the filtered reading view: the usual rows, with gap bars between them. */
export type FilteredRow = ViewRow | GapRow;

export function filteredRowKey(row: FilteredRow, viewKey: (row: ViewRow) => string): string {
  return row.kind === "gap" ? `gap:${row.firstSkippedId}` : viewKey(row);
}

export interface FilteredView {
  rows: FilteredRow[];
  /** Shown turns: runs of one speaker's consecutive sentences in the full text. */
  turns: number;
  /** Shown sentences; 0 means the selected speakers have nothing in this revision. */
  sentences: number;
}

/**
 * The reading view of only the selected speakers' sentences. Turns never run across skipped
 * text: each run of sentences that were consecutive in the full text is paragraphed and
 * grouped on its own, so two of a speaker's turns with someone else in between stay two
 * turns, with a gap bar between them. Chapters keep their headings over the sentences shown;
 * a chapter with nothing shown has none. `options` are those of `viewRows`.
 */
export function filteredViewRows(
  segments: readonly TranscriptSegmentDto[],
  chapters: readonly ReadingChapter[],
  selected: ReadonlySet<string>,
  options: Parameters<typeof viewRows>[1],
): FilteredView {
  const position = new Map<string, number>();
  const kept: TranscriptSegmentDto[] = [];
  segments.forEach((segment, index) => {
    if (segment.speakerId !== undefined && selected.has(segment.speakerId)) {
      position.set(segment.id, index);
      kept.push(segment);
    }
  });
  const sections: SpeakerSection<TranscriptSegmentDto>[] = readingSections(kept, chapters).map((section) => {
    const runs: TranscriptSegmentDto[][] = [];
    let previous = -2;
    for (const segment of section.sentences) {
      const at = position.get(segment.id) as number;
      const run = runs.at(-1);
      if (run !== undefined && at === previous + 1) run.push(segment);
      else runs.push([segment]);
      previous = at;
    }
    return {
      ...(section.chapter === undefined ? {} : { chapter: section.chapter }),
      turns: runs.flatMap((run) => speakerTurns(readingParagraphs(run))),
    };
  });
  const rows: FilteredRow[] = [];
  let last: { index: number; rowAt: number; endMs: number } | undefined;
  for (const row of viewRows(sections, options)) {
    if (row.kind === "paragraph") {
      const first = row.paragraph.segments[0] as TranscriptSegmentDto;
      const firstAt = position.get(first.id) as number;
      if (last !== undefined && firstAt > last.index + 1) {
        // Right after the turn before, ahead of any chapter heading between the two.
        rows.splice(last.rowAt + 1, 0, {
          kind: "gap",
          firstSkippedId: (segments[last.index + 1] as TranscriptSegmentDto).id,
          skippedMs: Math.max(0, first.startMs - last.endMs),
        });
      }
      rows.push(row);
      const tail = row.paragraph.segments.at(-1) as TranscriptSegmentDto;
      last = { index: position.get(tail.id) as number, rowAt: rows.length - 1, endMs: tail.endMs };
    } else {
      rows.push(row);
    }
  }
  return { rows, turns: countTurns(segments, selected), sentences: kept.length };
}

/** Runs of one speaker's consecutive sentences among the selected speakers' sentences. */
export function countTurns(segments: ReadonlyArray<Pick<TranscriptSegmentDto, "speakerId">>, selected: ReadonlySet<string>): number {
  let turns = 0;
  let previous: string | undefined;
  for (const segment of segments) {
    const shown = segment.speakerId !== undefined && selected.has(segment.speakerId) ? segment.speakerId : undefined;
    if (shown !== undefined && shown !== previous) turns += 1;
    previous = shown;
  }
  return turns;
}

/** The row showing `segmentId`, or -1: where the full text is scrolled when a gap bar is clicked. */
export function rowIndexOfSegment(rows: readonly FilteredRow[], segmentId: string): number {
  return rows.findIndex((row) => row.kind === "paragraph" && row.paragraph.segments.some((segment) => segment.id === segmentId));
}

/** A skipped stretch split for display: whole hours and minutes, minutes and seconds, or seconds. */
export function skippedParts(ms: number): { unit: "hours"; hours: number; minutes: number } | { unit: "minutes"; minutes: number; seconds: number } | { unit: "seconds"; seconds: number } {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total >= 3600) return { unit: "hours", hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) };
  if (total >= 60) return { unit: "minutes", minutes: Math.floor(total / 60), seconds: total % 60 };
  return { unit: "seconds", seconds: total };
}
