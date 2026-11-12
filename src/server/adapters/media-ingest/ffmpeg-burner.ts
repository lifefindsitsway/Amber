import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_PROBE_TIMEOUT_MS, SUBTITLE_VIDEO_AUDIO_KBPS } from "../../../shared/defaults.ts";
import { amberError } from "../../domain/errors.ts";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../../ports/process-runner.ts";
import type { BurnOptions, VideoBurner } from "../../ports/video-burner.ts";

export interface FfmpegVideoBurnerOptions {
  runner: ProcessRunner;
  /** `AMBER_BIN_DIR`: ffmpeg is started by absolute path. */
  binDir: string;
  /** The bundled fonts directory, `fonts/` beside `AMBER_BIN_DIR`. */
  fontsDir: string;
  /** Complete child environment, built with `childProcessEnv`. */
  env: Readonly<Record<string, string>>;
}

/** Hardware encoders first, libx264 last: the first encoder ffmpeg lists wins; a listed one that fails to encode hands over to the next. */
export const ENCODER_ORDER = ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_videotoolbox", "libx264"] as const;
export type BurnEncoder = (typeof ENCODER_ORDER)[number];

interface EncoderProfile {
  /** Options placed before the input (hardware device set-up). */
  readonly global: readonly string[];
  /** Appended to the subtitle filter, e.g. the upload into a hardware frame pool. */
  readonly filterSuffix: string;
  /** Quality and output pixel-format options for this encoder. */
  readonly args: readonly string[];
}

/**
 * Per-encoder quality arguments. The encoders accept no common quality
 * option (`-crf` is libx264's), so each gets its own constant-quality mode at a level
 * comparable to `-crf 20`; output is 8-bit 4:2:0 so every WebView2 build plays it. Option
 * names and ranges were read from `ffmpeg -h encoder=<name>` of the pinned n9.0.2 builds
 * (Linux and win64) and the rate-control selection in the pinned source
 * (`libavcodec/nvenc.c`, `qsvenc.c`, `vaapi_encode.c`, `videotoolboxenc.c`):
 * - nvenc: `-rc vbr` with `-cq` (0–51) is constant-quality VBR; the encoder then drops the
 *   average bitrate itself.
 * - qsv: `-global_quality` (ICQQuality 1–51) without a bitrate selects ICQ.
 * - vaapi: needs a VAAPI device and frames uploaded into it; `-rc_mode CQP -qp` (0–52) is
 *   the mode drivers support most widely.
 * - videotoolbox: not in either pinned build; per the FFmpeg source, `-q:v` (1–100) maps
 *   to `kVTCompressionPropertyKey_Quality` and is refused where unsupported, which makes
 *   the burn fall through to the next encoder instead of using a 200 kbit/s default.
 */
export const ENCODER_PROFILES: Readonly<Record<BurnEncoder, EncoderProfile>> = {
  h264_nvenc: { global: [], filterSuffix: "", args: ["-preset", "p4", "-rc", "vbr", "-cq", "20", "-pix_fmt", "yuv420p"] },
  h264_qsv: { global: [], filterSuffix: "", args: ["-preset", "veryfast", "-global_quality", "20", "-pix_fmt", "nv12"] },
  h264_vaapi: {
    global: ["-init_hw_device", "vaapi=amber", "-filter_hw_device", "amber"],
    filterSuffix: ",format=nv12,hwupload",
    args: ["-rc_mode", "CQP", "-qp", "20"],
  },
  h264_videotoolbox: { global: [], filterSuffix: "", args: ["-q:v", "65", "-pix_fmt", "yuv420p"] },
  libx264: { global: [], filterSuffix: "", args: ["-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"] },
};

/** Characters that end or quote a filter option value (`av_opt_set_from_string`, `av_get_token(":")`). */
const OPTION_SPECIALS = new Set(["\\", "'", ":", "=", " ", "\t", "\n", "\r"]);
/** Characters that end or quote a filter's argument string in a graph (`graphparser.c`, `av_get_token("[],;")`). */
const GRAPH_SPECIALS = new Set(["\\", "'", "[", "]", ",", ";", " ", "\t", "\n", "\r"]);

function backslashEscape(text: string, specials: ReadonlySet<string>): string {
  let out = "";
  for (const char of text) {
    out += specials.has(char) ? `\\${char}` : char;
  }
  return out;
}

/**
 * A filter option value (a path) as it must appear in a `-vf` filtergraph. ffmpeg unescapes
 * twice: the graph parser first, then the filter's option parser, and both treat `\` and
 * `'` as escapes; so the value is escaped for the option level, then the result for the
 * graph level (FFmpeg filters documentation, "Notes on filtergraph escaping"). Windows
 * paths carry `\` and the drive colon, which both levels would otherwise swallow.
 */
export function escapeFilterValue(value: string): string {
  return backslashEscape(backslashEscape(value, OPTION_SPECIALS), GRAPH_SPECIALS);
}

/** `file:` keeps a path that looks like a URL or an option from being read as one. */
const fileUrl = (path: string): string => `file:${path}`;

/**
 * Square pixels with even dimensions before the subtitles: H.264 in
 * 4:2:0 refuses odd dimensions, and libass draws on the frame as it is stored, so a
 * non-square picture would stretch the subtitles. ffmpeg has already turned a rotated
 * source upright at this point, so `iw`, `ih` and `sar` are those of the upright frame.
 */
const SQUARE_PIXELS = "scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1,";

function needsSquarePixels(geometry: NonNullable<BurnOptions["geometry"]>): boolean {
  return geometry.sar.num !== geometry.sar.den || geometry.displayWidth % 2 !== 0 || geometry.displayHeight % 2 !== 0;
}

/**
 * Audio codecs of a styled burn, which maps the first video stream (`V` leaves cover
 * images out) and every audio stream: each is copied or re-encoded to AAC as the caller
 * says; a stream the caller did not describe is copied.
 */
function audioArgs(options: BurnOptions): string[] {
  const perStream = (options.audioCopy ?? []).flatMap((copy, index) =>
    copy ? [`-c:a:${index}`, "copy"] : [`-c:a:${index}`, "aac", `-b:a:${index}`, `${SUBTITLE_VIDEO_AUDIO_KBPS}k`],
  );
  return ["-c:a", "copy", ...perStream];
}

/** Encoder names from `ffmpeg -encoders`: lines like ` V....D libx264   description`. */
export function listedEncoders(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*V[A-Z.]{5}\s+([\w-]+)\s/.exec(line);
    if (match?.[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

async function assertReadable(path: string): Promise<void> {
  try {
    await (await open(path, "r")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw amberError("media_missing", "input file does not exist");
    }
    throw error;
  }
}

/**
 * VideoBurner over the bundled ffmpeg: libass's
 * `subtitles` filter with the bundled fonts directory, audio copied, MP4 with the index up
 * front so the saved file starts playing at once. The encoder list is probed once per
 * instance (one per process); every listed encoder of `ENCODER_ORDER` is tried in turn
 * until one encodes.
 */
export class FfmpegVideoBurner implements VideoBurner {
  private readonly options: FfmpegVideoBurnerOptions;
  private encoders: Promise<BurnEncoder[]> | undefined;

  constructor(options: FfmpegVideoBurnerOptions) {
    this.options = options;
  }

  async burn(
    input: { video: string; subtitle: string },
    output: { path: string },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    options?: BurnOptions,
  ): Promise<{ sizeBytes: number; encoder: string }> {
    await assertReadable(input.video);
    await assertReadable(input.subtitle);
    const candidates = await this.availableEncoders(signal);
    const durationMs = await this.durationOf(input.video, signal);
    let lastFailure = "";
    for (const encoder of candidates) {
      const result = await this.encode(encoder, input, output.path, durationMs, onProgress, signal, options);
      if (result.exitCode === 0) {
        onProgress(1);
        return { sizeBytes: (await stat(output.path)).size, encoder };
      }
      lastFailure = `${encoder} exited with ${result.exitCode ?? result.signal}`;
    }
    throw amberError("internal", `no encoder could burn the video (${lastFailure})`, { code: "internal.tool_failed" });
  }

  /** Probed once; a failed probe is not cached so the next burn probes again. */
  private availableEncoders(signal: AbortSignal): Promise<BurnEncoder[]> {
    this.encoders ??= this.run(["-hide_banner", "-nostdin", "-encoders"], signal, MEDIA_PROBE_TIMEOUT_MS).then((result) => {
      const listed = listedEncoders(result.stdout);
      const usable = ENCODER_ORDER.filter((name) => listed.has(name));
      if (result.exitCode !== 0 || usable.length === 0) {
        throw amberError("internal", "ffmpeg lists no usable H.264 encoder", { code: "internal.tool_failed" });
      }
      return usable;
    });
    const probing = this.encoders;
    probing.catch(() => {
      if (this.encoders === probing) {
        this.encoders = undefined;
      }
    });
    return probing;
  }

  /** Progress needs the input duration; without one, progress is only reported at the end. */
  private async durationOf(path: string, signal: AbortSignal): Promise<number | undefined> {
    const result = await this.run(
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "-i", fileUrl(path)],
      signal,
      MEDIA_PROBE_TIMEOUT_MS,
      "ffprobe",
    );
    const seconds = Number(result.stdout.trim());
    return result.exitCode === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }

  private encode(
    encoder: BurnEncoder,
    input: { video: string; subtitle: string },
    outputPath: string,
    durationMs: number | undefined,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    options: BurnOptions | undefined,
  ): Promise<ProcessResult> {
    const profile = ENCODER_PROFILES[encoder];
    const geometry = options?.geometry;
    const prefix = geometry !== undefined && needsSquarePixels(geometry) ? SQUARE_PIXELS : "";
    // Styled subtitles arrive already broken to the wrap width; libass only wraps what an
    // estimate missed. Unicode line breaking (the `ass` filter wraps at spaces only, so
    // Chinese ran off the picture) with end-of-line filling: its balancing style moves the
    // glyph before a non-space break onto the next line, putting a comma at a line's start.
    const filter = `${prefix}subtitles=filename=${escapeFilterValue(input.subtitle)}:fontsdir=${escapeFilterValue(this.options.fontsDir)}:wrap_unicode=1:force_style=WrapStyle=1${profile.filterSuffix}`;
    const args = [
      "-hide_banner", "-nostdin", "-v", "error", "-nostats", "-progress", "pipe:1", "-y",
      ...profile.global,
      "-i", fileUrl(input.video),
      ...(options === undefined ? [] : ["-map", "0:V:0", "-map", "0:a?"]),
      "-vf", filter,
      "-c:v", encoder, ...profile.args,
      ...(options === undefined ? ["-c:a", "copy"] : audioArgs(options)),
      "-movflags", "+faststart",
      "-f", "mp4", fileUrl(outputPath),
    ];
    return this.run(args, signal, undefined, "ffmpeg", (line) => {
      // ffmpeg reports `out_time_us` and, for compatibility, `out_time_ms` — both in microseconds.
      const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
      if (match?.[1] !== undefined && durationMs !== undefined) {
        onProgress(Math.min(1, Number(match[1]) / 1000 / durationMs));
      }
    });
  }

  private async run(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs?: number,
    tool: "ffmpeg" | "ffprobe" = "ffmpeg",
    onStdoutLine?: (line: string) => void,
  ): Promise<ProcessResult> {
    const spec: ProcessSpec = {
      command: join(this.options.binDir, process.platform === "win32" ? `${tool}.exe` : tool),
      args,
      env: this.options.env,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    try {
      return await this.options.runner.run(spec, { signal, ...(onStdoutLine === undefined ? {} : { onStdoutLine }) });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw amberError("internal", `${tool} failed to run`, { code: "internal.tool_failed" });
    }
  }
}
