import { monotonicFactory } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { TranscriptDraft, TranscriptRevision, TranscriptSegment } from "../../../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { insertRow, openTempDatabase, reopenTempDatabase } from "../../../../tools/sqlite.ts";
import { lectureTranscripts, type TranscriptFixture } from "../../../../fixtures/transcripts/lecture.ts";

const T0 = 1_790_000_000_000;
let opened: ReturnType<typeof openTempDatabase>;
let db: SqliteConnection;
let repository: SqliteRepository;
let lecture: TranscriptFixture;

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
  for (const [id, userId] of [["c", "alice"], ["other", "alice"]] as const) {
    insertRow(db, "content", { id, user_id: userId, source_kind: "bilibili", processing_status: "queued", created_at: T0, updated_at: T0 });
  }
  lecture = lectureTranscripts("c");
  repository.withTransaction((scope) => {
    for (const { revision, segments } of [lecture.platform, lecture.asr, lecture.corrected]) {
      scope.transcripts.insertRevision("alice", revision, segments);
    }
  });
});

describe("transcript segments", () => {
  it("pages a revision by ordinal and keeps each page's lineage", () => {
    const corrected = lecture.corrected;
    const page = (afterOrdinal: number | undefined) =>
      repository.withTransaction((scope) =>
        scope.transcripts.listSegments("alice", corrected.revision.id, { ...(afterOrdinal === undefined ? {} : { afterOrdinal }), limit: 3 }),
      );
    const first = page(undefined);
    expect(first.map((segment) => segment.ordinal)).toEqual([0, 1, 2]);
    expect(first.map((segment) => segment.sourceSegmentIds)).toEqual(corrected.segments.slice(0, 3).map((segment) => segment.sourceSegmentIds));
    const second = page(2);
    expect(second.map((segment) => segment.id)).toEqual([corrected.segments[3]?.id]);
    expect(second[0]?.sourceSegmentIds).toEqual(corrected.segments[3]?.sourceSegmentIds);
    expect(page(3)).toEqual([]);
    // Without a page, the whole revision as before.
    expect(repository.withTransaction((scope) => scope.transcripts.listSegments("alice", corrected.revision.id))).toEqual(corrected.segments);
    expect(repository.withTransaction((scope) => scope.transcripts.listSegments("bob", corrected.revision.id, { limit: 3 }))).toEqual([]);
  });

  it("finds a segment by id for its owner only, with words and sources", () => {
    const asr = lecture.asr.segments[1];
    const corrected = lecture.corrected.segments[1];
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("alice", String(asr?.id)))).toEqual(asr);
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("alice", String(corrected?.id)))).toEqual(corrected);
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("bob", String(asr?.id)))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("alice", "missing"))).toBeUndefined();
  });
});

describe("transcript drafts", () => {
  const draft = (id: string, baseRevisionId: string, updatedAt: number, text = "改动", targetLanguage?: string): TranscriptDraft => ({
    id,
    contentId: "c",
    baseRevisionId,
    ...(targetLanguage === undefined ? {} : { targetLanguage }),
    version: 1,
    segments: [{ id: "client-1", startMs: 0, endMs: 1000, text, sourceSegmentIds: [] }],
    updatedAt,
  });
  const put = (owner: string, value: TranscriptDraft, expected: number | null) => repository.withTransaction((scope) => scope.transcripts.putDraft(owner, value, expected));
  const get = (owner: string, language?: string) => repository.withTransaction((scope) => scope.transcripts.getDraft(owner, "c", language));
  const remove = (owner: string, language: string | undefined, expected?: number) =>
    repository.withTransaction((scope) => scope.transcripts.deleteDraft(owner, "c", language, expected));

  it("keeps exactly one draft per Content and replaces it whole", () => {
    expect(get("alice")).toBeUndefined();
    put("alice", draft("d1", lecture.asr.revision.id, T0), null);
    const replacement = { ...draft("d2", lecture.corrected.revision.id, T0 + 1, "再改"), segments: [] };
    expect(put("alice", replacement, 1)).toEqual({ written: { ...replacement, id: "d1", version: 2 } });
    expect(get("alice")).toEqual({ ...replacement, id: "d1", version: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_draft").get()).toEqual({ n: 1 });
    expect(get("bob")).toBeUndefined();
  });

  it("enforces one draft per Content in the schema", () => {
    put("alice", draft("d1", lecture.asr.revision.id, T0), null);
    expect(() =>
      insertRow(db, "transcript_draft", { id: "d2", content_id: "c", base_revision_id: lecture.asr.revision.id, segments_json: "[]", updated_at: T0 }),
    ).toThrow(/UNIQUE/);
  });

  it("refuses a base revision of another Content or owner, and another owner's Content", () => {
    expect(() => put("alice", { ...draft("d1", lecture.asr.revision.id, T0), contentId: "other" }, null)).toThrow();
    expect(() => put("alice", draft("d1", "missing", T0), null)).toThrow();
    expect(() => put("bob", draft("d1", lecture.asr.revision.id, T0), null)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_draft").get()).toEqual({ n: 0 });
  });

  it("deletes the owner's draft only", () => {
    put("alice", draft("d1", lecture.asr.revision.id, T0), null);
    expect(remove("bob", undefined)).toEqual({ deleted: false });
    expect(remove("bob", undefined, 1)).toEqual({ deleted: false });
    expect(remove("alice", undefined)).toEqual({ deleted: true });
    expect(remove("alice", undefined)).toEqual({ deleted: false });
    expect(get("alice")).toBeUndefined();
  });

  it("keeps the transcript draft and each language's draft apart: reads, writes and deletes touch only their own", () => {
    put("alice", draft("o", lecture.asr.revision.id, T0, "原文"), null);
    put("alice", draft("en", lecture.corrected.revision.id, T0, "english", "en"), null);
    put("alice", draft("ja", lecture.corrected.revision.id, T0, "japanese", "ja"), null);
    expect(put("alice", draft("x", lecture.corrected.revision.id, T0 + 1, "english 2", "en"), 1)).toMatchObject({ written: { id: "en", version: 2 } });
    expect(get("alice")).toMatchObject({ id: "o", version: 1, segments: [{ text: "原文" }] });
    expect(get("alice")?.targetLanguage).toBeUndefined();
    expect(get("alice", "en")).toMatchObject({ id: "en", targetLanguage: "en", version: 2, segments: [{ text: "english 2" }] });
    expect(get("alice", "ja")).toMatchObject({ id: "ja", targetLanguage: "ja", version: 1 });
    expect(get("alice", "fr")).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.transcripts.listDrafts("alice", "c")).map((entry) => entry.targetLanguage)).toEqual([undefined, "en", "ja"]);
    expect(repository.withTransaction((scope) => scope.transcripts.listDrafts("bob", "c"))).toEqual([]);
    expect(remove("alice", "en", 2)).toEqual({ deleted: true });
    expect(get("alice")).toMatchObject({ id: "o" });
    expect(get("alice", "ja")).toMatchObject({ id: "ja" });
    expect(remove("alice", undefined, 1)).toEqual({ deleted: true });
    expect(get("alice", "ja")).toMatchObject({ id: "ja" });
    expect(() =>
      insertRow(db, "transcript_draft", { id: "ja2", content_id: "c", base_revision_id: lecture.asr.revision.id, target_language: "ja", segments_json: "[]", updated_at: T0 }),
    ).toThrow(/UNIQUE/);
  });

  it("writes and deletes only at the expected version, and never recreates a deleted draft", () => {
    put("alice", draft("d1", lecture.asr.revision.id, T0), null);
    expect(put("alice", draft("d2", lecture.asr.revision.id, T0, "抢先"), null)).toEqual({ currentVersion: 1 });
    expect(put("alice", draft("d1", lecture.asr.revision.id, T0, "第二"), 1)).toMatchObject({ written: { version: 2 } });
    expect(put("alice", draft("d1", lecture.asr.revision.id, T0, "旧窗口"), 1)).toEqual({ currentVersion: 2 });
    expect(get("alice")).toMatchObject({ version: 2, segments: [{ text: "第二" }] });
    expect(remove("alice", undefined, 1)).toEqual({ currentVersion: 2 });
    expect(remove("alice", undefined, 2)).toEqual({ deleted: true });
    expect(put("alice", draft("d1", lecture.asr.revision.id, T0, "晚到"), 2)).toEqual({ currentVersion: null });
    expect(get("alice")).toBeUndefined();
    expect(put("alice", draft("d3", lecture.asr.revision.id, T0, "en", "en"), 4)).toEqual({ currentVersion: null });
    expect(get("alice", "en")).toBeUndefined();
  });
});

describe("transcript revisions: speaker records in the generation", () => {
  const SPEAKER_CONTEXT = {
    version: 1 as const,
    rules: { id: "speaker.rules", version: 1 },
    attributionDigest: "d".repeat(64),
    speakers: [
      { id: "s1", ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" },
      { id: "s2", ordinal: 2, label: "发言人 2" },
    ],
  };
  const modelRef = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
  const nextId = monotonicFactory();

  /** A revision copying its parent's sentences one for one. */
  function child(id: string, parent: { revision: TranscriptRevision; segments: TranscriptSegment[] }, revision: Omit<TranscriptRevision, "id" | "contentId" | "parentRevisionId" | "segmentCount">) {
    const segments = parent.segments.map((segment, ordinal) => ({
      id: nextId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      sourceSegmentIds: [segment.id],
    }));
    return { revision: { ...revision, id, contentId: "c", parentRevisionId: parent.revision.id, segmentCount: segments.length }, segments };
  }

  it("keeps the speakers a proofread, a commit and a hand-edited translation recorded, field for field, across a reopen", () => {
    const proofread = child(nextId(), lecture.asr, {
      kind: "corrected", language: "zh-CN", timingFidelity: "inherited_segment", createdAt: T0 + 10,
      generation: { kind: "llm", modelRef, promptRef: { id: "proofread", version: 1 }, promptRefs: [{ id: "proofread", version: 1 }], promptSnapshot: "p", speakerContext: SPEAKER_CONTEXT },
    });
    const committed = child(nextId(), proofread, {
      kind: "manual", language: "zh-CN", timingFidelity: "inherited_segment", createdAt: T0 + 11,
      generation: { kind: "manual", speakerReview: { acceptedSuggestions: 2, changedFromParent: 3 } },
    });
    const translated = child(nextId(), committed, {
      kind: "translated", language: "en", timingFidelity: "segment_only", createdAt: T0 + 12,
      generation: { kind: "manual", origin: { revisionId: nextId(), modelRef, promptRef: { id: "translate", version: 1 }, speakerContext: SPEAKER_CONTEXT } },
    });
    const written = [proofread, committed, translated];
    repository.withTransaction((scope) => {
      for (const { revision, segments } of written) scope.transcripts.insertRevision("alice", revision, segments);
    });
    reopen();
    for (const { revision } of written) {
      expect(repository.withTransaction((scope) => scope.transcripts.getRevision("alice", revision.id))).toEqual(revision);
    }
    const listed = repository.withTransaction((scope) => scope.transcripts.listRevisions("alice", "c"));
    const generations = written.map(({ revision }) => listed.find((item) => item.id === revision.id)?.generation);
    expect(generations[0]).toMatchObject({ kind: "llm", speakerContext: SPEAKER_CONTEXT });
    expect(generations[1]).toEqual({ kind: "manual", speakerReview: { acceptedSuggestions: 2, changedFromParent: 3 } });
    expect(generations[2]).toMatchObject({ kind: "manual", origin: { speakerContext: SPEAKER_CONTEXT } });
    // A revision recorded without any of them reads back without the keys.
    const plain = repository.withTransaction((scope) => scope.transcripts.getRevision("alice", lecture.corrected.revision.id));
    expect(plain?.generation).toEqual(lecture.corrected.revision.generation);
    expect(plain?.generation !== undefined && "speakerContext" in plain.generation).toBe(false);
  });
});
