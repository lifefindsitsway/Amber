import type { ContentDto } from "../../shared/dto/content.ts";

/** What a player can do; the UI hides what it cannot. */
export interface PlayerCapabilities {
  seekMode: "direct" | "reload" | "unsupported";
  timeTracking: "supported" | "unsupported";
  /**
   * Whether the position remembered from an earlier visit is written and applied here: true
   * only for a player that can be placed at it and whose playback the user controls (the local one).
   */
  remembersPosition: boolean;
}

export type PlayerSource =
  | { kind: "youtube"; videoId: string; originalUrl?: string }
  | { kind: "bilibili"; bvid: string; page?: number; cid?: string; originalUrl?: string }
  | { kind: "local" }
  | { kind: "none" };

export const CAPABILITIES: Readonly<Record<PlayerSource["kind"], PlayerCapabilities>> = {
  youtube: { seekMode: "direct", timeTracking: "supported", remembersPosition: false },
  // The embedded Bilibili player has URL parameters only: no postMessage or JS API.
  bilibili: { seekMode: "reload", timeTracking: "unsupported", remembersPosition: false },
  local: { seekMode: "direct", timeTracking: "supported", remembersPosition: true },
  none: { seekMode: "unsupported", timeTracking: "unsupported", remembersPosition: false },
};

/** Which player a Content plays in, from its source identifiers. */
export function playerSourceOf(content: Pick<ContentDto, "source">): PlayerSource {
  const { source } = content;
  const originalUrl = source.sourceUrl === undefined ? {} : { originalUrl: source.sourceUrl };
  if (source.kind === "youtube" && source.platformContentId !== undefined) {
    return { kind: "youtube", videoId: source.platformContentId, ...originalUrl };
  }
  if (source.kind === "bilibili" && source.platformContentId !== undefined) {
    const page = pageOf(source.sourceUrl);
    return {
      kind: "bilibili",
      bvid: source.platformContentId,
      ...(page === undefined ? {} : { page }),
      ...(source.platformPartId === undefined ? {} : { cid: source.platformPartId }),
      ...originalUrl,
    };
  }
  if (source.kind === "local") {
    return { kind: "local" };
  }
  return { kind: "none" };
}

function pageOf(url: string | undefined): number | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    const value = new URL(url).searchParams.get("p");
    const page = value === null ? Number.NaN : Number(value);
    return Number.isInteger(page) && page > 0 ? page : undefined;
  } catch {
    return undefined;
  }
}

/** The official embed URL; seeking reloads it with a new `t=` (seconds) and autoplay. */
export function bilibiliEmbedUrl(source: Extract<PlayerSource, { kind: "bilibili" }>, startMs: number | undefined): string {
  const params = new URLSearchParams({ bvid: source.bvid });
  if (source.cid !== undefined) params.set("cid", source.cid);
  if (source.page !== undefined) params.set("p", String(source.page));
  if (startMs !== undefined) {
    params.set("t", String(Math.floor(startMs / 1000)));
    params.set("autoplay", "1");
  } else {
    params.set("autoplay", "0");
  }
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}

/** IFrame API embed: `enablejsapi=1` plus our origin, without which YouTube refuses to play (Error 153). */
export function youtubeEmbedUrl(videoId: string, origin: string): string {
  const params = new URLSearchParams({ enablejsapi: "1", origin, rel: "0", playsinline: "1" });
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}
