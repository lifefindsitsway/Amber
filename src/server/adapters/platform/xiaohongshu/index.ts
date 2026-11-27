import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OUTBOUND_MAX_REDIRECTS, PLATFORM_PAGE_MAX_BYTES, SHORTLINK_MAX_HOPS } from "../../../../shared/defaults.ts";
import { cacheQualityTier } from "../../../../shared/cache-file-name.ts";
import { BYTES_PER_MB } from "../../../../shared/units.ts";
import { amberError, isAmberError } from "../../../domain/errors.ts";
import { cookieHeaderFor, parseNetscapeCookies } from "../../../domain/platform-cookie.ts";
import type { OutboundHttpClient } from "../../../ports/outbound-http.ts";
import type {
  CanonicalSubtitle,
  ParsedPlatformUrl,
  PlatformCollectionEntry,
  PlatformCollectionItem,
  PlatformCollectionListing,
  PlatformContentRef,
  PlatformCredential,
  PlatformDescription,
  PlatformImportCheck,
  PlatformMetadata,
  PlatformSourceAdapter,
  SubtitleTrackRef,
  VideoQuality,
  VideoTarget,
} from "../../../ports/platform-source.ts";
import { downloadPlatformMedia, PLATFORM_MEDIA_MAX_BYTES, type PlatformMediaDownload, type PlatformMediaKind } from "../download.ts";
import { platformGetBytes, platformGetText } from "../http.ts";
import { trustedImageUrl } from "../shared.ts";
import { probeMp4, type Mp4RangeReader } from "./mp4-header.ts";
import { loggedInOf, notePageDetail, XIAOHONGSHU_MEDIA_DOMAINS, type NoteDetail, type NotePageForm, type NoteStream } from "./page.ts";
import { accessParamsOf, explorePageUrl, mobileShareUrl, normalizeXiaohongshuShortLink, parseXiaohongshuUrl, type XiaohongshuAccessParams } from "./url.ts";

/** Cookies of the platform's web login; pasted or imported cookies are filtered to these. */
export const XIAOHONGSHU_COOKIE_DOMAINS: readonly string[] = [".xiaohongshu.com"];
/** Hosts note pages are read from; a redirect anywhere else is refused. */
const PAGE_HOSTS: ReadonlySet<string> = new Set(["www.xiaohongshu.com", "xiaohongshu.com"]);
/** Where a login is sent and checked: the desktop site's host. */
const LOGIN_HOST = "www.xiaohongshu.com";
/** The desktop home feed, whose embedded state says whether its viewer is logged in. */
const HOME_PAGE = "https://www.xiaohongshu.com/explore";
/** A phone browser's identity; the mobile share page is served to it. */
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const LOGIN_PATH = /^\/(?:website-)?login(?:\/|$)/;
const NOT_FOUND_PATH = /^\/404(?:\/|$)/;
const H264_SAMPLE_ENTRIES: ReadonlySet<string> = new Set(["avc1", "avc3"]);
/**
 * How the header of an untranscoded upload is read: a few hundred KiB per range request while
 * walking its top-level boxes, a `moov` of at most 16 MiB (hours of video), four requests at
 * most. A file that needs more is simply not offered as a quality.
 */
const ORIGINAL_PROBE = { chunkBytes: BYTES_PER_MB / 4, moovMaxBytes: 16 * BYTES_PER_MB, maxReads: 4 } as const;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

export interface XiaohongshuAdapterOptions {
  http: OutboundHttpClient;
  /** The platform media downloader; tests stand in for it. */
  download?: PlatformMediaDownload;
  now?: () => number;
}

/** What one read of a note page found. */
type PageOutcome = { kind: "note"; note: NoteDetail } | { kind: "login" } | { kind: "missing" } | { kind: "refused" };

/** A video quality a cache can be made in, with where its file is read from. */
interface VideoChoice extends VideoQuality {
  urls: string[];
  sizeBytes: number;
  original: boolean;
}

function visitorRefused(): Error {
  return amberError("platform_blocked", "xiaohongshu refused the visitor request", { code: "platform_blocked.visitor_refused" });
}

function notVideo(): Error {
  return amberError("invalid_request", "the note is not a video note", { code: "invalid_request.not_video" });
}

function tierUnavailable(tier: number): Error {
  return amberError("invalid_request", `no stream of the ${tier}P tier is offered`, {
    code: "invalid_request.cache_quality_unavailable",
    params: { quality: String(tier) },
  });
}

/** Failures that mean "the platform did not let us tell", as opposed to a refusal with its own error. */
function isUnreadable(error: unknown): boolean {
  return isAmberError(error) && (error.appError.class === "source_unreachable" || error.appError.class === "source_html_error_page");
}

/** A download failure after which another address of the same file is worth trying. */
function triesNextAddress(error: unknown, signal: AbortSignal): boolean {
  return !signal.aborted && isAmberError(error) && error.appError.class !== "media_too_large" && error.appError.class !== "disk_low";
}

function metadataOf(note: NoteDetail): PlatformMetadata {
  return {
    title: note.title,
    durationMs: note.durationMs ?? 0,
    ...(note.coverUrl === undefined ? {} : { coverUrl: note.coverUrl }),
    ...(note.publishedAt === undefined ? {} : { publishedAt: note.publishedAt }),
    ...(note.channelId === undefined ? {} : { channelId: note.channelId }),
    ...(note.channelTitle === undefined ? {} : { channelTitle: note.channelTitle }),
    subtitleTracks: [],
    description: note.description,
  };
}

/** One choice per tier, the untranscoded upload first within a tier, then the larger picture. */
function choicesByTier(candidates: readonly VideoChoice[]): VideoChoice[] {
  const byTier = new Map<number, VideoChoice>();
  const better = (a: VideoChoice, b: VideoChoice) => Number(b.original) - Number(a.original) || b.width * b.height - a.width * a.height || b.sizeBytes - a.sizeBytes;
  for (const candidate of [...candidates].sort(better)) {
    if (!byTier.has(candidate.tier)) {
      byTier.set(candidate.tier, candidate);
    }
  }
  return [...byTier.values()].sort((a, b) => a.tier - b.tier);
}

function pickChoice(choices: readonly VideoChoice[], target: VideoTarget): VideoChoice {
  if ("tier" in target) {
    const choice = choices.find((candidate) => candidate.tier === target.tier);
    if (choice === undefined) {
      throw tierUnavailable(target.tier);
    }
    return choice;
  }
  const within = choices.filter((candidate) => candidate.tier <= target.maxHeight);
  const choice = within.at(-1) ?? choices[0];
  if (choice === undefined) {
    throw notVideo();
  }
  return choice;
}

/**
 * Xiaohongshu video notes, read by Amber itself (no yt-dlp): the mobile share page first, the
 * desktop page when that redirects to the login page, a stored login only when both do. Media
 * and covers are fetched without a login. Neither logs nor error messages carry a page URL,
 * whose `xsec_token` grants access to the note.
 */
export class XiaohongshuAdapter implements PlatformSourceAdapter {
  readonly kind = "xiaohongshu" as const;
  readonly cookieDomains = XIAOHONGSHU_COOKIE_DOMAINS;
  protected readonly http: OutboundHttpClient;
  protected readonly download: PlatformMediaDownload;
  protected readonly now: () => number;

  constructor(options: XiaohongshuAdapterOptions) {
    this.http = options.http;
    this.download = options.download ?? downloadPlatformMedia;
    this.now = options.now ?? Date.now;
  }

  parse(url: string): ParsedPlatformUrl | null {
    return parseXiaohongshuUrl(url);
  }

  /** Expands an `xhslink.com` short link hop by hop; only short-link hops are requested. */
  async resolveUrl(url: string, signal: AbortSignal): Promise<string | null> {
    let current = normalizeXiaohongshuShortLink(url.trim());
    for (let hop = 0; current !== null && hop < SHORTLINK_MAX_HOPS; hop++) {
      const response = await platformGetText(this.http, { url: current, signal, maxBytes: PLATFORM_PAGE_MAX_BYTES });
      if (response.status < 300 || response.status >= 400 || response.location === undefined) {
        return null;
      }
      const parsed = parseXiaohongshuUrl(response.location);
      if (parsed?.platformContentId !== undefined) {
        return parsed.canonicalUrl;
      }
      current = normalizeXiaohongshuShortLink(response.location);
    }
    return null;
  }

  async precheck(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformImportCheck> {
    if (this.accessParams(ref).xsecToken === undefined) {
      // Without the access parameter the note page does not open; nothing is asked.
      return { result: "rejected", reason: "link_expired" };
    }
    let outcome: PageOutcome;
    try {
      outcome = await this.readNote(ref, auth, signal);
    } catch (error) {
      if (!signal.aborted && isUnreadable(error)) {
        return { result: "unverified" };
      }
      throw error;
    }
    if (outcome.kind !== "note") {
      // A login wall, a missing page or a refused visitor may all be the network's doing.
      return { result: "unverified" };
    }
    const { note } = outcome;
    if (note.type === "normal") {
      return { result: "rejected", reason: "not_video" };
    }
    if (note.type !== "video" || note.streams.length === 0) {
      return { result: "unverified" };
    }
    return { result: "video", metadata: metadataOf(note) };
  }

  async fetchMetadata(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformMetadata> {
    const note = await this.note(ref, auth, signal);
    if (note.type !== "video") {
      throw notVideo();
    }
    return metadataOf(note);
  }

  async fetchDescription(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformDescription> {
    return (await this.note(ref, auth, signal)).description;
  }

  async fetchSubtitle(_ref: PlatformContentRef, _track: SubtitleTrackRef, _auth: PlatformCredential | undefined, _signal: AbortSignal): Promise<CanonicalSubtitle> {
    // Notes have no platform subtitles; the subtitle stage never lists a track to ask for.
    throw amberError("source_unreachable", "xiaohongshu has no platform subtitles");
  }

  /**
   * Reads the desktop home feed once with the login: its embedded state says whether the
   * viewer is logged in. A redirect to the login page means the login is not accepted; a page
   * that says nothing, a network failure or any other answer is `unknown`.
   */
  async checkCredential(auth: PlatformCredential, signal: AbortSignal): Promise<"valid" | "expired" | "unknown"> {
    const cookie = await this.cookieHeader(auth);
    if (cookie === undefined) {
      return "expired";
    }
    try {
      const response = await platformGetText(this.http, { url: HOME_PAGE, headers: { Cookie: cookie }, signal, maxBytes: PLATFORM_PAGE_MAX_BYTES });
      if (response.status >= 300 && response.status < 400) {
        return response.location !== undefined && this.isLoginPage(response.location) ? "expired" : "unknown";
      }
      if (response.status < 200 || response.status >= 300) {
        return "unknown";
      }
      const loggedIn = loggedInOf(response.text);
      return loggedIn === undefined ? "unknown" : loggedIn ? "valid" : "expired";
    } catch (error) {
      if (signal.aborted || !isAmberError(error)) {
        throw error;
      }
      return "unknown";
    }
  }

  async listCollection(_platformCollectionId: string, _auth: PlatformCredential | undefined, _signal: AbortSignal, _limit: number): Promise<PlatformCollectionListing> {
    // `parse` never names a collection for this platform.
    throw amberError("invalid_request", "xiaohongshu has no collections");
  }

  async resolveCollectionEntries(
    _platformCollectionId: string,
    _entries: readonly PlatformCollectionEntry[],
    _auth: PlatformCredential | undefined,
    _signal: AbortSignal,
  ): Promise<PlatformCollectionItem[]> {
    throw amberError("invalid_request", "xiaohongshu has no collections");
  }

  /** Downloads the smallest H.264 stream, whose audio the extraction step takes. */
  async fetchAudio(
    ref: PlatformContentRef,
    auth: PlatformCredential | undefined,
    output: { path: string },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    options?: { maxBytes?: number },
  ): Promise<{ sizeBytes: number }> {
    const stream = (await this.videoNote(ref, auth, signal)).streams[0] as NoteStream;
    const scratchDir = await mkdtemp(join(dirname(output.path), ".xiaohongshu-"));
    try {
      const { sizeBytes } = await this.downloadFirst(stream.urls, {
        kind: "video",
        expectedBytes: stream.sizeBytes,
        maxBytes: options?.maxBytes ?? PLATFORM_MEDIA_MAX_BYTES,
        output: { path: output.path, scratchDir },
        onProgress,
        signal,
      });
      return { sizeBytes };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  async inspectAudio(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<{ sizeBytes?: number }> {
    return { sizeBytes: ((await this.videoNote(ref, auth, signal)).streams[0] as NoteStream).sizeBytes };
  }

  async listVideoQualities(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<VideoQuality[] | undefined> {
    const choices = await this.videoChoices(ref, auth, signal);
    return choices.map(({ tier, width, height }) => ({ tier, width, height }));
  }

  async inspectVideo(
    ref: PlatformContentRef,
    auth: PlatformCredential | undefined,
    target: VideoTarget,
    signal: AbortSignal,
  ): Promise<{ hasVideo: false } | { hasVideo: true; mimeType: string; sizeBytes?: number; height?: number; width?: number }> {
    const choice = pickChoice(await this.videoChoices(ref, auth, signal), target);
    return { hasVideo: true, mimeType: "video/mp4", sizeBytes: choice.sizeBytes, height: choice.height, width: choice.width };
  }

  async fetchVideo(
    ref: PlatformContentRef,
    auth: PlatformCredential | undefined,
    options: VideoTarget & { maxBytes: number; output: { path: string; scratchDir: string } },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number; mimeType: string; height?: number; acquisition: "guest" | "authenticated" }> {
    // The direct links are read again from the page: they are signed and short-lived.
    const target: VideoTarget = "tier" in options ? { tier: options.tier } : { maxHeight: options.maxHeight };
    const choice = pickChoice(await this.videoChoices(ref, auth, signal), target);
    const { sizeBytes } = await this.downloadFirst(choice.urls, {
      kind: "video",
      expectedBytes: choice.sizeBytes,
      maxBytes: options.maxBytes,
      output: options.output,
      onProgress,
      signal,
    });
    // Media is always fetched without the login.
    return { sizeBytes, mimeType: "video/mp4", height: choice.height, acquisition: "guest" };
  }

  async fetchCover(coverUrl: string, output: { path: string }, options: { maxBytes: number }, signal: AbortSignal): Promise<{ sizeBytes: number }> {
    const url = trustedImageUrl(coverUrl, XIAOHONGSHU_MEDIA_DOMAINS);
    if (url === undefined) {
      throw amberError("invalid_request", "the cover is not on the platform's image hosts");
    }
    const scratchDir = await mkdtemp(join(dirname(output.path), ".xiaohongshu-"));
    try {
      const { sizeBytes } = await this.download(this.http, {
        url,
        allowedHosts: XIAOHONGSHU_MEDIA_DOMAINS,
        kind: "image",
        maxBytes: options.maxBytes,
        output: { path: output.path, scratchDir },
        signal,
      });
      return { sizeBytes };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  /** The access parameters of the stored link, when it is this note's link. */
  private accessParams(ref: PlatformContentRef): XiaohongshuAccessParams {
    if (ref.sourceUrl === undefined) {
      return {};
    }
    const parsed = parseXiaohongshuUrl(ref.sourceUrl);
    return parsed?.platformContentId === ref.platformContentId ? accessParamsOf(parsed.canonicalUrl) : {};
  }

  private async cookieHeader(auth: PlatformCredential | undefined): Promise<string | undefined> {
    if (auth === undefined) {
      return undefined;
    }
    const header = cookieHeaderFor(parseNetscapeCookies(await auth.cookies()), LOGIN_HOST, this.now());
    return header === "" ? undefined : header;
  }

  private isLoginPage(location: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(location);
    } catch {
      return false;
    }
    return PAGE_HOSTS.has(parsed.hostname.toLowerCase()) && LOGIN_PATH.test(parsed.pathname);
  }

  /**
   * One note page read without following redirects by the client: a hop to the login page or
   * to `/404` ends the read, a hop to another page of the same note is followed over https,
   * and a hop off the platform's page hosts is refused before it is requested.
   */
  private async readPage(url: string, form: NotePageForm, noteId: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<PageOutcome> {
    let current = url;
    for (let hop = 0; hop <= OUTBOUND_MAX_REDIRECTS; hop++) {
      const response = await platformGetText(this.http, { url: current, headers, signal, maxBytes: PLATFORM_PAGE_MAX_BYTES });
      if (response.status === 412 || response.status === 429) {
        return { kind: "refused" };
      }
      if (response.status >= 200 && response.status < 300) {
        const note = notePageDetail(response.text, form, noteId);
        return note === undefined ? { kind: "missing" } : { kind: "note", note };
      }
      if (response.status < 300 || response.status >= 400 || response.location === undefined) {
        return { kind: "missing" };
      }
      let next: URL;
      try {
        next = new URL(response.location);
      } catch {
        return { kind: "missing" };
      }
      if (!PAGE_HOSTS.has(next.hostname.toLowerCase())) {
        throw amberError("network_blocked_by_policy", "a note page redirected off the platform's hosts", { code: "network_blocked_by_policy.redirect" });
      }
      if (LOGIN_PATH.test(next.pathname)) {
        return { kind: "login" };
      }
      if (NOT_FOUND_PATH.test(next.pathname) || parseXiaohongshuUrl(next.toString())?.platformContentId !== noteId) {
        return { kind: "missing" };
      }
      next.protocol = "https:";
      current = next.toString();
    }
    return { kind: "missing" };
  }

  /**
   * The note as a visitor sees it: the mobile share page, then the desktop page when the
   * mobile one does not give the note. Only when both redirect to the login page, and the user
   * stored a login, is the desktop page read once more with it; still redirected, the login is
   * not accepted (`auth_required`, which marks the account expired).
   */
  private async readNote(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PageOutcome> {
    const noteId = ref.platformContentId;
    const params = this.accessParams(ref);
    const mobile = await this.readPage(mobileShareUrl(noteId, params), "mobile", noteId, { "User-Agent": MOBILE_USER_AGENT }, signal);
    if (mobile.kind === "note" || mobile.kind === "refused") {
      return mobile;
    }
    const desktop = await this.readPage(explorePageUrl(noteId, params), "desktop", noteId, {}, signal);
    if (desktop.kind !== "login") {
      return desktop;
    }
    if (mobile.kind !== "login") {
      return { kind: "missing" };
    }
    const cookie = await this.cookieHeader(auth);
    if (cookie === undefined) {
      return desktop;
    }
    const withLogin = await this.readPage(explorePageUrl(noteId, params), "desktop", noteId, { Cookie: cookie }, signal);
    if (withLogin.kind === "login") {
      throw amberError("auth_required", "xiaohongshu still asks for a login with the stored one");
    }
    return withLogin;
  }

  /** The note, or the error its read ended in. */
  private async note(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<NoteDetail> {
    const outcome = await this.readNote(ref, auth, signal);
    switch (outcome.kind) {
      case "note":
        return outcome.note;
      case "login":
        throw amberError("auth_required", "xiaohongshu asks for a login to show the note");
      case "refused":
        throw visitorRefused();
      case "missing":
        throw amberError("source_unreachable", "xiaohongshu did not show the note");
    }
  }

  /** A video note with at least one H.264 stream. */
  private async videoNote(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<NoteDetail> {
    const note = await this.note(ref, auth, signal);
    if (note.type !== "video") {
      throw notVideo();
    }
    if (note.streams.length === 0) {
      throw amberError("source_unreachable", "the note offers no H.264 stream");
    }
    return note;
  }

  /** The tiers a cache can be made in: every H.264 stream of the page, and the untranscoded upload when its header shows H.264. */
  private async videoChoices(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<VideoChoice[]> {
    const note = await this.videoNote(ref, auth, signal);
    const candidates: VideoChoice[] = note.streams.map((stream) => ({
      tier: cacheQualityTier(stream.height, stream.width),
      width: stream.width,
      height: stream.height,
      urls: stream.urls,
      sizeBytes: stream.sizeBytes,
      original: false,
    }));
    if (note.originalUrl !== undefined) {
      const original = await this.probeOriginal(note.originalUrl, signal);
      if (original !== undefined) {
        candidates.push({ ...original, tier: cacheQualityTier(original.height, original.width), urls: [note.originalUrl], original: true });
      }
    }
    return choicesByTier(candidates);
  }

  /** The untranscoded upload's picture size and length from its header, or `undefined` when it cannot be read or is not H.264. */
  private async probeOriginal(url: string, signal: AbortSignal): Promise<{ width: number; height: number; sizeBytes: number } | undefined> {
    const read: Mp4RangeReader = async (start, length) => {
      const { headers, bytes } = await platformGetBytes(this.http, {
        url,
        headers: { Range: `bytes=${start}-${start + length - 1}` },
        signal,
        maxBytes: length,
        redirect: "manual",
      });
      const range = CONTENT_RANGE.exec(headers.get("content-range") ?? "");
      if (range === null || Number(range[1]) !== start) {
        throw amberError("source_unreachable", "the file answered without the requested range");
      }
      return { bytes, totalBytes: Number(range[3]) };
    };
    try {
      const probed = await probeMp4(read, ORIGINAL_PROBE);
      if (probed === undefined || !H264_SAMPLE_ENTRIES.has(probed.track.codec)) {
        return undefined;
      }
      return { width: probed.track.width, height: probed.track.height, sizeBytes: probed.totalBytes };
    } catch (error) {
      if (signal.aborted || !isAmberError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  /** Downloads from the first of `urls` that delivers, trying the next on a failure another address may not have. */
  private async downloadFirst(
    urls: readonly string[],
    request: {
      kind: PlatformMediaKind;
      expectedBytes: number;
      maxBytes: number;
      output: { path: string; scratchDir: string };
      onProgress: (progress: number) => void;
      signal: AbortSignal;
    },
  ): Promise<{ sizeBytes: number }> {
    let failure: unknown = amberError("source_unreachable", "the note offers no stream address");
    for (const url of urls) {
      try {
        const { sizeBytes } = await this.download(this.http, {
          url,
          allowedHosts: XIAOHONGSHU_MEDIA_DOMAINS,
          kind: request.kind,
          expectedBytes: request.expectedBytes,
          maxBytes: request.maxBytes,
          output: request.output,
          onProgress: (received, total) => {
            const size = total ?? request.expectedBytes;
            if (size > 0) {
              request.onProgress(Math.min(1, received / size));
            }
          },
          signal: request.signal,
        });
        return { sizeBytes };
      } catch (error) {
        if (!triesNextAddress(error, request.signal)) {
          throw error;
        }
        failure = error;
      }
    }
    throw failure;
  }
}
