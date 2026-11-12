/**
 * Comparing who said what in two transcriptions of the same Content, typically by models of
 * two vendors. Two transcriptions never share speaker ids, so their speakers are put in
 * correspondence by time overlap first; only then are the sentences compared. The result is
 * a list of places worth a second look, never a verdict: where both transcriptions are
 * wrong in the same way nothing shows up.
 */

/**
 * How one speaker of the other transcription relates to the speakers of this one:
 * `matched` to the speaker it overlaps for most of its time, `unreliable` when no single
 * speaker covers enough of it (one label probably mixes several people), `unmatched` when
 * it overlaps nobody. Several speakers of the other transcription may match the same one.
 */
export type SpeakerCorrespondenceStatus = "matched" | "unreliable" | "unmatched";

export interface SpeakerCorrespondence {
  /** The speaker in the other transcription. */
  sourceId: string;
  /** The speaker of this transcription it corresponds to; `null` unless `matched` (or chosen by the user). */
  targetId: string | null;
  status: SpeakerCorrespondenceStatus;
  /** Share of the source speaker's overlapped time that falls on its best candidate, 0–1. */
  share: number;
}

/**
 * Why a sentence is listed: the other transcription gives it to someone else (`different`),
 * cannot say (`undetermined`: too little overlap, or no speaker there), or gives it to a
 * speaker that corresponds to nobody here (`unmapped`).
 */
export type AttributionDifferenceKind = "different" | "undetermined" | "unmapped";

export interface AttributionDifference {
  segmentId: string;
  kind: AttributionDifferenceKind;
  /** The sentence's speaker in this transcription; `null` = unassigned. */
  speakerId: string | null;
  /** Whom the other transcription gives it to, in this transcription's speaker ids; `null` when it cannot be said. */
  otherSpeakerId: string | null;
}

export interface AttributionComparison {
  differences: AttributionDifference[];
  counts: Record<AttributionDifferenceKind, number>;
  /** Share of this transcription's sentences the other one overlaps at all, 0–1. */
  coverage: number;
  /** The two timelines probably disagree: low coverage, or ends too far apart. The list is not to be trusted then. */
  unreliable: boolean;
}
