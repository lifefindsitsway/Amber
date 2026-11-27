import { COVER_DOWNLOAD_MAX_BYTES, COVER_FETCH_TIMEOUT_MS, COVER_IMAGE_MAX_BYTES, COVER_LONG_EDGE_MAX_PX } from "../../shared/defaults.ts";
import type { ContentDetailDto } from "../../shared/dto/content.ts";
import type { Content } from "../domain/content.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import { isPlatform } from "../domain/platform.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { ContentCoverImage, Repository } from "../ports/repository.ts";
import type { PlatformAccess } from "../pipeline/stages/platform-access.ts";
import type { SourceCoverSaver } from "../pipeline/stages/source-cover.ts";
import type { ContentService } from "./contents.ts";
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
  logger?: Logger;
  now?: () => number;
  /** Download plus processing of one cover; `COVER_FETCH_TIMEOUT_MS` by default. */
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
 * Settles with `signal`'s reason as soon as it aborts, else as `promise` does. `promise` always
 * gets a handler, so a rejection after the abort is never unhandled.
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

/**
 * Local copies of platform covers. The platform's image is downloaded through the Content's
 * adapter (trusted image hosts only, no login), decoded and re-encoded by the shared image
 * processor, and stored with its version in one transaction; the platform's file is never
 * kept. The `source` stage stores one only while there is none (`saveIfAbsent`, never
 * throwing); the user's explicit fetch replaces it (`fetch`), leaving the old copy and
 * version alone when anything fails.
 *
 * Writes go through the cover repository, which refuses a Content that is gone, another
 * owner's or in the trash at the moment of the write, so a purge, a move to the trash or a
 * re-import racing a download never leaves a cover row behind; reads see the copy as it is
 * at that moment or none.
 */
export class ContentCoverService implements SourceCoverSaver {
  private readonly options: ContentCoverServiceOptions;
  private readonly now: () => number;

  constructor(options: ContentCoverServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
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
      const image = await this.download(content, coverUrl, signal);
      const wrote = this.options.repository.withTransaction((scope) => scope.contentCovers.putIfAbsent(ownerUserId, contentId, image, this.now()));
      if (!wrote) {
        this.options.logger?.debug("cover_already_present", { contentId });
      }
    } catch (error) {
      // The cover is a nicety: whatever went wrong, the caller carries on. The URL is not
      // logged; some platforms put access parameters in it.
      this.options.logger?.warn("cover_save_failed", { contentId, ...failureFields(error) });
    }
  }

  /**
   * Downloads the cover at the Content's current `coverUrl` again and replaces the local copy,
   * raising its version. Only platform Contents have one (`invalid_request` otherwise); any
   * failure is thrown as it came (the platform's error, a refused image) with the stored copy
   * untouched.
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
    const image = await this.download(content, content.coverUrl, signal);
    return this.options.repository.withTransaction((scope) => {
      scope.contentCovers.put(owner, contentId, image, this.now());
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

  /**
   * Fetches and normalizes one cover within the overall time limit. The adapter checks the URL
   * against its platform's image hosts before any request; a platform without covers fails
   * like an unreachable platform.
   */
  private async download(content: Content, coverUrl: string, signal: AbortSignal): Promise<FigureImage> {
    const kind = content.source.kind;
    if (!isPlatform(kind)) {
      throw amberError("invalid_request", "only platform contents have a platform cover", { params: { detail: "contentId" } });
    }
    const adapter = this.options.platforms.adapterFor(kind);
    const fetchCover = adapter.fetchCover?.bind(adapter);
    if (fetchCover === undefined) {
      throw amberError("source_unreachable", "the platform adapter cannot fetch covers");
    }
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort(new Error("cover fetch timed out"));
    }, this.options.timeoutMs ?? COVER_FETCH_TIMEOUT_MS);
    const bounded = AbortSignal.any([signal, deadline.signal]);
    try {
      // Raced against the signal so the limit holds even for a step that does not watch it;
      // the job's directory is still removed once that step returns.
      return await untilAborted(
        this.options.images.normalizeFetched(
          content.userId,
          (input) => fetchCover(coverUrl, input, { maxBytes: COVER_DOWNLOAD_MAX_BYTES }, bounded),
          COVER_LIMITS,
          bounded,
        ),
        bounded,
      );
    } catch (error) {
      if (timedOut && !signal.aborted) {
        throw amberError("source_unreachable", "the cover did not arrive in time");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function failureFields(error: unknown): Record<string, unknown> {
  if (isAmberError(error)) {
    return { errorClass: error.appError.class, errorCode: error.appError.code };
  }
  return { errorClass: "internal", message: error instanceof Error ? error.name : "unknown" };
}
