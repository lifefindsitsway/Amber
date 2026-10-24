import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function seed(db: SqliteConnection): void {
  insertRow(db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  for (const contentId of ["c1", "c2"]) {
    insertRow(db, "content", { id: contentId, user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  }
  insertRow(db, "transcript_revision", {
    id: "r1",
    content_id: "c1",
    kind: "asr",
    language: "zh-CN",
    timing_fidelity: "exact_words",
    generation_json: "{}",
    segment_count: 1,
    created_at: T0,
  });
  insertRow(db, "transcript_segment", { id: "s1", revision_id: "r1", ordinal: 0, start_ms: 0, end_ms: 1000, text: "第一句" });
}

function atVersion19(): { dir: string; file: string; revisions: unknown[] } {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 19) });
  seed(db);
  const revisions = db.prepare("SELECT * FROM transcript_revision").all();
  db.close();
  return { dir, file, revisions };
}

describe("migration 0020: archive marks for transcript revisions", () => {
  it("adds an empty archive table and leaves revisions as they were", () => {
    const { dir, file, revisions } = atVersion19();
    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 20) });
    expect({ from, to }).toEqual({ from: 19, to: 20 });
    expect(db.prepare("SELECT * FROM transcript_revision").all()).toEqual(revisions);
    expect(countRows(db, "transcript_revision_archive")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("keeps a mark on a revision of the same Content and drops it with the revision", () => {
    const { dir, file } = atVersion19();
    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 20) });
    insertRow(db, "transcript_revision_archive", { revision_id: "r1", content_id: "c1", archived_at: T0 + 1 });
    expect(() => insertRow(db, "transcript_revision_archive", { revision_id: "r1", content_id: "c1", archived_at: T0 + 2 })).toThrow(/UNIQUE/u);
    // The composite key refuses a mark that names another Content.
    db.prepare("DELETE FROM transcript_revision_archive").run();
    expect(() => insertRow(db, "transcript_revision_archive", { revision_id: "r1", content_id: "c2", archived_at: T0 + 1 })).toThrow(/FOREIGN KEY/u);
    insertRow(db, "transcript_revision_archive", { revision_id: "r1", content_id: "c1", archived_at: T0 + 1 });
    db.prepare("DELETE FROM transcript_revision WHERE id = 'r1'").run();
    expect(countRows(db, "transcript_revision_archive")).toBe(0);
    expect(countRows(db, "transcript_segment")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
