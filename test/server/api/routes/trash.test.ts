import { afterEach, describe, expect, it, vi } from "vitest";
import { TRASH_RETENTION_MS } from "../../../../src/server/domain/content.ts";
import { API_PAGE_SIZE_MAX, CONTENT_TRASH_BATCH_MAX } from "../../../../src/shared/defaults.ts";
import { contentDtoSchema } from "../../../../src/shared/dto/content.ts";
import { trashListDtoSchema, trashPurgeAllDtoSchema, trashRestoreResultDtoSchema } from "../../../../src/shared/dto/trash.ts";
import { BOB_TOKEN, createHarness, createLocalContent, createTaskOfKind, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { insertSummary, seedTranscripts } from "../../../fixtures/pipeline/summary-data.ts";
import { countRows } from "../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const h = createHarness();
  open.push(h);
  const { app } = await h.app();
  return { h, app };
}

function finishedContent(h: Harness): string {
  const contentId = createLocalContent(h);
  const taskId = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId });
  h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, "succeeded", 2));
  return contentId;
}

describe("/api/trash", () => {
  it("lists what DELETE /api/contents/:id moved there, and restores it as a ContentDto", async () => {
    const { h, app } = await setup();
    const contentId = finishedContent(h);
    expect((await app.inject({ method: "GET", url: "/api/trash", headers: auth })).json()).toEqual({ items: [], total: 0 });
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth })).statusCode).toBe(204);

    const listed = await app.inject({ method: "GET", url: "/api/trash?limit=10", headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(trashListDtoSchema.parse(listed.json())).toEqual({
      items: [{ id: contentId, source: { kind: "local" }, trashedAt: T0, purgeAt: T0 + TRASH_RETENTION_MS, expired: false, mediaBytes: 0 }],
      total: 1,
    });
    expect((await app.inject({ method: "GET", url: "/api/trash", headers: bob })).json()).toEqual({ items: [], total: 0 });

    expect((await app.inject({ method: "POST", url: `/api/trash/${contentId}/restore`, headers: bob })).statusCode).toBe(404);
    const restored = await app.inject({ method: "POST", url: `/api/trash/${contentId}/restore`, headers: auth });
    expect(restored.statusCode).toBe(200);
    expect(contentDtoSchema.parse(restored.json())).toMatchObject({ id: contentId, collections: [] });
    expect(restored.json()).not.toHaveProperty("trashedAt");
    expect((await app.inject({ method: "POST", url: `/api/trash/${contentId}/restore`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth })).statusCode).toBe(200);
  });

  it("refuses to restore an expired entry with 409 conflict.trash_expired, while still listing it", async () => {
    const { h, app } = await setup();
    const contentId = finishedContent(h);
    await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth });
    vi.setSystemTime(T0 + TRASH_RETENTION_MS);
    const refused = await app.inject({ method: "POST", url: `/api/trash/${contentId}/restore`, headers: auth });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ class: "conflict", code: "conflict.trash_expired" });
    expect((await app.inject({ method: "GET", url: "/api/trash", headers: auth })).json().items).toMatchObject([{ id: contentId, expired: true }]);
  });

  it("purges one entry with 204 and empties the trash with the ids purged and the failures", async () => {
    const { h, app } = await setup();
    const [a, b, c] = [finishedContent(h), finishedContent(h), finishedContent(h)];
    for (const id of [a, b, c]) await app.inject({ method: "DELETE", url: `/api/contents/${id}`, headers: auth });
    // Not in the trash, or not the caller's: unknown.
    expect((await app.inject({ method: "DELETE", url: `/api/trash/${finishedContent(h)}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/trash/${a}`, headers: bob })).statusCode).toBe(404);
    const purged = await app.inject({ method: "DELETE", url: `/api/trash/${a}`, headers: auth });
    expect(purged.statusCode).toBe(204);
    expect(purged.body).toBe("");
    expect(countRows(h.db, "content", "id = ?", a)).toBe(0);
    expect((await app.inject({ method: "DELETE", url: `/api/trash/${a}`, headers: auth })).statusCode).toBe(404);

    createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId: c as string });
    const emptied = await app.inject({ method: "DELETE", url: "/api/trash", headers: auth });
    expect(emptied.statusCode).toBe(200);
    expect(trashPurgeAllDtoSchema.parse(emptied.json())).toEqual({ purgedIds: [b], failed: [{ contentId: c, code: "conflict.tasks_unfinished" }] });
  });

  it("validates the listing query and pages with an opaque cursor", async () => {
    const { h, app } = await setup();
    for (let index = 0; index < 3; index += 1) {
      vi.setSystemTime(T0 + index);
      await app.inject({ method: "DELETE", url: `/api/contents/${finishedContent(h)}`, headers: auth });
    }
    for (const url of ["/api/trash?limit=0", `/api/trash?limit=${API_PAGE_SIZE_MAX + 1}`, "/api/trash?other=1", "/api/trash?cursor=bogus"]) {
      expect([url, (await app.inject({ method: "GET", url, headers: auth })).statusCode]).toEqual([url, 400]);
    }
    const first = (await app.inject({ method: "GET", url: "/api/trash?limit=2", headers: auth })).json();
    const second = (await app.inject({ method: "GET", url: `/api/trash?limit=2&cursor=${first.nextCursor}`, headers: auth })).json();
    expect([first.items.length, second.items.length, second.nextCursor, first.total]).toEqual([2, 1, undefined, 3]);
  });

  it("pages by number, never together with a cursor, and only with a safe integer from 1", async () => {
    const { h, app } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      vi.setSystemTime(T0 + index);
      const contentId = finishedContent(h);
      ids.push(contentId);
      await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth });
    }
    const second = await app.inject({ method: "GET", url: "/api/trash?limit=2&page=2", headers: auth });
    expect(second.statusCode).toBe(200);
    expect(trashListDtoSchema.parse(second.json())).toMatchObject({ items: [{ id: ids[0] }], total: 3 });
    expect(second.json()).not.toHaveProperty("nextCursor");
    expect((await app.inject({ method: "GET", url: "/api/trash?limit=2&page=3", headers: auth })).json()).toEqual({ items: [], total: 3 });

    const cursor = (await app.inject({ method: "GET", url: "/api/trash?limit=2", headers: auth })).json().nextCursor as string;
    const both = await app.inject({ method: "GET", url: `/api/trash?limit=2&page=1&cursor=${cursor}`, headers: auth });
    expect([both.statusCode, both.json().error.class, both.json().error.userMessage]).toEqual([400, "invalid_request", expect.stringMatching(/query\.page$/)]);
    for (const url of ["/api/trash?page=0", "/api/trash?page=1.5", "/api/trash?page=9007199254740993", "/api/trash?page=-1", "/api/trash?page="]) {
      expect([url, (await app.inject({ method: "GET", url, headers: auth })).statusCode]).toEqual([url, 400]);
    }
  });
});

describe("a Content in the trash, over HTTP", () => {
  it("is not_found on its own routes and its sub-resources, even for its owner", async () => {
    const { h, app } = await setup();
    const contentId = finishedContent(h);
    const fixture = seedTranscripts(h, contentId);
    const segment = fixture.asr.segments[0];
    const summary = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    const note = h.notes.create(LOCAL, contentId, {
      transcriptRevisionId: fixture.asr.revision.id, startSegmentId: segment?.id as string, startOffset: 0, endSegmentId: segment?.id as string, endOffset: 2,
      mark: "underline", color: "blue",
    }).body;
    const course = h.collections.create(LOCAL, { name: "Course" });
    const item = (await h.collections.addItem(LOCAL, course.id, { contentId })).body as { id: string };
    const taskId = h.tasks.list(LOCAL, { limit: 10, contentId }).items[0]?.id as string;
    await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth });

    const requests: Array<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; payload?: Record<string, unknown> }> = [
      { method: "GET", url: `/api/contents/${contentId}` },
      { method: "PATCH", url: `/api/contents/${contentId}`, payload: { pinned: true } },
      { method: "DELETE", url: `/api/contents/${contentId}` },
      { method: "GET", url: `/api/contents/${contentId}/transcript/revisions` },
      { method: "GET", url: `/api/transcript/revisions/${fixture.asr.revision.id}/segments` },
      { method: "GET", url: `/api/transcript/segments/${segment?.id}/map?targetRevision=${fixture.corrected.revision.id}` },
      { method: "GET", url: `/api/contents/${contentId}/notes` },
      { method: "PATCH", url: `/api/notes/${note.id}`, payload: { color: "green" } },
      { method: "DELETE", url: `/api/notes/${note.id}` },
      { method: "GET", url: `/api/contents/${contentId}/summaries` },
      { method: "GET", url: `/api/summaries/${summary.artifactId}/revisions` },
      { method: "PUT", url: `/api/summaries/${summary.artifactId}/current`, payload: { revisionId: summary.revisionId } },
      { method: "GET", url: `/api/contents/${contentId}/chat` },
      { method: "GET", url: `/api/tasks/${taskId}` },
      { method: "GET", url: `/api/tasks?contentId=${contentId}` },
      { method: "DELETE", url: `/api/collections/${course.id}/items/${item.id}` },
      { method: "POST", url: `/api/collections/${course.id}/items`, payload: { contentId } },
    ];
    const answers: string[] = [];
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: auth });
      answers.push(`${request.method} ${request.url} → ${response.statusCode} ${(response.json() as { error?: { class?: string } }).error?.class}`);
    }
    expect(answers).toEqual(requests.map((request) => `${request.method} ${request.url} → 404 not_found`));
    expect((await app.inject({ method: "GET", url: "/api/notes/groups", headers: auth })).json()).toMatchObject({ items: [], total: 0 });
    // Nothing was changed by any of them.
    expect(countRows(h.db, "note", "id = ?", note.id)).toBe(1);
    expect(countRows(h.db, "collection_item", "id = ?", item.id)).toBe(1);
  });
});

describe("POST /api/trash/restore", () => {
  it("restores each Content on its own and tells the outcomes apart", async () => {
    const { h, app } = await setup();
    const back = finishedContent(h);
    const old = finishedContent(h);
    const active = finishedContent(h);
    h.trash.trash(LOCAL, old);
    vi.setSystemTime(T0 + 10);
    h.trash.trash(LOCAL, back);
    vi.setSystemTime(T0 + TRASH_RETENTION_MS);
    const response = await app.inject({ method: "POST", url: "/api/trash/restore", headers: auth, payload: { contentIds: [back, active, old, "01UNKNOWNCONTENT000000000"] } });
    expect(response.statusCode).toBe(200);
    expect(trashRestoreResultDtoSchema.parse(response.json())).toEqual({
      restoredIds: [back],
      alreadyActiveIds: [active],
      failed: [{ contentId: old, reason: "expired" }, { contentId: "01UNKNOWNCONTENT000000000", reason: "missing" }],
    });
    expect((await app.inject({ method: "GET", url: `/api/contents/${back}`, headers: auth })).statusCode).toBe(200);
    // Another user's ids are missing for the caller and stay where they are.
    vi.setSystemTime(T0 + TRASH_RETENTION_MS + 1);
    h.trash.trash(LOCAL, back);
    expect((await app.inject({ method: "POST", url: "/api/trash/restore", headers: bob, payload: { contentIds: [back] } })).json()).toEqual({
      restoredIds: [], alreadyActiveIds: [], failed: [{ contentId: back, reason: "missing" }],
    });
    expect((await app.inject({ method: "GET", url: `/api/contents/${back}`, headers: auth })).statusCode).toBe(404);
    const tooMany = await app.inject({
      method: "POST", url: "/api/trash/restore", headers: auth, payload: { contentIds: Array.from({ length: CONTENT_TRASH_BATCH_MAX + 1 }, (_, index) => `c${index}`) },
    });
    expect([tooMany.statusCode, tooMany.json().error.code]).toEqual([400, "invalid_request.batch_too_large"]);
    expect((await app.inject({ method: "POST", url: "/api/trash/restore", headers: auth, payload: { contentIds: [] } })).statusCode).toBe(400);
  });
});
