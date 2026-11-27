import type { ContentDto } from "../../shared/dto/content.ts";
import type { ContentSourceKind, Platform } from "../../shared/enums.ts";
import { platformCapabilities } from "../../shared/platforms.ts";

/** What a player can do; the UI hides what it cannot. */
export interface PlayerCapabilities {
  seekMode: "direct" | "reload" | "unsupported";
  timeTracking: "supported" | "unsupported";
  /**
   * Whether the position remembered from an earlier visit is written and applied here: true
   * only for a player that can be placed at it and whose playback the user controls (the local one).
   */
  remembersPosition: boolean;
  /**
   * What 「播放一段」 does here: `play` jumps, plays and pauses at the end (a player that can be
   * started, paused and read by script); `jump` only moves to the start, because the player
   * can neither be paused nor tell its time (entry points then read 「跳到」 instead of 「播放」);
   * `unsupported` when there is nothing to move.
   */
  rangePlayback: "play" | "jump" | "unsupported";
}

export type PlayerSource =
  | { kind: "youtube"; videoId: string; originalUrl?: string }
  | { kind: "bilibili"; bvid: string; page?: number; cid?: string; originalUrl?: string }
  | { kind: "local" }
  /** A platform Content whose platform has no embeddable player: it plays only from a cached copy. */
  | { kind: "no_online_player"; platform: Platform; originalUrl?: string }
  | { kind: "none" };

/** The sources that play in a platform's embedded player (an iframe). */
export type EmbeddedSource = Extract<PlayerSource, { kind: "youtube" | "bilibili" }>;

export const CAPABILITIES: Readonly<Record<PlayerSource["kind"], PlayerCapabilities>> = {
  // The IFrame API plays, pauses and reports the time.
  youtube: { seekMode: "direct", timeTracking: "supported", remembersPosition: false, rangePlayback: "play" },
  // The embedded Bilibili player has URL parameters only: no postMessage or JS API.
  bilibili: { seekMode: "reload", timeTracking: "unsupported", remembersPosition: false, rangePlayback: "jump" },
  local: { seekMode: "direct", timeTracking: "supported", remembersPosition: true, rangePlayback: "play" },
  // Nothing plays until a cached copy does, and that one is the local player.
  no_online_player: { seekMode: "unsupported", timeTracking: "unsupported", remembersPosition: false, rangePlayback: "unsupported" },
  none: { seekMode: "unsupported", timeTracking: "unsupported", remembersPosition: false, rangePlayback: "unsupported" },
};

/**
 * Whether Contents from this source can be watched in the platform's own embedded player.
 * Decided by the platform capability table alone, so a new platform needs no change here.
 */
export function hasOnlinePlayer(kind: ContentSourceKind): boolean {
  return kind !== "local" && platformCapabilities(kind).onlinePlayer;
}

/** Whether this source is shown in a platform iframe (as opposed to the local player or nothing). */
export function isEmbedded(source: PlayerSource): source is EmbeddedSource {
  return source.kind === "youtube" || source.kind === "bilibili";
}

/** Which player a Content plays in, from its source identifiers. */
export function playerSourceOf(content: Pick<ContentDto, "source">): PlayerSource {
  const { source } = content;
  const originalUrl = source.sourceUrl === undefined ? {} : { originalUrl: source.sourceUrl };
  if (source.kind !== "local" && !hasOnlinePlayer(source.kind)) {
    return { kind: "no_online_player", platform: source.kind, ...originalUrl };
  }
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
