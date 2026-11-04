import type { ChapterActiveStage, ChapterRevisionDto, ChaptersDto } from "../../shared/dto/chapter.ts";
import type { ChapterRevision } from "../domain/artifact.ts";
import type { Content } from "../domain/content.ts";
import type { StageRun, Task } from "../domain/task.ts";
import { amberError } from "../domain/errors.ts";
import { deriveFreshness, transcriptAncestors } from "../domain/freshness.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { laneKeys } from "../pipeline/lane.ts";
import { isTerminalProjection, latestAttempts } from "../pipeline/projection.ts";

export interface ChapterServiceOptions {
  repository: Repository;
}

/**
 * A chapter revision as the UI sees it, with freshness derived against the current primary
 * and its ancestors (`primaryAncestors`, nearest first).
 */
export function chapterRevisionDto(revision: ChapterRevision, content: Content, primaryAncestors: readonly string[]): ChapterRevisionDto {
  const { provenance } = revision;
  const freshness = deriveFreshness(provenance.inputs, {
    ...(content.primaryTranscriptRevisionId === undefined ? {} : { primaryTranscriptRevisionId: content.primaryTranscriptRevisionId }),
    primaryAncestors,
  });
  return {
    id: revision.id,
    artifactId: revision.artifactId,
    origin: revision.origin.kind === "ai" ? { kind: "ai", transcriptRevisionId: revision.origin.transcriptRevisionId } : { kind: "platform" },
    chapters: revision.chapters.map((chapter) => ({
      startMs: chapter.startMs,
      endMs: chapter.endMs,
      title: chapter.title,
      ...(chapter.summary === undefined ? {} : { summary: chapter.summary }),
      ...(chapter.startSegmentId === undefined ? {} : { startSegmentId: chapter.startSegmentId }),
    })),
    ...(provenance.modelRef === undefined ? {} : { modelRef: { ...provenance.modelRef } }),
    ...(provenance.promptRef === undefined ? {} : { promptRef: { ...provenance.promptRef } }),
    quality: revision.quality,
    // Chapters carry no citations, so no quality reason applies to them.
    qualityReasons: [],
    ...(freshness.stale ? { stale: true, staleReason: freshness.staleReason } : { stale: false }),
    createdAt: provenance.createdAt,
  };
}

/**
 * Reading a Content's chapters and choosing which revision is current. The page shows only
 * what `currentRevisionId` names; regenerating never overwrites an older revision, and the
 * user may switch back to platform chapters.
 */
export class ChapterService {
  private readonly options: ChapterServiceOptions;

  constructor(options: ChapterServiceOptions) {
    this.options = options;
  }

  get(principal: RequestPrincipal, contentId: string): ChaptersDto {
    return this.options.repository.withTransaction((scope) => this.snapshot(scope, principal.userId, ownedContent(scope, principal.userId, contentId)));
  }

  setCurrent(principal: RequestPrincipal, contentId: string, revisionId: string): ChaptersDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = ownedContent(scope, owner, contentId);
      const artifact = scope.chapters.getArtifact(owner, contentId);
      const revision = scope.chapters.getRevision(owner, revisionId);
      if (artifact === undefined || revision === undefined || revision.artifactId !== artifact.id) {
        throw amberError("not_found", "chapter revision not found");
      }
      scope.chapters.setCurrent(owner, contentId, revisionId);
      return this.snapshot(scope, owner, content);
    });
  }

  private snapshot(scope: RepositoryScope, owner: string, content: Content): ChaptersDto {
    const artifact = scope.chapters.getArtifact(owner, content.id);
    const revisions = scope.chapters.listRevisions(owner, content.id);
    const current = revisions.find((revision) => revision.id === artifact?.currentRevisionId);
    const ancestors = transcriptAncestors(content.primaryTranscriptRevisionId, scope.transcripts.listRevisions(owner, content.id));
    const tasks = scope.tasks.listByContent(owner, content.id);
    const active = tasks.find((task) => !isTerminalProjection(task.statusProjection) && laneKeys(task, content.source.kind).includes("chapter"));
    const activeStage = active === undefined ? undefined : activeStageOf(active, chapterRun(scope, owner, active));
    const failed = lastFailedTask(scope, owner, tasks, current?.provenance.createdAt);
    return {
      ...(artifact === undefined ? {} : { artifactId: artifact.id }),
      ...(current === undefined ? {} : { current: chapterRevisionDto(current, content, ancestors) }),
      revisions: revisions.map((revision) => chapterRevisionDto(revision, content, ancestors)),
      ...(active === undefined ? {} : { activeTaskId: active.id }),
      ...(activeStage === undefined ? {} : { activeStage }),
      ...(failed === undefined ? {} : { lastFailedTaskId: failed.id }),
    };
  }
}

/** Task kinds whose graph has a chapter stage. */
const CHAPTER_TASK_KINDS: ReadonlySet<Task["kind"]> = new Set(["process_content", "regenerate_chapters"]);

/** The latest attempt of the Task's chapter stage, if its graph has one. */
function chapterRun(scope: RepositoryScope, owner: string, task: Task): StageRun | undefined {
  if (!CHAPTER_TASK_KINDS.has(task.kind)) {
    return undefined;
  }
  return latestAttempts(scope.stageRuns.listByTask(owner, task.id)).find((run) => run.stage === "chapter");
}

/**
 * Where the unfinished Task holding the chapter lane stands for the chapter section. A
 * regeneration is `queued` or `running` by its projection; the processing Task is `running`
 * only while its chapter stage runs. Anything else (the processing Task before or after its
 * chapter stage, a regeneration waiting for configuration or for the user) keeps the
 * chapters `waiting`.
 */
function activeStageOf(task: Task, run: StageRun | undefined): ChapterActiveStage {
  if (task.kind === "regenerate_chapters" && (task.statusProjection === "queued" || task.statusProjection === "running")) {
    return task.statusProjection;
  }
  if (task.kind === "process_content" && run?.status === "running") {
    return "running";
  }
  return "waiting";
}

/**
 * The latest Task with a chapter stage, when that stage itself failed after the current
 * revision was made (any time without a current revision). A chapter stage skipped or
 * cancelled because an earlier stage failed is not a chapter failure, and a later Task
 * that did not fail there hides an older failure.
 */
function lastFailedTask(scope: RepositoryScope, owner: string, tasks: readonly Task[], currentCreatedAt: number | undefined): Task | undefined {
  // Oldest first; the latest with a chapter stage decides.
  const latest = tasks.filter((task) => CHAPTER_TASK_KINDS.has(task.kind)).at(-1);
  if (latest === undefined) {
    return undefined;
  }
  const run = chapterRun(scope, owner, latest);
  if (run?.status !== "failed") {
    return undefined;
  }
  const failedAt = run.finishedAt ?? latest.finishedAt ?? latest.createdAt;
  return currentCreatedAt === undefined || failedAt > currentCreatedAt ? latest : undefined;
}

function ownedContent(scope: RepositoryScope, owner: string, contentId: string): Content {
  const content = scope.contents.get(owner, contentId);
  if (content === undefined) {
    throw amberError("not_found", "content not found");
  }
  return content;
}
