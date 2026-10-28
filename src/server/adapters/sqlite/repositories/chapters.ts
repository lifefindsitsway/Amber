import type { ArtifactInputRef, ChapterArtifact, ChapterRevision } from "../../../domain/artifact.ts";
import { canonicalJson } from "../../../domain/canonical-json.ts";
import type { ChapterRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface ChapterRevisionRow {
  id: string;
  artifact_id: string;
  inputs_json: string;
  model_ref_json: string | null;
  prompt_ref_json: string | null;
  prompt_refs_json: string | null;
  prompt_snapshot: string | null;
  quality: ChapterRevision["quality"];
  origin_json: string;
  chapters_json: string;
  created_at: number;
}

function toRevision(row: ChapterRevisionRow): ChapterRevision {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    provenance: withoutNulls<ChapterRevision["provenance"]>({
      inputs: parseJson(row.inputs_json),
      modelRef: parseJsonOrNull(row.model_ref_json),
      promptRef: parseJsonOrNull(row.prompt_ref_json),
      promptRefs: parseJsonOrNull(row.prompt_refs_json),
      promptSnapshot: row.prompt_snapshot,
      createdAt: row.created_at,
    }),
    quality: row.quality,
    origin: parseJson(row.origin_json),
    chapters: parseJson(row.chapters_json),
  };
}

export function sqliteChapterRepository(db: SqliteConnection): ChapterRepository {
  const platformChapters = db.prepare(
    `SELECT 1 FROM chapter_revision
     JOIN chapter_artifact ON chapter_artifact.id = chapter_revision.artifact_id
     JOIN content ON content.id = chapter_artifact.content_id
     WHERE chapter_artifact.content_id = ? AND content.user_id = ?
       AND json_extract(chapter_revision.origin_json, '$.kind') = 'platform'
     LIMIT 1`,
  );
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const artifactOf = db.prepare(
    `SELECT chapter_artifact.id, chapter_artifact.current_revision_id FROM chapter_artifact
     JOIN content ON content.id = chapter_artifact.content_id
     WHERE chapter_artifact.content_id = ? AND content.user_id = ?`,
  );
  const insertArtifact = db.prepare("INSERT INTO chapter_artifact (id, content_id) VALUES (?, ?)");
  const platformRevisions = db.prepare(
    `SELECT * FROM chapter_revision WHERE artifact_id = ? AND json_extract(origin_json, '$.kind') = 'platform'
     ORDER BY created_at, id`,
  );
  const insertRevision = db.prepare(
    `INSERT INTO chapter_revision (id, artifact_id, inputs_json, quality, origin_json, chapters_json, created_at)
     VALUES (@id, @artifactId, '[]', 'normal', @originJson, @chaptersJson, @createdAt)`,
  );
  const insertAiRevision = db.prepare(
    `INSERT INTO chapter_revision (
       id, artifact_id, inputs_json, model_ref_json, prompt_ref_json, prompt_refs_json, prompt_snapshot, quality, origin_json, chapters_json, created_at
     ) VALUES (
       @id, @artifactId, @inputsJson, @modelRefJson, @promptRefJson, @promptRefsJson, @promptSnapshot, @quality, @originJson, @chaptersJson, @createdAt
     )`,
  );
  const transcriptOfContent = db.prepare("SELECT 1 FROM transcript_revision WHERE id = ? AND content_id = ?");
  const ownedRevision = db.prepare(
    `SELECT chapter_revision.* FROM chapter_revision
     JOIN chapter_artifact ON chapter_artifact.id = chapter_revision.artifact_id
     JOIN content ON content.id = chapter_artifact.content_id
     WHERE chapter_revision.id = ? AND content.user_id = ?`,
  );
  const revisionsOfArtifact = db.prepare("SELECT * FROM chapter_revision WHERE artifact_id = ? ORDER BY created_at, id");
  const revisionOfArtifact = db.prepare("SELECT * FROM chapter_revision WHERE id = ? AND artifact_id = ?");
  const setCurrent = db.prepare("UPDATE chapter_artifact SET current_revision_id = ? WHERE id = ?");

  function artifact(ownerUserId: string, contentId: string) {
    return artifactOf.get(contentId, ownerUserId) as { id: string; current_revision_id: string | null } | undefined;
  }

  return {
    hasPlatformChapters(ownerUserId, contentId) {
      return platformChapters.get(contentId, ownerUserId) !== undefined;
    },
    insertPlatformRevision(ownerUserId, contentId, revision) {
      if (ownedContent.get(contentId, ownerUserId) === undefined) {
        throw notFound("content", contentId);
      }
      let artifactId = artifact(ownerUserId, contentId)?.id;
      if (artifactId === undefined) {
        insertArtifact.run(revision.artifactId, contentId);
        artifactId = revision.artifactId;
      }
      const chaptersJson = canonicalJson(revision.chapters.map(({ startMs, endMs, title }) => ({ startMs, endMs, title })));
      for (const row of platformRevisions.all(artifactId) as ChapterRevisionRow[]) {
        if (canonicalJson(parseJson(row.chapters_json)) === chaptersJson) {
          return { revisionId: row.id, created: false };
        }
      }
      insertRevision.run({
        id: revision.id,
        artifactId,
        originJson: JSON.stringify({ kind: "platform" }),
        chaptersJson,
        createdAt: revision.createdAt,
      });
      return { revisionId: revision.id, created: true };
    },
    insertAiRevision(ownerUserId, contentId, revision) {
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
      insertAiRevision.run({
        id: revision.id,
        artifactId,
        inputsJson: JSON.stringify(inputs),
        modelRefJson: JSON.stringify(revision.modelRef),
        promptRefJson: JSON.stringify(revision.promptRef),
        promptRefsJson: jsonOrNull(revision.promptRefs),
        promptSnapshot: revision.promptSnapshot,
        quality: revision.quality,
        originJson: JSON.stringify({ kind: "ai", transcriptRevisionId: revision.transcriptRevisionId }),
        chaptersJson: JSON.stringify(revision.chapters),
        createdAt: revision.createdAt,
      });
    },
    getArtifact(ownerUserId, contentId) {
      const found = artifact(ownerUserId, contentId);
      return found === undefined
        ? undefined
        : withoutNulls<ChapterArtifact>({ id: found.id, contentId, currentRevisionId: found.current_revision_id });
    },
    getRevision(ownerUserId, revisionId) {
      const row = ownedRevision.get(revisionId, ownerUserId) as ChapterRevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    listRevisions(ownerUserId, contentId) {
      const found = artifact(ownerUserId, contentId);
      return found === undefined ? [] : (revisionsOfArtifact.all(found.id) as ChapterRevisionRow[]).map(toRevision);
    },
    getCurrent(ownerUserId, contentId) {
      const found = artifact(ownerUserId, contentId);
      if (found?.current_revision_id == null) {
        return undefined;
      }
      const row = revisionOfArtifact.get(found.current_revision_id, found.id) as ChapterRevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    setCurrent(ownerUserId, contentId, revisionId) {
      const found = artifact(ownerUserId, contentId);
      if (found === undefined || revisionOfArtifact.get(revisionId, found.id) === undefined) {
        throw notFound("chapter revision", revisionId);
      }
      setCurrent.run(revisionId, found.id);
    },
  };
}
