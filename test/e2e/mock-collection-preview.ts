import type { Request, Route } from "@playwright/test";
import { collectionDetailDtoSchema, collectionSummaryDtoSchema } from "../../src/shared/dto/collection.ts";
import { importResponseSchema, inspectResponseSchema, type CollectionEntryState, type ImportRequest, type InspectRequest } from "../../src/shared/dto/import.ts";
import { COLLECTION_PREVIEW_PAGE_SIZE } from "../../src/shared/defaults.ts";

/*
 * A made-up YouTube playlist for the collection preview: more entries than one preview page, a
 * few of them in each state the preview shows. Ids and titles are invented.
 */

export const PREVIEW_LIST_URL = "https://www.youtube.com/playlist?list=PLmockpreview00000001";
export const PREVIEW_LIST_TITLE = "模拟播放列表：系统设计入门";
/** The local collection the import joins, opened after it. */
export const PREVIEW_COLLECTION = "01J0000000000000000000PC01";
export const PREVIEW_ENTRY_COUNT = COLLECTION_PREVIEW_PAGE_SIZE + 6;
const PREVIEW_ID = "mock-preview-1";
const NOW = 1_760_000_000_000;

export const previewEntryId = (index: number): string => `mockPv${String(index + 1).padStart(5, "0")}`;
export const previewEntryTitle = (index: number): string => `第 ${index + 1} 讲：模拟章节`;

/** States by 0-based position; the rest are new to the library. */
const STATES: Readonly<Record<number, CollectionEntryState>> = {
  1: "processing",
  2: "in_library",
  4: "in_collection",
  6: "trashed",
  8: "unavailable",
};

function entry(index: number) {
  const state = STATES[index] ?? "new";
  const id = previewEntryId(index);
  return {
    platformContentId: id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    index,
    state,
    ...(state === "unavailable" ? { unavailableReason: "private" as const } : { title: previewEntryTitle(index), durationMs: (8 + (index % 7)) * 60_000 }),
    ...(state === "new" || state === "unavailable" ? {} : { contentId: `01J00000000000000000PCC${String(index).padStart(3, "0")}` }),
  };
}

/** What the last import of chosen entries created, in platform order, for the collection page. */
let members: string[] = [];

/**
 * The browser smoke's fake of collection previews (`POST /api/contents/inspect` for the playlist,
 * its later pages, the import of chosen entries and the collection it joins). Answers `false` for
 * anything it does not handle, so the main fake keeps its own routes.
 */
export async function handleCollectionPreview(route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (method === "POST" && url.pathname === "/api/contents/inspect") {
    const body = request.postDataJSON() as InspectRequest;
    if (body.url !== PREVIEW_LIST_URL) return false;
    const offset = body.previewId === PREVIEW_ID ? (body.offset ?? 0) : 0;
    const end = Math.min(offset + COLLECTION_PREVIEW_PAGE_SIZE, PREVIEW_ENTRY_COUNT);
    await json(
      inspectResponseSchema.parse({
        kind: "collection",
        canonicalUrl: PREVIEW_LIST_URL,
        title: PREVIEW_LIST_TITLE,
        previewId: PREVIEW_ID,
        itemCount: PREVIEW_ENTRY_COUNT,
        totalCount: PREVIEW_ENTRY_COUNT,
        offset,
        ...(end < PREVIEW_ENTRY_COUNT ? { nextOffset: end } : {}),
        items: Array.from({ length: end - offset }, (_, index) => entry(offset + index)),
      }),
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/api/contents/import") {
    const body = request.postDataJSON() as ImportRequest;
    const chosen = body.items.find((item) => item.url === PREVIEW_LIST_URL)?.entries;
    if (chosen === undefined) return false;
    const order = Array.from({ length: PREVIEW_ENTRY_COUNT }, (_, index) => previewEntryId(index));
    members = [...chosen].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const contentIds = chosen.map((id) => `01J0000000000000000C${id.slice(-6)}`);
    await json(
      importResponseSchema.parse({
        importBatchId: "01J00000000000000000PBATCH",
        taskIds: chosen.map((id) => `01J0000000000000000T${id.slice(-6)}`),
        contentIds,
        collectionIds: [PREVIEW_COLLECTION],
      }),
      202,
    );
    return true;
  }

  if (method === "GET" && url.pathname === `/api/collections/${PREVIEW_COLLECTION}`) {
    const order = Array.from({ length: PREVIEW_ENTRY_COUNT }, (_, index) => previewEntryId(index));
    await json(
      collectionDetailDtoSchema.parse({
        id: PREVIEW_COLLECTION,
        name: PREVIEW_LIST_TITLE,
        platformCollectionId: "PLmockpreview00000001",
        itemCount: members.length,
        createdAt: NOW,
        updatedAt: NOW,
        items: members.map((id, position) => {
          const index = order.indexOf(id);
          return {
            id: `01J0000000000000000I${id.slice(-6)}`,
            contentId: `01J0000000000000000C${id.slice(-6)}`,
            position,
            addedAt: NOW,
            title: previewEntryTitle(index),
            processingStatus: "queued",
            sourceUrl: `https://www.youtube.com/watch?v=${id}`,
            source: { kind: "youtube" },
            updatedAt: NOW,
          };
        }),
      }),
    );
    return true;
  }

  if (method === "GET" && url.pathname === `/api/collections/${PREVIEW_COLLECTION}/summary`) {
    await json(collectionSummaryDtoSchema.parse({ stale: false }));
    return true;
  }
  return false;
}
