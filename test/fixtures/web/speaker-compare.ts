import type { TranscriptRevisionListItemDto } from "../../../src/shared/dto/content.ts";
import type { SpeakerDto } from "../../../src/shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../src/shared/dto/transcript.ts";
import { revision } from "./content-data.ts";

/**
 * Data for the cross-recognition comparison views. Sentences carry only times and speaker
 * ordinals, never transcript text.
 */

/** [startMs, endMs, ordinal or null for unassigned]. */
export type Row = readonly [number, number, number | null];

/** Turns of `ordinals`, `length` ms each, starting at 0. */
export function turns(ordinals: ReadonlyArray<number | null>, length = 5_000): Row[] {
  return ordinals.map((ordinal, index) => [index * length, (index + 1) * length, ordinal] as const);
}

/** This Content's speakers 1–2 (the reviewed transcription) and 3–5 (the comparison's own labels). */
export const COMPARE_SPEAKERS: SpeakerDto[] = [
  { id: "spk-1", ordinal: 1, name: "陈明", colorIndex: 0, used: true },
  { id: "spk-2", ordinal: 2, name: "林雪", colorIndex: 1, used: true },
  { id: "spk-3", ordinal: 3, colorIndex: 2, used: true, comparisonOnly: true },
  { id: "spk-4", ordinal: 4, colorIndex: 3, used: true, comparisonOnly: true },
  { id: "spk-5", ordinal: 5, colorIndex: 4, used: true, comparisonOnly: true },
];

/** Speaker id of ordinal `n` in `COMPARE_SPEAKERS`. */
export const speakerOf = (ordinal: number): string => `spk-${ordinal}`;

export function segmentsOf(revisionId: string, rows: readonly Row[]): TranscriptSegmentDto[] {
  return rows.map(([startMs, endMs, ordinal], index) => ({
    id: `${revisionId}-s${index + 1}`,
    revisionId,
    ordinal: index,
    startMs,
    endMs,
    text: "",
    sourceSegmentIds: [],
    ...(ordinal === null ? {} : { speakerId: speakerOf(ordinal) }),
  }));
}

/** A recognition of the Content that found speakers; `comparison` marks one made only to compare with. */
export function recognition(id: string, modelId: string, options: { comparison?: boolean; createdAt?: number } = {}): TranscriptRevisionListItemDto {
  return revision(id, {
    kind: "asr",
    createdAt: options.createdAt ?? 10,
    generation: { kind: "asr", asrProfileId: "p", modelId, diarization: { status: "applied" }, ...(options.comparison === true ? { purpose: "comparison" } : {}) },
  });
}

export function segmentRoute(revisionId: string, rows: readonly Row[], listed: TranscriptRevisionListItemDto) {
  return { [`GET /api/transcript/revisions/${revisionId}/segments`]: { body: { revision: listed, items: segmentsOf(revisionId, rows) } } };
}
