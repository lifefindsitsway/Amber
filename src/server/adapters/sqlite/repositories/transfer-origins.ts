import type { Collection } from "../../../domain/collection.ts";
import type { Content } from "../../../domain/content.ts";
import type { TransferOriginRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { sqliteCollectionRepository } from "./collections.ts";
import { sqliteContentRepository } from "./contents.ts";

/**
 * Transfer identities and the user's merge choices. Every query names the owner; the maps'
 * composite foreign keys keep each row in its owner's library and drop it with its target.
 * Identity lookups include trashed Contents: an identity in the trash still matches, so the
 * import preview can say so instead of creating a second copy.
 */
export function sqliteTransferOriginRepository(db: SqliteConnection): TransferOriginRepository {
  const contents = sqliteContentRepository(db);
  const collections = sqliteCollectionRepository(db);
  const contentTargets = db.prepare("SELECT content_id FROM content_origin_map WHERE user_id = ? AND origin_id = ? ORDER BY created_at, content_id");
  // OR IGNORE: merging into the same target again is a no-op; the foreign key still refuses a
  // target that is not the owner's.
  const addContentTarget = db.prepare("INSERT OR IGNORE INTO content_origin_map (user_id, origin_id, content_id, created_at) VALUES (?, ?, ?, ?)");
  const collectionTargets = db.prepare(
    "SELECT collection_id FROM collection_origin_map WHERE user_id = ? AND origin_id = ? ORDER BY created_at, collection_id",
  );
  const addCollectionTarget = db.prepare(
    "INSERT OR IGNORE INTO collection_origin_map (user_id, origin_id, collection_id, created_at) VALUES (?, ?, ?, ?)",
  );
  const contentsByIdentity = db.prepare(
    "SELECT id FROM content WHERE user_id = @owner AND (origin_id = @origin OR (origin_id IS NULL AND id = @origin)) ORDER BY created_at, id",
  );
  const collectionsByIdentity = db.prepare(
    "SELECT id FROM collection WHERE user_id = @owner AND (origin_id = @origin OR (origin_id IS NULL AND id = @origin)) ORDER BY created_at, id",
  );

  return {
    contentTargets(ownerUserId, originId) {
      return (contentTargets.all(ownerUserId, originId) as Array<{ content_id: string }>).map((row) => row.content_id);
    },
    addContentTarget(ownerUserId, originId, contentId, now) {
      addContentTarget.run(ownerUserId, originId, contentId, now);
    },
    collectionTargets(ownerUserId, originId) {
      return (collectionTargets.all(ownerUserId, originId) as Array<{ collection_id: string }>).map((row) => row.collection_id);
    },
    addCollectionTarget(ownerUserId, originId, collectionId, now) {
      addCollectionTarget.run(ownerUserId, originId, collectionId, now);
    },
    contentsByIdentity(ownerUserId, originId) {
      const ids = (contentsByIdentity.all({ owner: ownerUserId, origin: originId }) as Array<{ id: string }>).map((row) => row.id);
      return ids.flatMap((id): Content[] => {
        const content = contents.getIncludingTrashed(ownerUserId, id);
        return content === undefined ? [] : [content];
      });
    },
    collectionsByIdentity(ownerUserId, originId) {
      const ids = (collectionsByIdentity.all({ owner: ownerUserId, origin: originId }) as Array<{ id: string }>).map((row) => row.id);
      return ids.flatMap((id): Collection[] => {
        const collection = collections.get(ownerUserId, id);
        return collection === undefined ? [] : [collection];
      });
    },
  };
}
