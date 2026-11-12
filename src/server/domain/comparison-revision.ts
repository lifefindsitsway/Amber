import { SPEAKER_COMPARISON_ROOM_FACTOR, SPEAKERS_PER_CONTENT_MAX } from "../../shared/defaults.ts";
import { isComparisonGeneration } from "../../shared/speaker-comparison.ts";
import type { ContentSpeaker } from "./speaker.ts";
import { PROTECTED_REVISION_KINDS, type TranscriptRevision } from "./transcript.ts";

/**
 * A transcription made only to compare speakers with: an `asr` revision whose immutable
 * generation says so. It never takes the primary by itself, writes no original language and
 * is not searched until the user makes it the primary.
 */
export function isComparisonRevision(revision: Pick<TranscriptRevision, "generation">): boolean {
  return isComparisonGeneration(revision.generation);
}

/**
 * Whether a revision is evidence the user may archive but never permanently delete: platform
 * and ASR originals. A comparison transcription is the exception: it was asked for only to
 * check speakers against, and holds speaker rows the user may want back.
 */
export function isPermanentRevision(revision: Pick<TranscriptRevision, "kind" | "generation">): boolean {
  return PROTECTED_REVISION_KINDS.has(revision.kind) && !isComparisonRevision(revision);
}

/**
 * The room a comparison transcription needs among the Content's speakers: the other model may
 * split each speaker of the primary into several labels, so it must fit
 * `SPEAKER_COMPARISON_ROOM_FACTOR` times as many as the primary names. `room` is what is left
 * under `SPEAKERS_PER_CONTENT_MAX`.
 */
export function comparisonSpeakerRoom(registered: number, primarySpeakers: number): { room: number; required: number; enough: boolean } {
  const room = Math.max(0, SPEAKERS_PER_CONTENT_MAX - registered);
  const required = SPEAKER_COMPARISON_ROOM_FACTOR * primarySpeakers;
  return { room, required, enough: room >= required };
}

/**
 * Whether a speaker row may be reclaimed together with the comparison transcription that alone
 * named it: only one the user has not given a name or a photo, which holds nothing of theirs.
 * Whether anything else still names it is the caller's to check.
 */
export function isRecyclableSpeaker(speaker: Pick<ContentSpeaker, "name" | "avatar">): boolean {
  return speaker.name === undefined && speaker.avatar === undefined;
}
