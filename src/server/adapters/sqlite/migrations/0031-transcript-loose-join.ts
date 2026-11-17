import type { Migration } from "../migrations.ts";

/**
 * Loose joining of a transcript revision: 1 means the revision has paragraph marks but its
 * sentences join as an unmarked revision's do (a transcript paragraphed by hand without
 * proofreading, whose text must read exactly as before it was paragraphed); NULL means the
 * usual rule for its marks. Only revisions with paragraph marks may carry it, which the
 * repository checks on insert since a CHECK cannot see the segments.
 *
 * Existing rows stay NULL, which is what they always meant. The column is added rather than
 * the table rebuilt, so the revision immutability trigger keeps refusing every UPDATE.
 */
export const migration0031: Migration = {
  version: 31,
  name: "transcript-loose-join",
  sql: `
    ALTER TABLE transcript_revision ADD COLUMN loose_join INTEGER CHECK (loose_join IS NULL OR loose_join = 1);
  `,
};
