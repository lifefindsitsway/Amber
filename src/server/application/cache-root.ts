import { readdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { monotonicFactory } from "ulid";
import {
  CACHE_DIR_NAME,
  CACHE_ROOT_MARKER,
  CACHE_ROOT_MARKER_MAGIC,
  CACHE_ROOTS_FILE,
  CACHE_SCRATCH_DIR,
  isMarkerText,
  markerText,
} from "../../shared/app-identity.ts";
import { isCacheRef } from "../../shared/cache-file-name.ts";
import type { CacheHoldDto, CacheLocationDto, CacheLocationPut, CacheMigrationDto } from "../../shared/dto/local-media.ts";
import type { AppError, CacheDirReason } from "../../shared/errors.ts";
import { cacheDirErrors } from "../../shared/i18n/zh-CN/errors.ts";
import { AmberError, amberError, appError } from "../domain/errors.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { CacheMigrationMarker, InstanceSettings } from "../domain/runtime-support.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { CacheGate, Release } from "../pipeline/cache-gate.ts";
import { cacheVolumeLow } from "../pipeline/disk-watermark.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import { removeScratchEntries, type FileStoreFactory, type MediaFiles } from "../pipeline/media-files.ts";
import { toAppError } from "../pipeline/retry.ts";
import { requireAdmin } from "./admin.ts";
import { CacheRootsRegistry } from "./cache-roots-registry.ts";
import type { InstanceSettingsService } from "./instance-settings.ts";
import type { PendingFileDeleter } from "./pending-file-delete.ts";

export interface CacheRootServiceOptions {
  repository: Repository;
  settings: Pick<InstanceSettingsService, "updateCacheRoot" | "effective">;
  media: MediaFiles;
  gate: Pick<CacheGate, "tryExclusive" | "exclusiveReason">;
  grants: FileGrantVerifier;
  /** The data directory: holds the default cache directory and the registry of custom ones. */
  dataDir: string;
  /** Builds a flat cache store over a cache directory, to probe its volume or copy into it. */
  storeFactory: FileStoreFactory;
  /** The owned-roots registry; defaults to `<dataDir>/cache-roots.txt`. */
  registry?: Pick<CacheRootsRegistry, "add" | "remove">;
  /** Files purged while an old directory was current are removed through it before it is given up. */
  fileDeleter?: Pick<PendingFileDeleter, "drainRoot">;
  logger: Logger;
  newId?: () => string;
  /** Path rules differ per platform; defaults to the running one. */
  isWindows?: boolean;
  /** Interrupted cache replacements waiting for the user, listed with the status; none when absent. */
  holds?: () => CacheHoldDto[];
}

interface MigrationProgress {
  copiedBytes: number;
  totalBytes: number;
  fileCount: number;
}

/** A row and the size its file has on disk right now. */
interface CachedFile {
  asset: MediaAsset;
  sizeBytes: number;
}

/** The resolved directories every path check compares against. */
interface Roots {
  dataRoot: string;
  defaultDir: string;
}

function cacheMigrating(): AmberError {
  return amberError("conflict", "a cache move is in progress", { code: "conflict.cache_migrating" });
}

/** A refused cache location; `reason` tells the user what to change. */
function invalidCacheDir(reason: CacheDirReason, message: string): AmberError {
  return amberError("invalid_request", message, { code: "invalid_request.cache_dir", details: { reason }, params: { message: cacheDirErrors[reason] } });
}


/** Whether two resolved paths name one directory; Windows compares them case-insensitively. */
export function samePath(a: string, b: string, isWindows = process.platform === "win32"): boolean {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** The error code alone: registry and marker failures are logged without the user's paths. */
function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "error";
}

/**
 * Removes Amber's download scratch `<dir>/.amber-tmp` with everything in it, except a
 * directory holding the record of an interrupted replacement, which waits for the user.
 * `fs.rm` checks entries with `lstat`, so a link inside is removed itself and never followed.
 */
async function removeScratch(dir: string): Promise<void> {
  await removeScratchEntries(dir);
}

/** Reads `source` chunk by chunk and stops as soon as `signal` aborts, so a cancelled copy does not drain a multi-gigabyte file first. */
async function* abortable(source: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("cache move aborted");
    }
    yield chunk;
  }
}

/**
 * `GET / PUT /api/media/cache-location` (local mode): where the
 * desktop client keeps its `platform_cache` files and the move from one cache directory to
 * another. The default directory is `<data dir>/media`; a custom one is a `media` directory
 * the shell created on a local volume.
 *
 * A move copies every available cache under the exclusive cache lease, switches the root
 * in one transaction (the commit point), releases the lease and then removes the old files
 * best-effort. `storageRef`s never change: a ref is relative to whichever directory is
 * current. A copy that fails or is aborted removes only what it wrote at the refs of
 * `platform_cache` rows in the target and leaves the source untouched; no step ever deletes
 * a directory recursively, except Amber's own download scratch `.amber-tmp`, which goes
 * with the old files (no Task runs during a move, so nothing uses it). The marker in `InstanceSettings` survives a crash so `recover()`
 * can finish the cleanup or roll the copy back at the next start.
 *
 * Custom directories carry the ownership marker `.amber-cache-root` and are listed in the
 * registry `<data dir>/cache-roots.txt` for the full uninstall: registered before the marker
 * is written, unregistered only after it is removed, and kept registered while an old
 * directory is offline. Registry failures are logged and never fail a move.
 */
export class CacheRootService {
  private readonly options: CacheRootServiceOptions;
  private readonly newId: () => string;
  private readonly isWindows: boolean;
  private readonly registry: Pick<CacheRootsRegistry, "add" | "remove">;
  /** Set while a PUT is between its pre-checks and the written marker, so a second PUT cannot interleave. */
  private changing = false;
  private worker: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private progress: MigrationProgress | undefined;
  private failed: AppError | undefined;
  private stopping = false;

  constructor(options: CacheRootServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
    this.isWindows = options.isWindows ?? process.platform === "win32";
    this.registry = options.registry ?? new CacheRootsRegistry(join(options.dataDir, CACHE_ROOTS_FILE), { isWindows: this.isWindows });
  }

  /** `GET /api/media/cache-location`: the current cache directory, its usage and any move in progress. */
  async status(principal: RequestPrincipal): Promise<CacheLocationDto> {
    requireAdmin(principal);
    return this.currentStatus();
  }

  /**
   * `PUT /api/media/cache-location`: moves the cache to the shell-signed `media` directory
   * or back to the default one. Answers as soon as the copy has started; the returned
   * status carries its progress.
   */
  async change(principal: RequestPrincipal, body: CacheLocationPut): Promise<CacheLocationDto> {
    requireAdmin(principal);
    if (this.changing) {
      throw cacheMigrating();
    }
    this.changing = true;
    try {
      await this.finishPendingCleanup();
      const marker = this.options.settings.effective().cacheMigration;
      if (marker?.phase === "copying") {
        throw cacheMigrating();
      }
      if (marker?.phase === "cleanup_pending") {
        throw amberError("conflict", "the previous cache move has files left to clean up", { code: "conflict.cache_cleanup_pending" });
      }
      const release = this.options.gate.tryExclusive("cache_migration");
      if (release === undefined) {
        // Another exclusive holder (a backup export, the maintenance state) names itself; otherwise Tasks hold shared leases.
        if (this.options.gate.exclusiveReason() !== undefined) {
          throw gateConflict(this.options.gate);
        }
        throw amberError("conflict", "tasks are still running", { code: "conflict.tasks_still_running" });
      }
      try {
        await this.startMove(body, release);
      } catch (error) {
        release();
        throw error;
      }
      return await this.currentStatus();
    } finally {
      this.changing = false;
    }
  }

  /**
   * Start-up, before the janitor sweep: points the cache store at the stored directory,
   * retires rows of the obsolete nested layout, settles a move the previous process did not
   * finish (`copying` never reached the switch and is rolled back; `cleanup_pending` already
   * switched and only the old files remain), makes sure the current custom directory is
   * registered, and marks available caches whose file is gone `evicted`. The last step is
   * skipped while the custom directory is unavailable: an unplugged volume is not a deletion.
   */
  async recover(): Promise<void> {
    const settings = this.options.settings.effective();
    const { cache } = this.options.media;
    cache.setRoot(settings.cacheRoot);
    await cache.isAvailable();
    this.evictLegacyRows();
    const marker = settings.cacheMigration;
    if (marker !== undefined) {
      const roots = await this.roots();
      const refs = this.availableCaches().map((asset) => asset.storageRef);
      if (marker.phase === "copying") {
        this.options.logger.warn("cache_migration_rolled_back", { id: marker.id });
        await this.rollback(this.storeOver(marker.to, roots), refs, this.samePath(marker.to, roots.defaultDir) ? undefined : marker.to);
        this.options.settings.updateCacheRoot({ cacheMigration: undefined });
      } else {
        await this.cleanup(marker, refs, roots);
      }
    }
    const current = cache.root();
    if (current !== undefined) {
      await this.register(current);
    }
    if (await cache.isAvailable()) {
      await this.reconcile(cache);
    }
  }

  /** Stops a running copy and waits for its rollback; the marker is cleared by the worker itself. */
  async close(): Promise<void> {
    this.stopping = true;
    this.abort?.abort(new Error("shutdown"));
    await this.worker;
  }

  /** Resolves once no copy or cleanup is running. */
  async whenIdle(): Promise<void> {
    await this.worker;
  }

  /**
   * A store over a cache directory that is not the current one, for files registered while
   * it was: the default directory, or a custom one that still exists and carries Amber's
   * ownership marker. Anything else is `undefined`: an unplugged volume, a directory the
   * user removed, or one that is no longer Amber's.
   */
  async ownedStoreOver(dir: string): Promise<FileStore | undefined> {
    const roots = await this.roots();
    if (!(await this.isDirectory(dir))) {
      return undefined;
    }
    if (this.samePath(dir, roots.defaultDir)) {
      return this.options.storeFactory(dir);
    }
    return (await this.hasValidMarker(dir)) ? this.options.storeFactory(dir) : undefined;
  }

  private async currentStatus(): Promise<CacheLocationDto> {
    const settings = this.options.settings.effective();
    const { cache } = this.options.media;
    const available = await cache.isAvailable();
    const caches = this.availableCaches();
    const migration = this.migrationDto(settings);
    // A directory that is not there has no volume to report; the page shows the location as unavailable instead.
    const volume = available ? await cache.diskUsage().catch(() => undefined) : undefined;
    return {
      path: cache.directory(),
      isDefault: settings.cacheRoot === undefined,
      available,
      fileCount: caches.length,
      usedBytes: caches.reduce((sum, asset) => sum + asset.sizeBytes, 0),
      freeBytes: volume?.freeBytes ?? 0,
      totalBytes: volume?.totalBytes ?? 0,
      holds: this.options.holds?.() ?? [],
      ...(migration === undefined ? {} : { migration }),
    };
  }

  private migrationDto(settings: InstanceSettings): CacheMigrationDto | undefined {
    const marker = settings.cacheMigration;
    if (marker?.phase === "copying") {
      return { phase: "copying", copiedBytes: this.progress?.copiedBytes ?? 0, totalBytes: this.progress?.totalBytes ?? 0, fileCount: this.progress?.fileCount ?? 0 };
    }
    if (marker?.phase === "cleanup_pending") {
      return { phase: "cleanup_pending" };
    }
    return this.failed === undefined ? undefined : { phase: "failed", error: this.failed };
  }

  private availableCaches(): MediaAsset[] {
    return this.options.repository.withTransaction((scope) => scope.mediaAssets.listAvailableCachesUnscoped());
  }

  /**
   * Caches of the obsolete `assets/<user>/<content>/<asset>` layout have no place in the
   * flat cache directory: their rows become `evicted`, and the janitor collects their files
   * from the data directory as orphans of the wrong store.
   */
  private evictLegacyRows(): void {
    const evicted = this.options.repository.withTransaction((scope) => {
      const legacy = scope.mediaAssets.listAvailableCachesUnscoped().filter((asset) => !isCacheRef(asset.storageRef));
      for (const asset of legacy) {
        scope.mediaAssets.update(asset.userId, { ...asset, availability: "evicted" });
      }
      return legacy.length;
    });
    if (evicted > 0) {
      this.options.logger.info("cache_legacy_rows_evicted", { count: evicted });
    }
  }

  /**
   * An interrupted cache replacement keeps its files in the current directory's scratch
   * area, which a move neither copies nor would find again: while one waits for the user,
   * or a record of one is still on disk (its recovery has not run yet), the location stays
   * (`conflict.cache_recovery_pending`).
   */
  private async refuseWhileSwapsPending(): Promise<void> {
    const { cache } = this.options.media;
    const held = (this.options.holds?.() ?? []).length > 0;
    if (held || ((await cache.isAvailable()) && (await cache.swapScratchIds()).length > 0)) {
      throw amberError("conflict", "an interrupted cache replacement waits to be settled", { code: "conflict.cache_recovery_pending" });
    }
  }

  /** A `cleanup_pending` marker left by an earlier attempt is retried before a new move; it must be gone for the move to start. */
  private async finishPendingCleanup(): Promise<void> {
    const marker = this.options.settings.effective().cacheMigration;
    if (marker?.phase !== "cleanup_pending") {
      return;
    }
    await this.cleanup(marker, this.availableCaches().map((asset) => asset.storageRef), await this.roots());
  }

  /** Steps 3–7 of a move, under the exclusive lease; throws (and the caller releases) when nothing has started yet. */
  private async startMove(body: CacheLocationPut, release: Release): Promise<void> {
    const { media, settings } = this.options;
    const roots = await this.roots();
    const target = await this.resolveTarget(body, roots);
    const targetIsDefault = this.samePath(target, roots.defaultDir);
    const currentRoot = media.cache.root();
    const current = currentRoot === undefined ? roots.defaultDir : await this.realpathOr(currentRoot);
    if (this.samePath(target, current)) {
      release();
      return;
    }
    await this.refuseWhileSwapsPending();
    if (this.isInside(target, current) || this.isInside(current, target)) {
      throw invalidCacheDir("overlaps_current", "the new cache directory must not be inside the current one or contain it");
    }
    if (!targetIsDefault && (this.samePath(target, roots.dataRoot) || this.isInside(target, roots.dataRoot) || this.isInside(roots.dataRoot, target))) {
      throw invalidCacheDir("overlaps_data_dir", "the cache directory must not be inside the data directory");
    }
    if (!targetIsDefault) {
      await this.requireEmptyDir(target);
    }
    const nextRoot = targetIsDefault ? undefined : target;

    if (!(await media.cache.isAvailable())) {
      // Nothing can be copied from an unmounted volume: the rows lose their files and the
      // root switches at once. The unmounted directory stays registered.
      if (nextRoot !== undefined) {
        await this.claim(nextRoot);
      }
      this.options.repository.withTransaction((scope) => {
        for (const asset of scope.mediaAssets.listAvailableCachesUnscoped()) {
          scope.mediaAssets.update(asset.userId, { ...asset, availability: "evicted" });
        }
      });
      settings.updateCacheRoot({ cacheRoot: nextRoot, cacheMigration: undefined });
      media.cache.setRoot(nextRoot);
      this.failed = undefined;
      release();
      return;
    }

    const files = await this.reconcile(media.cache);
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    await this.requireRoom(target, totalBytes, roots);
    if (nextRoot !== undefined) {
      await this.claim(nextRoot);
    }

    const marker: CacheMigrationMarker = { id: this.newId(), from: current, to: target, phase: "copying" };
    settings.updateCacheRoot({ cacheMigration: marker });
    this.failed = undefined;
    this.progress = { copiedBytes: 0, totalBytes, fileCount: files.length };
    const abort = new AbortController();
    this.abort = abort;
    const toStore = this.storeOver(target, roots);
    this.worker = this.copyThenSwitch(marker, files, media.cache, toStore, nextRoot, roots, release, abort.signal).finally(() => {
      this.worker = undefined;
      this.abort = undefined;
      this.progress = undefined;
    });
  }

  /** The signed `media` directory as an absolute, resolved path, or the default cache directory for `useDefault`. */
  private async resolveTarget(body: CacheLocationPut, roots: Roots): Promise<string> {
    if ("useDefault" in body) {
      return roots.defaultDir;
    }
    if (!this.options.grants.verify(body.grant, { path: body.path, purpose: "cache_dir" })) {
      throw amberError("unauthenticated", "file grant is missing, forged or expired", { code: "unauthenticated.file_grant" });
    }
    const paths = this.isWindows ? win32 : posix;
    if (!paths.isAbsolute(body.path)) {
      throw invalidCacheDir("invalid_path", "path is not absolute");
    }
    // Only a local drive: a UNC share is not "this machine's volume" and cannot be probed for free space.
    if (this.isWindows && (!/^[A-Za-z]:\\/u.test(body.path) || body.path.startsWith("\\\\"))) {
      throw invalidCacheDir("not_local", "path must be on a local drive");
    }
    if (paths.basename(body.path) !== CACHE_DIR_NAME) {
      throw invalidCacheDir("invalid_path", `the cache directory must be named ${CACHE_DIR_NAME}`);
    }
    try {
      return await realpath(body.path);
    } catch {
      throw invalidCacheDir("not_found", "path does not name an existing directory");
    }
  }

  /**
   * The directory must exist and be empty; the shell created it a moment ago, so anything
   * else is unexpected. A directory holding only a valid ownership marker, and possibly
   * Amber's `.amber-tmp`, counts as empty: it is one Amber owned before and the shell picked
   * again (the start-up sweep removes the scratch).
   */
  private async requireEmptyDir(target: string): Promise<void> {
    let entries: string[];
    try {
      if (!(await stat(target)).isDirectory()) {
        throw invalidCacheDir("not_directory", "path is not a directory");
      }
      entries = await readdir(target);
    } catch (error) {
      if (error instanceof AmberError) throw error;
      const code = errorCode(error);
      throw code === "ENOENT" || code === "ENOTDIR"
        ? invalidCacheDir("not_found", "path does not name an existing directory")
        : invalidCacheDir("not_accessible", "the cache directory cannot be read");
    }
    const others = entries.filter((name) => name !== CACHE_ROOT_MARKER && name !== CACHE_SCRATCH_DIR);
    if (others.length > 0 || (entries.length > 0 && !(await this.hasValidMarker(target)))) {
      throw invalidCacheDir("not_empty", "the cache directory is not empty");
    }
  }

  private async hasValidMarker(dir: string): Promise<boolean> {
    try {
      return isMarkerText(await readFile(join(dir, CACHE_ROOT_MARKER), "utf8"), CACHE_ROOT_MARKER_MAGIC);
    } catch {
      return false;
    }
  }

  /**
   * Takes ownership of a custom directory: registered first, then marked, so the registry
   * never misses a marked directory. Writing the marker also proves the directory accepts
   * files before any copy starts; when it does not, the registration is undone.
   */
  private async claim(dir: string): Promise<void> {
    await this.register(dir);
    try {
      await writeFile(join(dir, CACHE_ROOT_MARKER), markerText(CACHE_ROOT_MARKER_MAGIC));
    } catch {
      await rm(join(dir, CACHE_ROOT_MARKER), { force: true }).catch(() => undefined);
      await this.unregister(dir);
      throw invalidCacheDir("not_writable", "the cache directory is not writable");
    }
  }

  /**
   * Gives up ownership of a custom directory Amber no longer uses: its `.amber-tmp`, the
   * marker, then the directory if empty (`rmdir`, never recursive), then the registration.
   * A marker that cannot be removed keeps the directory registered and throws.
   */
  private async relinquish(dir: string): Promise<void> {
    await removeScratch(dir);
    await rm(join(dir, CACHE_ROOT_MARKER), { force: true });
    try {
      await rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && !isNotFound(error)) {
        this.options.logger.warn("cache_root_rmdir_failed", { error: errorCode(error) });
      }
    }
    await this.unregister(dir);
  }

  private async register(dir: string): Promise<void> {
    try {
      await this.registry.add(dir);
    } catch (error) {
      this.options.logger.warn("cache_roots_registry_failed", { op: "add", error: errorCode(error) });
    }
  }

  private async unregister(dir: string): Promise<void> {
    try {
      await this.registry.remove(dir);
    } catch (error) {
      this.options.logger.warn("cache_roots_registry_failed", { op: "remove", error: errorCode(error) });
    }
  }

  /** Rows whose file is gone are marked `evicted`; the rest are returned with their size on disk. */
  private async reconcile(from: FileStore): Promise<CachedFile[]> {
    const present: CachedFile[] = [];
    const gone: MediaAsset[] = [];
    for (const asset of this.availableCaches()) {
      const stored = isCacheRef(asset.storageRef) ? await from.stat(asset.storageRef) : null;
      if (stored === null) {
        gone.push(asset);
      } else {
        present.push({ asset, sizeBytes: stored.sizeBytes });
      }
    }
    if (gone.length > 0) {
      this.options.repository.withTransaction((scope) => {
        for (const asset of gone) {
          scope.mediaAssets.update(asset.userId, { ...asset, availability: "evicted" });
        }
      });
      this.options.logger.info("cache_missing_files_evicted", { count: gone.length });
    }
    return present;
  }

  /**
   * The target volume must stay above the low-water mark once the copy has landed. Only free
   * space counts, even for a move back to the default directory inside the data directory:
   * the cache directory never counts against `maxDataGB`.
   */
  private async requireRoom(target: string, totalBytes: number, roots: Roots): Promise<void> {
    const volume = await this.storeOver(target, roots).diskUsage();
    if (cacheVolumeLow({ ...volume, freeBytes: volume.freeBytes - totalBytes }, this.options.settings.effective())) {
      throw new AmberError(appError("disk_low"), "the target volume would fall below the low-water mark");
    }
  }

  /** The background half of a move; holds the exclusive lease until the switch has committed or the copy has been rolled back. */
  private async copyThenSwitch(
    marker: CacheMigrationMarker,
    files: CachedFile[],
    from: FileStore,
    to: FileStore,
    nextRoot: string | undefined,
    roots: Roots,
    release: Release,
    signal: AbortSignal,
  ): Promise<void> {
    const refs = files.map((file) => file.asset.storageRef);
    try {
      for (const { asset } of files) {
        signal.throwIfAborted();
        const stored = await to.writeAtomic(asset.storageRef, abortable(from.read(asset.storageRef), signal));
        const expected = asset.fingerprint ?? (await from.digest(asset.storageRef));
        if (stored.digest !== expected) {
          throw amberError("media_changed", `copied cache ${asset.id} does not match its fingerprint`);
        }
        if (this.progress !== undefined) {
          this.progress.copiedBytes += stored.sizeBytes;
        }
      }
      signal.throwIfAborted();
    } catch (error) {
      this.options.logger.warn("cache_migration_failed", { id: marker.id, error: String(error) });
      await this.rollback(to, refs, nextRoot);
      this.options.settings.updateCacheRoot({ cacheMigration: undefined });
      release();
      if (!this.stopping) {
        this.failed = toAppError(error);
      }
      return;
    }
    // The commit point: the root and the marker phase change together.
    const switched: CacheMigrationMarker = { ...marker, phase: "cleanup_pending" };
    this.options.settings.updateCacheRoot({ cacheRoot: nextRoot, cacheMigration: switched });
    this.options.media.cache.setRoot(nextRoot);
    release();
    this.options.logger.info("cache_migration_switched", { id: marker.id, isDefault: nextRoot === undefined });
    await this.cleanup(switched, refs, roots);
  }

  /**
   * Undoes a copy: only the refs of cache rows go from the target; a custom target then
   * loses its marker, the directory itself if empty, and its registration. Best effort
   * throughout: a marker that cannot be removed keeps the directory registered.
   */
  private async rollback(to: FileStore, refs: readonly string[], customTarget: string | undefined): Promise<void> {
    for (const ref of refs) {
      await to.remove(ref).catch((error: unknown) => this.options.logger.warn("cache_rollback_remove_failed", { error: String(error) }));
    }
    if (customTarget !== undefined) {
      await this.relinquish(customTarget).catch((error: unknown) => this.options.logger.warn("cache_rollback_release_failed", { error: errorCode(error) }));
    }
  }

  /**
   * Best effort, after the switch and without a lease: the old files, then for an old
   * custom directory its marker, the directory once empty and its registration. Anything
   * that fails keeps the marker so the next start or the next move tries again; Tasks are
   * never held up by it. An old custom directory that is no longer mounted is given up on
   * instead: waiting for a volume that may never return would block every later move. It
   * stays registered, so the full uninstall still finds it once the volume is back.
   */
  private async cleanup(marker: CacheMigrationMarker, refs: readonly string[], roots: Roots): Promise<void> {
    const fromIsDefault = this.samePath(marker.from, roots.defaultDir);
    const from = this.storeOver(marker.from, roots);
    try {
      if (!fromIsDefault && !(await this.isDirectory(marker.from))) {
        this.options.settings.updateCacheRoot({ cacheMigration: undefined });
        this.options.logger.warn("cache_cleanup_root_missing", { id: marker.id });
        return;
      }
      for (const ref of refs) {
        await from.remove(ref);
      }
      // Purged files registered under the old directory go while it is still marked as
      // Amber's; a custom one with any left keeps its marker, so they can go later.
      const drained = (await this.options.fileDeleter?.drainRoot(marker.from)) ?? true;
      if (fromIsDefault) {
        await removeScratch(marker.from);
      } else {
        if (!drained) {
          throw new Error("files purged under the old cache directory are still pending");
        }
        await this.relinquish(marker.from);
      }
      this.options.settings.updateCacheRoot({ cacheMigration: undefined });
      this.options.logger.info("cache_migration_cleaned_up", { id: marker.id });
    } catch (error) {
      this.options.logger.warn("cache_cleanup_failed", { id: marker.id, error: String(error) });
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /** A flat cache store over `dir`; only the default directory may be created on demand. */
  private storeOver(dir: string, roots: Roots): FileStore {
    return this.samePath(dir, roots.defaultDir) ? this.options.storeFactory(dir, { createDir: true }) : this.options.storeFactory(dir);
  }

  /** The data directory and the default cache directory, resolved; the latter may not exist yet. */
  private async roots(): Promise<Roots> {
    const dataRoot = await this.realpathOr(this.options.dataDir);
    const configured = this.options.media.cache.defaultDirectory();
    let defaultDir: string;
    try {
      defaultDir = await realpath(configured);
    } catch {
      defaultDir = join(await this.realpathOr(dirname(configured)), basename(configured));
    }
    return { dataRoot, defaultDir };
  }

  /** The resolved path, or the path as given when it cannot be resolved (an unplugged volume). */
  private async realpathOr(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  }

  private samePath(a: string, b: string): boolean {
    return samePath(a, b, this.isWindows);
  }

  /** Whether `path` is strictly inside `ancestor`. */
  private isInside(path: string, ancestor: string): boolean {
    const paths = this.isWindows ? win32 : posix;
    const relative = paths.relative(this.isWindows ? ancestor.toLowerCase() : ancestor, this.isWindows ? path.toLowerCase() : path);
    return relative !== "" && !relative.startsWith("..") && !paths.isAbsolute(relative);
  }
}
