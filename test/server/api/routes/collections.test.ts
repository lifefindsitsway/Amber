import { afterEach, describe, expect, it } from "vitest";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
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
