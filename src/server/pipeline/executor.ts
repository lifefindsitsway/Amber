import type { TokenUsageFeature } from "../../shared/enums.ts";
import type { Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import type { LlmCallAttribution, LlmCompletion, LlmRequest } from "../domain/llm.ts";
import type { AsrModelRef, ModelRef, ModelRefSnapshot } from "../domain/model-ref.ts";
import type { CustomizablePromptId, ResolvedPrompt } from "../domain/prompts.ts";
import type { EffectiveCapability } from "../domain/provider-profile.ts";
import type { StageRun, Task, WorkUnitBilling } from "../domain/task.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import type { SlotOrder } from "./fair-semaphore.ts";

/** The persisted unit a spec runs as; its id is stable across retries and crash recovery. */
export interface UnitIdentity {
  id: string;
  /** Runs of this unit so far, this one included (1-based). */
  attempt: number;
  /** Retries already spent on this unit for the same input. */
  retryCount: number;
  /**
   * For a `paidCallStart: "explicit"` unit: the paid request is about to be sent, so from
   * now on a crash leaves its outcome unknown. Idempotent; a no-op for other units.
   */
  markPaidCallStart(): void;
}

/** A DB-only WorkUnit: its JSON payload is persisted in `WorkUnitResult`. */
export interface DbUnitSpec<T> {
  key: string;
  /** Fingerprint of the unit's input; a completed unit is reused only for the same digest. */
  inputDigest: string;
  /** Marks a paid outbound call: crash recovery parks it instead of re-running it. */
  billing?: WorkUnitBilling;
  /**
   * When a paid unit starts to count as calling: at once (`immediate`, the default for
   * ASR), or only once `run` calls `unit.markPaidCallStart()` (`explicit`, the default for
   * LLM units, whose calls first wait for their model lane). Until then the unit stays
   * `pending` and crash recovery re-runs it instead of parking it.
   */
  paidCallStart?: PaidCallStart;
  run(signal: AbortSignal, unit: UnitIdentity): Promise<T>;
}

export type PaidCallStart = "immediate" | "explicit";

/**
 * A file-backed WorkUnit. `run` writes its file atomically (`.partial` → fsync → rename)
 * before resolving; completion is then judged by the file's presence and digest.
 */
export interface FileUnitSpec {
  key: string;
  inputDigest: string;
  storage: "file";
  /** Where the output file lives: the video cache store, or by default the data directory. */
  store?: "cache";
  billing?: WorkUnitBilling;
  paidCallStart?: PaidCallStart;
  /**
   * Where `run` commits its output for a given unit. When present, a unit that is about to
   * run again (after a crash, or after the user confirmed a re-send) whose output was
   * already committed there is completed from that file without running: a paid result
   * that reached the disk is never paid for twice.
   */
  checkpointRef?(unit: UnitIdentity): string;
  run(signal: AbortSignal, unit: UnitIdentity): Promise<{ outputRef: string; outputDigest: string }>;
}

/**
 * What a stage may know about the model it is about to call: the effective capability
 * (the only source of capability decisions, never the model's name), the audio formats its
 * protocol can encode (empty = none) and the snapshot recorded in provenance.
 */
export interface LlmModelDescription {
  capability: EffectiveCapability;
  audioMimeTypes: readonly string[];
  snapshot: ModelRefSnapshot;
}

/**
 * A request built only once its call may be sent: nothing is prepared while
 * the call waits, or while its model lane cools down. Proofreading clips a chunk's audio here.
 */
export interface DeferredLlmRequest {
  modelRef: ModelRef;
  /** Runs after the call was admitted and before anything is sent. */
  prepare(signal: AbortSignal): Promise<LlmRequest>;
}

export type LlmRequestInput = LlmRequest | DeferredLlmRequest;

export function isDeferredLlmRequest(request: LlmRequestInput): request is DeferredLlmRequest {
  return "prepare" in request;
}

/**
 * What the scheduler needs from the LlmGateway (application layer): one call that resolves
 * the request's ModelRef for its owner, waits in the fair group of `task` until its model
 * lane admits it, and records one TokenUsage row per request that crossed
 * the send boundary.
 */
export interface LlmInvoker {
  /**
   * `onCallStart` runs exactly once per attempt, after the call was admitted and its
   * request built, right before the adapter is called: until then nothing has been sent.
   * A Task's call that its cooling lane turns away throws `LlmCallDeferred`.
   */
  complete(
    call: LlmCallAttribution,
    request: LlmRequestInput,
    options: { signal: AbortSignal; task?: SlotOrder; onCallStart?: () => void },
  ): Promise<LlmCompletion>;
  /**
   * Resolves the owner's ModelRef without sending anything; fails like `complete` would
   * before sending (`llm_unconfigured`, unavailable credential, no adapter).
   */
  describe(userId: string, modelRef: ModelRef): LlmModelDescription;
}

/**
 * A stage's LLM handle, bound to its Task: owner, fair LLM slot group, cancellation and the
 * Task / Content attribution of usage. A call inside a WorkUnit passes the unit's id; it
 * is not retried here, `runUnit` retries the whole unit.
 */
export interface StageLlm {
  complete(request: LlmRequestInput, call: { feature: TokenUsageFeature; workUnitId?: string }): Promise<LlmCompletion>;
  /** The Task owner's view of `modelRef`, for planning a request before any call. */
  describe(modelRef: ModelRef): LlmModelDescription;
}

export interface StageExecutionContext {
  readonly task: Task;
  readonly stageRun: StageRun;
  readonly content: Content | undefined;
  /** The parsed, immutable `Task.requestJson`; each stage validates the part it needs. */
  readonly request: unknown;
  /** Frozen stage input first, then the Task request. */
  readonly modelRef: ModelRef | undefined;
  /** The ASR model the stage is bound to: frozen stage input first, then the Task request. */
  readonly asrModelRef: AsrModelRef | undefined;
  /**
   * A customizable prompt as this stage uses it: the version frozen on the stage input
   * (a re-run failed stage), else on the Task request, else the one in effect now (Tasks
   * submitted before prompts were frozen). A frozen version that no longer resolves falls
   * back to the current builtin text with a warning. Opens its own read; never call it
   * inside a repository transaction.
   */
  prompt(id: CustomizablePromptId): ResolvedPrompt;
  /** Aborts on cancellation and shutdown; pass it to every ProcessRunner and HTTP call. */
  readonly signal: AbortSignal;
  /**
   * Runs one WorkUnit, or returns its persisted result when it already completed. A
   * failure whose outcome is unknown parks the unit as `waiting_user_action` and throws
   * `StageParked`, so a paid call whose outcome is unknown is never re-sent automatically;
   * a failure retried later leaves the unit `pending` until its `retryNotBefore` and throws
   * `StageDeferred`. Executors must let both propagate; `stageUnitFailure` picks what a stage of parallel units throws.
   */
  runUnit<T>(unit: DbUnitSpec<T>): Promise<T>;
  runUnit(unit: FileUnitSpec): Promise<{ outputRef: string; outputDigest: string }>;
  /** LLM calls on behalf of this Task, through the LlmGateway. */
  readonly llm: StageLlm;
  /** Wraps managed heavy work (probing, metadata, audio extraction and clipping, downloads, burn-in) in the heavy-job governor. */
  withHeavySlot<T>(work: () => Promise<T>): Promise<T>;
  reportProgress(progress: number): void;
}

/**
 * What a successful stage publishes. `publish` runs inside the same transaction that marks
 * the StageRun `succeeded`: new revisions, current pointers, usage and the terminal state
 * commit together or not at all. It must be synchronous and do no I/O.
 */
export interface StageOutcome {
  resultJson?: unknown;
  publish?(scope: RepositoryScope): void;
}

export interface StageExecutor {
  run(context: StageExecutionContext): Promise<StageOutcome>;
}

export type StageExecutors = Partial<Record<StageRun["stage"], StageExecutor>>;

/** Thrown by `runUnit` when a unit waits for the user's confirmation to re-send. */
export class StageParked extends Error {
  constructor() {
    super("stage waits for user action");
    this.name = "StageParked";
  }
}

/**
 * Thrown by `runUnit` when a unit waits for its `retryNotBefore` (a rate-limit cooldown or
 * a retry backoff): the stage returns, its Task slot is freed, and the scheduler runs the
 * stage again once the time has come.
 */
export class StageDeferred extends Error {
  constructor() {
    super("stage waits before retrying a unit");
    this.name = "StageDeferred";
  }
}

/**
 * Thrown by a unit's `run` when it must wait without having failed: nothing was refused,
 * so no retry is spent. `runUnit` leaves the unit `pending` until `notBefore` and defers
 * its stage, freeing the Task slot. `resetRetries` clears the retries spent
 * so far: a unit polling an asynchronous job that answered "not yet" starts its transient
 * error budget afresh.
 */
export class UnitDeferred extends Error {
  readonly notBefore: number;
  readonly resetRetries: boolean;

  constructor(notBefore: number, options: { resetRetries?: boolean; message?: string } = {}) {
    super(options.message ?? "work unit waits before running again");
    this.name = "UnitDeferred";
    this.notBefore = notBefore;
    this.resetRetries = options.resetRetries ?? false;
  }
}

/**
 * Thrown by the LlmInvoker when a Task's call was turned away unsent because its model lane
 * is cooling down; `notBefore` is when the lane admits calls again.
 */
export class LlmCallDeferred extends UnitDeferred {
  constructor(notBefore: number) {
    super(notBefore, { message: "model lane is cooling down" });
    this.name = "LlmCallDeferred";
  }
}

/**
 * What a stage of parallel units throws once they all settled, or `undefined` when none
 * failed: a unit waiting for the user keeps the stage waiting, then a real failure fails
 * it, and only then does a unit waiting for its retry time defer it.
 */
export function stageUnitFailure(settled: readonly PromiseSettledResult<unknown>[]): unknown {
  const reasons = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  return (
    reasons.find((reason) => reason instanceof StageParked) ??
    reasons.find((reason) => !(reason instanceof StageDeferred)) ??
    reasons[0]
  );
}

/**
 * For a stage's publishing transaction: the transcript revision the stage was built from
 * must still be there. The user may delete it, or a manual commit may fold it away, while
 * the stage waits on the model; publishing anyway would store rows pointing at a revision
 * that no longer exists, so the stage fails instead and nothing is published.
 */
export function assertBaseRevisionExists(scope: RepositoryScope, ownerUserId: string, contentId: string, revisionId: string): void {
  const revision = scope.transcripts.getRevision(ownerUserId, revisionId);
  if (revision === undefined || revision.contentId !== contentId) {
    throw amberError("not_found", "base transcript revision not found");
  }
}
