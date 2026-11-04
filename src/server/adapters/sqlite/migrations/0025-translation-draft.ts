import type { Migration } from "../migrations.ts";

/**
 * A draft is either the Content's transcript draft (`target_language` NULL, at most one per
 * Content) or the draft of one translation language (at most one per Content and language).
 * The old unique index on `content_id` alone becomes a partial one so both kinds can coexist.
 * `version` counts successful writes; every save, discard and commit names the version it
 * expects, so a stale window or a late autosave never overwrites or revives a draft. Existing
 * drafts stay transcript drafts at version 1.
 */
export const migration0025: Migration = {
  version: 25,
  name: "translation-draft",
  sql: `
    ALTER TABLE transcript_draft ADD COLUMN target_language TEXT;
    ALTER TABLE transcript_draft ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    DROP INDEX transcript_draft_content;
    CREATE UNIQUE INDEX transcript_draft_content ON transcript_draft (content_id) WHERE target_language IS NULL;
    CREATE UNIQUE INDEX transcript_draft_translation ON transcript_draft (content_id, target_language) WHERE target_language IS NOT NULL;
  `,
};
