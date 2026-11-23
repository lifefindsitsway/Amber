import { afterEach, describe, expect, it } from "vitest";
import { TrashService } from "../../../../src/server/application/trash.ts";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import { BUILTIN_SUMMARY_TEMPLATES } from "../../../../src/server/domain/prompts.ts";
import { attributionDigest, speakerLabels } from "../../../../src/server/domain/speaker-context.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { transact } from "../../../../src/server/pipeline/publish.ts";
import { createTask } from "../../../../src/server/pipeline/task-state.ts";
import { collectionDeletePlanDtoSchema, collectionDeleteResultDtoSchema, collectionDetailDtoSchema } from "../../../../src/shared/dto/collection.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { BOB, BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, silentLogger, taskOf, type Harness } from "../../../fixtures/pipeline/harness.ts";
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

describe("removing members and deleting a collection with its contents", () => {
  async function withTrash() {
    const h = createHarness();
    open.push(h);
    const trash = new TrashService({
      repository: h.repository,
      deleteContent: h.deleteContent,
      fileDeleter: h.fileDeleter,
      chat: h.chat,
      logger: silentLogger,
      tasks: h.tasks,
      execution: h.scheduler,
    });
    const { app } = await h.app({ trash });
    return { h, app };
  }

  async function seeded(h: Harness) {
    const exclusive = [createLocalContent(h), createLocalContent(h)];
    const shared = createLocalContent(h);
    const course = h.collections.create(LOCAL, { name: "Course" });
    const other = h.collections.create(LOCAL, { name: "Other" });
    for (const contentId of [...exclusive, shared]) await h.collections.addItem(LOCAL, course.id, { contentId });
    await h.collections.addItem(LOCAL, other.id, { contentId: shared });
    return { course: course.id, other: other.id, exclusive, shared };
  }

  /** An unfinished summary of the collection, created the way the collection service does. */
  function summaryTask(h: Harness, collectionId: string, contentIds: readonly string[]): string {
    return transact(h.repository, h.bus, (scope, outbox) =>
      createTask(scope, outbox, {
        task: {
          id: h.newId(),
          userId: LOCAL.userId,
          collectionId,
          kind: "summarize_collection",
          requestJson: canonicalJson({
            requestSchemaVersion: 1,
            kind: "summarize_collection",
            outputLanguage: "zh-CN",
            inputItems: contentIds.map((contentId, position) => ({ collectionItemId: `i${position}`, contentId, summaryRevisionId: "s", transcriptRevisionId: "t", position })),
          }),
          createdAt: Date.now(),
        },
        sourceKind: undefined,
        newId: h.newId,
      }).id,
    );
  }

  it("removes several members in one request and answers the detail; a non-member refuses the whole request", async () => {
    const { h, app } = await withTrash();
    const s = await seeded(h);
    const refused = await app.inject({ method: "POST", url: `/api/collections/${s.course}/items/remove`, headers: auth, payload: { contentIds: [s.exclusive[0], "01UNKNOWNCONTENT000000000"] } });
    expect([refused.statusCode, refused.json().error.class]).toEqual([404, "not_found"]);
    expect((await app.inject({ method: "POST", url: `/api/collections/${s.course}/items/remove`, headers: bob, payload: { contentIds: [s.shared] } })).statusCode).toBe(404);
    const removed = await app.inject({ method: "POST", url: `/api/collections/${s.course}/items/remove`, headers: auth, payload: { contentIds: [s.shared, s.exclusive[0]] } });
    expect(removed.statusCode).toBe(200);
    expect(collectionDetailDtoSchema.parse(removed.json())).toMatchObject({ itemCount: 1, items: [{ contentId: s.exclusive[1] }] });
    expect(h.collections.get(LOCAL, s.other).items.map((item) => item.contentId)).toEqual([s.shared]);
    expect((await app.inject({ method: "POST", url: `/api/collections/${s.course}/items/remove`, headers: auth, payload: { contentIds: [] } })).statusCode).toBe(400);
  });

  it("plans and deletes with the contents; a retry with the same key gets the first answer", async () => {
    const { h, app } = await withTrash();
    const s = await seeded(h);
    const summary = summaryTask(h, s.course, s.exclusive);
    const plan = await app.inject({ method: "GET", url: `/api/collections/${s.course}/delete-plan`, headers: auth });
    expect(plan.statusCode).toBe(200);
    expect(collectionDeletePlanDtoSchema.parse(plan.json())).toEqual({
      memberCount: 3, exclusiveContentIds: s.exclusive, sharedCount: 1, trashedMemberCount: 0, exclusiveWithTasksCount: 0, collectionTaskCount: 1, blocked: [],
    });
    expect((await app.inject({ method: "GET", url: `/api/collections/${s.course}/delete-plan`, headers: bob })).statusCode).toBe(404);

    const url = `/api/collections/${s.course}/delete`;
    const payload = { contents: "exclusive", cancelTasks: true, expectedContentIds: s.exclusive };
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { contents: "exclusive", cancelTasks: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob, payload })).statusCode).toBe(404);
    const changed = await app.inject({ method: "POST", url, headers: auth, payload: { ...payload, expectedContentIds: [s.exclusive[0]] } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatchObject({ code: "conflict.collection_members_changed", details: { cancelledTaskCount: 0 } });
    expect(taskOf(h, summary).statusProjection).toBe("queued");

    const keyed = { ...auth, "idempotency-key": "delete-1" };
    const deleted = await app.inject({ method: "POST", url, headers: keyed, payload });
    expect(deleted.statusCode).toBe(200);
    expect(collectionDeleteResultDtoSchema.parse(deleted.json())).toEqual({ trashedIds: s.exclusive, cancelledTaskCount: 1 });
    const retried = await app.inject({ method: "POST", url, headers: keyed, payload });
    expect([retried.statusCode, retried.json()]).toEqual([200, deleted.json()]);
    expect((await app.inject({ method: "POST", url, headers: auth, payload })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/contents/${s.shared}`, headers: auth })).statusCode).toBe(200);
    const restored = await app.inject({ method: "POST", url: "/api/trash/restore", headers: auth, payload: { contentIds: s.exclusive } });
    expect(restored.json()).toMatchObject({ restoredIds: s.exclusive });
  });

  it("leaves DELETE /api/collections/:id as it was: 409 while a Task is unfinished, else 204 keeping the members", async () => {
    const { h, app } = await withTrash();
    const s = await seeded(h);
    const summary = summaryTask(h, s.course, s.exclusive);
    const refused = await app.inject({ method: "DELETE", url: `/api/collections/${s.course}`, headers: auth });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ class: "conflict", code: "conflict" });
    expect(taskOf(h, summary).statusProjection).toBe("queued");
    h.tasks.cancel(LOCAL, summary);
    const deleted = await app.inject({ method: "DELETE", url: `/api/collections/${s.course}`, headers: auth });
    expect([deleted.statusCode, deleted.body]).toEqual([204, ""]);
    for (const contentId of [...s.exclusive, s.shared]) {
      expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/api/trash", headers: auth })).json()).toMatchObject({ total: 0 });
  });

  it("with contents kept deletes only the collection, like DELETE", async () => {
    const { h, app } = await withTrash();
    const s = await seeded(h);
    const response = await app.inject({ method: "POST", url: `/api/collections/${s.course}/delete`, headers: auth, payload: { contents: "keep", cancelTasks: false } });
    expect([response.statusCode, response.json()]).toEqual([200, { trashedIds: [], cancelledTaskCount: 0 }]);
    expect(h.collections.list(LOCAL).items.map((item) => item.id)).toEqual([s.other]);
    expect(h.contents.list(LOCAL, { limit: 10 }).items).toHaveLength(3);
  });
});
