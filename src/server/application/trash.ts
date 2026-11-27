import { CONTENT_TRASH_BATCH_MAX, CONTENT_TRASH_DRAIN_TIMEOUT_MS, TRASH_SWEEP_BATCH } from "../../shared/defaults.ts";
import type { CollectionDeletePlanDto, CollectionDeleteRequest, CollectionDeleteResultDto } from "../../shared/dto/collection.ts";
import type { ContentDto } from "../../shared/dto/content.ts";
import type {
  ContentTrashFailureReason,
  ContentTrashPlanDto,
  ContentTrashPlanItemDto,
  ContentTrashRequest,
  ContentTrashResultDto,
  TrashItemDto,
  TrashListDto,
  TrashPurgeAllDto,
  TrashRestoreResultDto,
} from "../../shared/dto/trash.ts";
import type { Collection } from "../domain/collection.ts";
import { displayTitle, TRASH_RETENTION_MS, trashPurgeAt, type Content } from "../domain/content.ts";
import { amberError, isAmberError, type AmberError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope, TrashCursor } from "../ports/repository.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { MAX_TIMER_MS } from "../pipeline/scheduler.ts";
import type { ChatService } from "./chat.ts";
import { contentDtos } from "./contents.ts";
import type { DeleteContentService } from "./delete-content.ts";
import { jsonRequestDigest, runIdempotent } from "./idempotency.ts";
import { retryBackoffMs, type PendingFileDeleter } from "./pending-file-delete.ts";
import type { TaskService } from "./tasks.ts";
import {
  batchTooLarge,
  cancelTasks,
  frozenBySummaries,
  IDLE_EXECUTION,
  isBlocked,
  moveToTrash,
  settleWithin,
  trashBlockers,
  trashFailureReason,
  type TaskExecution,
} from "./trash-guard.ts";

export const COLLECTION_DELETE_ROUTE = "POST /api/collections/:id/delete";

export interface TrashServiceOptions {
  repository: Repository;
  deleteContent: Pick<DeleteContentService, "purge">;
  fileDeleter: Pick<PendingFileDeleter, "kick" | "nextDueAt">;
  /** Answers still streaming about a Content are aborted when it goes to the trash. */
  chat: Pick<ChatService, "abortContent">;
  logger: Logger;
  /** Cancels the Tasks a delete was asked to cancel; without it, such a delete fails as `internal`. */
  tasks?: Pick<TaskService, "cancel">;
  /** Which Tasks still execute, and waiting for them to stop; without a scheduler nothing does. */
  execution?: TaskExecution;
  /** `CONTENT_TRASH_DRAIN_TIMEOUT_MS` unless a test shortens it. */
  drainTimeoutMs?: number;
  now?: () => number;
  /** Starts an unref'd one-shot timer and returns its cancel function; a test seam. */
  setTimer?: (ms: number, fire: () => void) => () => void;
}

/** The outcome of one sweep. */
export interface TrashSweepResult {
  purged: number;
  /** Expired entries that could not be purged this time (unfinished Task, streaming answer, cache move, …). */
  deferred: number;
}

function defaultTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

function notInTrash(): never {
  throw amberError("not_found", "content not found in the trash");
}

/**
 * Takes a trashed Content out of the trash inside the caller's transaction:
 * refused once its retention has run out, whether or not the sweep has purged it yet.
 * `updatedAt`, pin and collection positions stay as they were; the search projection
 * comes back and the collections holding it count as changed.
 */
export function restoreTrashed(scope: RepositoryScope, owner: string, content: Content, now: number): void {
  if (content.trashedAt === undefined) {
    notInTrash();
  }
  if (trashPurgeAt(content.trashedAt) <= now) {
    throw amberError("conflict", "the content's time in the trash has run out", { code: "conflict.trash_expired" });
  }
  scope.contents.restore(owner, content.id);
  scope.search.syncContent(owner, content.id);
  scope.collections.touchByContent(owner, content.id, now);
}

/** What became of one Content of a batch move to the trash. */
type TrashOutcome = "trashed" | "already" | ContentTrashFailureReason;

interface CollectionMembers {
  /** Members outside the trash, in collection order. */
  visible: string[];
  /** Of those, the ones in no other collection, in collection order. */
  exclusive: string[];
  /** Members in the trash. */
  trashedCount: number;
}

function collectionMembers(scope: RepositoryScope, owner: string, collectionId: string): CollectionMembers {
  const visible = scope.collections.listVisibleItems(owner, collectionId).map((item) => item.contentId);
  const memberships = scope.collections.membershipsOf(owner, visible);
  const exclusive = visible.filter((contentId) => (memberships.get(contentId) ?? []).every((collection) => collection.id === collectionId));
  return { visible, exclusive, trashedCount: scope.collections.listItems(owner, collectionId).length - visible.length };
}

function sameIds(ids: readonly string[], expected: ReadonlySet<string>): boolean {
  return ids.length === expected.size && ids.every((id) => expected.has(id));
}

function membersChanged(cancelledTaskCount: number): AmberError {
  return amberError("conflict", "the contents a collection delete would move to the trash changed", {
    code: "conflict.collection_members_changed",
    details: { cancelledTaskCount },
  });
}

function ownedCollection(scope: RepositoryScope, owner: string, collectionId: string): Collection {
  const collection = scope.collections.get(owner, collectionId);
  if (collection === undefined) {
    throw amberError("not_found", "collection not found");
  }
  return collection;
}

function encodeCursor(position: TrashCursor): string {
  return Buffer.from(JSON.stringify([position.trashedAt, position.id])).toString("base64url");
}

function decodeCursor(cursor: string): TrashCursor {
  try {
    const [trashedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof trashedAt === "number" && Number.isInteger(trashedAt) && typeof id === "string" && id.length > 0) {
      return { trashedAt, id };
    }
  } catch {
    // Fall through to the uniform error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}

/**
 * The content trash. Deleting a Content moves it here: rows and
 * files stay, and everything but this service treats it as unknown. It is restorable until
 * `trashedAt + TRASH_RETENTION_DAYS`, strictly; from then on only the sweep, which purges
 * every expired entry at start-up and again when a single timer fires at the next expiry.
 * Purging, by hand or by the sweep, is `DeleteContentService.purge`; an entry the sweep
 * cannot purge yet is retried with the pending-file backoff. The same timer wakes the
 * pending-file worker when its next row is due.
 */
export class TrashService {
  private readonly options: TrashServiceOptions;
  private readonly now: () => number;
  private readonly setTimer: (ms: number, fire: () => void) => () => void;
  private cancelTimer: (() => void) | undefined;
  private sweeping: Promise<TrashSweepResult> | undefined;
  /** Consecutive sweeps that left expired entries behind; drives their backoff. */
  private deferredRounds = 0;
  private armed = false;
  private stopped = false;

  private readonly execution: TaskExecution;

  constructor(options: TrashServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? defaultTimer;
    this.execution = options.execution ?? IDLE_EXECUTION;
  }

  /**
   * `DELETE /api/contents/:id`. Refused with `conflict.tasks_unfinished` while the Content
   * cannot go to the trash: a Task of its own is unfinished or still stopping, or an
   * unfinished collection summary froze it as input (whether or not it is still a member).
   * Answers streaming about it are aborted afterwards, without waiting for them to settle.
   */
  trash(principal: RequestPrincipal, contentId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      if (scope.contents.get(owner, contentId) === undefined) {
        throw amberError("not_found", "content not found");
      }
      if (isBlocked(trashBlockers(scope, owner, contentId, frozenBySummaries(scope, owner), this.execution))) {
        throw amberError("conflict", "the content has unfinished tasks or a running collection summary uses it", { code: "conflict.tasks_unfinished" });
      }
      moveToTrash(scope, owner, contentId, this.now());
    });
    this.options.chat.abortContent(owner, contentId);
    this.refresh();
  }

  /**
   * `POST /api/contents/trash-plan`: where each Content stands before a delete, in request
   * order and without changing anything. Another user's Content is `missing` like an unknown
   * one. A Task already cancelled whose execution has not stopped counts as unfinished.
   */
  plan(principal: RequestPrincipal, contentIds: readonly string[]): ContentTrashPlanDto {
    if (contentIds.length > CONTENT_TRASH_BATCH_MAX) {
      throw batchTooLarge(contentIds.length);
    }
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const frozen = frozenBySummaries(scope, owner);
      const names = new Map<string, string | undefined>();
      const nameOf = (collectionId: string): string | undefined => {
        if (!names.has(collectionId)) {
          names.set(collectionId, scope.collections.get(owner, collectionId)?.name);
        }
        return names.get(collectionId);
      };
      const items = contentIds.map((contentId): ContentTrashPlanItemDto => {
        const content = scope.contents.getIncludingTrashed(owner, contentId);
        if (content === undefined) {
          return { contentId, state: "missing" };
        }
        const title = displayTitle(content);
        const titled = { contentId, ...(title === undefined ? {} : { title }) };
        if (content.trashedAt !== undefined) {
          return { ...titled, state: "trashed" };
        }
        const blockers = trashBlockers(scope, owner, contentId, frozen, this.execution);
        if (blockers.summarizingCollectionIds.length > 0) {
          return {
            ...titled,
            state: "blocked",
            blockingCollections: blockers.summarizingCollectionIds.map((id) => {
              const name = nameOf(id);
              return { id, ...(name === undefined ? {} : { name }) };
            }),
          };
        }
        const unfinished = blockers.unfinishedTaskIds.length + blockers.stoppingTaskIds.length;
        return unfinished > 0 ? { ...titled, state: "tasks", unfinishedTaskCount: unfinished } : { ...titled, state: "ready" };
      });
      return { items };
    });
  }

  /**
   * `POST /api/contents/trash`. Every Content is judged on its own and moved in its own
   * transaction, so one failing never stops the rest, and repeating the request is safe:
   * what is in the trash already is reported as such and keeps its time there. With
   * `cancelTasks` the Contents' own unfinished Tasks are cancelled first, then their
   * executions are given `CONTENT_TRASH_DRAIN_TIMEOUT_MS` to stop. A Content an unfinished
   * collection summary froze is never moved and that summary is never cancelled; its own
   * Tasks are left alone too, since cancelling them could not free it. Cancelled Tasks stay
   * cancelled whatever happens to their Content.
   */
  async trashMany(principal: RequestPrincipal, request: ContentTrashRequest): Promise<ContentTrashResultDto> {
    const { contentIds } = request;
    if (contentIds.length > CONTENT_TRASH_BATCH_MAX) {
      throw batchTooLarge(contentIds.length);
    }
    const owner = principal.userId;
    const outcomes = new Map<string, TrashOutcome>();
    const { candidates, toCancel, stopping } = this.options.repository.withTransaction((scope) => {
      const frozen = frozenBySummaries(scope, owner);
      const found = { candidates: [] as string[], toCancel: [] as string[], stopping: [] as string[] };
      for (const contentId of contentIds) {
        const content = scope.contents.getIncludingTrashed(owner, contentId);
        if (content === undefined) {
          outcomes.set(contentId, "missing");
          continue;
        }
        if (content.trashedAt !== undefined) {
          outcomes.set(contentId, "already");
          continue;
        }
        found.candidates.push(contentId);
        const blockers = trashBlockers(scope, owner, contentId, frozen, this.execution);
        if (blockers.summarizingCollectionIds.length > 0) {
          continue;
        }
        if (request.cancelTasks) {
          found.toCancel.push(...blockers.unfinishedTaskIds);
        }
        found.stopping.push(...blockers.stoppingTaskIds);
      }
      return found;
    });
    const cancelledTaskCount = this.cancelAll(principal, toCancel);
    await this.drain([...toCancel, ...stopping], "content_trash_drain_timeout");
    const trashedIds: string[] = [];
    for (const contentId of candidates) {
      try {
        const outcome = this.options.repository.withTransaction((scope): TrashOutcome => {
          const content = scope.contents.getIncludingTrashed(owner, contentId);
          if (content === undefined) {
            return "missing";
          }
          if (content.trashedAt !== undefined) {
            return "already";
          }
          const reason = trashFailureReason(trashBlockers(scope, owner, contentId, frozenBySummaries(scope, owner), this.execution));
          if (reason !== undefined) {
            return reason;
          }
          moveToTrash(scope, owner, contentId, this.now());
          return "trashed";
        });
        outcomes.set(contentId, outcome);
        if (outcome === "trashed") {
          trashedIds.push(contentId);
        }
      } catch (error) {
        this.options.logger.error("content_trash_failed", { contentId, error: isAmberError(error) ? error.appError.code : String(error) });
        outcomes.set(contentId, "internal");
      }
    }
    this.afterTrashed(owner, trashedIds);
    const result: ContentTrashResultDto = { trashedIds: [], alreadyTrashedIds: [], failed: [], cancelledTaskCount };
    for (const contentId of contentIds) {
      const outcome = outcomes.get(contentId) ?? "internal";
      if (outcome === "trashed") {
        result.trashedIds.push(contentId);
      } else if (outcome === "already") {
        result.alreadyTrashedIds.push(contentId);
      } else {
        result.failed.push({ contentId, reason: outcome });
      }
    }
    return result;
  }

  /** `POST /api/trash/:id/restore`: not in the trash → `not_found`; expired → `conflict.trash_expired`. */
  restore(principal: RequestPrincipal, contentId: string): ContentDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.getIncludingTrashed(owner, contentId);
      if (content?.trashedAt === undefined) {
        notInTrash();
      }
      restoreTrashed(scope, owner, content, this.now());
      return contentDtos(scope, owner, [scope.contents.get(owner, contentId) as Content])[0] as ContentDto;
    });
  }

  /**
   * `POST /api/trash/restore`: each Content in its own transaction, with everything a single
   * restore does. One outside the trash is reported as already active; one whose retention ran
   * out as `expired`, purged or another user's as `missing`.
   */
  restoreMany(principal: RequestPrincipal, contentIds: readonly string[]): TrashRestoreResultDto {
    if (contentIds.length > CONTENT_TRASH_BATCH_MAX) {
      throw batchTooLarge(contentIds.length);
    }
    const owner = principal.userId;
    const result: TrashRestoreResultDto = { restoredIds: [], alreadyActiveIds: [], failed: [] };
    for (const contentId of contentIds) {
      try {
        const outcome = this.options.repository.withTransaction((scope) => {
          const content = scope.contents.getIncludingTrashed(owner, contentId);
          if (content === undefined) {
            return "missing" as const;
          }
          if (content.trashedAt === undefined) {
            return "active" as const;
          }
          restoreTrashed(scope, owner, content, this.now());
          return "restored" as const;
        });
        if (outcome === "restored") {
          result.restoredIds.push(contentId);
        } else if (outcome === "active") {
          result.alreadyActiveIds.push(contentId);
        } else {
          result.failed.push({ contentId, reason: "missing" });
        }
      } catch (error) {
        if (isAmberError(error) && error.appError.code === "conflict.trash_expired") {
          result.failed.push({ contentId, reason: "expired" });
          continue;
        }
        this.options.logger.error("trash_restore_failed", { contentId, error: isAmberError(error) ? error.appError.code : String(error) });
        result.failed.push({ contentId, reason: "internal" });
      }
    }
    return result;
  }

  /**
   * `GET /api/collections/:id/delete-plan`. Exclusive members (outside the trash, in no other
   * collection) are the ones a delete with contents moves to the trash. The collection's own
   * summary is left out of `blocked`: deleting cancels it together with the rest.
   */
  collectionDeletePlan(principal: RequestPrincipal, collectionId: string): CollectionDeletePlanDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedCollection(scope, owner, collectionId);
      const members = collectionMembers(scope, owner, collectionId);
      const frozen = frozenBySummaries(scope, owner, collectionId);
      let exclusiveWithTasksCount = 0;
      const blocked: CollectionDeletePlanDto["blocked"] = [];
      for (const contentId of members.exclusive) {
        const blockers = trashBlockers(scope, owner, contentId, frozen, this.execution);
        if (blockers.unfinishedTaskIds.length + blockers.stoppingTaskIds.length > 0) {
          exclusiveWithTasksCount += 1;
        }
        if (blockers.summarizingCollectionIds.length > 0) {
          const content = scope.contents.get(owner, contentId);
          const title = content === undefined ? undefined : displayTitle(content);
          blocked.push({
            contentId,
            ...(title === undefined ? {} : { title }),
            collections: blockers.summarizingCollectionIds.map((id) => {
              const name = scope.collections.get(owner, id)?.name;
              return { id, ...(name === undefined ? {} : { name }) };
            }),
          });
        }
      }
      return {
        memberCount: members.visible.length,
        exclusiveContentIds: members.exclusive,
        sharedCount: members.visible.length - members.exclusive.length,
        trashedMemberCount: members.trashedCount,
        exclusiveWithTasksCount,
        collectionTaskCount: scope.tasks.listByCollection(owner, collectionId).filter((task) => !isTerminalProjection(task.statusProjection)).length,
        blocked,
      };
    });
  }

  /**
   * `POST /api/collections/:id/delete`. The database part is all or nothing:
   * 1. Before any Task is cancelled, the exclusive members are recomputed and checked; a set
   *    other than `expectedContentIds` is `conflict.collection_members_changed`, a member
   *    another collection's summary froze, or a Task to cancel without `cancelTasks`, is
   *    `conflict.tasks_unfinished`. Nothing has changed then.
   * 2. The Tasks are cancelled (the exclusive members' own and the collection's) and given
   *    `CONTENT_TRASH_DRAIN_TIMEOUT_MS` to stop.
   * 3. One transaction recomputes and checks again, moves the exclusive members to the trash
   *    and deletes the collection. Anything amiss now is `conflict.collection_members_changed`
   *    carrying the Tasks already cancelled, which stay cancelled; the transaction rolls back
   *    and none of the after-commit work happens. Keeping the contents, the only thing to
   *    re-check is the collection's own Tasks, and one still running or new is
   *    `conflict.tasks_unfinished` as for the plain delete.
   * Members already in the trash lose their membership but keep their trash time. With
   * `Idempotency-Key`, a retry of a delete that committed answers the first result instead
   * of `not_found`; the record commits with the delete.
   */
  async deleteCollection(
    principal: RequestPrincipal,
    collectionId: string,
    body: CollectionDeleteRequest,
    idempotencyKey?: string,
  ): Promise<CollectionDeleteResultDto> {
    const owner = principal.userId;
    const context = { userId: owner, route: COLLECTION_DELETE_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest({ collectionId, body }) };
    // Checked before the collection itself: once the first attempt committed, it is gone.
    const stored =
      idempotencyKey === undefined
        ? undefined
        : this.options.repository.withTransaction((scope) => scope.idempotency.get(owner, COLLECTION_DELETE_ROUTE, idempotencyKey));
    if (stored !== undefined) {
      if (stored.requestDigest !== context.requestDigest) {
        throw amberError("idempotency_conflict", "idempotency key reused with a different request");
      }
      return JSON.parse(stored.responseBodyJson) as CollectionDeleteResultDto;
    }
    const withContents = body.contents === "exclusive";
    const expected = new Set(body.expectedContentIds ?? []);
    const { toCancel, stopping } = this.options.repository.withTransaction((scope) => {
      ownedCollection(scope, owner, collectionId);
      const found = { toCancel: [] as string[], stopping: [] as string[] };
      for (const task of scope.tasks.listByCollection(owner, collectionId)) {
        if (!isTerminalProjection(task.statusProjection)) {
          found.toCancel.push(task.id);
        } else if (this.execution.isExecuting(task.id)) {
          found.stopping.push(task.id);
        }
      }
      if (withContents) {
        const members = collectionMembers(scope, owner, collectionId);
        if (!sameIds(members.exclusive, expected)) {
          throw membersChanged(0);
        }
        const frozen = frozenBySummaries(scope, owner, collectionId);
        for (const contentId of members.exclusive) {
          const blockers = trashBlockers(scope, owner, contentId, frozen, this.execution);
          if (blockers.summarizingCollectionIds.length > 0) {
            throw amberError("conflict", "an unfinished summary of another collection uses a member", { code: "conflict.tasks_unfinished" });
          }
          found.toCancel.push(...blockers.unfinishedTaskIds);
          found.stopping.push(...blockers.stoppingTaskIds);
        }
      }
      if (found.toCancel.length > 0 && !body.cancelTasks) {
        throw amberError("conflict", "unfinished tasks work on this collection or its contents", { code: "conflict.tasks_unfinished" });
      }
      return found;
    });
    const cancelledTaskCount = this.cancelAll(principal, toCancel);
    await this.drain([...toCancel, ...stopping], "collection_delete_drain_timeout");
    // One synchronous transaction on the single connection: nothing can start between the
    // re-check and the delete.
    const result = this.options.repository.withTransaction((scope) =>
      runIdempotent(scope, context, this.now(), () => {
        ownedCollection(scope, owner, collectionId);
        const busy = scope.tasks
          .listByCollection(owner, collectionId)
          .some((task) => !isTerminalProjection(task.statusProjection) || this.execution.isExecuting(task.id));
        if (busy) {
          // Keeping the contents, only the collection's own Tasks stand in the way, as for the
          // plain delete; with them, the confirmed scope no longer holds.
          throw withContents
            ? membersChanged(cancelledTaskCount)
            : amberError("conflict", "unfinished tasks work on this collection", { code: "conflict.tasks_unfinished" });
        }
        let trashedIds: string[] = [];
        if (withContents) {
          const members = collectionMembers(scope, owner, collectionId);
          if (!sameIds(members.exclusive, expected)) {
            throw membersChanged(cancelledTaskCount);
          }
          const frozen = frozenBySummaries(scope, owner, collectionId);
          if (members.exclusive.some((contentId) => isBlocked(trashBlockers(scope, owner, contentId, frozen, this.execution)))) {
            throw membersChanged(cancelledTaskCount);
          }
          const now = this.now();
          for (const contentId of members.exclusive) {
            moveToTrash(scope, owner, contentId, now);
          }
          trashedIds = members.exclusive;
        }
        scope.collections.delete(owner, collectionId);
        scope.search.removeCollection(owner, collectionId);
        return { status: 200, body: { trashedIds, cancelledTaskCount }, resourceRefs: [] };
      }),
    );
    if (!result.replayed) {
      this.afterTrashed(owner, result.body.trashedIds);
    }
    return result.body;
  }

  /** `DELETE /api/trash/:id`: done once the purge commits; the files follow through the worker. */
  async purge(principal: RequestPrincipal, contentId: string): Promise<void> {
    await this.options.deleteContent.purge(principal.userId, contentId, { onlyTrashed: true });
  }

  /** `DELETE /api/trash`: every entry in its own transaction; one that fails is reported and the rest go on. */
  async purgeAll(principal: RequestPrincipal): Promise<TrashPurgeAllDto> {
    const owner = principal.userId;
    const ids = this.options.repository.withTransaction((scope) => scope.contents.listTrashedIds(owner));
    const purgedIds: string[] = [];
    const failed: TrashPurgeAllDto["failed"] = [];
    for (const contentId of ids) {
      try {
        await this.options.deleteContent.purge(owner, contentId, { onlyTrashed: true, kick: false });
        purgedIds.push(contentId);
      } catch (error) {
        if (!isAmberError(error)) {
          this.options.logger.error("trash_purge_failed", { contentId, error: String(error) });
        }
        failed.push({ contentId, code: isAmberError(error) ? error.appError.code : "internal" });
      }
    }
    this.options.fileDeleter.kick();
    return { purgedIds, failed };
  }

  /**
   * `GET /api/trash`: latest `trashedAt` first, expired entries included. `mediaBytes` sums
   * the available files a purge would remove, so never the user's own originals. Pages
   * either by `cursor` or by a 1-based `page` number, never both; a numbered
   * page carries no `nextCursor`, and one past the last page is empty.
   */
  list(principal: RequestPrincipal, query: { limit: number; cursor?: string; page?: number }): TrashListDto {
    const owner = principal.userId;
    if (query.cursor !== undefined && query.page !== undefined) {
      throw amberError("invalid_request", "cursor and page exclude each other", { params: { detail: "page" } });
    }
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const now = this.now();
    return this.options.repository.withTransaction((scope) => {
      const itemOf = (content: Content): TrashItemDto => {
        const trashedAt = content.trashedAt as number;
        const purgeAt = trashPurgeAt(trashedAt);
        const title = displayTitle(content);
        const mediaBytes = scope.mediaAssets
          .listByContent(owner, content.id)
          .filter((asset) => asset.kind !== "external_local" && asset.availability === "available")
          .reduce((sum, asset) => sum + asset.sizeBytes, 0);
        return {
          id: content.id,
          ...(title === undefined ? {} : { title }),
          source: { ...content.source },
          ...(content.coverUrl === undefined ? {} : { coverUrl: content.coverUrl }),
          ...(content.coverImageVersion === undefined ? {} : { coverImageVersion: content.coverImageVersion }),
          ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
          trashedAt,
          purgeAt,
          expired: purgeAt <= now,
          mediaBytes,
        };
      };
      if (query.page !== undefined) {
        const total = scope.contents.countTrashed(owner);
        // Compared as page indexes, so an absurdly large page number cannot overflow an offset.
        if (total === 0 || query.page - 1 > Math.floor((total - 1) / query.limit)) {
          return { items: [], total };
        }
        return { items: scope.contents.listTrashed(owner, { limit: query.limit, offset: (query.page - 1) * query.limit }).map(itemOf), total };
      }
      const found = scope.contents.listTrashed(owner, { limit: query.limit + 1, ...(after === undefined ? {} : { after }) });
      const contents = found.slice(0, query.limit);
      const last = contents.at(-1);
      return {
        items: contents.map(itemOf),
        total: scope.contents.countTrashed(owner),
        ...(found.length > query.limit && last !== undefined ? { nextCursor: encodeCursor({ trashedAt: last.trashedAt as number, id: last.id }) } : {}),
      };
    });
  }

  /**
   * Purges every expired entry of every user, `TRASH_SWEEP_BATCH` at a time, each in its own
   * transaction. Concurrent calls share one run. An entry that cannot be purged now is
   * counted as deferred and tried again later; the file worker is woken once at the end.
   */
  sweep(): Promise<TrashSweepResult> {
    this.sweeping ??= this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  /** Starts the timer: from now on it is kept set at the next moment something falls due. */
  arm(): void {
    this.armed = true;
    this.refresh();
  }

  /**
   * Re-computes the single timer once armed: the earliest of the next expiry, the next due
   * pending file, and the backoff of entries the last sweep had to leave. No timer when
   * none of them exists.
   */
  refresh(): void {
    if (!this.armed || this.stopped) {
      return;
    }
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const now = this.now();
    const due: number[] = [];
    const nextTrashed = this.options.repository.withTransaction((scope) => scope.contents.earliestTrashedAfter(now - TRASH_RETENTION_MS));
    if (nextTrashed !== undefined) {
      due.push(trashPurgeAt(nextTrashed));
    }
    const nextFile = this.options.fileDeleter.nextDueAt();
    if (nextFile !== undefined) {
      // A row due already is the worker's at hand; waking for it again at once would only spin.
      due.push(nextFile > now ? nextFile : now + retryBackoffMs(1));
    }
    if (this.deferredRounds > 0) {
      due.push(now + retryBackoffMs(this.deferredRounds));
    }
    if (due.length === 0) {
      return;
    }
    const delay = Math.min(Math.max(0, Math.min(...due) - now), MAX_TIMER_MS);
    this.cancelTimer = this.setTimer(delay, () => void this.fire());
  }

  /** No timer fires any more and a running sweep is waited for. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    await this.sweeping?.catch(() => undefined);
  }

  /** Cancels the Tasks through the task service and returns how many it cancelled. */
  private cancelAll(principal: RequestPrincipal, taskIds: readonly string[]): number {
    if (taskIds.length === 0) {
      return 0;
    }
    const tasks = this.options.tasks;
    if (tasks === undefined) {
      throw amberError("internal", "cancelling tasks is not available here");
    }
    return cancelTasks(tasks, principal, taskIds, (taskId, error) =>
      this.options.logger.warn("trash_task_cancel_failed", { taskId, error: isAmberError(error) ? error.appError.code : String(error) }),
    );
  }

  /** Gives the executions of the Tasks a bounded time to stop; what still runs afterwards is refused by the check that follows. */
  private async drain(taskIds: readonly string[], timeoutEvent: string): Promise<void> {
    if (taskIds.length === 0) {
      return;
    }
    const settled = await settleWithin(this.execution.settleTasks(taskIds), this.options.drainTimeoutMs ?? CONTENT_TRASH_DRAIN_TIMEOUT_MS);
    if (!settled) {
      this.options.logger.warn(timeoutEvent, { tasks: taskIds.length });
    }
  }

  /** After the commit only: answers about the Contents are aborted and the expiry timer is set once for the whole batch. */
  private afterTrashed(owner: string, contentIds: readonly string[]): void {
    if (contentIds.length === 0) {
      return;
    }
    for (const contentId of contentIds) {
      this.options.chat.abortContent(owner, contentId);
    }
    this.refresh();
  }

  private async fire(): Promise<void> {
    this.cancelTimer = undefined;
    try {
      await this.sweep();
    } catch (error) {
      this.options.logger.warn("trash_sweep_failed", { error: String(error) });
    } finally {
      this.refresh();
    }
  }

  private async sweepOnce(): Promise<TrashSweepResult> {
    const { repository, deleteContent, logger } = this.options;
    const cutoff = this.now() - TRASH_RETENTION_MS;
    let purged = 0;
    let deferred = 0;
    let after: TrashCursor | undefined;
    for (;;) {
      const batch = repository.withTransaction((scope) => scope.contents.listExpired(cutoff, TRASH_SWEEP_BATCH, after));
      for (const entry of batch) {
        if (this.stopped) {
          break;
        }
        try {
          await deleteContent.purge(entry.userId, entry.id, { onlyTrashed: true, kick: false });
          purged += 1;
        } catch (error) {
          // Restored or purged by hand in the meantime: nothing left to do.
          if (isAmberError(error) && error.appError.class === "not_found") {
            continue;
          }
          deferred += 1;
          logger.warn("trash_purge_deferred", { contentId: entry.id, error: isAmberError(error) ? error.appError.code : String(error) });
        }
      }
      const last = batch.at(-1);
      if (this.stopped || batch.length < TRASH_SWEEP_BATCH || last === undefined) {
        break;
      }
      after = { trashedAt: last.trashedAt, id: last.id };
    }
    this.deferredRounds = deferred > 0 ? this.deferredRounds + 1 : 0;
    this.options.fileDeleter.kick();
    logger.info("trash_sweep_done", { purged, deferred });
    return { purged, deferred };
  }
}
