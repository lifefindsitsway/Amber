import type { IdempotencyRecord } from "../../../domain/runtime-support.ts";
import type { IdempotencyRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";

interface IdempotencyRow {
  user_id: string;
  route: string;
  idempotency_key: string;
  request_digest: string;
  response_status: number;
  response_body_json: string;
  resource_refs_json: string;
  created_at: number;
}

export function sqliteIdempotencyRepository(db: SqliteConnection): IdempotencyRepository {
  const select = db.prepare("SELECT * FROM idempotency_record WHERE user_id = ? AND route = ? AND idempotency_key = ?");
  const insert = db.prepare(
    `INSERT INTO idempotency_record (
       user_id, route, idempotency_key, request_digest, response_status, response_body_json, resource_refs_json, created_at
     ) VALUES (@userId, @route, @key, @requestDigest, @responseStatus, @responseBodyJson, @resourceRefsJson, @createdAt)`,
  );

  // A record is tied to the revisions when any created resource id is one of them or the
  // response carries one as `transcriptRevisionId`.
  const deleteReferencing = db.prepare(
    `DELETE FROM idempotency_record
     WHERE user_id = @userId
       AND (
         EXISTS (SELECT 1 FROM json_each(resource_refs_json) AS ref WHERE ref.value IN (SELECT value FROM json_each(@ids)))
         OR json_extract(response_body_json, '$.transcriptRevisionId') IN (SELECT value FROM json_each(@ids))
       )`,
  );

  // Each created resource id among `ids` becomes `toId`, keeping the order of the list.
  const rebind = db.prepare(
    `UPDATE idempotency_record
     SET resource_refs_json = (
       SELECT json_group_array(CASE WHEN ref.value IN (SELECT value FROM json_each(@ids)) THEN @toId ELSE ref.value END)
       FROM (SELECT value FROM json_each(idempotency_record.resource_refs_json) ORDER BY key) AS ref
     )
     WHERE user_id = @userId
       AND EXISTS (SELECT 1 FROM json_each(resource_refs_json) AS ref WHERE ref.value IN (SELECT value FROM json_each(@ids)))`,
  );

  return {
    get(ownerUserId, route, key): IdempotencyRecord | undefined {
      const row = select.get(ownerUserId, route, key) as IdempotencyRow | undefined;
      return row === undefined
        ? undefined
        : {
            userId: row.user_id,
            route: row.route,
            key: row.idempotency_key,
            requestDigest: row.request_digest,
            responseStatus: row.response_status,
            responseBodyJson: row.response_body_json,
            resourceRefsJson: row.resource_refs_json,
            createdAt: row.created_at,
          };
    },
    insert(record) {
      insert.run({ ...record });
    },
    rebindResourceRefs(ownerUserId, fromIds, toId) {
      if (fromIds.length === 0) {
        return 0;
      }
      return rebind.run({ userId: ownerUserId, ids: JSON.stringify(fromIds), toId }).changes;
    },
    deleteReferencingRevisions(ownerUserId, revisionIds) {
      if (revisionIds.length === 0) {
        return 0;
      }
      return deleteReferencing.run({ userId: ownerUserId, ids: JSON.stringify(revisionIds) }).changes;
    },
  };
}
