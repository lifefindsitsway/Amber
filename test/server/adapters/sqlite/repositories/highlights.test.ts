import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { lectureTranscripts } from "../../../../fixtures/transcripts/lecture.ts";
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
let fixtures: Record<string, ReturnType<typeof lectureTranscripts>>;

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
  fixtures = {};
  for (const [id, owner] of [["c", "alice"], ["c2", "alice"], ["cb", "bob"]] as const) {
    insertRow(db, "content", { id, user_id: owner, source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    const fixture = lectureTranscripts(id);
    repository.withTransaction((scope) => scope.transcripts.insertRevision(owner, fixture.asr.revision, fixture.asr.segments));
    fixtures[id] = fixture;
  }
});

function revision(id: string, contentId = "c", createdAt = T0) {
  const asr = fixtures[contentId]?.asr;
  return {
    id,
    artifactId: `a-${id}`,
    transcriptRevisionId: asr?.revision.id as string,
    items: [{ segmentId: asr?.segments[1]?.id as SegmentId, score: 88, text: "关键" }],
    modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
    promptRef: { id: "highlight.default", version: 1 },
    promptSnapshot: "<highlight prompt>",
    quality: "normal" as const,
    createdAt,
  };
}

describe("highlight repository", () => {
  it("creates the artifact once, keeps every revision and moves current only on setCurrent", () => {
    repository.withTransaction((scope) => scope.highlights.insertRevision("alice", "c", revision("r1")));
    expect(repository.withTransaction((scope) => scope.highlights.getArtifact("alice", "c"))).toEqual({ id: "a-r1", contentId: "c" });
    expect(repository.withTransaction((scope) => scope.highlights.getCurrent("alice", "c"))).toBeUndefined();

    repository.withTransaction((scope) => {
      scope.highlights.insertRevision("alice", "c", revision("r2", "c", T0 + 1));
      scope.highlights.setCurrent("alice", "c", "r2");
    });
    expect(db.prepare("SELECT id FROM highlight_artifact").all()).toEqual([{ id: "a-r1" }]);
    expect(db.prepare("SELECT id, artifact_id FROM highlight_revision ORDER BY id").all()).toEqual([
      { id: "r1", artifact_id: "a-r1" },
      { id: "r2", artifact_id: "a-r1" },
    ]);
    const current = repository.withTransaction((scope) => scope.highlights.getCurrent("alice", "c"));
    expect(current).toMatchObject({
      id: "r2",
      artifactId: "a-r1",
      transcriptRevisionId: fixtures["c"]?.asr.revision.id,
      quality: "normal",
      items: [{ segmentId: fixtures["c"]?.asr.segments[1]?.id, score: 88, text: "关键" }],
      provenance: {
        inputs: [{ kind: "transcriptRevision", id: fixtures["c"]?.asr.revision.id }],
        modelRef: { providerProfileId: "p", modelId: "m" },
        promptRef: { id: "highlight.default", version: 1 },
        promptSnapshot: "<highlight prompt>",
        createdAt: T0 + 1,
      },
    });
    expect(repository.withTransaction((scope) => scope.highlights.getArtifact("alice", "c"))?.currentRevisionId).toBe("r2");
    expect(repository.withTransaction((scope) => scope.highlights.getRevision("alice", "r1"))?.id).toBe("r1");
  });

  it("refuses a transcript of another Content, a foreign Content and a revision of another artifact", () => {
    const foreignTranscript = { ...revision("rx"), transcriptRevisionId: fixtures["c2"]?.asr.revision.id as string };
    expect(() => repository.withTransaction((scope) => scope.highlights.insertRevision("alice", "c", foreignTranscript))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.highlights.insertRevision("bob", "c", revision("ry")))).toThrow();
    repository.withTransaction((scope) => {
      scope.highlights.insertRevision("alice", "c", revision("r1"));
      scope.highlights.insertRevision("alice", "c2", revision("r2", "c2"));
    });
    expect(() => repository.withTransaction((scope) => scope.highlights.setCurrent("alice", "c", "r2"))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.highlights.setCurrent("alice", "c", "missing"))).toThrow();
    expect(repository.withTransaction((scope) => scope.highlights.getCurrent("alice", "c"))).toBeUndefined();
  });

  it("keeps owners apart", () => {
    repository.withTransaction((scope) => {
      scope.highlights.insertRevision("alice", "c", revision("r1"));
      scope.highlights.setCurrent("alice", "c", "r1");
    });
    repository.withTransaction((scope) => {
      expect(scope.highlights.getArtifact("bob", "c")).toBeUndefined();
      expect(scope.highlights.getRevision("bob", "r1")).toBeUndefined();
      expect(scope.highlights.getCurrent("bob", "c")).toBeUndefined();
      expect(() => scope.highlights.setCurrent("bob", "c", "r1")).toThrow();
    });
  });

  it("goes away with its Content", () => {
    repository.withTransaction((scope) => {
      scope.highlights.insertRevision("alice", "c", revision("r1"));
      scope.highlights.setCurrent("alice", "c", "r1");
    });
    db.prepare("DELETE FROM content WHERE id = 'c'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM highlight_revision").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM highlight_artifact").get()).toEqual({ n: 0 });
  });
});

describe("highlight repository: speaker context", () => {
  it("stores the speakers the highlights were picked with, also across a reopen, and reads none where none were stored or the value is of another shape", () => {
    repository.withTransaction((scope) => {
      scope.highlights.insertRevision("alice", "c", { ...revision("r1"), speakerContext: SPEAKER_CONTEXT });
      scope.highlights.insertRevision("alice", "c", revision("r2", "c", T0 + 1));
    });
    insertRow(db, "highlight_revision", {
      id: "r3", artifact_id: "a-r1", inputs_json: "[]", quality: "normal", transcript_revision_id: fixtures["c"]?.asr.revision.id, items_json: "[]",
      created_at: T0 + 2, speaker_context_json: '{"speakers":[]}',
    });
    const written = repository.withTransaction((scope) => scope.highlights.getRevision("alice", "r1"));
    expect(written?.provenance.speakerContext).toEqual(SPEAKER_CONTEXT);
    reopen();
    const read = repository.withTransaction((scope) => scope.highlights.getRevision("alice", "r1"));
    expect(read).toEqual(written);
    expect(read?.provenance.speakerContext).toEqual(SPEAKER_CONTEXT);
    for (const id of ["r2", "r3"]) {
      const other = repository.withTransaction((scope) => scope.highlights.getRevision("alice", id));
      expect(other && "speakerContext" in other.provenance).toBe(false);
    }
  });
});
