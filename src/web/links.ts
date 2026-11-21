import type { Platform } from "../shared/enums.ts";

/** What a pasted link would import, as far as the client can tell without going online. */
export interface RecognizedLink {
  url: string;
  platform: Platform;
  /** `collection` imports a whole list; `shortlink` is expanded by the server. */
  kind: "video" | "collection" | "shortlink";
  /** A bilibili video link without `p=` may still name a multi-part submission. */
  partChosen: boolean;
}

const BILIBILI_HOSTS = new Set(["www.bilibili.com", "bilibili.com", "m.bilibili.com"]);
const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
const BVID = /^BV[0-9A-Za-z]{10}$/;
const PART = /^[1-9]\d{0,3}$/;
const DIGITS = /^\d+$/;
const YOUTUBE_ID = /^[0-9A-Za-z_-]{11}$/;
const YOUTUBE_LIST = /^[0-9A-Za-z_-]{10,64}$/;
const SHORT_PATH = /^\/[0-9A-Za-z]+\/?$/;

/**
 * Client-side recognizer for the link shapes the platforms accept. It decides only whether a
 * paste looks like a supported link and whether it is a batch; the server's parser stays
 * authoritative. Every shape accepted here is one the server accepts as well, so a link
 * the server would refuse is never presented as supported.
 */
export function recognizeLink(text: string): RecognizedLink | undefined {
  const href = text.trim();
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (BILIBILI_HOSTS.has(host)) {
    if (segments.length !== 2 || segments[0] !== "video" || !BVID.test(segments[1] ?? "")) return undefined;
    const part = url.searchParams.get("p");
    if (part !== null && !PART.test(part)) return undefined;
    return { url: href, platform: "bilibili", kind: "video", partChosen: part !== null };
  }
  if (host === "space.bilibili.com") {
    return bilibiliList(url, segments) ? { url: href, platform: "bilibili", kind: "collection", partChosen: true } : undefined;
  }
  if (host === "b23.tv") {
    return SHORT_PATH.test(url.pathname) ? { url: href, platform: "bilibili", kind: "shortlink", partChosen: false } : undefined;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch" && YOUTUBE_ID.test(url.searchParams.get("v") ?? "")) {
      return { url: href, platform: "youtube", kind: "video", partChosen: true };
    }
    if (url.pathname === "/playlist" && YOUTUBE_LIST.test(url.searchParams.get("list") ?? "")) {
      return { url: href, platform: "youtube", kind: "collection", partChosen: true };
    }
    return undefined;
  }
  // The id is the whole path: `youtu.be/<id>/` is refused upstream, so it is refused here too.
  if (host === "youtu.be" && YOUTUBE_ID.test(url.pathname.slice(1))) {
    return { url: href, platform: "youtube", kind: "video", partChosen: true };
  }
  return undefined;
}

/** A space's collection or series: `/<mid>/lists/<sid>`, or the older `channel/…detail?sid=` forms. */
function bilibiliList(url: URL, segments: readonly string[]): boolean {
  if (segments.length !== 3 || !DIGITS.test(segments[0] ?? "")) return false;
  if (segments[1] === "lists") return DIGITS.test(segments[2] ?? "");
  if (segments[1] === "channel" && (segments[2] === "collectiondetail" || segments[2] === "seriesdetail")) {
    return DIGITS.test(url.searchParams.get("sid") ?? "");
  }
  return false;
}

/** Non-empty trimmed lines of a pasted block. */
export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** What a block of text holds, read the same way wherever links are pasted. */
export interface ParsedLinkText {
  /** Supported links in order of appearance; an exact repeat is kept once. */
  links: RecognizedLink[];
  /** `http(s)` links that are not supported, in order; an exact repeat is kept once. */
  unsupported: string[];
  /** Every link, supported or not, in order of appearance; an exact repeat is kept once. */
  all: string[];
  /** Non-blank lines holding no link at all. */
  ignoredLines: number;
  /** Whether anything besides the links themselves is present: titles, punctuation, other lines. */
  otherText: boolean;
}

/**
 * Where a link may start: the scheme, in any case. A run of visible ASCII after it is the
 * candidate, so a space or any non-ASCII character (a full-width bracket around a share
 * text's title, a full-width full stop) ends it.
 */
const RUN = /https?:\/\/[\x21-\x7e]*/gi;
/** A second scheme inside one run means two links pasted without a space between them. */
const INNER_SCHEME = /(?=https?:\/\/)/i;
const SCHEME_ONLY = /^https?:\/\/$/i;
/** Characters a sentence may put right after a link; never part of a supported link's end. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "'", '"']);
/** How many trailing characters are tried off; with the run itself, at most nine attempts. */
const MAX_TRIMS = 8;

/**
 * The link a candidate holds: the whole candidate if it is supported, else the candidate with
 * trailing punctuation taken off one character at a time. Parameters (`?p=2`, `list=`) are kept
 * as they are. A candidate that never becomes supported is returned with that punctuation off,
 * as written otherwise. Bounded: `recognize` is called at most nine times.
 */
export function readCandidate(candidate: string, recognize: (text: string) => RecognizedLink | undefined = recognizeLink): { text: string; link?: RecognizedLink } {
  let text = candidate;
  for (let trims = 0; ; trims++) {
    const link = recognize(text);
    if (link !== undefined) return { text, link };
    const last = text.at(-1);
    if (trims === MAX_TRIMS || last === undefined || !TRAILING.has(last)) break;
    text = text.slice(0, -1);
  }
  return { text };
}

/**
 * Reads pasted text, such as a platform's share text (a title in full-width brackets, then the
 * link), for the links in it.
 * Always by fragments: a whole line is never taken as one link, because a URL parser accepts a
 * title after a query string as part of it. Duplicates are dropped only when exactly equal; two
 * parts of one video are different links. Which items are the same video is the server's call.
 */
export function parseLinkText(text: string): ParsedLinkText {
  const links: RecognizedLink[] = [];
  const unsupported: string[] = [];
  const all: string[] = [];
  const seen = new Set<string>();
  let ignoredLines = 0;
  let otherText = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let found = false;
    // What is left of the line once its links are taken out; anything visible there is other text.
    let rest = "";
    let from = 0;
    for (const run of line.matchAll(RUN)) {
      rest += line.slice(from, run.index);
      from = run.index + run[0].length;
      for (const candidate of run[0].split(INNER_SCHEME)) {
        if (SCHEME_ONLY.test(candidate)) {
          rest += candidate;
          continue;
        }
        const read = readCandidate(candidate);
        rest += candidate.slice(read.text.length);
        if (SCHEME_ONLY.test(read.text)) {
          rest += read.text;
          continue;
        }
        found = true;
        if (seen.has(read.text)) continue;
        seen.add(read.text);
        all.push(read.text);
        if (read.link === undefined) unsupported.push(read.text);
        else links.push(read.link);
      }
    }
    rest += line.slice(from);
    if (!found) ignoredLines += 1;
    if (rest.trim() !== "") otherText = true;
  }
  return { links, unsupported, all, ignoredLines, otherText };
}

/** What a paste becomes once tidied: its links alone, and how many there are. */
export interface LinkPaste {
  text: string;
  count: number;
  /** Whether anything besides the links was left out; only then is there something to point out. */
  tidied: boolean;
}

/**
 * The tidied form of a paste holding a supported link: every link it holds, supported or not,
 * one per line (or joined by `separator`), with titles and other words left out. Unsupported
 * links stay so the page can say they were not added. `undefined` when no link is supported:
 * such a paste is left alone.
 */
export function linkPaste(text: string, separator = "\n"): LinkPaste | undefined {
  const parsed = parseLinkText(text);
  if (parsed.links.length === 0) return undefined;
  return { text: parsed.all.join(separator), count: parsed.all.length, tidied: parsed.otherText };
}
