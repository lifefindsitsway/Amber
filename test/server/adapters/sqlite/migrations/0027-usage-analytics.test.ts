import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function modelRef(profileId: string, modelId: string): string {
  return JSON.stringify({ providerProfileId: profileId, modelId, providerNameSnapshot: "Relay", modelDisplaySnapshot: modelId });
}

function secretRow(id: string, updatedAt: number): Record<string, unknown> {
  return {
    id, user_id: "alice", envelope_version: 1, kdf_salt: Buffer.alloc(16, 1), nonce: Buffer.alloc(12, 2),
    ciphertext: Buffer.from([3, 4, 5]), auth_tag: Buffer.alloc(16, 6), created_at: T0, updated_at: updatedAt,
  };
}

type Row = Record<string, unknown>;

function allRows(db: SqliteConnection, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[];
}

/** The old columns of each row, so a row can be compared with its pre-migration self. */
function onlyColumns(rows: readonly Row[], columns: readonly string[]): Row[] {
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
}

function columnsOf(rows: readonly Row[]): string[] {
  return Object.keys(rows[0] ?? {});
}

function seedAtVersion26(file: string, backupDir: string): { secrets: Row[]; tokens: Row[]; asr: Row[] } {
  const { db } = openDatabase(file, { backupDir, migrations: MIGRATIONS.slice(0, 26) });
  insertRow(db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(db, "secret", secretRow("s1", T0 + 10));
  insertRow(db, "secret", secretRow("s2", T0 + 20));
  insertRow(db, "secret", secretRow("s3", T0 + 30));
  insertRow(db, "asr_provider_profile", {
    id: "ap-live", user_id: "alice", name: "百炼 Profile", provider: "dashscope", models_json: '[{"modelId":"fun-asr"}]', credential_ref: "s1", created_at: T0,
  });
  insertRow(db, "token_usage", {
    id: "tu-cache", user_id: "alice", model_ref_json: modelRef("p-1", "claude-sonnet-x"), feature: "summary", outcome: "succeeded",
    input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_write_tokens: 10, reasoning_tokens: 5,
    raw_usage_json: '{"input_tokens":100,"cache_read_input_tokens":60}', created_at: T0 + 100,
  });
  insertRow(db, "token_usage", {
    id: "tu-plain", user_id: "alice", model_ref_json: modelRef("p-2", "模型/带斜杠"), feature: "chat", outcome: "outcome_unknown", created_at: T0 + 200,
  });
  insertRow(db, "asr_usage", {
    id: "au-live", user_id: "alice", asr_profile_id: "ap-live", provider: "dashscope", model: "fun-asr", outcome: "succeeded", audio_ms: 61_000,
    raw_usage_json: '{"duration":61}', created_at: T0 + 300,
  });
  insertRow(db, "asr_usage", {
    id: "au-cleared", user_id: "alice", provider: "elevenlabs", model: "scribe_v2", outcome: "failed", audio_ms: 0, feature: "test_connection", created_at: T0 + 400,
  });
  const snapshot = { secrets: allRows(db, "secret"), tokens: allRows(db, "token_usage"), asr: allRows(db, "asr_usage") };
  db.close();
  return snapshot;
}

describe("migration 0027: usage analytics", () => {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const backupDir = join(dir, "backups");
  const before = seedAtVersion26(file, backupDir);
  const { db, from, to } = openDatabase(file, { backupDir, migrations: MIGRATIONS.slice(0, 27) });

  it("moves from version 26 to 27 without losing a row or breaking a key", () => {
    expect({ from, to }).toEqual({ from: 26, to: 27 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(allRows(db, "secret")).toHaveLength(before.secrets.length);
    expect(allRows(db, "token_usage")).toHaveLength(before.tokens.length);
    expect(allRows(db, "asr_usage")).toHaveLength(before.asr.length);
  });

  it("leaves every pre-existing column value as it was, raw usage included", () => {
    expect(onlyColumns(allRows(db, "secret"), columnsOf(before.secrets))).toEqual(before.secrets);
    expect(onlyColumns(allRows(db, "token_usage"), columnsOf(before.tokens))).toEqual(before.tokens);
    expect(onlyColumns(allRows(db, "asr_usage"), columnsOf(before.asr))).toEqual(before.asr);
    const raw = db.prepare("SELECT id, raw_usage_json FROM token_usage WHERE raw_usage_json IS NOT NULL").all();
    expect(raw).toEqual([{ id: "tu-cache", raw_usage_json: '{"input_tokens":100,"cache_read_input_tokens":60}' }]);
  });

  it("gives each secret its own version identifier and its update time as the set time", () => {
    const secrets = db.prepare("SELECT id, version_id, version_set_at, updated_at FROM secret ORDER BY id").all() as Array<{
      id: string; version_id: string; version_set_at: number; updated_at: number;
    }>;
    expect(secrets.map((secret) => secret.version_set_at)).toEqual([T0 + 10, T0 + 20, T0 + 30]);
    expect(secrets.every((secret) => secret.version_set_at === secret.updated_at)).toBe(true);
    for (const secret of secrets) {
      expect(secret.version_id).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(new Set(secrets.map((secret) => secret.version_id)).size).toBe(3);
  });

  it("copies the profile and model out of the stored model reference and leaves the rest empty", () => {
    const rows = db.prepare(
      `SELECT id, provider_profile_id, model_id, sent_at, credential_version, credential_set_at, price_snapshot_json, cache_write_1h_tokens
       FROM token_usage ORDER BY id`,
    ).all();
    const empty = { sent_at: null, credential_version: null, credential_set_at: null, price_snapshot_json: null, cache_write_1h_tokens: null };
    expect(rows).toEqual([
      { id: "tu-cache", provider_profile_id: "p-1", model_id: "claude-sonnet-x", ...empty },
      { id: "tu-plain", provider_profile_id: "p-2", model_id: "模型/带斜杠", ...empty },
    ]);
  });

  it("snapshots the live profile's id and name and leaves rows without a profile unsnapshotted", () => {
    const rows = db.prepare(
      `SELECT id, profile_id_snapshot, profile_name_snapshot, sent_at, job_id, billed_input_tokens, billed_output_tokens, billed_audio_ms,
              job_outcome, credential_version, credential_set_at, price_snapshot_json
       FROM asr_usage ORDER BY id`,
    ).all();
    const empty = {
      sent_at: null, job_id: null, billed_input_tokens: null, billed_output_tokens: null, billed_audio_ms: null,
      job_outcome: null, credential_version: null, credential_set_at: null, price_snapshot_json: null,
    };
    expect(rows).toEqual([
      { id: "au-cleared", profile_id_snapshot: null, profile_name_snapshot: null, ...empty },
      { id: "au-live", profile_id_snapshot: "ap-live", profile_name_snapshot: "百炼 Profile", ...empty },
    ]);
  });

  it("keeps the profile snapshot after the profile is deleted", () => {
    db.prepare("DELETE FROM asr_provider_profile WHERE id = 'ap-live'").run();
    expect(db.prepare("SELECT asr_profile_id, profile_id_snapshot, profile_name_snapshot FROM asr_usage WHERE id = 'au-live'").get()).toEqual({
      asr_profile_id: null, profile_id_snapshot: "ap-live", profile_name_snapshot: "百炼 Profile",
    });
  });

  it("rejects values the analytics must never see", () => {
    expect(() => db.prepare("UPDATE token_usage SET cache_write_1h_tokens = -1").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE token_usage SET price_snapshot_json = 'not json'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE asr_usage SET billed_input_tokens = -1").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE asr_usage SET billed_output_tokens = -1").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE asr_usage SET billed_audio_ms = -1").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE asr_usage SET job_outcome = 'outcome_unknown'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE asr_usage SET price_snapshot_json = '{'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE asr_usage SET job_outcome = 'cancelled', billed_audio_ms = 0 WHERE id = 'au-cleared'").run();
    db.prepare("UPDATE asr_usage SET job_outcome = NULL, billed_audio_ms = NULL WHERE id = 'au-cleared'").run();
  });

  it("keeps secret version identifiers unique but lets unversioned rows coexist", () => {
    const existing = (db.prepare("SELECT version_id FROM secret WHERE id = 's2'").get() as { version_id: string }).version_id;
    expect(() => db.prepare("UPDATE secret SET version_id = ? WHERE id = 's3'").run(existing)).toThrow(/UNIQUE/);
    db.prepare("UPDATE secret SET version_id = NULL WHERE id IN ('s2', 's3')").run();
  });

  it("creates the range, model and cache-observed indexes", () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "secret_version_id", "token_usage_user_occurred", "asr_usage_user_occurred", "token_usage_model", "token_usage_cache_observed", "asr_usage_model",
      ]),
    );
    const sql = (name: string) => (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql;
    expect(sql("token_usage_user_occurred")).toMatch(/COALESCE\(sent_at, created_at\)/);
    expect(sql("asr_usage_user_occurred")).toMatch(/COALESCE\(sent_at, created_at\)/);
    expect(sql("token_usage_cache_observed")).toMatch(/WHERE cache_read_tokens > 0/);
    expect(sql("secret_version_id")).toMatch(/CREATE UNIQUE INDEX/);
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM token_usage WHERE user_id = 'alice' AND COALESCE(sent_at, created_at) >= 0 AND COALESCE(sent_at, created_at) < 1",
    ).all() as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join("\n")).toContain("token_usage_user_occurred");
    db.close();
  });
});
