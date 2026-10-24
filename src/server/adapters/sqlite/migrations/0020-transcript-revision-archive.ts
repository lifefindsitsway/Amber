import type { Migration } from "../migrations.ts";

/**
 * Archived transcript revisions. Revisions are immutable, so the archived flag lives in its
 * own table instead of a column: archiving or restoring a revision inserts or deletes one row
 * here and never touches `transcript_revision`. The composite key keeps a mark on a revision
 * of the same Content, and the cascade drops the mark with the revision or the Content.
 */
export const migration0020: Migration = {
  version: 20,
  name: "transcript-revision-archive",
  sql: `
    CREATE TABLE transcript_revision_archive (
      revision_id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      FOREIGN KEY (revision_id, content_id) REFERENCES transcript_revision (id, content_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX transcript_revision_archive_content ON transcript_revision_archive (content_id);
  `,
};
