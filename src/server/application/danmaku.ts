import { DANMAKU_FETCH_COOLDOWN_MS, DANMAKU_FETCH_TIMEOUT_MS } from "../../shared/defaults.ts";
import type { ContentDanmakuSummary, DanmakuFetchResultDto, DanmakuItem, DanmakuSnapshot, DanmakuSnapshotDto } from "../../shared/dto/danmaku.ts";
import type { AppError } from "../../shared/errors.ts";
import type { Content } from "../domain/content.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import { isPlatform } from "../domain/platform.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { PlatformContentRef, PlatformSourceAdapter } from "../ports/platform-source.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { PlatformRegistry } from "./platforms.ts";

export interface DanmakuServiceOptions {
  repository: Repository;
  platforms: Pick<PlatformRegistry, "all">;
  logger?: Logger;
  now?: () => number;
}

type FetchDanmaku = (ref: PlatformContentRef, signal: AbortSignal) => Promise<{ items: DanmakuItem[]; truncated: boolean }>;

/** Where a Content's danmaku come from: its platform's fetch and the exact part it names. */
interface DanmakuSource {
  fetch: FetchDanmaku;
  ref: PlatformContentRef & { platformPartId: string };
}

/**
 * A Content has danmaku when its platform's adapter offers `fetchDanmaku` and the Content
 * names one part of one platform video: a snapshot belongs to that part and to no other.
 */
function danmakuSource(platforms: Pick<PlatformRegistry, "all">, content: Content): DanmakuSource | undefined {
  const { kind, platformContentId, platformPartId } = content.source;
  if (!isPlatform(kind) || platformContentId === undefined || platformPartId === undefined) {
    return undefined;
  }
  const adapter: PlatformSourceAdapter | undefined = platforms.all.find((candidate) => candidate.kind === kind);
  if (adapter?.fetchDanmaku === undefined) {
    return undefined;
  }
  return { fetch: adapter.fetchDanmaku.bind(adapter), ref: { platformContentId, platformPartId } };
}

function sameSource(a: DanmakuSource, b: DanmakuSource): boolean {
  return a.ref.platformContentId === b.ref.platformContentId && a.ref.platformPartId === b.ref.platformPartId;
}

/** The stored snapshot when it was fetched for the part the Content names now; one of an earlier part is never shown. */
function visibleSnapshot(scope: RepositoryScope, owner: string, contentId: string, source: DanmakuSource): DanmakuSnapshot | undefined {
  const record = scope.danmaku.get(owner, contentId);
  if (record === undefined || record.platformPartId !== source.ref.platformPartId) {
    return undefined;
  }
  return { fetchedAt: record.fetchedAt, count: record.items.length, items: record.items };
}

/**
 * The danmaku part of a Content's detail, read in the caller's transaction without the
 * items: absent when the Content has no danmaku; `{}` until a snapshot of its current part
 * exists, then when it was fetched and how many items it holds.
 */
export function danmakuSummaryIn(platforms: Pick<PlatformRegistry, "all">, scope: RepositoryScope, owner: string, content: Content): ContentDanmakuSummary | undefined {
  const source = danmakuSource(platforms, content);
  if (source === undefined) {
    return undefined;
  }
  const summary = scope.danmaku.summary(owner, content.id);
  return summary === undefined || summary.platformPartId !== source.ref.platformPartId ? {} : { fetchedAt: summary.fetchedAt, count: summary.count };
}

/**
 * Settles with `signal`'s reason as soon as it aborts, else as `promise` does. `promise`
 * always gets a handler, so a rejection after the abort is never unhandled.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** A danmaku request never uses a login, so an action leading to one (log in to the platform) would mislead. */
function withoutAction(error: AppError): AppError {
  const copy = { ...error };
  delete copy.action;
  return copy;
}

/**
 * Danmaku snapshots of platform videos: read, and fetch on the user's request only. A fetch
 * is one anonymous request; it is never retried, never repeated with a login, and never
 * started by reading.
 */
export class DanmakuService {
  private readonly options: DanmakuServiceOptions;
  private readonly now: () => number;
  /**
   * The fetch in flight per owner and Content: a second click or window joins it rather
   * than sending another request. The entry goes when the fetch settles.
   */
  private readonly executions = new Map<string, Promise<DanmakuFetchResultDto>>();
  /** When the last request per owner and Content was sent; entries older than the cooldown are pruned. */
  private readonly lastSent = new Map<string, number>();

  constructor(options: DanmakuServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Whether the Content has danmaku, and the snapshot of its current part if one was fetched. */
  get(principal: RequestPrincipal, contentId: string): DanmakuSnapshotDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = this.content(scope, owner, contentId);
      const source = danmakuSource(this.options.platforms, content);
      if (source === undefined) {
        return { supported: false };
      }
      const snapshot = visibleSnapshot(scope, owner, contentId, source);
      return { supported: true, ...(snapshot === undefined ? {} : { snapshot }) };
    });
  }

  /** The detail's danmaku summary of `content`, in the caller's transaction. */
  summaryIn(scope: RepositoryScope, owner: string, content: Content): ContentDanmakuSummary | undefined {
    return danmakuSummaryIn(this.options.platforms, scope, owner, content);
  }

  /**
   * Fetches the Content's danmaku once. `fetched` and `empty` replace the snapshot whole;
   * `failed` keeps the previous one and carries the error. A request for the same Content
   * while one is in flight joins it; a new one within `DANMAKU_FETCH_COOLDOWN_MS` of the last
   * sent is `rate_limited.danmaku_cooldown` and sends nothing. `signal` is this caller's:
   * when it aborts, the caller stops waiting, but the request goes on and its answer is
   * still stored.
   */
  async fetch(principal: RequestPrincipal, contentId: string, signal?: AbortSignal): Promise<DanmakuFetchResultDto> {
    signal?.throwIfAborted();
    const owner = principal.userId;
    // Checked for every caller, also one that joins a fetch in flight; no transaction is held while waiting.
    const source = this.options.repository.withTransaction((scope) => {
      const found = danmakuSource(this.options.platforms, this.content(scope, owner, contentId));
      if (found === undefined) {
        throw amberError("invalid_request", "the content's platform offers no danmaku", { code: "invalid_request.danmaku_unsupported" });
      }
      return found;
    });
    const key = JSON.stringify([owner, contentId]);
    let execution = this.executions.get(key);
    if (execution === undefined) {
      this.admit(key);
      const started = this.execute(owner, contentId, source);
      const forget = (): void => {
        if (this.executions.get(key) === started) {
          this.executions.delete(key);
        }
      };
      started.then(forget, forget);
      this.executions.set(key, started);
      execution = started;
    }
    return signal === undefined ? execution : untilAborted(execution, signal);
  }

  private content(scope: RepositoryScope, owner: string, contentId: string): Content {
    const content = scope.contents.get(owner, contentId);
    if (content === undefined) {
      throw amberError("not_found", "content not found");
    }
    return content;
  }

  /** Records a request about to be sent, or refuses it while the last one is too recent. */
  private admit(key: string): void {
    const now = this.now();
    for (const [other, sentAt] of this.lastSent) {
      if (now - sentAt >= DANMAKU_FETCH_COOLDOWN_MS) {
        this.lastSent.delete(other);
      }
    }
    const last = this.lastSent.get(key);
    if (last !== undefined) {
      throw amberError("rate_limited", "danmaku requested too recently", {
        code: "rate_limited.danmaku_cooldown",
        details: { retryAfterMs: Math.max(1, last + DANMAKU_FETCH_COOLDOWN_MS - now) },
      });
    }
    this.lastSent.set(key, now);
  }

  /**
   * One shared request under its own `DANMAKU_FETCH_TIMEOUT_MS` deadline, covering the whole
   * body; no caller's disconnect reaches it. A Content gone or trashed by the time the answer
   * arrives is `not_found` and nothing is written.
   */
  private async execute(owner: string, contentId: string, source: DanmakuSource): Promise<DanmakuFetchResultDto> {
    const sentAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DANMAKU_FETCH_TIMEOUT_MS);
    let answer: { items: DanmakuItem[]; truncated: boolean };
    try {
      answer = await untilAborted(source.fetch(source.ref, controller.signal), controller.signal);
    } catch (error) {
      const reason = controller.signal.aborted ? amberError("source_unreachable", "the danmaku request timed out").appError : this.errorOf(error);
      this.options.logger?.warn("danmaku_fetch_failed", { contentId, code: reason.code });
      return this.failed(owner, contentId, reason);
    } finally {
      clearTimeout(timer);
    }
    return this.options.repository.withTransaction((scope) => {
      const current = danmakuSource(this.options.platforms, this.content(scope, owner, contentId));
      if (current === undefined || !sameSource(current, source)) {
        // The Content now names another video or part: this answer belongs to neither.
        const snapshot = current === undefined ? undefined : visibleSnapshot(scope, owner, contentId, current);
        const moved = amberError("conflict", "the content's platform part changed during the danmaku request").appError;
        return { result: "failed" as const, error: moved, ...(snapshot === undefined ? {} : { snapshot }) };
      }
      scope.danmaku.put(owner, { contentId, platformPartId: source.ref.platformPartId, fetchedAt: sentAt, items: answer.items });
      return {
        result: answer.items.length === 0 ? "empty" : "fetched",
        snapshot: { fetchedAt: sentAt, count: answer.items.length, items: answer.items },
        ...(answer.truncated ? { truncated: true as const } : {}),
      };
    });
  }

  private errorOf(error: unknown): AppError {
    if (isAmberError(error)) {
      return withoutAction(error.appError);
    }
    this.options.logger?.error("danmaku_fetch_error", { error: error instanceof Error ? error.name : typeof error });
    return amberError("internal", "danmaku fetch failed unexpectedly").appError;
  }

  /** The answer to a request that brought nothing usable: the previous snapshot stays as it was. */
  private failed(owner: string, contentId: string, error: AppError): DanmakuFetchResultDto {
    return this.options.repository.withTransaction((scope) => {
      const current = danmakuSource(this.options.platforms, this.content(scope, owner, contentId));
      const snapshot = current === undefined ? undefined : visibleSnapshot(scope, owner, contentId, current);
      return { result: "failed", error, ...(snapshot === undefined ? {} : { snapshot }) };
    });
  }
}
