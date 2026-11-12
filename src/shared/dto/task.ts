import { z } from "zod";
import {
  PROCESSING_STATUSES,
  STAGE_CONDITION_IDS,
  STAGE_IDS,
  STAGE_STATUSES,
  TASK_KINDS,
  WORK_UNIT_STATUSES,
} from "../enums.ts";
import { appErrorSchema } from "../errors.ts";
import { TASK_HISTORY_HIDE_MAX } from "../defaults.ts";
import { WORK_STEP_NAMES } from "../work-steps.ts";
import { asrModelRefSchema, modelRefSchema } from "./model-ref.ts";

const idSchema = z.string().min(1);
const epochMsSchema = z.number().int().nonnegative();

export const taskDtoSchema = z.object({
  id: idSchema,
  contentId: idSchema.exactOptional(),
  collectionId: idSchema.exactOptional(),
  kind: z.enum(TASK_KINDS),
  statusProjection: z.enum(PROCESSING_STATUSES),
  /** Title of the target Content or Collection, for task lists. */
  targetTitle: z.string().exactOptional(),
  createdAt: epochMsSchema,
  finishedAt: epochMsSchema.exactOptional(),
  /**
   * Latest `retryNotBefore` of the units the Task waits on, while it only waits for them: a
   * rate-limit, overload or back-off wait that keeps it `queued` without holding a task slot.
   */
  retryNotBefore: epochMsSchema.exactOptional(),
  /**
   * The named step of the unit that sets `retryNotBefore`, when it is one (for example
   * `awaitResult`: waiting for an asynchronous ASR job rather than for a model service).
   */
  waitingStep: z.enum(WORK_STEP_NAMES).exactOptional(),
  /**
   * The summary template a `process_content` or `regenerate_summary` Task summarizes with, so
   * the stage flow can tell a re-run of the same template; absent on other kinds.
   */
  templateId: idSchema.exactOptional(),
  /**
   * Present on a `retranscribe` Task made only to compare speakers with: it changes nothing
   * about the Content, so it is never shown as the Content's own re-transcription.
   */
  comparison: z.literal(true).exactOptional(),
});
export type TaskDto = z.infer<typeof taskDtoSchema>;

/**
 * What does the work of a stage, named beside the stage when the stage flow shows it
 * failed: the effective model binding of an LLM stage, or the ASR model an ASR stage is
 * bound to. `provider` comes from
 * the profile while it exists, else from the stage's usage record, and is absent when
 * neither is known.
 */
export const stageEngineDtoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("llm"), modelRef: modelRefSchema }),
  z.object({
    kind: z.literal("asr"),
    asrModelRef: asrModelRefSchema,
    provider: z.string().min(1).exactOptional(),
  }),
]);
export type StageEngineDto = z.infer<typeof stageEngineDtoSchema>;

export const stageRunDtoSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  stage: z.enum(STAGE_IDS),
  attempt: z.number().int().positive(),
  status: z.enum(STAGE_STATUSES),
  progress: z.number().min(0).max(1),
  dependencies: z.array(z.enum(STAGE_IDS)),
  condition: z.enum(STAGE_CONDITION_IDS).exactOptional(),
  error: appErrorSchema.exactOptional(),
  /** Parsed from `StageRun.resultJson`; the raw JSON is never exposed. */
  reasons: z.array(z.string()).exactOptional(),
  engine: stageEngineDtoSchema.exactOptional(),
  startedAt: epochMsSchema.exactOptional(),
  finishedAt: epochMsSchema.exactOptional(),
});
export type StageRunDto = z.infer<typeof stageRunDtoSchema>;

/** Digests and file locations stay server-side; clients only see progress and errors. */
export const workUnitDtoSchema = z.object({
  id: idSchema,
  stageRunId: idSchema,
  key: z.string().min(1),
  status: z.enum(WORK_UNIT_STATUSES),
  attempt: z.number().int().positive(),
  retryCount: z.number().int().nonnegative(),
  retryNotBefore: epochMsSchema.exactOptional(),
  error: appErrorSchema.exactOptional(),
});
export type WorkUnitDto = z.infer<typeof workUnitDtoSchema>;

/**
 * `GET /api/tasks/:id`: the authoritative snapshot. Clients subscribe to live events first,
 * then fetch this and apply only events whose `id` exceeds `eventSeq`.
 */
export const taskDetailDtoSchema = taskDtoSchema.extend({
  stageRuns: z.array(stageRunDtoSchema),
  workUnits: z.array(workUnitDtoSchema),
  /** Event sequence captured by the server before reading the snapshot. */
  eventSeq: z.number().int().nonnegative(),
});
export type TaskDetailDto = z.infer<typeof taskDetailDtoSchema>;

/** `GET /api/tasks`: newest first, cursor-paginated, with the same `eventSeq` merge rule as the detail. */
export const taskListDtoSchema = z.object({
  items: z.array(taskDtoSchema),
  nextCursor: z.string().min(1).exactOptional(),
  eventSeq: z.number().int().nonnegative(),
});
export type TaskListDto = z.infer<typeof taskListDtoSchema>;

/**
 * `POST /api/tasks/:id/retry-stage`. `modelRef` either supplies only what the frozen
 * request lacks, when resuming a stage that waits for LLM configuration, or switches the
 * model of a failed LLM stage being re-run, and of the LLM stages reopened with it; a
 * failed stage without an LLM requirement rejects it. `asrModelRef` does
 * the same for the ASR stage; switching it on a failed stage submits the audio anew.
 */
export const retryStageRequestSchema = z
  .object({
    stage: z.enum(STAGE_IDS),
    modelRef: modelRefSchema.exactOptional(),
    asrModelRef: asrModelRefSchema.exactOptional(),
  })
  .strict();
export type RetryStageRequest = z.infer<typeof retryStageRequestSchema>;

/** Body of the 202 answers that (re)start work on a Task. */
export const taskAcceptedDtoSchema = z.object({ taskId: idSchema });
export type TaskAcceptedDto = z.infer<typeof taskAcceptedDtoSchema>;

/**
 * `POST /api/tasks/history/hide`: removes the owner's finished Tasks among `taskIds` from the
 * task panel's history. Nothing is deleted; ids that are not the owner's finished, shown Tasks
 * are skipped without telling them apart.
 */
export const taskHistoryHideRequestSchema = z.object({ taskIds: z.array(idSchema).min(1).max(TASK_HISTORY_HIDE_MAX) }).strict();
export type TaskHistoryHideRequest = z.infer<typeof taskHistoryHideRequestSchema>;

/** Answer of `POST /api/tasks/history/hide` and `/clear`: how many Tasks this removal hid, and its id for the undo. */
export const taskHistoryHiddenDtoSchema = z.object({ hidden: z.number().int().nonnegative(), batchId: idSchema });
export type TaskHistoryHiddenDto = z.infer<typeof taskHistoryHiddenDtoSchema>;

/** `POST /api/tasks/history/restore`: shows again exactly the Tasks one removal hid. */
export const taskHistoryRestoreRequestSchema = z.object({ batchId: idSchema }).strict();
export type TaskHistoryRestoreRequest = z.infer<typeof taskHistoryRestoreRequestSchema>;

export const taskHistoryRestoredDtoSchema = z.object({ restored: z.number().int().nonnegative() });
export type TaskHistoryRestoredDto = z.infer<typeof taskHistoryRestoredDtoSchema>;
