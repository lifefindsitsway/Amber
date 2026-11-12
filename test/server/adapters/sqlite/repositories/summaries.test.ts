import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { SummaryRevision } from "../../../../../src/server/domain/artifact.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const SEGMENT = "01J0000000000000000000000A" as SegmentId;
const modelRef = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  for (const id of ["c", "other"]) {
    insertRow(db, "content", { id, user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  }
  insertRow(db, "transcript_revision", {
    id: "t1", content_id: "c", kind: "asr", language: "zh-CN", timing_fidelity: "exact_words", generation_json: "{}", segment_count: 0, created_at: T0,
  });
  repository.withTransaction((scope) =>
    scope.summaryTemplates.syncBuiltin(
      [
        { id: "summary.core", name: "summaryTemplate.core", versions: [{ version: 1, prompt: "core" }] },
        { id: "summary.terms", name: "summaryTemplate.terms", versions: [{ version: 1, prompt: "terms" }] },
      ],
      T0,
    ),
  );
});

function revision(id: string, createdAt: number, extra: Partial<SummaryRevision> = {}): Omit<SummaryRevision, "artifactId"> {
  return {
    id,
    provenance: {
      inputs: [{ kind: "transcriptRevision", id: "t1" }],
      modelRef,
      promptRef: { id: "summary.core", version: 1 },
      promptSnapshot: "snapshot",
      createdAt,
    },
    quality: "normal",
    body: `正文 [[seg:${SEGMENT}]]`,
    citations: [{ transcriptRevisionId: "t1", segmentId: SEGMENT }],
    ...extra,
  };
}

const insert = (owner: string, contentId: string, templateId: string, artifactId: string, value: Omit<SummaryRevision, "artifactId">) =>
  repository.withTransaction((scope) => scope.summaries.insertRevision(owner, { contentId, templateId, artifactId, revision: value }));

describe("summary repository", () => {
  it("creates the artifact on first use, reuses it after, and leaves current alone", () => {
    expect(insert("alice", "c", "summary.core", "a1", revision("r1", T0))).toEqual({ artifactId: "a1" });
    expect(insert("alice", "c", "summary.core", "ignored", revision("r2", T0 + 1, { quality: "degraded", partialIds: ["p0", "p1"] }))).toEqual({ artifactId: "a1" });
    expect(insert("alice", "c", "summary.terms", "a2", revision("r3", T0 + 2))).toEqual({ artifactId: "a2" });
    expect(repository.withTransaction((scope) => scope.summaries.getArtifact("alice", "a1"))).toEqual({ id: "a1", contentId: "c", templateId: "summary.core" });
    expect(repository.withTransaction((scope) => scope.summaries.findArtifact("alice", "c", "summary.terms"))?.id).toBe("a2");
    expect(repository.withTransaction((scope) => scope.summaries.listArtifacts("alice", "c")).map((artifact) => artifact.id)).toEqual(["a1", "a2"]);
    expect(repository.withTransaction((scope) => scope.summaries.getRevision("alice", "r1"))).toEqual({ ...revision("r1", T0), artifactId: "a1" });
    expect(repository.withTransaction((scope) => scope.summaries.getRevision("alice", "r2"))).toMatchObject({ quality: "degraded", partialIds: ["p0", "p1"] });
    expect(repository.withTransaction((scope) => scope.summaries.listRevisions("alice", "a1")).map((value) => value.id)).toEqual(["r1", "r2"]);
  });

  it("reads back a revision without optional fields as missing keys", () => {
    const bare = revision("r1", T0);
    insert("alice", "c", "summary.core", "a1", { ...bare, provenance: { inputs: [], createdAt: T0 } });
    const read = repository.withTransaction((scope) => scope.summaries.getRevision("alice", "r1"));
    expect(read?.provenance).toEqual({ inputs: [], createdAt: T0 });
    expect(read !== undefined && "chapterRevisionId" in read).toBe(false);
    expect(read !== undefined && "partialIds" in read).toBe(false);
  });

  it("keeps the chapter revision a summary was shown with", () => {
    insertRow(db, "chapter_artifact", { id: "ca", content_id: "c" });
    insertRow(db, "chapter_revision", {
      id: "ch1", artifact_id: "ca", inputs_json: "[]", quality: "normal", origin_json: '{"kind":"platform"}', chapters_json: "[]", created_at: T0,
    });
    insert("alice", "c", "summary.core", "a1", revision("r1", T0, { chapterRevisionId: "ch1" }));
    expect(repository.withTransaction((scope) => scope.summaries.getRevision("alice", "r1"))?.chapterRevisionId).toBe("ch1");
  });

  it("switches current only to a revision of the same artifact", () => {
    insert("alice", "c", "summary.core", "a1", revision("r1", T0));
    insert("alice", "c", "summary.core", "a1", revision("r2", T0 + 1));
    insert("alice", "c", "summary.terms", "a2", revision("r3", T0 + 2));
    repository.withTransaction((scope) => scope.summaries.setCurrent("alice", "a1", "r2"));
    expect(repository.withTransaction((scope) => scope.summaries.getArtifact("alice", "a1"))?.currentRevisionId).toBe("r2");
    expect(() => repository.withTransaction((scope) => scope.summaries.setCurrent("alice", "a1", "r3"))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.summaries.setCurrent("bob", "a1", "r1"))).toThrow();
  });

  it("isolates owners and refuses unknown templates or another owner's Content", () => {
    insert("alice", "c", "summary.core", "a1", revision("r1", T0));
    expect(() => insert("bob", "c", "summary.core", "a9", revision("r9", T0))).toThrow();
    expect(() => insert("alice", "c", "missing", "a9", revision("r9", T0))).toThrow();
    insertRow(db, "summary_template", { id: "bob-own", user_id: "bob", builtin: 0, name: "b", current_version: 1 });
    expect(() => insert("alice", "c", "bob-own", "a9", revision("r9", T0))).toThrow();
    expect(repository.withTransaction((scope) => scope.summaries.getArtifact("bob", "a1"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.summaries.findArtifact("bob", "c", "summary.core"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.summaries.listArtifacts("bob", "c"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.summaries.getRevision("bob", "r1"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.summaries.listRevisions("bob", "a1"))).toEqual([]);
  });

  it("goes with its Content, partials included", () => {
    insert("alice", "c", "summary.core", "a1", revision("r1", T0));
    repository.withTransaction((scope) => {
      scope.summaries.setCurrent("alice", "a1", "r1");
      scope.rollupPartials.insertMany("alice", "summary", [
        {
          id: "p0", ownerRevisionId: "r1", index: 0, inputs: [], body: "b", citations: [], modelRef,
          promptRef: { id: "rollup.partial", version: 1 }, promptSnapshot: "s", createdAt: T0,
        },
      ]);
      scope.contents.delete("alice", "c");
    });
    expect(countRows(db, "summary_artifact")).toBe(0);
    expect(countRows(db, "summary_revision")).toBe(0);
    expect(countRows(db, "rollup_partial")).toBe(0);
  });
});

describe("summary repository: speaker context", () => {
  const speakerContext = {
    version: 1 as const,
    rules: { id: "speaker.rules", version: 1 },
    attributionDigest: "a".repeat(64),
    speakers: [
      { id: "s1", ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" },
      { id: "s2", ordinal: 2, label: "发言人 2" },
    ],
  };

  it("stores the snapshot with the provenance and reads it back field for field, also after the database is reopened", () => {
    const opened = openTempDatabase();
    const value = revision("r1", T0);
    const withSpeakers = { ...value, provenance: { ...value.provenance, speakerContext } };
    const own = new SqliteRepository(opened.db);
    insertRow(opened.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
    insertRow(opened.db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    own.withTransaction((scope) => scope.summaryTemplates.syncBuiltin([{ id: "summary.core", name: "summaryTemplate.core", versions: [{ version: 1, prompt: "core" }] }], T0));
    own.withTransaction((scope) => scope.summaries.insertRevision("alice", { contentId: "c", templateId: "summary.core", artifactId: "a1", revision: withSpeakers }));
    expect(own.withTransaction((scope) => scope.summaries.getRevision("alice", "r1"))).toEqual({ ...withSpeakers, artifactId: "a1" });
    opened.db.close();
    const reopened = openDatabase(opened.file, { backupDir: join(opened.dir, "backups") });
    try {
      const read = new SqliteRepository(reopened.db).withTransaction((scope) => scope.summaries.getRevision("alice", "r1"));
      expect(read?.provenance.speakerContext).toEqual(speakerContext);
    } finally {
      reopened.db.close();
    }
  });

  it("reads a row without the column, or with a value of another shape, as having no snapshot", () => {
    insert("alice", "c", "summary.core", "a1", revision("r1", T0));
    // Rows are immutable once written: the odd value is written as a restored backup would.
    insertRow(db, "summary_revision", {
      id: "r2", artifact_id: "a1", inputs_json: "[]", quality: "normal", body: "b", citations_json: "[]", created_at: T0 + 1,
      speaker_context_json: JSON.stringify({ version: 2, speakers: "x" }),
    });
    for (const id of ["r1", "r2"]) {
      const read = repository.withTransaction((scope) => scope.summaries.getRevision("alice", id));
      expect(read && "speakerContext" in read.provenance).toBe(false);
    }
  });
});
