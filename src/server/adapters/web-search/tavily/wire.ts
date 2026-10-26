import { z } from "zod";
import { amberError, type AmberError } from "../../../domain/errors.ts";
import type { WebSearchResult } from "../../../ports/web-search.ts";

/**
 * The Tavily Search wire format. Invariant: these field names never leave this directory;
 * callers see `WebSearchResult` only.
 */

/** Tavily's own statuses for an exhausted key or plan (432) and pay-as-you-go limit (433). */
const PLAN_LIMIT_STATUS = 432;
const PAYG_LIMIT_STATUS = 433;

/**
 * The request body. `basic` depth costs one credit per search; `include_published_date`
 * must be asked for, else results carry no date.
 */
export function requestBody(query: string, maxResults: number): string {
  return JSON.stringify({ query, search_depth: "basic", max_results: maxResults, include_published_date: true });
}

// Lenient on purpose: a result without a usable URL is skipped rather than failing the
// whole answer, and optional fields may be absent or null.
const resultSchema = z.object({
  url: z.unknown(),
  title: z.unknown().optional(),
  content: z.unknown().optional(),
  score: z.unknown().optional(),
  published_date: z.unknown().optional(),
});
const responseSchema = z.object({ results: z.array(z.unknown()) });

/** The results of a 2xx answer; anything that is not the documented shape is `bad_response`. */
export function decodeResponse(text: string): WebSearchResult[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badResponse("search answer is not JSON");
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw badResponse("search answer has no result list");
  }
  const results: WebSearchResult[] = [];
  for (const item of parsed.data.results) {
    const entry = resultSchema.safeParse(item);
    if (!entry.success || typeof entry.data.url !== "string") {
      continue;
    }
    const { url, title, content, score, published_date: publishedDate } = entry.data;
    const publishedAt = typeof publishedDate === "string" ? Date.parse(publishedDate) : Number.NaN;
    results.push({
      url,
      title: typeof title === "string" ? title : "",
      content: typeof content === "string" ? content : "",
      ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
      ...(Number.isFinite(publishedAt) ? { publishedAt } : {}),
    });
  }
  return results;
}

/**
 * The AmberError for a non-2xx answer, by status alone. The answer's text is not kept: it
 * may echo the query, which must not end up in stored errors or logs.
 */
export function statusError(status: number, retryAfter: number | undefined): AmberError {
  const internal = `search service answered HTTP ${status}`;
  if (status === 401) {
    return amberError("web_search_failed", internal, { code: "web_search_failed.auth" });
  }
  if (status === PLAN_LIMIT_STATUS || status === PAYG_LIMIT_STATUS) {
    return amberError("web_search_failed", internal, { code: "web_search_failed.quota" });
  }
  if (status === 429) {
    return amberError("web_search_failed", internal, {
      code: "web_search_failed.rate_limited",
      ...(retryAfter === undefined ? {} : { details: { retryAfterMs: retryAfter } }),
    });
  }
  if (status === 400 || status === 422) {
    return amberError("web_search_failed", internal, { code: "web_search_failed.invalid_query" });
  }
  return amberError("web_search_failed", internal, {
    code: "web_search_failed.unavailable",
    details: { reason: status >= 500 ? "server_error" : "bad_response" },
  });
}

export function badResponse(internal: string): AmberError {
  return amberError("web_search_failed", internal, { code: "web_search_failed.unavailable", details: { reason: "bad_response" } });
}

/** IMF-fixdate, the only HTTP date form senders generate today. */
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** `Retry-After` as milliseconds from `now`: delay-seconds or an HTTP date; unreadable values are ignored. */
export function retryAfterMs(value: string | undefined, now: number): number | undefined {
  const first = value?.split(",")[0]?.trim();
  if (first === undefined || first === "") {
    return undefined;
  }
  if (/^\d+$/.test(first)) {
    return Number(first) * 1000;
  }
  // A date contains a comma itself, so it is matched against the whole value.
  const date = value?.trim() ?? "";
  if (!HTTP_DATE.test(date)) {
    return undefined;
  }
  const at = Date.parse(date);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
