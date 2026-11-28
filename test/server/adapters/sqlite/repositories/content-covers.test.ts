import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { sqliteContentCoverRepository } from "../../../../../src/server/adapters/sqlite/repositories/content-covers.ts";
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

describe("conditional cover writes", () => {
  beforeEach(() => {
    db.prepare("UPDATE content SET cover_url = 'https://img.example.com/1.jpg' WHERE id = 'c1'").run();
  });

  it("writes and raises the version only while link and version are as expected", () => {
    expect(run((scope) => scope.contentCovers.putIf("alice", "c1", image(1), T0, { coverUrl: "https://img.example.com/1.jpg", version: undefined }))).toEqual({ outcome: "written", version: 1 });
    expect(run((scope) => scope.contentCovers.putIf("alice", "c1", image(2), T0, { coverUrl: "https://img.example.com/1.jpg", version: 1 }))).toEqual({ outcome: "written", version: 2 });
    // Started before the second write: an older version, a different image.
    expect(run((scope) => scope.contentCovers.putIf("alice", "c1", image(3), T0, { coverUrl: "https://img.example.com/1.jpg", version: 1 }))).toEqual({ outcome: "superseded" });
    // The same image as the one stored: success without a new version.
    expect(run((scope) => scope.contentCovers.putIf("alice", "c1", image(2), T0, { coverUrl: "https://img.example.com/1.jpg", version: 1 }))).toEqual({ outcome: "unchanged", version: 2 });
    // Another link than the stored one.
    expect(run((scope) => scope.contentCovers.putIf("alice", "c1", image(4), T0, { coverUrl: "https://img.example.com/old.jpg", version: 2 }))).toEqual({ outcome: "superseded" });
    // Filling a missing cover finds one.
    expect(run((scope) => scope.contentCovers.putIf("alice", "c1", image(5), T0, { version: undefined }))).toEqual({ outcome: "superseded" });
    expect(run((scope) => scope.contentCovers.get("alice", "c1"))).toEqual({ ...image(2), version: 2 });
    expect(contentRow("c1")).toEqual({ cover_image_version: 2, updated_at: T0 });
  });

  it("answers gone for a trashed, missing or foreign Content and writes nothing", () => {
    expect(run((scope) => scope.contentCovers.putIf("bob", "c1", image(1), T0, { version: undefined }))).toEqual({ outcome: "gone" });
    expect(run((scope) => scope.contentCovers.putIf("alice", "missing", image(1), T0, { version: undefined }))).toEqual({ outcome: "gone" });
    run((scope) => scope.contents.trash("alice", "c1", T0 + 1));
    expect(run((scope) => scope.contentCovers.putIf("alice", "c1", image(1), T0, { version: undefined }))).toEqual({ outcome: "gone" });
    expect(countRows(db, "content_cover_image")).toBe(0);
  });

  it("replaces the cover link only while it is still the expected one", () => {
    expect(run((scope) => scope.contentCovers.replaceCoverUrl("alice", "c1", "https://img.example.com/x.jpg", "https://img.example.com/2.jpg"))).toBe(false);
    expect(run((scope) => scope.contentCovers.replaceCoverUrl("bob", "c1", "https://img.example.com/1.jpg", "https://img.example.com/2.jpg"))).toBe(false);
    expect(run((scope) => scope.contentCovers.replaceCoverUrl("alice", "c1", "https://img.example.com/1.jpg", "https://img.example.com/2.jpg"))).toBe(true);
    expect(db.prepare("SELECT cover_url, updated_at FROM content WHERE id = 'c1'").get()).toEqual({ cover_url: "https://img.example.com/2.jpg", updated_at: T0 });
    run((scope) => scope.contents.trash("alice", "c1", T0 + 1));
    expect(run((scope) => scope.contentCovers.replaceCoverUrl("alice", "c1", "https://img.example.com/2.jpg", "https://img.example.com/3.jpg"))).toBe(false);
  });
});

describe("backfill candidates", () => {
  function content(id: string, owner: string, extra: Record<string, unknown> = {}): void {
    insertRow(db, "content", {
      id,
      user_id: owner,
      source_kind: "douyin",
      platform_content_id: `p-${id}`,
      cover_url: `https://img.example.com/${id}.jpg`,
      processing_status: "succeeded",
      created_at: T0,
      updated_at: T0,
      ...extra,
    });
  }

  it("lists the owner's platform Contents outside the trash with a link and no copy, ascending by id after the cursor", () => {
    db.prepare("DELETE FROM content").run();
    content("k05", "alice");
    content("k01", "alice");
    content("k03", "alice", { source_kind: "youtube" });
    content("k02", "alice", { cover_url: null });
    content("k04", "alice", { trashed_at: T0 });
    content("k06", "bob");
    content("k07", "alice", { source_kind: "local", platform_content_id: null });
    content("k08", "alice");
    run((scope) => scope.contentCovers.put("alice", "k08", image(1), T0));
    content("k09", "alice");
    const list = (afterId: string | undefined, limit: number) => run((scope) => scope.contentCovers.listBackfillCandidates("alice", afterId, limit));
    expect(list(undefined, 10)).toEqual(["k01", "k03", "k05", "k09"]);
    expect(list(undefined, 2)).toEqual(["k01", "k03"]);
    expect(list("k03", 10)).toEqual(["k05", "k09"]);
    expect(run((scope) => scope.contentCovers.countBackfillCandidates("alice"))).toBe(4);
    expect(run((scope) => scope.contentCovers.countBackfillCandidates("alice", "k03"))).toBe(2);
    expect(run((scope) => scope.contentCovers.countBackfillCandidates("bob"))).toBe(1);
  });

  it("finds them through an index of the owner's rows, never a scan of the whole table", () => {
    const plan = (sql: string, params: Record<string, unknown>) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>).map((row) => row.detail);
    // The statements the repository runs, captured from it rather than retyped.
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = Object.assign(Object.create(db) as SqliteConnection, {
      prepare: (sql: string) => {
        statements.push(sql);
        return prepare(sql);
      },
    });
    sqliteContentCoverRepository(spy);
    const listing = statements.find((sql) => sql.includes("ORDER BY content.id LIMIT"));
    const counting = statements.find((sql) => sql.startsWith("SELECT count(*) AS n FROM content WHERE"));
    expect(listing).toBeDefined();
    expect(counting).toBeDefined();
    for (const [sql, params] of [
      [listing as string, { owner: "alice", after: "", limit: 10 }],
      [counting as string, { owner: "alice", after: "" }],
    ] as const) {
      const steps = plan(sql, params);
      expect(steps.some((step) => /^SEARCH content USING (COVERING )?INDEX \S+ \(user_id=\?/u.test(step))).toBe(true);
      expect(steps.filter((step) => /^SCAN content\b/u.test(step))).toEqual([]);
    }
  });

  it("totals the bytes of the owner's copies, trashed Contents included", () => {
    run((scope) => scope.contentCovers.put("alice", "c1", image(1, 2, 3), T0));
    run((scope) => scope.contentCovers.put("alice", "c2", image(4, 5), T0));
    run((scope) => scope.contents.trash("alice", "c2", T0 + 1));
    expect(run((scope) => scope.contentCovers.totalBytes("alice"))).toBe(5);
    expect(run((scope) => scope.contentCovers.totalBytes("bob"))).toBe(0);
  });
});
