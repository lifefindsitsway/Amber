import { monotonicFactory } from "ulid";
import { capDescription, type DescriptionClock } from "../../domain/content-description.ts";
import { amberError } from "../../domain/errors.ts";
import type { Platform } from "../../domain/platform.ts";
import { normalizePlatformChapters } from "../../domain/platform-subtitle.ts";
import type { Repository } from "../../ports/repository.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import { platformTarget, taskContent, type PlatformAccess } from "./platform-access.ts";
import type { SourceCoverSaver } from "./source-cover.ts";

export interface SourceStageDeps {
  repository: Repository;
  platforms: PlatformAccess;
  /** The process's one issuer of description request times, shared with the manual description fetch. */
  descriptionClock: DescriptionClock;
  /** Keeps a local copy of the platform's cover; without it only the cover URL is stored. */
  covers?: SourceCoverSaver;
  now?: () => number;
  newId?: () => string;
}

/**
 * The `source` stage of a platform `process_content`: fetches the
 * platform metadata, fills the Content's title, duration, cover, date and channel, and
 * stores creator chapters as a `ChapterRevision(origin = platform)` (first chapter from 0,
 * deduplicated by content). Platform chapters become current unless an AI revision
 * already is. The description read with the metadata is stored when the platform gave a
 * clear answer (text or "none") and no later request's answer is stored already; an
 * unreadable one leaves what is stored alone.
 */
export class SourceStageExecutor implements StageExecutor {
  private readonly deps: SourceStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SourceStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const content = taskContent(this.deps.repository, context);
    const target = platformTarget(this.deps.platforms, content);
    if (target === undefined) {
      throw new TypeError("the source stage needs a platform Content");
    }
    // Metadata goes through the platform's extractor: managed heavy work that waits for a slot of
    // the shared heavy-job governor.
    let checkedAt = 0;
    // An import check read this link's metadata moments ago: it is used instead of asking again.
    const recent = this.deps.platforms.recentMetadata?.(content.userId, content.source.kind as Platform, target.ref);
    if (recent !== undefined) {
      checkedAt = this.deps.descriptionClock.issue();
    }
    const metadata =
      recent ??
      (await context.withHeavySlot(() => {
        // The time the request is sent, not when it returns: a manual fetch sent while this one
        // is out is newer and must win.
        checkedAt = this.deps.descriptionClock.issue();
        return target.adapter.fetchMetadata(target.ref, target.auth, context.signal);
      }));
    if (!(metadata.durationMs > 0)) {
      throw amberError("source_unreachable", "the platform reported no duration");
    }
    const chapters = normalizePlatformChapters(metadata.chapters ?? [], metadata.durationMs);
    const owner = content.userId;
    // Outside the heavy slot: an image download is not extractor work. It never throws and
    // does nothing when a copy exists, so re-running the stage keeps the stored version.
    if (metadata.coverUrl !== undefined) {
      await this.deps.covers?.saveIfAbsent(owner, content.id, metadata.coverUrl, context.signal);
    }
    return {
      resultJson: { reasons: [] },
      publish: (scope) => {
        const now = this.now();
        scope.contents.setMetadata(
          owner,
          content.id,
          {
            title: metadata.title,
            durationMs: metadata.durationMs,
            ...(metadata.coverUrl === undefined ? {} : { coverUrl: metadata.coverUrl }),
            ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
            ...(metadata.rawLanguage === undefined || content.rawLanguage !== undefined ? {} : { rawLanguage: metadata.rawLanguage }),
            ...(metadata.channelId === undefined ? {} : { channelId: metadata.channelId }),
            ...(metadata.channelTitle === undefined ? {} : { channelTitle: metadata.channelTitle }),
          },
          now,
        );
        const { description } = metadata;
        if (description.state === "found") {
          const capped = capDescription(description.text);
          scope.contents.setDescription(owner, content.id, { description: capped.text, truncated: capped.truncated, checkedAt }, now);
        } else if (description.state === "empty") {
          scope.contents.setDescription(owner, content.id, { description: null, truncated: false, checkedAt }, now);
        }
        scope.search.syncContent(owner, content.id);
        if (chapters.length === 0) {
          return;
        }
        const { revisionId } = scope.chapters.insertPlatformRevision(owner, content.id, {
          id: this.newId(),
          artifactId: this.newId(),
          chapters,
          createdAt: now,
        });
        const current = scope.chapters.getCurrent(owner, content.id);
        if (current === undefined || current.origin.kind === "platform") {
          scope.chapters.setCurrent(owner, content.id, revisionId);
        }
      },
    };
  }
}
