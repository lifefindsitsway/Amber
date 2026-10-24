import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { RETRY_BASE_MS, RETRY_MAX, YTDLP_SOCKET_TIMEOUT_S } from "../../../shared/defaults.ts";
import { BYTES_PER_MB } from "../../../shared/units.ts";
import type { ErrorClass } from "../../../shared/errors.ts";
import { AmberError, amberError } from "../../domain/errors.ts";
import type { ProcessResult, ProcessRunner } from "../../ports/process-runner.ts";

/** Where yt-dlp keeps its cache and where cookies are materialized, relative to the data directory. */
export const YTDLP_CACHE_DIR = "tmp/yt-dlp-cache";
export const COOKIES_DIR = "tmp/cookies";
/** Scratch output of one platform call (subtitle files); removed when the call ends. */
export const PLATFORM_SCRATCH_DIR = "tmp/platform";
/** First line yt-dlp requires of a `--cookies` file it loads. */
const NETSCAPE_COOKIE_HEADER = "# Netscape HTTP Cookie File\n";
/** yt-dlp's exit code for a command line without a URL (optparse `parser.error`). */
const NO_URL_EXIT_CODE = 2;
/** Bound on one `-J` document held in memory. */
const JSON_OUTPUT_MAX_BYTES = 64 * BYTES_PER_MB;

export interface YtDlpOptions {
  runner: ProcessRunner;
  /** `AMBER_BIN_DIR`: yt-dlp, ffmpeg and deno live here and are started by absolute path. */
  binDir: string;
  dataDir: string;
  /** Complete child environment, built with `childProcessEnv`. */
  env: Readonly<Record<string, string>>;
  newId?: () => string;
}

export interface YtDlpRun {
  args: readonly string[];
  /** IE_NAMEs for `--use-extractors`; yt-dlp matches them whole and case-insensitively. */
  extractors: readonly string[];
  /** Netscape cookies.txt text; written to a private file for this run only. */
  cookies?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
}

function executable(binDir: string, tool: string): string {
  return join(binDir, process.platform === "win32" ? `${tool}.exe` : tool);
}

/** `--retry-sleep exp=START:END`: RETRY_BASE_MS doubling for RETRY_MAX retries. */
function retrySleep(): string {
  const startS = RETRY_BASE_MS / 1000;
  return `exp=${startS}:${startS * 2 ** (RETRY_MAX - 1)}`;
}

/**
 * The fixed part of every yt-dlp command line: no user or system config,
 * explicit tool locations (the child has no PATH), a cache inside the data directory,
 * the adapter's extractors only, and one retry policy for all three retry kinds.
 *
 * yt-dlp's own HTTP does not go through `OutboundHttpClient`, so it has neither IP pinning
 * nor per-redirect checks. It is confined only by the adapters accepting nothing but
 * canonical URLs on supported platform hosts, by `--use-extractors` and by `--no-config`.
 */
export function baseArgs(options: Pick<YtDlpOptions, "binDir" | "dataDir">, extractors: readonly string[]): string[] {
  return [
    "--no-config",
    "--ffmpeg-location",
    options.binDir,
    "--js-runtimes",
    `deno:${executable(options.binDir, "deno")}`,
    "--cache-dir",
    join(options.dataDir, YTDLP_CACHE_DIR),
    "--use-extractors",
    extractors.join(","),
    "--socket-timeout",
    String(YTDLP_SOCKET_TIMEOUT_S),
    "--retries",
    String(RETRY_MAX),
    "--fragment-retries",
    String(RETRY_MAX),
    "--extractor-retries",
    String(RETRY_MAX),
    "--retry-sleep",
    retrySleep(),
  ];
}

/**
 * stderr patterns → error class, checked in order against yt-dlp's `ERROR:` lines. The
 * texts come from the extractors of the pinned yt-dlp release; anything unmatched is
 * `source_unreachable` when it looks like transport trouble and `unknown` otherwise.
 */
export const YTDLP_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; errorClass: ErrorClass }> = [
  // The disk filled up under yt-dlp or the ffmpeg it merges with (`[Errno 28]` / `ENOSPC`).
  { pattern: /No space left on device|ENOSPC|Errno 28/i, errorClass: "disk_low" },
  { pattern: /supporter-only|premium members|members[- ]only|join this channel|become a premium member/i, errorClass: "paid_content" },
  {
    pattern: /only available for registered users|only available when logged in|sign in to confirm|use --cookies|account cookies are no longer valid|login required|requires authentication/i,
    errorClass: "auth_required",
  },
  {
    pattern: /exceeded the rate limit|blocked by server|rejected by server|HTTP Error 41[23]|HTTP Error 429|\b352\b|captcha|rate-limited|IP is likely being blocked/i,
    errorClass: "platform_blocked",
  },
  { pattern: /Unable to extract|unexpected HTML|<html/i, errorClass: "source_html_error_page" },
  {
    pattern: /deleted or geo-restricted|not available from your location|video unavailable|private video|does not exist|HTTP Error 404|HTTP Error 5\d\d|Unable to download|timed out|connection|getaddrinfo|Name or service not known|Temporary failure|SSL|Network is unreachable/i,
    errorClass: "source_unreachable",
  },
];

/** Removes query strings (signed URLs carry tokens) and caps the length of an upstream line. */
export function redactUpstream(line: string): string {
  return line.replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, "$1?…").slice(0, 500);
}

/** Maps a failed yt-dlp run to an AppError; exit code 2 is an option error on our side. */
export function classifyYtDlpFailure(result: Pick<ProcessResult, "exitCode" | "stderr">): AmberError {
  if (result.exitCode === 2) {
    return amberError("internal", "yt-dlp rejected its options", { code: "internal.tool_failed" });
  }
  const errorLines = result.stderr.split(/\r?\n/).filter((line) => line.startsWith("ERROR:"));
  const text = errorLines.join("\n");
  const upstreamMessage = redactUpstream(errorLines.at(-1) ?? "");
  const match = YTDLP_ERROR_PATTERNS.find((entry) => entry.pattern.test(text));
  const errorClass: ErrorClass = match?.errorClass ?? "unknown";
  return amberError(errorClass, `yt-dlp exited with ${result.exitCode}`, upstreamMessage === "" ? {} : { upstreamMessage });
}

/**
 * Runs yt-dlp through the ProcessRunner (argument array, never a shell). Cookies are
 * materialized as `tmp/cookies/<ulid>.txt` (directory 0700, file 0600) for the run and
 * removed in `finally`; the start-up sweep catches what a crash leaves.
 */
export class YtDlp {
  private readonly options: YtDlpOptions;
  private readonly newId: () => string;

  constructor(options: YtDlpOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
  }

  get dataDir(): string {
    return this.options.dataDir;
  }

  async run(run: YtDlpRun): Promise<ProcessResult> {
    const cookieFile = run.cookies === undefined ? undefined : await this.writeCookies(run.cookies);
    try {
      const args = [...baseArgs(this.options, run.extractors), ...(cookieFile === undefined ? [] : ["--cookies", cookieFile]), ...run.args];
      let result: ProcessResult;
      try {
        result = await this.options.runner.run(
          {
            command: executable(this.options.binDir, "yt-dlp"),
            args,
            env: this.options.env,
            ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
          },
          { signal: run.signal, ...(run.onStdoutLine === undefined ? {} : { onStdoutLine: run.onStdoutLine }) },
        );
      } catch (error) {
        if (run.signal.aborted) {
          throw error;
        }
        const reason = (error as { reason?: string }).reason;
        throw reason === "timeout"
          ? amberError("source_unreachable", "yt-dlp timed out")
          : amberError("internal", "yt-dlp failed to run", { code: "internal.tool_failed" });
      }
      if (result.exitCode !== 0) {
        throw classifyYtDlpFailure(result);
      }
      return result;
    } finally {
      if (cookieFile !== undefined) {
        await rm(cookieFile, { force: true });
      }
    }
  }

  /**
   * Runs with `--dump-single-json` style output and parses stdout. The document is
   * collected line by line rather than from the runner's bounded output tail: a YouTube
   * info document lists every caption language and easily exceeds that tail.
   */
  async json<T>(run: YtDlpRun): Promise<T> {
    const lines: string[] = [];
    let bytes = 0;
    await this.run({
      ...run,
      onStdoutLine: (line) => {
        run.onStdoutLine?.(line);
        bytes += Buffer.byteLength(line) + 1;
        if (bytes <= JSON_OUTPUT_MAX_BYTES) {
          lines.push(line);
        }
      },
    });
    if (bytes > JSON_OUTPUT_MAX_BYTES) {
      throw amberError("source_html_error_page", "yt-dlp printed more JSON than accepted");
    }
    try {
      return JSON.parse(lines.join("\n")) as T;
    } catch {
      throw amberError("source_html_error_page", "yt-dlp printed no JSON");
    }
  }

  /**
   * Dumps the cookie jar of a local browser profile (`--cookies-from-browser`) as Netscape
   * cookies.txt text, for every site in that profile; the caller filters it. Nothing is
   * downloaded: no URL is given. In the pinned release `yt_dlp/__init__.py` reports the
   * missing URL through `parser.error` (exit 2) inside `with YoutubeDL(...)`, whose
   * `__exit__ → close() → save_cookies()` still loads the browser jar and writes it to the
   * `--cookies` file; a profile that cannot be read raises `CookieLoadError` instead (exit 1).
   * So only exit 2 with a written jar is success; every other outcome, a timeout or a
   * failed start included, is `browser_cookies_unavailable`. The file lives under
   * `tmp/cookies/` like any cookie file of a run and is removed before this returns.
   */
  async dumpBrowserCookies(run: { browser: string; extractors: readonly string[]; signal: AbortSignal; timeoutMs?: number }): Promise<string> {
    // Pre-created with the bare header so the file is 0600 from the first byte: yt-dlp
    // reopens an existing file with "w", which keeps its mode. An empty file would not
    // do, yt-dlp loads `--cookies` first and rejects a file without the Netscape header.
    const cookieFile = await this.writeCookies(NETSCAPE_COOKIE_HEADER);
    const unavailable = () => amberError("browser_cookies_unavailable", "yt-dlp could not read the browser's cookies");
    try {
      let result: ProcessResult;
      try {
        result = await this.options.runner.run(
          {
            command: executable(this.options.binDir, "yt-dlp"),
            args: [...baseArgs(this.options, run.extractors), "--cookies", cookieFile, "--cookies-from-browser", run.browser],
            env: this.options.env,
            ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
          },
          { signal: run.signal },
        );
      } catch (error) {
        if (run.signal.aborted) {
          throw error;
        }
        throw unavailable();
      }
      if (result.exitCode !== NO_URL_EXIT_CODE) {
        throw unavailable();
      }
      const text = await readFile(cookieFile, "utf8").catch(() => "");
      if (text.trim() === "") {
        throw unavailable();
      }
      return text;
    } finally {
      await rm(cookieFile, { force: true });
    }
  }

  private async writeCookies(cookies: string): Promise<string> {
    const dir = join(this.options.dataDir, COOKIES_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const file = join(dir, `${this.newId()}.txt`);
    await writeFile(file, cookies, { mode: 0o600, flag: "wx" });
    return file;
  }
}
