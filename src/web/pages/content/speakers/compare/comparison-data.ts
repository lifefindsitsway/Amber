import { useMemo } from "react";
import type { TranscriptRevisionDto } from "../../../../../shared/dto/content.ts";
import { asrDiarizationRecordSchema } from "../../../../../shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../../../shared/dto/transcript.ts";
import type { AttributionComparison, AttributionDifferenceKind, SpeakerCorrespondence } from "../../../../../shared/speaker-compare.ts";
import { compareAttribution, isComparisonGeneration, proposeCorrespondences, withOverrides, type ComparedSentence } from "../../../../../shared/speaker-comparison.ts";

/** The three kinds of listed sentences, in the order the view shows them. */
export const DIFFERENCE_KINDS = ["different", "undetermined", "unmapped"] as const satisfies readonly AttributionDifferenceKind[];

/** Whether a revision is a transcription made only for comparison. */
export function isComparisonRevision(revision: Pick<TranscriptRevisionDto, "generation">): boolean {
  return isComparisonGeneration(revision.generation);
}

/** The recognition a revision descends from: following parents up to the root, within the listed revisions. */
function rootOf(revisions: readonly TranscriptRevisionDto[], revisionId: string): string {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const seen = new Set<string>();
  let at = revisionId;
  for (;;) {
    const parent = byId.get(at)?.parentRevisionId;
    if (parent === undefined || seen.has(parent) || !byId.has(parent)) return at;
    seen.add(at);
    at = parent;
  }
}

/**
 * The transcriptions the current one can be compared with: recognitions that recorded finding
 * speakers, other than the one being checked and the recognition it was itself made from
 * (comparing a transcription with its own origin shows nothing). Comparison transcriptions
 * come first, then the others, newest first within each.
 */
export function comparisonCandidates<T extends TranscriptRevisionDto>(revisions: readonly T[], baseRevisionId: string): T[] {
  const root = rootOf(revisions, baseRevisionId);
  return revisions
    .filter((revision) => {
      if (revision.kind !== "asr" || revision.id === baseRevisionId || revision.id === root) return false;
      const record = asrDiarizationRecordSchema.safeParse(revision.generation["diarization"]);
      return record.success && record.data.status === "applied";
    })
    .sort((a, b) => Number(isComparisonRevision(b)) - Number(isComparisonRevision(a)) || b.createdAt - a.createdAt);
}

/** The model a recognition was made with, as its generation records it. */
export function recognitionModel(revision: Pick<TranscriptRevisionDto, "generation">): string | undefined {
  const recorded = revision.generation["modelId"];
  return typeof recorded === "string" && recorded.length > 0 ? recorded : undefined;
}

/** The speakers sentences name, in order of first appearance. */
export function speakersInOrder(sentences: readonly Pick<ComparedSentence, "speakerId">[]): string[] {
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (sentence.speakerId !== null) seen.add(sentence.speakerId);
  }
  return [...seen];
}

export interface ComparisonResult {
  correspondences: SpeakerCorrespondence[];
  comparison: AttributionComparison;
}

/**
 * Correspondences (with the user's choices) and the sentence-by-sentence comparison of
 * `sentences` against the other transcription's; `undefined` until the other side is loaded.
 * Proposals are computed once per pair of inputs, so changing a choice only re-runs the
 * comparison.
 */
export function useAttributionComparison(
  sentences: readonly ComparedSentence[] | undefined,
  other: readonly Pick<TranscriptSegmentDto, "startMs" | "endMs" | "speakerId">[] | undefined,
  overrides: ReadonlyMap<string, string | null>,
): ComparisonResult | undefined {
  const proposed = useMemo(() => (sentences === undefined || other === undefined ? undefined : proposeCorrespondences(sentences, other)), [sentences, other]);
  return useMemo(() => {
    if (sentences === undefined || other === undefined || proposed === undefined) return undefined;
    const correspondences = withOverrides(proposed, overrides);
    return { correspondences, comparison: compareAttribution(sentences, other, correspondences) };
  }, [sentences, other, proposed, overrides]);
}

/** A stored revision's sentences as the comparison reads them. */
export function comparedSentences(segments: readonly Pick<TranscriptSegmentDto, "id" | "startMs" | "endMs" | "speakerId">[]): ComparedSentence[] {
  return segments.map((segment) => ({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs, speakerId: segment.speakerId ?? null }));
}
