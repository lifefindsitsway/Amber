import { monotonicFactory } from "ulid";
import type {
  CollectionCreateRequest,
  CollectionDetailDto,
  CollectionDto,
  CollectionItemAddRequest,
  CollectionItemDto,
  CollectionListDto,
  CollectionPatchRequest,
  CollectionSummaryDto,
  CollectionSummaryRequest,
  CollectionSummaryRevisionDto,
} from "../../shared/dto/collection.ts";
import type { ImportResponse } from "../../shared/dto/import.ts";
import type { TaskAcceptedDto } from "../../shared/dto/task.ts";
import type { CollectionSummaryRevision } from "../domain/artifact.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import type { Collection, CollectionItem } from "../domain/collection.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import { deriveCollectionFreshness, transcriptAncestors, type CollectionMemberState, type Freshness } from "../domain/freshness.ts";
import { DEFAULT_SUMMARY_TEMPLATE_ID } from "../domain/prompts.ts";
import { summarizeCollectionRequestSchema, type SummarizeCollectionRequest } from "../domain/task-request.ts";
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
import type { ImportContentService } from "./import-content.ts";
import { outputLanguageFor } from "./settings.ts";
import { qualityReasonsOf } from "./summaries.ts";
import type { TaskControl } from "./tasks.ts";
import { displayTitle } from "../domain/content.ts";

export const COLLECTION_SUMMARY_ROUTE = "POST /api/collections/:id/summary";

export interface CollectionServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  /** Adding a member by URL imports it into the collection; absent, only `contentId` is accepted. */
  importContent?: Pick<ImportContentService, "import">;
  now?: () => number;
  newId?: () => string;
}

/** The answer of `POST /api/collections/:id/items`: an import (202) or the enrolled item (200). */
export type CollectionItemAddResult = { status: 202; body: ImportResponse } | { status: 200; body: CollectionItemDto };

/**
 * Collections as play queue, summarization unit and sharing unit. Members reference Contents
 * only; a URL added to a collection first becomes a Content through the import service. A
 * collection summary freezes each member's `summary.core` current revision and primary
 * transcript at submission and refuses to run with any missing; it never generates them
 * implicitly.
 */
export class CollectionService {
  private readonly options: CollectionServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: CollectionServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  list(principal: RequestPrincipal): CollectionListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => ({
      items: scope.collections.list(owner).map((collection) => collectionDto(collection, scope.collections.listVisibleItems(owner, collection.id).length)),
    }));
  }

  get(principal: RequestPrincipal, collectionId: string): CollectionDetailDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => detail(scope, owner, ownedCollection(scope, owner, collectionId)));
  }

  create(principal: RequestPrincipal, body: CollectionCreateRequest): CollectionDetailDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const description = body.description?.trim();
      const now = this.now();
      const collection: Collection = {
        id: this.newId(),
        userId: owner,
        name: body.name,
        ...(description === undefined || description === "" ? {} : { description }),
        createdAt: now,
        updatedAt: now,
      };
      scope.collections.insert(collection);
      scope.search.syncCollection(owner, collection.id);
      return detail(scope, owner, collection);
    });
  }

  patch(principal: RequestPrincipal, collectionId: string, body: CollectionPatchRequest): CollectionDetailDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedCollection(scope, owner, collectionId);
      const description = body.description === null ? undefined : body.description?.trim();
      scope.collections.update(owner, collectionId, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: description === "" ? undefined : description }),
      });
      scope.collections.touch(owner, collectionId, this.now());
      scope.search.syncCollection(owner, collectionId);
      return detail(scope, owner, ownedCollection(scope, owner, collectionId));
    });
  }

  /** Member Contents stay; Tasks, items and summaries of the collection go with it. */
  delete(principal: RequestPrincipal, collectionId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      ownedCollection(scope, owner, collectionId);
      if (scope.tasks.listByCollection(owner, collectionId).some((task) => !isTerminalProjection(task.statusProjection))) {
        throw amberError("conflict", "an unfinished task works on this collection; cancel it first");
      }
      scope.collections.delete(owner, collectionId);
      scope.search.removeCollection(owner, collectionId);
    });
  }

  async addItem(principal: RequestPrincipal, collectionId: string, body: CollectionItemAddRequest, idempotencyKey?: string): Promise<CollectionItemAddResult> {
    const owner = principal.userId;
    if (body.url !== undefined) {
      const importContent = this.options.importContent;
      if (importContent === undefined) {
        throw amberError("invalid_request", "adding by URL is not available here", { params: { detail: "url" } });
      }
      this.options.repository.withTransaction((scope) => ownedCollection(scope, owner, collectionId));
      const result = await importContent.import(
        principal,
        { items: [{ url: body.url }], settings: body.settings ?? { autoProofread: true }, collection: { id: collectionId } },
        idempotencyKey,
      );
      return { status: 202, body: result.body };
    }
    const contentId = body.contentId as string;
    return this.options.repository.withTransaction((scope) => {
      ownedCollection(scope, owner, collectionId);
      if (scope.contents.get(owner, contentId) === undefined) {
        throw amberError("not_found", "content not found");
      }
      let item = scope.collections.findItem(owner, collectionId, contentId);
      if (item === undefined) {
        const position = scope.collections.listItems(owner, collectionId).reduce((max, existing) => Math.max(max, existing.position), -1) + 1;
        item = { id: this.newId(), collectionId, contentId, position, addedAt: this.now() };
        scope.collections.addItem(owner, item);
        scope.collections.touch(owner, collectionId, item.addedAt);
      }
      return { status: 200, body: itemDto(scope, owner, item) };
    });
  }

  /** A member in the trash cannot be removed: it is not there as far as the user can see. */
  removeItem(principal: RequestPrincipal, collectionId: string, itemId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      ownedCollection(scope, owner, collectionId);
      const item = scope.collections.getItem(owner, itemId);
      if (item === undefined || item.collectionId !== collectionId || scope.contents.get(owner, item.contentId) === undefined) {
        throw amberError("not_found", "collection item not found");
      }
      if (!scope.collections.removeItem(owner, collectionId, itemId)) {
        throw amberError("not_found", "collection item not found");
      }
      scope.collections.touch(owner, collectionId, this.now());
    });
  }

  /**
   * `itemIds` must be the complete new order of the visible items: each exactly once. They
   * are reordered within the positions they hold, so members in the trash keep theirs.
   */
  reorder(principal: RequestPrincipal, collectionId: string, itemIds: readonly string[]): CollectionDetailDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const collection = ownedCollection(scope, owner, collectionId);
      const present = scope.collections.listVisibleItems(owner, collectionId).map((item) => item.id);
      const given = new Set(itemIds);
      if (given.size !== itemIds.length || given.size !== present.length || present.some((id) => !given.has(id))) {
        throw amberError("invalid_request", "itemIds must list every item of the collection exactly once", { params: { detail: "itemIds" } });
      }
      scope.collections.reorder(owner, collectionId, itemIds);
      scope.collections.touch(owner, collectionId, this.now());
      return detail(scope, owner, ownedCollection(scope, owner, collectionId));
    });
  }

  /**
   * While any member the current revision summarised is in the trash, the revision itself is
   * withheld (`hiddenReason: member_trashed`): its body, citations and partials draw on that
   * member. It shows again once the member is restored; once purged or removed from the
   * collection, the usual staleness applies.
   */
  getSummary(principal: RequestPrincipal, collectionId: string): CollectionSummaryDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedCollection(scope, owner, collectionId);
      const artifact = scope.collectionSummaries.getArtifact(owner, collectionId);
      const current = scope.collectionSummaries.getCurrent(owner, collectionId);
      const active = scope.tasks.listByCollection(owner, collectionId).find((task) => !isTerminalProjection(task.statusProjection));
      if (current !== undefined && trashedMembersOf(scope, owner, current).length > 0) {
        return {
          ...(artifact === undefined ? {} : { artifactId: artifact.id }),
          stale: true,
          staleReason: "member_changed",
          hiddenReason: "member_trashed",
          ...(active === undefined ? {} : { activeTaskId: active.id }),
        };
      }
      const freshness: Freshness =
        current === undefined
          ? { stale: false }
          : deriveCollectionFreshness(
              [...current.inputItems].sort((a, b) => a.position - b.position).map(snapshotState),
              memberStates(scope, owner, collectionId),
            );
      return {
        ...(artifact === undefined ? {} : { artifactId: artifact.id }),
        ...(current === undefined ? {} : { current: collectionSummaryRevisionDto(scope, owner, current, freshness) }),
        ...(freshness.stale ? { stale: true, staleReason: freshness.staleReason } : { stale: false }),
        ...(active === undefined ? {} : { activeTaskId: active.id }),
      };
    });
  }

  async createSummary(
    principal: RequestPrincipal,
    collectionId: string,
    body: CollectionSummaryRequest,
    idempotencyKey?: string,
  ): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const context = { userId: owner, route: COLLECTION_SUMMARY_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest({ collectionId, body }) };
    const replay = this.options.repository.withTransaction((scope) =>
      idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, COLLECTION_SUMMARY_ROUTE, idempotencyKey),
    );
    if (replay === undefined) {
      const low = await diskLowError(this.options.disk, this.options.settings.effective());
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark");
      }
    }
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
      runIdempotent(scope, context, this.now(), () => {
        ownedCollection(scope, owner, collectionId);
        if (body.modelRef !== undefined) {
          const problem = modelRefProblem(scope, owner, body.modelRef);
          if (problem !== undefined) {
            throw amberError("invalid_request", problem, { params: { detail: "modelRef" } });
          }
        }
        const items = scope.collections.listVisibleItems(owner, collectionId);
        if (items.length === 0) {
          throw amberError("invalid_request", "the collection has no items", { params: { detail: "items" } });
        }
        const inputItems: SummarizeCollectionRequest["inputItems"] = [];
        const missing: string[] = [];
        for (const item of items) {
          const state = memberState(scope, owner, item.contentId);
          if (state.summaryRevisionId === undefined || state.transcriptRevisionId === undefined) {
            missing.push(item.contentId);
            continue;
          }
          inputItems.push({
            collectionItemId: item.id,
            contentId: item.contentId,
            summaryRevisionId: state.summaryRevisionId,
            transcriptRevisionId: state.transcriptRevisionId,
            position: item.position,
          });
        }
        if (missing.length > 0) {
          throw amberError("invalid_request", "some members have no core summary yet", {
            code: "invalid_request.collection_summary_missing",
            details: { missingContentIds: missing },
          });
        }
        const requestJson = canonicalJson(
          summarizeCollectionRequestSchema.parse({
            requestSchemaVersion: 1,
            kind: "summarize_collection",
            ...(body.modelRef === undefined ? {} : { modelRef: body.modelRef }),
            outputLanguage: outputLanguageFor(scope, owner, body.outputLanguage),
            inputItems,
          }),
        );
        const candidate = { id: "", kind: "summarize_collection" as const, requestJson };
        const others = scope.tasks
          .listByCollection(owner, collectionId)
          .filter((task) => !isTerminalProjection(task.statusProjection))
          .map((task) => ({ task, keys: laneKeys(task, undefined) }));
        const blocking = laneConflict(laneKeys(candidate, undefined), others);
        if (blocking !== undefined) {
          throw mutationLaneError(blocking, "another unfinished task summarizes this collection");
        }
        const task = createTask(scope, outbox, {
          task: { id: this.newId(), userId: owner, collectionId, kind: "summarize_collection", requestJson, createdAt: this.now() },
          sourceKind: undefined,
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

function collectionDto(collection: Collection, itemCount: number): CollectionDto {
  return {
    id: collection.id,
    name: collection.name,
    ...(collection.description === undefined ? {} : { description: collection.description }),
    ...(collection.platformCollectionId === undefined ? {} : { platformCollectionId: collection.platformCollectionId }),
    itemCount,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

function detail(scope: RepositoryScope, owner: string, collection: Collection): CollectionDetailDto {
  const items = scope.collections.listVisibleItems(owner, collection.id);
  return { ...collectionDto(collection, items.length), items: items.map((item) => itemDto(scope, owner, item)) };
}

function itemDto(scope: RepositoryScope, owner: string, item: CollectionItem): CollectionItemDto {
  const content = scope.contents.get(owner, item.contentId);
  if (content === undefined) {
    throw amberError("internal", "a collection item without its content");
  }
  const title = displayTitle(content);
  return {
    id: item.id,
    contentId: item.contentId,
    position: item.position,
    addedAt: item.addedAt,
    ...(title === undefined ? {} : { title }),
    ...(content.coverUrl === undefined ? {} : { coverUrl: content.coverUrl }),
    ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
    processingStatus: content.processingStatus,
    ...(content.pinnedAt === undefined ? {} : { pinnedAt: content.pinnedAt }),
    ...(content.source.sourceUrl === undefined ? {} : { sourceUrl: content.source.sourceUrl }),
  };
}

/** A member's `summary.core` current revision and primary transcript (with its ancestors) as they are now. */
function memberState(scope: RepositoryScope, owner: string, contentId: string): CollectionMemberState {
  const content = scope.contents.get(owner, contentId);
  const artifact = scope.summaries.findArtifact(owner, contentId, DEFAULT_SUMMARY_TEMPLATE_ID);
  const primaryId = content?.primaryTranscriptRevisionId;
  return {
    contentId,
    ...(artifact?.currentRevisionId === undefined ? {} : { summaryRevisionId: artifact.currentRevisionId }),
    ...(primaryId === undefined ? {} : { transcriptRevisionId: primaryId, transcriptAncestors: transcriptAncestors(primaryId, scope.transcripts.listRevisions(owner, contentId)) }),
  };
}

function memberStates(scope: RepositoryScope, owner: string, collectionId: string): CollectionMemberState[] {
  return scope.collections.listVisibleItems(owner, collectionId).map((item) => memberState(scope, owner, item.contentId));
}

/** The Contents a `summarize_collection` request froze as its input. */
export function frozenMemberIds(requestJson: string): string[] {
  const request = summarizeCollectionRequestSchema.safeParse(JSON.parse(requestJson));
  return request.success ? request.data.inputItems.map((item) => item.contentId) : [];
}

/** Members a collection summary revision summarised that are in the trash now; purged ones are not counted. */
export function trashedMembersOf(scope: RepositoryScope, owner: string, revision: Pick<CollectionSummaryRevision, "inputItems">): string[] {
  return revision.inputItems
    .map((item) => item.contentId)
    .filter((contentId) => scope.contents.getIncludingTrashed(owner, contentId)?.trashedAt !== undefined);
}

function snapshotState(item: CollectionSummaryRevision["inputItems"][number]): CollectionMemberState {
  return {
    contentId: item.contentId,
    ...(item.summaryRevisionId === undefined ? {} : { summaryRevisionId: item.summaryRevisionId }),
    ...(item.transcriptRevisionId === undefined ? {} : { transcriptRevisionId: item.transcriptRevisionId }),
  };
}

function collectionSummaryRevisionDto(
  scope: RepositoryScope,
  owner: string,
  revision: CollectionSummaryRevision,
  freshness: Freshness,
): CollectionSummaryRevisionDto {
  const { provenance } = revision;
  return {
    id: revision.id,
    artifactId: revision.artifactId,
    body: revision.body,
    citations: revision.citations.map((citation) => ({ ...citation })),
    inputItems: revision.inputItems.map((item) => ({ ...item })),
    partials: scope.rollupPartials.listByOwnerRevision(owner, revision.id).map((partial) => ({
      id: partial.id,
      index: partial.index,
      body: partial.body,
      citations: partial.citations.map((citation) => ({ ...citation })),
      createdAt: partial.createdAt,
    })),
    ...(provenance.modelRef === undefined ? {} : { modelRef: { ...provenance.modelRef } }),
    ...(provenance.promptRef === undefined ? {} : { promptRef: { ...provenance.promptRef } }),
    quality: revision.quality,
    qualityReasons: qualityReasonsOf(revision.quality),
    ...(freshness.stale ? { stale: true, staleReason: freshness.staleReason } : { stale: false }),
    createdAt: provenance.createdAt,
  };
}

function ownedCollection(scope: RepositoryScope, owner: string, collectionId: string): Collection {
  const collection = scope.collections.get(owner, collectionId);
  if (collection === undefined) {
    throw amberError("not_found", "collection not found");
  }
  return collection;
}
