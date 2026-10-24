import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { cacheQualityTier } from "../../shared/cache-file-name.ts";
import type { ContentDetailDto, MediaAssetDto } from "../../shared/dto/content.ts";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { localFileUrl } from "../desktop/bridge.ts";
import { useDesktop } from "../desktop/use-desktop.ts";

/** Kinds `GET /api/media/:assetId` serves (server mode). */
const SERVED_KINDS = new Set(["managed_upload", "platform_cache"]);

type Media = Pick<ContentDetailDto, "media">;

/** An available asset with the path the backend reported for the desktop client. */
export type LocalAsset = MediaAssetDto & { localPath: string };

function isLocal(item: MediaAssetDto): item is LocalAsset {
  return item.availability === "available" && item.localPath !== undefined;
}

/** Whether an asset carries sound only; caches are told apart by their MIME prefix. */
export function isAudioOnly(asset: Pick<MediaAssetDto, "mimeType">): boolean {
  return asset.mimeType.startsWith("audio/");
}

function isVideoCache(item: MediaAssetDto): boolean {
  return item.kind === "platform_cache" && item.mimeType.startsWith("video/");
}

/**
 * The quality tier of a video cache as read from its file, or undefined for an unknown quality
 * (`""`, a row whose quality was never recorded, or one whose recorded quality has not been
 * checked against the file yet: an unchecked value may be wrong, so it is not shown as fact).
 */
export function cacheHeight(asset: Pick<MediaAssetDto, "quality" | "qualityVerified">): number | undefined {
  if (asset.qualityVerified === false) return undefined;
  const quality = asset.quality ?? "";
  if (!/^\d+$/u.test(quality)) return undefined;
  const height = Number(quality);
  // A height an earlier build recorded shows as its tier until the client rewrites it.
  return height > 0 ? cacheQualityTier(height) : undefined;
}

/** A quality as the player and the cache lists name it: `1080P`, or 「未知画质」. */
export function qualityLabel(height: number | undefined, t: TFunction): string {
  return height === undefined ? t("contentView.player.quality.unknown") : t("contentView.player.quality.height", { height });
}

/** Highest quality first, unknown quality last; within one quality the newest first. */
export function compareCacheQuality(a: MediaAssetDto, b: MediaAssetDto): number {
  const ha = cacheHeight(a) ?? 0;
  const hb = cacheHeight(b) ?? 0;
  return ha !== hb ? hb - ha : b.createdAt - a.createdAt;
}

/** The video caches the desktop client can read, best quality first (see `compareCacheQuality`). */
export function playableVideoCaches(content: Media): LocalAsset[] {
  return content.media.filter((item): item is LocalAsset => isVideoCache(item) && isLocal(item)).sort(compareCacheQuality);
}

/** The newest audio cache the desktop client can read; a Content holds at most one. */
function playableAudioCache(content: Media): LocalAsset | undefined {
  return content.media
    .filter((item): item is LocalAsset => item.kind === "platform_cache" && isAudioOnly(item) && isLocal(item))
    .reduce<LocalAsset | undefined>((newest, item) => (newest === undefined || item.createdAt > newest.createdAt ? item : newest), undefined);
}

/** The platform caches the desktop client can read: the best video cache before the audio cache. */
export function playableCaches(content: Media): LocalAsset[] {
  return [playableVideoCaches(content)[0], playableAudioCache(content)].filter((item): item is LocalAsset => item !== undefined);
}

/** Every platform cache the desktop client can read: the video caches by quality, then the audio cache. */
export function allPlayableCaches(content: Media): LocalAsset[] {
  return [...playableVideoCaches(content), playableAudioCache(content)].filter((item): item is LocalAsset => item !== undefined);
}

/**
 * The cache the local player switches to: the best video cache when there is one, else the
 * audio cache, which plays without a picture (`audioOnly`).
 */
export function playableCache(content: Media): { asset: LocalAsset; audioOnly: boolean } | undefined {
  const asset = playableCaches(content)[0];
  return asset === undefined ? undefined : { asset, audioOnly: isAudioOnly(asset) };
}

/**
 * The file the desktop client plays: a local original first, then the video cache
 * `assetId` names when it is still playable, then the best platform cache.
 */
export function localPlayable(content: Media, assetId?: string): LocalAsset | undefined {
  const original = content.media.find((item): item is LocalAsset => item.kind === "external_local" && isLocal(item));
  if (original !== undefined) return original;
  const chosen = assetId === undefined ? undefined : playableVideoCaches(content).find((item) => item.id === assetId);
  return chosen ?? playableCache(content)?.asset;
}

/**
 * The asset `mediaUrlOf` streams, or undefined where there is no player source. `assetId`
 * picks one video cache over the best one; an original file still comes first.
 */
export function playbackAsset(content: Media, mode: ApiClient["mode"], desktop: boolean, assetId?: string): MediaAssetDto | undefined {
  if (mode === "server") {
    const served = content.media.filter((item) => SERVED_KINDS.has(item.kind) && item.availability === "available");
    const videos = served.filter(isVideoCache).sort(compareCacheQuality);
    return (
      served.find((item) => item.kind === "managed_upload") ??
      (assetId === undefined ? undefined : videos.find((item) => item.id === assetId)) ??
      videos[0] ??
      served[0]
    );
  }
  return desktop ? localPlayable(content, assetId) : undefined;
}

async function urlOfAsset(asset: MediaAssetDto, client: Pick<ApiClient, "mode" | "url">): Promise<string | undefined> {
  if (client.mode === "server") return client.url(`/api/media/${encodeURIComponent(asset.id)}`);
  return asset.localPath === undefined ? undefined : localFileUrl(asset.localPath);
}

/**
 * URL the `<video>` player streams from, when there is one. The server mode serves uploads
 * and platform caches over `/api/media`; the desktop client reads the original local file
 * or a platform cache (video before audio) through its asset protocol. A local backend
 * outside the desktop client has no player source.
 */
export async function mediaUrlOf(content: Media, client: Pick<ApiClient, "mode" | "url">, desktop: boolean, assetId?: string): Promise<string | undefined> {
  const asset = playbackAsset(content, client.mode, desktop, assetId);
  return asset === undefined ? undefined : urlOfAsset(asset, client);
}

/** What the player plays, resolved as one unit so a URL never goes with another asset's id. */
interface ResolvedMedia {
  contentId: string;
  url: string | undefined;
  assetId: string | undefined;
  audioOnly: boolean;
}

/**
 * `mediaUrlOf` for a component. `src` and `assetId` change together once the new URL is
 * resolved, so the player can key its element by the asset; both are undefined until the
 * first resolution and whenever there is no source. A different Content drops the previous
 * Content's media at once rather than when its own URL arrives. `audioOnly` says the file has
 * no picture, so the player shows a placeholder.
 */
export function usePlaybackMedia(
  content: Pick<ContentDetailDto, "id" | "media">,
  assetId?: string,
): { src: string | undefined; assetId: string | undefined; audioOnly: boolean } {
  const client = useApi();
  const desktop = useDesktop();
  const [resolved, setResolved] = useState<ResolvedMedia | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const asset = playbackAsset(content, client.mode, desktop, assetId);
    const settle = (url: string | undefined): void => {
      if (!live) return;
      const next: ResolvedMedia = {
        contentId: content.id,
        url,
        assetId: url === undefined ? undefined : asset?.id,
        audioOnly: url !== undefined && asset !== undefined && isAudioOnly(asset),
      };
      setResolved((current) =>
        current !== undefined && current.contentId === next.contentId && current.url === next.url && current.assetId === next.assetId && current.audioOnly === next.audioOnly
          ? current
          : next,
      );
    };
    if (asset === undefined) settle(undefined);
    else urlOfAsset(asset, client).then(settle, () => settle(undefined));
    return () => {
      live = false;
    };
  }, [content, client, desktop, assetId]);
  const current = resolved?.contentId === content.id ? resolved : undefined;
  return { src: current?.url, assetId: current?.assetId, audioOnly: current?.audioOnly ?? false };
}
