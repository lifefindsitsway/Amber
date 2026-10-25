import { monotonicFactory } from "ulid";
import type { RetryStageRequest, TaskAcceptedDto, TaskDetailDto, TaskListDto } from "../../shared/dto/task.ts";
import type { TaskKind } from "../../shared/enums.ts";
import { ASR_AWAIT_UNIT_KEY, ASR_SUBMIT_UNIT_KEY } from "../../shared/work-steps.ts";
import { asrJobHandleSchema } from "../domain/asr.ts";
import { amberError } from "../domain/errors.ts";
import type { AsrModelRef } from "../domain/model-ref.ts";
import type { AsrProviderProfile } from "../domain/provider-profile.ts";
import type { StageRun, Task } from "../domain/task.ts";
import { parseStageInput, taskRequestView, type StageInput } from "../domain/task-request.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import { isAsrJobProvider, type AsrJobHandle, type AsrProviderFactory } from "../ports/asr-provider.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope, TaskCursor } from "../ports/repository.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import { downstreamStages, stageSpec } from "../pipeline/graph.ts";
import { laneConflict, laneKeys, mutationLaneError } from "../pipeline/lane.ts";
import { isTerminalProjection, latestAttempts, taskWait, type TaskWait } from "../pipeline/projection.ts";
import { type Outbox, transact } from "../pipeline/publish.ts";
import { asrModelRefProblem, modelRefProblem, unmetRequirement, type CredentialStatusSource } from "../pipeline/requirements.ts";
import { toStageRunDto, toTaskDto, toWorkUnitDto } from "../pipeline/task-dto.ts";
import {
  cancelTaskState,
  insertStageRun,
  loadTaskState,
  loadVisibleTaskState,
  propagateStageInput,
  refreshProjection,
  saveStageRun,
  saveWorkUnit,
  stageEngine,
  type TaskState,
} from "../pipeline/task-state.ts";
import { frozenMemberIds } from "./collections.ts";
import { jsonRequestDigest, runIdempotent } from "./idempotency.ts";
import { displayTitleOf } from "../domain/content.ts";

/** What the task services need from the scheduler. */
export interface TaskControl {
  kick(): void;
  abortTask(taskId: string): void;
}

export interface TaskListRequest {
  limit: number;
  cursor?: string;
  unfinished?: boolean;
  finished?: boolean;
  contentId?: string;
  collectionId?: string;
  kind?: TaskKind;
}

export interface TaskServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: TaskControl;
  secrets: CredentialStatusSource;
  /** The factory implementing an ASR profile's provider, for cancelling a submitted job remotely. */
  asr?: (provider: AsrProviderProfile["provider"]) => AsrProviderFactory | undefined;
  logger?: Logger;
  now?: () => number;
  newId?: () => string;
}

/** How long cancelling waits for the ASR provider to cancel a submitted job. */
const REMOTE_ASR_CANCEL_TIMEOUT_MS = 10_000;

/** A submitted ASR job of a Task being cancelled: what the provider needs to cancel it too. */
interface RemoteAsrJob {
  profile: AsrProviderProfile;
  modelId: string;
  handle: AsrJobHandle;
}

export const RETRY_STAGE_ROUTE = "POST /api/tasks/:id/retry-stage";
export const CONFIRM_RESEND_ROUTE = "POST /api/tasks/:id/work-units/:wid/confirm-resend";

/**
 * The single application service for observing and steering Tasks. Every read is scoped to
 * the principal; another user's Task is `not_found`.
 */
export class TaskService {
  private readonly options: TaskServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly remoteCancels = new Set<Promise<void>>();

  constructor(options: TaskServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /**
   * Newest first; `unfinished`, `finished`, `contentId`, `collectionId` and `kind` narrow
   * the list. Tasks of trashed Contents are never listed, and naming one of the principal's
   * trashed Contents is `not_found` like its other sub-resources.
   */
  list(principal: RequestPrincipal, page: TaskListRequest): TaskListDto {
    const owner = principal.userId;
    const eventSeq = this.options.bus.currentSeq();
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const { tasks, dtos } = this.options.repository.withTransaction((scope) => {
      if (page.contentId !== undefined && scope.contents.getIncludingTrashed(owner, page.contentId)?.trashedAt !== undefined) {
        throw amberError("not_found", "content not found");
      }
      const found = scope.tasks.list(owner, {
        limit: page.limit + 1,
        ...(after === undefined ? {} : { after }),
        ...(page.unfinished === true ? { unfinished: true } : {}),
        ...(page.finished === true ? { finished: true } : {}),
        ...(page.contentId === undefined ? {} : { contentId: page.contentId }),
        ...(page.collectionId === undefined ? {} : { collectionId: page.collectionId }),
        ...(page.kind === undefined ? {} : { kind: page.kind }),
      });
      const titles = new Map<string, string | undefined>();
      const titleOf = (task: Task): string | undefined => {
        const key = task.contentId ?? task.collectionId;
        if (key === undefined) {
          return undefined;
        }
        if (!titles.has(key)) {
          titles.set(
            key,
            task.contentId !== undefined ? displayTitleOf(scope.contents.get(owner, task.contentId)) : scope.collections.get(owner, key)?.name,
          );
        }
        return titles.get(key);
      };
      // Only a queued Task can be waiting for retry times; others skip the extra reads.
      const waitOf = (task: Task): TaskWait =>
        task.statusProjection === "queued" ? taskWait(scope.stageRuns.listByTask(owner, task.id), scope.workUnits.listByTask(owner, task.id)) : {};
      return { tasks: found, dtos: found.slice(0, page.limit).map((task) => toTaskDto(task, titleOf(task), waitOf(task))) };
    });
    const last = tasks.slice(0, page.limit).at(-1);
    return {
      items: dtos,
      ...(tasks.length > page.limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
      eventSeq,
    };
  }

  /** The event sequence is read before the snapshot so clients can merge live events. */
  get(principal: RequestPrincipal, taskId: string): TaskDetailDto {
    const eventSeq = this.options.bus.currentSeq();
    const detail = this.options.repository.withTransaction((scope) => {
      const state = loadVisibleTaskState(scope, principal.userId, taskId);
      return state === undefined ? undefined : toDetail(scope, state, eventSeq);
    });
    if (detail === undefined) {
      throw amberError("not_found", `task ${taskId}`);
    }
    return detail;
  }

  cancel(principal: RequestPrincipal, taskId: string): TaskDetailDto {
    const existing = this.options.repository.withTransaction((scope) => loadVisibleTaskState(scope, principal.userId, taskId)?.task);
    if (existing === undefined) {
      throw amberError("not_found", `task ${taskId}`);
    }
    if (isTerminalProjection(existing.statusProjection)) {
      throw amberError("conflict", `task ${taskId} already finished`);
    }
    // The handle of a submitted ASR job is read before anything changes; succeeded units
    // and their results stay through cancellation either way.
    const job = this.options.repository.withTransaction((scope) => {
      const state = loadTaskState(scope, principal.userId, taskId);
      return state === undefined ? undefined : remoteAsrJob(scope, state);
    });
    // Abort first: the execution stops writing and its process trees are killed before
    // the cancelled state commits.
    this.options.control.abortTask(taskId);
    transact(this.options.repository, this.options.bus, (scope, outbox) => {
      cancelTaskState(scope, outbox, loadTaskState(scope, principal.userId, taskId) as TaskState, this.now());
    });
    this.options.control.kick();
    if (job !== undefined) {
      const pending = this.cancelRemoteAsrJob(taskId, job).finally(() => this.remoteCancels.delete(pending));
      this.remoteCancels.add(pending);
    }
    return this.get(principal, taskId);
  }

  /** Resolves once every remote cancellation started so far has ended (tests, shutdown). */
  async settleRemoteCancels(): Promise<void> {
    await Promise.all([...this.remoteCancels]);
  }

  /**
   * Best effort, after the local cancellation committed: asks the provider to drop a job it
   * may still be working on, so a cancelled Task does not keep consuming its quota. Its
   * outcome is only logged; the Task is cancelled whatever the provider answers.
   */
  private async cancelRemoteAsrJob(taskId: string, job: RemoteAsrJob): Promise<void> {
    const logger = this.options.logger;
    try {
      const provider = this.options.asr?.(job.profile.provider)?.create(job.profile, job.modelId);
      if (provider === undefined || !isAsrJobProvider(provider) || provider.cancel === undefined) {
        logger?.info("asr_job_cancel", { taskId, outcome: "unsupported" });
        return;
      }
      const outcome = await provider.cancel(job.handle, { signal: AbortSignal.timeout(REMOTE_ASR_CANCEL_TIMEOUT_MS) });
      logger?.info("asr_job_cancel", { taskId, outcome });
    } catch (error) {
      logger?.warn("asr_job_cancel_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  /**
   * "Continue" / "re-run from this step". A stage waiting for
   * configuration is re-checked and returns to `pending` in the same attempt; a model the
   * user chooses because neither the stage input nor the request names one is frozen into
   * this stage and into the Task's other pending LLM stages. A failed stage gets a new
   * attempt, and the stages skipped because of it are reopened with it; each new attempt
   * inherits its previous input unless a failed LLM stage is re-run with an explicitly
   * chosen model, which then binds the re-run stage and the LLM stages reopened with it.
   */
  retryStage(principal: RequestPrincipal, taskId: string, body: RetryStageRequest, idempotencyKey?: string): TaskAcceptedDto {
    const owner = principal.userId;
    const context = { userId: owner, route: RETRY_STAGE_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest({ taskId, body }) };
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) => {
      // Before any replay: what was accepted once may not be accepted again now that the
      // Content is in the trash or a frozen collection member is.
      const visible = loadVisibleTaskState(scope, owner, taskId);
      if (visible === undefined) {
        throw amberError("not_found", `task ${taskId}`);
      }
      if (visible.task.kind === "summarize_collection") {
        const missing = frozenMemberIds(visible.task.requestJson).filter((contentId) => scope.contents.get(owner, contentId) === undefined);
        if (missing.length > 0) {
          throw amberError("invalid_request", "some summarised members are no longer available", {
            code: "invalid_request.collection_summary_missing",
            details: { missingContentIds: missing },
          });
        }
      }
      return runIdempotent(scope, context, this.now(), () => {
        const state = loadTaskState(scope, owner, taskId);
        if (state === undefined) {
          throw amberError("not_found", `task ${taskId}`);
        }
        const run = latestAttempts(state.runs).find((candidate) => candidate.stage === body.stage);
        if (run === undefined) {
          throw amberError("invalid_request", "stage is not part of this task", { params: { detail: "stage" } });
        }
        if (state.task.statusProjection === "cancelled") {
          throw amberError("conflict", `task ${taskId} was cancelled`);
        }
        if (run.status === "waiting_configuration") {
          this.resumeWaitingStage(scope, outbox, state, run, body);
        } else if (run.status === "failed") {
          this.reopenFailedStage(scope, outbox, state, run, body);
        } else {
          throw amberError("conflict", `stage ${run.stage} is ${run.status}`);
        }
        refreshProjection(scope, outbox, owner, taskId, this.now());
        return { status: 202, body: { taskId }, resourceRefs: [] };
      });
    });
    this.options.control.kick();
    return result.body;
  }

  /**
   * The user accepts possible double billing and re-sends a unit whose outcome was unknown.
   * Invariant: a paid call whose outcome is unknown is never re-sent without this explicit
   * confirmation.
   */
  confirmResend(principal: RequestPrincipal, taskId: string, workUnitId: string, idempotencyKey?: string): TaskAcceptedDto {
    const owner = principal.userId;
    const context = {
      userId: owner,
      route: CONFIRM_RESEND_ROUTE,
      key: idempotencyKey,
      requestDigest: jsonRequestDigest({ taskId, workUnitId }),
    };
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) => {
      // Before any replay, like `retryStage`.
      if (loadVisibleTaskState(scope, owner, taskId) === undefined) {
        throw amberError("not_found", `work unit ${workUnitId} of task ${taskId}`);
      }
      return runIdempotent(scope, context, this.now(), () => {
        const state = loadTaskState(scope, owner, taskId);
        const unit = state?.units.find((candidate) => candidate.id === workUnitId);
        if (state === undefined || unit === undefined) {
          throw amberError("not_found", `work unit ${workUnitId} of task ${taskId}`);
        }
        if (unit.status !== "waiting_user_action") {
          throw amberError("conflict", `work unit ${workUnitId} is ${unit.status}`);
        }
        const { error: _cleared, ...rest } = unit;
        saveWorkUnit(scope, outbox, owner, { ...rest, status: "pending" });
        refreshProjection(scope, outbox, owner, taskId, this.now());
        return { status: 202, body: { taskId }, resourceRefs: [] };
      });
    });
    this.options.control.kick();
    return result.body;
  }

  private resumeWaitingStage(scope: RepositoryScope, outbox: Outbox, state: TaskState, run: StageRun, body: RetryStageRequest): void {
    const owner = state.task.userId;
    const requirement = stageSpec(state.graph, run.stage)?.requirement;
    const request = taskRequestView(state.task.requestJson);
    let inputJson = run.inputJson;
    let supplied: StageInput | undefined;
    if (body.modelRef !== undefined) {
      // Stage input may only fill what the frozen request and the stage itself lack;
      // a stage that already has a model resumes with it.
      if (requirement !== "llm_configured" || request.modelRef !== undefined || parseStageInput(run.inputJson).modelRef !== undefined) {
        throw amberError("invalid_request", "modelRef is not accepted for this stage", { params: { detail: "modelRef" } });
      }
      if (modelRefProblem(scope, owner, body.modelRef) !== undefined) {
        throw amberError("invalid_request", "modelRef does not name an owned model", { params: { detail: "modelRef" } });
      }
      supplied = { modelRef: body.modelRef };
      inputJson = JSON.stringify(supplied);
    }
    if (body.asrModelRef !== undefined) {
      // Same rule for the ASR model: only a stage bound to none may be given one.
      if (requirement !== "asr_configured" || request.asrModelRef !== undefined || parseStageInput(run.inputJson).asrModelRef !== undefined) {
        throw amberError("invalid_request", "asrModelRef is not accepted for this stage", { params: { detail: "asrModelRef" } });
      }
      const asrModelRef = checkOwnedAsrModel(scope, owner, body.asrModelRef);
      inputJson = JSON.stringify({ ...parseStageInput(inputJson), asrModelRef } satisfies StageInput);
    }
    if (requirement !== undefined) {
      const stageInput = parseStageInput(inputJson);
      const modelRef = stageInput.modelRef ?? request.modelRef;
      const asrModelRef = stageInput.asrModelRef ?? request.asrModelRef;
      if (unmetRequirement(scope, this.options.secrets, { requirement, ownerUserId: owner, modelRef, asrModelRef }) !== undefined) {
        throw amberError("invalid_request", `requirement ${requirement} is still unmet`, {
          params: { detail: requirement === "llm_configured" ? "modelRef" : "asrModelRef" },
        });
      }
    }
    const { error: _cleared, ...rest } = run;
    saveStageRun(scope, outbox, owner, { ...rest, status: "pending", ...(inputJson === undefined ? {} : { inputJson }) });
    if (supplied !== undefined) {
      // The same choice serves the rest of this Task's LLM stages, in this transaction.
      propagateStageInput(scope, outbox, state, supplied, run);
    }
  }

  private reopenFailedStage(scope: RepositoryScope, outbox: Outbox, state: TaskState, run: StageRun, body: RetryStageRequest): void {
    const owner = state.task.userId;
    const { modelRef } = body;
    let asrModelRef: AsrModelRef | undefined;
    if (body.asrModelRef !== undefined) {
      // Switching the ASR model of a failed ASR stage submits the audio anew.
      if (stageSpec(state.graph, run.stage)?.requirement !== "asr_configured") {
        throw amberError("invalid_request", "asrModelRef is not accepted for this stage", { params: { detail: "asrModelRef" } });
      }
      asrModelRef = checkOwnedAsrModel(scope, owner, body.asrModelRef);
    }
    if (modelRef !== undefined) {
      // Only an LLM stage has a model to change, and only to one of the user's own models;
      // both checks run before anything is written.
      if (stageSpec(state.graph, run.stage)?.requirement !== "llm_configured") {
        throw amberError("invalid_request", "modelRef is not accepted for this stage", { params: { detail: "modelRef" } });
      }
      if (modelRefProblem(scope, owner, modelRef) !== undefined) {
        throw amberError("invalid_request", "modelRef does not name an owned model", { params: { detail: "modelRef" } });
      }
    }
    const sourceKind = state.content?.source.kind;
    const siblings =
      state.task.contentId !== undefined
        ? scope.tasks.listByContent(owner, state.task.contentId)
        : scope.tasks.listByCollection(owner, state.task.collectionId as string);
    const others = siblings
      .filter((task) => task.id !== state.task.id && !isTerminalProjection(task.statusProjection))
      .map((task) => ({ task, keys: laneKeys(task, sourceKind) }));
    const blocking = laneConflict(laneKeys(state.task, sourceKind), others);
    if (blocking !== undefined) {
      throw mutationLaneError(blocking, "another unfinished task works on the same stages");
    }
    const latest = latestAttempts(state.runs);
    const reopened = new Set(downstreamStages(state.graph, run.stage));
    for (const previous of latest) {
      const blockedByFailure =
        reopened.has(previous.stage) && previous.status === "skipped" && hasDependencyReason(previous.resultJson);
      if (previous.id === run.id || blockedByFailure) {
        // A new attempt keeps the input of the previous one; an explicitly chosen model
        // replaces the binding of every LLM stage reopened here, while `requestJson`, user
        // settings and stages that already succeeded stay as they are.
        const requirement = stageSpec(state.graph, previous.stage)?.requirement;
        const inputJson =
          modelRef !== undefined && requirement === "llm_configured"
            ? JSON.stringify({ ...parseStageInput(previous.inputJson), modelRef } satisfies StageInput)
            : asrModelRef !== undefined && previous.id === run.id
              ? JSON.stringify({ ...parseStageInput(previous.inputJson), asrModelRef } satisfies StageInput)
              : previous.inputJson;
        insertStageRun(scope, outbox, owner, {
          id: this.newId(),
          taskId: state.task.id,
          stage: previous.stage,
          attempt: previous.attempt + 1,
          status: "pending",
          progress: 0,
          dependencies: previous.dependencies,
          ...(previous.condition === undefined ? {} : { condition: previous.condition }),
          ...(inputJson === undefined ? {} : { inputJson }),
        });
      }
    }
  }
}

function checkOwnedAsrModel(scope: RepositoryScope, owner: string, ref: AsrModelRef): AsrModelRef {
  const problem = asrModelRefProblem(scope, owner, ref);
  if (problem !== undefined) {
    throw amberError("invalid_request", problem, { params: { detail: "asrModelRef" } });
  }
  return { asrProfileId: ref.asrProfileId, modelId: ref.modelId };
}

/**
 * The job the Task's latest ASR attempt submitted and still waits for, with the profile it
 * is bound to; `undefined` when nothing was submitted, the result already arrived, or the
 * submission was synchronous (its unit keeps no handle).
 */
function remoteAsrJob(scope: RepositoryScope, state: TaskState): RemoteAsrJob | undefined {
  const owner = state.task.userId;
  const run = latestAttempts(state.runs).find((candidate) => candidate.stage === "asr");
  if (run === undefined) {
    return undefined;
  }
  const units = state.units.filter((unit) => unit.stageRunId === run.id);
  const submitted = units.find((unit) => unit.key === ASR_SUBMIT_UNIT_KEY && unit.status === "succeeded");
  if (submitted === undefined || units.some((unit) => unit.key === ASR_AWAIT_UNIT_KEY && unit.status === "succeeded")) {
    return undefined;
  }
  const result = scope.workUnits.getResult(owner, submitted.id);
  if (result === undefined) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.payloadJson);
  } catch {
    return undefined;
  }
  const parsed = asrJobHandleSchema.safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }
  const ref = parseStageInput(run.inputJson).asrModelRef ?? taskRequestView(state.task.requestJson).asrModelRef;
  const profile = ref === undefined ? undefined : scope.asrProfiles.get(owner, ref.asrProfileId);
  return profile === undefined || ref === undefined ? undefined : { profile, modelId: ref.modelId, handle: parsed.data };
}

function hasDependencyReason(resultJson: string | undefined): boolean {
  if (resultJson === undefined) {
    return false;
  }
  const reasons = (JSON.parse(resultJson) as { reasons?: unknown }).reasons;
  return Array.isArray(reasons) && reasons.some((reason) => reason === "dependency_failed" || reason === "dependency_cancelled");
}

function toDetail(scope: RepositoryScope, state: TaskState, eventSeq: number): TaskDetailDto {
  const owner = state.task.userId;
  const context = { task: state.task, graph: state.graph };
  return {
    ...toTaskDto(
      state.task,
      displayTitleOf(state.content) ?? (state.task.collectionId === undefined ? undefined : scope.collections.get(owner, state.task.collectionId)?.name),
      taskWait(state.runs, state.units),
    ),
    stageRuns: state.runs.map((run) => toStageRunDto(run, stageEngine(scope, owner, run, context))),
    workUnits: state.units.map(toWorkUnitDto),
    eventSeq,
  };
}

function encodeCursor(position: TaskCursor): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.id])).toString("base64url");
}

function decodeCursor(cursor: string): TaskCursor {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof createdAt === "number" && Number.isInteger(createdAt) && typeof id === "string" && id.length > 0) {
      return { createdAt, id };
    }
  } catch {
    // Fall through to the uniform error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}
