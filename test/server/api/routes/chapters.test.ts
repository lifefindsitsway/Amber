import { afterEach, describe, expect, it } from "vitest";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { UI_LANGUAGE_DEFAULT } from "../../../../src/shared/defaults.ts";
import { FakeLlmProvider } from "../../../fixtures/llm/fake-llm.ts";
import { lectureTranscripts } from "../../../fixtures/transcripts/lecture.ts";
import { builtinPromptRefs, BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, taskOf, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/**
 * A Content whose primary is the ASR original, with platform chapters and AI chapters
 * built from that ASR original; the AI revision is current.
 */
async function setup() {
  const llm = new FakeLlmProvider();
  const h = createHarness({ llmProviders: [llm] });
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  const artifactId = h.newId();
  const platformRevisionId = h.newId();
  const aiRevisionId = h.newId();
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.asr.revision.id, 2);
    scope.chapters.insertPlatformRevision(LOCAL.userId, contentId, {
      id: platformRevisionId,
      artifactId,
      chapters: [
        { startMs: 0, endMs: 9800, title: "开场" },
        { startMs: 9800, endMs: 21000, title: "Embedding" },
      ],
      createdAt: 3,
    });
    const [first, third] = [fixture.asr.segments[0], fixture.asr.segments[2]] as const;
    scope.chapters.insertAiRevision(LOCAL.userId, contentId, {
      id: aiRevisionId,
      artifactId,
      transcriptRevisionId: fixture.asr.revision.id,
      chapters: [
        { startMs: first?.startMs as number, endMs: third?.startMs as number, title: "RAG 是什么", summary: "检索与生成结合", startSegmentId: first?.id as SegmentId },
        { startMs: third?.startMs as number, endMs: 20900, title: "Embedding 模型", startSegmentId: third?.id as SegmentId },
      ],
      modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
      promptRef: { id: "chapter.ai", version: 1 },
      promptSnapshot: "<chapter prompt>",
      quality: "normal",
      createdAt: 4,
    });
    scope.chapters.setCurrent(LOCAL.userId, contentId, aiRevisionId);
  });
  const { app } = await h.app();
  return { h, llm, app, contentId, fixture, artifactId, platformRevisionId, aiRevisionId };
}

describe("switching the primary to another lineage makes dependent chapters stale without calling a model", () => {
  it("keeps AI chapters fresh on an edited primary, derives transcript_changed on another lineage, keeps platform chapters fresh and makes no LLM call", async () => {
    const { llm, app, contentId, fixture, artifactId, platformRevisionId, aiRevisionId } = await setup();
    const url = `/api/contents/${contentId}/chapters`;
    const before = await app.inject({ method: "GET", url, headers: auth });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      artifactId,
      current: { id: aiRevisionId, origin: { kind: "ai", transcriptRevisionId: fixture.asr.revision.id }, stale: false, quality: "normal", qualityReasons: [] },
    });
    expect(before.json().current.chapters[0]).toMatchObject({ title: "RAG 是什么", summary: "检索与生成结合", startSegmentId: fixture.asr.segments[0]?.id });
    expect(before.json().current).toMatchObject({ modelRef: { providerNameSnapshot: "relay" }, promptRef: { id: "chapter.ai", version: 1 } });
    expect(before.json().current).not.toHaveProperty("staleReason");

    const setPrimary = (revisionId: string) => app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId } });
    // Proofread from the chapters' transcript: same sentences and timing, so they stand.
    expect((await setPrimary(fixture.corrected.revision.id)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url, headers: auth })).json().current).toMatchObject({ id: aiRevisionId, stale: false });

    expect((await setPrimary(fixture.platform.revision.id)).statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url, headers: auth })).json();
    expect(after.current).toMatchObject({ id: aiRevisionId, stale: true, staleReason: "transcript_changed" });
    const byId = Object.fromEntries((after.revisions as Array<{ id: string; stale: boolean }>).map((revision) => [revision.id, revision]));
    expect(byId[platformRevisionId]).toMatchObject({ origin: { kind: "platform" }, stale: false });
    expect(byId[platformRevisionId]).not.toHaveProperty("staleReason");
    expect(byId[aiRevisionId]).toMatchObject({ stale: true, staleReason: "transcript_changed" });
    expect(llm.calls).toHaveLength(0);
  });
});

describe("GET / PUT /api/contents/:id/chapters", () => {
  it("lists every revision oldest first and switches back to platform chapters", async () => {
    const { app, contentId, platformRevisionId, aiRevisionId } = await setup();
    const url = `/api/contents/${contentId}/chapters`;
    expect((await app.inject({ method: "GET", url, headers: auth })).json().revisions.map((revision: { id: string }) => revision.id)).toEqual([platformRevisionId, aiRevisionId]);
    const switched = await app.inject({ method: "PUT", url: `${url}/current`, headers: auth, payload: { revisionId: platformRevisionId } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().current).toMatchObject({ id: platformRevisionId, origin: { kind: "platform" }, stale: false });
    expect(switched.json().current.chapters[0]).toEqual({ startMs: 0, endMs: 9800, title: "开场" });
    expect((await app.inject({ method: "GET", url, headers: auth })).json().current.id).toBe(platformRevisionId);
  });

  it("answers an empty listing without chapters and 404 for foreign or unknown ids", async () => {
    const { h, app, contentId, aiRevisionId } = await setup();
    const bare = createLocalContent(h);
    expect((await app.inject({ method: "GET", url: `/api/contents/${bare}/chapters`, headers: auth })).json()).toEqual({ revisions: [] });
    expect((await app.inject({ method: "PUT", url: `/api/contents/${bare}/chapters/current`, headers: auth, payload: { revisionId: aiRevisionId } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/contents/${contentId}/chapters/current`, headers: auth, payload: { revisionId: "unknown" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chapters`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/contents/${contentId}/chapters/current`, headers: bob, payload: { revisionId: aiRevisionId } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/contents/${contentId}/chapters/current`, headers: auth, payload: {} })).statusCode).toBe(400);
  });
});

describe("POST /api/contents/:id/chapters/regenerate", () => {
  it("creates a regenerate_chapters Task frozen on the primary and its language, shown as the active Task", async () => {
    const { h, app, contentId, fixture } = await setup();
    const url = `/api/contents/${contentId}/chapters/regenerate`;
    const created = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "c-1" } });
    expect(created.statusCode).toBe(202);
    const { taskId } = created.json() as { taskId: string };
    expect(JSON.parse(taskOf(h, taskId).requestJson)).toEqual({
      requestSchemaVersion: 1,
      kind: "regenerate_chapters",
      baseRevisionId: fixture.asr.revision.id,
      promptRefs: builtinPromptRefs("regenerate_chapters"),
      outputLanguage: UI_LANGUAGE_DEFAULT,
    });
    expect((await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "c-1" } })).json()).toEqual({ taskId });
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chapters`, headers: auth })).json().activeTaskId).toBe(taskId);

    const again = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("conflict.mutation_lane");
    // Proofreading occupies another lane and may run alongside.
    expect((await app.inject({ method: "POST", url: `/api/contents/${contentId}/transcript/proofread`, headers: auth })).statusCode).toBe(202);

    h.tasks.cancel(LOCAL, taskId);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chapters`, headers: auth })).json()).not.toHaveProperty("activeTaskId");
  });

  it("answers 400 without a primary and 404 for another user's Content", async () => {
    const { h, app, contentId } = await setup();
    const bare = createLocalContent(h);
    expect((await app.inject({ method: "POST", url: `/api/contents/${bare}/chapters/regenerate`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/contents/${contentId}/chapters/regenerate`, headers: bob })).statusCode).toBe(404);
  });
});
