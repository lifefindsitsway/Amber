import type { Request, Route } from "@playwright/test";
import { contentDtoSchema, type ContentDto } from "../../src/shared/dto/content.ts";
import {
  contentTrashPlanDtoSchema,
  contentTrashPlanRequestSchema,
  contentTrashRequestSchema,
  contentTrashResultDtoSchema,
  trashItemDtoSchema,
  trashListDtoSchema,
  trashPurgeAllDtoSchema,
  trashRestoreRequestSchema,
  trashRestoreResultDtoSchema,
  type ContentTrashPlanItemDto,
  type ContentTrashResultDto,
  type TrashItemDto,
  type TrashRestoreResultDto,
} from "../../src/shared/dto/trash.ts";
import { API_PAGE_SIZE_DEFAULT, CONTENT_TRASH_BATCH_MAX, TRASH_RETENTION_DAYS } from "../../src/shared/defaults.ts";
import { ERROR_CLASS_DEFAULTS, errorResponseSchema, type ErrorClass } from "../../src/shared/errors.ts";

/*
 * The trash of the fake backend. Deleting a Content only moves it here: it leaves the
 * listings, and every `/api/contents/:id` endpoint answers 404 until it is restored. Purged
 * Contents stay hidden for good. Times are the real clock rather than the fixed `now` of the
 * other fakes, because the page counts the days left against its own clock.
 *
 * The batch delete (`POST /api/contents/trash-plan`, `POST /api/contents/trash`) sees the
 * unfinished Tasks and the collection summaries a test seeds; cancelling a Content's Tasks
 * clears its seeded count. The batch restore (`POST /api/trash/restore`) judges each id on its
 * own: restored, already back in the library, expired, or unknown.
 */

const DAY_MS = 86_400_000;
const RETENTION_MS = TRASH_RETENTION_DAYS * DAY_MS;

/** A Content that exists only in the trash, its retention already run out. */
export const EXPIRED_TRASH_CONTENT = "01J0000000000000000000TR01";
export const EXPIRED_TRASH_TITLE = "第零讲：已到期的模拟课程";
const EXPIRED_TRASH_VIDEO = "mockExpired1";
const EXPIRED_TRASH_MEDIA_BYTES = 50 * 1024 * 1024;

/** A Content of the library as the trash needs it: its DTO and the bytes of its media files. */
export interface LibraryContent {
  content: ContentDto;
  mediaBytes: number;
}

interface TrashEntry extends LibraryContent {
  trashedAt: number;
}

export interface MockTrash {
  /** Ids in the trash, newest first. */
  ids(): string[];
  /** Ids purged for good, in purge order. */
  purged(): string[];
  /** Moves a library Content to the trash as if the user had deleted it `ageMs` ago. */
  seed(contentId: string, ageMs?: number): TrashItemDto;
  /** Puts a Content whose retention ran out a day ago in the trash: it can only wait for the sweep or be purged. */
  seedExpired(): TrashItemDto;
  /** Gives a library Content `count` unfinished Tasks, which the batch delete must cancel first. */
  seedTasks(contentId: string, count: number): void;
  /** Freezes a library Content in the unfinished summaries of these collections; it cannot be deleted. */
  seedBlocked(contentId: string, collections: Array<{ id: string; name?: string }>): void;
  /** Unfinished Tasks a Content still has. */
  unfinishedTasks(contentId: string): number;
}

type BlockingCollection = { id: string; name?: string };

export class TrashState {
  private readonly entries = new Map<string, TrashEntry>();
  private readonly purgedIds: string[] = [];
  private readonly tasks = new Map<string, number>();
  private readonly blockers = new Map<string, BlockingCollection[]>();
  private readonly lookup: (contentId: string) => LibraryContent | undefined;

  /** `lookup` resolves a Content id the library knows; undefined for unknown ids. */
  constructor(lookup: (contentId: string) => LibraryContent | undefined) {
    this.lookup = lookup;
  }

  /** In the trash or purged: absent from every listing, 404 on every `/api/contents/:id` endpoint. */
  hidden(contentId: string): boolean {
    return this.entries.has(contentId) || this.purgedIds.includes(contentId);
  }

  ordered(): TrashEntry[] {
    return [...this.entries.values()].sort((a, b) => b.trashedAt - a.trashedAt || (a.content.id < b.content.id ? 1 : -1));
  }

  put(entry: LibraryContent, trashedAt: number): TrashItemDto {
    const stored = { ...entry, trashedAt };
    this.entries.set(entry.content.id, stored);
    return item(stored);
  }

  /** `DELETE /api/contents/:id`; false when the Content is unknown, already trashed or purged. */
  trash(contentId: string): boolean {
    const found = this.hidden(contentId) ? undefined : this.lookup(contentId);
    if (found === undefined) return false;
    this.put(found, Date.now());
    return true;
  }

  /** A direct re-import of a trashed platform video restores it first; an expired one is skipped. */
  restoreForImport(contentId: string): "restored" | "expired" | "absent" {
    const entry = this.entries.get(contentId);
    if (entry === undefined) return "absent";
    if (expired(entry)) return "expired";
    this.entries.delete(contentId);
    return "restored";
  }

  take(contentId: string): TrashEntry | undefined {
    return this.entries.get(contentId);
  }

  restore(contentId: string): void {
    this.entries.delete(contentId);
  }

  purge(contentId: string): void {
    this.entries.delete(contentId);
    this.purgedIds.push(contentId);
  }

  /** Where a Content stands before deletion, most binding first, as the server ranks it. */
  planItem(contentId: string): ContentTrashPlanItemDto {
    const entry = this.entries.get(contentId);
    if (entry !== undefined) return { contentId, ...titled(entry.content), state: "trashed" };
    const found = this.purgedIds.includes(contentId) ? undefined : this.lookup(contentId);
    if (found === undefined) return { contentId, state: "missing" };
    const blocking = this.blockers.get(contentId);
    if (blocking !== undefined) return { contentId, ...titled(found.content), state: "blocked", blockingCollections: blocking };
    const unfinished = this.tasks.get(contentId) ?? 0;
    if (unfinished > 0) return { contentId, ...titled(found.content), state: "tasks", unfinishedTaskCount: unfinished };
    return { contentId, ...titled(found.content), state: "ready" };
  }

  /** `POST /api/contents/trash`: each Content on its own; cancelling clears the seeded Tasks first. */
  trashMany(contentIds: readonly string[], cancelTasks: boolean): ContentTrashResultDto {
    const result: ContentTrashResultDto = { trashedIds: [], alreadyTrashedIds: [], failed: [], cancelledTaskCount: 0 };
    for (const contentId of contentIds) {
      const planned = this.planItem(contentId);
      if (planned.state === "trashed") {
        result.alreadyTrashedIds.push(contentId);
      } else if (planned.state === "missing") {
        result.failed.push({ contentId, reason: "missing" });
      } else if (planned.state === "blocked") {
        result.failed.push({ contentId, reason: "summarizing" });
      } else if (planned.state === "tasks" && !cancelTasks) {
        result.failed.push({ contentId, reason: "tasks" });
      } else {
        result.cancelledTaskCount += planned.unfinishedTaskCount ?? 0;
        this.tasks.delete(contentId);
        this.trash(contentId);
        result.trashedIds.push(contentId);
      }
    }
    return contentTrashResultDtoSchema.parse(result);
  }

  /** `POST /api/trash/restore`: each Content on its own. */
  restoreMany(contentIds: readonly string[]): TrashRestoreResultDto {
    const result: TrashRestoreResultDto = { restoredIds: [], alreadyActiveIds: [], failed: [] };
    for (const contentId of contentIds) {
      const entry = this.entries.get(contentId);
      if (entry !== undefined) {
        if (expired(entry)) {
          result.failed.push({ contentId, reason: "expired" });
        } else {
          this.restore(contentId);
          result.restoredIds.push(contentId);
        }
      } else if (!this.purgedIds.includes(contentId) && this.lookup(contentId) !== undefined) {
        result.alreadyActiveIds.push(contentId);
      } else {
        result.failed.push({ contentId, reason: "missing" });
      }
    }
    return trashRestoreResultDtoSchema.parse(result);
  }

  mock(): MockTrash {
    return {
      ids: () => this.ordered().map((entry) => entry.content.id),
      purged: () => [...this.purgedIds],
      seed: (contentId, ageMs = 0) => {
        const found = this.lookup(contentId);
        if (found === undefined) throw new Error(`unknown content ${contentId}`);
        return this.put(found, Date.now() - ageMs);
      },
      seedExpired: () => this.put(expiredContent(), Date.now() - RETENTION_MS - DAY_MS),
      seedTasks: (contentId, count) => {
        if (this.lookup(contentId) === undefined) throw new Error(`unknown content ${contentId}`);
        this.tasks.set(contentId, count);
      },
      seedBlocked: (contentId, collections) => {
        if (this.lookup(contentId) === undefined) throw new Error(`unknown content ${contentId}`);
        this.blockers.set(contentId, collections);
      },
      unfinishedTasks: (contentId) => this.tasks.get(contentId) ?? 0,
    };
  }
}

function titled(content: ContentDto): { title?: string } {
  return content.title === undefined ? {} : { title: content.title };
}

function expired(entry: TrashEntry): boolean {
  return Date.now() >= entry.trashedAt + RETENTION_MS;
}

function item(entry: TrashEntry): TrashItemDto {
  const { content } = entry;
  return trashItemDtoSchema.parse({
    id: content.id,
    ...(content.title === undefined ? {} : { title: content.title }),
    source: content.source,
    ...(content.coverUrl === undefined ? {} : { coverUrl: content.coverUrl }),
    ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
    trashedAt: entry.trashedAt,
    purgeAt: entry.trashedAt + RETENTION_MS,
    expired: expired(entry),
    mediaBytes: entry.mediaBytes,
  });
}

function expiredContent(): LibraryContent {
  const createdAt = Date.now() - RETENTION_MS - 2 * DAY_MS;
  return {
    content: contentDtoSchema.parse({
      id: EXPIRED_TRASH_CONTENT,
      source: { kind: "youtube", sourceUrl: `https://www.youtube.com/watch?v=${EXPIRED_TRASH_VIDEO}`, platformContentId: EXPIRED_TRASH_VIDEO },
      title: EXPIRED_TRASH_TITLE,
      durationMs: 3_600_000,
      processingStatus: "succeeded",
      collections: [],
      createdAt,
      updatedAt: createdAt,
    }),
    mediaBytes: EXPIRED_TRASH_MEDIA_BYTES,
  };
}

function errorBody(errorClass: ErrorClass, code: string, details?: Record<string, unknown>): unknown {
  return errorResponseSchema.parse({
    error: { class: errorClass, code, retryDisposition: ERROR_CLASS_DEFAULTS[errorClass].retryDisposition ?? "never", userMessage: "", ...(details === undefined ? {} : { details }) },
  });
}

/**
 * `/api/trash*`, `DELETE /api/contents/:id`, the batch delete with its pre-check, and the 404
 * of every other `/api/contents/:id` endpoint of a hidden Content; false for anything else.
 */
export async function handleTrash(state: TrashState, route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const notFound = () => json(errorBody("not_found", "not_found"), 404);
  const tooMany = (itemCount: number) => json(errorBody("invalid_request", "invalid_request.batch_too_large", { itemCount, limit: CONTENT_TRASH_BATCH_MAX }), 400);

  // Matched before `/api/contents/:id`, whose pattern would take them for ids.
  if (method === "POST" && path === "/api/contents/trash-plan") {
    const { contentIds } = contentTrashPlanRequestSchema.parse(request.postDataJSON());
    if (contentIds.length > CONTENT_TRASH_BATCH_MAX) return (await tooMany(contentIds.length), true);
    return (await json(contentTrashPlanDtoSchema.parse({ items: contentIds.map((contentId) => state.planItem(contentId)) })), true);
  }
  if (method === "POST" && path === "/api/contents/trash") {
    const { contentIds, cancelTasks } = contentTrashRequestSchema.parse(request.postDataJSON());
    if (contentIds.length > CONTENT_TRASH_BATCH_MAX) return (await tooMany(contentIds.length), true);
    return (await json(state.trashMany(contentIds, cancelTasks)), true);
  }

  const contentMatch = /^\/api\/contents\/([^/]+)(\/.*)?$/.exec(path);
  if (contentMatch !== null) {
    const contentId = decodeURIComponent(contentMatch[1] as string);
    if (method === "DELETE" && contentMatch[2] === undefined) {
      return (await (state.trash(contentId) ? route.fulfill({ status: 204, body: "" }) : notFound()), true);
    }
    if (state.hidden(contentId)) return (await notFound(), true);
    return false;
  }

  if (method === "POST" && path === "/api/trash/restore") {
    const { contentIds } = trashRestoreRequestSchema.parse(request.postDataJSON());
    if (contentIds.length > CONTENT_TRASH_BATCH_MAX) return (await tooMany(contentIds.length), true);
    return (await json(state.restoreMany(contentIds)), true);
  }

  if (path === "/api/trash") {
    if (method === "GET") {
      const ordered = state.ordered();
      const limit = Number(url.searchParams.get("limit") ?? API_PAGE_SIZE_DEFAULT);
      const pageNumber = url.searchParams.get("page");
      // A numbered page carries no nextCursor; one past the end is empty.
      if (pageNumber !== null) {
        const from = (Number(pageNumber) - 1) * limit;
        return (await json(trashListDtoSchema.parse({ items: ordered.slice(from, from + limit).map(item), total: ordered.length })), true);
      }
      const cursor = url.searchParams.get("cursor");
      const from = cursor === null || cursor === "" ? 0 : ordered.findIndex((entry) => `${entry.trashedAt}:${entry.content.id}` === cursor) + 1;
      const page = ordered.slice(from, from + limit);
      const last = page.at(-1);
      return (
        await json(
          trashListDtoSchema.parse({
            items: page.map(item),
            total: ordered.length,
            ...(from + limit < ordered.length && last !== undefined ? { nextCursor: `${last.trashedAt}:${last.content.id}` } : {}),
          }),
        ),
        true
      );
    }
    if (method === "DELETE") {
      const purgedIds = state.ordered().map((entry) => entry.content.id);
      for (const id of purgedIds) state.purge(id);
      return (await json(trashPurgeAllDtoSchema.parse({ purgedIds, failed: [] })), true);
    }
    return false;
  }

  const restoreMatch = /^\/api\/trash\/([^/]+)\/restore$/.exec(path);
  if (restoreMatch !== null && method === "POST") {
    const entry = state.take(decodeURIComponent(restoreMatch[1] as string));
    if (entry === undefined) return (await notFound(), true);
    if (expired(entry)) return (await json(errorBody("conflict", "conflict.trash_expired"), 409), true);
    state.restore(entry.content.id);
    // Restoring leaves the Content as it was, `updatedAt` included.
    return (await json(contentDtoSchema.parse(entry.content)), true);
  }

  const itemMatch = /^\/api\/trash\/([^/]+)$/.exec(path);
  if (itemMatch !== null && method === "DELETE") {
    const entry = state.take(decodeURIComponent(itemMatch[1] as string));
    if (entry === undefined) return (await notFound(), true);
    state.purge(entry.content.id);
    return (await route.fulfill({ status: 204, body: "" }), true);
  }
  return false;
}
