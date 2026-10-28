import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { RETRY_MAX } from "../../shared/defaults.ts";
import type { RunMode } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import type { Content } from "../domain/content.ts";
import { AmberError, appError, isAmberError } from "../domain/errors.ts";
import type { InstanceSettings } from "../domain/runtime-support.ts";
import type { StageRun, Task, WorkUnit } from "../domain/task.ts";
import { parseStageInput, taskRequestView } from "../domain/task-request.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { CacheGate, Release } from "./cache-gate.ts";
import { conditionHolds, gatherConditionFacts } from "./conditions.ts";
import { diskLowError, type DiskUsageProbe } from "./disk-watermark.ts";
import type { TaskEventBus } from "./events.ts";
import {
  StageDeferred,
  StageParked,
  UnitDeferred,
  type DbUnitSpec,
  type FileUnitSpec,
  type LlmInvoker,
  type UnitIdentity,
  type StageExecutionContext,
  type StageExecutor,
  type StageExecutors,
} from "./executor.ts";
import { stageSpec, type StageSpec } from "./graph.ts";
import { isTerminalProjection, latestAttempts, stageRetryTime } from "./projection.ts";
import { type Outbox, transact } from "./publish.ts";
import { recoverInterrupted } from "./recovery.ts";
import { unmetRequirement, type CredentialStatusSource } from "./requirements.ts";
import { FairSemaphore, taskGroup, type SlotOrder } from "./fair-semaphore.ts";
import { backoffMs, mayRetry, retriesAutomatically, sleep, toAppError } from "./retry.ts";
import { resolvePrompt } from "./prompts.ts";
import { failStage, loadTaskState, refreshProjection, saveStageRun, saveWorkUnit, type TaskState } from "./task-state.ts";
import { toWorkUnitDto } from "./task-dto.ts";

/** Effective instance settings (environment over database), read on every scheduling decision. */
export interface InstanceSettingsSource {
  effective(): InstanceSettings;
}

/** The stores file-backed units are verified against on resume: checkpoints in `data`, cache downloads in `cache`. */
export interface SchedulerFiles {
  data: Pick<FileStore, "digest">;
  cache: Pick<FileStore, "digest">;
}

export interface SchedulerOptions {
  repository: Repository;
  secrets: CredentialStatusSource;
  bus: TaskEventBus;
  executors: StageExecutors;
  settings: InstanceSettingsSource;
  disk: DiskUsageProbe;
  /**
   * Every Task driver holds a shared lease while it runs, so a cache move waits for running
   * Tasks and no Task starts while the cache is being moved.
   */
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  /** Verifies file-backed units on resume; without it they are always re-run. */
  media?: SchedulerFiles;
  mode: RunMode;
  logger: Logger;
  /** The LlmGateway; it alone admits LLM calls. */
  llm?: LlmInvoker;
  /**
   * The instance's managed heavy-job governor, shared with API-side heavy work; capacity =
   * `concurrencyPipeline`. Created here when not given.
   */
  heavy?: FairSemaphore;
  now?: () => number;
  newId?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Calls `wake` after `ms` without keeping the process alive; returns a cancel. Defaults to `setTimeout`. */
  wakeAfter?: (ms: number, wake: () => void) => () => void;
}

interface Driver {
  controller: AbortController;
  wake: () => void;
  done: Promise<void>;
}

interface StageStart {
  task: Task;
  content: Content | undefined;
  run: StageRun;
  spec: StageSpec;
  executor: StageExecutor;
}

const digestOf = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const orderOf = (task: Task): SlotOrder => ({ createdAt: task.createdAt, id: task.id });
/** The longest delay `setTimeout` takes; a longer wait just wakes once more on the way. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

function wakeAfterTimeout(ms: number, wake: () => void): () => void {
  const timer = setTimeout(wake, Math.min(Math.max(0, ms), MAX_TIMER_MS));
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * In-process scheduler. State lives in SQLite; this class only decides
 * what runs next and drives stage executors:
 * - Tasks take pipeline slots FIFO by (`createdAt`, `id`); a Task holds its slot while it
 *   has stages to execute and releases it when it finishes or only waits (configuration,
 *   user confirmation, a unit's retry time). Managed heavy work takes a slot of the shared
 *   heavy-job governor in the Task's fair group; LLM calls are admitted by the LlmGateway.
 * - A unit waiting for its `retryNotBefore` keeps its stage out of scheduling until then; a
 *   timer wakes the scheduler at the earliest such time.
 * - Before a slot is taken the disk watermark is checked; below it, queued Tasks stay
 *   queued until the next scheduling pass. Running Tasks are never interrupted by it. The
 *   same holds for the cache gate: while the cache is being moved nothing starts.
 * - Every state change commits in a transaction and its events are published after commit.
 * - Cancellation and shutdown abort the Task's signal, which kills process trees; after an
 *   abort the execution writes nothing, so explicit cancellation owns the final state and a
 *   shutdown leaves `running` rows for crash recovery.
 */
export class Scheduler {
  private readonly options: SchedulerOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly drivers = new Map<string, Driver>();
  private readonly activeStages = new Set<string>();
  private readonly unitFailures = new WeakSet<object>();
  private readonly heavy: FairSemaphore;
  private readonly wakeAfter: (ms: number, wake: () => void) => () => void;
  private cancelWake: (() => void) | undefined;
  /** Settles when the scheduled wake fired or was cancelled. */
  private wakeSettled: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private tickRunning: Promise<void> | undefined;
  private tickAgain = false;
  private diskLowReported = false;
  private cacheMigrationReported = false;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.sleep = options.sleep ?? sleep;
    this.heavy = options.heavy ?? new FairSemaphore(() => options.settings.effective().concurrencyPipeline);
    this.wakeAfter = options.wakeAfter ?? wakeAfterTimeout;
  }

  /**
   * Crash recovery, then the first scheduling pass. Nothing is scheduled before this: a
   * pass could otherwise mark stages `running` that recovery would then interrupt.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const recovered = recoverInterrupted(this.options.repository, this.options.bus, this.now());
    if (recovered > 0) {
      this.options.logger.info("scheduler_recovered", { interrupted: recovered });
    }
    this.kick();
  }

  /**
   * Requests a scheduling pass: after any state change, new Task, retry, confirmation or
   * settings change. Passes never overlap; a request during a pass triggers one more.
   */
  kick(): void {
    if (!this.started || this.stopped) {
      return;
    }
    this.heavy.drain();
    for (const driver of this.drivers.values()) {
      driver.wake();
    }
    if (this.tickRunning !== undefined) {
      this.tickAgain = true;
      return;
    }
    this.tickRunning = this.tickLoop().finally(() => {
      this.tickRunning = undefined;
    });
  }

  /** Aborts the Task's running execution (process trees included) ahead of explicit cancellation. */
  abortTask(taskId: string): void {
    this.drivers.get(taskId)?.controller.abort(new Error("task cancelled"));
  }

  /** Whether the Task has an execution in this process (running, or still unwinding after an abort). */
  isExecuting(taskId: string): boolean {
    return this.drivers.has(taskId);
  }

  /**
   * Resolves once none of the Tasks has an execution left: every aborted stage has
   * returned and its process trees are gone. Tasks without an execution count as settled.
   */
  async settleTasks(taskIds: readonly string[]): Promise<void> {
    for (;;) {
      const pending = taskIds.flatMap((id) => {
        const driver = this.drivers.get(id);
        return driver === undefined ? [] : [driver.done];
      });
      if (pending.length === 0) {
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  isStageActive(stageRunId: string): boolean {
    return this.activeStages.has(stageRunId);
  }

  /** Stops scheduling and aborts every execution, leaving `running` rows to crash recovery. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelWake?.();
    this.cancelWake = undefined;
    for (const driver of this.drivers.values()) {
      driver.controller.abort(new Error("shutdown"));
    }
    await Promise.allSettled([this.tickRunning, ...[...this.drivers.values()].map((driver) => driver.done)]);
  }

  /** Resolves once no pass is pending, no Task is executing and no wake for a waiting unit is scheduled. */
  async whenIdle(): Promise<void> {
    while (this.tickRunning !== undefined || this.drivers.size > 0 || this.wakeSettled !== undefined) {
      await Promise.allSettled([this.tickRunning, this.wakeSettled, ...[...this.drivers.values()].map((driver) => driver.done)]);
    }
  }

  private async tickLoop(): Promise<void> {
    do {
      this.tickAgain = false;
      try {
        await this.tick();
      } catch (error) {
        this.options.logger.error("scheduler_tick_failed", { error: String(error) });
      }
    } while (this.tickAgain && !this.stopped);
  }

  private async tick(): Promise<void> {
    const settings = this.options.settings.effective();
    const now = this.now();
    let nextWake: number | undefined;
    const ready = this.options.repository.withTransaction((scope) =>
      scope.tasks.listUnfinished().filter((task) => {
        const state = loadTaskState(scope, task.userId, task.id);
        if (state === undefined) {
          return false;
        }
        const waitsUntil = nextRetryTime(state, now);
        if (waitsUntil !== undefined && (nextWake === undefined || waitsUntil < nextWake)) {
          nextWake = waitsUntil;
        }
        return !this.drivers.has(task.id) && readyStages(state, this.activeStages, now).length > 0;
      }),
    );
    this.scheduleWake(nextWake, now);
    let diskChecked = false;
    for (const task of ready) {
      if (this.stopped || this.drivers.size >= settings.concurrencyPipeline) {
        return;
      }
      if (!diskChecked) {
        diskChecked = true;
        if ((await diskLowError(this.options.disk, settings)) !== undefined) {
          if (!this.diskLowReported) {
            this.diskLowReported = true;
            this.options.logger.warn("scheduler_paused_disk_low");
          }
          return;
        }
        this.diskLowReported = false;
      }
      if (!this.drivers.has(task.id) && !this.stopped && !this.startDriver(task)) {
        return;
      }
    }
  }

  /** One timer for the earliest time a waiting unit's stage becomes ready again. */
  private scheduleWake(at: number | undefined, now: number): void {
    this.cancelWake?.();
    this.cancelWake = undefined;
    if (at === undefined || this.stopped) {
      return;
    }
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const done = (): void => {
      if (this.wakeSettled === settled) {
        this.wakeSettled = undefined;
      }
      settle();
    };
    this.wakeSettled = settled;
    const cancel = this.wakeAfter(at - now, () => {
      this.cancelWake = undefined;
      // The pass starts before the wake counts as settled, so `whenIdle` sees one or the other.
      this.kick();
      done();
    });
    this.cancelWake = () => {
      cancel();
      done();
    };
  }

  /** Starts the Task's driver under a shared cache lease; `false` when the cache is being moved, to try again next tick. */
  private startDriver(task: Task): boolean {
    const release: Release | undefined = this.options.gate.tryShared();
    if (release === undefined) {
      if (!this.cacheMigrationReported) {
        this.cacheMigrationReported = true;
        this.options.logger.info(`scheduler_paused_${this.options.gate.exclusiveReason() ?? "cache_migration"}`);
      }
      return false;
    }
    this.cacheMigrationReported = false;
    const controller = new AbortController();
    const driver: Driver = { controller, wake: () => undefined, done: Promise.resolve() };
    this.drivers.set(task.id, driver);
    driver.done = this.drive(task, driver)
      .catch((error: unknown) => this.options.logger.error("task_driver_failed", { taskId: task.id, error: String(error) }))
      .finally(() => {
        this.drivers.delete(task.id);
        release();
        this.kick();
      });
    return true;
  }

  private async drive(task: Task, driver: Driver): Promise<void> {
    const { signal } = driver.controller;
    const inflight = new Map<string, Promise<void>>();
    while (!signal.aborted) {
      const starts = transact(this.options.repository, this.options.bus, (scope, outbox) =>
        this.planStep(scope, outbox, task, inflight),
      );
      for (const start of starts) {
        this.activeStages.add(start.run.id);
        inflight.set(
          start.run.id,
          this.runStage(start, signal).finally(() => {
            this.activeStages.delete(start.run.id);
            inflight.delete(start.run.id);
          }),
        );
      }
      if (inflight.size === 0) {
        break;
      }
      const woken = new Promise<void>((resolve) => {
        driver.wake = resolve;
      });
      await Promise.race([...inflight.values(), woken]);
    }
    await Promise.allSettled([...inflight.values()]);
  }

  /**
   * One planning step inside a transaction: settles every stage that can be decided without
   * running it (condition skips, unmet requirements, missing executors) and marks the ones
   * to execute as `running`.
   */
  private planStep(scope: RepositoryScope, outbox: Outbox, task: Task, inflight: ReadonlyMap<string, unknown>): StageStart[] {
    const owner = task.userId;
    const now = this.now();
    const starts: StageStart[] = [];
    const excluded = new Set([...this.activeStages, ...inflight.keys()]);
    for (;;) {
      const state = loadTaskState(scope, owner, task.id);
      if (state === undefined || isTerminalProjection(state.task.statusProjection)) {
        return starts;
      }
      const request = taskRequestView(state.task.requestJson);
      let settled = false;
      for (const run of readyStages(state, excluded, now)) {
        const spec = stageSpec(state.graph, run.stage);
        const executor = this.options.executors[run.stage];
        if (run.status === "pending") {
          if (spec?.condition !== undefined) {
            const facts = gatherConditionFacts(scope, { mode: this.options.mode, content: state.content, request, stageRuns: state.runs });
            if (!conditionHolds(spec.condition, facts)) {
              saveStageRun(scope, outbox, owner, { ...run, status: "skipped", finishedAt: now });
              settled = true;
              break;
            }
          }
          if (spec?.requirement !== undefined) {
            const input = parseStageInput(run.inputJson);
            const modelRef = input.modelRef ?? request.modelRef;
            const asrModelRef = input.asrModelRef ?? request.asrModelRef;
            const unmet = unmetRequirement(scope, this.options.secrets, { requirement: spec.requirement, ownerUserId: owner, modelRef, asrModelRef });
            if (unmet !== undefined) {
              saveStageRun(scope, outbox, owner, { ...run, status: "waiting_configuration", error: unmet });
              settled = true;
              break;
            }
          }
        }
        if (spec === undefined || executor === undefined) {
          this.options.logger.error("stage_without_executor", { taskId: task.id, stage: run.stage });
          failStage(scope, outbox, state, run, appError("internal"), now);
          settled = true;
          break;
        }
        const { error: _cleared, ...rest } = run;
        const running: StageRun = { ...rest, status: "running", startedAt: run.startedAt ?? now };
        if (run.status !== "running") {
          saveStageRun(scope, outbox, owner, running);
        }
        excluded.add(run.id);
        starts.push({ task: state.task, content: state.content, run: running, spec, executor });
      }
      if (!settled) {
        refreshProjection(scope, outbox, owner, task.id, now);
        return starts;
      }
    }
  }

  private async runStage(start: StageStart, signal: AbortSignal): Promise<void> {
    const { task, run, spec, executor } = start;
    const owner = task.userId;
    try {
      const context = this.context(start, signal);
      const execute = (): Promise<Awaited<ReturnType<StageExecutor["run"]>>> => this.executeWithRetry(executor, context, signal);
      const outcome = spec.heavy === true ? await this.heavy.run(taskGroup(orderOf(task)), signal, execute) : await execute();
      if (signal.aborted) {
        return;
      }
      transact(this.options.repository, this.options.bus, (scope, outbox) => {
        outcome.publish?.(scope);
        const current = currentRun(scope, owner, run);
        const succeeded: StageRun = { ...current, status: "succeeded", progress: 1, finishedAt: this.now() };
        if (outcome.resultJson !== undefined) {
          succeeded.resultJson = JSON.stringify(outcome.resultJson);
        }
        saveStageRun(scope, outbox, owner, succeeded);
        refreshProjection(scope, outbox, owner, task.id, this.now());
      });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      // The stage stays `running` without being executed: it waits for the user, or for a
      // unit's retry time, and is picked up again by a later pass.
      if (error instanceof StageParked || error instanceof StageDeferred) {
        transact(this.options.repository, this.options.bus, (scope, outbox) => {
          refreshProjection(scope, outbox, owner, task.id, this.now());
        });
        return;
      }
      if (!isAmberError(error)) {
        this.options.logger.error("stage_failed_unexpectedly", { taskId: task.id, stage: run.stage, error: String(error) });
      }
      const failure = toAppError(error);
      transact(this.options.repository, this.options.bus, (scope, outbox) => {
        const state = loadTaskState(scope, owner, task.id) as TaskState;
        failStage(scope, outbox, state, currentRun(scope, owner, run), failure, this.now());
        refreshProjection(scope, outbox, owner, task.id, this.now());
      });
    }
  }

  /** Stage-level automatic retry for `safe` / `policy` failures outside any WorkUnit. */
  private async executeWithRetry(
    executor: StageExecutor,
    context: StageExecutionContext,
    signal: AbortSignal,
  ): ReturnType<StageExecutor["run"]> {
    for (let retry = 1; ; retry += 1) {
      try {
        return await executor.run(context);
      } catch (error) {
        if (signal.aborted || error instanceof StageParked || error instanceof StageDeferred || this.unitFailures.has(error as object)) {
          throw error;
        }
        const failure = toAppError(error);
        if (!mayRetry(failure, retry)) {
          throw error;
        }
        await this.waitBeforeRetry(failure, retry, signal);
      }
    }
  }

  /** Exponential backoff, except for `output_mismatch`, which is re-asked at once. */
  private async waitBeforeRetry(failure: AppError, retry: number, signal: AbortSignal): Promise<void> {
    if (failure.class !== "output_mismatch") {
      await this.sleep(backoffMs(retry), signal);
    }
  }

  private context(start: StageStart, signal: AbortSignal): StageExecutionContext {
    const { task, content, run, spec } = start;
    const order = orderOf(task);
    const request: unknown = JSON.parse(task.requestJson);
    const stageInput = parseStageInput(run.inputJson);
    const requestView = taskRequestView(task.requestJson);
    const modelRef = stageInput.modelRef ?? requestView.modelRef;
    const asrModelRef = stageInput.asrModelRef ?? requestView.asrModelRef;
    const frozenPrompts = { ...requestView.promptRefs, ...stageInput.promptRefs };
    const runUnit = (unit: DbUnitSpec<unknown> | FileUnitSpec): Promise<unknown> => this.runUnit(task, run, unit, signal);
    const gateway = (): LlmInvoker => {
      if (this.options.llm === undefined) {
        throw new AmberError(appError("internal"), "no LLM gateway composed");
      }
      return this.options.llm;
    };
    return {
      task,
      stageRun: run,
      content,
      request,
      modelRef,
      asrModelRef,
      prompt: (id) =>
        this.options.repository.withTransaction((scope) =>
          resolvePrompt(scope, task.userId, id, frozenPrompts[id], (ref) =>
            this.options.logger.warn("prompt_version_unresolved", { taskId: task.id, stage: run.stage, promptId: id, ref: `${ref.id}@${ref.version}` }),
          ),
        ),
      signal,
      runUnit: runUnit as StageExecutionContext["runUnit"],
      llm: {
        complete: async (llmRequest, call) =>
          gateway().complete(
            {
              userId: task.userId,
              feature: call.feature,
              taskId: task.id,
              ...(content === undefined ? {} : { contentId: content.id }),
              ...(call.workUnitId === undefined ? {} : { workUnitId: call.workUnitId }),
            },
            llmRequest,
            {
              signal,
              task: order,
              ...(call.workUnitId === undefined ? {} : { onCallStart: () => this.markUnitCalling(task, run.id, call.workUnitId as string) }),
            },
          ),
        describe: (ref) => gateway().describe(task.userId, ref),
      },
      // A heavy stage already holds its slot for the whole run.
      withHeavySlot: (work) => (spec.heavy === true ? work() : this.heavy.run(taskGroup(order), signal, work)),
      reportProgress: (progress) => {
        if (signal.aborted) {
          return;
        }
        transact(this.options.repository, this.options.bus, (scope, outbox) => {
          const current = currentRun(scope, task.userId, run);
          // Progress only grows within a run and is kept at whole percents, so
          // a fine-grained sink neither moves the bar backwards nor floods the bus.
          const next = Math.max(current.progress, quantizeProgress(progress));
          if (next !== current.progress) {
            saveStageRun(scope, outbox, task.userId, { ...current, progress: next });
          }
        });
      },
    };
  }

  private async runUnit(task: Task, run: StageRun, spec: DbUnitSpec<unknown> | FileUnitSpec, signal: AbortSignal): Promise<unknown> {
    const owner = task.userId;
    const fileBacked = "storage" in spec;
    const existing = this.options.repository.withTransaction((scope) =>
      scope.workUnits.listByStageRun(owner, run.id).find((unit) => unit.key === spec.key),
    );
    if (existing?.status === "waiting_user_action") {
      throw new StageParked();
    }
    // Its stage ran again for another unit's sake; this one still waits for its time.
    if (existing?.status === "pending" && existing.inputDigest === spec.inputDigest && (existing.retryNotBefore ?? 0) > this.now()) {
      throw new StageDeferred();
    }
    if (existing?.status === "succeeded" && existing.inputDigest === spec.inputDigest) {
      const completed = fileBacked ? await this.completedFile(existing, spec) : this.completedDbUnit(owner, existing);
      if (completed !== undefined) {
        return completed.value;
      }
    }
    if (existing === undefined) {
      const reused = await this.reuseEarlierAttempt(task, run, spec);
      if (reused !== undefined) {
        return reused.value;
      }
    } else if (fileBacked && existing.status !== "succeeded" && existing.inputDigest === spec.inputDigest) {
      const recovered = await this.recoverCheckpoint(task, existing, spec);
      if (recovered !== undefined) {
        return recovered.value;
      }
    }
    // Re-entry after a confirmed re-send must not pay again for a unit whose failure is
    // already final in this attempt: its persisted error stands, and running it again takes
    // a new attempt.
    if (existing?.status === "failed" && existing.inputDigest === spec.inputDigest) {
      const failure = new AmberError(existing.error ?? appError("internal"), "work unit already failed in this attempt");
      this.unitFailures.add(failure);
      throw failure;
    }
    if (signal.aborted) {
      throw signal.reason;
    }

    const billing = spec.billing === undefined ? {} : { billing: spec.billing };
    // A paid unit whose call starts later than its run (an LLM call waiting for its model
    // lane, an ASR job whose upload comes first) has sent nothing until it says so, so it
    // stays `pending` until `markUnitCalling`: crash recovery parks only units that may have
    // sent a paid request. Other units count as calling from the start.
    const explicitStart = spec.billing !== undefined && (spec.paidCallStart ?? (spec.billing === "llm" ? "explicit" : "immediate")) === "explicit";
    const status: WorkUnit["status"] = explicitStart ? "pending" : "running";
    // Retries already spent count on across stage re-runs and restarts, for the same input.
    const retryCount = existing !== undefined && existing.inputDigest === spec.inputDigest ? existing.retryCount : 0;
    let unit: WorkUnit =
      existing === undefined
        ? { id: this.newId(), stageRunId: run.id, key: spec.key, status, attempt: 1, retryCount, inputDigest: spec.inputDigest, ...billing }
        : { id: existing.id, stageRunId: run.id, key: spec.key, status, attempt: existing.attempt + 1, retryCount, inputDigest: spec.inputDigest, ...billing };
    transact(this.options.repository, this.options.bus, (scope, outbox) => {
      if (existing === undefined) {
        scope.workUnits.insert(owner, unit);
        outbox.push(owner, { type: "workunit.updated", workUnit: toWorkUnitDto(unit) });
      } else {
        saveWorkUnit(scope, outbox, owner, unit);
      }
      refreshProjection(scope, outbox, owner, task.id, this.now());
    });

    for (;;) {
      let value: unknown;
      try {
        value = await spec.run(signal, this.identity(task, run, unit, explicitStart));
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        // A wait that is no failure (a cooling model lane turned the call away unsent, an
        // asynchronous job is not done yet): no retry spent, the Task slot is freed.
        if (error instanceof UnitDeferred) {
          const waiting: WorkUnit = { ...unit, status: "pending", retryNotBefore: error.notBefore };
          if (error.resetRetries) {
            // The job answered, so earlier transient failures are behind it.
            delete waiting.error;
            waiting.retryCount = 0;
          }
          this.settleUnit(task, waiting);
          throw new StageDeferred();
        }
        const failure = toAppError(error);
        if (failure.retryDisposition === "outcome_unknown") {
          this.settleUnit(task, { ...unit, status: "waiting_user_action", error: failure });
          throw new StageParked();
        }
        if (retriesAutomatically(failure.retryDisposition) && unit.retryCount < RETRY_MAX) {
          // An explicit answer: the unit is back to `pending` with one more retry spent.
          // A wait is persisted and its stage gives up the Task slot until then.
          const waitMs = retryWaitMs(failure, unit.retryCount + 1);
          const retried: WorkUnit = { ...unit, status: "pending", retryCount: unit.retryCount + 1, error: failure };
          if (waitMs > 0) {
            this.settleUnit(task, { ...retried, retryNotBefore: this.now() + waitMs });
            throw new StageDeferred();
          }
          // Nothing to wait for (`output_mismatch`): ask again at once, in this run.
          unit = { ...retried, status };
          this.settleUnit(task, unit);
          continue;
        }
        this.settleUnit(task, { ...unit, status: "failed", error: failure });
        const thrown = isAmberError(error) ? error : new AmberError(failure, "work unit failed", { cause: error });
        this.unitFailures.add(thrown);
        throw thrown;
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      if (explicitStart) {
        this.reportUnmarkedPaidCall(task, run, unit);
      }
      const { error: _cleared, ...done } = unit;
      if (fileBacked) {
        const output = value as { outputRef: string; outputDigest: string };
        this.settleUnit(task, { ...done, status: "succeeded", outputRef: output.outputRef, outputDigest: output.outputDigest });
        return value;
      }
      const payloadJson = JSON.stringify(value ?? null);
      const outputDigest = digestOf(payloadJson);
      this.settleUnit(task, { ...done, status: "succeeded", outputDigest }, (scope) =>
        scope.workUnits.putResult(owner, { workUnitId: unit.id, payloadJson, outputDigest, createdAt: this.now() }),
      );
      return JSON.parse(payloadJson) as unknown;
    }
  }

  /**
   * Completes a unit that is about to run again (after a crash, or a confirmed re-send)
   * from the output its earlier run already committed at its checkpoint, without running
   * it: atomic writes make an existing file a complete one.
   */
  private async recoverCheckpoint(task: Task, unit: WorkUnit, spec: FileUnitSpec): Promise<{ value: unknown } | undefined> {
    // Checkpoints live under `tmp/tasks` in the data directory whatever the unit's store.
    const files = this.options.media?.data;
    if (files === undefined || spec.checkpointRef === undefined) {
      return undefined;
    }
    const outputRef = spec.checkpointRef(this.identity(task, unit.stageRunId, unit, false));
    const outputDigest = await files.digest(outputRef);
    if (outputDigest === null) {
      return undefined;
    }
    const { error: _cleared, ...rest } = unit;
    this.settleUnit(task, { ...rest, status: "succeeded", outputRef, outputDigest });
    return { value: { outputRef, outputDigest } };
  }

  /**
   * Cross-attempt reuse: a new attempt of a stage takes over the latest
   * earlier attempt's succeeded unit with the same key and input digest, after checking
   * that its result is intact, by recording a succeeded copy in the new attempt. Nothing is
   * re-run or paid for again. Units that wait for the user are never taken over.
   */
  private async reuseEarlierAttempt(task: Task, run: StageRun, spec: DbUnitSpec<unknown> | FileUnitSpec): Promise<{ value: unknown } | undefined> {
    const owner = task.userId;
    const fileBacked = "storage" in spec;
    const candidates = this.options.repository.withTransaction((scope) => {
      const attempts = new Map(
        scope.stageRuns
          .listByTask(owner, task.id)
          .filter((candidate) => candidate.stage === run.stage && candidate.attempt < run.attempt)
          .map((candidate) => [candidate.id, candidate.attempt]),
      );
      return scope.workUnits
        .listByTask(owner, task.id)
        .filter((unit) => attempts.has(unit.stageRunId) && unit.key === spec.key && unit.status === "succeeded" && unit.inputDigest === spec.inputDigest)
        .sort((a, b) => (attempts.get(b.stageRunId) as number) - (attempts.get(a.stageRunId) as number));
    });
    for (const candidate of candidates) {
      const completed = fileBacked ? await this.completedFile(candidate, spec) : this.completedDbUnit(owner, candidate);
      if (completed === undefined) {
        continue;
      }
      const copy: WorkUnit = {
        id: this.newId(),
        stageRunId: run.id,
        key: spec.key,
        status: "succeeded",
        attempt: 1,
        retryCount: 0,
        inputDigest: spec.inputDigest,
        ...(candidate.outputRef === undefined ? {} : { outputRef: candidate.outputRef }),
        ...(candidate.outputDigest === undefined ? {} : { outputDigest: candidate.outputDigest }),
        ...(candidate.billing === undefined ? {} : { billing: candidate.billing }),
      };
      const result = fileBacked ? undefined : this.options.repository.withTransaction((scope) => scope.workUnits.getResult(owner, candidate.id));
      transact(this.options.repository, this.options.bus, (scope, outbox) => {
        scope.workUnits.insert(owner, copy);
        if (result !== undefined) {
          scope.workUnits.putResult(owner, { ...result, workUnitId: copy.id, createdAt: this.now() });
        }
        outbox.push(owner, { type: "workunit.updated", workUnit: toWorkUnitDto(copy) });
        refreshProjection(scope, outbox, owner, task.id, this.now());
      });
      return completed;
    }
    return undefined;
  }

  /**
   * What a unit's `run` sees of itself. `markPaidCallStart` moves an explicit-start unit to
   * `running` once, through `markUnitCalling`; repeated calls and other units do nothing.
   */
  private identity(task: Task, run: StageRun | string, unit: WorkUnit, explicitStart: boolean): UnitIdentity {
    let marked = !explicitStart;
    const runId = typeof run === "string" ? run : run.id;
    return {
      id: unit.id,
      attempt: unit.attempt,
      retryCount: unit.retryCount,
      markPaidCallStart: () => {
        if (marked) {
          return;
        }
        marked = true;
        this.markUnitCalling(task, runId, unit.id);
      },
    };
  }

  /**
   * An explicit-start paid unit that returned while still `pending` never said it was
   * calling: had the process died mid-call, its paid request would have been re-sent
   * silently. Reported, not refused: the result itself is valid.
   */
  private reportUnmarkedPaidCall(task: Task, run: StageRun, unit: WorkUnit): void {
    const current = this.options.repository.withTransaction((scope) =>
      scope.workUnits.listByStageRun(task.userId, run.id).find((candidate) => candidate.id === unit.id),
    );
    if (current?.status === "pending") {
      this.options.logger.error("unit_paid_call_unmarked", { taskId: task.id, key: unit.key });
    }
  }

  /**
   * A queued LLM unit was admitted and is about to call the adapter: from here a crash may
   * leave a paid request with an unknown outcome. Only an explicit answer moves it back to
   * `pending` (`runUnit`); the parsing after a call stays protected, so a crash there never
   * re-sends the paid request.
   */
  private markUnitCalling(task: Task, runId: string, workUnitId: string): void {
    transact(this.options.repository, this.options.bus, (scope, outbox) => {
      const unit = scope.workUnits.listByStageRun(task.userId, runId).find((candidate) => candidate.id === workUnitId);
      if (unit?.status !== "pending") {
        return;
      }
      saveWorkUnit(scope, outbox, task.userId, { ...unit, status: "running" });
      refreshProjection(scope, outbox, task.userId, task.id, this.now());
    });
  }

  /** Persists a unit's new state (and, for DB-only success, its result) in one transaction. */
  private settleUnit(task: Task, unit: WorkUnit, alongside?: (scope: RepositoryScope) => void): void {
    transact(this.options.repository, this.options.bus, (scope, outbox) => {
      alongside?.(scope);
      saveWorkUnit(scope, outbox, task.userId, unit);
      refreshProjection(scope, outbox, task.userId, task.id, this.now());
    });
  }

  /** A DB-only unit is complete when its result row exists and matches the recorded digest. */
  private completedDbUnit(owner: string, unit: WorkUnit): { value: unknown } | undefined {
    const result = this.options.repository.withTransaction((scope) => scope.workUnits.getResult(owner, unit.id));
    if (result === undefined || unit.outputDigest === undefined) {
      return undefined;
    }
    if (result.outputDigest !== unit.outputDigest || digestOf(result.payloadJson) !== unit.outputDigest) {
      return undefined;
    }
    return { value: JSON.parse(result.payloadJson) as unknown };
  }

  /** A file-backed unit is complete when its file exists, in the store its spec names, with the recorded `sha256:<hex>` digest. */
  private async completedFile(unit: WorkUnit, spec: FileUnitSpec): Promise<{ value: unknown } | undefined> {
    const files = spec.store === "cache" ? this.options.media?.cache : this.options.media?.data;
    if (files === undefined || unit.outputRef === undefined || unit.outputDigest === undefined) {
      return undefined;
    }
    return (await files.digest(unit.outputRef)) === unit.outputDigest
      ? { value: { outputRef: unit.outputRef, outputDigest: unit.outputDigest } }
      : undefined;
  }
}

/** Stored progress resolution: whole percents. */
const PROGRESS_STEPS = 100;
/** Absorbs binary rounding (0.29 * 100 = 28.999…) so a value already on a step stays on it. */
const PROGRESS_EPSILON = 1e-9;

/** Clamps to [0, 1] and rounds down to a whole percent; 1 stays 1. */
function quantizeProgress(progress: number): number {
  const clamped = Number.isNaN(progress) ? 0 : Math.min(1, Math.max(0, progress));
  return Math.floor(clamped * PROGRESS_STEPS + PROGRESS_EPSILON) / PROGRESS_STEPS;
}

function currentRun(scope: RepositoryScope, owner: string, run: StageRun): StageRun {
  const current = scope.stageRuns.listByTask(owner, run.taskId).find((candidate) => candidate.id === run.id);
  if (current === undefined) {
    throw new TypeError(`stage run ${run.id} vanished`);
  }
  return current;
}

/**
 * How long a unit waits before retry number `retry` (1-based): the cooldown its model lane
 * named, at once after `output_mismatch` (re-asked without backoff), else exponential
 * backoff.
 */
function retryWaitMs(failure: AppError, retry: number): number {
  const lane = failure.details?.["retryAfterMs"];
  if (typeof lane === "number") {
    return Math.max(0, lane);
  }
  return failure.class === "output_mismatch" ? 0 : backoffMs(retry);
}

/** The earliest future time one of the Task's waiting stages becomes ready, for the wake timer. */
export function nextRetryTime(state: Pick<TaskState, "runs" | "units">, now: number): number | undefined {
  let earliest: number | undefined;
  for (const run of latestAttempts(state.runs)) {
    const at = stageRetryTime(run, state.units);
    if (at !== undefined && at > now && (earliest === undefined || at < earliest)) {
      earliest = at;
    }
  }
  return earliest;
}

/**
 * Stages with work to do: `pending` ones whose dependencies all finished (`succeeded`, or
 * `skipped` by their own condition), `interrupted` ones, and `running` ones that nothing
 * executes and whose units do not wait for the user (for example after confirm-resend). A
 * started stage whose units wait for their retry time is ready once the latest has passed.
 */
export function readyStages(state: Pick<TaskState, "runs" | "units">, active: ReadonlySet<string>, now: number): StageRun[] {
  const latest = latestAttempts(state.runs);
  const byStage = new Map(latest.map((run) => [run.stage, run]));
  const parked = new Set(state.units.filter((unit) => unit.status === "waiting_user_action").map((unit) => unit.stageRunId));
  return latest.filter((run) => {
    if (active.has(run.id)) {
      return false;
    }
    const retryAt = stageRetryTime(run, state.units);
    if (retryAt !== undefined && retryAt > now) {
      return false;
    }
    switch (run.status) {
      case "pending":
        return run.dependencies.every((dependency) => {
          const status = byStage.get(dependency)?.status;
          return status === "succeeded" || status === "skipped";
        });
      case "interrupted":
        return true;
      case "running":
        return !parked.has(run.id);
      default:
        return false;
    }
  });
}
