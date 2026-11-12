import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { SPEAKER_PALETTE_SIZE } from "../../../../../src/shared/defaults.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c1", user_id: "alice", source_kind: "local_file", title: "访谈", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(db, "content", { id: "c2", user_id: "alice", source_kind: "local_file", title: "讲座", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(db, "content", { id: "b1", user_id: "bob", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
});

describe("speaker repository", () => {
  it("numbers new speakers after the existing ones and gives each its default color", () => {
    const first = repository.withTransaction((scope) => scope.speakers.insert("alice", "c1", [{ id: "A" }, { id: "B", name: "蒋炎岩" }], T0));
    expect(first.map((speaker) => [speaker.id, speaker.ordinal, speaker.colorIndex, speaker.name])).toEqual([
      ["A", 1, 0, undefined],
      ["B", 2, 1, "蒋炎岩"],
    ]);
    const more = repository.withTransaction((scope) => scope.speakers.insert("alice", "c1", Array.from({ length: SPEAKER_PALETTE_SIZE }, (_, i) => ({ id: `n${i}` })), T0));
    expect(more.at(-1)).toMatchObject({ ordinal: SPEAKER_PALETTE_SIZE + 2, colorIndex: (SPEAKER_PALETTE_SIZE + 1) % SPEAKER_PALETTE_SIZE });
    expect(repository.withTransaction((scope) => scope.speakers.count("alice", "c1"))).toBe(SPEAKER_PALETTE_SIZE + 2);
  });

  it("keeps speakers per Content and per owner", () => {
    repository.withTransaction((scope) => {
      scope.speakers.insert("alice", "c1", [{ id: "0" }], T0);
      scope.speakers.insert("alice", "c2", [{ id: "0" }], T0);
    });
    expect(repository.withTransaction((scope) => scope.speakers.list("alice", "c2")).map((s) => [s.contentId, s.id, s.ordinal])).toEqual([["c2", "0", 1]]);
    expect(() => repository.withTransaction((scope) => scope.speakers.insert("bob", "c1", [{ id: "x" }], T0))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.speakers.insert("alice", "c1", [{ id: "0" }], T0))).toThrow();
    expect(repository.withTransaction((scope) => scope.speakers.get("bob", "c1", "0"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.speakers.list("bob", "c1"))).toEqual([]);
  });

  it("patches name, color and photo; a new photo raises its version and clearing removes it", () => {
    repository.withTransaction((scope) => scope.speakers.insert("alice", "c1", [{ id: "A" }], T0));
    const named = repository.withTransaction((scope) => scope.speakers.update("alice", "c1", "A", { name: "主持人", colorIndex: 5 }, T0 + 1));
    expect(named).toMatchObject({ name: "主持人", colorIndex: 5, updatedAt: T0 + 1 });
    expect(named?.avatar).toBeUndefined();
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const first = repository.withTransaction((scope) => scope.speakers.update("alice", "c1", "A", { avatar: { mime: "image/webp", bytes } }, T0 + 2));
    expect(first?.avatar).toEqual({ mime: "image/webp", version: 1 });
    const second = repository.withTransaction((scope) => scope.speakers.update("alice", "c1", "A", { avatar: { mime: "image/png", bytes } }, T0 + 3));
    expect(second?.avatar).toEqual({ mime: "image/png", version: 2 });
    expect(repository.withTransaction((scope) => scope.speakers.getAvatar("alice", "c1", "A"))).toEqual({ mime: "image/png", bytes, version: 2 });
    expect(repository.withTransaction((scope) => scope.speakers.getAvatar("bob", "c1", "A"))).toBeUndefined();
    const cleared = repository.withTransaction((scope) => scope.speakers.update("alice", "c1", "A", { avatar: null, name: null }, T0 + 4));
    expect(cleared?.avatar).toBeUndefined();
    expect(cleared?.name).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.speakers.getAvatar("alice", "c1", "A"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.speakers.update("bob", "c1", "A", { name: "x" }, T0))).toBeUndefined();
  });

  it("reports the speakers unarchived revisions and the transcript draft name", () => {
    repository.withTransaction((scope) => scope.speakers.insert("alice", "c1", [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }], T0));
    const revision = (id: string, at: number) =>
      insertRow(db, "transcript_revision", {
        id, content_id: "c1", kind: "asr", language: "zh", timing_fidelity: "segment_only",
        generation_json: JSON.stringify({ kind: "asr", asrProfileId: "p", modelId: "m" }), segment_count: 1, created_at: at,
      });
    revision("r1", T0);
    revision("r2", T0 + 1);
    insertRow(db, "transcript_segment", { id: "s1", revision_id: "r1", ordinal: 0, start_ms: 0, end_ms: 1, text: "a", speaker_id: "A" });
    insertRow(db, "transcript_segment", { id: "s2", revision_id: "r2", ordinal: 0, start_ms: 0, end_ms: 1, text: "b", speaker_id: "B" });
    insertRow(db, "transcript_revision_archive", { revision_id: "r2", content_id: "c1", archived_at: T0 + 2 });
    insertRow(db, "transcript_draft", {
      id: "d", content_id: "c1", base_revision_id: "r1", version: 1, updated_at: T0,
      segments_json: JSON.stringify([
        { startMs: 0, endMs: 1, text: "a", sourceSegmentIds: ["s1"], speakerId: "C" },
        { startMs: 1, endMs: 2, text: "b", sourceSegmentIds: [], speakerId: null },
      ]),
    });
    insertRow(db, "transcript_draft", {
      id: "t", content_id: "c1", base_revision_id: "r1", target_language: "en", version: 1, updated_at: T0,
      segments_json: JSON.stringify([{ startMs: 0, endMs: 1, text: "a", sourceSegmentIds: ["s1"], speakerId: "D" }]),
    });
    expect([...repository.withTransaction((scope) => scope.speakers.usedIds("alice", "c1"))].sort()).toEqual(["A", "C"]);
    expect(repository.withTransaction((scope) => scope.speakers.usedIds("bob", "c1")).size).toBe(0);
  });

  it("suggests the owner's named speakers of other Contents, newest first, matching the query literally", () => {
    repository.withTransaction((scope) => {
      scope.speakers.insert("alice", "c1", [{ id: "a1", name: "蒋炎岩" }, { id: "a2" }], T0);
      scope.speakers.insert("alice", "c2", [{ id: "b1", name: "主持人 100%" }], T0 + 5);
      scope.speakers.insert("bob", "b1", [{ id: "x", name: "蒋炎岩" }], T0 + 9);
    });
    const all = repository.withTransaction((scope) => scope.speakers.suggestions("alice", " ", undefined, 8));
    expect(all.map((s) => [s.contentId, s.id, s.contentTitle])).toEqual([
      ["c2", "b1", "讲座"],
      ["c1", "a1", "访谈"],
    ]);
    expect(repository.withTransaction((scope) => scope.speakers.suggestions("alice", "蒋", "c1", 8))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.speakers.suggestions("alice", "0%", undefined, 8)).map((s) => s.id)).toEqual(["b1"]);
    expect(repository.withTransaction((scope) => scope.speakers.suggestions("alice", "_", undefined, 8))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.speakers.suggestions("alice", "", undefined, 1))).toHaveLength(1);
  });
});

describe("speaker repository: name confirmation", () => {
  it("stores the confirmation given on insert, and reads none where none was given", () => {
    const [confirmed, plain] = repository.withTransaction((scope) =>
      scope.speakers.insert("alice", "c1", [{ id: "A", name: "蒋炎岩", nameConfirmedAt: T0 + 5 }, { id: "B", name: "张三" }], T0),
    );
    expect(confirmed).toMatchObject({ name: "蒋炎岩", nameConfirmedAt: T0 + 5 });
    expect(plain && "nameConfirmedAt" in plain).toBe(false);
    expect(repository.withTransaction((scope) => scope.speakers.get("alice", "c1", "A"))?.nameConfirmedAt).toBe(T0 + 5);
  });

  it("sets and withdraws the confirmation by patch, and leaves it alone when the patch does not name it", () => {
    repository.withTransaction((scope) => scope.speakers.insert("alice", "c1", [{ id: "A", name: "主持人" }], T0));
    const set = repository.withTransaction((scope) => scope.speakers.update("alice", "c1", "A", { nameConfirmedAt: T0 + 1 }, T0 + 1));
    expect(set).toMatchObject({ name: "主持人", nameConfirmedAt: T0 + 1, updatedAt: T0 + 1 });
    const recoloured = repository.withTransaction((scope) => scope.speakers.update("alice", "c1", "A", { colorIndex: 3 }, T0 + 2));
    expect(recoloured).toMatchObject({ colorIndex: 3, nameConfirmedAt: T0 + 1 });
    const withdrawn = repository.withTransaction((scope) => scope.speakers.update("alice", "c1", "A", { name: "嘉宾", nameConfirmedAt: null }, T0 + 3));
    expect(withdrawn?.name).toBe("嘉宾");
    expect(withdrawn && "nameConfirmedAt" in withdrawn).toBe(false);
    expect(repository.withTransaction((scope) => scope.speakers.update("bob", "c1", "A", { nameConfirmedAt: T0 }, T0))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.speakers.get("alice", "c1", "A"))?.nameConfirmedAt).toBeUndefined();
  });

  describe("speakers of comparison transcriptions", () => {
    const revision = (id: string, comparison: boolean, contentId = "c1") =>
      insertRow(db, "transcript_revision", {
        id, content_id: contentId, kind: "asr", language: "zh", timing_fidelity: "segment_only",
        generation_json: JSON.stringify({ kind: "asr", asrProfileId: "p", modelId: "m", ...(comparison ? { purpose: "comparison" } : {}) }), segment_count: 1, created_at: T0,
      });
    let segment = 0;
    const naming = (revisionId: string, speakerId: string) => {
      segment += 1;
      insertRow(db, "transcript_segment", { id: `s${segment}`, revision_id: revisionId, ordinal: segment, start_ms: 0, end_ms: 1, text: "a", speaker_id: speakerId });
    };

    beforeEach(() => {
      segment = 0;
      repository.withTransaction((scope) => scope.speakers.insert("alice", "c1", [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }], T0));
      revision("r1", false);
      revision("r2", true);
      naming("r1", "A");
      naming("r2", "A");
      naming("r2", "B");
      naming("r2", "C");
      // C also in a translation draft: a draft of any kind keeps it in use.
      insertRow(db, "transcript_draft", {
        id: "t", content_id: "c1", base_revision_id: "r1", target_language: "en", version: 1, updated_at: T0,
        segments_json: JSON.stringify([{ startMs: 0, endMs: 1, text: "a", sourceSegmentIds: [], speakerId: "C" }]),
      });
    });

    it("finds the speakers only comparison transcriptions name, for the owner only", () => {
      expect([...repository.withTransaction((scope) => scope.speakers.comparisonOnlyIds("alice", "c1"))]).toEqual(["B"]);
      expect(repository.withTransaction((scope) => scope.speakers.comparisonOnlyIds("bob", "c1")).size).toBe(0);
      expect(repository.withTransaction((scope) => scope.speakers.comparisonOnlyIds("alice", "c2")).size).toBe(0);
      // Made the primary, the comparison is read like any other revision.
      db.prepare("UPDATE content SET primary_transcript_revision_id = 'r2' WHERE id = 'c1'").run();
      expect(repository.withTransaction((scope) => scope.speakers.comparisonOnlyIds("alice", "c1")).size).toBe(0);
    });

    it("reports which speakers anything still names and deletes the others, for the owner only", () => {
      expect([...repository.withTransaction((scope) => scope.speakers.referencedAmong("alice", "c1", ["A", "B", "C", "D"]))].sort()).toEqual(["A", "B", "C"]);
      expect(repository.withTransaction((scope) => scope.speakers.referencedAmong("bob", "c1", ["A", "B", "C"])).size).toBe(0);
      expect(repository.withTransaction((scope) => scope.speakers.referencedAmong("alice", "c1", [])).size).toBe(0);
      expect(repository.withTransaction((scope) => scope.speakers.delete("bob", "c1", ["D"]))).toBe(0);
      expect(repository.withTransaction((scope) => scope.speakers.delete("alice", "c1", ["D"]))).toBe(1);
      expect(repository.withTransaction((scope) => scope.speakers.list("alice", "c1")).map((speaker) => speaker.id)).toEqual(["A", "B", "C"]);
    });

    it("leaves comparison-only speakers out of the suggestions", () => {
      repository.withTransaction((scope) => {
        scope.speakers.update("alice", "c1", "A", { name: "甲" }, T0 + 1);
        scope.speakers.update("alice", "c1", "B", { name: "乙" }, T0 + 2);
      });
      expect(repository.withTransaction((scope) => scope.speakers.suggestions("alice", "", "c2", 8)).map((speaker) => speaker.id)).toEqual(["A"]);
    });
  });
});
