import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { CACHE_QUALITY_TIERS, cacheQualityTier } from "../../../shared/cache-file-name.ts";
import { PLATFORM_METADATA_TIMEOUT_MS } from "../../../shared/defaults.ts";
import { formatBytes } from "../../../shared/units.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import type { VideoQuality, VideoTarget } from "../../ports/platform-source.ts";
import type { YtDlp } from "./yt-dlp.ts";

/** A chapter as yt-dlp prints it: seconds, possibly fractional. */
export interface YtDlpChapter {
  start_time: number;
  end_time?: number;
  title?: string;
}

/** Platform seconds → integer milliseconds; NaN stays NaN so broken cues are dropped later. */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * BCP-47 form of a platform language code. Platforms append their own ids to some codes
 * (YouTube names a titled track `en-eEY6OEpapPo` after its vssId), so trailing subtags are
 * dropped until the rest is a valid tag; nothing valid at all is `und`.
 */
export function languageTag(code: string): string {
  const subtags = code.split(/[-_]/);
  while (subtags.length > 0) {
    try {
      const tag = Intl.getCanonicalLocales(subtags.join("-"))[0];
      if (tag !== undefined) {
        return tag;
      }
    } catch {
      // Not a valid tag yet; try without the last subtag.
    }
    subtags.pop();
  }
  return "und";
}

const PROGRESS_PREFIX = "amber-progress ";
const FORMAT_PREFIX = "amber-format ";
const PROGRESS_TEMPLATE = `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s`;
/** yt-dlp's format selection for audio: the best audio-only stream, else the best combined format. */
const AUDIO_FORMAT = "ba/b";

function tooLarge(sizeBytes: number, maxBytes: number) {
  return amberError("media_too_large", `media of ${sizeBytes} bytes exceeds ${maxBytes}`, { params: { limit: formatBytes(maxBytes) } });
}

/**
 * Downloads the best audio-only stream (`ba/b`, falling back to the best combined
 * format) to exactly `output.path`, reporting byte progress.
 *
 * With `maxBytes` (an audio cache) the size is guarded without another
 * metadata run: the caller has already checked the announced size through `inspectAudio`,
 * and here the download is stopped as soon as yt-dlp reports a total, or a byte count,
 * above the limit; a finished file that is still larger is removed. Both fail with
 * `media_too_large`.
 */
export async function downloadAudio(
  ytDlp: YtDlp,
  input: {
    url: string;
    extractors: readonly string[];
    cookies?: string;
    output: { path: string };
    onProgress: (progress: number) => void;
    signal: AbortSignal;
    maxBytes?: number;
  },
): Promise<{ sizeBytes: number }> {
  const { maxBytes } = input;
  // Aborting this controller kills yt-dlp like a cancellation would; `oversize` tells the two apart.
  const guard = new AbortController();
  const forward = () => guard.abort(input.signal.reason);
  input.signal.addEventListener("abort", forward, { once: true });
  if (input.signal.aborted) {
    forward();
  }
  let oversize: number | undefined;
  try {
    try {
      await ytDlp.run({
        args: [
          "--no-playlist",
          "--format",
          AUDIO_FORMAT,
          "--no-part",
          "--force-overwrites",
          "--newline",
          "--progress-template",
          PROGRESS_TEMPLATE,
          "--output",
          input.output.path,
          input.url,
        ],
        extractors: input.extractors,
        ...(input.cookies === undefined ? {} : { cookies: input.cookies }),
        signal: guard.signal,
        onStdoutLine: (line) => {
          if (!line.startsWith(PROGRESS_PREFIX) || oversize !== undefined) {
            return;
          }
          const [downloaded, total, estimate] = line.slice(PROGRESS_PREFIX.length).split(" ").map(Number);
          if (maxBytes !== undefined) {
            const announced = Number.isFinite(total) ? (total as number) : 0;
            const received = Number.isFinite(downloaded) ? (downloaded as number) : 0;
            if (Math.max(announced, received) > maxBytes) {
              oversize = Math.max(announced, received);
              guard.abort();
              return;
            }
          }
          const size = Number.isFinite(total) && (total as number) > 0 ? (total as number) : (estimate as number);
          if (Number.isFinite(downloaded) && Number.isFinite(size) && size > 0) {
            input.onProgress(Math.min(1, (downloaded as number) / size));
          }
        },
      });
    } catch (error) {
      if (oversize === undefined || input.signal.aborted) {
        throw error;
      }
    }
    if (oversize === undefined && maxBytes !== undefined) {
      const { size } = await stat(input.output.path);
      if (size > maxBytes) {
        oversize = size;
      }
    }
    if (oversize !== undefined && maxBytes !== undefined) {
      await rm(input.output.path, { force: true });
      throw tooLarge(oversize, maxBytes);
    }
    return { sizeBytes: (await stat(input.output.path)).size };
  } finally {
    input.signal.removeEventListener("abort", forward);
  }
}

/**
 * What an audio cache would download, without downloading it: one
 * `--print` run over the same `ba/b` selection as `downloadAudio`. `sizeBytes` is
 * `filesize ?? filesize_approx`, absent when the platform announces neither.
 */
export async function inspectAudio(
  ytDlp: YtDlp,
  input: { url: string; extractors: readonly string[]; cookies?: string; signal: AbortSignal },
): Promise<{ sizeBytes?: number }> {
  let selected: ReturnType<typeof parseFormatLine>;
  await ytDlp.run({
    args: ["--no-playlist", "--format", AUDIO_FORMAT, "--print", `${FORMAT_PREFIX}%(filesize,filesize_approx)s`, input.url],
    extractors: input.extractors,
    ...(input.cookies === undefined ? {} : { cookies: input.cookies }),
    signal: input.signal,
    onStdoutLine: (line) => {
      selected = parseFormatLine(line) ?? selected;
    },
  });
  return selected?.sizeBytes === undefined ? {} : { sizeBytes: selected.sizeBytes };
}

/**
 * yt-dlp format selection for a cached video, as checked against the pinned release's
 * `YoutubeDL.py` (`_build_format_filter`, `get_compatible_ext`): first a video and an audio
 * stream whose containers merge into a file WebView2 plays (MP4 + M4A, else WebM + WebM),
 * then any video and audio pair within the height cap, then the best combined format within
 * it, then anything. A pair that matches no
 * container would make the `mp4/webm` merge fall back to WebM and ffmpeg refuse the mux.
 */
export function videoFormat(maxHeight: number): string {
  const capped = `[height<=${maxHeight}]`;
  return [`bv*${capped}[ext=mp4]+ba[ext=m4a]`, `bv*${capped}[ext=webm]+ba[ext=webm]`, `bv*${capped}+ba`, `b${capped}`, "bv*+ba", "b"].join("/");
}

/**
 * `--format-sort`: H.264 and AAC first, as the pinned release's own `-t mp4` preset does
 * (`options.py`), so the MP4 pair is the one WebView2 decodes everywhere; then resolution.
 */
export const VIDEO_FORMAT_SORT = "vcodec:h264,res,acodec:aac";
/**
 * `--merge-output-format` takes `/`-separated preferences (`options.py`; `YoutubeDL.py`
 * hands them to `get_compatible_ext`): MP4 when both streams fit it, else WebM.
 */
export const VIDEO_MERGE_FORMATS = "mp4/webm";
const VIDEO_MIME_BY_EXT: Readonly<Record<string, string>> = { mp4: "video/mp4", webm: "video/webm" };
const VIDEO_BASENAME = "video";
const scratchIds = monotonicFactory();

/** `--print` output of a format check: announced size (yt-dlp's `NA` when unknown), height, container, video codec and width. */
export function parseFormatLine(line: string): { sizeBytes?: number; height?: number; ext?: string; vcodec?: string; width?: number } | undefined {
  if (!line.startsWith(FORMAT_PREFIX)) {
    return undefined;
  }
  const [size, height, ext, vcodec, width] = line.slice(FORMAT_PREFIX.length).split(" ");
  const number = (text: string | undefined) => (text === undefined || !/^\d+(\.\d+)?$/.test(text) ? undefined : Number(text));
  const text = (value: string | undefined) => (value === undefined || value === "" || value === "NA" ? undefined : value);
  const sizeBytes = number(size);
  const parsedHeight = number(height);
  const parsedExt = text(ext);
  const parsedVcodec = text(vcodec);
  const parsedWidth = number(width);
  return {
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(parsedHeight === undefined ? {} : { height: parsedHeight }),
    ...(parsedExt === undefined ? {} : { ext: parsedExt }),
    ...(parsedVcodec === undefined ? {} : { vcodec: parsedVcodec }),
    ...(parsedWidth === undefined ? {} : { width: parsedWidth }),
  };
}

interface VideoSelection {
  url: string;
  extractors: readonly string[];
  cookies?: string;
  target: VideoTarget;
  signal: AbortSignal;
}

function videoSelectionArgs(format: string): string[] {
  return ["--no-playlist", "--format", format, "--format-sort", VIDEO_FORMAT_SORT, "--merge-output-format", VIDEO_MERGE_FORMATS];
}

/**
 * Format ids an exact selection may name. yt-dlp parses `--format` as an expression, so an
 * id carrying `+`, `/`, `[`, spaces or the like would change what is selected.
 */
const SAFE_FORMAT_ID = /^[A-Za-z0-9._-]+$/;
/** yt-dlp's message when a `--format` expression matches none of the current formats. */
const FORMAT_NOT_AVAILABLE = /Requested format is not available/i;

/** A video stream of the metadata that a cache of an exact tier may take. */
interface VideoCandidate {
  formatId: string;
  ext: string;
  vcodec: string;
  width: number;
  height: number;
  tbr: number;
  /** Position in yt-dlp's list, which runs from worst to best. */
  index: number;
}

/** The stream a cache of a tier downloads, as `pickTierFormat` selects it. */
export interface TierFormat {
  formatId: string;
  ext: string;
  width: number;
  height: number;
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * The streams of a yt-dlp format list a tier can be cached from: an MP4 or WebM container
 * (what WebView2 plays), a video codec, a positive integer height and width, and a format id
 * that is safe to name in a `--format` expression. The width is required because the tier
 * is judged from both sides; a stream announcing its height alone could land in a different
 * tier than its picture has.
 */
function videoCandidates(formats: readonly unknown[]): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];
  formats.forEach((format, index) => {
    if (typeof format !== "object" || format === null) {
      return;
    }
    const { format_id: formatId, ext, vcodec, width, height, tbr } = format as Record<string, unknown>;
    if (typeof formatId !== "string" || !SAFE_FORMAT_ID.test(formatId) || typeof ext !== "string" || !Object.hasOwn(VIDEO_MIME_BY_EXT, ext.toLowerCase())) {
      return;
    }
    if (typeof vcodec !== "string" || vcodec === "" || vcodec.toLowerCase() === "none" || !positiveInteger(height) || !positiveInteger(width)) {
      return;
    }
    const bitrate = typeof tbr === "number" && Number.isFinite(tbr) && tbr > 0 ? tbr : 0;
    candidates.push({ formatId, ext: ext.toLowerCase(), vcodec: vcodec.toLowerCase(), width, height, tbr: bitrate, index });
  });
  return candidates;
}

const isH264 = (candidate: VideoCandidate) => candidate.vcodec.startsWith("avc1") || candidate.vcodec.startsWith("h264");
const equivalentHeight = (candidate: VideoCandidate) =>
  Math.max(Math.min(candidate.width, candidate.height), (Math.max(candidate.width, candidate.height) * 9) / 16);

/**
 * Best first: H.264, which every WebView2 build decodes; then the larger picture within the
 * tier; then MP4 over WebM; then the higher bitrate; then the later entry, as yt-dlp lists
 * formats from worst to best.
 */
function compareCandidates(a: VideoCandidate, b: VideoCandidate): number {
  return (
    Number(isH264(b)) - Number(isH264(a)) ||
    equivalentHeight(b) - equivalentHeight(a) ||
    Number(b.ext === "mp4") - Number(a.ext === "mp4") ||
    b.tbr - a.tbr ||
    b.index - a.index
  );
}

function pickFrom(candidates: readonly VideoCandidate[], tier: number): TierFormat | undefined {
  const [best] = candidates.filter((candidate) => cacheQualityTier(candidate.height, candidate.width) === tier).sort(compareCandidates);
  return best === undefined ? undefined : { formatId: best.formatId, ext: best.ext, width: best.width, height: best.height };
}

/**
 * The stream of yt-dlp's `formats` a cache of quality `tier` downloads: among the candidates
 * (`videoCandidates`) whose picture falls in that tier, the first by `compareCandidates`.
 * `undefined` when none does.
 */
export function pickTierFormat(formats: readonly unknown[], tier: number): TierFormat | undefined {
  return pickFrom(videoCandidates(formats), tier);
}

/** The tiers `formats` can be cached in, ascending, each with the size of the stream `pickTierFormat` takes for it. */
export function availableTiers(formats: readonly unknown[]): VideoQuality[] {
  const candidates = videoCandidates(formats);
  const qualities: VideoQuality[] = [];
  for (const tier of CACHE_QUALITY_TIERS) {
    const pick = pickFrom(candidates, tier);
    if (pick !== undefined) {
      qualities.push({ tier, width: pick.width, height: pick.height });
    }
  }
  return qualities;
}

/**
 * The `--format` expression for exactly `pick`. A bare format id matches only that format,
 * and `/` takes the first alternative that matches (`YoutubeDL.py` of the pinned release):
 * the stream with an audio stream of its own container, else with any audio stream (the
 * merge then falls back as `--merge-output-format` allows), else the stream alone. Which
 * audio stream is taken is left to `--format-sort`.
 */
export function exactVideoFormat(pick: Pick<TierFormat, "formatId" | "ext">): string {
  const audio = pick.ext === "webm" ? "ba[ext=webm]" : "ba[ext=m4a]";
  return `${pick.formatId}+${audio}/${pick.formatId}+ba/${pick.formatId}`;
}

/** The format list of the source's metadata (`--dump-single-json`, nothing downloaded); `undefined` when the document has none. */
async function dumpFormats(ytDlp: YtDlp, input: { url: string; extractors: readonly string[]; cookies?: string; signal: AbortSignal }): Promise<unknown[] | undefined> {
  const info = await ytDlp.json<{ formats?: unknown } | null>({
    args: ["--dump-single-json", "--skip-download", "--no-playlist", input.url],
    extractors: input.extractors,
    ...(input.cookies === undefined ? {} : { cookies: input.cookies }),
    signal: input.signal,
    timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
  });
  const formats = info?.formats;
  return Array.isArray(formats) ? formats : undefined;
}

function tierUnavailable(tier: number) {
  return amberError("invalid_request", `no stream of the ${tier}P tier is offered`, {
    code: "invalid_request.cache_quality_unavailable",
    params: { quality: String(tier) },
  });
}

/**
 * A failure of a run with an exact selection whose stream is gone by the time yt-dlp reads
 * the formats again: that tier is no longer offered, and nothing else is taken in its place.
 */
function tierFailure(target: VideoTarget, error: unknown): unknown {
  if ("tier" in target && isAmberError(error) && FORMAT_NOT_AVAILABLE.test(error.appError.upstreamMessage ?? error.message)) {
    return tierUnavailable(target.tier);
  }
  return error;
}

/** Just the target of a `fetchVideo` request, without its other options. */
export function videoTargetOf(options: VideoTarget): VideoTarget {
  return "tier" in options ? { tier: options.tier } : { maxHeight: options.maxHeight };
}

/**
 * The `--format` expression for `target`, shared by the format check and the download so
 * both select the same stream. A tier is selected exactly from a fresh metadata dump
 * (`pickTierFormat`), and a tier the source does not offer fails with
 * `invalid_request.cache_quality_unavailable` before anything else runs; a height cap uses
 * `videoFormat`.
 */
async function resolveVideoTarget(ytDlp: YtDlp, input: VideoSelection): Promise<{ format: string }> {
  if (!("tier" in input.target)) {
    return { format: videoFormat(input.target.maxHeight) };
  }
  const formats = await dumpFormats(ytDlp, input);
  const pick = formats === undefined ? undefined : pickTierFormat(formats, input.target.tier);
  if (pick === undefined) {
    throw tierUnavailable(input.target.tier);
  }
  return { format: exactVideoFormat(pick) };
}

/**
 * One download-free run printing the selected format's `filesize ?? filesize_approx` —
 * yt-dlp derives the approximation from the bitrate and sums both streams of a merged pair
 * (`YoutubeDL.py`) — its height, the container the merge produces, its video codec and width.
 */
async function checkVideoFormat(ytDlp: YtDlp, input: VideoSelection, format: string): Promise<ReturnType<typeof parseFormatLine>> {
  let selected: ReturnType<typeof parseFormatLine>;
  try {
    await ytDlp.run({
      args: [...videoSelectionArgs(format), "--print", `${FORMAT_PREFIX}%(filesize,filesize_approx)s %(height)s %(ext)s %(vcodec)s %(width)s`, input.url],
      extractors: input.extractors,
      ...(input.cookies === undefined ? {} : { cookies: input.cookies }),
      signal: input.signal,
      onStdoutLine: (line) => {
        selected = parseFormatLine(line) ?? selected;
      },
    });
  } catch (error) {
    throw tierFailure(input.target, error);
  }
  return selected;
}

/**
 * What `downloadVideo` would fetch for `target`, without fetching it.
 * The selection has no video stream when yt-dlp reports `vcodec` `none`, or reports no
 * codec and no height either: the content is audio only. A container WebView2 cannot play
 * fails with `media_unsupported_type` here rather than after the download.
 */
export async function inspectVideo(
  ytDlp: YtDlp,
  input: VideoSelection,
): Promise<{ hasVideo: false } | { hasVideo: true; mimeType: string; sizeBytes?: number; height?: number; width?: number }> {
  const { format } = await resolveVideoTarget(ytDlp, input);
  const selected = await checkVideoFormat(ytDlp, input, format);
  const codec = selected?.vcodec?.toLowerCase();
  if (codec === "none" || (codec === undefined && selected?.height === undefined)) {
    return { hasVideo: false };
  }
  const mimeType = selected?.ext === undefined ? undefined : VIDEO_MIME_BY_EXT[selected.ext.toLowerCase()];
  if (mimeType === undefined) {
    throw amberError("media_unsupported_type", `the selected format is .${selected?.ext ?? "unknown"}`, {
      params: { formats: Object.keys(VIDEO_MIME_BY_EXT).join(", ") },
    });
  }
  return {
    hasVideo: true,
    mimeType,
    ...(selected?.sizeBytes === undefined ? {} : { sizeBytes: selected.sizeBytes }),
    ...(selected?.height === undefined ? {} : { height: selected.height }),
    ...(selected?.width === undefined ? {} : { width: selected.width }),
  };
}

/**
 * The quality tiers a video cache of the source can be made in, from one metadata dump
 * (nothing downloaded): each tier `pickTierFormat` finds a stream for, with that stream's
 * picture size, so a listed tier is exactly what `downloadVideo` fetches for it. yt-dlp lists
 * only the streams the platform returned for the login of this run, so qualities that need
 * another login are absent. `undefined` when the document has no format list.
 */
export async function listVideoQualities(
  ytDlp: YtDlp,
  input: { url: string; extractors: readonly string[]; cookies?: string; signal: AbortSignal },
): Promise<VideoQuality[] | undefined> {
  const formats = await dumpFormats(ytDlp, input);
  return formats === undefined ? undefined : availableTiers(formats);
}

/**
 * Downloads the video for `target` to exactly `output.path` (`cache_media`): exactly the
 * stream of a tier, or the best stream at most `maxHeight` pixels high (`resolveVideoTarget`).
 * A download-free run (`checkVideoFormat`) then reads the selected format's
 * announced size, and a size over `maxBytes` fails with `media_too_large` before anything
 * is fetched. While downloading, yt-dlp is stopped as soon as the bytes received for both
 * streams together, or an announced total, exceed `maxBytes` (`media_too_large`, nothing
 * left behind). yt-dlp picks the merged file's extension itself, so each run downloads into
 * a private directory of its own inside `output.scratchDir`, which is on the volume of
 * `output.path`, and the single result is renamed into place. Progress spans
 * both streams of a merged download.
 */
export async function downloadVideo(
  ytDlp: YtDlp,
  input: {
    url: string;
    extractors: readonly string[];
    cookies?: string;
    target: VideoTarget;
    maxBytes: number;
    output: { path: string; scratchDir: string };
    onProgress: (progress: number) => void;
    signal: AbortSignal;
  },
): Promise<{ sizeBytes: number; mimeType: string; height?: number }> {
  const { format } = await resolveVideoTarget(ytDlp, input);
  const selection = videoSelectionArgs(format);
  const cookies = input.cookies === undefined ? {} : { cookies: input.cookies };
  const selected = await checkVideoFormat(ytDlp, input, format);
  if (selected?.sizeBytes !== undefined && selected.sizeBytes > input.maxBytes) {
    throw tooLarge(selected.sizeBytes, input.maxBytes);
  }

  const dir = join(input.output.scratchDir, scratchIds());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Aborting this controller kills yt-dlp like a cancellation would; `oversize` tells the two apart.
  const guard = new AbortController();
  const forward = () => guard.abort(input.signal.reason);
  input.signal.addEventListener("abort", forward, { once: true });
  if (input.signal.aborted) {
    forward();
  }
  let oversize: number | undefined;
  try {
    let finished = 0;
    let current = { downloaded: 0, total: 0 };
    let reported = 0;
    try {
      await ytDlp.run({
        args: [
          ...selection,
          "--no-part",
          "--force-overwrites",
          "--newline",
          "--progress-template",
          PROGRESS_TEMPLATE,
          "--output",
          join(dir, `${VIDEO_BASENAME}.%(ext)s`),
          input.url,
        ],
        extractors: input.extractors,
        ...cookies,
        signal: guard.signal,
        onStdoutLine: (line) => {
          if (!line.startsWith(PROGRESS_PREFIX) || oversize !== undefined) {
            return;
          }
          const [downloaded, total, estimate] = line.slice(PROGRESS_PREFIX.length).split(" ").map(Number);
          const received = Number.isFinite(downloaded) ? (downloaded as number) : 0;
          // The counter restarts when the second stream of a merged pair starts.
          if (received < current.downloaded) {
            finished += current.total;
            current = { downloaded: 0, total: 0 };
          }
          const announced = Number.isFinite(total) ? (total as number) : 0;
          const soFar = finished + Math.max(announced, received);
          if (soFar > input.maxBytes) {
            oversize = soFar;
            guard.abort();
            return;
          }
          const size = Number.isFinite(total) && (total as number) > 0 ? (total as number) : (estimate as number);
          if (!Number.isFinite(downloaded) || !Number.isFinite(size) || size <= 0) {
            current = { downloaded: received, total: Math.max(current.total, received) };
            return;
          }
          current = { downloaded: received, total: size };
          const expected = Math.max(selected?.sizeBytes ?? 0, finished + size);
          reported = Math.max(reported, Math.min(1, (finished + current.downloaded) / expected));
          input.onProgress(reported);
        },
      });
    } catch (error) {
      if (oversize === undefined || input.signal.aborted) {
        throw tierFailure(input.target, error);
      }
    }
    if (oversize !== undefined) {
      throw tooLarge(oversize, input.maxBytes);
    }
    const results = (await readdir(dir)).filter((name) => new RegExp(`^${VIDEO_BASENAME}\\.[A-Za-z0-9]+$`).test(name));
    const [name] = results;
    if (name === undefined || results.length > 1) {
      throw amberError("internal", `yt-dlp left ${results.length} result files`, { code: "internal.tool_failed" });
    }
    const ext = name.slice(VIDEO_BASENAME.length + 1).toLowerCase();
    const mimeType = VIDEO_MIME_BY_EXT[ext];
    if (mimeType === undefined) {
      throw amberError("media_unsupported_type", `yt-dlp produced a .${ext} file`, { params: { formats: Object.keys(VIDEO_MIME_BY_EXT).join(", ") } });
    }
    const { size } = await stat(join(dir, name));
    if (size > input.maxBytes) {
      throw tooLarge(size, input.maxBytes);
    }
    await moveFile(join(dir, name), input.output.path);
    return {
      sizeBytes: (await stat(input.output.path)).size,
      mimeType,
      ...(selected?.height === undefined ? {} : { height: selected.height }),
    };
  } finally {
    input.signal.removeEventListener("abort", forward);
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Renames `from` to `to`; across volumes (`EXDEV`, e.g. a cache directory that is a mount
 * point of its own) it copies and removes the source instead.
 */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") {
      throw error;
    }
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
