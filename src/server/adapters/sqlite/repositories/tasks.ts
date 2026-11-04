import type { Task } from "../../../domain/task.ts";
import type { TaskRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface TaskRow {
  id: string;
  user_id: string;
  content_id: string | null;
  collection_id: string | null;
  kind: Task["kind"];
  request_json: string;
  status_projection: Task["statusProjection"];
  created_at: number;
  finished_at: number | null;
  history_hidden_at: number | null;
  history_hide_batch: string | null;
}

function toTask(row: TaskRow): Task {
  return withoutNulls<Task>({
    id: row.id,
    userId: row.user_id,
    contentId: row.content_id,
    collectionId: row.collection_id,
    kind: row.kind,
    requestJson: row.request_json,
    statusProjection: row.status_projection,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    historyHiddenAt: row.history_hidden_at,
    historyHideBatch: row.history_hide_batch,
  });
}

/** A finished Task the user has not removed from the task panel's history. */
const HISTORY_VISIBLE = "finished_at IS NOT NULL AND history_hidden_at IS NULL";
/** Tasks of a trashed Content are listed nowhere until it is restored. */
const NOT_TRASHED = "NOT EXISTS (SELECT 1 FROM content WHERE content.id = task.content_id AND content.trashed_at IS NOT NULL)";

export function sqliteTaskRepository(db: SqliteConnection): TaskRepository {
  const select = db.prepare("SELECT * FROM task WHERE id = ? AND user_id = ?");
  // Optional filters are NULL when unused, so one statement serves every combination.
  const page = db.prepare(
    `SELECT * FROM task
     WHERE user_id = @owner
       AND (@unfinished = 0 OR finished_at IS NULL)
       AND (@finished = 0 OR finished_at IS NOT NULL)
       AND (@history = 0 OR (${HISTORY_VISIBLE}))
       AND (@contentId IS NULL OR content_id = @contentId)
       AND (@collectionId IS NULL OR collection_id = @collectionId)
       AND (@kind IS NULL OR kind = @kind)
       AND (@createdAt IS NULL OR created_at < @createdAt OR (created_at = @createdAt AND id < @id))
       AND ${NOT_TRASHED}
     ORDER BY created_at DESC, id DESC LIMIT @limit`,
  );
  // Clearing hides exactly what the history list shows: the same predicates, trash included.
  const clearHistory = db.prepare(
    `UPDATE task SET history_hidden_at = @at, history_hide_batch = @batch
     WHERE user_id = @owner AND ${HISTORY_VISIBLE} AND ${NOT_TRASHED}`,
  );
  const restoreHistory = db.prepare(
    "UPDATE task SET history_hidden_at = NULL, history_hide_batch = NULL WHERE user_id = ? AND history_hide_batch = ?",
  );
  const byContent = db.prepare("SELECT * FROM task WHERE content_id = ? AND user_id = ? ORDER BY created_at, id");
  const byCollection = db.prepare("SELECT * FROM task WHERE collection_id = ? AND user_id = ? ORDER BY created_at, id");
  const unfinished = db.prepare("SELECT * FROM task WHERE finished_at IS NULL ORDER BY created_at, id");
  const unfinishedOf = db.prepare("SELECT * FROM task WHERE user_id = ? AND finished_at IS NULL ORDER BY created_at, id");
  const unscoped = db.prepare("SELECT * FROM task WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO task (id, user_id, content_id, collection_id, kind, request_json, status_projection, created_at, finished_at)
     VALUES (@id, @userId, @contentId, @collectionId, @kind, @requestJson, @statusProjection, @createdAt, @finishedAt)`,
  );
  // A Task that starts again (no finish time) leaves no hidden history entry behind.
  const setProjection = db.prepare(
    `UPDATE task SET status_projection = @status, finished_at = @finishedAt,
       history_hidden_at = CASE WHEN @finishedAt IS NULL THEN NULL ELSE history_hidden_at END,
       history_hide_batch = CASE WHEN @finishedAt IS NULL THEN NULL ELSE history_hide_batch END
     WHERE id = @id AND user_id = @owner`,
  );

  return {
    get(ownerUserId, taskId) {
      const row = select.get(taskId, ownerUserId) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    list(ownerUserId, { limit, after, unfinished, finished, history, contentId, collectionId, kind }) {
      const rows = page.all({
        owner: ownerUserId,
        unfinished: unfinished === true ? 1 : 0,
        finished: finished === true ? 1 : 0,
        history: history === true ? 1 : 0,
        contentId: contentId ?? null,
        collectionId: collectionId ?? null,
        kind: kind ?? null,
        createdAt: after?.createdAt ?? null,
        id: after?.id ?? null,
        limit,
      });
      return (rows as TaskRow[]).map(toTask);
    },
    hideHistory(ownerUserId, taskIds, batchId, hiddenAt) {
      const ids = [...new Set(taskIds)];
      if (ids.length === 0) {
        return 0;
      }
      // The id list is bound, never interpolated; only its placeholder count varies.
      const statement = db.prepare(
        `UPDATE task SET history_hidden_at = ?, history_hide_batch = ?
         WHERE user_id = ? AND id IN (${ids.map(() => "?").join(", ")}) AND ${HISTORY_VISIBLE}`,
      );
      return statement.run(hiddenAt, batchId, ownerUserId, ...ids).changes;
    },
    clearHistory(ownerUserId, batchId, hiddenAt) {
      return clearHistory.run({ owner: ownerUserId, batch: batchId, at: hiddenAt }).changes;
    },
    restoreHistory(ownerUserId, batchId) {
      return restoreHistory.run(ownerUserId, batchId).changes;
    },
    listByContent(ownerUserId, contentId) {
      return (byContent.all(contentId, ownerUserId) as TaskRow[]).map(toTask);
    },
    listByCollection(ownerUserId, collectionId) {
      return (byCollection.all(collectionId, ownerUserId) as TaskRow[]).map(toTask);
    },
    listUnfinished() {
      return (unfinished.all() as TaskRow[]).map(toTask);
    },
    listUnfinishedOf(ownerUserId) {
      return (unfinishedOf.all(ownerUserId) as TaskRow[]).map(toTask);
    },
    getUnscoped(taskId) {
      const row = unscoped.get(taskId) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    insert(task) {
      insert.run({
        id: task.id,
        userId: task.userId,
        contentId: nullable(task.contentId),
        collectionId: nullable(task.collectionId),
        kind: task.kind,
        requestJson: task.requestJson,
        statusProjection: task.statusProjection,
        createdAt: task.createdAt,
        finishedAt: nullable(task.finishedAt),
      });
    },
    setProjection(ownerUserId, taskId, status, finishedAt) {
      if (setProjection.run({ status, finishedAt: nullable(finishedAt), id: taskId, owner: ownerUserId }).changes === 0) {
        throw notFound("task", taskId);
      }
    },
  };
}
