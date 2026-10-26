import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteBackupStore } from "../../../../src/server/adapters/sqlite/backup-store.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { seedLibrary, sha256Of } from "../../../fixtures/backup/library.ts";
import { createHarness, LOCAL, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { insertRow, tableNames } from "../../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function rowCounts(db: { prepare(sql: string): { get(): unknown } }, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(tables.map((table) => [table, (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n]));
}

async function seeded() {
  const h = createHarness();
  open.push(h);
  const library = await seedLibrary(h);
  // Rows the snapshot must drop although they are not secrets.
  insertRow(h.db, "network_allowlist", { origin: "https://relay.invalid", created_at: 1 });
  insertRow(h.db, "session", { session_id_hash: "placeholder-hash", user_id: "bob", created_at: 1, last_seen_at: 1, expires_at: 2 });
  insertRow(h.db, "user_credential", { user_id: "bob", username: "bob", password_hash: "<placeholder>", must_change_password: 0 });
  insertRow(h.db, "idempotency_record", {
    user_id: LOCAL.userId, route: "POST /contents", idempotency_key: "k", request_digest: "d", response_status: 202,
    response_body_json: "{}", resource_refs_json: "[]", created_at: 1,
  });
  insertRow(h.db, "pending_file_delete", { id: "p1", store: "data", root_path: h.dir, storage_ref: "assets/x", next_attempt_at: 1, created_at: 1 });
  h.settings.effective();
  h.db.prepare("UPDATE instance_settings SET cache_root = ?, credentials_reset_at = 5").run(join(h.dir, "elsewhere"));
  h.repository.withTransaction((scope) => {
    const current = scope.userSettings.get(LOCAL.userId);
    if (current !== undefined) scope.userSettings.put({ ...current, platformCookieBrowser: "firefox" });
  });
  const store = new SqliteBackupStore({ db: h.db, file: h.file });
  return { h, library, store };
}

describe("SqliteBackupStore", () => {
  it("snapshots and strips a copy: no secret, no credential reference, no login state; the live database is untouched", async () => {
    const { h, library, store } = await seeded();
    const tables = tableNames(h.db).filter((name) => !name.startsWith("sqlite_") && !name.includes("search"));
    const before = rowCounts(h.db, tables);
    expect(before["secret"]).toBeGreaterThanOrEqual(4);
    for (const table of ["session", "user_credential", "idempotency_record", "pending_file_delete", "network_allowlist", "platform_account"]) {
      expect(before[table], table).toBeGreaterThan(0);
    }
    const liveBytes = sha256Of(readFileSync(h.file));

    const snapshot = join(h.dir, "snapshot.sqlite");
    store.snapshotTo(snapshot);
    const summary = store.stripSnapshot(snapshot, { includedOriginals: new Set(), includedCaches: new Set([library.cache.assetId]) });
    expect(summary.contents).toBe(1);
    expect(summary.collections).toBe(1);
    expect(summary.notes).toBe(1);
    expect(summary.schemaVersion).toBeGreaterThan(0);

    const copy = new Database(snapshot, { readonly: true });
    try {
      const count = (sql: string): number => (copy.prepare(sql).get() as { n: number }).n;
      expect(count("SELECT count(*) AS n FROM secret")).toBe(0);
      expect(count("SELECT count(*) AS n FROM platform_account")).toBe(0);
      expect(count("SELECT count(*) AS n FROM provider_profile WHERE credential_ref IS NOT NULL")).toBe(0);
      expect(count("SELECT count(*) AS n FROM asr_provider_profile WHERE credential_ref IS NOT NULL")).toBe(0);
      expect(count("SELECT count(*) AS n FROM provider_profile")).toBe(before["provider_profile"]);
      expect(count("SELECT count(*) AS n FROM asr_provider_profile")).toBe(2);
      for (const table of ["session", "user_credential", "idempotency_record", "pending_file_delete", "network_allowlist"]) {
        expect(count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
      }
      expect(copy.prepare("SELECT cache_root, cache_migration_json, credentials_reset_at FROM instance_settings").get()).toEqual({
        cache_root: null,
        cache_migration_json: null,
        credentials_reset_at: null,
      });
      expect(count("SELECT count(*) AS n FROM user_settings WHERE platform_cookie_browser IS NOT NULL")).toBe(0);
      expect(count("SELECT count(*) AS n FROM media_asset WHERE kind IN ('extracted_audio', 'temporary')")).toBe(0);
      const availability = (id: string): unknown => (copy.prepare("SELECT availability FROM media_asset WHERE id = ?").get(id) as { availability: string }).availability;
      expect(availability(library.cache.assetId)).toBe("available");
      expect(availability(library.original.assetId)).toBe("missing");
      expect(copy.pragma("foreign_key_check")).toEqual([]);
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(count("SELECT count(*) AS n FROM note")).toBe(1);
      expect(count("SELECT count(*) AS n FROM transcript_segment")).toBe(rowCounts(h.db, ["transcript_segment"])["transcript_segment"]);
    } finally {
      copy.close();
    }

    expect(rowCounts(h.db, tables)).toEqual(before);
    expect(sha256Of(readFileSync(h.file))).toBe(liveBytes);
  });

  it("strips the web search key: the profile stays, without its reference or its Secret", async () => {
    const { h, store } = await seeded();
    const credentialRef = h.secrets.store(LOCAL.userId, "tvly-placeholder-key");
    h.repository.withTransaction((scope) => scope.webSearchProfiles.put({ userId: LOCAL.userId, service: "tavily", credentialRef, createdAt: 1, updatedAt: 1 }));
    const snapshot = join(h.dir, "snapshot.sqlite");
    store.snapshotTo(snapshot);
    store.stripSnapshot(snapshot, { includedOriginals: new Set(), includedCaches: new Set() });
    const copy = new Database(snapshot, { readonly: true });
    try {
      expect(copy.prepare("SELECT user_id, service, credential_ref FROM web_search_profile").all()).toEqual([{ user_id: LOCAL.userId, service: "tavily", credential_ref: null }]);
      expect(copy.prepare("SELECT count(*) AS n FROM secret WHERE id = ?").get(credentialRef)).toEqual({ n: 0 });
      expect(copy.pragma("foreign_key_check")).toEqual([]);
    } finally {
      copy.close();
    }
    expect(h.repository.withTransaction((scope) => scope.webSearchProfiles.get(LOCAL.userId))?.credentialRef).toBe(credentialRef);
  });

  it("marks an excluded original missing and an uncached cache evicted", async () => {
    const { h, library, store } = await seeded();
    const snapshot = join(h.dir, "snapshot.sqlite");
    store.snapshotTo(snapshot);
    store.stripSnapshot(snapshot, { includedOriginals: new Set([library.original.assetId]), includedCaches: new Set() });
    const copy = new Database(snapshot, { readonly: true });
    try {
      const availability = (id: string): unknown => (copy.prepare("SELECT availability FROM media_asset WHERE id = ?").get(id) as { availability: string }).availability;
      expect(availability(library.original.assetId)).toBe("available");
      expect(availability(library.cache.assetId)).toBe("evicted");
    } finally {
      copy.close();
    }
  });

  it("refuses an existing snapshot target", async () => {
    const { h, store } = await seeded();
    const snapshot = join(h.dir, "snapshot.sqlite");
    store.snapshotTo(snapshot);
    expect(() => store.snapshotTo(snapshot)).toThrow();
  });

  it("fails backup_invalid when the copy's checks fail", async () => {
    const { h, store } = await seeded();
    const snapshot = join(h.dir, "snapshot.sqlite");
    store.snapshotTo(snapshot);
    // A dangling reference the strip does not repair stands for a damaged snapshot.
    const raw = new Database(snapshot);
    raw.pragma("foreign_keys = OFF");
    raw.prepare("UPDATE media_asset SET content_id = 'gone' WHERE kind = 'platform_cache'").run();
    raw.close();
    try {
      store.stripSnapshot(snapshot, { includedOriginals: new Set(), includedCaches: new Set() });
      expect.unreachable();
    } catch (error) {
      expect(isAmberError(error) && error.appError.class).toBe("backup_invalid");
    }
  });

  it("lists available originals and caches, and the fresh-install categories of the live database", async () => {
    const { library, store } = await seeded();
    const media = store.listBackupMedia();
    expect(media.originals.map((row) => row.assetId)).toEqual([library.original.assetId]);
    expect(media.originals[0]?.fingerprint).toBe(`sha256:${sha256Of(library.original.bytes)}`);
    expect(media.caches.map((row) => row.storageRef)).toEqual([library.cache.ref]);
    expect(store.databaseBytes()).toBeGreaterThan(0);
    expect(store.nonEmptyCategories()).toEqual(expect.arrayContaining(["content", "note", "secret", "provider_profile", "cache_root"]));
  });
});
