import type { ArtifactInputRef, HighlightArtifact, HighlightRevision } from "../../../domain/artifact.ts";
import type { HighlightRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface HighlightRevisionRow {
  id: string;
  artifact_id: string;
  inputs_json: string;
  model_ref_json: string | null;
  prompt_ref_json: string | null;
  prompt_refs_json: string | null;
  prompt_snapshot: string | null;
  quality: HighlightRevision["quality"];
  transcript_revision_id: string;
  items_json: string;
  created_at: number;
}

function toRevision(row: HighlightRevisionRow): HighlightRevision {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    provenance: withoutNulls<HighlightRevision["provenance"]>({
      inputs: parseJson(row.inputs_json),
      modelRef: parseJsonOrNull(row.model_ref_json),
      promptRef: parseJsonOrNull(row.prompt_ref_json),
      promptRefs: parseJsonOrNull(row.prompt_refs_json),
      promptSnapshot: row.prompt_snapshot,
      createdAt: row.created_at,
    }),
    quality: row.quality,
    transcriptRevisionId: row.transcript_revision_id,
    items: parseJson(row.items_json),
  };
}

export function sqliteHighlightRepository(db: SqliteConnection): HighlightRepository {
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const artifactOf = db.prepare(
    `SELECT highlight_artifact.id, highlight_artifact.current_revision_id FROM highlight_artifact
     JOIN content ON content.id = highlight_artifact.content_id
     WHERE highlight_artifact.content_id = ? AND content.user_id = ?`,
  );
  const insertArtifact = db.prepare("INSERT INTO highlight_artifact (id, content_id) VALUES (?, ?)");
  const insertRevision = db.prepare(
    `INSERT INTO highlight_revision (
       id, artifact_id, inputs_json, model_ref_json, prompt_ref_json, prompt_refs_json, prompt_snapshot, quality, transcript_revision_id, items_json, created_at
     ) VALUES (
       @id, @artifactId, @inputsJson, @modelRefJson, @promptRefJson, @promptRefsJson, @promptSnapshot, @quality, @transcriptRevisionId, @itemsJson, @createdAt
     )`,
  );
  const transcriptOfContent = db.prepare("SELECT 1 FROM transcript_revision WHERE id = ? AND content_id = ?");
  const ownedRevision = db.prepare(
    `SELECT highlight_revision.* FROM highlight_revision
     JOIN highlight_artifact ON highlight_artifact.id = highlight_revision.artifact_id
     JOIN content ON content.id = highlight_artifact.content_id
     WHERE highlight_revision.id = ? AND content.user_id = ?`,
  );
  const revisionOfArtifact = db.prepare("SELECT * FROM highlight_revision WHERE id = ? AND artifact_id = ?");
  const setCurrent = db.prepare("UPDATE highlight_artifact SET current_revision_id = ? WHERE id = ?");

  function artifact(ownerUserId: string, contentId: string) {
    return artifactOf.get(contentId, ownerUserId) as { id: string; current_revision_id: string | null } | undefined;
  }

  return {
    insertRevision(ownerUserId, contentId, revision) {
      if (ownedContent.get(contentId, ownerUserId) === undefined) {
        throw notFound("content", contentId);
      }
      if (transcriptOfContent.get(revision.transcriptRevisionId, contentId) === undefined) {
        throw notFound("transcript revision", revision.transcriptRevisionId);
      }
      let artifactId = artifact(ownerUserId, contentId)?.id;
      if (artifactId === undefined) {
        insertArtifact.run(revision.artifactId, contentId);
        artifactId = revision.artifactId;
      }
      const inputs: ArtifactInputRef[] = [{ kind: "transcriptRevision", id: revision.transcriptRevisionId }];
      insertRevision.run({
        id: revision.id,
        artifactId,
        inputsJson: JSON.stringify(inputs),
        modelRefJson: JSON.stringify(revision.modelRef),
        promptRefJson: JSON.stringify(revision.promptRef),
        promptRefsJson: jsonOrNull(revision.promptRefs),
        promptSnapshot: revision.promptSnapshot,
        quality: revision.quality,
        transcriptRevisionId: revision.transcriptRevisionId,
        itemsJson: JSON.stringify(revision.items),
        createdAt: revision.createdAt,
      });
    },
    getArtifact(ownerUserId, contentId) {
      const found = artifact(ownerUserId, contentId);
      return found === undefined
        ? undefined
        : withoutNulls<HighlightArtifact>({ id: found.id, contentId, currentRevisionId: found.current_revision_id });
    },
    getRevision(ownerUserId, revisionId) {
      const row = ownedRevision.get(revisionId, ownerUserId) as HighlightRevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    getCurrent(ownerUserId, contentId) {
      const found = artifact(ownerUserId, contentId);
      if (found?.current_revision_id == null) {
        return undefined;
      }
      const row = revisionOfArtifact.get(found.current_revision_id, found.id) as HighlightRevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    setCurrent(ownerUserId, contentId, revisionId) {
      const found = artifact(ownerUserId, contentId);
      if (found === undefined || revisionOfArtifact.get(revisionId, found.id) === undefined) {
        throw notFound("highlight revision", revisionId);
      }
      setCurrent.run(revisionId, found.id);
    },
  };
}
