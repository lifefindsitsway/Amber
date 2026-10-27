import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { projectionSnapshot } from "../../fixtures/search/corpus.ts";
import { lectureTranscripts, type TranscriptFixture } from "../../fixtures/transcripts/lecture.ts";
import { countRows, insertRow, tableNames } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

/** An ASR original made primary, optionally with paragraph marks. */
function seed(h: Harness, contentId: string, count: number, paragraphStarts?: readonly boolean[]): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = Array.from({ length: count }, (_, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId,
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text: `第${ordinal + 1}句`,
    ...(paragraphStarts === undefined ? {} : { paragraphStart: paragraphStarts[ordinal] as boolean }),
    sourceSegmentIds: [],
  }));
  const revision: TranscriptRevision = {
    id: revisionId,
    contentId,
    kind: "asr",
    language: "zh-CN",
    timingFidelity: "exact_words",
    generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe" },
    segmentCount: count,
    createdAt: 1,
  };
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 2);
  });
  return { revision, segments };
}

describe("TranscriptService draft commit", () => {
  it("carries the base's paragraph marks into the manual revision: merges keep the first source's, splits open once, new sentences never", () => {
    const h = createHarness();
    open.push(h);
    const contentId = createLocalContent(h);
    const base = seed(h, contentId, 5, [true, false, true, false, true]);
    const ids = base.segments.map((segment) => segment.id);
    const sentence = (startMs: number, sourceSegmentIds: string[]) => ({ startMs, endMs: startMs + 500, text: "改", sourceSegmentIds });
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: base.revision.id,
      segments: [
        sentence(0, [ids[0] as string]),
        sentence(1000, [ids[1] as string, ids[2] as string]),
        sentence(3000, [ids[3] as string]),
        sentence(4000, [ids[4] as string]),
        sentence(4500, [ids[4] as string]),
        sentence(5000, []),
      ],
    });
    const committed = h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: base.revision.id });
    const segments = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, committed.id));
    expect(segments.map((segment) => segment.paragraphStart)).toEqual([true, false, false, true, false, false]);
    expect(h.transcripts.segments(LOCAL, committed.id, { limit: 10 }).items.map((item) => item.paragraphStart)).toEqual([true, false, false, true, false, false]);
  });

  it("adds no marks when the base has none", () => {
    const h = createHarness();
    open.push(h);
    const contentId = createLocalContent(h);
    const base = seed(h, contentId, 2);
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: base.revision.id,
      segments: base.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id] })),
    });
    const committed = h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: base.revision.id });
    const items = h.transcripts.segments(LOCAL, committed.id, { limit: 10 }).items;
    expect(items.map((item) => item.paragraphStart)).toEqual([undefined, undefined]);
    expect(items.every((item) => !("paragraphStart" in item))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Merge on commit, archive, permanent delete

/** The lecture's platform, asr and corrected revisions; corrected is primary. */
function lecture(h: Harness): { contentId: string; fixture: TranscriptFixture } {
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.corrected.revision.id, 2);
  });
  return { contentId, fixture };
}

const primaryOf = (h: Harness, contentId: string) => h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId)?.primaryTranscriptRevisionId);
const revisionOf = (h: Harness, id: string) => h.repository.withTransaction((scope) => scope.transcripts.getRevision(LOCAL.userId, id));
const segmentsOf = (h: Harness, id: string) => h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, id));

/** Edits every sentence of `baseId` one to one and commits against the current primary. */
function commitEdit(h: Harness, contentId: string, baseId: string, extra: Array<{ startMs: number; endMs: number; text: string }> = []) {
  const base = segmentsOf(h, baseId);
  h.transcripts.putDraft(LOCAL, contentId, {
    baseRevisionId: baseId,
    segments: [
      ...base.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: `${segment.text}!`, sourceSegmentIds: [segment.id] })),
      ...extra.map((sentence) => ({ ...sentence, sourceSegmentIds: [] })),
    ],
  });
  return h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: primaryOf(h, contentId) as string });
}

/** A manual revision stored directly, as earlier builds left them: one sentence per parent sentence. */
function insertManual(h: Harness, contentId: string, parentId: string, createdAt: number): TranscriptRevision {
  const parent = segmentsOf(h, parentId);
  const id = h.newId();
  const revision: TranscriptRevision = {
    id,
    contentId,
    kind: "manual",
    parentRevisionId: parentId,
    language: "zh-CN",
    timingFidelity: "inherited_segment",
    generation: { kind: "manual" },
    segmentCount: parent.length,
    createdAt,
  };
  const segments = parent.map((segment, ordinal) => ({ ...segment, id: h.newId() as SegmentId, revisionId: id, ordinal, sourceSegmentIds: [segment.id] }));
  h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision, segments));
  return revision;
}

function insertTranslation(h: Harness, contentId: string, parentId: string, language: string, createdAt: number): TranscriptRevision {
  const parent = segmentsOf(h, parentId);
  const id = h.newId();
  const revision: TranscriptRevision = {
    id,
    contentId,
    kind: "translated",
    parentRevisionId: parentId,
    language,
    timingFidelity: "segment_only",
    generation: { kind: "manual" },
    segmentCount: parent.length,
    createdAt,
  };
  const segments = parent.map((segment, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId: id,
    ordinal,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: `[${language}] ${segment.text}`,
    sourceSegmentIds: [segment.id],
  }));
  h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision, segments));
  return revision;
}

function insertNote(h: Harness, contentId: string, revisionId: string): string {
  const [segment] = segmentsOf(h, revisionId);
  const id = h.newId();
  insertRow(h.db, "note", {
    id,
    user_id: LOCAL.userId,
    content_id: contentId,
    transcript_revision_id: revisionId,
    start_segment_id: segment?.id,
    start_offset: 0,
    end_segment_id: segment?.id,
    end_offset: 1,
    quote: "大",
    mark: "underline",
    color: "blue",
    created_at: 10,
    updated_at: 10,
  });
  return id;
}

function insertChat(h: Harness, contentId: string, text: string, extra: Record<string, unknown> = {}): string {
  let thread = h.db.prepare("SELECT id FROM chat_thread WHERE content_id = ?").get(contentId) as { id: string } | undefined;
  if (thread === undefined) {
    thread = { id: h.newId() };
    insertRow(h.db, "chat_thread", { id: thread.id, content_id: contentId, created_at: 0 });
  }
  const id = h.newId();
  insertRow(h.db, "chat_message", { id, thread_id: thread.id, role: "assistant", text, status: "complete", citations_json: "[]", created_at: 10, ...extra });
  return id;
}

/** The Content's summary artifact of the first builtin template, created on first use. */
function summaryArtifact(h: Harness, contentId: string): string {
  const template = h.db.prepare("SELECT id FROM summary_template WHERE builtin = 1 LIMIT 1").get() as { id: string };
  const existing = h.db.prepare("SELECT id FROM summary_artifact WHERE content_id = ? AND template_id = ?").get(contentId, template.id) as { id: string } | undefined;
  if (existing !== undefined) {
    return existing.id;
  }
  const id = h.newId();
  insertRow(h.db, "summary_artifact", { id, content_id: contentId, template_id: template.id });
  return id;
}

function insertSummary(h: Harness, contentId: string, fields: { inputs?: unknown[]; citations?: unknown[]; body?: string }): string {
  const id = h.newId();
  insertRow(h.db, "summary_revision", {
    id,
    artifact_id: summaryArtifact(h, contentId),
    inputs_json: JSON.stringify(fields.inputs ?? []),
    quality: "normal",
    body: fields.body ?? "",
    citations_json: JSON.stringify(fields.citations ?? []),
    created_at: 10,
  });
  return id;
}

/**
 * A history-only summary (with a rolling partial), chapter and highlight revision citing
 * sentences of a revision, next to current ones that cite nothing of it; returns their ids.
 */
function insertHistory(h: Harness, contentId: string, segments: readonly TranscriptSegment[]): { summary: string; chapter: string; highlight: string; currentSummary: string } {
  const summary = insertSummary(h, contentId, { body: `旧总结 [[seg:${segments[0]?.id}]]` });
  insertRow(h.db, "rollup_partial", {
    id: h.newId(),
    summary_revision_id: summary,
    partial_index: 0,
    inputs_json: "[]",
    body: `分段 [[seg:${segments[1]?.id}]]`,
    citations_json: "[]",
    model_ref_json: "{}",
    prompt_ref_json: "{}",
    prompt_snapshot: "",
    created_at: 10,
  });
  const currentSummary = insertSummary(h, contentId, { body: "当前总结" });
  h.db.prepare("UPDATE summary_artifact SET current_revision_id = ? WHERE id = (SELECT artifact_id FROM summary_revision WHERE id = ?)").run(currentSummary, currentSummary);
  const chapterArtifact = h.newId();
  insertRow(h.db, "chapter_artifact", { id: chapterArtifact, content_id: contentId });
  const chapter = h.newId();
  const currentChapter = h.newId();
  for (const [id, segment] of [[chapter, segments[0]?.id], [currentChapter, undefined]] as const) {
    insertRow(h.db, "chapter_revision", {
      id,
      artifact_id: chapterArtifact,
      inputs_json: "[]",
      quality: "normal",
      origin_json: JSON.stringify({ kind: "ai", transcriptRevisionId: "elsewhere" }),
      chapters_json: JSON.stringify([{ startMs: 0, endMs: 1, title: "t", ...(segment === undefined ? {} : { startSegmentId: segment }) }]),
      created_at: 10,
    });
  }
  h.db.prepare("UPDATE chapter_artifact SET current_revision_id = ? WHERE id = ?").run(currentChapter, chapterArtifact);
  const highlightArtifact = h.newId();
  insertRow(h.db, "highlight_artifact", { id: highlightArtifact, content_id: contentId });
  const highlight = h.newId();
  insertRow(h.db, "highlight_revision", {
    id: highlight,
    artifact_id: highlightArtifact,
    inputs_json: "[]",
    quality: "normal",
    transcript_revision_id: segments[0]?.revisionId,
    items_json: JSON.stringify([{ segmentId: segments[2]?.id, score: 90, text: "x" }]),
    created_at: 11,
  });
  return { summary, chapter, highlight, currentSummary };
}

async function codeOf(work: () => unknown): Promise<{ code: string; details?: unknown } | undefined> {
  try {
    await work();
  } catch (error) {
    const appError = (error as { appError?: { code: string; details?: unknown } }).appError;
    return appError === undefined ? { code: String(error) } : { code: appError.code, ...(appError.details === undefined ? {} : { details: appError.details }) };
  }
  return undefined;
}

describe("TranscriptService commit merges unreferenced manual revisions", () => {
  it("folds the edited manual revision (the primary) into the new one and maps sources to the anchor", () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const first = commitEdit(h, contentId, fixture.corrected.revision.id);
    expect(first.parentRevisionId).toBe(fixture.corrected.revision.id);
    h.db.prepare("INSERT INTO idempotency_record VALUES (?, 'POST /x', 'k', 'd', 201, ?, '[]', 1)").run(LOCAL.userId, JSON.stringify({ transcriptRevisionId: first.id }));

    const second = commitEdit(h, contentId, first.id, [{ startMs: 30000, endMs: 31000, text: "新句" }]);
    expect(second.parentRevisionId).toBe(fixture.corrected.revision.id);
    expect(revisionOf(h, first.id)).toBeUndefined();
    expect(primaryOf(h, contentId)).toBe(second.id);
    const segments = segmentsOf(h, second.id);
    expect(segments.slice(0, 4).map((segment) => segment.sourceSegmentIds)).toEqual(fixture.corrected.segments.map((segment) => [segment.id]));
    expect(segments[4]?.sourceSegmentIds).toEqual([]);
    expect(segments[0]?.text).toBe(`${fixture.corrected.segments[0]?.text}!!`);
    expect(countRows(h.db, "idempotency_record")).toBe(0);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
    // A sentence of the anchor still maps onto the new revision by lineage.
    expect(h.transcripts.map(LOCAL, fixture.corrected.segments[1]?.id as string, second.id)).toEqual({ segmentId: segments[1]?.id, method: "lineage" });
  });

  it("folds a whole chain left by earlier builds, carrying merged sources through every level", () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const m1 = insertManual(h, contentId, fixture.corrected.revision.id, 3);
    const m2 = insertManual(h, contentId, m1.id, 4);
    const m3 = insertManual(h, contentId, m2.id, 5);
    const base = segmentsOf(h, m3.id);
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: m3.id,
      segments: [
        { startMs: 0, endMs: 9000, text: "合并", sourceSegmentIds: [base[1]?.id as string, base[0]?.id as string, base[1]?.id as string] },
        { startMs: 9900, endMs: 15000, text: "保留", sourceSegmentIds: [base[2]?.id as string] },
      ],
    });
    const committed = h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: fixture.corrected.revision.id });
    expect(committed.parentRevisionId).toBe(fixture.corrected.revision.id);
    for (const gone of [m1, m2, m3]) expect(revisionOf(h, gone.id)).toBeUndefined();
    const corrected = fixture.corrected.segments.map((segment) => segment.id);
    expect(segmentsOf(h, committed.id).map((segment) => segment.sourceSegmentIds)).toEqual([[corrected[1], corrected[0]], [corrected[2]]]);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps a manual revision that anything else references, and stops the chain there", () => {
    type Reference = (h: Harness, contentId: string, m1: TranscriptRevision) => void;
    const references: Record<string, Reference> = {
      note: (h, contentId, m1) => insertNote(h, contentId, m1.id),
      chat: (h, contentId, m1) => insertChat(h, contentId, `见 [[seg:${segmentsOf(h, m1.id)[0]?.id}]]`),
      summary: (h, contentId, m1) => insertSummary(h, contentId, { inputs: [{ kind: "transcriptRevision", id: m1.id }] }),
      child: (h, contentId, m1) => insertTranslation(h, contentId, m1.id, "en", 4),
      highlight: (h, contentId, m1) => {
        insertRow(h.db, "highlight_artifact", { id: "ha", content_id: contentId });
        insertRow(h.db, "highlight_revision", {
          id: "hr",
          artifact_id: "ha",
          inputs_json: JSON.stringify([{ kind: "transcriptRevision", id: m1.id }]),
          quality: "normal",
          transcript_revision_id: m1.id,
          items_json: "[]",
          created_at: 10,
        });
      },
    };
    for (const [name, reference] of Object.entries(references)) {
      const h = createHarness();
      open.push(h);
      const { contentId, fixture } = lecture(h);
      const m1 = commitEdit(h, contentId, fixture.corrected.revision.id);
      reference(h, contentId, m1 as TranscriptRevision);
      const m2 = commitEdit(h, contentId, m1.id);
      expect({ name, parent: m2.parentRevisionId }).toEqual({ name, parent: m1.id });
      expect(revisionOf(h, m1.id)).toBeDefined();
      // The next edit folds m2 (unreferenced) but still stops at m1.
      const m3 = commitEdit(h, contentId, m2.id);
      expect({ name, parent: m3.parentRevisionId, m2: revisionOf(h, m2.id) }).toEqual({ name, parent: m1.id, m2: undefined });
    }
  }, 60_000);

  it("merges nothing while the Content has an unfinished Task, and folds the chain once it has finished", () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const m1 = commitEdit(h, contentId, fixture.corrected.revision.id);
    // Its stages may read the primary (m1) as their base when they run; nothing in its request names it.
    insertRow(h.db, "task", {
      id: "running",
      user_id: LOCAL.userId,
      content_id: contentId,
      kind: "process_content",
      request_json: JSON.stringify({ kind: "process_content" }),
      status_projection: "running",
      created_at: 10,
    });
    // An unfinished Task of another Content that names none of these revisions does not hold the merge.
    insertRow(h.db, "task", {
      id: "elsewhere",
      user_id: LOCAL.userId,
      content_id: createLocalContent(h),
      kind: "process_content",
      request_json: JSON.stringify({ kind: "process_content" }),
      status_projection: "running",
      created_at: 10,
    });
    const m2 = commitEdit(h, contentId, m1.id);
    expect(m2.parentRevisionId).toBe(m1.id);
    expect(revisionOf(h, m1.id)).toBeDefined();
    expect(primaryOf(h, contentId)).toBe(m2.id);

    h.db.prepare("UPDATE task SET finished_at = 20, status_projection = 'succeeded' WHERE id = 'running'").run();
    const m3 = commitEdit(h, contentId, m2.id);
    expect(m3.parentRevisionId).toBe(fixture.corrected.revision.id);
    expect([revisionOf(h, m1.id), revisionOf(h, m2.id)]).toEqual([undefined, undefined]);
  });
});

describe("TranscriptService archive", () => {
  it("archives and restores one revision; the primary and a draft's base refuse; archived revisions are neither primary nor base", async () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const asr = fixture.asr.revision.id;
    const archived = h.transcripts.setArchived(LOCAL, asr, true);
    expect(archived).toMatchObject({ id: asr, archived: true, archivedAt: expect.any(Number), deletable: false });
    expect(h.contents.revisions(LOCAL, contentId).revisions.find((item) => item.id === asr)).toMatchObject({ archived: true });
    expect(await codeOf(() => h.contents.setPrimary(LOCAL, contentId, asr))).toMatchObject({ code: "invalid_request" });
    expect(await codeOf(() => h.transcripts.putDraft(LOCAL, contentId, { baseRevisionId: asr, segments: [] }))).toMatchObject({ code: "invalid_request" });
    expect(h.transcripts.setArchived(LOCAL, asr, false)).toMatchObject({ archived: false });
    expect(h.transcripts.setArchived(LOCAL, asr, false)).not.toHaveProperty("archivedAt");

    expect(await codeOf(() => h.transcripts.setArchived(LOCAL, fixture.corrected.revision.id, true))).toEqual({ code: "conflict.revision_is_primary" });
    h.transcripts.putDraft(LOCAL, contentId, { baseRevisionId: fixture.platform.revision.id, segments: [] });
    expect(await codeOf(() => h.transcripts.setArchived(LOCAL, fixture.platform.revision.id, true))).toMatchObject({
      code: "conflict.revision_referenced",
      details: { draft: 1 },
    });
    expect(await codeOf(() => h.transcripts.setArchived(BOB, asr, true))).toEqual({ code: "not_found" });
  });

  it("archives a platform original like any other revision, keeps it protected from deletion and restores it", async () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const platform = fixture.platform.revision.id;
    const archived = h.transcripts.setArchived(LOCAL, platform, true);
    expect(archived).toMatchObject({ id: platform, kind: "platform", archived: true, archivedAt: expect.any(Number), deletable: false });
    expect(h.contents.revisions(LOCAL, contentId).revisions.find((item) => item.id === platform)).toMatchObject({ archived: true, deletable: false });
    expect(countRows(h.db, "transcript_revision_archive", "revision_id = ?", platform)).toBe(1);
    // Archiving only adds the mark: the revision and its sentences are untouched.
    expect(revisionOf(h, platform)).toEqual(fixture.platform.revision);
    expect(segmentsOf(h, platform)).toHaveLength(fixture.platform.segments.length);
    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, platform, { withDescendants: false }))).toEqual({
      code: "invalid_request.revision_kind_protected",
    });
    expect(h.transcripts.setArchived(LOCAL, platform, false)).toMatchObject({ archived: false });
    expect(countRows(h.db, "transcript_revision_archive")).toBe(0);
  });

  it("discards the draft on request and reports a missing one", async () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    h.transcripts.putDraft(LOCAL, contentId, { baseRevisionId: fixture.corrected.revision.id, segments: [] });
    h.transcripts.discardDraft(LOCAL, contentId);
    expect(await codeOf(() => h.transcripts.getDraft(LOCAL, contentId))).toEqual({ code: "not_found" });
    expect(await codeOf(() => h.transcripts.discardDraft(LOCAL, contentId))).toEqual({ code: "not_found" });
    expect(revisionOf(h, fixture.corrected.revision.id)).toBeDefined();
  });
});

describe("TranscriptService permanent delete", () => {
  /** Lecture plus a manual revision `m` of corrected; corrected stays primary. */
  function withManual(): { h: Harness; contentId: string; fixture: TranscriptFixture; m: TranscriptRevision; mSegments: TranscriptSegment[] } {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const m = insertManual(h, contentId, fixture.corrected.revision.id, 3);
    return { h, contentId, fixture, m, mSegments: segmentsOf(h, m.id) };
  }

  it("refuses with the count of every blocking category", async () => {
    const cases: Array<{ category: string; count: number; add: (setup: ReturnType<typeof withManual>) => void }> = [
      { category: "children", count: 2, add: ({ h, contentId, m }) => [insertTranslation(h, contentId, m.id, "en", 4), insertManual(h, contentId, m.id, 5)] },
      { category: "draft", count: 1, add: ({ h, contentId, m }) => h.transcripts.putDraft(LOCAL, contentId, { baseRevisionId: m.id, segments: [] }) },
      { category: "notes", count: 1, add: ({ h, contentId, m }) => insertNote(h, contentId, m.id) },
      {
        category: "highlights",
        count: 1,
        add: ({ h, contentId, fixture, mSegments }) => {
          insertRow(h.db, "highlight_artifact", { id: "ha", content_id: contentId });
          insertRow(h.db, "highlight_revision", {
            id: "hr",
            artifact_id: "ha",
            inputs_json: JSON.stringify([{ kind: "transcriptRevision", id: fixture.corrected.revision.id }]),
            quality: "normal",
            transcript_revision_id: fixture.corrected.revision.id,
            items_json: JSON.stringify([{ segmentId: mSegments[2]?.id, score: 90, text: "x" }]),
            created_at: 10,
          });
          h.db.prepare("UPDATE highlight_artifact SET current_revision_id = 'hr' WHERE id = 'ha'").run();
        },
      },
      {
        category: "chatMessages",
        count: 4,
        add: ({ h, contentId, m, mSegments }) => {
          insertChat(h, contentId, "plain", { context_transcript_revision_id: m.id });
          insertChat(h, contentId, "plain", { citations_json: JSON.stringify([{ transcriptRevisionId: "other", segmentId: mSegments[0]?.id }]) });
          const through = insertChat(h, contentId, `答 [[seg:${mSegments[1]?.id}]]`);
          // A marker-like id that is not a whole marker does not count.
          insertChat(h, contentId, `seg:${mSegments[1]?.id} [[unresolved:seg:${mSegments[1]?.id}]]`);
          const thread = (h.db.prepare("SELECT id FROM chat_thread WHERE content_id = ?").get(contentId) as { id: string }).id;
          insertRow(h.db, "chat_compaction", {
            id: h.newId(),
            thread_id: thread,
            through_message_id: through,
            body: `摘要 [[seg:${mSegments[3]?.id}]]`,
            model_ref_json: "{}",
            prompt_ref_json: "{}",
            prompt_snapshot: "",
            created_at: 11,
          });
        },
      },
      {
        // Kept from going with history: frozen by a collection summary, or current.
        category: "artifacts",
        count: 6,
        add: ({ h, contentId, m, mSegments }) => {
          const frozen = [
            insertSummary(h, contentId, { inputs: [{ kind: "transcriptRevision", id: m.id }] }),
            insertSummary(h, contentId, { body: `总结 [[seg:${mSegments[0]?.id}]]` }),
            insertSummary(h, contentId, { citations: [{ transcriptRevisionId: m.id, segmentId: mSegments[0]?.id }] }),
            insertSummary(h, contentId, {}),
          ];
          insertRow(h.db, "rollup_partial", {
            id: "rp",
            // A rolling partial is part of its summary: one reference, not two.
            summary_revision_id: frozen[3],
            partial_index: 0,
            inputs_json: "[]",
            body: `分段 [[seg:${mSegments[2]?.id}]]`,
            citations_json: "[]",
            model_ref_json: "{}",
            prompt_ref_json: "{}",
            prompt_snapshot: "",
            created_at: 10,
          });
          insertRow(h.db, "chapter_artifact", { id: "ca", content_id: contentId });
          insertRow(h.db, "chapter_revision", {
            id: "cr",
            artifact_id: "ca",
            inputs_json: "[]",
            quality: "normal",
            origin_json: JSON.stringify({ kind: "ai", transcriptRevisionId: "elsewhere" }),
            chapters_json: JSON.stringify([{ startMs: 0, endMs: 1, title: "t", startSegmentId: mSegments[0]?.id }]),
            created_at: 10,
          });
          h.db.prepare("UPDATE chapter_artifact SET current_revision_id = 'cr' WHERE id = 'ca'").run();
          // A collection summary of another Content's collection still counts: it is the same user's.
          insertRow(h.db, "collection", { id: "col", user_id: LOCAL.userId, name: "合集", created_at: 1 });
          insertRow(h.db, "collection_summary_artifact", { id: "csa", collection_id: "col" });
          insertRow(h.db, "collection_summary_revision", {
            id: "csr",
            artifact_id: "csa",
            inputs_json: "[]",
            quality: "normal",
            input_items_json: JSON.stringify([
              { collectionItemId: "i", contentId, transcriptRevisionId: m.id, position: 0 },
              ...frozen.map((summaryRevisionId, index) => ({ collectionItemId: `f${index}`, contentId, summaryRevisionId, position: index + 1 })),
            ]),
            partial_ids_json: "[]",
            body: "",
            citations_json: "[]",
            created_at: 10,
          });
        },
      },
      {
        // Earlier revisions that only history holds: removable along with the revision.
        category: "history",
        count: 3,
        add: ({ h, contentId, mSegments }) => insertHistory(h, contentId, mSegments),
      },
      {
        category: "activeTasks",
        count: 2,
        add: ({ h, contentId, m }) => {
          const task = (id: string, request: unknown, finishedAt?: number) =>
            insertRow(h.db, "task", {
              id,
              user_id: LOCAL.userId,
              content_id: contentId,
              kind: "burn",
              request_json: JSON.stringify(request),
              status_projection: finishedAt === undefined ? "running" : "succeeded",
              created_at: 10,
              ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
            });
          task("t1", { kind: "burn", revisionId: m.id });
          task("t2", { kind: "summarize_collection", inputItems: [{ transcriptRevisionId: m.id }] });
          // A finished Task is a record of what was done and does not block.
          task("t3", { kind: "proofread", baseRevisionId: m.id }, 20);
        },
      },
      {
        // The Content's own unfinished Task blocks without naming the revision: its stages may
        // read whatever is primary when they run. Another Content's Task naming nothing does not.
        category: "activeTasks",
        count: 1,
        add: ({ h, contentId }) => {
          for (const [id, target] of [["own", contentId], ["other", createLocalContent(h)]] as const) {
            insertRow(h.db, "task", {
              id,
              user_id: LOCAL.userId,
              content_id: target,
              kind: "process_content",
              request_json: JSON.stringify({ kind: "process_content" }),
              status_projection: "running",
              created_at: 10,
            });
          }
        },
      },
    ];
    for (const { category, count, add } of cases) {
      const setup = withManual();
      add(setup);
      const listed = setup.h.contents.revisions(LOCAL, setup.contentId).revisions.find((item) => item.id === setup.m.id);
      expect({ category, blockers: listed?.blockers[category as "notes"], deletable: listed?.deletable }).toEqual({ category, blockers: count, deletable: category === "history" });
      const refused = await codeOf(() => setup.h.transcripts.deleteRevision(LOCAL, setup.m.id, { withDescendants: false }));
      expect({ category, refused }).toEqual({
        category,
        refused: {
          code: "conflict.revision_referenced",
          details: { children: 0, draft: 0, notes: 0, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0, history: 0, [category]: count },
        },
      });
      expect(revisionOf(setup.h, setup.m.id)).toBeDefined();
    }
  }, 60_000);

  it("protects originals and the primary, scopes to the owner and lists what a delete would take", async () => {
    const { h, contentId, fixture, m } = withManual();
    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, fixture.asr.revision.id, { withDescendants: false }))).toEqual({
      code: "invalid_request.revision_kind_protected",
    });
    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, fixture.platform.revision.id, { withDescendants: false }))).toEqual({
      code: "invalid_request.revision_kind_protected",
    });
    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, fixture.corrected.revision.id, { withDescendants: true }))).toEqual({
      code: "conflict.revision_is_primary",
    });
    expect(await codeOf(() => h.transcripts.deleteRevision(BOB, m.id, { withDescendants: false }))).toEqual({ code: "not_found" });
    const items = h.contents.revisions(LOCAL, contentId).revisions;
    expect(items.find((item) => item.id === fixture.asr.revision.id)).toMatchObject({
      deletable: false,
      archived: false,
      descendantIds: [fixture.corrected.revision.id, m.id],
      blockers: { children: 1 },
    });
    expect(items.find((item) => item.id === m.id)).toMatchObject({ deletable: true, descendantIds: [] });
  });

  it("deletes with descendants leaves first, hands translations over and drops idempotency records", () => {
    const { h, contentId, fixture, m } = withManual();
    const older = insertTranslation(h, contentId, fixture.corrected.revision.id, "en", 4);
    const child = insertManual(h, contentId, m.id, 5);
    const translated = insertTranslation(h, contentId, m.id, "en", 6);
    const onlyJa = insertTranslation(h, contentId, child.id, "ja", 7);
    h.repository.withTransaction((scope) => {
      scope.translations.setCurrent(LOCAL.userId, contentId, "en", translated.id, h.newId());
      scope.translations.setCurrent(LOCAL.userId, contentId, "ja", onlyJa.id, h.newId());
    });
    h.transcripts.setArchived(LOCAL, child.id, true);
    insertRow(h.db, "token_usage", {
      id: "u1",
      user_id: LOCAL.userId,
      feature: "translate",
      model_ref_json: "{}",
      input_tokens: 1,
      output_tokens: 1,
      outcome: "succeeded",
      artifact_revision_id: translated.id,
      created_at: 1,
    });
    const record = h.db.prepare("INSERT INTO idempotency_record VALUES (?, ?, ?, 'd', 201, ?, ?, 1)");
    record.run(LOCAL.userId, "POST /a", "k1", JSON.stringify({ transcriptRevisionId: child.id }), "[]");
    record.run(LOCAL.userId, "POST /b", "k2", "{}", JSON.stringify([translated.id]));
    record.run(LOCAL.userId, "POST /c", "k3", JSON.stringify({ transcriptRevisionId: fixture.corrected.revision.id }), "[]");

    h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: true });
    for (const gone of [m, child, translated, onlyJa]) expect(revisionOf(h, gone.id)).toBeUndefined();
    const artifacts = h.repository.withTransaction((scope) => scope.translations.listArtifacts(LOCAL.userId, contentId));
    expect(artifacts.map((artifact) => [artifact.targetLanguage, artifact.currentRevisionId])).toEqual([["en", older.id]]);
    expect(countRows(h.db, "transcript_revision_archive")).toBe(0);
    expect(countRows(h.db, "token_usage", "artifact_revision_id IS NULL")).toBe(1);
    expect((h.db.prepare("SELECT idempotency_key FROM idempotency_record").all() as Array<{ idempotency_key: string }>).map((row) => row.idempotency_key)).toEqual(["k3"]);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("deletes the revision alone by default and refuses while it has children", async () => {
    const { h, contentId, m } = withManual();
    const child = insertManual(h, contentId, m.id, 5);
    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false }))).toMatchObject({ details: { children: 1 } });
    h.transcripts.deleteRevision(LOCAL, child.id, { withDescendants: false });
    h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false });
    expect(revisionOf(h, m.id)).toBeUndefined();
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("re-runs a replayed note request once its revision is gone instead of answering with a deleted id", async () => {
    const { h, contentId, m, mSegments } = withManual();
    const body = {
      transcriptRevisionId: m.id,
      startSegmentId: mSegments[0]?.id as string,
      startOffset: 0,
      endSegmentId: mSegments[0]?.id as string,
      endOffset: 1,
      mark: "underline" as const,
      color: "blue" as const,
    };
    const created = h.notes.create(LOCAL, contentId, body, "same-key");
    expect(h.notes.create(LOCAL, contentId, body, "same-key")).toMatchObject({ replayed: true });
    h.notes.delete(LOCAL, created.body.id);
    h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false });
    expect(countRows(h.db, "idempotency_record")).toBe(0);
    expect(await codeOf(() => h.notes.create(LOCAL, contentId, body, "same-key"))).toEqual({ code: "not_found" });
  });

  it("deletes nothing when it refuses: every table keeps its rows, pointers and marks", async () => {
    const { h, contentId, fixture, m } = withManual();
    const child = insertManual(h, contentId, m.id, 5);
    const translated = insertTranslation(h, contentId, m.id, "en", 6);
    h.repository.withTransaction((scope) => scope.translations.setCurrent(LOCAL.userId, contentId, "en", translated.id, h.newId()));
    h.transcripts.setArchived(LOCAL, child.id, true);
    h.db.prepare("INSERT INTO idempotency_record VALUES (?, 'POST /a', 'k1', 'd', 201, ?, '[]', 1)").run(LOCAL.userId, JSON.stringify({ transcriptRevisionId: child.id }));
    h.search.rebuild();
    // Blockers on a descendant and on the revision itself: a note on the child and a summary citing a sentence of `m`.
    insertNote(h, contentId, child.id);
    const mSegment = segmentsOf(h, m.id)[0]?.id as string;
    insertSummary(h, contentId, { citations: [{ transcriptRevisionId: m.id, segmentId: mSegment }] });

    const snapshot = () => ({
      counts: Object.fromEntries(tableNames(h.db).map((table) => [table, countRows(h.db, table)])),
      revisions: h.db.prepare("SELECT id FROM transcript_revision ORDER BY id").all(),
      segments: h.db.prepare("SELECT id, revision_id FROM transcript_segment ORDER BY id").all(),
      translations: h.db.prepare("SELECT * FROM translation_artifact ORDER BY id").all(),
      archived: h.db.prepare("SELECT * FROM transcript_revision_archive ORDER BY revision_id").all(),
      idempotency: h.db.prepare("SELECT * FROM idempotency_record ORDER BY idempotency_key").all(),
      primary: primaryOf(h, contentId),
      projection: projectionSnapshot(h),
    });
    const before = snapshot();
    expect(before.counts["transcript_revision"]).toBe(6);

    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: true }))).toEqual({
      code: "conflict.revision_referenced",
      details: { children: 0, draft: 0, notes: 1, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0, history: 1 },
    });
    expect(snapshot()).toEqual(before);
    // Alone, the children block as well; still nothing goes.
    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false }))).toMatchObject({
      code: "conflict.revision_referenced",
      details: { children: 2, history: 1 },
    });
    expect(snapshot()).toEqual(before);
    expect(primaryOf(h, contentId)).toBe(fixture.corrected.revision.id);
  });

  it("keeps the search projection in sync: no hit from the deleted revision, the remaining primary is still found", () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    // A manual revision with a sentence of its own, primary for a while so its sentences are projected.
    const m = commitEdit(h, contentId, fixture.corrected.revision.id, [{ startMs: 30000, endMs: 31000, text: "量子纠缠的观测实验" }]);
    const mSegments = new Set(segmentsOf(h, m.id).map((segment) => segment.id as string));
    expect(h.search.search(LOCAL, { q: "量子纠缠" }).segments.map((hit) => hit.transcriptRevisionId)).toEqual([m.id]);

    h.contents.setPrimary(LOCAL, contentId, fixture.corrected.revision.id);
    h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false });
    expect(revisionOf(h, m.id)).toBeUndefined();

    expect(h.search.search(LOCAL, { q: "量子纠缠" }).segments).toEqual([]);
    const remaining = h.search.search(LOCAL, { q: "检索增强" }).segments;
    expect(remaining.map((hit) => [hit.transcriptRevisionId, hit.segmentId])).toEqual([[fixture.corrected.revision.id, fixture.corrected.segments[0]?.id]]);
    const projected = projectionSnapshot(h) as Array<{ revision_id: string | null; segment_id: string | null }>;
    expect(projected.filter((row) => row.revision_id === m.id || (row.segment_id !== null && mSegments.has(row.segment_id)))).toEqual([]);
    // The incremental update leaves exactly what a full rebuild would.
    h.search.rebuild();
    expect(projectionSnapshot(h)).toEqual(projected);
  });

  it("drops the hits of a manual revision folded away by a commit and finds the new primary's sentences", () => {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const m1 = commitEdit(h, contentId, fixture.corrected.revision.id, [{ startMs: 30000, endMs: 31000, text: "量子纠缠的观测实验" }]);
    expect(h.search.search(LOCAL, { q: "量子纠缠" }).segments.map((hit) => hit.transcriptRevisionId)).toEqual([m1.id]);
    // The next edit keeps the first four sentences only; nothing else uses m1, so it is folded into m2 and deleted.
    const kept = segmentsOf(h, m1.id).slice(0, 4);
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: m1.id,
      segments: kept.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id] })),
    });
    const m2 = h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: m1.id });
    expect(revisionOf(h, m1.id)).toBeUndefined();

    expect(h.search.search(LOCAL, { q: "量子纠缠" }).segments).toEqual([]);
    expect(h.search.search(LOCAL, { q: "检索增强" }).segments.map((hit) => hit.transcriptRevisionId)).toEqual([m2.id]);
    const projected = projectionSnapshot(h) as Array<{ revision_id: string | null }>;
    expect(projected.some((row) => row.revision_id === m1.id)).toBe(false);
    h.search.rebuild();
    expect(projectionSnapshot(h)).toEqual(projected);
  });
});

describe("TranscriptService delete together with history artifact revisions", () => {
  function withHistory() {
    const h = createHarness();
    open.push(h);
    const { contentId, fixture } = lecture(h);
    const m = insertManual(h, contentId, fixture.corrected.revision.id, 3);
    const history = insertHistory(h, contentId, segmentsOf(h, m.id));
    insertRow(h.db, "token_usage", {
      id: "usage",
      user_id: LOCAL.userId,
      model_ref_json: "{}",
      feature: "summary",
      artifact_revision_id: history.summary,
      content_id: contentId,
      outcome: "succeeded",
      created_at: 10,
    });
    return { h, contentId, fixture, m, history };
  }

  it("lists them on the revision, refuses without the option and deletes them with it, leaving the current ones", async () => {
    const { h, contentId, m, history } = withHistory();
    const listed = h.contents.revisions(LOCAL, contentId).revisions.find((item) => item.id === m.id);
    expect(listed).toMatchObject({ deletable: true, blockers: { history: 3, artifacts: 0, highlights: 0 } });
    expect(listed?.historyArtifacts.map((artifact) => [artifact.kind, artifact.revisionId])).toEqual([
      ["summary", history.summary],
      ["chapter", history.chapter],
      ["highlight", history.highlight],
    ]);
    expect(listed?.historyArtifacts[0]?.templateId).toBeDefined();

    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false }))).toMatchObject({
      code: "conflict.revision_referenced",
      details: { history: 3 },
    });
    expect(revisionOf(h, m.id)).toBeDefined();

    h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false, withHistory: true });
    expect(revisionOf(h, m.id)).toBeUndefined();
    expect(countRows(h.db, "summary_revision", "id = ?", history.summary)).toBe(0);
    expect(countRows(h.db, "rollup_partial", "summary_revision_id = ?", history.summary)).toBe(0);
    expect(countRows(h.db, "chapter_revision", "id = ?", history.chapter)).toBe(0);
    expect(countRows(h.db, "highlight_revision", "id = ?", history.highlight)).toBe(0);
    expect(countRows(h.db, "summary_revision", "id = ?", history.currentSummary)).toBe(1);
    // Usage is kept; only its link to the deleted revision is cleared.
    expect(h.db.prepare("SELECT artifact_revision_id FROM token_usage WHERE id = 'usage'").get()).toEqual({ artifact_revision_id: null });
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("still refuses, deleting nothing, when anything else holds the revision", async () => {
    const { h, contentId, m, history } = withHistory();
    insertNote(h, contentId, m.id);
    expect(await codeOf(() => h.transcripts.deleteRevision(LOCAL, m.id, { withDescendants: false, withHistory: true }))).toMatchObject({
      code: "conflict.revision_referenced",
      details: { notes: 1, history: 3 },
    });
    expect(revisionOf(h, m.id)).toBeDefined();
    expect(countRows(h.db, "summary_revision", "id = ?", history.summary)).toBe(1);
    expect(countRows(h.db, "chapter_revision", "id = ?", history.chapter)).toBe(1);
  });

  it("keeps a chapter revision a summary was written over among the blocking artifacts", async () => {
    const { h, contentId, m, history } = withHistory();
    // Another template's current summary, written over the earlier chapter revision.
    const template = h.db.prepare("SELECT id FROM summary_template WHERE builtin = 1 ORDER BY id DESC LIMIT 1").get() as { id: string };
    insertRow(h.db, "summary_artifact", { id: "other", content_id: contentId, template_id: template.id });
    insertRow(h.db, "summary_revision", {
      id: "written-over",
      artifact_id: "other",
      inputs_json: "[]",
      quality: "normal",
      body: "",
      citations_json: "[]",
      chapter_revision_id: history.chapter,
      created_at: 12,
    });
    h.db.prepare("UPDATE summary_artifact SET current_revision_id = 'written-over' WHERE id = 'other'").run();
    const listed = h.contents.revisions(LOCAL, contentId).revisions.find((item) => item.id === m.id);
    expect(listed).toMatchObject({ deletable: false, blockers: { history: 2, artifacts: 1 } });
    expect(listed?.historyArtifacts.map((artifact) => artifact.kind)).toEqual(["summary", "highlight"]);
  });

  it("does not fold a manual revision held by history into the next edit", () => {
    const { h, contentId, m, history } = withHistory();
    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, m.id, 20));
    const next = commitEdit(h, contentId, m.id);
    expect(next.parentRevisionId).toBe(m.id);
    expect(revisionOf(h, m.id)).toBeDefined();
    expect(countRows(h.db, "summary_revision", "id = ?", history.summary)).toBe(1);
  });
});
