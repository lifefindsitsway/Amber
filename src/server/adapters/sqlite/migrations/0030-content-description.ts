import type { Migration } from "../migrations.ts";

/**
 * The platform video's description on `content`. `description` is the normalized, capped
 * text (NULL when none is stored); `description_truncated` says it was cut to the length
 * limit; `description_checked_at` is when the request whose answer is stored was sent, so
 * an answer to an earlier request never replaces a later one. NULL `description` with a
 * time set means the platform said there is none.
 *
 * Existing rows read as never checked; nothing is rewritten.
 */
export const migration0030: Migration = {
  version: 30,
  name: "content-description",
  sql: `
    ALTER TABLE content ADD COLUMN description TEXT;
    ALTER TABLE content ADD COLUMN description_truncated INTEGER NOT NULL DEFAULT 0 CHECK (description_truncated IN (0, 1));
    ALTER TABLE content ADD COLUMN description_checked_at INTEGER;
  `,
};
