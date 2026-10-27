import { afterEach, describe, expect, it } from "vitest";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL_TOKEN, taskOf, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { insertSummary, seedTranscripts } from "../../../fixtures/pipeline/summary-data.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = seedTranscripts(h, contentId);
  const { app } = await h.app();
  return { h, app, contentId, fixture };
}

describe("/api/contents/:id/summaries and /api/summaries/:aid", () => {
  it("lists summaries per template with derived staleness", async () => {
    const { h, app, contentId, fixture } = await setup();
    const { artifactId, revisionId } = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    const listed = await app.inject({ method: "GET", url: `/api/contents/${contentId}/summaries`, headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().templates[0]).toMatchObject({ template: { id: "summary.core" }, artifactId, current: { id: revisionId }, stale: false });

    await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: fixture.corrected.revision.id } });
    const edited = await app.inject({ method: "GET", url: `/api/contents/${contentId}/summaries`, headers: auth });
    expect(edited.json().templates[0]).toMatchObject({ current: { id: revisionId }, stale: false });

    await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: fixture.platform.revision.id } });
    const after = await app.inject({ method: "GET", url: `/api/contents/${contentId}/summaries`, headers: auth });
    expect(after.json().templates[0]).toMatchObject({ stale: true, staleReason: "transcript_changed" });
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/summaries`, headers: bob })).statusCode).toBe(404);
  });

  it("accepts a generation with 202, replays it by Idempotency-Key and validates the body", async () => {
    const { h, app, contentId } = await setup();
    const url = `/api/contents/${contentId}/summaries`;
    const headers = { ...auth, "idempotency-key": "k1" };
    const first = await app.inject({ method: "POST", url, headers, payload: { templateId: "summary.detailed", outputLanguage: "en" } });
    expect(first.statusCode).toBe(202);
    const { taskId } = first.json();
    expect(JSON.parse(taskOf(h, taskId).requestJson)).toMatchObject({ templateRef: { id: "summary.detailed", version: 1 }, outputLanguage: "en" });
    const replay = await app.inject({ method: "POST", url, headers, payload: { templateId: "summary.detailed", outputLanguage: "en" } });
    expect(replay.json()).toEqual({ taskId });
    const conflict = await app.inject({ method: "POST", url, headers: auth, payload: { templateId: "summary.detailed" } });
    expect(conflict.statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { templateId: "summary.core", outputLanguage: "not a tag" } })).statusCode).toBe(400);
  });

  it("lists revisions and switches current", async () => {
    const { h, app, contentId, fixture } = await setup();
    const older = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 10 });
    const newer = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 11 });
    const revisions = await app.inject({ method: "GET", url: `/api/summaries/${older.artifactId}/revisions`, headers: auth });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json()).toMatchObject({ currentRevisionId: newer.revisionId, items: [{ id: older.revisionId }, { id: newer.revisionId }] });
    const switched = await app.inject({ method: "PUT", url: `/api/summaries/${older.artifactId}/current`, headers: auth, payload: { revisionId: older.revisionId } });
    expect(switched.json().currentRevisionId).toBe(older.revisionId);
    expect((await app.inject({ method: "PUT", url: `/api/summaries/${older.artifactId}/current`, headers: auth, payload: { revisionId: "nope" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/summaries/${older.artifactId}/revisions`, headers: bob })).statusCode).toBe(404);
  });

  it("deletes an earlier revision, refuses the current one with 409 and another user with 404", async () => {
    const { h, app, contentId, fixture } = await setup();
    const older = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 10 });
    const current = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 20 });
    const url = (rid: string) => `/api/summaries/${older.artifactId}/revisions/${rid}`;
    expect((await app.inject({ method: "DELETE", url: url(older.revisionId), headers: bob })).statusCode).toBe(404);
    const refused = await app.inject({ method: "DELETE", url: url(current.revisionId), headers: auth });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "conflict.summary_revision_in_use", details: { reason: "current" } });
    const deleted = await app.inject({ method: "DELETE", url: url(older.revisionId), headers: auth });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ currentRevisionId: current.revisionId, frozenRevisionIds: [] });
    expect(deleted.json().items.map((item: { id: string }) => item.id)).toEqual([current.revisionId]);
    expect((await app.inject({ method: "DELETE", url: url(older.revisionId), headers: auth })).statusCode).toBe(404);
  });
});
