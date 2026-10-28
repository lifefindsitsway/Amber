import { afterEach, describe, expect, it } from "vitest";
import { amberError } from "../../../../src/server/domain/errors.ts";
import { checkTranscriptInvariants, type TranscriptRevision, type TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { SEEK_MATCH_TOLERANCE_MS } from "../../../../src/shared/defaults.ts";
import { taskDetailDtoSchema, taskListDtoSchema } from "../../../../src/shared/dto/task.ts";
import { lectureTranscripts } from "../../../fixtures/transcripts/lecture.ts";
import {
  builtinPromptRefs,
  BOB_TOKEN,
  configureLlm,
  countingExecutor,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  LOCAL_TOKEN,
  taskOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";
import { countRows, insertRow, tableNames } from "../../../tools/sqlite.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content with the lecture's platform, asr and corrected revisions; corrected is primary. */
async function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.corrected.revision.id, 2);
  });
  const { app } = await h.app();
  return { h, app, contentId, fixture };
}

function primaryOf(h: Harness, contentId: string): string | undefined {
  return h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId)?.primaryTranscriptRevisionId);
}

function insertRoot(h: Harness, contentId: string, lines: Array<[number, number]>): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const id = h.newId();
  const segments = lines.map(([startMs, endMs], ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId: id,
    ordinal,
    startMs,
    endMs,
    text: `line ${ordinal}`,
    sourceSegmentIds: [],
  }));
  const revision: TranscriptRevision = {
    id,
    contentId,
    kind: "imported",
    language: "en",
    timingFidelity: "segment_only",
    generation: { kind: "imported", format: "srt" },
    segmentCount: segments.length,
    createdAt: 5,
  };
  h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision, segments));
  return { revision, segments };
}

describe("GET /api/transcript/revisions/:rid/segments", () => {
  it("pages segments in ordinal order with an opaque cursor and hides foreign revisions", async () => {
    const { app, fixture } = await setup();
    const url = `/api/transcript/revisions/${fixture.asr.revision.id}/segments`;
    const first = await app.inject({ method: "GET", url: `${url}?limit=3`, headers: auth });
    expect(first.statusCode).toBe(200);
    expect(first.json().revision).toMatchObject({ id: fixture.asr.revision.id, kind: "asr" });
    expect(first.json().items.map((segment: { id: string }) => segment.id)).toEqual(fixture.asr.segments.slice(0, 3).map((segment) => segment.id));
    expect(first.json().items[0].words).toHaveLength(5);
    const second = await app.inject({ method: "GET", url: `${url}?limit=3&cursor=${first.json().nextCursor as string}`, headers: auth });
    expect(second.json().items.map((segment: { id: string }) => segment.id)).toEqual([fixture.asr.segments[3]?.id]);
    expect(second.json().nextCursor).toBeUndefined();
    const corrected = await app.inject({ method: "GET", url: `/api/transcript/revisions/${fixture.corrected.revision.id}/segments`, headers: auth });
    expect(corrected.json().items[1]).toMatchObject({ sourceSegmentIds: [fixture.asr.segments[1]?.id] });
    expect((await app.inject({ method: "GET", url: `${url}?cursor=%21%21`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${url}?limit=0`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });
});

describe("Draft → Commit and a concurrent switch of the primary", () => {
  it("commits a manual revision onto the draft's base, then refuses a stale expected primary without writing anything", async () => {
    const { h, app, contentId, fixture } = await setup();
    const draftUrl = `/api/contents/${contentId}/transcript/draft`;
    const commitUrl = `${draftUrl}/commit`;
    const base = fixture.corrected;
    expect((await app.inject({ method: "GET", url: draftUrl, headers: auth })).statusCode).toBe(404);

    // Merge the first two sentences, fix the third, keep the fourth.
    const [s0, s1, s2, s3] = base.segments as [TranscriptSegment, TranscriptSegment, TranscriptSegment, TranscriptSegment];
    const segments = [
      { id: "client-1", startMs: s0.startMs, endMs: s1.endMs, text: `${s0.text}${s1.text}`, sourceSegmentIds: [s0.id, s1.id] },
      { startMs: s2.startMs, endMs: s2.endMs, text: "首先看一下 Embedding 模型的工作方式。", sourceSegmentIds: [s2.id] },
      { startMs: s3.startMs, endMs: s3.endMs, text: s3.text, sourceSegmentIds: [s3.id] },
    ];
    const saved = await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: base.revision.id, segments } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ contentId, baseRevisionId: base.revision.id, segments: [{ id: "client-1" }, {}, {}] });
    expect((await app.inject({ method: "GET", url: draftUrl, headers: auth })).json().segments).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: draftUrl, headers: bob })).statusCode).toBe(404);

    const committed = await app.inject({ method: "POST", url: commitUrl, headers: auth, payload: { expectedPrimaryRevisionId: base.revision.id } });
    expect(committed.statusCode).toBe(201);
    const manual = committed.json() as { id: string };
    expect(committed.json()).toMatchObject({ kind: "manual", parentRevisionId: base.revision.id, language: "zh-CN", timingFidelity: "inherited_segment", segmentCount: 3 });
    expect(primaryOf(h, contentId)).toBe(manual.id);
    const stored = h.repository.withTransaction((scope) => ({
      revision: scope.transcripts.getRevision(LOCAL.userId, manual.id) as TranscriptRevision,
      segments: scope.transcripts.listSegments(LOCAL.userId, manual.id),
    }));
    expect(checkTranscriptInvariants(stored.revision, stored.segments)).toEqual([]);
    expect(stored.segments.map((segment) => segment.sourceSegmentIds)).toEqual([[s0.id, s1.id], [s2.id], [s3.id]]);
    expect(stored.segments.every((segment) => !base.segments.some((parent) => parent.id === segment.id))).toBe(true);
    expect((await app.inject({ method: "GET", url: draftUrl, headers: auth })).statusCode).toBe(404);

    // A second editor opens on the manual revision; meanwhile the primary is switched to the ASR original.
    const second = await app.inject({
      method: "PUT",
      url: draftUrl,
      headers: auth,
      payload: { baseRevisionId: manual.id, segments: [{ startMs: 0, endMs: 1000, text: "x", sourceSegmentIds: [] }] },
    });
    expect(second.statusCode).toBe(200);
    const switched = await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: fixture.asr.revision.id } });
    expect(switched.statusCode).toBe(200);
    const revisions = countRows(h.db, "transcript_revision");
    const stale = await app.inject({ method: "POST", url: commitUrl, headers: auth, payload: { expectedPrimaryRevisionId: manual.id } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "conflict.primary_changed", details: { currentPrimaryRevisionId: fixture.asr.revision.id } });
    expect(primaryOf(h, contentId)).toBe(fixture.asr.revision.id);
    expect(countRows(h.db, "transcript_revision")).toBe(revisions);
    expect((await app.inject({ method: "GET", url: draftUrl, headers: auth })).statusCode).toBe(200);

    // Confirmed against the primary that is current now, the same draft commits. Nothing else
    // uses the earlier manual revision, so it is folded into the new one.
    const confirmed = await app.inject({ method: "POST", url: commitUrl, headers: auth, payload: { expectedPrimaryRevisionId: fixture.asr.revision.id } });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json()).toMatchObject({ kind: "manual", parentRevisionId: base.revision.id });
    expect(h.repository.withTransaction((scope) => scope.transcripts.getRevision(LOCAL.userId, manual.id))).toBeUndefined();
  });

  it("refuses drafts that break the revision invariants and bases that cannot be edited", async () => {
    const { h, app, contentId, fixture } = await setup();
    const draftUrl = `/api/contents/${contentId}/transcript/draft`;
    const commit = () => app.inject({ method: "POST", url: `${draftUrl}/commit`, headers: auth, payload: { expectedPrimaryRevisionId: fixture.corrected.revision.id } });
    const put = (segments: unknown[], baseRevisionId = fixture.corrected.revision.id) =>
      app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId, segments } });
    const [c0, c1] = fixture.corrected.segments as [TranscriptSegment, TranscriptSegment];

    expect((await commit()).statusCode).toBe(404);
    for (const segments of [
      [],
      [{ startMs: 1000, endMs: 1000, text: "a", sourceSegmentIds: [] }],
      [{ startMs: -1, endMs: 10, text: "a", sourceSegmentIds: [] }],
      [
        { startMs: 5000, endMs: 6000, text: "a", sourceSegmentIds: [c1.id] },
        { startMs: 4000, endMs: 7000, text: "b", sourceSegmentIds: [c0.id] },
      ],
      [{ startMs: 0, endMs: 10, text: "a", sourceSegmentIds: [fixture.asr.segments[0]?.id] }],
    ]) {
      expect((await put(segments)).statusCode, JSON.stringify(segments)).toBe(200);
      const refused = await commit();
      expect(refused.statusCode, JSON.stringify(segments)).toBe(400);
      expect(refused.json().error.class).toBe("invalid_request");
    }
    expect(primaryOf(h, contentId)).toBe(fixture.corrected.revision.id);

    const translatedId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        {
          id: translatedId,
          contentId,
          kind: "translated",
          parentRevisionId: fixture.corrected.revision.id,
          language: "en",
          timingFidelity: "segment_only",
          generation: {
            kind: "llm",
            modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
            promptRef: { id: "translate.subtitles", version: 1 },
            promptSnapshot: "…",
          },
          segmentCount: 1,
          createdAt: 9,
        },
        [{ id: h.newId() as SegmentId, revisionId: translatedId, ordinal: 0, startMs: c0.startMs, endMs: c0.endMs, text: "Hello", sourceSegmentIds: [c0.id] }],
      ),
    );
    expect((await put([], translatedId)).statusCode).toBe(400);
    expect((await put([], "unknown")).statusCode).toBe(404);
    const otherContent = createLocalContent(h);
    expect((await app.inject({ method: "PUT", url: `/api/contents/${otherContent}/transcript/draft`, headers: auth, payload: { baseRevisionId: fixture.corrected.revision.id, segments: [] } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: draftUrl, headers: bob, payload: { baseRevisionId: fixture.corrected.revision.id, segments: [] } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: fixture.corrected.revision.id, segments: [], extra: 1 } })).statusCode).toBe(400);
  });
});

describe("same-sentence mapping, four branches", () => {
  it("answers lineage, overlap, nearest and none", async () => {
    const { h, app, contentId, fixture } = await setup();
    const map = async (segmentId: string, targetRevision: string, headers = auth) =>
      app.inject({ method: "GET", url: `/api/transcript/segments/${segmentId}/map?targetRevision=${targetRevision}`, headers });

    // Same lineage: the corrected sentence back to its ASR original.
    const lineage = await map(fixture.corrected.segments[1]?.id ?? "", fixture.asr.revision.id);
    expect(lineage.statusCode).toBe(200);
    expect(lineage.json()).toEqual({ segmentId: fixture.asr.segments[1]?.id, method: "lineage" });

    // Different lineage: platform captions against the ASR original, by time overlap.
    expect((await map(fixture.platform.segments[1]?.id ?? "", fixture.asr.revision.id)).json()).toEqual({
      segmentId: fixture.asr.segments[1]?.id,
      method: "overlap",
    });

    // No overlap: the nearest start within the tolerance, else nothing.
    const sparse = insertRoot(h, contentId, [
      [0, 1000],
      [5000, 6000],
    ]);
    const probe = insertRoot(h, contentId, [
      [2000, 3000],
      [6000 + SEEK_MATCH_TOLERANCE_MS + 1000, 6000 + SEEK_MATCH_TOLERANCE_MS + 2000],
    ]);
    expect((await map(probe.segments[0]?.id ?? "", sparse.revision.id)).json()).toEqual({ segmentId: sparse.segments[0]?.id, method: "nearest" });
    expect((await map(probe.segments[1]?.id ?? "", sparse.revision.id)).json()).toEqual({ segmentId: null, method: "none" });

    expect((await map(fixture.asr.segments[0]?.id ?? "", fixture.asr.revision.id, bob)).statusCode).toBe(404);
    expect((await map("unknown", fixture.asr.revision.id)).statusCode).toBe(404);
    const elsewhere = insertRoot(h, createLocalContent(h), [[0, 1000]]);
    expect((await map(fixture.asr.segments[0]?.id ?? "", elsewhere.revision.id)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/transcript/segments/${fixture.asr.segments[0]?.id ?? ""}/map`, headers: auth })).statusCode).toBe(400);
  });
});

describe("POST /api/contents/:id/transcript/proofread", () => {
  it("creates a reproofread Task frozen on the current primary, replays by key and refuses a second one", async () => {
    const { h, app, contentId, fixture } = await setup();
    const modelRef = configureLlm(h);
    const url = `/api/contents/${contentId}/transcript/proofread`;
    const first = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "p-1" }, payload: { modelRef } });
    expect(first.statusCode).toBe(202);
    const { taskId } = first.json() as { taskId: string };
    expect(taskOf(h, taskId).kind).toBe("reproofread");
    expect(JSON.parse(taskOf(h, taskId).requestJson)).toEqual({ requestSchemaVersion: 1, kind: "reproofread", promptRefs: builtinPromptRefs("reproofread"), modelRef, baseRevisionId: fixture.corrected.revision.id });
    const replay = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "p-1" }, payload: { modelRef } });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ taskId });
    const second = await app.inject({ method: "POST", url, headers: auth });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict.mutation_lane");
  });

  it("answers 400 without a primary or with a foreign model, 404 for a foreign Content and 507 below the disk mark", async () => {
    const { h, app, contentId } = await setup();
    const bare = createLocalContent(h);
    const noPrimary = await app.inject({ method: "POST", url: `/api/contents/${bare}/transcript/proofread`, headers: auth, payload: {} });
    expect(noPrimary.statusCode).toBe(400);
    const url = `/api/contents/${contentId}/transcript/proofread`;
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { modelRef: { providerProfileId: "nope", modelId: "m" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { temperature: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob })).statusCode).toBe(404);
    h.disk.low();
    expect((await app.inject({ method: "POST", url, headers: auth })).statusCode).toBe(507);
    expect(countRows(h.db, "task")).toBe(0);
  });
});

describe("revision archive, delete and draft discard routes", () => {
  it("archives, lists, deletes with descendants and discards a draft", async () => {
    const { h, app, contentId, fixture } = await setup();
    const listUrl = `/api/contents/${contentId}/transcript/revisions`;
    const archive = (rid: string, archived: unknown) => app.inject({ method: "PUT", url: `/api/transcript/revisions/${rid}/archived`, headers: auth, payload: { archived } });

    const archived = await archive(fixture.asr.revision.id, true);
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ id: fixture.asr.revision.id, archived: true, deletable: false, descendantIds: [fixture.corrected.revision.id] });
    expect((await archive(fixture.asr.revision.id, "yes")).statusCode).toBe(400);
    expect((await archive(fixture.corrected.revision.id, true)).json().error.code).toBe("conflict.revision_is_primary");
    expect((await archive(fixture.asr.revision.id, true)).statusCode).toBe(200);
    const listed = (await app.inject({ method: "GET", url: listUrl, headers: auth })).json() as { revisions: Array<{ id: string; archived: boolean; blockers: Record<string, number> }> };
    expect(listed.revisions.find((item) => item.id === fixture.asr.revision.id)).toMatchObject({ archived: true, blockers: { children: 1 } });
    expect((await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: fixture.asr.revision.id } })).statusCode).toBe(400);
    expect((await archive(fixture.asr.revision.id, false)).json()).toMatchObject({ archived: false });

    // A manual revision with a translation child: refused alone, deleted with its descendants.
    const draftUrl = `/api/contents/${contentId}/transcript/draft`;
    const segments = fixture.corrected.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id] }));
    await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: fixture.corrected.revision.id, segments } });
    const manual = (await app.inject({ method: "POST", url: `${draftUrl}/commit`, headers: auth, payload: { expectedPrimaryRevisionId: fixture.corrected.revision.id } })).json() as { id: string };
    await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: fixture.corrected.revision.id } });
    const translationId = h.newId();
    const manualSegments = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, manual.id));
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        {
          id: translationId,
          contentId,
          kind: "translated",
          parentRevisionId: manual.id,
          language: "en",
          timingFidelity: "segment_only",
          generation: { kind: "manual" },
          segmentCount: manualSegments.length,
          createdAt: 9,
        },
        manualSegments.map((segment, ordinal) => ({ id: h.newId() as SegmentId, revisionId: translationId, ordinal, startMs: segment.startMs, endMs: segment.endMs, text: "en", sourceSegmentIds: [segment.id] })),
      ),
    );
    const deleteUrl = `/api/transcript/revisions/${manual.id}`;
    const refused = await app.inject({ method: "DELETE", url: deleteUrl, headers: auth });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "conflict.revision_referenced", details: { children: 1, notes: 0 } });
    expect((await app.inject({ method: "DELETE", url: `${deleteUrl}?withDescendants=maybe`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `${deleteUrl}?withDescendants=true`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${deleteUrl}?withDescendants=true`, headers: auth })).statusCode).toBe(204);
    expect(countRows(h.db, "transcript_revision", "id IN (?, ?)", manual.id, translationId)).toBe(0);
    const protectedDelete = await app.inject({ method: "DELETE", url: `/api/transcript/revisions/${fixture.asr.revision.id}?withDescendants=false`, headers: auth });
    expect(protectedDelete.statusCode).toBe(400);
    expect(protectedDelete.json().error.code).toBe("invalid_request.revision_kind_protected");

    await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: fixture.corrected.revision.id, segments } });
    expect((await app.inject({ method: "DELETE", url: draftUrl, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: draftUrl, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: draftUrl, headers: auth })).statusCode).toBe(404);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  /** A manual revision of corrected, one sentence per parent sentence; corrected stays primary. */
  function insertManual(h: Harness, contentId: string, parentId: string): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
    const parent = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, parentId));
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
      createdAt: 3,
    };
    const segments = parent.map((segment, ordinal) => ({ ...segment, id: h.newId() as SegmentId, revisionId: id, ordinal, sourceSegmentIds: [segment.id] }));
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision, segments));
    return { revision, segments };
  }

  const tableCounts = (h: Harness) => Object.fromEntries(tableNames(h.db).map((table) => [table, countRows(h.db, table)]));

  it("archives a platform original: 200, then listed as archived", async () => {
    const { h, app, contentId, fixture } = await setup();
    const platform = fixture.platform.revision.id;
    const archived = await app.inject({ method: "PUT", url: `/api/transcript/revisions/${platform}/archived`, headers: auth, payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ id: platform, kind: "platform", archived: true, archivedAt: expect.any(Number), deletable: false });
    const listed = (await app.inject({ method: "GET", url: `/api/contents/${contentId}/transcript/revisions`, headers: auth })).json() as {
      revisions: Array<{ id: string; archived: boolean }>;
    };
    expect(listed.revisions.find((item) => item.id === platform)).toMatchObject({ archived: true });
    expect(listed.revisions.filter((item) => item.archived).map((item) => item.id)).toEqual([platform]);
    expect(countRows(h.db, "transcript_revision", "id = ?", platform)).toBe(1);
  });

  it("refuses a delete held by a note and a citing summary with 409 and their counts, deleting nothing", async () => {
    const { h, app, contentId, fixture } = await setup();
    const manual = insertManual(h, contentId, fixture.corrected.revision.id);
    const [first, second] = manual.segments as [TranscriptSegment, TranscriptSegment];
    insertRow(h.db, "note", {
      id: h.newId(), user_id: LOCAL.userId, content_id: contentId, transcript_revision_id: manual.revision.id,
      start_segment_id: first.id, start_offset: 0, end_segment_id: first.id, end_offset: 1, quote: "大",
      mark: "underline", color: "blue", created_at: 10, updated_at: 10,
    });
    const template = h.db.prepare("SELECT id FROM summary_template WHERE builtin = 1 LIMIT 1").get() as { id: string };
    insertRow(h.db, "summary_artifact", { id: "sa", content_id: contentId, template_id: template.id });
    insertRow(h.db, "summary_revision", {
      id: "sr", artifact_id: "sa", inputs_json: "[]", quality: "normal", body: `要点 [[seg:${second.id}]]`,
      citations_json: JSON.stringify([{ transcriptRevisionId: manual.revision.id, segmentId: second.id }]), created_at: 10,
    });
    const before = tableCounts(h);

    for (const query of ["", "?withDescendants=true", "?withHistory=true"]) {
      const refused = await app.inject({ method: "DELETE", url: `/api/transcript/revisions/${manual.revision.id}${query}`, headers: auth });
      expect(refused.statusCode, query).toBe(409);
      expect(refused.json().error).toMatchObject({
        class: "conflict",
        code: "conflict.revision_referenced",
        // The summary has no current revision, so it is history only: removable with `withHistory`, but the note still holds.
        details: { children: 0, draft: 0, notes: 1, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0, history: 1 },
      });
      expect(tableCounts(h), query).toEqual(before);
    }
    expect(countRows(h.db, "transcript_segment", "revision_id = ?", manual.revision.id)).toBe(manual.segments.length);

    // Without the note, only history holds it: refused alone, deleted together with `withHistory=true`.
    h.db.prepare("DELETE FROM note WHERE transcript_revision_id = ?").run(manual.revision.id);
    const url = `/api/transcript/revisions/${manual.revision.id}`;
    expect((await app.inject({ method: "DELETE", url, headers: auth })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `${url}?withHistory=true`, headers: auth })).statusCode).toBe(204);
    expect(countRows(h.db, "summary_revision", "id = 'sr'")).toBe(0);
    expect(countRows(h.db, "transcript_revision", "id = ?", manual.revision.id)).toBe(0);
  });

  it("deletes a revision refused for the draft based on it once that draft is discarded", async () => {
    const { h, app, contentId, fixture } = await setup();
    const manual = insertManual(h, contentId, fixture.corrected.revision.id);
    const draftUrl = `/api/contents/${contentId}/transcript/draft`;
    const saved = await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: manual.revision.id, segments: [] } });
    expect(saved.statusCode).toBe(200);
    const deletion = { method: "DELETE" as const, url: `/api/transcript/revisions/${manual.revision.id}?withDescendants=true`, headers: auth };

    const refused = await app.inject(deletion);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "conflict.revision_referenced", details: { draft: 1, children: 0, notes: 0, artifacts: 0, activeTasks: 0 } });
    expect(countRows(h.db, "transcript_revision", "id = ?", manual.revision.id)).toBe(1);

    expect((await app.inject({ method: "DELETE", url: draftUrl, headers: auth })).statusCode).toBe(204);
    expect((await app.inject(deletion)).statusCode).toBe(204);
    expect(countRows(h.db, "transcript_revision", "id = ?", manual.revision.id)).toBe(0);
    expect(countRows(h.db, "transcript_segment", "revision_id = ?", manual.revision.id)).toBe(0);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("still lists and details finished Tasks whose requests named a deleted revision, without exposing its id", async () => {
    const { h, app, contentId, fixture } = await setup();
    const modelRef = configureLlm(h);
    const manual = insertManual(h, contentId, fixture.corrected.revision.id).revision.id;
    const reproofread = () => createTaskOfKind(h, "reproofread", { modelRef, baseRevisionId: manual }, { contentId });
    const deleteUrl = `/api/transcript/revisions/${manual}`;

    // Cancelled: while it is unfinished, it holds the revision.
    const cancelled = reproofread();
    const held = await app.inject({ method: "DELETE", url: deleteUrl, headers: auth });
    expect(held.statusCode).toBe(409);
    expect(held.json().error).toMatchObject({ code: "conflict.revision_referenced", details: { activeTasks: 1 } });
    expect((await app.inject({ method: "POST", url: `/api/tasks/${cancelled}/cancel`, headers: auth })).statusCode).toBe(200);

    // Failed, then succeeded, both run by the scheduler.
    h.executors.proofread = { run: async () => Promise.reject(amberError("llm_capability")) };
    const failed = reproofread();
    h.scheduler.start();
    await h.scheduler.whenIdle();
    h.executors.proofread = countingExecutor();
    const succeeded = reproofread();
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    const taskIds = [cancelled, failed, succeeded];
    expect(taskIds.map((id) => taskOf(h, id).statusProjection)).toEqual(["cancelled", "failed", "succeeded"]);

    expect((await app.inject({ method: "DELETE", url: deleteUrl, headers: auth })).statusCode).toBe(204);
    expect(countRows(h.db, "transcript_revision", "id = ?", manual)).toBe(0);
    // The finished requests keep what they were asked to do; only the API view must not show it.
    for (const id of taskIds) expect(taskOf(h, id).requestJson).toContain(manual);

    const list = await app.inject({ method: "GET", url: `/api/tasks?contentId=${contentId}`, headers: auth });
    expect(list.statusCode).toBe(200);
    expect(taskListDtoSchema.parse(list.json()).items.map((task) => task.id).sort()).toEqual([...taskIds].sort());
    expect(JSON.stringify(list.json()).includes(manual)).toBe(false);
    for (const id of taskIds) {
      const detail = await app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: auth });
      expect(detail.statusCode, id).toBe(200);
      expect(taskDetailDtoSchema.parse(detail.json()).id).toBe(id);
      expect(JSON.stringify(detail.json()).includes(manual), id).toBe(false);
    }
  });
});
