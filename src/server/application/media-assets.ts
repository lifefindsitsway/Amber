import { isCacheRef } from "../../shared/cache-file-name.ts";
import type { BurnOutputDto } from "../../shared/dto/media.ts";
import type { SaveGrantDto } from "../../shared/dto/local-media.ts";
import { amberError } from "../domain/errors.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { FileGrantIssuer } from "../ports/file-grant.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { CacheGate } from "../pipeline/cache-gate.ts";
import { CachePathLocks } from "../pipeline/cache-path-locks.ts";
import { cacheRowsAt, matchesIdentity } from "../pipeline/cache-swap.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import type { MediaFiles } from "../pipeline/media-files.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { displayTitleOf } from "../domain/content.ts";

export interface MediaAssetServiceOptions {
  repository: Repository;
  /** The asset kind decides the store a file is read from or removed in. */
  media: Pick<MediaFiles, "storeFor">;
  /** Removing a cache file holds a shared lease so a cache move never races it. */
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  /** Local mode only: signs `burn_output` / `cache_save` grants for the shell. */
  grants?: FileGrantIssuer;
  /**
   * Serializes removing a cache file with publishing and removing others at the same path.
   * Defaults to a private set of locks, enough where nothing else touches the cache.
   */
  locks?: Pick<CachePathLocks, "withLock">;
}

/** Kinds a browser may stream in server mode. */
const PLAYABLE: ReadonlySet<MediaAsset["kind"]> = new Set(["managed_upload", "platform_cache"]);

/**
 * One of the owner's assets whose Content is outside the trash; an asset of a trashed
 * Content is as unknown as the Content.
 */
export function visibleAsset(scope: RepositoryScope, owner: string, assetId: string): MediaAsset | undefined {
  const asset = scope.mediaAssets.get(owner, assetId);
  return asset === undefined || scope.contents.get(owner, asset.contentId) === undefined ? undefined : asset;
}

export interface PlayableMedia {
  mimeType: string;
  sizeBytes: number;
  read(range?: { start: number; end: number }): AsyncIterable<Uint8Array>;
}

/** Media playback, manual removal and the burn products waiting to be saved. */
export class MediaAssetService {
  private readonly options: MediaAssetServiceOptions;

  private readonly locks: Pick<CachePathLocks, "withLock">;

  constructor(options: MediaAssetServiceOptions) {
    this.options = options;
    this.locks = options.locks ?? new CachePathLocks();
  }

  /** Only available uploads and caches are served; anything else, or a file gone from disk, is `not_found`. */
  async playable(principal: RequestPrincipal, assetId: string): Promise<PlayableMedia> {
    const asset = this.options.repository.withTransaction((scope) => visibleAsset(scope, principal.userId, assetId));
    if (asset === undefined || !PLAYABLE.has(asset.kind) || asset.availability !== "available") {
      throw amberError("not_found", "media asset is not playable");
    }
    const files = this.options.media.storeFor(asset.kind);
    const stored = await files.stat(asset.storageRef);
    if (stored === null) {
      throw amberError("not_found", "media file is gone");
    }
    return {
      mimeType: asset.mimeType,
      sizeBytes: stored.sizeBytes,
      read: (range) => files.read(asset.storageRef, range),
    };
  }

  /**
   * Per kind: a `platform_cache` file is evicted and its row kept
   * as `evicted`; a `managed_upload` loses file and row; the user's own `external_local`
   * file and Task intermediates are refused, except a `burn` Task's product, which the
   * client removes after saving it. Refused while the Content has an unfinished Task, and
   * for a cache while the cache is being moved (`conflict.cache_migrating`). The database
   * changes first; the file goes after the commit.
   *
   * A cache already `evicted` is done: its file, if any, is not touched, since its name may
   * belong to a newer cache by now. An available cache's file is removed under its path's
   * lock and only when no other available row holds the path and the file is the one the
   * row describes (size and SHA-256 equal to its fingerprint); otherwise, or when the row
   * has no fingerprint, `conflict.cache_file_foreign` and nothing changes.
   */
  async delete(principal: RequestPrincipal, assetId: string): Promise<void> {
    const owner = principal.userId;
    const found = this.options.repository.withTransaction((scope) => visibleAsset(scope, owner, assetId));
    if (found === undefined) {
      throw amberError("not_found", "media asset not found");
    }
    if (found.kind === "platform_cache" && found.availability === "evicted") {
      return;
    }
    const release = found.kind === "platform_cache" ? this.options.gate.tryShared() : () => undefined;
    if (release === undefined) {
      throw gateConflict(this.options.gate);
    }
    try {
      if (found.kind === "platform_cache") {
        await this.locks.withLock(found.storageRef, () => this.deleteCache(owner, assetId));
        return;
      }
      const removed = this.options.repository.withTransaction((scope) => {
        const asset = visibleAsset(scope, owner, assetId);
        if (asset === undefined) {
          throw amberError("not_found", "media asset not found");
        }
        if (scope.tasks.listByContent(owner, asset.contentId).some((task) => !isTerminalProjection(task.statusProjection))) {
          throw amberError("conflict", "the content has unfinished tasks", { code: "conflict.tasks_unfinished" });
        }
        switch (asset.kind) {
          case "platform_cache":
            // Removed above, under its path's lock; a kind never changes.
            throw new TypeError("a cache is removed through its path lock");
          case "managed_upload":
            scope.mediaAssets.delete(owner, asset.id);
            return asset;
          case "temporary": {
            const task = asset.taskId === undefined ? undefined : scope.tasks.get(owner, asset.taskId);
            if (task?.kind !== "burn") {
              throw amberError("conflict", "task intermediates are removed with their task");
            }
            scope.mediaAssets.delete(owner, asset.id);
            return asset;
          }
          case "extracted_audio":
            throw amberError("conflict", "task intermediates are removed with their task");
          case "external_local":
            throw amberError("conflict", "the user's own files are never deleted by Amber");
        }
      });
      await this.options.media.storeFor(removed.kind).remove(removed.storageRef);
    } finally {
      release();
    }
  }

  /** The cache half of `delete`, under the path's lock. */
  private async deleteCache(owner: string, assetId: string): Promise<void> {
    const { repository, media } = this.options;
    const files = media.storeFor("platform_cache");
    const check = () =>
      repository.withTransaction((scope) => {
        const asset = visibleAsset(scope, owner, assetId);
        if (asset === undefined) {
          throw amberError("not_found", "media asset not found");
        }
        if (scope.tasks.listByContent(owner, asset.contentId).some((task) => !isTerminalProjection(task.statusProjection))) {
          throw amberError("conflict", "the content has unfinished tasks", { code: "conflict.tasks_unfinished" });
        }
        const sharedPath = cacheRowsAt(scope, asset.storageRef).some((other) => other.id !== asset.id && other.availability === "available");
        return { asset, sharedPath };
      });
    const { asset, sharedPath } = check();
    if (asset.availability === "evicted") {
      return;
    }
    // Another available row at the path means the file is not this row's to remove; a ref
    // of the obsolete nested layout is not in the flat cache directory at all.
    let removeFile = !sharedPath && isCacheRef(asset.storageRef);
    if (removeFile) {
      const stored = await files.stat(asset.storageRef);
      if (stored !== null) {
        if (asset.fingerprint === undefined || asset.fingerprint === "") {
          throw amberError("conflict", "the cache has no fingerprint to verify its file by", { code: "conflict.cache_file_foreign" });
        }
        if ((await matchesIdentity(files.pathOf(asset.storageRef), { sizeBytes: stored.sizeBytes, digest: asset.fingerprint })) !== true) {
          throw amberError("conflict", "the file at the cache path is not the registered cache", { code: "conflict.cache_file_foreign" });
        }
      } else {
        removeFile = false;
      }
    }
    repository.withTransaction((scope) => {
      const current = visibleAsset(scope, owner, assetId);
      if (current === undefined) {
        throw amberError("not_found", "media asset not found");
      }
      if (scope.tasks.listByContent(owner, current.contentId).some((task) => !isTerminalProjection(task.statusProjection))) {
        throw amberError("conflict", "the content has unfinished tasks", { code: "conflict.tasks_unfinished" });
      }
      if (current.availability === "available") {
        scope.mediaAssets.update(owner, { ...current, availability: "evicted" });
      }
    });
    if (removeFile) {
      await files.remove(asset.storageRef);
    }
  }

  /** `GET /api/media/burn-outputs` [client]: burn products not yet saved out, oldest first, none of a trashed Content. */
  listBurnOutputs(principal: RequestPrincipal): BurnOutputDto[] {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) =>
      scope.mediaAssets.listBurnOutputs(owner).flatMap((asset) => {
        const content = scope.contents.get(owner, asset.contentId);
        if (content === undefined) {
          return [];
        }
        const title = displayTitleOf(content);
        return {
          assetId: asset.id,
          contentId: asset.contentId,
          taskId: asset.taskId as string,
          ...(title === undefined ? {} : { title }),
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          createdAt: asset.createdAt,
        };
      }),
    );
  }

  /**
   * `POST /api/media/:assetId/save-grant` [client]: binds the absolute path of one of the
   * user's files to a short-lived grant whose purpose says what it is:
   * an available burn product → `burn_output`, an available `platform_cache` →
   * `cache_save`. The WebView never names a source path; the shell copies only what such
   * a grant covers and checks that the purpose matches the command. Anything else is
   * `conflict`.
   */
  saveGrant(principal: RequestPrincipal, assetId: string): SaveGrantDto {
    const grants = this.options.grants;
    if (grants === undefined) {
      throw new TypeError("save grants exist only in local mode");
    }
    const owner = principal.userId;
    const { asset, purpose } = this.options.repository.withTransaction((scope) => {
      const found = visibleAsset(scope, owner, assetId);
      if (found === undefined) {
        throw amberError("not_found", "media asset not found");
      }
      if (found.availability === "available" && found.kind === "platform_cache") {
        return { asset: found, purpose: "cache_save" as const };
      }
      const task = found.taskId === undefined ? undefined : scope.tasks.get(owner, found.taskId);
      if (found.availability === "available" && found.kind === "temporary" && task?.kind === "burn") {
        return { asset: found, purpose: "burn_output" as const };
      }
      throw amberError("conflict", "only an available burn product or media cache can be saved");
    });
    return { grant: grants.issue({ path: this.options.media.storeFor(asset.kind).pathOf(asset.storageRef), purpose }) };
  }
}
