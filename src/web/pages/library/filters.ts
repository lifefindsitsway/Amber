import { CONTENT_PROCESSING_STATUSES, CONTENT_SOURCE_KINDS, type ContentProcessingStatus, type ContentSourceKind } from "../../../shared/enums.ts";
import { PAGE_PARAM } from "../../ui/pagination.tsx";

/** Library filters as they live in the URL query. */
export interface LibraryFilters {
  status?: ContentProcessingStatus;
  source?: ContentSourceKind;
  collectionId?: string;
  /** `uncollected=1`: Contents in no collection; it gives way to a named collection. */
  uncollected?: boolean;
  importBatchId?: string;
}

const FILTER_KEYS = ["status", "source", "collectionId", "importBatchId"] as const;

/** The collection select's choice for 「未加入合集」; collection ids are ULIDs, so it cannot clash. */
export const UNCOLLECTED_CHOICE = "-uncollected";

/** Reads the filters, ignoring values the API would reject. */
export function filtersFromSearch(search: URLSearchParams): LibraryFilters {
  const filters: LibraryFilters = {};
  const status = search.get("status");
  if (status !== null && (CONTENT_PROCESSING_STATUSES as readonly string[]).includes(status)) {
    filters.status = status as ContentProcessingStatus;
  }
  const source = search.get("source");
  if (source !== null && (CONTENT_SOURCE_KINDS as readonly string[]).includes(source)) {
    filters.source = source as ContentSourceKind;
  }
  const collectionId = search.get("collectionId");
  if (collectionId !== null && collectionId !== "") {
    filters.collectionId = collectionId;
  }
  if (filters.collectionId === undefined && search.get("uncollected") === "1") {
    filters.uncollected = true;
  }
  const importBatchId = search.get("importBatchId");
  if (importBatchId !== null && importBatchId !== "") {
    filters.importBatchId = importBatchId;
  }
  return filters;
}

/**
 * Writes one filter back into a copy of the query; an empty value removes it. A changed filter
 * starts again on page 1, so the page is dropped; the page size and other params stay.
 */
export function withFilter(search: URLSearchParams, key: (typeof FILTER_KEYS)[number], value: string | undefined): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete(PAGE_PARAM);
  if (value === undefined || value === "") {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  return next;
}

/** The collection select's value for the current filters. */
export function collectionChoiceOf(filters: LibraryFilters): string {
  return filters.uncollected === true ? UNCOLLECTED_CHOICE : (filters.collectionId ?? "");
}

/** Writes the collection select's choice: one collection, 「未加入合集」, or any. Back to page 1, other params stay. */
export function withCollectionChoice(search: URLSearchParams, choice: string): URLSearchParams {
  const next = withFilter(search, "collectionId", choice === UNCOLLECTED_CHOICE ? undefined : choice);
  if (choice === UNCOLLECTED_CHOICE) {
    next.set("uncollected", "1");
  } else {
    next.delete("uncollected");
  }
  return next;
}
