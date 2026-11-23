import { CONTENT_TRASH_BATCH_MAX } from "../../shared/defaults.ts";
import type { ContentTrashFailureReason } from "../../shared/dto/trash.ts";
import { amberError, isAmberError, type AmberError } from "../domain/errors.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { frozenMemberIds } from "./collections.ts";
import type { TaskService } from "./tasks.ts";

/** What moving Contents to the trash needs from the scheduler. */
export interface TaskExecution {
  /** Whether the Task still has an execution in this process, cancelled or not. */
  isExecuting(taskId: string): boolean;
  /** Resolves once none of the Tasks has an execution left. */
  settleTasks(taskIds: readonly string[]): Promise<void>;
}

/** Without a scheduler nothing executes, so nothing needs waiting for. */
export const IDLE_EXECUTION: TaskExecution = { isExecuting: () => false, settleTasks: async () => undefined };

/** Why a Content cannot go to the trash right now; every list empty means it can. */
export interface TrashBlockers {
  /** Unfinished Tasks of the Content itself. */
  unfinishedTaskIds: string[];
  /** Tasks of the Content already cancelled whose execution has not stopped yet. */
  stoppingTaskIds: string[];
  /** Collections whose unfinished summary froze the Content as input. */
  summarizingCollectionIds: string[];
}

/**
 * Contents frozen as input by the owner's unfinished collection summaries, mapped to the
 * collections summarising them. Read from what each summary Task froze at submission, not
 * from current memberships: a member taken out of the collection while the summary runs is
 * still one of its inputs. The summary of `exceptCollectionId` is left out, for a caller that
 * cancels it together with the deletion.
 */
export function frozenBySummaries(scope: RepositoryScope, owner: string, exceptCollectionId?: string): Map<string, string[]> {
  const frozen = new Map<string, string[]>();
  for (const task of scope.tasks.listUnfinishedOf(owner)) {
    if (task.kind !== "summarize_collection" || task.collectionId === undefined || task.collectionId === exceptCollectionId) {
      continue;
    }
    for (const contentId of new Set(frozenMemberIds(task.requestJson))) {
      const collections = frozen.get(contentId) ?? [];
      if (!collections.includes(task.collectionId)) {
        collections.push(task.collectionId);
      }
      frozen.set(contentId, collections);
    }
  }
  return frozen;
}

/**
 * The single check every move to the trash runs (one Content, a batch, a collection deleted
 * with its contents), inside the transaction that would move it. `frozen` comes from
 * `frozenBySummaries` of the same transaction.
 */
export function trashBlockers(
  scope: RepositoryScope,
  owner: string,
  contentId: string,
  frozen: ReadonlyMap<string, readonly string[]>,
  execution: Pick<TaskExecution, "isExecuting">,
): TrashBlockers {
  const unfinishedTaskIds: string[] = [];
  const stoppingTaskIds: string[] = [];
  for (const task of scope.tasks.listByContent(owner, contentId)) {
    if (!isTerminalProjection(task.statusProjection)) {
      unfinishedTaskIds.push(task.id);
    } else if (execution.isExecuting(task.id)) {
      stoppingTaskIds.push(task.id);
    }
  }
  return { unfinishedTaskIds, stoppingTaskIds, summarizingCollectionIds: [...(frozen.get(contentId) ?? [])] };
}

/** The most binding reason, as a batch reports it; `undefined` when nothing blocks. */
export function trashFailureReason(blockers: TrashBlockers): Exclude<ContentTrashFailureReason, "missing" | "internal"> | undefined {
  if (blockers.summarizingCollectionIds.length > 0) {
    return "summarizing";
  }
  if (blockers.unfinishedTaskIds.length > 0) {
    return "tasks";
  }
  if (blockers.stoppingTaskIds.length > 0) {
    return "stopping";
  }
  return undefined;
}

export function isBlocked(blockers: TrashBlockers): boolean {
  return trashFailureReason(blockers) !== undefined;
}

/**
 * Moves one Content to the trash inside the caller's transaction: hidden from search, and
 * every collection holding it counts as changed. What follows the commit (aborting answers
 * about it, re-arming the expiry timer) is the caller's.
 */
export function moveToTrash(scope: RepositoryScope, owner: string, contentId: string, now: number): void {
  scope.contents.trash(owner, contentId, now);
  scope.search.removeContent(owner, contentId);
  scope.collections.touchByContent(owner, contentId, now);
}

export function batchTooLarge(itemCount: number): AmberError {
  return amberError("invalid_request", "too many contents in one request", {
    code: "invalid_request.batch_too_large",
    params: { limit: String(CONTENT_TRASH_BATCH_MAX) },
    details: { itemCount, limit: CONTENT_TRASH_BATCH_MAX },
  });
}

/**
 * Cancels each Task through the task service, so its execution is aborted before the
 * cancellation commits and a submitted ASR job is cancelled remotely too. A Task that ended
 * (or became invisible) between reading and cancelling is simply skipped; any other failure
 * leaves the Task unfinished, and the check that follows reports it. Returns how many were
 * cancelled here.
 */
export function cancelTasks(
  tasks: Pick<TaskService, "cancel">,
  principal: Parameters<TaskService["cancel"]>[0],
  taskIds: readonly string[],
  onError: (taskId: string, error: unknown) => void,
): number {
  let cancelled = 0;
  for (const taskId of taskIds) {
    try {
      tasks.cancel(principal, taskId);
      cancelled += 1;
    } catch (error) {
      if (isAmberError(error) && (error.appError.class === "conflict" || error.appError.class === "not_found")) {
        continue;
      }
      onError(taskId, error);
    }
  }
  return cancelled;
}

/** Waits for `work` at most `timeoutMs`; `false` when the time ran out first. */
export async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
