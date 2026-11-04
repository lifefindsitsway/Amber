import type { StageEngineDto } from "../../shared/dto/task.ts";
import type { StageId } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import type { Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import type { StageRun, Task, WorkUnit } from "../domain/task.ts";
import { parseStageInput, taskRequestView, type StageInput } from "../domain/task-request.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import { downstreamStages, stageGraph, stageSpec, type StageSpec } from "./graph.ts";
import { isTerminalProjection, isTerminalStage, latestAttempts, projectStatus, taskWait, type TaskWait } from "./projection.ts";
import type { Outbox } from "./publish.ts";
import { toStageRunDto, toTaskDto, toWorkUnitDto } from "./task-dto.ts";

/**
 * State transitions shared by the scheduler and the task services. Every function runs
 * inside a transaction and queues the matching events on the outbox, so callers publish
 * them only after commit.
 */

export interface TaskState {
  task: Task;
  content: Content | undefined;
  graph: StageSpec[];
  runs: StageRun[];
  units: WorkUnit[];
}

/**
 * Creates a Task with the first attempt of every stage of its graph, all `pending`. A new
 * `process_content` Task becomes its Content's latest one, so the Content's projection
 * follows it from now on.
 */
export function createTask(
  scope: RepositoryScope,
  outbox: Outbox,
  input: { task: Omit<Task, "statusProjection" | "finishedAt">; sourceKind: Content["source"]["kind"] | undefined; newId: () => string },
): Task {
  const task: Task = { ...input.task, statusProjection: "queued" };
  scope.tasks.insert(task);
  outbox.push(task.userId, { type: "task.updated", task: toTaskDto(task) });
  for (const spec of stageGraph(task.kind, input.sourceKind)) {
    const run: StageRun = {
      id: input.newId(),
      taskId: task.id,
      stage: spec.stage,
      attempt: 1,
      status: "pending",
      progress: 0,
      dependencies: spec.dependencies,
      ...(spec.condition === undefined ? {} : { condition: spec.condition }),
    };
    insertStageRun(scope, outbox, task.userId, run);
  }
  if (task.kind === "process_content" && task.contentId !== undefined) {
    scope.contents.setProcessingStatus(task.userId, task.contentId, task.statusProjection, task.createdAt);
  }
  return task;
}

/** The Task with its Content, stage runs and units; a Content in the trash is loaded too (the pipeline's view). */
export function loadTaskState(scope: RepositoryScope, ownerUserId: string, taskId: string): TaskState | undefined {
  const task = scope.tasks.get(ownerUserId, taskId);
  if (task === undefined) {
    return undefined;
  }
  const content = task.contentId === undefined ? undefined : scope.contents.getIncludingTrashed(ownerUserId, task.contentId);
  return {
    task,
    content,
    graph: stageGraph(task.kind, content?.source.kind),
    runs: scope.stageRuns.listByTask(ownerUserId, taskId),
    units: scope.workUnits.listByTask(ownerUserId, taskId),
  };
}

/**
 * `loadTaskState` as a request sees it: a Task of a Content in the trash is as unknown as
 * the Content itself.
 */
export function loadVisibleTaskState(scope: RepositoryScope, ownerUserId: string, taskId: string): TaskState | undefined {
  const state = loadTaskState(scope, ownerUserId, taskId);
  return state?.content?.trashedAt === undefined ? state : undefined;
}

export function saveStageRun(scope: RepositoryScope, outbox: Outbox, ownerUserId: string, run: StageRun): void {
  scope.stageRuns.update(ownerUserId, run);
  outbox.push(ownerUserId, { type: "stage.updated", stageRun: toStageRunDto(run, stageEngine(scope, ownerUserId, run)) });
}

export function insertStageRun(scope: RepositoryScope, outbox: Outbox, ownerUserId: string, run: StageRun): void {
  scope.stageRuns.insert(ownerUserId, run);
  outbox.push(ownerUserId, { type: "stage.updated", stageRun: toStageRunDto(run, stageEngine(scope, ownerUserId, run)) });
}

/**
 * What does a stage's work, for "stage + engine" in the UI: an LLM
 * stage's effective model binding, or an ASR stage's bound model (each from the frozen
 * stage input first, then the Task request). An ASR engine names the profile's provider
 * while it exists, else the one its usage recorded for this Task, so history stays readable
 * after the profile was deleted. Absent for other stages and for a stage that has
 * nothing bound yet.
 */
export function stageEngine(
  scope: RepositoryScope,
  ownerUserId: string,
  run: StageRun,
  known?: { task: Task; graph: readonly StageSpec[] },
): StageEngineDto | undefined {
  const context = known ?? taskContext(scope, ownerUserId, run.taskId);
  if (context === undefined) {
    return undefined;
  }
  switch (stageSpec(context.graph, run.stage)?.requirement) {
    case "llm_configured": {
      const modelRef = parseStageInput(run.inputJson).modelRef ?? taskRequestView(context.task.requestJson).modelRef;
      return modelRef === undefined ? undefined : { kind: "llm", modelRef: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId } };
    }
    case "asr_configured": {
      const ref = parseStageInput(run.inputJson).asrModelRef ?? taskRequestView(context.task.requestJson).asrModelRef;
      if (ref === undefined) {
        return undefined;
      }
      const asrModelRef = { asrProfileId: ref.asrProfileId, modelId: ref.modelId };
      const provider = scope.asrProfiles.get(ownerUserId, ref.asrProfileId)?.provider ?? scope.asrUsage.list(ownerUserId, { taskId: run.taskId }).at(-1)?.provider;
      return provider === undefined ? { kind: "asr", asrModelRef } : { kind: "asr", asrModelRef, provider };
    }
    case undefined:
      return undefined;
  }
}

function taskContext(scope: RepositoryScope, ownerUserId: string, taskId: string): { task: Task; graph: StageSpec[] } | undefined {
  const task = scope.tasks.get(ownerUserId, taskId);
  if (task === undefined) {
    return undefined;
  }
  const content = task.contentId === undefined ? undefined : scope.contents.getIncludingTrashed(ownerUserId, task.contentId);
  return { task, graph: stageGraph(task.kind, content?.source.kind) };
}

export function saveWorkUnit(scope: RepositoryScope, outbox: Outbox, ownerUserId: string, unit: WorkUnit): void {
  scope.workUnits.update(ownerUserId, unit);
  outbox.push(ownerUserId, { type: "workunit.updated", workUnit: toWorkUnitDto(unit) });
}

/**
 * Rebuilds `Task.statusProjection` (and `Content.processingStatus` when this is the
 * Content's latest `process_content` Task) from StageRun / WorkUnit state. `finishedAt`
 * is set on reaching a terminal projection and cleared when the Task is reopened.
 */
export function refreshProjection(scope: RepositoryScope, outbox: Outbox, ownerUserId: string, taskId: string, now: number): Task {
  const task = scope.tasks.get(ownerUserId, taskId);
  if (task === undefined) {
    throw new TypeError(`task ${taskId} vanished inside its own transaction`);
  }
  const runs = scope.stageRuns.listByTask(ownerUserId, taskId);
  const units = scope.workUnits.listByTask(ownerUserId, taskId);
  const status = projectStatus(runs, units);
  const wait: TaskWait = status === "queued" ? taskWait(runs, units) : {};
  const terminal = isTerminalProjection(status);
  const finishedAt = terminal ? (task.finishedAt ?? now) : undefined;
  // A changed wait time is news for the task panel even when the status stays `queued`.
  if (status === task.statusProjection && finishedAt === task.finishedAt) {
    if (wait.retryNotBefore !== undefined) {
      outbox.push(ownerUserId, { type: "task.updated", task: toTaskDto(task, undefined, wait) });
    }
    return task;
  }
  scope.tasks.setProjection(ownerUserId, taskId, status, finishedAt);
  const updated: Task = { ...task, statusProjection: status };
  delete updated.finishedAt;
  if (finishedAt !== undefined) {
    updated.finishedAt = finishedAt;
  } else {
    // Mirrors setProjection: a Task that starts again leaves no hidden history entry behind.
    delete updated.historyHiddenAt;
    delete updated.historyHideBatch;
  }
  outbox.push(ownerUserId, { type: terminal ? "task.finished" : "task.updated", task: toTaskDto(updated, undefined, wait) });
  if (updated.kind === "process_content" && updated.contentId !== undefined) {
    const latest = scope.tasks
      .listByContent(ownerUserId, updated.contentId)
      .filter((candidate) => candidate.kind === "process_content")
      .at(-1);
    if (latest?.id === updated.id) {
      scope.contents.setProcessingStatus(ownerUserId, updated.contentId, status, now);
    }
  }
  return updated;
}

/**
 * Failure propagation: every pending stage that depends on `stage`, directly
 * or transitively, becomes `skipped` with the dependency reason, so "all terminal" stays
 * reachable. Branches that do not depend on it are untouched.
 */
export function propagateFailure(
  scope: RepositoryScope,
  outbox: Outbox,
  state: Pick<TaskState, "task" | "graph" | "runs">,
  stage: StageId,
  reason: "dependency_failed" | "dependency_cancelled",
  now: number,
): void {
  const downstream = new Set(downstreamStages(state.graph, stage));
  for (const run of latestAttempts(state.runs)) {
    if (downstream.has(run.stage) && run.status === "pending") {
      saveStageRun(scope, outbox, state.task.userId, {
        ...run,
        status: "skipped",
        resultJson: JSON.stringify({ reasons: [reason] }),
        finishedAt: now,
      });
    }
  }
}

/**
 * Applies the input a user supplied through retry-stage to the other stages of the same
 * Task that will need it: latest attempts still `pending`, requiring an LLM, with no input
 * yet. Stages that already carry a choice keep it; nothing outside this Task
 * is touched. An input that exists but names no model cannot be completed under the
 * write-once rule, so it is reported rather than overwritten or silently left to block
 * the Task later.
 */
export function propagateStageInput(
  scope: RepositoryScope,
  outbox: Outbox,
  state: Pick<TaskState, "task" | "graph" | "runs">,
  input: StageInput,
  exclude: Pick<StageRun, "id">,
): StageId[] {
  const written: StageId[] = [];
  for (const run of latestAttempts(state.runs)) {
    if (run.id === exclude.id || run.status !== "pending" || stageSpec(state.graph, run.stage)?.requirement !== "llm_configured") {
      continue;
    }
    if (run.inputJson !== undefined) {
      if (parseStageInput(run.inputJson).modelRef === undefined) {
        throw amberError("internal", `stage run ${run.id} carries an input without a model`);
      }
      continue;
    }
    saveStageRun(scope, outbox, state.task.userId, { ...run, inputJson: JSON.stringify(input) });
    written.push(run.stage);
  }
  return written;
}

export function failStage(scope: RepositoryScope, outbox: Outbox, state: TaskState, run: StageRun, error: AppError, now: number): void {
  saveStageRun(scope, outbox, state.task.userId, { ...run, status: "failed", error, finishedAt: now });
  propagateFailure(scope, outbox, { ...state, runs: scope.stageRuns.listByTask(state.task.userId, state.task.id) }, run.stage, "dependency_failed", now);
}

/**
 * Explicit cancellation: unfinished stages and their unfinished units
 * become `cancelled`. Published revisions are immutable and stay. The caller aborts the
 * running execution (killing its process trees) before calling this.
 */
export function cancelTaskState(scope: RepositoryScope, outbox: Outbox, state: TaskState, now: number): Task {
  const owner = state.task.userId;
  const current = latestAttempts(state.runs);
  const currentIds = new Set(current.map((run) => run.id));
  for (const unit of state.units) {
    if (currentIds.has(unit.stageRunId) && !["succeeded", "failed", "cancelled"].includes(unit.status)) {
      saveWorkUnit(scope, outbox, owner, { ...unit, status: "cancelled" });
    }
  }
  for (const run of current) {
    if (!isTerminalStage(run.status)) {
      saveStageRun(scope, outbox, owner, { ...run, status: "cancelled", finishedAt: now });
    }
  }
  return refreshProjection(scope, outbox, owner, state.task.id, now);
}
