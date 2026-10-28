import type { CollectionSummaryArtifact, CollectionSummaryRevision } from "../../../domain/artifact.ts";
import type { CollectionSummaryRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface ArtifactRow {
  id: string;
  collection_id: string;
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
  quality: CollectionSummaryRevision["quality"];
  input_items_json: string;
  partial_ids_json: string;
  body: string;
  citations_json: string;
  created_at: number;
}

function toRevision(row: RevisionRow): CollectionSummaryRevision {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    provenance: withoutNulls<CollectionSummaryRevision["provenance"]>({
      inputs: parseJson(row.inputs_json),
      modelRef: parseJsonOrNull(row.model_ref_json),
      promptRef: parseJsonOrNull(row.prompt_ref_json),
      promptRefs: parseJsonOrNull(row.prompt_refs_json),
      promptSnapshot: row.prompt_snapshot,
      createdAt: row.created_at,
    }),
    quality: row.quality,
    inputItems: parseJson(row.input_items_json),
    partialIds: parseJson(row.partial_ids_json),
    body: row.body,
    citations: parseJson(row.citations_json),
  };
}

/** A collection has at most one summary artifact; everything reaches its owner through `collection.user_id`. */
export function sqliteCollectionSummaryRepository(db: SqliteConnection): CollectionSummaryRepository {
  const artifactOf = db.prepare(
    `SELECT collection_summary_artifact.* FROM collection_summary_artifact
     JOIN collection ON collection.id = collection_summary_artifact.collection_id
     WHERE collection_summary_artifact.collection_id = ? AND collection.user_id = ?`,
  );
  const ownedCollection = db.prepare("SELECT 1 FROM collection WHERE id = ? AND user_id = ?");
  const insertArtifact = db.prepare("INSERT INTO collection_summary_artifact (id, collection_id) VALUES (?, ?)");
  const insertRevision = db.prepare(
    `INSERT INTO collection_summary_revision (
       id, artifact_id, inputs_json, model_ref_json, prompt_ref_json, prompt_refs_json, prompt_snapshot, quality, input_items_json,
       partial_ids_json, body, citations_json, created_at
     ) VALUES (
       @id, @artifactId, @inputsJson, @modelRefJson, @promptRefJson, @promptRefsJson, @promptSnapshot, @quality, @inputItemsJson,
       @partialIdsJson, @body, @citationsJson, @createdAt
     )`,
  );
  const ownedRevision = db.prepare(
    `SELECT collection_summary_revision.* FROM collection_summary_revision
     JOIN collection_summary_artifact ON collection_summary_artifact.id = collection_summary_revision.artifact_id
     JOIN collection ON collection.id = collection_summary_artifact.collection_id
     WHERE collection_summary_revision.id = ? AND collection.user_id = ?`,
  );
  const revisionsOf = db.prepare("SELECT * FROM collection_summary_revision WHERE artifact_id = ? ORDER BY created_at, id");
  const revisionOfArtifact = db.prepare("SELECT * FROM collection_summary_revision WHERE id = ? AND artifact_id = ?");
  const setCurrent = db.prepare("UPDATE collection_summary_artifact SET current_revision_id = ? WHERE id = ?");
  const deleteRevisions = db.prepare("DELETE FROM collection_summary_revision WHERE artifact_id = ?");
  const deleteArtifact = db.prepare("DELETE FROM collection_summary_artifact WHERE id = ?");

  const artifact = (ownerUserId: string, collectionId: string) => artifactOf.get(collectionId, ownerUserId) as ArtifactRow | undefined;

  return {
    getArtifact(ownerUserId, collectionId) {
      const row = artifact(ownerUserId, collectionId);
      return row === undefined
        ? undefined
        : withoutNulls<CollectionSummaryArtifact>({ id: row.id, collectionId: row.collection_id, currentRevisionId: row.current_revision_id });
    },
    insertRevision(ownerUserId, input) {
      const { collectionId, revision } = input;
      if (ownedCollection.get(collectionId, ownerUserId) === undefined) {
        throw notFound("collection", collectionId);
      }
      let artifactId = artifact(ownerUserId, collectionId)?.id;
      if (artifactId === undefined) {
        insertArtifact.run(input.artifactId, collectionId);
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
        inputItemsJson: JSON.stringify(revision.inputItems),
        partialIdsJson: JSON.stringify(revision.partialIds),
        body: revision.body,
        citationsJson: JSON.stringify(revision.citations),
        createdAt: provenance.createdAt,
      });
      return { artifactId };
    },
    getRevision(ownerUserId, revisionId) {
      const row = ownedRevision.get(revisionId, ownerUserId) as RevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    listRevisions(ownerUserId, collectionId) {
      const found = artifact(ownerUserId, collectionId);
      return found === undefined ? [] : (revisionsOf.all(found.id) as RevisionRow[]).map(toRevision);
    },
    getCurrent(ownerUserId, collectionId) {
      const found = artifact(ownerUserId, collectionId);
      if (found?.current_revision_id == null) {
        return undefined;
      }
      const row = revisionOfArtifact.get(found.current_revision_id, found.id) as RevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    setCurrent(ownerUserId, collectionId, revisionId) {
      const found = artifact(ownerUserId, collectionId);
      if (found === undefined || revisionOfArtifact.get(revisionId, found.id) === undefined) {
        throw notFound("collection summary revision", revisionId);
      }
      setCurrent.run(revisionId, found.id);
    },
    deleteArtifact(ownerUserId, collectionId) {
      const found = artifact(ownerUserId, collectionId);
      if (found === undefined) {
        return false;
      }
      // The artifact's current pointer is an immediate foreign key into its revisions, so it is
      // cleared before they go. Deleting the revisions cascades to their partials; triggers on
      // both unlink the usage rows that named them.
      setCurrent.run(null, found.id);
      deleteRevisions.run(found.id);
      deleteArtifact.run(found.id);
      return true;
    },
  };
}
