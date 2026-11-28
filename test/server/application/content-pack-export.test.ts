import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPackFile } from "../../../src/server/adapters/backup/pack-archive.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { CONTENT_PACK_EXPORT_TTL_MS } from "../../../src/shared/defaults.ts";
import type { ContentPackSelection } from "../../../src/shared/dto/content-pack.ts";
import { CONTENT_PACK_BASE_FORMAT_VERSION, CONTENT_PACK_COVER_FORMAT_VERSION } from "../../../src/server/domain/content-pack/document.ts";
import { addPlatformContent, bareSelection, openLibrary, putCover, type Library } from "../../fixtures/content-pack/library.ts";
import { COVER_HEIGHT, COVER_WEBP, COVER_WIDTH, sampleBuild, sha256 } from "../../fixtures/content-pack/pack.ts";
import { createEnv, principal, until, type Env } from "../../fixtures/content-pack/services.ts";

const envs: Env[] = [];
const libraries: Library[] = [];
afterEach(() => {
  for (const env of envs.splice(0)) env.close();
  for (const library of libraries.splice(0)) library.close();
});
function setup(): Env {
  const env = createEnv();
  envs.push(env);
  return env;
}

const alice = principal("alice");
const selection: ContentPackSelection = { contents: [{ contentId: "content-1", revisionIds: [], figures: true, notes: false, mediaAssetIds: ["asset-1"] }], collectionIds: [] };

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  return undefined;
}

describe("ContentPackExportService", () => {
  it("local mode: writes the pack to the granted file, readable as a pack, no partial left", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside, { count: 2 }).build;
    const service = env.exports();
    const target = join(env.outside, "我的内容包.amberpack");
    const { jobId } = await service.start(alice, { selection, grant: env.grant(target, "pack_output") });
    expect(service.active(alice)).toBe(jobId);
    await until(() => service.get(alice, jobId).status !== "running");
    const job = service.get(alice, jobId);
    expect(job).toMatchObject({ status: "succeeded", phase: "finalize", result: { fileName: "我的内容包.amberpack", contents: 2 } });
    expect(job.bytesDone).toBe(job.bytesTotal);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect((await openPackFile(target).readDocuments(new AbortController().signal)).contents).toHaveLength(2);
    expect(service.active(alice)).toBeUndefined();
    expect(env.gate.sharedHeld()).toBe(0);
  });

  it("counts as covers left out only platform Contents with a cover address and no cover copy in the pack", async () => {
    const env = setup();
    const { build } = sampleBuild(env.outside, { count: 4, cover: (index) => index === 3 });
    const platform = (index: number) => ({ kind: "bilibili" as const, platformContentId: `BV1Lef${index}41c7m`, sourceUrl: `https://www.bilibili.com/video/BV1Lef${index}41c7m` });
    const [local, noAddress, covered, leftOut] = build.contents;
    if (local === undefined || noAddress === undefined || covered === undefined || leftOut === undefined) throw new Error("expected four contents");
    // A local file, even with an address on it, never had a platform cover to show.
    local.document = { ...local.document, coverUrl: "https://i0.hdslb.com/bfs/archive/local.jpg" };
    noAddress.document = { ...noAddress.document, source: platform(2) };
    covered.document = { ...covered.document, coverUrl: "https://i0.hdslb.com/bfs/archive/covered.jpg" };
    leftOut.document = { ...leftOut.document, source: platform(4), coverUrl: "https://i0.hdslb.com/bfs/archive/left-out.jpg" };
    env.engine.script.build = build;
    const service = env.exports();
    const target = join(env.outside, "covers.amberpack");
    const { jobId } = await service.start(alice, { selection, grant: env.grant(target, "pack_output") });
    await until(() => service.get(alice, jobId).status !== "running");
    expect(service.get(alice, jobId)).toMatchObject({ status: "succeeded", result: { contents: 4, coversLeftOut: 1 } });
  });

  it("refuses a missing or foreign grant, and a destination with the wrong extension", async () => {
    const env = setup();
    const service = env.exports();
    expect(await codeOf(() => service.start(alice, { selection }))).toBe("unauthenticated.file_grant");
    expect(await codeOf(() => service.start(alice, { selection, grant: env.grant(join(env.outside, "a.amberpack"), "pack_input") }))).toBe("unauthenticated.file_grant");
    expect(await codeOf(() => service.start(alice, { selection, grant: env.grant(join(env.outside, "a.zip"), "pack_output") }))).toBe("invalid_request");
  });

  it("allows one job per user, export and import alike; other users go on", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside).build;
    let release!: () => void;
    env.engine.script.beforeBuild = () => new Promise<void>((resolve) => (release = resolve));
    const service = env.exports();
    const imports = env.imports();
    const { jobId } = await service.start(alice, { selection, grant: env.grant(join(env.outside, "a.amberpack"), "pack_output") });
    await until(() => release !== undefined);
    expect(await codeOf(() => service.start(alice, { selection, grant: env.grant(join(env.outside, "b.amberpack"), "pack_output") }))).toBe("conflict.pack_job_active");
    const pack = join(env.outside, "in.amberpack");
    writeFileSync(pack, "x");
    expect(await codeOf(() => imports.startFromFile(alice, { grant: env.grant(pack, "pack_input") }))).toBe("conflict.pack_job_active");
    delete env.engine.script.beforeBuild;
    const bob = principal("bob");
    expect(await codeOf(() => service.start(bob, { selection, grant: env.grant(join(env.outside, "c.amberpack"), "pack_output") }))).toBeUndefined();
    release();
    await until(() => service.get(alice, jobId).status !== "running");
    // Bob's job never sees Alice's and the other way round.
    expect(await codeOf(() => service.get(bob, jobId))).toBe("not_found");
    expect(await codeOf(() => service.cancel(bob, jobId))).toBe("not_found");
  });

  it("cancels a running job: no pack and no partial at the destination, lease and slot released", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside, { mediaBytes: 8 * 1024 * 1024 }).build;
    let entered = false;
    let release!: () => void;
    env.engine.script.beforeBuild = () => {
      entered = true;
      return new Promise<void>((resolve) => (release = resolve));
    };
    const service = env.exports();
    const target = join(env.outside, "a.amberpack");
    const { jobId } = await service.start(alice, { selection, grant: env.grant(target, "pack_output") });
    await until(() => entered);
    const cancelling = service.cancel(alice, jobId);
    release();
    expect((await cancelling).status).toBe("cancelled");
    expect(existsSync(target) || existsSync(`${target}.partial`)).toBe(false);
    expect(env.gate.sharedHeld()).toBe(0);
    expect(env.slots.holder("alice")).toBeUndefined();
  });

  it("refuses to start while the cache gate is held exclusively (backup, cache move, update)", async () => {
    const env = setup();
    const service = env.exports();
    const release = env.gate.tryExclusive("backup_export");
    expect(await codeOf(() => service.start(alice, { selection, grant: env.grant(join(env.outside, "a.amberpack"), "pack_output") }))).toBe("conflict.backup_in_progress");
    release?.();
    expect(env.slots.holder("alice")).toBeUndefined();
  });

  it("fails with disk_low when the destination lacks the space, leaving nothing", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside).build;
    env.freeBytes.value = 100;
    const service = env.exports();
    const target = join(env.outside, "a.amberpack");
    const { jobId } = await service.start(alice, { selection, grant: env.grant(target, "pack_output") });
    await until(() => service.get(alice, jobId).status !== "running");
    expect(service.get(alice, jobId)).toMatchObject({ status: "failed", error: { code: "disk_low" } });
    expect(existsSync(target) || existsSync(`${target}.partial`)).toBe(false);
  });

  it("server mode: a plain download; an interrupted one keeps the file, a complete one removes it", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside).build;
    const service = env.exports("server");
    const bob = principal("bob", "server");
    const { jobId } = await service.start(principal("alice", "server"), { selection });
    const owner = principal("alice", "server");
    await until(() => service.get(owner, jobId).status !== "running");
    const job = service.get(owner, jobId);
    expect(job.result).toMatchObject({ fileName: "内容 1.amberpack", downloadPath: `/api/content-packs/exports/${jobId}/file`, expiresAt: env.clock.now + CONTENT_PACK_EXPORT_TTL_MS });
    expect(await codeOf(() => service.download(bob, jobId))).toBe("not_found");
    const first = service.download(owner, jobId);
    expect(first.path.startsWith(env.workDir)).toBe(true);
    first.onSent(false);
    expect(existsSync(first.path)).toBe(true);
    const second = service.download(owner, jobId);
    second.onSent(true);
    await until(() => !existsSync(second.path));
    expect(service.get(owner, jobId).result?.downloadPath).toBeUndefined();
    expect(await codeOf(() => service.download(owner, jobId))).toBe("not_found");
  });

  it("server mode: an undownloaded pack is removed once it expires", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside).build;
    const service = env.exports("server");
    const owner = principal("alice", "server");
    const { jobId } = await service.start(owner, { selection });
    await until(() => service.get(owner, jobId).status !== "running");
    const { path } = service.download(owner, jobId);
    env.clock.now += CONTENT_PACK_EXPORT_TTL_MS;
    expect(service.get(owner, jobId).result?.expiresAt).toBeUndefined();
    await until(() => !existsSync(path));
    expect(await codeOf(() => service.download(owner, jobId))).toBe("not_found");
  });

  it("copies a cache file under its path lock and fails the Content when it was replaced meanwhile (T10)", async () => {
    const env = setup();
    const sample = sampleBuild(env.outside, { count: 2 });
    // The second Content's media is a platform cache in the cache directory.
    mkdirSync(env.media.cache.directory(), { recursive: true });
    const cacheRef = "media/片 [720P].mp4";
    const cachePath = env.media.cache.pathOf(cacheRef);
    const original = randomBytes(sample.media[1]?.sizeBytes ?? 0);
    writeFileSync(cachePath, original);
    const content = sample.build.contents[1] as (typeof sample.build.contents)[0];
    content.media[0] = { ...(content.media[0] as (typeof content.media)[0]), kind: "cache", location: { storageRef: cacheRef } };
    env.engine.script.build = sample.build;
    let hashed = false;
    let proceed!: () => void;
    const proceeding = new Promise<void>((resolve) => (proceed = resolve));
    env.engine.script.beforeBuild = async () => {
      hashed = true;
      await proceeding;
    };
    // Another task holds the cache path: the export must wait for it, then see the new file.
    let releaseLock!: () => void;
    let lockHeld = false;
    const service = env.exports();
    const target = join(env.outside, "a.amberpack");
    const { jobId } = await service.start(alice, { selection, grant: env.grant(target, "pack_output") });
    await until(() => hashed);
    void env.locks.withLock(cacheRef, async () => {
      lockHeld = true;
      await new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await until(() => lockHeld);
    proceed();
    // The copy reaches the cache file and waits for the lock while the other task replaces it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.get(alice, jobId).status).toBe("running");
    writeFileSync(cachePath, randomBytes(original.length));
    releaseLock();
    await until(() => service.get(alice, jobId).status !== "running");
    expect(service.get(alice, jobId)).toMatchObject({ status: "failed", error: { code: "media_changed" }, failedContent: { contentId: "content-2", title: "内容 2" } });
    expect(existsSync(target) || existsSync(`${target}.partial`)).toBe(false);
  });

  it("start-up sweep removes a crashed job's partial pack and the server-mode packs", async () => {
    const env = setup();
    const target = join(env.outside, "crash.amberpack");
    mkdirSync(join(env.workDir, "exports", "job-x"), { recursive: true });
    writeFileSync(join(env.workDir, "exports", "job-x", "pack.amberpack"), "x");
    writeFileSync(join(env.workDir, "exports", "job-y.json"), JSON.stringify({ jobId: "job-y", target, startedAt: Date.now() - 1000 }));
    writeFileSync(`${target}.partial`, "partial");
    writeFileSync(join(env.outside, "other.amberpack.partial"), "not ours");
    await env.exports().sweepLeftovers();
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(existsSync(join(env.outside, "other.amberpack.partial"))).toBe(true);
    expect(existsSync(join(env.workDir, "exports"))).toBe(false);
  });
  it("refuses to start before the start-up recovery finished (conflict.starting_up)", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside).build;
    let ready = false;
    const service = env.exports("local", { backgroundReady: () => ready });
    const target = join(env.outside, "a.amberpack");
    expect(await codeOf(() => service.start(alice, { selection, grant: env.grant(target, "pack_output") }))).toBe("conflict.starting_up");
    expect(env.slots.holder("alice")).toBeUndefined();
    expect(env.gate.sharedHeld()).toBe(0);
    ready = true;
    expect(await codeOf(() => service.start(alice, { selection, grant: env.grant(target, "pack_output") }))).toBeUndefined();
  });

  it("server mode: a user at the storage limit is refused at the start; a pack too large for the rest fails the job", async () => {
    const env = setup();
    env.engine.script.build = sampleBuild(env.outside, { mediaBytes: 64 * 1024 }).build;
    const owner = principal("alice", "server");
    const full = env.exports("server", { quota: { usage: async () => ({ usedBytes: 1024 ** 3, storageLimitGB: 1 }) } });
    expect(await codeOf(() => full.start(owner, { selection }))).toBe("storage_quota_exceeded");
    expect(env.slots.holder("alice")).toBeUndefined();
    const nearlyFull = env.exports("server", { quota: { usage: async () => ({ usedBytes: 1024 ** 3 - 1024, storageLimitGB: 1 }) } });
    const { jobId } = await nearlyFull.start(owner, { selection });
    await until(() => nearlyFull.get(owner, jobId).status !== "running");
    expect(nearlyFull.get(owner, jobId)).toMatchObject({ status: "failed", error: { code: "storage_quota_exceeded" } });
    expect(existsSync(join(env.workDir, "exports", jobId))).toBe(false);
  });
});

describe("ContentPackExportService over a library: cover copies", () => {
  const never = new AbortController().signal;
  const bilibili = (id: string) => ({ kind: "bilibili" as const, platformContentId: id, sourceUrl: `https://www.bilibili.com/video/${id}` });

  /** Exports `contentIds` of Alice's library to a pack file; returns the finished job and the pack. */
  async function exportFrom(library: Library, contentIds: readonly string[]) {
    const env = setup();
    const service = env.exports("local", { repository: library.repository, engine: library.engine });
    const target = join(env.outside, "covers.amberpack");
    const { jobId } = await service.start(alice, { selection: bareSelection(contentIds), grant: env.grant(target, "pack_output") });
    await until(() => service.get(alice, jobId).status !== "running");
    const job = service.get(alice, jobId);
    expect(job.status).toBe("succeeded");
    return { job, pack: openPackFile(target) };
  }

  function library(): Library {
    const opened = openLibrary();
    libraries.push(opened);
    return opened;
  }

  it("writes a local cover beside its document with matching fields, keeps the cover URL, and marks the pack version 2", async () => {
    const lib = library();
    const covered = addPlatformContent(lib, "alice", bilibili("BV1Cov41c7mA"), { coverUrl: "https://i0.hdslb.com/bfs/archive/cover-a.jpg" });
    const bare = addPlatformContent(lib, "alice", bilibili("BV1Bar41c7mB"), { coverUrl: "https://i0.hdslb.com/bfs/archive/cover-b.jpg" });
    putCover(lib, "alice", covered, COVER_WEBP);

    const { job, pack } = await exportFrom(lib, [covered, bare]);
    const documents = await pack.readDocuments(never);
    expect(documents.header.formatVersion).toBe(CONTENT_PACK_COVER_FORMAT_VERSION);
    const [first, second] = documents.contents;
    expect(first?.document.cover).toEqual({ entry: "contents/0/cover.webp", width: COVER_WIDTH, height: COVER_HEIGHT, bytes: COVER_WEBP.length, sha256: sha256(COVER_WEBP) });
    expect(first?.document.coverUrl).toBe("https://i0.hdslb.com/bfs/archive/cover-a.jpg");
    expect(second?.document.cover).toBeUndefined();
    expect(second?.document.coverUrl).toBe("https://i0.hdslb.com/bfs/archive/cover-b.jpg");
    expect(documents.header.entries.map((entry) => entry.name).filter((name) => name.endsWith("/cover.webp"))).toEqual(["contents/0/cover.webp"]);
    const read = await pack.readAll(documents.digests, new Map(), () => undefined, never, { keepImages: new Set(["contents/0/cover.webp"]) });
    expect(Buffer.from(read.images.get("contents/0/cover.webp") ?? [])).toEqual(Buffer.from(COVER_WEBP));
    // Only the platform Content without a local copy travels with its cover URL alone.
    expect(job.result?.coversLeftOut).toBe(1);
  });

  it("writes version 1 with no cover field or entry when no chosen Content has a local cover", async () => {
    const lib = library();
    const first = addPlatformContent(lib, "alice", bilibili("BV1One41c7mC"), { coverUrl: "https://i0.hdslb.com/bfs/archive/cover-c.jpg" });
    const second = addPlatformContent(lib, "alice", bilibili("BV1Two41c7mD"));
    // Another Content's cover never makes this pack carry one.
    const other = addPlatformContent(lib, "alice", bilibili("BV1Oth41c7mE"));
    putCover(lib, "alice", other, COVER_WEBP);

    const { job, pack } = await exportFrom(lib, [first, second]);
    const documents = await pack.readDocuments(never);
    expect(documents.header.formatVersion).toBe(CONTENT_PACK_BASE_FORMAT_VERSION);
    expect(documents.contents.map((content) => "cover" in content.document)).toEqual([false, false]);
    expect(documents.header.entries.some((entry) => entry.name.endsWith("/cover.webp"))).toBe(false);
    // The second has no cover address, so it has no cover to lose and is not counted.
    expect(job.result?.coversLeftOut).toBe(1);
  });
});
