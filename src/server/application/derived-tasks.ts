import { monotonicFactory } from "ulid";
import type { TaskAcceptedDto } from "../../shared/dto/task.ts";
import type { DerivedTaskRequest } from "../../shared/dto/transcript.ts";
import type { TranslationRequest } from "../../shared/dto/translation.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import type { Content } from "../domain/content.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import type { TaskKind } from "../../shared/enums.ts";
import {
  recomputeHighlightsRequestSchema,
  regenerateChaptersRequestSchema,
  reproofreadRequestSchema,
  translateRequestSchema,
} from "../domain/task-request.ts";
import { normalizeTargetLanguages } from "../domain/translation.ts";
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
import type { TaskControl } from "./tasks.ts";

export const PROOFREAD_ROUTE = "POST /api/contents/:id/transcript/proofread";
export const REGENERATE_CHAPTERS_ROUTE = "POST /api/contents/:id/chapters/regenerate";
export const RECOMPUTE_HIGHLIGHTS_ROUTE = "POST /api/contents/:id/highlights/recompute";
export const TRANSLATE_ROUTE = "POST /api/contents/:id/translations";

export interface DerivedTaskServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  now?: () => number;
  newId?: () => string;
}

/**
 * The explicit "proofread again", "regenerate chapters", "recompute highlights" and
 * "translate" actions: each creates a single-stage Task whose request freezes its base
 * transcript at submission as `baseRevisionId`, so a later switch of the primary does not
 * change what the Task works on. A model may be left out; the stage then waits for one to
 * be chosen through retry-stage.
 */
export class DerivedTaskService {
  private readonly options: DerivedTaskServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: DerivedTaskServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  proofread(principal: RequestPrincipal, contentId: string, body: DerivedTaskRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    return this.create(principal, contentId, body, idempotencyKey, PROOFREAD_ROUTE, "reproofread", (content) =>
      canonicalJson(
        reproofreadRequestSchema.parse({
          requestSchemaVersion: 1,
          kind: "reproofread",
          ...(body.modelRef === undefined ? {} : { modelRef: body.modelRef }),
          baseRevisionId: primaryOf(content),
        }),
      ),
    );
  }

  /**
   * The request carries no language, so the chapter language is frozen from the user's
   * output-language default chain.
   */
  regenerateChapters(principal: RequestPrincipal, contentId: string, body: DerivedTaskRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    return this.create(principal, contentId, body, idempotencyKey, REGENERATE_CHAPTERS_ROUTE, "regenerate_chapters", (content, scope) =>
      canonicalJson(
        regenerateChaptersRequestSchema.parse({
          requestSchemaVersion: 1,
          kind: "regenerate_chapters",
          ...(body.modelRef === undefined ? {} : { modelRef: body.modelRef }),
          baseRevisionId: primaryOf(content),
          outputLanguage: outputLanguageFor(scope, principal.userId, undefined),
        }),
      ),
    );
  }

  /** Like chapters, the language of the highlight reasons is frozen from the user's output-language default chain. */
  recomputeHighlights(principal: RequestPrincipal, contentId: string, body: DerivedTaskRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    return this.create(principal, contentId, body, idempotencyKey, RECOMPUTE_HIGHLIGHTS_ROUTE, "recompute_highlights", (content, scope) =>
      canonicalJson(
        recomputeHighlightsRequestSchema.parse({
          requestSchemaVersion: 1,
          kind: "recompute_highlights",
          ...(body.modelRef === undefined ? {} : { modelRef: body.modelRef }),
          baseRevisionId: primaryOf(content),
          outputLanguage: outputLanguageFor(scope, principal.userId, undefined),
        }),
      ),
    );
  }

  /**
   * One Task for every requested language. The source is the named revision
   * or the primary; a translation is never translated again. Languages are canonicalized
   * and de-duplicated, and one whose primary subtag is the source's is refused.
   */
  translate(principal: RequestPrincipal, contentId: string, body: TranslationRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    return this.create(principal, contentId, body, idempotencyKey, TRANSLATE_ROUTE, "translate", (content, scope) => {
      const sourceId = body.sourceRevisionId ?? primaryOf(content);
      const source = scope.transcripts.getRevision(principal.userId, sourceId);
      if (source === undefined || source.contentId !== content.id) {
        throw amberError("not_found", "source transcript revision not found");
      }
      if (source.kind === "translated") {
        throw amberError("invalid_request", "a translation cannot be translated again", { params: { detail: "sourceRevisionId" } });
      }
      const normalized = normalizeTargetLanguages(body.targetLanguages, source.language);
      if ("problem" in normalized) {
        throw amberError("invalid_request", `target language ${normalized.problem.tag}: ${normalized.problem.kind}`, {
          params: { detail: "targetLanguages" },
        });
      }
      return canonicalJson(
        translateRequestSchema.parse({
          requestSchemaVersion: 1,
          kind: "translate",
          targetLanguages: normalized.languages,
          ...(body.modelRef === undefined ? {} : { modelRef: body.modelRef }),
          baseRevisionId: source.id,
        }),
      );
    });
  }

  private async create(
    principal: RequestPrincipal,
    contentId: string,
    body: DerivedTaskRequest,
    idempotencyKey: string | undefined,
    route: string,
    kind: TaskKind,
    requestJsonFor: (content: Content, scope: RepositoryScope) => string,
  ): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const context = { userId: owner, route, key: idempotencyKey, requestDigest: jsonRequestDigest({ contentId, body }) };
    const replay = this.options.repository.withTransaction((scope) =>
      idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, route, idempotencyKey),
    );
    if (replay === undefined) {
      const low = await diskLowError(this.options.disk, this.options.settings.effective());
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark");
      }
    }
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
      runIdempotent(scope, context, this.now(), () => {
        const content: Content | undefined = scope.contents.get(owner, contentId);
        if (content === undefined) {
          throw amberError("not_found", `content ${contentId}`);
        }
        if (body.modelRef !== undefined) {
          const problem = modelRefProblem(scope, owner, body.modelRef);
          if (problem !== undefined) {
            throw amberError("invalid_request", problem, { params: { detail: "modelRef" } });
          }
        }
        const requestJson = requestJsonFor(content, scope);
        const candidate = { id: "", kind, requestJson };
        const others = scope.tasks
          .listByContent(owner, contentId)
          .filter((task) => !isTerminalProjection(task.statusProjection))
          .map((task) => ({ task, keys: laneKeys(task, content.source.kind) }));
        const blocking = laneConflict(laneKeys(candidate, content.source.kind), others);
        if (blocking !== undefined) {
          throw mutationLaneError(blocking, "another unfinished task works on the same stages");
        }
        const task = createTask(scope, outbox, {
          task: { id: this.newId(), userId: owner, contentId, kind, requestJson, createdAt: this.now() },
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
}

function primaryOf(content: Content): string {
  if (content.primaryTranscriptRevisionId === undefined) {
    throw amberError("invalid_request", "the content has no primary transcript yet", { params: { detail: "primaryTranscriptRevisionId" } });
  }
  return content.primaryTranscriptRevisionId;
}
