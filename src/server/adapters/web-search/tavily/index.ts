import { WEB_SEARCH_RESPONSE_MAX_BYTES, WEB_SEARCH_TIMEOUT_MS } from "../../../../shared/defaults.ts";
import { amberError, isAmberError } from "../../../domain/errors.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundResponse } from "../../../ports/outbound-http.ts";
import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "../../../ports/web-search.ts";
import { badResponse, decodeResponse, requestBody, retryAfterMs, statusError } from "./wire.ts";

/** The fixed official endpoint: user input never chooses where a search goes. */
const SEARCH_URL = "https://api.tavily.com/search";

export interface TavilyWebSearchProviderOptions {
  http: OutboundHttpClient;
  now?: () => number;
  /** Overridable for tests only; production uses the named defaults. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** The answer outgrew the reading limit; carries nothing of it. */
class TooLarge extends Error {}

/**
 * Tavily Search. One POST per query, bounded as a whole (connection, headers and body) by
 * `WEB_SEARCH_TIMEOUT_MS`; the body is read as it arrives and the request is aborted the
 * moment it passes `WEB_SEARCH_RESPONSE_MAX_BYTES`, so a hostile or broken answer never
 * makes the process hold more than that.
 */
export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly service = "tavily";
  private readonly options: TavilyWebSearchProviderOptions;
  private readonly now: () => number;

  constructor(options: TavilyWebSearchProviderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    const { signal } = options;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal.reason);
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS);
    try {
      const response = await this.options.http.request({
        url: SEARCH_URL,
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: requestBody(query, options.maxResults),
        signal: controller.signal,
        redirect: "manual",
      });
      const limit = this.options.maxResponseBytes ?? WEB_SEARCH_RESPONSE_MAX_BYTES;
      if (response.status < 200 || response.status >= 300) {
        // The error body is not needed; it is left unread and the request aborted below.
        throw statusError(response.status, response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), this.now()) : undefined);
      }
      return decodeResponse(await readBounded(response, limit));
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof TooLarge) {
        throw amberError("web_search_failed", "search answer exceeds the reading limit", {
          code: "web_search_failed.unavailable",
          details: { reason: "too_large" },
        });
      }
      if (timedOut || error instanceof OutboundHttpError) {
        throw amberError("web_search_failed", timedOut ? "search request timed out" : error instanceof Error ? error.message : "search request failed", {
          code: "web_search_failed.unreachable",
        });
      }
      if (isAmberError(error)) {
        throw error;
      }
      throw badResponse("search answer could not be read");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // Ends whatever is still open of the exchange: an unread error body, an oversized one.
      controller.abort();
    }
  }
}

async function readBounded(response: OutboundResponse, limitBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limitBytes) {
      throw new TooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
