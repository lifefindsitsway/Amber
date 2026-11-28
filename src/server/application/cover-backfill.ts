import { monotonicFactory } from "ulid";
import { COVER_BACKFILL_INTERVAL_MS, COVER_BACKFILL_MAX_ITEMS } from "../../shared/defaults.ts";
import {
  COVER_BACKFILL_FAILURE_REASONS,
  type CoverBackfillFailureReason,
  type CoverBackfillJobDto,
  type CoverBackfillStartRequest,
  type CoverBackfillStatusDto,
} from "../../shared/dto/cover-backfill.ts";
import type { COVER_BACKFILL_MODES, COVER_BACKFILL_STATES } from "../../shared/dto/cover-backfill.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import { diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import type { ContentCoverService, CoverBackfillItemResult } from "./content-covers.ts";
import { abortableSleep } from "./cover-fetch-coordinator.ts";

type Mode = (typeof COVER_BACKFILL_MODES)[number];
type State = (typeof COVER_BACKFILL_STATES)[number];

/** Failure groups a later `retry` takes up: the ones that may well pass on another try. */
const TEMPORARY: ReadonlySet<CoverBackfillFailureReason> = new Set(["platform_unreachable", "platform_refused", "proxy_unavailable", "disk_low"]);

/** The group a failed item is counted in. */
export function coverBackfillFailureReason(error: unknown, staleLink: boolean): CoverBackfillFailureReason {
  if (staleLink) {
    return "link_expired";
  }
  if (!isAmberError(error)) {
    return "platform_unreachable";
  }
  switch (error.appError.class) {
    case "platform_blocked":
    case "auth_required":
    case "paid_content":
      return "platform_refused";
    case "network_proxy_unsupported":
    case "network_proxy_failed":
      return "proxy_unavailable";
    case "disk_low":
      return "disk_low";
    case "invalid_request":
    case "media_too_large":
    case "media_unsupported_type":
    case "internal":
      return "image_rejected";
    default:
      return "platform_unreachable";
  }
}

interface Failure {
  reason: CoverBackfillFailureReason;
  /** The link went stale on a platform whose links can be re-read, and has not been re-read yet. */
  refreshable: boolean;
}

interface Job {
  readonly id: string;
  readonly owner: string;
  readonly mode: Mode;
  state: State;
  /** The Content ids to process, ascending. */
  readonly items: readonly string[];
  /** Items handled so far; `items[index]` is next. */
  index: number;
  saved: number;
  skipped: number;
  readonly failures: Map<string, Failure>;
  /** Items skipped because their platform refused an earlier one: `retry` takes them up too. */
  readonly blockedSkips: Set<string>;
  /**
   * Where the next `stored` job continues: the last stored-mode item handled, else where this
   * job started. `retry` and `refresh` jobs carry their predecessor's.
   */
  cursor: string | undefined;
  /** The user's stop: the current item finishes, nothing new starts. */
  readonly stop: AbortController;
  /** Deleting the user or shutting down: the current item is abandoned too. */
  readonly hard: AbortController;
  done: Promise<void>;
}

export interface CoverBackfillServiceOptions {
  repository: Repository;
  covers: Pick<ContentCoverService, "backfillOne">;
  /** The data directory's volume; its low-water mark already counts the database and its WAL. */
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  logger?: Logger;
  newId?: () => string;
  /** Waits between items; tests pass a fake. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function noSuchJob(): never {
  throw amberError("not_found", "no such cover backfill job");
}

function active(): Error {
  return amberError("conflict", "a cover backfill job is still running", { code: "conflict.cover_backfill_active" });
}

function finished(state: State): boolean {
  return state !== "running" && state !== "stopping";
}

/**
 * Saving the covers of existing Contents on the user's explicit request (`/api/covers/backfill`).
 * Jobs live in memory, one per user: its result stays until the user closes it, starts another
 * job, or the process restarts. Every operation checks the job belongs to the caller; another
 * user's job id is unknown.
 *
 * A `stored` job takes the user's candidates (outside the trash, from a platform, with a cover
 * URL and no copy) in ascending Content id after `afterId`, at most `COVER_BACKFILL_MAX_ITEMS`,
 * and records where it got to, so the next job continues there and its failures are not met
 * again. `retry` takes up the previous job's temporary failures; `refresh` its stale links on
 * platforms that can re-read them, re-reading first. Items run one at a time, each re-checked
 * first; downloads are spaced `COVER_BACKFILL_INTERVAL_MS` apart (refreshes are paced by their
 * own per-minute budget instead). A platform that refuses one item has its remaining items
 * skipped. Before each item the data directory's low-water mark is checked; below it the job
 * ends as `aborted_disk`, its remaining items untouched.
 */
export class CoverBackfillService {
  private readonly options: CoverBackfillServiceOptions;
  private readonly jobs = new Map<string, Job>();
  private readonly newId: () => string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: CoverBackfillServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
    this.sleep = options.sleep ?? abortableSleep;
  }

  status(principal: RequestPrincipal): CoverBackfillStatusDto {
    const owner = principal.userId;
    const job = this.jobs.get(owner);
    return this.options.repository.withTransaction((scope) => {
      const candidates = scope.contentCovers.countBackfillCandidates(owner);
      return { candidates, ...(job === undefined ? {} : { job: this.dto(job, scope.contentCovers.countBackfillCandidates(owner, job.cursor)) }) };
    });
  }

  start(principal: RequestPrincipal, request: CoverBackfillStartRequest): CoverBackfillStatusDto {
    const owner = principal.userId;
    const previous = this.jobs.get(owner);
    if (previous !== undefined && !finished(previous.state)) {
      throw active();
    }
    let items: string[];
    let cursor: string | undefined;
    if (request.mode === "stored") {
      cursor = request.afterId;
      items = this.options.repository.withTransaction((scope) => scope.contentCovers.listBackfillCandidates(owner, request.afterId, COVER_BACKFILL_MAX_ITEMS));
    } else {
      if (request.jobId === undefined) {
        throw amberError("invalid_request", "retry and refresh name the job they continue", { params: { detail: "jobId" } });
      }
      if (previous === undefined || previous.id !== request.jobId) {
        noSuchJob();
      }
      cursor = previous.cursor;
      items = request.mode === "retry" ? retryItems(previous) : refreshItems(previous);
    }
    const job: Job = {
      id: this.newId(),
      owner,
      mode: request.mode,
      state: "running",
      items,
      index: 0,
      saved: 0,
      skipped: 0,
      failures: new Map(),
      blockedSkips: new Set(),
      cursor,
      stop: new AbortController(),
      hard: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(owner, job);
    job.done = this.run(job);
    return this.status(principal);
  }

  /** Stops the caller's job after its current item; already ending or ended: unchanged. */
  cancel(principal: RequestPrincipal, jobId: string): CoverBackfillStatusDto {
    const job = this.ownJob(principal, jobId);
    if (job.state === "running") {
      job.state = "stopping";
      job.stop.abort(new Error("stopped by the user"));
    }
    return this.status(principal);
  }

  /** Closes the caller's finished job and its result; a running one cannot be closed. */
  remove(principal: RequestPrincipal, jobId: string): CoverBackfillStatusDto {
    const job = this.ownJob(principal, jobId);
    if (!finished(job.state)) {
      throw active();
    }
    this.jobs.delete(principal.userId);
    return this.status(principal);
  }

  /** For deleting a user: abandons their job, current item included, and forgets it. */
  async discardOwner(ownerUserId: string): Promise<void> {
    const job = this.jobs.get(ownerUserId);
    if (job === undefined) {
      return;
    }
    this.jobs.delete(ownerUserId);
    job.hard.abort(new Error("the user is being deleted"));
    job.stop.abort(new Error("the user is being deleted"));
    await job.done;
  }

  /** Shutdown: abandons every job and waits for their loops to end. */
  async stop(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((owner) => this.discardOwner(owner)));
  }

  private ownJob(principal: RequestPrincipal, jobId: string): Job {
    const job = this.jobs.get(principal.userId);
    return job !== undefined && job.id === jobId ? job : noSuchJob();
  }

  private async run(job: Job): Promise<void> {
    const blocked = new Set<Platform>();
    const halted = AbortSignal.any([job.stop.signal, job.hard.signal]);
    try {
      while (job.index < job.items.length && !halted.aborted) {
        if ((await diskLowError(this.options.disk, this.options.settings.effective())) !== undefined) {
          job.state = "aborted_disk";
          return;
        }
        if (halted.aborted) {
          break;
        }
        const contentId = job.items[job.index] as string;
        const result = await this.options.covers.backfillOne(job.owner, contentId, { refresh: job.mode === "refresh", blocked, stop: job.stop.signal }, job.hard.signal);
        if (result.outcome === "interrupted") {
          break;
        }
        job.index += 1;
        if (job.mode === "stored") {
          job.cursor = contentId;
        }
        if (this.tally(job, contentId, result, blocked) === "disk_low") {
          job.state = "aborted_disk";
          return;
        }
        if (result.downloaded && job.mode !== "refresh" && job.index < job.items.length) {
          try {
            await this.sleep(COVER_BACKFILL_INTERVAL_MS, halted);
          } catch {
            break;
          }
        }
      }
      job.state = job.index < job.items.length ? "stopped" : "completed";
    } catch (error) {
      // Only the user's deletion or a shutdown gets here mid-item; anything else is logged and
      // the job ends where it is, its result kept.
      if (!job.hard.signal.aborted) {
        this.options.logger?.warn("cover_backfill_failed", { jobId: job.id, message: error instanceof Error ? error.name : "unknown" });
      }
      job.state = "stopped";
    }
  }

  /** Counts one handled item; answers the failure group when it failed. */
  private tally(job: Job, contentId: string, result: CoverBackfillItemResult, blocked: Set<Platform>): CoverBackfillFailureReason | undefined {
    switch (result.outcome) {
      case "saved":
        job.saved += 1;
        return undefined;
      case "skipped":
        job.skipped += 1;
        if (result.blocked === true) {
          job.blockedSkips.add(contentId);
        }
        return undefined;
      case "interrupted":
        return undefined;
      case "failed": {
        const reason = coverBackfillFailureReason(result.error, result.staleLink);
        job.failures.set(contentId, { reason, refreshable: reason === "link_expired" && result.refreshable });
        if (isAmberError(result.error) && result.error.appError.class === "platform_blocked") {
          blocked.add(result.platform);
        }
        return reason;
      }
    }
  }

  private dto(job: Job, remaining: number): CoverBackfillJobDto {
    const failed: Partial<Record<CoverBackfillFailureReason, number>> = {};
    for (const reason of COVER_BACKFILL_FAILURE_REASONS) {
      const count = [...job.failures.values()].filter((failure) => failure.reason === reason).length;
      if (count > 0) {
        failed[reason] = count;
      }
    }
    return {
      id: job.id,
      mode: job.mode,
      state: job.state,
      total: job.items.length,
      processed: job.index,
      saved: job.saved,
      skipped: job.skipped,
      failed,
      retryable: retryItems(job).length,
      refreshable: refreshItems(job).length,
      remaining,
      ...(job.cursor === undefined ? {} : { nextAfterId: job.cursor }),
    };
  }
}

/** Items still to do when the job is itself a `mode` job that did not get through them. */
function unprocessed(job: Job, mode: Mode): string[] {
  return job.mode === mode && finished(job.state) ? job.items.slice(job.index) : [];
}

/** What `retry` of `job` takes up: its temporary failures and the items its refused platforms left. */
function retryItems(job: Job): string[] {
  const failed = [...job.failures].filter(([, failure]) => TEMPORARY.has(failure.reason)).map(([id]) => id);
  return sorted([...failed, ...job.blockedSkips, ...unprocessed(job, "retry")]);
}

/** What `refresh` of `job` takes up: its stale links that can be re-read. */
function refreshItems(job: Job): string[] {
  const stale = [...job.failures].filter(([, failure]) => failure.refreshable).map(([id]) => id);
  return sorted([...stale, ...unprocessed(job, "refresh")]);
}

function sorted(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
