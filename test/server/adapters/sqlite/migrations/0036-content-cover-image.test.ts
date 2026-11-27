import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { insertRow, tableNames, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const SHA = "ab".repeat(32);

/** A database at schema 35 holding Contents, then upgraded to 36. */
function upgraded() {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const old = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 35) });
  insertRow(old.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(old.db, "content", {
    id: "c1", user_id: "alice", source_kind: "bilibili", platform_content_id: "BV1xx411c7mD", title: "t",
    cover_url: "https://i0.hdslb.com/bfs/archive/x.jpg", processing_status: "succeeded", created_at: T0, updated_at: T0 + 1,
  });
  insertRow(old.db, "content", { id: "c2", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  const before = old.db.prepare("SELECT * FROM content ORDER BY rowid").all() as Array<Record<string, unknown>>;
  const everyTable = dumpTables(old.db);
  old.db.close();
  const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 36) });
  return { db, from, to, before, everyTable };
}

/** Every row of every table, by table name. */
function dumpTables(db: ReturnType<typeof openDatabase>["db"]): Record<string, unknown[]> {
  return Object.fromEntries(tableNames(db).map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

const cover = (contentId: string, overrides: Record<string, unknown> = {}) => ({
  content_id: contentId, user_id: "alice", image: Buffer.from([1, 2, 3]), width: 16, height: 9, bytes: 3, sha256: SHA, created_at: T0, updated_at: T0, ...overrides,
});

describe("migration 0036: local cover image", () => {
  it("keeps every Content as it was, with no local cover", () => {
    const { db, from, to, before, everyTable } = upgraded();
    expect({ from, to }).toEqual({ from: 35, to: 36 });
    // Every other table keeps its rows and values; only the new table and column are added.
    const after = dumpTables(db);
    for (const [name, rows] of Object.entries(everyTable)) {
      if (name !== "content" && name !== "schema_migrations") expect([name, after[name]]).toEqual([name, rows]);
    }
    expect(db.prepare("SELECT * FROM content ORDER BY rowid").all()).toEqual(before.map((row) => ({ ...row, cover_image_version: null })));
    expect(db.prepare("SELECT count(*) AS n FROM content_cover_image").get()).toEqual({ n: 0 });
    const content = new SqliteRepository(db).withTransaction((scope) => scope.contents.get("alice", "c1"));
    expect(content).toMatchObject({ id: "c1", coverUrl: "https://i0.hdslb.com/bfs/archive/x.jpg" });
    expect(content).not.toHaveProperty("coverImageVersion");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("checks the version and the stored image", () => {
    const { db } = upgraded();
    expect(() => db.prepare("UPDATE content SET cover_image_version = 0 WHERE id = 'c1'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE content SET cover_image_version = 1 WHERE id = 'c1'").run();
    for (const bad of [{ width: 0 }, { height: 0 }, { bytes: 0 }, { sha256: "ab" }, { sha256: "AB".repeat(32) }, { sha256: "zz".repeat(32) }]) {
      expect(() => insertRow(db, "content_cover_image", cover("c1", bad)), JSON.stringify(bad)).toThrow(/CHECK/);
    }
    // The owner must be the Content's: the key is the pair, as for every other per-Content table.
    insertRow(db, "user", { id: "bob", role: "user", status: "active", created_at: T0 });
    expect(() => insertRow(db, "content_cover_image", cover("c1", { user_id: "bob" }))).toThrow(/FOREIGN KEY/);
    insertRow(db, "content_cover_image", cover("c1"));
    db.prepare("DELETE FROM content WHERE id = 'c1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM content_cover_image").get()).toEqual({ n: 0 });
    db.close();
  });
});
