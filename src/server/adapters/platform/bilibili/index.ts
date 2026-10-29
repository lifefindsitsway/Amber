import { PLATFORM_METADATA_TIMEOUT_MS, SHORTLINK_MAX_HOPS } from "../../../../shared/defaults.ts";
import { amberError } from "../../../domain/errors.ts";
import { cookieHeaderFor, parseNetscapeCookies } from "../../../domain/platform-cookie.ts";
import type { OutboundHttpClient } from "../../../ports/outbound-http.ts";
import type {
  CanonicalSubtitle,
  ParsedPlatformUrl,
  PlatformCollection,
  PlatformContentRef,
  PlatformCredential,
  PlatformMetadata,
  PlatformPart,
  PlatformSourceAdapter,
  SubtitleTrackRef,
  VideoQuality,
  VideoTarget,
} from "../../../ports/platform-source.ts";
import { platformGet, platformGetJson } from "../http.ts";
import { downloadAudio, downloadVideo, inspectAudio, inspectVideo, languageTag, listVideoQualities, secondsToMs, videoTargetOf, type YtDlpChapter } from "../shared.ts";
import type { YtDlp } from "../yt-dlp.ts";
import { collectionUrl, isShortLink, parseBilibiliUrl, videoUrl } from "./url.ts";

/** IE_NAMEs of the pinned yt-dlp that handle the URLs `parse` accepts. */
export const BILIBILI_EXTRACTORS = ["bilibili", "bilibilicollectionlist", "bilibiliserieslist"] as const;
const API = "https://api.bilibili.com";
/** Where a bilibili login lives; cookies of other sites never enter its Secret. */
export const BILIBILI_COOKIE_DOMAINS = ["bilibili.com"] as const;
const REFERER = { Referer: "https://www.bilibili.com/" };

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
}

interface FlatPlaylist {
  title?: string;
  entries?: Array<{ id?: string; url?: string }>;
}

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
    const envelope = await this.api<PageEntry[]>(`/x/player/pagelist?bvid=${encodeURIComponent(ref.platformContentId)}`, auth, signal);
    const pages = envelope ?? [];
    if (pages.length === 0) {
      throw amberError("source_unreachable", "bilibili returned no parts");
    }
    return pages.map((page) => ({
      platformPartId: String(page.cid),
      index: page.page,
      title: (page.part ?? "").trim(),
      durationMs: secondsToMs(page.duration ?? 0),
      canonicalUrl: videoUrl(ref.platformContentId, pages.length > 1 ? page.page : undefined),
    }));
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
    };
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

  async fetchCollection(platformCollectionId: string, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformCollection> {
    const url = collectionUrl(platformCollectionId);
    if (url === null) {
      throw new TypeError("not a bilibili collection id");
    }
    const cookies = await auth?.cookies();
    const playlist = await this.options.ytDlp.json<FlatPlaylist>({
      args: ["--dump-single-json", "--flat-playlist", url],
      extractors: BILIBILI_EXTRACTORS,
      ...(cookies === undefined ? {} : { cookies }),
      signal,
      timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
    });
    const items = [];
    for (const entry of playlist.entries ?? []) {
      const bvid = this.parse(entry.url ?? "")?.platformContentId ?? entry.id;
      if (bvid === undefined) {
        continue;
      }
      // A multi-part submission inside a collection contributes its first part only:
      // importing every part would start paid work nobody chose.
      const [first] = await this.resolveParts({ platformContentId: bvid }, auth, signal);
      if (first === undefined) {
        continue;
      }
      items.push({
        platformContentId: bvid,
        platformPartId: first.platformPartId,
        ...(first.title === "" ? {} : { title: first.title }),
        durationMs: first.durationMs,
        canonicalUrl: first.canonicalUrl,
      });
    }
    return { title: playlist.title ?? platformCollectionId, items };
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

  /** The part a Content refers to, located by cid because part numbers shift when parts are reordered. */
  private async part(ref: PlatformContentRef, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformPart> {
    const parts = await this.resolveParts(ref, auth, signal);
    const part = ref.platformPartId === undefined ? parts[0] : parts.find((candidate) => candidate.platformPartId === ref.platformPartId);
    if (part === undefined) {
      throw amberError("source_unreachable", "the part no longer exists in this submission");
    }
    return part;
  }

  private async api<T>(path: string, auth: PlatformCredential | undefined, signal: AbortSignal): Promise<T | undefined> {
    const envelope = await platformGetJson<ApiEnvelope<T>>(this.options.http, {
      url: `${API}${path}`,
      headers: { ...REFERER, ...(auth === undefined ? {} : await this.cookieHeader(auth, "api.bilibili.com")) },
      signal,
    });
    if (envelope.code !== 0) {
      throw apiError(envelope.code);
    }
    return envelope.data;
  }

  private async cookieHeader(auth: PlatformCredential, host: string): Promise<Record<string, string>> {
    const header = cookieHeaderFor(parseNetscapeCookies(await auth.cookies()), host, this.now());
    return header === "" ? {} : { Cookie: header };
  }
}
