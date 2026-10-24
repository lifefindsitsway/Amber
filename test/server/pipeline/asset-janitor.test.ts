import { createHash } from "node:crypto";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import type { Task } from "../../../src/server/domain/task.ts";
import { AssetJanitor } from "../../../src/server/pipeline/asset-janitor.ts";
import { CacheHoldRegistry } from "../../../src/server/pipeline/cache-holds.ts";
import { CachePathLocks } from "../../../src/server/pipeline/cache-path-locks.ts";
import { SWAP_RECORD_FILE, writeSwapRecord } from "../../../src/server/pipeline/cache-swap.ts";
import type { Logger } from "../../../src/server/ports/logger.ts";
import type { ProcessingStatus, TaskKind } from "../../../src/shared/enums.ts";
import { createLocalContent, createTaskOfKind, LOCAL, silentLogger, stageRunsOf, taskOf } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, dataPath, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

function stack(): MediaStack {
  const created = createMediaStack();
  open.push(created);
  return created;
}

async function put(s: MediaStack, ref: string, text = ref): Promise<void> {
  await s.files.writeAtomic(ref, Buffer.from(text));
}

const digestOf = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function registerAsset(s: MediaStack, asset: Partial<MediaAsset> & Pick<MediaAsset, "id" | "contentId" | "kind">): MediaAsset {
  const full: MediaAsset = {
    userId: LOCAL.userId,
    storageRef: `assets/${LOCAL.userId}/${asset.contentId}/${asset.id}`,
    mimeType: "audio/flac",
    sizeBytes: 1,
    availability: "available",
    retentionPolicy: asset.kind === "managed_upload" ? "keep" : "ephemeral",
    createdAt: 1,
    ...asset,
  };
  s.h.repository.withTransaction((scope) => scope.mediaAssets.insert(full));
  return full;
}

/** Marks the Task terminal (or not) and publishes what the scheduler would. */
function finish(s: MediaStack, taskId: string, status: ProcessingStatus): Task {
  s.h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, status, status === "queued" ? undefined : 10));
  const task = taskOf(s.h, taskId);
  s.h.bus.publish(LOCAL.userId, {
    type: "task.finished",
    task: { id: task.id, contentId: task.contentId as string, kind: task.kind, statusProjection: status, createdAt: task.createdAt, finishedAt: 10 },
  });
  return task;
}

function succeededUnitWithOutput(s: MediaStack, taskId: string, outputRef: string): void {
  const run = stageRunsOf(s.h, taskId)[0];
  s.h.repository.withTransaction((scope) =>
    scope.workUnits.insert(LOCAL.userId, {
      id: s.h.newId(), stageRunId: run?.id as string, key: `k-${outputRef}`, status: "succeeded", attempt: 1, retryCount: 0, inputDigest: "d", outputRef, outputDigest: "o",
    }),
  );
}

function taskWithAudio(s: MediaStack, kind: TaskKind = "process_content") {
  const contentId = createLocalContent(s.h);
  const taskId = createTaskOfKind(s.h, kind, kind === "process_content" ? { autoProofread: false } : {}, { contentId });
  return { contentId, taskId };
}

const assetsOf = (s: MediaStack, contentId: string) =>
  s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId)).map((asset) => asset.id).sort();

describe("asset janitor", () => {
  it("after a failed Task removes its intermediates but keeps the checkpoints of succeeded units", async () => {
    const s = stack();
    const { contentId, taskId } = taskWithAudio(s);
    const audio = registerAsset(s, { id: "audio", contentId, kind: "extracted_audio", taskId });
    await put(s, audio.storageRef);
    await put(s, `tmp/tasks/${taskId}/asr-1.json`);
    await put(s, `tmp/tasks/${taskId}/scratch.bin`);
    succeededUnitWithOutput(s, taskId, `tmp/tasks/${taskId}/asr-1.json`);

    finish(s, taskId, "failed");
    await s.janitor.whenIdle();
    expect(assetsOf(s, contentId)).toEqual([]);
    expect(await s.files.stat(audio.storageRef)).toBeNull();
    expect(await s.files.list(`tmp/tasks/${taskId}`)).toEqual([`tmp/tasks/${taskId}/asr-1.json`]);

    // Once the Task can no longer be reopened the checkpoint goes too.
    finish(s, taskId, "cancelled");
    await s.janitor.whenIdle();
    expect(await s.files.list(`tmp/tasks/${taskId}`)).toEqual([]);
  });

  it("after a succeeded Task discards an upload marked discard_after_audio and keeps a kept one", async () => {
    const s = stack();
    const { contentId, taskId } = taskWithAudio(s);
    const discard = registerAsset(s, { id: "discard", contentId, kind: "managed_upload", retentionPolicy: "discard_after_audio" });
    const keep = registerAsset(s, { id: "keep", contentId, kind: "managed_upload", retentionPolicy: "keep" });
    const audio = registerAsset(s, { id: "audio", contentId, kind: "extracted_audio", taskId });
    for (const asset of [discard, keep, audio]) await put(s, asset.storageRef);

    finish(s, taskId, "succeeded");
    await s.janitor.whenIdle();
    expect(assetsOf(s, contentId)).toEqual(["keep"]);
    expect(await s.files.stat(discard.storageRef)).toBeNull();
    expect(await s.files.stat(keep.storageRef)).not.toBeNull();
  });

  it("never discards an upload when the Task did not extract audio", async () => {
    const s = stack();
    const { contentId, taskId } = taskWithAudio(s);
    const discard = registerAsset(s, { id: "discard", contentId, kind: "managed_upload", retentionPolicy: "discard_after_audio" });
    await put(s, discard.storageRef);
    finish(s, taskId, "succeeded");
    await s.janitor.whenIdle();
    expect(assetsOf(s, contentId)).toEqual(["discard"]);
  });

  it("keeps the temporary product of a burn Task for the client to save", async () => {
    const s = stack();
    const { contentId, taskId } = taskWithAudio(s, "burn");
    const product = registerAsset(s, { id: "burned", contentId, kind: "temporary", taskId, mimeType: "video/mp4" });
    await put(s, product.storageRef);
    finish(s, taskId, "succeeded");
    await s.janitor.whenIdle();
    expect(assetsOf(s, contentId)).toEqual(["burned"]);
    expect(await s.files.stat(product.storageRef)).not.toBeNull();
  });

  it("sweeps debris at start-up and leaves live files alone", async () => {
    const s = stack();
    const live = taskWithAudio(s);
    const failed = taskWithAudio(s);
    const done = taskWithAudio(s);
    const kept = registerAsset(s, { id: "kept", contentId: live.contentId, kind: "managed_upload" });
    const liveAudio = registerAsset(s, { id: "live-audio", contentId: live.contentId, kind: "extracted_audio", taskId: live.taskId });
    const staleAudio = registerAsset(s, { id: "stale-audio", contentId: done.contentId, kind: "extracted_audio", taskId: done.taskId });
    for (const asset of [kept, liveAudio, staleAudio]) await put(s, asset.storageRef);
    await put(s, `assets/${LOCAL.userId}/${live.contentId}/orphan`);
    await put(s, `tmp/tasks/${live.taskId}/partial-work.bin`);
    await put(s, `tmp/tasks/${failed.taskId}/asr-1.json`);
    await put(s, `tmp/tasks/${failed.taskId}/scratch.bin`);
    succeededUnitWithOutput(s, failed.taskId, `tmp/tasks/${failed.taskId}/asr-1.json`);
    await put(s, `tmp/tasks/${done.taskId}/asr-1.json`);
    await put(s, "tmp/tasks/01UNKNOWNTASK0000000000000/x");
    await put(s, "tmp/cookies/abc.txt");
    await put(s, "tmp/backup/job/archive.bin");
    await put(s, "tmp/platform/01SCRATCH/sub.zh.vtt");
    await put(s, "tmp/yt-dlp-cache/youtube/x.json");
    mkdirSync(join(s.h.dir, "assets", LOCAL.userId, live.contentId), { recursive: true });
    writeFileSync(join(s.h.dir, "assets", LOCAL.userId, live.contentId, "upload.partial"), "debris");
    s.h.repository.withTransaction((scope) => {
      scope.tasks.setProjection(LOCAL.userId, failed.taskId, "failed", 10);
      scope.tasks.setProjection(LOCAL.userId, done.taskId, "succeeded", 10);
    });

    await s.janitor.sweep();
    expect((await s.files.list("assets")).sort()).toEqual([kept.storageRef, liveAudio.storageRef].sort());
    expect(assetsOf(s, done.contentId)).toEqual([]);
    expect((await s.files.list("tmp")).sort()).toEqual(
      [`tmp/tasks/${failed.taskId}/asr-1.json`, `tmp/tasks/${live.taskId}/partial-work.bin`, "tmp/yt-dlp-cache/youtube/x.json"].sort(),
    );
    expect(existsSync(dataPath(s, "tmp/cookies"))).toBe(false);
    expect(existsSync(dataPath(s, "tmp/platform"))).toBe(false);
  });

  it("collects caches of the old nested layout from the data directory as orphans of the wrong store", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    const legacy = registerAsset(s, { id: "legacy", contentId, kind: "platform_cache", mimeType: "video/mp4", retentionPolicy: "evictable", availability: "evicted" });
    const upload = registerAsset(s, { id: "upload", contentId, kind: "managed_upload" });
    await put(s, legacy.storageRef);
    await put(s, upload.storageRef);
    await s.janitor.sweep();
    expect(await s.files.list("assets")).toEqual([upload.storageRef]);
    expect(assetsOf(s, contentId)).toEqual(["legacy", "upload"]);
  });

  it("sweeps the cache directory: keeps what an available row points at, removes Amber's evicted leftovers, never a file it does not know", async () => {
    const infos: Array<{ message: string; fields: unknown }> = [];
    const s = createMediaStack();
    open.push(s);
    const logger: Logger = { ...silentLogger, info: (message, fields) => void infos.push({ message, fields }) };
    const janitor = new AssetJanitor({ repository: s.h.repository, media: s.stores, bus: s.h.bus, logger });
    const contentId = createLocalContent(s.h);
    const cache = (id: string, storageRef: string, availability: MediaAsset["availability"]) =>
      registerAsset(s, {
        id, contentId, kind: "platform_cache", storageRef, mimeType: "video/mp4", retentionPolicy: "evictable", availability,
        sizeBytes: Buffer.byteLength(id), fingerprint: digestOf(Buffer.from(id)),
      });
    const live = cache("live", "media/第一讲.mp4", "available");
    const leftover = cache("leftover", "media/第一讲 (2).mp4", "evicted");
    // An evicted row's name, now holding another file of the same size: not Amber's to remove.
    const replaced = cache("replaced", "media/第三讲.mp4", "evicted");
    await s.stores.cache.writeAtomic(replaced.storageRef, Buffer.from("REPLACED"));
    // Re-cached under a name an evicted row once had: the available row wins.
    cache("old-name", "media/Lecture.mp3", "evicted");
    const reused = cache("reused", "media/Lecture.mp3", "available");
    for (const asset of [live, leftover, reused]) await s.stores.cache.writeAtomic(asset.storageRef, Buffer.from(asset.id));
    // The user's own files in the cache directory: one renamed by hand, one copied in.
    await s.stores.cache.writeAtomic("media/我的笔记.mp4", Buffer.from("renamed"));
    writeFileSync(join(s.stores.cache.directory(), "notes.txt"), "mine");
    writeFileSync(join(s.stores.cache.directory(), "第二讲.mp4.partial"), "debris");
    // An interrupted video download's intermediate files in Amber's own scratch directory.
    mkdirSync(join(s.stores.cache.directory(), ".amber-tmp", "01ASSET", "01RUN"), { recursive: true });
    writeFileSync(join(s.stores.cache.directory(), ".amber-tmp", "01ASSET", "01RUN", "video.f30080.mp4"), "debris");

    await janitor.sweep();
    expect(existsSync(join(s.stores.cache.directory(), ".amber-tmp"))).toBe(false);
    expect(await s.stores.cache.list("media")).toEqual(["media/Lecture.mp3", "media/我的笔记.mp4", "media/第一讲.mp4", "media/第三讲.mp4"].sort());
    expect(existsSync(join(s.stores.cache.directory(), "notes.txt"))).toBe(true);
    expect(existsSync(join(s.stores.cache.directory(), "第二讲.mp4.partial"))).toBe(false);
    // Rows are never touched by the sweep of the cache directory.
    expect(assetsOf(s, contentId)).toEqual(["leftover", "live", "old-name", "replaced", "reused"]);
    expect(infos.find((entry) => entry.message === "cache_unknown_file")?.fields).toEqual({ count: 2 });
    expect(JSON.stringify(infos)).not.toContain("我的笔记");
    expect(infos.find((entry) => entry.message === "asset_sweep_done")?.fields).toMatchObject({ cache: { partials: 1, scratch: 1, leftovers: 1, unknown: 2 } });
  });

  it("leaves files waiting in the pending-file queue to it: no orphan removal, no unknown count", async () => {
    const infos: Array<{ message: string; fields: unknown }> = [];
    const s = createMediaStack();
    open.push(s);
    const logger: Logger = { ...silentLogger, info: (message, fields) => void infos.push({ message, fields }) };
    const janitor = new AssetJanitor({ repository: s.h.repository, media: s.stores, bus: s.h.bus, logger, pendingRefs: () => s.fileDeleter.currentPendingRefs() });
    const dataRef = `assets/${LOCAL.userId}/01PURGEDCONTENT00000000000/01ASSET`;
    await put(s, dataRef);
    await s.stores.cache.writeAtomic("media/已删除.mp4", Buffer.from("purged"));
    await s.stores.cache.writeAtomic("media/用户的.mp4", Buffer.from("mine"));
    // Registered, but the worker has not been woken yet.
    s.h.repository.withTransaction((scope) =>
      s.fileDeleter.register(scope, [
        { store: "data", storageRef: dataRef, expectedSizeBytes: Buffer.byteLength(dataRef) },
        { store: "cache", storageRef: "media/已删除.mp4", expectedSizeBytes: 6 },
      ]),
    );
    await janitor.sweep();
    expect(await s.files.list("assets")).toEqual([dataRef]);
    expect(await s.stores.cache.list("media")).toEqual(["media/已删除.mp4", "media/用户的.mp4"]);
    expect(infos.find((entry) => entry.message === "asset_sweep_done")?.fields).toMatchObject({ orphans: 0, cache: { unknown: 1 } });
  });

  it("sweeps a custom cache directory instead of the default one once the cache has moved", async () => {
    const s = stack();
    const contentId = createLocalContent(s.h);
    // A row without fingerprint, as earlier builds may have left: its size alone identifies the file.
    const leftover = registerAsset(s, { id: "gone", contentId, kind: "platform_cache", storageRef: "media/Gone.mp4", mimeType: "video/mp4", retentionPolicy: "evictable", availability: "evicted", sizeBytes: 3 });
    const root = join(tempDataDir("amber-janitor-cache-"), "media");
    mkdirSync(root);
    s.stores.cache.setRoot(root);
    await s.stores.cache.writeAtomic(leftover.storageRef, Buffer.from("old"));
    await s.janitor.sweep();
    expect(existsSync(join(root, "Gone.mp4"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("skips the cache store while its root is not mounted instead of treating it as empty", async () => {
    const events: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => void events.push(message) };
    const s = createMediaStack();
    open.push(s);
    const janitor = new AssetJanitor({ repository: s.h.repository, media: s.stores, bus: s.h.bus, logger });
    const contentId = createLocalContent(s.h);
    const cache = registerAsset(s, { id: "cache", contentId, kind: "platform_cache", mimeType: "video/mp4", retentionPolicy: "evictable" });
    s.stores.cache.setRoot(join(tempDataDir("amber-janitor-gone-"), "media"));
    await put(s, `assets/${LOCAL.userId}/${contentId}/orphan`);
    await janitor.sweep();
    expect(events).toEqual(["asset_sweep_skipped_cache_unavailable", "asset_sweep_done"]);
    expect(await s.files.list("assets")).toEqual([]);
    expect(s.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, cache.id))?.availability).toBe("available");
  });

  it("removes empty directories left from before the start, never one created since", async () => {
    const s = stack();
    const stale = dataPath(s, `assets/${LOCAL.userId}/01DELETEDCONTENT0000000000`);
    mkdirSync(stale, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    utimesSync(stale, past, past);
    // An upload that started after the process did may have created its directory already.
    const fresh = dataPath(s, `assets/${LOCAL.userId}/01NEWUPLOAD000000000000000`);
    mkdirSync(fresh, { recursive: true });
    await s.janitor.sweep();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("recovers interrupted replacements first, holds what it cannot settle, and the sweep never removes a held directory", async () => {
    const s = createMediaStack();
    open.push(s);
    const holds = new CacheHoldRegistry();
    const muxer = { inspect: async () => ({ container: "mp4", streams: [] }) };
    const janitor = new AssetJanitor({ repository: s.h.repository, media: s.stores, bus: s.h.bus, logger: silentLogger, swaps: { holds, locks: new CachePathLocks() }, muxer });
    const scratch = (id: string) => join(s.stores.cache.directory(), ".amber-tmp", id);
    // Nothing moved yet: discarded. The target is a stranger: held.
    for (const [id, target] of [["01DISCARD", undefined], ["01HOLD", "a stranger"]] as const) {
      mkdirSync(scratch(id), { recursive: true });
      writeFileSync(join(scratch(id), "download.mp4"), "new");
      await writeSwapRecord(scratch(id), { v: 1, targetRef: `media/${id}.mp4`, newAssetId: id, newSizeBytes: 3, newDigest: digestOf(Buffer.from("new")) });
      if (target !== undefined) {
        writeFileSync(join(s.stores.cache.directory(), `${id}.mp4`), target);
      }
    }
    expect(await janitor.recoverSwaps()).toEqual({ discarded: 1, held: 1 });
    expect(existsSync(scratch("01DISCARD"))).toBe(false);
    expect(holds.isHeld("media/01HOLD.mp4")).toBe(true);
    await janitor.sweep();
    expect(existsSync(join(scratch("01HOLD"), SWAP_RECORD_FILE))).toBe(true);
    expect(existsSync(join(scratch("01HOLD"), "download.mp4"))).toBe(true);
  });

  it("recovers the replacements of a cache directory unmounted at start-up once it is mounted, before admitting cache Tasks, once", async () => {
    const s = createMediaStack();
    open.push(s);
    const holds = new CacheHoldRegistry();
    const janitor = new AssetJanitor({ repository: s.h.repository, media: s.stores, bus: s.h.bus, logger: silentLogger, swaps: { holds, locks: new CachePathLocks() } });
    const root = join(tempDataDir("amber-janitor-late-"), "media");
    s.stores.cache.setRoot(root);
    expect(await janitor.recoverSwaps()).toEqual({});
    // Nothing to look at yet: no recovery, nothing refused.
    await janitor.ensureSwapsRecovered();
    const plant = async (id: string) => {
      const dir = join(root, ".amber-tmp", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "download.mp4"), "new");
      await writeSwapRecord(dir, { v: 1, targetRef: `media/${id}.mp4`, newAssetId: id, newSizeBytes: 3, newDigest: digestOf(Buffer.from("new")) });
      writeFileSync(join(root, `${id}.mp4`), "a stranger");
    };
    await plant("01LATEHOLD");
    await janitor.ensureSwapsRecovered();
    expect(holds.isHeld("media/01LATEHOLD.mp4")).toBe(true);
    // Once settled, later admissions do not walk the scratch area again.
    await plant("01AFTERWARDS");
    await janitor.ensureSwapsRecovered();
    expect(holds.isHeld("media/01AFTERWARDS.mp4")).toBe(false);
  });

  it("never sweeps a held path, and compares leftover names as Windows does", async () => {
    const s = createMediaStack();
    open.push(s);
    const holds = new CacheHoldRegistry();
    const janitor = new AssetJanitor({ repository: s.h.repository, media: s.stores, bus: s.h.bus, logger: silentLogger, swaps: { holds, locks: new CachePathLocks() } });
    const contentId = createLocalContent(s.h);
    const evictedAt = (id: string, ref: string, bytes: Buffer) =>
      registerAsset(s, { id, contentId, kind: "platform_cache", storageRef: ref, mimeType: "video/mp4", retentionPolicy: "evictable", availability: "evicted", sizeBytes: bytes.length, fingerprint: digestOf(bytes) });
    const bytes = Buffer.from("old bytes");
    evictedAt("held", "media/Held.mp4", bytes);
    await s.stores.cache.writeAtomic("media/Held.mp4", bytes);
    holds.add({ scratchId: "01HELD", record: { v: 1, targetRef: "media/held.MP4", newAssetId: "01HELD", newSizeBytes: 1, newDigest: "sha256:00" } });
    // Evicted under this spelling, available under another: the same file on Windows.
    evictedAt("cased", "media/Cased.mp4", bytes);
    registerAsset(s, { id: "cased-live", contentId, kind: "platform_cache", storageRef: "media/cased.mp4", mimeType: "video/mp4", retentionPolicy: "evictable", sizeBytes: bytes.length, fingerprint: digestOf(bytes) });
    await s.stores.cache.writeAtomic("media/Cased.mp4", bytes);
    await janitor.sweep();
    expect(existsSync(s.stores.cache.pathOf("media/Held.mp4"))).toBe(true);
    expect(existsSync(s.stores.cache.pathOf("media/Cased.mp4"))).toBe(true);
  });

  it("reads the quality tier of video caches an earlier build never verified or recorded as an encoded height; an unreadable one becomes an unknown quality", async () => {
    const s = createMediaStack();
    open.push(s);
    const contentId = createLocalContent(s.h);
    const probed: string[] = [];
    const muxer = {
      inspect: async (path: string) => {
        probed.push(path);
        if (path.endsWith("broken.mp4")) {
          throw new Error("ffprobe failed");
        }
        if (path.endsWith("encoded.mp4")) {
          return { container: "mov,mp4", streams: [{ index: 0, type: "video" as const, codec: "h264", width: 1920, height: 1072 }] };
        }
        return { container: "mov,mp4", streams: [{ index: 0, type: "video" as const, codec: "h264", width: 1280, height: 714 }] };
      },
    };
    const janitor = new AssetJanitor({ repository: s.h.repository, media: s.stores, bus: s.h.bus, logger: silentLogger, muxer });
    const cache = (id: string, fields: Partial<MediaAsset>) =>
      registerAsset(s, { id, contentId, kind: "platform_cache", storageRef: `media/${id}.mp4`, mimeType: "video/mp4", retentionPolicy: "evictable", ...fields });
    cache("legacy", { quality: "1080" });
    cache("broken", { quality: "480" });
    cache("verified", { quality: "1080", qualityVerified: true });
    // An earlier candidate build recorded the encoded height rather than the tier.
    cache("encoded", { quality: "1072", qualityVerified: true });
    cache("audio", { mimeType: "audio/mpeg", storageRef: "media/audio.mp3" });
    for (const id of ["legacy", "broken", "verified", "encoded"]) await s.stores.cache.writeAtomic(`media/${id}.mp4`, Buffer.from(id));
    await janitor.sweep();
    const rows = Object.fromEntries(
      s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId)).map((asset) => [asset.id, [asset.quality, asset.qualityVerified]]),
    );
    expect(rows).toEqual({ legacy: ["720", true], broken: ["", true], verified: ["1080", true], encoded: ["1080", true], audio: [undefined, undefined] });
    expect(probed.map((path) => path.split(/[\\/]/u).at(-1)).sort()).toEqual(["broken.mp4", "encoded.mp4", "legacy.mp4"]);
  });
});
