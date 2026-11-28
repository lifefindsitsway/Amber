import { PLATFORM_JSON_MAX_BYTES, PLATFORM_METADATA_TIMEOUT_MS } from "../../../shared/defaults.ts";
import { amberError } from "../../domain/errors.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundResponse } from "../../ports/outbound-http.ts";

/** A desktop browser identity; platform web APIs reject requests without one. */
export const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface PlatformGet {
  url: string;
  headers?: Readonly<Record<string, string>>;
  signal: AbortSignal;
  /** `manual` returns a 3xx as is (short-link expansion walks the chain hop by hop). */
  redirect?: "follow" | "manual";
  /**
   * The calling adapter's own `trustedHosts`, passed on with the request: only a hop whose host
   * is on it may go through the configured proxy. Each adapter passes its own table, never
   * another platform's.
   */
  trustedHosts: readonly string[];
  /**
   * Bounds the request up to its response headers, each wait for the next body chunk, and the
   * whole body read; `PLATFORM_METADATA_TIMEOUT_MS` when absent.
   */
  timeoutMs?: number;
}

/**
 * Sends one platform GET. Transport failures become source error classes; an abort and every
 * AmberError the outbound client raises itself (a policy refusal, an unusable or unreachable
 * proxy) pass through unchanged, so their class and code reach the caller as raised.
 */
async function send(http: OutboundHttpClient, request: PlatformGet): Promise<OutboundResponse> {
  try {
    return await http.request({
      url: request.url,
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT, ...request.headers },
      signal: request.signal,
      timeoutMs: request.timeoutMs ?? PLATFORM_METADATA_TIMEOUT_MS,
      // Platform hosts are fixed public names: a platform request never reaches a private or
      // reserved address, whatever the run mode trusts otherwise.
      publicOnly: true,
      trustedHosts: request.trustedHosts,
      ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
    });
  } catch (error) {
    if (error instanceof OutboundHttpError && error.reason !== "aborted") {
      throw amberError("source_unreachable", error.message);
    }
    throw error;
  }
}

function tooLarge(maxBytes: number): Error {
  return amberError("source_html_error_page", `platform response exceeded ${maxBytes} bytes`);
}

/** The source error class of a non-2xx platform answer: 412 / 429 are risk control, the rest unreachable. */
function statusError(status: number): Error | undefined {
  if (status === 412 || status === 429) {
    return amberError("platform_blocked", `platform answered HTTP ${status}`);
  }
  if (status < 200 || status >= 300) {
    return amberError("source_unreachable", `platform answered HTTP ${status}`);
  }
  return undefined;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** The `Location` of a 3xx resolved against the request URL; absent for anything else or an unusable value. */
function locationOf(response: OutboundResponse, requestUrl: string): string | undefined {
  const raw = isRedirect(response.status) ? response.headers.get("location") : undefined;
  if (raw === undefined) {
    return undefined;
  }
  try {
    return new URL(raw, requestUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * The body's bytes, `maxBytes` at most. A declared `Content-Length` above the cap is refused
 * before anything is read; a body that grows past it is dropped at the chunk that crosses it.
 * A body that goes `timeoutMs` without a byte, or that is still arriving `timeoutMs` after the
 * read began, is given up as unreachable: a request's own time limit ends at the response
 * headers, and a trickling answer must not hold a caller (and the heavy slot it may hold) for
 * ever. Every early end destroys the response, which drops the connection without waiting for
 * a stalled read to settle.
 */
async function readCapped(response: OutboundResponse, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (declared > maxBytes) {
    response.destroy?.();
    throw tooLarge(maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The next chunk, or a timeout error once the stall or the whole-read limit passes first.
  const nextChunk = (): Promise<IteratorResult<Uint8Array>> =>
    new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      const left = deadline - Date.now();
      const message = left < timeoutMs ? `platform response took longer than ${timeoutMs} ms` : `platform response sent nothing for ${timeoutMs} ms`;
      timer = setTimeout(() => reject(amberError("source_unreachable", message)), Math.max(0, left));
      iterator.next().then(resolve, reject);
    }).finally(() => clearTimeout(timer));
  try {
    for (;;) {
      const next = await nextChunk();
      if (next.done === true) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw tooLarge(maxBytes);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.destroy?.();
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    if (error instanceof OutboundHttpError && error.reason !== "aborted") {
      throw amberError("source_unreachable", error.message);
    }
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/** What a GET answered without its body: enough to walk a redirect chain or tell a status. */
export interface PlatformHop {
  status: number;
  headers: ReadonlyMap<string, string>;
  /** The `Location` of a 3xx, resolved against the request URL; absent otherwise. */
  location?: string;
}

/**
 * GETs one response without following redirects and discards its body unread (short-link
 * hops need only the status and `Location`). A transport failure is `source_unreachable`; an
 * abort passes through.
 */
export async function platformGetHop(http: OutboundHttpClient, request: PlatformGet): Promise<PlatformHop> {
  const response = await send(http, { ...request, redirect: "manual" });
  response.destroy?.();
  const location = locationOf(response, request.url);
  return { status: response.status, headers: response.headers, ...(location === undefined ? {} : { location }) };
}

export interface PlatformGetJson extends PlatformGet {
  /** Most body bytes read; `PLATFORM_JSON_MAX_BYTES` when absent. A longer answer fails with `source_html_error_page`. */
  maxBytes?: number;
}

/**
 * GETs a JSON document read within `maxBytes`, as an unchecked value for the caller to
 * validate. 412 / 429 mean the platform's risk control, other non-2xx answers (an unfollowed
 * 3xx included) are unreachable and discarded unread; a body that is not JSON is
 * `source_html_error_page`.
 */
export async function platformGetJson(http: OutboundHttpClient, request: PlatformGetJson): Promise<unknown> {
  return (await platformGetJsonWithCookies(http, request)).body;
}

/** `platformGetJson` plus the cookies the platform set, for login flows. */
export async function platformGetJsonWithCookies(http: OutboundHttpClient, request: PlatformGetJson): Promise<{ body: unknown; setCookies: readonly string[] }> {
  const { maxBytes, ...get } = request;
  const response = await send(http, get);
  const refused = statusError(response.status);
  if (refused !== undefined) {
    response.destroy?.();
    throw refused;
  }
  const bytes = await readCapped(response, maxBytes ?? PLATFORM_JSON_MAX_BYTES, get.timeoutMs ?? PLATFORM_METADATA_TIMEOUT_MS);
  try {
    return { body: JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown, setCookies: response.setCookies ?? [] };
  } catch {
    throw amberError("source_html_error_page", "platform answered with something other than JSON");
  }
}

export interface PlatformGetBytes extends PlatformGet {
  /** Most body bytes read; a longer answer is abandoned as soon as it shows. */
  maxBytes: number;
}

/**
 * GETs a body as raw bytes, as sent (no content decoding), reading at most `maxBytes`: a
 * `Content-Length` above it is refused before reading, and a body that grows past it is
 * dropped at the chunk that crosses it (`source_html_error_page`). Statuses map as in
 * `platformGetJson`, the error answer discarded unread. A transport failure while reading is
 * `source_unreachable`; an abort passes through.
 */
export async function platformGetBytes(http: OutboundHttpClient, request: PlatformGetBytes): Promise<{ headers: ReadonlyMap<string, string>; bytes: Uint8Array }> {
  const { maxBytes, ...get } = request;
  const response = await send(http, get);
  const refused = statusError(response.status);
  if (refused !== undefined) {
    response.destroy?.();
    throw refused;
  }
  return { headers: response.headers, bytes: await readCapped(response, maxBytes, get.timeoutMs ?? PLATFORM_METADATA_TIMEOUT_MS) };
}

export interface PlatformGetText extends PlatformGet {
  /** Most body bytes read (`PLATFORM_PAGE_MAX_BYTES` for pages, `PLATFORM_JSON_MAX_BYTES` for JSON). */
  maxBytes: number;
}

/** One platform answer read whole as UTF-8 text, with what deciding about it needs. */
export interface PlatformTextResponse {
  status: number;
  headers: ReadonlyMap<string, string>;
  /** The `Location` of a 3xx, resolved against the request URL; absent otherwise. */
  location?: string;
  setCookies: readonly string[];
  /** The body; always empty for a 3xx, whose body is discarded unread. */
  text: string;
}

/**
 * GETs one response without following redirects and returns its status and text, the body
 * read within `maxBytes` (a longer one fails with `source_html_error_page`). A 3xx is not
 * followed and its body is discarded unread. Statuses are not mapped: adapters that must tell
 * a login redirect, a signature refusal or an empty answer apart decide themselves. A
 * transport failure is `source_unreachable`; an abort passes through.
 */
export async function platformGetText(http: OutboundHttpClient, request: PlatformGetText): Promise<PlatformTextResponse> {
  const { maxBytes, ...get } = request;
  const response = await send(http, { ...get, redirect: "manual" });
  const location = locationOf(response, request.url);
  let text = "";
  if (isRedirect(response.status)) {
    response.destroy?.();
  } else {
    text = new TextDecoder("utf-8").decode(await readCapped(response, maxBytes, get.timeoutMs ?? PLATFORM_METADATA_TIMEOUT_MS));
  }
  return {
    status: response.status,
    headers: response.headers,
    ...(location === undefined ? {} : { location }),
    setCookies: response.setCookies ?? [],
    text,
  };
}
