import { USAGE_RESULTS, type UsageGranularity, type UsageModality, type UsageResult } from "../../../../shared/dto/usage-analytics.ts";
import { PRICE_CURRENCIES } from "../../../../shared/model-pricing.ts";
import {
  activityKeyText,
  activityPartsOf,
  identityOfParts,
  parseActivityIdentity,
  type UsageActivityKey,
  type UsageActivityParts,
  type UsageActivityRow,
  type UsageBucketRow,
  type UsageCallRow,
  type UsageCurrentPricing,
  type UsageGroupRow,
  type UsageIdentityRow,
  type UsageMeasures,
  type UsageProfileName,
  type UsageScope,
} from "../../../domain/usage-analytics.ts";
import type { UsageAnalyticsRepository } from "../../../ports/usage-analytics.ts";
import type { SqliteConnection } from "../database.ts";
import {
  activityCallsSql,
  activityCountSql,
  activityGroupsSql,
  activityPageSql,
  bucketGroupsSql,
  CACHE_OBSERVED_SQL,
  earliestSql,
  identitiesSql,
} from "./usage-analytics-sql.ts";

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
  return String(row[column]);
}

function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
}

function big(row: Row, column: string): bigint {
  const value = row[column];
  return typeof value === "bigint" ? value : BigInt(Number(value ?? 0));
}

function int(row: Row, column: string): number {
  return Number(big(row, column));
}

function intOrNull(row: Row, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : int(row, column);
}

/** A result written by any version is read as one of the four the page knows; anything else is "unknown". */
function resultOf(row: Row): UsageResult {
  const value = text(row, "result");
  return (USAGE_RESULTS as readonly string[]).includes(value) ? (value as UsageResult) : "outcome_unknown";
}

function measuresOf(row: Row): UsageMeasures {
  return {
    requests: big(row, "requests"),
    rawInput: big(row, "sum_raw_input"),
    input: big(row, "sum_input"),
    output: big(row, "sum_output"),
    reasoning: big(row, "sum_reasoning"),
    cacheRead: big(row, "sum_cache_read"),
    cacheWrite: big(row, "sum_cache_write"),
    cacheWrite1h: big(row, "sum_cache_write_1h"),
    audioBilledMs: big(row, "sum_audio_billed"),
    audioLocalMs: big(row, "sum_audio_local"),
    lastAt: int(row, "last_at"),
  };
}

function groupOf(row: Row): UsageGroupRow {
  return {
    modality: text(row, "modality") as UsageModality,
    profileId: text(row, "profile_id"),
    modelId: text(row, "model_id"),
    credentialVersion: textOrNull(row, "credential_version"),
    credentialSetAt: intOrNull(row, "credential_set_at"),
    snapshotJson: textOrNull(row, "snapshot"),
    bitmap: int(row, "bitmap"),
    flags: int(row, "flags"),
    result: resultOf(row),
    ...measuresOf(row),
  };
}

/** One call as a group of one: its own columns are the sums. */
function callOf(row: Row): UsageCallRow {
  const sums: Row = {
    requests: 1,
    last_at: row["occurred_at"],
    sum_raw_input: row["raw_input"],
    sum_input: row["input"],
    sum_output: row["output"],
    sum_reasoning: row["reasoning"],
    sum_cache_read: row["cache_read"],
    sum_cache_write: row["cache_write"],
    sum_cache_write_1h: row["cache_write_1h"],
    sum_audio_billed: row["audio_billed"],
    sum_audio_local: row["audio_local"],
  };
  return {
    ...groupOf({ ...row, ...sums }),
    id: text(row, "id"),
    occurredAt: int(row, "occurred_at"),
    feature: text(row, "feature"),
  };
}

function activityPartsOfRow(row: Row): UsageActivityParts {
  return {
    kind: text(row, "kind") as UsageActivityParts["kind"],
    a: text(row, "activity_a"),
    b: text(row, "activity_b"),
    c: text(row, "activity_c"),
    d: int(row, "activity_d"),
  };
}

/** `?, ?, ?` for a list of bound values. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Usage analytics on SQLite. Queries select from a normalized union of both usage tables and
 * group in SQL; integers are read as `bigint` so sums stay exact, and an `int64` overflow
 * surfaces as the database's own error instead of a wrong number.
 */
export class SqliteUsageAnalyticsRepository implements UsageAnalyticsRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  groupsByBucket(scope: UsageScope, granularity: UsageGranularity): UsageBucketRow[] {
    const query = bucketGroupsSql(scope, granularity);
    return this.all(query.sql, query.params).map((row) => ({ ...groupOf(row), bucketStart: int(row, "bucket_start") }));
  }

  identities(scope: UsageScope): UsageIdentityRow[] {
    const query = identitiesSql(scope);
    return this.all(query.sql, query.params).map((row) => ({
      modality: text(row, "modality") as UsageModality,
      profileId: text(row, "profile_id"),
      modelId: text(row, "model_id"),
      credentialVersion: textOrNull(row, "credential_version"),
      credentialSetAt: intOrNull(row, "credential_set_at"),
      requests: int(row, "requests"),
    }));
  }

  earliest(scope: UsageScope): number | null {
    const query = earliestSql(scope);
    const row = this.all(query.sql, query.params)[0];
    return row === undefined ? null : intOrNull(row, "first_at");
  }

  /** One existence probe per currency: it stops at the first snapshot that names it. */
  currencies(owner: string): string[] {
    return PRICE_CURRENCIES.filter((currency) => this.hasSnapshotIn(owner, currency));
  }

  profileNames(owner: string): UsageProfileName[] {
    const rows = this.all(
      `SELECT 'llm' AS modality, id, name FROM provider_profile WHERE user_id = @owner
       UNION ALL
       SELECT 'asr', id, name FROM asr_provider_profile WHERE user_id = @owner`,
      { owner },
    );
    return rows.map((row) => ({ modality: text(row, "modality") as UsageModality, profileId: text(row, "id"), name: text(row, "name") }));
  }

  recordedProfileNames(owner: string, profiles: ReadonlyArray<{ modality: UsageModality; profileId: string }>): UsageProfileName[] {
    return profiles.flatMap((profile) => {
      const name = this.recordedName(owner, profile.modality, profile.profileId);
      return name === null ? [] : [{ ...profile, name }];
    });
  }

  currentPricing(owner: string): UsageCurrentPricing[] {
    const rows = this.all(
      `SELECT 'llm' AS modality, p.id AS profile_id, m.model_id AS model_id, m.pricing_json AS pricing
         FROM model_capability AS m JOIN provider_profile AS p ON p.id = m.profile_id WHERE p.user_id = @owner
       UNION ALL
       SELECT 'asr', p.id, json_extract(entry.value, '$.modelId'), json_extract(entry.value, '$.pricing')
         FROM asr_provider_profile AS p, json_each(p.models_json) AS entry WHERE p.user_id = @owner`,
      { owner },
    );
    return rows.map((row) => ({
      modality: text(row, "modality") as UsageModality,
      profileId: text(row, "profile_id"),
      modelId: text(row, "model_id"),
      pricingJson: textOrNull(row, "pricing"),
    }));
  }

  activityKeys(scope: UsageScope, page: { limit: number; offset: number }): { total: number; items: UsageActivityKey[] } {
    const query = activityPageSql(scope, page);
    const rows = this.all(query.sql, query.params);
    const items = rows.map((row) => ({
      key: activityKeyText(identityOfParts(activityPartsOfRow(row))),
      startedAt: int(row, "started_at"),
      endedAt: int(row, "ended_at"),
    }));
    // A page past the end has no row to carry the total.
    return { total: rows[0] === undefined ? this.activityCount(scope) : int(rows[0], "total"), items };
  }

  activityGroups(scope: UsageScope, items: readonly UsageActivityKey[]): UsageActivityRow[] {
    if (items.length === 0) {
      return [];
    }
    // Every call of a listed activity lies between its first and last call, so the groups of
    // the page are read from that window alone instead of from the whole range.
    const window = { from: Math.min(...items.map((item) => item.startedAt)), to: Math.max(...items.map((item) => item.endedAt)) + 1 };
    const query = activityGroupsSql({ ...scope, from: Math.max(scope.from ?? window.from, window.from), to: Math.min(scope.to ?? window.to, window.to) });
    const wanted = new Set(items.map((item) => item.key));
    return this.all(query.sql, query.params).flatMap((row) => {
      const key = activityKeyText(identityOfParts(activityPartsOfRow(row)));
      return wanted.has(key) ? [{ ...groupOf(row), key, feature: text(row, "feature"), contentId: textOrNull(row, "content_id") }] : [];
    });
  }

  contentTitles(owner: string, contentIds: readonly string[]): ReadonlyMap<string, string | null> {
    if (contentIds.length === 0) {
      return new Map();
    }
    const rows = this.db
      .prepare(`SELECT id, COALESCE(custom_title, title) AS title FROM content WHERE user_id = ? AND id IN (${placeholders(contentIds.length)})`)
      .all(owner, ...contentIds) as Row[];
    return new Map(rows.map((row) => [text(row, "id"), textOrNull(row, "title")]));
  }

  calls(scope: UsageScope, key: string): UsageCallRow[] {
    const identity = parseActivityIdentity(key);
    if (identity === undefined) {
      return [];
    }
    const query = activityCallsSql({ ...scope, narrow: identity }, activityPartsOf(identity));
    return this.all(query.sql, query.params).map(callOf);
  }

  cacheObserved(owner: string): Array<{ profileId: string; modelId: string }> {
    return this.all(CACHE_OBSERVED_SQL, { owner }).map((row) => ({ profileId: text(row, "provider_profile_id"), modelId: text(row, "model_id") }));
  }

  private activityCount(scope: UsageScope): number {
    const query = activityCountSql(scope);
    return int(this.all(query.sql, query.params)[0] as Row, "total");
  }

  private hasSnapshotIn(owner: string, currency: string): boolean {
    const probe = (table: string): string =>
      `EXISTS (SELECT 1 FROM ${table} WHERE user_id = @owner AND price_snapshot_json IS NOT NULL
         AND json_extract(price_snapshot_json, '$.currency') = @currency)`;
    const row = this.all(`SELECT ${probe("token_usage")} OR ${probe("asr_usage")} AS found`, { owner, currency })[0];
    return row !== undefined && int(row, "found") === 1;
  }

  private recordedName(owner: string, modality: UsageModality, profileId: string): string | null {
    if (profileId === "") {
      return null;
    }
    const sql =
      modality === "llm"
        ? `SELECT json_extract(model_ref_json, '$.providerNameSnapshot') AS name FROM token_usage
           WHERE user_id = @owner AND provider_profile_id = @profile ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`
        : `SELECT profile_name_snapshot AS name FROM asr_usage
           WHERE user_id = @owner AND profile_id_snapshot = @profile ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`;
    const row = this.all(sql, { owner, profile: profileId })[0];
    return row === undefined ? null : textOrNull(row, "name");
  }

  private all(sql: string, params: Record<string, unknown>): Row[] {
    return this.db.prepare(sql).safeIntegers(true).all(params) as Row[];
  }
}
