import type { ArtifactInputRef } from "./artifact.ts";
import { ancestry } from "./segment-map.ts";
import type { TranscriptRevision } from "./transcript.ts";

/** Why a derived artifact is stale, as artifact DTOs report it in `staleReason`. */
export type StaleReason = "transcript_changed" | "chapters_changed" | "member_changed" | "order_changed";

export type Freshness = { stale: false } | { stale: true; staleReason: StaleReason };

/** The current pointers an artifact's inputs are compared with. */
export interface CurrentPointers {
  primaryTranscriptRevisionId?: string;
  /** The primary's ancestors along `parentRevisionId`, nearest first. */
  primaryAncestors?: readonly string[];
  /** The Content's ChapterArtifact current revision. */
  chapterRevisionId?: string;
}

/**
 * Freshness is never stored as truth: it is derived by comparing the
 * revisions an artifact was built from with the pointers that are current now. A
 * transcript input that is neither the primary nor one of its ancestors makes it
 * `transcript_changed`: a primary edited or proofread from the input shares its sentences
 * and timing, and such corrections are mostly typos and sentence breaks, so the artifact
 * keeps standing until the user chooses to regenerate it. A chapter input that is no
 * longer current makes it `chapters_changed`. Artifacts without such inputs — platform
 * chapters above all — are always fresh. Other input kinds are compared by the artifacts
 * that use them.
 */
export function deriveFreshness(inputs: readonly ArtifactInputRef[], current: CurrentPointers): Freshness {
  for (const input of inputs) {
    if (input.kind === "transcriptRevision" && !inLineage(input.id, current.primaryTranscriptRevisionId, current.primaryAncestors)) {
      return { stale: true, staleReason: "transcript_changed" };
    }
  }
  for (const input of inputs) {
    if (input.kind === "chapterRevision" && input.id !== current.chapterRevisionId) {
      return { stale: true, staleReason: "chapters_changed" };
    }
  }
  return { stale: false };
}

/**
 * The ancestors of a transcript revision along `parentRevisionId`, nearest first, among
 * the Content's revisions; empty without a revision.
 */
export function transcriptAncestors(revisionId: string | undefined, revisions: Iterable<Pick<TranscriptRevision, "id" | "parentRevisionId">>): string[] {
  if (revisionId === undefined) {
    return [];
  }
  return ancestry(revisionId, new Map([...revisions].map((revision) => [revision.id, revision]))).slice(1);
}

function inLineage(inputId: string, primaryId: string | undefined, ancestors: readonly string[] | undefined): boolean {
  return primaryId !== undefined && (inputId === primaryId || (ancestors ?? []).includes(inputId));
}

/** A collection member as a collection summary saw it, or as it is now. */
export interface CollectionMemberState {
  contentId: string;
  /** The member's `summary.core` current revision. */
  summaryRevisionId?: string;
  /** The member's primary transcript. */
  transcriptRevisionId?: string;
  /** For the member as it is now: the primary's ancestors, nearest first. */
  transcriptAncestors?: readonly string[];
}

/**
 * Freshness of a collection summary: `inputItems` are compared
 * with the members as they are now, both in collection order. A different set of
 * members, or a member whose `summary.core` current changed or whose primary is no longer
 * the frozen transcript or one edited from it, is `member_changed`; otherwise a different
 * order is `order_changed`.
 */
export function deriveCollectionFreshness(snapshot: readonly CollectionMemberState[], current: readonly CollectionMemberState[]): Freshness {
  const now = new Map(current.map((member) => [member.contentId, member]));
  const sameMembers =
    snapshot.length === current.length &&
    snapshot.every((member) => {
      const present = now.get(member.contentId);
      return (
        present !== undefined &&
        present.summaryRevisionId === member.summaryRevisionId &&
        (member.transcriptRevisionId === undefined
          ? present.transcriptRevisionId === undefined
          : inLineage(member.transcriptRevisionId, present.transcriptRevisionId, present.transcriptAncestors))
      );
    });
  if (!sameMembers) {
    return { stale: true, staleReason: "member_changed" };
  }
  if (snapshot.some((member, index) => current[index]?.contentId !== member.contentId)) {
    return { stale: true, staleReason: "order_changed" };
  }
  return { stale: false };
}
