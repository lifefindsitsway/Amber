import type { WebSearchService } from "../../shared/enums.ts";

/**
 * One result as the search service returned it, normalized only in shape: the URL, title
 * and text are the service's own and still untrusted; the application filters, cuts and
 * ranks them before any model sees them.
 */
export interface WebSearchResult {
  url: string;
  title: string;
  /** The service's excerpt of the page. */
  content: string;
  /** Relevance as the service scores it; higher is better. */
  score?: number;
  /** Unix ms; only when the service gave a valid date. */
  publishedAt?: number;
}

export interface WebSearchOptions {
  maxResults: number;
  /** The user's key, revealed for this request only; adapters never keep or log it. */
  apiKey: string;
  /** The caller's cancellation; the adapter adds its own time limit on top. */
  signal: AbortSignal;
}

/**
 * Invariant: the web search boundary. One adapter per search service, each talking to the
 * fixed official origin of its service through the OutboundHttpClient; request and response
 * field names stay inside `adapters/web-search/<service>/`. Failures are thrown as
 * `web_search_failed.*` AmberErrors; a cancellation through `signal` is rethrown as it came
 * from the transport. Adapters never retry, and never log the query, the results or the key.
 */
export interface WebSearchProvider {
  readonly service: WebSearchService;
  search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]>;
}
