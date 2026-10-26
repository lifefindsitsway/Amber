import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../../shared/defaults.ts";
import { latestSchemaVersion, migrate, MIGRATIONS, schemaVersionUnsupported, type Migration } from "./migrations.ts";

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}

/** The connection surface this adapter exposes; the driver's own types stay inside the adapter. */
export interface SqliteConnection {
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): unknown;
}

export interface OpenDatabaseOptions {
  /** Where the pre-migration snapshot goes: `<dataDir>/backups`. */
  backupDir: string;
  migrations?: readonly Migration[];
  now?: () => number;
}

export interface OpenedDatabase {
  db: SqliteConnection;
  from: number;
  to: number;
  /** Set when an existing database was snapshotted before migrating. */
  backupPath?: string;
}

const HEADER_BYTES = 100;
const MAGIC = "SQLite format 3\u0000";
const USER_VERSION_OFFSET = 60;

/**
 * Opens the Amber database in a fixed order:
 * 1. read `user_version` without writing anything and refuse a newer schema, leaving the
 *    file untouched;
 * 2. snapshot an existing database with `VACUUM INTO` before any pending migration (never
 *    by copying a WAL database file); a failed snapshot stops the start;
 * 3. apply migrations;
 * 4. set WAL, foreign keys and the busy timeout.
 */
export function openDatabase(file: string, options: OpenDatabaseOptions): OpenedDatabase {
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = latestSchemaVersion(migrations);
  const found = readSchemaVersion(file);
  if (found > latest) {
    throw schemaVersionUnsupported(found, latest);
  }
  let backupPath: string | undefined;
  if (found > 0 && found < latest) {
    mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
    backupPath = join(options.backupDir, `pre-migration-v${found}-v${latest}-${(options.now ?? Date.now)()}.sqlite`);
    snapshot(file, backupPath);
  }
  const db: SqliteConnection = new Database(file);
  try {
    const { from, to } = migrate(db, migrations);
    db.pragma("journal_mode = WAL");
    // WAL keeps readers from blocking the single writer. The bundled SQLite already enforces
    // foreign keys on a new connection; the pragma states it rather than relying on the build.
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    return { db, from, to, ...(backupPath === undefined ? {} : { backupPath }) };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Reads `user_version` without modifying anything. A cleanly closed database is read from
 * its header, which creates no files; when a non-empty WAL or rollback journal exists the
 * header may be stale, so a read-only connection (which sees the WAL) is used instead.
 */
export function readSchemaVersion(file: string): number {
  if (!existsSync(file) || statSync(file).size === 0) {
    return 0;
  }
  const pendingLog = [`${file}-wal`, `${file}-journal`].some((log) => existsSync(log) && statSync(log).size > 0);
  const header = pendingLog ? undefined : readHeader(file);
  if (header !== undefined && header.toString("latin1", 0, MAGIC.length) === MAGIC) {
    return header.readInt32BE(USER_VERSION_OFFSET);
  }
  const readonly = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return readonly.pragma("user_version", { simple: true }) as number;
  } finally {
    readonly.close();
  }
}

function readHeader(file: string): Buffer | undefined {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    return readSync(fd, header, 0, HEADER_BYTES, 0) === HEADER_BYTES ? header : undefined;
  } finally {
    closeSync(fd);
  }
}

/** Consistent snapshot through SQLite itself; a read-only connection keeps the source untouched. */
function snapshot(file: string, target: string): void {
  const readonly = new Database(file, { readonly: true, fileMustExist: true });
  try {
    readonly.prepare("VACUUM INTO ?").run(target);
  } finally {
    readonly.close();
  }
}
