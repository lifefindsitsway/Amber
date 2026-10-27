import { monotonicFactory } from "ulid";
import type {
  ContentSummariesDto,
  QualityReason,
  SummaryCreateRequest,
  SummaryRevisionDto,
  SummaryRevisionListDto,
} from "../../shared/dto/summary.ts";
import type { TaskAcceptedDto } from "../../shared/dto/task.ts";
import type { ArtifactRevisionBase, SummaryArtifact, SummaryRevision, SummaryTemplate } from "../domain/artifact.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import type { Content } from "../domain/content.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import { deriveFreshness, transcriptAncestors, type Freshness } from "../domain/freshness.ts";
import { regenerateSummaryRequestSchema } from "../domain/task-request.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import { laneConflict, laneKeys, mutationLaneError } from "../pipeline/lane.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { transact } from "../pipeline/publish.ts";
import { modelRefProblem } from "../pipeline/requirements.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import { createTask } from "../pipeline/task-state.ts";
import { jsonRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";
import { outputLanguageFor } from "./settings.ts";
import { resolveTemplateRef, summaryTemplateDto } from "./summary-templates.ts";
import type { TaskControl } from "./tasks.ts";

export const SUMMARY_ROUTE = "POST /api/contents/:id/summaries";

export interface SummaryServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  now?: () => number;
  newId?: () => string;
}

/** Quality reasons are derived from `quality`, not stored. */
export function qualityReasonsOf(quality: ArtifactRevisionBase["quality"]): QualityReason[] {
  return quality === "degraded" ? ["citation_degraded"] : [];
}

/** Freshness of a summary against the Content's primary (and its ancestors) and current chapters. */
function summaryFreshness(scope: RepositoryScope, content: Content, revision: SummaryRevision): Freshness {
  const chapterRevisionId = scope.chapters.getArtifact(content.userId, content.id)?.currentRevisionId;
  return deriveFreshness(revision.provenance.inputs, {
    ...(content.primaryTranscriptRevisionId === undefined ? {} : { primaryTranscriptRevisionId: content.primaryTranscriptRevisionId }),
    primaryAncestors: transcriptAncestors(content.primaryTranscriptRevisionId, scope.transcripts.listRevisions(content.userId, content.id)),
    ...(chapterRevisionId === undefined ? {} : { chapterRevisionId }),
  });
}

export function summaryRevisionDto(revision: SummaryRevision, freshness: Freshness): SummaryRevisionDto {
  const { provenance } = revision;
  const transcript = provenance.inputs.find((input) => input.kind === "transcriptRevision");
  if (transcript === undefined) {
    throw amberError("internal", "a summary revision without a transcript input");
  }
  return {
    id: revision.id,
    artifactId: revision.artifactId,
    body: revision.body,
    citations: revision.citations.map((citation) => ({ ...citation })),
    ...(revision.chapterRevisionId === undefined ? {} : { chapterRevisionId: revision.chapterRevisionId }),
    ...(revision.partialIds === undefined ? {} : { partialIds: [...revision.partialIds] }),
    transcriptRevisionId: transcript.id,
    ...(provenance.modelRef === undefined ? {} : { modelRef: { ...provenance.modelRef } }),
    ...(provenance.promptRef === undefined ? {} : { promptRef: { ...provenance.promptRef } }),
    quality: revision.quality,
    qualityReasons: qualityReasonsOf(revision.quality),
    ...(freshness.stale ? { stale: true, staleReason: freshness.staleReason } : { stale: false }),
    createdAt: provenance.createdAt,
  };
}

/**
 * A Content's summaries, one artifact per template, and the explicit "generate summary"
 * action. Generating creates a `regenerate_summary` Task
 * that freezes the template version, the primary transcript and the output language at
 * submission; the page shows only what each artifact's `currentRevisionId` names.
 */
export class SummaryService {
  private readonly options: SummaryServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: SummaryServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /**
   * Every template the Content can show: builtin ones, the owner's undeleted ones,
   * and deleted ones that already produced a summary of this Content.
   */
  list(principal: RequestPrincipal, contentId: string): ContentSummariesDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = ownedContent(scope, owner, contentId);
      const artifacts = new Map(scope.summaries.listArtifacts(owner, contentId).map((artifact) => [artifact.templateId, artifact]));
      const templates: SummaryTemplate[] = scope.summaryTemplates.list(owner);
      const listed = new Set(templates.map((template) => template.id));
      for (const templateId of artifacts.keys()) {
        if (!listed.has(templateId)) {
          const template = scope.summaryTemplates.get(owner, templateId);
          if (template !== undefined) {
            templates.push(template);
            listed.add(templateId);
          }
        }
      }
      const unfinished = scope.tasks
        .listByContent(owner, contentId)
        .filter((task) => !isTerminalProjection(task.statusProjection))
        .map((task) => ({ task, keys: laneKeys(task, content.source.kind) }));
      return {
        templates: templates.map((template) => {
          const artifact = artifacts.get(template.id);
          const current = currentOf(scope, owner, artifact);
          const freshness = current === undefined ? ({ stale: false } as const) : summaryFreshness(scope, content, current);
          const active = unfinished.find(({ keys }) => keys.includes(`summary:${template.id}`));
          return {
            template: summaryTemplateDto(template),
            ...(artifact === undefined ? {} : { artifactId: artifact.id }),
            ...(current === undefined ? {} : { current: summaryRevisionDto(current, freshness) }),
            ...(freshness.stale ? { stale: true, staleReason: freshness.staleReason } : { stale: false }),
            ...(active === undefined ? {} : { activeTaskId: active.task.id }),
          };
        }),
      };
    });
  }

  async create(principal: RequestPrincipal, contentId: string, body: SummaryCreateRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const context = { userId: owner, route: SUMMARY_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest({ contentId, body }) };
    const replay = this.options.repository.withTransaction((scope) =>
      idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, SUMMARY_ROUTE, idempotencyKey),
    );
    if (replay === undefined) {
      const low = await diskLowError(this.options.disk, this.options.settings.effective());
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark");
      }
    }
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
      runIdempotent(scope, context, this.now(), () => {
        const content = ownedContent(scope, owner, contentId);
        if (body.modelRef !== undefined) {
          const problem = modelRefProblem(scope, owner, body.modelRef);
          if (problem !== undefined) {
            throw amberError("invalid_request", problem, { params: { detail: "modelRef" } });
          }
        }
        const templateRef = resolveTemplateRef(scope, owner, body.templateId);
        const baseRevisionId = content.primaryTranscriptRevisionId;
        if (baseRevisionId === undefined) {
          throw amberError("invalid_request", "the content has no primary transcript yet", { params: { detail: "primaryTranscriptRevisionId" } });
        }
        const requestJson = canonicalJson(
          regenerateSummaryRequestSchema.parse({
            requestSchemaVersion: 1,
            kind: "regenerate_summary",
            ...(body.modelRef === undefined ? {} : { modelRef: body.modelRef }),
            outputLanguage: outputLanguageFor(scope, owner, body.outputLanguage),
            templateRef,
            baseRevisionId,
          }),
        );
        const candidate = { id: "", kind: "regenerate_summary" as const, requestJson };
        const others = scope.tasks
          .listByContent(owner, contentId)
          .filter((task) => !isTerminalProjection(task.statusProjection))
          .map((task) => ({ task, keys: laneKeys(task, content.source.kind) }));
        const blocking = laneConflict(laneKeys(candidate, content.source.kind), others);
        if (blocking !== undefined) {
          throw mutationLaneError(blocking, "another unfinished task works on the same summary");
        }
        const task = createTask(scope, outbox, {
          task: { id: this.newId(), userId: owner, contentId, kind: "regenerate_summary", requestJson, createdAt: this.now() },
          sourceKind: content.source.kind,
          newId: this.newId,
        });
        return { status: 202, body: { taskId: task.id }, resourceRefs: [task.id] };
      }),
    );
    if (!result.replayed) {
      this.options.control.kick();
    }
    return result;
  }

  revisions(principal: RequestPrincipal, artifactId: string): SummaryRevisionListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => this.revisionList(scope, owner, ownedArtifact(scope, owner, artifactId)));
  }

  setCurrent(principal: RequestPrincipal, artifactId: string, revisionId: string): SummaryRevisionListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const artifact = ownedArtifact(scope, owner, artifactId);
      ownedContent(scope, owner, artifact.contentId);
      const revision = scope.summaries.getRevision(owner, revisionId);
      if (revision === undefined || revision.artifactId !== artifact.id) {
        throw amberError("not_found", "summary revision not found");
      }
      scope.summaries.setCurrent(owner, artifact.id, revisionId);
      scope.search.syncContent(owner, artifact.contentId);
      return this.revisionList(scope, owner, { ...artifact, currentRevisionId: revisionId });
    });
  }

  /**
   * Deletes one earlier revision of a summary, with its rolling partials; usage rows stay with
   * their link cleared. The current revision, and one a collection summary was built from,
   * stay: the page and the collection still show them. Only the current revision is indexed
   * for search, so the projection is unchanged.
   */
  deleteRevision(principal: RequestPrincipal, artifactId: string, revisionId: string): SummaryRevisionListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const artifact = ownedArtifact(scope, owner, artifactId);
      ownedContent(scope, owner, artifact.contentId);
      const revision = scope.summaries.getRevision(owner, revisionId);
      if (revision === undefined || revision.artifactId !== artifact.id) {
        throw amberError("not_found", "summary revision not found");
      }
      if (artifact.currentRevisionId === revisionId) {
        throw amberError("conflict", "the current summary revision cannot be deleted", {
          code: "conflict.summary_revision_in_use",
          details: { reason: "current" },
        });
      }
      const history = scope.revisionReferences.historyArtifact(owner, "summary", revisionId);
      if (history === undefined) {
        throw amberError("conflict", "a collection summary was built from this revision", {
          code: "conflict.summary_revision_in_use",
          details: { reason: "collection_summary" },
        });
      }
      scope.revisionReferences.deleteHistoryArtifact(owner, history);
      return this.revisionList(scope, owner, artifact);
    });
  }

  private revisionList(scope: RepositoryScope, owner: string, artifact: SummaryArtifact): SummaryRevisionListDto {
    const content = ownedContent(scope, owner, artifact.contentId);
    const revisions = scope.summaries.listRevisions(owner, artifact.id);
    return {
      artifactId: artifact.id,
      ...(artifact.currentRevisionId === undefined ? {} : { currentRevisionId: artifact.currentRevisionId }),
      items: revisions.map((revision) => summaryRevisionDto(revision, summaryFreshness(scope, content, revision))),
      frozenRevisionIds: revisions
        .filter((revision) => revision.id !== artifact.currentRevisionId && scope.revisionReferences.historyArtifact(owner, "summary", revision.id) === undefined)
        .map((revision) => revision.id),
    };
  }
}

function currentOf(scope: RepositoryScope, owner: string, artifact: SummaryArtifact | undefined): SummaryRevision | undefined {
  return artifact?.currentRevisionId === undefined ? undefined : scope.summaries.getRevision(owner, artifact.currentRevisionId);
}

function ownedContent(scope: RepositoryScope, owner: string, contentId: string): Content {
  const content = scope.contents.get(owner, contentId);
  if (content === undefined) {
    throw amberError("not_found", "content not found");
  }
  return content;
}

function ownedArtifact(scope: RepositoryScope, owner: string, artifactId: string): SummaryArtifact {
  const artifact = scope.summaries.getArtifact(owner, artifactId);
  if (artifact === undefined) {
    throw amberError("not_found", "summary not found");
  }
  return artifact;
}
