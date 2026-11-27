import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { ContentCoverImageInput, NotPromise, RepositoryScope } from "../../../../../src/server/ports/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c1", user_id: "alice", source_kind: "bilibili", platform_content_id: "BV1", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(db, "content", { id: "c2", user_id: "alice", source_kind: "bilibili", platform_content_id: "BV2", processing_status: "succeeded", created_at: T0, updated_at: T0 });
});

function image(...bytes: number[]): ContentCoverImageInput {
  const data = new Uint8Array(bytes);
  return { bytes: data, width: 16, height: 9, sha256: createHash("sha256").update(data).digest("hex") };
}

const run = <T>(work: (scope: RepositoryScope) => NotPromise<T>): T => repository.withTransaction(work);
const contentRow = (id: string) => db.prepare("SELECT cover_image_version, updated_at FROM content WHERE id = ?").get(id);
const notFoundThrown = (work: () => unknown): boolean => {
  try {
    work();
  } catch (error) {
    return isAmberError(error) && error.appError.class === "not_found";
  }
  return false;
};

describe("content cover repository", () => {
  it("stores and replaces a cover, raising the version without touching updatedAt", () => {
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toBeUndefined();
    expect(run((scope) => scope.contentCovers.put("alice", "c1", image(1, 2, 3), T0 + 5))).toBe(1);
    expect(contentRow("c1")).toEqual({ cover_image_version: 1, updated_at: T0 });
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toEqual({ ...image(1, 2, 3), version: 1 });
    expect(run((scope) => scope.contents.get("alice", "c1"))).toMatchObject({ coverImageVersion: 1, updatedAt: T0 });

    expect(run((scope) => scope.contentCovers.put("alice", "c1", { ...image(4, 5), width: 9, height: 16 }, T0 + 9))).toBe(2);
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toEqual({ ...image(4, 5), width: 9, height: 16, version: 2 });
    expect(contentRow("c1")).toEqual({ cover_image_version: 2, updated_at: T0 });
    expect(db.prepare("SELECT bytes, created_at, updated_at FROM content_cover_image WHERE content_id = 'c1'").get()).toEqual({ bytes: 2, created_at: T0 + 5, updated_at: T0 + 9 });
    // The other Content is untouched.
    expect(contentRow("c2")).toEqual({ cover_image_version: null, updated_at: T0 });
    expect(run((scope) => scope.contents.get("alice", "c2"))).not.toHaveProperty("coverImageVersion");
  });

  it("keeps another owner's Content as unknown, for reads and writes", () => {
    run((scope) => scope.contentCovers.put("alice", "c1", image(1), T0));
    expect(run((scope) => scope.contentCovers.get("bob", "c1"))).toBeUndefined();
    expect(run((scope) => scope.contentCovers.getIncludingTrashed("bob", "c1"))).toBeUndefined();
    expect(notFoundThrown(() => run((scope) => scope.contentCovers.put("bob", "c1", image(9), T0 + 1)))).toBe(true);
    expect(notFoundThrown(() => run((scope) => scope.contentCovers.putIfAbsent("bob", "c2", image(9), T0 + 1)))).toBe(true);
    expect(notFoundThrown(() => run((scope) => scope.contentCovers.put("alice", "missing", image(9), T0 + 1)))).toBe(true);
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toEqual({ ...image(1), version: 1 });
    expect(contentRow("c2")).toEqual({ cover_image_version: null, updated_at: T0 });
    expect(countRows(db, "content_cover_image")).toBe(1);
  });

  it("leaves the version and the copy as they were when a write fails, even if the caller carries on", () => {
    run((scope) => scope.contentCovers.put("alice", "c1", image(1), T0));
    const outcome = run((scope) => {
      let failed = false;
      try {
        scope.contentCovers.put("alice", "c1", { ...image(2), sha256: "not-a-digest" }, T0 + 1);
      } catch {
        failed = true;
      }
      // The caller's own transaction goes on and commits.
      scope.contents.setPinned("alice", "c1", T0 + 2);
      return failed;
    });
    expect(outcome).toBe(true);
    expect(db.prepare("SELECT cover_image_version, pinned_at FROM content WHERE id = 'c1'").get()).toEqual({ cover_image_version: 1, pinned_at: T0 + 2 });
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toEqual({ ...image(1), version: 1 });

    // A first write that fails leaves no version behind.
    expect(() => run((scope) => scope.contentCovers.put("alice", "c2", { ...image(3), width: 0 }, T0))).toThrow(/CHECK/);
    expect(contentRow("c2")).toEqual({ cover_image_version: null, updated_at: T0 });
    expect(countRows(db, "content_cover_image", "content_id = 'c2'")).toBe(0);
  });

  it("writes only when there is no cover yet with putIfAbsent", () => {
    expect(run((scope) => scope.contentCovers.putIfAbsent("alice", "c1", image(1), T0 + 1))).toBe(true);
    expect(run((scope) => scope.contentCovers.putIfAbsent("alice", "c1", image(2), T0 + 2))).toBe(false);
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toEqual({ ...image(1), version: 1 });
    expect(contentRow("c1")).toEqual({ cover_image_version: 1, updated_at: T0 });
  });

  it("reads a trashed Content's cover only through getIncludingTrashed and refuses to write to it", () => {
    run((scope) => scope.contentCovers.put("alice", "c1", image(1), T0));
    run((scope) => scope.contents.trash("alice", "c1", T0 + 10));
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toBeUndefined();
    expect(run((scope) => scope.contentCovers.getIncludingTrashed("alice", "c1"))).toEqual({ ...image(1), version: 1 });
    expect(notFoundThrown(() => run((scope) => scope.contentCovers.put("alice", "c1", image(2), T0 + 11)))).toBe(true);
    run((scope) => scope.contents.trash("alice", "c2", T0 + 10));
    expect(notFoundThrown(() => run((scope) => scope.contentCovers.putIfAbsent("alice", "c2", image(2), T0 + 11)))).toBe(true);
    expect(db.prepare("SELECT id, cover_image_version FROM content ORDER BY id").all()).toEqual([
      { id: "c1", cover_image_version: 1 },
      { id: "c2", cover_image_version: null },
    ]);
    run((scope) => scope.contents.restore("alice", "c1"));
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toEqual({ ...image(1), version: 1 });
  });

  it("goes with its Content on purge", () => {
    run((scope) => scope.contentCovers.put("alice", "c1", image(1), T0));
    run((scope) => scope.contentCovers.put("alice", "c2", image(2), T0));
    expect(run((scope) => scope.contents.delete("alice", "c1"))).toBe(true);
    expect(db.prepare("SELECT content_id FROM content_cover_image").all()).toEqual([{ content_id: "c2" }]);
  });
});
