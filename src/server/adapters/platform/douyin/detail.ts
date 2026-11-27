import { z } from "zod";
import { cacheQualityTier } from "../../../../shared/cache-file-name.ts";
import { PLATFORM_TITLE_MAX_CHARS } from "../../../../shared/defaults.ts";
import { capDescription, classifyPlatformDescription, normalizeDescription } from "../../../domain/content-description.ts";
import { amberError } from "../../../domain/errors.ts";
import type {
  PlatformChapter,
  PlatformCollectionEntry,
  PlatformEntryUnavailableReason,
  PlatformMetadata,
  PlatformRelatedCollection,
  VideoQuality,
} from "../../../ports/platform-source.ts";
import { DOUYIN_IMAGE_HOSTS, isOnHosts } from "./client.ts";
import { collectionCanonicalUrl, collectionIdOf, videoUrl } from "./url.ts";

/*
 * Only the fields Amber uses are declared; the platform sends many more, which are dropped.
 * A declared field of the wrong type fails the read: nothing half-understood is stored.
 */

const flag = z.union([z.number(), z.boolean()]).nullish();
const count = z.number().nullish();
const text = z.string().nullish();

const imageSchema = z.object({ url_list: z.array(z.string()).nullish() }).nullish();

const playAddrSchema = z
  .object({
    url_list: z.array(z.string()).nullish(),
    width: count,
    height: count,
    data_size: count,
    url_key: text,
  })
  .nullish();

const bitRateSchema = z.object({
  gear_name: text,
  bit_rate: count,
  /** `mp4`: picture and sound in one file; `dash`: the picture alone. */
  format: text,
  is_h265: flag,
  is_bytevc1: flag,
  play_addr: playAddrSchema,
});

const audioSchema = z.object({
  audio_meta: z
    .object({
      url_list: z.object({ main_url: text, backup_url: text, fallback_url: text }).nullish(),
      size: count,
      bitrate: count,
    })
    .nullish(),
});

const detailSchema = z.object({
  aweme_id: z.string().regex(/^\d{1,20}$/),
  item_title: text,
  desc: text,
  duration: count,
  create_time: count,
  author: z.object({ nickname: text, sec_uid: text }).nullish(),
  video: z
    .object({
      duration: count,
      cover: imageSchema,
      origin_cover: imageSchema,
      bit_rate: z.array(bitRateSchema).nullish(),
      bit_rate_audio: z.array(audioSchema).nullish(),
    })
    .nullish(),
  images: z.array(z.unknown()).nullish(),
  chapter_list: z.array(z.object({ desc: text, timestamp: count })).nullish(),
  mix_info: z
    .object({
      mix_id: text,
      mix_name: text,
      statis: z.object({ current_episode: count, updated_to_episode: count }).nullish(),
    })
    .nullish(),
  status: z.object({ is_delete: flag, is_prohibited: flag, private_status: count }).nullish(),
});

export type DouyinDetail = z.infer<typeof detailSchema>;

const detailResponseSchema = z.object({
  status_code: count,
  aweme_detail: z.unknown().optional(),
});

const mixPageSchema = z.object({
  status_code: count,
  aweme_list: z.array(z.unknown()).nullish(),
  cursor: count,
  has_more: flag,
});

function malformed(what: string): Error {
  return amberError("source_unreachable", `the platform's ${what} did not have the expected shape`);
}

/** The body as JSON; an empty answer or one that is not JSON is unreachable, like any other unreadable answer. */
export function parseJsonBody(body: string): unknown {
  if (body.trim() === "") {
    throw amberError("source_unreachable", "platform answered with an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw amberError("source_unreachable", "platform answered with something other than JSON");
  }
}

/**
 * The detail answer: the video's detail, or `hidden` when the platform answered without one
 * (a removed, private or filtered video, which the platform explains only by a filter note).
 */
export function readDetailResponse(body: unknown): { kind: "found"; detail: DouyinDetail } | { kind: "hidden" } {
  const envelope = detailResponseSchema.safeParse(body);
  if (!envelope.success) {
    throw malformed("video detail");
  }
  const { status_code: statusCode, aweme_detail: raw } = envelope.data;
  if ((statusCode !== undefined && statusCode !== null && statusCode !== 0) || raw === null || raw === undefined) {
    return { kind: "hidden" };
  }
  const detail = detailSchema.safeParse(raw);
  if (!detail.success) {
    throw malformed("video detail");
  }
  return isRemoved(detail.data) ? { kind: "hidden" } : { kind: "found", detail: detail.data };
}

function isRemoved(detail: DouyinDetail): boolean {
  return Boolean(detail.status?.is_delete) || Boolean(detail.status?.is_prohibited);
}

/** Why a listed entry cannot be imported, from what its own status and streams say. */
function entryUnavailable(detail: DouyinDetail): PlatformEntryUnavailableReason | undefined {
  if (isRemoved(detail)) {
    return "removed";
  }
  if ((detail.status?.private_status ?? 0) !== 0) {
    return "private";
  }
  return isPlayableVideo(detail) ? undefined : "not_video";
}

/** One page of a collection listing, the cursor of the next page and whether there is one. */
export interface MixPage {
  entries: Array<{ platformContentId: string; detail?: DouyinDetail }>;
  cursor: number | undefined;
  hasMore: boolean;
}

export function readMixPage(body: unknown): MixPage {
  const page = mixPageSchema.safeParse(body);
  if (!page.success) {
    throw malformed("collection page");
  }
  if (page.data.status_code !== undefined && page.data.status_code !== null && page.data.status_code !== 0) {
    throw amberError("source_unreachable", "the platform did not list the collection");
  }
  const entries: MixPage["entries"] = [];
  for (const raw of page.data.aweme_list ?? []) {
    const detail = detailSchema.safeParse(raw);
    if (detail.success) {
      entries.push({ platformContentId: detail.data.aweme_id, detail: detail.data });
      continue;
    }
    // An entry whose details do not parse is still listed, by its id, as one that cannot be read.
    const id = z.object({ aweme_id: z.string().regex(/^\d{1,20}$/) }).safeParse(raw);
    if (id.success) {
      entries.push({ platformContentId: id.data.aweme_id });
    }
  }
  const cursor = page.data.cursor;
  return { entries, cursor: typeof cursor === "number" && Number.isSafeInteger(cursor) ? cursor : undefined, hasMore: Boolean(page.data.has_more) };
}

const HASHTAG = /(^|\s)#[^\s#]+/gu;

function oneLine(value: string): string {
  return normalizeDescription(value).replace(/\s+/gu, " ").trim();
}

function capTitle(value: string): string {
  return capDescription(value, PLATFORM_TITLE_MAX_CHARS).text;
}

function firstLine(value: string): string {
  return (
    normalizeDescription(value)
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .find((line) => line !== "") ?? ""
  );
}

/**
 * The platform's own title; without one, the first line of the description once its topic tags
 * are taken out. A description of nothing but tags still gives its first line; nothing at all
 * leaves the video id. At most `PLATFORM_TITLE_MAX_CHARS`, cut at a grapheme boundary.
 */
export function titleOf(detail: DouyinDetail): string {
  const own = oneLine(detail.item_title ?? "");
  if (own !== "") {
    return capTitle(own);
  }
  const description = detail.desc ?? "";
  const untagged = firstLine(normalizeDescription(description).replace(HASHTAG, "$1"));
  return capTitle(untagged !== "" ? untagged : firstLine(description) || detail.aweme_id);
}

function durationOf(detail: DouyinDetail): number {
  const ms = detail.duration ?? detail.video?.duration;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

/** The first cover address on the platform's image hosts, if any. */
export function trustedImage(urls: readonly string[] | null | undefined): string | undefined {
  return (urls ?? []).find((url) => isOnHosts(url, DOUYIN_IMAGE_HOSTS));
}

function coverOf(detail: DouyinDetail): string | undefined {
  return trustedImage(detail.video?.cover?.url_list) ?? trustedImage(detail.video?.origin_cover?.url_list);
}

/** Creator chapters in the platform's millisecond offsets, ordered, each ending where the next starts. */
function chaptersOf(detail: DouyinDetail, durationMs: number): PlatformChapter[] {
  const anchors = (detail.chapter_list ?? [])
    .map((chapter) => ({ startMs: chapter.timestamp, title: capTitle(oneLine(chapter.desc ?? "")) }))
    .filter((chapter): chapter is { startMs: number; title: string } => {
      const start = chapter.startMs;
      return typeof start === "number" && Number.isSafeInteger(start) && start >= 0 && (durationMs === 0 || start < durationMs) && chapter.title !== "";
    })
    .sort((a, b) => a.startMs - b.startMs);
  return anchors.map((chapter, index) => {
    const next = anchors[index + 1]?.startMs ?? (durationMs > 0 ? durationMs : undefined);
    return { startMs: chapter.startMs, ...(next === undefined || next <= chapter.startMs ? {} : { endMs: next }), title: chapter.title };
  });
}

/** Everything the detail says about the video, in one read; Douyin has no platform subtitles. */
export function metadataOf(detail: DouyinDetail): PlatformMetadata {
  const durationMs = durationOf(detail);
  const cover = coverOf(detail);
  const created = detail.create_time;
  const channelId = detail.author?.sec_uid ?? undefined;
  const channelTitle = detail.author?.nickname ?? undefined;
  return {
    title: titleOf(detail),
    durationMs,
    ...(cover === undefined ? {} : { coverUrl: cover }),
    ...(typeof created === "number" && Number.isSafeInteger(created) && created > 0 ? { publishedAt: created * 1000 } : {}),
    ...(channelId === undefined || channelId === "" ? {} : { channelId }),
    ...(channelTitle === undefined || channelTitle === "" ? {} : { channelTitle }),
    chapters: chaptersOf(detail, durationMs),
    subtitleTracks: [],
    description: classifyPlatformDescription(detail.desc),
  };
}

/** The collection the video belongs to, as its detail names it. */
export function relatedCollectionOf(detail: DouyinDetail): PlatformRelatedCollection | undefined {
  const mix = detail.mix_info;
  const mixId = mix?.mix_id ?? undefined;
  const platformCollectionId = mixId === undefined ? undefined : `douyin:${mixId}`;
  if (mix === undefined || mix === null || platformCollectionId === undefined || collectionIdOf(platformCollectionId) === null) {
    return undefined;
  }
  const title = capTitle(oneLine(mix.mix_name ?? ""));
  if (title === "") {
    return undefined;
  }
  const itemCount = mix.statis?.updated_to_episode;
  const index = mix.statis?.current_episode;
  const positive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  return {
    platformCollectionId,
    title,
    ...(positive(itemCount) ? { itemCount } : {}),
    ...(positive(index) ? { index } : {}),
    canonicalUrl: collectionCanonicalUrl(mixId as string),
  };
}

/** The collection's name as one of its entries names it. */
export function mixTitleOf(detail: DouyinDetail | undefined, mixId: string): string | undefined {
  if (detail?.mix_info?.mix_id !== mixId) {
    return undefined;
  }
  const title = capTitle(oneLine(detail.mix_info.mix_name ?? ""));
  return title === "" ? undefined : title;
}

/** How many entries the collection has, as one of its entries says. */
export function mixCountOf(detail: DouyinDetail | undefined, mixId: string): number | undefined {
  const value = detail?.mix_info?.mix_id === mixId ? detail.mix_info.statis?.updated_to_episode : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** One downloadable file the detail offers: its addresses in the platform's order and what it holds. */
export interface DouyinStream {
  urls: string[];
  width?: number;
  height?: number;
  sizeBytes?: number;
  bitRate: number;
}

const positiveInteger = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const CODEC_IN_KEY = /_(h264|bytevc1|bytevc2|h265)_\d+p_\d+$/;

function isH264(entry: z.infer<typeof bitRateSchema>): boolean {
  const named = CODEC_IN_KEY.exec(entry.play_addr?.url_key ?? "")?.[1];
  if (named !== undefined) {
    return named === "h264";
  }
  return !entry.is_h265 && !entry.is_bytevc1;
}

function httpUrls(urls: ReadonlyArray<string | null | undefined>): string[] {
  return urls.filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url));
}

/**
 * The streams holding picture and sound in one H.264 MP4 file, each with at least one address.
 * Video-only DASH streams and H.265 / ByteVC streams are left out: WebView2 does not decode
 * every one of them, and the sound would be missing.
 */
export function combinedH264Streams(detail: DouyinDetail): DouyinStream[] {
  const streams: DouyinStream[] = [];
  for (const entry of detail.video?.bit_rate ?? []) {
    const format = entry.format ?? "mp4";
    const urls = httpUrls(entry.play_addr?.url_list ?? []);
    if (format !== "mp4" || !isH264(entry) || urls.length === 0) {
      continue;
    }
    const width = positiveInteger(entry.play_addr?.width);
    const height = positiveInteger(entry.play_addr?.height);
    const sizeBytes = positiveInteger(entry.play_addr?.data_size);
    streams.push({
      urls,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      bitRate: positiveInteger(entry.bit_rate) ?? 0,
    });
  }
  return streams;
}

/** A video is a post with a playable H.264 stream; image posts may carry a `video` block without one. */
export function isPlayableVideo(detail: DouyinDetail): boolean {
  return combinedH264Streams(detail).length > 0;
}

/** Separate sound streams, the highest bitrate first. */
export function audioStreams(detail: DouyinDetail): DouyinStream[] {
  const streams: DouyinStream[] = [];
  for (const entry of detail.video?.bit_rate_audio ?? []) {
    const meta = entry.audio_meta;
    const urls = httpUrls([meta?.url_list?.main_url, meta?.url_list?.backup_url, meta?.url_list?.fallback_url]);
    if (urls.length === 0) {
      continue;
    }
    const sizeBytes = positiveInteger(meta?.size);
    streams.push({ urls, ...(sizeBytes === undefined ? {} : { sizeBytes }), bitRate: positiveInteger(meta?.bitrate) ?? 0 });
  }
  return streams.sort((a, b) => b.bitRate - a.bitRate);
}

/** The smallest combined stream, the fallback for sound when there is no separate one. */
export function smallestCombined(detail: DouyinDetail): DouyinStream | undefined {
  const size = (stream: DouyinStream) => stream.sizeBytes ?? Number.POSITIVE_INFINITY;
  return [...combinedH264Streams(detail)].sort((a, b) => size(a) - size(b) || a.bitRate - b.bitRate)[0];
}

function tierOf(stream: DouyinStream): number | undefined {
  return stream.height === undefined ? undefined : cacheQualityTier(stream.height, stream.width);
}

/**
 * The stream a cache of each tier downloads: per tier, the larger picture, then the higher
 * bitrate. Streams without a known picture size are not offered as a tier.
 */
function streamsByTier(detail: DouyinDetail): Map<number, DouyinStream> {
  const best = new Map<number, DouyinStream>();
  const area = (stream: DouyinStream) => (stream.width ?? 0) * (stream.height ?? 0);
  for (const stream of combinedH264Streams(detail)) {
    const tier = tierOf(stream);
    if (tier === undefined || stream.width === undefined) {
      continue;
    }
    const current = best.get(tier);
    if (current === undefined || area(stream) > area(current) || (area(stream) === area(current) && stream.bitRate > current.bitRate)) {
      best.set(tier, stream);
    }
  }
  return best;
}

/** The tiers a video cache can be made in, ascending, with the picture size of each tier's stream. */
export function qualitiesOf(detail: DouyinDetail): VideoQuality[] {
  return [...streamsByTier(detail).entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, stream]) => ({ tier, width: stream.width as number, height: stream.height as number }));
}

/**
 * The stream of exactly `tier`, or for a height cap the highest tier within it, else the lowest
 * tier there is. `undefined` when nothing matches (an exact tier no longer offered).
 */
export function streamFor(detail: DouyinDetail, target: { tier: number } | { maxHeight: number }): (DouyinStream & { tier: number }) | undefined {
  const tiers = [...streamsByTier(detail).entries()].sort(([a], [b]) => a - b);
  let chosen: [number, DouyinStream] | undefined;
  if ("tier" in target) {
    chosen = tiers.find(([tier]) => tier === target.tier);
  } else {
    chosen = tiers.filter(([tier]) => tier <= target.maxHeight).at(-1) ?? tiers[0];
  }
  return chosen === undefined ? undefined : { ...chosen[1], tier: chosen[0] };
}

/** A collection entry as the listing gives it, with title, duration and cover already known. */
export function listedEntry(index: number, entry: MixPage["entries"][number]): PlatformCollectionEntry {
  const base = { index, platformContentId: entry.platformContentId, canonicalUrl: videoUrl(entry.platformContentId) };
  const { detail } = entry;
  if (detail === undefined) {
    return { ...base, unavailable: "unknown" };
  }
  const unavailable = entryUnavailable(detail);
  if (unavailable === "removed" || unavailable === "private") {
    // Neither title nor duration is shown for what cannot be read.
    return { ...base, unavailable };
  }
  const durationMs = durationOf(detail);
  const cover = coverOf(detail);
  return {
    ...base,
    title: titleOf(detail),
    ...(durationMs > 0 ? { durationMs } : {}),
    ...(cover === undefined ? {} : { coverUrl: cover }),
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}
