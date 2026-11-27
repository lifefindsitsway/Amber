import type { Migration } from "../migrations.ts";

/**
 * A local copy of a Content's cover. `content.cover_url` keeps the address the platform gave;
 * `content_cover_image` holds the re-encoded WebP with its size and digest, one row per
 * Content, going with it on purge.
 *
 * `content.cover_image_version` names the copy for cache validation: it is written in the
 * same transaction as the row, only ever goes up, and stays NULL while there is no copy.
 * It lives on `content` so every Content listing can tell the client whether to ask for the
 * local copy without joining the image table.
 *
 * Existing Contents get no copy and a NULL version; nothing is backfilled.
 */
export const migration0036: Migration = {
  version: 36,
  name: "content-cover-image",
  sql: `
    ALTER TABLE content ADD COLUMN cover_image_version INTEGER CHECK (cover_image_version IS NULL OR cover_image_version >= 1);

    CREATE TABLE content_cover_image (
      content_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      image BLOB NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      bytes INTEGER NOT NULL CHECK (bytes > 0),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE
    ) STRICT;
  `,
};
