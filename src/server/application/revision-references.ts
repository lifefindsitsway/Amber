import type { TranscriptRevisionListItemDto } from "../../shared/dto/content.ts";
import type { Content } from "../domain/content.ts";
import {
  descendantsOf,
  hasRevisionBlockers,
  PROTECTED_REVISION_KINDS,
  revisionBlockers,
  type RevisionReference,
  type TranscriptRevision,
} from "../domain/transcript.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import { transcriptRevisionDto } from "./contents.ts";

/**
 * Builds the revision list items of a Content: each revision with its archive mark, what
 * blocks deleting it alone, and the descendants a delete with descendants would also remove.
 * Revisions come oldest first, as the repository lists them.
 */
export function revisionListItems(
  scope: RepositoryScope,
  owner: string,
  content: Content,
  revisions: readonly TranscriptRevision[] = scope.transcripts.listRevisions(owner, content.id),
  references: readonly RevisionReference[] = scope.revisionReferences.listReferences(owner, content.id),
): TranscriptRevisionListItemDto[] {
  const archived = new Map(scope.transcripts.listArchived(owner, content.id).map((entry) => [entry.revisionId, entry.archivedAt]));
  return revisions.map((revision) => {
    const blockers = revisionBlockers(references, new Set([revision.id]));
    const archivedAt = archived.get(revision.id);
    const deletable =
      !PROTECTED_REVISION_KINDS.has(revision.kind) && revision.id !== content.primaryTranscriptRevisionId && !hasRevisionBlockers(blockers);
    return {
      ...transcriptRevisionDto(revision),
      archived: archivedAt !== undefined,
      ...(archivedAt === undefined ? {} : { archivedAt }),
      deletable,
      blockers,
      descendantIds: descendantsOf(revisions, revision.id),
    };
  });
}
