import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FlatCacheFileStore } from "../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { openDatabase, type SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { PendingFileDeleter, resolvedDir, retryBackoffMs, type PendingFile } from "../../../src/server/application/pending-file-delete.ts";
import { CacheGate } from "../../../src/server/pipeline/cache-gate.ts";
import { SplitMediaFiles } from "../../../src/server/pipeline/media-files.ts";
import type { FileStore } from "../../../src/server/ports/file-store.ts";
import type { Logger } from "../../../src/server/ports/logger.ts";
import { CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC, markerText } from "../../../src/shared/app-identity.ts";
import { TRASH_RETRY_BASE_MS, TRASH_RETRY_MAX_MS, TRASH_SWEEP_BATCH } from "../../../src/shared/defaults.ts";
import { insertRow, openTempDatabase, tempDataDir } from "../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const MINUTE = 60_000;

interface Rig {
  db: SqliteConnection;
  dir: string;
  repository: SqliteRepository;
  media: SplitMediaFiles;
  gate: CacheGate;
  deleter: PendingFileDeleter;
  clock: { now: number };
  warnings: string[];
  /** Refs whose removal fails with EBUSY, as a file held open would. */
  busy: Set<string>;
  /** Runs before every removal, in either store. */
  hooks: { beforeRemove?: (ref: string) => Promise<void> };
  foreign: Map<string, FileStore>;
  register(files: PendingFile[]): void;
  rows(): Array<{ ref: string; attempts: number; next: number; error: string | null }>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.deleter.stop();
    rig.db.close();
  }
});

/** Wraps a store so `busy` refs fail to be removed. */
function failing(store: FileStore, busy: Set<string>, hooks: Rig["hooks"]): FileStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "remove") {
        return async (ref: string) => {
          await hooks.beforeRemove?.(ref);
          if (busy.has(ref)) {
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          }
          await target.remove(ref);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** With `reopen`, opens the database already in that data directory, as a restarted process would. */
function rig(options: { foreign?: boolean; reopen?: string } = {}): Rig {
  const { db, dir } =
    options.reopen === undefined
      ? openTempDatabase()
      : { ...openDatabase(join(options.reopen, "amber.db"), { backupDir: join(options.reopen, "backups") }), dir: options.reopen };
  const repository = new SqliteRepository(db);
  const busy = new Set<string>();
  const hooks: Rig["hooks"] = {};
  const media = new SplitMediaFiles(
    failing(new LocalFileStore(dir), busy, hooks),
    (cacheDir, cacheOptions) => failing(new FlatCacheFileStore(cacheDir, cacheOptions), busy, hooks),
    join(dir, "media"),
  );
  const gate = new CacheGate();
  const clock = { now: T0 };
  const warnings: string[] = [];
  const logger: Logger = { debug: () => undefined, info: () => undefined, warn: (message) => void warnings.push(message), error: (message) => void warnings.push(message), child: () => logger };
  const foreign = new Map<string, FileStore>();
  const deleter = new PendingFileDeleter({
    repository,
    media,
    dataDir: dir,
    gate,
    ...(options.foreign === false ? {} : { foreignCacheRoot: async (root: string) => foreign.get(root) }),
    logger,
    now: () => clock.now,
  });
  const created: Rig = {
    db,
    dir,
    repository,
    media,
    gate,
    deleter,
    clock,
    warnings,
    busy,
    hooks,
    foreign,
    register: (files) => repository.withTransaction((scope) => deleter.register(scope, files)),
    rows: () =>
      db.prepare("SELECT storage_ref AS ref, attempts, next_attempt_at AS next, last_error AS error FROM pending_file_delete ORDER BY storage_ref").all() as Array<{
        ref: string;
        attempts: number;
        next: number;
        error: string | null;
      }>,
  };
  rigs.push(created);
  return created;
}

async function drain(r: Rig): Promise<void> {
  r.deleter.kick();
  await r.deleter.whenIdle();
}

async function writeData(r: Rig, ref: string, text = "data"): Promise<void> {
  await r.media.data.writeAtomic(ref, Buffer.from(text));
}

async function writeCache(r: Rig, ref: string, text: string): Promise<void> {
  await r.media.cache.writeAtomic(ref, Buffer.from(text));
}

/** A custom cache directory Amber owns: a `media` directory with the ownership marker. */
function customCacheDir(): string {
  const dir = join(tempDataDir("amber-cache-root-"), "media");
  mkdirSync(dir);
  writeFileSync(join(dir, CACHE_ROOT_MARKER), markerText(CACHE_ROOT_MARKER_MAGIC));
  return dir;
}

describe("retryBackoffMs", () => {
  it("doubles from the base and stops at the cap", () => {
    expect([1, 2, 3, 4].map(retryBackoffMs)).toEqual([TRASH_RETRY_BASE_MS, 2 * TRASH_RETRY_BASE_MS, 4 * TRASH_RETRY_BASE_MS, 8 * TRASH_RETRY_BASE_MS]);
    expect(retryBackoffMs(100)).toBe(TRASH_RETRY_MAX_MS);
  });
});

describe("PendingFileDeleter", () => {
  it("records the roots current at registration; a second registration of the same file keeps the first row", async () => {
    const r = rig();
    r.register([{ store: "data", storageRef: "assets/u/c/a", expectedSizeBytes: 4, userId: "u" }, { store: "cache", storageRef: "media/第一讲.mp4", expectedSizeBytes: 9 }]);
    r.clock.now += 5;
    r.register([{ store: "data", storageRef: "assets/u/c/a", expectedSizeBytes: 99 }]);
    expect(r.db.prepare("SELECT store, root_path AS root, storage_ref AS ref, expected_size_bytes AS size, user_id AS userId, next_attempt_at AS next FROM pending_file_delete ORDER BY store").all()).toEqual([
      { store: "cache", root: resolvedDir(join(r.dir, "media")), ref: "media/第一讲.mp4", size: 9, userId: null, next: T0 },
      { store: "data", root: resolvedDir(r.dir), ref: "assets/u/c/a", size: 4, userId: "u", next: T0 },
    ]);
    expect(r.deleter.nextDueAt()).toBe(T0);
    expect([...r.deleter.pendingCacheRefs()]).toEqual(["media/第一讲.mp4"]);
    expect(r.deleter.currentPendingRefs()).toEqual({ data: new Set(["assets/u/c/a"]), cache: new Set(["media/第一讲.mp4"]) });
  });

  it("removes data files and the Content directory once empty; a file already gone counts as removed", async () => {
    const r = rig();
    await writeData(r, "assets/u/c/a");
    await writeData(r, "assets/u/keep/b");
    r.register([
      { store: "data", storageRef: "assets/u/c/a", expectedSizeBytes: 4 },
      { store: "data", storageRef: "assets/u/c/gone", expectedSizeBytes: 4 },
    ]);
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(existsSync(join(r.dir, "assets", "u", "c"))).toBe(false);
    expect(existsSync(join(r.dir, "assets", "u", "keep", "b"))).toBe(true);
  });

  it("removes a scratch directory without a recorded size as it is", async () => {
    const r = rig();
    await writeData(r, "tmp/tasks/t1/asr-1.json", "{}");
    r.register([{ store: "data", storageRef: "tmp/tasks/t1" }]);
    await drain(r);
    expect(existsSync(join(r.dir, "tmp", "tasks", "t1"))).toBe(false);
    expect(r.rows()).toEqual([]);
  });

  it("drops the row but keeps a file whose size differs: it is not the purged file", async () => {
    const r = rig();
    await writeCache(r, "media/第一讲.mp4", "a newer, longer file");
    r.register([{ store: "cache", storageRef: "media/第一讲.mp4", expectedSizeBytes: 3 }]);
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(readFileSync(join(r.dir, "media", "第一讲.mp4"), "utf8")).toBe("a newer, longer file");
    expect(r.warnings).toEqual(["pending_file_mismatch"]);
  });

  it("keeps a file of the recorded size whose digest differs, and removes the one whose digest matches", async () => {
    const r = rig();
    const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
    await writeCache(r, "media/a.mp4", "abc");
    await writeCache(r, "media/b.mp4", "xyz");
    r.register([
      { store: "cache", storageRef: "media/a.mp4", expectedSizeBytes: 3, expectedDigest: sha("ABC") },
      { store: "cache", storageRef: "media/b.mp4", expectedSizeBytes: 3, expectedDigest: sha("xyz") },
    ]);
    expect(r.db.prepare("SELECT expected_digest AS digest FROM pending_file_delete ORDER BY storage_ref").all()).toEqual([{ digest: sha("ABC") }, { digest: sha("xyz") }]);
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(readFileSync(join(r.dir, "media", "a.mp4"), "utf8")).toBe("abc");
    expect(existsSync(join(r.dir, "media", "b.mp4"))).toBe(false);
    expect(r.warnings).toEqual(["pending_file_mismatch"]);
  });

  it("drops the row without touching the file while an available row holds the path", async () => {
    const r = rig();
    await writeCache(r, "media/held.mp4", "abc");
    insertRow(r.db, "user", { id: "u", role: "user", status: "active", created_at: 1 });
    insertRow(r.db, "content", { id: "c", user_id: "u", source_kind: "local", processing_status: "succeeded", created_at: 1, updated_at: 1 });
    insertRow(r.db, "media_asset", {
      id: "m", user_id: "u", content_id: "c", kind: "platform_cache", storage_ref: "media/held.mp4", mime_type: "video/mp4",
      size_bytes: 3, availability: "available", retention_policy: "evictable", created_at: 1,
    });
    r.register([{ store: "cache", storageRef: "media/held.mp4", expectedSizeBytes: 3 }]);
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(existsSync(join(r.dir, "media", "held.mp4"))).toBe(true);
  });

  it("retries a failed removal after 1, 2, then 4 minutes, and then removes it", async () => {
    const r = rig();
    await writeData(r, "assets/u/c/a");
    r.busy.add("assets/u/c/a");
    r.register([{ store: "data", storageRef: "assets/u/c/a", expectedSizeBytes: 4 }]);
    const waits: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const before = r.clock.now;
      await drain(r);
      const [row] = r.rows();
      expect(row).toMatchObject({ attempts: round + 1, error: "EBUSY" });
      waits.push((row?.next as number) - before);
      // Not due yet: nothing happens a millisecond early.
      r.clock.now = (row?.next as number) - 1;
      await drain(r);
      expect(r.rows()[0]?.attempts).toBe(round + 1);
      r.clock.now += 1;
    }
    expect(waits).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE]);
    r.busy.clear();
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(existsSync(join(r.dir, "assets", "u", "c", "a"))).toBe(false);
  });

  it("postpones every cache row by the base delay while a cache move holds the gate, without counting an attempt", async () => {
    const r = rig();
    await writeCache(r, "media/a.mp4", "aaa");
    await writeData(r, "assets/u/c/a");
    r.register([
      { store: "cache", storageRef: "media/a.mp4", expectedSizeBytes: 3 },
      { store: "data", storageRef: "assets/u/c/a", expectedSizeBytes: 4 },
    ]);
    const release = r.gate.tryExclusive("cache_migration");
    await drain(r);
    // The data directory does not depend on the cache lease.
    expect(r.rows()).toEqual([{ ref: "media/a.mp4", attempts: 0, next: T0 + TRASH_RETRY_BASE_MS, error: null }]);
    release?.();
    r.clock.now = T0 + TRASH_RETRY_BASE_MS;
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(existsSync(join(r.dir, "media", "a.mp4"))).toBe(false);
  });

  it("backs off the rows of an unplugged current cache directory and removes them once it is back", async () => {
    const r = rig();
    const custom = customCacheDir();
    r.media.cache.setRoot(custom);
    await writeCache(r, "media/a.mp4", "aaa");
    r.register([{ store: "cache", storageRef: "media/a.mp4", expectedSizeBytes: 3 }]);
    const parked = `${custom}-unplugged`;
    const { renameSync } = await import("node:fs");
    renameSync(custom, parked);
    await drain(r);
    expect(r.rows()).toEqual([{ ref: "media/a.mp4", attempts: 1, next: T0 + TRASH_RETRY_BASE_MS, error: "cache_unavailable" }]);
    renameSync(parked, custom);
    r.clock.now = T0 + TRASH_RETRY_BASE_MS;
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(existsSync(join(custom, "a.mp4"))).toBe(false);
  });

  it("removes a file of a former cache directory through that directory, never the same name in the current one", async () => {
    const r = rig();
    const oldRoot = r.deleter.currentCacheRoot();
    await writeCache(r, "media/第一讲.mp4", "old");
    r.register([{ store: "cache", storageRef: "media/第一讲.mp4", expectedSizeBytes: 3 }]);
    // The cache moves; a new file of the same name and size lands in the new directory.
    const custom = customCacheDir();
    r.media.cache.setRoot(custom);
    await writeCache(r, "media/第一讲.mp4", "new");

    // The old directory cannot be reached: the row waits the longest delay and nothing is touched.
    await drain(r);
    expect(r.rows()).toEqual([{ ref: "media/第一讲.mp4", attempts: 0, next: T0 + TRASH_RETRY_MAX_MS, error: null }]);
    expect(readFileSync(join(custom, "第一讲.mp4"), "utf8")).toBe("new");

    r.foreign.set(oldRoot, new FlatCacheFileStore(oldRoot));
    r.clock.now = T0 + TRASH_RETRY_MAX_MS;
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(existsSync(join(oldRoot, "第一讲.mp4"))).toBe(false);
    expect(readFileSync(join(custom, "第一讲.mp4"), "utf8")).toBe("new");
    // Only refs of the current directory keep names taken.
    r.register([{ store: "cache", storageRef: "media/b.mp4" }]);
    expect([...r.deleter.pendingCacheRefs()]).toEqual(["media/b.mp4"]);
    expect([...r.deleter.listRefs("cache", oldRoot)]).toEqual([]);
  });

  it("drainRoot removes a former directory's rows at once, due or not, and tells whether any is left", async () => {
    const r = rig();
    const oldRoot = r.deleter.currentCacheRoot();
    await writeCache(r, "media/a.mp4", "aaa");
    await writeCache(r, "media/held.mp4", "hhh");
    r.busy.add("media/held.mp4");
    r.register([
      { store: "cache", storageRef: "media/a.mp4", expectedSizeBytes: 3 },
      { store: "cache", storageRef: "media/held.mp4", expectedSizeBytes: 3 },
    ]);
    r.media.cache.setRoot(customCacheDir());
    // Not due for a while: drainRoot does not wait for that.
    r.db.prepare("UPDATE pending_file_delete SET next_attempt_at = ?").run(T0 + 10 * MINUTE);
    r.foreign.set(oldRoot, failing(new FlatCacheFileStore(oldRoot), r.busy, r.hooks));
    expect(await r.deleter.drainRoot(oldRoot)).toBe(false);
    expect(r.rows().map((row) => row.ref)).toEqual(["media/held.mp4"]);
    r.busy.clear();
    expect(await r.deleter.drainRoot(oldRoot)).toBe(true);
    expect(r.rows()).toEqual([]);
  });

  it("keeps a deleted user's rows and removes their files later", async () => {
    const r = rig();
    insertRow(r.db, "user", { id: "gone", role: "user", status: "active", created_at: T0 });
    await writeCache(r, "media/x.mp3", "xx");
    r.register([{ store: "cache", storageRef: "media/x.mp3", expectedSizeBytes: 2, userId: "gone" }]);
    r.db.prepare("DELETE FROM user WHERE id = 'gone'").run();
    expect(r.rows()).toHaveLength(1);
    await drain(r);
    expect(r.rows()).toEqual([]);
    expect(existsSync(join(r.dir, "media", "x.mp3"))).toBe(false);
  });

  it("works through more rows than one batch", async () => {
    const r = rig();
    const files = Array.from({ length: TRASH_SWEEP_BATCH + 3 }, (_, index) => ({ store: "data" as const, storageRef: `assets/u/c/f${index}`, expectedSizeBytes: 4 }));
    r.register(files);
    await drain(r);
    expect(r.rows()).toEqual([]);
  });

  it("runs one drain at a time: kicks during a run coalesce into a single follow-up", async () => {
    const r = rig();
    let removals = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    r.hooks.beforeRemove = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      removals += 1;
      concurrent -= 1;
    };
    r.register([{ store: "data", storageRef: "tmp/tasks/a" }]);
    r.deleter.kick();
    r.register([{ store: "data", storageRef: "tmp/tasks/b" }]);
    for (let i = 0; i < 5; i += 1) r.deleter.kick();
    await r.deleter.whenIdle();
    expect(maxConcurrent).toBe(1);
    expect(removals).toBe(2);
    expect(r.rows()).toEqual([]);
  });

  it("stop lets the file at hand finish, then nothing runs any more", async () => {
    const r = rig();
    r.register([{ store: "data", storageRef: "tmp/tasks/a" }, { store: "data", storageRef: "tmp/tasks/b" }]);
    let stopping: Promise<void> | undefined;
    r.hooks.beforeRemove = async () => {
      stopping ??= r.deleter.stop();
    };
    r.deleter.kick();
    await r.deleter.whenIdle();
    await stopping;
    expect(r.rows().map((row) => row.ref)).toEqual(["tmp/tasks/b"]);
    r.deleter.kick();
    await r.deleter.whenIdle();
    expect(r.rows()).toHaveLength(1);
  });

  it("never throws out of a drain and still reports it", async () => {
    const r = rig();
    let after = 0;
    const deleter = new PendingFileDeleter({
      repository: { withTransaction: () => { throw new Error("database is closed"); } },
      media: r.media,
      dataDir: r.dir,
      gate: r.gate,
      afterDrain: () => void (after += 1),
      logger: { ...silent(r), error: (message) => void r.warnings.push(message) },
    });
    deleter.kick();
    await deleter.whenIdle();
    expect(r.warnings).toContain("pending_file_drain_failed");
    expect(after).toBe(1);
  });
});

function silent(r: Rig): Logger {
  const logger: Logger = { debug: () => undefined, info: () => undefined, warn: (message) => void r.warnings.push(message), error: () => undefined, child: () => logger };
  return logger;
}

describe("across a restart", () => {
  it("loses no queued row when the process dies before the drain, then removes the purged files and keeps a changed one", async () => {
    const first = rig();
    await writeData(first, "assets/u/c/a");
    await writeCache(first, "media/第一讲.mp4", "a newer, longer file");
    first.register([
      { store: "data", storageRef: "assets/u/c/a", expectedSizeBytes: 4 },
      // Removed just before the crash, so its row outlived the file.
      { store: "data", storageRef: "assets/u/c/gone", expectedSizeBytes: 4 },
      { store: "cache", storageRef: "media/第一讲.mp4", expectedSizeBytes: 3 },
    ]);
    const queued = first.rows();
    expect(queued).toHaveLength(3);
    // Only the database survives the process: no drain ran and nothing is kept in memory.
    rigs.splice(rigs.indexOf(first), 1);
    await first.deleter.stop();
    first.db.close();

    const second = rig({ reopen: first.dir });
    expect(second.rows()).toEqual(queued);
    await drain(second);
    expect(second.rows()).toEqual([]);
    expect(existsSync(join(second.dir, "assets", "u", "c"))).toBe(false);
    expect(readFileSync(join(second.dir, "media", "第一讲.mp4"), "utf8")).toBe("a newer, longer file");
    expect(second.warnings).toEqual(["pending_file_mismatch"]);
  });
});
