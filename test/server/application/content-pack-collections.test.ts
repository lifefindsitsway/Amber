import { monotonicFactory } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PackCollectionDecision, PackCollectionResult } from "../../../src/shared/dto/content-pack.ts";
import type { SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { createPackCollections } from "../../../src/server/application/content-pack-collections.ts";
import type { PackCollectionsEngine } from "../../../src/server/application/content-pack-engine.ts";
import { collectionsDocumentSchema, type CollectionsDocument, type ContentPackHeader } from "../../../src/server/domain/content-pack/document.ts";
import type { PackDocuments } from "../../../src/server/ports/content-pack.ts";
import type { NotPromise, RepositoryScope } from "../../../src/server/ports/repository.ts";
import { insertRow, openTempDatabase } from "../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const NAME = "检索增强生成课程";

let db: SqliteConnection;
let repository: SqliteRepository;
let engine: PackCollectionsEngine;
const newId = monotonicFactory();

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  engine = createPackCollections({ repository, newId });
});
afterEach(() => db.close());

const run = <T>(work: (scope: RepositoryScope) => NotPromise<T>): T => repository.withTransaction(work);

function addContent(owner: string, id: string = newId()): string {
  insertRow(db, "content", { id, user_id: owner, source_kind: "local", processing_status: "none", title: id, created_at: T0, updated_at: T0 });
  return id;
}

function addCollection(owner: string, members: readonly string[], fields: { name?: string; originId?: string; platformCollectionId?: string; positions?: number[] } = {}): string {
  const id = newId();
  run((scope) => {
    scope.collections.insert({
      id,
      userId: owner,
      name: fields.name ?? "本机合集",
      ...(fields.originId === undefined ? {} : { originId: fields.originId }),
      ...(fields.platformCollectionId === undefined ? {} : { platformCollectionId: fields.platformCollectionId }),
      createdAt: T0,
      updatedAt: T0,
    });
    members.forEach((contentId, index) =>
      scope.collections.addItem(owner, { id: newId(), collectionId: id, contentId, position: fields.positions?.[index] ?? index, addedAt: T0 }),
    );
  });
  return id;
}

/** A pack holding only collections: the collections engine reads nothing else of it. */
function pack(collections: CollectionsDocument["collections"]): PackDocuments {
  return {
    header: {} as ContentPackHeader,
    collections: collectionsDocumentSchema.parse({ collections }),
    contents: [],
    digests: new Map(),
  };
}

const members = (owner: string, collectionId: string): string[] => run((scope) => scope.collections.listItems(owner, collectionId).map((item) => item.contentId));
const collection = (owner: string, collectionId: string) => run((scope) => scope.collections.get(owner, collectionId));
const commit = (owner: string, documents: PackDocuments, decisions: PackCollectionDecision[], contentIds: Map<string, string>, now = T0 + 1000): PackCollectionResult[] =>
  engine.commit(owner, documents, decisions, contentIds, now);

/** What the import mapped: carried key → the local Content (imported fresh here). */
function landed(owner: string, keys: readonly string[]): Map<string, string> {
  return new Map(keys.map((key) => [key, addContent(owner)]));
}

describe("content pack collections: preview", () => {
  it("matches by identity, an earlier merge or the platform collection; a mere name match is offered, never merged", () => {
    const byIdentity = addCollection("alice", [addContent("alice")], { name: "改过名", originId: "K-IDENTITY" });
    const mapped = addCollection("alice", [], { name: "别的名字" });
    run((scope) => scope.transferOrigins.addCollectionTarget("alice", "K-MAPPED", mapped, T0));
    const platform = addCollection("alice", [], { name: "平台合集", platformCollectionId: "season_9" });
    const named = addCollection("alice", [addContent("alice"), addContent("alice")], { name: NAME });
    const documents = pack([
      { key: "K-IDENTITY", name: "原名", contentKeys: ["a"] },
      { key: "K-MAPPED", name: "随便", contentKeys: ["a"] },
      { key: "K-PLATFORM", name: "B 站合集", platformCollectionId: "season_9", contentKeys: ["a"] },
      { key: "K-NAMED", name: NAME, description: "说明", contentKeys: ["a", "b", "a"] },
      { key: "K-NEW", name: "全新", contentKeys: ["b"] },
    ]);
    const preview = engine.preview("alice", documents);
    expect(preview.map((item) => [item.key, item.match, item.candidates])).toEqual([
      ["K-IDENTITY", "same", [{ collectionId: byIdentity, name: "改过名", memberCount: 1 }]],
      ["K-MAPPED", "same", [{ collectionId: mapped, name: "别的名字", memberCount: 0 }]],
      ["K-PLATFORM", "same", [{ collectionId: platform, name: "平台合集", memberCount: 0 }]],
      ["K-NAMED", "same_name", [{ collectionId: named, name: NAME, memberCount: 2 }]],
      ["K-NEW", "new", []],
    ]);
    expect(preview[3]).toMatchObject({ name: NAME, description: "说明", contentKeys: ["a", "b"] });
  });

  it("lists every candidate when one source matches several local collections", () => {
    const first = addCollection("alice", [], { originId: "K" });
    const second = addCollection("alice", [], { name: "又一个" });
    run((scope) => scope.transferOrigins.addCollectionTarget("alice", "K", second, T0));
    const [item] = engine.preview("alice", pack([{ key: "K", name: "课", contentKeys: ["a"] }]));
    expect(item?.match).toBe("same");
    expect(item?.candidates.map((candidate) => candidate.collectionId)).toEqual([first, second]);
  });

  it("counts visible members only and never sees another user's collections", () => {
    const trashed = addContent("alice");
    const target = addCollection("alice", [addContent("alice"), trashed], { name: NAME, originId: "K" });
    run((scope) => scope.contents.trash("alice", trashed, T0 + 1));
    const documents = pack([{ key: "K", name: NAME, contentKeys: ["a"] }]);
    expect(engine.preview("alice", documents)[0]?.candidates).toEqual([{ collectionId: target, name: NAME, memberCount: 1 }]);
    expect(engine.preview("bob", documents)[0]).toMatchObject({ match: "new", candidates: [] });
  });
});

describe("content pack collections: commit", () => {
  it("creates a collection from 3 of 20 members in their relative order, with its name, description and identity", () => {
    const picked = ["m05", "m09", "m07"];
    const documents = pack([{ key: "K-COURSE", name: NAME, description: "二十讲", platformCollectionId: "season_9", contentKeys: picked }]);
    const contentIds = landed("alice", picked);
    const [result] = commit("alice", documents, [{ key: "K-COURSE", action: "create" }], contentIds);
    expect(result).toMatchObject({ key: "K-COURSE", name: NAME, status: "created", added: 3 });
    const id = result?.collectionId as string;
    expect(members("alice", id)).toEqual(picked.map((key) => contentIds.get(key)));
    expect(collection("alice", id)).toEqual({
      id,
      userId: "alice",
      name: NAME,
      description: "二十讲",
      platformCollectionId: "season_9",
      originId: "K-COURSE",
      createdAt: T0 + 1000,
      updatedAt: T0 + 1000,
    });
    expect(run((scope) => scope.collections.listItems("alice", id)).map((item) => item.position)).toEqual([0, 1, 2]);
    // The name is searchable like any collection created here.
    const hits = run((scope) => scope.search.query("alice", { terms: [NAME], mode: "fts", scope: { kind: "global" }, groupLimit: 10, likeLimit: 100 }));
    expect(hits).toContainEqual({ kind: "collection", collectionId: id, text: expect.stringContaining(NAME) });
  });

  it("leaves out Contents the import skipped or failed, and reports a collection with none of its members landed", () => {
    const documents = pack([
      { key: "K-PART", name: "部分", contentKeys: ["a", "b", "c"] },
      { key: "K-NONE", name: "全无", contentKeys: ["b"] },
    ]);
    const contentIds = landed("alice", ["a", "c"]);
    const results = commit("alice", documents, [{ key: "K-PART", action: "create" }, { key: "K-NONE", action: "create" }], contentIds);
    expect(results.map((result) => [result.key, result.status, result.added])).toEqual([["K-PART", "created", 2], ["K-NONE", "skipped", 0]]);
    expect(members("alice", results[0]?.collectionId as string)).toEqual([contentIds.get("a"), contentIds.get("c")]);
    expect(results[1]).not.toHaveProperty("collectionId");
    expect(run((scope) => scope.collections.list("alice")).map((item) => item.name)).toEqual(["部分"]);
  });

  it("puts a Content carried in two collections into both", () => {
    const documents = pack([
      { key: "K1", name: "合集一", contentKeys: ["shared", "x"] },
      { key: "K2", name: "合集二", contentKeys: ["y", "shared"] },
    ]);
    const contentIds = landed("alice", ["shared", "x", "y"]);
    const results = commit("alice", documents, [{ key: "K1", action: "create" }, { key: "K2", action: "create" }], contentIds);
    expect(results.map((result) => result.status)).toEqual(["created", "created"]);
    expect(members("alice", results[0]?.collectionId as string)).toEqual([contentIds.get("shared"), contentIds.get("x")]);
    expect(members("alice", results[1]?.collectionId as string)).toEqual([contentIds.get("y"), contentIds.get("shared")]);
  });

  it("never merges a same-named collection by itself; joining it by choice remembers the match and keeps its name", () => {
    const own = [addContent("alice"), addContent("alice")];
    const named = addCollection("alice", own, { name: NAME });
    const documents = pack([{ key: "K", name: NAME, description: "包里的说明", contentKeys: ["a"] }]);
    expect(engine.preview("alice", documents)[0]?.match).toBe("same_name");

    // The default: a new collection beside the local one.
    const first = commit("alice", documents, [{ key: "K", action: "create" }], landed("alice", ["a"]));
    expect(first[0]?.status).toBe("created");
    expect(first[0]?.collectionId).not.toBe(named);
    expect(members("alice", named)).toEqual(own);

    // The user picks the same-named one instead: members are added, name and description stay.
    const other = pack([{ key: "K-OTHER", name: NAME, description: "包里的说明", contentKeys: ["b"] }]);
    const contentIds = landed("alice", ["b"]);
    const joined = commit("alice", other, [{ key: "K-OTHER", action: "join", targetCollectionId: named }], contentIds);
    expect(joined[0]).toMatchObject({ status: "joined", collectionId: named, added: 1 });
    expect(members("alice", named)).toEqual([...own, contentIds.get("b")]);
    expect(collection("alice", named)).toMatchObject({ name: NAME, updatedAt: T0 + 1000 });
    expect(collection("alice", named)).not.toHaveProperty("description");
    expect(collection("alice", named)).not.toHaveProperty("originId");
    expect(run((scope) => scope.transferOrigins.collectionTargets("alice", "K-OTHER"))).toEqual([named]);
    // Next time the same source is recognised.
    expect(engine.preview("alice", other)[0]).toMatchObject({ match: "same", candidates: [{ collectionId: named }] });
  });

  it("importing the same pack again neither creates a second collection, adds duplicates nor reorders", () => {
    const keys = ["m03", "m04", "m05"];
    const documents = pack([{ key: "K", name: NAME, contentKeys: keys }]);
    const contentIds = landed("alice", keys);
    const [created] = commit("alice", documents, [{ key: "K", action: "create" }], contentIds);
    const id = created?.collectionId as string;
    // The user reorders here afterwards.
    const items = run((scope) => scope.collections.listItems("alice", id));
    run((scope) => scope.collections.reorder("alice", id, [items[2]?.id as string, items[0]?.id as string, items[1]?.id as string]));
    const before = run((scope) => scope.collections.listItems("alice", id));

    const [again] = engine.preview("alice", documents);
    expect(again).toMatchObject({ match: "same", candidates: [{ collectionId: id, memberCount: 3 }] });
    const [joined] = commit("alice", documents, [{ key: "K", action: "join", targetCollectionId: id }], contentIds, T0 + 5000);
    expect(joined).toMatchObject({ status: "joined", collectionId: id, added: 0 });
    expect(run((scope) => scope.collections.listItems("alice", id))).toEqual(before);
    expect(collection("alice", id)?.updatedAt).toBe(T0 + 1000);
    expect(run((scope) => scope.collections.list("alice"))).toHaveLength(1);
    // Joining by identity writes no manual match.
    expect(run((scope) => scope.transferOrigins.collectionTargets("alice", "K"))).toEqual([]);
  });

  it("a second pack joins the collection the first created and places its members by the rule", () => {
    const first = ["m05", "m06", "m07"];
    const ids = landed("alice", first);
    const [created] = commit("alice", pack([{ key: "K", name: NAME, contentKeys: first }]), [{ key: "K", action: "create" }], ids);
    const id = created?.collectionId as string;

    // Three more from the same 20: one carried member already here anchors them.
    const second = ["m04", "m05", "m08", "m09"];
    for (const [key, contentId] of landed("alice", ["m04", "m08", "m09"])) ids.set(key, contentId);
    const [joined] = commit("alice", pack([{ key: "K", name: NAME, contentKeys: second }]), [{ key: "K", action: "join", targetCollectionId: id }], ids, T0 + 2000);
    expect(joined).toMatchObject({ status: "joined", added: 3 });
    // m04 has nothing here before it: right before m05; m08 and m09 right after m05, in the pack's order.
    expect(members("alice", id)).toEqual(["m04", "m05", "m08", "m09", "m06", "m07"].map((key) => ids.get(key)));
    expect(collection("alice", id)?.updatedAt).toBe(T0 + 2000);

    // A pack whose members are all new appends them.
    for (const [key, contentId] of landed("alice", ["m19", "m20"])) ids.set(key, contentId);
    commit("alice", pack([{ key: "K", name: NAME, contentKeys: ["m19", "m20"] }]), [{ key: "K", action: "join", targetCollectionId: id }], ids);
    expect(members("alice", id).slice(-2)).toEqual([ids.get("m19"), ids.get("m20")]);
  });

  it("never changes the relative order of local members: reversed pack order, trashed members, duplicate positions", () => {
    const [c1, c2, c3, c4] = [addContent("alice"), addContent("alice"), addContent("alice"), addContent("alice")];
    // Stored positions tie in pairs, so the order is (position, id); c4 goes to the trash.
    const id = addCollection("alice", [c3 as string, c2 as string, c4 as string, c1 as string], { name: NAME, originId: "K", positions: [0, 0, 1, 1] });
    run((scope) => scope.contents.trash("alice", c4 as string, T0 + 1));
    const before = members("alice", id);
    const ids = new Map([["a", c1 as string], ["b", c2 as string], ["c", c3 as string]]);
    for (const [key, contentId] of landed("alice", ["n1", "n2"])) ids.set(key, contentId);
    // The pack orders the local members the other way round.
    const [joined] = commit("alice", pack([{ key: "K", name: NAME, contentKeys: ["a", "n1", "b", "n2", "c"] }]), [{ key: "K", action: "join", targetCollectionId: id }], ids);
    expect(joined).toMatchObject({ status: "joined", added: 2 });
    const after = members("alice", id);
    expect(after.filter((contentId) => before.includes(contentId))).toEqual(before);
    // n1 follows a (c1), n2 follows b (c2).
    expect(after.indexOf(ids.get("n1") as string)).toBe(after.indexOf(c1 as string) + 1);
    expect(after.indexOf(ids.get("n2") as string)).toBe(after.indexOf(c2 as string) + 1);
    expect(run((scope) => scope.collections.listItems("alice", id)).map((item) => item.position)).toEqual([0, 1, 2, 3, 4, 5]);
    // The trashed member is still there and still hidden.
    expect(run((scope) => scope.collections.listVisibleItems("alice", id)).map((item) => item.contentId)).not.toContain(c4);
  });

  it("enrols no Content that went to the trash after its commit, but lets a trashed member anchor new ones", () => {
    const [here, gone] = [addContent("alice"), addContent("alice")];
    const id = addCollection("alice", [here as string], { originId: "K" });
    run((scope) => scope.contents.trash("alice", here as string, T0 + 1));
    const ids = new Map([["here", here as string], ["gone", gone as string]]);
    for (const [key, contentId] of landed("alice", ["new"])) ids.set(key, contentId);
    run((scope) => scope.contents.trash("alice", gone as string, T0 + 2));
    const [joined] = commit("alice", pack([{ key: "K", name: "课", contentKeys: ["new", "gone", "here"] }]), [{ key: "K", action: "join", targetCollectionId: id }], ids);
    expect(joined).toMatchObject({ status: "joined", added: 1 });
    expect(members("alice", id)).toEqual([ids.get("new"), here]);
  });

  it("refuses another user's collection and bad decisions as failed results, without stopping the others", () => {
    const theirs = addCollection("bob", [addContent("bob")], { name: NAME });
    const documents = pack([
      { key: "K1", name: "一", contentKeys: ["a"] },
      { key: "K2", name: "二", contentKeys: ["a"] },
      { key: "K3", name: "三", contentKeys: ["a"] },
      { key: "K4", name: "四", contentKeys: ["a"] },
    ]);
    const contentIds = landed("alice", ["a"]);
    const results = commit(
      "alice",
      documents,
      [
        { key: "K1", action: "join", targetCollectionId: theirs },
        { key: "K2", action: "join" },
        { key: "K3", action: "create", targetCollectionId: theirs },
        { key: "MISSING", action: "create" },
        { key: "K4", action: "create" },
        { key: "K4", action: "create" },
      ],
      contentIds,
    );
    expect(results.map((result) => [result.key, result.status, result.error?.class])).toEqual([
      ["K1", "failed", "not_found"],
      ["K2", "failed", "invalid_request"],
      ["K3", "failed", "invalid_request"],
      ["MISSING", "failed", "invalid_request"],
      ["K4", "created", undefined],
    ]);
    expect(members("bob", theirs)).toHaveLength(1);
    expect(run((scope) => scope.transferOrigins.collectionTargets("alice", "K1"))).toEqual([]);
    expect(run((scope) => scope.collections.list("alice")).map((item) => item.name)).toEqual(["四"]);
  });

  it("rolls back one collection that fails midway and still writes the next", () => {
    const failing = createPackCollections({
      repository: {
        withTransaction: (work) =>
          repository.withTransaction((scope) => {
            const result = work(scope);
            if (scope.collections.list("alice").some((item) => item.name === "坏")) throw new Error("disk I/O error");
            return result;
          }),
      },
      newId,
    });
    const documents = pack([
      { key: "BAD", name: "坏", contentKeys: ["a"] },
      { key: "GOOD", name: "好", contentKeys: ["a"] },
    ]);
    const results = failing.commit("alice", documents, [{ key: "BAD", action: "create" }, { key: "GOOD", action: "create" }], landed("alice", ["a"]), T0);
    expect(results.map((result) => [result.key, result.status, result.error?.class])).toEqual([["BAD", "failed", "internal"], ["GOOD", "created", undefined]]);
    expect(run((scope) => scope.collections.list("alice")).map((item) => item.name)).toEqual(["好"]);
  });

  it("joins while a collection summary runs; the decision skip writes nothing", () => {
    const id = addCollection("alice", [addContent("alice")], { originId: "K" });
    insertRow(db, "task", { id: "t1", user_id: "alice", kind: "summarize_collection", collection_id: id, status_projection: "running", request_json: "{}", created_at: T0 });
    const contentIds = landed("alice", ["a"]);
    const documents = pack([{ key: "K", name: "课", contentKeys: ["a"] }]);
    expect(commit("alice", documents, [{ key: "K", action: "skip" }], contentIds)).toEqual([{ key: "K", name: "课", status: "skipped", added: 0 }]);
    expect(members("alice", id)).toHaveLength(1);
    expect(commit("alice", documents, [{ key: "K", action: "join", targetCollectionId: id }], contentIds)[0]).toMatchObject({ status: "joined", added: 1 });
  });
});
