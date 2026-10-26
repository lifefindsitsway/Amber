import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import type { LibraryCategory } from "../../../shared/backup.ts";
import { amberError } from "../../domain/errors.ts";
import type { BackupMediaRow, BackupStore, SnapshotScope, SnapshotSummary } from "../../ports/backup.ts";
import type { SqliteConnection } from "./database.ts";
import { nonEmptyCategories } from "./library-state.ts";

interface MediaRow {
  id: string;
  content_id: string;
  kind: "external_local" | "platform_cache";
  storage_ref: string;
  display_name: string | null;
  size_bytes: number;
  fingerprint: string | null;
}

/**
 * What a snapshot must not carry, cleared in this fixed order. Clearing `credential_ref`
 * only drops the references; deleting `platform_account` removes its secrets through the
 * delete triggers; the final `DELETE FROM secret` removes whatever is left, so no encrypted
 * envelope leaves the device even though the master key never does either.
 */
const STRIP_STATEMENTS = [
  "UPDATE provider_profile SET credential_ref = NULL",
  "UPDATE asr_provider_profile SET credential_ref = NULL",
  "UPDATE web_search_profile SET credential_ref = NULL",
  "DELETE FROM platform_account",
  "DELETE FROM secret",
  "DELETE FROM session",
  "DELETE FROM user_credential",
  "DELETE FROM idempotency_record",
  "DELETE FROM pending_file_delete",
  "DELETE FROM network_allowlist",
  "UPDATE instance_settings SET cache_root = NULL, cache_migration_json = NULL, credentials_reset_at = NULL",
  "UPDATE user_settings SET platform_cookie_browser = NULL",
  "DELETE FROM media_asset WHERE kind IN ('extracted_audio', 'temporary')",
  "UPDATE media_asset SET availability = 'evicted' WHERE kind = 'platform_cache' AND id NOT IN (SELECT id FROM temp.backup_included)",
  "UPDATE media_asset SET availability = 'missing' WHERE kind = 'managed_upload' OR (kind = 'external_local' AND id NOT IN (SELECT id FROM temp.backup_included))",
] as const;

function invalid(reason: string): never {
  throw amberError("backup_invalid", `backup snapshot check failed: ${reason}`);
}

/** The client backup's database side over the live connection. */
export class SqliteBackupStore implements BackupStore {
  private readonly db: SqliteConnection;
  private readonly file: string;

  constructor(options: { db: SqliteConnection; file: string }) {
    this.db = options.db;
    this.file = options.file;
  }

  snapshotTo(path: string): void {
    if (existsSync(path)) {
      throw new Error("snapshot target already exists");
    }
    // SQLite's own consistent copy of the committed state; WAL files are never copied.
    this.db.prepare("VACUUM INTO ?").run(path);
  }

  stripSnapshot(path: string, scope: SnapshotScope): SnapshotSummary {
    const snapshot = new Database(path, { fileMustExist: true });
    try {
      snapshot.pragma("foreign_keys = ON");
      snapshot.exec("CREATE TEMP TABLE backup_included (id TEXT PRIMARY KEY)");
      const include = snapshot.prepare("INSERT OR IGNORE INTO temp.backup_included (id) VALUES (?)");
      snapshot.transaction(() => {
        for (const id of scope.includedOriginals) include.run(id);
        for (const id of scope.includedCaches) include.run(id);
        for (const statement of STRIP_STATEMENTS) snapshot.exec(statement);
      })();
      snapshot.exec("DROP TABLE temp.backup_included");
      if ((snapshot.pragma("foreign_key_check") as unknown[]).length > 0) invalid("foreign_key_check");
      const integrity = snapshot.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") invalid("integrity_check");
      const count = (sql: string): number => (snapshot.prepare(sql).get() as { n: number }).n;
      if (count("SELECT count(*) AS n FROM secret") !== 0) invalid("secret rows left");
      return {
        schemaVersion: snapshot.pragma("user_version", { simple: true }) as number,
        contents: count("SELECT count(*) AS n FROM content"),
        collections: count("SELECT count(*) AS n FROM collection"),
        notes: count("SELECT count(*) AS n FROM note"),
      };
    } finally {
      snapshot.close();
    }
  }

  listBackupMedia(): { originals: BackupMediaRow[]; caches: BackupMediaRow[] } {
    const rows = this.db
      .prepare(
        `SELECT id, content_id, kind, storage_ref, display_name, size_bytes, fingerprint FROM media_asset
         WHERE availability = 'available' AND kind IN ('external_local', 'platform_cache') ORDER BY id`,
      )
      .all() as MediaRow[];
    const toRow = (row: MediaRow): BackupMediaRow => ({
      assetId: row.id,
      contentId: row.content_id,
      kind: row.kind,
      storageRef: row.storage_ref,
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      sizeBytes: row.size_bytes,
      ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    });
    return {
      originals: rows.filter((row) => row.kind === "external_local").map(toRow),
      caches: rows.filter((row) => row.kind === "platform_cache").map(toRow),
    };
  }

  databaseBytes(): number {
    // The WAL holds committed pages not yet checkpointed; the snapshot includes them.
    return [this.file, `${this.file}-wal`].reduce((sum, file) => sum + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
  }

  nonEmptyCategories(): LibraryCategory[] {
    return nonEmptyCategories(this.db);
  }
}
