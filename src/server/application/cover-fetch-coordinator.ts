import { COVER_DOWNLOAD_MAX_BYTES, COVER_FETCH_CONCURRENCY, COVER_FETCH_TIMEOUT_MS, COVER_FETCH_USER_CONCURRENCY } from "../../shared/defaults.ts";
import { amberError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import { FairSemaphore, type FairGroupRef } from "../pipeline/fair-semaphore.ts";
import type { PlatformAccess } from "../pipeline/stages/platform-access.ts";
import type { FigureImage, FigureImageProcessor, ImageLimits } from "./figure-images.ts";

/**
 * Settles with `signal`'s reason as soon as it aborts, else as `promise` does. `promise` always
 * gets a handler, so a rejection after the abort is never unhandled.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The user's cover slots are taken, or a per-minute limit is reached (then with the wait). */
export function coverFetchBusy(retryAfterMs?: number): Error {
  return amberError("conflict", "cover download slots or request budget exhausted", {
    code: "conflict.cover_fetch_busy",
    ...(retryAfterMs === undefined ? {} : { details: { retryAfterMs } }),
  });
}

function timedOut(): Error {
  return amberError("source_unreachable", "the cover did not arrive in time");
}

/**
 * Counting slots per user with a first-come queue. `tryAcquire` never waits (a manual fetch
 * answers busy at once); `acquire` waits its turn until its signal aborts.
 */
class UserSlots {
  private readonly held = new Map<string, number>();
  private readonly queues = new Map<string, Array<(release: () => void) => void>>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  inUse(owner: string): number {
    return this.held.get(owner) ?? 0;
  }

  tryAcquire(owner: string): (() => void) | undefined {
    if (this.inUse(owner) >= this.limit || (this.queues.get(owner)?.length ?? 0) > 0) {
      return undefined;
    }
    return this.take(owner);
  }

  acquire(owner: string, signal: AbortSignal): Promise<() => void> {
    const now = this.tryAcquire(owner);
    if (now !== undefined) {
      return Promise.resolve(now);
    }
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const queue = this.queues.get(owner) ?? [];
      const grant = (release: () => void): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = (): void => {
        const index = queue.indexOf(grant);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        if (queue.length === 0) {
          this.queues.delete(owner);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(grant);
      this.queues.set(owner, queue);
    });
  }

  private take(owner: string): () => void {
    this.held.set(owner, this.inUse(owner) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const left = this.inUse(owner) - 1;
      if (left === 0) {
        this.held.delete(owner);
      } else {
        this.held.set(owner, left);
      }
      const queue = this.queues.get(owner);
      const next = queue?.shift();
      if (queue !== undefined && queue.length === 0) {
        this.queues.delete(owner);
      }
      next?.(this.take(owner));
    };
  }
}

/** How a caller waits for the user's slots: `manual` is refused at once when they are taken, `queued` waits. */
export type CoverFetchPriority = "manual" | "queued";

export interface CoverDownloadRequest {
  ownerUserId: string;
  contentId: string;
  platform: Platform;
  coverUrl: string;
  priority: CoverFetchPriority;
  /** The caller's own signal: aborting it ends this caller's wait, not the shared download. */
  signal: AbortSignal;
  /** Bounds this caller's whole wait, queue included (a manual fetch); absent: only the download's own limit applies. */
  waitTimeoutMs?: number;
}

interface Execution {
  readonly promise: Promise<FigureImage>;
  /** Aborted once every caller has given up: the download, its queue places and its processing stop. */
  readonly controller: AbortController;
  /** Aborted when the download itself exceeds its time limit; callers stop waiting then. */
  readonly timeLimit: AbortController;
  /** `holdsUserSlot` is false while it still waits for one of the user's slots; `settled` once its work has ended. */
  readonly progress: { holdsUserSlot: boolean; settled: boolean };
  waiters: number;
}

export interface CoverFetchCoordinatorOptions {
  /** The platform adapters; a cover is fetched without any login. */
  platforms: Pick<PlatformAccess, "adapterFor">;
  /** The process's one image processor, shared with figures so both count against one decoding limit. */
  images: Pick<FigureImageProcessor, "normalizeFetched">;
  /** How a fetched image is re-encoded. */
  limits: ImageLimits;
  /** The instance-wide gate over cover downloads; a fair semaphore of `COVER_FETCH_CONCURRENCY` by default. */
  globalSlots?: Pick<FairSemaphore, "acquire">;
  /** Per-user slots; `COVER_FETCH_USER_CONCURRENCY` by default. */
  userConcurrency?: number;
  /** Download plus processing of one cover; `COVER_FETCH_TIMEOUT_MS` by default. */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The one gate every cover download passes: the `source` stage's save, the user's manual
 * fetch and the backfill. Two lifecycles are kept apart. A caller's wait is bound to its own
 * signal; the shared execution (download, decoding, removal of the scratch directory) runs on
 * its own controller and is cancelled only once every caller has given up. Slots are released
 * in the execution's own `finally`, when the underlying work has really ended, never because a
 * caller stopped waiting: a download that is still running keeps counting against the limits.
 *
 * Callers asking for the same user, Content and cover URL at once share one execution and its
 * result; each writes the result under its own conditions.
 *
 * Slots: first one of the user's `COVER_FETCH_USER_CONCURRENCY` (a manual fetch that finds
 * them taken is refused with `conflict.cover_fetch_busy`; the others queue), then one of the
 * instance's fair `COVER_FETCH_CONCURRENCY`, grouped by user. Covers never take a managed
 * heavy-job slot.
 */
export class CoverFetchCoordinator {
  private readonly options: CoverFetchCoordinatorOptions;
  private readonly executions = new Map<string, Execution>();
  private readonly userSlots: UserSlots;
  private readonly globalSlots: Pick<FairSemaphore, "acquire">;
  private readonly now: () => number;

  constructor(options: CoverFetchCoordinatorOptions) {
    this.options = options;
    this.userSlots = new UserSlots(options.userConcurrency ?? COVER_FETCH_USER_CONCURRENCY);
    this.globalSlots = options.globalSlots ?? new FairSemaphore(() => COVER_FETCH_CONCURRENCY);
    this.now = options.now ?? Date.now;
  }

  /** Slots of `owner` held by executions whose work has not ended yet. */
  userSlotsInUse(owner: string): number {
    return this.userSlots.inUse(owner);
  }

  /**
   * Waits for the cover at `coverUrl`, joining a running execution for the same key. Rejects
   * with the caller's abort reason when its signal aborts, `source_unreachable` when its wait
   * bound or the download's time limit passes first, and otherwise as the download does.
   */
  download(request: CoverDownloadRequest): Promise<FigureImage> {
    if (request.signal.aborted) {
      return Promise.reject(request.signal.reason);
    }
    const key = `${request.ownerUserId}\u0000${request.contentId}\u0000${request.coverUrl}`;
    let execution = this.executions.get(key);
    if (execution !== undefined && !execution.progress.holdsUserSlot && request.priority === "manual") {
      // It is still queued for one of the user's slots, so none is free for this caller either.
      return Promise.reject(coverFetchBusy());
    }
    if (execution === undefined) {
      // Taken now when free, so the execution counts as holding it before anything awaits.
      const release = this.userSlots.tryAcquire(request.ownerUserId);
      if (release === undefined && request.priority === "manual") {
        return Promise.reject(coverFetchBusy());
      }
      execution = this.start(key, request, release);
    }
    return this.wait(key, execution, request);
  }

  private start(key: string, request: CoverDownloadRequest, userRelease: (() => void) | undefined): Execution {
    const controller = new AbortController();
    const timeLimit = new AbortController();
    const progress = { holdsUserSlot: userRelease !== undefined, settled: false };
    const owner = request.ownerUserId;
    const run = async (): Promise<FigureImage> => {
      const releaseUser = userRelease ?? (await this.userSlots.acquire(owner, controller.signal));
      progress.holdsUserSlot = true;
      try {
        const group: FairGroupRef = { key: `cover:${owner}`, createdAt: this.now() };
        const releaseGlobal = await this.globalSlots.acquire(group, controller.signal);
        const timer = setTimeout(() => timeLimit.abort(timedOut()), this.options.timeoutMs ?? COVER_FETCH_TIMEOUT_MS);
        try {
          return await this.fetchAndNormalize(request, AbortSignal.any([controller.signal, timeLimit.signal]));
        } finally {
          clearTimeout(timer);
          releaseGlobal();
        }
      } finally {
        releaseUser();
      }
    };
    const promise = run().finally(() => {
      progress.settled = true;
      if (this.executions.get(key) === execution) {
        this.executions.delete(key);
      }
    });
    // Callers hold their own handlers; this one only keeps an abandoned execution's failure from going unhandled.
    promise.catch(() => undefined);
    const execution: Execution = { promise, controller, timeLimit, progress, waiters: 0 };
    this.executions.set(key, execution);
    return execution;
  }

  private async wait(key: string, execution: Execution, request: CoverDownloadRequest): Promise<FigureImage> {
    execution.waiters += 1;
    const bound = new AbortController();
    const timer = request.waitTimeoutMs === undefined ? undefined : setTimeout(() => bound.abort(timedOut()), request.waitTimeoutMs);
    try {
      return await untilAborted(execution.promise, AbortSignal.any([request.signal, bound.signal, execution.timeLimit.signal]));
    } catch (error) {
      if (request.signal.aborted) {
        throw request.signal.reason;
      }
      if (bound.signal.aborted || execution.timeLimit.signal.aborted) {
        throw timedOut();
      }
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      execution.waiters -= 1;
      if (execution.waiters === 0 && !execution.progress.settled) {
        // Nobody waits any more: stop the work. It still holds its slots until it has really
        // ended; later callers start afresh.
        if (this.executions.get(key) === execution) {
          this.executions.delete(key);
        }
        execution.controller.abort(new Error("every caller gave up on this cover"));
      }
    }
  }

  /**
   * Fetches and normalizes one cover. The adapter checks the URL against its platform's image
   * hosts before any request; a platform without covers fails like an unreachable platform.
   */
  private fetchAndNormalize(request: CoverDownloadRequest, signal: AbortSignal): Promise<FigureImage> {
    const adapter = this.options.platforms.adapterFor(request.platform);
    const fetchCover = adapter.fetchCover?.bind(adapter);
    if (fetchCover === undefined) {
      return Promise.reject(amberError("source_unreachable", "the platform adapter cannot fetch covers"));
    }
    return this.options.images.normalizeFetched(
      request.ownerUserId,
      (input) => fetchCover(request.coverUrl, input, { maxBytes: COVER_DOWNLOAD_MAX_BYTES }, signal),
      this.options.limits,
      signal,
    );
  }
}

/** One minute: the window of the per-minute request budgets. */
const MINUTE_MS = 60 * 1000;

/**
 * At most `perMinute` takes per key in any sliding minute. `tryTake` answers at once with the
 * wait until the next one would be allowed; `take` waits for it.
 */
export class PerMinuteLimiter {
  private readonly perMinute: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly taken = new Map<string, number[]>();

  constructor(perMinute: number, clock: { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
    this.perMinute = perMinute;
    this.now = clock.now ?? Date.now;
    this.sleep = clock.sleep ?? abortableSleep;
  }

  tryTake(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.taken.get(key) ?? []).filter((at) => at > now - MINUTE_MS);
    if (recent.length >= this.perMinute) {
      this.taken.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, (recent[0] as number) + MINUTE_MS - now) };
    }
    recent.push(now);
    this.taken.set(key, recent);
    return { ok: true };
  }

  async take(key: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const answer = this.tryTake(key);
      if (answer.ok) {
        return;
      }
      await this.sleep(answer.retryAfterMs, signal);
    }
  }
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
