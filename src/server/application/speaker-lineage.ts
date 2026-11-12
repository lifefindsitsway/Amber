import type { ContentSpeaker } from "../domain/speaker.ts";
import { speakerLabels, type SpeakerContextSnapshot } from "../domain/speaker-context.ts";
import {
  compareSpeakerLineage,
  deriveSpeakerContextState,
  lineageVerdict,
  type SpeakerContextStateResult,
  type SpeakerLineageComparison,
} from "../domain/speaker-lineage.ts";
import { ancestry } from "../domain/segment-map.ts";
import type { TranscriptRevision, TranscriptSegment } from "../domain/transcript.ts";
import type { RepositoryScope } from "../ports/repository.ts";

/**
 * Revision pairs whose comparison is kept. A comparison holds one set entry per sentence of
 * the earlier revision; this bounds the memory to a few hundred transcripts' worth while
 * still covering every artifact list a user has open.
 */
const LINEAGE_CACHE_PAIRS = 256;

/** The labels the given speakers (those a snapshot lists) would be given to a model now, by speaker id. */
export type SpeakerLabeler = (speakers: readonly ContentSpeaker[]) => ReadonlyMap<string, string>;

/** The labels a request would use now, by the same rule that labelled the snapshot. */
export const currentSpeakerLabels: SpeakerLabeler = (speakers) => new Map(speakerLabels(speakers).map((speaker) => [speaker.id, speaker.label]));

export interface SpeakerContextStateRequest {
  contentId: string;
  /** The transcript revision the result was generated from. */
  generatedFromRevisionId: string;
  snapshot: SpeakerContextSnapshot;
  /** The sentences the result cites: citations, highlight items, chapter starts. */
  citedSegmentIds: Iterable<string>;
}

/**
 * Speaker states of stored results, compared with the Content's current primary. Revisions
 * and their sentences are immutable, so the sentence-by-sentence comparison of two
 * revisions never changes and is cached per (owner, generated-from, primary), least recently
 * used first out; names and reviews do change, so they are read anew on every call. The
 * cache lives as long as the service and nothing about it is stored.
 */
export class SpeakerLineageReader {
  private readonly cache = new Map<string, SpeakerLineageComparison>();
  private readonly capacity: number;

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? LINEAGE_CACHE_PAIRS;
  }

  /** The comparison of `fromRevisionId` with `toRevisionId`, two revisions of one Content of the owner. */
  compare(scope: RepositoryScope, owner: string, contentId: string, fromRevisionId: string, toRevisionId: string): SpeakerLineageComparison {
    const key = `${owner}\n${fromRevisionId}\n${toRevisionId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const comparison = loadComparison(scope, owner, contentId, fromRevisionId, toRevisionId);
    this.cache.set(key, comparison);
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return comparison;
  }

  /**
   * The speaker state of one result; `undefined` when it has none to show: the Content has
   * no primary, or the result's transcript is neither the primary nor one of its ancestors
   * (its text is stale, which says more than any speaker state could).
   */
  state(scope: RepositoryScope, owner: string, request: SpeakerContextStateRequest, labeler: SpeakerLabeler = currentSpeakerLabels): SpeakerContextStateResult | undefined {
    const content = scope.contents.get(owner, request.contentId);
    const primaryId = content?.primaryTranscriptRevisionId;
    if (primaryId === undefined) {
      return undefined;
    }
    const revisions = new Map(scope.transcripts.listRevisions(owner, request.contentId).map((revision) => [revision.id, revision]));
    if (!ancestry(primaryId, revisions).includes(request.generatedFromRevisionId)) {
      return undefined;
    }
    const comparison = this.compare(scope, owner, request.contentId, request.generatedFromRevisionId, primaryId);
    const verdict = lineageVerdict(comparison, request.citedSegmentIds);
    const listed = new Set(request.snapshot.speakers.map((speaker) => speaker.id));
    const roster = scope.speakers.list(owner, request.contentId).filter((speaker) => listed.has(speaker.id));
    const primaryConfirmed = scope.speakerConfirmations.confirmedAt(owner, primaryId) !== undefined;
    return deriveSpeakerContextState(verdict, request.snapshot, labeler(roster), primaryConfirmed);
  }
}

function loadComparison(scope: RepositoryScope, owner: string, contentId: string, fromRevisionId: string, toRevisionId: string): SpeakerLineageComparison {
  const revisions = new Map<string, TranscriptRevision>(
    scope.transcripts.listRevisions(owner, contentId).map((revision) => [revision.id, revision]),
  );
  return compareSpeakerLineage({
    fromRevisionId,
    toRevisionId,
    revisions,
    segmentsOf: (revisionId): TranscriptSegment[] | undefined => (revisions.has(revisionId) ? scope.transcripts.listSegments(owner, revisionId) : undefined),
  });
}
