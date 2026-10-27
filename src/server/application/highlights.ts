import type { HighlightRevisionDto, HighlightsDto } from "../../shared/dto/highlight.ts";
import type { HighlightRevision } from "../domain/artifact.ts";
import type { Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import { deriveFreshness, transcriptAncestors } from "../domain/freshness.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { laneKeys } from "../pipeline/lane.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";

export interface HighlightServiceOptions {
  repository: Repository;
}

/**
 * A highlight revision as the UI sees it: each item with the sentence it points at, in time
 * order, and freshness derived against the current primary and its ancestors.
 */
export function highlightRevisionDto(scope: RepositoryScope, owner: string, revision: HighlightRevision, content: Content): HighlightRevisionDto {
  const { provenance } = revision;
  const freshness = deriveFreshness(provenance.inputs, {
    ...(content.primaryTranscriptRevisionId === undefined ? {} : { primaryTranscriptRevisionId: content.primaryTranscriptRevisionId }),
    primaryAncestors: transcriptAncestors(content.primaryTranscriptRevisionId, scope.transcripts.listRevisions(owner, content.id)),
  });
  const items = revision.items
    .map((item) => {
      const segment = scope.transcripts.getSegment(owner, item.segmentId);
      if (segment === undefined || segment.revisionId !== revision.transcriptRevisionId) {
        throw amberError("internal", "a highlight points outside its transcript revision");
      }
      return { segmentId: item.segmentId, score: item.score, text: item.text, segmentText: segment.text, startMs: segment.startMs, endMs: segment.endMs };
    })
    .sort((a, b) => a.startMs - b.startMs);
  return {
    id: revision.id,
    artifactId: revision.artifactId,
    transcriptRevisionId: revision.transcriptRevisionId,
    items,
    ...(provenance.modelRef === undefined ? {} : { modelRef: { ...provenance.modelRef } }),
    ...(provenance.promptRef === undefined ? {} : { promptRef: { ...provenance.promptRef } }),
    quality: revision.quality,
    // Highlights carry no citation markers, so no quality reason applies to them.
    qualityReasons: [],
    ...(freshness.stale ? { stale: true, staleReason: freshness.staleReason } : { stale: false }),
    createdAt: provenance.createdAt,
  };
}

/** Reading a Content's AI highlights; recomputing them is a Task. */
export class HighlightService {
  private readonly options: HighlightServiceOptions;

  constructor(options: HighlightServiceOptions) {
    this.options = options;
  }

  get(principal: RequestPrincipal, contentId: string): HighlightsDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      const artifact = scope.highlights.getArtifact(owner, contentId);
      const current = scope.highlights.getCurrent(owner, contentId);
      const active = scope.tasks
        .listByContent(owner, contentId)
        .find((task) => !isTerminalProjection(task.statusProjection) && laneKeys(task, content.source.kind).includes("highlight"));
      return {
        ...(artifact === undefined ? {} : { artifactId: artifact.id }),
        ...(current === undefined ? {} : { current: highlightRevisionDto(scope, owner, current, content) }),
        ...(active === undefined ? {} : { activeTaskId: active.id }),
      };
    });
  }
}
