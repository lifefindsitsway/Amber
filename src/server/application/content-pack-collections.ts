import { monotonicFactory } from "ulid";
import type { PackCollectionDecision, PackCollectionResult, PackPreviewCollection } from "../../shared/dto/content-pack.ts";
import type { AppError } from "../../shared/errors.ts";
import type { Collection } from "../domain/collection.ts";
import { mergeCollectionOrder } from "../domain/collection-merge.ts";
import type { CollectionsDocument } from "../domain/content-pack/document.ts";
import { originOf } from "../domain/content-pack/identity.ts";
import { AmberError, amberError, appError, isAmberError } from "../domain/errors.ts";
import type { PackDocuments } from "../ports/content-pack.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { PackCollectionsEngine } from "./content-pack-engine.ts";

export interface PackCollectionsOptions {
  repository: Repository;
  logger?: Logger;
  newId?: () => string;
}

type CarriedCollection = CollectionsDocument["collections"][number];

/**
 * Collections carried by content packs: matching at preview and the per-collection merge after
 * the Contents.
 *
 * A carried collection is the same as a local one when the local one has its transfer identity,
 * the user merged it there before, or both stand for the same platform collection; a local one
 * that only shares the name is offered but never merged without the user's choice. The pack's
 * ids are foreign data: they only suggest a target, and every write is scoped to the owner of
 * the session.
 *
 * Joining never renames, never rewrites the description and never reorders what is here: the
 * merged order comes from `mergeCollectionOrder` over every member as it is inside the
 * committing transaction (trashed ones included), so edits made after the preview are kept.
 */
export function createPackCollections(options: PackCollectionsOptions): PackCollectionsEngine {
  const newId = options.newId ?? monotonicFactory();
  const repository = options.repository;

  return {
    preview(ownerUserId, documents) {
      return repository.withTransaction((scope) => {
        const local = scope.collections.list(ownerUserId);
        const visibleCount = new Map<string, number>();
        const memberCount = (collectionId: string): number => {
          let count = visibleCount.get(collectionId);
          if (count === undefined) {
            count = scope.collections.listVisibleItems(ownerUserId, collectionId).length;
            visibleCount.set(collectionId, count);
          }
          return count;
        };
        return uniqueCollections(documents).map((carried): PackPreviewCollection => {
          const same = sameCollections(scope, ownerUserId, carried, local);
          const sameName = same.length > 0 ? [] : local.filter((collection) => namesMatch(collection.name, carried.name));
          const match: PackPreviewCollection["match"] = same.length > 0 ? "same" : sameName.length > 0 ? "same_name" : "new";
          return {
            key: carried.key,
            name: carried.name,
            ...(carried.description === undefined ? {} : { description: carried.description }),
            contentKeys: unique(carried.contentKeys),
            match,
            candidates: (same.length > 0 ? same : sameName).map((collection) => ({
              collectionId: collection.id,
              name: collection.name,
              memberCount: memberCount(collection.id),
            })),
          };
        });
      });
    },

    commit(ownerUserId, documents, decisions, contentIds, now) {
      const carried = new Map(uniqueCollections(documents).map((collection) => [collection.key, collection]));
      const decided = new Set<string>();
      const results: PackCollectionResult[] = [];
      for (const decision of decisions) {
        // A key decided twice is written once; the first decision stands.
        if (decided.has(decision.key)) continue;
        decided.add(decision.key);
        const collection = carried.get(decision.key);
        if (collection === undefined) {
          results.push(failed(decision.key, "", appError("invalid_request", { params: { detail: "collections" } })));
          continue;
        }
        results.push(commitOne(ownerUserId, collection, decision, contentIds, now));
      }
      return results;
    },
  };

  function commitOne(
    owner: string,
    carried: CarriedCollection,
    decision: PackCollectionDecision,
    contentIds: ReadonlyMap<string, string>,
    now: number,
  ): PackCollectionResult {
    if (decision.action === "skip") {
      return { key: carried.key, name: carried.name, status: "skipped", added: 0 };
    }
    try {
      return repository.withTransaction((scope) =>
        decision.action === "create" ? create(scope, owner, carried, decision, contentIds, now) : join(scope, owner, carried, decision, contentIds, now),
      );
    } catch (error) {
      if (isAmberError(error)) return failed(carried.key, carried.name, error.appError);
      options.logger?.error("content_pack.collection_commit_failed", { key: carried.key, error: error instanceof Error ? error.message : String(error) });
      return failed(carried.key, carried.name, appError("internal"));
    }
  }

  function create(
    scope: RepositoryScope,
    owner: string,
    carried: CarriedCollection,
    decision: PackCollectionDecision,
    contentIds: ReadonlyMap<string, string>,
    now: number,
  ): PackCollectionResult {
    if (decision.targetCollectionId !== undefined) throw invalidDecision();
    const members = addableMembers(scope, owner, carried, contentIds, new Set());
    // A collection none of whose carried members made it would arrive empty: nothing is created
    // and the result says nothing was added.
    if (members.length === 0) return { key: carried.key, name: carried.name, status: "skipped", added: 0 };
    const description = carried.description?.trim();
    const collection: Collection = {
      id: newId(),
      userId: owner,
      name: carried.name,
      ...(description === undefined || description === "" ? {} : { description }),
      ...(carried.platformCollectionId === undefined ? {} : { platformCollectionId: carried.platformCollectionId }),
      originId: carried.key,
      createdAt: now,
      updatedAt: now,
    };
    scope.collections.insert(collection);
    scope.collections.renumber(owner, collection.id, members, now);
    scope.search.syncCollection(owner, collection.id);
    return { key: carried.key, name: carried.name, status: "created", collectionId: collection.id, added: members.length };
  }

  function join(
    scope: RepositoryScope,
    owner: string,
    carried: CarriedCollection,
    decision: PackCollectionDecision,
    contentIds: ReadonlyMap<string, string>,
    now: number,
  ): PackCollectionResult {
    const targetId = decision.targetCollectionId;
    if (targetId === undefined) throw invalidDecision();
    const target = scope.collections.get(owner, targetId);
    if (target === undefined) throw amberError("not_found", "collection not found");
    // Joining a collection that is not the carried one by identity is the user's choice: it is
    // remembered so the next pack from the same collection is matched without asking.
    if (originOf(target) !== carried.key) {
      scope.transferOrigins.addCollectionTarget(owner, carried.key, target.id, now);
    }
    const local = scope.collections.listItems(owner, target.id).map((item) => item.contentId);
    const present = new Set(local);
    const carriedHere = addableMembers(scope, owner, carried, contentIds, present);
    const added = carriedHere.filter((contentId) => !present.has(contentId)).length;
    if (added === 0) {
      return { key: carried.key, name: carried.name, status: "joined", collectionId: target.id, added: 0 };
    }
    scope.collections.renumber(owner, target.id, mergeCollectionOrder(local, carriedHere), now);
    scope.collections.touch(owner, target.id, now);
    return { key: carried.key, name: carried.name, status: "joined", collectionId: target.id, added };
  }
}

/**
 * The carried members that may stand in the collection, in the pack's order, as local Content
 * ids: those the import landed (Contents skipped or failed have no local id) that are either
 * members already or visible Contents of the owner. A Content trashed since its commit is not
 * enrolled; one already a member, trashed or not, still anchors the placement of new ones.
 */
function addableMembers(
  scope: RepositoryScope,
  owner: string,
  carried: CarriedCollection,
  contentIds: ReadonlyMap<string, string>,
  present: ReadonlySet<string>,
): string[] {
  const members: string[] = [];
  const seen = new Set<string>();
  for (const key of carried.contentKeys) {
    const contentId = contentIds.get(key);
    if (contentId === undefined || seen.has(contentId)) continue;
    if (!present.has(contentId) && scope.contents.get(owner, contentId) === undefined) continue;
    seen.add(contentId);
    members.push(contentId);
  }
  return members;
}

/** Local collections that are the carried one: by transfer identity, an earlier merge, or the platform collection. */
function sameCollections(scope: RepositoryScope, owner: string, carried: CarriedCollection, local: readonly Collection[]): Collection[] {
  const byId = new Map(local.map((collection) => [collection.id, collection]));
  const found = new Map<string, Collection>();
  for (const collection of scope.transferOrigins.collectionsByIdentity(owner, carried.key)) found.set(collection.id, collection);
  for (const collectionId of scope.transferOrigins.collectionTargets(owner, carried.key)) {
    const collection = byId.get(collectionId);
    if (collection !== undefined && !found.has(collectionId)) found.set(collectionId, collection);
  }
  if (carried.platformCollectionId !== undefined) {
    for (const collection of local) {
      if (collection.platformCollectionId === carried.platformCollectionId && !found.has(collection.id)) found.set(collection.id, collection);
    }
  }
  return [...found.values()];
}

function namesMatch(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** A collection listed twice in a pack is taken once, its first listing standing. */
function uniqueCollections(documents: PackDocuments): CarriedCollection[] {
  const seen = new Set<string>();
  return documents.collections.collections.filter((collection) => {
    if (seen.has(collection.key)) return false;
    seen.add(collection.key);
    return true;
  });
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

function invalidDecision(): AmberError {
  return amberError("invalid_request", "a collection decision names a target only to join it", { params: { detail: "collections" } });
}

function failed(key: string, name: string, error: AppError): PackCollectionResult {
  return { key, name, status: "failed", added: 0, error };
}
