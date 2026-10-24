import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { RevisionReference } from "../../../../../src/server/domain/transcript.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";
import { lectureTranscripts, type TranscriptFixture } from "../../../../fixtures/transcripts/lecture.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;
let lecture: TranscriptFixture;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  for (const [id, userId] of [["c", "alice"], ["other", "alice"], ["bobs", "bob"]] as const) {
    insertRow(db, "content", { id, user_id: userId, source_kind: "bilibili", processing_status: "queued", created_at: T0, updated_at: T0 });
  }
  lecture = lectureTranscripts("c");
  repository.withTransaction((scope) => {
    for (const { revision, segments } of [lecture.platform, lecture.asr, lecture.corrected]) {
      scope.transcripts.insertRevision("alice", revision, segments);
    }
  });
});

function task(id: string, fields: { userId?: string; contentId: string; request?: unknown; finishedAt?: number }): void {
  insertRow(db, "task", {
    id,
    user_id: fields.userId ?? "alice",
    content_id: fields.contentId,
    kind: "process_content",
    request_json: JSON.stringify(fields.request ?? { kind: "process_content" }),
    status_projection: fields.finishedAt === undefined ? "running" : "succeeded",
    created_at: T0,
    ...(fields.finishedAt === undefined ? {} : { finished_at: fields.finishedAt }),
  });
}

const activeTasks = (): RevisionReference[] =>
  repository.withTransaction((scope) => scope.revisionReferences.listReferences("alice", "c")).filter((reference) => reference.category === "activeTasks");

describe("revision references of unfinished Tasks", () => {
  it("lets an unfinished Task of the Content reach every revision of it, whatever its request names", () => {
    task("own", { contentId: "c" });
    const all = [lecture.platform, lecture.asr, lecture.corrected].map(({ revision }) => revision.id).sort();
    expect(activeTasks().map((reference) => [...reference.revisionIds].sort())).toEqual([all]);
  });

  it("counts a Task once even when its request also names a revision", () => {
    task("own", { contentId: "c", request: { kind: "reproofread", baseRevisionId: lecture.asr.revision.id } });
    expect(activeTasks()).toHaveLength(1);
  });

  it("leaves out finished Tasks, and Tasks of other Contents unless their request names a revision", () => {
    task("done", { contentId: "c", finishedAt: T0 + 1 });
    task("elsewhere", { contentId: "other" });
    task("bobs", { userId: "bob", contentId: "bobs" });
    expect(activeTasks()).toEqual([]);
    task("cross", { contentId: "other", request: { kind: "summarize_collection", inputItems: [{ transcriptRevisionId: lecture.corrected.revision.id }] } });
    expect(activeTasks().map((reference) => reference.revisionIds)).toEqual([[lecture.corrected.revision.id]]);
  });
});
