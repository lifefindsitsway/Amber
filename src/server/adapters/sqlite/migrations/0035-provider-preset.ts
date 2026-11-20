import type { Migration } from "../migrations.ts";

/**
 * The preset an LLM profile was created from, for its icon and region display only. Existing
 * profiles keep `NULL`: guessing a vendor from an address could mislabel a relay.
 */
export const migration0035: Migration = {
  version: 35,
  name: "provider-preset",
  sql: `
    ALTER TABLE provider_profile ADD COLUMN preset_id TEXT;
  `,
};
