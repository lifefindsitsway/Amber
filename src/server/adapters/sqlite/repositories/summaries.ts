import type { SummaryArtifact, SummaryRevision } from "../../../domain/artifact.ts";
import type { SummaryRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface ArtifactRow {
  id: string;
  content_id: string;
  template_id: string;
  current_revision_id: string | null;
}

interface RevisionRow {
  id: string;
  artifact_id: string;
  inputs_json: string;
  model_ref_json: string | null;
  prompt_ref_json: string | null;
  prompt_refs_json: string | null;
  prompt_snapshot: string | null;
  quality: SummaryRevision["quality"];
  body: string;
  citations_json: string;
  chapter_revision_id: string | null;
  partial_ids_json: string | null;
  created_at: number;
}

function toArtifact(row: ArtifactRow): SummaryArtifact {
  return withoutNulls<SummaryArtifact>({
    id: row.id,
    contentId: row.content_id,
    templateId: row.template_id,
    currentRevisionId: row.current_revision_id,
  });
}

function toRevision(row: RevisionRow): SummaryRevision {
  return withoutNulls<SummaryRevision>({
    id: row.id,
    artifactId: row.artifact_id,
    provenance: withoutNulls<SummaryRevision["provenance"]>({
      inputs: parseJson(row.inputs_json),
      modelRef: parseJsonOrNull(row.model_ref_json),
      promptRef: parseJsonOrNull(row.prompt_ref_json),
      promptRefs: parseJsonOrNull(row.prompt_refs_json),
      promptSnapshot: row.prompt_snapshot,
      createdAt: row.created_at,
    }),
    quality: row.quality,
    body: row.body,
    citations: parseJson(row.citations_json),
    chapterRevisionId: row.chapter_revision_id,
    partialIds: parseJsonOrNull(row.partial_ids_json),
  });
}

/** Summary artifacts and revisions reach their owner through `content.user_id`. */
export function sqliteSummaryRepository(db: SqliteConnection): SummaryRepository {
  const ownedArtifact = db.prepare(
    `SELECT summary_artifact.* FROM summary_artifact
     JOIN content ON content.id = summary_artifact.content_id
     WHERE summary_artifact.id = ? AND content.user_id = ?`,
  );
  const artifactOf = db.prepare(
    `SELECT summary_artifact.* FROM summary_artifact
     JOIN content ON content.id = summary_artifact.content_id
     WHERE summary_artifact.content_id = ? AND summary_artifact.template_id = ? AND content.user_id = ?`,
  );
  const artifactsOf = db.prepare(
    `SELECT summary_artifact.* FROM summary_artifact
     JOIN content ON content.id = summary_artifact.content_id
     WHERE summary_artifact.content_id = ? AND content.user_id = ?
     ORDER BY summary_artifact.template_id, summary_artifact.id`,
  );
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const visibleTemplate = db.prepare("SELECT 1 FROM summary_template WHERE id = ? AND (user_id IS NULL OR user_id = ?)");
  const insertArtifact = db.prepare("INSERT INTO summary_artifact (id, content_id, template_id) VALUES (?, ?, ?)");
  const insertRevision = db.prepare(
    `INSERT INTO summary_revision (
       id, artifact_id, inputs_json, model_ref_json, prompt_ref_json, prompt_refs_json, prompt_snapshot, quality, body, citations_json,
       chapter_revision_id, partial_ids_json, created_at
     ) VALUES (
       @id, @artifactId, @inputsJson, @modelRefJson, @promptRefJson, @promptRefsJson, @promptSnapshot, @quality, @body, @citationsJson,
       @chapterRevisionId, @partialIdsJson, @createdAt
     )`,
  );
  const ownedRevision = db.prepare(
    `SELECT summary_revision.* FROM summary_revision
     JOIN summary_artifact ON summary_artifact.id = summary_revision.artifact_id
     JOIN content ON content.id = summary_artifact.content_id
     WHERE summary_revision.id = ? AND content.user_id = ?`,
  );
  const revisionsOf = db.prepare("SELECT * FROM summary_revision WHERE artifact_id = ? ORDER BY created_at, id");
  const revisionOfArtifact = db.prepare("SELECT 1 FROM summary_revision WHERE id = ? AND artifact_id = ?");
  const setCurrent = db.prepare("UPDATE summary_artifact SET current_revision_id = ? WHERE id = ?");

  return {
    getArtifact(ownerUserId, artifactId) {
      const row = ownedArtifact.get(artifactId, ownerUserId) as ArtifactRow | undefined;
      return row === undefined ? undefined : toArtifact(row);
    },
    findArtifact(ownerUserId, contentId, templateId) {
      const row = artifactOf.get(contentId, templateId, ownerUserId) as ArtifactRow | undefined;
      return row === undefined ? undefined : toArtifact(row);
    },
    listArtifacts(ownerUserId, contentId) {
      return (artifactsOf.all(contentId, ownerUserId) as ArtifactRow[]).map(toArtifact);
    },
    insertRevision(ownerUserId, input) {
      const { contentId, templateId, revision } = input;
      if (ownedContent.get(contentId, ownerUserId) === undefined) {
        throw notFound("content", contentId);
      }
      if (visibleTemplate.get(templateId, ownerUserId) === undefined) {
        throw notFound("summary template", templateId);
      }
      let artifactId = (artifactOf.get(contentId, templateId, ownerUserId) as ArtifactRow | undefined)?.id;
      if (artifactId === undefined) {
        insertArtifact.run(input.artifactId, contentId, templateId);
        artifactId = input.artifactId;
      }
      const { provenance } = revision;
      insertRevision.run({
        id: revision.id,
        artifactId,
        inputsJson: JSON.stringify(provenance.inputs),
        modelRefJson: jsonOrNull(provenance.modelRef),
        promptRefJson: jsonOrNull(provenance.promptRef),
        promptRefsJson: jsonOrNull(provenance.promptRefs),
        promptSnapshot: nullable(provenance.promptSnapshot),
        quality: revision.quality,
        body: revision.body,
        citationsJson: JSON.stringify(revision.citations),
        chapterRevisionId: nullable(revision.chapterRevisionId),
        partialIdsJson: jsonOrNull(revision.partialIds),
        createdAt: provenance.createdAt,
      });
      return { artifactId };
    },
    getRevision(ownerUserId, revisionId) {
      const row = ownedRevision.get(revisionId, ownerUserId) as RevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    listRevisions(ownerUserId, artifactId) {
      if (ownedArtifact.get(artifactId, ownerUserId) === undefined) {
        return [];
      }
      return (revisionsOf.all(artifactId) as RevisionRow[]).map(toRevision);
    },
    setCurrent(ownerUserId, artifactId, revisionId) {
      if (ownedArtifact.get(artifactId, ownerUserId) === undefined || revisionOfArtifact.get(revisionId, artifactId) === undefined) {
        throw notFound("summary revision", revisionId);
      }
      setCurrent.run(revisionId, artifactId);
    },
  };
}
