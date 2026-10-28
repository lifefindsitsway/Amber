import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { latestSchemaVersion, MIGRATIONS } from "../../src/server/adapters/sqlite/migrations.ts";
import { openDatabase } from "../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../src/server/adapters/sqlite/repository.ts";
import { ensureLocalUser } from "../../src/server/application/ensure-local-user.ts";
import { ensureInstanceSettings } from "../../src/server/application/instance-settings.ts";
import { ensureBuiltinSummaryTemplates } from "../../src/server/application/summary-templates.ts";
import {
  applyRestore,
  inspectRestore,
  recoverInterruptedRestore,
  recoverRestore,
  RESTORE_CHECKPOINTS,
  RestoreHalted,
  runRestoreCommand,
  type RestoreCheckpoint,
} from "../../src/server/restore.ts";
import { RESTORED_ORIGINALS_DIR_PREFIX } from "../../src/shared/backup.ts";
import { BACKUP_HEADER_MAX_BYTES, BACKUP_MANIFEST_MAX_BYTES } from "../../src/shared/defaults.ts";
import { RESTORE_PROGRESS_PREFIX, restoreApplyReportSchema, type RestoreApplyReport } from "../../src/shared/dto/backup.ts";
import { defaultSubtitleAppearance } from "../../src/shared/subtitle-style.ts";
import {
  archiveEntries,
  buildSourceLibrary,
  exportParts,
  rawTar,
  sha256,
  writeBackup,
  type BackupParts,
  type ExportChoice,
  type RawEntry,
  type SourceLibrary,
  type SourceOptions,
} from "../fixtures/backup/build-backup.ts";
import { createExportStack, seedLibrary, settled, sha256Of } from "../fixtures/backup/library.ts";
import { countingExecutor, createHarness, LOCAL, waitFor, type Harness } from "../fixtures/pipeline/harness.ts";
import { composeLocalStack, type ComposedLocalStack } from "../fixtures/server/composed-local-stack.ts";
import { insertRow, tempDataDir } from "../tools/sqlite.ts";

/** The offline restore, against archives forged the way an export writes them. */

const ALL: ExportChoice = { includeOriginals: true, includeCache: true };
const sources = new Map<string, Promise<SourceLibrary>>();

/** Building a source library is the slow part; tests that only read it share one per option set. */
function sourceOf(options: SourceOptions = {}): Promise<SourceLibrary> {
  const key = JSON.stringify(options);
  let source = sources.get(key);
  if (source === undefined) {
    source = buildSourceLibrary(options);
    sources.set(key, source);
  }
  return source;
}

/** A data directory as the sidecar leaves it after its first start: migrated, local user, built-in templates, settings. */
function freshTarget(seed?: (db: Database.Database) => void): string {
  const dir = tempDataDir("amber-target-");
  const file = join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups") });
  const repository = new SqliteRepository(db);
  ensureLocalUser(repository);
  ensureBuiltinSummaryTemplates(repository, 1);
  ensureInstanceSettings(repository);
  db.close();
  if (seed !== undefined) {
    const raw = new Database(file);
    raw.pragma("foreign_keys = ON");
    seed(raw);
    raw.close();
  }
  return dir;
}

/** Every file under `dir` with its hash, relative paths sorted; empty directories are left out. */
function treeOf(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  if (!existsSync(dir)) return tree;
  const walk = (current: string): void => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, name.name);
      if (name.isDirectory()) walk(path);
      else tree[relative(dir, path)] = sha256(readFileSync(path));
    }
  };
  walk(dir);
  return tree;
}

const crossVolumeRoots: string[] = [];
afterAll(() => {
  for (const root of crossVolumeRoots) rmSync(root, { recursive: true, force: true });
});

/** A directory the user picks for originals: on the temp volume, or on `/dev/shm` for a second volume. */
function pickedDir(crossVolume = false): string {
  if (!crossVolume) return tempDataDir("amber-picked-");
  const root = mkdtempSync(join("/dev/shm", "amber-picked-"));
  crossVolumeRoots.push(root);
  return root;
}

function archiveOf(parts: BackupParts, entries?: RawEntry[]): string {
  const archive = join(tempDataDir("amber-archive-"), "library.amberbackup");
  if (entries === undefined) writeBackup(archive, parts);
  else writeFileSync(archive, rawTar(entries));
  return archive;
}

function okReport(report: RestoreApplyReport): Extract<RestoreApplyReport, { ok: true }> {
  if (!report.ok) throw new Error(`restore failed: ${report.error.code}`);
  return report;
}

function openRestored(dataDir: string): Database.Database {
  return new Database(join(dataDir, "amber.db"), { readonly: true });
}

const count = (db: Database.Database, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

function tableCounts(db: Database.Database): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
  return Object.fromEntries(names.map((name) => [name, count(db, `SELECT count(*) AS n FROM "${name}"`)]));
}

const RESTORE_DIR = /^Amber-Restored-/u;
function restoreSubdir(parent: string): string {
  return join(parent, "Amber-Restored-20261019-120000");
}

describe("fresh target", () => {
  const cases: Array<[string, ((db: Database.Database) => void) | undefined, string | undefined]> = [
    ["a pristine install", undefined, undefined],
    [
      "only a model profile",
      (db) => insertRow(db, "provider_profile", { id: "p1", user_id: "local", name: "relay", protocol: "openai_compatible", base_url: "https://llm.invalid/v1", created_at: 1 }),
      "provider_profile",
    ],
    ["only a terminology set", (db) => insertRow(db, "terminology_set", { id: "t1", user_id: "local", scope_kind: "global" }), "terminology_set"],
    ["only a custom template", (db) => insertRow(db, "summary_template", { id: "u1", user_id: "local", builtin: 0, name: "mine", current_version: 1 }), "summary_template"],
    [
      "only a restored system prompt's history",
      (db) => {
        insertRow(db, "prompt_override", { user_id: "local", prompt_id: "chapter.ai", updated_at: 1 });
        insertRow(db, "prompt_override_version", { user_id: "local", prompt_id: "chapter.ai", version: 1, text: "mine", created_at: 1 });
      },
      "prompt_override_version",
    ],
    ["only a relocated cache", (db) => db.prepare("UPDATE instance_settings SET cache_root = '/elsewhere'").run(), "cache_root"],
    [
      "a stored secret",
      (db) =>
        insertRow(db, "secret", { id: "s1", user_id: "local", envelope_version: 1, kdf_salt: Buffer.alloc(16), nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(4), auth_tag: Buffer.alloc(16), created_at: 1, updated_at: 1 }),
      "secret",
    ],
    [
      "only a changed theme",
      (db) => insertRow(db, "user_settings", { user_id: "local", theme: "light", language: "en", shortcuts_json: "{}", updated_at: 1 }),
      undefined,
    ],
  ];
  it.each(cases)("%s", async (_name, seed, category) => {
    const source = await sourceOf();
    const archive = archiveOf(exportParts(source, { includeOriginals: false, includeCache: false }));
    const target = freshTarget(seed);
    const before = treeOf(target);
    const report = applyRestore({ archive, dataDir: target });
    if (category === undefined) {
      expect(okReport(report).database).toBe("ok");
      const db = openRestored(target);
      expect((db.prepare("SELECT theme FROM user_settings WHERE user_id = 'local'").get() as { theme: string }).theme).toBe("dark");
      db.close();
      return;
    }
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.error.code).toBe("conflict.library_not_empty");
    expect(report.error.details?.["nonEmpty"]).toEqual([category]);
    expect(treeOf(target)).toEqual(before);
    expect(existsSync(join(target, "tmp", "restore"))).toBe(false);
  });

  it("lists every non-empty category of a library in use", async () => {
    const source = await sourceOf();
    const archive = archiveOf(exportParts(source, { includeOriginals: false, includeCache: false }));
    const report = applyRestore({ archive, dataDir: dirname(source.file) });
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.error.details?.["nonEmpty"]).toEqual(expect.arrayContaining(["content", "collection", "task", "note", "provider_profile", "secret", "platform_account"]));
  });
});

describe("restore correctness", () => {
  it("restores the library: rows, citations, search, originals, caches, tasks, usage, profiles and preferences", async () => {
    const source = await sourceOf();
    const appearance = JSON.stringify(defaultSubtitleAppearance());
    const parts = exportParts(source, {
      ...ALL,
      uiPreferences: {
        "amber.subtitle.appearance.local": appearance,
        "amber.player.volume": "0.35",
        "amber.sidebar.width": "300",
        [`amber.subtitle.track.local.${source.contentIds[0]}`]: "x".repeat(5000),
      },
    });
    const archive = archiveOf(parts);
    const target = freshTarget();
    const picked = pickedDir();
    const progress: string[] = [];
    const report = okReport(
      applyRestore({ archive, dataDir: target, originalsDir: restoreSubdir(picked), onProgress: (event) => progress.push(event.phase) }),
    );
    expect(restoreApplyReportSchema.safeParse(report).success).toBe(true);
    expect(new Set(progress)).toEqual(new Set(["verify", "stage", "originals", "cache", "database", "cleanup"]));

    // Every table holds exactly the rows of the stripped snapshot.
    const snapshotFile = join(tempDataDir("amber-snapshot-"), "snapshot.sqlite");
    writeFileSync(snapshotFile, parts.database);
    const snapshot = new Database(snapshotFile, { readonly: true });
    const restored = openRestored(target);
    expect(tableCounts(restored)).toEqual(tableCounts(snapshot));
    snapshot.close();
    const sourceDb = new Database(source.file, { readonly: true });
    expect(count(sourceDb, "SELECT count(*) AS n FROM secret")).toBeGreaterThan(0);
    for (const table of ["content", "collection", "collection_item", "note", "transcript_segment", "summary_revision", "chat_message", "task", "token_usage", "asr_usage", "provider_profile", "asr_provider_profile"]) {
      expect(count(restored, `SELECT count(*) AS n FROM ${table}`), table).toBe(count(sourceDb, `SELECT count(*) AS n FROM ${table}`));
    }
    // Custom system prompts come back with their current version and their whole history.
    const prompts = (db: Database.Database) => ({
      overrides: db.prepare("SELECT prompt_id, current_version FROM prompt_override ORDER BY prompt_id").all(),
      versions: db.prepare("SELECT prompt_id, version, text, created_at FROM prompt_override_version ORDER BY prompt_id, version").all(),
    });
    expect(prompts(restored)).toEqual(prompts(sourceDb));
    expect(prompts(restored).overrides).toEqual([
      { prompt_id: "chapter.ai", current_version: 2 },
      { prompt_id: "summary.envelope", current_version: null },
    ]);
    expect(prompts(restored).versions).toHaveLength(3);
    sourceDb.close();
    for (const table of ["secret", "platform_account", "session", "pending_file_delete"]) {
      expect(count(restored, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }

    // Citations resolve and search finds the text.
    const bodies = [
      ...(restored.prepare("SELECT body AS text FROM summary_revision").all() as Array<{ text: string }>),
      ...(restored.prepare("SELECT text FROM chat_message").all() as Array<{ text: string }>),
    ];
    const markers = bodies.flatMap((row) => [...row.text.matchAll(/\[\[seg:([^\]\s]+)\]\]/gu)].map((match) => match[1] as string));
    expect(new Set(markers)).toEqual(new Set(source.citedSegmentIds));
    for (const segmentId of markers) {
      expect(count(restored, "SELECT count(*) AS n FROM transcript_segment WHERE id = ?", segmentId)).toBe(1);
    }
    expect(count(restored, "SELECT count(*) AS n FROM search_index WHERE search_index MATCH ?", '"要点与例子"')).toBeGreaterThan(0);

    // Originals: a new subdirectory, the rows pointing into it, hashes equal to the fingerprints, name collisions told apart.
    const originalsDir = report.originalsDir as string;
    expect(dirname(originalsDir)).toBe(picked);
    expect(basename(originalsDir)).toMatch(RESTORE_DIR);
    const rows = restored.prepare("SELECT id, storage_ref, availability, fingerprint FROM media_asset WHERE kind = 'external_local' ORDER BY id").all() as Array<{
      id: string;
      storage_ref: string;
      availability: string;
      fingerprint: string;
    }>;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.availability).toBe("available");
      expect(dirname(row.storage_ref)).toBe(originalsDir);
      expect(`sha256:${sha256(readFileSync(row.storage_ref))}`).toBe(row.fingerprint);
    }
    const [first, second, third] = source.originals;
    expect(rows.find((row) => row.id === first?.assetId)?.storage_ref).toBe(join(originalsDir, "lecture.mp4"));
    expect(rows.find((row) => row.id === second?.assetId)?.storage_ref).toBe(join(originalsDir, `Lecture (${second?.assetId.slice(-6)}).MP4`));
    expect(rows.find((row) => row.id === third?.assetId)?.storage_ref).toBe(join(originalsDir, "notes1.mp3"));
    expect(readdirSync(originalsDir).sort()).toHaveLength(3);
    // The source files themselves are untouched.
    for (const original of source.originals) expect(readFileSync(original.path)).toEqual(original.bytes);

    // Caches land in the default cache directory under their own names.
    const cache = source.caches[0];
    expect(readFileSync(join(target, "media", cache?.fileName as string))).toEqual(cache?.bytes);
    expect(restored.prepare("SELECT availability, storage_ref FROM media_asset WHERE id = ?").get(cache?.assetId)).toEqual({
      availability: "available",
      storage_ref: `media/${cache?.fileName}`,
    });
    expect(count(restored, "SELECT count(*) AS n FROM media_asset WHERE kind IN ('extracted_audio', 'temporary')")).toBe(0);

    // Finished Tasks are kept as they were; profiles stay without credentials.
    expect(restored.prepare("SELECT status_projection FROM task ORDER BY created_at").all()).toEqual([{ status_projection: "failed" }, { status_projection: "cancelled" }]);
    expect(count(restored, "SELECT count(*) AS n FROM provider_profile WHERE credential_ref IS NULL")).toBe(1);
    expect(count(restored, "SELECT count(*) AS n FROM asr_provider_profile WHERE credential_ref IS NULL")).toBe(2);
    expect(count(restored, "SELECT count(*) AS n FROM instance_settings WHERE cache_root IS NOT NULL")).toBe(0);
    restored.close();

    expect(report.restored).toEqual({ contents: 2, collections: 1, notes: 1, originals: 3, cache: 1, missingOriginals: 0, profilesNeedingCredentials: 3 });
    expect(report.preferences.candidates).toEqual({ "amber.subtitle.appearance.local": appearance, "amber.player.volume": "0.35" });
    expect(report.preferences.dropped).toEqual(
      expect.arrayContaining([
        { key: "amber.sidebar.width", reason: "not_allowed" },
        { key: `amber.subtitle.track.local.${source.contentIds[0]}`, reason: "too_large" },
      ]),
    );

    // The replaced database is kept aside; nothing of the restore is left in tmp.
    expect(readdirSync(join(target, "backups")).some((name) => /^pre-restore-\d{8}-\d{6}\.db$/u.test(name))).toBe(true);
    expect(existsSync(join(target, "tmp", "restore"))).toBe(false);
  });

  it("runs no Task after the restore and lets a profile take a new key", async () => {
    const source = await sourceOf();
    const target = freshTarget();
    okReport(applyRestore({ archive: archiveOf(exportParts(source, ALL)), dataDir: target, originalsDir: restoreSubdir(pickedDir()) }));
    const executor = countingExecutor();
    const h = createHarness({ file: join(target, "amber.db"), executors: Object.fromEntries(["media", "source", "subtitle", "asr", "proofread", "chapter", "highlight", "translate", "summary", "collection_summary"].map((stage) => [stage, executor])) as never });
    try {
      h.scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(executor.calls).toBe(0);
      expect(h.repository.withTransaction((scope) => scope.tasks.listUnfinished())).toEqual([]);
      const profile = h.db.prepare("SELECT id FROM provider_profile").get() as { id: string };
      const credentialRef = h.secrets.store(LOCAL.userId, "<placeholder-new-key>");
      h.db.prepare("UPDATE provider_profile SET credential_ref = ? WHERE id = ?").run(credentialRef, profile.id);
      expect(h.secrets.status(LOCAL.userId, credentialRef)).toBe("configured");
      expect(h.secrets.reveal(LOCAL.userId, credentialRef)).toBe("<placeholder-new-key>");
    } finally {
      await h.close();
    }
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("restores media with originals %s and caches %s, from a source whose cache directory is not available", async (includeOriginals, includeCache) => {
    const source = await sourceOf({ customCacheRoot: true });
    const target = freshTarget();
    const picked = pickedDir();
    const report = okReport(applyRestore({ archive: archiveOf(exportParts(source, { includeOriginals, includeCache })), dataDir: target, originalsDir: restoreSubdir(picked) }));
    const db = openRestored(target);
    for (const original of source.originals) {
      const row = db.prepare("SELECT availability, storage_ref FROM media_asset WHERE id = ?").get(original.assetId) as { availability: string; storage_ref: string };
      expect(row.availability).toBe(includeOriginals ? "available" : "missing");
      if (!includeOriginals) expect(row.storage_ref).toBe(original.path);
    }
    for (const cache of source.caches) {
      const row = db.prepare("SELECT availability FROM media_asset WHERE id = ?").get(cache.assetId) as { availability: string };
      expect(row.availability).toBe(includeCache ? "available" : "evicted");
      expect(existsSync(join(target, "media", cache.fileName))).toBe(includeCache);
    }
    expect(count(db, "SELECT count(*) AS n FROM instance_settings WHERE cache_root IS NOT NULL")).toBe(0);
    db.close();
    expect(report.originalsDir === null).toBe(!includeOriginals);
    // Without originals in the backup the chosen subdirectory is never created.
    expect(readdirSync(picked).some((name) => RESTORE_DIR.test(name))).toBe(includeOriginals);
    expect(report.restored.missingOriginals).toBe(includeOriginals ? 0 : 3);
  });

  it("keeps an explicitly excluded original missing at its old path", async () => {
    const source = await sourceOf();
    const excluded = source.originals[1]?.assetId as string;
    const target = freshTarget();
    const report = okReport(
      applyRestore({ archive: archiveOf(exportParts(source, { ...ALL, excludeOriginals: [excluded] })), dataDir: target, originalsDir: restoreSubdir(pickedDir()) }),
    );
    const db = openRestored(target);
    expect(db.prepare("SELECT availability, storage_ref FROM media_asset WHERE id = ?").get(excluded)).toEqual({ availability: "missing", storage_ref: source.originals[1]?.path });
    db.close();
    expect(report.restored).toMatchObject({ originals: 2, missingOriginals: 1 });
  });

  it("requires an originals directory when the backup carries originals", async () => {
    const source = await sourceOf();
    const report = applyRestore({ archive: archiveOf(exportParts(source, ALL)), dataDir: freshTarget() });
    expect(report.ok ? undefined : report.error.class).toBe("invalid_request");
  });

  it("migrates a backup of an older schema", async () => {
    const dir = tempDataDir("amber-old-");
    const file = join(dir, "old.sqlite");
    const older = MIGRATIONS.slice(0, -1);
    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: older });
    insertRow(db, "user", { id: "local", role: "admin", status: "active", created_at: 1 });
    db.close();
    const database = readFileSync(file);
    const version = latestSchemaVersion(older);
    const parts: BackupParts = {
      header: { ...exportParts(await sourceOf(), { includeOriginals: false, includeCache: false }).header, schemaVersion: version, counts: { contents: 0, collections: 0, notes: 0, originals: 0, cache: 0 }, sizes: { database: database.length, originals: 0, cache: 0 } },
      database,
      files: new Map(),
    };
    const target = freshTarget();
    okReport(applyRestore({ archive: archiveOf(parts), dataDir: target }));
    const restored = openRestored(target);
    expect(restored.pragma("user_version", { simple: true })).toBe(latestSchemaVersion());
    restored.close();
  });

  it("refuses a newer schema, and a header that misnames the schema", async () => {
    const parts = exportParts(await sourceOf(), { includeOriginals: false, includeCache: false });
    const dir = tempDataDir("amber-newer-");
    const file = join(dir, "db.sqlite");
    writeFileSync(file, parts.database);
    const db = new Database(file);
    db.pragma(`user_version = ${latestSchemaVersion() + 1}`);
    db.close();
    const newer = readFileSync(file);
    const target = freshTarget();
    const before = treeOf(target);
    const tooNew = applyRestore({
      archive: archiveOf({ ...parts, database: newer, header: { ...parts.header, schemaVersion: latestSchemaVersion() + 1, sizes: { ...parts.header.sizes, database: newer.length } } }),
      dataDir: target,
    });
    expect(tooNew.ok ? undefined : tooNew.error.code).toBe("schema_version_unsupported");
    const misnamed = applyRestore({ archive: archiveOf({ ...parts, header: { ...parts.header, schemaVersion: latestSchemaVersion() - 1 } }), dataDir: target });
    expect(misnamed.ok ? undefined : misnamed.error.code).toBe("backup_invalid");
    expect(treeOf(target)).toEqual(before);
  });

  it.each([
    ["a newer format version", { formatVersion: 2 }],
    ["a server-mode backup", { mode: "server" }],
  ])("refuses %s as backup_invalid", async (_name, change) => {
    const parts = exportParts(await sourceOf(), { includeOriginals: false, includeCache: false });
    const archive = archiveOf(parts, archiveEntries({ ...parts, header: { ...parts.header, ...change } as never }));
    const target = freshTarget();
    const before = treeOf(target);
    const report = applyRestore({ archive, dataDir: target });
    expect(report.ok ? undefined : report.error.code).toBe("backup_invalid");
    expect(inspectRestore(archive).ok).toBe(false);
    expect(treeOf(target)).toEqual(before);
  });
});

describe("inspect", () => {
  it("reads only the header, so damage further in does not show yet", async () => {
    const parts = exportParts(await sourceOf(), ALL);
    const archive = archiveOf(parts);
    const bytes = readFileSync(archive);
    writeFileSync(archive, bytes.subarray(0, bytes.length - 4096));
    const report = inspectRestore(archive);
    expect(report.ok ? report.header : undefined).toEqual(parts.header);
    expect(applyRestore({ archive, dataDir: freshTarget(), originalsDir: restoreSubdir(pickedDir()) }).ok).toBe(false);
  });

  it("refuses a file that is not a backup", () => {
    const file = join(tempDataDir("amber-junk-"), "junk.amberbackup");
    writeFileSync(file, "not a tar archive at all".repeat(100));
    const report = inspectRestore(file);
    expect(report.ok ? undefined : report.error.code).toBe("backup_invalid");
  });
});

describe("the restore command", () => {
  it("writes its report, prints progress lines and exits by the outcome", async () => {
    const source = await sourceOf();
    const archive = archiveOf(exportParts(source, ALL));
    const target = freshTarget();
    const reportFile = join(tempDataDir("amber-report-"), "report.json");
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await runRestoreCommand(["apply", "--archive", archive, "--data-dir", target, "--originals-dir", restoreSubdir(pickedDir()), "--report", reportFile]);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    expect(restoreApplyReportSchema.parse(JSON.parse(readFileSync(reportFile, "utf8"))).ok).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith(RESTORE_PROGRESS_PREFIX))).toBe(true);

    expect(await runRestoreCommand(["inspect", "--archive", archive, "--report", reportFile])).toBe(0);
    expect(JSON.parse(readFileSync(reportFile, "utf8")).header.counts.contents).toBe(2);
    expect(await runRestoreCommand(["recover", "--data-dir", target, "--report", reportFile])).toBe(0);
    expect(JSON.parse(readFileSync(reportFile, "utf8"))).toEqual({ ok: true, outcome: "nothing_to_do" });
    expect(await runRestoreCommand(["apply", "--archive", archive, "--data-dir", target, "--report", reportFile])).toBe(1);
  });
});

/** The state a rollback must return to, and the files of the user it must never touch. */
interface Scene {
  source: SourceLibrary;
  archive: string;
  target: string;
  picked: string;
  originalsDir: string;
  before: Record<string, string>;
  userFiles: Record<string, string>;
}

async function scene(crossVolume: boolean): Promise<Scene> {
  const source = await sourceOf();
  const archive = archiveOf(exportParts(source, ALL));
  const target = freshTarget();
  const picked = pickedDir(crossVolume);
  // The user's own files beside the restore directory, including one named like a restored original.
  writeFileSync(join(picked, "lecture.mp4"), "the user's own file");
  mkdirSync(join(picked, "photos"));
  writeFileSync(join(picked, "photos", "a.jpg"), "photo");
  return { source, archive, target, picked, originalsDir: restoreSubdir(picked), before: treeOf(target), userFiles: treeOf(picked) };
}

function halted(s: Scene, point: RestoreCheckpoint): void {
  expect(() =>
    applyRestore({
      archive: s.archive,
      dataDir: s.target,
      originalsDir: s.originalsDir,
      checkpoint: (reached) => {
        if (reached === point) throw new RestoreHalted(point);
      },
    }),
  ).toThrow(RestoreHalted);
}

function expectRolledBack(s: Scene): void {
  expect(treeOf(s.target)).toEqual(s.before);
  expect(existsSync(join(s.target, "tmp", "restore"))).toBe(false);
  expect(existsSync(s.originalsDir)).toBe(false);
  expect(treeOf(s.picked)).toEqual(s.userFiles);
}

function expectRestored(s: Scene): void {
  const db = openRestored(s.target);
  expect(count(db, "SELECT count(*) AS n FROM content")).toBe(2);
  expect(count(db, "SELECT count(*) AS n FROM media_asset WHERE kind = 'external_local' AND availability = 'available'")).toBe(3);
  db.close();
  expect(readdirSync(s.originalsDir)).toHaveLength(3);
  expect(existsSync(join(s.target, "tmp", "restore"))).toBe(false);
  const { [basename(s.originalsDir)]: _restored, ...userFiles } = Object.fromEntries(
    Object.entries(treeOf(s.picked)).filter(([path]) => !path.startsWith(basename(s.originalsDir))),
  );
  void _restored;
  expect(userFiles).toEqual(s.userFiles);
}

const ROLLS_BACK: ReadonlySet<RestoreCheckpoint> = new Set(["unpacking", "original_partial_written", "original_renamed", "cache_renamed", "database_moved_aside"]);

describe.each([
  ["on the data directory's volume", false],
  ["across volumes", true],
])("crash recovery %s", (_name, crossVolume) => {
  if (crossVolume) {
    it("really puts the originals on another device", async () => {
      const s = await scene(true);
      expect(statSync(s.picked).dev).not.toBe(statSync(s.target).dev);
    });
  }

  it.each(RESTORE_CHECKPOINTS.map((point) => [point]))("a crash at %s is settled by recover, twice", async (point) => {
    const s = await scene(crossVolume);
    halted(s, point);
    const first = recoverRestore(s.target);
    const afterFirst = { target: treeOf(s.target), picked: treeOf(s.picked) };
    const second = recoverRestore(s.target);
    expect(second).toEqual({ ok: true, outcome: "nothing_to_do" });
    expect({ target: treeOf(s.target), picked: treeOf(s.picked) }).toEqual(afterFirst);
    if (ROLLS_BACK.has(point)) {
      expect(first).toEqual({ ok: true, outcome: "rolled_back" });
      expectRolledBack(s);
    } else {
      expect(first).toEqual({ ok: true, outcome: point === "finished" ? "nothing_to_do" : "completed" });
      expectRestored(s);
    }
  });

  it.each(RESTORE_CHECKPOINTS.map((point) => [point]))("a crash at %s is settled when the sidecar starts", async (point) => {
    const s = await scene(crossVolume);
    halted(s, point);
    const outcome = await recoverInterruptedRestore(s.target);
    expect(outcome).toBe(ROLLS_BACK.has(point) ? "rolled_back" : point === "finished" ? "nothing_to_do" : "completed");
    if (ROLLS_BACK.has(point)) expectRolledBack(s);
    else expectRestored(s);
    expect(await recoverInterruptedRestore(s.target)).toBe("nothing_to_do");
  });
});

describe("file safety", () => {
  async function refused(build: (parts: BackupParts, entries: RawEntry[]) => RawEntry[], choice: ExportChoice = ALL): Promise<RestoreApplyReport> {
    const parts = exportParts(await sourceOf(), choice);
    const archive = archiveOf(parts, build(parts, archiveEntries(parts)));
    const target = freshTarget();
    const picked = pickedDir();
    const before = treeOf(target);
    const report = applyRestore({ archive, dataDir: target, originalsDir: restoreSubdir(picked) });
    expect(report.ok ? undefined : report.error.code).toBe("backup_invalid");
    expect(treeOf(target)).toEqual(before);
    expect(existsSync(join(target, "tmp", "restore"))).toBe(false);
    expect(readdirSync(picked)).toEqual([]);
    return report;
  }
  const replaceFirstOriginal = (entries: RawEntry[], replacement: Partial<RawEntry>): RawEntry[] =>
    entries.map((entry) => (entry.path.startsWith("originals/") && entries.find((e) => e.path.startsWith("originals/")) === entry ? { ...entry, ...replacement } : entry));
  const insertBeforeManifest = (entries: RawEntry[], extra: RawEntry): RawEntry[] => [...entries.slice(0, -1), extra, ...entries.slice(-1)];

  it("refuses a path that climbs out", () => refused((_p, entries) => insertBeforeManifest(entries, { path: "../../evil.txt", data: Buffer.from("x") })));
  it("refuses an absolute path", () => refused((_p, entries) => insertBeforeManifest(entries, { path: "/tmp/evil.txt", data: Buffer.from("x") })));
  it("refuses a symbolic link in place of an original", () => refused((_p, entries) => replaceFirstOriginal(entries, { type: "SymbolicLink", linkpath: "/etc/passwd", data: Buffer.alloc(0) })));
  it("refuses a hard link in place of an original", () => refused((_p, entries) => replaceFirstOriginal(entries, { type: "Link", linkpath: "database.sqlite", data: Buffer.alloc(0) })));
  it("refuses a device entry", () => refused((_p, entries) => replaceFirstOriginal(entries, { type: "CharacterDevice", data: Buffer.alloc(0) })));
  it("refuses a Windows reserved name", () =>
    refused((parts) => {
      const cache = parts.header.cache[0] as { assetId: string; archivePath: string };
      const header = { ...parts.header, cache: [{ ...cache, archivePath: "media/CON.mp4" }] };
      const files = new Map([...parts.files].map(([path, data]) => [path === cache.archivePath ? "media/CON.mp4" : path, data]));
      return archiveEntries({ ...parts, header, files });
    }));
  it("refuses an entry that appears twice", () => refused((_p, entries) => insertBeforeManifest(entries, entries[1] as RawEntry)));
  it("refuses an entry the header does not list", () => refused((_p, entries) => insertBeforeManifest(entries, { path: "originals/01EXTRA00000000000000000000.mp4", data: Buffer.from("x") })));
  it("refuses an entry after the manifest", () => refused((_p, entries) => [...entries, { path: "database.sqlite", data: Buffer.from("x") }]));
  it("refuses an archive without a manifest", () => refused((_p, entries) => entries.slice(0, -1)));
  it("refuses an archive whose first entry is not the header", () => refused((_p, entries) => [entries[1] as RawEntry, entries[0] as RawEntry, ...entries.slice(2)]));
  it("refuses an oversized header", () => refused((_p, entries) => [{ path: "header.json", data: Buffer.alloc(BACKUP_HEADER_MAX_BYTES + 1, 0x20) }, ...entries.slice(1)]));
  it("refuses an oversized manifest", () => refused((_p, entries) => [...entries.slice(0, -1), { path: "manifest.json", data: Buffer.alloc(BACKUP_MANIFEST_MAX_BYTES + 1, 0x20) }]));
  it("refuses a manifest of another header", () =>
    refused((_p, entries) => {
      const manifest = JSON.parse((entries.at(-1)?.data as Buffer).toString()) as { headerSha256: string };
      return [...entries.slice(0, -1), { path: "manifest.json", data: Buffer.from(JSON.stringify({ ...manifest, headerSha256: "0".repeat(64) })) }];
    }));
  it("refuses a file that does not match the manifest", () => refused((_p, entries) => replaceFirstOriginal(entries, { data: Buffer.from("tampered") })));
  it("refuses an original that does not match its fingerprint", () =>
    refused((parts) => {
      const original = parts.header.originals[0] as BackupParts["header"]["originals"][number];
      const tampered = Buffer.from("other content of the same file");
      const header = { ...parts.header, originals: parts.header.originals.map((o) => (o === original ? { ...o, sizeBytes: tampered.length } : o)) };
      return archiveEntries({ ...parts, header, files: new Map([...parts.files].map(([path, data]) => [path, path === original.archivePath ? tampered : data])) });
    }));
  it("refuses a truncated archive", () => refused((_p, entries) => entries.slice(0, 2)));

  it("leaves alone a restored file that was replaced after it was written", async () => {
    const parts = exportParts(await sourceOf(), ALL);
    const target = freshTarget();
    const picked = pickedDir();
    const originalsDir = restoreSubdir(picked);
    const before = treeOf(target);
    let intruder: string | undefined;
    const report = applyRestore({
      archive: archiveOf(parts),
      dataDir: target,
      originalsDir,
      checkpoint: (point) => {
        if (point === "original_partial_written" && intruder === undefined) {
          const partial = readdirSync(originalsDir).find((name) => name.endsWith(".partial")) as string;
          rmSync(join(originalsDir, partial));
          intruder = join(originalsDir, partial.slice(0, -".partial".length));
          writeFileSync(join(originalsDir, partial), "someone else's file");
        }
      },
    });
    expect(report.ok).toBe(false);
    expect(treeOf(target)).toEqual(before);
    // Not this restore's file: it stays, and so does the directory holding it.
    expect(readFileSync(intruder as string, "utf8")).toBe("someone else's file");
    expect(readdirSync(originalsDir)).toEqual([basename(intruder as string)]);
  });

  it("does not touch anything when the journal is damaged, and refuses a second restore meanwhile", async () => {
    const parts = exportParts(await sourceOf(), ALL);
    const archive = archiveOf(parts);
    const target = freshTarget();
    const originalsDir = restoreSubdir(pickedDir());
    expect(() => applyRestore({ archive, dataDir: target, originalsDir, checkpoint: (point) => { if (point === "original_renamed") throw new RestoreHalted(point); } })).toThrow(RestoreHalted);
    const journal = join(target, "tmp", "restore", "journal.json");
    const text = readFileSync(journal, "utf8");
    writeFileSync(journal, text.replace('"staged"', '"committed"'));
    const damaged = { target: treeOf(target), originals: treeOf(originalsDir) };
    expect(recoverRestore(target)).toEqual({ ok: true, outcome: "manual_required" });
    expect(await recoverInterruptedRestore(target)).toBe("manual_required");
    expect({ target: treeOf(target), originals: treeOf(originalsDir) }).toEqual(damaged);
    const second = applyRestore({ archive, dataDir: target, originalsDir: restoreSubdir(pickedDir()) });
    expect(second.ok ? undefined : second.error.code).toBe("conflict.backup_in_progress");
    expect({ target: treeOf(target), originals: treeOf(originalsDir) }).toEqual(damaged);
  });

  it("refuses an originals directory that exists, lies in the data directory, or is not a restore subdirectory", async () => {
    const archive = archiveOf(exportParts(await sourceOf(), ALL));
    const target = freshTarget();
    const existing = restoreSubdir(pickedDir());
    mkdirSync(existing);
    for (const originalsDir of [existing, restoreSubdir(target), join(pickedDir(), "Restored")]) {
      const report = applyRestore({ archive, dataDir: target, originalsDir });
      expect(report.ok ? undefined : report.error.class).toBe("invalid_request");
    }
    expect(readdirSync(existing)).toEqual([]);
  });

  it("refuses an originals directory reached through a symbolic link", async () => {
    const { symlinkSync } = await import("node:fs");
    const archive = archiveOf(exportParts(await sourceOf(), ALL));
    const real = pickedDir();
    const link = join(tempDataDir("amber-link-"), "link");
    symlinkSync(real, link);
    const report = applyRestore({ archive, dataDir: freshTarget(), originalsDir: restoreSubdir(link) });
    expect(report.ok ? undefined : report.error.class).toBe("invalid_request");
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses to run while another process writes to the live database", async () => {
    const archive = archiveOf(exportParts(await sourceOf(), { includeOriginals: false, includeCache: false }));
    const target = freshTarget();
    const writer = new Database(join(target, "amber.db"));
    writer.exec("BEGIN IMMEDIATE");
    try {
      const report = applyRestore({ archive, dataDir: target });
      expect(report.ok ? undefined : report.error.class).toBe("conflict");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    expect(existsSync(join(target, "tmp", "restore"))).toBe(false);
  });
});

/**
 * The client backup end to end: the export service writes an archive
 * from a populated library, the offline restore command applies it to a fresh installation,
 * and the restored backend serves the library through `/api`.
 */

const roundTripHarnesses: Harness[] = [];
const roundTripStacks: ComposedLocalStack[] = [];
afterEach(async () => {
  for (const stack of roundTripStacks.splice(0)) await stack.close();
  for (const h of roundTripHarnesses.splice(0)) await h.close();
});

async function exportLibrary(options: { includeOriginals: boolean; includeCache: boolean }) {
  const h = createHarness();
  roundTripHarnesses.push(h);
  const library = await seedLibrary(h);
  const stack = createExportStack(h);
  const archive = join(stack.destinationDir, "迁移.amberbackup");
  const accepted = stack.service.start({ grant: stack.grant(archive), ...options, uiPreferences: { "amber.player.volume": "0.4" } });
  const job = await settled(stack, accepted.jobId);
  expect(job.status).toBe("succeeded");
  return { h, library, archive };
}

/** A fresh installation: the data directory a first sidecar start leaves behind. */
async function composedFreshTarget(): Promise<string> {
  const stack = await composeLocalStack();
  await stack.close();
  return stack.dataDir;
}

describe("backup export → restore round trip", () => {
  it("restores the library, its original and its cache on a fresh installation", async () => {
    const { h, library, archive } = await exportLibrary({ includeOriginals: true, includeCache: true });
    const sourceDb = readFileSync(h.file);
    const dataDir = await composedFreshTarget();
    const originalsDir = join(tempDataDir("amber-roundtrip-originals-"), `${RESTORED_ORIGINALS_DIR_PREFIX}20261019-080000`);

    const report = applyRestore({ archive, dataDir, originalsDir });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(report.restored).toMatchObject({ contents: 1, collections: 1, notes: 1, originals: 1, cache: 1, missingOriginals: 0 });
    expect(report.restored.profilesNeedingCredentials).toBe(3);
    expect(report.preferences.candidates).toEqual({ "amber.player.volume": "0.4" });
    expect(readFileSync(h.file).equals(sourceDb)).toBe(true);
    expect(readFileSync(library.original.path).equals(library.original.bytes)).toBe(true);

    const db = new Database(join(dataDir, "amber.db"), { readonly: true });
    try {
      const original = db.prepare("SELECT storage_ref, availability, fingerprint FROM media_asset WHERE id = ?").get(library.original.assetId) as {
        storage_ref: string;
        availability: string;
        fingerprint: string;
      };
      expect(original.availability).toBe("available");
      expect(dirname(original.storage_ref)).toBe(originalsDir);
      expect(basename(original.storage_ref)).toBe(basename(library.original.path));
      expect(`sha256:${sha256Of(readFileSync(original.storage_ref))}`).toBe(original.fingerprint);
      const cache = db.prepare("SELECT storage_ref, availability FROM media_asset WHERE id = ?").get(library.cache.assetId) as { storage_ref: string; availability: string };
      expect(cache.availability).toBe("available");
      expect(readFileSync(join(dataDir, cache.storage_ref)).equals(library.cache.bytes)).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM media_asset WHERE id = ?").get(library.audio.assetId)).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM secret").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }

    const restored = await composeOn(dataDir);
    const contents = (await restored.send({ method: "GET", url: "/api/contents" })).json() as { items: Array<{ id: string }> };
    expect(contents.items.map((item) => item.id)).toEqual([library.contentId]);
    const notes = (await restored.send({ method: "GET", url: `/api/contents/${library.contentId}/notes` })).json() as { items: unknown[] };
    expect(notes.items).toHaveLength(1);
    const readiness = (await restored.send({ method: "GET", url: "/api/backup/restore-readiness" })).json() as { fresh: boolean };
    expect(readiness.fresh).toBe(false);
  });

  it("restores without the files: the original is missing and the cache evicted", async () => {
    const { library, archive } = await exportLibrary({ includeOriginals: false, includeCache: false });
    const dataDir = await composedFreshTarget();
    const report = applyRestore({ archive, dataDir });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(report.originalsDir).toBeNull();
    expect(report.restored).toMatchObject({ originals: 0, cache: 0, missingOriginals: 1 });
    const db = new Database(join(dataDir, "amber.db"), { readonly: true });
    try {
      const availability = (id: string) => (db.prepare("SELECT availability, storage_ref FROM media_asset WHERE id = ?").get(id) as { availability: string; storage_ref: string });
      expect(availability(library.original.assetId)).toEqual({ availability: "missing", storage_ref: library.original.path });
      expect(availability(library.cache.assetId).availability).toBe("evicted");
      expect(existsSync(join(dataDir, library.cache.ref))).toBe(false);
    } finally {
      db.close();
    }
  });
});

/** A backend composed on an existing data directory, as the restarted sidecar would be. */
async function composeOn(dataDir: string): Promise<ComposedLocalStack> {
  const stack = await composeLocalStack({ dataDir });
  roundTripStacks.push(stack);
  await stack.composition.startBackground();
  return stack;
}
