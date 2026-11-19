import type { Migration } from "../migrations.ts";

/**
 * The latest danmaku snapshot of a platform video, one per Content, replaced whole on every
 * successful fetch. `platform_part_id` is the part the snapshot was fetched for, so a snapshot
 * never shows on a Content whose part changed. `items_json` is an array of
 * `[timeMs, mode, color, weight, text]` with mode 0 = scroll, 1 = top, 2 = bottom; sender
 * hashes and danmaku ids are never stored.
 */
export const migration0033: Migration = {
  version: 33,
  name: "content-danmaku",
  sql: `
    CREATE TABLE content_danmaku (
      content_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      platform_part_id TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      item_count INTEGER NOT NULL CHECK (item_count >= 0),
      items_json TEXT NOT NULL CHECK (json_valid(items_json)),
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE
    ) STRICT;
  `,
};
