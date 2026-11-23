import { PLATFORM_COLLECTION_RESOLVE_CONCURRENCY, PLATFORM_METADATA_TIMEOUT_MS, SHORTLINK_MAX_HOPS } from "../../../../shared/defaults.ts";
import { classifyPlatformDescription } from "../../../domain/content-description.ts";
import { amberError } from "../../../domain/errors.ts";
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
  PlatformEntryUnavailableReason,
  PlatformMetadata,
  PlatformPart,
  PlatformSourceAdapter,
  SubtitleTrackRef,
  VideoQuality,
  VideoTarget,
} from "../../../ports/platform-source.ts";
import type { DanmakuItem } from "../../../../shared/dto/danmaku.ts";
import { platformGet, platformGetJson } from "../http.ts";
import {
  downloadAudio,
  downloadVideo,
  inspectAudio,
  inspectVideo,
  languageTag,
  listVideoQualities,
  mapConcurrent,
  playlistItemsUpTo,
  secondsToMs,
  trustedImageUrl,
  videoTargetOf,
  type YtDlpChapter,
} from "../shared.ts";
import type { YtDlp } from "../yt-dlp.ts";
import { fetchBilibiliDanmaku } from "./danmaku.ts";
import { collectionUrl, isShortLink, parseBilibiliUrl, seasonOf, videoUrl } from "./url.ts";

/** IE_NAMEs of the pinned yt-dlp that handle the URLs `parse` accepts. */
export const BILIBILI_EXTRACTORS = ["bilibili", "bilibilicollectionlist", "bilibiliserieslist"] as const;
const API = "https://api.bilibili.com";
/** Where a bilibili login lives; cookies of other sites never enter its Secret. */
export const BILIBILI_COOKIE_DOMAINS = ["bilibili.com"] as const;
const REFERER = { Referer: "https://www.bilibili.com/" };
/** Hosts bilibili serves covers from (`i0.hdslb.com` and the like, `archive.biliimg.com`), subdomains included. */
export const BILIBILI_IMAGE_DOMAINS = ["hdslb.com", "biliimg.com"] as const;
/** Submissions per page asked of the season archive list. */
const SEASON_PAGE_SIZE = 100;
/** What bilibili shows (and yt-dlp passes on) for a video whose uploader wrote no description. */
const EMPTY_DESCRIPTIONS = ["-"] as const;

export interface BilibiliAdapterOptions {
  ytDlp: YtDlp;
  http: OutboundHttpClient;
  now?: () => number;
}

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

interface PageEntry {
  cid: number;
  page: number;
  part?: string;
  duration?: number;
}

interface PlayerInfo {
  need_login_subtitle?: boolean;
  subtitle?: { subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string; type?: number; ai_type?: number }> };
}

interface VideoInfo {
  title?: string;
  duration?: number;
  thumbnail?: string;
  timestamp?: number;
  uploader?: string;
  uploader_id?: string | number;
  chapters?: YtDlpChapter[] | null;
  /**
   * Read only at the top level of the document: for an interactive video yt-dlp also
   * returns entries whose descriptions carry extra JSON in front of the text.
   */
  description?: unknown;
}

interface FlatPlaylist {
  title?: string;
  entries?: Array<{ id?: string; url?: string }>;
}

/** One submission of a 合集 as its archive list gives it; `duration` is the whole submission's and is not read. */
interface SeasonArchive {
  bvid?: string;
  title?: string;
  pic?: string;
}

interface SeasonArchives {
  archives?: SeasonArchive[];
  page?: { total?: number };
}

/** One page of a 合集's archive list: the season's submissions with their titles and covers, guest-readable. */
function seasonArchivesPath(season: { mid: string; seasonId: string }, page: number): string {
  return `/x/polymer/web-space/seasons_archives_list?mid=${season.mid}&season_id=${season.seasonId}&page_num=${page}&page_size=${SEASON_PAGE_SIZE}`;
}

/**
 * What a collection entry's part list answering one of these codes means: the submission is
 * gone (-404) or not open to this viewer (-403). Any other code fails the whole resolution.
 */
const UNAVAILABLE_PART_LIST_CODES: ReadonlyMap<number, PlatformEntryUnavailableReason> = new Map([
  [-404, "removed"],
  [-403, "private"],
]);

/** An API error code: -101 not logged in, -352 / -412 risk control, -404 gone, -403 no access. */
export function apiError(code: number): Error {
  if (code === -412 || code === -352 || code === -509) {
    return amberError("platform_blocked", `bilibili api code ${code}`);
  }
  if (code === -101 || code === -403) {
    return amberError("auth_required", `bilibili api code ${code}`);
  }
  return amberError("source_unreachable", `bilibili api code ${code}`);
}

function pageListPath(bvid: string): string {
  return `/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
}

/** A submission's parts from its part list; a list without parts is a failure. */
function partsOf(bvid: string, data: PageEntry[] | undefined): PlatformPart[] {
  const pages = data ?? [];
  if (pages.length === 0) {
    throw amberError("source_unreachable", "bilibili returned no parts");
  }
  return pages.map((page) => ({
    platformPartId: String(page.cid),
    index: page.page,
    title: (page.part ?? "").trim(),
    durationMs: secondsToMs(page.duration ?? 0),
    canonicalUrl: videoUrl(bvid, pages.length > 1 ? page.page : undefined),
  }));
}

function https(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url.replace(/^http:/, "https:");
}

/**
 * `PlatformSourceAdapter` for bilibili. yt-dlp's info dict does
 * not carry the part id (cid), so parts come from `x/player/pagelist`; the subtitle list
 * (login only) from `x/player/wbi/v2`, and subtitle bodies are fetched from their signed
 * URLs. Title, duration, cover, date and chapters come from `yt-dlp -J`, which does not
 * fetch subtitles unless asked. A login is used whenever the user has one.
 */
export class BilibiliAdapter implements PlatformSourceAdapter {
  readonly kind = "bilibili" as const;
  readonly cookieDomains = BILIBILI_COOKIE_DOMAINS;
  private readonly options: BilibiliAdapterOptions;
  private readonly now: () => number;

  constructor(options: BilibiliAdapterOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  parse(url: string): ParsedPlatformUrl | null {
    return parseBilibiliUrl(url);
  }

  async resolveUrl(url: string, signal: AbortSignal): Promise<string | null> {
    let current = url.trim();
    for (let hop = 0; hop < SHORTLINK_MAX_HOPS; hop++) {
      if (!isShortLink(current)) {
        return null;
      }
      const response = await platformGet(this.options.http, { url: current, signal });
      await response.text();
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || location === undefined) {
        return null;
      }
      const next = new URL(location, current).toString();
      const parsed = this.parse(next);
      if (parsed !== null) {
        return parsed.canonicalUrl;
      }
      current = next;
    }
    return null;
  }

  async resolveParts(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformPart[]> {
    const envelope = await this.envelope<PageEntry[]>(pageListPath(ref.platformContentId), auth, signal);
    if (envelope.code !== 0) {
      throw apiError(envelope.code);
    }
    return partsOf(ref.platformContentId, envelope.data);
  }

  async fetchMetadata(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformMetadata> {
    const part = await this.part(ref, auth, signal);
    const cookies = await auth?.cookies();
    const info = await this.options.ytDlp.json<VideoInfo>({
      args: ["--dump-single-json", "--skip-download", "--no-playlist", part.canonicalUrl],
      extractors: BILIBILI_EXTRACTORS,
      ...(cookies === undefined ? {} : { cookies }),
      signal,
      timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
    });
    const player = await this.api<PlayerInfo>(
      `/x/player/wbi/v2?bvid=${encodeURIComponent(ref.platformContentId)}&cid=${encodeURIComponent(part.platformPartId)}`,
      auth,
      signal,
    );
    const tracks: SubtitleTrackRef[] = [];
    for (const subtitle of player?.subtitle?.subtitles ?? []) {
      if (subtitle.lan === undefined || subtitle.subtitle_url === undefined || subtitle.subtitle_url === "") {
        continue;
      }
      const ai = subtitle.lan.startsWith("ai-") || subtitle.type === 1;
      tracks.push({
        locator: https(subtitle.subtitle_url),
        language: languageTag(subtitle.lan.replace(/^ai-/, "")),
        ...(subtitle.lan_doc === undefined ? {} : { label: subtitle.lan_doc }),
        autoGenerated: ai,
        translated: subtitle.ai_type === 1,
      });
    }
    const durationMs = secondsToMs(info.duration ?? 0) || part.durationMs;
    return {
      title: info.title ?? part.title,
      durationMs,
      ...(info.thumbnail === undefined ? {} : { coverUrl: https(info.thumbnail) }),
      ...(info.timestamp === undefined ? {} : { publishedAt: info.timestamp * 1000 }),
      ...(info.uploader_id === undefined ? {} : { channelId: String(info.uploader_id) }),
      ...(info.uploader === undefined ? {} : { channelTitle: info.uploader }),
      chapters: (info.chapters ?? []).map((chapter) => ({
        startMs: secondsToMs(chapter.start_time),
        ...(chapter.end_time === undefined ? {} : { endMs: secondsToMs(chapter.end_time) }),
        title: chapter.title ?? "",
      })),
      subtitleTracks: tracks,
      description: classifyPlatformDescription(info.description, EMPTY_DESCRIPTIONS),
    };
  }

  /**
   * One metadata read of the submission's BV URL without `p=`: the description belongs to
   * the whole submission and is the same for every part. No subtitle list is asked for;
   * the login is used whenever the user has one, as for every other bilibili call.
   */
  async fetchDescription(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformDescription> {
    const url = videoUrl(ref.platformContentId);
    // Only a URL `parse` accepts reaches yt-dlp.
    if (this.parse(url)?.platformContentId !== ref.platformContentId) {
      throw new TypeError("not a bilibili video id");
    }
    const cookies = await auth?.cookies();
    const info = await this.options.ytDlp.json<Pick<VideoInfo, "description"> | null>({
      args: ["--dump-single-json", "--skip-download", "--no-playlist", url],
      extractors: BILIBILI_EXTRACTORS,
      ...(cookies === undefined ? {} : { cookies }),
      signal,
      timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
    });
    return classifyPlatformDescription(info?.description, EMPTY_DESCRIPTIONS);
  }

  async fetchSubtitle(
    _ref: PlatformContentRef,
    track: SubtitleTrackRef,
    auth: PlatformCredential | undefined,
    signal: AbortSignal,
  ): Promise<CanonicalSubtitle> {
    // The signed URL carries its own authorization; no cookie goes to the subtitle host.
    const body = await platformGetJson<{ body?: Array<{ from?: number; to?: number; content?: string }> }>(this.options.http, {
      url: track.locator,
      headers: REFERER,
      signal,
    });
    return {
      language: track.language,
      cues: (body.body ?? []).map((line) => ({
        startMs: secondsToMs(line.from ?? Number.NaN),
        endMs: secondsToMs(line.to ?? Number.NaN),
        text: line.content ?? "",
      })),
      acquisition: auth === undefined ? "guest" : "authenticated",
    };
  }

  async checkCredential(auth: PlatformCredential, signal: AbortSignal): Promise<"valid" | "expired" | "unknown"> {
    try {
      const response = await platformGetJson<ApiEnvelope<{ isLogin?: boolean }>>(this.options.http, {
        url: `${API}/x/web-interface/nav`,
        headers: { ...REFERER, ...(await this.cookieHeader(auth, "api.bilibili.com")) },
        signal,
      });
      if (response.data?.isLogin === true) {
        return "valid";
      }
      return response.code === -101 || response.data?.isLogin === false ? "expired" : "unknown";
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      return "unknown";
    }
  }

  /**
   * The collection's video ids in order, from one flat yt-dlp listing stopped one entry past
   * `limit`. That listing carries no total, so a truncated 合集 asks the season archive list
   * for it; a 列表 (series) leaves it unknown.
   */
  async listCollection(platformCollectionId: string, auth: PlatformCredential | undefined, signal: AbortSignal, limit: number): Promise<PlatformCollectionListing> {
    const url = collectionUrl(platformCollectionId);
    if (url === null) {
      throw new TypeError("not a bilibili collection id");
    }
    const cookies = await auth?.cookies();
    const playlist = await this.options.ytDlp.json<FlatPlaylist>({
      args: ["--dump-single-json", "--flat-playlist", "--playlist-items", playlistItemsUpTo(limit), url],
      extractors: BILIBILI_EXTRACTORS,
      ...(cookies === undefined ? {} : { cookies }),
      signal,
      timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
    });
    const listed: string[] = [];
    for (const entry of playlist.entries ?? []) {
      const bvid = this.parse(entry.url ?? "")?.platformContentId ?? entry.id;
      // Only an id that makes a URL `parse` accepts is passed on; a repeat keeps its first place.
      if (bvid !== undefined && this.parse(videoUrl(bvid))?.platformContentId === bvid && !listed.includes(bvid)) {
        listed.push(bvid);
      }
    }
    const truncated = listed.length > limit;
    const entries = listed.slice(0, limit).map((bvid, index) => ({ index, platformContentId: bvid, canonicalUrl: videoUrl(bvid) }));
    const totalCount = truncated ? await this.seasonTotal(platformCollectionId, auth, signal) : entries.length;
    return { title: playlist.title ?? platformCollectionId, entries, ...(totalCount === undefined ? {} : { totalCount }), truncated };
  }

  /**
   * The first part of each entry, from its part list, a few entries at a time: the part id is
   * the Content identity. A multi-part submission contributes its first part only, since
   * importing every part would start paid work nobody chose. The season archive list adds
   * each submission's own title and cover, matched by video id because its paging need not
   * line up with the listing; whatever it does not give falls back to the first part.
   * A submission's total duration is never used: only its first part is imported. An entry
   * whose part list says the submission is gone or closed comes back `unavailable`, with
   * neither part, title nor duration.
   */
  async resolveCollectionEntries(
    platformCollectionId: string,
    entries: readonly PlatformCollectionEntry[],
    auth: PlatformCredential | undefined,
    signal: AbortSignal,
  ): Promise<PlatformCollectionItem[]> {
    if (collectionUrl(platformCollectionId) === null) {
      throw new TypeError("not a bilibili collection id");
    }
    const archives = this.seasonArchives(platformCollectionId, entries, auth, signal);
    let parts: Array<PlatformPart[] | PlatformEntryUnavailableReason>;
    try {
      parts = await mapConcurrent(entries, PLATFORM_COLLECTION_RESOLVE_CONCURRENCY, (entry) => this.entryParts(entry.platformContentId, auth, signal));
    } catch (error) {
      await archives;
      throw error;
    }
    const byBvid = await archives;
    return entries.map((entry, index) => {
      const submission = parts[index] as PlatformPart[] | PlatformEntryUnavailableReason;
      if (typeof submission === "string") {
        // Nothing of its own is shown for an entry that cannot be imported, not even what the season list may still say.
        return { platformContentId: entry.platformContentId, canonicalUrl: videoUrl(entry.platformContentId), unavailable: submission };
      }
      const first = submission[0] as PlatformPart;
      const archive = byBvid.get(entry.platformContentId);
      const archiveTitle = archive?.title?.trim() || undefined;
      const partTitle = first.title === "" ? undefined : first.title;
      // A single part is the submission itself, so it takes the submission's title; one part of
      // several keeps its own until the source stage reads the platform's metadata.
      const title = submission.length === 1 ? (archiveTitle ?? partTitle) : partTitle;
      const displayTitle = archiveTitle ?? partTitle;
      const coverUrl = typeof archive?.pic === "string" ? trustedImageUrl(https(archive.pic), BILIBILI_IMAGE_DOMAINS) : undefined;
      return {
        platformContentId: entry.platformContentId,
        platformPartId: first.platformPartId,
        canonicalUrl: first.canonicalUrl,
        ...(title === undefined ? {} : { title }),
        ...(displayTitle === undefined || displayTitle === title ? {} : { displayTitle }),
        durationMs: first.durationMs,
        ...(coverUrl === undefined ? {} : { coverUrl }),
        partCount: submission.length,
      };
    });
  }

  async fetchAudio(
    ref: PlatformContentRef,
    auth: PlatformCredential | undefined,
    output: { path: string },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    options?: { maxBytes?: number },
  ): Promise<{ sizeBytes: number }> {
    const part = await this.part(ref, auth, signal);
    const cookies = await auth?.cookies();
    return downloadAudio(this.options.ytDlp, {
      url: part.canonicalUrl,
      extractors: BILIBILI_EXTRACTORS,
      ...(cookies === undefined ? {} : { cookies }),
      output,
      onProgress,
      signal,
      ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
  }

  /** What an audio cache of the part would download, with the login whenever the user has one. */
  async inspectAudio(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<{ sizeBytes?: number }> {
    const part = await this.part(ref, auth, signal);
    const cookies = await auth?.cookies();
    return inspectAudio(this.options.ytDlp, { url: part.canonicalUrl, extractors: BILIBILI_EXTRACTORS, ...(cookies === undefined ? {} : { cookies }), signal });
  }

  /** What a video cache of the part would download, with the login whenever the user has one. */
  async inspectVideo(
    ref: PlatformContentRef,
    auth: PlatformCredential | undefined,
    target: VideoTarget,
    signal: AbortSignal,
  ): Promise<{ hasVideo: false } | { hasVideo: true; mimeType: string; sizeBytes?: number; height?: number; width?: number }> {
    const part = await this.part(ref, auth, signal);
    const cookies = await auth?.cookies();
    return inspectVideo(this.options.ytDlp, {
      url: part.canonicalUrl,
      extractors: BILIBILI_EXTRACTORS,
      ...(cookies === undefined ? {} : { cookies }),
      target,
      signal,
    });
  }

  /** The quality tiers a video cache of the part can be made in, with the login whenever the user has one, as the download would use. */
  async listVideoQualities(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<VideoQuality[] | undefined> {
    const part = await this.part(ref, auth, signal);
    const cookies = await auth?.cookies();
    return listVideoQualities(this.options.ytDlp, { url: part.canonicalUrl, extractors: BILIBILI_EXTRACTORS, ...(cookies === undefined ? {} : { cookies }), signal });
  }

  /** The part's video for `cache_media`, with the login whenever the user has one, like every other bilibili call. */
  async fetchVideo(
    ref: PlatformContentRef,
    auth: PlatformCredential | undefined,
    options: VideoTarget & { maxBytes: number; output: { path: string; scratchDir: string } },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number; mimeType: string; height?: number; acquisition: "guest" | "authenticated" }> {
    const part = await this.part(ref, auth, signal);
    const cookies = await auth?.cookies();
    const video = await downloadVideo(this.options.ytDlp, {
      url: part.canonicalUrl,
      extractors: BILIBILI_EXTRACTORS,
      ...(cookies === undefined ? {} : { cookies }),
      target: videoTargetOf(options),
      maxBytes: options.maxBytes,
      output: options.output,
      onProgress,
      signal,
    });
    return { ...video, acquisition: cookies === undefined ? "guest" : "authenticated" };
  }

  /**
   * The part's danmaku in one anonymous request to the danmaku list of its cid. Takes no
   * credential: the login is never read and no cookie is sent, so a failure is never retried
   * with one. A Content without a cid has no part to ask for.
   */
  async fetchDanmaku(ref: PlatformContentRef, signal: AbortSignal): Promise<{ items: DanmakuItem[]; truncated: boolean }> {
    if (ref.platformPartId === undefined) {
      throw new TypeError("danmaku needs the part id");
    }
    return fetchBilibiliDanmaku(this.options.http, ref.platformPartId, signal);
  }

  /**
   * One collection entry's parts, or why the platform will not give them: a submission that
   * is gone or closed to this viewer is one unavailable entry, not a failed collection.
   * Network errors, risk control and every other code still fail the whole resolution.
   */
  private async entryParts(bvid: string, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformPart[] | PlatformEntryUnavailableReason> {
    const envelope = await this.envelope<PageEntry[]>(pageListPath(bvid), auth, signal);
    const unavailable = UNAVAILABLE_PART_LIST_CODES.get(envelope.code);
    if (unavailable !== undefined) {
      return unavailable;
    }
    if (envelope.code !== 0) {
      throw apiError(envelope.code);
    }
    return partsOf(bvid, envelope.data);
  }

  /** The part a Content refers to, located by cid because part numbers shift when parts are reordered. */
  private async part(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformPart> {
    const parts = await this.resolveParts(ref, auth, signal);
    const part = ref.platformPartId === undefined ? parts[0] : parts.find((candidate) => candidate.platformPartId === ref.platformPartId);
    if (part === undefined) {
      throw amberError("source_unreachable", "the part no longer exists in this submission");
    }
    return part;
  }

  /**
   * Submissions of the season archive list pages that hold `entries`, by video id; empty for
   * a 列表 (series). Never fails: a page that does not answer only leaves its entries
   * without the submission's title and cover.
   */
  private async seasonArchives(
    platformCollectionId: string,
    entries: readonly PlatformCollectionEntry[],
    auth: PlatformCredential | undefined,
    signal: AbortSignal,
  ): Promise<Map<string, SeasonArchive>> {
    const byBvid = new Map<string, SeasonArchive>();
    const season = seasonOf(platformCollectionId);
    if (season === null) {
      return byBvid;
    }
    const pages = [...new Set(entries.map((entry) => Math.floor(entry.index / SEASON_PAGE_SIZE) + 1))];
    for (const page of pages) {
      if (signal.aborted) {
        break;
      }
      try {
        const data = await this.api<SeasonArchives>(seasonArchivesPath(season, page), auth, signal);
        for (const archive of data?.archives ?? []) {
          if (typeof archive.bvid === "string" && !byBvid.has(archive.bvid)) {
            byBvid.set(archive.bvid, archive);
          }
        }
      } catch {
        // Decoration only: the entries keep what their part lists said.
      }
    }
    return byBvid;
  }

  /** How many entries a 合集 has, from the first page of its archive list; `undefined` when unknown. */
  private async seasonTotal(platformCollectionId: string, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<number | undefined> {
    const season = seasonOf(platformCollectionId);
    if (season === null) {
      return undefined;
    }
    try {
      const total = (await this.api<SeasonArchives>(seasonArchivesPath(season, 1), auth, signal))?.page?.total;
      return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : undefined;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      return undefined;
    }
  }

  private async api<T>(path: string, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<T | undefined> {
    const envelope = await this.envelope<T>(path, auth, signal);
    if (envelope.code !== 0) {
      throw apiError(envelope.code);
    }
    return envelope.data;
  }

  private async envelope<T>(path: string, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<ApiEnvelope<T>> {
    return platformGetJson<ApiEnvelope<T>>(this.options.http, {
      url: `${API}${path}`,
      headers: { ...REFERER, ...(auth === undefined ? {} : await this.cookieHeader(auth, "api.bilibili.com")) },
      signal,
    });
  }

  private async cookieHeader(auth: PlatformCredential, host: string): Promise<Record<string, string>> {
    const header = cookieHeaderFor(parseNetscapeCookies(await auth.cookies()), host, this.now());
    return header === "" ? {} : { Cookie: header };
  }
}
