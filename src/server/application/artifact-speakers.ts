import type { SpeakerContextDto } from "../../shared/dto/speaker-context.ts";
import type { ChapterRevision, HighlightRevision, SummaryRevision } from "../domain/artifact.ts";
import type { SpeakerContextSnapshot } from "../domain/speaker-context.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import type { SpeakerLineageReader } from "./speaker-lineage.ts";

/**
 * Whether the speakers a stored result was generated with still hold, as the result's DTOs
 * show it. Nothing here is stored, and nothing is regenerated or removed because of it: a
 * result that no longer holds is only marked.
 */

interface SpeakerContextInput {
  contentId: string;
  /** The transcript revision the result read. */
  transcriptRevisionId: string;
  snapshot: SpeakerContextSnapshot | undefined;
  /** The sentences the result cites; read only when there is a snapshot. */
  cited: () => Iterable<string>;
}

/**
 * The speaker context of a result: absent when it was generated without speakers, or when
 * its transcript is no longer the primary or one of its ancestors (its text is stale then,
 * which says more than any speaker state could).
 */
export function speakerContextDto(scope: RepositoryScope, owner: string, lineage: SpeakerLineageReader, input: SpeakerContextInput): SpeakerContextDto | undefined {
  const { snapshot } = input;
  if (snapshot === undefined) {
    return undefined;
  }
  const result = lineage.state(scope, owner, {
    contentId: input.contentId,
    generatedFromRevisionId: input.transcriptRevisionId,
    snapshot,
    citedSegmentIds: input.cited(),
  });
  if (result === undefined) {
    return undefined;
  }
  return {
    state: result.state,
    speakers: snapshot.speakers.map((speaker) => ({ id: speaker.id, label: speaker.label })),
    ...(result.state === "attribution_changed" && result.changedSentences !== undefined && result.changedSentences > 0 ? { changedSentences: result.changedSentences } : {}),
    ...(result.state === "evidence_removed" && result.removedCitations !== undefined && result.removedCitations > 0 ? { removedCitations: result.removedCitations } : {}),
    ...(result.state === "names_changed" && result.renamed !== undefined ? { renamed: result.renamed.map((speaker) => ({ ...speaker })) } : {}),
  };
}

/** The transcript revision a summary revision read. */
export function summaryTranscriptOf(revision: SummaryRevision): string | undefined {
  return revision.provenance.inputs.find((input) => input.kind === "transcriptRevision")?.id;
}

/**
 * A summary's speaker context. Its cited sentences are those of its body and, for a long
 * summary, of its rolling partials: a partial's claims reach the summary through them.
 */
export function summarySpeakerContext(
  scope: RepositoryScope,
  owner: string,
  lineage: SpeakerLineageReader,
  contentId: string,
  revision: SummaryRevision,
): SpeakerContextDto | undefined {
  const transcriptRevisionId = summaryTranscriptOf(revision);
  if (transcriptRevisionId === undefined) {
    return undefined;
  }
  return speakerContextDto(scope, owner, lineage, {
    contentId,
    transcriptRevisionId,
    snapshot: revision.provenance.speakerContext,
    cited: () => [
      ...revision.citations.map((citation) => citation.segmentId),
      ...(revision.partialIds === undefined
        ? []
        : scope.rollupPartials.listByOwnerRevision(owner, revision.id).flatMap((partial) => partial.citations.map((citation) => citation.segmentId))),
    ],
  });
}

/** AI chapters' speaker context; each chapter cites the sentence it starts at. Platform chapters read no transcript. */
export function chapterSpeakerContext(
  scope: RepositoryScope,
  owner: string,
  lineage: SpeakerLineageReader,
  contentId: string,
  revision: ChapterRevision,
): SpeakerContextDto | undefined {
  if (revision.origin.kind !== "ai") {
    return undefined;
  }
  return speakerContextDto(scope, owner, lineage, {
    contentId,
    transcriptRevisionId: revision.origin.transcriptRevisionId,
    snapshot: revision.provenance.speakerContext,
    cited: () => revision.chapters.flatMap((chapter) => (chapter.startSegmentId === undefined ? [] : [chapter.startSegmentId])),
  });
}

/** Highlights' speaker context; each highlight cites its sentence. */
export function highlightSpeakerContext(
  scope: RepositoryScope,
  owner: string,
  lineage: SpeakerLineageReader,
  contentId: string,
  revision: HighlightRevision,
): SpeakerContextDto | undefined {
  return speakerContextDto(scope, owner, lineage, {
    contentId,
    transcriptRevisionId: revision.transcriptRevisionId,
    snapshot: revision.provenance.speakerContext,
    cited: () => revision.items.map((item) => item.segmentId),
  });
}
