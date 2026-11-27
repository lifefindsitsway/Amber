import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPackFile } from "../../../src/server/adapters/backup/pack-archive.ts";
import type { ContentPackImportService } from "../../../src/server/application/content-pack-import.ts";
import type { ContentPackSource } from "../../../src/server/ports/content-pack.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { IMPORTED_ORIGINALS_DIR_PREFIX } from "../../../src/shared/backup-names.ts";
import { CONTENT_PACK_PREVIEW_TTL_MS } from "../../../src/shared/defaults.ts";
import type { ContentPackImportDecisions } from "../../../src/shared/dto/content-pack.ts";
import { CONTENT_PACK_BASE_FORMAT_VERSION, CONTENT_PACK_COVER_FORMAT_VERSION, CONTENT_PACK_FORMAT_VERSION } from "../../../src/server/domain/content-pack/document.ts";
import type { PackExportBuild } from "../../../src/server/application/content-pack-engine.ts";
import type { ContentSource } from "../../../src/server/domain/content.ts";
import type { PackContentDecision, PackPreviewContent } from "../../../src/shared/dto/content-pack.ts";
import { addPlatformContent, bareSelection, NO_HOOKS, openLibrary, putCover, type Library } from "../../fixtures/content-pack/library.ts";
import { AVATAR_WEBP, COVER_WEBP, rawEntriesOf, rawTar, sampleBuild, sha256, writeSamplePack, type SampleMedia } from "../../fixtures/content-pack/pack.ts";
import { countRows } from "../../tools/sqlite.ts";
import { createEnv, principal, until, type Env, type EngineScript } from "../../fixtures/content-pack/services.ts";

const envs: Env[] = [];
const libraries: Library[] = [];
afterEach(() => {
  for (const env of envs.splice(0)) env.close();
  for (const library of libraries.splice(0)) library.close();
});

const alice = principal("alice");
const serverAlice = principal("alice", "server");

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  return undefined;
}

interface Setup {
  env: Env;
  pack: string;
  media: SampleMedia[];
}

async function setup(
  script: EngineScript = {},
  count = 1,
  options: Parameters<typeof sampleBuild>[1] = {},
  mutate?: (sample: ReturnType<typeof sampleBuild>, sources: string) => void,
): Promise<Setup> {
  const env = createEnv(script);
  envs.push(env);
  const sources = join(env.root, "sources");
  mkdirSync(sources);
  const sample = sampleBuild(sources, { count, ...options });
  mutate?.(sample, sources);
  const pack = join(env.outside, "in.amberpack");
  await writeSamplePack(pack, sample.build);
  return { env, pack, media: sample.media };
}

function decisions(keys: readonly string[], extra: Partial<ContentPackImportDecisions> = {}): ContentPackImportDecisions {
  return {
    contents: keys.map((key) => ({ key, action: "import" as const, revisions: true, figures: true, notes: false, mediaKeys: [`${key}-media`] })),
    collections: [],
    ...extra,
  };
}

async function previewed(service: ContentPackImportService, env: Env, pack: string): Promise<string> {
  const { jobId } = await service.startFromFile(alice, { grant: env.grant(pack, "pack_input") });
  await until(() => service.get(alice, jobId).status !== "previewing");
  expect(service.get(alice, jobId).status).toBe("awaiting_decisions");
  return jobId;
}

async function settled(service: ContentPackImportService, jobId: string, who = alice): Promise<ReturnType<ContentPackImportService["get"]>> {
  await until(() => service.get(who, jobId).status !== "importing");
  return service.get(who, jobId);
}

function originalsGrant(env: Env, name = `${IMPORTED_ORIGINALS_DIR_PREFIX}20261118-120000`) {
  return { path: join(env.outside, name), grant: env.grant(join(env.outside, name), "pack_originals_dir") };
}

describe("ContentPackImportService", () => {
  it("local mode: previews, then places originals in the new directory and commits each Content", async () => {
    const { env, pack, media } = await setup({}, 2);
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const preview = service.get(alice, jobId).preview;
    expect(preview?.contents.map((content) => content.key)).toEqual(["origin-1", "origin-2"]);
    expect(preview?.pack.mediaBytes).toBe(media.reduce((sum, item) => sum + item.sizeBytes, 0));
    expect(service.active(alice)).toBe(jobId);
    const dir = originalsGrant(env);
    const started = await service.commit(alice, jobId, decisions(["origin-1", "origin-2"], { originalsDir: dir.grant }));
    expect(started.status).toBe("importing");
    const job = await settled(service, jobId);
    expect(job.status).toBe("finished");
    expect(job.result?.contents.map((content) => content.status)).toEqual(["imported", "imported"]);
    expect(readdirSync(dir.path).sort()).toEqual(["原片 1.mp4", "原片 2.mp4"]);
    const placed = env.engine.commits[0]?.media.get("media/1/1.mp4");
    expect(placed).toEqual({ location: { path: join(dir.path, "原片 1.mp4") }, sizeBytes: media[0]?.sizeBytes, sha256: media[0]?.sha256 });
    expect(readFileSync(join(dir.path, "原片 1.mp4"))).toEqual(readFileSync(media[0]?.path ?? ""));
    // Each commit gets its own Content's images, read back from the job directory, nothing else.
    expect(env.engine.commits.map((commit) => commit.imageEntries)).toEqual([
      ["contents/1/avatars/1.webp", "contents/1/figures/1.webp"],
      ["contents/2/avatars/1.webp", "contents/2/figures/1.webp"],
    ]);
    expect(existsSync(join(env.workDir, "journal", `${jobId}.json`))).toBe(false);
    expect(service.active(alice)).toBeUndefined();
    expect(env.gate.sharedHeld()).toBe(0);
  });

  it("refuses an originals directory that exists and is not empty, or is not named for an import", async () => {
    const { env, pack } = await setup();
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const dir = originalsGrant(env);
    mkdirSync(dir.path);
    writeFileSync(join(dir.path, "mine.txt"), "x");
    expect(await codeOf(() => service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: dir.grant })))).toBe("invalid_request");
    const wrong = join(env.outside, "Videos");
    expect(await codeOf(() => service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: env.grant(wrong, "pack_originals_dir") })))).toBe("invalid_request");
    expect(await codeOf(() => service.commit(alice, jobId, decisions(["origin-1"])))).toBe("invalid_request");
    expect(service.get(alice, jobId).status).toBe("awaiting_decisions");
    expect(readFileSync(join(dir.path, "mine.txt"), "utf8")).toBe("x");
  });

  it("server mode: streams the upload, previews it, and places originals in managed storage", async () => {
    const { env, pack, media } = await setup({ targetKind: "managed_upload" });
    const service = env.imports("server");
    const bytes = readFileSync(pack);
    async function* body(): AsyncIterable<Uint8Array> {
      for (let at = 0; at < bytes.length; at += 1000) yield bytes.subarray(at, at + 1000);
    }
    const { jobId } = await service.startFromUpload(serverAlice, "包.amberpack", body(), new AbortController().signal);
    await until(() => service.get(serverAlice, jobId).status !== "previewing");
    expect(service.get(serverAlice, jobId)).toMatchObject({ status: "awaiting_decisions", fileName: "包.amberpack", bytesTotal: bytes.length });
    await service.commit(serverAlice, jobId, decisions(["origin-1"]));
    const job = await settled(service, jobId, serverAlice);
    expect(job.status).toBe("finished");
    const ref = "assets/alice/alice-origin-1/assetorigin1";
    expect(env.engine.commits[0]?.media.get("media/1/1.mp4")?.location).toEqual({ storageRef: ref });
    expect(sha256(readFileSync(env.files.pathOf(ref)))).toBe(media[0]?.sha256);
    // The upload is gone once the import is done.
    expect(existsSync(join(env.workDir, "imports", jobId))).toBe(false);
  });

  it("server mode: an interrupted upload leaves nothing and frees the slot", async () => {
    const { env } = await setup();
    const service = env.imports("server");
    async function* broken(): AsyncIterable<Uint8Array> {
      yield randomBytes(4096);
      throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    }
    await expect(service.startFromUpload(serverAlice, undefined, broken(), new AbortController().signal)).rejects.toThrow();
    expect(readdirSync(join(env.workDir, "imports"))).toEqual([]);
    expect(env.slots.holder("alice")).toBeUndefined();
    // A client that hangs up mid-way: cancelled the same way.
    const controller = new AbortController();
    async function* hanging(): AsyncIterable<Uint8Array> {
      yield randomBytes(4096);
      controller.abort();
      yield randomBytes(4096);
    }
    await expect(service.startFromUpload(serverAlice, undefined, hanging(), controller.signal)).rejects.toThrow();
    expect(readdirSync(join(env.workDir, "imports"))).toEqual([]);
    expect(env.slots.holder("alice")).toBeUndefined();
  });

  it("server mode: an upload stops at the disk watermark and is not accepted below it", async () => {
    const { env, pack } = await setup();
    const service = env.imports("server");
    env.disk.usedBytes = 2000 * 1024 ** 3;
    const bytes = readFileSync(pack);
    async function* body(): AsyncIterable<Uint8Array> {
      yield bytes;
    }
    expect(await codeOf(() => service.startFromUpload(serverAlice, undefined, body(), new AbortController().signal))).toBe("disk_low");
    expect(env.slots.holder("alice")).toBeUndefined();
  });

  it("a preview nobody decides on expires: cancelled, upload removed, slot free", async () => {
    const { env, pack } = await setup();
    const service = env.imports("server");
    const { jobId } = await service.startFromUpload(serverAlice, undefined, (async function* () {
      yield readFileSync(pack);
    })(), new AbortController().signal);
    await until(() => service.get(serverAlice, jobId).status !== "previewing");
    expect(existsSync(join(env.workDir, "imports", jobId))).toBe(true);
    env.clock.now += CONTENT_PACK_PREVIEW_TTL_MS;
    expect(service.get(serverAlice, jobId).status).toBe("cancelled");
    await until(() => !existsSync(join(env.workDir, "imports", jobId)));
    expect(env.slots.holder("alice")).toBeUndefined();
    expect(await codeOf(() => service.commit(serverAlice, jobId, decisions(["origin-1"])))).toBe("conflict.pack_job_state");
  });

  it("refuses a pack replaced after its preview, before anything is written (T50)", async () => {
    const { env, pack } = await setup();
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const other = sampleBuild(join(env.root, "sources"), { count: 1 });
    rmSync(pack);
    await writeSamplePack(pack, other.build);
    const dir = originalsGrant(env);
    await service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: dir.grant }));
    const job = await settled(service, jobId);
    expect(job).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_changed" } });
    expect(env.engine.commits).toEqual([]);
    expect(existsSync(dir.path)).toBe(false);
    expect(readdirSync(join(env.workDir, "journal"))).toEqual([]);
  });

  it("second Content fails: the first stays, the second's file is taken away, a new import adds only the second (T06)", async () => {
    const { env, pack } = await setup({ failCommit: new Set(["origin-2"]) }, 2);
    const service = env.imports();
    const first = await previewed(service, env, pack);
    const dir = originalsGrant(env);
    await service.commit(alice, first, decisions(["origin-1", "origin-2"], { originalsDir: dir.grant }));
    const job = await settled(service, first);
    expect(job.status).toBe("finished");
    expect(job.result?.contents.map((content) => [content.key, content.status])).toEqual([
      ["origin-1", "imported"],
      ["origin-2", "failed"],
    ]);
    expect(readdirSync(dir.path)).toEqual(["原片 1.mp4"]);

    env.engine.script.failCommit = new Set();
    const second = await previewed(service, env, pack);
    const dir2 = originalsGrant(env, `${IMPORTED_ORIGINALS_DIR_PREFIX}20261118-130000`);
    await service.commit(alice, second, decisions(["origin-1", "origin-2"], { originalsDir: dir2.grant }));
    const again = await settled(service, second);
    expect(again.result?.contents.map((content) => [content.key, content.status])).toEqual([
      ["origin-1", "skipped"],
      ["origin-2", "imported"],
    ]);
    expect(env.engine.commits.map((commit) => commit.key)).toEqual(["origin-1", "origin-2", "origin-2"]);
    expect(readdirSync(dir2.path)).toEqual(["原片 2.mp4"]);
  });

  it("never overwrites a cache: a name held by another Content or a stranger file fails that Content only (T08)", async () => {
    const cacheName = (index: number): string => `片${index} [720P].mp4`;
    const { env, pack } = await setup({ targetKind: "platform_cache" }, 3, { cacheFileName: cacheName });
    const cacheDir = env.media.cache.directory();
    mkdirSync(cacheDir, { recursive: true });
    // Content 1's name: another Content's available cache with different bytes.
    const held = randomBytes(100);
    writeFileSync(join(cacheDir, cacheName(1)), held);
    env.rows.assets.push({
      id: "other",
      userId: "alice",
      contentId: "other-content",
      kind: "platform_cache",
      storageRef: `media/${cacheName(1)}`,
      mimeType: "video/mp4",
      sizeBytes: 100,
      fingerprint: `sha256:${sha256(held)}`,
      availability: "available",
      retentionPolicy: "evictable",
      createdAt: 1,
    } as MediaAsset);
    // Content 2's name: a file nobody registered.
    writeFileSync(join(cacheDir, cacheName(2)), "stranger");
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    await service.commit(alice, jobId, decisions(["origin-1", "origin-2", "origin-3"]));
    const job = await settled(service, jobId);
    expect(job.result?.contents.map((content) => [content.key, content.status, content.error?.code])).toEqual([
      ["origin-1", "failed", "conflict.cache_name_taken"],
      ["origin-2", "failed", "conflict.cache_file_foreign"],
      ["origin-3", "imported", undefined],
    ]);
    expect(readFileSync(join(cacheDir, cacheName(1)))).toEqual(held);
    expect(readFileSync(join(cacheDir, cacheName(2)), "utf8")).toBe("stranger");
    expect(env.engine.commits.map((commit) => commit.key)).toEqual(["origin-3"]);
    expect(env.engine.commits[0]?.media.get("media/3/1.mp4")?.location).toEqual({ storageRef: `media/${cacheName(3)}` });
    // The replacement record and scratch of the committed cache are gone.
    expect(existsSync(join(cacheDir, ".amber-tmp"))).toBe(false);
  });

  it("a collection failure is reported on its own and retried without touching the Contents (T54)", async () => {
    const { env, pack } = await setup({ failCollections: true }, 1);
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const dir = originalsGrant(env);
    await service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: dir.grant, collections: [{ key: "col", action: "create" }] }));
    const job = await settled(service, jobId);
    expect(job.status).toBe("finished");
    expect(job.result?.contents[0]?.status).toBe("imported");
    expect(job.result?.collections).toMatchObject([{ key: "col", status: "failed" }]);
    env.engine.script.failCollections = false;
    const retried = service.retryCollections(alice, jobId);
    expect(retried.result?.collections).toMatchObject([{ key: "col", status: "created" }]);
    expect(env.engine.commits).toHaveLength(1);
    expect(env.engine.collectionCommits.map((commit) => [commit.keys, [...commit.contentIds]])).toEqual([
      [["col"], [["origin-1", "alice-origin-1"]]],
      [["col"], [["origin-1", "alice-origin-1"]]],
    ]);
    expect(await codeOf(() => service.retryCollections(alice, jobId))).toBe("conflict.pack_job_state");
  });

  it("checks space before starting: disk watermark and storage limit (server mode)", async () => {
    const { env, pack } = await setup({ targetKind: "managed_upload" });
    const service = env.imports("server", {
      quota: { begin: async () => undefined, usage: async () => ({ usedBytes: 1024 ** 3, storageLimitGB: 1 }) } as never,
    });
    const { jobId } = await service.startFromUpload(serverAlice, undefined, (async function* () {
      yield readFileSync(pack);
    })(), new AbortController().signal);
    await until(() => service.get(serverAlice, jobId).status !== "previewing");
    expect(await codeOf(() => service.commit(serverAlice, jobId, decisions(["origin-1"])))).toBe("storage_quota_exceeded");
    env.disk.usedBytes = 2000 * 1024 ** 3;
    expect(await codeOf(() => service.commit(serverAlice, jobId, decisions(["origin-1"])))).toBe("disk_low");
    expect(service.get(serverAlice, jobId).status).toBe("awaiting_decisions");
    expect(env.gate.sharedHeld()).toBe(0);
  });

  it("refuses to commit while the cache gate is held exclusively; the preview stays", async () => {
    const { env, pack } = await setup();
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const release = env.gate.tryExclusive("cache_migration");
    expect(await codeOf(() => service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: originalsGrant(env).grant })))).toBe("conflict.cache_migrating");
    release?.();
    expect(service.get(alice, jobId).status).toBe("awaiting_decisions");
  });

  it("cancel and discard: awaiting job cancelled, slot freed, then forgotten", async () => {
    const { env, pack } = await setup();
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    expect((await service.cancel(alice, jobId)).status).toBe("cancelled");
    expect(service.active(alice)).toBeUndefined();
    await service.discard(alice, jobId);
    expect(await codeOf(() => service.get(alice, jobId))).toBe("not_found");
  });

  it("answers another user's job ids as unknown", async () => {
    const { env, pack } = await setup();
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const bob = principal("bob");
    for (const work of [
      () => service.get(bob, jobId),
      () => service.compare(bob, jobId, { key: "origin-1", targetContentId: "x" }),
      () => service.commit(bob, jobId, decisions(["origin-1"])),
      () => service.cancel(bob, jobId),
      () => service.retryCollections(bob, jobId),
      () => service.discard(bob, jobId),
    ]) {
      expect(await codeOf(work)).toBe("not_found");
    }
    expect(service.active(bob)).toBeUndefined();
    expect(service.get(alice, jobId).status).toBe("awaiting_decisions");
  });

  it("a corrupt pack fails its preview with the archive's error and frees the slot", async () => {
    const { env } = await setup();
    const service = env.imports();
    const bad = join(env.outside, "bad.amberpack");
    writeFileSync(bad, randomBytes(4096));
    const { jobId } = await service.startFromFile(alice, { grant: env.grant(bad, "pack_input") });
    await until(() => service.get(alice, jobId).status !== "previewing");
    expect(service.get(alice, jobId)).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_entry" } });
    expect(service.active(alice)).toBeUndefined();
  });
});

describe("ContentPackImportService under concurrency and partial failures", () => {
  /** A reader that runs `before` right before the single read, as if something changed meanwhile. */
  const readerWith = (before: () => void) => (path: string): ContentPackSource => {
    const source = openPackFile(path);
    return {
      sizeBytes: () => source.sizeBytes(),
      readDocuments: (signal) => source.readDocuments(signal),
      readAll: (digests, stage, onProgress, signal, options) => {
        before();
        return source.readAll(digests, stage, onProgress, signal, options);
      },
    };
  };

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  }

  it("refuses to start or commit before the start-up recovery finished (conflict.starting_up)", async () => {
    const { env, pack } = await setup();
    let ready = false;
    const service = env.imports("local", { backgroundReady: () => ready });
    expect(await codeOf(() => service.startFromFile(alice, { grant: env.grant(pack, "pack_input") }))).toBe("conflict.starting_up");
    const server = env.imports("server", { backgroundReady: () => ready });
    expect(await codeOf(() => server.startFromUpload(serverAlice, undefined, (async function* () {})(), new AbortController().signal))).toBe("conflict.starting_up");
    expect(env.slots.holder("alice")).toBeUndefined();
    ready = true;
    const jobId = await previewed(service, env, pack);
    ready = false;
    expect(await codeOf(() => service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: originalsGrant(env).grant })))).toBe("conflict.starting_up");
    expect(service.get(alice, jobId).status).toBe("awaiting_decisions");
  });

  it("a second commit while the first waits on its checks is refused; one import runs (double click)", async () => {
    const { env, pack } = await setup({ targetKind: "managed_upload" });
    const usage = deferred<{ usedBytes: number }>();
    let asked = 0;
    const service = env.imports("server", {
      quota: { begin: async () => undefined, usage: () => ((asked += 1), usage.promise) } as never,
    });
    const { jobId } = await service.startFromUpload(serverAlice, undefined, (async function* () {
      yield readFileSync(pack);
    })(), new AbortController().signal);
    await until(() => service.get(serverAlice, jobId).status !== "previewing");
    const first = service.commit(serverAlice, jobId, decisions(["origin-1"]));
    await until(() => asked === 1);
    expect(await codeOf(() => service.commit(serverAlice, jobId, decisions(["origin-1"])))).toBe("conflict.pack_job_state");
    // The preview's deadline passes while the accepted commit waits: it is not undone.
    env.clock.now += CONTENT_PACK_PREVIEW_TTL_MS;
    expect(service.get(serverAlice, jobId).status).toBe("awaiting_decisions");
    usage.resolve({ usedBytes: 0 });
    expect((await first).status).toBe("importing");
    expect((await settled(service, jobId, serverAlice)).status).toBe("finished");
    expect(env.engine.commits.map((commit) => commit.key)).toEqual(["origin-1"]);
    expect(asked).toBe(1);
  });

  it("a cancel while a commit waits on its checks wins: the commit is refused and gives its lease back", async () => {
    const { env, pack } = await setup({ targetKind: "managed_upload" });
    const usage = deferred<{ usedBytes: number }>();
    const service = env.imports("server", { quota: { begin: async () => undefined, usage: () => usage.promise } as never });
    const { jobId } = await service.startFromUpload(serverAlice, undefined, (async function* () {
      yield readFileSync(pack);
    })(), new AbortController().signal);
    await until(() => service.get(serverAlice, jobId).status !== "previewing");
    const first = codeOf(() => service.commit(serverAlice, jobId, decisions(["origin-1"])));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await service.cancel(serverAlice, jobId)).status).toBe("cancelled");
    usage.resolve({ usedBytes: 0 });
    expect(await first).toBe("conflict.pack_job_state");
    expect(env.gate.sharedHeld()).toBe(0);
    expect(env.engine.commits).toEqual([]);
  });

  it("keeps the images on disk until their Content commits, not in memory", async () => {
    const { env, pack } = await setup({}, 2);
    const service = env.imports();
    const seen: Array<{ key: string; files: string[] }> = [];
    env.engine.onCommit = (key) => {
      const dir = readdirSync(join(env.workDir, "imports")).map((jobDir) => join(env.workDir, "imports", jobDir, "images"));
      seen.push({ key, files: dir.flatMap((path) => (existsSync(path) ? readdirSync(path) : [])).sort() });
    };
    const jobId = await previewed(service, env, pack);
    await service.commit(alice, jobId, decisions(["origin-1", "origin-2"], { originalsDir: originalsGrant(env).grant }));
    expect((await settled(service, jobId)).status).toBe("finished");
    // Four images (two per Content) waited as files in the job directory while the Contents committed.
    expect(seen.map((item) => [item.key, item.files.length])).toEqual([
      ["origin-1", 4],
      ["origin-2", 4],
    ]);
    expect(existsSync(join(env.workDir, "imports", jobId))).toBe(false);
  });

  it("a journal that cannot be written before a commit fails that Content only and leaves no orphan", async () => {
    const { env, pack } = await setup({}, 2);
    const journalDir = join(env.workDir, "journal");
    let firstRead = true;
    const service = env.imports("local", {
      openPack: readerWith(() => {
        // The journal was written once before the read; from now on the folder refuses writes.
        if (firstRead) chmodSync(journalDir, 0o500);
        firstRead = false;
      }),
    });
    const jobId = await previewed(service, env, pack);
    const dir = originalsGrant(env);
    await service.commit(alice, jobId, decisions(["origin-1", "origin-2"], { originalsDir: dir.grant }));
    const job = await settled(service, jobId);
    chmodSync(journalDir, 0o700);
    expect(job.status).toBe("finished");
    expect(job.result?.contents.map((content) => content.status)).toEqual(["failed", "failed"]);
    expect(env.engine.commits).toEqual([]);
    expect(existsSync(dir.path)).toBe(false);
  });

  it("keeps the journal when a placed file of a failed Content could not be taken away, for the start-up recovery", async () => {
    const { env, pack } = await setup({ failCommit: new Set(["origin-1"]) }, 1);
    const dir = originalsGrant(env);
    // The commit fails, and the placed file cannot even be read for its rollback.
    env.engine.onCommit = () => chmodSync(join(dir.path, "原片 1.mp4"), 0o000);
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    await service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: dir.grant }));
    expect((await settled(service, jobId)).result?.contents[0]?.status).toBe("failed");
    expect(existsSync(join(env.workDir, "journal", `${jobId}.json`))).toBe(true);
    chmodSync(join(dir.path, "原片 1.mp4"), 0o600);
    await service.recover();
    expect(existsSync(join(env.workDir, "journal", `${jobId}.json`))).toBe(false);
    expect(existsSync(dir.path)).toBe(false);
  });

  it("a fill whose folder is gone, and a fill whose folder vanishes before the read, fail only their own Content", async () => {
    const { env, pack } = await setup({}, 3);
    const gone = join(env.outside, "unplugged", "film.mp4");
    const vanishing = join(env.outside, "vanishing");
    mkdirSync(vanishing);
    env.engine.script.fills = new Map([
      ["media/1/1.mp4", { path: gone }],
      ["media/2/1.mp4", { path: join(vanishing, "film.mp4") }],
    ]);
    const service = env.imports("local", { openPack: readerWith(() => rmSync(vanishing, { recursive: true, force: true })) });
    const jobId = await previewed(service, env, pack);
    await service.commit(alice, jobId, decisions(["origin-1", "origin-2", "origin-3"], { originalsDir: originalsGrant(env).grant }));
    const job = await settled(service, jobId);
    expect(job.result?.contents.map((content) => [content.key, content.status, content.error?.code])).toEqual([
      ["origin-1", "failed", "conflict.pack_target_changed"],
      ["origin-2", "failed", "conflict.pack_target_changed"],
      ["origin-3", "imported", undefined],
    ]);
  });

  it("an overlong display name or extension still places the file under a valid name", async () => {
    const { env, pack } = await setup({}, 1, {}, (sample) => {
      const media = sample.build.contents[0]?.document.media[0] as { displayName?: string };
      media.displayName = `${"长".repeat(300)}.${"x".repeat(200)}`;
    });
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const dir = originalsGrant(env);
    await service.commit(alice, jobId, decisions(["origin-1"], { originalsDir: dir.grant }));
    expect((await settled(service, jobId)).result?.contents[0]?.status).toBe("imported");
    const [name] = readdirSync(dir.path);
    expect(name?.endsWith(".mp4")).toBe(true);
    expect(Buffer.byteLength(name ?? "")).toBeLessThanOrEqual(180);
  });

  it("never removes a file it did not create at a staging path", async () => {
    const { env, pack } = await setup({}, 1);
    const folder = join(env.outside, "registered");
    mkdirSync(folder);
    env.engine.script.fills = new Map([["media/1/1.mp4", { path: join(folder, "film.mp4") }]]);
    const service = env.imports("local", { newId: () => "JOB1" });
    const jobId = await previewed(service, env, pack);
    const foreign = join(folder, ".JOB1-assetorigin1.amber-partial");
    writeFileSync(foreign, "someone else's");
    await service.commit(alice, jobId, decisions(["origin-1"]));
    const job = await settled(service, jobId);
    expect(job.result?.contents[0]?.status).toBe("failed");
    expect(readFileSync(foreign, "utf8")).toBe("someone else's");
  });

  it("a Content whose second file cannot be planned leaves no cache scratch of its first", async () => {
    const { env, pack } = await setup({ targetKind: "platform_cache" }, 1, { cacheFileName: () => "片 [720P].mp4" }, (sample, sources) => {
      const content = sample.build.contents[0] as (typeof sample.build.contents)[0];
      const first = content.document.media[0] as (typeof content.document.media)[0];
      // A second cache file without a usable name.
      content.document.media.push({ ...first, key: "origin-1-media2", entry: "media/1/2.mp4", cacheFileName: "../escape.mp4" });
      content.media.push({ ...(content.media[0] as (typeof content.media)[0]), entry: "media/1/2.mp4", assetId: "asset-1b" });
      void sources;
    });
    mkdirSync(env.media.cache.directory(), { recursive: true });
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const choice = decisions(["origin-1"]);
    (choice.contents[0] as { mediaKeys: string[] }).mediaKeys = ["origin-1-media", "origin-1-media2"];
    await service.commit(alice, jobId, choice);
    const job = await settled(service, jobId);
    expect(job.result?.contents[0]?.status).toBe("failed");
    expect(existsSync(join(env.media.cache.directory(), ".amber-tmp"))).toBe(false);
  });

  it("checks the space of each volume a filled-in original goes to, without an originals directory", async () => {
    const { env, pack } = await setup({}, 1);
    const folder = join(env.outside, "registered");
    mkdirSync(folder);
    env.engine.script.fills = new Map([["media/1/1.mp4", { path: join(folder, "film.mp4") }]]);
    env.freeBytes.value = 10;
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    expect(await codeOf(() => service.commit(alice, jobId, decisions(["origin-1"])))).toBe("disk_low");
    expect(service.get(alice, jobId).status).toBe("awaiting_decisions");
  });
});

describe("ContentPackImportService checks each carried file's container", () => {
  const PLAYLIST = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nhttp://127.0.0.1/segment.ts\n#EXT-X-ENDLIST\n");

  /** Content `index`'s media becomes an HLS playlist, its document still saying `video/mp4` (digest and size agree). */
  const playlistAt = (index: number, mimeType?: string) => (sample: ReturnType<typeof sampleBuild>) => {
    const content = sample.build.contents[index - 1] as (typeof sample.build.contents)[0];
    const file = sample.media[index - 1] as SampleMedia;
    writeFileSync(file.path, PLAYLIST);
    const declared = content.document.media[0] as (typeof content.document.media)[0];
    Object.assign(declared, { sizeBytes: PLAYLIST.length, sha256: sha256(PLAYLIST), ...(mimeType === undefined ? {} : { mimeType }) });
    Object.assign(content.media[0] as object, { sizeBytes: PLAYLIST.length, sha256: sha256(PLAYLIST) });
    content.document.fingerprint = `sha256:${sha256(PLAYLIST)}`;
  };

  it("a playlist declared video/mp4 in the cache fails its Content, nothing left behind; the real MP4 beside it imports", async () => {
    const cacheName = (index: number): string => `片${index} [720P].mp4`;
    const { env, pack } = await setup({ targetKind: "platform_cache" }, 2, { cacheFileName: cacheName }, playlistAt(1));
    mkdirSync(env.media.cache.directory(), { recursive: true });
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    await service.commit(alice, jobId, decisions(["origin-1", "origin-2"]));
    const job = await settled(service, jobId);
    expect(job.result?.contents.map((content) => [content.key, content.status, content.error?.code, content.error?.details])).toEqual([
      ["origin-1", "failed", "backup_invalid.pack_entry", { entry: "media/1/1.mp4", reason: "container" }],
      ["origin-2", "imported", undefined, undefined],
    ]);
    // No media row: the engine never saw the first Content; no file of it in the cache.
    expect(env.engine.commits.map((commit) => commit.key)).toEqual(["origin-2"]);
    expect(readdirSync(env.media.cache.directory()).sort()).toEqual([cacheName(2)]);
  });

  it("a playlist as a local original fails its Content; the MP4 beside it is placed", async () => {
    const { env, pack } = await setup({}, 2, {}, playlistAt(1));
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    const dir = originalsGrant(env);
    await service.commit(alice, jobId, decisions(["origin-1", "origin-2"], { originalsDir: dir.grant }));
    const job = await settled(service, jobId);
    expect(job.result?.contents.map((content) => [content.key, content.status, content.error?.details?.["reason"]])).toEqual([
      ["origin-1", "failed", "container"],
      ["origin-2", "imported", undefined],
    ]);
    expect(readdirSync(dir.path)).toEqual(["原片 2.mp4"]);
  });

  it("a playlist as a managed upload fails its Content (server mode); nothing reaches managed storage", async () => {
    const { env, pack } = await setup({ targetKind: "managed_upload" }, 2, {}, playlistAt(1));
    const service = env.imports("server");
    const { jobId } = await service.startFromUpload(serverAlice, undefined, (async function* () {
      yield readFileSync(pack);
    })(), new AbortController().signal);
    await until(() => service.get(serverAlice, jobId).status !== "previewing");
    await service.commit(serverAlice, jobId, decisions(["origin-1", "origin-2"]));
    const job = await settled(service, jobId, serverAlice);
    expect(job.result?.contents.map((content) => [content.key, content.status])).toEqual([
      ["origin-1", "failed"],
      ["origin-2", "imported"],
    ]);
    expect(existsSync(env.files.pathOf("assets/alice/alice-origin-1"))).toBe(false);
    expect(existsSync(env.files.pathOf("assets/alice/alice-origin-2/assetorigin2"))).toBe(true);
  });

  it("an MP4 declared as audio/mp4 is accepted; a container of another family than declared is not", async () => {
    const { env, pack } = await setup({}, 2, {}, (sample) => {
      Object.assign(sample.build.contents[0]?.document.media[0] as object, { mimeType: "audio/mp4" });
      Object.assign(sample.build.contents[1]?.document.media[0] as object, { mimeType: "video/webm" });
    });
    const service = env.imports();
    const jobId = await previewed(service, env, pack);
    await service.commit(alice, jobId, decisions(["origin-1", "origin-2"], { originalsDir: originalsGrant(env).grant }));
    const job = await settled(service, jobId);
    expect(job.result?.contents.map((content) => [content.key, content.status, content.error?.details?.["reason"]])).toEqual([
      ["origin-1", "imported", undefined],
      ["origin-2", "failed", "container"],
    ]);
  });
});

describe("ContentPackImportService.recover (T07)", () => {
  function journal(env: Env, files: unknown[], extra: Record<string, unknown> = {}): void {
    mkdirSync(join(env.workDir, "journal"), { recursive: true });
    writeFileSync(
      join(env.workDir, "journal", "job1.json"),
      JSON.stringify({ v: 1, jobId: "job1", owner: "alice", createdAt: 1, files, contents: { k: "placed" }, ...extra }),
    );
  }

  function placedFile(env: Env, dir: string, name: string, bytes: Buffer, assetId: string) {
    const finalPath = join(dir, name);
    writeFileSync(finalPath, bytes);
    writeFileSync(`${finalPath}.amber-partial`, "staged leftover");
    return {
      entry: "media/1/1.mp4",
      contentKey: "k",
      assetId,
      targetKind: "external_local",
      fills: false,
      finalPath,
      tempPath: `${finalPath}.amber-partial`,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    };
  }

  it("keeps the files of a committed Content and rolls back the rest; a changed file is never removed", async () => {
    const env = createEnv();
    envs.push(env);
    const dir = join(env.outside, `${IMPORTED_ORIGINALS_DIR_PREFIX}20261118-120000`);
    mkdirSync(dir);
    const committed = placedFile(env, dir, "a.mp4", randomBytes(500), "committed");
    const rolledBack = placedFile(env, dir, "b.mp4", randomBytes(500), "lost");
    const changed = placedFile(env, dir, "c.mp4", randomBytes(500), "lost2");
    writeFileSync(changed.finalPath, randomBytes(500));
    env.rows.assets.push({ id: "committed", userId: "alice", contentId: "c1", kind: "external_local", storageRef: committed.finalPath, mimeType: "video/mp4", sizeBytes: 500, availability: "available", retentionPolicy: "keep", createdAt: 1 } as MediaAsset);
    journal(env, [committed, rolledBack, changed], { originalsDir: { path: dir, created: true } });
    mkdirSync(join(env.workDir, "imports", "job1"), { recursive: true });
    const service = env.imports();
    await service.recover();
    expect(readdirSync(dir).sort()).toEqual(["a.mp4", "c.mp4"]);
    expect(existsSync(join(env.workDir, "journal", "job1.json"))).toBe(false);
    expect(existsSync(join(env.workDir, "imports"))).toBe(false);
    // Running it again changes nothing.
    await service.recover();
    expect(readdirSync(dir).sort()).toEqual(["a.mp4", "c.mp4"]);
  });

  it("removes the originals directory it created once nothing committed is left in it", async () => {
    const env = createEnv();
    envs.push(env);
    const dir = join(env.outside, `${IMPORTED_ORIGINALS_DIR_PREFIX}20261118-120000`);
    mkdirSync(dir);
    journal(env, [placedFile(env, dir, "b.mp4", randomBytes(100), "lost")], { originalsDir: { path: dir, created: true } });
    await env.imports().recover();
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves a filled-in file at the user's own place, whatever the database says", async () => {
    const env = createEnv();
    envs.push(env);
    const file = { ...placedFile(env, env.outside, "mine.mp4", randomBytes(100), "registered"), fills: true };
    journal(env, [file]);
    await env.imports().recover();
    expect(existsSync(file.finalPath)).toBe(true);
    expect(existsSync(file.tempPath)).toBe(false);
  });
});

describe("ContentPackImportService over a library: covers and source links", () => {
  const never = new AbortController().signal;
  const bilibili = (id: string): ContentSource => ({ kind: "bilibili", platformContentId: id, sourceUrl: `https://www.bilibili.com/video/${id}` });
  const XHS_NOTE = "0123456789abcdef01234567";
  const XHS_OTHER = "89abcdef0123456789abcdef";
  /** A share link with its access parameters, as the platform hands it out (the token is a placeholder). */
  const XHS_LINK = `https://www.xiaohongshu.com/explore/${XHS_NOTE}?xsec_token=TESTONLY_xxxxtok&xsec_source=pc_feed`;

  function library(): Library {
    const opened = openLibrary();
    libraries.push(opened);
    return opened;
  }

  function environment(): Env {
    const env = createEnv();
    envs.push(env);
    return env;
  }

  let packs = 0;
  /** Alice's `contentIds` on `source` as a pack file, its documents changed by `tamper` first. */
  async function packOf(env: Env, source: Library, contentIds: readonly string[], tamper?: (build: PackExportBuild) => void): Promise<string> {
    const build = await source.engine.buildExport("alice", bareSelection(contentIds), NO_HOOKS);
    tamper?.(build);
    packs += 1;
    const path = join(env.outside, `pack-${packs}.amberpack`);
    await writeSamplePack(path, build);
    return path;
  }

  const importAll = (item: PackPreviewContent): PackContentDecision => ({ key: item.key, action: "import", revisions: true, figures: true, notes: false, mediaKeys: [] });
  const mergeSuggested = (item: PackPreviewContent): PackContentDecision => ({ ...importAll(item), action: "merge", ...(item.diff.targetContentId === undefined ? {} : { targetContentId: item.diff.targetContentId }) });

  /** Previews `pack` into `target` and commits `decide` for every Content; returns the finished job. */
  async function importInto(env: Env, target: Library, pack: string, decide: (item: PackPreviewContent) => PackContentDecision = importAll) {
    const service = env.imports("local", { repository: target.repository, engine: target.engine });
    const jobId = await previewed(service, env, pack);
    const preview = service.get(alice, jobId).preview;
    await service.commit(alice, jobId, { contents: (preview?.contents ?? []).map(decide), collections: [] });
    const job = await settled(service, jobId);
    expect(job.status).toBe("finished");
    return { job, preview };
  }

  const coverOf = (lib: Library, contentId: string) => lib.repository.withTransaction((scope) => scope.contentCovers.get("alice", contentId));
  const contentOf = (lib: Library, contentId: string) => lib.repository.withTransaction((scope) => scope.contents.get("alice", contentId));

  it("previews and imports version 1 and version 2 packs, and refuses a newer format as pack_newer", async () => {
    const env = environment();
    const a = library();
    const covered = addPlatformContent(a, "alice", bilibili("BV1Ver20c7mA"));
    putCover(a, "alice", covered, COVER_WEBP);
    const bare = addPlatformContent(a, "alice", bilibili("BV1Ver10c7mB"));
    const b = library();
    for (const [contentId, version] of [
      [covered, CONTENT_PACK_COVER_FORMAT_VERSION],
      [bare, CONTENT_PACK_BASE_FORMAT_VERSION],
    ] as const) {
      const { job, preview } = await importInto(env, b, await packOf(env, a, [contentId]));
      expect(preview?.pack.formatVersion).toBe(version);
      expect(job.result?.contents.map((content) => content.status)).toEqual(["imported"]);
    }

    // A pack from a later format: refused before its documents are believed.
    const { build, media } = sampleBuild(env.outside, { cover: () => true });
    const entries = rawEntriesOf(build, media);
    const header = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString()) as Record<string, unknown>;
    entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify({ ...header, formatVersion: CONTENT_PACK_FORMAT_VERSION + 1 })) };
    const newer = join(env.outside, "newer.amberpack");
    writeFileSync(newer, rawTar(entries));
    const service = env.imports("local", { repository: b.repository, engine: b.engine });
    const { jobId } = await service.startFromFile(alice, { grant: env.grant(newer, "pack_input") });
    await until(() => service.get(alice, jobId).status !== "previewing");
    expect(service.get(alice, jobId)).toMatchObject({ status: "failed", error: { code: "invalid_request.pack_newer" } });
  });

  it("refuses at preview a version 1 pack whose document carries a cover", async () => {
    const env = environment();
    const { build, media } = sampleBuild(env.outside, { cover: () => true });
    const entries = rawEntriesOf(build, media);
    const header = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString()) as Record<string, unknown>;
    entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify({ ...header, formatVersion: CONTENT_PACK_BASE_FORMAT_VERSION })) };
    const pack = join(env.outside, "v1-cover.amberpack");
    writeFileSync(pack, rawTar(entries));
    const service = env.imports();
    const { jobId } = await service.startFromFile(alice, { grant: env.grant(pack, "pack_input") });
    await until(() => service.get(alice, jobId).status !== "previewing");
    expect(service.get(alice, jobId)).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_entry", details: { reason: "cover" } } });
  });

  it("gives a new Content the carried cover, version 1, in the transaction that creates it", async () => {
    const env = environment();
    const a = library();
    const covered = addPlatformContent(a, "alice", bilibili("BV1New10c7mA"), { coverUrl: "https://i0.hdslb.com/bfs/archive/new-a.jpg" });
    putCover(a, "alice", covered, COVER_WEBP);
    const pack = await packOf(env, a, [covered]);

    const b = library();
    const { job } = await importInto(env, b, pack);
    const imported = job.result?.contents[0]?.contentId ?? "";
    expect(job.result?.contents[0]?.status).toBe("imported");
    const cover = coverOf(b, imported);
    expect(Buffer.from(cover?.bytes ?? [])).toEqual(Buffer.from(COVER_WEBP));
    expect(cover).toMatchObject({ version: 1, sha256: sha256(COVER_WEBP) });
    expect(contentOf(b, imported)).toMatchObject({ coverImageVersion: 1, coverUrl: "https://i0.hdslb.com/bfs/archive/new-a.jpg" });

    // A cover that fails at the commit takes the new Content with it: the two stand or fall together.
    const c = library();
    const source = openPackFile(pack);
    const documents = await source.readDocuments(never);
    const analysed = c.engine.analyzeImport("alice", documents);
    const prepared = c.engine.prepareImport("alice", documents, analysed.state, { contents: analysed.contents.map(importAll), collections: [] });
    expect([...prepared.imageEntries]).toEqual(["contents/0/cover.webp"]);
    const item = prepared.contents[0];
    if (item === undefined) throw new Error("nothing prepared");
    const failed = c.engine.commitContent("alice", documents, item, { images: new Map([["contents/0/cover.webp", AVATAR_WEBP]]), media: new Map(), now: 1 });
    expect(failed).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_entry" } });
    expect(countRows(c.db, "content")).toBe(0);
    expect(countRows(c.db, "content_cover_image")).toBe(0);
  });

  it("merging never replaces a local cover, and gives one to a Content that has none", async () => {
    const env = environment();
    const a = library();
    const first = addPlatformContent(a, "alice", bilibili("BV1Mrg10c7mA"));
    const second = addPlatformContent(a, "alice", bilibili("BV1Mrg20c7mB"));
    putCover(a, "alice", first, COVER_WEBP);
    putCover(a, "alice", second, COVER_WEBP);
    const pack = await packOf(env, a, [first, second]);

    const b = library();
    const kept = addPlatformContent(b, "alice", bilibili("BV1Mrg10c7mA"));
    const filled = addPlatformContent(b, "alice", bilibili("BV1Mrg20c7mB"));
    putCover(b, "alice", kept, AVATAR_WEBP);
    const before = coverOf(b, kept);

    const { job } = await importInto(env, b, pack, mergeSuggested);
    expect(job.result?.contents.map((content) => [content.status, content.contentId])).toEqual([
      ["merged", kept],
      ["merged", filled],
    ]);
    const after = coverOf(b, kept);
    expect(Buffer.from(after?.bytes ?? [])).toEqual(Buffer.from(AVATAR_WEBP));
    expect(after?.version).toBe(before?.version);
    expect(contentOf(b, kept)?.coverImageVersion).toBe(before?.version);
    const added = coverOf(b, filled);
    expect(Buffer.from(added?.bytes ?? [])).toEqual(Buffer.from(COVER_WEBP));
    expect(added?.version).toBe(1);
  });

  it("checks carried source links against their platform: a valid one stays as it is, anything else becomes the identity's canonical link", async () => {
    const env = environment();
    const a = library();
    const ids = {
      foreignHost: addPlatformContent(a, "alice", bilibili("BV1Src10c7mA")),
      otherVideo: addPlatformContent(a, "alice", bilibili("BV1Src20c7mB")),
      withToken: addPlatformContent(a, "alice", { kind: "xiaohongshu", platformContentId: XHS_NOTE, sourceUrl: XHS_LINK }),
      script: addPlatformContent(a, "alice", { kind: "xiaohongshu", platformContentId: XHS_OTHER, sourceUrl: `https://www.xiaohongshu.com/explore/${XHS_OTHER}` }),
      untouched: addPlatformContent(a, "alice", { kind: "douyin", platformContentId: "7300000000000000001", sourceUrl: "https://www.douyin.com/video/7300000000000000001" }),
    };
    const forged: Record<number, string> = {
      0: "https://evil.example.com/video/BV1Src10c7mA",
      1: "https://www.bilibili.com/video/BV1Oth10c7mZ",
      3: "javascript:alert(1)",
    };
    const pack = await packOf(env, a, Object.values(ids), (build) => {
      build.contents.forEach((content, index) => {
        const url = forged[index];
        if (url !== undefined) content.document.source.sourceUrl = url;
      });
    });

    const b = library();
    const { job } = await importInto(env, b, pack);
    const stored = (job.result?.contents ?? []).map((content) => contentOf(b, content.contentId ?? "")?.source.sourceUrl);
    expect(stored).toEqual([
      "https://www.bilibili.com/video/BV1Src10c7mA",
      "https://www.bilibili.com/video/BV1Src20c7mB",
      XHS_LINK,
      `https://www.xiaohongshu.com/explore/${XHS_OTHER}`,
      "https://www.douyin.com/video/7300000000000000001",
    ]);
  });
});

