import type { ParsedPlatformUrl } from "../../../ports/platform-source.ts";

const PAGE_HOSTS: ReadonlySet<string> = new Set(["www.xiaohongshu.com", "xiaohongshu.com"]);
const SHORT_LINK_HOSTS: ReadonlySet<string> = new Set(["xhslink.com", "www.xhslink.com"]);
/** Note and user ids are 24-character lowercase hex object ids. */
const OBJECT_ID = /^[0-9a-f]{24}$/;
/**
 * `xsec_token` is URL-safe base64 with optional `=` padding. Anything else (spaces, quotes,
 * `<`, other punctuation) is dropped rather than carried into a stored URL or a request.
 */
const XSEC_TOKEN = /^[A-Za-z0-9_-]{1,256}={0,2}$/;
/** `xsec_source` is a short tag such as `pc_feed` or `app_share`. */
const XSEC_SOURCE = /^[A-Za-z0-9_-]{1,64}$/;
const SHORT_LINK_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The two query parameters that grant access to a note page; nothing else is kept. */
export interface XiaohongshuAccessParams {
  xsecToken?: string;
  xsecSource?: string;
}

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

/** Reads the access parameters, dropping any whose value is empty or not token-shaped. */
function accessParamsFromSearch(search: URLSearchParams): XiaohongshuAccessParams {
  const params: XiaohongshuAccessParams = {};
  const token = search.get("xsec_token");
  if (token !== null && XSEC_TOKEN.test(token)) {
    params.xsecToken = token;
  }
  const source = search.get("xsec_source");
  if (source !== null && XSEC_SOURCE.test(source)) {
    params.xsecSource = source;
  }
  return params;
}

function withAccessParams(base: string, params: XiaohongshuAccessParams): string {
  const search = new URLSearchParams();
  if (params.xsecToken !== undefined && XSEC_TOKEN.test(params.xsecToken)) {
    search.set("xsec_token", params.xsecToken);
  }
  if (params.xsecSource !== undefined && XSEC_SOURCE.test(params.xsecSource)) {
    search.set("xsec_source", params.xsecSource);
  }
  const query = search.toString();
  return query === "" ? base : `${base}?${query}`;
}

/** Canonical URL of a note: the desktop page, with only the access parameters. */
export function explorePageUrl(noteId: string, params: XiaohongshuAccessParams = {}): string {
  return withAccessParams(`https://www.xiaohongshu.com/explore/${noteId}`, params);
}

/**
 * The mobile share page of a note. It is read first because it stays readable for visitors
 * where the desktop page redirects to the login page, and it tells videos from image notes.
 */
export function mobileShareUrl(noteId: string, params: XiaohongshuAccessParams = {}): string {
  return withAccessParams(`https://www.xiaohongshu.com/discovery/item/${noteId}`, params);
}

/**
 * Xiaohongshu note URLs Amber accepts: `/explore/<id>`, `/discovery/item/<id>` and
 * `/user/profile/<userId>/<id>` on `www.xiaohongshu.com` (or the bare domain). A link
 * without `xsec_token` still parses; the import precheck reports it as expired.
 */
export function parseXiaohongshuUrl(url: string): ParsedPlatformUrl | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null || !PAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  let noteId: string | undefined;
  if (segments[0] === "explore" && segments.length === 2) {
    noteId = segments[1];
  } else if (segments[0] === "discovery" && segments[1] === "item" && segments.length === 3) {
    noteId = segments[2];
  } else if (segments[0] === "user" && segments[1] === "profile" && segments.length === 4 && OBJECT_ID.test(segments[2] as string)) {
    noteId = segments[3];
  }
  if (noteId === undefined || !OBJECT_ID.test(noteId)) {
    return null;
  }
  return { platformContentId: noteId, canonicalUrl: explorePageUrl(noteId, accessParamsFromSearch(parsed.searchParams)) };
}

/** The access parameters carried by a note URL (empty when it is not a note URL). */
export function accessParamsOf(url: string): XiaohongshuAccessParams {
  const parsed = parseHttpUrl(url);
  return parsed === null ? {} : accessParamsFromSearch(parsed.searchParams);
}

/** Whether a parsed note URL carries an `xsec_token`; without one the note page cannot be opened. */
export function hasAccessToken(parsed: ParsedPlatformUrl): boolean {
  return accessParamsOf(parsed.canonicalUrl).xsecToken !== undefined;
}

/**
 * The `xhslink.com` short link rewritten to `https` with query and fragment dropped, or
 * `null` when the URL is not one. Share texts often carry `http://` short links, while
 * platform reads only go out over `https`; the code lives in the path (`/a/<code>`,
 * `/m/<code>` or `/<code>`).
 */
export function normalizeXiaohongshuShortLink(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null || !SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 1 || segments.length > 2 || !segments.every((segment) => SHORT_LINK_SEGMENT.test(segment))) {
    return null;
  }
  return `https://${parsed.hostname.toLowerCase()}/${segments.join("/")}`;
}

export function isXiaohongshuShortLink(url: string): boolean {
  return normalizeXiaohongshuShortLink(url) !== null;
}
