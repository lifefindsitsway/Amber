import type { ParsedPlatformUrl } from "../../../ports/platform-source.ts";

const WEB_HOSTS: ReadonlySet<string> = new Set(["www.douyin.com", "douyin.com"]);
const SHARE_HOSTS: ReadonlySet<string> = new Set(["www.iesdouyin.com"]);
const SHORT_LINK_HOST = "v.douyin.com";
/** Video (aweme) ids and collection (mix) ids are both long decimal numbers. */
const NUMERIC_ID = /^\d{15,20}$/;
const SHORT_CODE = /^[A-Za-z0-9_-]{1,32}$/;
/**
 * Collection ids are namespaced so they can never collide with another platform's
 * collection ids in the same column.
 */
const COLLECTION_ID_PREFIX = "douyin:";

function parseHttpUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  // Credentials or a non-default port never appear in a real share link; refusing them
  // keeps the outbound host check meaningful. (`URL` already drops an explicit default port.)
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    return null;
  }
  return parsed;
}

/** Canonical URL of a video or image post; the precheck tells the two apart later. */
export function videoUrl(awemeId: string): string {
  return `https://www.douyin.com/video/${awemeId}`;
}

export function collectionCanonicalUrl(mixId: string): string {
  return `https://www.douyin.com/collection/${mixId}`;
}

/** The mix id inside a `douyin:<id>` collection id, or `null` for anything else. */
export function collectionIdOf(platformCollectionId: string): string | null {
  if (!platformCollectionId.startsWith(COLLECTION_ID_PREFIX)) {
    return null;
  }
  const mixId = platformCollectionId.slice(COLLECTION_ID_PREFIX.length);
  return NUMERIC_ID.test(mixId) ? mixId : null;
}

function content(awemeId: string | null | undefined): ParsedPlatformUrl | null {
  return awemeId !== null && awemeId !== undefined && NUMERIC_ID.test(awemeId) ? { platformContentId: awemeId, canonicalUrl: videoUrl(awemeId) } : null;
}

function collection(mixId: string | undefined): ParsedPlatformUrl | null {
  return mixId !== undefined && NUMERIC_ID.test(mixId) ? { platformCollectionId: `${COLLECTION_ID_PREFIX}${mixId}`, canonicalUrl: collectionCanonicalUrl(mixId) } : null;
}

/**
 * Douyin URLs Amber accepts. Content: `douyin.com/video/<id>`, `douyin.com/note/<id>`, any
 * `douyin.com` page carrying `modal_id=<id>` (the video opened over that page wins over
 * the page itself) and `iesdouyin.com/share/video/<id>`. Collections:
 * `douyin.com/collection/<id>` and `iesdouyin.com/share/mix/detail/<id>`.
 */
export function parseDouyinUrl(url: string): ParsedPlatformUrl | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (WEB_HOSTS.has(host)) {
    const modalId = parsed.searchParams.get("modal_id");
    if (modalId !== null) {
      return content(modalId);
    }
    if ((segments[0] === "video" || segments[0] === "note") && segments.length === 2) {
      return content(segments[1]);
    }
    if (segments[0] === "collection" && segments.length === 2) {
      return collection(segments[1]);
    }
    return null;
  }
  if (SHARE_HOSTS.has(host) && segments[0] === "share") {
    if (segments[1] === "video" && segments.length === 3) {
      return content(segments[2]);
    }
    if (segments[1] === "mix" && segments[2] === "detail" && segments.length === 4) {
      return collection(segments[3]);
    }
  }
  return null;
}

/**
 * The `v.douyin.com/<code>` short link rewritten to `https` with query and fragment
 * dropped, or `null` when the URL is not one. Platform reads only go out over `https`.
 */
export function normalizeDouyinShortLink(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null || parsed.hostname.toLowerCase() !== SHORT_LINK_HOST) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  const code = segments.length === 1 ? segments[0] : undefined;
  return code !== undefined && SHORT_CODE.test(code) ? `https://${SHORT_LINK_HOST}/${code}/` : null;
}

export function isDouyinShortLink(url: string): boolean {
  return normalizeDouyinShortLink(url) !== null;
}
