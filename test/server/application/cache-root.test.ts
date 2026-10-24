import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HmacFileGrantVerifier, signFileGrant } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { FlatCacheFileStore } from "../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { CacheRootService } from "../../../src/server/application/cache-root.ts";
import { PendingFileDeleter } from "../../../src/server/application/pending-file-delete.ts";
import { CacheRootsRegistry } from "../../../src/server/application/cache-roots-registry.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import type { AtomicWriteSource, FileStore, StoredFile, WriteAtomicOptions } from "../../../src/server/ports/file-store.ts";
import type { Logger } from "../../../src/server/ports/logger.ts";
import { CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC, CACHE_ROOTS_FILE, CACHE_SCRATCH_DIR, markerText } from "../../../src/shared/app-identity.ts";
import { cacheFileNameOf } from "../../../src/shared/cache-file-name.ts";
import { FILE_GRANT_TTL_MS } from "../../../src/shared/defaults.ts";
import { cacheLocationDtoSchema } from "../../../src/shared/dto/local-media.ts";
import type { CacheHoldDto, FileGrant } from "../../../src/shared/dto/local-media.ts";
import type { CacheDirReason } from "../../../src/shared/errors.ts";
import { cacheDirErrors } from "../../../src/shared/i18n/zh-CN/errors.ts";
import { BYTES_PER_GB } from "../../../src/shared/units.ts";
import { BOB, createLocalContent, gate, LOCAL, silentLogger } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";
import { countRows, tempDataDir } from "../../tools/sqlite.ts";

const open: Array<{ s: MediaStack; service: CacheRootService }> = [];
afterEach(async () => {
  for (const { s, service } of open.splice(0)) {
    await service.close();
    await s.close();
  }
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

/** The code, reason and message of a refused cache location. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; reason: unknown; userMessage: string }> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return { code: error.appError.code, reason: error.appError.details?.reason, userMessage: error.appError.userMessage };
    throw error;
  }
  throw new Error("expected a rejection");
}

function refused(reason: CacheDirReason): { code: string; reason: CacheDirReason; userMessage: string } {
  return { code: "invalid_request.cache_dir", reason, userMessage: cacheDirErrors[reason] };
}

/** A fresh, empty `media` directory on its own temp root, as the shell would create it. */
function cacheDir(name = "media"): string {
  const dir = join(tempDataDir("amber-cache-root-"), name);
  mkdirSync(dir);
  return realpathSync(dir);
}

const flat = (dir: string, options?: { createDir?: boolean }): FileStore => new FlatCacheFileStore(dir, options);

/** Lets a test hold the first write of one directory until it opens the gate. */
class BlockingStore extends FlatCacheFileStore {
  private readonly blocker: Promise<void>;

  constructor(dir: string, blocker: Promise<void>) {
    super(dir);
    this.blocker = blocker;
  }

  override async writeAtomic(ref: string, data: AtomicWriteSource, options?: WriteAtomicOptions): Promise<StoredFile> {
    await this.blocker;
    return super.writeAtomic(ref, data, options);
  }
}

class FailingWriteStore extends FlatCacheFileStore {
  override writeAtomic(): Promise<StoredFile> {
    return Promise.reject(new Error("EIO: write failed"));
  }
}

class LowDiskStore extends FlatCacheFileStore {
  override diskUsage(): ReturnType<FileStore["diskUsage"]> {
    return Promise.resolve({ usedBytes: 0, freeBytes: 1, totalBytes: 100 });
  }
}

/** A volume with a fixed free space and no ratio to speak of. */
class FixedVolumeStore extends FlatCacheFileStore {
  private readonly free: number;

  constructor(dir: string, free: number) {
    super(dir);
    this.free = free;
  }

  override diskUsage(): ReturnType<FileStore["diskUsage"]> {
    return Promise.resolve({ usedBytes: 0, freeBytes: this.free, totalBytes: 0 });
  }
}

class FailingRemoveStore extends FlatCacheFileStore {
  private readonly failing: () => boolean;

  constructor(dir: string, failing: () => boolean) {
    super(dir);
    this.failing = failing;
  }

  override remove(ref: string): Promise<void> {
    return this.failing() ? Promise.reject(new Error("EBUSY: remove failed")) : super.remove(ref);
  }
}

interface Setup {
  s: MediaStack;
  service: CacheRootService;
  dataRoot: string;
  /** `<data dir>/media`, the default cache directory. */
  defaultDir: string;
  /** A flat store over the default cache directory, independent of where the cache points now. */
  defaults: FileStore;
  grant(path: string, purpose?: FileGrant["purpose"]): FileGrant;
  /** Writes a cache file through the current cache store and registers its row. */
  addCache(contentId: string, text: string, userId?: string): Promise<MediaAsset>;
  asset(asset: MediaAsset): MediaAsset | undefined;
  migration(): unknown;
  registered(): Promise<string[]>;
  /** The pending-file worker, reaching former cache directories through the service. */
  deleter: PendingFileDeleter;
  warnings: string[];
}

let names = 0;

function setup(
  options: { storeFactory?: (dir: string, options?: { createDir?: boolean }) => FileStore; isWindows?: boolean; registry?: Pick<CacheRootsRegistry, "add" | "remove">; holds?: () => CacheHoldDto[] } = {},
): Setup {
  const s = createMediaStack();
  const key = randomBytes(32);
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (message) => void warnings.push(message) };
  let created: CacheRootService | undefined;
  const deleter = new PendingFileDeleter({
    repository: s.h.repository,
    media: s.stores,
    dataDir: s.h.dir,
    gate: s.h.gate,
    foreignCacheRoot: async (root) => created?.ownedStoreOver(root),
    logger,
  });
  const service = new CacheRootService({
    repository: s.h.repository,
    settings: s.h.settings,
    media: s.stores,
    gate: s.h.gate,
    grants: new HmacFileGrantVerifier(key),
    dataDir: s.h.dir,
    storeFactory: options.storeFactory ?? flat,
    fileDeleter: deleter,
    logger,
    newId: s.h.newId,
    ...(options.isWindows === undefined ? {} : { isWindows: options.isWindows }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.holds === undefined ? {} : { holds: options.holds }),
  });
  created = service;
  open.push({ s, service });
  // The temp volume of the test machine must not decide these tests.
  s.h.settings.patch(LOCAL, { lowWaterFreeGB: 0.001, lowWaterFreeRatio: 0 });
  const dataRoot = realpathSync(s.h.dir);
  const defaultDir = join(dataRoot, "media");
  return {
    s,
    service,
    dataRoot,
    defaultDir,
    defaults: new FlatCacheFileStore(defaultDir, { createDir: true }),
    grant: (path, purpose = "cache_dir") => signFileGrant(key, { path, purpose, expiresAt: Date.now() + FILE_GRANT_TTL_MS }),
    async addCache(contentId, text, userId = LOCAL.userId) {
      const id = s.h.newId();
      names += 1;
      const storageRef = `media/第 ${names} 讲 #${names}.mp4`;
      const stored = await s.stores.cache.writeAtomic(storageRef, Buffer.from(text));
      const asset: MediaAsset = {
        id, userId, contentId, kind: "platform_cache", storageRef, mimeType: "video/mp4", sizeBytes: stored.sizeBytes, quality: "720",
        fingerprint: stored.digest, availability: "available", retentionPolicy: "evictable", createdAt: 1,
      };
      s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
      return asset;
    },
    asset: (asset) => s.h.repository.withTransaction((scope) => scope.mediaAssets.get(asset.userId, asset.id)),
    migration: () => s.h.settings.effective().cacheMigration,
    registered: () => new CacheRootsRegistry(join(s.h.dir, CACHE_ROOTS_FILE)).list(),
    deleter,
    warnings,
  };
}

async function addUpload(s: MediaStack, contentId: string): Promise<MediaAsset> {
  const id = s.h.newId();
  const storageRef = `assets/${LOCAL.userId}/${contentId}/${id}`;
  await s.files.writeAtomic(storageRef, Buffer.from("upload"));
  const asset: MediaAsset = {
    id, userId: LOCAL.userId, contentId, kind: "managed_upload", storageRef, mimeType: "video/mp4", sizeBytes: 6, availability: "available",
    retentionPolicy: "keep", createdAt: 1,
  };
  s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  return asset;
}

const onDisk = (dir: string, ref: string): boolean => existsSync(join(dir, cacheFileNameOf(ref)));
const markerOf = (dir: string): string | undefined => (existsSync(join(dir, CACHE_ROOT_MARKER)) ? readFileSync(join(dir, CACHE_ROOT_MARKER), "utf8") : undefined);

/** Whether a lease could be taken right now; it is released again at once. */
function canTake(lease: (() => void) | undefined): boolean {
  lease?.();
  return lease !== undefined;
}

describe("CacheRootService.status", () => {
  it("reports the default media directory with the usage of every user's available caches, and is admin-only", async () => {
    const t = setup();
    const mine = createLocalContent(t.s.h);
    const bobs = createLocalContent(t.s.h, BOB.userId);
    const a = await t.addCache(mine, "aaaa");
    await t.addCache(bobs, "bbbbbb", BOB.userId);
    const evicted = await t.addCache(mine, "cc");
    t.s.h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...evicted, availability: "evicted" }));

    const status = await t.service.status(LOCAL);
    expect(cacheLocationDtoSchema.parse(status)).toEqual({
      path: join(t.s.h.dir, "media"),
      isDefault: true,
      available: true,
      fileCount: 2,
      usedBytes: a.sizeBytes + 6,
      freeBytes: expect.any(Number),
      totalBytes: expect.any(Number),
      holds: [],
    });
    // The free space is the cache directory's volume, which the test machine decides.
    expect(status.totalBytes).toBeGreaterThan(0);
    expect(status.freeBytes).toBeLessThanOrEqual(status.totalBytes);
    expect(onDisk(t.defaultDir, a.storageRef)).toBe(true);
    expect(await codeOf(t.service.status(BOB))).toBe("forbidden");
    expect(await codeOf(t.service.change(BOB, { useDefault: true }))).toBe("forbidden");
  });

  it("lists the interrupted replacements waiting for the user, read anew on every status", async () => {
    let holds: CacheHoldDto[] = [];
    const t = setup({ holds: () => holds });
    expect((await t.service.status(LOCAL)).holds).toEqual([]);
    holds = [{ assetId: "01HOLD", contentId: "01CONTENT", title: "第一讲", fileName: "第一讲 720p.mp4", currentSizeBytes: 10, displacedSizeBytes: 20 }];
    const status = await t.service.status(LOCAL);
    expect(cacheLocationDtoSchema.parse(status).holds).toEqual(holds);
  });
});

describe("CacheRootService.change", () => {
  it("moves the cache to a custom media directory and back, owning it only while in use and leaving other kinds alone", async () => {
    const t = setup();
    const content = createLocalContent(t.s.h);
    const first = await t.addCache(content, "first video");
    const second = await t.addCache(content, "second video");
    const gone = await t.addCache(content, "vanished");
    await t.s.stores.cache.remove(gone.storageRef);
    const upload = await addUpload(t.s, content);
    const target = cacheDir();
    // A crashed download's scratch in the old directory goes with the old files.
    mkdirSync(join(t.defaultDir, CACHE_SCRATCH_DIR, "01OLD"), { recursive: true });
    writeFileSync(join(t.defaultDir, CACHE_SCRATCH_DIR, "01OLD", "video.f30080.mp4"), "stream");

    const accepted = await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    expect(accepted.migration === undefined || ["copying", "cleanup_pending"].includes(accepted.migration.phase)).toBe(true);
    await t.service.whenIdle();

    const status = await t.service.status(LOCAL);
    expect(status).toEqual({
      path: target,
      isDefault: false,
      available: true,
      fileCount: 2,
      usedBytes: first.sizeBytes + second.sizeBytes,
      freeBytes: expect.any(Number),
      totalBytes: expect.any(Number),
      holds: [],
    });
    expect(t.s.stores.cache.root()).toBe(target);
    expect(t.s.h.settings.effective().cacheRoot).toBe(target);
    expect(t.migration()).toBeUndefined();
    expect(markerOf(target)).toBe(markerText(CACHE_ROOT_MARKER_MAGIC));
    expect(await t.registered()).toEqual([target]);
    for (const asset of [first, second]) {
      expect(t.asset(asset)).toEqual(asset);
      // Flat: the file lies directly in the chosen directory under its readable name.
      expect(onDisk(target, asset.storageRef)).toBe(true);
      expect(onDisk(t.defaultDir, asset.storageRef)).toBe(false);
      expect(await t.s.stores.cache.digest(asset.storageRef)).toBe(asset.fingerprint);
    }
    expect(t.asset(gone)?.availability).toBe("evicted");
    expect(await t.s.files.stat(upload.storageRef)).toEqual({ sizeBytes: 6 });
    expect(existsSync(join(t.defaultDir, CACHE_SCRATCH_DIR))).toBe(false);
    // Tasks may run again.
    expect(canTake(t.s.h.gate.tryShared())).toBe(true);

    // The custom directory's scratch holds a link to the user's files: the link goes, never what it points to.
    const outside = join(tempDataDir("amber-cache-outside-"), "keep.txt");
    writeFileSync(outside, "mine");
    mkdirSync(join(target, CACHE_SCRATCH_DIR, "01NEW"), { recursive: true });
    symlinkSync(join(outside, ".."), join(target, CACHE_SCRATCH_DIR, "01NEW", "link"), "dir");
    await t.service.change(LOCAL, { useDefault: true });
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).toMatchObject({ path: join(t.s.h.dir, "media"), isDefault: true, fileCount: 2 });
    expect(t.s.stores.cache.root()).toBeUndefined();
    expect(t.s.h.settings.effective().cacheRoot).toBeUndefined();
    for (const asset of [first, second]) {
      expect(await t.defaults.digest(asset.storageRef)).toBe(asset.fingerprint);
    }
    // The emptied custom directory is removed with its marker and unregistered; its parent is the user's.
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(target, ".."))).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("mine");
    expect(await t.registered()).toEqual([]);
  });

  it("removes files purged under the old directory through it before giving it up", async () => {
    const t = setup();
    const content = createLocalContent(t.s.h);
    const kept = await t.addCache(content, "kept video");
    const target = cacheDir();
    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();
    // A cache purged while the custom directory was current, its file not removed yet.
    const purged = await t.addCache(createLocalContent(t.s.h), "purged video");
    t.s.h.repository.withTransaction((scope) => {
      scope.mediaAssets.delete(LOCAL.userId, purged.id);
      t.deleter.register(scope, [{ store: "cache", storageRef: purged.storageRef, expectedSizeBytes: purged.sizeBytes }]);
    });

    await t.service.change(LOCAL, { useDefault: true });
    await t.service.whenIdle();
    expect(countRows(t.s.h.db, "pending_file_delete")).toBe(0);
    expect(onDisk(t.defaultDir, purged.storageRef)).toBe(false);
    expect(onDisk(t.defaultDir, kept.storageRef)).toBe(true);
    // Emptied in time, so the old directory went with its marker.
    expect(existsSync(target)).toBe(false);
    expect(await t.registered()).toEqual([]);
  });

  it("keeps an old directory marked and the cleanup pending while a purged file in it cannot go yet", async () => {
    const t = setup();
    const target = cacheDir();
    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();
    const purged = await t.addCache(createLocalContent(t.s.h), "purged video");
    t.s.h.repository.withTransaction((scope) => {
      scope.mediaAssets.delete(LOCAL.userId, purged.id);
      t.deleter.register(scope, [{ store: "cache", storageRef: purged.storageRef, expectedSizeBytes: purged.sizeBytes }]);
    });
    // A read-only directory: its file cannot be removed, as if held open.
    const held = join(target, cacheFileNameOf(purged.storageRef));
    chmodSync(target, 0o500);
    try {
      await t.service.change(LOCAL, { useDefault: true });
      await t.service.whenIdle();
    } finally {
      chmodSync(target, 0o700);
    }
    expect(t.migration()).toMatchObject({ phase: "cleanup_pending", from: target });
    expect(markerOf(target)).toBe(markerText(CACHE_ROOT_MARKER_MAGIC));
    expect(existsSync(held)).toBe(true);
    expect(t.warnings).toContain("cache_cleanup_failed");
  });

  it("rolls back when a copy does not match the recorded fingerprint and remembers the failure until the next attempt", async () => {
    const t = setup();
    const content = createLocalContent(t.s.h);
    const good = await t.addCache(content, "good");
    const bad = await t.addCache(content, "bad");
    const upload = await addUpload(t.s, content);
    t.s.h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...bad, fingerprint: `sha256:${"0".repeat(64)}` }));
    const target = cacheDir();

    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();

    const status = await t.service.status(LOCAL);
    expect(status).toMatchObject({ isDefault: true, migration: { phase: "failed", error: { class: "media_changed" } } });
    expect(t.migration()).toBeUndefined();
    expect(t.s.stores.cache.root()).toBeUndefined();
    expect(await t.defaults.digest(good.storageRef)).toBe(good.fingerprint);
    expect(await t.defaults.stat(bad.storageRef)).not.toBeNull();
    expect(await t.s.files.stat(upload.storageRef)).not.toBeNull();
    expect(existsSync(target)).toBe(false);
    expect(await t.registered()).toEqual([]);
    expect(canTake(t.s.h.gate.tryShared())).toBe(true);

    // A later successful move clears the remembered failure.
    t.s.h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...bad }));
    const again = cacheDir();
    await t.service.change(LOCAL, { path: again, grant: t.grant(again) });
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).not.toHaveProperty("migration");
    expect(await t.registered()).toEqual([again]);
  });

  it("rolls back when the target refuses a write, touching nothing but the cache refs and its own marker", async () => {
    const target = cacheDir();
    writeFileSync(join(target, "..", "users-own.txt"), "mine");
    const t = setup({ storeFactory: (dir, options) => (dir === target ? new FailingWriteStore(dir) : flat(dir, options)) });
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");
    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: true, migration: { phase: "failed", error: { class: "internal" } } });
    expect(await t.defaults.digest(cache.storageRef)).toBe(cache.fingerprint);
    expect(existsSync(join(target, "..", "users-own.txt"))).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(await t.registered()).toEqual([]);
    expect(t.migration()).toBeUndefined();
  });

  it("rolls back a copy aborted by close() and records no failure for it", async () => {
    const target = cacheDir();
    const blocker = gate();
    const t = setup({ storeFactory: (dir, options) => (dir === target ? new BlockingStore(dir, blocker.promise) : flat(dir, options)) });
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "a video that takes a while");

    const accepted = await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    expect(accepted.migration).toEqual({ phase: "copying", copiedBytes: 0, totalBytes: cache.sizeBytes, fileCount: 1 });
    expect(t.migration()).toMatchObject({ from: t.defaultDir, to: target, phase: "copying" });
    // Registered and marked before the first byte is copied.
    expect(await t.registered()).toEqual([target]);
    expect(markerOf(target)).toBe(markerText(CACHE_ROOT_MARKER_MAGIC));
    const closing = t.service.close();
    blocker.open();
    await closing;

    expect(t.migration()).toBeUndefined();
    expect(await t.service.status(LOCAL)).toEqual(expect.not.objectContaining({ migration: expect.anything() }));
    expect(t.s.stores.cache.root()).toBeUndefined();
    expect(await t.defaults.digest(cache.storageRef)).toBe(cache.fingerprint);
    expect(existsSync(target)).toBe(false);
    expect(await t.registered()).toEqual([]);
    expect(canTake(t.s.h.gate.tryShared())).toBe(true);
  });

  it("refuses a second move, cache deletions and Content deletions while a copy runs", async () => {
    const target = cacheDir();
    const blocker = gate();
    const t = setup({ storeFactory: (dir, options) => (dir === target ? new BlockingStore(dir, blocker.promise) : flat(dir, options)) });
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");

    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    const other = cacheDir();
    expect(await codeOf(t.service.change(LOCAL, { path: other, grant: t.grant(other) }))).toBe("conflict.cache_migrating");
    expect(await codeOf(t.service.change(LOCAL, { useDefault: true }))).toBe("conflict.cache_migrating");
    expect(await codeOf(t.s.media.delete(LOCAL, cache.id))).toBe("conflict.cache_migrating");
    expect(await codeOf(t.s.deleteContent.delete(LOCAL, content))).toBe("conflict.cache_migrating");
    expect(t.s.h.gate.tryShared()).toBeUndefined();

    blocker.open();
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, path: target, fileCount: 1 });
    expect(canTake(t.s.h.gate.tryShared())).toBe(true);
    await t.s.media.delete(LOCAL, cache.id);
    expect(t.asset(cache)?.availability).toBe("evicted");
    expect(onDisk(target, cache.storageRef)).toBe(false);
  });

  it("refuses while a Task holds the cache", async () => {
    const t = setup();
    const target = cacheDir();
    const release = t.s.h.gate.tryShared() as () => void;
    expect(await codeOf(t.service.change(LOCAL, { path: target, grant: t.grant(target) }))).toBe("conflict.tasks_still_running");
    release();
    expect(t.migration()).toBeUndefined();
    expect(markerOf(target)).toBeUndefined();
    expect(await t.registered()).toEqual([]);
  });

  it("names the exclusive holder when a backup export or an update install holds the cache", async () => {
    const t = setup();
    const target = cacheDir();
    for (const [reason, code] of [
      ["backup_export", "conflict.backup_in_progress"],
      ["update_install", "conflict.maintenance"],
    ] as const) {
      const release = t.s.h.gate.tryExclusive(reason) as () => void;
      expect(await codeOf(t.service.change(LOCAL, { path: target, grant: t.grant(target) }))).toBe(code);
      release();
    }
    expect(t.migration()).toBeUndefined();
    expect(markerOf(target)).toBeUndefined();
  });

  it("rejects a bad grant and paths that are relative, misnamed, nested, inside the data directory, non-empty or missing", async () => {
    const t = setup();
    const target = cacheDir();
    expect(await codeOf(t.service.change(LOCAL, { path: target, grant: t.grant(target, "local_file") }))).toBe("unauthenticated.file_grant");
    expect(await codeOf(t.service.change(LOCAL, { path: target, grant: { ...t.grant(target), sig: "AAAA" } }))).toBe("unauthenticated.file_grant");
    const relative = "relative/media";
    expect(await refusalOf(t.service.change(LOCAL, { path: relative, grant: t.grant(relative) }))).toEqual(refused("invalid_path"));
    for (const name of ["Cache", "Amber Cache", "Media"]) {
      const misnamed = cacheDir(name);
      expect(await refusalOf(t.service.change(LOCAL, { path: misnamed, grant: t.grant(misnamed) }))).toEqual(refused("invalid_path"));
    }
    const inside = join(t.s.h.dir, "sub", "media");
    mkdirSync(inside, { recursive: true });
    expect(await refusalOf(t.service.change(LOCAL, { path: inside, grant: t.grant(inside) }))).toEqual(refused("overlaps_data_dir"));
    const full = cacheDir();
    writeFileSync(join(full, "stray.txt"), "x");
    expect(await refusalOf(t.service.change(LOCAL, { path: full, grant: t.grant(full) }))).toEqual(refused("not_empty"));
    // A marker Amber did not write does not make a directory empty.
    const forged = cacheDir();
    writeFileSync(join(forged, CACHE_ROOT_MARKER), "someone-else\n");
    expect(await refusalOf(t.service.change(LOCAL, { path: forged, grant: t.grant(forged) }))).toEqual(refused("not_empty"));
    const missing = join(tempDataDir("amber-cache-root-"), "media");
    expect(await refusalOf(t.service.change(LOCAL, { path: missing, grant: t.grant(missing) }))).toEqual(refused("not_found"));
    expect(await t.registered()).toEqual([]);
    expect(markerOf(full)).toBeUndefined();
    expect(markerOf(forged)).toBe("someone-else\n");

    // Once on a custom directory, a target nested in it is refused too.
    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();
    const nested = join(target, "deeper", "media");
    mkdirSync(nested, { recursive: true });
    expect(await refusalOf(t.service.change(LOCAL, { path: nested, grant: t.grant(nested) }))).toEqual(refused("overlaps_current"));

    expect(t.migration()).toBeUndefined();
    expect(await t.registered()).toEqual([target]);
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);
  });

  it("accepts a directory that holds nothing but a valid ownership marker and Amber's scratch", async () => {
    const t = setup();
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");
    const reused = cacheDir();
    writeFileSync(join(reused, CACHE_ROOT_MARKER), markerText(CACHE_ROOT_MARKER_MAGIC).replaceAll("\n", "\r\n"));
    // Scratch a crash left behind does not make an owned directory non-empty; without the marker it would.
    mkdirSync(join(reused, CACHE_SCRATCH_DIR, "01OLD"), { recursive: true });
    const foreign = cacheDir();
    mkdirSync(join(foreign, CACHE_SCRATCH_DIR));
    expect(await refusalOf(t.service.change(LOCAL, { path: foreign, grant: t.grant(foreign) }))).toEqual(refused("not_empty"));
    await t.service.change(LOCAL, { path: reused, grant: t.grant(reused) });
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, path: reused, fileCount: 1 });
    expect(onDisk(reused, cache.storageRef)).toBe(true);
    expect(markerOf(reused)).toBe(markerText(CACHE_ROOT_MARKER_MAGIC));
    expect(await t.registered()).toEqual([reused]);
  });

  it("names why a location is refused when it is a file, unreadable or not writable, and keeps the other codes", async () => {
    const t = setup();
    const file = join(tempDataDir("amber-cache-root-"), "media");
    writeFileSync(file, "x");
    expect(await refusalOf(t.service.change(LOCAL, { path: file, grant: t.grant(file) }))).toEqual(refused("not_directory"));
    const unreadable = cacheDir();
    chmodSync(unreadable, 0o000);
    try {
      expect(await refusalOf(t.service.change(LOCAL, { path: unreadable, grant: t.grant(unreadable) }))).toEqual(refused("not_accessible"));
    } finally {
      chmodSync(unreadable, 0o700);
    }
    const readOnly = cacheDir();
    chmodSync(readOnly, 0o500);
    try {
      expect(await refusalOf(t.service.change(LOCAL, { path: readOnly, grant: t.grant(readOnly) }))).toEqual(refused("not_writable"));
    } finally {
      chmodSync(readOnly, 0o700);
    }
    expect(markerOf(readOnly)).toBeUndefined();
    expect(await t.registered()).toEqual([]);
    // A forged grant is still a grant failure, not a refused location.
    expect(await refusalOf(t.service.change(LOCAL, { path: readOnly, grant: { ...t.grant(readOnly), sig: "AAAA" } }))).toMatchObject({ code: "unauthenticated.file_grant", reason: undefined });
    expect(t.migration()).toBeUndefined();
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);
  });

  it("applies the Windows path rules: a local drive, never a UNC share, and a directory named media", async () => {
    const t = setup({ isWindows: true });
    const rules: ReadonlyArray<[string, CacheDirReason]> = [
      ["\\\\nas\\share\\media", "not_local"],
      ["C:\\Users\\me\\Cache", "invalid_path"],
      ["media", "invalid_path"],
      ["D:\\Amber Cache", "invalid_path"],
    ];
    for (const [path, reason] of rules) {
      expect(await refusalOf(t.service.change(LOCAL, { path, grant: t.grant(path) }))).toEqual(refused(reason));
    }
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);
  });

  it("refuses a target volume that would fall below the low-water mark once the files have landed", async () => {
    const low = cacheDir();
    const t = setup({ storeFactory: (dir, options) => (dir === low ? new LowDiskStore(dir) : flat(dir, options)) });
    const content = createLocalContent(t.s.h);
    await t.addCache(content, "video");
    expect(await codeOf(t.service.change(LOCAL, { path: low, grant: t.grant(low) }))).toBe("disk_low");
    expect(t.migration()).toBeUndefined();
    expect(existsSync(low)).toBe(true);
    // Refused before ownership was taken.
    expect(markerOf(low)).toBeUndefined();
    expect(await t.registered()).toEqual([]);
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);


    // Free space minus the bytes to move is what must stay above the mark, to the byte.
    const tight = cacheDir();
    const u = setup({ storeFactory: (dir, options) => (dir === tight ? new FixedVolumeStore(dir, BYTES_PER_GB) : flat(dir, options)) });
    const file = await u.addCache(createLocalContent(u.s.h), "video");
    u.s.h.settings.patch(LOCAL, { lowWaterFreeGB: (BYTES_PER_GB - file.sizeBytes + 1) / BYTES_PER_GB });
    expect(await codeOf(u.service.change(LOCAL, { path: tight, grant: u.grant(tight) }))).toBe("disk_low");
    u.s.h.settings.patch(LOCAL, { lowWaterFreeGB: (BYTES_PER_GB - file.sizeBytes) / BYTES_PER_GB });
    await u.service.change(LOCAL, { path: tight, grant: u.grant(tight) });
    await u.service.whenIdle();
    expect(await u.service.status(LOCAL)).toMatchObject({ isDefault: false, path: tight, fileCount: 1 });
  });

  it("moves back to the default directory without checking maxDataGB, which never counts the cache directory", async () => {
    const roomy = cacheDir();
    const t = setup();
    const content = createLocalContent(t.s.h);
    await t.addCache(content, "video");
    await t.service.change(LOCAL, { path: roomy, grant: t.grant(roomy) });
    await t.service.whenIdle();
    // The data directory already holds the database, so it is over this limit before the move.
    t.s.h.settings.patch(LOCAL, { maxDataGB: 1 / BYTES_PER_GB });
    await t.service.change(LOCAL, { useDefault: true });
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: true, fileCount: 1 });
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);
  });

  it("still refuses a move back when the default directory's volume would fall below the low-water mark", async () => {
    const roomy = cacheDir();
    let lowDir: string | undefined;
    const t = setup({ storeFactory: (dir, options) => (dir === lowDir ? new LowDiskStore(dir) : flat(dir, options)) });
    await t.addCache(createLocalContent(t.s.h), "video");
    await t.service.change(LOCAL, { path: roomy, grant: t.grant(roomy) });
    await t.service.whenIdle();
    lowDir = t.defaultDir;
    expect(await codeOf(t.service.change(LOCAL, { useDefault: true }))).toBe("disk_low");
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, path: roomy });
  });

  it("marks every cache evicted and switches without copying when the current directory is unplugged; the unplugged one stays registered", async () => {
    const t = setup();
    const root = cacheDir();
    t.s.h.settings.updateCacheRoot({ cacheRoot: root });
    t.s.stores.cache.setRoot(root);
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");
    await new CacheRootsRegistry(join(t.s.h.dir, CACHE_ROOTS_FILE)).add(root);
    rmSync(root, { recursive: true, force: true });
    // A directory that is not there has no volume to report.
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, available: false, fileCount: 1, freeBytes: 0, totalBytes: 0 });

    const next = cacheDir();
    const status = await t.service.change(LOCAL, { path: next, grant: t.grant(next) });
    expect(status).toMatchObject({ isDefault: false, path: next, available: true, fileCount: 0 });
    expect(status).not.toHaveProperty("migration");
    expect(t.asset(cache)?.availability).toBe("evicted");
    expect(t.s.stores.cache.root()).toBe(next);
    expect(markerOf(next)).toBe(markerText(CACHE_ROOT_MARKER_MAGIC));
    expect(await t.registered()).toEqual([root, next]);
    expect(t.migration()).toBeUndefined();
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);
  });

  it("refuses to move while a replacement waits for the user or a replacement record is still in the current directory", async () => {
    let holds: CacheHoldDto[] = [{ assetId: "01HOLD", fileName: "第一讲 [720P].mp4" }];
    const t = setup({ holds: () => holds });
    const target = cacheDir();
    expect(await codeOf(t.service.change(LOCAL, { path: target, grant: t.grant(target) }))).toBe("conflict.cache_recovery_pending");
    holds = [];
    // A record the recovery has not settled yet counts as well.
    const scratch = join(t.defaultDir, CACHE_SCRATCH_DIR, "01PENDINGSWAP");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "swap.json"), "{}");
    expect(await codeOf(t.service.change(LOCAL, { path: target, grant: t.grant(target) }))).toBe("conflict.cache_recovery_pending");
    expect(t.migration()).toBeUndefined();
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);
    rmSync(scratch, { recursive: true });
    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();
    expect(t.s.stores.cache.root()).toBe(target);
  });

  it("treats a move to the current directory as a no-op and releases the lease", async () => {
    const t = setup();
    const status = await t.service.change(LOCAL, { useDefault: true });
    expect(status).toMatchObject({ isDefault: true });
    expect(t.migration()).toBeUndefined();
    expect(canTake(t.s.h.gate.tryExclusive("cache_migration"))).toBe(true);
  });

  it("retries a pending cleanup before a new move, refuses the move while it still fails, and unregisters the old directory once it is gone", async () => {
    const old = cacheDir();
    let failing = true;
    const t = setup({ storeFactory: (dir, options) => (dir === old ? new FailingRemoveStore(dir, () => failing) : flat(dir, options)) });
    const current = cacheDir();
    const content = createLocalContent(t.s.h);
    t.s.h.settings.updateCacheRoot({ cacheRoot: current });
    t.s.stores.cache.setRoot(current);
    const cache = await t.addCache(content, "video");
    // The last move switched to `current` but never removed the old copy.
    await new FlatCacheFileStore(old).writeAtomic(cache.storageRef, Buffer.from("video"));
    writeFileSync(join(old, CACHE_ROOT_MARKER), markerText(CACHE_ROOT_MARKER_MAGIC));
    const registry = new CacheRootsRegistry(join(t.s.h.dir, CACHE_ROOTS_FILE));
    await registry.add(old);
    await registry.add(current);
    t.s.h.settings.updateCacheRoot({ cacheMigration: { id: "m-old", from: old, to: current, phase: "cleanup_pending" } });
    expect(await t.service.status(LOCAL)).toMatchObject({ migration: { phase: "cleanup_pending" } });

    expect(await codeOf(t.service.change(LOCAL, { useDefault: true }))).toBe("conflict.cache_cleanup_pending");
    expect(onDisk(old, cache.storageRef)).toBe(true);
    expect(markerOf(old)).toBeDefined();
    expect(await t.registered()).toEqual([old, current]);
    expect(t.migration()).toMatchObject({ id: "m-old" });

    failing = false;
    await t.service.change(LOCAL, { useDefault: true });
    await t.service.whenIdle();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(current)).toBe(false);
    expect(await t.service.status(LOCAL)).toEqual(expect.objectContaining({ isDefault: true, fileCount: 1 }));
    expect(await t.defaults.digest(cache.storageRef)).toBe(cache.fingerprint);
    expect(t.migration()).toBeUndefined();
    expect(await t.registered()).toEqual([]);
  });

  it("logs registry failures without failing the move", async () => {
    const failing = { add: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })), remove: () => Promise.reject(new Error("denied")) };
    const t = setup({ registry: failing });
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");
    const target = cacheDir();
    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, path: target, fileCount: 1 });
    expect(onDisk(target, cache.storageRef)).toBe(true);
    expect(markerOf(target)).toBe(markerText(CACHE_ROOT_MARKER_MAGIC));
    expect(t.warnings).toContain("cache_roots_registry_failed");
  });
});

describe("CacheRootService.recover", () => {
  it("rolls back a copy the previous process never finished, removing only the cache refs and the marker from the target", async () => {
    const t = setup();
    const target = cacheDir();
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");
    await new FlatCacheFileStore(target).writeAtomic(cache.storageRef, Buffer.from("half copied"));
    writeFileSync(join(target, CACHE_ROOT_MARKER), markerText(CACHE_ROOT_MARKER_MAGIC));
    writeFileSync(join(target, "keep.txt"), "not ours to delete");
    await new CacheRootsRegistry(join(t.s.h.dir, CACHE_ROOTS_FILE)).add(target);
    t.s.h.settings.updateCacheRoot({ cacheMigration: { id: "m-crash", from: t.defaultDir, to: target, phase: "copying" } });

    await t.service.recover();
    expect(t.migration()).toBeUndefined();
    expect(t.s.stores.cache.root()).toBeUndefined();
    expect(onDisk(target, cache.storageRef)).toBe(false);
    expect(markerOf(target)).toBeUndefined();
    // Not empty, so the directory stays; without its marker it is no longer Amber's to list.
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
    expect(await t.registered()).toEqual([]);
    expect(await t.defaults.digest(cache.storageRef)).toBe(cache.fingerprint);
    expect(t.asset(cache)?.availability).toBe("available");
    expect(await t.service.status(LOCAL)).not.toHaveProperty("migration");
  });

  it("finishes a cleanup the previous process left pending and makes sure the current directory is registered", async () => {
    const t = setup();
    const target = cacheDir();
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");
    const upload = await addUpload(t.s, content);
    // Switched already: the custom directory's copy is the real one, the default directory's is the leftover.
    await new FlatCacheFileStore(target).writeAtomic(cache.storageRef, Buffer.from("video"));
    t.s.h.settings.updateCacheRoot({ cacheRoot: target, cacheMigration: { id: "m-switched", from: t.defaultDir, to: target, phase: "cleanup_pending" } });

    await t.service.recover();
    expect(t.s.stores.cache.root()).toBe(target);
    expect(t.migration()).toBeUndefined();
    expect(onDisk(t.defaultDir, cache.storageRef)).toBe(false);
    expect(await t.s.files.stat(upload.storageRef)).not.toBeNull();
    expect(await t.s.stores.cache.digest(cache.storageRef)).toBe(cache.fingerprint);
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, path: target, fileCount: 1 });
    expect(await t.registered()).toEqual([target]);
  });

  it("gives up a pending cleanup whose old directory is no longer mounted but keeps it registered", async () => {
    const t = setup();
    const gone = join(tempDataDir("amber-cache-root-"), "media");
    const registry = new CacheRootsRegistry(join(t.s.h.dir, CACHE_ROOTS_FILE));
    await registry.add(gone);
    const content = createLocalContent(t.s.h);
    const cache = await t.addCache(content, "video");
    t.s.h.settings.updateCacheRoot({ cacheMigration: { id: "m-unplugged", from: gone, to: t.defaultDir, phase: "cleanup_pending" } });

    await t.service.recover();
    expect(t.migration()).toBeUndefined();
    expect(await t.defaults.digest(cache.storageRef)).toBe(cache.fingerprint);
    expect(await t.registered()).toEqual([gone]);
    const target = cacheDir();
    await t.service.change(LOCAL, { path: target, grant: t.grant(target) });
    await t.service.whenIdle();
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, path: target, fileCount: 1 });
    expect(await t.registered()).toEqual([gone, target]);
  });

  it("points the cache store at the stored directory and probes it, keeping caches of an unplugged directory available", async () => {
    const t = setup();
    const missing = join(tempDataDir("amber-cache-root-"), "media");
    t.s.h.settings.updateCacheRoot({ cacheRoot: missing });
    const content = createLocalContent(t.s.h);
    const row: MediaAsset = {
      id: t.s.h.newId(), userId: LOCAL.userId, contentId: content, kind: "platform_cache", storageRef: "media/offline.mp4", mimeType: "video/mp4",
      sizeBytes: 5, availability: "available", retentionPolicy: "evictable", createdAt: 1,
    };
    t.s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(row));
    await t.service.recover();
    expect(t.s.stores.cache.root()).toBe(missing);
    expect(t.s.stores.cache.isAvailableSync()).toBe(false);
    expect(await t.service.status(LOCAL)).toMatchObject({ isDefault: false, path: missing, available: false });
    expect(t.asset(row)?.availability).toBe("available");
    expect(await t.registered()).toEqual([missing]);
  });

  it("retires caches of the old nested layout and caches whose file was deleted outside Amber", async () => {
    const t = setup();
    const content = createLocalContent(t.s.h);
    const kept = await t.addCache(content, "still here");
    const deleted = await t.addCache(content, "user deleted it");
    rmSync(join(t.defaultDir, cacheFileNameOf(deleted.storageRef)));
    const legacyId = t.s.h.newId();
    const legacy: MediaAsset = {
      id: legacyId, userId: LOCAL.userId, contentId: content, kind: "platform_cache", storageRef: `assets/${LOCAL.userId}/${content}/${legacyId}`,
      mimeType: "video/mp4", sizeBytes: 3, availability: "available", retentionPolicy: "evictable", createdAt: 1,
    };
    t.s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(legacy));
    await t.s.files.writeAtomic(legacy.storageRef, Buffer.from("old"));

    await t.service.recover();
    expect(t.asset(kept)?.availability).toBe("available");
    expect(t.asset(deleted)?.availability).toBe("evicted");
    expect(t.asset(legacy)?.availability).toBe("evicted");

    // The janitor then collects the old layout's file from the data directory.
    await t.s.janitor.sweep();
    expect(await t.s.files.stat(legacy.storageRef)).toBeNull();
    expect(onDisk(t.defaultDir, kept.storageRef)).toBe(true);
  });
});
