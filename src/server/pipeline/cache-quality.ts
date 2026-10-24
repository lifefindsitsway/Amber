import type { MediaStreamInfo } from "../domain/export/container-policy.ts";
import { cacheQualityTier } from "../../shared/cache-file-name.ts";
import { needsQualityProbe, type MediaAsset } from "../domain/media-asset.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { MediaInspection, SubtitleMuxer } from "../ports/subtitle-muxer.ts";
import type { CacheFileStore } from "./media-files.ts";

/** The picture of a file: its first video stream that is not a cover image. */
export function pictureStream(inspection: MediaInspection): MediaStreamInfo | undefined {
  return inspection.streams.find((stream) => stream.type === "video" && stream.attachedPic !== true);
}

/** The container of a finished video download as a cache stores it; `undefined` for anything WebView2 cannot play. */
export function videoContainerOf(inspection: MediaInspection): { ext: "mp4" | "webm"; mimeType: string } | undefined {
  const names = inspection.container.toLowerCase().split(",");
  if (names.includes("mp4") || names.includes("mov")) {
    return { ext: "mp4", mimeType: "video/mp4" };
  }
  // ffprobe names Matroska and WebM alike; the download only ever merges into WebM.
  if (names.includes("webm") || names.includes("matroska")) {
    return { ext: "webm", mimeType: "video/webm" };
  }
  return undefined;
}

export interface CacheQualityDeps {
  repository: Repository;
  cache: Pick<CacheFileStore, "pathOf">;
  muxer: Pick<SubtitleMuxer, "inspect">;
  logger?: Logger;
}

/**
 * Reads the picture of video caches whose quality an earlier build recorded without looking
 * at the file, or recorded as an encoded height rather than a tier, and stores its quality
 * tier as verified. A file that cannot be read, or has no height, is recorded as an unknown
 * quality (`""`), which never counts as the same quality as anything. Rows changed meanwhile
 * are left as they are.
 */
export async function verifyCacheQualities(deps: CacheQualityDeps, assets: readonly MediaAsset[], signal: AbortSignal): Promise<number> {
  let verified = 0;
  for (const asset of assets) {
    if (!needsQualityProbe(asset)) {
      continue;
    }
    if (signal.aborted) {
      break;
    }
    let quality = "";
    try {
      const picture = pictureStream(await deps.muxer.inspect(deps.cache.pathOf(asset.storageRef), signal));
      quality = picture?.height === undefined ? "" : String(cacheQualityTier(picture.height, picture.width));
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      deps.logger?.warn("cache_quality_probe_failed", { assetId: asset.id, error: (error as NodeJS.ErrnoException | undefined)?.code ?? "error" });
    }
    deps.repository.withTransaction((scope) => {
      const current = scope.mediaAssets.get(asset.userId, asset.id);
      if (current !== undefined && needsQualityProbe(current) && current.storageRef === asset.storageRef) {
        scope.mediaAssets.update(asset.userId, { ...current, quality, qualityVerified: true });
      }
    });
    verified += 1;
  }
  return verified;
}
