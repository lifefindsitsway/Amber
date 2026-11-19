import { monotonicFactory } from "ulid";
import type { Collection, CollectionItem } from "../../../domain/collection.ts";
import type { CollectionRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  platform_collection_id: string | null;
  origin_id: string | null;
  created_at: number;
  updated_at: number;
}

interface CollectionItemRow {
  id: string;
  collection_id: string;
  content_id: string;
  position: number;
  added_at: number;
}

function toCollection(row: CollectionRow): Collection {
  return withoutNulls<Collection>({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    platformCollectionId: row.platform_collection_id,
    originId: row.origin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toItem(row: CollectionItemRow): CollectionItem {
  return {
    id: row.id,
    collectionId: row.collection_id,
    contentId: row.content_id,
    position: row.position,
    addedAt: row.added_at,
  };
}

export function sqliteCollectionRepository(db: SqliteConnection): CollectionRepository {
  const select = db.prepare("SELECT * FROM collection WHERE id = ? AND user_id = ?");
  const list = db.prepare("SELECT * FROM collection WHERE user_id = ? ORDER BY created_at, id");
  const insert = db.prepare(
    `INSERT INTO collection (id, user_id, name, description, platform_collection_id, origin_id, created_at, updated_at)
     VALUES (@id, @userId, @name, @description, @platformCollectionId, @originId, @createdAt, @updatedAt)`,
  );
  const byPlatformId = db.prepare(
    "SELECT * FROM collection WHERE user_id = ? AND platform_collection_id = ? ORDER BY created_at, id LIMIT 1",
  );
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const insertItem = db.prepare(
    `INSERT INTO collection_item (id, collection_id, content_id, position, added_at)
     VALUES (@id, @collectionId, @contentId, @position, @addedAt)`,
  );
  const listItems = db.prepare(
    `SELECT item.* FROM collection_item AS item
     JOIN collection ON collection.id = item.collection_id
     WHERE item.collection_id = ? AND collection.user_id = ?
     ORDER BY item.position, item.id`,
  );
  const listVisibleItems = db.prepare(
    `SELECT item.* FROM collection_item AS item
     JOIN collection ON collection.id = item.collection_id
     JOIN content ON content.id = item.content_id
     WHERE item.collection_id = ? AND collection.user_id = ? AND content.trashed_at IS NULL
     ORDER BY item.position, item.id`,
  );
  const remove = db.prepare("DELETE FROM collection WHERE id = ? AND user_id = ?");
  const updateName = db.prepare("UPDATE collection SET name = ? WHERE id = ? AND user_id = ?");
  const updateDescription = db.prepare("UPDATE collection SET description = ? WHERE id = ? AND user_id = ?");
  const ownedItem = db.prepare(
    `SELECT item.* FROM collection_item AS item
     JOIN collection ON collection.id = item.collection_id
     WHERE item.id = ? AND collection.user_id = ?`,
  );
  const itemByContent = db.prepare(
    `SELECT item.* FROM collection_item AS item
     JOIN collection ON collection.id = item.collection_id
     WHERE item.collection_id = ? AND item.content_id = ? AND collection.user_id = ?`,
  );
  const removeItem = db.prepare(
    `DELETE FROM collection_item
     WHERE id = ? AND collection_id = ? AND collection_id IN (SELECT id FROM collection WHERE user_id = ?)`,
  );
  const touch = db.prepare("UPDATE collection SET updated_at = ? WHERE id = ? AND user_id = ?");
  const touchByContent = db.prepare(
    `UPDATE collection SET updated_at = ?
     WHERE user_id = ? AND id IN (SELECT collection_id FROM collection_item WHERE content_id = ?)`,
  );
  const setPosition = db.prepare("UPDATE collection_item SET position = ? WHERE id = ? AND collection_id = ?");
  const memberships = db.prepare(
    `SELECT item.content_id AS contentId, collection.id AS id, collection.name AS name, item.id AS itemId FROM collection_item AS item
     JOIN collection ON collection.id = item.collection_id
     WHERE collection.user_id = @owner AND item.content_id IN (SELECT value FROM json_each(@contentIds))
     ORDER BY item.added_at, item.id`,
  );

  const newItemId = monotonicFactory();
  // Its own (nested) transaction, so a refused order leaves every position as it was even when
  // the caller catches the error and carries on.
  const renumberRows = (ownerUserId: string, collectionId: string, contentIds: readonly string[], addedAt: number): void => {
    if (select.get(collectionId, ownerUserId) === undefined) {
      throw notFound("collection", collectionId);
    }
    const items = new Map((listItems.all(collectionId, ownerUserId) as CollectionItemRow[]).map((row) => [row.content_id, row]));
    const named = new Set(contentIds);
    if (named.size !== contentIds.length || [...items.keys()].some((contentId) => !named.has(contentId))) {
      throw new TypeError("the new order must name every member of the collection exactly once");
    }
    for (const contentId of contentIds) {
      if (!items.has(contentId) && ownedContent.get(contentId, ownerUserId) === undefined) {
        throw notFound("content", contentId);
      }
    }
    // Position carries no uniqueness constraint, so rows can be rewritten one by one; the
    // fresh positions are dense, which also settles any ties the old ones had.
    contentIds.forEach((contentId, position) => {
      const item = items.get(contentId);
      if (item === undefined) {
        insertItem.run({ id: newItemId(), collectionId, contentId, position, addedAt });
      } else if (item.position !== position) {
        setPosition.run(position, item.id, collectionId);
      }
    });
  };

  return {
    get(ownerUserId, collectionId) {
      const row = select.get(collectionId, ownerUserId) as CollectionRow | undefined;
      return row === undefined ? undefined : toCollection(row);
    },
    list(ownerUserId) {
      return (list.all(ownerUserId) as CollectionRow[]).map(toCollection);
    },
    insert(collection) {
      insert.run({
        id: collection.id,
        userId: collection.userId,
        name: collection.name,
        description: nullable(collection.description),
        platformCollectionId: nullable(collection.platformCollectionId),
        originId: nullable(collection.originId),
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
      });
    },
    findByPlatformCollectionId(ownerUserId, platformCollectionId) {
      const row = byPlatformId.get(ownerUserId, platformCollectionId) as CollectionRow | undefined;
      return row === undefined ? undefined : toCollection(row);
    },
    addItem(ownerUserId, item) {
      if (select.get(item.collectionId, ownerUserId) === undefined) {
        throw notFound("collection", item.collectionId);
      }
      if (ownedContent.get(item.contentId, ownerUserId) === undefined) {
        throw notFound("content", item.contentId);
      }
      insertItem.run({ ...item });
    },
    listItems(ownerUserId, collectionId) {
      return (listItems.all(collectionId, ownerUserId) as CollectionItemRow[]).map(toItem);
    },
    listVisibleItems(ownerUserId, collectionId) {
      return (listVisibleItems.all(collectionId, ownerUserId) as CollectionItemRow[]).map(toItem);
    },
    update(ownerUserId, collectionId, patch) {
      if (select.get(collectionId, ownerUserId) === undefined) {
        throw notFound("collection", collectionId);
      }
      if (patch.name !== undefined) {
        updateName.run(patch.name, collectionId, ownerUserId);
      }
      if ("description" in patch) {
        updateDescription.run(nullable(patch.description), collectionId, ownerUserId);
      }
    },
    getItem(ownerUserId, itemId) {
      const row = ownedItem.get(itemId, ownerUserId) as CollectionItemRow | undefined;
      return row === undefined ? undefined : toItem(row);
    },
    findItem(ownerUserId, collectionId, contentId) {
      const row = itemByContent.get(collectionId, contentId, ownerUserId) as CollectionItemRow | undefined;
      return row === undefined ? undefined : toItem(row);
    },
    removeItem(ownerUserId, collectionId, itemId) {
      return removeItem.run(itemId, collectionId, ownerUserId).changes > 0;
    },
    renumber(ownerUserId, collectionId, contentIds, addedAt) {
      db.transaction(() => renumberRows(ownerUserId, collectionId, contentIds, addedAt))();
    },
    reorder(ownerUserId, collectionId, itemIds) {
      if (select.get(collectionId, ownerUserId) === undefined) {
        throw notFound("collection", collectionId);
      }
      const positions = new Map((listItems.all(collectionId, ownerUserId) as CollectionItemRow[]).map((row) => [row.id, row.position]));
      const wanted = new Set(itemIds);
      if (wanted.size !== itemIds.length || itemIds.some((id) => !positions.has(id))) {
        throw new TypeError("the new order must name items of the collection, each at most once");
      }
      const slots = itemIds.map((id) => positions.get(id) as number).sort((a, b) => a - b);
      // Position carries no uniqueness constraint, so rows can be rewritten one by one.
      itemIds.forEach((id, index) => setPosition.run(slots[index], id, collectionId));
    },
    touch(ownerUserId, collectionId, at) {
      touch.run(at, collectionId, ownerUserId);
    },
    touchByContent(ownerUserId, contentId, at) {
      touchByContent.run(at, ownerUserId, contentId);
    },
    delete(ownerUserId, collectionId) {
      return remove.run(collectionId, ownerUserId).changes > 0;
    },
    membershipsOf(ownerUserId, contentIds) {
      const result = new Map(contentIds.map((contentId) => [contentId, [] as Array<{ id: string; name: string; itemId: string }>]));
      const rows = memberships.all({ owner: ownerUserId, contentIds: JSON.stringify(contentIds) }) as Array<{ contentId: string; id: string; name: string; itemId: string }>;
      for (const row of rows) {
        result.get(row.contentId)?.push({ id: row.id, name: row.name, itemId: row.itemId });
      }
      return result;
    },
  };
}
