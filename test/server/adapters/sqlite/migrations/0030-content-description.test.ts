import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const ADDED = ["description", "description_truncated", "description_checked_at"];

/** A database at schema 29 holding Contents, then upgraded to 30. */
function upgraded() {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const old = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 29) });
  insertRow(old.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(old.db, "content", {
    id: "c1", user_id: "alice", source_kind: "bilibili", platform_content_id: "BV1xx411c7mD", title: "t",
    processing_status: "succeeded", created_at: T0, updated_at: T0 + 1,
  });
  insertRow(old.db, "content", { id: "c2", user_id: "alice", source_kind: "local_file", processing_status: "queued", created_at: T0, updated_at: T0 });
  const before = old.db.prepare("SELECT * FROM content ORDER BY rowid").all() as Array<Record<string, unknown>>;
  old.db.close();
  const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 30) });
  return { db, from, to, before, file };
}

describe("migration 0030: content description", () => {
  it("keeps every Content as it was and reads it as never checked", () => {
    const { db, from, to, before } = upgraded();
    expect({ from, to }).toEqual({ from: 29, to: 30 });
    expect(latestSchemaVersion(MIGRATIONS.slice(0, 30))).toBe(30);
    expect(db.pragma("user_version", { simple: true })).toBe(30);
    const after = db.prepare("SELECT * FROM content ORDER BY rowid").all();
    expect(after).toEqual(before.map((row) => ({ ...row, description: null, description_truncated: 0, description_checked_at: null })));
    const columns = (db.pragma("table_info(content)") as Array<{ name: string; notnull: number; dflt_value: unknown }>).filter((column) => ADDED.includes(column.name));
    expect(columns).toEqual([
      expect.objectContaining({ name: "description", notnull: 0, dflt_value: null }),
      expect.objectContaining({ name: "description_truncated", notnull: 1, dflt_value: "0" }),
      expect.objectContaining({ name: "description_checked_at", notnull: 0, dflt_value: null }),
    ]);
    const repository = new SqliteRepository(db);
    const content = repository.withTransaction((scope) => scope.contents.get("alice", "c1"));
    expect(content).not.toHaveProperty("description");
    expect(content).not.toHaveProperty("descriptionTruncated");
    expect(content).not.toHaveProperty("descriptionCheckedAt");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("accepts only 0 and 1 as the truncated flag", () => {
    const { db } = upgraded();
    expect(() => db.prepare("UPDATE content SET description_truncated = 2 WHERE id = 'c1'").run()).toThrow(/CHECK/);
    db.close();
  });

  it("is refused by the build before it, leaving the file untouched", () => {
    const { db, file } = upgraded();
    db.close();
    const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = hash();
    let thrown: unknown;
    try {
      openDatabase(file, { backupDir: join(file, "..", "backups"), migrations: MIGRATIONS.slice(0, 29) });
    } catch (error) {
      thrown = error;
    }
    expect(isAmberError(thrown) && thrown.appError.class).toBe("schema_version_unsupported");
    expect(isAmberError(thrown) && thrown.message).toMatch(/\b30\b.*\b29\b/u);
    expect(hash()).toBe(before);
  });
});
