import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, migrate, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const REVISION = "01J0000000000000000000REV1";
const SEGMENT = "01J0000000000000000000SEG1";

/** A database at schema 30 holding a marked revision, then upgraded to 31. */
function upgraded() {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const old = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 30) });
  insertRow(old.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(old.db, "content", { id: "c1", user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(old.db, "transcript_revision", {
    id: REVISION, content_id: "c1", kind: "imported", language: "zh-CN", timing_fidelity: "segment_only",
    generation_json: JSON.stringify({ kind: "imported", format: "ambersub" }), segment_count: 1, created_at: T0,
  });
  insertRow(old.db, "transcript_segment", { id: SEGMENT, revision_id: REVISION, ordinal: 0, start_ms: 0, end_ms: 1000, text: "甲", paragraph_start: 1 });
  const before = old.db.prepare("SELECT * FROM transcript_revision").all() as Array<Record<string, unknown>>;
  old.db.close();
  const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 31) });
  return { db, from, to, before };
}

describe("migration 0031: transcript loose join", () => {
  it("keeps every revision as it was, read as not loosely joined", () => {
    const { db, from, to, before } = upgraded();
    expect({ from, to }).toEqual({ from: 30, to: 31 });
    expect(latestSchemaVersion(MIGRATIONS.slice(0, 31))).toBe(31);
    expect(db.pragma("user_version", { simple: true })).toBe(31);
    expect(db.prepare("SELECT * FROM transcript_revision").all()).toEqual(before.map((row) => ({ ...row, loose_join: null })));
    const column = (db.pragma("table_info(transcript_revision)") as Array<{ name: string; notnull: number; dflt_value: unknown }>).find((entry) => entry.name === "loose_join");
    expect(column).toEqual(expect.objectContaining({ notnull: 0, dflt_value: null }));
    // The repository is written for the latest schema.
    migrate(db);
    const repository = new SqliteRepository(db);
    const [revision, segments] = repository.withTransaction((scope) => [scope.transcripts.getRevision("alice", REVISION), scope.transcripts.listSegments("alice", REVISION)] as const);
    expect(revision).not.toHaveProperty("looseJoin");
    expect(segments.map((segment) => [segment.paragraphStart, "looseJoin" in segment])).toEqual([[true, false]]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("accepts only NULL and 1", () => {
    const { db } = upgraded();
    const insert = (looseJoin: number) =>
      insertRow(db, "transcript_revision", {
        id: `01J00000000000000000REV${looseJoin}X`, content_id: "c1", kind: "imported", language: "zh-CN", timing_fidelity: "segment_only",
        generation_json: "{}", segment_count: 0, loose_join: looseJoin, created_at: T0,
      });
    expect(() => insert(2)).toThrow(/CHECK/);
    expect(() => insert(0)).toThrow(/CHECK/);
    expect(() => insert(1)).not.toThrow();
    db.close();
  });

  it("leaves revisions immutable: the flag cannot be set afterwards", () => {
    const { db } = upgraded();
    expect(() => db.prepare("UPDATE transcript_revision SET loose_join = 1 WHERE id = ?").run(REVISION)).toThrow(/immutable/);
    expect(db.prepare("SELECT loose_join FROM transcript_revision WHERE id = ?").get(REVISION)).toEqual({ loose_join: null });
    db.close();
  });
});
