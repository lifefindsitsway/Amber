import type { StageEngineDto, StageRunDto, TaskDto, WorkUnitDto } from "../../shared/dto/task.ts";
import { DEFAULT_SUMMARY_TEMPLATE_ID } from "../domain/prompts.ts";
import type { StageRun, Task, WorkUnit } from "../domain/task.ts";
import { taskRequestView } from "../domain/task-request.ts";
import type { TaskWait } from "./projection.ts";

/**
 * `targetTitle` names the Task's Content or Collection in task lists; `wait` is the
 * projection's companion (`taskWait`), shown only while the Task is queued.
 */
export function toTaskDto(task: Task, targetTitle?: string, wait: TaskWait = {}): TaskDto {
  const queued = task.statusProjection === "queued" && wait.retryNotBefore !== undefined;
  return {
    id: task.id,
    ...(task.contentId === undefined ? {} : { contentId: task.contentId }),
    ...(task.collectionId === undefined ? {} : { collectionId: task.collectionId }),
    kind: task.kind,
    ...(targetTitle === undefined ? {} : { targetTitle }),
    statusProjection: task.statusProjection,
    createdAt: task.createdAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(queued ? { retryNotBefore: wait.retryNotBefore } : {}),
    ...(queued && wait.waitingStep !== undefined ? { waitingStep: wait.waitingStep } : {}),
    ...summaryTemplateOf(task),
    ...(comparisonOf(task) ? { comparison: true as const } : {}),
  };
}

/** Whether a `retranscribe` Task's frozen request marks a transcription made only to compare speakers with. */
function comparisonOf(task: Task): boolean {
  if (task.kind !== "retranscribe") {
    return false;
  }
  try {
    return taskRequestView(task.requestJson).comparison === true;
  } catch {
    return false;
  }
}

/**
 * The template a summarizing Task uses: the frozen `templateRef`, else — for
 * `process_content` only — the default template its summary stage falls back to.
 */
function summaryTemplateOf(task: Task): { templateId?: string } {
  if (task.kind !== "process_content" && task.kind !== "regenerate_summary") {
    return {};
  }
  let templateId: string | undefined;
  try {
    templateId = taskRequestView(task.requestJson).templateRef?.id;
  } catch {
    templateId = undefined;
  }
  templateId ??= task.kind === "process_content" ? DEFAULT_SUMMARY_TEMPLATE_ID : undefined;
  return templateId === undefined ? {} : { templateId };
}

/**
 * Exposes the parsed `reasons[]` of the stage result, never the raw JSON, and the engine
 * doing the stage's work when there is one.
 */
export function toStageRunDto(run: StageRun, engine?: StageEngineDto): StageRunDto {
  const reasons = stageReasons(run.resultJson);
  return {
    id: run.id,
    taskId: run.taskId,
    stage: run.stage,
    attempt: run.attempt,
    status: run.status,
    progress: run.progress,
    dependencies: run.dependencies,
    ...(run.condition === undefined ? {} : { condition: run.condition }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(reasons === undefined ? {} : { reasons }),
    ...(engine === undefined ? {} : { engine }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  };
}

/** Digests and output locations stay server-side. */
export function toWorkUnitDto(unit: WorkUnit): WorkUnitDto {
  return {
    id: unit.id,
    stageRunId: unit.stageRunId,
    key: unit.key,
    status: unit.status,
    attempt: unit.attempt,
    retryCount: unit.retryCount,
    ...(unit.retryNotBefore === undefined ? {} : { retryNotBefore: unit.retryNotBefore }),
    ...(unit.error === undefined ? {} : { error: unit.error }),
  };
}

function stageReasons(resultJson: string | undefined): string[] | undefined {
  if (resultJson === undefined) {
    return undefined;
  }
  const reasons = (JSON.parse(resultJson) as { reasons?: unknown }).reasons;
  return Array.isArray(reasons) && reasons.every((reason) => typeof reason === "string") ? reasons : undefined;
}
