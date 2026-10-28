import type { RollupPartial } from "../../../domain/artifact.ts";
import type { RollupPartialRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, parseJson, parseJsonOrNull } from "./rows.ts";

interface PartialRow {
  id: string;
  summary_revision_id: string | null;
  collection_summary_revision_id: string | null;
  partial_index: number;
  inputs_json: string;
  body: string;
  citations_json: string;
  model_ref_json: string;
  prompt_ref_json: string;
  prompt_refs_json: string | null;
  prompt_snapshot: string;
  created_at: number;
}

function toPartial(row: PartialRow): RollupPartial {
  const promptRefs = parseJsonOrNull<RollupPartial["promptRefs"]>(row.prompt_refs_json);
  return {
    id: row.id,
    ownerRevisionId: (row.summary_revision_id ?? row.collection_summary_revision_id) as string,
    index: row.partial_index,
    inputs: parseJson(row.inputs_json),
    body: row.body,
    citations: parseJson(row.citations_json),
    modelRef: parseJson(row.model_ref_json),
    promptRef: parseJson(row.prompt_ref_json),
    ...(promptRefs === null || promptRefs === undefined ? {} : { promptRefs }),
    promptSnapshot: row.prompt_snapshot,
    createdAt: row.created_at,
  };
}

/** Partials reach their owner through the summary or collection-summary revision they belong to. */
export function sqliteRollupPartialRepository(db: SqliteConnection): RollupPartialRepository {
  const ownedSummaryRevision = db.prepare(
    `SELECT 1 FROM summary_revision
     JOIN summary_artifact ON summary_artifact.id = summary_revision.artifact_id
     JOIN content ON content.id = summary_artifact.content_id
     WHERE summary_revision.id = ? AND content.user_id = ?`,
  );
  const ownedCollectionSummaryRevision = db.prepare(
    `SELECT 1 FROM collection_summary_revision
     JOIN collection_summary_artifact ON collection_summary_artifact.id = collection_summary_revision.artifact_id
     JOIN collection ON collection.id = collection_summary_artifact.collection_id
     WHERE collection_summary_revision.id = ? AND collection.user_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO rollup_partial (
       id, summary_revision_id, collection_summary_revision_id, partial_index, inputs_json, body, citations_json,
       model_ref_json, prompt_ref_json, prompt_refs_json, prompt_snapshot, created_at
     ) VALUES (
       @id, @summaryRevisionId, @collectionSummaryRevisionId, @index, @inputsJson, @body, @citationsJson,
       @modelRefJson, @promptRefJson, @promptRefsJson, @promptSnapshot, @createdAt
     )`,
  );
  const byOwner = db.prepare(
    `SELECT rollup_partial.* FROM rollup_partial
     LEFT JOIN summary_revision ON summary_revision.id = rollup_partial.summary_revision_id
     LEFT JOIN summary_artifact ON summary_artifact.id = summary_revision.artifact_id
     LEFT JOIN content ON content.id = summary_artifact.content_id
     LEFT JOIN collection_summary_revision ON collection_summary_revision.id = rollup_partial.collection_summary_revision_id
     LEFT JOIN collection_summary_artifact ON collection_summary_artifact.id = collection_summary_revision.artifact_id
     LEFT JOIN collection ON collection.id = collection_summary_artifact.collection_id
     WHERE (rollup_partial.summary_revision_id = @revisionId AND content.user_id = @owner)
        OR (rollup_partial.collection_summary_revision_id = @revisionId AND collection.user_id = @owner)
     ORDER BY rollup_partial.partial_index`,
  );

  return {
    insertMany(ownerUserId, owner, partials) {
      const check = owner === "summary" ? ownedSummaryRevision : ownedCollectionSummaryRevision;
      const checked = new Set<string>();
      for (const partial of partials) {
        if (!checked.has(partial.ownerRevisionId)) {
          if (check.get(partial.ownerRevisionId, ownerUserId) === undefined) {
            throw notFound(owner === "summary" ? "summary revision" : "collection summary revision", partial.ownerRevisionId);
          }
          checked.add(partial.ownerRevisionId);
        }
        insert.run({
          id: partial.id,
          summaryRevisionId: owner === "summary" ? partial.ownerRevisionId : null,
          collectionSummaryRevisionId: owner === "collection_summary" ? partial.ownerRevisionId : null,
          index: partial.index,
          inputsJson: JSON.stringify(partial.inputs),
          body: partial.body,
          citationsJson: JSON.stringify(partial.citations),
          modelRefJson: JSON.stringify(partial.modelRef),
          promptRefJson: JSON.stringify(partial.promptRef),
          promptRefsJson: jsonOrNull(partial.promptRefs),
          promptSnapshot: partial.promptSnapshot,
          createdAt: partial.createdAt,
        });
      }
    },
    listByOwnerRevision(ownerUserId, ownerRevisionId) {
      return (byOwner.all({ revisionId: ownerRevisionId, owner: ownerUserId }) as PartialRow[]).map(toPartial);
    },
  };
}
