import type { AppError } from "../../shared/errors.ts";
import type {
  ProcessingStatus,
  StageConditionId,
  StageId,
  StageStatus,
  TaskKind,
  WorkUnitStatus,
} from "../../shared/enums.ts";

/**
 * Invariant: a Task runs independently of any HTTP or SSE
 * connection and only stops through explicit cancellation.
 */
export interface Task {
  id: string;
  userId: string;
  /** Exactly one target: `contentId` or `collectionId`. */
  contentId?: string;
  collectionId?: string;
  kind: TaskKind;
  /**
   * Immutable snapshot of the submitted request (`requestSchemaVersion`, frozen
   * `templateRef.version`, `modelRef`, base revision, languages, switches). Stages read
   * their inputs only from here, never from current defaults.
   */
  requestJson: string;
  /** Projection rebuildable from StageRuns; authority lives in StageRun / WorkUnit. */
  statusProjection: ProcessingStatus;
  createdAt: number;
  finishedAt?: number;
  /**
   * Set when the user removed the finished Task from the task panel's history. Display only:
   * status, details and every other listing ignore it; a Task that starts again drops it.
   */
  historyHiddenAt?: number;
  /** The removal that hid it, so an undo restores exactly that removal. */
  historyHideBatch?: string;
}

/** Authoritative stage state. The pipeline is a conditional dependency graph, not a fixed line. */
export interface StageRun {
  id: string;
  taskId: string;
  stage: StageId;
  attempt: number;
  status: StageStatus;
  /** 0–1. */
  progress: number;
  dependencies: StageId[];
  condition?: StageConditionId;
  error?: AppError;
  /** Structured stage result; diagnostics of a successful-but-degraded stage go here, not in `error`. */
  resultJson?: string;
  /**
   * Stage input the user supplied explicitly through retry-stage because the frozen request
   * lacked it (for example the `modelRef` of a Task submitted before any LLM was
   * configured). Only fills gaps in `Task.requestJson`; immutable once written.
   */
  inputJson?: string;
  startedAt?: number;
  finishedAt?: number;
}

/**
 * Smallest independently re-runnable unit inside a stage (proofreading chunk, translation
 * batch, rollup partial or carry). Invariant: a paid call whose outcome is unknown parks
 * here as `waiting_user_action` instead of being re-sent.
 */
export interface WorkUnit {
  id: string;
  stageRunId: string;
  /** For example `proofread:range:151-300`. */
  key: string;
  status: WorkUnitStatus;
  attempt: number;
  /**
   * Automatic retries after failed sends, kept across stage re-runs and restarts; past
   * `RETRY_MAX` the unit fails. A call turned away unsent does not count.
   */
  retryCount: number;
  /**
   * Earliest time the unit may run again. A `pending` unit carrying it waits (rate-limit
   * cooldown or retry backoff) while its stage holds no Task slot.
   */
  retryNotBefore?: number;
  /** Input fingerprint: basis for idempotency and resuming. */
  inputDigest: string;
  /** Output location of file-backed units; DB-only units have none. */
  outputRef?: string;
  /** Digest of the output file or of `WorkUnitResult.payloadJson`. */
  outputDigest?: string;
  error?: AppError;
  /**
   * Set on units whose work is a paid outbound call. Crash recovery never re-queues such a
   * unit: it waits for the user's confirmation instead. Invariant: a paid call whose
   * outcome is unknown is never re-sent automatically.
   * Absent means no paid call (`none` in storage).
   */
  billing?: WorkUnitBilling;
}

export type WorkUnitBilling = "asr" | "llm";

/**
 * Durable result of a DB-only WorkUnit, committed in the same transaction as its
 * `succeeded` status so completed units are neither re-run nor re-paid after a crash.
 * Internal only; never exposed through DTOs.
 */
export interface WorkUnitResult {
  workUnitId: string;
  payloadJson: string;
  outputDigest: string;
  createdAt: number;
}
