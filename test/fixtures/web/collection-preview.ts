import { inspectResponseSchema, type CollectionEntryState, type ENTRY_UNAVAILABLE_REASONS, type InspectRequest } from "../../../src/shared/dto/import.ts";
import type { RecordedCall } from "./render.tsx";

/** One entry of a fake platform collection; made-up ids and titles. */
export interface FakeEntry {
  id: string;
  title?: string;
  state?: CollectionEntryState;
  durationMs?: number;
  partCount?: number;
  unavailableReason?: (typeof ENTRY_UNAVAILABLE_REASONS)[number];
  coverUrl?: string;
  /** The entry's own link; by default the collection link with the id as its fragment. */
  canonicalUrl?: string;
}

export interface FakeCollection {
  url: string;
  title?: string;
  entries: FakeEntry[];
  pageSize: number;
  totalCount?: number;
  truncated?: boolean;
}

export const STALE_REPLY = {
  status: 409,
  body: { error: { class: "conflict", code: "conflict.collection_preview_stale", retryDisposition: "never", userMessage: "合集内容已变化或预览已过期，请重新读取" } },
};

/** `count` new entries `<prefix>1`…, each ten minutes long. */
export function newEntries(count: number, prefix = "v", from = 1): FakeEntry[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${from + index}`, title: `第 ${from + index} 讲`, durationMs: 600_000 }));
}

/**
 * The inspect route of a fake server holding these collections, paged by each one's `pageSize`.
 * Every first-page read (no preview id) hands out a fresh preview id; a later page asked with any
 * other id answers `conflict.collection_preview_stale`, as an expired preview would. `requests`
 * records the bodies; `expire()` makes the current ids stale; `fail` answers the next reads with
 * the given replies first.
 */
export function fakeInspect(collections: FakeCollection[]) {
  const requests: InspectRequest[] = [];
  const current = new Map<string, string>();
  const queued: Array<{ status: number; body: unknown }> = [];
  let issued = 0;
  const reply = (call: RecordedCall): { status?: number; body?: unknown } => {
    const body = call.body as InspectRequest;
    requests.push(body);
    const next = queued.shift();
    if (next !== undefined) return next;
    const collection = collections.find((candidate) => candidate.url === body.url);
    if (collection === undefined) return { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } };
    if (body.previewId !== undefined && current.get(body.url) !== body.previewId) return STALE_REPLY;
    if (body.previewId === undefined) {
      issued += 1;
      current.set(body.url, `pv${issued}`);
    }
    const offset = body.offset ?? 0;
    const end = offset + collection.pageSize;
    const answer = inspectResponseSchema.parse({
      kind: "collection",
      canonicalUrl: collection.url,
      ...(collection.title === undefined ? {} : { title: collection.title }),
      previewId: current.get(body.url),
      itemCount: collection.entries.length,
      offset,
      ...(end < collection.entries.length ? { nextOffset: end } : {}),
      ...(collection.totalCount === undefined ? {} : { totalCount: collection.totalCount }),
      ...(collection.truncated === undefined ? {} : { truncated: collection.truncated }),
      items: collection.entries.slice(offset, end).map((entry, index) => ({
        platformContentId: entry.id,
        canonicalUrl: entry.canonicalUrl ?? `${collection.url}#${entry.id}`,
        index: offset + index,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
        ...(entry.partCount === undefined ? {} : { partCount: entry.partCount }),
        ...(entry.coverUrl === undefined ? {} : { coverUrl: entry.coverUrl }),
        state: entry.state ?? "new",
        ...(entry.unavailableReason === undefined ? {} : { unavailableReason: entry.unavailableReason }),
        ...(entry.state !== undefined && entry.state !== "new" && entry.state !== "unavailable" ? { contentId: `c-${entry.id}` } : {}),
      })),
    });
    return { body: answer };
  };
  return {
    reply,
    requests,
    expire: () => current.clear(),
    fail: (...replies: Array<{ status: number; body: unknown }>) => queued.push(...replies),
  };
}
