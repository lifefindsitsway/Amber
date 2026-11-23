import type { Page, Request, Route } from "@playwright/test";
import {
  collectionDeletePlanDtoSchema,
  collectionDeleteRequestSchema,
  collectionDeleteResultDtoSchema,
  collectionDetailDtoSchema,
  collectionItemsRemoveRequestSchema,
  collectionListDtoSchema,
  collectionSummaryDtoSchema,
  type CollectionDeletePlanDto,
  type CollectionDeleteResultDto,
} from "../../src/shared/dto/collection.ts";
import { ERROR_CLASS_DEFAULTS, errorResponseSchema, type ErrorClass } from "../../src/shared/errors.ts";
import type { MockTrash } from "./mock-trash.ts";

/*
 * The browser smoke's fake of the user's collections, for the pages that delete a collection
 * (with or without its members) and remove members in bulk. A test opts in per page with
 * `mockCollections(page, backend.trash)` and seeds collections whose members are Contents the
 * fake library knows; pages that never opt in keep the backend's empty collection list.
 *
 * Deleting with `contents: "exclusive"` moves the members found in no other collection to the
 * fake trash (cancelling their seeded Tasks first), so the trash page and the library show the
 * outcome. A repeated `Idempotency-Key` answers the first result.
 */

/** A member as the collection page lists it; the Content must be known to the fake library. */
export interface MockMember {
  contentId: string;
  title: string;
}

export interface MockCollectionSeed {
  id: string;
  name: string;
  members: MockMember[];
  /** Unfinished Tasks of the collection itself (its summary). */
  collectionTasks?: number;
}

export interface MockCollections {
  seed(collection: MockCollectionSeed): void;
  /** Ids of the collections that still exist. */
  ids(): string[];
  /** The Content ids of a collection's members, trashed ones included; undefined once it is deleted. */
  members(collectionId: string): string[] | undefined;
}

interface StoredCollection {
  id: string;
  name: string;
  members: MockMember[];
  collectionTasks: number;
}

class CollectionsState {
  readonly collections = new Map<string, StoredCollection>();
  readonly replies = new Map<string, CollectionDeleteResultDto>();
  readonly trash: MockTrash;

  constructor(trash: MockTrash) {
    this.trash = trash;
  }

  hidden(contentId: string): boolean {
    return this.trash.ids().includes(contentId) || this.trash.purged().includes(contentId);
  }

  visible(collection: StoredCollection): MockMember[] {
    return collection.members.filter((member) => !this.hidden(member.contentId));
  }

  plan(collection: StoredCollection): CollectionDeletePlanDto {
    const visible = this.visible(collection);
    const elsewhere = (contentId: string) =>
      [...this.collections.values()].some((other) => other.id !== collection.id && other.members.some((member) => member.contentId === contentId));
    const exclusive = visible.filter((member) => !elsewhere(member.contentId)).map((member) => member.contentId);
    return collectionDeletePlanDtoSchema.parse({
      memberCount: visible.length,
      exclusiveContentIds: exclusive,
      sharedCount: visible.length - exclusive.length,
      trashedMemberCount: collection.members.length - visible.length,
      exclusiveWithTasksCount: exclusive.filter((contentId) => this.trash.unfinishedTasks(contentId) > 0).length,
      collectionTaskCount: collection.collectionTasks,
      blocked: [],
    });
  }

  detail(collection: StoredCollection) {
    const items = this.visible(collection).map((member, index) => ({
      id: `${collection.id}-item-${member.contentId}`,
      contentId: member.contentId,
      position: index,
      addedAt: 0,
      title: member.title,
      processingStatus: "succeeded",
      source: { kind: "youtube" },
      updatedAt: 0,
    }));
    return collectionDetailDtoSchema.parse({ id: collection.id, name: collection.name, itemCount: items.length, createdAt: 0, updatedAt: 0, items });
  }
}

const states = new WeakMap<Page, CollectionsState>();

/** Gives `page` its own fake collections, deleting members into `trash`. */
export function mockCollections(page: Page, trash: MockTrash): MockCollections {
  const state = new CollectionsState(trash);
  states.set(page, state);
  return {
    seed: (collection) => state.collections.set(collection.id, { ...collection, members: [...collection.members], collectionTasks: collection.collectionTasks ?? 0 }),
    ids: () => [...state.collections.keys()],
    members: (collectionId) => state.collections.get(collectionId)?.members.map((member) => member.contentId),
  };
}

function errorBody(errorClass: ErrorClass, code: string, details?: Record<string, unknown>): unknown {
  return errorResponseSchema.parse({
    error: { class: errorClass, code, retryDisposition: ERROR_CLASS_DEFAULTS[errorClass].retryDisposition ?? "never", userMessage: "", ...(details === undefined ? {} : { details }) },
  });
}

function stateOf(request: Request): CollectionsState | undefined {
  try {
    return states.get(request.frame().page());
  } catch {
    // Requests without a frame (service workers) never belong to a page that opted in.
    return undefined;
  }
}

/**
 * `GET /api/collections`, a collection's detail and summary, its delete plan, both ways of
 * deleting it and the bulk removal of members, for a page that opted in through
 * `mockCollections`. Answers `false` for anything it does not handle.
 */
export async function handleCollections(route: Route, request: Request, url: URL): Promise<boolean> {
  const state = stateOf(request);
  if (state === undefined) return false;
  const method = request.method();
  const path = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (method === "GET" && path === "/api/collections") {
    const items = [...state.collections.values()].map((collection) => {
      const { items: members, ...rest } = state.detail(collection);
      return { ...rest, itemCount: members.length };
    });
    return (await json(collectionListDtoSchema.parse({ items })), true);
  }
  const match = /^\/api\/collections\/([^/]+)(\/.*)?$/.exec(path);
  if (match === null) return false;
  const collection = state.collections.get(decodeURIComponent(match[1] as string));
  const rest = match[2] ?? "";
  const notFound = () => json(errorBody("not_found", "not_found"), 404);
  const key = request.headers()["idempotency-key"];
  if (method === "POST" && rest === "/delete" && key !== undefined && state.replies.has(key)) {
    return (await json(state.replies.get(key)), true);
  }
  if (collection === undefined) return (await notFound(), true);

  if (method === "GET" && rest === "") return (await json(state.detail(collection)), true);
  if (method === "GET" && rest === "/summary") return (await json(collectionSummaryDtoSchema.parse({ stale: false })), true);
  if (method === "GET" && rest === "/delete-plan") return (await json(state.plan(collection)), true);
  if (method === "DELETE" && rest === "") {
    state.collections.delete(collection.id);
    return (await route.fulfill({ status: 204, body: "" }), true);
  }
  if (method === "POST" && rest === "/delete") {
    const body = collectionDeleteRequestSchema.parse(request.postDataJSON());
    const plan = state.plan(collection);
    const needsCancel = plan.collectionTaskCount > 0 || (body.contents === "exclusive" && plan.exclusiveWithTasksCount > 0);
    if (needsCancel && !body.cancelTasks) return (await json(errorBody("conflict", "conflict.tasks_unfinished"), 409), true);
    if (body.contents === "exclusive" && JSON.stringify(body.expectedContentIds) !== JSON.stringify(plan.exclusiveContentIds)) {
      return (await json(errorBody("conflict", "conflict.collection_members_changed", { cancelledTaskCount: 0 }), 409), true);
    }
    let cancelledTaskCount = body.cancelTasks ? plan.collectionTaskCount : 0;
    const trashedIds = body.contents === "exclusive" ? plan.exclusiveContentIds : [];
    for (const contentId of trashedIds) {
      cancelledTaskCount += state.trash.unfinishedTasks(contentId);
      if (state.trash.unfinishedTasks(contentId) > 0) state.trash.seedTasks(contentId, 0);
      state.trash.seed(contentId);
    }
    state.collections.delete(collection.id);
    const result = collectionDeleteResultDtoSchema.parse({ trashedIds, cancelledTaskCount });
    if (key !== undefined) state.replies.set(key, result);
    return (await json(result), true);
  }
  if (method === "POST" && rest === "/items/remove") {
    const { contentIds } = collectionItemsRemoveRequestSchema.parse(request.postDataJSON());
    const visible = new Set(state.visible(collection).map((member) => member.contentId));
    // One transaction: a single id that is not a visible member refuses the whole request.
    if (contentIds.some((contentId) => !visible.has(contentId))) return (await notFound(), true);
    const leaving = new Set(contentIds);
    collection.members = collection.members.filter((member) => !leaving.has(member.contentId));
    return (await json(state.detail(collection)), true);
  }
  return false;
}
