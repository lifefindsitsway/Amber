import { afterEach, describe, expect, it } from "vitest";
import { UI_LANGUAGE_DEFAULT } from "../../../../src/shared/defaults.ts";
import { highlightsDtoSchema } from "../../../../src/shared/dto/highlight.ts";
import { lectureTranscripts } from "../../../fixtures/transcripts/lecture.ts";
import { builtinPromptRefs, BOB_TOKEN, configureLlm, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, taskOf, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content whose primary is the ASR original; no highlights yet. */
async function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, fixture.asr.revision, fixture.asr.segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.asr.revision.id, 2);
  });
  const { app } = await h.app();
  return { h, app, contentId, fixture };
}

describe("GET /api/contents/:id/highlights", () => {
  it("answers an empty DTO before any highlights and 404 for another user's Content", async () => {
    const { app, contentId } = await setup();
    const url = `/api/contents/${contentId}/highlights`;
    const response = await app.inject({ method: "GET", url, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(highlightsDtoSchema.parse(response.json())).toEqual({});
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });
});

describe("POST /api/contents/:id/highlights/recompute", () => {
  it("creates a recompute_highlights Task frozen on the primary and the language, replayable and shown as the active Task", async () => {
    const { h, app, contentId, fixture } = await setup();
    const url = `/api/contents/${contentId}/highlights/recompute`;
    const created = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "h-1" } });
    expect(created.statusCode).toBe(202);
    const { taskId } = created.json() as { taskId: string };
    expect(JSON.parse(taskOf(h, taskId).requestJson)).toEqual({
      requestSchemaVersion: 1,
      kind: "recompute_highlights",
      baseRevisionId: fixture.asr.revision.id,
      promptRefs: builtinPromptRefs("recompute_highlights"),
      outputLanguage: UI_LANGUAGE_DEFAULT,
    });
    const replay = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "h-1" } });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ taskId });
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/highlights`, headers: auth })).json()).toEqual({ activeTaskId: taskId });

    const again = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("conflict.mutation_lane");
    // Chapters occupy another lane and may run alongside.
    expect((await app.inject({ method: "POST", url: `/api/contents/${contentId}/chapters/regenerate`, headers: auth })).statusCode).toBe(202);

    h.tasks.cancel(LOCAL, taskId);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/highlights`, headers: auth })).json()).not.toHaveProperty("activeTaskId");
  });

  it("freezes the chosen model and the user's output language", async () => {
    const { h, app, contentId } = await setup();
    const modelRef = configureLlm(h);
    await app.inject({ method: "PATCH", url: "/api/settings", headers: auth, payload: { defaultOutputLanguage: "en" } });
    const created = await app.inject({ method: "POST", url: `/api/contents/${contentId}/highlights/recompute`, headers: auth, payload: { modelRef } });
    expect(created.statusCode).toBe(202);
    expect(JSON.parse(taskOf(h, created.json().taskId).requestJson)).toMatchObject({ modelRef, outputLanguage: "en" });
  });

  it("answers 400 without a primary or with an unknown body field, and 404 for another user's Content", async () => {
    const { h, app, contentId } = await setup();
    const bare = createLocalContent(h);
    expect((await app.inject({ method: "POST", url: `/api/contents/${bare}/highlights/recompute`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/contents/${contentId}/highlights/recompute`, headers: auth, payload: { count: 10 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/contents/${contentId}/highlights/recompute`, headers: bob })).statusCode).toBe(404);
  });
});
