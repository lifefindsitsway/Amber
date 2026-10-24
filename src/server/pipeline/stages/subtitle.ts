import { monotonicFactory } from "ulid";
import type { Content } from "../../domain/content.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import {
  cueDigest,
  originalSubtitleLanguage,
  platformTranscript,
  selectSubtitleTrack,
  usableCues,
  type PlatformCue,
} from "../../domain/platform-subtitle.ts";
import { importedSubtitleWarnings, judgeSubtitle, type SubtitleVerdict } from "../../domain/subtitle-verdict.ts";
import { rootRevisionTakesPrimary } from "../../domain/transcript.ts";
import type { CanonicalSubtitle, PlatformMetadata } from "../../ports/platform-source.ts";
import type { Repository, RepositoryScope } from "../../ports/repository.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import { platformTarget, taskContent, type PlatformAccess, type PlatformTarget } from "./platform-access.ts";

export interface SubtitleStageDeps {
  repository: Repository;
  platforms: PlatformAccess;
  now?: () => number;
  newId?: () => string;
}

/** How the best-effort platform fetch went when the user's own subtitle is primary. */
type PlatformFetch = "stored" | "none" | "failed";

interface FetchedSubtitle {
  cues: PlatformCue[];
  dropped: number;
  subtitle: CanonicalSubtitle;
}

/**
 * The `subtitle` stage of a platform `process_content`. Picks the best
 * platform track (human original > automatic original > other human > translation),
 * judges its completeness (`valid / suspicious / invalid / none`) and keeps it as a
 * `platform` revision (deduplicated by content). Only a `valid` working copy may become
 * primary, and only while no manual / imported / corrected revision is;
 * anything else leaves `needs_asr` true. When the user imported a subtitle, fetching the
 * platform one is best effort, never changes the primary and never leads to ASR; the
 * imported timeline is only sanity-checked into warnings.
 */
export class SubtitleStageExecutor implements StageExecutor {
  private readonly deps: SubtitleStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SubtitleStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const content = taskContent(this.deps.repository, context);
    const target = platformTarget(this.deps.platforms, content);
    if (target === undefined) {
      throw new TypeError("the subtitle stage needs a platform Content");
    }
    const durationMs = content.durationMs;
    if (durationMs === undefined || !(durationMs > 0)) {
      throw amberError("internal", "the subtitle stage runs after the source stage has learned the duration");
    }
    const owner = content.userId;
    const primaryKind = this.deps.repository.withTransaction((scope) =>
      content.primaryTranscriptRevisionId === undefined ? undefined : scope.transcripts.getRevision(owner, content.primaryTranscriptRevisionId)?.kind,
    );
    return primaryKind === "imported"
      ? this.alongsideImported(context, content, target, durationMs)
      : this.platformWorkingCopy(context, content, target, durationMs);
  }

  private async platformWorkingCopy(context: StageExecutionContext, content: Content, target: PlatformTarget, durationMs: number): Promise<StageOutcome> {
    const metadata = await this.fetchMetadata(context, target);
    const fetched = await this.fetchBest(context, target, metadata, content.rawLanguage);
    const rawLanguage = content.rawLanguage === undefined ? originalSubtitleLanguage(metadata.subtitleTracks, metadata.rawLanguage) : undefined;
    if (fetched === undefined) {
      return {
        resultJson: { verdict: "none" satisfies SubtitleVerdict, reasons: ["subtitle_none"] },
        publish: (scope) => this.writeRawLanguage(scope, content, rawLanguage),
      };
    }
    const judgement = fetched.cues.length === 0 ? { verdict: "invalid" as const, reasons: [] } : judgeSubtitle(fetched.cues, durationMs);
    const reasons = [
      ...(judgement.verdict === "valid" ? [] : ["subtitle_incomplete"]),
      ...judgement.reasons,
      ...(fetched.dropped > 0 ? ["subtitle_cue_dropped"] : []),
    ];
    return {
      resultJson: { verdict: judgement.verdict, reasons },
      publish: (scope) => {
        this.writeRawLanguage(scope, content, rawLanguage);
        const revisionId = this.storePlatformRevision(scope, content, fetched);
        if (revisionId === undefined || judgement.verdict !== "valid") {
          return;
        }
        // An identical platform revision the user archived is reused as it is, archived: an
        // archived revision is never made current behind the user's back.
        if (scope.transcripts.listArchived(content.userId, content.id).some((entry) => entry.revisionId === revisionId)) {
          return;
        }
        const current = scope.contents.getIncludingTrashed(content.userId, content.id);
        const currentKind =
          current?.primaryTranscriptRevisionId === undefined ? undefined : scope.transcripts.getRevision(content.userId, current.primaryTranscriptRevisionId)?.kind;
        if (rootRevisionTakesPrimary(currentKind)) {
          scope.contents.setPrimaryTranscript(content.userId, content.id, revisionId, this.now());
          scope.search.syncContent(content.userId, content.id);
        }
      },
    };
  }

  /** Only the metadata call is a managed heavy job, held to a slot of the shared heavy-job governor; subtitle downloads are not. */
  private fetchMetadata(context: StageExecutionContext, target: PlatformTarget) {
    return context.withHeavySlot(() => target.adapter.fetchMetadata(target.ref, target.auth, context.signal));
  }

  private async alongsideImported(context: StageExecutionContext, content: Content, target: PlatformTarget, durationMs: number): Promise<StageOutcome> {
    const owner = content.userId;
    const imported = this.deps.repository.withTransaction((scope) => scope.transcripts.listSegments(owner, content.primaryTranscriptRevisionId as string));
    const reasons = importedSubtitleWarnings(imported, durationMs);
    let fetched: FetchedSubtitle | undefined;
    let verdict: SubtitleVerdict = "none";
    let platformFetch: PlatformFetch = "none";
    let rawLanguage: string | undefined;
    try {
      const metadata = await this.fetchMetadata(context, target);
      rawLanguage = content.rawLanguage === undefined ? originalSubtitleLanguage(metadata.subtitleTracks, metadata.rawLanguage) : undefined;
      fetched = await this.fetchBest(context, target, metadata, content.rawLanguage);
      if (fetched !== undefined) {
        platformFetch = "stored";
        verdict = fetched.cues.length === 0 ? "invalid" : judgeSubtitle(fetched.cues, durationMs).verdict;
      }
    } catch (error) {
      if (context.signal.aborted || !isAmberError(error)) {
        throw error;
      }
      platformFetch = "failed";
      reasons.push("platform_subtitle_unavailable");
    }
    return {
      resultJson: { verdict, reasons, platformFetch },
      publish: (scope) => {
        this.writeRawLanguage(scope, content, rawLanguage);
        if (fetched !== undefined) {
          this.storePlatformRevision(scope, content, fetched);
        }
      },
    };
  }

  private async fetchBest(
    context: StageExecutionContext,
    target: PlatformTarget,
    metadata: PlatformMetadata,
    rawLanguage: string | undefined,
  ): Promise<FetchedSubtitle | undefined> {
    const track = selectSubtitleTrack(metadata.subtitleTracks, rawLanguage ?? metadata.rawLanguage);
    if (track === undefined) {
      return undefined;
    }
    const subtitle = await target.adapter.fetchSubtitle(target.ref, track, target.auth, context.signal);
    const { cues, dropped } = usableCues(subtitle.cues);
    return { cues, dropped, subtitle };
  }

  private writeRawLanguage(scope: RepositoryScope, content: Content, rawLanguage: string | undefined): void {
    if (rawLanguage !== undefined && scope.contents.getIncludingTrashed(content.userId, content.id)?.rawLanguage === undefined) {
      scope.contents.setMetadata(content.userId, content.id, { rawLanguage }, this.now());
    }
  }

  /** Stores the subtitle as a `platform` revision, reusing an identical one; `undefined` when it has no cues. */
  private storePlatformRevision(scope: RepositoryScope, content: Content, fetched: FetchedSubtitle): string | undefined {
    if (fetched.cues.length === 0) {
      return undefined;
    }
    const owner = content.userId;
    const language = fetched.subtitle.language;
    const digest = cueDigest(language, fetched.cues);
    for (const revision of scope.transcripts.listRevisions(owner, content.id)) {
      if (revision.kind === "platform" && cueDigest(revision.language, scope.transcripts.listSegments(owner, revision.id)) === digest) {
        return revision.id;
      }
    }
    const { revision, segments } = platformTranscript({
      revisionId: this.newId(),
      contentId: content.id,
      language,
      cues: fetched.cues,
      acquisition: fetched.subtitle.acquisition,
      newId: this.newId,
      createdAt: this.now(),
    });
    scope.transcripts.insertRevision(owner, revision, segments);
    return revision.id;
  }
}
