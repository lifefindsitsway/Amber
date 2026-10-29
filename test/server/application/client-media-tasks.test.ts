import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientMediaTaskService } from "../../../src/server/application/client-media-tasks.ts";
import { amberError } from "../../../src/server/domain/errors.ts";
import type { MediaInspection } from "../../../src/server/ports/subtitle-muxer.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import { BYTES_PER_GB } from "../../../src/shared/units.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { cacheFileNameOf } from "../../../src/shared/cache-file-name.ts";
import { CACHE_MEDIA_MAX_HEIGHT } from "../../../src/shared/defaults.ts";
import { cacheMediaInspectDtoSchema, cacheMediaQualitiesDtoSchema } from "../../../src/shared/dto/media.ts";
import { cacheFile } from "../../../src/shared/i18n/zh-CN/cache-file.ts";
import { CacheDownloadLedger } from "../../../src/server/pipeline/cache-download-ledger.ts";
import { CacheHoldRegistry } from "../../../src/server/pipeline/cache-holds.ts";
import { FairSemaphore } from "../../../src/server/pipeline/fair-semaphore.ts";
import type { PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { addLocalFile, seedExportContent } from "../../fixtures/export/export-data.ts";
import {
  BOB,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  stageRunsOf,
  StubDisk,
  taskOf,
  type Harness,
} from "../../fixtures/pipeline/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  const cacheDir = join(h.dir, "media");
  mkdirSync(cacheDir);
  const probed: string[] = [];
  const cache = {
    available: true,
    dir: cacheDir,
    usage: new StubDisk(),
    diskUsage: () => {
      probed.push("cache");
      return cache.usage.diskUsage();
    },
    isAvailable: async () => cache.available,
    directory: () => cache.dir,
    pathOf: (ref: string) => join(cache.dir, cacheFileNameOf(ref)),
  };
  const data = {
    diskUsage: () => {
      probed.push("data");
      return h.disk.diskUsage();
    },
  };
  const inspected: string[] = [];
  const ledger = new CacheDownloadLedger();
  const holds = new CacheHoldRegistry();
  const heavyRuns: string[] = [];
  const heavy = new FairSemaphore(() => 1);
  const sameVolume = { value: true };
  const recoveries = { count: 0, refuse: false };
  const source = {
    inspection: {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      streams: [
        { index: 0, type: "video", codec: "h264", width: 1280, height: 720 },
        { index: 1, type: "audio", codec: "aac" },
      ],
    } as MediaInspection | Error,
  };
  const service = new ClientMediaTaskService({
    media: { storeFor: () => ({ pathOf: (ref: string) => join(h.dir, ref) }) },
    muxer: {
      inspect: async (path) => {
        inspected.push(path);
        if (source.inspection instanceof Error) throw source.inspection;
        return source.inspection;
      },
    },
    repository: h.repository,
    bus: h.bus,
    control: h.scheduler,
    disk: data,
    cache,
    cacheFileExists: (ref) => existsSync(join(cache.dir, cacheFileNameOf(ref))),
    sameVolume: () => sameVolume.value,
    ledger,
    holds,
    recoverSwaps: async () => {
      recoveries.count += 1;
      if (recoveries.refuse) throw amberError("conflict", "recovery could not run", { code: "conflict.cache_recovery_pending" });
    },
    platforms: h.platformAccess,
    heavy: { run: (ref, signal, work) => (heavyRuns.push(ref.key), heavy.run(ref, signal, work)) },
    settings: h.settings,
    newId: h.newId,
  });
  return { h, service, cache, cacheDir, probed, inspected, source, ledger, holds, heavyRuns, sameVolume, recoveries };
}

/** The user message of the error the promise rejects with. */
async function messageOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return isAmberError(error) ? error.appError.userMessage : undefined;
  }
  return undefined;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

function platformContent(h: Harness, options: { userId?: string; title?: string; customTitle?: string } = {}): string {
  const id = h.newId();
  // A platform identity is unique per user; each Content of a test gets its own video id.
  const videoId = id.slice(-11);
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id,
      userId: options.userId ?? LOCAL.userId,
      source: { kind: "youtube", sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, platformContentId: videoId },
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.customTitle === undefined ? {} : { customTitle: options.customTitle }),
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return id;
}

function addCache(h: Harness, contentId: string, storageRef: string, fields: Partial<MediaAsset> = {}): MediaAsset {
  const asset: MediaAsset = {
    id: h.newId(),
    userId: LOCAL.userId,
    contentId,
    kind: "platform_cache",
    storageRef,
    mimeType: storageRef.endsWith(".mp3") ? "audio/mpeg" : "video/mp4",
    sizeBytes: 1,
    availability: "available",
    retentionPolicy: "evictable",
    createdAt: 1,
    ...fields,
  };
  h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  return asset;
}

/** The request frozen into the accepted Task. */
async function frozen(service: ClientMediaTaskService, h: Harness, contentId: string, body: Parameters<ClientMediaTaskService["cacheMedia"]>[2] = {}) {
  const accepted = await service.cacheMedia(LOCAL, contentId, body);
  return JSON.parse(taskOf(h, accepted.body.taskId).requestJson) as Record<string, unknown>;
}

/**
 * What the YouTube adapter's format checks answer: a video of `height`, or no picture with an
 * audio track. Calls are recorded as `tier:<n>` for an exact tier, `video:<n>` for a cap.
 */
function videoFormat(h: Harness, video: { height?: number; sizeBytes?: number; hasVideo?: boolean; mimeType?: string }, audioBytes?: number): string[] {
  const calls: string[] = [];
  const inspectVideo: NonNullable<PlatformSourceAdapter["inspectVideo"]> = async (_ref, _auth, options) => {
    calls.push("tier" in options ? `tier:${options.tier}` : `video:${options.maxHeight}`);
    return video.hasVideo === false
      ? { hasVideo: false }
      : {
          hasVideo: true,
          mimeType: video.mimeType ?? "video/mp4",
          ...(video.height === undefined ? {} : { height: video.height }),
          ...(video.sizeBytes === undefined ? {} : { sizeBytes: video.sizeBytes }),
        };
  };
  const inspectAudio: NonNullable<PlatformSourceAdapter["inspectAudio"]> = async () => {
    calls.push("audio");
    return audioBytes === undefined ? {} : { sizeBytes: audioBytes };
  };
  Object.assign(h.platforms.youtube, { inspectVideo, inspectAudio });
  return calls;
}

/** Finishes every unfinished Task of the Content so the lane is free again. */
function finishTasks(h: Harness, contentId: string): void {
  h.db.prepare("UPDATE task SET status_projection = 'succeeded', finished_at = 1 WHERE content_id = ?").run(contentId);
}

describe("ClientMediaTaskService.cacheMedia", () => {
  it("freezes a v4 request with the default type, no tier (the cap meaning), the stem and a fresh asset id, and replays by Idempotency-Key", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "Lecture: one" });
    const first = await service.cacheMedia(LOCAL, contentId, {}, "k-1");
    expect(first.status).toBe(202);
    const task = taskOf(h, first.body.taskId);
    expect(task).toMatchObject({ kind: "cache_media", contentId });
    const request = JSON.parse(task.requestJson) as Record<string, unknown>;
    expect(request).toEqual({ requestSchemaVersion: 4, kind: "cache_media", type: "video", stem: "Lecture one", assetId: expect.any(String) });
    expect(request["assetId"]).not.toBe(task.id);
    expect(stageRunsOf(h, task.id).map((run) => run.stage)).toEqual(["cache_media"]);

    const replay = await service.cacheMedia(LOCAL, contentId, {}, "k-1");
    expect(replay).toMatchObject({ replayed: true, body: { taskId: task.id } });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { quality: 360 }, "k-1"))).toBe("idempotency_conflict");
  });

  it("freezes the chosen tier of a video into a v4 request", async () => {
    const { h, service } = setup();
    for (const quality of [240, 480, 1440] as const) {
      const contentId = platformContent(h, { title: `Lecture ${quality}` });
      expect(await frozen(service, h, contentId, { quality }), String(quality)).toEqual({
        requestSchemaVersion: 4, kind: "cache_media", type: "video", quality, stem: `Lecture ${quality}`, assetId: expect.any(String),
      });
    }
  });

  it("freezes an audio request without a tier", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "Talk" });
    expect(await frozen(service, h, contentId, { type: "audio" })).toEqual({
      requestSchemaVersion: 4, kind: "cache_media", type: "audio", stem: "Talk", assetId: expect.any(String),
    });
  });

  it("takes the stem from the cleaned request name, else the display title, else the i18n default, and never numbers it", async () => {
    const { h, service } = setup();
    const named = platformContent(h, { title: "Platform title" });
    expect((await frozen(service, h, named, { fileName: '  课程: 第1讲?.MP4 ' }))["stem"]).toBe("课程 第1讲");
    const renamed = platformContent(h, { title: "Platform title", customTitle: "My name" });
    expect((await frozen(service, h, renamed))["stem"]).toBe("My name");
    // Unfinished Tasks of one stem conflict; finish each so the next may take it.
    const finishAll = () => h.db.prepare("UPDATE task SET status_projection = 'succeeded', finished_at = 1").run();
    const untitled = platformContent(h);
    expect((await frozen(service, h, untitled))["stem"]).toBe(cacheFile.untitled);
    finishAll();
    const symbols = platformContent(h, { title: "?*" });
    expect((await frozen(service, h, symbols))["stem"]).toBe(cacheFile.untitled);
    finishAll();
    // A name the user cleared, or one that cleans to nothing, is untitled rather than the title.
    for (const fileName of ["", "  ::  ", "///"]) {
      const titled = platformContent(h, { title: "Platform title" });
      expect((await frozen(service, h, titled, { fileName }))["stem"], JSON.stringify(fileName)).toBe(cacheFile.untitled);
      finishAll();
    }
    // Taken names stay: a cache of this Content, another Content's, a file on disk.
    const t = platformContent(h, { title: "T" });
    addCache(h, t, "media/T [1080P].mp4");
    expect((await frozen(service, h, t))["stem"]).toBe("T");
  });

  it("shortens the stem to fit the Windows path limit and refuses a cache directory with no room left", async () => {
    const { h, service, cache } = setup();
    cache.dir = `C:\\${"d".repeat(200)}`;
    const stem = (await frozen(service, h, platformContent(h, { title: "x".repeat(100) })))["stem"] as string;
    expect(stem.length).toBeLessThan(100);
    expect(cache.dir.length + 1 + stem.length + " [2160P].webm.partial".length).toBeLessThanOrEqual(259);
    cache.dir = `C:\\${"d".repeat(250)}`;
    const refused = await service.cacheMedia(LOCAL, platformContent(h, { title: "x" }), {}).catch((error: unknown) => error);
    expect(isAmberError(refused) && refused.appError).toMatchObject({ class: "invalid_request", userMessage: "请求参数有误：fileName" });
  });

  it("refuses a stem another Content's unfinished cache Task froze for the same type and a same or unknown height", async () => {
    const { h, service } = setup();
    const other = platformContent(h, { title: "T" });
    const pending = createTaskOfKind(h, "cache_media", { requestSchemaVersion: 3, type: "video", quality: 720, stem: "t", expectedHeight: 720, assetId: h.newId() }, { contentId: other });
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h, { title: "T" }), {}))).toBe("conflict.cache_name_pending");
    // Audio of the same stem writes another name.
    expect((await service.cacheMedia(LOCAL, platformContent(h, { title: "T" }), { type: "audio" })).status).toBe(202);
    finishTasks(h, other);
    void pending;
    expect((await service.cacheMedia(LOCAL, platformContent(h, { title: "T" }), {})).status).toBe(202);
  });

  it("refuses a stem another Content's unfinished v4 cache Task froze, and ignores v1 and v2 Tasks", async () => {
    const { h, service } = setup();
    const v4 = platformContent(h, { title: "x" });
    createTaskOfKind(h, "cache_media", { requestSchemaVersion: 4, type: "video", quality: 480, stem: "T", expectedHeight: 480, assetId: h.newId() }, { contentId: v4 });
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h, { title: "T" }), {}))).toBe("conflict.cache_name_pending");
    finishTasks(h, v4);
    createTaskOfKind(h, "cache_media", { requestSchemaVersion: 2, type: "video", quality: 720, fileName: "T", assetId: h.newId() }, { contentId: platformContent(h, { title: "y" }) });
    createTaskOfKind(h, "cache_media", { requestSchemaVersion: 1, quality: 720 }, { contentId: platformContent(h, { title: "z" }) });
    expect((await service.cacheMedia(LOCAL, platformContent(h, { title: "T" }), {})).status).toBe(202);
  });

  it("freezes the height the preceding inspection expected and checks the overwrite confirmation", async () => {
    const { h, service } = setup();
    videoFormat(h, { height: 720 });
    const other = platformContent(h, { title: "theirs" });
    const held = addCache(h, other, "media/T [720P].mp4", { fingerprint: "sha256:held" });
    const contentId = platformContent(h, { title: "T" });
    const inspection = await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    expect(inspection.overwrite).toMatchObject({ assetId: held.id, contentId: other, title: "theirs", fileName: "T [720P].mp4" });
    expect(await frozen(service, h, contentId, { overwriteAssetId: held.id })).toMatchObject({
      expectedHeight: 720,
      overwrite: { assetId: held.id, fileName: "T [720P].mp4" },
    });
    finishTasks(h, contentId);
    // Without a fresh inspection the expected name is unknown: the confirmation cannot hold it.
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { overwriteAssetId: held.id }))).toBe("conflict.cache_name_taken");
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId: other });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { overwriteAssetId: held.id }))).toBe("conflict.tasks_unfinished");
    finishTasks(h, other);
    h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...held, fingerprint: "" }));
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { overwriteAssetId: held.id }))).toBe("conflict.cache_file_foreign");
    h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...held, availability: "evicted" }));
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { overwriteAssetId: held.id }))).toBe("conflict.cache_name_taken");
  });

  it("keeps the estimate of an omitted tier apart from that of the tier the default cap names", async () => {
    const { h, service } = setup();
    videoFormat(h, { height: 720 });
    const contentId = platformContent(h, { title: "T" });
    // The cap selects the 720 stream; a request naming 1080 must not inherit that estimate.
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    expect(await frozen(service, h, contentId, { quality: 1080 })).not.toHaveProperty("expectedHeight");
    finishTasks(h, contentId);
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    expect(await frozen(service, h, contentId)).toMatchObject({ requestSchemaVersion: 4, expectedHeight: 720 });
  });

  it("refuses an overwrite confirmation naming another user's cache, even at the expected name", async () => {
    const { h, service } = setup();
    videoFormat(h, { height: 720 });
    const bobContent = platformContent(h, { userId: BOB.userId, title: "theirs" });
    const bobs = addCache(h, bobContent, "media/T [720P].mp4", { userId: BOB.userId, fingerprint: "sha256:bob" });
    const contentId = platformContent(h, { title: "T" });
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { overwriteAssetId: bobs.id }))).toBe("conflict.cache_name_taken");
    expect(h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId))).toEqual([]);
    expect(h.repository.withTransaction((scope) => scope.mediaAssets.get(BOB.userId, bobs.id))?.availability).toBe("available");
    // The same confirmation of the owner's own cache at that name goes through: the refusal was about the owner.
    const own = addCache(h, platformContent(h, { title: "mine" }), "media/T [720P].webm", { fingerprint: "sha256:own" });
    expect(await frozen(service, h, contentId, { overwriteAssetId: own.id })).toMatchObject({ overwrite: { assetId: own.id, fileName: "T [720P].webm" } });
  });

  it("refuses an overwrite confirmation whose cache does not hold the expected file name", async () => {
    const { h, service } = setup();
    videoFormat(h, { height: 720 });
    const other = platformContent(h, { title: "theirs" });
    const contentId = platformContent(h, { title: "T" });
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    const mismatched = [
      // Another tier of the stem.
      addCache(h, other, "media/T [1080P].mp4", { fingerprint: "sha256:1080" }),
      // Another stem of the tier.
      addCache(h, other, "media/Other [720P].mp4", { fingerprint: "sha256:other" }),
      // The stem with the tier's label only as a prefix of a longer name.
      addCache(h, other, "media/T [720P] extra.mp4", { fingerprint: "sha256:extra" }),
      // An audio cache of the stem.
      addCache(h, other, "media/T.mp3", { fingerprint: "sha256:mp3" }),
    ];
    for (const held of mismatched) {
      expect(await codeOf(service.cacheMedia(LOCAL, contentId, { overwriteAssetId: held.id })), held.storageRef).toBe("conflict.cache_name_taken");
    }
    // An original file of another Content is never a cache to replace, whatever it is called.
    const original = addCache(h, other, "assets/local/x/T [720P].mp4", { kind: "managed_upload", retentionPolicy: "keep", fingerprint: "sha256:upload" });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { overwriteAssetId: original.id }))).toBe("conflict.cache_name_taken");
    // Audio expects `<stem>.mp3`: a video cache of the stem does not hold it, the MP3 does.
    const video = addCache(h, other, "media/T [720P].mp4", { fingerprint: "sha256:720" });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { type: "audio", overwriteAssetId: video.id }))).toBe("conflict.cache_name_taken");
    expect(h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId))).toEqual([]);
    expect(await frozen(service, h, contentId, { type: "audio", overwriteAssetId: (mismatched[3] as MediaAsset).id })).toMatchObject({
      overwrite: { assetId: (mismatched[3] as MediaAsset).id, fileName: "T.mp3" },
    });
  });

  it("forgets an expected height once a later inspection cannot read one", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "T" });
    videoFormat(h, { height: 720 });
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    videoFormat(h, {});
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    expect((await frozen(service, h, contentId))["expectedHeight"]).toBeUndefined();
  });

  it("keeps the expected height for the retry when the submission is refused after reading it", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "T" });
    videoFormat(h, { height: 720 });
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    createTaskOfKind(h, "burn", { mode: "original", revisionId: "r" }, { contentId });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, {}))).toBe("conflict.mutation_lane");
    finishTasks(h, contentId);
    expect((await frozen(service, h, contentId))["expectedHeight"]).toBe(720);
    finishTasks(h, contentId);
    // Consumed by the Task that froze it.
    expect((await frozen(service, h, contentId))["expectedHeight"]).toBeUndefined();
  });

  it("settles interrupted replacements before inspecting or admitting a cache Task, and refuses when that cannot run", async () => {
    const { h, service, recoveries } = setup();
    const contentId = platformContent(h, { title: "T" });
    videoFormat(h, { height: 720 });
    await service.inspectCacheMedia(LOCAL, contentId, {}, new AbortController().signal);
    await service.cacheMedia(LOCAL, contentId, {});
    expect(recoveries.count).toBe(2);
    finishTasks(h, contentId);
    recoveries.refuse = true;
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, {}))).toBe("conflict.cache_recovery_pending");
    expect(h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId))).toHaveLength(1);
  });

  it("keeps cache and burn Tasks on one Content apart, and each serial", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "T" });
    await service.cacheMedia(LOCAL, contentId, {});
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { type: "audio" }))).toBe("conflict.mutation_lane");
    finishTasks(h, contentId);
    createTaskOfKind(h, "burn", { mode: "original", revisionId: "r" }, { contentId });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, {}))).toBe("conflict.mutation_lane");
    // The refusal names the Task to wait for or cancel.
    expect(await messageOf(service.cacheMedia(LOCAL, contentId, {}))).toBe("已有一个「导出字幕视频」任务正在进行，与这次操作冲突；请等它结束，或在左下角「任务」里取消后再试");
    // Other Contents are not affected.
    expect((await service.cacheMedia(LOCAL, platformContent(h, { title: "T" }), {})).status).toBe(202);
  });

  it("refuses local, unknown and foreign Contents", async () => {
    const { h, service } = setup();
    expect(await codeOf(service.cacheMedia(LOCAL, createLocalContent(h), {}))).toBe("invalid_request");
    expect(await codeOf(service.cacheMedia(LOCAL, "nope", {}))).toBe("not_found");
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h, { userId: BOB.userId }), {}))).toBe("not_found");
  });

  it("checks the cache volume for a video, and both volumes for audio", async () => {
    const { h, service, cache, probed } = setup();
    await service.cacheMedia(LOCAL, platformContent(h, { title: h.newId() }), {});
    expect(probed).toEqual(["cache"]);
    probed.length = 0;
    await service.cacheMedia(LOCAL, platformContent(h, { title: h.newId() }), { type: "audio" });
    expect(probed).toEqual(["data", "cache"]);

    cache.usage.low();
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h, { title: h.newId() }), {}))).toBe("disk_low");
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h, { title: h.newId() }), { type: "audio" }))).toBe("disk_low");
    // A full data directory does not stop a video download onto a roomy cache volume, but stops audio.
    cache.usage.plenty();
    h.disk.low();
    expect((await service.cacheMedia(LOCAL, platformContent(h, { title: h.newId() }), {})).status).toBe(202);
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h, { title: h.newId() }), { type: "audio" }))).toBe("disk_low");
  });

  it("refuses a cache Task while the cache root is not mounted", async () => {
    const { h, service, cache } = setup();
    cache.available = false;
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h), {}))).toBe("conflict.cache_unavailable");
    cache.available = true;
    expect((await service.cacheMedia(LOCAL, platformContent(h), {})).status).toBe(202);
  });
});

describe("ClientMediaTaskService.burn", () => {
  it("accepts revisions the way subtitle export does and freezes them", async () => {
    const { h, service } = setup();
    const fixture = seedExportContent(h, LOCAL.userId, "local");
    addLocalFile(h, fixture.contentId, "lecture.mp4");
    const body = { mode: "bilingual" as const, revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id };
    const accepted = await service.burn(LOCAL, fixture.contentId, body, "b-1");
    expect(accepted.status).toBe(202);
    const task = taskOf(h, accepted.body.taskId);
    expect(task.kind).toBe("burn");
    expect(JSON.parse(task.requestJson)).toEqual({ requestSchemaVersion: 1, kind: "burn", ...body });
    expect(stageRunsOf(h, task.id).map((run) => run.stage)).toEqual(["burn"]);
    expect((await service.burn(LOCAL, fixture.contentId, body, "b-1")).body).toEqual({ taskId: task.id });

    // One burn at a time per Content.
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: fixture.asr.revision.id }))).toBe("conflict.mutation_lane");
    finishTasks(h, fixture.contentId);
    const original = await service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: fixture.asr.revision.id });
    expect(JSON.parse(taskOf(h, original.body.taskId).requestJson)).toEqual({ requestSchemaVersion: 1, kind: "burn", mode: "original", revisionId: fixture.asr.revision.id });
  });

  it("burns into a video cache only, never an audio cache, and waits for an unfinished cache Task", async () => {
    const { h, service } = setup();
    const fixture = seedExportContent(h, LOCAL.userId);
    const body = { mode: "original" as const, revisionId: fixture.asr.revision.id };
    addCache(h, fixture.contentId, "media/a.mp3");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("media_missing");
    addCache(h, fixture.contentId, "media/a.mp4");
    const cacheTask = await service.cacheMedia(LOCAL, fixture.contentId, { type: "audio" });
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("conflict.mutation_lane");
    expect(await messageOf(service.burn(LOCAL, fixture.contentId, body))).toBe("已有一个「缓存视频」任务正在进行，与这次操作冲突；请等它结束，或在左下角「任务」里取消后再试");
    expect(taskOf(h, cacheTask.body.taskId).kind).toBe("cache_media");
    finishTasks(h, fixture.contentId);
    expect((await service.burn(LOCAL, fixture.contentId, body)).status).toBe(202);
  });

  it("refuses a translation as the original, a translation of another revision, unknown revisions and Contents without media", async () => {
    const { h, service } = setup();
    const fixture = seedExportContent(h, LOCAL.userId, "local");
    addLocalFile(h, fixture.contentId, "lecture.mp4");
    const { asr, corrected, translated } = fixture;
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: translated.revision.id }))).toBe("invalid_request");
    expect(
      await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "translation", revisionId: asr.revision.id, translationRevisionId: translated.revision.id })),
    ).toBe("invalid_request");
    expect(
      await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "bilingual", revisionId: corrected.revision.id, translationRevisionId: asr.revision.id })),
    ).toBe("invalid_request");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: "nope" }))).toBe("not_found");
    const other = seedExportContent(h, LOCAL.userId, "local");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: other.asr.revision.id }))).toBe("not_found");
    expect(await codeOf(service.burn(BOB, fixture.contentId, { mode: "original", revisionId: asr.revision.id }))).toBe("not_found");

    // No original and no cache available at submission.
    expect(await codeOf(service.burn(LOCAL, other.contentId, { mode: "original", revisionId: other.asr.revision.id }))).toBe("media_missing");
    h.repository.withTransaction((scope) => {
      for (const asset of scope.mediaAssets.listByContent(LOCAL.userId, fixture.contentId)) {
        scope.mediaAssets.update(LOCAL.userId, { ...asset, availability: "missing" });
      }
    });
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: asr.revision.id }))).toBe("media_missing");
  });
});

describe("ClientMediaTaskService.burn, styled exports", () => {
  const style = { appearance: { ...defaultSubtitleAppearance(), original: { fontSize: 50, color: "#abcdef" } }, placement: defaultSubtitlePlacement() };

  function styled(h: Harness) {
    const fixture = seedExportContent(h, LOCAL.userId, "local");
    const assetId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.mediaAssets.insert({
        id: assetId, userId: LOCAL.userId, contentId: fixture.contentId, kind: "external_local", storageRef: "/media/lecture.mkv", displayName: "lecture.mkv",
        mimeType: "video/x-matroska", sizeBytes: 10, fingerprint: "sha256:abc", availability: "available", retentionPolicy: "keep", createdAt: 1,
      }),
    );
    const body = {
      mode: "bilingual" as const,
      revisionId: fixture.corrected.revision.id,
      translationRevisionId: fixture.translated.revision.id,
      delivery: "soft" as const,
      container: "mkv" as const,
      style,
    };
    return { fixture, assetId, body };
  }

  it("inspects the picked source and freezes it with its fingerprint, the delivery, the container and the parsed style", async () => {
    const { h, service, inspected } = setup();
    const { fixture, assetId, body } = styled(h);
    const accepted = await service.burn(LOCAL, fixture.contentId, body, "s-1");
    expect(accepted.status).toBe(202);
    expect(inspected).toEqual(["/media/lecture.mkv"]);
    const request = JSON.parse(taskOf(h, accepted.body.taskId).requestJson) as Record<string, unknown>;
    expect(request).toEqual({
      requestSchemaVersion: 2,
      kind: "burn",
      mode: "bilingual",
      revisionId: fixture.corrected.revision.id,
      translationRevisionId: fixture.translated.revision.id,
      source: { assetId, fingerprint: "sha256:abc" },
      delivery: "soft",
      container: "mkv",
      style: { ...style, appearance: { ...style.appearance, original: { fontSize: 50, color: "#ABCDEF" } } },
    });
    // A replay neither inspects nor creates again.
    expect((await service.burn(LOCAL, fixture.contentId, body, "s-1")).body).toEqual({ taskId: accepted.body.taskId });
    expect(inspected).toHaveLength(1);
  });

  it("refuses a soft MP4 of streams outside the MP4 rule, listing them; MKV and hard MP4 take them", async () => {
    const { h, service, source } = setup();
    const { fixture, body } = styled(h);
    source.inspection = {
      container: "matroska,webm",
      streams: [
        { index: 0, type: "video", codec: "vp9", width: 1920, height: 1080 },
        { index: 1, type: "audio", codec: "opus" },
        { index: 2, type: "subtitle", codec: "ass" },
        { index: 3, type: "video", codec: "mjpeg", attachedPic: true },
      ],
    };
    const failure = await service.burn(LOCAL, fixture.contentId, { ...body, container: "mp4" }).catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError).toMatchObject({ code: "invalid_request.container_unsupported", details: { streams: ["0:video:vp9", "1:audio:opus"] } });
    expect((await service.burn(LOCAL, fixture.contentId, body)).status).toBe(202);
    finishTasks(h, fixture.contentId);
    expect((await service.burn(LOCAL, fixture.contentId, { ...body, delivery: "hard", container: "mp4" })).status).toBe(202);
  });

  it("needs room for an output the size of the source beyond the low-water mark", async () => {
    const { h, service } = setup();
    const { fixture, assetId, body } = styled(h);
    const free = h.disk.usage.freeBytes;
    const settings = h.settings.effective();
    // Just enough: what is left after the output still meets the absolute and the ratio mark.
    const floor = Math.max(settings.lowWaterFreeGB * BYTES_PER_GB, settings.lowWaterFreeRatio * h.disk.usage.totalBytes);
    const setSize = (sizeBytes: number) =>
      h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...(scope.mediaAssets.get(LOCAL.userId, assetId) as MediaAsset), sizeBytes }));
    setSize(free - floor + 1);
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("disk_low");
    setSize(free - floor);
    expect((await service.burn(LOCAL, fixture.contentId, body)).status).toBe(202);
  });

  it("refuses without an available video, and reports an inspection failure as it comes", async () => {
    const { h, service, source, inspected } = setup();
    const { fixture, assetId, body } = styled(h);
    source.inspection = amberError("internal", "ffprobe exited with 1", { code: "internal.tool_failed" });
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("internal.tool_failed");
    h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...(scope.mediaAssets.get(LOCAL.userId, assetId) as MediaAsset), availability: "missing" }));
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("media_missing");
    // Revisions are checked before anything is inspected.
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { ...body, revisionId: "nope" }))).toBe("not_found");
    expect(inspected).toHaveLength(1);
  });
});

describe("ClientMediaTaskService.inspectCacheMedia", () => {
  const inspect = (service: ClientMediaTaskService, contentId: string, body: Parameters<ClientMediaTaskService["inspectCacheMedia"]>[2] = {}) =>
    service.inspectCacheMedia(LOCAL, contentId, body, new AbortController().signal);

  it("estimates the file, lists what it replaces and the Content's caches, probing unverified ones, in the foreground heavy slot", async () => {
    const { h, service, heavyRuns, inspected } = setup();
    const calls = videoFormat(h, { height: 720, sizeBytes: 1000 });
    const contentId = platformContent(h, { title: "T" });
    const same = addCache(h, contentId, "media/T [720P].webm", { quality: "720", qualityVerified: true, sizeBytes: 7, createdAt: 3 });
    // An earlier build's row: the probe reads 720 from the file.
    const legacy = addCache(h, contentId, "media/T.mp4", { quality: "1080", sizeBytes: 8, createdAt: 2 });
    const audio = addCache(h, contentId, "media/T.mp3", { sizeBytes: 9, createdAt: 4 });
    const answer = await inspect(service, contentId, { quality: 720 });
    // A chosen tier is asked for exactly.
    expect(calls).toEqual(["tier:720"]);
    expect(heavyRuns).toEqual([`foreground:${LOCAL.userId}`]);
    expect(inspected).toEqual([join(h.dir, "media", "T.mp4")]);
    expect(answer).toMatchObject({
      expected: { type: "video", height: 720, ext: "mp4", sizeBytes: 1000 },
      expectedFileName: "T [720P].mp4",
      foreignFile: false,
      pendingName: false,
      recoveryHold: false,
      disk: { ok: true },
    });
    expect(answer.overwrite).toBeUndefined();
    expect(answer.disk.data).toBeUndefined();
    expect(answer.replaces.map((entry) => entry.assetId).sort()).toEqual([same.id, legacy.id].sort());
    expect(answer.caches).toEqual([
      { assetId: legacy.id, type: "video", height: 720, verified: true, fileName: "T.mp4", sizeBytes: 8, createdAt: 2 },
      { assetId: same.id, type: "video", height: 720, verified: true, fileName: "T [720P].webm", sizeBytes: 7, createdAt: 3 },
      { assetId: audio.id, type: "audio", verified: true, fileName: "T.mp3", sizeBytes: 9, createdAt: 4 },
    ]);
  });

  it("reports whole-byte low-water marks when a ratio of the volume is kept free", async () => {
    // An instance upgraded with the earlier ratio default keeps 0.2; 0.2 of a real volume size is fractional.
    const { h, service, cache } = setup();
    h.settings.patch(LOCAL, { lowWaterFreeRatio: 0.2 });
    cache.usage.usage = { usedBytes: 0, freeBytes: 500 * BYTES_PER_GB, totalBytes: 1_099_511_627_779 };
    videoFormat(h, { height: 720, sizeBytes: 1000 });
    const answer = await inspect(service, platformContent(h, { title: "T" }), { quality: 720 });
    expect(answer.disk.cache.lowWaterBytes).toBe(219_902_325_556);
    expect(cacheMediaInspectDtoSchema.safeParse(answer).success).toBe(true);
  });

  it("shows an unknown height as [?P] and a source without picture as audio with both volumes", async () => {
    const { h, service } = setup();
    videoFormat(h, {});
    const contentId = platformContent(h, { title: "T" });
    expect(await inspect(service, contentId)).toMatchObject({ expected: { type: "video", ext: "mp4" }, expectedFileName: "T [?P].mp4", replaces: [] });
    const calls = videoFormat(h, { hasVideo: false }, 500);
    const audio = await inspect(service, contentId);
    expect(calls).toEqual([`video:${CACHE_MEDIA_MAX_HEIGHT}`, "audio"]);
    expect(audio).toMatchObject({ expected: { type: "audio", ext: "mp3" }, expectedFileName: "T.mp3" });
    expect(audio.disk.data).toBeDefined();
  });

  it("asks the format check for the chosen tier exactly, and for the default cap without one", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "T" });
    const calls = videoFormat(h, { height: 480 });
    await inspect(service, contentId, { quality: 480 });
    await inspect(service, contentId, {});
    await inspect(service, contentId, { quality: 1440 });
    expect(calls).toEqual(["tier:480", `video:${CACHE_MEDIA_MAX_HEIGHT}`, "tier:1440"]);
  });

  it("reports a pending name held by another Content's unfinished v4 cache Task", async () => {
    const { h, service } = setup();
    videoFormat(h, { height: 480 });
    const contentId = platformContent(h, { title: "T" });
    createTaskOfKind(h, "cache_media", { requestSchemaVersion: 4, type: "video", quality: 480, stem: "T", assetId: h.newId() }, { contentId: platformContent(h, { title: "x" }) });
    expect(await inspect(service, contentId, { quality: 480 })).toMatchObject({ pendingName: true });
  });

  it("reports a foreign file, a pending name, a held path and a volume without room", async () => {
    const { h, service, cacheDir, holds, cache } = setup();
    videoFormat(h, { height: 1080 });
    const contentId = platformContent(h, { title: "T" });
    writeFileSync(join(cacheDir, "T [1080P].mp4"), "the user's own");
    const other = platformContent(h, { title: "x" });
    createTaskOfKind(h, "cache_media", { requestSchemaVersion: 3, type: "video", quality: 1080, stem: "T", assetId: h.newId() }, { contentId: other });
    holds.add({ scratchId: "01HELD", record: { v: 1, targetRef: "media/T [1080P].mp4", newAssetId: "01HELD", newSizeBytes: 1, newDigest: "sha256:x" } });
    cache.usage.low();
    expect(await inspect(service, contentId)).toMatchObject({ foreignFile: true, pendingName: true, recoveryHold: true, disk: { ok: false } });
  });

  it("refuses local and unknown Contents and an unmounted cache root", async () => {
    const { h, service, cache } = setup();
    expect(await codeOf(inspect(service, createLocalContent(h)))).toBe("invalid_request");
    expect(await codeOf(inspect(service, "nope"))).toBe("not_found");
    cache.available = false;
    expect(await codeOf(inspect(service, platformContent(h)))).toBe("conflict.cache_unavailable");
  });
});

describe("ClientMediaTaskService.listCacheQualities", () => {
  type Qualities = Awaited<ReturnType<NonNullable<PlatformSourceAdapter["listVideoQualities"]>>>;
  const list = (service: ClientMediaTaskService, contentId: string, signal = new AbortController().signal) => service.listCacheQualities(LOCAL, contentId, signal);
  /** What the YouTube adapter's quality list answers. */
  const qualities = (h: Harness, answer: Qualities | (() => Promise<Qualities>)): void => {
    const listVideoQualities: NonNullable<PlatformSourceAdapter["listVideoQualities"]> = async () => (typeof answer === "function" ? answer() : answer);
    Object.assign(h.platforms.youtube, { listVideoQualities });
  };

  it("answers the adapter's tiers with the picture size of their stream, in the foreground heavy slot", async () => {
    const { h, service, heavyRuns } = setup();
    // An ultra-wide source: each tier downloads a picture lower than its name.
    qualities(h, [
      { tier: 360, width: 640, height: 206 },
      { tier: 480, width: 854, height: 274 },
      { tier: 720, width: 1280, height: 410 },
    ]);
    const answer = await list(service, platformContent(h));
    expect(answer).toEqual({
      status: "available",
      qualities: [
        { tier: 360, width: 640, height: 206 },
        { tier: 480, width: 854, height: 274 },
        { tier: 720, width: 1280, height: 410 },
      ],
    });
    expect(Object.keys(answer).sort()).toEqual(["qualities", "status"]);
    expect(cacheMediaQualitiesDtoSchema.safeParse(answer).success).toBe(true);
    expect(heavyRuns).toEqual([`foreground:${LOCAL.userId}`]);
  });

  it("sorts by tier, keeps one entry per tier and leaves out tiers beyond the set", async () => {
    const { h, service } = setup();
    qualities(h, [
      { tier: 1080, width: 1080, height: 1920 },
      { tier: 720, width: 1280, height: 720 },
      { tier: 9000, width: 16000, height: 9000 },
      { tier: 720, width: 1280, height: 714 },
      { tier: 600, width: 600, height: 600 },
      { tier: 240, width: 426, height: 240 },
    ]);
    const answer = await list(service, platformContent(h));
    expect(answer).toEqual({
      status: "available",
      qualities: [
        { tier: 240, width: 426, height: 240 },
        { tier: 720, width: 1280, height: 720 },
        { tier: 1080, width: 1080, height: 1920 },
      ],
    });
    expect(cacheMediaQualitiesDtoSchema.safeParse(answer).success).toBe(true);
  });

  it("tells a source without usable video streams apart from one without a format list", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h);
    qualities(h, []);
    expect(await list(service, contentId)).toEqual({ status: "audio_only", qualities: [] });
    // Only tiers beyond the set: nothing the dialog could offer.
    qualities(h, [{ tier: 9000, width: 16000, height: 9000 }]);
    expect(await list(service, contentId)).toEqual({ status: "audio_only", qualities: [] });
    qualities(h, undefined);
    expect(await list(service, contentId)).toEqual({ status: "unknown", qualities: [] });
  });

  it("does not need the cache root, and passes a yt-dlp failure on as is", async () => {
    const { h, service, cache } = setup();
    cache.available = false;
    const contentId = platformContent(h);
    qualities(h, [{ tier: 480, width: 854, height: 480 }]);
    expect(await list(service, contentId)).toEqual({ status: "available", qualities: [{ tier: 480, width: 854, height: 480 }] });
    qualities(h, () => Promise.reject(amberError("source_unreachable", "yt-dlp timed out")));
    expect(await codeOf(list(service, contentId))).toBe("source_unreachable");
  });

  it("refuses local, unknown and foreign Contents, and an adapter that cannot list qualities", async () => {
    const { h, service } = setup();
    expect(await codeOf(list(service, createLocalContent(h)))).toBe("invalid_request");
    expect(await codeOf(list(service, "nope"))).toBe("not_found");
    expect(await codeOf(list(service, platformContent(h, { userId: BOB.userId })))).toBe("not_found");
    expect(typeof (h.platforms.youtube as Partial<PlatformSourceAdapter>).listVideoQualities).toBe("undefined");
    expect(await codeOf(list(service, platformContent(h)))).toBe("internal");
  });

  it("frees the foreground slot when the probe is aborted, so the inspection waiting behind it runs", async () => {
    const { h, service, heavyRuns } = setup();
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const listVideoQualities: NonNullable<PlatformSourceAdapter["listVideoQualities"]> = (_ref, _auth, signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    Object.assign(h.platforms.youtube, { listVideoQualities });
    videoFormat(h, { height: 720 });
    const contentId = platformContent(h, { title: "T" });
    const probe = list(service, contentId, controller.signal);
    await running;
    let inspected = false;
    const inspection = service.inspectCacheMedia(LOCAL, contentId, { quality: 720 }, new AbortController().signal).then((answer) => {
      inspected = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inspected).toBe(false);
    controller.abort();
    await expect(probe).rejects.toThrow("aborted");
    expect((await inspection).expected).toMatchObject({ type: "video", height: 720 });
    expect(heavyRuns).toEqual([`foreground:${LOCAL.userId}`, `foreground:${LOCAL.userId}`]);
  });
});

describe("ClientMediaTaskService.burn, source video", () => {
  const style = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };

  function withCaches(h: Harness) {
    const fixture = seedExportContent(h, LOCAL.userId);
    const p720 = addCache(h, fixture.contentId, "media/a [720P].mp4", { quality: "720", qualityVerified: true, fingerprint: "sha256:720", createdAt: 5 });
    const p1080 = addCache(h, fixture.contentId, "media/a [1080P].mp4", { quality: "1080", qualityVerified: true, fingerprint: "sha256:1080", createdAt: 1 });
    const audio = addCache(h, fixture.contentId, "media/a.mp3", { fingerprint: "sha256:mp3" });
    const body = { mode: "original" as const, revisionId: fixture.asr.revision.id, delivery: "hard" as const, container: "mp4" as const, style };
    return { fixture, p720, p1080, audio, body };
  }

  const sourceOf = (h: Harness, taskId: string) => (JSON.parse(taskOf(h, taskId).requestJson) as { source: unknown }).source;

  it("defaults to the highest cached quality and takes the user's pick of a video cache", async () => {
    const { h, service } = setup();
    const { fixture, p720, p1080, body } = withCaches(h);
    const highest = await service.burn(LOCAL, fixture.contentId, body);
    expect(sourceOf(h, highest.body.taskId)).toEqual({ assetId: p1080.id, fingerprint: "sha256:1080" });
    finishTasks(h, fixture.contentId);
    const picked = await service.burn(LOCAL, fixture.contentId, { ...body, sourceAssetId: p720.id });
    expect(sourceOf(h, picked.body.taskId)).toEqual({ assetId: p720.id, fingerprint: "sha256:720" });
  });

  it("takes the user's pick of the Content's original, uploaded or linked, and freezes it with its fingerprint", async () => {
    const { h, service, inspected } = setup();
    const uploaded = seedExportContent(h, LOCAL.userId, "local");
    const upload = addCache(h, uploaded.contentId, `assets/${LOCAL.userId}/${uploaded.contentId}/upload`, {
      kind: "managed_upload",
      mimeType: "video/mp4",
      retentionPolicy: "keep",
      fingerprint: "sha256:upload",
    });
    const fromUpload = await service.burn(LOCAL, uploaded.contentId, { mode: "original", revisionId: uploaded.asr.revision.id, delivery: "hard", container: "mp4", style, sourceAssetId: upload.id });
    expect(fromUpload.status).toBe(202);
    expect(sourceOf(h, fromUpload.body.taskId)).toEqual({ assetId: upload.id, fingerprint: "sha256:upload" });
    expect(inspected).toEqual([join(h.dir, upload.storageRef)]);

    // A platform Content with video caches and a linked original file: the pick is the original.
    const { fixture, body } = withCaches(h);
    const linked = addCache(h, fixture.contentId, "/media/lecture.mp4", { kind: "external_local", retentionPolicy: "keep", fingerprint: "sha256:linked" });
    const fromLinked = await service.burn(LOCAL, fixture.contentId, { ...body, sourceAssetId: linked.id });
    expect(fromLinked.status).toBe(202);
    expect(sourceOf(h, fromLinked.body.taskId)).toEqual({ assetId: linked.id, fingerprint: "sha256:linked" });
    // A linked file is read where it lives.
    expect(inspected.at(-1)).toBe("/media/lecture.mp4");
  });

  it("refuses an audio cache, another Content's asset or an unknown id, and a source no longer available", async () => {
    const { h, service } = setup();
    const { fixture, p720, audio, body } = withCaches(h);
    const elsewhere = addCache(h, platformContent(h, { title: "other" }), "media/b [720P].mp4", { quality: "720", qualityVerified: true, fingerprint: "sha256:b" });
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { ...body, sourceAssetId: audio.id }))).toBe("invalid_request");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { ...body, sourceAssetId: elsewhere.id }))).toBe("invalid_request");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { ...body, sourceAssetId: "nope" }))).toBe("invalid_request");
    h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...p720, availability: "evicted" }));
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { ...body, sourceAssetId: p720.id }))).toBe("media_missing");
  });
});
