import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { CollectionSummaryRevision } from "../../../../../src/server/domain/artifact.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const modelRef = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  for (const id of ["course", "second"]) insertRow(db, "collection", { id, user_id: "alice", name: id, created_at: T0 });
  insertRow(db, "collection_item", { id: "i1", collection_id: "course", content_id: "c", position: 0, added_at: T0 });
});

function revision(id: string, createdAt: number): Omit<CollectionSummaryRevision, "artifactId"> {
  return {
    id,
    provenance: {
      inputs: [{ kind: "collectionItemSnapshot", collectionItemId: "i1", contentId: "c", summaryRevisionId: "s1", transcriptRevisionId: "t1", position: 0 }],
      modelRef,
      promptRef: { id: "rollup.final.collection", version: 1 },
      promptSnapshot: "snapshot",
      createdAt,
    },
    quality: "normal",
    inputItems: [{ collectionItemId: "i1", contentId: "c", summaryRevisionId: "s1", transcriptRevisionId: "t1", position: 0 }],
    partialIds: ["p0"],
    body: "课程总归纳",
    citations: [],
  };
}

const insert = (owner: string, collectionId: string, artifactId: string, value: Omit<CollectionSummaryRevision, "artifactId">) =>
  repository.withTransaction((scope) => scope.collectionSummaries.insertRevision(owner, { collectionId, artifactId, revision: value }));

describe("collection summary repository", () => {
  it("creates the single artifact on first use and reads revisions back", () => {
    expect(insert("alice", "course", "a1", revision("r1", T0))).toEqual({ artifactId: "a1" });
    expect(insert("alice", "course", "ignored", revision("r2", T0 + 1))).toEqual({ artifactId: "a1" });
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getArtifact("alice", "course"))).toEqual({ id: "a1", collectionId: "course" });
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getCurrent("alice", "course"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getRevision("alice", "r1"))).toEqual({ ...revision("r1", T0), artifactId: "a1" });
    expect(repository.withTransaction((scope) => scope.collectionSummaries.listRevisions("alice", "course")).map((value) => value.id)).toEqual(["r1", "r2"]);
  });

  it("switches current within the collection's artifact only", () => {
    insert("alice", "course", "a1", revision("r1", T0));
    insert("alice", "second", "a2", revision("r2", T0));
    repository.withTransaction((scope) => scope.collectionSummaries.setCurrent("alice", "course", "r1"));
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getCurrent("alice", "course"))?.id).toBe("r1");
    expect(() => repository.withTransaction((scope) => scope.collectionSummaries.setCurrent("alice", "course", "r2"))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.collectionSummaries.setCurrent("bob", "course", "r1"))).toThrow();
  });

  it("isolates owners", () => {
    insert("alice", "course", "a1", revision("r1", T0));
    expect(() => insert("bob", "course", "a9", revision("r9", T0))).toThrow();
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getArtifact("bob", "course"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getRevision("bob", "r1"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.collectionSummaries.listRevisions("bob", "course"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getCurrent("bob", "course"))).toBeUndefined();
  });

  it("deletes the artifact with every revision and partial, for its owner only", () => {
    insert("alice", "course", "a1", revision("r1", T0));
    insert("alice", "course", "a1", revision("r2", T0 + 1));
    insert("alice", "second", "a2", revision("r3", T0));
    repository.withTransaction((scope) => {
      scope.collectionSummaries.setCurrent("alice", "course", "r2");
      scope.rollupPartials.insertMany("alice", "collection_summary", [
        { id: "p0", ownerRevisionId: "r2", index: 0, inputs: [], body: "b", citations: [], modelRef, promptRef: { id: "rollup.partial", version: 1 }, promptSnapshot: "s", createdAt: T0 },
      ]);
    });
    expect(repository.withTransaction((scope) => scope.collectionSummaries.deleteArtifact("bob", "course"))).toBe(false);
    expect(countRows(db, "collection_summary_revision")).toBe(3);
    expect(repository.withTransaction((scope) => scope.collectionSummaries.deleteArtifact("alice", "course"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.collectionSummaries.getArtifact("alice", "course"))).toBeUndefined();
    expect(countRows(db, "collection_summary_revision")).toBe(1);
    expect(countRows(db, "rollup_partial")).toBe(0);
    expect(countRows(db, "collection")).toBe(2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(repository.withTransaction((scope) => scope.collectionSummaries.deleteArtifact("alice", "course"))).toBe(false);
  });

  it("goes with its collection, partials included, while member Contents stay", () => {
    insert("alice", "course", "a1", revision("r1", T0));
    repository.withTransaction((scope) => {
      scope.collectionSummaries.setCurrent("alice", "course", "r1");
      scope.rollupPartials.insertMany("alice", "collection_summary", [
        {
          id: "p0", ownerRevisionId: "r1", index: 0, inputs: [], body: "b", citations: [], modelRef,
          promptRef: { id: "rollup.partial", version: 1 }, promptSnapshot: "s", createdAt: T0,
        },
      ]);
      scope.collections.delete("alice", "course");
    });
    expect(countRows(db, "collection_summary_artifact")).toBe(0);
    expect(countRows(db, "collection_summary_revision")).toBe(0);
    expect(countRows(db, "rollup_partial")).toBe(0);
    expect(countRows(db, "collection_item")).toBe(0);
    expect(countRows(db, "content")).toBe(1);
  });
});
