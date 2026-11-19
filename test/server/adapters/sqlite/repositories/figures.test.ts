import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { ContentFigure } from "../../../../../src/server/domain/figure.ts";
import type { NotPromise, RepositoryScope } from "../../../../../src/server/ports/repository.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c1", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
});

function figure(id: string, overrides: Partial<ContentFigure> = {}): ContentFigure {
  return {
    id, contentId: "c1", userId: "alice", source: "upload", displayMs: 1000, sortKey: 0, widthRatio: 0.7,
    image: { width: 4, height: 3, bytes: 3, sha256: "a".repeat(64) }, version: 1, createdAt: T0, updatedAt: T0, ...overrides,
  };
}

const run = <T>(work: (scope: RepositoryScope) => NotPromise<T>): T => repository.withTransaction(work);

describe("figure repository", () => {
  it("round-trips metadata and image bytes for the owner only", () => {
    const capture = figure("f1", { source: "capture", capturedAtMs: 900, anchor: { revisionId: "r1", segmentId: "s1", side: "after" }, caption: "x", originId: "o1" });
    run((scope) => scope.figures.insert(capture, new Uint8Array([1, 2, 3])));
    expect(run((scope) => scope.figures.get("alice", "f1"))).toEqual(capture);
    expect(run((scope) => scope.figures.get("bob", "f1"))).toBeUndefined();
    expect(Array.from(run((scope) => scope.figures.getImage("alice", "f1")) ?? [])).toEqual([1, 2, 3]);
    expect(run((scope) => scope.figures.getImage("bob", "f1"))).toBeUndefined();
    expect(run((scope) => scope.figures.countByContent("alice", "c1"))).toBe(1);
    expect(run((scope) => scope.figures.listByContent("bob", "c1"))).toEqual([]);
  });

  it("updates on the expected version only, clearing caption and anchor with null", () => {
    run((scope) => scope.figures.insert(figure("f1", { caption: "x", anchor: { revisionId: "r1", segmentId: "s1", side: "before" } }), new Uint8Array([1])));
    expect(run((scope) => scope.figures.update("alice", "f1", 2, { caption: "y" }, T0 + 1))).toEqual({ conflict: "version_mismatch", currentVersion: 1 });
    const updated = run((scope) => scope.figures.update("alice", "f1", 1, { caption: null, anchor: null, widthRatio: 0.4, displayMs: 5, sortKey: 3 }, T0 + 1));
    expect(updated).toEqual(figure("f1", { widthRatio: 0.4, displayMs: 5, sortKey: 3, version: 2, updatedAt: T0 + 1 }));
    expect(run((scope) => scope.figures.update("bob", "f1", 2, { caption: "z" }, T0 + 2))).toBeUndefined();
  });

  it("deletes idempotently, restores, and purges with the image", () => {
    run((scope) => scope.figures.insert(figure("f1"), new Uint8Array([1])));
    const deleted = run((scope) => scope.figures.setDeleted("alice", "f1", T0 + 10, T0 + 10));
    expect(deleted).toMatchObject({ deletedAt: T0 + 10, version: 2 });
    expect(run((scope) => scope.figures.setDeleted("alice", "f1", T0 + 20, T0 + 20))).toMatchObject({ deletedAt: T0 + 10, version: 2 });
    expect(run((scope) => scope.figures.setDeleted("alice", "f1", undefined, T0 + 30))).toEqual(figure("f1", { version: 3, updatedAt: T0 + 30 }));
    run((scope) => scope.figures.setDeleted("alice", "f1", T0 + 40, T0 + 40));
    expect(run((scope) => scope.figures.purgeDeleted(T0 + 40, 10))).toEqual([]);
    expect(run((scope) => scope.figures.purgeDeleted(T0 + 41, 10))).toEqual([{ userId: "alice", contentId: "c1", figureId: "f1" }]);
    expect(db.prepare("SELECT count(*) AS n FROM content_figure_image").get()).toEqual({ n: 0 });
  });

  it("refuses to rewrite an image", () => {
    run((scope) => scope.figures.insert(figure("f1"), new Uint8Array([1])));
    expect(() => db.prepare("UPDATE content_figure_image SET bytes = x'02'").run()).toThrow(/immutable/);
  });
});
