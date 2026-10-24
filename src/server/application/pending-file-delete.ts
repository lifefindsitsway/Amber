import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { monotonicFactory } from "ulid";
import { isCacheRef } from "../../shared/cache-file-name.ts";
import { TRASH_RETRY_BASE_MS, TRASH_RETRY_MAX_MS, TRASH_SWEEP_BATCH } from "../../shared/defaults.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { PendingFileDelete } from "../domain/runtime-support.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { CacheGate } from "../pipeline/cache-gate.ts";
import { CachePathLocks } from "../pipeline/cache-path-locks.ts";
import { cacheRowsAt, matchesIdentity } from "../pipeline/cache-swap.ts";
import type { MediaFiles } from "../pipeline/media-files.ts";
import { samePath } from "./cache-root.ts";

export interface PendingFileDeleterOptions {
  repository: Repository;
  /** The data store and the current cache store. */
  media: Pick<MediaFiles, "data" | "cache">;
  /** The data directory: the root every data-store ref is relative to. */
  dataDir: string;
  /** Cache files are removed under a shared lease, so a cache move never races the worker. */
  gate: Pick<CacheGate, "tryShared">;
  /**
   * Serializes removing a cache file with publishing a new cache at the same path.
   * Defaults to a private set of locks, enough where nothing else touches the cache.
   */
  locks?: Pick<CachePathLocks, "withLock">;
  /**
   * A store over a cache directory other than the current one, or `undefined` while it is
   * unreachable or not Amber's own. Absent where the cache directory never moves (server
   * mode): rows of another root then wait.
   */
  foreignCacheRoot?: (rootPath: string) => Promise<FileStore | undefined>;
  /** Runs after every drain, so whoever wakes the worker can schedule the next due row. */
  afterDrain?: () => void;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
  /** Path rules differ per platform; defaults to the running one. */
  isWindows?: boolean;
}

/** One file to register: the ref relative to the current root of its store. */
export interface PendingFile {
  store: PendingFileDelete["store"];
  storageRef: string;
  expectedSizeBytes?: number;
  /** `sha256:<hex>` of the file meant; recorded for caches, whose names a newer cache may take. */
  expectedDigest?: string;
  userId?: string;
}

/** The wait before attempt `attempts + 1`: `TRASH_RETRY_BASE_MS × 2^(attempts − 1)`, capped at `TRASH_RETRY_MAX_MS`. */
export function retryBackoffMs(attempts: number): number {
  return Math.min(TRASH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), TRASH_RETRY_MAX_MS);
}

/** The code alone: cache file names carry the user's titles. */
function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "error";
}

/**
 * An absolute directory resolved the way the cache root service resolves roots: through
 * symlinks when it exists, else its resolved parent joined with its name (a default cache
 * directory not created yet, an unplugged volume).
 */
export function resolvedDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/**
 * The files purging these assets leaves to remove: never the user's own
 * `external_local` files, a cache only at a flat cache ref (the obsolete nested layout is the
 * start-up sweep's), and a cache ref only while no other available row holds it, since an
 * evicted cache's name may have been given to a newer file meanwhile.
 */
export function filesOfAssets(scope: RepositoryScope, assets: readonly MediaAsset[]): PendingFile[] {
  const leaving = new Set(assets.map((asset) => asset.id));
  const files: PendingFile[] = [];
  for (const asset of assets) {
    if (asset.kind === "external_local") {
      continue;
    }
    if (asset.kind === "platform_cache") {
      if (!isCacheRef(asset.storageRef)) {
        continue;
      }
      const heldElsewhere = scope.mediaAssets
        .listCachesByStorageRefUnscoped(asset.storageRef)
        .some((other) => !leaving.has(other.id) && other.availability === "available");
      if (heldElsewhere) {
        continue;
      }
    }
    files.push({
      store: asset.kind === "platform_cache" ? "cache" : "data",
      storageRef: asset.storageRef,
      expectedSizeBytes: asset.sizeBytes,
      ...(asset.kind === "platform_cache" && asset.fingerprint !== undefined && asset.fingerprint !== "" ? { expectedDigest: asset.fingerprint } : {}),
      userId: asset.userId,
    });
  }
  return files;
}

/** `assets/<user>/<content>` of a data ref inside a Content's directory. */
function contentDirOf(ref: string): string | undefined {
  const [top, user, content, ...rest] = ref.split("/");
  return top === "assets" && user !== undefined && content !== undefined && rest.length > 0 ? `assets/${user}/${content}` : undefined;
}

/**
 * The persistent queue of files to remove. A purge or a user deletion
 * registers its files in its own transaction (`register`); committing it is the deletion.
 * This single-flight worker removes them afterwards, each only through the root it was
 * registered under: a ref is never read against a cache directory that replaced that root,
 * which may hold another file of the same name. Before removing, a file's size, and its
 * SHA-256 when one was recorded, are checked against the registration; a different file is
 * left alone and only its registration dropped, a file already gone counts as removed. A
 * cache file is removed under its path's lock, and not at all while an available row holds
 * the path in the current cache directory: a newer cache took the name. A failure waits
 * `retryBackoffMs`; while the cache lease is held exclusively (a move) the cache rows wait
 * `TRASH_RETRY_BASE_MS`, and rows of a root that cannot be reached wait the cap.
 *
 * The worker never throws: every failure is logged and left to the next run. It runs on
 * `kick()`; `afterDrain` lets the trash service's timer wake it again at `nextDueAt()`.
 */
export class PendingFileDeleter {
  private readonly options: PendingFileDeleterOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly isWindows: boolean;
  private tail: Promise<void> = Promise.resolve();
  /** A drain is queued but has not started yet; further kicks join it. */
  private queued = false;
  private stopped = false;

  private readonly locks: Pick<CachePathLocks, "withLock">;

  constructor(options: PendingFileDeleterOptions) {
    this.options = options;
    this.locks = options.locks ?? new CachePathLocks();
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.isWindows = options.isWindows ?? process.platform === "win32";
  }

  /** The current cache directory, resolved as rows record it. */
  currentCacheRoot(): string {
    return resolvedDir(this.options.media.cache.directory());
  }

  /**
   * Registers files inside the caller's transaction, against the roots current right now.
   * A file already registered under the same root keeps its row.
   */
  register(scope: RepositoryScope, files: readonly PendingFile[]): void {
    if (files.length === 0) {
      return;
    }
    const roots = { data: resolvedDir(this.options.dataDir), cache: this.currentCacheRoot() };
    const now = this.now();
    for (const file of files) {
      scope.pendingFileDeletes.insert({
        id: this.newId(),
        store: file.store,
        rootPath: roots[file.store],
        storageRef: file.storageRef,
        ...(file.expectedSizeBytes === undefined ? {} : { expectedSizeBytes: file.expectedSizeBytes }),
        ...(file.expectedDigest === undefined ? {} : { expectedDigest: file.expectedDigest }),
        ...(file.userId === undefined ? {} : { userId: file.userId }),
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      });
    }
  }

  /** Refs still waiting to be removed under `rootPath`; in the current cache root they keep their names taken. */
  listRefs(store: PendingFileDelete["store"], rootPath: string): Set<string> {
    const rows = this.options.repository.withTransaction((scope) => scope.pendingFileDeletes.listByStore(store));
    return new Set(rows.filter((row) => samePath(row.rootPath, rootPath, this.isWindows)).map((row) => row.storageRef));
  }

  /** `listRefs` of the current cache root. */
  pendingCacheRefs(): Set<string> {
    return this.listRefs("cache", this.currentCacheRoot());
  }

  /** Refs waiting under the data directory and the cache directory in use: the start-up sweep leaves them to this worker. */
  currentPendingRefs(): { data: Set<string>; cache: Set<string> } {
    return { data: this.listRefs("data", resolvedDir(this.options.dataDir)), cache: this.pendingCacheRefs() };
  }

  /** When the earliest row is due, if any. */
  nextDueAt(): number | undefined {
    return this.options.repository.withTransaction((scope) => scope.pendingFileDeletes.earliestAttemptAt());
  }

  /** Wakes the worker; a run already queued takes this call's work along. Never waits and never throws. */
  kick(): void {
    if (this.stopped || this.queued) {
      return;
    }
    this.queued = true;
    void this.enqueue(async () => {
      this.queued = false;
      await this.drainDue();
    });
  }

  /**
   * Removes every row registered under the cache directory `rootPath` now, due or not, and
   * tells whether none is left. The cache root service calls it before it gives an old
   * directory up, while the directory is still marked as Amber's.
   */
  drainRoot(rootPath: string): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        const rows = this.options.repository
          .withTransaction((scope) => scope.pendingFileDeletes.listByStore("cache"))
          .filter((row) => samePath(row.rootPath, rootPath, this.isWindows));
        if (rows.length > 0) {
          await this.removeCacheGroup(rootPath, rows);
        }
        return this.listRefs("cache", rootPath).size === 0;
      } catch (error) {
        this.options.logger.error("pending_file_drain_failed", { error: errorCode(error) });
        return false;
      }
    });
  }

  /** Resolves once nothing is running or queued. */
  async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.tail;
      await current;
    } while (current !== this.tail);
  }

  /** No new run starts; a running one stops after the file at hand. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.whenIdle();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drainDue(): Promise<void> {
    const { repository, logger } = this.options;
    try {
      for (;;) {
        if (this.stopped) {
          return;
        }
        const now = this.now();
        const due = repository.withTransaction((scope) => scope.pendingFileDeletes.listDue(now, TRASH_SWEEP_BATCH));
        const groups = new Map<string, PendingFileDelete[]>();
        for (const row of due) {
          // Grouped by the root string as stored; one root resolves alike whatever its case.
          const key = `${row.store}\u0000${row.rootPath}`;
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        for (const rows of groups.values()) {
          const first = rows[0] as PendingFileDelete;
          if (first.store === "data") {
            await this.removeDataGroup(rows);
          } else {
            await this.removeCacheGroup(first.rootPath, rows);
          }
        }
        // Every row taken was removed or rescheduled into the future: a short batch was the last.
        if (due.length < TRASH_SWEEP_BATCH) {
          return;
        }
      }
    } catch (error) {
      logger.error("pending_file_drain_failed", { error: errorCode(error) });
    } finally {
      this.afterDrain();
    }
  }

  private afterDrain(): void {
    try {
      this.options.afterDrain?.();
    } catch (error) {
      this.options.logger.warn("pending_file_after_drain_failed", { error: errorCode(error) });
    }
  }

  /** Data rows are always read against the data directory in use: refs there are asset and Task ids. */
  private async removeDataGroup(rows: readonly PendingFileDelete[]): Promise<void> {
    const store = this.options.media.data;
    const dirs = new Set<string>();
    for (const row of rows) {
      if (this.stopped) {
        return;
      }
      await this.removeOne(store, row);
      const dir = contentDirOf(row.storageRef);
      if (dir !== undefined) {
        dirs.add(dir);
      }
    }
    // The Content is gone, so nothing writes into its directory any more.
    for (const dir of dirs) {
      try {
        await store.removeEmptyDirs(dir);
      } catch (error) {
        this.options.logger.warn("content_dir_removal_failed", { error: errorCode(error) });
      }
    }
  }

  private async removeCacheGroup(rootPath: string, rows: readonly PendingFileDelete[]): Promise<void> {
    const release = this.options.gate.tryShared();
    if (release === undefined) {
      // A cache move holds the exclusive lease; it is short-lived, so the rows wait the base delay.
      this.postpone(rows, TRASH_RETRY_BASE_MS);
      return;
    }
    try {
      const store = await this.cacheStoreOf(rootPath);
      if (store === "unavailable") {
        // The current cache directory's volume is unplugged: like a failed attempt, so the wait grows.
        for (const row of rows) {
          this.failed(row, "cache_unavailable");
        }
        return;
      }
      if (store === undefined) {
        this.postpone(rows, TRASH_RETRY_MAX_MS);
        return;
      }
      const current = store === this.options.media.cache;
      for (const row of rows) {
        if (this.stopped) {
          return;
        }
        await this.locks.withLock(row.storageRef, async () => {
          if (current && this.heldByAvailableRow(row.storageRef)) {
            this.options.repository.withTransaction((scope) => scope.pendingFileDeletes.delete(row.id));
            return;
          }
          await this.removeOne(store, row);
        });
      }
    } finally {
      release();
    }
  }

  private heldByAvailableRow(ref: string): boolean {
    return this.options.repository.withTransaction((scope) => cacheRowsAt(scope, ref).some((asset) => asset.availability === "available"));
  }

  /** The store a cache root is read through now: the current cache store, another of Amber's roots, or nothing. */
  private async cacheStoreOf(rootPath: string): Promise<FileStore | "unavailable" | undefined> {
    const { cache } = this.options.media;
    if (samePath(rootPath, this.currentCacheRoot(), this.isWindows)) {
      return (await cache.isAvailable()) ? cache : "unavailable";
    }
    return this.options.foreignCacheRoot?.(rootPath);
  }

  private async removeOne(store: FileStore, row: PendingFileDelete): Promise<void> {
    const { repository, logger } = this.options;
    try {
      if (row.expectedSizeBytes !== undefined) {
        const stored = await store.stat(row.storageRef);
        if (stored === null) {
          repository.withTransaction((scope) => scope.pendingFileDeletes.delete(row.id));
          return;
        }
        const same =
          stored.sizeBytes === row.expectedSizeBytes &&
          (row.expectedDigest === undefined || (await matchesIdentity(store.pathOf(row.storageRef), { sizeBytes: stored.sizeBytes, digest: row.expectedDigest })) === true);
        if (!same) {
          // Another file took the name since; it is not Amber's to remove.
          repository.withTransaction((scope) => scope.pendingFileDeletes.delete(row.id));
          logger.warn("pending_file_mismatch", { store: row.store });
          return;
        }
      }
      // Without a recorded size (a Task's scratch directory) the ref is removed as it is; removing nothing is fine.
      await store.remove(row.storageRef);
      repository.withTransaction((scope) => scope.pendingFileDeletes.delete(row.id));
    } catch (error) {
      this.failed(row, errorCode(error));
    }
  }

  private failed(row: PendingFileDelete, code: string): void {
    const attempts = row.attempts + 1;
    this.options.repository.withTransaction((scope) => scope.pendingFileDeletes.reschedule(row.id, attempts, this.now() + retryBackoffMs(attempts), code));
    this.options.logger.warn("pending_file_delete_failed", { store: row.store, attempts, error: code });
  }

  /** Waits without counting an attempt: nothing was tried. */
  private postpone(rows: readonly PendingFileDelete[], delayMs: number): void {
    const at = this.now() + delayMs;
    this.options.repository.withTransaction((scope) => {
      for (const row of rows) {
        scope.pendingFileDeletes.reschedule(row.id, row.attempts, at, row.lastError);
      }
    });
  }
}
