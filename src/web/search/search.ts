import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  SEARCH_QUERY_MAX_CHARS,
  searchResultDtoSchema,
  type CollectionHitDto,
  type ContentHitDto,
  type SearchRange,
  type SearchResultDto,
  type SegmentHitDto,
  type SpeakerHitDto,
  type SummaryHitDto,
} from "../../shared/dto/search.ts";
import { useApi } from "../api/context.tsx";
import { queryString } from "../api/queries.ts";

/** Typing pause before a query is sent; keeps one request per word rather than per key. */
const SEARCH_DEBOUNCE_MS = 200;

/** `global` (Omnibox), `library` (all contents page) or a collection id (collection page). */
export type SearchScopeParam = "global" | "library" | string;

export const searchKeys = {
  all: ["search"] as const,
  query: (q: string, scope: SearchScopeParam) => ["search", scope, q] as const,
};

/** What a search box should send: trimmed, bounded, and empty when there is nothing to look for. */
export function normalizeQuery(text: string): string {
  return text.trim().slice(0, SEARCH_QUERY_MAX_CHARS);
}

export function useDebounced<T>(value: T, delayMs = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * `GET /api/search` for the debounced query; idle while the query is empty.
 * `active` tells whether a query is in effect at all, so callers can switch views at once
 * instead of waiting for the debounce.
 */
export function useSearch(text: string, scope: SearchScopeParam) {
  const client = useApi();
  const q = useDebounced(normalizeQuery(text));
  const result = useQuery<SearchResultDto>({
    queryKey: searchKeys.query(q, scope),
    queryFn: ({ signal }) => client.get(`/api/search${queryString({ q, scope })}`, searchResultDtoSchema, { signal }),
    enabled: q !== "",
    placeholderData: (previous) => previous,
  });
  return { ...result, query: q, active: normalizeQuery(text) !== "" };
}

export type ContentSideHit =
  | { kind: "content"; hit: ContentHitDto }
  | { kind: "segment"; hit: SegmentHitDto }
  | { kind: "summary"; hit: SummaryHitDto };

/** Where a hit opens; the query travels along for in-page locating. */
export function hitLink(entry: ContentSideHit | { kind: "collection"; hit: CollectionHitDto }, query: string): string {
  const search = new URLSearchParams();
  switch (entry.kind) {
    case "collection":
      return `/collections/${encodeURIComponent(entry.hit.collectionId)}`;
    case "segment":
      search.set("tab", "transcript");
      search.set("revision", entry.hit.transcriptRevisionId);
      search.set("segment", entry.hit.segmentId);
      break;
    case "summary":
      search.set("tab", "summary");
      break;
    case "content":
      break;
  }
  search.set("search", query);
  return `/contents/${encodeURIComponent(entry.hit.contentId)}?${search.toString()}`;
}

/**
 * Where a speaker found by name opens: the Content's reading view showing only that
 * speaker. The query is a name, not words of the text, so it does not travel along.
 */
export function speakerHitLink(hit: Pick<SpeakerHitDto, "contentId" | "speakerId">): string {
  const search = new URLSearchParams({ tab: "transcript", speaker: hit.speakerId });
  return `/contents/${encodeURIComponent(hit.contentId)}?${search.toString()}`;
}

/** Whether a summary hit was generated with speakers that no longer hold as they did. */
export function summaryBasisChanged(hit: Pick<SummaryHitDto, "speakerContextState">): boolean {
  return hit.speakerContextState !== undefined && hit.speakerContextState !== "consistent";
}

/**
 * The Contents a result mentions, best first, each with the first hit that named it:
 * groups are taken in the order contents, sentences, summaries and kept in their own
 * relevance order, so a title match outranks a sentence match.
 */
export function hitsByContent(result: SearchResultDto): Array<{ contentId: string; title: string | undefined; first: ContentSideHit }> {
  const seen = new Map<string, { contentId: string; title: string | undefined; first: ContentSideHit }>();
  const add = (contentId: string, title: string | undefined, entry: ContentSideHit): void => {
    if (!seen.has(contentId)) {
      seen.set(contentId, { contentId, title, first: entry });
    }
  };
  for (const hit of result.contents) add(hit.contentId, hit.title, { kind: "content", hit });
  for (const hit of result.segments) add(hit.contentId, hit.contentTitle, { kind: "segment", hit });
  for (const hit of result.summaries) add(hit.contentId, hit.contentTitle, { kind: "summary", hit });
  return [...seen.values()];
}

/** Sorted, clamped, non-overlapping copy of `ranges` within `text`. */
export function normalizeRanges(text: string, ranges: readonly SearchRange[]): SearchRange[] {
  const sorted = ranges
    .map((range) => ({ start: Math.max(0, Math.min(range.start, text.length)), end: Math.max(0, Math.min(range.end, text.length)) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Occurrences of the query's whitespace-separated terms in `text`, case-insensitively, for
 * locating the search terms inside a page the hit opened.
 */
export function termRanges(text: string, query: string): SearchRange[] {
  const haystack = text.toLocaleLowerCase();
  const ranges: SearchRange[] = [];
  for (const term of query.toLocaleLowerCase().split(/\s+/).filter((part) => part !== "")) {
    // Lower-casing can change length outside ASCII; offsets are only trusted when it did not.
    if (haystack.length !== text.length) {
      break;
    }
    for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) {
      ranges.push({ start: at, end: at + term.length });
    }
  }
  return normalizeRanges(text, ranges);
}
