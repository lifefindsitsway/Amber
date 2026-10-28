import type { LibraryCategory } from "../../../shared/backup.ts";
import type { SqliteConnection } from "./database.ts";

/**
 * The fresh-install check of a restore: a restore target may hold no row in any of these
 * tables (built-in summary templates excepted) and no relocated cache directory. User and
 * instance settings are left out on purpose: a restore replaces them wholesale.
 */
const CATEGORY_QUERIES: ReadonlyArray<readonly [LibraryCategory, string]> = [
  ["content", "SELECT 1 FROM content LIMIT 1"],
  ["collection", "SELECT 1 FROM collection LIMIT 1"],
  ["import_batch", "SELECT 1 FROM import_batch LIMIT 1"],
  ["task", "SELECT 1 FROM task LIMIT 1"],
  ["media_asset", "SELECT 1 FROM media_asset LIMIT 1"],
  ["transcript_revision", "SELECT 1 FROM transcript_revision LIMIT 1"],
  ["transcript_draft", "SELECT 1 FROM transcript_draft LIMIT 1"],
  ["note", "SELECT 1 FROM note LIMIT 1"],
  ["chat_thread", "SELECT 1 FROM chat_thread LIMIT 1"],
  ["provider_profile", "SELECT 1 FROM provider_profile LIMIT 1"],
  ["asr_provider_profile", "SELECT 1 FROM asr_provider_profile LIMIT 1"],
  ["other_model_profile", "SELECT 1 FROM other_model_profile LIMIT 1"],
  ["platform_account", "SELECT 1 FROM platform_account LIMIT 1"],
  ["secret", "SELECT 1 FROM secret LIMIT 1"],
  ["terminology_set", "SELECT 1 FROM terminology_set LIMIT 1"],
  ["summary_template", "SELECT 1 FROM summary_template WHERE builtin = 0 LIMIT 1"],
  // Any saved version counts, even after the builtin was restored: it is the user's text.
  ["prompt_override_version", "SELECT 1 FROM prompt_override_version LIMIT 1"],
  ["token_usage", "SELECT 1 FROM token_usage LIMIT 1"],
  ["asr_usage", "SELECT 1 FROM asr_usage LIMIT 1"],
  ["network_allowlist", "SELECT 1 FROM network_allowlist LIMIT 1"],
  ["pending_file_delete", "SELECT 1 FROM pending_file_delete LIMIT 1"],
  ["cache_root", "SELECT 1 FROM instance_settings WHERE cache_root IS NOT NULL LIMIT 1"],
];

/** The categories that keep `db` from being a fresh install, in a fixed order; empty when it is one. */
export function nonEmptyCategories(db: SqliteConnection): LibraryCategory[] {
  return CATEGORY_QUERIES.filter(([, sql]) => db.prepare(sql).get() !== undefined).map(([category]) => category);
}
