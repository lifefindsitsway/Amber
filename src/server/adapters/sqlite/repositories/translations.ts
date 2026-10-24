import type { TranslationArtifact } from "../../../domain/artifact.ts";
import type { TranslationRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, withoutNulls } from "./rows.ts";

interface TranslationArtifactRow {
  id: string;
  content_id: string;
  target_language: string;
  current_revision_id: string | null;
}

function toArtifact(row: TranslationArtifactRow): TranslationArtifact {
  return withoutNulls<TranslationArtifact>({
    id: row.id,
    contentId: row.content_id,
    targetLanguage: row.target_language,
    currentRevisionId: row.current_revision_id,
  });
}

export function sqliteTranslationRepository(db: SqliteConnection): TranslationRepository {
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const artifactOf = db.prepare(
    `SELECT translation_artifact.* FROM translation_artifact
     JOIN content ON content.id = translation_artifact.content_id
     WHERE translation_artifact.content_id = ? AND translation_artifact.target_language = ? AND content.user_id = ?`,
  );
  const artifactsOf = db.prepare(
    `SELECT translation_artifact.* FROM translation_artifact
     JOIN content ON content.id = translation_artifact.content_id
     WHERE translation_artifact.content_id = ? AND content.user_id = ?
     ORDER BY translation_artifact.target_language`,
  );
  const translatedRevision = db.prepare(
    "SELECT 1 FROM transcript_revision WHERE id = ? AND content_id = ? AND kind = 'translated' AND language = ?",
  );
  const insertArtifact = db.prepare(
    "INSERT INTO translation_artifact (id, content_id, target_language, current_revision_id) VALUES (?, ?, ?, ?)",
  );
  const setCurrent = db.prepare("UPDATE translation_artifact SET current_revision_id = ? WHERE id = ?");
  const deleteArtifact = db.prepare(
    `DELETE FROM translation_artifact
     WHERE content_id = ? AND target_language = ? AND content_id IN (SELECT id FROM content WHERE user_id = ?)`,
  );

  return {
    getArtifact(ownerUserId, contentId, targetLanguage) {
      const row = artifactOf.get(contentId, targetLanguage, ownerUserId) as TranslationArtifactRow | undefined;
      return row === undefined ? undefined : toArtifact(row);
    },
    listArtifacts(ownerUserId, contentId) {
      return (artifactsOf.all(contentId, ownerUserId) as TranslationArtifactRow[]).map(toArtifact);
    },
    setCurrent(ownerUserId, contentId, targetLanguage, revisionId, artifactId) {
      if (ownedContent.get(contentId, ownerUserId) === undefined) {
        throw notFound("content", contentId);
      }
      if (translatedRevision.get(revisionId, contentId, targetLanguage) === undefined) {
        throw notFound("translated revision", revisionId);
      }
      const existing = artifactOf.get(contentId, targetLanguage, ownerUserId) as TranslationArtifactRow | undefined;
      if (existing === undefined) {
        insertArtifact.run(artifactId, contentId, targetLanguage, revisionId);
      } else {
        setCurrent.run(revisionId, existing.id);
      }
    },
    deleteArtifact(ownerUserId, contentId, targetLanguage) {
      return deleteArtifact.run(contentId, targetLanguage, ownerUserId).changes > 0;
    },
  };
}
