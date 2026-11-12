import { afterEach, describe, expect, it } from "vitest";
import { registerContentRoutes } from "../../../src/server/api/routes/contents.ts";
import type { AsrModelRef } from "../../../src/server/domain/model-ref.ts";
import { RetranscribeService } from "../../../src/server/application/retranscribe.ts";
import { SPEAKERS_PER_CONTENT_MAX } from "../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { mediaFixtures } from "../../fixtures/media/index.ts";
import { BOB_TOKEN, LOCAL, LOCAL_TOKEN, taskOf } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

async function setup() {
  const stack = createMediaStack();
  open.push(stack);
  const { h } = stack;
  const retranscribe = new RetranscribeService({ repository: h.repository, bus: h.bus, control: h.scheduler, disk: h.disk, settings: h.settings, newId: h.newId });
  const { app } = await h.app({ extraRoutes: (instance) => registerContentRoutes(instance, { retranscribe }) });
  const { withAudio } = mediaFixtures();
  const created = await stack.localImport.importLocalFile(LOCAL, {
    path: withAudio.path,
    grant: stack.grant(withAudio.path),
    settings: { autoProofread: false },
    allowDuplicate: true,
  });
  const contentId = created.body.contentIds[0] as string;
  // The import's own Task would hold the asr lane; this test is about the new one.
  h.tasks.cancel(LOCAL, created.body.taskIds[0] as string);
  return { stack, app, contentId, url: `/api/contents/${contentId}/transcript/retranscribe` };
}

describe("POST /api/contents/:id/transcript/retranscribe", () => {
  it("creates a single-stage retranscribe Task, replays by Idempotency-Key and refuses a second one while it is unfinished", async () => {
    const { stack, app, url } = await setup();
    const first = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "k-1" }, payload: {} });
    expect(first.statusCode).toBe(202);
    const { taskId } = first.json() as { taskId: string };
    const task = taskOf(stack.h, taskId);
    expect(task).toMatchObject({ kind: "retranscribe", requestJson: '{"diarization":{"mode":"preferred"},"kind":"retranscribe","requestSchemaVersion":1}' });
    const runs = stack.h.repository.withTransaction((scope) => scope.stageRuns.listByTask(LOCAL.userId, taskId));
    expect(runs.map((run) => run.stage)).toEqual(["asr"]);

    const replay = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "k-1" } });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ taskId });

    const second = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict.mutation_lane");
  });

  it("freezes only the requested ASR model, never the user's default, and refuses another user's or an unlisted one", async () => {
    const { stack, app, url } = await setup();
    const { h } = stack;
    const asrProfile = (userId: string, id: string) =>
      h.repository.withTransaction((scope) => scope.asrProfiles.insert({ id, userId, name: id, provider: "dashscope", models: [{ modelId: "fun-asr" }], createdAt: 1 }));
    asrProfile(LOCAL.userId, "mine");
    asrProfile(LOCAL.userId, "default");
    asrProfile("bob", "bobs");
    const foreign = await app.inject({ method: "POST", url, headers: auth, payload: { asrModelRef: { asrProfileId: "bobs", modelId: "fun-asr" } } });
    expect(foreign.statusCode).toBe(400);
    const unlisted = await app.inject({ method: "POST", url, headers: auth, payload: { asrModelRef: { asrProfileId: "mine", modelId: "scribe_v2" } } });
    expect(unlisted.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { asrProfileId: "mine" } })).statusCode).toBe(400);

    const chosen = await app.inject({ method: "POST", url, headers: auth, payload: { asrModelRef: { asrProfileId: "mine", modelId: "fun-asr" } } });
    expect(chosen.statusCode).toBe(202);
    const chosenId = (chosen.json() as { taskId: string }).taskId;
    expect(JSON.parse(taskOf(h, chosenId).requestJson)).toEqual({
      kind: "retranscribe",
      requestSchemaVersion: 1,
      asrModelRef: { asrProfileId: "mine", modelId: "fun-asr" },
      diarization: { mode: "preferred" },
    });
    h.tasks.cancel(LOCAL, chosenId);

    // The default only preselects the picker; a request without a model waits for one.
    h.userSettings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: "default", modelId: "fun-asr" } });
    const unchosen = await app.inject({ method: "POST", url, headers: auth });
    expect(JSON.parse(taskOf(h, (unchosen.json() as { taskId: string }).taskId).requestJson)).toEqual({ kind: "retranscribe", requestSchemaVersion: 1, diarization: { mode: "preferred" } });
  });

  describe("speaker identification", () => {
    const post = (app: Awaited<ReturnType<typeof setup>>["app"], url: string, payload: object) => app.inject({ method: "POST", url, headers: auth, payload });
    const requestOf = (stack: MediaStack, response: { json(): unknown }) => JSON.parse(taskOf(stack.h, (response.json() as { taskId: string }).taskId).requestJson) as Record<string, unknown>;

    function profile(stack: MediaStack, id: string, provider: "dashscope" | "elevenlabs", modelId: string): AsrModelRef {
      stack.h.repository.withTransaction((scope) =>
        scope.asrProfiles.insert({ id, userId: LOCAL.userId, name: id, provider, models: [{ modelId }], createdAt: 1 }),
      );
      return { asrProfileId: id, modelId };
    }

    const tasksOf = (stack: MediaStack, contentId: string) => stack.h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId));

    function cancelAll(stack: MediaStack, contentId: string): void {
      for (const task of tasksOf(stack, contentId)) {
        if (task.statusProjection !== "succeeded" && task.statusProjection !== "cancelled") stack.h.tasks.cancel(LOCAL, task.id);
      }
    }

    it("freezes the user's setting when the body gives none, and the body's own request as given", async () => {
      const { stack, app, contentId, url } = await setup();
      const defaulted = await post(app, url, {});
      expect(requestOf(stack, defaulted)["diarization"]).toEqual({ mode: "preferred" });
      cancelAll(stack, contentId);
      stack.h.userSettings.patch(LOCAL, { asrDiarization: false });
      const off = await post(app, url, {});
      expect(requestOf(stack, off)["diarization"]).toEqual({ mode: "off" });
      cancelAll(stack, contentId);
      const given = await post(app, url, { diarization: { mode: "required", speakerCount: 4 } });
      expect(given.statusCode).toBe(202);
      // The body wins over the setting, count included, with no model chosen yet to check against.
      expect(requestOf(stack, given)["diarization"]).toEqual({ mode: "required", speakerCount: 4 });
    });

    it("includes the request in what an Idempotency-Key replay is compared with", async () => {
      const { stack, app, contentId, url } = await setup();
      const headers = { ...auth, "idempotency-key": "k-d" };
      const first = await app.inject({ method: "POST", url, headers, payload: { diarization: { mode: "off" } } });
      expect(first.statusCode).toBe(202);
      expect((await app.inject({ method: "POST", url, headers, payload: { diarization: { mode: "off" } } })).json()).toEqual(first.json());
      const changed = await app.inject({ method: "POST", url, headers, payload: { diarization: { mode: "required" } } });
      expect(changed.statusCode).toBeGreaterThanOrEqual(400);
      expect(tasksOf(stack, contentId).filter((task) => task.kind === "retranscribe")).toHaveLength(1);
    });

    it("refuses a required request on a model Amber does not know to identify speakers, before queueing anything", async () => {
      const { stack, app, contentId, url } = await setup();
      const typed = profile(stack, "typed", "dashscope", "fun-asr-2026");
      const refused = await post(app, url, { asrModelRef: typed, diarization: { mode: "required" } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatchObject({ code: "invalid_request.diarization_unavailable", details: { reason: "unsupported" } });
      expect(tasksOf(stack, contentId).filter((task) => task.kind === "retranscribe")).toEqual([]);
    });

    it("lets a preferred request on an unsupported model through, to go without identification", async () => {
      const { stack, app, url } = await setup();
      const typed = profile(stack, "typed", "dashscope", "fun-asr-2026");
      const accepted = await post(app, url, { asrModelRef: typed, diarization: { mode: "preferred" } });
      expect(accepted.statusCode).toBe(202);
      expect(requestOf(stack, accepted)["diarization"]).toEqual({ mode: "preferred" });
    });

    it("refuses a required request when the Content's known duration is past what the model recommends", async () => {
      const { stack, app, contentId, url } = await setup();
      const fun = profile(stack, "fun", "dashscope", "fun-asr");
      stack.h.repository.withTransaction((scope) => scope.contents.setMetadata(LOCAL.userId, contentId, { durationMs: 7_200_001 }, 2));
      const refused = await post(app, url, { asrModelRef: fun, diarization: { mode: "required" } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatchObject({ code: "invalid_request.diarization_unavailable", details: { reason: "over_recommended" } });
      // Preferred goes on; so does a duration exactly at the limit.
      expect((await post(app, url, { asrModelRef: fun, diarization: { mode: "preferred" } })).statusCode).toBe(202);
      cancelAll(stack, contentId);
      stack.h.repository.withTransaction((scope) => scope.contents.setMetadata(LOCAL.userId, contentId, { durationMs: 7_200_000 }, 3));
      expect((await post(app, url, { asrModelRef: fun, diarization: { mode: "required" } })).statusCode).toBe(202);
    });

    it("never clamps a speaker count outside the chosen model's range, in any mode", async () => {
      const { stack, app, contentId, url } = await setup();
      const fun = profile(stack, "fun", "dashscope", "fun-asr");
      const scribe = profile(stack, "scribe", "elevenlabs", "scribe_v2");
      for (const [asrModelRef, speakerCount] of [[fun, 1], [fun, 101], [scribe, 33]] as const) {
        for (const mode of ["preferred", "required"] as const) {
          const refused = await post(app, url, { asrModelRef, diarization: { mode, speakerCount } });
          expect(refused.statusCode, `${asrModelRef.modelId} ${speakerCount} ${mode}`).toBe(400);
          expect(refused.json().error).toMatchObject({ code: "invalid_request.diarization_unavailable", details: { reason: "speaker_count" } });
        }
      }
      for (const [asrModelRef, speakerCount] of [[fun, 2], [fun, 100], [scribe, 1], [scribe, 32]] as const) {
        const accepted = await post(app, url, { asrModelRef, diarization: { mode: "required", speakerCount } });
        expect(accepted.statusCode).toBe(202);
        expect(requestOf(stack, accepted)["diarization"]).toEqual({ mode: "required", speakerCount });
        cancelAll(stack, contentId);
      }
    });

    it("does not check a request against a count when the mode is off", async () => {
      const { stack, app, url } = await setup();
      const fun = profile(stack, "fun", "dashscope", "fun-asr");
      const accepted = await post(app, url, { asrModelRef: fun, diarization: { mode: "off", speakerCount: 500 } });
      expect(accepted.statusCode).toBe(202);
    });

    it("refuses a malformed request in the body", async () => {
      const { app, url } = await setup();
      for (const diarization of [{ mode: "always" }, { mode: "required", speakerCount: 0 }, { mode: "required", speakerCount: 2.5 }, { mode: "required", extra: 1 }, {}]) {
        expect((await post(app, url, { diarization })).statusCode).toBe(400);
      }
    });
  });

  describe("comparison", () => {
    const post = (app: Awaited<ReturnType<typeof setup>>["app"], url: string, payload: object, headers: Record<string, string> = auth) => app.inject({ method: "POST", url, headers, payload });
    const requestOf = (stack: MediaStack, response: { json(): unknown }) => JSON.parse(taskOf(stack.h, (response.json() as { taskId: string }).taskId).requestJson) as Record<string, unknown>;
    const retranscribes = (stack: MediaStack, contentId: string) =>
      stack.h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId)).filter((task) => task.kind === "retranscribe");

    function profile(stack: MediaStack, id: string, modelId: string): AsrModelRef {
      stack.h.repository.withTransaction((scope) => scope.asrProfiles.insert({ id, userId: LOCAL.userId, name: id, provider: "dashscope", models: [{ modelId }], createdAt: 1 }));
      return { asrProfileId: id, modelId };
    }

    /** Gives the Content a primary naming `named` speakers, out of `registered` speakers in all. */
    function primaryWithSpeakers(stack: MediaStack, contentId: string, named: number, registered: number): void {
      const { h } = stack;
      h.repository.withTransaction((scope) => {
        const ids = Array.from({ length: registered }, () => h.newId());
        scope.speakers.insert(LOCAL.userId, contentId, ids.map((id) => ({ id })), 2);
        const revisionId = h.newId();
        const segments = Array.from({ length: Math.max(named, 1) }, (_, ordinal) => ({
          id: h.newId() as SegmentId,
          revisionId,
          ordinal,
          startMs: ordinal * 1000,
          endMs: ordinal * 1000 + 900,
          text: `${ordinal}`,
          sourceSegmentIds: [],
          ...(ordinal < named ? { speakerId: ids[ordinal] as string } : {}),
        }));
        scope.transcripts.insertRevision(
          LOCAL.userId,
          { id: revisionId, contentId, kind: "manual", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "manual" }, segmentCount: segments.length, createdAt: 2 },
          segments,
        );
        scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 2);
      });
    }

    it("freezes the comparison mark with identification required, and keeps it apart from an ordinary request under one key", async () => {
      const { stack, app, contentId, url } = await setup();
      const fun = profile(stack, "fun", "fun-asr");
      const headers = { ...auth, "idempotency-key": "k-c" };
      const accepted = await post(app, url, { asrModelRef: fun, diarization: { mode: "off" }, comparison: true }, headers);
      expect(accepted.statusCode).toBe(202);
      expect(requestOf(stack, accepted)).toEqual({ kind: "retranscribe", requestSchemaVersion: 1, asrModelRef: fun, diarization: { mode: "required" }, comparison: true });
      expect((await post(app, url, { asrModelRef: fun, diarization: { mode: "off" }, comparison: true }, headers)).json()).toEqual(accepted.json());
      // The same key with the mark left out is another request.
      expect((await post(app, url, { asrModelRef: fun, diarization: { mode: "off" } }, headers)).statusCode).toBeGreaterThanOrEqual(400);
      expect(retranscribes(stack, contentId)).toHaveLength(1);
    });

    it("keeps the speaker count asked for", async () => {
      const { stack, app, url } = await setup();
      const fun = profile(stack, "fun", "fun-asr");
      const counted = await post(app, url, { asrModelRef: fun, diarization: { mode: "preferred", speakerCount: 3 }, comparison: true });
      expect(requestOf(stack, counted)["diarization"]).toEqual({ mode: "required", speakerCount: 3 });
    });

    it("refuses a model that cannot identify speakers before queueing anything, whatever mode the body asks", async () => {
      const { stack, app, contentId, url } = await setup();
      const typed = profile(stack, "typed", "fun-asr-2026");
      for (const diarization of [undefined, { mode: "off" }, { mode: "preferred" }]) {
        const refused = await post(app, url, { asrModelRef: typed, comparison: true, ...(diarization === undefined ? {} : { diarization }) });
        expect(refused.statusCode).toBe(400);
        expect(refused.json().error).toMatchObject({ code: "invalid_request.diarization_unavailable", details: { reason: "unsupported" } });
      }
      expect(retranscribes(stack, contentId)).toEqual([]);
    });

    it("refuses with the room and the requirement when the Content cannot hold twice the primary's speakers", async () => {
      const { stack, app, contentId, url } = await setup();
      const fun = profile(stack, "fun", "fun-asr");
      primaryWithSpeakers(stack, contentId, 3, SPEAKERS_PER_CONTENT_MAX - 5);
      const refused = await post(app, url, { asrModelRef: fun, comparison: true });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({ code: "conflict.speaker_capacity", details: { room: 5, required: 6 } });
      expect(retranscribes(stack, contentId)).toEqual([]);
      // An ordinary re-transcription is not held to it.
      expect((await post(app, url, { asrModelRef: fun })).statusCode).toBe(202);
    });

    it("lets a comparison through when exactly the required room is left", async () => {
      const { stack, app, url, contentId } = await setup();
      const fun = profile(stack, "fun", "fun-asr");
      primaryWithSpeakers(stack, contentId, 3, SPEAKERS_PER_CONTENT_MAX - 6);
      expect((await post(app, url, { asrModelRef: fun, comparison: true })).statusCode).toBe(202);
    });

    it("refuses a comparison mark other than true", async () => {
      const { app, url } = await setup();
      for (const comparison of [false, "yes", 1]) expect((await post(app, url, { comparison })).statusCode).toBe(400);
    });
  });

  it("answers 404 for an unknown or foreign Content, 400 for options and 422 media_missing without media", async () => {
    const { stack, app, contentId, url } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/contents/nope/transcript/retranscribe", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { language: "en" } })).statusCode).toBe(400);

    stack.h.repository.withTransaction((scope) => {
      for (const asset of scope.mediaAssets.listByContent(LOCAL.userId, contentId)) {
        scope.mediaAssets.update(LOCAL.userId, { ...asset, availability: "missing" });
      }
    });
    const missing = await app.inject({ method: "POST", url, headers: auth });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe("media_missing");
  });

  it("is refused below the disk low-water mark", async () => {
    const { stack, app, url } = await setup();
    stack.h.disk.low();
    const low = await app.inject({ method: "POST", url, headers: auth });
    expect(low.statusCode).toBe(507);
    expect(low.json().error.code).toBe("disk_low");
  });
});
