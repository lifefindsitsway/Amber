import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_SUMMARY_TEMPLATES } from "../../../../src/server/domain/prompts.ts";
import { attributionDigest, speakerLabels } from "../../../../src/server/domain/speaker-context.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { BOB, BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { insertCollectionSummary, insertSummary, seedTranscripts } from "../../../fixtures/pipeline/summary-data.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const { app } = await h.app();
  return { h, app };
}

describe("/api/collections", () => {
  it("creates, reads, patches, reorders, removes items and deletes", async () => {
    const { h, app } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/collections", headers: auth, payload: { name: "Course", description: "d" } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    const contents = [createLocalContent(h), createLocalContent(h)];
    for (const contentId of contents) {
      const added = await app.inject({ method: "POST", url: `/api/collections/${id}/items`, headers: auth, payload: { contentId } });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toMatchObject({ contentId });
    }
    const imported = await app.inject({ method: "POST", url: `/api/collections/${id}/items`, headers: auth, payload: { url: WATCH } });
    expect(imported.statusCode).toBe(202);
    expect(imported.json()).toMatchObject({ contentIds: [expect.any(String)], taskIds: [expect.any(String)] });

    const detail = (await app.inject({ method: "GET", url: `/api/collections/${id}`, headers: auth })).json();
    expect(detail).toMatchObject({ name: "Course", description: "d", itemCount: 3 });
    const ids: string[] = detail.items.map((item: { id: string }) => item.id);
    const reordered = await app.inject({ method: "PUT", url: `/api/collections/${id}/items/order`, headers: auth, payload: { itemIds: [...ids].reverse() } });
    expect(reordered.json().items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
    expect((await app.inject({ method: "PUT", url: `/api/collections/${id}/items/order`, headers: auth, payload: { itemIds: ids.slice(1) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/api/collections/${id}/items/${ids[0]}`, headers: auth })).statusCode).toBe(204);

    const patched = await app.inject({ method: "PATCH", url: `/api/collections/${id}`, headers: auth, payload: { description: null } });
    expect(patched.json()).not.toHaveProperty("description");
    expect((await app.inject({ method: "GET", url: "/api/collections", headers: auth })).json().items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/collections/${id}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/collections/${id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/collections/${id}`, headers: auth })).statusCode).toBe(404);
  });

  it("validates item bodies: exactly one of url and contentId", async () => {
    const { app } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/collections", headers: auth, payload: { name: "C" } })).json();
    for (const payload of [{}, { url: WATCH, contentId: "x" }]) {
      expect((await app.inject({ method: "POST", url: `/api/collections/${id}/items`, headers: auth, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/api/collections", headers: auth, payload: { name: " " } })).statusCode).toBe(400);
  });

  it("accepts a collection summary with 202, lists missing members with 400 and reads the summary", async () => {
    const { h, app } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/collections", headers: auth, payload: { name: "C" } })).json();
    const contentId = createLocalContent(h);
    const fixture = seedTranscripts(h, contentId);
    await app.inject({ method: "POST", url: `/api/collections/${id}/items`, headers: auth, payload: { contentId } });

    const missing = await app.inject({ method: "POST", url: `/api/collections/${id}/summary`, headers: auth, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: "invalid_request.collection_summary_missing", details: { missingContentIds: [contentId] } });

    insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    const accepted = await app.inject({ method: "POST", url: `/api/collections/${id}/summary`, headers: auth });
    expect(accepted.statusCode).toBe(202);
    const summary = await app.inject({ method: "GET", url: `/api/collections/${id}/summary`, headers: auth });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toEqual({ stale: false, activeTaskId: accepted.json().taskId });
  });

  it("returns each partial's member range in the summary response", async () => {
    const { h, app } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/collections", headers: auth, payload: { name: "C" } })).json();
    const contentId = createLocalContent(h);
    const fixture = seedTranscripts(h, contentId);
    const added = (await app.inject({ method: "POST", url: `/api/collections/${id}/items`, headers: auth, payload: { contentId } })).json();
    const core = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    const item = { collectionItemId: added.id, contentId, summaryRevisionId: core.revisionId, transcriptRevisionId: fixture.asr.revision.id, position: 0 };
    insertCollectionSummary(h, id, [item], LOCAL.userId, { partialInputs: [{ kind: "collectionItemSnapshot", ...item }] });

    const summary = await app.inject({ method: "GET", url: `/api/collections/${id}/summary`, headers: auth });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().current.partials[0].itemRange).toEqual({ first: 1, last: 1 });
  });

  it("deletes the collection summary with 204, 404 for another owner or once gone, 409 while summarising", async () => {
    const { h, app } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/collections", headers: auth, payload: { name: "C" } })).json();
    const contentId = createLocalContent(h);
    const fixture = seedTranscripts(h, contentId);
    const added = (await app.inject({ method: "POST", url: `/api/collections/${id}/items`, headers: auth, payload: { contentId } })).json();
    const core = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    const { revisionId } = insertCollectionSummary(h, id, [
      { collectionItemId: added.id, contentId, summaryRevisionId: core.revisionId, transcriptRevisionId: fixture.asr.revision.id, position: 0 },
    ]);
    const remove = (headers: typeof auth) => app.inject({ method: "DELETE", url: `/api/collections/${id}/summary`, headers });

    expect((await remove(bob)).statusCode).toBe(404);
    const accepted = await app.inject({ method: "POST", url: `/api/collections/${id}/summary`, headers: auth });
    const busy = await remove(auth);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatchObject({ code: "conflict.tasks_unfinished" });
    expect((await app.inject({ method: "GET", url: `/api/collections/${id}/summary`, headers: auth })).json()).toMatchObject({ current: { id: revisionId } });
    h.tasks.cancel(LOCAL, accepted.json().taskId);

    const removed = await remove(auth);
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe("");
    expect((await app.inject({ method: "GET", url: `/api/collections/${id}/summary`, headers: auth })).json()).toEqual({ stale: false });
    expect((await remove(auth)).statusCode).toBe(404);
  });
});

describe("GET /api/collections/:id/summary: members whose speakers changed", () => {
  const CORE = BUILTIN_SUMMARY_TEMPLATES[0] as (typeof BUILTIN_SUMMARY_TEMPLATES)[number];

  /**
   * A member's current core summary: `none` generated without speakers; `held` with speakers
   * whose review was given; `changed` with speakers whose review never was, so its speaker
   * state is not `consistent`.
   */
  type Member = "none" | "held" | "changed";

  interface Seeded {
    contentId: string;
    revisionId: string;
  }

  /** One member owned by `userId`: a 3-sentence primary transcript and its current core summary. */
  function seedMember(h: Harness, userId: string, member: Member): Seeded {
    const contentId = h.newId();
    const revisionId = h.newId();
    const speakerIds = member === "none" ? [] : [h.newId(), h.newId()];
    const segments: TranscriptSegment[] = [0, 1, 2].map((ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text: `第 ${ordinal + 1} 句`,
      ...(speakerIds.length === 0 ? {} : { speakerId: speakerIds[ordinal % 2] as string }),
      sourceSegmentIds: [],
    }));
    const revision: TranscriptRevision = {
      id: revisionId,
      contentId,
      kind: "imported",
      language: "zh-CN",
      timingFidelity: "segment_only",
      generation: { kind: "imported", format: "srt" },
      segmentCount: 3,
      createdAt: 1,
    };
    h.repository.withTransaction((scope) => {
      scope.contents.insert({ id: contentId, userId, source: { kind: "local" }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 });
      if (speakerIds.length > 0) {
        scope.speakers.insert(userId, contentId, [{ id: speakerIds[0] as string, name: "蒋炎岩", nameConfirmedAt: 3 }, { id: speakerIds[1] as string }], 1);
      }
      scope.transcripts.insertRevision(userId, revision, segments);
      scope.contents.setPrimaryTranscript(userId, contentId, revisionId, 2);
      if (member === "held") scope.speakerConfirmations.set(userId, contentId, revisionId, 4);
      const summaryRevisionId = h.newId();
      const { artifactId } = scope.summaries.insertRevision(userId, {
        contentId,
        templateId: CORE.id,
        artifactId: h.newId(),
        revision: {
          id: summaryRevisionId,
          provenance: {
            inputs: [{ kind: "transcriptRevision", id: revisionId }],
            promptRef: { id: CORE.id, version: CORE.version },
            ...(speakerIds.length === 0
              ? {}
              : {
                  speakerContext: {
                    version: 1,
                    rules: { id: "speaker.rules", version: 1 },
                    attributionDigest: attributionDigest(segments),
                    speakers: speakerLabels(scope.speakers.list(userId, contentId)),
                  },
                }),
            createdAt: 1,
          },
          quality: "normal",
          body: `## 摘要\n要点 [[seg:${segments[0]?.id}]]`,
          citations: [{ transcriptRevisionId: revisionId, segmentId: segments[0]?.id as SegmentId }],
        },
      });
      scope.summaries.setCurrent(userId, artifactId, summaryRevisionId);
    });
    return { contentId, revisionId };
  }

  function syncTemplates(h: Harness): void {
    h.repository.withTransaction((scope) =>
      scope.summaryTemplates.syncBuiltin(
        BUILTIN_SUMMARY_TEMPLATES.map((template) => ({ id: template.id, name: template.nameKey, versions: [{ version: template.version, prompt: template.prompt }] })),
        1,
      ),
    );
  }

  /** A collection created through the API by the holder of `headers`, its members added through the API too. */
  async function seedCollection(
    h: Harness,
    app: Awaited<ReturnType<Harness["app"]>>["app"],
    headers: typeof auth,
    userId: string,
    members: readonly Member[],
  ): Promise<{ id: string; members: Seeded[] }> {
    const { id } = (await app.inject({ method: "POST", url: "/api/collections", headers, payload: { name: "生成式软件工程" } })).json();
    const seeded: Seeded[] = [];
    for (const member of members) {
      const one = seedMember(h, userId, member);
      const added = await app.inject({ method: "POST", url: `/api/collections/${id}/items`, headers, payload: { contentId: one.contentId } });
      expect(added.statusCode).toBe(200);
      seeded.push(one);
    }
    return { id, members: seeded };
  }

  const read = async (app: Awaited<ReturnType<Harness["app"]>>["app"], id: string, headers: typeof auth) =>
    app.inject({ method: "GET", url: `/api/collections/${id}/summary`, headers });

  it("counts only the caller's own members, live, and another owner's collection is not found", async () => {
    const { h, app } = await setup();
    syncTemplates(h);
    // The same shape for both owners: two members whose speakers changed, one held, one without speakers.
    const shape: Member[] = ["changed", "held", "changed", "none"];
    const mine = await seedCollection(h, app, auth, LOCAL.userId, shape);
    const theirs = await seedCollection(h, app, bob, BOB.userId, shape);

    const own = await read(app, mine.id, auth);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ stale: false, speakerContextChangedMembers: 2 });
    expect((await read(app, theirs.id, bob)).json()).toEqual({ stale: false, speakerContextChangedMembers: 2 });

    // Each owner's count moves with their own members only.
    const bobFirst = theirs.members[0] as Seeded;
    h.repository.withTransaction((scope) => scope.speakerConfirmations.set(BOB.userId, bobFirst.contentId, bobFirst.revisionId, 9));
    expect((await read(app, theirs.id, bob)).json()).toEqual({ stale: false, speakerContextChangedMembers: 1 });
    expect((await read(app, mine.id, auth)).json()).toEqual({ stale: false, speakerContextChangedMembers: 2 });

    // Neither may read the other's collection, its count included.
    for (const [id, headers] of [[theirs.id, auth], [mine.id, bob]] as const) {
      const foreign = await read(app, id, headers);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error).toMatchObject({ code: "not_found" });
      expect(foreign.body).not.toContain("speakerContextChangedMembers");
    }
  });

  it("leaves the count out when no member's speakers changed", async () => {
    const { h, app } = await setup();
    syncTemplates(h);
    const quiet = await seedCollection(h, app, auth, LOCAL.userId, ["held", "none"]);
    const response = await read(app, quiet.id, auth);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stale: false });
    expect(response.json()).not.toHaveProperty("speakerContextChangedMembers");

    // Once the last changed member's review is given, the count goes away rather than reading 0.
    const changing = await seedCollection(h, app, auth, LOCAL.userId, ["changed", "none"]);
    expect((await read(app, changing.id, auth)).json()).toEqual({ stale: false, speakerContextChangedMembers: 1 });
    const member = changing.members[0] as Seeded;
    h.repository.withTransaction((scope) => scope.speakerConfirmations.set(LOCAL.userId, member.contentId, member.revisionId, 9));
    const after = await read(app, changing.id, auth);
    expect(after.json()).toEqual({ stale: false });
    expect(after.body).not.toContain("speakerContextChangedMembers");
  });
});
