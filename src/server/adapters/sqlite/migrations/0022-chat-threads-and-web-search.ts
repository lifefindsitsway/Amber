import type { SqliteConnection } from "../database.ts";
import type { Migration } from "../migrations.ts";

/**
 * Several chat threads per Content, retried and deleted turns, and web search.
 *
 * `chat_thread` is rebuilt without `UNIQUE (content_id)` and gains `created_at`: the earliest
 * message of the thread, else the Content's creation. Ids and the current compaction are
 * kept, so every existing conversation becomes one thread of its Content. A thread's title
 * and latest message time are derived from its messages when read, never stored.
 * Messages and compactions reference the thread with `ON DELETE CASCADE`, so the runner
 * turns foreign keys off around the rebuild; `verify` then proves that no message,
 * compaction, current compaction or usage link was lost before the version is bumped.
 *
 * `chat_message` gains `finished_at` (when an answer reached its final state; NULL for
 * answers stored before), `web_search_json` (the search record of the answer),
 * `replaces_message_id` (the answer a retry replaces, a plain id that outlives that answer)
 * and `error_json` (why an answer failed, so a failed retry still says why after a reload).
 *
 * A compaction keeps its body, model and prompt for good; only `through_message_id` may
 * move, to an earlier kept message, when the turn it ended on is deleted.
 *
 * `user_settings.chat_web_search_mode` remembers the user's last search setting (NULL = off),
 * and `web_search_profile` holds at most one search service per user with its Secret.
 */
export const migration0022: Migration = {
  version: 22,
  name: "chat-threads-and-web-search",
  rebuildsReferencedTable: true,
  sql: `
    CREATE TEMP TABLE chat_rebuild_counts AS SELECT
      (SELECT count(*) FROM chat_thread) AS threads,
      (SELECT count(*) FROM chat_thread WHERE current_compaction_id IS NOT NULL) AS current_compactions,
      (SELECT count(*) FROM chat_message) AS messages,
      (SELECT count(*) FROM chat_compaction) AS compactions,
      (SELECT count(*) FROM token_usage WHERE chat_message_id IS NOT NULL) AS usage_links;

    CREATE TABLE chat_thread_v22 (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content (id) ON DELETE CASCADE,
      current_compaction_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (current_compaction_id, id) REFERENCES chat_compaction (id, thread_id)
    ) STRICT;
    INSERT INTO chat_thread_v22 (id, content_id, current_compaction_id, created_at)
    SELECT
      t.id, t.content_id, t.current_compaction_id,
      coalesce((SELECT min(m.created_at) FROM chat_message AS m WHERE m.thread_id = t.id), (SELECT c.created_at FROM content AS c WHERE c.id = t.content_id))
    FROM chat_thread AS t;

    DROP TABLE chat_thread;
    ALTER TABLE chat_thread_v22 RENAME TO chat_thread;
    CREATE INDEX chat_thread_content ON chat_thread (content_id, created_at, id);
    CREATE INDEX chat_thread_current_compaction ON chat_thread (current_compaction_id, id);

    ALTER TABLE chat_message ADD COLUMN finished_at INTEGER;
    ALTER TABLE chat_message ADD COLUMN web_search_json TEXT CHECK (web_search_json IS NULL OR json_valid(web_search_json));
    ALTER TABLE chat_message ADD COLUMN replaces_message_id TEXT;
    ALTER TABLE chat_message ADD COLUMN error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json));

    DROP TRIGGER chat_compaction_immutable;
    CREATE TRIGGER chat_compaction_immutable
    BEFORE UPDATE OF id, thread_id, body, model_ref_json, prompt_ref_json, prompt_snapshot, created_at ON chat_compaction
    BEGIN
      SELECT RAISE(ABORT, 'chat_compaction is immutable');
    END;

    ALTER TABLE user_settings ADD COLUMN chat_web_search_mode TEXT;

    CREATE TABLE web_search_profile (
      user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      credential_ref TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (credential_ref, user_id) REFERENCES secret (id, user_id)
    ) STRICT;
    CREATE TRIGGER web_search_profile_secret_delete AFTER DELETE ON web_search_profile
    WHEN old.credential_ref IS NOT NULL
    BEGIN
      DELETE FROM secret WHERE id = old.credential_ref;
    END;
  `,
  verify(db: SqliteConnection): void {
    const before = db.prepare("SELECT * FROM temp.chat_rebuild_counts").get();
    const after = db
      .prepare(
        `SELECT
           (SELECT count(*) FROM chat_thread) AS threads,
           (SELECT count(*) FROM chat_thread WHERE current_compaction_id IS NOT NULL) AS current_compactions,
           (SELECT count(*) FROM chat_message) AS messages,
           (SELECT count(*) FROM chat_compaction) AS compactions,
           (SELECT count(*) FROM token_usage WHERE chat_message_id IS NOT NULL) AS usage_links`,
      )
      .get();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`chat rebuild changed row counts: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
    db.exec("DROP TABLE temp.chat_rebuild_counts");
  },
};
