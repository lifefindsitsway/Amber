import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type OpenedDatabase, type SqliteConnection } from "../../src/server/adapters/sqlite/database.ts";

/** A fresh data directory under the OS temp dir; tests never touch a real data directory. */
export function tempDataDir(prefix = "amber-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A migrated database in a fresh temp directory, opened exactly as the server opens it. */
export function openTempDatabase(): OpenedDatabase & { dir: string; file: string } {
  const dir = tempDataDir("amber-db-");
  const file = join(dir, "amber.db");
  return { ...openDatabase(file, { backupDir: join(dir, "backups") }), dir, file };
}

/**
 * Closes a database from `openTempDatabase` and opens the same file again, the way a restart
 * does: what a test reads afterwards is what was written to disk, not anything the old
 * connection still held.
 */
export function reopenTempDatabase(opened: { db: SqliteConnection; dir: string; file: string }): OpenedDatabase & { dir: string; file: string } {
  opened.db.close();
  return { ...openDatabase(opened.file, { backupDir: join(opened.dir, "backups") }), dir: opened.dir, file: opened.file };
}

/** Inserts one row from a map of SQL column names to values; values are bound, never interpolated. */
export function insertRow(db: SqliteConnection, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`).run(row);
}

export function countRows(db: SqliteConnection, table: string, where = "1", ...params: unknown[]): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

export function tableNames(db: SqliteConnection): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}
