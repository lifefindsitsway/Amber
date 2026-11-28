import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { COLLECTION_PREVIEW_ITEMS_MAX, SHORTLINK_MAX_HOPS } from "../../../../shared/defaults.ts";
import { classifyPlatformDescription } from "../../../domain/content-description.ts";
import { amberError, isAmberError } from "../../../domain/errors.ts";
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
import {
  DOUYIN_IMAGE_HOSTS,
  DOUYIN_MEDIA_HOSTS,
  DOUYIN_PAGE_HOSTS,
  DOUYIN_REFERER,
  DOUYIN_TRUSTED_HOSTS,
  DouyinClient,
  getHop,
  isOnHosts,
  refusedHost,
  statusCheck,
} from "./client.ts";
import {
  audioStreams,
  combinedH264Streams,
  isPlayableVideo,
  listedEntry,
  metadataOf,
  mixCountOf,
  mixTitleOf,
  parseJsonBody,
  qualitiesOf,
  readDetailResponse,
  readMixPage,
  relatedCollectionOf,
  smallestCombined,
  streamFor,
  type DouyinDetail,
  type DouyinStream,
  type MixPage,
} from "./detail.ts";
import { collectionIdOf, normalizeDouyinShortLink, parseDouyinUrl } from "./url.ts";

export interface DouyinAdapterOptions {
  http: OutboundHttpClient;
  /** The platform media downloader; tests stand in for it. */
  download?: PlatformMediaDownload;
  now?: () => number;
}

const DETAIL_PATH = "/aweme/v1/web/aweme/detail/";
const MIX_PATH = "/aweme/v1/web/mix/aweme/";
/**
 * Entries asked for per collection page. Each entry carries its full detail (some 100 KB), so a
 * page stays well below `PLATFORM_JSON_MAX_BYTES` at this size.
 */
const MIX_PAGE_SIZE = 10;
/** Enough pages for the most entries a listing may hold; short or repeated pages cannot extend it. */
const MIX_PAGES_MAX = Math.ceil(COLLECTION_PREVIEW_ITEMS_MAX / MIX_PAGE_SIZE);
const VIDEO_MIME = "video/mp4";
const AWEME_ID = /^\d{15,20}$/;

function notVideo(): Error {
  return amberError("invalid_request", "the post has no playable video stream", { code: "invalid_request.not_video" });
}

function hiddenVideo(): Error {
  return amberError("source_unreachable", "the platform answered without the video's detail");
}

function tierUnavailable(tier: number): Error {
  return amberError("invalid_request", `no stream of the ${tier}P tier is offered`, {
    code: "invalid_request.cache_quality_unavailable",
    params: { quality: String(tier) },
  });
}

/** Failures after which another address of the same file cannot do better. */
function isFinal(error: unknown): boolean {
  return isAmberError(error) && (error.appError.class === "media_too_large" || error.appError.class === "disk_low");
}

/** Runs `work` with a fresh directory beside `target`, removed afterwards whatever happens. */
async function withScratch<T>(target: string, work: (scratchDir: string) => Promise<T>): Promise<T> {
  const scratchDir = await mkdtemp(join(dirname(target), ".douyin-"));
  try {
    return await work(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Douyin videos and collections, read by Amber itself (no yt-dlp) as a visitor: one
 * process-wide visitor session, rebuilt once when the platform refuses a request signature and
 * then cooled down. There is no login. Media and covers come from the platform CDN directly.
 */
export class DouyinAdapter implements PlatformSourceAdapter {
  readonly kind = "douyin" as const;
  readonly trustedHosts: readonly string[] = DOUYIN_TRUSTED_HOSTS;
  protected readonly http: OutboundHttpClient;
  protected readonly download: PlatformMediaDownload;
  protected readonly now: () => number;
  private readonly client: DouyinClient;

  constructor(options: DouyinAdapterOptions) {
    this.http = options.http;
    this.download = options.download ?? downloadPlatformMedia;
    this.now = options.now ?? Date.now;
    this.client = new DouyinClient(this.http, this.now, this.trustedHosts);
  }

  parse(url: string): ParsedPlatformUrl | null {
    return parseDouyinUrl(url);
  }

  /**
   * Walks a `v.douyin.com` short link hop by hop, every hop on the platform's page hosts and
   * read within the page cap, until a hop names a supported page.
   */
  async resolveUrl(url: string, signal: AbortSignal): Promise<string | null> {
    let current = normalizeDouyinShortLink(url);
    if (current === null) {
      return null;
    }
    this.client.assertOpen();
    for (let hop = 0; hop < SHORTLINK_MAX_HOPS; hop++) {
      if (!isOnHosts(current, DOUYIN_PAGE_HOSTS)) {
        return null;
      }
      const answer = await getHop(this.http, current, signal, this.trustedHosts);
      if (answer.status < 300 || answer.status >= 400 || answer.location === undefined) {
        return null;
      }
      const parsed = this.parse(answer.location);
      if (parsed !== null) {
        return parsed.canonicalUrl;
      }
      current = answer.location;
    }
    return null;
  }

  /**
   * One detail read. A refused signature (after the one rebuild) and the cooldown after it are
   * thrown with their own code; every other failure, a hidden video included, is `unverified`.
   */
  async precheck(ref: PlatformContentRef, _auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformImportCheck> {
    let read: Awaited<ReturnType<DouyinAdapter["readDetail"]>>;
    try {
      read = await this.readDetail(ref.platformContentId, signal);
    } catch (error) {
      if (signal.aborted || !isAmberError(error) || error.appError.code === "platform_blocked.access_changed") {
        throw error;
      }
      return { result: "unverified" };
    }
    if (read.kind === "hidden") {
      return { result: "unverified" };
    }
    if (!isPlayableVideo(read.detail)) {
      return { result: "rejected", reason: "not_video" };
    }
    const relatedCollection = relatedCollectionOf(read.detail);
    return { result: "video", metadata: metadataOf(read.detail), ...(relatedCollection === undefined ? {} : { relatedCollection }) };
  }

  async fetchMetadata(ref: PlatformContentRef, _auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformMetadata> {
    return metadataOf(await this.videoDetail(ref, signal));
  }

  /** The same detail request as `fetchMetadata`; an image post still has a description. */
  async fetchDescription(ref: PlatformContentRef, _auth: PlatformCredential | undefined, signal: AbortSignal): Promise<PlatformDescription> {
    const read = await this.readDetail(ref.platformContentId, signal);
    if (read.kind === "hidden") {
      throw hiddenVideo();
    }
    return classifyPlatformDescription(read.detail.desc);
  }

  /** Never offered a track: the metadata lists none, so subtitles come from transcription. */
  async fetchSubtitle(_ref: PlatformContentRef, _track: SubtitleTrackRef, _auth: PlatformCredential | undefined, _signal: AbortSignal): Promise<CanonicalSubtitle> {
    throw amberError("internal", "douyin offers no platform subtitles");
  }

  async listCollection(platformCollectionId: string, _auth: PlatformCredential | undefined, signal: AbortSignal, limit: number): Promise<PlatformCollectionListing> {
    const mixId = collectionIdOf(platformCollectionId);
    if (mixId === null) {
      throw amberError("source_unsupported_url", "not a douyin collection id");
    }
    const cap = Math.max(0, Math.min(limit, COLLECTION_PREVIEW_ITEMS_MAX));
    const listed: MixPage["entries"] = [];
    const seen = new Set<string>();
    let title: string | undefined;
    let reported: number | undefined;
    let cursor = 0;
    let truncated = false;
    for (let page = 0; page < MIX_PAGES_MAX; page++) {
      const answer = await this.client.get(MIX_PATH, [["mix_id", mixId], ["cursor", String(cursor)], ["count", String(MIX_PAGE_SIZE)]], signal);
      statusCheck(answer.status);
      const read = readMixPage(parseJsonBody(answer.text));
      for (const entry of read.entries) {
        if (seen.has(entry.platformContentId)) {
          continue;
        }
        seen.add(entry.platformContentId);
        title ??= mixTitleOf(entry.detail, mixId);
        reported ??= mixCountOf(entry.detail, mixId);
        if (listed.length >= cap) {
          truncated = true;
          break;
        }
        listed.push(entry);
      }
      if (truncated || !read.hasMore) {
        break;
      }
      if (listed.length >= cap || page === MIX_PAGES_MAX - 1) {
        truncated = true;
        break;
      }
      // A cursor that does not move would hand back the same page forever.
      if (read.cursor === undefined || read.cursor <= cursor) {
        break;
      }
      cursor = read.cursor;
    }
    if (listed.length === 0 && !truncated) {
      throw amberError("source_unreachable", "the platform listed nothing for the collection");
    }
    const totalCount = !truncated ? listed.length : reported !== undefined && reported > listed.length ? reported : undefined;
    return {
      title: title ?? platformCollectionId,
      entries: listed.map((entry, index) => listedEntry(index, entry)),
      ...(totalCount === undefined ? {} : { totalCount }),
      truncated,
    };
  }

  /** The listing already carries titles, durations and covers: no request is made. */
  async resolveCollectionEntries(
    _platformCollectionId: string,
    entries: readonly PlatformCollectionEntry[],
    _auth?: PlatformCredential,
    _signal?: AbortSignal,
  ): Promise<PlatformCollectionItem[]> {
    return entries.map(({ index: _index, ...entry }) => entry);
  }

  /** The separate sound stream when there is one, else the smallest combined file for the caller to extract from. */
  async fetchAudio(
    ref: PlatformContentRef,
    _auth: PlatformCredential | undefined,
    output: { path: string },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    options?: { maxBytes?: number },
  ): Promise<{ sizeBytes: number }> {
    const { stream, kind } = this.soundSource(await this.videoDetail(ref, signal));
    const { sizeBytes } = await withScratch(output.path, (scratchDir) =>
      this.downloadStream(stream, kind, { path: output.path, scratchDir }, options?.maxBytes ?? PLATFORM_MEDIA_MAX_BYTES, onProgress, signal),
    );
    return { sizeBytes };
  }

  async inspectAudio(ref: PlatformContentRef, _auth: PlatformCredential | undefined, signal: AbortSignal): Promise<{ sizeBytes?: number }> {
    const { stream } = this.soundSource(await this.videoDetail(ref, signal));
    return stream.sizeBytes === undefined ? {} : { sizeBytes: stream.sizeBytes };
  }

  async listVideoQualities(ref: PlatformContentRef, _auth: PlatformCredential | undefined, signal: AbortSignal): Promise<VideoQuality[] | undefined> {
    return qualitiesOf(await this.videoDetail(ref, signal));
  }

  async inspectVideo(
    ref: PlatformContentRef,
    _auth: PlatformCredential | undefined,
    target: VideoTarget,
    signal: AbortSignal,
  ): Promise<{ hasVideo: false } | { hasVideo: true; mimeType: string; sizeBytes?: number; height?: number; width?: number }> {
    const stream = this.videoStream(await this.videoDetail(ref, signal), target);
    return {
      hasVideo: true,
      mimeType: VIDEO_MIME,
      ...(stream.sizeBytes === undefined ? {} : { sizeBytes: stream.sizeBytes }),
      ...(stream.height === undefined ? {} : { height: stream.height }),
      ...(stream.width === undefined ? {} : { width: stream.width }),
    };
  }

  /** Only combined H.264 MP4 streams are cached; the tier is selected again from a fresh detail read. */
  async fetchVideo(
    ref: PlatformContentRef,
    _auth: PlatformCredential | undefined,
    options: VideoTarget & { maxBytes: number; output: { path: string; scratchDir: string } },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number; mimeType: string; height?: number; acquisition: "guest" | "authenticated" }> {
    const target: VideoTarget = "tier" in options ? { tier: options.tier } : { maxHeight: options.maxHeight };
    const stream = this.videoStream(await this.videoDetail(ref, signal), target);
    const result = await this.downloadStream(stream, "video", options.output, options.maxBytes, onProgress, signal);
    return {
      sizeBytes: result.sizeBytes,
      mimeType: result.mimeType.startsWith("video/") ? result.mimeType : VIDEO_MIME,
      ...(stream.height === undefined ? {} : { height: stream.height }),
      acquisition: "guest",
    };
  }

  /** Only an https cover on the platform's image hosts is fetched, without any cookie. */
  async fetchCover(coverUrl: string, output: { path: string }, options: { maxBytes: number }, signal: AbortSignal): Promise<{ sizeBytes: number }> {
    if (!isOnHosts(coverUrl, DOUYIN_IMAGE_HOSTS)) {
      throw refusedHost();
    }
    const { sizeBytes } = await withScratch(output.path, (scratchDir) =>
      this.download(this.http, {
        url: coverUrl,
        allowedHosts: DOUYIN_IMAGE_HOSTS,
        trustedHosts: this.trustedHosts,
        kind: "image",
        maxBytes: options.maxBytes,
        output: { path: output.path, scratchDir },
        signal,
      }),
    );
    return { sizeBytes };
  }

  /** The detail answer, `hidden` when the platform gave none. */
  private async readDetail(platformContentId: string, signal: AbortSignal): Promise<ReturnType<typeof readDetailResponse>> {
    if (!AWEME_ID.test(platformContentId)) {
      throw amberError("source_unsupported_url", "not a douyin video id");
    }
    const answer = await this.client.get(DETAIL_PATH, [["aweme_id", platformContentId]], signal);
    statusCheck(answer.status);
    return readDetailResponse(parseJsonBody(answer.text));
  }

  /** The detail of a playable video; a hidden one is unreachable and an image post is not a video. */
  private async videoDetail(ref: PlatformContentRef, signal: AbortSignal): Promise<DouyinDetail> {
    const read = await this.readDetail(ref.platformContentId, signal);
    if (read.kind === "hidden") {
      throw hiddenVideo();
    }
    if (!isPlayableVideo(read.detail)) {
      throw notVideo();
    }
    return read.detail;
  }

  private soundSource(detail: DouyinDetail): { stream: DouyinStream; kind: PlatformMediaKind } {
    const [audio] = audioStreams(detail);
    if (audio !== undefined) {
      return { stream: audio, kind: "audio" };
    }
    const combined = smallestCombined(detail);
    if (combined === undefined) {
      throw notVideo();
    }
    return { stream: combined, kind: "video" };
  }

  /**
   * The stream for `target`. An exact tier no longer offered is refused, never swapped for
   * another; a height cap takes the best tier within it, else the lowest there is, else (no
   * stream states its picture size) the combined stream of the highest bitrate.
   */
  private videoStream(detail: DouyinDetail, target: VideoTarget): DouyinStream {
    const picked = streamFor(detail, target);
    if (picked !== undefined) {
      return picked;
    }
    if ("tier" in target) {
      throw tierUnavailable(target.tier);
    }
    const [best] = combinedH264Streams(detail).sort((a, b) => b.bitRate - a.bitRate);
    if (best === undefined) {
      throw notVideo();
    }
    return best;
  }

  /**
   * Downloads one file from the first of its addresses on the media hosts that works, without
   * cookies; addresses elsewhere are skipped. A size or disk failure, or a cancellation, ends it
   * at once; other failures move on to the next address, the last one's failure is reported.
   */
  private async downloadStream(
    stream: DouyinStream,
    kind: PlatformMediaKind,
    output: { path: string; scratchDir: string },
    maxBytes: number,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number; mimeType: string }> {
    const urls = stream.urls.filter((url) => isOnHosts(url, DOUYIN_MEDIA_HOSTS));
    let failure: unknown = refusedHost();
    for (const url of urls) {
      try {
        return await this.download(this.http, {
          url,
          allowedHosts: DOUYIN_MEDIA_HOSTS,
          trustedHosts: this.trustedHosts,
          headers: { Referer: DOUYIN_REFERER },
          kind,
          ...(stream.sizeBytes === undefined ? {} : { expectedBytes: stream.sizeBytes }),
          maxBytes,
          output,
          onProgress: (received, total) => {
            const size = total ?? stream.sizeBytes;
            if (size !== undefined && size > 0) {
              onProgress(Math.min(1, received / size));
            }
          },
          signal,
        });
      } catch (error) {
        if (signal.aborted || isFinal(error)) {
          throw error;
        }
        failure = error;
      }
    }
    throw failure;
  }
}
