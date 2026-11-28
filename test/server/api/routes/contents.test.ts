import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import type { FileStore } from "../../../../src/server/ports/file-store.ts";
import {
  CONTENT_DESCRIPTION_MAX_CHARS,
  CONTENT_LIST_IDS_MAX,
  COVER_FETCH_USER_CONCURRENCY,
  COVER_FETCH_USER_PER_MIN,
  MAX_UPLOAD_GB,
  SUBTITLE_IMPORT_MAX_BYTES,
} from "../../../../src/shared/defaults.ts";
import { TEXT_BODY_LIMIT_BYTES } from "../../../../src/server/api/routes/contents.ts";
import { isUlid } from "../../../../src/shared/ids.ts";
import { BYTES_PER_GB, BYTES_PER_MB } from "../../../../src/shared/units.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import { multipartBody, paddedMp4, zeroStream } from "../../../fixtures/media/multipart.ts";
import { createMediaStack, type MediaStack, type MediaStackOptions } from "../../../fixtures/pipeline/media-stack.ts";
import { BOB_TOKEN, createHarness, createLocalContent, gate, LOCAL, LOCAL_TOKEN, stageStatuses, taskOf, waitFor, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { configureLlm } from "../../../fixtures/pipeline/harness.ts";
import { countRows, tempDataDir } from "../../../tools/sqlite.ts";
import { coverRig, platformContentWithCover, rigContent, scriptedCovers, TINY_WEBP, type ScriptedCover } from "../../../fixtures/platform/covers.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import { contentListDtoSchema } from "../../../../src/shared/dto/content.ts";

const LINK = "https://www.bilibili.com/video/BV1xx411c7mD";
const MEMORY_PROBE = join(import.meta.dirname, "../../../fixtures/media/upload-memory-probe.ts");
const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  open.push(h);
  const { app } = await h.app();
  return { h, app };
}

describe("POST /api/contents/import", () => {
  it("answers 202 with importBatchId, taskIds, contentIds and the skipped trashed Contents", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }] } });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { importBatchId: string; taskIds: string[]; contentIds: string[] };
    expect(Object.keys(body).sort()).toEqual(["collectionIds", "contentIds", "importBatchId", "skippedTrashedContentIds", "taskIds"]);
    expect(response.json().collectionIds).toEqual([]);
    expect(response.json().skippedTrashedContentIds).toEqual([]);
    expect(body.taskIds).toHaveLength(1);
    expect(isUlid(body.taskIds[0] as string)).toBe(true);
    expect(isUlid(body.contentIds[0] as string)).toBe(true);
    expect(isUlid(body.importBatchId)).toBe(true);
  });

  it("rejects malformed bodies, unknown fields and unsupported links", async () => {
    const { app } = await setup();
    for (const payload of [{}, { links: [] }, { links: [LINK, LINK] }, { items: [{ url: LINK }], extra: true }, { items: [{ url: LINK }], settings: { outputLanguage: "not a tag" } }]) {
      const response = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.class).toBe("invalid_request");
    }
  });

  it("refuses an unsupported URL with source_unsupported_url and creates no Task", async () => {
    const { h, app } = await setup();
    const unsupported = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: "https://example.com/watch" }] } });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json().error).toMatchObject({ class: "source_unsupported_url", code: "source_unsupported_url" });
    expect(countRows(h.db, "task")).toBe(0);
    expect(countRows(h.db, "content")).toBe(0);
  });

  it("answers multipart_choice_required with the part ids for a multi-part submission", async () => {
    const { h, app } = await setup();
    h.platforms.bilibili.video("BV1xx411c7mD", { parts: [{ platformPartId: "c1" }, { platformPartId: "c2" }] });
    const response = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "invalid_request.multipart_choice_required", details: { parts: ["c1", "c2"] } });
  });
});

describe("POST /api/contents/inspect", () => {
  it("describes a link without creating anything", async () => {
    const { h, app } = await setup();
    h.platforms.bilibili.video("BV1xx411c7mD", { parts: [{ platformPartId: "c1", title: "One" }, { platformPartId: "c2", title: "Two" }] });
    const response = await app.inject({ method: "POST", url: "/api/contents/inspect", headers: auth, payload: { url: LINK } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "multipart", canonicalUrl: LINK, parts: [{ platformPartId: "c1", index: 1, title: "One" }, { index: 2 }] });
    const unsupported = await app.inject({ method: "POST", url: "/api/contents/inspect", headers: auth, payload: { url: "https://example.com/x" } });
    expect(unsupported.statusCode).toBe(422);
    const malformed = await app.inject({ method: "POST", url: "/api/contents/inspect", headers: auth, payload: { url: LINK, extra: 1 } });
    expect(malformed.statusCode).toBe(400);
    expect(countRows(h.db, "content")).toBe(0);
  });

  it("passes the preview fields through: later pages of a cached listing, and a stale preview as a conflict", async () => {
    const { h, app } = await setup();
    const SPACE = "https://space.bilibili.com/1/lists/2";
    const ids = Array.from({ length: 60 }, (_, i) => `BV1xx411c${String(i).padStart(3, "0")}`);
    h.platforms.bilibili.collections.set("1_2", {
      title: "Course",
      items: ids.map((id) => ({ platformContentId: id, platformPartId: `${id}-cid`, canonicalUrl: `https://www.bilibili.com/video/${id}` })),
    });
    const inspect = (payload: object) => app.inject({ method: "POST", url: "/api/contents/inspect", headers: auth, payload });
    const first = await inspect({ url: SPACE });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ kind: "collection", itemCount: 60, offset: 0, nextOffset: 50 });
    const next = await inspect({ url: SPACE, previewId: first.json().previewId, offset: 50 });
    expect(next.json()).toMatchObject({ offset: 50, previewId: first.json().previewId });
    expect(next.json().items).toHaveLength(10);
    expect(h.platforms.bilibili.callsOf("listCollection")).toHaveLength(1);
    const stale = await inspect({ url: SPACE, previewId: "gone", offset: 50 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("conflict.collection_preview_stale");
    expect((await inspect({ url: SPACE, offset: -1 })).statusCode).toBe(400);
  });
});

describe("reading and managing Contents over HTTP", () => {
  const bob = { authorization: `Bearer ${BOB_TOKEN}` };
  const SRT = "1\n00:00:00,000 --> 00:00:02,000\nhello\n";

  async function imported(app: Awaited<ReturnType<typeof setup>>["app"], url = LINK): Promise<string> {
    const response = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url }] } });
    return (response.json() as { contentIds: string[] }).contentIds[0] as string;
  }

  it("lists Contents page by page and filters them", async () => {
    const { app } = await setup();
    const first = await imported(app);
    const second = await imported(app, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const page = await app.inject({ method: "GET", url: "/api/contents?limit=1", headers: auth });
    expect(page.statusCode).toBe(200);
    const body = page.json() as { items: Array<{ id: string }>; nextCursor: string };
    expect(body.items.map((item) => item.id)).toEqual([second]);
    const next = await app.inject({ method: "GET", url: `/api/contents?limit=1&cursor=${body.nextCursor}`, headers: auth });
    expect((next.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([first]);
    const filtered = await app.inject({ method: "GET", url: "/api/contents?source=youtube", headers: auth });
    expect((filtered.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([second]);
    expect(body).toMatchObject({ total: 2 });
    const uncollected = await app.inject({ method: "GET", url: "/api/contents?uncollected=1", headers: auth });
    expect(uncollected.json()).toMatchObject({ total: 2 });
    for (const query of ["limit=0", "limit=abc", "source=vimeo", "status=nope", "unknown=1", "cursor=!!", "uncollected=yes", "uncollected=1&collectionId=k"]) {
      const bad = await app.inject({ method: "GET", url: `/api/contents?${query}`, headers: auth });
      expect(bad.statusCode, query).toBe(400);
    }
    const others = await app.inject({ method: "GET", url: "/api/contents", headers: bob });
    expect(others.json()).toEqual({ items: [], total: 0 });
  });

  it("lists a numbered page without nextCursor and refuses page with cursor or a page that is not a positive safe integer", async () => {
    const { app } = await setup();
    const first = await imported(app);
    const second = await imported(app, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const page = await app.inject({ method: "GET", url: "/api/contents?limit=1&page=2", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ items: [expect.objectContaining({ id: first })], total: 2 });
    const beyond = await app.inject({ method: "GET", url: "/api/contents?limit=1&page=3", headers: auth });
    expect(beyond.json()).toEqual({ items: [], total: 2 });
    const cursor = (await app.inject({ method: "GET", url: "/api/contents?limit=1", headers: auth })).json().nextCursor as string;
    expect((await app.inject({ method: "GET", url: `/api/contents?limit=1&page=1`, headers: auth })).json().items[0].id).toBe(second);
    const both = await app.inject({ method: "GET", url: `/api/contents?limit=1&page=1&cursor=${cursor}`, headers: auth });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toMatchObject({ class: "invalid_request" });
    // The offending field reaches the client only through the message's `detail`.
    expect(both.json().error.userMessage).toMatch(/query\.page$/);
    for (const value of ["0", "-1", "1.5", "abc", "9007199254740993"]) {
      const bad = await app.inject({ method: "GET", url: `/api/contents?page=${value}`, headers: auth });
      expect(bad.statusCode, value).toBe(400);
      expect(bad.json().error.userMessage, value).toMatch(/query\.page$/);
    }
  });

  it("lists only the named ids, deduplicated, and refuses empty entries and too many ids", async () => {
    const { app } = await setup();
    const first = await imported(app);
    const second = await imported(app, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const listed = await app.inject({ method: "GET", url: `/api/contents?ids=${first},${first},missing&page=1&limit=10`, headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [expect.objectContaining({ id: first })], total: 1 });
    const both = await app.inject({ method: "GET", url: `/api/contents?ids=${second},${first}`, headers: auth });
    expect((both.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([second, first]);
    const bob = { authorization: `Bearer ${BOB_TOKEN}` };
    expect((await app.inject({ method: "GET", url: `/api/contents?ids=${first}`, headers: bob })).json()).toEqual({ items: [], total: 0 });
    // The cap counts distinct ids, so repeating one id past it is still a single id.
    const repeated = Array.from({ length: CONTENT_LIST_IDS_MAX + 1 }, () => first).join(",");
    expect((await app.inject({ method: "GET", url: `/api/contents?ids=${repeated}`, headers: auth })).statusCode).toBe(200);
    const atCap = Array.from({ length: CONTENT_LIST_IDS_MAX }, (_, index) => `id${index}`).join(",");
    expect((await app.inject({ method: "GET", url: `/api/contents?ids=${atCap}`, headers: auth })).statusCode).toBe(200);
    for (const ids of ["", `${first},,${second}`, `${first},`, ",", `${atCap},extra`]) {
      const bad = await app.inject({ method: "GET", url: `/api/contents?ids=${ids}`, headers: auth });
      expect(bad.statusCode, ids).toBe(400);
      expect(bad.json().error).toMatchObject({ class: "invalid_request" });
      expect(bad.json().error.userMessage, ids).toMatch(/query\.ids/);
    }
  });

  it("renames, restores and pins a Content; only its owner may", async () => {
    const { app } = await setup();
    const contentId = await imported(app);
    const patch = (payload: Record<string, unknown>, headers = auth) => app.inject({ method: "PATCH", url: `/api/contents/${contentId}`, headers, payload });
    const renamed = await patch({ title: "  我的第一讲  " });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: contentId, title: "我的第一讲", customTitle: "我的第一讲" });
    const pinned = await patch({ pinned: true });
    expect((pinned.json() as { pinnedAt?: number }).pinnedAt).toEqual(expect.any(Number));
    const restored = await patch({ title: null, pinned: false });
    expect(restored.json()).not.toHaveProperty("customTitle");
    expect(restored.json()).not.toHaveProperty("pinnedAt");
    for (const payload of [{}, { title: "" }, { title: "   " }, { pinned: "yes" }, { other: 1 }]) {
      expect((await patch(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await patch({ pinned: true }, bob)).statusCode).toBe(404);
  });

  it("returns one Content with its media, and 404 for another user", async () => {
    const { app } = await setup();
    const contentId = await imported(app);
    const response = await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: contentId, source: { kind: "bilibili", sourceUrl: LINK }, media: [] });
    expect(response.json()).not.toHaveProperty("userId");
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/contents/missing", headers: auth })).statusCode).toBe(404);
  });

  it("imports a subtitle (201), lists revisions and switches the primary", async () => {
    const { app } = await setup();
    const contentId = await imported(app);
    const subtitle = await app.inject({ method: "POST", url: `/api/contents/${contentId}/subtitle-import`, headers: auth, payload: { text: SRT, language: "en" } });
    expect(subtitle.statusCode).toBe(201);
    const revisionId = (subtitle.json() as { transcriptRevisionId: string }).transcriptRevisionId;
    const notes = await app.inject({ method: "POST", url: `/api/contents/${contentId}/subtitle-import`, headers: auth, payload: { text: "notes", format: "md" } });
    expect(notes.statusCode).toBe(201);
    expect(notes.json()).toEqual({ referenceTextId: expect.any(String), warnings: [] });

    const revisions = await app.inject({ method: "GET", url: `/api/contents/${contentId}/transcript/revisions`, headers: auth });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json()).toMatchObject({ primaryTranscriptRevisionId: revisionId, revisions: [{ id: revisionId, kind: "imported" }] });

    const primary = await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId } });
    expect(primary.statusCode).toBe(200);
    expect(primary.json()).toMatchObject({ id: contentId, primaryTranscriptRevisionId: revisionId });
    const referenceText = (notes.json() as { referenceTextId: string }).referenceTextId;
    const refused = await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: referenceText } });
    expect(refused.statusCode).toBe(404);
    const malformed = await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: {} });
    expect(malformed.statusCode).toBe(400);

    for (const request of [
      { method: "POST" as const, url: `/api/contents/${contentId}/subtitle-import`, payload: { text: SRT, language: "en" } },
      { method: "GET" as const, url: `/api/contents/${contentId}/transcript/revisions` },
      { method: "PUT" as const, url: `/api/contents/${contentId}/primary-transcript`, payload: { revisionId } },
    ]) {
      expect((await app.inject({ ...request, headers: bob })).statusCode, request.url).toBe(404);
    }
  });

  it("takes subtitle text up to SUBTITLE_IMPORT_MAX_BYTES and answers media_too_large beyond it", async () => {
    const { app } = await setup();
    const contentId = await imported(app);
    const tooLarge = await app.inject({
      method: "POST", url: `/api/contents/${contentId}/subtitle-import`, headers: auth, payload: { text: "a".repeat(SUBTITLE_IMPORT_MAX_BYTES + 1), format: "txt" },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.class).toBe("media_too_large");
    const beyondBody = await app.inject({
      method: "POST", url: `/api/contents/${contentId}/subtitle-import`, headers: auth, payload: { text: "a".repeat(TEXT_BODY_LIMIT_BYTES + 1) },
    });
    expect(beyondBody.statusCode).toBe(400);
    expect(beyondBody.json().error.class).toBe("invalid_request");
  }, 60_000);

  it("moves a finished Content to the trash with 204, refuses one with unfinished Tasks, and hides others' Contents", async () => {
    const { h, app } = await setup();
    const modelRef = configureLlm(h);
    const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }], settings: { modelRef } } });
    const contentId = (created.json() as { contentIds: string[] }).contentIds[0] as string;
    const busy = await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth });
    expect(busy.statusCode).toBe(409);
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(taskOf(h, (created.json() as { taskIds: string[] }).taskIds[0] as string).statusProjection).toBe("succeeded");
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: bob })).statusCode).toBe(404);
    const deleted = await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    // The row stays, in the trash: unknown to every Content route, already-trashed included.
    expect(countRows(h.db, "content", "trashed_at IS NOT NULL")).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth })).statusCode).toBe(404);
  });
});

describe("POST /api/contents/:id/description/fetch", () => {
  const bob = { authorization: `Bearer ${BOB_TOKEN}` };
  const BVID = "BV1dsc411c7mD";
  const DESCRIPTION_FIELDS = ["description", "descriptionTruncated", "descriptionCheckedAt"];

  function platformContent(h: Harness): string {
    const contentId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.contents.insert({
        id: contentId,
        userId: LOCAL.userId,
        source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${BVID}`, platformContentId: BVID },
        title: "Lecture",
        processingStatus: "succeeded",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    return contentId;
  }

  const fetchDescription = (app: Awaited<ReturnType<typeof setup>>["app"], contentId: string, payload?: unknown, headers = auth) =>
    app.inject({ method: "POST", url: `/api/contents/${contentId}/description/fetch`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

  it("answers 200 with the result and the detail, with an empty object or no body", async () => {
    const { h, app } = await setup();
    const contentId = platformContent(h);
    h.platforms.bilibili.video(BVID, { description: { state: "found", text: "x".repeat(CONTENT_DESCRIPTION_MAX_CHARS + 1) } });
    const response = await fetchDescription(app, contentId, {});
    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: string; content: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["content", "result"]);
    expect(body.result).toBe("found");
    expect(body.content).toMatchObject({ id: contentId, description: "x".repeat(CONTENT_DESCRIPTION_MAX_CHARS), descriptionTruncated: true, descriptionCheckedAt: expect.any(Number), media: [], updatedAt: 1 });
    expect(body.content).not.toHaveProperty("userId");

    h.platforms.bilibili.video(BVID, { description: { state: "empty" } });
    const bodyless = await fetchDescription(app, contentId);
    expect(bodyless.statusCode).toBe(200);
    expect(bodyless.json().result).toBe("empty");
    expect(bodyless.json().content).not.toHaveProperty("description");
    expect(bodyless.json().content).not.toHaveProperty("descriptionTruncated");
    expect(bodyless.json().content.descriptionCheckedAt).toEqual(expect.any(Number));
  });

  it("refuses unknown body fields, local Contents, others' Contents and missing ones", async () => {
    const { h, app } = await setup();
    const contentId = platformContent(h);
    expect((await fetchDescription(app, contentId, { force: true })).statusCode).toBe(400);
    const local = h.newId();
    h.repository.withTransaction((scope) => scope.contents.insert({ id: local, userId: LOCAL.userId, source: { kind: "local" }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 }));
    const refused = await fetchDescription(app, local, {});
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.class).toBe("invalid_request");
    expect((await fetchDescription(app, contentId, {}, bob)).statusCode).toBe(404);
    expect((await fetchDescription(app, "missing", {})).statusCode).toBe(404);
    expect(h.platforms.bilibili.calls.filter((call) => call.method === "fetchDescription")).toEqual([]);
  });

  it("carries the description on the detail only, not on the list, a rename, the primary switch, a restore or collection items", async () => {
    const { h, app } = await setup();
    const contentId = platformContent(h);
    h.platforms.bilibili.video(BVID, { description: { state: "found", text: "x".repeat(CONTENT_DESCRIPTION_MAX_CHARS + 1) } });
    expect((await fetchDescription(app, contentId, {})).statusCode).toBe(200);
    const noDescription = (value: unknown, label: string) => {
      for (const field of DESCRIPTION_FIELDS) expect(value, `${label} ${field}`).not.toHaveProperty(field);
    };

    const detail = await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth });
    expect(detail.json()).toMatchObject({ description: "x".repeat(CONTENT_DESCRIPTION_MAX_CHARS), descriptionTruncated: true, descriptionCheckedAt: expect.any(Number) });

    const list = await app.inject({ method: "GET", url: "/api/contents", headers: auth });
    expect(list.json().items).toHaveLength(1);
    noDescription(list.json().items[0], "list");
    noDescription((await app.inject({ method: "PATCH", url: `/api/contents/${contentId}`, headers: auth, payload: { title: "Mine" } })).json(), "patch");

    const subtitle = await app.inject({ method: "POST", url: `/api/contents/${contentId}/subtitle-import`, headers: auth, payload: { text: "1\n00:00:00,000 --> 00:00:02,000\nhello\n", language: "en" } });
    const revisionId = (subtitle.json() as { transcriptRevisionId: string }).transcriptRevisionId;
    const primary = await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId } });
    expect(primary.statusCode).toBe(200);
    noDescription(primary.json(), "primary");

    const collection = h.collections.create(LOCAL, { name: "Course" });
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId: collection.id, contentId, position: 0, addedAt: 1 }));
    const items = (await app.inject({ method: "GET", url: `/api/collections/${collection.id}`, headers: auth })).json().items as unknown[];
    expect(items).toHaveLength(1);
    noDescription(items[0], "collection item");

    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}`, headers: auth })).statusCode).toBe(204);
    const restored = await app.inject({ method: "POST", url: `/api/trash/${contentId}/restore`, headers: auth });
    expect(restored.statusCode).toBe(200);
    noDescription(restored.json(), "restore");
    // The stored description survives the trip through the trash.
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth })).json().description).toBe("x".repeat(CONTENT_DESCRIPTION_MAX_CHARS));
  });
});

describe("Idempotency-Key over HTTP", () => {
  it("returns the same ids for a repeated key and idempotency_conflict for a different body", async () => {
    const { h, app } = await setup();
    const send = (payload: Record<string, unknown>, key: string) =>
      app.inject({ method: "POST", url: "/api/contents/import", headers: { ...auth, "idempotency-key": key }, payload });
    const first = await send({ items: [{ url: LINK }] }, "k-1");
    const second = await send({ items: [{ url: LINK }] }, "k-1");
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(countRows(h.db, "import_batch")).toBe(1);

    const conflict = await send({ items: [{ url: LINK }], settings: { autoProofread: false } }, "k-1");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.class).toBe("idempotency_conflict");

    const malformed = await send({ items: [{ url: LINK }] }, "has space");
    expect(malformed.statusCode).toBe(400);
  });
});

describe("disk low-water mark", () => {
  it("refuses new tasks with disk_low (507) while a running task finishes and queued ones wait", async () => {
    const { h, app } = await setup({ overrides: { concurrencyPipeline: 1 } });
    const modelRef = configureLlm(h);
    const release = gate();
    let summaries = 0;
    h.executors.summary = {
      async run() {
        summaries += 1;
        if (summaries === 1) {
          await release.promise;
        }
        return {};
      },
    };
    const importLink = (link: string) =>
      app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: link }], settings: { modelRef } } });
    const running = (await importLink(LINK)).json().taskIds[0] as string;
    const queued = (await importLink("https://www.bilibili.com/video/BV1yy411c7mE")).json().taskIds[0] as string;
    h.scheduler.start();
    await waitFor(() => stageStatuses(h, running).summary === "running");

    h.disk.low();
    const refused = await importLink("https://www.bilibili.com/video/BV1zz411c7mF");
    expect(refused.statusCode).toBe(507);
    expect(refused.json().error).toMatchObject({ class: "disk_low", code: "disk_low", retryDisposition: "never" });

    release.open();
    await h.scheduler.whenIdle();
    expect(taskOf(h, running).statusProjection).toBe("succeeded");
    expect(taskOf(h, queued).statusProjection).toBe("queued");
    expect(summaries).toBe(1);

    h.disk.plenty();
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    expect(taskOf(h, queued).statusProjection).toBe("succeeded");
  });
});

describe("POST /api/contents/upload [server] and /api/contents/local-file [client]", () => {
  const stacks: MediaStack[] = [];
  afterEach(async () => {
    for (const stack of stacks.splice(0)) await stack.close();
  });
  function mediaStack(options: MediaStackOptions = {}): MediaStack {
    const stack = createMediaStack(options);
    stacks.push(stack);
    return stack;
  }
  const fixture = () => readFileSync(mediaFixtures().withAudio.path);

  it("registers upload only in server mode and local-file only in local mode", async () => {
    const s = mediaStack();
    const local = (await s.app("local")).app;
    const server = (await s.app("server")).app;
    const body = multipartBody([{ name: "file", filename: "a.mp4", data: fixture() }]);
    const uploadLocal = await local.inject({ method: "POST", url: "/api/contents/upload", headers: { ...auth, "content-type": body.contentType }, payload: body.stream() });
    expect(uploadLocal.statusCode).toBe(404);
    const fileServer = await server.inject({ method: "POST", url: "/api/contents/local-file", headers: auth, payload: {} });
    expect(fileServer.statusCode).toBe(404);
  });

  it("accepts a multipart upload over the route with the ordered parts", async () => {
    const s = mediaStack();
    const { app } = await s.app("server");
    const body = multipartBody([
      { name: "settings", data: JSON.stringify({ autoProofread: false }) },
      { name: "allowDuplicate", data: "false" },
      { name: "file", filename: "C:\\Users\\me\\talk.mp4", data: fixture() },
    ]);
    const response = await app.inject({ method: "POST", url: "/api/contents/upload", headers: { ...auth, "content-type": body.contentType }, payload: body.stream() });
    expect(response.statusCode).toBe(202);
    const contentId = (response.json() as { contentIds: string[] }).contentIds[0] as string;
    const [asset] = s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
    expect(asset?.displayName).toBe("talk.mp4");
  });

  it("answers 413 media_too_large past the limit and 422 media_unsupported_type for a renamed text file, leaving no files", async () => {
    const s = mediaStack({ maxUploadBytes: 1024 * 1024 });
    const { app } = await s.app("server");
    const big = multipartBody([{ name: "file", filename: "big.mp4", data: paddedMp4(fixture(), 3 * 1024 * 1024) }]);
    const tooLarge = await app.inject({ method: "POST", url: "/api/contents/upload", headers: { ...auth, "content-type": big.contentType }, payload: big.stream() });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error).toMatchObject({ class: "media_too_large", code: "media_too_large" });
    const text = multipartBody([{ name: "file", filename: "movie.mp4", data: "plain text\n".repeat(100) }]);
    const unsupported = await app.inject({ method: "POST", url: "/api/contents/upload", headers: { ...auth, "content-type": text.contentType }, payload: text.stream() });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json().error.code).toBe("media_unsupported_type");
    expect(await s.files.list("assets")).toEqual([]);
  });

  it("answers 507 storage_quota_exceeded once an upload crosses the user's storage limit, leaving no files", async () => {
    const s = mediaStack();
    s.h.db.prepare("UPDATE user SET storage_limit_gb = ? WHERE id = ?").run(1024 / BYTES_PER_GB, LOCAL.userId);
    const { app } = await s.app("server");
    const body = multipartBody([{ name: "file", filename: "a.mp4", data: fixture() }]);
    const response = await app.inject({ method: "POST", url: "/api/contents/upload", headers: { ...auth, "content-type": body.contentType }, payload: body.stream() });
    expect(response.statusCode).toBe(507);
    expect(response.json().error.code).toBe("storage_quota_exceeded");
    expect(await s.files.list("assets")).toEqual([]);
  });

  it("closes the connection after refusing an upload mid-body, so a client still sending is not left waiting", async () => {
    const s = mediaStack();
    s.h.db.prepare("UPDATE user SET storage_limit_gb = ? WHERE id = ?").run((2 * BYTES_PER_MB) / BYTES_PER_GB, LOCAL.userId);
    const { app } = await s.app("server");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const send = (data: Parameters<typeof multipartBody>[0]) =>
      new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
        const body = multipartBody(data);
        const outgoing = httpRequest(
          { host: "127.0.0.1", port, method: "POST", path: "/api/contents/upload", headers: { ...auth, "content-type": body.contentType } },
          (response) => {
            response.resume();
            resolve({ status: response.statusCode ?? 0, headers: response.headers });
          },
        );
        // The client keeps writing after the answer; the closed connection ends it.
        outgoing.on("error", () => undefined);
        body.stream().on("error", reject).pipe(outgoing);
      });

    const refused = await send([{ name: "file", filename: "big.mp4", data: paddedMp4(fixture(), 64 * BYTES_PER_MB) }]);
    expect(refused.status).toBe(507);
    expect(refused.headers.connection).toBe("close");
    s.h.db.prepare("UPDATE user SET storage_limit_gb = NULL WHERE id = ?").run(LOCAL.userId);
    const accepted = await send([{ name: "file", filename: "a.mp4", data: fixture() }]);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.connection).not.toBe("close");
  });

  it("the real MAX_UPLOAD_GB limit stops a stub stream larger than it with 413", async () => {
    let received = 0;
    // Counts what reaches the store instead of writing gigabytes to disk.
    class SinkFileStore extends LocalFileStore {
      override async writeAtomic(_ref: string, data: Parameters<FileStore["writeAtomic"]>[1]) {
        for await (const chunk of data as AsyncIterable<Uint8Array>) {
          received += chunk.length;
        }
        return { sizeBytes: received, digest: "sha256:none" };
      }
    }
    const sink = new SinkFileStore(tempDataDir("amber-sink-"));
    const s = mediaStack({ files: sink });
    expect(s.localImport.uploadLimitBytes).toBe(MAX_UPLOAD_GB * BYTES_PER_GB);
    const { app } = await s.app("server");
    const body = multipartBody([{ name: "file", filename: "huge.mp4", data: zeroStream(MAX_UPLOAD_GB * BYTES_PER_GB + 4 * 1024 * 1024) }]);
    const response = await app.inject({ method: "POST", url: "/api/contents/upload", headers: { ...auth, "content-type": body.contentType }, payload: body.stream() });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("media_too_large");
    expect(received).toBe(MAX_UPLOAD_GB * BYTES_PER_GB);
    expect(countRows(s.h.db, "content")).toBe(0);
  }, 300_000);

  it("heap and external memory stay flat while 64 MiB and 512 MiB stream over a real socket", async () => {
    // Each size runs in its own server process with its own warm-up; the client is a third
    // process. `arrayBuffers` is already part of `external` (Node.js process.memoryUsage),
    // so it is recorded for diagnosis only and not added again.
    const outputDir = tempDataDir("amber-e2-samples-");
    const measure = async (size: number) => {
      const output = join(outputDir, `e2-${size / BYTES_PER_MB}mib.json`);
      // The probe gets a bare environment; only the run's temp root is passed on, so its
      // scratch directories are removed with the run (test/tools/temp-root.ts).
      const temp = tmpdir();
      const env = { AMBER_PROBE_SIZE: String(size), AMBER_PROBE_OUTPUT: output, TMPDIR: temp, TEMP: temp, TMP: temp };
      const probe = spawn(process.execPath, [MEMORY_PROBE], { env, stdio: "inherit" });
      expect(await new Promise<number | null>((resolve) => probe.once("exit", resolve))).toBe(0);
      const run = JSON.parse(readFileSync(output, "utf8")) as {
        warmupStatus: string;
        status: string;
        baseline: { heapUsed: number; external: number; arrayBuffers: number; rss: number };
        samples: Array<{ heapUsed: number; external: number; arrayBuffers: number; rss: number }>;
      };
      expect(run.warmupStatus).toBe("202");
      expect(run.status).toBe("202");
      const managed = (s: { heapUsed: number; external: number }) => s.heapUsed + s.external;
      return {
        managed: Math.max(...run.samples.map(managed)) - managed(run.baseline),
        rss: Math.max(...run.samples.map((s) => s.rss)) - run.baseline.rss,
        arrayBuffers: Math.max(...run.samples.map((s) => s.arrayBuffers)) - run.baseline.arrayBuffers,
        samples: run.samples.length,
      };
    };
    const small = await measure(64 * BYTES_PER_MB);
    const large = await measure(512 * BYTES_PER_MB);
    const mib = (bytes: number) => Math.round((bytes / BYTES_PER_MB) * 10) / 10;
    console.log(
      `Upload memory raw samples in ${outputDir}; peak deltas (MiB) heapUsed+external ${mib(small.managed)} / ${mib(large.managed)}, ` +
        `rss ${mib(small.rss)} / ${mib(large.rss)}, arrayBuffers (diagnostic) ${mib(small.arrayBuffers)} / ${mib(large.arrayBuffers)}, ` +
        `samples ${small.samples} / ${large.samples}`,
    );
    // V8 lets external memory grow 64 MiB past its level at the last mark-compact before
    // external pressure forces a GC (kExternalAllocationSoftLimit); 32 MiB of margin on top.
    expect(small.managed).toBeLessThan(96 * BYTES_PER_MB);
    expect(large.managed).toBeLessThan(96 * BYTES_PER_MB);
    expect(Math.abs(large.managed - small.managed)).toBeLessThan(32 * BYTES_PER_MB);
    expect(small.rss).toBeLessThan(128 * BYTES_PER_MB);
    expect(large.rss).toBeLessThan(128 * BYTES_PER_MB);
  }, 300_000);

  it("imports a granted local file over the route", async () => {
    const s = mediaStack();
    const { app } = await s.app("local");
    const { withAudio } = mediaFixtures();
    const response = await app.inject({ method: "POST", url: "/api/contents/local-file", headers: auth, payload: { path: withAudio.path, grant: s.grant(withAudio.path) } });
    expect(response.statusCode).toBe(202);
    const forged = await app.inject({
      method: "POST", url: "/api/contents/local-file", headers: auth, payload: { path: "/etc/hostname", grant: { ...s.grant(withAudio.path), path: "/etc/hostname" } },
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe("unauthenticated.file_grant");
    const malformed = await app.inject({ method: "POST", url: "/api/contents/local-file", headers: auth, payload: { path: withAudio.path } });
    expect(malformed.statusCode).toBe(400);
  });
});

describe("the local cover over HTTP", () => {
  const bob = { authorization: `Bearer ${BOB_TOKEN}` };

  async function coverSetup(answer?: () => ScriptedCover) {
    const h = createHarness();
    open.push(h);
    const { covers, fetched } = scriptedCovers(h, answer);
    const { app } = await h.app({ covers });
    return { h, app, covers, fetched };
  }

  const fetchCover = (app: Awaited<ReturnType<typeof coverSetup>>["app"], id: string, headers = auth, payload?: unknown) =>
    app.inject({ method: "POST", url: `/api/contents/${id}/cover/fetch`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

  it("serves the copy as WebP with a versioned ETag, revalidates to 304, and answers 404 without a copy", async () => {
    const { h, app, covers } = await coverSetup();
    const id = platformContentWithCover(h);
    const missing = await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: auth });
    expect([missing.statusCode, missing.json().error.class]).toEqual([404, "not_found"]);

    await covers.saveIfAbsent(LOCAL.userId, id, "https://i0.hdslb.com/bfs/archive/cover.jpg", new AbortController().signal);
    const served = await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: auth });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/webp");
    expect(served.headers["cache-control"]).toBe("private, no-cache");
    expect(served.rawPayload.equals(TINY_WEBP)).toBe(true);
    const etag = served.headers.etag as string;
    expect(etag).toMatch(/^"v1-[0-9a-f]{32}"$/);
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const revalidated = await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: { ...auth, "if-none-match": header } });
      expect([header, revalidated.statusCode, revalidated.body]).toEqual([header, 304, ""]);
    }
    expect((await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: { ...auth, "if-none-match": '"v0-old"' } })).statusCode).toBe(200);

    // Another user's Content, or one in the trash, is unknown here.
    const foreign = await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: bob });
    expect([foreign.statusCode, foreign.json().error.class]).toEqual([404, "not_found"]);
    h.trash.trash(LOCAL, id);
    expect((await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: auth })).statusCode).toBe(404);
  });

  it("fetches again on request: a success raises the version and changes the ETag", async () => {
    let bytes = TINY_WEBP;
    const { h, app, covers } = await coverSetup(() => bytes);
    const id = platformContentWithCover(h);
    await covers.saveIfAbsent(LOCAL.userId, id, "https://i0.hdslb.com/bfs/archive/cover.jpg", new AbortController().signal);
    const before = (await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: auth })).headers.etag;

    bytes = Buffer.concat([TINY_WEBP, Buffer.from([0])]);
    for (const payload of [{}, undefined]) {
      const response = await fetchCover(app, id, auth, payload);
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json())).toEqual(["content"]);
    }
    const detail = (await app.inject({ method: "GET", url: `/api/contents/${id}`, headers: auth })).json();
    expect(detail).toMatchObject({ id, coverImageVersion: 3, updatedAt: 1 });
    const after = await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: { ...auth, "if-none-match": before as string } });
    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).toMatch(/^"v3-/);
    expect((await fetchCover(app, id, auth, { extra: true })).statusCode).toBe(400);
  });

  it("keeps the copy and the version when the fetch fails, answering the platform's error", async () => {
    let answer: ScriptedCover = TINY_WEBP;
    const { h, app, covers } = await coverSetup(() => answer);
    const id = platformContentWithCover(h);
    await covers.saveIfAbsent(LOCAL.userId, id, "https://i0.hdslb.com/bfs/archive/cover.jpg", new AbortController().signal);
    answer = amberError("platform_blocked", "refused");
    const failed = await fetchCover(app, id);
    expect([failed.statusCode, failed.json().error.class]).toEqual([422, "platform_blocked"]);
    const served = await app.inject({ method: "GET", url: `/api/contents/${id}/cover`, headers: auth });
    expect([served.statusCode, served.headers.etag]).toEqual([200, expect.stringMatching(/^"v1-/)]);
    expect((await app.inject({ method: "GET", url: `/api/contents/${id}`, headers: auth })).json().coverImageVersion).toBe(1);
  });

  it("answers 409 cover_fetch_busy while the user's cover slots are taken and over the per-minute budget", async () => {
    const h = createHarness();
    open.push(h);
    let now = 1_000_000;
    const rig = coverRig(h, { service: { now: () => now } });
    const { app } = await h.app({ covers: rig.covers });
    const held = Array.from({ length: COVER_FETCH_USER_CONCURRENCY }, () => rigContent(h));
    const saving = held.map((id) => rig.covers.saveIfAbsent(LOCAL.userId, id, `https://img.example.com/${id}.jpg`, new AbortController().signal));
    await waitFor(() => rig.calls.length === COVER_FETCH_USER_CONCURRENCY);
    const id = rigContent(h);
    const busy = await fetchCover(app, id);
    expect([busy.statusCode, busy.json().error.code]).toEqual([409, "conflict.cover_fetch_busy"]);
    for (const call of rig.calls) call.answer(TINY_WEBP);
    await Promise.all(saving);

    const quick = coverRig(h, { auto: () => TINY_WEBP, service: { now: () => now } });
    const { app: second } = await h.app({ covers: quick.covers });
    for (let i = 0; i < COVER_FETCH_USER_PER_MIN; i += 1) expect((await fetchCover(second, id)).statusCode).toBe(200);
    const limited = await fetchCover(second, id);
    expect([limited.statusCode, limited.json().error]).toEqual([409, expect.objectContaining({ code: "conflict.cover_fetch_busy", details: { retryAfterMs: 60_000 } })]);
    now += 60_000;
    expect((await fetchCover(second, id)).statusCode).toBe(200);
  });

  it("refuses a local Content and answers not_found for another user's", async () => {
    const { h, app, fetched } = await coverSetup();
    const local = createLocalContent(h);
    const refused = await fetchCover(app, local);
    expect([refused.statusCode, refused.json().error.class]).toEqual([400, "invalid_request"]);
    const foreign = await fetchCover(app, platformContentWithCover(h), bob);
    expect([foreign.statusCode, foreign.json().error.class]).toEqual([404, "not_found"]);
    expect(fetched).toEqual([]);
  });

  it("carries coverImageVersion in the list and the detail only for a Content with a copy", async () => {
    const { h, app, covers } = await coverSetup();
    const [withCopy, without] = [platformContentWithCover(h), platformContentWithCover(h)];
    await covers.saveIfAbsent(LOCAL.userId, withCopy, "https://i0.hdslb.com/bfs/archive/cover.jpg", new AbortController().signal);
    const list = contentListDtoSchema.parse((await app.inject({ method: "GET", url: "/api/contents", headers: auth })).json());
    expect(list.items.find((item) => item.id === withCopy)?.coverImageVersion).toBe(1);
    expect(list.items.find((item) => item.id === without)).not.toHaveProperty("coverImageVersion");
    expect((await app.inject({ method: "GET", url: `/api/contents/${withCopy}`, headers: auth })).json().coverImageVersion).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/contents/${without}`, headers: auth })).json()).not.toHaveProperty("coverImageVersion");

    // A collection's items carry it too.
    const collection = h.collections.create(LOCAL, { name: "c" });
    for (const contentId of [withCopy, without]) await h.collections.addItem(LOCAL, collection.id, { contentId });
    const items = h.collections.get(LOCAL, collection.id).items;
    expect(items.find((item) => item.contentId === withCopy)?.coverImageVersion).toBe(1);
    expect(items.find((item) => item.contentId === without)).not.toHaveProperty("coverImageVersion");
  });
});

describe("links checked before import over HTTP", () => {
  const NOTE = "64e0a1b2c3d4e5f600112233";
  const XHS = `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=xxxxtok1&xsec_source=pc_feed`;
  const importLink = (app: Awaited<ReturnType<typeof setup>>["app"], item: object) =>
    app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [item] } });

  it("answers 400 with the refused link and writes nothing, until an unverified link is accepted", async () => {
    const { h, app } = await setup();
    h.platforms.xiaohongshu.checks.set(NOTE, { result: "rejected", reason: "not_video" });
    const image = await importLink(app, { url: XHS });
    expect(image.statusCode).toBe(400);
    expect(image.json().error).toMatchObject({ code: "invalid_request.not_video", details: { urls: [XHS] }, userMessage: "这是图文笔记，Amber 目前只处理视频" });

    h.platforms.xiaohongshu.checks.set(NOTE, { result: "unverified" });
    const unverified = await importLink(app, { url: XHS });
    expect(unverified.statusCode).toBe(400);
    expect(unverified.json().error).toMatchObject({ code: "invalid_request.link_unverified", details: { urls: [XHS] } });
    expect(countRows(h.db, "content")).toBe(0);
    expect(countRows(h.db, "task")).toBe(0);

    const accepted = await importLink(app, { url: XHS, acceptUnverified: true });
    expect(accepted.statusCode).toBe(202);
    expect(countRows(h.db, "content")).toBe(1);
    expect(countRows(h.db, "task")).toBe(1);
  });

  it("inspects a library link without asking the platform, and reports a replaced source link on import", async () => {
    const { h, app } = await setup();
    const created = await importLink(app, { url: XHS });
    const contentId = created.json().contentIds[0];
    const checks = h.platforms.xiaohongshu.callsOf("precheck").length;
    const inspected = await app.inject({ method: "POST", url: "/api/contents/inspect", headers: auth, payload: { url: XHS } });
    expect(inspected.json()).toEqual({ kind: "single", canonicalUrl: XHS, contentId });
    expect(h.platforms.xiaohongshu.callsOf("precheck")).toHaveLength(checks);

    const renewed = await importLink(app, { url: XHS.replace("xxxxtok1", "xxxxtok2") });
    expect(renewed.statusCode).toBe(202);
    expect(renewed.json().sourceUrlUpdates).toEqual([{ contentId, result: "updated" }]);
  });
});
