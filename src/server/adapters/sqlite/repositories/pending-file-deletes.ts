import type { PendingFileDelete } from "../../../domain/runtime-support.ts";
import type { PendingFileDeleteRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { nullable, withoutNulls } from "./rows.ts";

interface PendingFileDeleteRow {
  id: string;
  store: PendingFileDelete["store"];
  root_path: string;
  storage_ref: string;
  expected_size_bytes: number | null;
  expected_digest: string | null;
  user_id: string | null;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}

function toEntry(row: PendingFileDeleteRow): PendingFileDelete {
  return withoutNulls<PendingFileDelete>({
    id: row.id,
    store: row.store,
    rootPath: row.root_path,
    storageRef: row.storage_ref,
    expectedSizeBytes: row.expected_size_bytes,
    expectedDigest: row.expected_digest,
    userId: row.user_id,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  });
}

export function sqlitePendingFileDeleteRepository(db: SqliteConnection): PendingFileDeleteRepository {
  // The first registration of a file wins: its size and owner describe the file being purged.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pending_file_delete (
       id, store, root_path, storage_ref, expected_size_bytes, expected_digest, user_id, attempts, next_attempt_at, last_error, created_at
     ) VALUES (
       @id, @store, @rootPath, @storageRef, @expectedSizeBytes, @expectedDigest, @userId, @attempts, @nextAttemptAt, @lastError, @createdAt
     )`,
  );
  const due = db.prepare("SELECT * FROM pending_file_delete WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?");
  const byStore = db.prepare("SELECT * FROM pending_file_delete WHERE store = ? ORDER BY created_at, id");
  const reschedule = db.prepare("UPDATE pending_file_delete SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM pending_file_delete WHERE id = ?");
  const earliest = db.prepare("SELECT min(next_attempt_at) AS at FROM pending_file_delete");

  return {
    insert(entry) {
      insert.run({
        id: entry.id,
        store: entry.store,
        rootPath: entry.rootPath,
        storageRef: entry.storageRef,
        expectedSizeBytes: nullable(entry.expectedSizeBytes),
        expectedDigest: nullable(entry.expectedDigest),
        userId: nullable(entry.userId),
        attempts: entry.attempts,
        nextAttemptAt: entry.nextAttemptAt,
        lastError: nullable(entry.lastError),
        createdAt: entry.createdAt,
      });
    },
    listDue(now, limit) {
      return (due.all(now, limit) as PendingFileDeleteRow[]).map(toEntry);
    },
    listByStore(store) {
      return (byStore.all(store) as PendingFileDeleteRow[]).map(toEntry);
    },
    reschedule(id, attempts, nextAttemptAt, lastError) {
      reschedule.run(attempts, nextAttemptAt, nullable(lastError), id);
    },
    delete(id) {
      remove.run(id);
    },
    earliestAttemptAt() {
      return (earliest.get() as { at: number | null }).at ?? undefined;
    },
  };
}
