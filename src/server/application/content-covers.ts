import { COVER_FETCH_TIMEOUT_MS, COVER_FETCH_USER_PER_MIN, COVER_IMAGE_MAX_BYTES, COVER_LONG_EDGE_MAX_PX } from "../../shared/defaults.ts";
import type { ContentDetailDto } from "../../shared/dto/content.ts";
import type { Content } from "../domain/content.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import { isPlatform } from "../domain/platform.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { ContentCoverExpectation, ContentCoverImage, Repository } from "../ports/repository.ts";
import type { PlatformAccess } from "../pipeline/stages/platform-access.ts";
import type { SourceCoverSaver } from "../pipeline/stages/source-cover.ts";
import type { ContentService } from "./contents.ts";
import { abortableSleep, CoverFetchCoordinator, coverFetchBusy, PerMinuteLimiter, type CoverFetchPriority } from "./cover-fetch-coordinator.ts";
import type { FigureImage, FigureImageProcessor, ImageLimits } from "./figure-images.ts";

/** A stored cover: a WebP of at most this edge and size, whatever the platform served. */
export const COVER_LIMITS: ImageLimits = { maxLongEdge: COVER_LONG_EDGE_MAX_PX, maxBytes: COVER_IMAGE_MAX_BYTES };

export interface ContentCoverServiceOptions {
  repository: Repository;
  /** The platform adapters; a cover is fetched without any login. */
  platforms: Pick<PlatformAccess, "adapterFor">;
  /** The process's one image processor, shared with figures so both count against one decoding limit. */
  images: Pick<FigureImageProcessor, "normalizeFetched">;
  /** Builds the answer's Content exactly as the detail endpoint does. */
  details: Pick<ContentService, "detailIn">;
  /**
   * The one cover download gate of the process, shared by every path that downloads covers.
   * Built from `platforms`, `images` and `timeoutMs` when absent.
   */
  coordinator?: CoverFetchCoordinator;
  logger?: Logger;
  now?: () => number;
  /** Waits for a per-minute budget; tests pass a fake. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Download plus processing of one cover, and a manual fetch's whole wait; `COVER_FETCH_TIMEOUT_MS` by default. */
  timeoutMs?: number;
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

function notFound(): never {
  throw amberError("not_found", "content not found");
}

/**
 * Local copies of platform covers. The platform's image is downloaded through the Content's
 * adapter (trusted image hosts only, no login), decoded and re-encoded by the shared image
 * processor, and stored with its version in one transaction; the platform's file is never
 * kept. Every download goes through the cover download coordinator: the `source` stage's save
 * (`saveIfAbsent`, never throwing) and the user's explicit fetch (`fetch`).
 *
 * Every write is conditional: the Content must still be the owner's and outside the trash,
 * the caller must not have given up, and its cover URL and version must be what the download
 * started from (paths that only fill a missing cover require there still to be none). When
 * they are not, an identical image already stored counts as success without a new version;
 * anything else is dropped and the current cover stands. A failed download never removes a
 * stored copy.
 */
export class ContentCoverService implements SourceCoverSaver {
  private readonly options: ContentCoverServiceOptions;
  private readonly now: () => number;
  private readonly coordinator: CoverFetchCoordinator;
  private readonly manualBudget: PerMinuteLimiter;

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
   * slots is free (`conflict.cover_fetch_busy` otherwise). Any failure is thrown as it came with
   * the stored copy untouched; a result overtaken by a newer cover is dropped and the Content
   * answered as it stands.
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
    const coverUrl = content.coverUrl;
    const image = await this.download(content, coverUrl, "manual", signal);
    const result = this.write(owner, contentId, image, { coverUrl, version }, signal);
    if (result.outcome === "gone") {
      notFound();
    }
    return this.options.repository.withTransaction((scope) => {
      const current = scope.contents.get(owner, contentId) ?? notFound();
      return { content: this.options.details.detailIn(scope, owner, current) };
    });
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
}

function failureFields(error: unknown): Record<string, unknown> {
  if (isAmberError(error)) {
    return { errorClass: error.appError.class, errorCode: error.appError.code };
  }
  return { errorClass: "internal", message: error instanceof Error ? error.name : "unknown" };
}
