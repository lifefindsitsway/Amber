import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import { BOB_TOKEN, createLocalContent, createTaskOfKind, LOCAL, LOCAL_TOKEN } from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { countRows } from "../../../tools/sqlite.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

const BODY = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));
const BODY_DIGEST = `sha256:${createHash("sha256").update(BODY).digest("hex")}`;

async function withAsset(kind: MediaAsset["kind"], extra: Partial<MediaAsset> = {}) {
  const s = createMediaStack();
  open.push(s);
  const contentId = createLocalContent(s.h);
  const asset: MediaAsset = {
    id: s.h.newId(), userId: LOCAL.userId, contentId, kind, storageRef: "", mimeType: "video/mp4", sizeBytes: BODY.length,
    availability: "available", retentionPolicy: kind === "managed_upload" ? "keep" : kind === "platform_cache" ? "evictable" : "ephemeral", createdAt: 1, ...extra,
  };
  // A platform cache lies flat in the cache directory under a readable name.
  asset.storageRef ||= kind === "platform_cache" ? `media/课程 ${asset.id}.mp4` : `assets/${LOCAL.userId}/${contentId}/${asset.id}`;
  s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  if (kind !== "external_local") {
    await s.stores.storeFor(kind).writeAtomic(asset.storageRef, BODY);
  }
  return { s, asset, contentId };
}

describe("GET / HEAD /api/media/:assetId [server]", () => {
  it("answers a single range with 206, Content-Range and exactly the requested bytes", async () => {
    const { s, asset } = await withAsset("managed_upload");
    const { app } = await s.app("server");
    const response = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: { ...auth, range: "bytes=0-99" } });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 0-99/${BODY.length}`);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-length"]).toBe("100");
    expect(response.rawPayload).toEqual(BODY.subarray(0, 100));
  });

  it("serves the whole file without a range or with several, and 416 past the end", async () => {
    const { s, asset } = await withAsset("platform_cache");
    const { app } = await s.app("server");
    for (const range of [undefined, "bytes=0-1,5-6", "bytes=nope"]) {
      const response = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: { ...auth, ...(range === undefined ? {} : { range }) } });
      expect(response.statusCode, String(range)).toBe(200);
      expect(response.rawPayload).toEqual(BODY);
    }
    const tail = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: { ...auth, range: "bytes=-10" } });
    expect(tail.rawPayload).toEqual(BODY.subarray(990));
    const beyond = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: { ...auth, range: `bytes=${BODY.length}-` } });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers["content-range"]).toBe(`bytes */${BODY.length}`);
    expect(beyond.headers["content-type"]).toMatch(/application\/json/);
    expect(beyond.json().error).toMatchObject({ class: "invalid_request", code: "invalid_request.range_not_satisfiable" });
  });

  it("answers HEAD with the headers only", async () => {
    const { s, asset } = await withAsset("managed_upload");
    const { app } = await s.app("server");
    const response = await app.inject({ method: "HEAD", url: `/api/media/${asset.id}`, headers: { ...auth, range: "bytes=10-19" } });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-length"]).toBe("10");
    expect(response.rawPayload.length).toBe(0);
  });

  it("serves nothing but available uploads and caches of the caller", async () => {
    const { s, asset, contentId } = await withAsset("managed_upload");
    const { app } = await s.app("server");
    const foreign = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: { authorization: `Bearer ${BOB_TOKEN}` } });
    expect(foreign.statusCode).toBe(404);
    const taskId = createTaskOfKind(s.h, "process_content", { autoProofread: false }, { contentId });
    const audio: MediaAsset = { ...asset, id: s.h.newId(), kind: "extracted_audio", taskId, storageRef: `assets/${LOCAL.userId}/${contentId}/audio`, retentionPolicy: "ephemeral" };
    s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(audio));
    await s.files.writeAtomic(audio.storageRef, BODY);
    expect((await app.inject({ method: "GET", url: `/api/media/${audio.id}`, headers: auth })).statusCode).toBe(404);
    s.h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...asset, availability: "evicted" }));
    expect((await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: auth })).statusCode).toBe(404);
  });

  it("is not registered in local mode", async () => {
    const { s, asset } = await withAsset("managed_upload");
    const { app } = await s.app("local");
    const response = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: auth });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.class).toBe("not_found");
  });
});

describe("DELETE /api/media/:assetId", () => {
  it("evicts a platform cache, keeping its row as evicted, once its file proves to be the registered one", async () => {
    const { s, asset } = await withAsset("platform_cache", { fingerprint: BODY_DIGEST });
    const { app } = await s.app("local");
    expect((await app.inject({ method: "DELETE", url: `/api/media/${asset.id}`, headers: auth })).statusCode).toBe(204);
    expect(s.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, asset.id))?.availability).toBe("evicted");
    expect(await s.stores.cache.stat(asset.storageRef)).toBeNull();
    // Deleting it again touches nothing, not even a newer file under the name.
    await s.stores.cache.writeAtomic(asset.storageRef, Buffer.from("a newer cache"));
    expect((await app.inject({ method: "DELETE", url: `/api/media/${asset.id}`, headers: auth })).statusCode).toBe(204);
    expect(await s.stores.cache.stat(asset.storageRef)).not.toBeNull();
  });

  it("keeps a cache whose file differs from its fingerprint, or that has none, with cache_file_foreign", async () => {
    for (const fingerprint of [undefined, "sha256:0000"]) {
      const { s, asset } = await withAsset("platform_cache", fingerprint === undefined ? {} : { fingerprint });
      const { app } = await s.app("local");
      const refused = await app.inject({ method: "DELETE", url: `/api/media/${asset.id}`, headers: auth });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe("conflict.cache_file_foreign");
      expect(s.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, asset.id))?.availability).toBe("available");
      expect(await s.stores.cache.stat(asset.storageRef)).not.toBeNull();
    }
  });

  it("evicts a cache whose file is already gone, and never removes a file another available row holds", async () => {
    const gone = await withAsset("platform_cache", { fingerprint: BODY_DIGEST });
    await gone.s.stores.cache.remove(gone.asset.storageRef);
    const goneApp = (await gone.s.app("local")).app;
    expect((await goneApp.inject({ method: "DELETE", url: `/api/media/${gone.asset.id}`, headers: auth })).statusCode).toBe(204);

    const { s, asset, contentId } = await withAsset("platform_cache", { fingerprint: BODY_DIGEST });
    const sharer: MediaAsset = { ...asset, id: s.h.newId(), contentId };
    // Two rows at one path cannot happen through Amber; if it ever does, the file stays.
    s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(sharer));
    const { app } = await s.app("local");
    expect((await app.inject({ method: "DELETE", url: `/api/media/${asset.id}`, headers: auth })).statusCode).toBe(204);
    expect(await s.stores.cache.stat(asset.storageRef)).not.toBeNull();
  });

  it("removes a managed upload with its row", async () => {
    const { s, asset } = await withAsset("managed_upload");
    const { app } = await s.app("server");
    expect((await app.inject({ method: "DELETE", url: `/api/media/${asset.id}`, headers: auth })).statusCode).toBe(204);
    expect(countRows(s.h.db, "media_asset")).toBe(0);
    expect(await s.files.stat(asset.storageRef)).toBeNull();
  });

  it("refuses the user's own files, Task intermediates and anything while a Task runs", async () => {
    const local = await withAsset("external_local", { storageRef: "/home/user/video.mp4" });
    const { app } = await local.s.app("local");
    const refused = await app.inject({ method: "DELETE", url: `/api/media/${local.asset.id}`, headers: auth });
    expect(refused.statusCode).toBe(409);

    const upload = await withAsset("managed_upload");
    const taskId = createTaskOfKind(upload.s.h, "process_content", { autoProofread: false }, { contentId: upload.contentId });
    const uploadApp = (await upload.s.app("server")).app;
    const running = await uploadApp.inject({ method: "DELETE", url: `/api/media/${upload.asset.id}`, headers: auth });
    expect(running.statusCode).toBe(409);
    expect(running.json().error.code).toBe("conflict.tasks_unfinished");
    upload.s.h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, "succeeded", 5));
    const audio: MediaAsset = { ...upload.asset, id: upload.s.h.newId(), kind: "extracted_audio", taskId, storageRef: "assets/x/y/z", retentionPolicy: "ephemeral" };
    upload.s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(audio));
    expect((await uploadApp.inject({ method: "DELETE", url: `/api/media/${audio.id}`, headers: auth })).statusCode).toBe(409);
    expect((await uploadApp.inject({ method: "DELETE", url: `/api/media/${upload.asset.id}`, headers: { authorization: `Bearer ${BOB_TOKEN}` } })).statusCode).toBe(404);
  });

  it("lets the client remove a burn product after saving it", async () => {
    const s = createMediaStack();
    open.push(s);
    const contentId = createLocalContent(s.h);
    const taskId = createTaskOfKind(s.h, "burn", {}, { contentId });
    s.h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, "succeeded", 5));
    const product: MediaAsset = {
      id: s.h.newId(), userId: LOCAL.userId, contentId, kind: "temporary", taskId, storageRef: `assets/${LOCAL.userId}/${contentId}/burned`,
      mimeType: "video/mp4", sizeBytes: BODY.length, availability: "available", retentionPolicy: "ephemeral", createdAt: 1,
    };
    s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(product));
    await s.files.writeAtomic(product.storageRef, BODY);
    const { app } = await s.app("local");
    expect((await app.inject({ method: "DELETE", url: `/api/media/${product.id}`, headers: auth })).statusCode).toBe(204);
    expect(await s.files.stat(product.storageRef)).toBeNull();
  });
});
