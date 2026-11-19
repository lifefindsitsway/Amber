import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { Note } from "../../../../../src/server/domain/note.ts";
import type { NotPromise, RepositoryScope } from "../../../../../src/server/ports/repository.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

/** alice owns `c1` (revision r1: s0 at 0 ms, s1 at 1000 ms) and `c2` (revision r2: t0); bob owns nothing. */
beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  for (const [content, revision, segments] of [["c1", "r1", ["s0", "s1"]], ["c2", "r2", ["t0"]]] as const) {
    insertRow(db, "content", { id: content, user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
    insertRow(db, "transcript_revision", {
      id: revision, content_id: content, kind: "asr", language: "en", timing_fidelity: "exact_words", generation_json: "{}", segment_count: segments.length, created_at: T0,
    });
    segments.forEach((id, ordinal) =>
      insertRow(db, "transcript_segment", { id, revision_id: revision, ordinal, start_ms: ordinal * 1000, end_ms: ordinal * 1000 + 1000, text: "Hello there." }),
    );
  }
});

function note(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id, userId: "alice", contentId: "c1", transcriptRevisionId: "r1", startSegmentId: "s0", startOffset: 0, endSegmentId: "s0", endOffset: 5,
    quote: "Hello", mark: "background", color: "yellow", createdAt: T0, updatedAt: T0, ...overrides,
  };
}

const run = <T>(work: (scope: RepositoryScope) => NotPromise<T>): T => repository.withTransaction(work);

describe("note repository", () => {
  it("round-trips a note with the start time of its first sentence, only for its owner", () => {
    run((scope) => scope.notes.insert(note("n1", { startSegmentId: "s1", endSegmentId: "s1", comment: "why" })));
    expect(run((scope) => scope.notes.get("alice", "n1"))).toEqual({ ...note("n1", { startSegmentId: "s1", endSegmentId: "s1", comment: "why" }), startMs: 1000 });
    expect(run((scope) => scope.notes.get("bob", "n1"))).toBeUndefined();
    expect(run((scope) => scope.notes.listByContent("bob", "c1"))).toEqual([]);
    expect(() => run((scope) => scope.notes.insert(note("n2", { userId: "bob" })))).toThrow(/not found/);
  });

  it("lists in reading order: start sentence time, start offset, creation, id", () => {
    run((scope) => {
      scope.notes.insert(note("n-late-sentence", { startSegmentId: "s1", endSegmentId: "s1", createdAt: T0 - 10 }));
      scope.notes.insert(note("n-b", { startOffset: 3, createdAt: T0 }));
      scope.notes.insert(note("n-a", { startOffset: 3, createdAt: T0 }));
      scope.notes.insert(note("n-early", { startOffset: 1, createdAt: T0 + 9 }));
      scope.notes.insert(note("n-first", { startOffset: 0, createdAt: T0 + 20 }));
    });
    expect(run((scope) => scope.notes.listByContent("alice", "c1").map((n) => n.id))).toEqual(["n-first", "n-early", "n-a", "n-b", "n-late-sentence"]);
    expect(run((scope) => scope.notes.countByContent("alice", "c1"))).toBe(5);
    expect(run((scope) => scope.notes.countByContent("bob", "c1"))).toBe(0);
  });

  it("changes only mark, colour and comment, clears a comment given as undefined, and deletes only for the owner", () => {
    run((scope) => scope.notes.insert(note("n1", { comment: "first" })));
    expect(run((scope) => scope.notes.update("alice", "n1", { color: "green" }, T0 + 1))).toBe(true);
    expect(run((scope) => scope.notes.get("alice", "n1"))).toMatchObject({ mark: "background", color: "green", comment: "first", updatedAt: T0 + 1 });
    expect(run((scope) => scope.notes.update("alice", "n1", { mark: "underline", comment: undefined }, T0 + 2))).toBe(true);
    const updated = run((scope) => scope.notes.get("alice", "n1"));
    expect(updated).toMatchObject({ mark: "underline", color: "green", updatedAt: T0 + 2 });
    expect(updated?.comment).toBeUndefined();
    expect(run((scope) => scope.notes.update("bob", "n1", { color: "pink" }, T0 + 3))).toBe(false);
    expect(run((scope) => scope.notes.delete("bob", "n1"))).toBe(false);
    expect(run((scope) => scope.notes.delete("alice", "n1"))).toBe(true);
    expect(run((scope) => scope.notes.delete("alice", "n1"))).toBe(false);
  });

  it("groups by Content, latest first, pages strictly after a cursor or by offset and counts groups", () => {
    insertRow(db, "content", { id: "c0", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
    insertRow(db, "transcript_revision", { id: "r0", content_id: "c0", kind: "asr", language: "en", timing_fidelity: "exact_words", generation_json: "{}", segment_count: 1, created_at: T0 });
    insertRow(db, "transcript_segment", { id: "u0", revision_id: "r0", ordinal: 0, start_ms: 0, end_ms: 1000, text: "Hello there." });
    run((scope) => {
      scope.notes.insert(note("a1", { createdAt: T0 + 1 }));
      scope.notes.insert(note("a2", { createdAt: T0 + 5 }));
      scope.notes.insert(note("b1", { contentId: "c2", transcriptRevisionId: "r2", startSegmentId: "t0", endSegmentId: "t0", createdAt: T0 + 5 }));
      scope.notes.insert(note("z1", { contentId: "c0", transcriptRevisionId: "r0", startSegmentId: "u0", endSegmentId: "u0", createdAt: T0 + 2 }));
    });
    // c1 and c2 tie on latestAt; the larger contentId comes first.
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 10 }))).toEqual([
      { contentId: "c2", count: 1, latestAt: T0 + 5 },
      { contentId: "c1", count: 2, latestAt: T0 + 5 },
      { contentId: "c0", count: 1, latestAt: T0 + 2 },
    ]);
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 1, after: { latestAt: T0 + 5, contentId: "c2" } }))).toEqual([{ contentId: "c1", count: 2, latestAt: T0 + 5 }]);
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 5, after: { latestAt: T0 + 5, contentId: "c1" } }))).toEqual([{ contentId: "c0", count: 1, latestAt: T0 + 2 }]);
    // Numbered pages skip `offset` rows of the same order, ties included.
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 1, offset: 1 }))).toEqual([{ contentId: "c1", count: 2, latestAt: T0 + 5 }]);
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 2, offset: 2 }))).toEqual([{ contentId: "c0", count: 1, latestAt: T0 + 2 }]);
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 2, offset: 0 }).map((group) => group.contentId))).toEqual(["c2", "c1"]);
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 2, offset: 3 }))).toEqual([]);
    expect(run((scope) => scope.notes.countGroups("alice"))).toBe(3);
    expect(run((scope) => scope.notes.listGroups("bob", { limit: 10 }))).toEqual([]);
    expect(run((scope) => scope.notes.listGroups("bob", { limit: 10, offset: 0 }))).toEqual([]);
    expect(run((scope) => scope.notes.countGroups("bob"))).toBe(0);
  });

  it("leaves Contents in the trash out of the groups and their count, keeping their notes", () => {
    run((scope) => {
      scope.notes.insert(note("a1", { createdAt: T0 + 1 }));
      scope.notes.insert(note("b1", { contentId: "c2", transcriptRevisionId: "r2", startSegmentId: "t0", endSegmentId: "t0", createdAt: T0 + 5 }));
      scope.contents.trash("alice", "c2", T0 + 9);
    });
    expect(run((scope) => scope.notes.listGroups("alice", { limit: 10 }))).toEqual([{ contentId: "c1", count: 1, latestAt: T0 + 1 }]);
    expect(run((scope) => scope.notes.countGroups("alice"))).toBe(1);
    expect(run((scope) => scope.notes.get("alice", "b1"))?.id).toBe("b1");
  });
});

describe("note transfer origin", () => {
  it("round-trips the origin id a content pack import writes, and leaves it absent otherwise", () => {
    run((scope) => scope.notes.insert(note("n1", { originId: "01ORIGINNOTE" })));
    run((scope) => scope.notes.insert(note("n2")));
    expect(run((scope) => scope.notes.get("alice", "n1"))).toEqual({ ...note("n1", { originId: "01ORIGINNOTE" }), startMs: 0 });
    expect(run((scope) => scope.notes.get("alice", "n2"))).not.toHaveProperty("originId");
  });
});
