import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function atVersion20(): { dir: string; file: string } {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 20) });
  insertRow(db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(db, "media_asset", {
    id: "m", user_id: "alice", content_id: "c", kind: "platform_cache", storage_ref: "media/a.mp4", mime_type: "video/mp4",
    size_bytes: 3, quality: "1080", fingerprint: "sha256:a", availability: "available", retention_policy: "evictable", created_at: T0,
  });
  insertRow(db, "pending_file_delete", {
    id: "p", store: "cache", root_path: "/cache", storage_ref: "media/b.mp4", expected_size_bytes: 3, attempts: 0, next_attempt_at: T0, created_at: T0,
  });
  db.close();
  return { dir, file };
}

describe("migration 0021: cache quality verification and the digest of a queued delete", () => {
  it("marks existing caches unverified and leaves queued deletes without a digest", () => {
    const { dir, file } = atVersion20();
    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 21) });
    expect({ from, to }).toEqual({ from: 20, to: 21 });
    expect(db.prepare("SELECT quality, quality_verified AS verified FROM media_asset").get()).toEqual({ quality: "1080", verified: 0 });
    expect(db.prepare("SELECT expected_digest AS digest, expected_size_bytes AS size FROM pending_file_delete").get()).toEqual({ digest: null, size: 3 });
    expect(() => db.prepare("UPDATE media_asset SET quality_verified = 2").run()).toThrow(/CHECK/);
    db.prepare("UPDATE media_asset SET quality_verified = 1").run();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
});
