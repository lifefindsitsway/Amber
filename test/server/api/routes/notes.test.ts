import { afterEach, describe, expect, it } from "vitest";
import { API_PAGE_SIZE_MAX } from "../../../../src/shared/defaults.ts";
import { noteDtoSchema, noteGroupsDtoSchema, noteListDtoSchema } from "../../../../src/shared/dto/note.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { jsonRequestDigest } from "../../../../src/server/application/idempotency.ts";
import { NOTE_CREATE_ROUTE } from "../../../../src/server/application/notes.ts";
import type { TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { lectureTranscripts } from "../../../fixtures/transcripts/lecture.ts";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content with the lecture's ASR original and its proofread. */
async function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
  });
  const { app } = await h.app();
  const first = fixture.corrected.segments[0]?.id as string;
  const payload = {
    transcriptRevisionId: fixture.corrected.revision.id, startSegmentId: first, startOffset: 0, endSegmentId: first, endOffset: 3, mark: "background", color: "yellow",
  };
  return { h, app, contentId, fixture, payload };
}

describe("POST /api/contents/:id/notes", () => {
  it("creates a note (201), replays an Idempotency-Key and refuses it with another body", async () => {
    const { app, contentId, payload } = await setup();
    const url = `/api/contents/${contentId}/notes`;
    const created = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "note-1" }, payload });
    expect(created.statusCode).toBe(201);
    const note = noteDtoSchema.parse(created.json());
    expect(note.quote).toBe("大家好");
    const replay = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "note-1" }, payload });
    expect([replay.statusCode, replay.json()]).toEqual([201, created.json()]);
    const conflict = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "note-1" }, payload: { ...payload, color: "blue" } });
    expect([conflict.statusCode, conflict.json().error.class]).toEqual([409, "idempotency_conflict"]);
    const listed = noteListDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json());
    expect(listed.items.map((item) => item.id)).toEqual([note.id]);
  });

  it("replays a recorded response with the quote as it reads now, and the recorded body once the note is gone", async () => {
    const { h, app, contentId } = await setup();
    // A punctuation-restored revision without closing punctuation, where an earlier reading
    // rule put a space between sentences, and a create recorded under that rule.
    const revisionId = h.newId();
    const segments: TranscriptSegment[] = ["第一句没有标点", "第二句。"].map((text, ordinal) => ({
      id: h.newId() as SegmentId, revisionId, ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 1000, text, sourceSegmentIds: [], paragraphStart: ordinal === 0,
    }));
    const payload = {
      transcriptRevisionId: revisionId, startSegmentId: segments[0]?.id as string, startOffset: 2, endSegmentId: segments[1]?.id as string, endOffset: 3,
      mark: "background" as const, color: "yellow" as const,
    };
    const noteId = h.newId();
    const recorded = { id: noteId, contentId, contentTitle: "", ...payload, startMs: 0, quote: "句没有标点 第二句", createdAt: 10, updatedAt: 10 };
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id: revisionId, contentId, kind: "imported", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: 2, createdAt: 9 },
        segments,
      );
      scope.notes.insert({ ...payload, id: noteId, userId: LOCAL.userId, contentId, quote: recorded.quote, createdAt: 10, updatedAt: 10 });
      scope.idempotency.insert({
        userId: LOCAL.userId, route: NOTE_CREATE_ROUTE, key: "legacy-key", requestDigest: jsonRequestDigest({ contentId, body: payload }),
        responseStatus: 201, responseBodyJson: JSON.stringify(recorded), resourceRefsJson: JSON.stringify([noteId]), createdAt: 10,
      });
    });
    const url = `/api/contents/${contentId}/notes`;
    const replay = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "legacy-key" }, payload });
    expect(replay.statusCode).toBe(201);
    expect(noteDtoSchema.parse(replay.json())).toEqual({ ...recorded, quote: "句没有标点第二句" });
    expect((h.db.prepare("SELECT count(*) AS n FROM note").get() as { n: number }).n).toBe(1);
    for (const read of [url, `${url}?revision=${revisionId}`]) {
      expect(noteListDtoSchema.parse((await app.inject({ method: "GET", url: read, headers: auth })).json()).items[0]?.quote).toBe("句没有标点第二句");
    }
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, headers: auth, payload: { color: "blue" } })).json().quote).toBe("句没有标点第二句");
    expect(h.db.prepare("SELECT quote FROM note WHERE id = ?").get(noteId)).toEqual({ quote: "句没有标点 第二句" });

    expect((await app.inject({ method: "DELETE", url: `/api/notes/${noteId}`, headers: auth })).statusCode).toBe(204);
    const gone = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "legacy-key" }, payload });
    expect([gone.statusCode, gone.json()]).toEqual([201, recorded]);
    expect((h.db.prepare("SELECT count(*) AS n FROM note").get() as { n: number }).n).toBe(0);
  });

  it("validates the body and reports refined anchor errors", async () => {
    const { app, contentId, payload } = await setup();
    const url = `/api/contents/${contentId}/notes`;
    for (const bad of [{ ...payload, quote: "client text" }, { ...payload, mark: "strike" }, { ...payload, comment: "   " }, { ...payload, endOffset: 0 }]) {
      const response = await app.inject({ method: "POST", url, headers: auth, payload: bad });
      expect([response.statusCode, response.json().error.class]).toEqual([400, "invalid_request"]);
    }
    const anchor = await app.inject({ method: "POST", url, headers: auth, payload: { ...payload, startOffset: 3, endOffset: 2 } });
    expect([anchor.statusCode, anchor.json().error.code]).toEqual([400, "invalid_request.note_anchor"]);
    const malformedKey = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "has space" }, payload });
    expect(malformedKey.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob, payload })).statusCode).toBe(404);
  });
});

describe("GET /api/contents/:id/notes", () => {
  it("adds a view only when a revision is asked for, and refuses a revision of another Content", async () => {
    const { h, app, contentId, fixture, payload } = await setup();
    const url = `/api/contents/${contentId}/notes`;
    await app.inject({ method: "POST", url, headers: auth, payload });
    const plain = noteListDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json());
    expect("view" in (plain.items[0] ?? {})).toBe(false);
    const mapped = noteListDtoSchema.parse((await app.inject({ method: "GET", url: `${url}?revision=${fixture.asr.revision.id}`, headers: auth })).json());
    expect(mapped.items[0]?.view).toEqual({ segments: [{ segmentId: fixture.asr.segments[0]?.id, startOffset: 0, endOffset: 3 }], exact: true });
    const elsewhere = createLocalContent(h);
    const otherFixture = lectureTranscripts(elsewhere);
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, otherFixture.asr.revision, otherFixture.asr.segments));
    expect((await app.inject({ method: "GET", url: `${url}?revision=${otherFixture.asr.revision.id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });
});

describe("PATCH and DELETE /api/notes/:id", () => {
  it("patches mark, colour and comment, deletes with 204 and then answers 404", async () => {
    const { app, contentId, payload } = await setup();
    const note = (await app.inject({ method: "POST", url: `/api/contents/${contentId}/notes`, headers: auth, payload: { ...payload, comment: "旧评论" } })).json() as { id: string };
    const url = `/api/notes/${note.id}`;
    const patched = await app.inject({ method: "PATCH", url, headers: auth, payload: { mark: "underline", comment: null } });
    expect(patched.statusCode).toBe(200);
    const dto = noteDtoSchema.parse(patched.json());
    expect([dto.mark, dto.comment]).toEqual(["underline", undefined]);
    expect((await app.inject({ method: "PATCH", url, headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, headers: auth, payload: { quote: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, headers: bob, payload: { color: "green" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url, headers: auth })).statusCode).toBe(404);
  });
});

describe("GET /api/notes/groups", () => {
  it("lists the caller's groups with a bounded limit", async () => {
    const { app, contentId, payload } = await setup();
    await app.inject({ method: "POST", url: `/api/contents/${contentId}/notes`, headers: auth, payload });
    const groups = noteGroupsDtoSchema.parse((await app.inject({ method: "GET", url: "/api/notes/groups", headers: auth })).json());
    expect(groups).toMatchObject({ items: [{ contentId, count: 1 }], total: 1 });
    expect(noteGroupsDtoSchema.parse((await app.inject({ method: "GET", url: "/api/notes/groups", headers: bob })).json())).toEqual({ items: [], total: 0 });
    expect((await app.inject({ method: "GET", url: `/api/notes/groups?limit=${API_PAGE_SIZE_MAX + 1}`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/notes/groups?cursor=bogus", headers: auth })).statusCode).toBe(400);
  });

  it("pages by number, never together with a cursor, and only with a safe integer from 1", async () => {
    const { h, app, contentId, payload } = await setup();
    await app.inject({ method: "POST", url: `/api/contents/${contentId}/notes`, headers: auth, payload });
    const later = createLocalContent(h);
    const fixture = lectureTranscripts(later);
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, fixture.asr.revision, fixture.asr.segments));
    const first = fixture.asr.segments[0]?.id as string;
    await app.inject({
      method: "POST", url: `/api/contents/${later}/notes`, headers: auth,
      payload: { ...payload, transcriptRevisionId: fixture.asr.revision.id, startSegmentId: first, endSegmentId: first },
    });
    const everything = noteGroupsDtoSchema.parse((await app.inject({ method: "GET", url: "/api/notes/groups", headers: auth })).json()).items;
    expect(everything).toHaveLength(2);

    const second = await app.inject({ method: "GET", url: "/api/notes/groups?limit=1&page=2", headers: auth });
    expect(second.statusCode).toBe(200);
    expect(noteGroupsDtoSchema.parse(second.json())).toEqual({ items: [everything[1]], total: 2 });
    expect((await app.inject({ method: "GET", url: "/api/notes/groups?limit=1&page=3", headers: auth })).json()).toEqual({ items: [], total: 2 });

    const cursor = (await app.inject({ method: "GET", url: "/api/notes/groups?limit=1", headers: auth })).json().nextCursor as string;
    const both = await app.inject({ method: "GET", url: `/api/notes/groups?limit=1&page=1&cursor=${cursor}`, headers: auth });
    expect([both.statusCode, both.json().error.class, both.json().error.userMessage]).toEqual([400, "invalid_request", expect.stringMatching(/query\.page$/)]);
    for (const url of ["/api/notes/groups?page=0", "/api/notes/groups?page=1.5", "/api/notes/groups?page=9007199254740993", "/api/notes/groups?page=-1", "/api/notes/groups?page="]) {
      expect([url, (await app.inject({ method: "GET", url, headers: auth })).statusCode]).toEqual([url, 400]);
    }
  });
});
