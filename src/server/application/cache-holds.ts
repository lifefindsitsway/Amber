import { cacheFileNameOf } from "../../shared/cache-file-name.ts";
import type { CacheHoldDto } from "../../shared/dto/local-media.ts";
import { displayTitleOf } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { CacheGate } from "../pipeline/cache-gate.ts";
import type { CacheHoldRegistry } from "../pipeline/cache-holds.ts";
import type { CachePathLocks } from "../pipeline/cache-path-locks.ts";
import { cacheRowsAt, resolveHold } from "../pipeline/cache-swap.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import type { CacheFileStore } from "../pipeline/media-files.ts";
import { requireAdmin } from "./admin.ts";

export interface CacheHoldServiceOptions {
  repository: Repository;
  cache: CacheFileStore;
  holds: CacheHoldRegistry;
  locks: CachePathLocks;
  /** Settling a hold moves cache files, which must not race a cache move. */
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  logger?: Logger;
}

/**
 * The interrupted cache replacements waiting for the user (local mode): the list the
 * storage page shows with the cache location, and the two ways to settle one. The cache
 * directory is instance-wide like its location, so these are the administrator's
 * actions, as moving the cache is.
 */
export class CacheHoldService {
  private readonly options: CacheHoldServiceOptions;

  constructor(options: CacheHoldServiceOptions) {
    this.options = options;
  }

  /** Every hold, with the title of the Content whose cache it concerns when a row says which. */
  list(): CacheHoldDto[] {
    return this.options.repository.withTransaction((scope) =>
      this.options.holds.list().map((hold) => {
        const { record } = hold;
        const rows = cacheRowsAt(scope, record.targetRef);
        const row = rows.find((asset) => asset.id === record.newAssetId) ?? rows.find((asset) => asset.id === record.displaced?.assetId);
        const content = row === undefined ? undefined : scope.contents.getIncludingTrashed(row.userId, row.contentId);
        const title = content === undefined ? undefined : displayTitleOf(content);
        return {
          assetId: hold.scratchId,
          ...(row === undefined ? {} : { contentId: row.contentId }),
          ...(title === undefined ? {} : { title }),
          fileName: cacheFileNameOf(record.targetRef),
          ...(hold.currentSizeBytes === undefined ? {} : { currentSizeBytes: hold.currentSizeBytes }),
          ...(hold.displacedSizeBytes === undefined ? {} : { displacedSizeBytes: hold.displacedSizeBytes }),
        };
      }),
    );
  }

  /**
   * `POST /api/media/cache-location/holds/:assetId/keep|restore` [client]: keeps the file now
   * at the path, or puts the displaced copy back, after checking both files against the
   * replacement's record (`conflict.cache_file_foreign` when they changed); then the
   * replacement's scratch directory goes. An unknown id is `not_found`.
   */
  async settle(principal: RequestPrincipal, assetId: string, action: "keep" | "restore"): Promise<void> {
    requireAdmin(principal);
    if (this.options.holds.get(assetId) === undefined) {
      throw amberError("not_found", "no replacement waits under this id");
    }
    const release = this.options.gate.tryShared();
    if (release === undefined) {
      throw gateConflict(this.options.gate);
    }
    try {
      await resolveHold(
        {
          repository: this.options.repository,
          cache: this.options.cache,
          holds: this.options.holds,
          locks: this.options.locks,
          ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
        },
        assetId,
        action,
      );
    } finally {
      release();
    }
  }
}
