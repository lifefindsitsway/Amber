import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cacheFileNameOf, sameCacheFileName } from "../../shared/cache-file-name.ts";
import { displayTitleOf } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import { isAudioCache, isVideoCache, verifiedCacheHeight, type MediaAsset } from "../domain/media-asset.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { CacheHold, CacheHoldRegistry } from "./cache-holds.ts";
import type { CachePathLocks } from "./cache-path-locks.ts";
import type { CacheFileStore } from "./media-files.ts";
import { isTerminalProjection } from "./projection.ts";

/**
 * The replacement protocol of the cache directory. A finished download waits in
 * `.amber-tmp/<assetId>/`; publishing it under its final name happens under the target
 * path's lock:
 *
 * 1. decide what the target path holds now and whether it may be replaced;
 * 2. write and fsync `swap.json` into the scratch directory, recording the target, the new
 *    file's size and digest, and the displaced file's;
 * 3. move a file already at the target into the scratch directory as `displaced` (a file
 *    another program holds open refuses: `conflict.cache_file_busy`, nothing moved);
 * 4. move the new file to the target and fsync the directory;
 * 5. one transaction registers the new row and marks the replaced rows `evicted`;
 * 6. remove `swap.json` and make that durable, then the rest of the scratch directory.
 *
 * A failure in 4 or 5 moves both files back. A crash anywhere leaves `swap.json`, which the
 * start-up recovery reads before anything else touches the cache directory: a registered
 * new row proves the commit; otherwise it undoes the replacement when the files on disk
 * prove what happened, and else keeps every file and holds the path for the user to decide
 * (`recoverSwap`).
 */

/** The record of a replacement in progress, inside its scratch directory. */
export const SWAP_RECORD_FILE = "swap.json";
/** The file a replacement moved away from the target path, inside its scratch directory. */
export const DISPLACED_FILE = "displaced";
/** The record is written here first and renamed, so `swap.json` is never half written. */
const SWAP_RECORD_TEMP = "swap.json.tmp";

/** Size and `sha256:<hex>` digest of a file. */
export interface FileIdentity {
  sizeBytes: number;
  digest: string;
}

const identitySchema = { sizeBytes: z.number().int().nonnegative(), digest: z.string().min(1) };

const swapRecordSchema = z.object({
  v: z.literal(1),
  targetRef: z.string().min(1),
  newAssetId: z.string().min(1),
  newSizeBytes: identitySchema.sizeBytes,
  newDigest: identitySchema.digest,
  // `assetId` is absent when the displaced file was an evicted cache's leftover.
  displaced: z.object({ assetId: z.string().min(1).exactOptional(), sizeBytes: identitySchema.sizeBytes, digest: identitySchema.digest }).exactOptional(),
});
export type SwapRecord = z.infer<typeof swapRecordSchema>;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Makes a rename durable; Windows cannot open a directory for syncing and has no need to. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Size and digest of the file at `path`, or `null` when there is none. */
export async function identityOf(path: string): Promise<FileIdentity | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      return null;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).length;
  }
  return { sizeBytes, digest: `sha256:${hash.digest("hex")}` };
}

/**
 * Whether the file at `path` is the one described: the size is compared first, so a
 * different file is usually told apart without reading it. `"missing"` when there is none.
 */
export async function matchesIdentity(path: string, expected: FileIdentity): Promise<boolean | "missing"> {
  let size: number;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      return "missing";
    }
    size = stats.size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  if (size !== expected.sizeBytes) {
    return false;
  }
  return (await identityOf(path))?.digest === expected.digest;
}

/** Writes `swap.json` atomically and durably into `dir`. */
export async function writeSwapRecord(dir: string, record: SwapRecord): Promise<void> {
  const temp = join(dir, SWAP_RECORD_TEMP);
  await writeFile(temp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  const handle = await open(temp, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, SWAP_RECORD_FILE));
  await syncDirectory(dir);
}

/** The record in `dir`; `undefined` when there is none, `"corrupt"` when it cannot be read as one. */
export async function readSwapRecord(dir: string): Promise<SwapRecord | "corrupt" | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, SWAP_RECORD_FILE), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed = swapRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : "corrupt";
  } catch {
    return "corrupt";
  }
}

async function removeSwapRecord(dir: string): Promise<void> {
  await rm(join(dir, SWAP_RECORD_FILE), { force: true });
  try {
    await syncDirectory(dir);
  } catch (error) {
    // No directory, no record left to make durable.
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Removes the scratch directory of a settled replacement. The record goes first, durably,
 * and only then the files beside it: a crash in between leaves a directory without a
 * record, which the start-up sweep removes, never a record whose files are half gone (for
 * a committed replacement such a record would later be read against whatever file a newer
 * cache put at the target).
 */
async function discardScratch(cache: CacheFileStore, scratchId: string): Promise<void> {
  await removeSwapRecord(cache.scratchPath(scratchId));
  await cache.removeScratchDir(scratchId, { force: true });
}

/** Flushes a file's contents to the disk, so the rename that publishes it never names a file the disk lost. */
async function syncFile(path: string): Promise<void> {
  // Writable: Windows flushes a file only through a handle that may write to it.
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Windows reports a file another program holds open as busy or not permitted. */
function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function fileBusy(): never {
  throw amberError("conflict", "the cache file is in use by another program", { code: "conflict.cache_file_busy" });
}

function foreignFile(): never {
  throw amberError("conflict", "the file at the cache path is not the registered cache", { code: "conflict.cache_file_foreign" });
}

function recoveryPending(): never {
  throw amberError("conflict", "an interrupted replacement of this cache path waits for the user", { code: "conflict.cache_recovery_pending" });
}

/** The cache rows of any user at `ref`, compared as Windows compares names. */
export function cacheRowsAt(scope: RepositoryScope, ref: string): MediaAsset[] {
  const exact = scope.mediaAssets.listCachesByStorageRefUnscoped(ref);
  // Rows at a differently cased spelling of the same name hold the same file on Windows.
  const others = scope.mediaAssets
    .listAvailableCachesUnscoped()
    .filter((asset) => asset.storageRef !== ref && sameCacheFileName(asset.storageRef, ref));
  return [...exact, ...others];
}

/** The type of a cache row. */
export function cacheTypeOf(asset: Pick<MediaAsset, "kind" | "mimeType">): "video" | "audio" | undefined {
  return isVideoCache(asset) ? "video" : isAudioCache(asset) ? "audio" : undefined;
}

/**
 * This Content's available caches a new cache of `type` (and, for a video, of quality tier
 * `height`) replaces: the same type and, for video, the same verified tier. A video of
 * unknown or still unverified quality never takes part.
 */
export function sameQualityCaches(assets: readonly MediaAsset[], type: "video" | "audio", height: number | undefined): MediaAsset[] {
  return assets.filter(
    (asset) =>
      asset.availability === "available" &&
      cacheTypeOf(asset) === type &&
      (type === "audio" || (height !== undefined && verifiedCacheHeight(asset) === height)),
  );
}

export interface CacheSwapDeps {
  repository: Repository;
  cache: CacheFileStore;
  locks: CachePathLocks;
  holds: CacheHoldRegistry;
  logger?: Logger;
}

/** A finished download waiting in its scratch directory to become a cache. */
export interface CachePublication {
  owner: string;
  contentId: string;
  /** The new asset's id, which is also the scratch directory's. */
  assetId: string;
  /** Absolute path of the finished file inside the scratch directory. */
  downloadPath: string;
  targetRef: string;
  type: "video" | "audio";
  /** The quality tier of a video, from the picture size of the finished file. */
  height?: number;
  mimeType: string;
  identity: FileIdentity;
  acquisition?: MediaAsset["acquisition"];
  /** The user's confirmation that another Content's cache holding this name may be replaced. */
  overwrite?: { assetId: string; fileName: string };
  createdAt: number;
}

export interface PublishedCache {
  asset: MediaAsset;
  /** Ids of the rows the new cache replaced, now `evicted`. */
  replaced: string[];
}

/**
 * Publishes a finished download as the cache at `targetRef`, following the protocol above.
 * What may stand at the target: nothing; this Content's own cache, which is replaced; another
 * Content's cache only with the user's confirmation naming it (`conflict.cache_name_taken`
 * otherwise); an evicted cache's leftover file. Any file must be the one its row describes
 * (size and SHA-256 equal to its fingerprint), else `conflict.cache_file_foreign`. The
 * Content's same-quality caches stored under other names are evicted with it and their
 * files removed afterwards, each under its own path's lock and only if it is still the file
 * its row describes.
 */
export async function publishCache(deps: CacheSwapDeps, publication: CachePublication): Promise<PublishedCache> {
  const { repository, cache, locks, holds } = deps;
  const scratchDir = cache.scratchPath(publication.assetId);
  // The record about to be written names this file as the new cache; it must be on the disk
  // before anything moves, or a crash could leave the target holding a file never flushed.
  await syncFile(publication.downloadPath);
  const result = await locks.withLock(publication.targetRef, async () => {
    if (holds.isHeld(publication.targetRef) || holds.get(publication.assetId) !== undefined) {
      recoveryPending();
    }
    const targetPath = cache.pathOf(publication.targetRef);
    const plan = repository.withTransaction((scope) => {
      const atTarget = cacheRowsAt(scope, publication.targetRef);
      const holder = atTarget.find((asset) => asset.availability === "available");
      const ownCaches = scope.mediaAssets.listByContent(publication.owner, publication.contentId);
      const sameQuality = sameQualityCaches(ownCaches, publication.type, publication.height);
      let holderTasksUnfinished = false;
      let holderTitle: string | undefined;
      if (holder !== undefined && (holder.contentId !== publication.contentId || holder.userId !== publication.owner)) {
        holderTasksUnfinished = scope.tasks.listByContent(holder.userId, holder.contentId).some((task) => !isTerminalProjection(task.statusProjection));
        const holderContent = scope.contents.getIncludingTrashed(holder.userId, holder.contentId);
        holderTitle = holderContent === undefined ? undefined : displayTitleOf(holderContent);
      }
      return { atTarget, holder, sameQuality, holderTasksUnfinished, holderTitle };
    });
    const holder = plan.holder;
    // A holder registered under a differently cased spelling of the name owns the file at
    // its own spelling: it is read and moved away under that ref, so a case-sensitive file
    // system displaces the file instead of leaving it beside the new one unregistered. On
    // Windows both spellings name one file.
    const currentRef = holder?.storageRef ?? publication.targetRef;
    const current = await cache.stat(currentRef);
    let displaced: { row?: MediaAsset; identity: FileIdentity } | undefined;
    const evict = new Set<MediaAsset>(plan.sameQuality.filter((asset) => !sameCacheFileName(asset.storageRef, publication.targetRef)));
    if (holder !== undefined && (holder.contentId !== publication.contentId || holder.userId !== publication.owner)) {
      const confirmed =
        publication.overwrite !== undefined &&
        holder.userId === publication.owner &&
        publication.overwrite.assetId === holder.id &&
        sameCacheFileName(publication.overwrite.fileName, cacheFileNameOf(publication.targetRef));
      if (!confirmed) {
        throw amberError("conflict", "another content's cache holds this file name", {
          code: "conflict.cache_name_taken",
          details: {
            fileName: cacheFileNameOf(publication.targetRef),
            holderContentId: holder.contentId,
            ...(plan.holderTitle === undefined ? {} : { holderTitle: plan.holderTitle }),
            ...(publication.height === undefined ? {} : { actualHeight: publication.height }),
          },
        });
      }
      if (plan.holderTasksUnfinished) {
        throw amberError("conflict", "the content whose cache would be replaced has unfinished tasks", { code: "conflict.tasks_unfinished" });
      }
    }
    if (current !== null) {
      if (holder !== undefined) {
        if (holder.fingerprint === undefined || holder.fingerprint === "") {
          foreignFile();
        }
        const identity = { sizeBytes: current.sizeBytes, digest: holder.fingerprint };
        if ((await matchesIdentity(cache.pathOf(currentRef), identity)) !== true) {
          foreignFile();
        }
        // Where the spellings are two files, the target spelling must not hide a stranger
        // that the new file's rename would overwrite.
        if (currentRef !== publication.targetRef && (await matchesIdentity(targetPath, identity)) === false) {
          foreignFile();
        }
        displaced = { row: holder, identity };
      } else {
        // No available row: only an evicted cache's own leftover may be replaced.
        const found = await identityOf(targetPath);
        const leftover = found === null ? undefined : plan.atTarget.find((asset) => asset.fingerprint !== undefined && asset.fingerprint === found.digest);
        if (found === null || leftover === undefined) {
          foreignFile();
        }
        displaced = { identity: found };
      }
    }
    // A holder whose file is gone no longer holds anything: it is evicted with the rest.
    if (holder !== undefined) {
      evict.add(holder);
    }

    const record: SwapRecord = {
      v: 1,
      targetRef: publication.targetRef,
      newAssetId: publication.assetId,
      newSizeBytes: publication.identity.sizeBytes,
      newDigest: publication.identity.digest,
      ...(displaced === undefined
        ? {}
        : { displaced: { ...(displaced.row === undefined ? {} : { assetId: displaced.row.id }), sizeBytes: displaced.identity.sizeBytes, digest: displaced.identity.digest } }),
    };
    await writeSwapRecord(scratchDir, record);
    const displacedPath = join(scratchDir, DISPLACED_FILE);
    if (displaced !== undefined) {
      try {
        await cache.moveOut(currentRef, displacedPath);
      } catch (error) {
        await removeSwapRecord(scratchDir);
        if (isBusy(error)) {
          fileBusy();
        }
        throw error;
      }
    }
    let moved = false;
    try {
      await cache.moveIn(publication.downloadPath, publication.targetRef);
      moved = true;
      const asset: MediaAsset = {
        id: publication.assetId,
        userId: publication.owner,
        contentId: publication.contentId,
        kind: "platform_cache",
        storageRef: publication.targetRef,
        displayName: cacheFileNameOf(publication.targetRef),
        mimeType: publication.mimeType,
        sizeBytes: publication.identity.sizeBytes,
        ...(publication.type === "video" ? { quality: publication.height === undefined ? "" : String(publication.height) } : {}),
        qualityVerified: true,
        fingerprint: publication.identity.digest,
        ...(publication.acquisition === undefined ? {} : { acquisition: publication.acquisition }),
        availability: "available",
        retentionPolicy: "evictable",
        createdAt: publication.createdAt,
      };
      const replaced = repository.withTransaction((scope) => {
        scope.mediaAssets.insert(asset);
        const ids: string[] = [];
        for (const row of evict) {
          const now = scope.mediaAssets.get(row.userId, row.id);
          if (now !== undefined && now.availability === "available") {
            scope.mediaAssets.update(row.userId, { ...now, availability: "evicted" });
            ids.push(row.id);
          }
        }
        return ids;
      });
      return { asset, replaced, oldPaths: [...evict].filter((row) => replaced.includes(row.id) && !sameCacheFileName(row.storageRef, publication.targetRef)) };
    } catch (error) {
      await rollBack(deps, { scratchDir, record, moved, downloadPath: publication.downloadPath, displacedPath });
      throw error;
    }
  });
  // The scratch directory, the displaced copy and the record go only after the commit.
  await discardScratch(cache, publication.assetId).catch((error: unknown) =>
    deps.logger?.warn("cache_scratch_remove_failed", { error: errorCode(error) ?? "error" }),
  );
  for (const old of result.oldPaths) {
    await removeIfStill(deps, old);
  }
  return { asset: result.asset, replaced: result.replaced };
}

/**
 * Undoes steps 3 and 4 after a failure: the new file back into the scratch directory, the
 * displaced one back to the target, then the record goes. A move that fails here keeps the
 * record, so the next start-up recovery decides from the files.
 */
async function rollBack(
  deps: CacheSwapDeps,
  state: { scratchDir: string; record: SwapRecord; moved: boolean; downloadPath: string; displacedPath: string },
): Promise<void> {
  const { cache, logger } = deps;
  try {
    if (state.moved) {
      await cache.moveOut(state.record.targetRef, state.downloadPath);
    }
    if (state.record.displaced !== undefined) {
      await cache.moveIn(state.displacedPath, state.record.targetRef);
    }
    await removeSwapRecord(state.scratchDir);
  } catch (error) {
    logger?.error("cache_swap_rollback_failed", { assetId: state.record.newAssetId, error: errorCode(error) ?? "error" });
    // Kept for the user: nothing publishes to this path until the replacement is settled.
    deps.holds.add(await describeHold(cache, state.record.newAssetId, state.record));
  }
}

/**
 * Removes the file of a replaced cache stored under another name, under that path's lock:
 * only while no available row holds the path and only when the file is still the one the
 * row describes. Anything else stays, logged; the start-up sweep looks at it again.
 */
export async function removeIfStill(deps: Pick<CacheSwapDeps, "repository" | "cache" | "locks" | "logger">, row: MediaAsset): Promise<boolean> {
  const { repository, cache, locks, logger } = deps;
  return locks.withLock(row.storageRef, async () => {
    try {
      const held = repository.withTransaction((scope) => cacheRowsAt(scope, row.storageRef).some((asset) => asset.availability === "available"));
      if (held || row.fingerprint === undefined || row.fingerprint === "") {
        return false;
      }
      const stored = await cache.stat(row.storageRef);
      if (stored === null) {
        return true;
      }
      if ((await matchesIdentity(cache.pathOf(row.storageRef), { sizeBytes: stored.sizeBytes, digest: row.fingerprint })) !== true) {
        logger?.warn("cache_replaced_file_changed", { assetId: row.id });
        return false;
      }
      await cache.remove(row.storageRef);
      return true;
    } catch (error) {
      // A file the user holds open stays behind; the start-up sweep removes files whose rows are all evicted.
      logger?.warn("cache_replaced_file_kept", { assetId: row.id, error: errorCode(error) ?? "error" });
      return false;
    }
  });
}

/** A hold as the registry keeps it: the record plus the sizes of the two files as found now. */
export async function describeHold(cache: CacheFileStore, scratchId: string, record: SwapRecord): Promise<CacheHold> {
  const current = await cache.stat(record.targetRef).catch(() => null);
  const displaced = await stat(join(cache.scratchPath(scratchId), DISPLACED_FILE)).catch(() => undefined);
  return {
    scratchId,
    record,
    ...(current === null ? {} : { currentSizeBytes: current.sizeBytes }),
    ...(displaced === undefined || !displaced.isFile() ? {} : { displacedSizeBytes: displaced.size }),
  };
}

/** What the start-up recovery did with one scratch directory. */
export type SwapRecoveryOutcome = "committed" | "rolled_back" | "discarded" | "held" | "unreadable";

/**
 * Settles one interrupted replacement from the files on disk and the database, under the
 * target path's lock:
 *
 * | new row in the database | target file          | action                                                     |
 * |-------------------------|----------------------|------------------------------------------------------------|
 * | yes, any availability   | anything             | committed: remove the scratch directory, never touch the target |
 * | no                      | the new file         | displaced copy verified → move it back; none → remove the unregistered new file |
 * | no                      | the new file, another available row describes it | hold                          |
 * | no                      | missing              | displaced copy verified → move it back; none recorded → remove the scratch directory |
 * | no                      | the displaced file, its copy gone | already moved back: remove the scratch directory |
 * | no                      | any other file       | hold                                                       |
 * | no                      | displaced copy differs from the record | hold                                 |
 * | —                       | recovery throws      | hold                                                       |
 *
 * The new row is inserted only by the commit, so its existence proves the commit happened
 * even when the row was evicted or deleted afterwards: by then the target may hold a newer
 * cache, possibly with the same bytes, which the record must never be read against.
 *
 * A hold keeps every file, logs an error and blocks publishing to the target path until the
 * user keeps the current file or restores the displaced copy.
 */
export async function recoverSwap(deps: CacheSwapDeps, scratchId: string): Promise<SwapRecoveryOutcome> {
  const { cache, locks, holds, logger } = deps;
  const dir = cache.scratchPath(scratchId);
  const record = await readSwapRecord(dir);
  if (record === undefined) {
    return "discarded";
  }
  if (record === "corrupt") {
    // Written atomically, so this is not a crash; the directory stays for a person to look at.
    logger?.error("cache_swap_record_unreadable", { scratchId });
    return "unreadable";
  }
  // Under the lock that `DELETE /media`, the pending-file worker and publishing take, so none
  // of them acts on the path between what is read here and what is done.
  return locks.withLock(record.targetRef, async () => {
    const hold = async (reason: string): Promise<SwapRecoveryOutcome> => {
      logger?.error("cache_swap_held", { assetId: record.newAssetId, reason });
      holds.add(await describeHold(cache, scratchId, record));
      return "held";
    };
    try {
      return await settleSwap(deps, scratchId, record, hold);
    } catch (error) {
      // Whatever the failure left half done stays as it is, for the user to settle.
      logger?.error("cache_swap_recovery_failed", { assetId: record.newAssetId, error: errorCode(error) ?? "error" });
      return hold("recovery_failed");
    }
  });
}

async function settleSwap(
  deps: CacheSwapDeps,
  scratchId: string,
  record: SwapRecord,
  hold: (reason: string) => Promise<SwapRecoveryOutcome>,
): Promise<SwapRecoveryOutcome> {
  const { repository, cache } = deps;
  const dir = cache.scratchPath(scratchId);
  const targetPath = cache.pathOf(record.targetRef);
  const displacedPath = join(dir, DISPLACED_FILE);
  const rows = repository.withTransaction((scope) => ({
    committed: scope.mediaAssets.listCachesByStorageRefUnscoped(record.targetRef).some((asset) => asset.id === record.newAssetId),
    // Another available row describing the new file's bytes: a later cache with the same
    // content took the path (the new row itself is gone), so the file is not this
    // replacement's to remove.
    claimedElsewhere: cacheRowsAt(scope, record.targetRef).some(
      (asset) =>
        asset.availability === "available" && asset.id !== record.newAssetId && asset.id !== record.displaced?.assetId && asset.fingerprint === record.newDigest,
    ),
  }));
  if (rows.committed) {
    await discardScratch(cache, scratchId);
    return "committed";
  }
  const target = await matchesIdentity(targetPath, { sizeBytes: record.newSizeBytes, digest: record.newDigest });
  const copy = record.displaced === undefined ? undefined : await matchesIdentity(displacedPath, record.displaced);
  if (copy === false) {
    return hold("displaced_changed");
  }
  if (target === true) {
    if (rows.claimedElsewhere) {
      return hold("target_registered_elsewhere");
    }
    if (record.displaced !== undefined && copy !== true) {
      return hold("displaced_missing");
    }
    await cache.remove(record.targetRef);
    if (copy === true) {
      await cache.moveIn(displacedPath, record.targetRef);
    }
    await discardScratch(cache, scratchId);
    return "rolled_back";
  }
  if (target === "missing") {
    if (record.displaced === undefined) {
      await discardScratch(cache, scratchId);
      return "discarded";
    }
    if (copy !== true) {
      return hold("displaced_missing");
    }
    await cache.moveIn(displacedPath, record.targetRef);
    await discardScratch(cache, scratchId);
    return "rolled_back";
  }
  // Some other file is at the target: the displaced one already moved back, or a stranger.
  if (record.displaced !== undefined && copy === "missing" && (await matchesIdentity(targetPath, record.displaced)) === true) {
    await discardScratch(cache, scratchId);
    return "rolled_back";
  }
  return hold("target_foreign");
}

/**
 * Settles a held replacement as the user decided, re-checking the files first:
 *
 * - `keep`: the file now at the target stays. It must still be the file found when the
 *   hold was taken; with no file at the target there is nothing to keep. Rows follow the file: the new row stays available
 *   only if the target is the new file, the displaced row becomes available again if the
 *   target is its file and nothing else holds the path.
 * - `restore`: the displaced copy goes back to the target. The copy must match the record;
 *   a file at the target must be the new file, which is discarded. The new row, if any, is
 *   evicted and the displaced row made available again.
 *
 * A file that is not what the record says → `conflict.cache_file_foreign`, nothing changes.
 * The scratch directory is removed and the hold dropped once done.
 */
export async function resolveHold(deps: CacheSwapDeps, scratchId: string, action: "keep" | "restore"): Promise<void> {
  const { repository, cache, locks, holds } = deps;
  const hold = holds.get(scratchId);
  if (hold === undefined) {
    throw amberError("not_found", "no replacement waits under this id");
  }
  const { record } = hold;
  await locks.withLock(record.targetRef, async () => {
    const dir = cache.scratchPath(scratchId);
    const targetPath = cache.pathOf(record.targetRef);
    const displacedPath = join(dir, DISPLACED_FILE);
    const isNew = (await matchesIdentity(targetPath, { sizeBytes: record.newSizeBytes, digest: record.newDigest })) === true;
    const isOld = record.displaced !== undefined && (await matchesIdentity(targetPath, record.displaced)) === true;
    if (action === "keep") {
      const current = await cache.stat(record.targetRef);
      // With no file at the path there is nothing to keep: settling would only discard the
      // displaced copy, possibly the last copy of the cache. The user restores it instead;
      // the refusal says the file at the path is not the one this choice needs.
      if (current === null || hold.currentSizeBytes === undefined || current.sizeBytes !== hold.currentSizeBytes) {
        foreignFile();
      }
      repository.withTransaction((scope) => {
        settleRows(scope, record, isNew ? "new" : isOld ? "old" : "other");
      });
    } else {
      if (record.displaced === undefined || (await matchesIdentity(displacedPath, record.displaced)) !== true) {
        foreignFile();
      }
      if ((await cache.stat(record.targetRef)) !== null) {
        if (!isNew) {
          foreignFile();
        }
        await cache.remove(record.targetRef);
      }
      await cache.moveIn(displacedPath, record.targetRef);
      repository.withTransaction((scope) => {
        settleRows(scope, record, "old");
      });
    }
    await discardScratch(cache, scratchId);
    holds.remove(scratchId);
  });
}

/**
 * Makes the rows of a settled replacement describe the file left at the target: the row of
 * that file is available (unless another row already holds the path), the other one is not.
 */
function settleRows(scope: RepositoryScope, record: SwapRecord, target: "new" | "old" | "other"): void {
  const rows = cacheRowsAt(scope, record.targetRef);
  const fresh = rows.find((asset) => asset.id === record.newAssetId);
  const old = record.displaced?.assetId === undefined ? undefined : rows.find((asset) => asset.id === record.displaced?.assetId);
  const keep = target === "new" ? fresh : target === "old" ? old : undefined;
  for (const row of [fresh, old]) {
    if (row !== undefined && row !== keep && row.availability === "available") {
      scope.mediaAssets.update(row.userId, { ...row, availability: "evicted" });
    }
  }
  const othersHold = rows.some((asset) => asset.availability === "available" && asset.id !== fresh?.id && asset.id !== old?.id);
  if (keep !== undefined && keep.availability !== "available" && !othersHold) {
    scope.mediaAssets.update(keep.userId, { ...keep, availability: "available" });
  }
}
