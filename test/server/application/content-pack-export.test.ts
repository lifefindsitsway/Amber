import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPackFile } from "../../../src/server/adapters/backup/pack-archive.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { CONTENT_PACK_EXPORT_TTL_MS } from "../../../src/shared/defaults.ts";
import type { ContentPackSelection } from "../../../src/shared/dto/content-pack.ts";
import { sampleBuild } from "../../fixtures/content-pack/pack.ts";
import { createEnv, principal, until, type Env } from "../../fixtures/content-pack/services.ts";

const envs: Env[] = [];
afterEach(() => {
  for (const env of envs.splice(0)) env.close();
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
