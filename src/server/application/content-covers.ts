import {
  COVER_FETCH_TIMEOUT_MS,
  COVER_FETCH_USER_PER_MIN,
  COVER_IMAGE_MAX_BYTES,
  COVER_LONG_EDGE_MAX_PX,
  COVER_REFRESH_USER_PER_MIN,
  PLATFORM_METADATA_TIMEOUT_MS,
} from "../../shared/defaults.ts";
import type { ContentDetailDto } from "../../shared/dto/content.ts";
import type { Content } from "../domain/content.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import { isPlatform, type Platform } from "../domain/platform.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { ContentCoverExpectation, ContentCoverImage, Repository } from "../ports/repository.ts";
import { upstreamHttpStatusOf } from "../ports/upstream-status.ts";
import type { FairGroupRef } from "../pipeline/fair-semaphore.ts";
import { platformTarget, type PlatformAccess } from "../pipeline/stages/platform-access.ts";
import type { SourceCoverSaver } from "../pipeline/stages/source-cover.ts";
import type { ContentService } from "./contents.ts";
import { abortableSleep, CoverFetchCoordinator, coverFetchBusy, PerMinuteLimiter, untilAborted, type CoverFetchPriority } from "./cover-fetch-coordinator.ts";
import type { FigureImage, FigureImageProcessor, ImageLimits } from "./figure-images.ts";

/** A stored cover: a WebP of at most this edge and size, whatever the platform served. */
export const COVER_LIMITS: ImageLimits = { maxLongEdge: COVER_LONG_EDGE_MAX_PX, maxBytes: COVER_IMAGE_MAX_BYTES };

/** Image host answers that mean the stored link no longer leads to the image. */
const STALE_LINK_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

/** Whether a cover download failed because the image host no longer serves that link. */
export function isStaleCoverLink(error: unknown): boolean {
  const status = upstreamHttpStatusOf(error);
  return status !== undefined && STALE_LINK_STATUSES.has(status);
}

export interface ContentCoverServiceOptions {
  repository: Repository;
  /** The platform adapters and logins; a cover image is fetched without any login, a link refresh reads the platform as metadata reads do. */
  platforms: PlatformAccess;
  /** The process's one image processor, shared with figures so both count against one decoding limit. */
  images: Pick<FigureImageProcessor, "normalizeFetched">;
  /** Builds the answer's Content exactly as the detail endpoint does. */
  details: Pick<ContentService, "detailIn">;
  /**
   * The one cover download gate of the process, shared by every path that downloads covers.
   * Built from `platforms`, `images` and `timeoutMs` when absent.
   */
  coordinator?: CoverFetchCoordinator;
  /** The managed heavy-job governor: a link refresh reads the platform like a metadata read. */
  heavy?: { run<T>(ref: FairGroupRef, signal: AbortSignal, work: () => Promise<T>): Promise<T> };
  logger?: Logger;
  now?: () => number;
  /** Waits for a per-minute budget; tests pass a fake. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Download plus processing of one cover, and a manual fetch's whole wait; `COVER_FETCH_TIMEOUT_MS` by default. */
  timeoutMs?: number;
  /** A link refresh's platform read, slot wait included; `PLATFORM_METADATA_TIMEOUT_MS` by default. */
  refreshTimeoutMs?: number;
  /**
   * False until the start-up sweep has run. It empties the scratch area image jobs work in, so a
   * manual fetch waits for it (`conflict.starting_up`). Absent means ready.
   */
  backgroundReady?: () => boolean;
}

/** `POST /api/contents/:id/cover/fetch` answers with the Content as it now stands. */
export interface CoverFetchResult {
  content: ContentDetailDto;
}

/** What one backfill item came to; a failure carries what grouping and later modes need. */
export type CoverBackfillItemResult =
  | { outcome: "saved"; downloaded: true }
  | { outcome: "skipped"; downloaded: boolean; platform?: Platform; blocked?: true }
  /** Stopped while waiting for the link-refresh budget, before anything was requested: still to do. */
  | { outcome: "interrupted"; downloaded: false }
  | { outcome: "failed"; downloaded: true; platform: Platform; error: unknown; staleLink: boolean; refreshable: boolean };

function notFound(): never {
  throw amberError("not_found", "content not found");
}

/**
 * Local copies of platform covers. The platform's image is downloaded through the Content's
 * adapter (trusted image hosts only, no login), decoded and re-encoded by the shared image
 * processor, and stored with its version in one transaction; the platform's file is never
 * kept. Every download goes through the cover download coordinator: the `source` stage's save
 * (`saveIfAbsent`, never throwing), the user's explicit fetch (`fetch`) and the backfill
 * (`backfillOne`).
 *
 * Every write is conditional: the Content must still be the owner's and outside the trash,
 * the caller must not have given up, and its cover URL and version must be what the download
 * started from (paths that only fill a missing cover require there still to be none). When
 * they are not, an identical image already stored counts as success without a new version;
 * anything else is dropped and the current cover stands. A failed download never removes a
 * stored copy.
 *
 * A stored link whose image host answers 403 / 404 / 410 can be re-read from the platform,
 * where its adapter implements `refreshCoverUrl`: at most `COVER_REFRESH_USER_PER_MIN` per
 * user and minute across manual fetches and the backfill, one read per user and Content at a
 * time, through the managed heavy-job governor. The read and the following download run one
 * after the other, never holding both kinds of slot at once.
 */
export class ContentCoverService implements SourceCoverSaver {
  private readonly options: ContentCoverServiceOptions;
  private readonly now: () => number;
  private readonly coordinator: CoverFetchCoordinator;
  private readonly manualBudget: PerMinuteLimiter;
  private readonly refreshBudget: PerMinuteLimiter;
  private readonly refreshes = new Map<string, { promise: Promise<string | undefined>; controller: AbortController; waiters: number }>();

  constructor(options: ContentCoverServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.coordinator =
      options.coordinator ??
      new CoverFetchCoordinator({
        platforms: options.platforms,
        images: options.images,
        limits: COVER_LIMITS,
        now: this.now,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    const clock = { now: this.now, sleep: options.sleep ?? abortableSleep };
    this.manualBudget = new PerMinuteLimiter(COVER_FETCH_USER_PER_MIN, clock);
    this.refreshBudget = new PerMinuteLimiter(COVER_REFRESH_USER_PER_MIN, clock);
  }

  async saveIfAbsent(ownerUserId: string, contentId: string, coverUrl: string, signal: AbortSignal): Promise<void> {
    try {
      const content = this.options.repository.withTransaction((scope) =>
        scope.contentCovers.get(ownerUserId, contentId) === undefined ? scope.contents.get(ownerUserId, contentId) : undefined,
      );
      // Gone, in the trash, or already holding a copy: nothing to fetch.
      if (content === undefined || !isPlatform(content.source.kind)) {
        return;
      }
      const image = await this.download(content, coverUrl, "queued", signal, true);
      // The stage stores the new cover URL only when it publishes, after this: the URL is not
      // compared, only that there is still no copy.
      const result = this.write(ownerUserId, contentId, image, { version: undefined }, signal);
      if (result.outcome !== "written") {
        this.options.logger?.debug("cover_already_present", { contentId, outcome: result.outcome });
      }
    } catch (error) {
      // The cover is a nicety: whatever went wrong, the caller carries on. The URL is not
      // logged; some platforms put access parameters in it.
      this.options.logger?.warn("cover_save_failed", { contentId, ...failureFields(error) });
    }
  }

  /**
   * Downloads the cover at the Content's current `coverUrl` again and replaces the local copy,
   * raising its version. Only platform Contents have one (`invalid_request` otherwise). At most
   * `COVER_FETCH_USER_PER_MIN` per user and minute, and only while one of the user's cover
   * slots is free (`conflict.cover_fetch_busy` otherwise). A link the image host no longer
   * serves is re-read from the platform once where the adapter can. Any failure is thrown as it
   * came with the stored copy untouched; a result overtaken by a newer cover is dropped and the
   * Content answered as it stands.
   */
  async fetch(principal: RequestPrincipal, contentId: string, signal: AbortSignal): Promise<CoverFetchResult> {
    const owner = principal.userId;
    // Ownership first: another user's id, or one in the trash, is `not_found` whatever the
    // process is doing, so the answer never depends on start-up.
    const content = this.options.repository.withTransaction((scope) => scope.contents.get(owner, contentId)) ?? notFound();
    if (this.options.backgroundReady?.() === false) {
      throw amberError("conflict", "start-up sweep still running", { code: "conflict.starting_up" });
    }
    if (!isPlatform(content.source.kind)) {
      throw amberError("invalid_request", "only platform contents have a platform cover", { params: { detail: "contentId" } });
    }
    if (content.coverUrl === undefined) {
      throw amberError("source_unreachable", "the platform gave no cover for this content");
    }
    const budget = this.manualBudget.tryTake(owner);
    if (!budget.ok) {
      throw coverFetchBusy(budget.retryAfterMs);
    }
    const version = content.coverImageVersion;
    let coverUrl = content.coverUrl;
    let image: FigureImage;
    try {
      image = await this.download(content, coverUrl, "manual", signal);
    } catch (error) {
      if (signal.aborted || !isStaleCoverLink(error) || !this.canRefresh(content.source.kind)) {
        throw error;
      }
      const fresh = await this.refreshedCoverUrl(content, coverUrl, "manual", signal);
      if (fresh === undefined || fresh === coverUrl) {
        throw error;
      }
      coverUrl = fresh;
      image = await this.download(content, coverUrl, "manual", signal);
    }
    const result = this.write(owner, contentId, image, { coverUrl, version }, signal);
    if (result.outcome === "gone") {
      notFound();
    }
    return this.options.repository.withTransaction((scope) => {
      const current = scope.contents.get(owner, contentId) ?? notFound();
      return { content: this.options.details.detailIn(scope, owner, current) };
    });
  }

  /** Whether covers of `platform` can be re-read from the platform once their link has gone stale. */
  canRefresh(platform: Platform): boolean {
    return typeof this.options.platforms.adapterFor(platform).refreshCoverUrl === "function";
  }

  /**
   * One backfill item: re-checks that the Content still wants a cover (the owner's, outside the
   * trash, from a platform, with a cover URL and no copy; `skipped` otherwise), skips platforms
   * in `blocked`, then downloads the stored link, or with `refresh` first re-reads the link
   * from the platform (waiting for the shared budget rather than failing on it; `stop` ends
   * that wait, leaving the item `interrupted`). Saving only fills a missing cover. Failures are
   * returned, not thrown, except the caller's own abort.
   */
  async backfillOne(
    ownerUserId: string,
    contentId: string,
    options: { refresh: boolean; blocked: ReadonlySet<Platform>; stop?: AbortSignal },
    signal: AbortSignal,
  ): Promise<CoverBackfillItemResult> {
    const content = this.options.repository.withTransaction((scope) => {
      const found = scope.contents.get(ownerUserId, contentId);
      return found !== undefined && found.coverImageVersion === undefined && scope.contentCovers.get(ownerUserId, contentId) === undefined ? found : undefined;
    });
    if (content === undefined || !isPlatform(content.source.kind) || content.coverUrl === undefined) {
      return { outcome: "skipped", downloaded: false };
    }
    const platform = content.source.kind;
    if (options.blocked.has(platform)) {
      return { outcome: "skipped", downloaded: false, platform, blocked: true };
    }
    let coverUrl = content.coverUrl;
    try {
      if (options.refresh) {
        if (!this.canRefresh(platform)) {
          return { outcome: "skipped", downloaded: false, platform };
        }
        const budgetWait = options.stop === undefined ? signal : AbortSignal.any([signal, options.stop]);
        try {
          await this.refreshBudget.take(ownerUserId, budgetWait);
        } catch (error) {
          if (!signal.aborted && options.stop?.aborted === true) {
            return { outcome: "interrupted", downloaded: false };
          }
          throw error;
        }
        const fresh = await this.refreshedCoverUrl(content, coverUrl, "budgeted", signal);
        if (fresh === undefined) {
          const still = this.options.repository.withTransaction((scope) => scope.contents.get(ownerUserId, contentId));
          return still === undefined
            ? { outcome: "skipped", downloaded: true, platform }
            : { outcome: "failed", downloaded: true, platform, error: amberError("source_unreachable", "the platform names no cover"), staleLink: true, refreshable: false };
        }
        coverUrl = fresh;
      }
      const image = await this.download(content, coverUrl, "queued", signal);
      const result = this.write(ownerUserId, contentId, image, { coverUrl, version: undefined }, signal);
      return result.outcome === "written" || result.outcome === "unchanged" ? { outcome: "saved", downloaded: true } : { outcome: "skipped", downloaded: true, platform };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const staleLink = isStaleCoverLink(error) || (isAmberError(error) && error.appError.code === "invalid_request.link_expired");
      // A link that went stale again right after a refresh is not offered for another one.
      const refreshable = !options.refresh && isStaleCoverLink(error) && this.canRefresh(platform);
      return { outcome: "failed", downloaded: true, platform, error, staleLink, refreshable };
    }
  }

  /** The cover of the principal's Content outside the trash; `not_found` when there is none. */
  cover(principal: RequestPrincipal, contentId: string): ContentCoverImage {
    return this.options.repository.withTransaction((scope) => scope.contentCovers.get(principal.userId, contentId)) ?? notFound();
  }

  /** The cover of the principal's Content in the trash; `not_found` when it is not there or has none. */
  trashedCover(principal: RequestPrincipal, contentId: string): ContentCoverImage {
    const owner = principal.userId;
    return (
      this.options.repository.withTransaction((scope) => {
        const content = scope.contents.getIncludingTrashed(owner, contentId);
        return content?.trashedAt === undefined ? undefined : scope.contentCovers.getIncludingTrashed(owner, contentId);
      }) ?? notFound()
    );
  }

  /** `bounded`: the caller's whole wait, queue included, stays within the cover time limit (a manual fetch, the `source` stage's save). */
  private download(content: Content, coverUrl: string, priority: CoverFetchPriority, signal: AbortSignal, bounded = priority === "manual"): Promise<FigureImage> {
    const platform = content.source.kind;
    if (!isPlatform(platform)) {
      return Promise.reject(amberError("invalid_request", "only platform contents have a platform cover", { params: { detail: "contentId" } }));
    }
    return this.coordinator.download({
      ownerUserId: content.userId,
      contentId: content.id,
      platform,
      coverUrl,
      priority,
      signal,
      // A manual fetch and the source stage's save wait within the limit, queue included, so a
      // busy backfill cannot hold a Task in its source stage; the backfill itself queues and is
      // bounded by the download's own limit once it starts.
      ...(bounded ? { waitTimeoutMs: this.options.timeoutMs ?? COVER_FETCH_TIMEOUT_MS } : {}),
    });
  }

  /** The conditional write; a caller that has given up writes nothing. */
  private write(owner: string, contentId: string, image: FigureImage, expected: ContentCoverExpectation, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.options.repository.withTransaction((scope) => scope.contentCovers.putIf(owner, contentId, image, this.now(), expected));
  }

  /**
   * Re-reads the Content's cover link from the platform and stores it while the Content still
   * has `staleUrl`; answers the link to download now (the stored one, which may have been
   * replaced meanwhile by someone else), or `undefined` when the platform names none. One read
   * per user and Content at a time, shared by its callers. A manual caller takes from the
   * per-minute budget here and is refused with the wait when it is spent; a `budgeted` caller
   * has already waited for its share.
   */
  private async refreshedCoverUrl(content: Content, staleUrl: string, budget: "manual" | "budgeted", signal: AbortSignal): Promise<string | undefined> {
    const owner = content.userId;
    const key = `${owner}\u0000${content.id}`;
    let refresh = this.refreshes.get(key);
    if (refresh === undefined) {
      if (budget === "manual") {
        const taken = this.refreshBudget.tryTake(owner);
        if (!taken.ok) {
          throw coverFetchBusy(taken.retryAfterMs);
        }
      }
      refresh = this.startRefresh(key, content, staleUrl);
    }
    refresh.waiters += 1;
    try {
      return await untilAborted(refresh.promise, signal);
    } finally {
      refresh.waiters -= 1;
      if (refresh.waiters === 0 && this.refreshes.get(key) === refresh) {
        this.refreshes.delete(key);
        refresh.controller.abort(new Error("every caller gave up on this refresh"));
      }
    }
  }

  private startRefresh(key: string, content: Content, staleUrl: string) {
    const controller = new AbortController();
    const owner = content.userId;
    const timeout = setTimeout(() => controller.abort(amberError("source_unreachable", "the cover link refresh timed out")), this.options.refreshTimeoutMs ?? PLATFORM_METADATA_TIMEOUT_MS);
    const read = async (): Promise<string | undefined> => {
      const fresh = await this.heavyJob(owner, controller.signal, async () => {
        // The login is read once the slot is granted, so one changed while waiting is used.
        const target = platformTarget(this.options.platforms, content);
        const refreshCoverUrl = target?.adapter.refreshCoverUrl?.bind(target.adapter);
        if (target === undefined || refreshCoverUrl === undefined) {
          return undefined;
        }
        return refreshCoverUrl(target.ref, target.auth, controller.signal);
      });
      controller.signal.throwIfAborted();
      if (fresh === undefined) {
        return undefined;
      }
      return this.options.repository.withTransaction((scope) => {
        scope.contentCovers.replaceCoverUrl(owner, content.id, staleUrl, fresh);
        return scope.contents.get(owner, content.id)?.coverUrl;
      });
    };
    const promise = untilAborted(read(), controller.signal).finally(() => {
      clearTimeout(timeout);
      if (this.refreshes.get(key) === entry) {
        this.refreshes.delete(key);
      }
    });
    promise.catch(() => undefined);
    const entry = { promise, controller, waiters: 0 };
    this.refreshes.set(key, entry);
    return entry;
  }

  private heavyJob<T>(owner: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const heavy = this.options.heavy;
    return heavy === undefined ? work() : heavy.run({ key: `foreground:${owner}`, createdAt: this.now() }, signal, work);
  }
}

function failureFields(error: unknown): Record<string, unknown> {
  if (isAmberError(error)) {
    return { errorClass: error.appError.class, errorCode: error.appError.code };
  }
  return { errorClass: "internal", message: error instanceof Error ? error.name : "unknown" };
}
