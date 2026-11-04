import type { Migration } from "../migrations.ts";

/**
 * A finished Task can be removed from the task panel's history without deleting it:
 * `history_hidden_at` is when, `history_hide_batch` the id of the removal that hid it, so an
 * undo restores exactly the rows that removal changed. Nothing else reads these columns; a
 * Task that starts again clears both. Existing Tasks keep NULL, which hides nothing.
 */
export const migration0026: Migration = {
  version: 26,
  name: "task-history-hidden",
  sql: `
    ALTER TABLE task ADD COLUMN history_hidden_at INTEGER;
    ALTER TABLE task ADD COLUMN history_hide_batch TEXT;
    CREATE INDEX task_history_hide_batch ON task (user_id, history_hide_batch) WHERE history_hide_batch IS NOT NULL;
  `,
};
