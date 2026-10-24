import type { Migration } from "../migrations.ts";

/**
 * `media_asset.quality_verified` marks a cache row whose `quality` was read from the finished
 * file. Rows written by earlier builds may carry the requested height cap instead of the
 * downloaded one, so they start unverified and the start-up sweep probes their files before
 * any same-quality replacement relies on them.
 *
 * `pending_file_delete.expected_digest` records the SHA-256 of the file a queued delete
 * means, so the worker never removes a different file that happens to have the same size.
 * Entries registered before this column existed stay NULL and keep the size-only check.
 */
export const migration0021: Migration = {
  version: 21,
  name: "cache-quality-and-trash-identity",
  sql: `
    ALTER TABLE media_asset ADD COLUMN quality_verified INTEGER NOT NULL DEFAULT 0 CHECK (quality_verified IN (0, 1));
    ALTER TABLE pending_file_delete ADD COLUMN expected_digest TEXT;
  `,
};
