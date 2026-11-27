import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { Content } from "../../../../../src/server/domain/content.ts";
import type { ContentListFilters, ContentListQuery } from "../../../../../src/server/ports/repository.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

function content(id: string, userId: string, createdAt: number, extra: Partial<Content> = {}): Content {
  return {
    id,
    userId,
    source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${id}`, platformContentId: id },
    processingStatus: "queued",
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

function page(userId: string, query: Partial<ContentListQuery> = {}): string[] {
  return repository.withTransaction((scope) => scope.contents.page(userId, { limit: 50, ...query })).map((item) => item.id);
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "import_batch", { id: "batch", user_id: "alice", created_at: T0, source_type: "links", total_items: 2 });
  repository.withTransaction((scope) => {
    scope.contents.insert(content("a1", "alice", T0 + 1, { importBatchId: "batch" }));
    // a2 and a3 share a creation time; the id breaks the tie.
    scope.contents.insert(content("a2", "alice", T0 + 2, { processingStatus: "succeeded", importBatchId: "batch" }));
    scope.contents.insert(content("a3", "alice", T0 + 2, { source: { kind: "local" } }));
    scope.contents.insert(content("a4", "alice", T0 + 3, { source: { kind: "youtube", platformContentId: "dQw4w9WgXcQ" } }));
    scope.contents.insert(content("b1", "bob", T0 + 5));
  });
});

describe("content repository paging", () => {
  it("lists the owner's Contents newest first, ties broken by id descending", () => {
    expect(page("alice")).toEqual(["a4", "a3", "a2", "a1"]);
    expect(page("bob")).toEqual(["b1"]);
  });

  it("continues after a cursor without skipping or repeating rows of the same creation time", () => {
    const first = repository.withTransaction((scope) => scope.contents.page("alice", { limit: 2 }));
    expect(first.map((item) => item.id)).toEqual(["a4", "a3"]);
    const last = first.at(-1) as Content;
    expect(page("alice", { limit: 2, after: { createdAt: last.createdAt, id: last.id } })).toEqual(["a2", "a1"]);
    expect(page("alice", { limit: 2, after: { createdAt: T0 + 1, id: "a1" } })).toEqual([]);
  });

  it("filters by status, source kind and import batch", () => {
    expect(page("alice", { status: "succeeded" })).toEqual(["a2"]);
    expect(page("alice", { source: "local" })).toEqual(["a3"]);
    expect(page("alice", { source: "youtube" })).toEqual(["a4"]);
    expect(page("alice", { importBatchId: "batch" })).toEqual(["a2", "a1"]);
    expect(page("alice", { status: "succeeded", source: "local" })).toEqual([]);
  });

  it("filters by the owner's collection only", () => {
    insertRow(db, "collection", { id: "mine", user_id: "alice", name: "Mine", created_at: T0 });
    insertRow(db, "collection", { id: "theirs", user_id: "bob", name: "Theirs", created_at: T0 });
    repository.withTransaction((scope) => {
      scope.collections.addItem("alice", { id: "i1", collectionId: "mine", contentId: "a1", position: 0, addedAt: T0 });
      scope.collections.addItem("alice", { id: "i2", collectionId: "mine", contentId: "a4", position: 1, addedAt: T0 });
    });
    expect(page("alice", { collectionId: "mine" })).toEqual(["a4", "a1"]);
    expect(page("alice", { collectionId: "theirs" })).toEqual([]);
    expect(page("bob", { collectionId: "mine" })).toEqual([]);
  });

  it("skips `offset` rows of the same order for a numbered page", () => {
    expect(page("alice", { limit: 2, offset: 0 })).toEqual(["a4", "a3"]);
    expect(page("alice", { limit: 2, offset: 2 })).toEqual(["a2", "a1"]);
    expect(page("alice", { limit: 2, offset: 3 })).toEqual(["a1"]);
    expect(page("alice", { limit: 2, offset: 4 })).toEqual([]);
    expect(page("alice", { limit: 1, offset: 1, status: "succeeded" })).toEqual([]);
  });

  it("narrows to the given ids, still under the owner and the other filters", () => {
    const count = (owner: string, filters: ContentListFilters) => repository.withTransaction((scope) => scope.contents.count(owner, filters));
    expect(page("alice", { ids: ["a1", "a3", "missing"] })).toEqual(["a3", "a1"]);
    expect(count("alice", { ids: ["a1", "a3", "missing"] })).toBe(2);
    expect(page("alice", { ids: ["a1", "a2", "a3"], source: "bilibili" })).toEqual(["a2", "a1"]);
    expect(page("alice", { ids: ["a1", "a2"], limit: 1, offset: 1 })).toEqual(["a1"]);
    expect(page("alice", { ids: ["b1"] })).toEqual([]);
    expect(count("alice", { ids: ["b1"] })).toBe(0);
    expect(page("bob", { ids: ["a1", "b1"] })).toEqual(["b1"]);
  });
});

describe("content repository pins and collections", () => {
  const pin = (id: string, at: number | undefined) => repository.withTransaction((scope) => scope.contents.setPinned("alice", id, at));
  const count = (filters: ContentListFilters = {}) => repository.withTransaction((scope) => scope.contents.count("alice", filters));

  it("lists pinned Contents first, latest pin first, and leaves updatedAt alone", () => {
    pin("a1", T0 + 100);
    pin("a3", T0 + 200);
    expect(page("alice")).toEqual(["a3", "a1", "a4", "a2"]);
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))).toMatchObject({ pinnedAt: T0 + 100, updatedAt: T0 + 1 });
    pin("a3", undefined);
    expect(page("alice")).toEqual(["a1", "a4", "a3", "a2"]);
  });

  it("pages across the pinned run into the rest without skipping or repeating", () => {
    pin("a2", T0 + 100);
    pin("a1", T0 + 100);
    const seen: string[] = [];
    let after: ContentListQuery["after"];
    for (;;) {
      const rows = repository.withTransaction((scope) => scope.contents.page("alice", { limit: 1, ...(after === undefined ? {} : { after }) }));
      const last = rows.at(-1);
      if (last === undefined) break;
      seen.push(last.id);
      after = { ...(last.pinnedAt === undefined ? {} : { pinnedAt: last.pinnedAt }), createdAt: last.createdAt, id: last.id };
    }
    expect(seen).toEqual(["a2", "a1", "a4", "a3"]);
  });

  it("lists only Contents in none of the owner's collections, and counts regardless of the page", () => {
    insertRow(db, "collection", { id: "mine", user_id: "alice", name: "Mine", created_at: T0 });
    repository.withTransaction((scope) => scope.collections.addItem("alice", { id: "i1", collectionId: "mine", contentId: "a4", position: 0, addedAt: T0 }));
    expect(page("alice", { uncollected: true })).toEqual(["a3", "a2", "a1"]);
    expect(count({ uncollected: true })).toBe(3);
    expect(count()).toBe(4);
    expect(count({ collectionId: "mine" })).toBe(1);
    expect(repository.withTransaction((scope) => scope.contents.count("bob", { uncollected: true }))).toBe(1);
  });

  it("keeps the user's title apart from the platform title, and refuses another owner", () => {
    repository.withTransaction((scope) => scope.contents.setMetadata("alice", "a1", { title: "Platform" }, T0 + 5));
    repository.withTransaction((scope) => scope.contents.setCustomTitle("alice", "a1", "Mine", T0 + 6));
    // A re-run of the source stage writes the platform title only.
    repository.withTransaction((scope) => scope.contents.setMetadata("alice", "a1", { title: "Platform v2" }, T0 + 7));
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))).toMatchObject({ title: "Platform v2", customTitle: "Mine", updatedAt: T0 + 7 });
    repository.withTransaction((scope) => scope.contents.setCustomTitle("alice", "a1", undefined, T0 + 8));
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))).not.toHaveProperty("customTitle");
    expect(() => repository.withTransaction((scope) => scope.contents.setCustomTitle("bob", "a1", "x", T0))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.contents.setPinned("bob", "a1", T0))).toThrow();
  });
});

describe("content repository metadata", () => {
  it("writes only the given fields, including the channel on the source", () => {
    repository.withTransaction((scope) =>
      scope.contents.setMetadata("alice", "a1", { title: "Lecture", durationMs: 1000, channelId: "42", channelTitle: "Channel" }, T0 + 10),
    );
    const updated = repository.withTransaction((scope) => scope.contents.get("alice", "a1"));
    expect(updated).toMatchObject({ title: "Lecture", durationMs: 1000, updatedAt: T0 + 10, source: { kind: "bilibili", channelId: "42", channelTitle: "Channel" } });
    repository.withTransaction((scope) => scope.contents.setMetadata("alice", "a1", { rawLanguage: "zh-CN" }, T0 + 11));
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))).toMatchObject({ title: "Lecture", rawLanguage: "zh-CN" });
  });

  it("refuses another owner's Content", () => {
    expect(() => repository.withTransaction((scope) => scope.contents.setMetadata("bob", "a1", { title: "x" }, T0))).toThrow();
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))?.title).toBeUndefined();
  });
});

describe("content repository source link", () => {
  it("replaces only the owner's stored link, leaving updatedAt and the identity alone", () => {
    const renewed = "https://www.bilibili.com/video/a1?renewed=1";
    expect(repository.withTransaction((scope) => scope.contents.setSourceUrl("bob", "a1", renewed))).toBe(false);
    expect(repository.withTransaction((scope) => scope.contents.setSourceUrl("alice", "a1", renewed))).toBe(true);
    const stored = repository.withTransaction((scope) => scope.contents.get("alice", "a1"));
    expect(stored?.source).toEqual({ kind: "bilibili", sourceUrl: renewed, platformContentId: "a1" });
    expect(stored?.updatedAt).toBe(T0 + 1);
  });
});

describe("content repository description", () => {
  const NOW = T0 + 1_000;
  const write = (owner: string, id: string, value: { description: string | null; truncated: boolean; checkedAt: number }, now = NOW) =>
    repository.withTransaction((scope) => scope.contents.setDescription(owner, id, value, now));
  const read = (id: string) => {
    const item = repository.withTransaction((scope) => scope.contents.getIncludingTrashed("alice", id));
    return { description: item?.description, truncated: item?.descriptionTruncated, checkedAt: item?.descriptionCheckedAt, updatedAt: item?.updatedAt };
  };

  it("stores found text with its flag and request time, without touching updatedAt", () => {
    expect(write("alice", "a1", { description: "简介", truncated: true, checkedAt: T0 + 10 })).toBe(true);
    expect(read("a1")).toEqual({ description: "简介", truncated: true, checkedAt: T0 + 10, updatedAt: T0 + 1 });
    expect(write("alice", "a1", { description: "完整", truncated: false, checkedAt: T0 + 11 })).toBe(true);
    expect(read("a1")).toEqual({ description: "完整", truncated: undefined, checkedAt: T0 + 11, updatedAt: T0 + 1 });
  });

  it("clears the text and the flag when the platform says there is none, keeping the time", () => {
    write("alice", "a1", { description: "简介", truncated: true, checkedAt: T0 + 10 });
    expect(write("alice", "a1", { description: null, truncated: true, checkedAt: T0 + 20 })).toBe(true);
    expect(read("a1")).toEqual({ description: undefined, truncated: undefined, checkedAt: T0 + 20, updatedAt: T0 + 1 });
    expect(db.prepare("SELECT description, description_truncated FROM content WHERE id = 'a1'").get()).toEqual({ description: null, description_truncated: 0 });
  });

  it("writes over nothing stored and over an older time, never over the same or a newer one", () => {
    expect(write("alice", "a1", { description: "first", truncated: false, checkedAt: T0 + 50 })).toBe(true);
    expect(write("alice", "a1", { description: "older", truncated: false, checkedAt: T0 + 40 })).toBe(false);
    expect(write("alice", "a1", { description: "same", truncated: false, checkedAt: T0 + 50 })).toBe(false);
    expect(read("a1").description).toBe("first");
    expect(write("alice", "a1", { description: null, truncated: false, checkedAt: T0 + 60 })).toBe(true);
    // A stored "none" is replaced by a later answer like any other.
    expect(write("alice", "a1", { description: "later", truncated: false, checkedAt: T0 + 70 })).toBe(true);
    expect(read("a1")).toMatchObject({ description: "later", checkedAt: T0 + 70 });
  });

  it("writes over a stored time in the future of now: the clock was set back", () => {
    write("alice", "a1", { description: "from the future", truncated: false, checkedAt: NOW + 10_000 });
    expect(write("alice", "a1", { description: "after the reset", truncated: false, checkedAt: NOW - 5 })).toBe(true);
    expect(read("a1")).toMatchObject({ description: "after the reset", checkedAt: NOW - 5 });
    // A stored time not ahead of now still wins over an older answer.
    expect(write("alice", "a1", { description: "older", truncated: false, checkedAt: NOW - 6 })).toBe(false);
  });

  it("writes only the owner's Content outside the trash", () => {
    expect(write("bob", "a1", { description: "x", truncated: false, checkedAt: T0 + 10 })).toBe(false);
    expect(write("alice", "missing", { description: "x", truncated: false, checkedAt: T0 + 10 })).toBe(false);
    expect(read("a1").checkedAt).toBeUndefined();
    repository.withTransaction((scope) => scope.contents.trash("alice", "a2", T0 + 100));
    expect(write("alice", "a2", { description: "x", truncated: false, checkedAt: T0 + 10 })).toBe(false);
    expect(read("a2")).toEqual({ description: undefined, truncated: undefined, checkedAt: undefined, updatedAt: T0 + 2 });
  });
});

describe("content repository trash", () => {
  const trash = (owner: string, id: string, at: number) => repository.withTransaction((scope) => scope.contents.trash(owner, id, at));

  it("hides a trashed Content from every active read while the trash reads still find it", () => {
    trash("alice", "a2", T0 + 100);
    repository.withTransaction((scope) => {
      expect(scope.contents.get("alice", "a2")).toBeUndefined();
      expect(scope.contents.getIncludingTrashed("alice", "a2")).toMatchObject({ id: "a2", trashedAt: T0 + 100, updatedAt: T0 + 2 });
      expect(scope.contents.list("alice").map((item) => item.id)).not.toContain("a2");
      expect(scope.contents.count("alice", {})).toBe(3);
      // The platform identity stays taken.
      expect(scope.contents.findByPlatformIdentity("alice", { kind: "bilibili", platformContentId: "a2" })?.trashedAt).toBe(T0 + 100);
      expect(scope.contents.getIncludingTrashed("bob", "a2")).toBeUndefined();
    });
    expect(page("alice")).toEqual(["a4", "a3", "a1"]);
  });

  it("trashes and restores only once, only for the owner, without touching updatedAt", () => {
    expect(() => trash("bob", "a1", T0 + 100)).toThrow();
    trash("alice", "a1", T0 + 100);
    expect(() => trash("alice", "a1", T0 + 200)).toThrow();
    expect(() => repository.withTransaction((scope) => scope.contents.restore("bob", "a1"))).toThrow();
    repository.withTransaction((scope) => scope.contents.restore("alice", "a1"));
    expect(() => repository.withTransaction((scope) => scope.contents.restore("alice", "a1"))).toThrow();
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))).toMatchObject({ updatedAt: T0 + 1 });
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))?.trashedAt).toBeUndefined();
  });

  it("pages the owner's trash latest first with a strict cursor and counts it", () => {
    trash("alice", "a1", T0 + 300);
    trash("alice", "a2", T0 + 100);
    trash("alice", "a3", T0 + 300);
    trash("bob", "b1", T0 + 400);
    const trashed = (after?: { trashedAt: number; id: string }) =>
      repository.withTransaction((scope) => scope.contents.listTrashed("alice", { limit: 2, ...(after === undefined ? {} : { after }) })).map((item) => item.id);
    expect(trashed()).toEqual(["a3", "a1"]);
    expect(trashed({ trashedAt: T0 + 300, id: "a1" })).toEqual(["a2"]);
    const numbered = (offset: number) => repository.withTransaction((scope) => scope.contents.listTrashed("alice", { limit: 2, offset })).map((item) => item.id);
    expect(numbered(0)).toEqual(["a3", "a1"]);
    expect(numbered(1)).toEqual(["a1", "a2"]);
    expect(numbered(2)).toEqual(["a2"]);
    expect(numbered(3)).toEqual([]);
    repository.withTransaction((scope) => {
      expect(scope.contents.countTrashed("alice")).toBe(3);
      expect(scope.contents.listTrashedIds("alice")).toEqual(["a3", "a1", "a2"]);
    });
  });

  it("finds expired entries of every user oldest first, in batches, and the next expiry after a cutoff", () => {
    trash("alice", "a1", T0 + 100);
    trash("bob", "b1", T0 + 100);
    trash("alice", "a2", T0 + 200);
    trash("alice", "a3", T0 + 300);
    repository.withTransaction((scope) => {
      expect(scope.contents.listExpired(T0 + 200, 10)).toEqual([
        { userId: "alice", id: "a1", trashedAt: T0 + 100 },
        { userId: "bob", id: "b1", trashedAt: T0 + 100 },
        { userId: "alice", id: "a2", trashedAt: T0 + 200 },
      ]);
      expect(scope.contents.listExpired(T0 + 200, 2, { trashedAt: T0 + 100, id: "b1" }).map((entry) => entry.id)).toEqual(["a2"]);
      expect(scope.contents.listExpired(T0 + 99, 10)).toEqual([]);
      expect(scope.contents.earliestTrashedAfter(T0 + 200)).toBe(T0 + 300);
      expect(scope.contents.earliestTrashedAfter(T0 + 300)).toBeUndefined();
    });
  });
});

describe("content transfer origin", () => {
  it("round-trips the origin id a content pack import writes, and leaves it absent otherwise", () => {
    repository.withTransaction((scope) => scope.contents.insert(content("p1", "alice", T0 + 9, { processingStatus: "none", originId: "01ORIGINCONTENT" })));
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "p1"))).toEqual(content("p1", "alice", T0 + 9, { processingStatus: "none", originId: "01ORIGINCONTENT" }));
    expect(repository.withTransaction((scope) => scope.contents.get("alice", "a1"))).not.toHaveProperty("originId");
  });
});
