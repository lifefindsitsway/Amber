import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

function revision(id: string, contentId: string, parentId?: string): void {
  insertRow(db, "transcript_revision", {
    id, content_id: contentId, kind: parentId === undefined ? "asr" : "manual", ...(parentId === undefined ? {} : { parent_revision_id: parentId }),
    language: "zh", timing_fidelity: "segment_only",
    generation_json: JSON.stringify(parentId === undefined ? { kind: "asr", asrProfileId: "p", modelId: "m" } : { kind: "manual" }),
    segment_count: 0, created_at: T0,
  });
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c1", user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(db, "content", { id: "c2", user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(db, "content", { id: "b1", user_id: "bob", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  revision("r1", "c1");
  revision("r2", "c1", "r1");
  revision("r3", "c2");
  revision("rb", "b1");
});

describe("speaker confirmation repository", () => {
  it("records, re-records and withdraws a revision's mark; no row reads as not reviewed", () => {
    expect(repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAt("alice", "r1"))).toBeUndefined();
    repository.withTransaction((scope) => scope.speakerConfirmations.set("alice", "c1", "r1", T0 + 1));
    expect(repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAt("alice", "r1"))).toBe(T0 + 1);
    repository.withTransaction((scope) => scope.speakerConfirmations.set("alice", "c1", "r1", T0 + 2));
    expect(repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAt("alice", "r1"))).toBe(T0 + 2);
    expect(countRows(db, "transcript_revision_speaker_confirmation")).toBe(1);
    repository.withTransaction((scope) => scope.speakerConfirmations.set("alice", "c1", "r1", undefined));
    repository.withTransaction((scope) => scope.speakerConfirmations.set("alice", "c1", "r1", undefined));
    expect(repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAt("alice", "r1"))).toBeUndefined();
  });

  it("lists the reviewed ones among given revisions, and never another owner's", () => {
    repository.withTransaction((scope) => {
      scope.speakerConfirmations.set("alice", "c1", "r2", T0 + 3);
      scope.speakerConfirmations.set("alice", "c2", "r3", T0 + 4);
      scope.speakerConfirmations.set("bob", "b1", "rb", T0 + 5);
    });
    const among = repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAmong("alice", ["r1", "r2", "r3", "rb", "r2"]));
    expect([...among]).toEqual([["r2", T0 + 3], ["r3", T0 + 4]]);
    expect(repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAt("bob", "r2"))).toBeUndefined();
  });

  it("refuses to mark a revision outside the owner's Content", () => {
    expect(() => repository.withTransaction((scope) => scope.speakerConfirmations.set("bob", "c1", "r1", T0))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.speakerConfirmations.set("alice", "c2", "r1", T0))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.speakerConfirmations.set("alice", "b1", "rb", T0))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.speakerConfirmations.set("bob", "c1", "r1", undefined))).toThrow();
    expect(countRows(db, "transcript_revision_speaker_confirmation")).toBe(0);
  });

  it("goes with its revision and with its Content", () => {
    repository.withTransaction((scope) => {
      scope.speakerConfirmations.set("alice", "c1", "r1", T0);
      scope.speakerConfirmations.set("alice", "c1", "r2", T0);
      scope.speakerConfirmations.set("alice", "c2", "r3", T0);
    });
    repository.withTransaction((scope) => scope.transcripts.deleteRevision("alice", "r2"));
    expect(repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAmong("alice", ["r1", "r2", "r3"])).size).toBe(2);
    db.prepare("DELETE FROM content WHERE id = ?").run("c1");
    expect(countRows(db, "transcript_revision_speaker_confirmation")).toBe(1);
    db.prepare("DELETE FROM user WHERE id = ?").run("alice");
    expect(countRows(db, "transcript_revision_speaker_confirmation")).toBe(0);
  });
});
