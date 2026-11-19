import { PLATFORM_METADATA_TIMEOUT_MS } from "../../../shared/defaults.ts";
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
}

/** Transport failures and HTTP errors of a platform request, as source error classes. */
async function send(http: OutboundHttpClient, request: PlatformGet, timeoutMs = PLATFORM_METADATA_TIMEOUT_MS): Promise<OutboundResponse> {
  try {
    return await http.request({
      url: request.url,
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT, ...request.headers },
      signal: request.signal,
      timeoutMs,
      ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
    });
  } catch (error) {
    if (error instanceof OutboundHttpError && error.reason !== "aborted") {
      throw amberError("source_unreachable", error.message);
    }
    throw error;
  }
}

/** The response of a GET without following redirects; the caller reads what it needs. */
export async function platformGet(http: OutboundHttpClient, request: PlatformGet): Promise<OutboundResponse> {
  return send(http, { ...request, redirect: "manual" });
}

/** GETs a JSON document; 412 / 429 mean the platform's risk control, other errors are unreachable. */
export async function platformGetJson<T>(http: OutboundHttpClient, request: PlatformGet): Promise<T> {
  return (await platformGetJsonWithCookies<T>(http, request)).body;
}

/** `platformGetJson` plus the cookies the platform set, for login flows. */
export async function platformGetJsonWithCookies<T>(http: OutboundHttpClient, request: PlatformGet): Promise<{ body: T; setCookies: readonly string[] }> {
  const response = await send(http, request);
  const text = await response.text();
  if (response.status === 412 || response.status === 429) {
    throw amberError("platform_blocked", `platform answered HTTP ${response.status}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw amberError("source_unreachable", `platform answered HTTP ${response.status}`);
  }
  try {
    return { body: JSON.parse(text) as T, setCookies: response.setCookies ?? [] };
  } catch {
    throw amberError("source_html_error_page", "platform answered with something other than JSON");
  }
}

export interface PlatformGetBytes extends PlatformGet {
  /** Most body bytes read; a longer answer is abandoned as soon as it shows. */
  maxBytes: number;
  /** Bounds each hop up to its response headers; `PLATFORM_METADATA_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
}

function tooLarge(maxBytes: number): Error {
  return amberError("source_html_error_page", `platform response exceeded ${maxBytes} bytes`);
}

/** The source error class of a non-2xx platform answer, as `platformGetJson` maps it. */
function statusError(status: number): Error | undefined {
  if (status === 412 || status === 429) {
    return amberError("platform_blocked", `platform answered HTTP ${status}`);
  }
  if (status < 200 || status >= 300) {
    return amberError("source_unreachable", `platform answered HTTP ${status}`);
  }
  return undefined;
}

/** The body's bytes, `maxBytes` at most; leaving the loop early ends the iterator, which drops the connection. */
async function readCapped(response: OutboundResponse, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes || declared > maxBytes) {
        throw tooLarge(maxBytes);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof OutboundHttpError && error.reason !== "aborted") {
      throw amberError("source_unreachable", error.message);
    }
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/**
 * GETs a body as raw bytes, as sent (no content decoding), reading at most `maxBytes`: a
 * `Content-Length` above it is refused at the first chunk, and a body that grows past it is
 * dropped at the chunk that crosses it (`source_html_error_page`). Statuses map as in
 * `platformGetJson`; an error page is read within the same cap and discarded. A transport
 * failure while reading is `source_unreachable`; an abort passes through.
 */
export async function platformGetBytes(http: OutboundHttpClient, request: PlatformGetBytes): Promise<{ headers: ReadonlyMap<string, string>; bytes: Uint8Array }> {
  const { maxBytes, timeoutMs, ...get } = request;
  const response = await send(http, get, timeoutMs);
  const refused = statusError(response.status);
  if (refused !== undefined) {
    try {
      await readCapped(response, maxBytes);
    } catch (error) {
      if (get.signal.aborted) {
        throw error;
      }
    }
    throw refused;
  }
  return { headers: response.headers, bytes: await readCapped(response, maxBytes) };
}
