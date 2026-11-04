import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import type { LlmProvider } from "../../../../src/server/ports/llm-provider.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { translationsDtoSchema } from "../../../../src/shared/dto/translation.ts";
import { FakeLlmProvider } from "../../../fixtures/llm/fake-llm.ts";
import { lectureTranscripts } from "../../../fixtures/transcripts/lecture.ts";
import { builtinPromptRefs, BOB_TOKEN, configureLlm, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, taskOf, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content whose primary is the ASR original (zh-CN), the corrected revision stored beside it, and one English translation. */
async function setup(options: { llmProviders?: readonly LlmProvider[] } = {}) {
  const h = createHarness(options);
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  const translatedId = h.newId();
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.asr.revision.id, 2);
    const segments: TranscriptSegment[] = fixture.asr.segments.map((source, ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId: translatedId,
      ordinal,
      startMs: source.startMs,
      endMs: source.endMs,
      text: `en: ${source.text}`,
      sourceSegmentIds: [source.id],
    }));
    scope.transcripts.insertRevision(
      LOCAL.userId,
      {
        id: translatedId,
        contentId,
        kind: "translated",
        parentRevisionId: fixture.asr.revision.id,
        language: "en",
        timingFidelity: "segment_only",
        generation: { kind: "llm", modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" }, promptRef: { id: "translate.subtitles", version: 1 }, promptSnapshot: "<prompt>" },
        segmentCount: segments.length,
        createdAt: 5,
      },
      segments,
    );
    scope.translations.setCurrent(LOCAL.userId, contentId, "en", translatedId, h.newId());
  });
  const { app } = await h.app();
  return { h, app, contentId, fixture, translatedId, url: `/api/contents/${contentId}/translations` };
}

describe("GET /api/contents/:id/translations", () => {
  it("returns the per-language translations and 404 for another user", async () => {
    const { app, url, translatedId } = await setup();
    const response = await app.inject({ method: "GET", url, headers: auth });
    expect(response.statusCode).toBe(200);
    const dto = translationsDtoSchema.parse(response.json());
    expect(dto).toMatchObject({ translations: [{ targetLanguage: "en", current: { id: translatedId }, stale: false }], activeTasks: [] });
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });
});

describe("switching the primary makes the translation stale without calling a model", () => {
  it("derives transcript_changed for a translation of the former primary and makes no LLM call", async () => {
    const llm = new FakeLlmProvider();
    const { app, url, contentId, fixture, translatedId } = await setup({ llmProviders: [llm] });
    const switched = await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: fixture.corrected.revision.id } });
    expect(switched.statusCode).toBe(200);
    const dto = translationsDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json());
    expect(dto.translations).toMatchObject([{ targetLanguage: "en", current: { id: translatedId }, stale: true, staleReason: "transcript_changed" }]);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("POST /api/contents/:id/translations", () => {
  it("creates one translate Task frozen on the primary with canonical, de-duplicated languages and replays by Idempotency-Key", async () => {
    const { h, app, url, fixture } = await setup();
    const modelRef = configureLlm(h);
    const headers = { ...auth, "idempotency-key": "t-1" };
    const payload = { targetLanguages: ["JA", "fr-ca", "ja"], modelRef };
    const created = await app.inject({ method: "POST", url, headers, payload });
    expect(created.statusCode).toBe(202);
    const { taskId } = created.json() as { taskId: string };
    expect(taskOf(h, taskId).kind).toBe("translate");
    expect(JSON.parse(taskOf(h, taskId).requestJson)).toEqual({
      requestSchemaVersion: 1,
      kind: "translate",
      targetLanguages: ["ja", "fr-CA"],
      promptRefs: builtinPromptRefs("translate"),
      modelRef,
      baseRevisionId: fixture.asr.revision.id,
    });
    expect((await app.inject({ method: "POST", url, headers, payload })).json()).toEqual({ taskId });
    expect((await app.inject({ method: "GET", url, headers: auth })).json().activeTasks).toEqual([{ taskId, targetLanguages: ["ja", "fr-CA"] }]);
  });

  it("honours an explicit source revision", async () => {
    const { h, app, url, fixture } = await setup();
    const created = await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["en"], sourceRevisionId: fixture.corrected.revision.id } });
    expect(created.statusCode).toBe(202);
    expect(JSON.parse(taskOf(h, created.json().taskId).requestJson)).toMatchObject({ baseRevisionId: fixture.corrected.revision.id, targetLanguages: ["en"] });
  });

  it("refuses the source language, invalid tags, a translated source, foreign or unknown sources and a missing primary", async () => {
    const { h, app, url, contentId, translatedId } = await setup();
    const sameAsSource = await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["en", "zh-TW"] } });
    expect(sameAsSource.statusCode).toBe(400);
    expect(sameAsSource.json().error.class).toBe("invalid_request");
    // Well-formed for the request schema, rejected by BCP-47 canonicalization.
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["en-US-US"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["not a tag"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["ja"], extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["ja"], sourceRevisionId: translatedId } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["ja"], sourceRevisionId: "unknown" } })).statusCode).toBe(404);

    const other = createLocalContent(h);
    const foreign = lectureTranscripts(other).asr;
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, foreign.revision, foreign.segments));
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["ja"], sourceRevisionId: foreign.revision.id } })).statusCode).toBe(404);
    // Without a primary there is nothing to translate by default.
    expect((await app.inject({ method: "POST", url: `/api/contents/${other}/translations`, headers: auth, payload: { targetLanguages: ["ja"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob, payload: { targetLanguages: ["ja"] } })).statusCode).toBe(404);
    expect(h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId))).toEqual([]);
  });

  it("refuses a second unfinished translation into the same language but accepts another language", async () => {
    const { app, url } = await setup();
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["ja", "fr"] } })).statusCode).toBe(202);
    const clash = await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["de", "fr"] } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("conflict.mutation_lane");
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { targetLanguages: ["de"] } })).statusCode).toBe(202);
  });
});

describe("/api/contents/:id/translations/:language/draft", () => {
  it("saves, reads, discards and commits a language's draft, naming the language in any BCP-47 spelling", async () => {
    const { h, app, url, translatedId, contentId } = await setup();
    const draftUrl = `${url}/EN/draft`;
    const base = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, translatedId));
    const segments = base.map((segment) => ({ id: segment.id, text: `${segment.text} (edited)` }));

    expect((await app.inject({ method: "GET", url: draftUrl, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${url}/fr/draft`, headers: auth })).statusCode).toBe(404);
    const saved = await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: translatedId, expectedVersion: null, segments } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ contentId, targetLanguage: "en", baseRevisionId: translatedId, version: 1, segments });
    expect((await app.inject({ method: "GET", url: `${url}/en/draft`, headers: auth })).json()).toMatchObject({ version: 1 });
    expect((await app.inject({ method: "GET", url: draftUrl, headers: bob })).statusCode).toBe(404);
    const listed = translationsDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json());
    expect(listed.translations[0]?.draft).toMatchObject({ baseRevisionId: translatedId, version: 1 });

    const stale = await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: translatedId, expectedVersion: null, segments } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "conflict.draft_changed", details: { currentVersion: 1 } });
    const extra = await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: translatedId, expectedVersion: 1, segments, startMs: 0 } });
    expect(extra.statusCode).toBe(400);
    const timed = segments.map((segment) => ({ ...segment, startMs: 0 }));
    expect((await app.inject({ method: "PUT", url: draftUrl, headers: auth, payload: { baseRevisionId: translatedId, expectedVersion: 1, segments: timed } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `${draftUrl}?version=2`, headers: auth })).statusCode).toBe(409);

    const commitUrl = `${draftUrl}/commit`;
    expect((await app.inject({ method: "POST", url: commitUrl, headers: auth, payload: { expectedRevisionId: translatedId, draftVersion: 1, allowOutdatedBase: false } })).statusCode).toBe(400);
    const committed = await app.inject({ method: "POST", url: commitUrl, headers: auth, payload: { expectedRevisionId: translatedId, draftVersion: 1 } });
    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toMatchObject({ kind: "translated", language: "en", generation: { kind: "manual", origin: { revisionId: translatedId } } });
    const after = translationsDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json());
    expect(after.translations[0]).toMatchObject({ current: { id: committed.json().id } });
    expect(after.translations[0]?.draft).toBeUndefined();
    expect((await app.inject({ method: "POST", url: commitUrl, headers: auth, payload: { expectedRevisionId: committed.json().id, draftVersion: 1 } })).statusCode).toBe(409);

    const editedId = (committed.json() as { id: string }).id;
    const reopened = await app.inject({
      method: "PUT",
      url: draftUrl,
      headers: auth,
      payload: { baseRevisionId: editedId, expectedVersion: null, segments: segmentIdsOf(h, editedId).map((id) => ({ id, text: "again" })) },
    });
    expect(reopened.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: draftUrl, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${draftUrl}?version=1`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: draftUrl, headers: auth })).statusCode).toBe(404);
  });
});

function segmentIdsOf(h: Harness, revisionId: string): string[] {
  return h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revisionId)).map((segment) => segment.id);
}
