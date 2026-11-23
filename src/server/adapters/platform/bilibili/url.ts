import type { ParsedPlatformUrl } from "../../../ports/platform-source.ts";

const VIDEO_HOSTS = new Set(["www.bilibili.com", "bilibili.com", "m.bilibili.com"]);
const BVID = /^BV[0-9A-Za-z]{10}$/;
export const SHORT_LINK_HOSTS: ReadonlySet<string> = new Set(["b23.tv"]);

/** Canonical URL of a video, or of one part of a multi-part submission. */
export function videoUrl(bvid: string, page?: number): string {
  return `https://www.bilibili.com/video/${bvid}${page === undefined ? "" : `?p=${page}`}`;
}

/**
 * Collection ids are `<mid>_<sid>` for a 合集 (season) and `<mid>_series_<sid>` for a
 * 列表 (series): the two kinds number independently and are listed by different APIs.
 */
export function collectionUrl(platformCollectionId: string): string | null {
  const match = /^(\d+)_(?:(series)_)?(\d+)$/.exec(platformCollectionId);
  if (match === null) {
    return null;
  }
  const [, mid, series, sid] = match as unknown as [string, string, string | undefined, string];
  return `https://space.bilibili.com/${mid}/lists/${sid}${series === undefined ? "" : "?type=series"}`;
}

/** The space and season of a 合集 id; `null` for a 列表 (series) or anything else. */
export function seasonOf(platformCollectionId: string): { mid: string; seasonId: string } | null {
  const match = /^(\d+)_(\d+)$/.exec(platformCollectionId);
  return match === null ? null : { mid: match[1] as string, seasonId: match[2] as string };
}

function parseUrl(url: string): URL | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * bilibili URLs Amber accepts: `bilibili.com/video/BV…[?p=N]` and a space's
 * collection or series (`space.bilibili.com/<mid>/lists/<sid>[?type=series]`, plus the
 * older `channel/collectiondetail?sid=` / `channel/seriesdetail?sid=` forms).
 */
export function parseBilibiliUrl(url: string): ParsedPlatformUrl | null {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (VIDEO_HOSTS.has(host)) {
    const bvid = segments[0] === "video" && segments.length === 2 ? segments[1] : undefined;
    if (bvid === undefined || !BVID.test(bvid)) {
      return null;
    }
    const p = parsed.searchParams.get("p");
    if (p === null) {
      return { platformContentId: bvid, canonicalUrl: videoUrl(bvid) };
    }
    const partIndex = /^[1-9]\d{0,3}$/.test(p) ? Number(p) : undefined;
    return partIndex === undefined ? null : { platformContentId: bvid, partIndex, canonicalUrl: videoUrl(bvid, partIndex) };
  }
  if (host === "space.bilibili.com") {
    const mid = segments[0];
    if (mid === undefined || !/^\d+$/.test(mid)) {
      return null;
    }
    let sid: string | null = null;
    let series = false;
    if (segments[1] === "lists" && segments.length === 3) {
      sid = segments[2] as string;
      series = parsed.searchParams.get("type") === "series";
    } else if (segments[1] === "channel" && segments.length === 3 && (segments[2] === "collectiondetail" || segments[2] === "seriesdetail")) {
      sid = parsed.searchParams.get("sid");
      series = segments[2] === "seriesdetail";
    }
    if (sid === null || !/^\d+$/.test(sid)) {
      return null;
    }
    const platformCollectionId = series ? `${mid}_series_${sid}` : `${mid}_${sid}`;
    return { platformCollectionId, canonicalUrl: collectionUrl(platformCollectionId) as string };
  }
  return null;
}

export function isShortLink(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase());
}
