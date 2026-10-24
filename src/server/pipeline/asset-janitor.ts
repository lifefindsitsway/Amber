import { CACHE_DIR_NAME } from "../../shared/app-identity.ts";
import { amberError } from "../domain/errors.ts";
import { needsQualityProbe, type MediaAsset } from "../domain/media-asset.ts";
import type { Task } from "../domain/task.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { SubtitleMuxer } from "../ports/subtitle-muxer.ts";
import type { CacheHoldRegistry } from "./cache-holds.ts";
import type { CachePathLocks } from "./cache-path-locks.ts";
import { verifyCacheQualities } from "./cache-quality.ts";
import { cacheRowsAt, describeHold, matchesIdentity, readSwapRecord, recoverSwap, type SwapRecoveryOutcome } from "./cache-swap.ts";
import type { TaskEventBus } from "./events.ts";
import type { CacheFileStore, MediaFiles } from "./media-files.ts";
import { isTerminalProjection } from "./projection.ts";
import { isOriginalMedia, taskScratchRef } from "./stages/source-media.ts";

export interface AssetJanitorOptions {
  repository: Repository;
  /** The data store and the video cache store; the asset kind decides where a file belongs. */
  media: MediaFiles;
  bus: TaskEventBus;
  logger: Logger;
  /** `AMBER_LOG_LEVEL=debug`: Task scratch directories are kept for inspection. */
  keepTaskScratch?: boolean;
  /**
   * Refs of purged files still waiting in the pending-file queue under the current data and
   * cache directories. They are the queue's to remove, so the sweep neither
   * removes them as orphans nor counts them as unknown.
   */
  pendingRefs?: () => { data: ReadonlySet<string>; cache: ReadonlySet<string> };
  /**
   * When this process started, before it accepted requests; the sweep removes only empty
   * directories older than that, never one an upload has just created. Defaults to the
   * janitor's construction.
   */
  startedAt?: number;
  /**
   * Interrupted cache replacements the recovery could not settle, and the path locks it
   * settles them under. Without them (server mode) there are no replacements to recover.
   */
  swaps?: { holds: CacheHoldRegistry; locks: CachePathLocks };
  /**
   * Reads the height of video caches an earlier build registered without looking at the
   * file. Absent where there are no caches (server mode): nothing is probed.
   */
  muxer?: Pick<SubtitleMuxer, "inspect">;
}

/**
 * File times come from the kernel's coarse clock and can trail `Date.now()` by a few
 * milliseconds; the sweep treats directories changed this close to the start as new.
 */
export const FS_CLOCK_SLACK_MS = 10_000;

/** What the start-up sweep did in the cache directory. */
interface CacheSweep {
  partials: number;
  /** Entries of `.amber-tmp` that interrupted downloads left behind. */
  scratch: number;
  leftovers: number;
  unknown: number;
}

/** Top-level scratch directories whose contents never outlive a process. */
const VOLATILE_DIRS = ["tmp/cookies", "tmp/backup", "tmp/platform", "tmp/asr-test"] as const;

/**
 * Removes what a finished Task leaves behind and sweeps debris at start-up. Database rows
 * go first and files second, so a failure in between leaves an unreferenced file that the
 * next start-up sweep removes, never a row without its file.
 *
 * - `extracted_audio` / `temporary` of a Task in any terminal state are free to rebuild and
 *   are removed, except the products of a `burn` Task, which the client saves first.
 * - `tmp/tasks/<taskId>/` holds paid-call checkpoints: while the Task is `failed` and can
 *   be reopened, the outputs of its `succeeded` units stay; `succeeded` / `cancelled`
 *   remove the directory.
 * - A `discard_after_audio` upload is removed once a Task that extracted its audio succeeds.
 * - At start-up, empty directories under `assets/` from before this process go too.
 *
 * Both stores are swept at start-up. In the data store's `assets/` a file is an orphan when
 * no row points at it, or when its row's kind belongs to the other store: this is how
 * caches of the obsolete nested layout get collected. The cache directory has rules of its
 * own: a file some `available` row points at stays, a file
 * whose rows are all `evicted` is Amber's own leftover and goes, and a file no row points
 * at is left alone and only counted (`cache_unknown_file`), since the user may have put or
 * renamed it there; Amber's own `.amber-tmp` goes with whatever is in it, except the
 * directories of interrupted replacements (`recoverSwaps`). A leftover goes only when it is
 * still the file an evicted row describes (size and SHA-256 equal to its fingerprint; size
 * alone for a row without fingerprint); a different file under the name is counted as
 * unknown. Video caches whose height an earlier build never read are probed and their
 * quality recorded as verified. An unmounted
 * custom cache directory is skipped, never treated as empty. Purged files still waiting in
 * the pending-file queue are the queue's: neither removed here nor counted.
 */
export class AssetJanitor {
  private readonly options: AssetJanitorOptions;
  private queue: Promise<void> = Promise.resolve();

  private readonly startedAt: number;
  /** Whether a recovery of interrupted replacements ran over a mounted cache directory. */
  private swapsSettled = false;
  /** The recovery running now, which every caller asking meanwhile waits for. */
  private swapRun: Promise<Partial<Record<SwapRecoveryOutcome, number>>> | undefined;

  constructor(options: AssetJanitorOptions) {
    this.options = options;
    this.startedAt = options.startedAt ?? Date.now();
  }

  /** Cleans after every finished Task; returns the unsubscribe function. */
  start(): () => void {
    return this.options.bus.subscribe(({ userId, event }) => {
      if (event.type === "task.finished") {
        this.enqueue(() => this.afterTask(userId, event.task.id));
      }
    });
  }

  /** Resolves once every queued cleanup has run. */
  async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  /**
   * The first step at start-up, before the cache move recovery and every sweep: settles each
   * interrupted cache replacement left in `.amber-tmp` (see `recoverSwap`), each under its
   * target path's lock. What cannot be settled from the files, or what fails while being
   * settled, is held for the user. A cache directory that is not mounted is left for
   * `ensureSwapsRecovered`.
   */
  recoverSwaps(): Promise<Partial<Record<SwapRecoveryOutcome, number>>> {
    this.swapRun ??= this.runSwapRecovery().finally(() => {
      this.swapRun = undefined;
    });
    return this.swapRun;
  }

  /**
   * Called before a cache Task is admitted: when the cache directory was not mounted at
   * start-up and is now, its interrupted replacements are settled first, once, so no
   * download publishes over a path whose earlier replacement nobody has looked at. A
   * recovery that cannot run refuses the cache Task (`conflict.cache_recovery_pending`).
   */
  async ensureSwapsRecovered(): Promise<void> {
    if (this.options.swaps === undefined || this.swapsSettled) {
      return;
    }
    if (!(await this.options.media.cache.isAvailable())) {
      // Nothing to look at; the caller refuses the Task as the directory is missing.
      return;
    }
    try {
      await this.recoverSwaps();
    } catch (error) {
      this.options.logger.error("cache_swap_recovery_failed", { error: (error as NodeJS.ErrnoException | undefined)?.code ?? String(error) });
      throw amberError("conflict", "interrupted cache replacements could not be checked", { code: "conflict.cache_recovery_pending" });
    }
  }

  private async runSwapRecovery(): Promise<Partial<Record<SwapRecoveryOutcome, number>>> {
    const swaps = this.options.swaps;
    const cache = this.options.media.cache;
    const counts: Partial<Record<SwapRecoveryOutcome, number>> = {};
    if (swaps === undefined) {
      return counts;
    }
    if (!(await cache.isAvailable())) {
      this.options.logger.info("cache_swap_recovery_skipped_cache_unavailable");
      return counts;
    }
    const deps = { repository: this.options.repository, cache, locks: swaps.locks, holds: swaps.holds, logger: this.options.logger };
    for (const id of await cache.swapScratchIds()) {
      let outcome: SwapRecoveryOutcome;
      try {
        outcome = await recoverSwap(deps, id);
      } catch (error) {
        // `recoverSwap` holds what fails while it settles; this is a record that could not
        // even be read. Held when it can be read now, so nothing publishes over its path.
        this.options.logger.error("cache_swap_recovery_failed", { scratchId: id, error: (error as NodeJS.ErrnoException | undefined)?.code ?? String(error) });
        const record = await readSwapRecord(cache.scratchPath(id)).catch(() => undefined);
        if (record !== undefined && record !== "corrupt") {
          swaps.holds.add(await describeHold(cache, id, record));
          outcome = "held";
        } else {
          continue;
        }
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    this.swapsSettled = true;
    if (Object.keys(counts).length > 0) {
      this.options.logger.info("cache_swap_recovery_done", counts);
    }
    return counts;
  }

  /** Start-up sweep; runs before the scheduler starts, so no Task is writing yet. */
  async sweep(): Promise<void> {
    const { media, repository } = this.options;
    const pending = this.options.pendingRefs?.() ?? { data: new Set<string>(), cache: new Set<string>() };
    const data = await this.sweepStore(media.data, pending.data);
    let cache: CacheSweep | undefined;
    if (await media.cache.isAvailable()) {
      cache = await this.sweepCache(media.cache, pending.cache);
      await this.verifyQualities();
    } else {
      this.options.logger.info("asset_sweep_skipped_cache_unavailable");
    }
    for (const dir of VOLATILE_DIRS) {
      await media.data.remove(dir);
    }
    for (const taskId of new Set((await media.data.list("tmp/tasks")).map((ref) => ref.split("/")[2] as string))) {
      const task = repository.withTransaction((scope) => scope.tasks.getUnscoped(taskId));
      await this.cleanScratch(task, taskId);
    }
    this.options.logger.info("asset_sweep_done", { ...data, ...(cache === undefined ? {} : { cache }) });
  }

  /** Partials, orphaned asset files and empty directories of one store. */
  private async sweepStore(store: FileStore, pending: ReadonlySet<string>): Promise<{ partials: number; orphans: number; emptyDirs: number }> {
    const { media, repository } = this.options;
    const partials = await store.removePartials();
    let orphans = 0;
    for (const ref of await store.list("assets")) {
      const [, userId, contentId, assetId, ...rest] = ref.split("/");
      if (userId === undefined || contentId === undefined || assetId === undefined || rest.length > 0 || pending.has(ref)) {
        continue;
      }
      const verdict = repository.withTransaction((scope) => {
        const asset = scope.mediaAssets.get(userId, assetId);
        if (asset === undefined || asset.storageRef !== ref || media.storeFor(asset.kind) !== store) {
          return "orphan" as const;
        }
        const task = asset.taskId === undefined ? undefined : scope.tasks.get(userId, asset.taskId);
        if (task !== undefined && isTerminalProjection(task.statusProjection) && disposable(asset, task)) {
          scope.mediaAssets.delete(userId, asset.id);
          return "orphan" as const;
        }
        return "keep" as const;
      });
      if (verdict === "orphan") {
        await store.remove(ref);
        orphans += 1;
      }
    }
    // Content directories emptied by deletions or orphan removal.
    const emptyDirs = await store.removeEmptyDirs("assets", { olderThan: this.startedAt - FS_CLOCK_SLACK_MS });
    return { partials, orphans, emptyDirs };
  }

  /** Partials, download scratch and leftover files of the cache directory; unknown files are counted, never removed. */
  private async sweepCache(store: CacheFileStore, pending: ReadonlySet<string>): Promise<CacheSweep> {
    const { repository } = this.options;
    const partials = await store.removePartials();
    const scratch = await store.removeScratch();
    let leftovers = 0;
    let unknown = 0;
    // Rows are looked up as Windows compares names: an available row under a differently
    // cased spelling holds the same file.
    const rowsAt = (ref: string) => repository.withTransaction((scope) => cacheRowsAt(scope, ref));
    const allEvicted = (rows: readonly MediaAsset[]) => rows.length > 0 && rows.every((asset) => asset.availability === "evicted");
    for (const ref of await store.list(CACHE_DIR_NAME)) {
      if (this.options.swaps?.holds.isHeld(ref) === true) {
        // An interrupted replacement waits for the user; its files are the user's to settle.
        continue;
      }
      const rows = rowsAt(ref);
      if (rows.length === 0) {
        if (!pending.has(ref)) {
          unknown += 1;
        }
      } else if (allEvicted(rows)) {
        // A file still open elsewhere (a player, an ffmpeg run) waits for the next start.
        try {
          const removed = await this.withPathLock(ref, async () => {
            // Read again under the lock: a recovery or a publish may have settled the path meanwhile.
            const now = rowsAt(ref);
            if (this.options.swaps?.holds.isHeld(ref) === true || !allEvicted(now)) {
              return "kept" as const;
            }
            if (!(await this.isLeftover(store, ref, now))) {
              return "unknown" as const;
            }
            await store.remove(ref);
            return "removed" as const;
          });
          if (removed === "removed") {
            leftovers += 1;
          } else if (removed === "unknown") {
            unknown += 1;
          }
        } catch (error) {
          this.options.logger.warn("cache_leftover_remove_failed", { error: (error as NodeJS.ErrnoException | undefined)?.code ?? "error" });
        }
      }
    }
    if (unknown > 0) {
      // A count only: file names in the cache directory are the user's titles.
      this.options.logger.info("cache_unknown_file", { count: unknown });
    }
    return { partials, scratch, leftovers, unknown };
  }

  private withPathLock<T>(ref: string, work: () => Promise<T>): Promise<T> {
    const locks = this.options.swaps?.locks;
    return locks === undefined ? work() : locks.withLock(ref, work);
  }

  /** Whether the file at `ref` is still one of these evicted rows' own file, not another that took the name. */
  private async isLeftover(store: CacheFileStore, ref: string, rows: readonly MediaAsset[]): Promise<boolean> {
    const stored = await store.stat(ref);
    if (stored === null) {
      return false;
    }
    for (const row of rows) {
      if (row.sizeBytes !== stored.sizeBytes) {
        continue;
      }
      if (row.fingerprint === undefined || row.fingerprint === "") {
        return true;
      }
      if ((await matchesIdentity(store.pathOf(ref), { sizeBytes: stored.sizeBytes, digest: row.fingerprint })) === true) {
        return true;
      }
    }
    return false;
  }

  /** Probes the video caches whose quality an earlier build recorded without reading the file. */
  private async verifyQualities(): Promise<void> {
    const muxer = this.options.muxer;
    if (muxer === undefined) {
      return;
    }
    const pending = this.options.repository
      .withTransaction((scope) => scope.mediaAssets.listAvailableCachesUnscoped())
      .filter((asset) => needsQualityProbe(asset));
    if (pending.length === 0) {
      return;
    }
    const verified = await verifyCacheQualities(
      { repository: this.options.repository, cache: this.options.media.cache, muxer, logger: this.options.logger },
      pending,
      new AbortController().signal,
    );
    this.options.logger.info("cache_quality_verified", { count: verified });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.options.logger.error("asset_cleanup_failed", { error: String(error) });
    });
  }

  private async afterTask(userId: string, taskId: string): Promise<void> {
    const { repository, media } = this.options;
    const removed = repository.withTransaction((scope) => {
      const task = scope.tasks.get(userId, taskId);
      if (task === undefined || !isTerminalProjection(task.statusProjection)) {
        return { task, assets: [] as MediaAsset[] };
      }
      const owned = scope.mediaAssets.listByTask(userId, taskId);
      const assets = owned.filter((asset) => disposable(asset, task));
      for (const asset of assets) {
        scope.mediaAssets.delete(userId, asset.id);
      }
      const extractedAudio = owned.some((asset) => asset.kind === "extracted_audio");
      if (task.statusProjection === "succeeded" && extractedAudio && task.contentId !== undefined) {
        for (const original of scope.mediaAssets.listByContent(userId, task.contentId)) {
          if (original.kind === "managed_upload" && original.retentionPolicy === "discard_after_audio") {
            scope.mediaAssets.delete(userId, original.id);
            assets.push(original);
          }
        }
      }
      return { task, assets };
    });
    for (const asset of removed.assets) {
      await media.storeFor(asset.kind).remove(asset.storageRef);
    }
    if (removed.task !== undefined && isTerminalProjection(removed.task.statusProjection)) {
      await this.cleanScratch(removed.task, taskId);
    }
  }

  /**
   * `tmp/tasks/<taskId>/`: removed for a Task that is gone or can no longer be reopened;
   * for a `failed` one only the outputs of its succeeded units (the checkpoints) stay;
   * an unfinished Task keeps everything.
   */
  private async cleanScratch(task: Task | undefined, taskId: string): Promise<void> {
    const { repository } = this.options;
    const files = this.options.media.data;
    const dir = taskScratchRef(taskId);
    if (this.options.keepTaskScratch === true) {
      return;
    }
    if (task === undefined || task.statusProjection === "succeeded" || task.statusProjection === "cancelled") {
      await files.remove(dir);
      return;
    }
    if (task.statusProjection !== "failed") {
      return;
    }
    const checkpoints = new Set(
      repository.withTransaction((scope) =>
        scope.workUnits
          .listByTask(task.userId, task.id)
          .filter((unit) => unit.status === "succeeded" && unit.outputRef !== undefined)
          .map((unit) => unit.outputRef as string),
      ),
    );
    for (const ref of await files.list(dir)) {
      if (!checkpoints.has(ref)) {
        await files.remove(ref);
      }
    }
  }
}

/** Task-scoped intermediates are disposable at the Task's end; `burn` output waits for the client to save it. */
function disposable(asset: MediaAsset, task: Task): boolean {
  if (isOriginalMedia(asset) || asset.taskId !== task.id) {
    return false;
  }
  return !(task.kind === "burn" && asset.kind === "temporary");
}
