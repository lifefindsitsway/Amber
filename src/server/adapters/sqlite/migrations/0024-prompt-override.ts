import type { Migration } from "../migrations.ts";

/**
 * A user's own versions of the customizable system prompts. `prompt_override` holds, per
 * user and prompt, the version in effect (`current_version` NULL: the builtin text);
 * `prompt_override_version` is append-only, so a frozen `custom:<promptId>` ref always
 * resolves, and restoring the builtin keeps every version. A version row is written before
 * `current_version` points at it; the composite keys keep a version under its own user and
 * prompt, and both tables go with their user.
 *
 * Derived artifacts and rolling-summary partials gain `prompt_refs_json`: every prompt
 * version that produced the stored result. Existing rows keep NULL, read as unknown.
 */
export const migration0024: Migration = {
  version: 24,
  name: "prompt-override",
  sql: `
    CREATE TABLE prompt_override (
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      prompt_id TEXT NOT NULL,
      current_version INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, prompt_id),
      FOREIGN KEY (user_id, prompt_id, current_version) REFERENCES prompt_override_version (user_id, prompt_id, version)
    ) STRICT;

    CREATE TABLE prompt_override_version (
      user_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, prompt_id, version),
      FOREIGN KEY (user_id, prompt_id) REFERENCES prompt_override (user_id, prompt_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TRIGGER prompt_override_version_immutable BEFORE UPDATE ON prompt_override_version
    BEGIN
      SELECT RAISE(ABORT, 'prompt_override_version is immutable');
    END;

    ALTER TABLE summary_revision ADD COLUMN prompt_refs_json TEXT CHECK (prompt_refs_json IS NULL OR json_valid(prompt_refs_json));
    ALTER TABLE chapter_revision ADD COLUMN prompt_refs_json TEXT CHECK (prompt_refs_json IS NULL OR json_valid(prompt_refs_json));
    ALTER TABLE highlight_revision ADD COLUMN prompt_refs_json TEXT CHECK (prompt_refs_json IS NULL OR json_valid(prompt_refs_json));
    ALTER TABLE collection_summary_revision ADD COLUMN prompt_refs_json TEXT CHECK (prompt_refs_json IS NULL OR json_valid(prompt_refs_json));
    ALTER TABLE rollup_partial ADD COLUMN prompt_refs_json TEXT CHECK (prompt_refs_json IS NULL OR json_valid(prompt_refs_json));
  `,
};
