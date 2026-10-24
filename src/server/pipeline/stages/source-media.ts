import { isAudioCache, isVideoCache, verifiedCacheHeight, type MediaAsset } from "../../domain/media-asset.ts";
import type { FileStore } from "../../ports/file-store.ts";
import type { Repository, RepositoryScope } from "../../ports/repository.ts";

/** Kinds that hold the user's original media, as opposed to caches and intermediates. */
const ORIGINAL_KINDS: ReadonlySet<MediaAsset["kind"]> = new Set(["external_local", "managed_upload"]);

export function isOriginalMedia(asset: MediaAsset): boolean {
  return ORIGINAL_KINDS.has(asset.kind);
}

/** The Content's original media file still registered as available, newest first. */
export function availableOriginal(scope: RepositoryScope, ownerUserId: string, contentId: string): MediaAsset | undefined {
  return scope.mediaAssets
    .listByContent(ownerUserId, contentId)
    .filter((asset) => isOriginalMedia(asset) && asset.availability === "available")
    .at(-1);
}

/** The Content's latest available audio cache. */
function latestAudioCache(scope: RepositoryScope, ownerUserId: string, contentId: string): MediaAsset | undefined {
  return scope.mediaAssets
    .listByContent(ownerUserId, contentId)
    .filter((asset) => isAudioCache(asset) && asset.availability === "available")
    .at(-1);
}

/**
 * The Content's available video caches, best first: the highest verified height first,
 * caches of unknown or not yet verified quality last; among equal heights the newest first.
 */
export function videoCachesBestFirst(scope: RepositoryScope, ownerUserId: string, contentId: string): MediaAsset[] {
  const rank = (asset: MediaAsset) => verifiedCacheHeight(asset) ?? -1;
  return scope.mediaAssets
    .listByContent(ownerUserId, contentId)
    .filter((asset) => isVideoCache(asset) && asset.availability === "available")
    .sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The Content's best available video cache (see `videoCachesBestFirst`). */
export function bestVideoCache(scope: RepositoryScope, ownerUserId: string, contentId: string): MediaAsset | undefined {
  return videoCachesBestFirst(scope, ownerUserId, contentId)[0];
}

/**
 * A video to work on without going online (burn-in): the original file,
 * else the best available video cache. An audio cache never qualifies.
 */
export function availableVideoSource(scope: RepositoryScope, ownerUserId: string, contentId: string): MediaAsset | undefined {
  return availableOriginal(scope, ownerUserId, contentId) ?? bestVideoCache(scope, ownerUserId, contentId);
}

/**
 * What audio can be extracted from without going online: the original file,
 * else the best cached platform video, else a cached MP3. Either cache type carries the
 * audio; the video is preferred because it is the fuller copy of the source.
 */
export function availableMediaSource(scope: RepositoryScope, ownerUserId: string, contentId: string): MediaAsset | undefined {
  return availableVideoSource(scope, ownerUserId, contentId) ?? latestAudioCache(scope, ownerUserId, contentId);
}

/** What `assetPath` needs from `MediaFiles`: the store of a kind, for its path only. */
export interface AssetPathResolver {
  storeFor(kind: MediaAsset["kind"]): Pick<FileStore, "pathOf">;
}

/** Where a tool reads the asset: the user's own path for `external_local`, the store of its kind otherwise. */
export function assetPath(asset: MediaAsset, media: AssetPathResolver): string {
  return asset.kind === "external_local" ? asset.storageRef : media.storeFor(asset.kind).pathOf(asset.storageRef);
}

/**
 * The resolver of a stage given only its data store: every kind lives there. Right for the
 * media stage, which only ever sees originals, and for compositions without a custom cache
 * root.
 */
export function singleStore(files: Pick<FileStore, "pathOf">): AssetPathResolver {
  return { storeFor: () => files };
}

/** FileStore ref of a media file Amber manages. */
export function assetRef(asset: Pick<MediaAsset, "userId" | "contentId" | "id">): string {
  return `assets/${asset.userId}/${asset.contentId}/${asset.id}`;
}

/** Per-Task scratch files and paid-call checkpoints. */
export function taskScratchRef(taskId: string): string {
  return `tmp/tasks/${taskId}`;
}

/** A vanished original is marked `missing` so the UI can offer relinking. */
export function markMissing(repository: Repository, asset: MediaAsset): void {
  repository.withTransaction((scope) => {
    const current = scope.mediaAssets.get(asset.userId, asset.id);
    if (current !== undefined && current.availability === "available") {
      scope.mediaAssets.update(asset.userId, { ...current, availability: "missing" });
    }
  });
}
