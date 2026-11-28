import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { MAX_UPLOAD_GB, OUTBOUND_MAX_REDIRECTS, PLATFORM_DOWNLOAD_RESUME_MAX, PLATFORM_DOWNLOAD_STALL_TIMEOUT_MS } from "../../../shared/defaults.ts";
import type { RefinedErrorCode } from "../../../shared/errors.ts";
import { BYTES_PER_GB, formatBytes } from "../../../shared/units.ts";
import { AmberError, amberError, appError, isAmberError } from "../../domain/errors.ts";
import { upstreamHttpStatus } from "../../ports/upstream-status.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundResponse } from "../../ports/outbound-http.ts";

/** Which kind of body a download must be; an HTML error page or anything else is refused. */
export type PlatformMediaKind = "video" | "audio" | "image";

/**
 * One media file to fetch from a platform CDN, without yt-dlp. The caller names the hosts the
 * URL and every redirect hop may be on; nothing outside them is ever requested.
 */
export interface PlatformDownloadRequest {
  /** An https URL on one of `allowedHosts`; no user info, no port. */
  url: string;
  /** Host names matched at a domain boundary (`xhscdn.com` admits `sns-video-bd.xhscdn.com`, not `evilxhscdn.com`). */
  allowedHosts: readonly string[];
  /**
   * The calling adapter's own `trustedHosts`, sent with every hop: only a hop whose host is on
   * it may go through the configured proxy.
   */
  trustedHosts: readonly string[];
  /** Sent with every hop; never a cookie (media requests go out without a login). */
  headers?: Readonly<Record<string, string>>;
  kind: PlatformMediaKind;
  /** The size the platform's own metadata declares, when it does; a different total is refused. */
  expectedBytes?: number;
  /** Most bytes accepted, by the declared length and by the bytes actually received (`media_too_large`). */
  maxBytes: number;
  /**
   * `path` is where the finished file is moved to atomically; `scratchDir` is a directory on the
   * same volume that the caller owns and removes. The download writes only below it, so an
   * unfinished or refused download never leaves a file at `path`.
   */
  output: { path: string; scratchDir: string };
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
  signal: AbortSignal;
}

export interface PlatformDownloadResult {
  sizeBytes: number;
  /** The `Content-Type` media type the platform answered with, without parameters. */
  mimeType: string;
}

/**
 * The most a platform media file may be when the caller names no limit of its own: the same
 * bound a user's upload has, so no platform answer can fill the disk.
 */
export const PLATFORM_MEDIA_MAX_BYTES = MAX_UPLOAD_GB * BYTES_PER_GB;

/** The downloader as adapters depend on it, so their tests can stand in for it. */
export type PlatformMediaDownload = (http: OutboundHttpClient, request: PlatformDownloadRequest) => Promise<PlatformDownloadResult>;

/** What the downloader takes from its environment; tests replace the clock and the disk. */
export interface PlatformDownloadEnvironment {
  /** How long the download may go without a single byte (response headers included). */
  stallTimeoutMs: number;
  /** Further requests after an interrupted or invalidated attempt, resumed or from the start. */
  resumeMax: number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Writes `chunk` at `position` of the temporary file. */
  writeChunk(handle: FileHandle, chunk: Uint8Array, position: number): Promise<void>;
}

const DEFAULT_ENVIRONMENT: PlatformDownloadEnvironment = {
  stallTimeoutMs: PLATFORM_DOWNLOAD_STALL_TIMEOUT_MS,
  resumeMax: PLATFORM_DOWNLOAD_RESUME_MAX,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  writeChunk: async (handle, chunk, position) => {
    let written = 0;
    while (written < chunk.byteLength) {
      const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written, position + written);
      written += bytesWritten;
    }
  },
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Request headers that never go to a platform CDN, or never to another origin than the one named. */
const NEVER_SENT = new Set(["cookie", "range", "if-range"]);
const CROSS_ORIGIN_DROPPED = new Set(["authorization", "proxy-authorization"]);
const TEMPORARY_FILE = "media.part";

/**
 * The bytes held in the temporary file and what a resume must find unchanged: a strong ETag
 * and the total length of the representation they belong to.
 */
interface Held {
  received: number;
  total: number;
  /** Absent when the response had no strong ETag; such a download is never resumed. */
  etag?: string;
  mimeType: string;
}

/** How one request ended without failing the download. */
type Attempt =
  | { outcome: "complete"; held: Held }
  /** The body was cut off; `held` is what the temporary file holds now. */
  | { outcome: "interrupted"; held: Held | undefined }
  /** The answer to a resume did not continue the held bytes; they must be discarded. */
  | { outcome: "restart" };

/**
 * Builds a downloader over `environment` (production defaults for anything not given). Only
 * tests pass an environment; adapters use `downloadPlatformMedia`.
 */
export function createPlatformMediaDownload(environment: Partial<PlatformDownloadEnvironment> = {}): PlatformMediaDownload {
  const env: PlatformDownloadEnvironment = { ...DEFAULT_ENVIRONMENT, ...environment };
  return async (http, request) => {
    const first = admitUrl(request.url, request.allowedHosts);
    if (first === undefined) {
      throw blocked(undefined, "media URL is not an https URL on an allowed host");
    }
    if (request.expectedBytes !== undefined && request.expectedBytes > request.maxBytes) {
      throw tooLarge(request.maxBytes);
    }
    request.signal.throwIfAborted();

    let directory: string | undefined;
    let handle: FileHandle | undefined;
    try {
      await mkdir(request.output.scratchDir, { recursive: true, mode: 0o700 });
      // A directory of its own per download: two downloads of the same content never share a file.
      directory = await mkdtemp(join(request.output.scratchDir, `download-${randomUUID()}-`));
      const temporary = join(directory, TEMPORARY_FILE);
      handle = await open(temporary, "wx", 0o600);
      const held = await fetchInto(http, request, first, handle, env);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, request.output.path);
      return { sizeBytes: held.received, mimeType: held.mimeType };
    } catch (error) {
      throw toDiskError(error);
    } finally {
      await handle?.close().catch(() => undefined);
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

/**
 * Downloads a platform media file to `output.path`: public addresses only, allowed hosts on
 * every hop, a unique temporary file below `output.scratchDir` moved into place only once
 * complete, resumed only against a strong ETag with `If-Range`, size capped by declaration and
 * by bytes, stalls and cancellation stop it, and every other outcome removes the temporary file.
 */
export const downloadPlatformMedia: PlatformMediaDownload = createPlatformMediaDownload();

/**
 * Requests until the temporary file holds the whole representation. An attempt cut off while
 * its body streams is followed by another request, at most `resumeMax` of them: a resume when
 * the held bytes carry a strong ETag, otherwise a download from the start. A resume appends
 * only to a 206 that starts at the held length and keeps the ETag and the total; any other
 * answer (200, 416, a different range, total or ETag) means starting over, a 200 being the
 * new start itself.
 */
async function fetchInto(http: OutboundHttpClient, request: PlatformDownloadRequest, url: URL, handle: FileHandle, env: PlatformDownloadEnvironment): Promise<Held> {
  let resumeFrom: Held | undefined;
  let retriesLeft = env.resumeMax;
  for (;;) {
    const attempt = await fetchOnce(http, request, url, handle, env, resumeFrom);
    if (attempt.outcome === "complete") {
      return attempt.held;
    }
    if (retriesLeft === 0) {
      throw amberError("source_unreachable", "media download was interrupted too often");
    }
    retriesLeft -= 1;
    if (attempt.outcome === "interrupted" && attempt.held?.etag !== undefined && attempt.held.received > 0) {
      resumeFrom = attempt.held;
      continue;
    }
    await handle.truncate(0);
    resumeFrom = undefined;
  }
}

/** One request, redirects walked, its body appended to the temporary file. */
async function fetchOnce(
  http: OutboundHttpClient,
  request: PlatformDownloadRequest,
  url: URL,
  handle: FileHandle,
  env: PlatformDownloadEnvironment,
  resumeFrom: Held | undefined,
): Promise<Attempt> {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  let stalled = false;
  let timer: unknown;
  const arm = (): void => {
    if (timer !== undefined) {
      env.clearTimer(timer);
    }
    timer = env.setTimer(() => {
      stalled = true;
      controller.abort();
    }, env.stallTimeoutMs);
  };
  let answered: OutboundResponse | undefined;
  // Ends the response early; its connection is dropped rather than drained.
  const drop = (): void => {
    answered?.destroy?.();
    controller.abort();
  };
  let held = resumeFrom;
  let streaming = false;
  arm();
  try {
    const headers = baseHeaders(request.headers);
    if (resumeFrom !== undefined) {
      headers.Range = `bytes=${resumeFrom.received}-`;
      headers["If-Range"] = resumeFrom.etag as string;
    }
    const response = await walk(http, url, request, headers, signal);
    answered = response;
    arm();

    let start = 0;
    let total: number;
    if (resumeFrom !== undefined && response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      const etag = strongEtag(response.headers.get("etag"));
      if (range === undefined || range.start !== resumeFrom.received || range.end !== range.total - 1 || range.total !== resumeFrom.total || etag !== resumeFrom.etag) {
        drop();
        return { outcome: "restart" };
      }
      start = range.start;
      total = range.total;
    } else if (resumeFrom !== undefined && response.status === 416) {
      // Not a completed download: the held bytes may belong to a representation that is gone.
      drop();
      return { outcome: "restart" };
    } else if (response.status === 200) {
      const declared = parseLength(response.headers.get("content-length"));
      if (declared === undefined) {
        drop();
        throw amberError("source_unreachable", "media response declares no length");
      }
      total = declared;
      if (resumeFrom !== undefined) {
        // The server ignored or refused the resume and sent everything: this is a fresh start.
        await handle.truncate(0);
        held = undefined;
      }
    } else {
      drop();
      // The status travels as the cause: a cover whose image host answers 403 / 404 / 410 has a
      // stale link, which the cover service can re-read from the platform.
      throw new AmberError(appError("source_unreachable"), `media request answered HTTP ${response.status}`, { cause: upstreamHttpStatus(response.status) });
    }

    const mimeType = mediaType(response.headers.get("content-type"));
    if (mimeType === undefined || !matchesKind(mimeType, request.kind)) {
      drop();
      throw amberError("source_html_error_page", `media request answered ${mimeType ?? "without a type"} instead of ${request.kind}`);
    }
    if (total > request.maxBytes) {
      drop();
      throw tooLarge(request.maxBytes);
    }
    if (request.expectedBytes !== undefined && total !== request.expectedBytes) {
      drop();
      throw amberError("source_unreachable", "media length differs from the size the platform declared");
    }
    const etag = strongEtag(response.headers.get("etag"));
    held = { received: start, total, mimeType, ...(etag === undefined ? {} : { etag }) };

    streaming = true;
    for await (const chunk of response.body) {
      arm();
      // Bytes that arrive after a cancellation are not written.
      request.signal.throwIfAborted();
      const after: number = held.received + chunk.byteLength;
      if (after > request.maxBytes) {
        drop();
        throw tooLarge(request.maxBytes);
      }
      if (after > held.total) {
        drop();
        throw amberError("source_unreachable", "media response is longer than it declared");
      }
      await env.writeChunk(handle, chunk, held.received);
      held = { ...held, received: after };
      request.onProgress?.(held.received, held.total);
    }
    return held.received === held.total ? { outcome: "complete", held } : { outcome: "interrupted", held };
  } catch (error) {
    if (request.signal.aborted) {
      throw request.signal.reason;
    }
    if (stalled) {
      throw amberError("source_unreachable", `media download received nothing for ${env.stallTimeoutMs} ms`);
    }
    if (error instanceof OutboundHttpError) {
      if (streaming) {
        return { outcome: "interrupted", held };
      }
      throw amberError("source_unreachable", error.message);
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      env.clearTimer(timer);
    }
  }
}

/**
 * Sends one GET and follows its redirects by hand, every hop checked against the allowed
 * hosts before it is requested. Every request is `publicOnly` and `redirect: "manual"`.
 */
async function walk(
  http: OutboundHttpClient,
  first: URL,
  request: Pick<PlatformDownloadRequest, "allowedHosts" | "trustedHosts">,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<OutboundResponse> {
  const { allowedHosts, trustedHosts } = request;
  let url = first;
  let hopHeaders = headers;
  for (let redirects = 0; ; redirects++) {
    const response = await http.request({ url: url.toString(), method: "GET", headers: hopHeaders, signal, redirect: "manual", publicOnly: true, trustedHosts });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === undefined) {
      return response;
    }
    await discard(response);
    if (redirects >= OUTBOUND_MAX_REDIRECTS) {
      throw blocked("network_blocked_by_policy.redirect", `media request redirected more than ${OUTBOUND_MAX_REDIRECTS} times`);
    }
    let next: URL | undefined;
    try {
      // An absolute location is judged as written, so an explicit port is seen before URL parsing drops a default one.
      const target = /^[a-z][a-z0-9+.-]*:/iu.test(location.trim()) ? location.trim() : new URL(location, url).toString();
      next = admitUrl(target, allowedHosts);
    } catch {
      next = undefined;
    }
    if (next === undefined) {
      throw blocked("network_blocked_by_policy.redirect", "media request redirected off the allowed hosts");
    }
    if (next.origin !== url.origin) {
      hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([name]) => !CROSS_ORIGIN_DROPPED.has(name.toLowerCase())));
    }
    url = next;
  }
}

/** The caller's headers without a cookie or range headers of its own; the downloader sets ranges. */
function baseHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !NEVER_SENT.has(name.toLowerCase())));
}

/**
 * The URL when it may be requested: https, no user info, no explicit port, a host name (not an
 * address) equal to an allowed host or below it at a label boundary.
 */
function admitUrl(text: string, allowedHosts: readonly string[]): URL | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || /^https:\/\/[^/?#]*:\d*(?:[/?#]|$)/iu.test(text.trim())) {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || isIP(host) !== 0) {
    return undefined;
  }
  const allowed = allowedHosts.some((entry) => {
    const name = entry.toLowerCase();
    return name !== "" && (host === name || host.endsWith(`.${name}`));
  });
  return allowed ? url : undefined;
}

function parseLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : undefined;
}

/** `bytes <start>-<end>/<total>` with a known total; anything else is unusable. */
function parseContentRange(value: string | undefined): { start: number; end: number; total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value?.trim() ?? "");
  if (match === null) {
    return undefined;
  }
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) {
    return undefined;
  }
  return { start, end, total };
}

/** A strong entity tag as sent; weak (`W/`) or malformed tags cannot validate a resume. */
function strongEtag(value: string | undefined): string | undefined {
  const tag = value?.trim();
  return tag !== undefined && /^"[^"]*"$/u.test(tag) ? tag : undefined;
}

function mediaType(value: string | undefined): string | undefined {
  const type = value?.split(";")[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
}

/**
 * Whether a media type fits the kind asked for. An audio-only stream often comes in an MP4 or
 * WebM container labelled `video/*`; what it holds is checked when the audio is extracted.
 */
function matchesKind(type: string, kind: PlatformMediaKind): boolean {
  if (kind === "audio") {
    return type.startsWith("audio/") || type.startsWith("video/");
  }
  return type.startsWith(`${kind}/`);
}

/** Drops a redirect's body unread; its connection is not reused. */
async function discard(response: OutboundResponse): Promise<void> {
  if (response.destroy !== undefined) {
    response.destroy();
    return;
  }
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done !== true) {
      await iterator.return?.();
    }
  } catch {
    // A broken redirect body does not matter; the next hop is a new request.
  }
}

function blocked(code: RefinedErrorCode | undefined, message: string) {
  return amberError("network_blocked_by_policy", message, code === undefined ? {} : { code });
}

function tooLarge(maxBytes: number) {
  return amberError("media_too_large", `media exceeds ${maxBytes} bytes`, { params: { limit: formatBytes(maxBytes) } });
}

/** A full disk (or quota) while writing is `disk_low`; everything else passes through. */
function toDiskError(error: unknown): unknown {
  if (isAmberError(error)) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? amberError("disk_low", "no space left while downloading media") : error;
}
