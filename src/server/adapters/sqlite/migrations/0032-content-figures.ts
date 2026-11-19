import type { Migration } from "../migrations.ts";

/**
 * Figures placed between the paragraphs of the reading view: a captured video frame or an
 * image the user uploaded or pasted, with a caption, a width and a place.
 *
 * The image bytes live in `content_figure_image`, apart from the metadata: a caption or move
 * is a small row update instead of rewriting a page chain of up to a megabyte. The bytes never
 * change once written (a trigger refuses it); a different picture is a different figure.
 *
 * The place is a time (`display_ms`) plus an optional soft anchor to the sentence the user put
 * it next to (`anchor_*`). The anchor has no foreign key on purpose: a figure outlives the
 * revision it was placed against and falls back to its time when that revision is deleted.
 *
 * `deleted_at` keeps a deleted figure restorable for the retention period; deleted figures
 * still count against the per-Content limit until they are purged.
 */
export const migration0032: Migration = {
  version: 32,
  name: "content-figures",
  sql: `
    CREATE TABLE content_figure (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('capture', 'upload')),
      captured_at_ms INTEGER CHECK (captured_at_ms IS NULL OR captured_at_ms >= 0),
      display_ms INTEGER NOT NULL CHECK (display_ms >= 0),
      anchor_revision_id TEXT,
      anchor_segment_id TEXT,
      anchor_side TEXT CHECK (anchor_side IS NULL OR anchor_side IN ('before', 'after')),
      sort_key INTEGER NOT NULL DEFAULT 0,
      width_ratio REAL NOT NULL CHECK (width_ratio > 0 AND width_ratio <= 1),
      caption TEXT CHECK (caption IS NULL OR caption <> ''),
      image_width INTEGER NOT NULL CHECK (image_width > 0),
      image_height INTEGER NOT NULL CHECK (image_height > 0),
      image_bytes INTEGER NOT NULL CHECK (image_bytes > 0),
      image_sha256 TEXT NOT NULL CHECK (length(image_sha256) = 64),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK ((source = 'capture') = (captured_at_ms IS NOT NULL)),
      CHECK ((anchor_revision_id IS NULL) = (anchor_segment_id IS NULL)),
      CHECK ((anchor_segment_id IS NULL) = (anchor_side IS NULL)),
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX content_figure_content ON content_figure (content_id, deleted_at);

    CREATE TABLE content_figure_image (
      figure_id TEXT PRIMARY KEY REFERENCES content_figure (id) ON DELETE CASCADE,
      bytes BLOB NOT NULL
    ) STRICT;
    CREATE TRIGGER content_figure_image_immutable BEFORE UPDATE ON content_figure_image
    BEGIN
      SELECT RAISE(ABORT, 'content_figure_image is immutable');
    END;
  `,
};
