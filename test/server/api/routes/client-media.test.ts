import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAuthAdapter } from "../../../../src/server/adapters/auth/local/index.ts";
import { HmacFileGrantVerifier, signFileGrant } from "../../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { FlatCacheFileStore } from "../../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { buildApp, type BuiltApp } from "../../../../src/server/app.ts";
import type { ClientMediaTaskService } from "../../../../src/server/application/client-media-tasks.ts";
import { ContentService } from "../../../../src/server/application/contents.ts";
import { LocalImportService } from "../../../../src/server/application/local-import.ts";
import { MediaAssetService } from "../../../../src/server/application/media-assets.ts";
import { CacheRootService } from "../../../../src/server/application/cache-root.ts";
import { CacheHoldService } from "../../../../src/server/application/cache-holds.ts";
import { CacheHoldRegistry } from "../../../../src/server/pipeline/cache-holds.ts";
import { CachePathLocks } from "../../../../src/server/pipeline/cache-path-locks.ts";
import { writeSwapRecord } from "../../../../src/server/pipeline/cache-swap.ts";
import { RelinkService } from "../../../../src/server/application/relink.ts";
import { SplitMediaFiles } from "../../../../src/server/pipeline/media-files.ts";
import { cacheLocationDtoSchema } from "../../../../src/shared/dto/local-media.ts";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import type { LocalMediaIngest, MediaProbe } from "../../../../src/server/ports/local-media-ingest.ts";
import { FILE_GRANT_TTL_MS } from "../../../../src/shared/defaults.ts";
import type { FileGrant } from "../../../../src/shared/dto/local-media.ts";
import { BOB, createHarness, createLocalContent, createTaskOfKind, LOCAL, LOCAL_TOKEN, silentLogger, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const BODY = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251));

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const ingest = {
  async probe(path: string): Promise<MediaProbe> {
    return { durationMs: 30_000, hasAudio: true, mimeType: "video/mp4", fingerprint: sha256(await readFile(path)) };
  },
} as unknown as LocalMediaIngest;

/** Only request validation of cache-media and burn is exercised here; their service must never be reached. */
const unreachableClientMedia = {
  cacheMedia: async () => Promise.reject(new Error("cache-media service reached")),
  inspectCacheMedia: async () => Promise.reject(new Error("cache-media inspect service reached")),
  burn: async () => Promise.reject(new Error("burn service reached")),
} as unknown as ClientMediaTaskService;

interface Stack {
  h: Harness;
  files: LocalFileStore;
  key: Buffer;
  grants: HmacFileGrantVerifier;
  userDir: string;
  grant(path: string, purpose: FileGrant["purpose"]): FileGrant;
  holds: CacheHoldRegistry;
  stores: SplitMediaFiles;
  /** The app per mode; like `compose`, only local mode gives the ContentService a path resolver. */
  app(mode: "local" | "server"): Promise<BuiltApp>;
}

const open: Array<{ h: Harness; apps: BuiltApp[] }> = [];
afterEach(async () => {
  for (const { h, apps } of open.splice(0)) {
    for (const built of apps) await built.app.close();
    await h.close();
  }
});

function stack(): Stack {
  const h = createHarness();
  const apps: BuiltApp[] = [];
  open.push({ h, apps });
  const files = new LocalFileStore(h.dir);
  const stores = new SplitMediaFiles(files, (dir, options) => new FlatCacheFileStore(dir, options), join(h.dir, "media"));
  const key = randomBytes(32);
  const grants = new HmacFileGrantVerifier(key);
  const userDir = join(h.dir, "user files");
  mkdirSync(userDir);
  const repository = h.repository;
  const holds = new CacheHoldRegistry();
  const locks = new CachePathLocks();
  const cacheHolds = new CacheHoldService({ repository, cache: stores.cache, holds, locks, gate: h.gate });
  return {
    h,
    holds,
    stores,
    files,
    key,
    grants,
    userDir,
    grant: (path, purpose) => signFileGrant(key, { path, purpose, expiresAt: Date.now() + FILE_GRANT_TTL_MS }),
    async app(mode) {
      const local = mode === "local";
      const built = await buildApp({
        mode,
        auth: new LocalAuthAdapter(LOCAL_TOKEN),
        bus: h.bus,
        tasks: h.tasks,
        instanceSettings: h.settings,
        contents: new ContentService({ repository, ...(local ? { localPaths: files } : {}) }),
        platformAccounts: h.platformAccounts,
        localImport: new LocalImportService({
          repository,
          bus: h.bus,
          control: { kick: () => undefined },
          files,
          ingest,
          disk: h.disk,
          settings: h.settings,
          grants,
          newId: h.newId,
        }),
        media: new MediaAssetService({ repository, media: stores, gate: h.gate, ...(local ? { grants } : {}) }),
        // Passed in both modes so the mode gate of `buildApp` itself is what is tested.
        clientMedia: unreachableClientMedia,
        relink: new RelinkService({ repository, ingest, grants }),
        cacheRoot: new CacheRootService({
          repository,
          settings: h.settings,
          media: stores,
          gate: h.gate,
          grants,
          dataDir: h.dir,
          storeFactory: (dir, options) => new FlatCacheFileStore(dir, options),
          holds: () => cacheHolds.list(),
          logger: silentLogger,
        }),
        cacheHolds,
        version: "0.0.0-test",
        log: false,
      });
      apps.push(built);
      return built;
    },
  };
}

function insertAsset(s: Stack, contentId: string, asset: Partial<MediaAsset> & Pick<MediaAsset, "kind">): MediaAsset {
  const id = s.h.newId();
  const row: MediaAsset = {
    id,
    userId: LOCAL.userId,
    contentId,
    storageRef: `assets/${LOCAL.userId}/${contentId}/${id}`,
    mimeType: "video/mp4",
    sizeBytes: BODY.length,
    availability: "available",
    retentionPolicy: "ephemeral",
    createdAt: 1,
    ...asset,
  };
  s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(row));
  return row;
}

describe("PUT /api/media/:assetId/relink [client]", () => {
  it("relinks a missing local original and answers its DTO with the new localPath", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const asset = insertAsset(s, contentId, {
      kind: "external_local",
      storageRef: join(s.userDir, "gone.mp4"),
      fingerprint: sha256(BODY),
      availability: "missing",
      retentionPolicy: "never_delete",
    });
    const path = join(s.userDir, "第 1 讲.mp4");
    writeFileSync(path, BODY);
    const { app } = await s.app("local");
    const response = await app.inject({ method: "PUT", url: `/api/media/${asset.id}/relink`, headers: auth, payload: { path, grant: s.grant(path, "relink") } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: asset.id, kind: "external_local", localPath: path, availability: "available", durationMs: 30_000 });
    const detail = await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth });
    expect(detail.json().media).toEqual([expect.objectContaining({ id: asset.id, localPath: path, availability: "available" })]);
  });

  it("answers 401 unauthenticated.file_grant without a valid relink grant, and 400 for a malformed body", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const asset = insertAsset(s, contentId, { kind: "external_local", storageRef: join(s.userDir, "gone.mp4"), availability: "missing", retentionPolicy: "never_delete" });
    const path = join(s.userDir, "found.mp4");
    writeFileSync(path, BODY);
    const { app } = await s.app("local");
    for (const grant of [s.grant(path, "local_file"), signFileGrant(randomBytes(32), { path, purpose: "relink", expiresAt: Date.now() + FILE_GRANT_TTL_MS })]) {
      const response = await app.inject({ method: "PUT", url: `/api/media/${asset.id}/relink`, headers: auth, payload: { path, grant } });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatchObject({ class: "unauthenticated", code: "unauthenticated.file_grant" });
    }
    const missingGrant = await app.inject({ method: "PUT", url: `/api/media/${asset.id}/relink`, headers: auth, payload: { path } });
    expect(missingGrant.statusCode).toBe(400);
    expect(s.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, asset.id))).toEqual(asset);
  });
});

describe("GET /api/media/burn-outputs [client]", () => {
  it("lists only available temporary assets of burn Tasks, oldest first, with the Content title", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    s.h.db.prepare("UPDATE content SET title = ? WHERE id = ?").run("Lecture", contentId);
    const burn = createTaskOfKind(s.h, "burn", { revisionId: "r", mode: "original" }, { contentId });
    const other = createTaskOfKind(s.h, "process_content", { autoProofread: false }, { contentId });
    const untitled = createLocalContent(s.h);
    const burnElsewhere = createTaskOfKind(s.h, "burn", { revisionId: "r", mode: "original" }, { contentId: untitled });
    const newer = insertAsset(s, contentId, { kind: "temporary", taskId: burn, createdAt: 300, sizeBytes: 3, mimeType: "video/x-matroska" });
    const older = insertAsset(s, untitled, { kind: "temporary", taskId: burnElsewhere, createdAt: 100, sizeBytes: 1 });
    insertAsset(s, contentId, { kind: "temporary", taskId: other, createdAt: 50 });
    insertAsset(s, contentId, { kind: "extracted_audio", taskId: burn, createdAt: 60 });
    insertAsset(s, contentId, { kind: "temporary", taskId: burn, createdAt: 70, availability: "missing" });
    insertAsset(s, contentId, { kind: "platform_cache", retentionPolicy: "evictable", createdAt: 80 });
    const { app } = await s.app("local");
    const response = await app.inject({ method: "GET", url: "/api/media/burn-outputs", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { assetId: older.id, contentId: untitled, taskId: burnElsewhere, mimeType: "video/mp4", sizeBytes: 1, createdAt: 100 },
      { assetId: newer.id, contentId, taskId: burn, title: "Lecture", mimeType: "video/x-matroska", sizeBytes: 3, createdAt: 300 },
    ]);
  });
});

describe("POST /api/media/:assetId/save-grant [client]", () => {
  it("signs a burn_output grant for the product's absolute path in the data directory", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const burn = createTaskOfKind(s.h, "burn", { revisionId: "r", mode: "original" }, { contentId });
    const product = insertAsset(s, contentId, { kind: "temporary", taskId: burn });
    const { app } = await s.app("local");
    const before = Date.now();
    const response = await app.inject({ method: "POST", url: `/api/media/${product.id}/save-grant`, headers: auth });
    expect(response.statusCode).toBe(200);
    const { grant } = response.json() as { grant: FileGrant };
    const path = join(s.h.dir, "assets", LOCAL.userId, contentId, product.id);
    expect(grant).toMatchObject({ path, purpose: "burn_output" });
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + FILE_GRANT_TTL_MS);
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + FILE_GRANT_TTL_MS);
    expect(new HmacFileGrantVerifier(s.key).verify(grant, { path, purpose: "burn_output" })).toBe(true);
    expect(new HmacFileGrantVerifier(randomBytes(32)).verify(grant, { path, purpose: "burn_output" })).toBe(false);
  });

  it("signs a cache_save grant for an available media cache's absolute path in the cache directory", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const video = insertAsset(s, contentId, { kind: "platform_cache", storageRef: "media/第 1 讲.mp4", retentionPolicy: "evictable" });
    const audio = insertAsset(s, contentId, { kind: "platform_cache", storageRef: "media/第 1 讲.mp3", mimeType: "audio/mpeg", retentionPolicy: "evictable" });
    const { app } = await s.app("local");
    for (const [asset, name] of [[video, "第 1 讲.mp4"], [audio, "第 1 讲.mp3"]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/media/${asset.id}/save-grant`, headers: auth });
      expect(response.statusCode).toBe(200);
      const { grant } = response.json() as { grant: FileGrant };
      const path = join(s.h.dir, "media", name);
      expect(grant).toMatchObject({ path, purpose: "cache_save" });
      expect(new HmacFileGrantVerifier(s.key).verify(grant, { path, purpose: "cache_save" })).toBe(true);
      expect(new HmacFileGrantVerifier(s.key).verify(grant, { path, purpose: "burn_output" })).toBe(false);
    }
  });

  it("never signs another user's cache or burn product", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h, BOB.userId);
    const burn = createTaskOfKind(s.h, "burn", { revisionId: "r", mode: "original" }, { contentId, userId: BOB.userId });
    const foreign = [
      insertAsset(s, contentId, { userId: BOB.userId, kind: "platform_cache", storageRef: "media/bob.mp4", retentionPolicy: "evictable" }),
      insertAsset(s, contentId, { userId: BOB.userId, kind: "temporary", taskId: burn }),
    ];
    const { app } = await s.app("local");
    for (const asset of foreign) {
      const response = await app.inject({ method: "POST", url: `/api/media/${asset.id}/save-grant`, headers: auth });
      expect(response.statusCode, asset.kind).toBe(404);
    }
  });

  it("answers 409 for anything but an available burn product or media cache and 404 for an unknown asset", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const burn = createTaskOfKind(s.h, "burn", { revisionId: "r", mode: "original" }, { contentId });
    const other = createTaskOfKind(s.h, "process_content", { autoProofread: false }, { contentId });
    const refused = [
      insertAsset(s, contentId, { kind: "temporary", taskId: other }),
      insertAsset(s, contentId, { kind: "temporary", taskId: burn, availability: "evicted" }),
      insertAsset(s, contentId, { kind: "extracted_audio", taskId: burn }),
      insertAsset(s, contentId, { kind: "platform_cache", storageRef: "media/gone.mp4", retentionPolicy: "evictable", availability: "evicted" }),
      insertAsset(s, contentId, { kind: "managed_upload", retentionPolicy: "keep" }),
      insertAsset(s, contentId, { kind: "external_local", storageRef: join(s.userDir, "a.mp4"), retentionPolicy: "never_delete" }),
    ];
    const { app } = await s.app("local");
    for (const asset of refused) {
      const response = await app.inject({ method: "POST", url: `/api/media/${asset.id}/save-grant`, headers: auth });
      expect(response.statusCode, asset.kind).toBe(409);
      expect(response.json().error.class).toBe("conflict");
    }
    const unknown = await app.inject({ method: "POST", url: `/api/media/${s.h.newId()}/save-grant`, headers: auth });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("POST /api/contents/:id/cache-media and /burn [client] request validation", () => {
  it("rejects a quality outside the tiers, a quality for audio, an unknown type, a malformed name and unknown keys with 400", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const { app } = await s.app("local");
    for (const payload of [
      { quality: 240 },
      { quality: "720" },
      { quality: 720, extra: true },
      { type: "audio", quality: 720 },
      { type: "subtitle" },
      { fileName: 42 },
      { fileName: "x".repeat(10_000) },
    ]) {
      const response = await app.inject({ method: "POST", url: `/api/contents/${contentId}/cache-media`, headers: auth, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.class).toBe("invalid_request");
    }
  });

  it("requires translationRevisionId for translation and bilingual burns and refuses it for original ones", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const { app } = await s.app("local");
    for (const payload of [
      { revisionId: "r", translationRevisionId: "t", mode: "original" },
      { revisionId: "r", mode: "bilingual" },
      { revisionId: "r", mode: "translation" },
      { revisionId: "r", mode: "original", outputPath: "/tmp/out.mp4" },
      { mode: "original" },
      // A source pick belongs to the styled export; the legacy burn-in chooses its own source.
      { revisionId: "r", mode: "original", sourceAssetId: "a" },
    ]) {
      const response = await app.inject({ method: "POST", url: `/api/contents/${contentId}/burn`, headers: auth, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.class).toBe("invalid_request");
    }
  });
});

describe("GET / PUT /api/media/cache-location [client]", () => {
  it("answers the location DTO, validates the body, and accepts a no-op move with 202", async () => {
    const s = stack();
    const { app } = await s.app("local");
    const status = await app.inject({ method: "GET", url: "/api/media/cache-location", headers: auth });
    expect(status.statusCode).toBe(200);
    expect(cacheLocationDtoSchema.parse(status.json())).toMatchObject({ path: join(s.h.dir, "media"), isDefault: true, available: true, fileCount: 0, usedBytes: 0 });

    const malformed = await app.inject({ method: "PUT", url: "/api/media/cache-location", headers: auth, payload: { path: "/x" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toMatchObject({ class: "invalid_request" });
    const forged = await app.inject({ method: "PUT", url: "/api/media/cache-location", headers: auth, payload: { path: "/x/media", grant: s.grant("/x/media", "local_file") } });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toMatchObject({ code: "unauthenticated.file_grant" });

    const unchanged = await app.inject({ method: "PUT", url: "/api/media/cache-location", headers: auth, payload: { useDefault: true } });
    expect(unchanged.statusCode).toBe(202);
    expect(cacheLocationDtoSchema.parse(unchanged.json())).toMatchObject({ isDefault: true });
  });
});

describe("interrupted cache replacements [client]", () => {
  it("lists a hold with the cache location and settles it by keeping the current file", async () => {
    const s = stack();
    const { app } = await s.app("local");
    const dir = s.stores.cache.scratchPath("01HELDASSET");
    mkdirSync(dir, { recursive: true });
    const record = { v: 1 as const, targetRef: "media/课 [720P].mp4", newAssetId: "01HELDASSET", newSizeBytes: 3, newDigest: sha256(Buffer.from("new")) };
    await writeSwapRecord(dir, record);
    writeFileSync(join(s.stores.cache.directory(), "课 [720P].mp4"), "a stranger");
    s.holds.add({ scratchId: "01HELDASSET", record, currentSizeBytes: "a stranger".length });

    const status = await app.inject({ method: "GET", url: "/api/media/cache-location", headers: auth });
    expect(cacheLocationDtoSchema.parse(status.json()).holds).toEqual([{ assetId: "01HELDASSET", fileName: "课 [720P].mp4", currentSizeBytes: 10 }]);
    const unknown = await app.inject({ method: "POST", url: "/api/media/cache-location/holds/01NOPE/restore", headers: auth });
    expect(unknown.statusCode).toBe(404);
    // Nothing displaced to restore.
    const restore = await app.inject({ method: "POST", url: "/api/media/cache-location/holds/01HELDASSET/restore", headers: auth });
    expect(restore.statusCode).toBe(409);
    expect(restore.json().error.code).toBe("conflict.cache_file_foreign");
    const keep = await app.inject({ method: "POST", url: "/api/media/cache-location/holds/01HELDASSET/keep", headers: auth });
    expect(keep.statusCode).toBe(204);
    expect(s.holds.list()).toEqual([]);
    expect(cacheLocationDtoSchema.parse((await app.inject({ method: "GET", url: "/api/media/cache-location", headers: auth })).json()).holds).toEqual([]);
  });
});

describe("POST /api/contents/:id/cache-media/inspect [client]", () => {
  it("validates the body before the service is reached", async () => {
    const s = stack();
    const { app } = await s.app("local");
    const contentId = createLocalContent(s.h);
    const refused = await app.inject({ method: "POST", url: `/api/contents/${contentId}/cache-media/inspect`, headers: auth, payload: { type: "audio", quality: 720 } });
    expect(refused.statusCode).toBe(400);
    const unknownField = await app.inject({ method: "POST", url: `/api/contents/${contentId}/cache-media/inspect`, headers: auth, payload: { overwriteAssetId: "x" } });
    expect(unknownField.statusCode).toBe(400);
  });
});

describe("client-only routes in server mode", () => {
  it("does not register the eight client media routes or import-browser", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const { app, routes } = await s.app("server");
    const requests = [
      { method: "POST", url: `/api/contents/${contentId}/cache-media`, payload: {} },
      { method: "POST", url: `/api/contents/${contentId}/burn`, payload: { revisionId: "r", mode: "original" } },
      { method: "PUT", url: `/api/media/${s.h.newId()}/relink`, payload: { path: "/x", grant: s.grant("/x", "relink") } },
      { method: "GET", url: "/api/media/burn-outputs" },
      { method: "POST", url: `/api/media/${s.h.newId()}/save-grant` },
      { method: "GET", url: "/api/media/cache-location" },
      { method: "PUT", url: "/api/media/cache-location", payload: { useDefault: true } },
      { method: "POST", url: `/api/contents/${contentId}/cache-media/inspect`, payload: {} },
      { method: "POST", url: `/api/media/cache-location/holds/${s.h.newId()}/keep` },
      { method: "POST", url: `/api/media/cache-location/holds/${s.h.newId()}/restore` },
      { method: "POST", url: "/api/platform-accounts/youtube/import-browser", payload: {} },
    ] as const;
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: auth });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
    const urls = routes.map((route) => `${route.method} ${route.url}`);
    for (const route of [
      "POST /api/contents/:id/cache-media",
      "POST /api/contents/:id/burn",
      "PUT /api/media/:assetId/relink",
      "GET /api/media/burn-outputs",
      "POST /api/media/:assetId/save-grant",
      "GET /api/media/cache-location",
      "PUT /api/media/cache-location",
      "POST /api/platform-accounts/youtube/import-browser",
    ]) {
      expect(urls).not.toContain(route);
    }
    const local = await s.app("local");
    expect(local.routes.map((route) => `${route.method} ${route.url}`)).toEqual(
      expect.arrayContaining(["GET /api/media/burn-outputs", "GET /api/media/cache-location", "PUT /api/media/cache-location", "POST /api/platform-accounts/youtube/import-browser"]),
    );
  });
});

describe("localPath in GET /api/contents/:id", () => {
  async function importLocal(s: Stack, app: BuiltApp["app"]): Promise<{ contentId: string; path: string }> {
    const path = join(s.userDir, "lecture 1.mp4");
    writeFileSync(path, BODY);
    const response = await app.inject({ method: "POST", url: "/api/contents/local-file", headers: auth, payload: { path, grant: s.grant(path, "local_file") } });
    expect(response.statusCode).toBe(202);
    return { contentId: (response.json() as { contentIds: string[] }).contentIds[0] as string, path };
  }

  it("local mode: an available local original carries its imported path and a cache its absolute file path", async () => {
    const s = stack();
    const { app } = await s.app("local");
    const { contentId, path } = await importLocal(s, app);
    const cache = insertAsset(s, contentId, { kind: "platform_cache", retentionPolicy: "evictable" });
    const audio = insertAsset(s, contentId, { kind: "extracted_audio", taskId: createTaskOfKind(s.h, "process_content", { autoProofread: false }, { contentId }) });
    const evicted = insertAsset(s, contentId, { kind: "platform_cache", retentionPolicy: "evictable", availability: "evicted" });
    const media = (await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth })).json().media as Array<Record<string, unknown>>;
    const byId = new Map(media.map((item) => [item["id"], item]));
    const original = media.find((item) => item["kind"] === "external_local");
    expect(original?.["localPath"]).toBe(path);
    expect(byId.get(cache.id)?.["localPath"]).toBe(join(s.h.dir, "assets", LOCAL.userId, contentId, cache.id));
    expect(byId.get(audio.id)).not.toHaveProperty("localPath");
    expect(byId.get(evicted.id)).not.toHaveProperty("localPath");
  });

  it("local mode: a missing original has no localPath", async () => {
    const s = stack();
    const { app } = await s.app("local");
    const { contentId } = await importLocal(s, app);
    s.h.db.prepare("UPDATE media_asset SET availability = 'missing' WHERE content_id = ?").run(contentId);
    const media = (await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth })).json().media as Array<Record<string, unknown>>;
    expect(media).toHaveLength(1);
    expect(media[0]).not.toHaveProperty("localPath");
  });

  it("server mode: no media item ever has the localPath key", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    insertAsset(s, contentId, { kind: "managed_upload", retentionPolicy: "keep" });
    insertAsset(s, contentId, { kind: "platform_cache", retentionPolicy: "evictable" });
    insertAsset(s, contentId, { kind: "external_local", storageRef: join(s.userDir, "a.mp4"), retentionPolicy: "never_delete" });
    const { app } = await s.app("server");
    const response = await app.inject({ method: "GET", url: `/api/contents/${contentId}`, headers: auth });
    expect(response.statusCode).toBe(200);
    const media = response.json().media as Array<Record<string, unknown>>;
    expect(media).toHaveLength(3);
    for (const item of media) {
      expect(item).not.toHaveProperty("localPath");
    }
    expect(response.body).not.toContain(s.userDir);
    expect(response.body).not.toContain(s.h.dir);
  });
});
