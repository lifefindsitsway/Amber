import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { formatBytes } from "../../../shared/units.ts";
import { amberError } from "../../domain/errors.ts";
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
  maxHeight: number;
  signal: AbortSignal;
}

function videoSelectionArgs(maxHeight: number): string[] {
  return ["--no-playlist", "--format", videoFormat(maxHeight), "--format-sort", VIDEO_FORMAT_SORT, "--merge-output-format", VIDEO_MERGE_FORMATS];
}

/**
 * One download-free run printing the selected format's `filesize ?? filesize_approx` —
 * yt-dlp derives the approximation from the bitrate and sums both streams of a merged pair
 * (`YoutubeDL.py`) — its height, the container the merge produces, its video codec and width.
 */
async function checkVideoFormat(ytDlp: YtDlp, input: VideoSelection): Promise<ReturnType<typeof parseFormatLine>> {
  let selected: ReturnType<typeof parseFormatLine>;
  await ytDlp.run({
    args: [...videoSelectionArgs(input.maxHeight), "--print", `${FORMAT_PREFIX}%(filesize,filesize_approx)s %(height)s %(ext)s %(vcodec)s %(width)s`, input.url],
    extractors: input.extractors,
    ...(input.cookies === undefined ? {} : { cookies: input.cookies }),
    signal: input.signal,
    onStdoutLine: (line) => {
      selected = parseFormatLine(line) ?? selected;
    },
  });
  return selected;
}

/**
 * What `downloadVideo` would fetch for `maxHeight`, without fetching it.
 * The selection has no video stream when yt-dlp reports `vcodec` `none`, or reports no
 * codec and no height either: the content is audio only. A container WebView2 cannot play
 * fails with `media_unsupported_type` here rather than after the download.
 */
export async function inspectVideo(
  ytDlp: YtDlp,
  input: VideoSelection,
): Promise<{ hasVideo: false } | { hasVideo: true; mimeType: string; sizeBytes?: number; height?: number; width?: number }> {
  const selected = await checkVideoFormat(ytDlp, input);
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
 * Downloads a video at most `maxHeight` pixels high to exactly `output.path` (`cache_media`).
 * A first, download-free run (`checkVideoFormat`) reads the selected format's
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
    maxHeight: number;
    maxBytes: number;
    output: { path: string; scratchDir: string };
    onProgress: (progress: number) => void;
    signal: AbortSignal;
  },
): Promise<{ sizeBytes: number; mimeType: string; height?: number }> {
  const selection = videoSelectionArgs(input.maxHeight);
  const cookies = input.cookies === undefined ? {} : { cookies: input.cookies };
  const selected = await checkVideoFormat(ytDlp, input);
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
        throw error;
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
