import type { Migration } from "../migrations.ts";

/**
 * Call-time snapshots for usage analytics. Everything here is additive: columns are added,
 * filled from what the rows already say, and indexed; no existing value is rewritten.
 *
 * - `secret.version_id` / `version_set_at` identify the version of a stored credential. Each
 *   existing secret gets one random identifier and its last update time as the set time; the
 *   application writes both on every store from now on, so the columns stay nullable only at
 *   the SQL level.
 * - `token_usage` gains the request's send time, the credential version in force, the price
 *   frozen when the request left, and the one-hour share of cache writes. The model's profile
 *   and id are copied out of `model_ref_json` into filterable columns that outlive the profile.
 * - `asr_usage` gains the same snapshots plus the job's remote outcome and the billed
 *   quantities the upstream reported. The profile id and name are copied at call time and are
 *   deliberately not a foreign key: they must survive deleting the profile, whereas
 *   `asr_profile_id` is cleared by it. Rows whose link was already cleared have no snapshot.
 *
 * The time a call is attributed to is `COALESCE(sent_at, created_at)`: `sent_at` when the
 * request left, otherwise the older rows' write time. The time-range indexes use exactly that
 * expression so range queries can use them.
 */
export const migration0027: Migration = {
  version: 27,
  name: "usage-analytics",
  sql: `
    ALTER TABLE secret ADD COLUMN version_id TEXT;
    ALTER TABLE secret ADD COLUMN version_set_at INTEGER;
    UPDATE secret SET version_id = lower(hex(randomblob(16))), version_set_at = updated_at;
    CREATE UNIQUE INDEX secret_version_id ON secret (version_id);

    ALTER TABLE token_usage ADD COLUMN provider_profile_id TEXT;
    ALTER TABLE token_usage ADD COLUMN model_id TEXT;
    ALTER TABLE token_usage ADD COLUMN sent_at INTEGER;
    ALTER TABLE token_usage ADD COLUMN credential_version TEXT;
    ALTER TABLE token_usage ADD COLUMN credential_set_at INTEGER;
    ALTER TABLE token_usage ADD COLUMN price_snapshot_json TEXT CHECK (price_snapshot_json IS NULL OR json_valid(price_snapshot_json));
    ALTER TABLE token_usage ADD COLUMN cache_write_1h_tokens INTEGER CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0);
    UPDATE token_usage SET
      provider_profile_id = json_extract(model_ref_json, '$.providerProfileId'),
      model_id = json_extract(model_ref_json, '$.modelId');

    ALTER TABLE asr_usage ADD COLUMN profile_id_snapshot TEXT;
    ALTER TABLE asr_usage ADD COLUMN profile_name_snapshot TEXT;
    ALTER TABLE asr_usage ADD COLUMN sent_at INTEGER;
    ALTER TABLE asr_usage ADD COLUMN job_id TEXT;
    ALTER TABLE asr_usage ADD COLUMN billed_input_tokens INTEGER CHECK (billed_input_tokens IS NULL OR billed_input_tokens >= 0);
    ALTER TABLE asr_usage ADD COLUMN billed_output_tokens INTEGER CHECK (billed_output_tokens IS NULL OR billed_output_tokens >= 0);
    ALTER TABLE asr_usage ADD COLUMN billed_audio_ms INTEGER CHECK (billed_audio_ms IS NULL OR billed_audio_ms >= 0);
    ALTER TABLE asr_usage ADD COLUMN job_outcome TEXT CHECK (job_outcome IS NULL OR job_outcome IN ('succeeded', 'failed', 'cancelled'));
    ALTER TABLE asr_usage ADD COLUMN credential_version TEXT;
    ALTER TABLE asr_usage ADD COLUMN credential_set_at INTEGER;
    ALTER TABLE asr_usage ADD COLUMN price_snapshot_json TEXT CHECK (price_snapshot_json IS NULL OR json_valid(price_snapshot_json));
    UPDATE asr_usage SET
      profile_id_snapshot = asr_profile_id,
      profile_name_snapshot = (SELECT p.name FROM asr_provider_profile AS p WHERE p.id = asr_usage.asr_profile_id)
    WHERE asr_profile_id IS NOT NULL;

    CREATE INDEX token_usage_user_occurred ON token_usage (user_id, COALESCE(sent_at, created_at));
    CREATE INDEX asr_usage_user_occurred ON asr_usage (user_id, COALESCE(sent_at, created_at));
    CREATE INDEX token_usage_model ON token_usage (user_id, provider_profile_id, model_id);
    CREATE INDEX token_usage_cache_observed ON token_usage (user_id, provider_profile_id, model_id) WHERE cache_read_tokens > 0;
    CREATE INDEX asr_usage_model ON asr_usage (user_id, profile_id_snapshot, model);
  `,
};
