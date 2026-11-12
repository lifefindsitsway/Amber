import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { ChapterRevision } from "../../../../../src/server/domain/artifact.ts";
import { insertRow, openTempDatabase, reopenTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const SPEAKER_CONTEXT = {
  version: 1 as const,
  rules: { id: "speaker.rules", version: 1 },
  attributionDigest: "d".repeat(64),
  speakers: [
    { id: "s1", ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" },
    { id: "s2", ordinal: 2, label: "发言人 2" },
  ],
};
let opened: ReturnType<typeof openTempDatabase>;
let db: SqliteConnection;
let repository: SqliteRepository;

/** Closes the database and opens its file again, so what is read next comes from disk. */
function reopen(): void {
  opened = reopenTempDatabase(opened);
  db = opened.db;
  repository = new SqliteRepository(db);
}

beforeEach(() => {
  opened = openTempDatabase();
  db = opened.db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

describe("chapter repository", () => {
  it("answers whether a Content has platform chapters", () => {
    insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "bilibili", processing_status: "queued", created_at: T0, updated_at: T0 });
    expect(repository.withTransaction((scope) => scope.chapters.hasPlatformChapters("alice", "c"))).toBe(false);
    insertRow(db, "chapter_artifact", { id: "ca", content_id: "c" });
    insertRow(db, "chapter_revision", {
      id: "cr", artifact_id: "ca", inputs_json: "[]", quality: "fresh", origin_json: '{"kind":"platform"}', chapters_json: "[]", created_at: T0,
    });
    expect(repository.withTransaction((scope) => scope.chapters.hasPlatformChapters("alice", "c"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.chapters.hasPlatformChapters("bob", "c"))).toBe(false);
  });
});

describe("platform chapter revisions", () => {
  const chapters = [
    { startMs: 0, endMs: 60_000, title: "One" },
    { startMs: 60_000, endMs: 120_000, title: "Two" },
  ];

  beforeEach(() => {
    insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "bilibili", processing_status: "queued", created_at: T0, updated_at: T0 });
  });

  it("creates the artifact on first use and reuses a revision with the same chapters", () => {
    const first = repository.withTransaction((scope) => scope.chapters.insertPlatformRevision("alice", "c", { id: "r1", artifactId: "a1", chapters, createdAt: T0 }));
    expect(first).toEqual({ revisionId: "r1", created: true });
    // Same chapters in a different key order: the same content.
    const reordered = chapters.map(({ title, endMs, startMs }) => ({ title, endMs, startMs }));
    const again = repository.withTransaction((scope) => scope.chapters.insertPlatformRevision("alice", "c", { id: "r2", artifactId: "a2", chapters: reordered, createdAt: T0 + 1 }));
    expect(again).toEqual({ revisionId: "r1", created: false });
    const changed = repository.withTransaction((scope) =>
      scope.chapters.insertPlatformRevision("alice", "c", { id: "r3", artifactId: "a3", chapters: [{ startMs: 0, endMs: 120_000, title: "All" }], createdAt: T0 + 2 }),
    );
    expect(changed).toEqual({ revisionId: "r3", created: true });
    expect(db.prepare("SELECT id FROM chapter_artifact").all()).toEqual([{ id: "a1" }]);
    expect(db.prepare("SELECT id, artifact_id FROM chapter_revision ORDER BY id").all()).toEqual([
      { id: "r1", artifact_id: "a1" },
      { id: "r3", artifact_id: "a1" },
    ]);
    expect(repository.withTransaction((scope) => scope.chapters.hasPlatformChapters("alice", "c"))).toBe(true);
  });

  it("points the artifact at a current revision and reads it back with platform origin and empty inputs", () => {
    expect(repository.withTransaction((scope) => scope.chapters.getCurrent("alice", "c"))).toBeUndefined();
    repository.withTransaction((scope) => {
      scope.chapters.insertPlatformRevision("alice", "c", { id: "r1", artifactId: "a1", chapters, createdAt: T0 });
      scope.chapters.setCurrent("alice", "c", "r1");
    });
    expect(repository.withTransaction((scope) => scope.chapters.getCurrent("alice", "c"))).toMatchObject({
      id: "r1",
      artifactId: "a1",
      origin: { kind: "platform" },
      provenance: { inputs: [], createdAt: T0 },
      chapters,
    });
    expect(repository.withTransaction((scope) => scope.chapters.getCurrent("bob", "c"))).toBeUndefined();
  });

  it("refuses another owner's Content and revisions of other artifacts", () => {
    expect(() =>
      repository.withTransaction((scope) => scope.chapters.insertPlatformRevision("bob", "c", { id: "r1", artifactId: "a1", chapters, createdAt: T0 })),
    ).toThrow();
    repository.withTransaction((scope) => scope.chapters.insertPlatformRevision("alice", "c", { id: "r1", artifactId: "a1", chapters, createdAt: T0 }));
    expect(() => repository.withTransaction((scope) => scope.chapters.setCurrent("bob", "c", "r1"))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.chapters.setCurrent("alice", "c", "missing"))).toThrow();
  });
});

describe("AI chapter revisions", () => {
  const modelRef = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
  const chapters = [
    { startMs: 120, endMs: 9900, title: "开场", summary: "介绍 RAG", startSegmentId: "01J0000000000000000000000A" },
    { startMs: 9900, endMs: 20900, title: "Embedding", startSegmentId: "01J0000000000000000000000B" },
  ] as ChapterRevision["chapters"];
  const ai = (id: string, artifactId: string, createdAt: number) => ({
    id,
    artifactId,
    transcriptRevisionId: "t1",
    chapters,
    modelRef,
    promptRef: { id: "chapter.ai", version: 1 },
    promptSnapshot: "snapshot",
    quality: "normal" as const,
    createdAt,
  });

  beforeEach(() => {
    for (const id of ["c", "other"]) {
      insertRow(db, "content", { id, user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    }
    insertRow(db, "transcript_revision", {
      id: "t1", content_id: "c", kind: "asr", language: "zh-CN", timing_fidelity: "exact_words", generation_json: "{}", segment_count: 0, created_at: T0,
    });
  });

  it("creates the artifact on first use, reads back the provenance and leaves current alone", () => {
    repository.withTransaction((scope) => scope.chapters.insertAiRevision("alice", "c", ai("r1", "a1", T0)));
    expect(repository.withTransaction((scope) => scope.chapters.getArtifact("alice", "c"))).toEqual({ id: "a1", contentId: "c" });
    expect(repository.withTransaction((scope) => scope.chapters.getCurrent("alice", "c"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.chapters.getRevision("alice", "r1"))).toEqual({
      id: "r1",
      artifactId: "a1",
      provenance: {
        inputs: [{ kind: "transcriptRevision", id: "t1" }],
        modelRef,
        promptRef: { id: "chapter.ai", version: 1 },
        promptSnapshot: "snapshot",
        createdAt: T0,
      },
      quality: "normal",
      origin: { kind: "ai", transcriptRevisionId: "t1" },
      chapters,
    });
    expect(repository.withTransaction((scope) => scope.chapters.hasPlatformChapters("alice", "c"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.chapters.getRevision("bob", "r1"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.chapters.getArtifact("bob", "c"))).toBeUndefined();
  });

  it("lists every revision of the artifact oldest first and switches current between origins", () => {
    repository.withTransaction((scope) => {
      scope.chapters.insertAiRevision("alice", "c", ai("r2", "a1", T0 + 2));
      scope.chapters.insertPlatformRevision("alice", "c", { id: "r1", artifactId: "ignored", chapters: [{ startMs: 0, endMs: 60_000, title: "P" }], createdAt: T0 + 1 });
      scope.chapters.insertAiRevision("alice", "c", ai("r3", "ignored", T0 + 3));
    });
    expect(repository.withTransaction((scope) => scope.chapters.listRevisions("alice", "c")).map((revision) => revision.id)).toEqual(["r1", "r2", "r3"]);
    expect(repository.withTransaction((scope) => scope.chapters.listRevisions("bob", "c"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.chapters.listRevisions("alice", "other"))).toEqual([]);
    repository.withTransaction((scope) => scope.chapters.setCurrent("alice", "c", "r3"));
    expect(repository.withTransaction((scope) => scope.chapters.getArtifact("alice", "c"))).toEqual({ id: "a1", contentId: "c", currentRevisionId: "r3" });
    repository.withTransaction((scope) => scope.chapters.setCurrent("alice", "c", "r1"));
    expect(repository.withTransaction((scope) => scope.chapters.getCurrent("alice", "c"))?.origin).toEqual({ kind: "platform" });
  });

  it("refuses another owner, a transcript of another Content and a revision of another Content's artifact", () => {
    expect(() => repository.withTransaction((scope) => scope.chapters.insertAiRevision("bob", "c", ai("r1", "a1", T0)))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.chapters.insertAiRevision("alice", "other", ai("r1", "a1", T0)))).toThrow();
    repository.withTransaction((scope) => {
      scope.chapters.insertAiRevision("alice", "c", ai("r1", "a1", T0));
      scope.chapters.insertPlatformRevision("alice", "other", { id: "p1", artifactId: "a2", chapters: [{ startMs: 0, endMs: 1000, title: "P" }], createdAt: T0 });
    });
    expect(() => repository.withTransaction((scope) => scope.chapters.setCurrent("alice", "other", "r1"))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.chapters.setCurrent("alice", "c", "p1"))).toThrow();
  });

  it("stores the speakers the chapters were generated with, also across a reopen, and reads none where none were stored or the value is of another shape", () => {
    repository.withTransaction((scope) => {
      scope.chapters.insertAiRevision("alice", "c", { ...ai("r1", "a1", T0), speakerContext: SPEAKER_CONTEXT });
      scope.chapters.insertAiRevision("alice", "c", ai("r2", "a1", T0 + 1));
      scope.chapters.insertPlatformRevision("alice", "c", { id: "p1", artifactId: "a1", chapters: [{ startMs: 0, endMs: 1000, title: "T" }], createdAt: T0 + 2 });
    });
    insertRow(db, "chapter_revision", {
      id: "r3", artifact_id: "a1", inputs_json: "[]", quality: "normal", origin_json: '{"kind":"ai","transcriptRevisionId":"t1"}', chapters_json: "[]",
      created_at: T0 + 3, speaker_context_json: '{"version":1}',
    });
    const written = repository.withTransaction((scope) => scope.chapters.getRevision("alice", "r1"));
    expect(written?.provenance.speakerContext).toEqual(SPEAKER_CONTEXT);
    reopen();
    const read = repository.withTransaction((scope) => scope.chapters.getRevision("alice", "r1"));
    expect(read).toEqual(written);
    expect(read?.provenance.speakerContext).toEqual(SPEAKER_CONTEXT);
    for (const id of ["r2", "p1", "r3"]) {
      const other = repository.withTransaction((scope) => scope.chapters.getRevision("alice", id));
      expect(other && "speakerContext" in other.provenance).toBe(false);
    }
  });
});
