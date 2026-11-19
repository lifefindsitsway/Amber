import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { NotPromise, RepositoryScope } from "../../../../../src/server/ports/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

const run = <T>(work: (scope: RepositoryScope) => NotPromise<T>): T => repository.withTransaction(work);

function content(id: string, userId: string, originId?: string, trashedAt?: number): void {
  insertRow(db, "content", {
    id,
    user_id: userId,
    source_kind: "local",
    processing_status: "none",
    created_at: T0,
    updated_at: T0,
    ...(originId === undefined ? {} : { origin_id: originId }),
    ...(trashedAt === undefined ? {} : { trashed_at: trashedAt }),
  });
}

function collection(id: string, userId: string, originId?: string): void {
  insertRow(db, "collection", { id, user_id: userId, name: id, created_at: T0, updated_at: T0, ...(originId === undefined ? {} : { origin_id: originId }) });
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

describe("transfer origin repository", () => {
  it("finds Contents by transfer identity: a stored origin, else the own id, trashed ones included", () => {
    content("c-own", "alice");
    content("c-carried", "alice", "origin-1");
    content("c-carried-trashed", "alice", "origin-1", T0 + 5);
    content("origin-1", "alice", "origin-9");
    content("c-bob", "bob", "origin-1");
    expect(run((scope) => scope.transferOrigins.contentsByIdentity("alice", "c-own")).map((item) => item.id)).toEqual(["c-own"]);
    // `origin-1` the id belongs to a Content whose identity is `origin-9`: not a match.
    expect(run((scope) => scope.transferOrigins.contentsByIdentity("alice", "origin-1")).map((item) => item.id).sort()).toEqual(["c-carried", "c-carried-trashed"]);
    expect(run((scope) => scope.transferOrigins.contentsByIdentity("alice", "origin-1")).find((item) => item.id === "c-carried")?.originId).toBe("origin-1");
    expect(run((scope) => scope.transferOrigins.contentsByIdentity("bob", "origin-1")).map((item) => item.id)).toEqual(["c-bob"]);
    expect(run((scope) => scope.transferOrigins.contentsByIdentity("bob", "c-own"))).toEqual([]);
  });

  it("records merge targets per owner, idempotently, several per identity", () => {
    content("c1", "alice");
    content("c2", "alice");
    run((scope) => {
      scope.transferOrigins.addContentTarget("alice", "origin-1", "c1", T0);
      scope.transferOrigins.addContentTarget("alice", "origin-1", "c1", T0 + 1);
      scope.transferOrigins.addContentTarget("alice", "origin-1", "c2", T0 + 2);
    });
    expect(run((scope) => scope.transferOrigins.contentTargets("alice", "origin-1"))).toEqual(["c1", "c2"]);
    expect(run((scope) => scope.transferOrigins.contentTargets("bob", "origin-1"))).toEqual([]);
  });

  it("refuses a target of another user at the database", () => {
    content("c-bob", "bob");
    expect(() => run((scope) => scope.transferOrigins.addContentTarget("alice", "origin-1", "c-bob", T0))).toThrow();
    collection("k-bob", "bob");
    expect(() => run((scope) => scope.transferOrigins.addCollectionTarget("alice", "origin-1", "k-bob", T0))).toThrow();
    expect(countRows(db, "content_origin_map")).toBe(0);
    expect(countRows(db, "collection_origin_map")).toBe(0);
  });

  it("drops the rows with their target", () => {
    content("c1", "alice");
    collection("k1", "alice");
    run((scope) => {
      scope.transferOrigins.addContentTarget("alice", "origin-1", "c1", T0);
      scope.transferOrigins.addCollectionTarget("alice", "origin-k", "k1", T0);
    });
    run((scope) => {
      scope.contents.delete("alice", "c1");
      scope.collections.delete("alice", "k1");
    });
    expect(run((scope) => scope.transferOrigins.contentTargets("alice", "origin-1"))).toEqual([]);
    expect(run((scope) => scope.transferOrigins.collectionTargets("alice", "origin-k"))).toEqual([]);
  });

  it("finds collections by identity and records their merges", () => {
    collection("k-own", "alice");
    collection("k-carried", "alice", "origin-k");
    collection("k-bob", "bob", "origin-k");
    expect(run((scope) => scope.transferOrigins.collectionsByIdentity("alice", "k-own")).map((item) => item.id)).toEqual(["k-own"]);
    expect(run((scope) => scope.transferOrigins.collectionsByIdentity("alice", "origin-k")).map((item) => item.id)).toEqual(["k-carried"]);
    run((scope) => scope.transferOrigins.addCollectionTarget("alice", "origin-x", "k-own", T0));
    expect(run((scope) => scope.transferOrigins.collectionTargets("alice", "origin-x"))).toEqual(["k-own"]);
    expect(run((scope) => scope.transferOrigins.collectionTargets("bob", "origin-x"))).toEqual([]);
  });
});
