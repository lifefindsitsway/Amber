import { CACHE_DIR_NAME } from "./app-identity.ts";
import { CACHE_FILE_NAME_MAX_CHARS } from "./defaults.ts";

/**
 * File names of cached platform media. Shared by the cache
 * dialog's preview and the server, whose result is authoritative. A cache file lies flat in
 * the cache directory; its `storageRef` is `media/<file name>`. A video is named
 * `<stem> [<tier>P].<ext>` after the quality tier of the finished file (see
 * `cacheQualityTier`), an audio cache `<stem>.mp3`.
 * Names are never numbered: the same name means the same cache, so a new file replaces the
 * one it is named like.
 */

/** Extensions a cache file can have, by the container actually produced. */
export const CACHE_EXTENSIONS = ["mp4", "webm", "mp3"] as const;
export type CacheExtension = (typeof CACHE_EXTENSIONS)[number];

/** What the user asked to cache. */
export const CACHE_MEDIA_TYPES = ["video", "audio"] as const;
export type CacheMediaType = (typeof CACHE_MEDIA_TYPES)[number];

/** Suffix of the file `writeAtomic` writes before renaming it into place. */
export const CACHE_PARTIAL_SUFFIX = ".partial";

/**
 * The longest path Win32 accepts without the `\\?\` prefix, excluding the terminating NUL
 * (`MAX_PATH` = 260). Counted in UTF-16 code units, as Windows does.
 */
export const WINDOWS_MAX_PATH_UNITS = 259;

/** The widest quality label the path budget reserves room for. */
const WIDEST_LABEL = " [2160P]";
/**
 * The longest tail a stem can get on disk: the widest quality label, the longest extension
 * and the partial suffix. Every tier up to 4320 has at most four digits.
 */
const LONGEST_TAIL = `${WIDEST_LABEL}.webm${CACHE_PARTIAL_SUFFIX}`;
/** The label shown in place of a height that is not known yet. */
const UNKNOWN_HEIGHT_LABEL = "?";

/** Characters Windows refuses in a file name. */
const FORBIDDEN = /[<>:"/\\|?*]/gu;
/** C0 / C1 control characters. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Device names Windows reserves, with or without an extension (`NUL.tar.gz` is `NUL`). */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
/** Media extensions a user may have typed into the name field; the real one is appended later. */
const TYPED_EXTENSION = /\.(?:mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|wav|flac|ogg|oga|opus|wma)$/iu;

function codePoints(text: string): string[] {
  return Array.from(text);
}

function trimEnds(text: string): string {
  return text.replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");
}

/** Appends `_` to the part before the first dot when Windows would read the name as a device. */
function unreserve(stem: string): string {
  const dot = stem.indexOf(".");
  const base = dot === -1 ? stem : stem.slice(0, dot);
  if (!RESERVED.test(base.trimEnd())) {
    return stem;
  }
  return dot === -1 ? `${stem}_` : `${base}_${stem.slice(dot)}`;
}

/**
 * The cleaned stem of a user's file name, or `undefined` when nothing usable remains:
 * NFC, no forbidden or control characters, collapsed whitespace, no leading or trailing
 * dots and spaces, no typed media extension, no device name, at most
 * `CACHE_FILE_NAME_MAX_CHARS` code points.
 */
export function sanitizeCacheStem(input: string): string | undefined {
  // Line breaks and tabs separate words; turn them into spaces before control characters go.
  let stem = input.normalize("NFC").replace(/[\t\n\v\f\r]/gu, " ").replace(CONTROL, "").replace(FORBIDDEN, "").replace(/\s+/gu, " ");
  stem = trimEnds(stem);
  stem = trimEnds(stem.replace(TYPED_EXTENSION, ""));
  stem = trimEnds(codePoints(stem).slice(0, CACHE_FILE_NAME_MAX_CHARS).join(""));
  if (stem === "") {
    return undefined;
  }
  return unreserve(stem);
}

/**
 * `stem` shortened so that `<dir>\<stem> [2160P].webm.partial` stays within
 * `WINDOWS_MAX_PATH_UNITS`, never splitting a character. `undefined` when not even one
 * character of the stem fits, i.e. the cache directory itself is too long.
 */
export function fittedCacheStem(stem: string, cacheDir: string): string | undefined {
  // One more unit for the `_` a device name may get after truncation.
  const budget = WINDOWS_MAX_PATH_UNITS - cacheDir.length - 1 - LONGEST_TAIL.length - 1;
  const points = codePoints(stem);
  let units = stem.length;
  while (points.length > 0 && units > budget) {
    units -= (points.pop() as string).length;
  }
  const fitted = trimEnds(points.join(""));
  return fitted === "" ? undefined : unreserve(fitted);
}

/**
 * The quality tiers a video cache is labelled with, as video platforms name their quality
 * menus (720P, 1080P, ...).
 */
export const CACHE_QUALITY_TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320] as const;
/** How far above a tier a picture may still be labelled with it (1280×756 is still 720P). */
const TIER_TOLERANCE = 1.05;

/**
 * The quality tier of a picture. Its equivalent height is the larger of the short side and
 * 9/16 of the long side, so landscape, portrait (1080×1920 → 1080) and wide-screen pictures
 * (1280×534 → 720) are judged alike; the tier is the smallest one the equivalent height stays
 * within `TIER_TOLERANCE` of (1280×714 → 720, 1920×1072 → 1080). Beyond the largest tier the
 * equivalent height itself, rounded, is the label. Without a width (a height recorded by an
 * earlier build) the height alone is the equivalent height. A tier maps to itself.
 */
export function cacheQualityTier(height: number, width?: number): number {
  const equivalent = width === undefined ? height : Math.max(Math.min(width, height), (Math.max(width, height) * 9) / 16);
  return CACHE_QUALITY_TIERS.find((tier) => equivalent <= tier * TIER_TOLERANCE) ?? Math.round(equivalent);
}

/** `<stem> [<tier>P]`, or `<stem> [?P]` for a tier not known yet (shown, never written). */
export function labelledStem(stem: string, tier: number | undefined): string {
  return `${stem} [${tier === undefined ? UNKNOWN_HEIGHT_LABEL : String(tier)}P]`;
}

/** The file name of a video cache: `<stem> [<tier>P].<ext>`; `[?P]` when the tier is not known yet. */
export function videoCacheFileName(stem: string, tier: number | undefined, ext: CacheExtension): string {
  return `${labelledStem(stem, tier)}.${ext}`;
}

/** The file name of an audio cache: `<stem>.mp3`. */
export function audioCacheFileName(stem: string): string {
  return `${stem}.mp3`;
}

/** The storage ref of a cache file name (`a [720P].mp4` → `media/a [720P].mp4`). */
export function cacheRefOf(fileName: string): string {
  return `${CACHE_DIR_NAME}/${fileName}`;
}

/** Whether `ref` is a flat cache ref (`media/<name>`). */
export function isCacheRef(ref: string): boolean {
  return ref.startsWith(`${CACHE_DIR_NAME}/`) && !ref.slice(CACHE_DIR_NAME.length + 1).includes("/");
}

/** The file name of a cache ref (`media/a.mp4` → `a.mp4`). */
export function cacheFileNameOf(ref: string): string {
  return ref.slice(CACHE_DIR_NAME.length + 1);
}

/** Windows compares file names case-insensitively; so does every cache name comparison. */
export function sameCacheFileName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The extension a cache file gets for the container actually produced. */
export function cacheExtensionOf(mimeType: string): CacheExtension | undefined {
  switch (mimeType) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "audio/mpeg":
      return "mp3";
    default:
      return undefined;
  }
}

/**
 * Whether `name` is a file name a cache ref may carry: what `sanitizeCacheStem` could have
 * produced plus one of `CACHE_EXTENSIONS`. The store's guard against path traversal.
 */
export function isValidCacheFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const ext = name.slice(dot + 1);
  if (!(CACHE_EXTENSIONS as readonly string[]).includes(ext)) {
    return false;
  }
  const stem = name.slice(0, dot);
  return (
    stem === stem.normalize("NFC") &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(stem) &&
    trimEnds(stem) === stem &&
    unreserve(stem) === stem &&
    !/\s{2,}|[\t\n\r]/u.test(stem) &&
    name.length <= 255
  );
}
