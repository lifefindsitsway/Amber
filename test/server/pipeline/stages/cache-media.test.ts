import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyYtDlpFailure } from "../../../../src/server/adapters/platform/yt-dlp.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import { CacheDownloadLedger } from "../../../../src/server/pipeline/cache-download-ledger.ts";
import { CacheHoldRegistry } from "../../../../src/server/pipeline/cache-holds.ts";
import { CachePathLocks } from "../../../../src/server/pipeline/cache-path-locks.ts";
import { SWAP_RECORD_FILE } from "../../../../src/server/pipeline/cache-swap.ts";
import { latestAttempts } from "../../../../src/server/pipeline/projection.ts";
import { audioReservation, CacheMediaStageExecutor, mp3EstimateBytes, videoReservation } from "../../../../src/server/pipeline/stages/cache-media.ts";
import type { CacheFileStore } from "../../../../src/server/pipeline/media-files.ts";
import type { LocalMediaIngest } from "../../../../src/server/ports/local-media-ingest.ts";
import type { PlatformSourceAdapter, VideoTarget } from "../../../../src/server/ports/platform-source.ts";
import type { MediaInspection, SubtitleMuxer } from "../../../../src/server/ports/subtitle-muxer.ts";
import type { FileStore } from "../../../../src/server/ports/file-store.ts";
import {
  CACHE_AUDIO_MP3_KBPS,
  CACHE_DOWNLOAD_PEAK_FACTOR,
  CACHE_MEDIA_MAX_HEIGHT,
  CACHE_UNKNOWN_SIZE_RESERVE_GB,
  LOW_WATER_FREE_GB,
} from "../../../../src/shared/defaults.ts";
import { BYTES_PER_GB } from "../../../../src/shared/units.ts";
import { BOB, createTaskOfKind, LOCAL, stageRunsOf, taskOf, waitFor, workUnitsOf } from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

const GB = BYTES_PER_GB;
const MP3_BYTES = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(30, 2)]);

type FetchVideo = NonNullable<PlatformSourceAdapter["fetchVideo"]>;
type InspectVideo = NonNullable<PlatformSourceAdapter["inspectVideo"]>;
type Usage = { usedBytes: number; freeBytes: number; totalBytes: number };
/** How a call asked for the video, recorded as the field it carried. */
const targetOf = (target: VideoTarget): { maxHeight: number } | { tier: number } => ("tier" in target ? { tier: target.tier } : { maxHeight: target.maxHeight });
/** A volume far above any low-water mark, for tests that are not about the disk budget. */
const AMPLE_USAGE: Usage = { usedBytes: 0, freeBytes: 1000 * GB, totalBytes: 2000 * GB };

/**
 * What the fake ffprobe reads from a fake download: the file starts with a JSON line that
 * describes the streams, followed by `salt` so two downloads of one quality differ.
 */
interface FakeMedia {
  container?: string;
  height?: number;
  /** Defaults to the height. */
  width?: number;
  video?: boolean;
  salt?: string;
}

function mediaBytes(media: FakeMedia = {}): Buffer {
  return Buffer.from(`${JSON.stringify({ container: "mov,mp4,m4a,3gp,3g2,mj2", video: true, ...media })}\n${media.salt ?? "body"}`);
}

const fakeMuxer: Pick<SubtitleMuxer, "inspect"> = {
  async inspect(path) {
    const text = await readFile(path, "utf8");
    const media = JSON.parse(text.slice(0, text.indexOf("\n"))) as FakeMedia;
    const streams: MediaInspection["streams"] = [{ index: 0, type: "video", codec: "mjpeg", attachedPic: true, height: 90 }];
    if (media.video !== false) {
      streams.push({ index: 1, type: "video", codec: "h264", ...(media.height === undefined ? {} : { height: media.height, width: media.width ?? media.height }) });
    }
    streams.push({ index: 2, type: "audio", codec: "aac" });
    return { container: media.container ?? "", streams };
  },
};

function digestOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface SetupOptions {
  durationMs?: number;
  sameVolume?: boolean;
  dataUsage?: () => Usage;
  cacheUsage?: () => Usage;
  diskCheckIntervalMs?: number;
  /** Replaces methods of the cache store, e.g. to make a rename fail. */
  cacheOverrides?: Partial<Record<keyof CacheFileStore, unknown>>;
  recoverSwaps?: () => Promise<void>;
}

function setup(options: SetupOptions = {}) {
  let stack: MediaStack | undefined;
  const transcodes: Array<{ input: string; output: string; bitrateKbps: number }> = [];
  const ingest: Pick<LocalMediaIngest, "transcodeAudio"> = {
    async transcodeAudio(input, output, opts, onProgress) {
      transcodes.push({ input: input.path, output: output.path, bitrateKbps: opts.bitrateKbps });
      // The downloaded track is still there while it is transcoded.
      expect(existsSync(input.path)).toBe(true);
      onProgress(0.5);
      await writeFile(output.path, MP3_BYTES);
      onProgress(1);
      return { sizeBytes: MP3_BYTES.length };
    },
  };
  const ledger = new CacheDownloadLedger();
  const locks = new CachePathLocks();
  const holds = new CacheHoldRegistry();
  const withUsage = <T extends FileStore>(store: T, usage: () => Usage, overrides: object = {}): T =>
    Object.assign(Object.create(store) as T, { diskUsage: async () => usage() }, overrides);
  const executor = new CacheMediaStageExecutor({
    get repository() {
      return (stack as MediaStack).h.repository;
    },
    get media() {
      const stores = (stack as MediaStack).stores;
      // Volumes are always simulated: the real machine's free space must not decide a test.
      return {
        data: withUsage(stores.data, options.dataUsage ?? (() => AMPLE_USAGE)),
        cache: withUsage(stores.cache, options.cacheUsage ?? (() => AMPLE_USAGE), options.cacheOverrides),
      };
    },
    get platforms() {
      return (stack as MediaStack).h.platformAccess;
    },
    get settings() {
      return (stack as MediaStack).h.settings;
    },
    ingest,
    muxer: fakeMuxer,
    sameVolume: () => options.sameVolume ?? true,
    ledger,
    locks,
    holds,
    ...(options.diskCheckIntervalMs === undefined ? {} : { diskCheckIntervalMs: options.diskCheckIntervalMs }),
    ...(options.recoverSwaps === undefined ? {} : { recoverSwaps: options.recoverSwaps }),
  });
  stack = createMediaStack({ executors: { cache_media: executor } });
  open.push(stack);
  const contentId = addContent(stack, "BV1cache", options.durationMs);
  const adapter = stack.h.platforms.bilibili;
  const calls: Array<{ method: string; maxHeight?: number; tier?: number; maxBytes?: number }> = [];
  const fetchWith = (impl: FetchVideo) => {
    const fetchVideo: FetchVideo = async (ref, auth, opts, onProgress, signal) => {
      calls.push({ method: "fetchVideo", ...targetOf(opts), maxBytes: opts.maxBytes });
      return impl(ref, auth, opts, onProgress, signal);
    };
    Object.assign(adapter, { fetchVideo });
  };
  const inspectWith = (impl: InspectVideo) => {
    const inspectVideo: InspectVideo = async (ref, auth, opts, signal) => {
      calls.push({ method: "inspectVideo", ...targetOf(opts) });
      return impl(ref, auth, opts, signal);
    };
    Object.assign(adapter, { inspectVideo });
  };
  /** A platform whose format check expects `expected` and whose download writes `delivered`. */
  const videoSource = (expected: { height?: number; sizeBytes?: number; mimeType?: string }, delivered: FakeMedia) => {
    inspectWith(async () => ({ hasVideo: true, mimeType: expected.mimeType ?? "video/mp4", ...expected }));
    fetchWith(async (_ref, _auth, opts, onProgress) => {
      onProgress(0.5);
      await writeFile(opts.output.path, mediaBytes(delivered));
      return { sizeBytes: mediaBytes(delivered).length, mimeType: "video/mp4", acquisition: "guest" };
    });
  };
  const audioWith = (announced: number | undefined, body = Buffer.from("raw audio track")) => {
    Object.assign(adapter, {
      inspectAudio: async () => {
        calls.push({ method: "inspectAudio" });
        return announced === undefined ? {} : { sizeBytes: announced };
      },
      fetchAudio: async (_ref: unknown, _auth: unknown, output: { path: string }, onProgress: (progress: number) => void, _signal: AbortSignal, opts?: { maxBytes?: number }) => {
        calls.push({ method: "fetchAudio", ...(opts?.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }) });
        onProgress(0.5);
        await writeFile(output.path, body);
        onProgress(1);
        return { sizeBytes: body.length };
      },
    });
  };
  return { stack, contentId, calls, transcodes, fetchWith, inspectWith, videoSource, audioWith, ledger, locks, holds };
}

let contentCounter = 0;
function addContent(stack: MediaStack, platformContentId: string, durationMs?: number, title?: string): string {
  const id = stack.h.newId();
  contentCounter += 1;
  stack.h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id,
      userId: LOCAL.userId,
      source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${platformContentId}${contentCounter}`, platformContentId: `${platformContentId}${contentCounter}`, platformPartId: "cid-1" },
      ...(title === undefined ? {} : { title }),
      ...(durationMs === undefined ? {} : { durationMs }),
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return id;
}

let assetCounter = 0;
function nextAssetId(): string {
  assetCounter += 1;
  return `01CACHEASSET${String(assetCounter).padStart(14, "0")}`;
}

function cacheRequest(fields: Record<string, unknown> = {}) {
  return { requestSchemaVersion: 3, type: "video", quality: 1080, stem: "第 1 讲", assetId: nextAssetId(), ...fields };
}

async function runCache(stack: MediaStack, contentId: string, request: Record<string, unknown>): Promise<string> {
  const taskId = createTaskOfKind(stack.h, "cache_media", request, { contentId });
  stack.h.scheduler.start();
  stack.h.scheduler.kick();
  await waitFor(() => ["succeeded", "failed"].includes(taskOf(stack.h, taskId).statusProjection));
  return taskId;
}

const cachesOf = (stack: MediaStack, contentId: string): MediaAsset[] =>
  stack.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId)).filter((asset) => asset.kind === "platform_cache");

const assetOf = (stack: MediaStack, id: string): MediaAsset | undefined => stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, id));

function resultOf(stack: MediaStack, taskId: string): Record<string, unknown> {
  return JSON.parse(latestAttempts(stageRunsOf(stack.h, taskId))[0]?.resultJson ?? "{}") as Record<string, unknown>;
}

function errorOf(stack: MediaStack, taskId: string) {
  return latestAttempts(stageRunsOf(stack.h, taskId))[0]?.error;
}

/** Registers a cache row and writes its file; the row's fingerprint is the file's digest unless given. */
async function putCache(
  stack: MediaStack,
  contentId: string,
  fileName: string,
  bytes: Buffer,
  fields: Partial<MediaAsset> = {},
): Promise<MediaAsset> {
  const asset: MediaAsset = {
    id: stack.h.newId(),
    userId: LOCAL.userId,
    contentId,
    kind: "platform_cache",
    storageRef: `media/${fileName}`,
    mimeType: fileName.endsWith(".mp3") ? "audio/mpeg" : fileName.endsWith(".webm") ? "video/webm" : "video/mp4",
    sizeBytes: bytes.length,
    fingerprint: digestOf(bytes),
    availability: "available",
    retentionPolicy: "evictable",
    createdAt: 1,
    ...fields,
  };
  stack.h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  await mkdir(stack.stores.cache.directory(), { recursive: true });
  await writeFile(join(stack.stores.cache.directory(), fileName), bytes);
  return asset;
}

const cacheFiles = (stack: MediaStack): string[] => readdirSync(stack.stores.cache.directory()).sort();
const fileOf = (stack: MediaStack, fileName: string): Buffer => readFileSync(join(stack.stores.cache.directory(), fileName));

describe("CacheMediaStageExecutor: video", () => {
  it("names the file after the finished download's height, registers it verified and removes the scratch directory", async () => {
    const { stack, contentId, calls, videoSource } = setup();
    videoSource({ height: 720, sizeBytes: 100 }, { height: 720 });
    const request = cacheRequest({ quality: 720 });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(resultOf(stack, taskId)).toEqual({
      assetId: request.assetId,
      fileName: "第 1 讲 [720P].mp4",
      requestedType: "video",
      actualType: "video",
      height: 720,
      replaced: [],
      evicted: [],
    });
    expect(assetOf(stack, request.assetId)).toMatchObject({
      storageRef: "media/第 1 讲 [720P].mp4",
      displayName: "第 1 讲 [720P].mp4",
      mimeType: "video/mp4",
      quality: "720",
      qualityVerified: true,
      fingerprint: digestOf(mediaBytes({ height: 720 })),
      sizeBytes: mediaBytes({ height: 720 }).length,
      acquisition: "guest",
      availability: "available",
    });
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4"]);
    // The budget allows the room above the low-water mark, divided by the peak factor.
    const available = AMPLE_USAGE.freeBytes - LOW_WATER_FREE_GB * GB;
    expect(calls).toEqual([
      { method: "inspectVideo", maxHeight: 720 },
      { method: "fetchVideo", maxHeight: 720, maxBytes: Math.floor(available / CACHE_DOWNLOAD_PEAK_FACTOR) },
    ]);
  });

  it("keeps 720p and 1080p of one Content side by side", async () => {
    const { stack, contentId, inspectWith, fetchWith } = setup();
    let height = 720;
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4", height }));
    fetchWith(async (_ref, _auth, opts) => {
      await writeFile(opts.output.path, mediaBytes({ height }));
      return { sizeBytes: 1, mimeType: "video/mp4", acquisition: "guest" };
    });
    const first = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    height = 1080;
    const second = await runCache(stack, contentId, cacheRequest({ quality: 1080 }));
    expect([taskOf(stack.h, first).statusProjection, taskOf(stack.h, second).statusProjection]).toEqual(["succeeded", "succeeded"]);
    expect(cachesOf(stack, contentId).map((asset) => [asset.storageRef, asset.quality, asset.availability])).toEqual([
      ["media/第 1 讲 [720P].mp4", "720", "available"],
      ["media/第 1 讲 [1080P].mp4", "1080", "available"],
    ]);
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [1080P].mp4", "第 1 讲 [720P].mp4"]);
  });

  it("replaces the same quality at the same name, in another container and under a legacy unlabelled name, never numbering", async () => {
    const { stack, contentId, videoSource } = setup();
    const sameName = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "old" }), { quality: "720", qualityVerified: true });
    const otherContainer = await putCache(stack, contentId, "第 1 讲 [720P].webm", mediaBytes({ height: 720, container: "matroska,webm", salt: "webm" }), {
      quality: "720",
      qualityVerified: true,
    });
    // An earlier build recorded the cap, not the height; the file says 720.
    const legacy = await putCache(stack, contentId, "第 1 讲.mp4", mediaBytes({ height: 720, salt: "legacy" }), { quality: "1080" });
    // An earlier candidate build named and recorded the encoded height; its tier is 720.
    const encoded = await putCache(stack, contentId, "第 1 讲 [714p].mp4", mediaBytes({ height: 714, salt: "encoded" }), { quality: "714", qualityVerified: true });
    const other = await putCache(stack, contentId, "第 1 讲 [1080P].mp4", mediaBytes({ height: 1080 }), { quality: "1080", qualityVerified: true });
    videoSource({ height: 720 }, { height: 720, salt: "new" });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect((resultOf(stack, taskId)["replaced"] as string[]).sort()).toEqual([sameName.id, otherContainer.id, legacy.id, encoded.id].sort());
    expect(assetOf(stack, encoded.id)).toMatchObject({ availability: "evicted", quality: "720", qualityVerified: true });
    expect(assetOf(stack, sameName.id)?.availability).toBe("evicted");
    expect(assetOf(stack, otherContainer.id)?.availability).toBe("evicted");
    expect(assetOf(stack, legacy.id)).toMatchObject({ availability: "evicted", quality: "720", qualityVerified: true });
    expect(assetOf(stack, other.id)?.availability).toBe("available");
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [1080P].mp4", "第 1 讲 [720P].mp4"]);
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ height: 720, salt: "new" }));
    // One available row per path, always.
    const atPath = cachesOf(stack, contentId).filter((asset) => asset.storageRef === "media/第 1 讲 [720P].mp4" && asset.availability === "available");
    expect(atPath).toHaveLength(1);
  });

  it("leaves a replaced cache's old file that changed since it was registered", async () => {
    const { stack, contentId, videoSource } = setup();
    const changed = await putCache(stack, contentId, "第 1 讲 [720P].webm", mediaBytes({ height: 720, salt: "a" }), { quality: "720", qualityVerified: true });
    await writeFile(join(stack.stores.cache.directory(), "第 1 讲 [720P].webm"), mediaBytes({ height: 720, salt: "b" }));
    videoSource({ height: 720 }, { height: 720 });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(assetOf(stack, changed.id)?.availability).toBe("evicted");
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4", "第 1 讲 [720P].webm"]);
  });

  it("names the file after what was downloaded, not the estimate, and reports a height above the cap", async () => {
    const { stack, contentId, videoSource } = setup();
    videoSource({ height: 720 }, { height: 1080, container: "matroska,webm" });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720, expectedHeight: 720 }));
    expect(resultOf(stack, taskId)).toMatchObject({ fileName: "第 1 讲 [1080P].webm", height: 1080, aboveRequested: true });
    expect(cachesOf(stack, contentId)[0]).toMatchObject({ mimeType: "video/webm", quality: "1080" });
  });

  it("labels the file with the quality tier of its picture and measures it against the cap by that tier", async () => {
    // A picture a few lines short of a tier, as platforms encode it, carries the tier's name.
    const near = setup();
    near.videoSource({ height: 720 }, { width: 1280, height: 714 });
    const nearRun = await runCache(near.stack, near.contentId, cacheRequest({ quality: 720 }));
    expect(resultOf(near.stack, nearRun)).toMatchObject({ fileName: "第 1 讲 [720P].mp4", height: 720 });
    expect(resultOf(near.stack, nearRun)["aboveRequested"]).toBeUndefined();

    // Portrait: the tier follows the short side, so it fits the cap it was asked for.
    const fits = setup();
    fits.videoSource({ height: 1080 }, { width: 1080, height: 1920 });
    const fitting = await runCache(fits.stack, fits.contentId, cacheRequest({ quality: 1080 }));
    expect(resultOf(fits.stack, fitting)).toMatchObject({ fileName: "第 1 讲 [1080P].mp4", height: 1080 });
    expect(resultOf(fits.stack, fitting)["aboveRequested"]).toBeUndefined();

    const above = setup();
    above.videoSource({ height: 1080 }, { width: 1440, height: 2560 });
    const larger = await runCache(above.stack, above.contentId, cacheRequest({ quality: 1080 }));
    expect(resultOf(above.stack, larger)).toMatchObject({ fileName: "第 1 讲 [1440P].mp4", aboveRequested: true });
  });

  it("settles interrupted replacements before downloading, and fails without downloading when that cannot run", async () => {
    let recoveries = 0;
    let refuse = false;
    const { stack, contentId, calls, videoSource } = setup({
      recoverSwaps: async () => {
        recoveries += 1;
        if (refuse) throw amberError("conflict", "recovery could not run", { code: "conflict.cache_recovery_pending" });
      },
    });
    videoSource({ height: 720 }, { height: 720 });
    expect(taskOf(stack.h, await runCache(stack, contentId, cacheRequest({ quality: 720 }))).statusProjection).toBe("succeeded");
    expect(recoveries).toBe(1);
    refuse = true;
    calls.length = 0;
    const refused = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(errorOf(stack, refused)?.code).toBe("conflict.cache_recovery_pending");
    expect(calls).toEqual([]);
  });

  it("fails with cache_request_outdated when the source or the download has no picture, and with cache_probe_failed without a height", async () => {
    const noPicture = setup();
    noPicture.videoSource({}, {});
    noPicture.inspectWith(async () => ({ hasVideo: false }));
    const outdatedSource = await runCache(noPicture.stack, noPicture.contentId, cacheRequest());
    expect(errorOf(noPicture.stack, outdatedSource)?.code).toBe("invalid_request.cache_request_outdated");
    expect(noPicture.calls.map((call) => call.method)).toEqual(["inspectVideo"]);

    const audioOnly = setup();
    audioOnly.videoSource({ height: 720 }, { video: false });
    const outdatedFile = await runCache(audioOnly.stack, audioOnly.contentId, cacheRequest());
    expect(errorOf(audioOnly.stack, outdatedFile)?.code).toBe("invalid_request.cache_request_outdated");
    expect(cacheFiles(audioOnly.stack)).toEqual([]);

    const noHeight = setup();
    noHeight.videoSource({}, {});
    const probeFailed = await runCache(noHeight.stack, noHeight.contentId, cacheRequest());
    expect(errorOf(noHeight.stack, probeFailed)?.code).toBe("invalid_request.cache_probe_failed");
    expect(cachesOf(noHeight.stack, noHeight.contentId)).toEqual([]);
    expect(cacheFiles(noHeight.stack)).toEqual([]);
  });

  it("refuses another Content's cache at the name without confirmation, with the holder in the details", async () => {
    const { stack, contentId, videoSource } = setup();
    const otherContent = addContent(stack, "BVother", undefined, "另一个视频");
    const held = await putCache(stack, otherContent, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "theirs" }), { quality: "720", qualityVerified: true });
    videoSource({ height: 720 }, { height: 720 });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(errorOf(stack, taskId)).toMatchObject({
      code: "conflict.cache_name_taken",
      details: { fileName: "第 1 讲 [720P].mp4", holderContentId: otherContent, holderTitle: "另一个视频", actualHeight: 720 },
    });
    expect(assetOf(stack, held.id)?.availability).toBe("available");
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ height: 720, salt: "theirs" }));
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4"]);
  });

  it("replaces another Content's cache the user confirmed, after checking its digest", async () => {
    const { stack, contentId, videoSource } = setup();
    const otherContent = addContent(stack, "BVother");
    const held = await putCache(stack, otherContent, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "theirs" }), { quality: "720", qualityVerified: true });
    videoSource({ height: 720 }, { height: 720, salt: "mine" });
    const request = cacheRequest({ quality: 720, overwrite: { assetId: held.id, fileName: "第 1 讲 [720P].mp4" } });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(resultOf(stack, taskId)["replaced"]).toEqual([held.id]);
    expect(assetOf(stack, held.id)?.availability).toBe("evicted");
    expect(assetOf(stack, request.assetId as string)?.availability).toBe("available");
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ height: 720, salt: "mine" }));
  });

  it("refuses a confirmed overwrite whose file no longer matches its row, and a file nobody registered", async () => {
    const { stack, contentId, videoSource } = setup();
    const otherContent = addContent(stack, "BVother");
    const held = await putCache(stack, otherContent, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "theirs" }), { quality: "720", qualityVerified: true });
    // Same size, different content.
    await writeFile(join(stack.stores.cache.directory(), "第 1 讲 [720P].mp4"), mediaBytes({ height: 720, salt: "THEIRS" }));
    videoSource({ height: 720 }, { height: 720 });
    const changed = await runCache(stack, contentId, cacheRequest({ quality: 720, overwrite: { assetId: held.id, fileName: "第 1 讲 [720P].mp4" } }));
    expect(errorOf(stack, changed)?.code).toBe("conflict.cache_file_foreign");
    expect(assetOf(stack, held.id)?.availability).toBe("available");
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ height: 720, salt: "THEIRS" }));

    await writeFile(join(stack.stores.cache.directory(), "第 1 讲 [1080P].mp4"), Buffer.from("the user's own"));
    videoSource({ height: 1080 }, { height: 1080 });
    const foreign = await runCache(stack, contentId, cacheRequest());
    expect(errorOf(stack, foreign)?.code).toBe("conflict.cache_file_foreign");
    expect(fileOf(stack, "第 1 讲 [1080P].mp4").toString()).toBe("the user's own");
    expect(cachesOf(stack, contentId)).toEqual([]);
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [1080P].mp4", "第 1 讲 [720P].mp4"]);
  });

  it("refuses this Content's cache whose row has no fingerprint, keeping it", async () => {
    const { stack, contentId, videoSource } = setup();
    const unverifiable = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "old" }), { quality: "720", qualityVerified: true });
    stack.h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...unverifiable, fingerprint: "" }));
    videoSource({ height: 720 }, { height: 720 });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(errorOf(stack, taskId)?.code).toBe("conflict.cache_file_foreign");
    expect(assetOf(stack, unverifiable.id)?.availability).toBe("available");
  });

  it("reuses the name of an evicted cache whose leftover file is still there", async () => {
    const { stack, contentId, videoSource } = setup();
    const leftover = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "old" }), {
      quality: "720",
      qualityVerified: true,
      availability: "evicted",
    });
    videoSource({ height: 720 }, { height: 720, salt: "new" });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(assetOf(stack, leftover.id)?.availability).toBe("evicted");
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ height: 720, salt: "new" }));
  });

  it("fails with cache_file_busy when the file to replace is held open, changing nothing", async () => {
    const busy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    const { stack, contentId, videoSource } = setup({
      cacheOverrides: {
        moveOut: async () => {
          throw busy;
        },
      },
    });
    const old = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "old" }), { quality: "720", qualityVerified: true });
    videoSource({ height: 720 }, { height: 720, salt: "new" });
    const request = cacheRequest({ quality: 720 });
    const taskId = await runCache(stack, contentId, request);
    expect(errorOf(stack, taskId)?.code).toBe("conflict.cache_file_busy");
    expect(assetOf(stack, old.id)?.availability).toBe("available");
    expect(assetOf(stack, request.assetId as string)).toBeUndefined();
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ height: 720, salt: "old" }));
    // Neither the record nor the download stays behind.
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4"]);
  });

  it("moves both files back when registering fails after the swap", async () => {
    const { stack, contentId, videoSource } = setup();
    const old = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "old" }), { quality: "720", qualityVerified: true });
    videoSource({ height: 720 }, { height: 720, salt: "new" });
    const request = cacheRequest({ quality: 720 });
    // Another user's row already has the asset id: the registering insert fails.
    const bobContent = stack.h.newId();
    stack.h.repository.withTransaction((scope) => {
      scope.contents.insert({ id: bobContent, userId: BOB.userId, source: { kind: "local" }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 });
      scope.mediaAssets.insert({
        id: request.assetId as string,
        userId: BOB.userId,
        contentId: bobContent,
        kind: "managed_upload",
        storageRef: "assets/bob/x/y",
        mimeType: "video/mp4",
        sizeBytes: 1,
        availability: "available",
        retentionPolicy: "keep",
        createdAt: 1,
      });
    });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    expect(assetOf(stack, old.id)?.availability).toBe("available");
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ height: 720, salt: "old" }));
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4"]);
  });

  it("refuses to publish to a path whose interrupted replacement waits for the user", async () => {
    const { stack, contentId, videoSource, holds } = setup();
    holds.add({
      scratchId: "01HELD",
      record: { v: 1, targetRef: "media/第 1 讲 [720P].mp4", newAssetId: "01HELD", newSizeBytes: 1, newDigest: "sha256:x" },
    });
    videoSource({ height: 720 }, { height: 720 });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(errorOf(stack, taskId)?.code).toBe("conflict.cache_recovery_pending");
    expect(cacheFiles(stack)).toEqual([]);
  });

  it("completes at once when the asset is already registered", async () => {
    const { stack, contentId, calls } = setup();
    const request = cacheRequest({ quality: 720 });
    await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720 }), { id: request.assetId as string, quality: "720", qualityVerified: true });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(resultOf(stack, taskId)).toEqual({
      assetId: request.assetId,
      fileName: "第 1 讲 [720P].mp4",
      requestedType: "video",
      actualType: "video",
      height: 720,
      replaced: [],
      evicted: [],
    });
    expect(calls).toEqual([]);
  });
});

describe("CacheMediaStageExecutor: disk budget", () => {
  const low = LOW_WATER_FREE_GB * GB;
  const volume = (room: number): Usage => ({ usedBytes: 0, freeBytes: low + room, totalBytes: 2000 * GB });

  it("reserves the peak of a known size and refuses before downloading when the cache volume lacks it", async () => {
    const estimate = 10 * 1024 * 1024;
    const refused = setup({ cacheUsage: () => volume(CACHE_DOWNLOAD_PEAK_FACTOR * estimate - 1) });
    refused.videoSource({ height: 720, sizeBytes: estimate }, { height: 720 });
    const taskId = await runCache(refused.stack, refused.contentId, cacheRequest());
    expect(errorOf(refused.stack, taskId)?.class).toBe("disk_low");
    expect(refused.calls.map((call) => call.method)).toEqual(["inspectVideo"]);
    expect(refused.ledger.ids()).toEqual([]);

    const admitted = setup({ cacheUsage: () => volume(CACHE_DOWNLOAD_PEAK_FACTOR * estimate) });
    admitted.videoSource({ height: 720, sizeBytes: estimate }, { height: 720 });
    const ok = await runCache(admitted.stack, admitted.contentId, cacheRequest());
    expect(taskOf(admitted.stack.h, ok).statusProjection).toBe("succeeded");
    expect(admitted.ledger.ids()).toEqual([]);
  });

  it("reserves CACHE_UNKNOWN_SIZE_RESERVE_GB for a size the platform does not announce", async () => {
    const unknown = CACHE_UNKNOWN_SIZE_RESERVE_GB * GB;
    expect(videoReservation(undefined)).toEqual({ cache: CACHE_DOWNLOAD_PEAK_FACTOR * unknown });
    expect(audioReservation(undefined, undefined)).toEqual({ data: unknown, cache: unknown });
    expect(audioReservation(5, 60_000)).toEqual({ data: 5, cache: mp3EstimateBytes(60_000) });
    const refused = setup({ cacheUsage: () => volume(CACHE_DOWNLOAD_PEAK_FACTOR * unknown - 1) });
    refused.videoSource({ height: 720 }, { height: 720 });
    const taskId = await runCache(refused.stack, refused.contentId, cacheRequest());
    expect(errorOf(refused.stack, taskId)?.class).toBe("disk_low");
  });

  it("counts the downloads in flight", async () => {
    const estimate = GB;
    const { stack, contentId, videoSource, ledger } = setup({ cacheUsage: () => volume(3 * estimate) });
    ledger.admit("01OTHERDOWNLOAD", { data: volume(0), cache: volume(3 * estimate), sameVolume: false }, stack.h.settings.effective(), { cache: 2 * estimate });
    videoSource({ height: 720, sizeBytes: estimate }, { height: 720 });
    const taskId = await runCache(stack, contentId, cacheRequest());
    expect(errorOf(stack, taskId)?.class).toBe("disk_low");
    expect(ledger.ids()).toEqual(["01OTHERDOWNLOAD"]);
  });

  it("turns the adapter's byte limit into disk_low", async () => {
    const { stack, contentId, inspectWith, fetchWith } = setup();
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4", height: 720 }));
    fetchWith(async () => {
      throw amberError("media_too_large", "the download passed its budget", { params: { limit: "1 GB" } });
    });
    const taskId = await runCache(stack, contentId, cacheRequest());
    expect(errorOf(stack, taskId)?.class).toBe("disk_low");
    expect(cacheFiles(stack)).toEqual([]);
  });

  it("stops a running download when a volume drops below its low-water mark", async () => {
    let free = volume(100 * GB);
    const { stack, contentId, inspectWith, fetchWith } = setup({ cacheUsage: () => free, diskCheckIntervalMs: 5 });
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4", height: 720 }));
    let aborted = false;
    fetchWith(async (_ref, _auth, opts, _progress, signal) => {
      await writeFile(join(opts.output.scratchDir, "video.part"), "partial");
      free = volume(-1);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      aborted = true;
      throw amberError("internal", "yt-dlp was killed", { code: "internal.tool_failed" });
    });
    const taskId = await runCache(stack, contentId, cacheRequest());
    expect(aborted).toBe(true);
    expect(errorOf(stack, taskId)?.class).toBe("disk_low");
    expect(cacheFiles(stack)).toEqual([]);
  });

  it("refuses before downloading with disk_low.cache_volume carrying the volume, the bytes asked for, its free space and its low-water mark", async () => {
    const estimate = 10 * 1024 * 1024;
    const free = low + CACHE_DOWNLOAD_PEAK_FACTOR * estimate - 1;
    const video = setup({ sameVolume: false, cacheUsage: () => ({ usedBytes: 0, freeBytes: free, totalBytes: 2000 * GB }) });
    video.videoSource({ height: 720, sizeBytes: estimate }, { height: 720 });
    const refused = await runCache(video.stack, video.contentId, cacheRequest());
    expect(errorOf(video.stack, refused)).toMatchObject({
      class: "disk_low",
      code: "disk_low.cache_volume",
      details: { volume: "cache", needBytes: CACHE_DOWNLOAD_PEAK_FACTOR * estimate, freeBytes: free, lowWaterBytes: low },
    });

    // Audio whose track the data volume cannot hold names the data volume.
    const track = 50 * 1024 * 1024;
    const audio = setup({ durationMs: 60_000, sameVolume: false, dataUsage: () => volume(track - 1), cacheUsage: () => volume(GB) });
    audio.audioWith(track);
    const noTrack = await runCache(audio.stack, audio.contentId, cacheRequest({ type: "audio", quality: undefined }));
    expect(errorOf(audio.stack, noTrack)).toMatchObject({
      code: "disk_low.cache_volume",
      details: { volume: "data", needBytes: track, freeBytes: low + track - 1, lowWaterBytes: low },
    });
  });

  it("budgets audio on both volumes: the track on the data volume, the MP3 on the cache volume, together when shared", async () => {
    const durationMs = 3_600_000;
    const mp3 = mp3EstimateBytes(durationMs) as number;
    const track = 50 * 1024 * 1024;

    const shared = setup({ durationMs, sameVolume: true, dataUsage: () => volume(track + mp3 - 1), cacheUsage: () => volume(track + mp3 - 1) });
    shared.audioWith(track);
    const refused = await runCache(shared.stack, shared.contentId, cacheRequest({ type: "audio", quality: undefined }));
    expect(errorOf(shared.stack, refused)?.class).toBe("disk_low");
    expect(shared.calls.map((call) => call.method)).toEqual(["inspectAudio"]);

    // Shared and with room for both: the track is told the room its MP3 leaves, not the whole of it.
    const spare = 1000;
    const roomy = setup({ durationMs, sameVolume: true, dataUsage: () => volume(track + mp3 + spare), cacheUsage: () => volume(track + mp3 + spare) });
    roomy.audioWith(track);
    const fits = await runCache(roomy.stack, roomy.contentId, cacheRequest({ type: "audio", quality: undefined }));
    expect(taskOf(roomy.stack.h, fits).statusProjection).toBe("succeeded");
    expect(roomy.calls).toEqual([{ method: "inspectAudio" }, { method: "fetchAudio", maxBytes: track + spare }]);

    const split = setup({ durationMs, sameVolume: false, dataUsage: () => volume(track), cacheUsage: () => volume(mp3) });
    split.audioWith(track);
    const accepted = await runCache(split.stack, split.contentId, cacheRequest({ type: "audio", quality: undefined }));
    expect(taskOf(split.stack.h, accepted).statusProjection).toBe("succeeded");
    expect(split.calls).toEqual([{ method: "inspectAudio" }, { method: "fetchAudio", maxBytes: track }]);

    const dataFull = setup({ durationMs, sameVolume: false, dataUsage: () => volume(track - 1), cacheUsage: () => volume(GB) });
    dataFull.audioWith(track);
    const noRoomForTrack = await runCache(dataFull.stack, dataFull.contentId, cacheRequest({ type: "audio", quality: undefined }));
    expect(errorOf(dataFull.stack, noRoomForTrack)?.class).toBe("disk_low");
  });
});

describe("CacheMediaStageExecutor: a download that runs out of room", () => {
  const low = LOW_WATER_FREE_GB * GB;
  const volume = (room: number): Usage => ({ usedBytes: 0, freeBytes: low + room, totalBytes: 2000 * GB });
  const OLD_BYTES = mediaBytes({ height: 720, salt: "old" });

  /** How each failure arrives while the download runs; `during` runs after a partial file is written. */
  const failures: Array<{ name: string; code: string; details?: Record<string, unknown>; during: (state: { setFree: (usage: Usage) => void; signal: AbortSignal }) => Promise<never> }> = [
    {
      name: "the cache volume dropping below its low-water mark",
      code: "disk_low.cache_volume",
      details: { volume: "cache" },
      during: async ({ setFree, signal }) => {
        setFree(volume(-1));
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw amberError("internal", "yt-dlp was killed", { code: "internal.tool_failed" });
      },
    },
    {
      name: "the adapter's byte limit",
      code: "disk_low.cache_volume",
      details: { volume: "cache" },
      during: async () => {
        throw amberError("media_too_large", "the download passed its budget", { params: { limit: "1 GB" } });
      },
    },
    {
      name: "yt-dlp reporting a full disk",
      code: "disk_low",
      // What the yt-dlp adapter surfaces when the download or its merge hits ENOSPC.
      during: async () => {
        throw classifyYtDlpFailure({ exitCode: 1, stderr: "[download] Destination: x.f137.mp4\nERROR: unable to write data: [Errno 28] No space left on device\n" });
      },
    },
  ];

  it.each(failures)("fails on $name with disk_low, removing the scratch directory and the reservation and keeping the existing cache", async ({ code, details, during }) => {
    let free = volume(100 * GB);
    const { stack, contentId, inspectWith, fetchWith, ledger } = setup({ cacheUsage: () => free, diskCheckIntervalMs: 5 });
    const old = await putCache(stack, contentId, "第 1 讲 [720P].mp4", OLD_BYTES, { quality: "720", qualityVerified: true });
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4", height: 720, sizeBytes: 1024 }));
    const request = cacheRequest({ quality: 720 });
    const scratchDir = join(stack.stores.cache.directory(), ".amber-tmp", request.assetId as string);
    let reservedWhileDownloading: string[] = [];
    fetchWith(async (_ref, _auth, opts, _progress, signal) => {
      reservedWhileDownloading = ledger.ids();
      await writeFile(join(opts.output.scratchDir, "video.f137.mp4.part"), "partial");
      await writeFile(opts.output.path, mediaBytes({ height: 720, salt: "partial" }));
      return during({ setFree: (usage) => (free = usage), signal });
    });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    expect(errorOf(stack, taskId)).toMatchObject({ class: "disk_low", code });
    if (details !== undefined) {
      expect(errorOf(stack, taskId)?.details).toEqual(details);
    }
    expect(reservedWhileDownloading).toEqual([request.assetId]);
    expect(ledger.ids()).toEqual([]);
    expect(existsSync(scratchDir)).toBe(false);
    expect(assetOf(stack, request.assetId as string)).toBeUndefined();
    expect(assetOf(stack, old.id)).toMatchObject({ availability: "available", storageRef: "media/第 1 讲 [720P].mp4", fingerprint: digestOf(OLD_BYTES) });
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(OLD_BYTES);
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4"]);
  });
});

describe("CacheMediaStageExecutor: audio", () => {
  it("downloads the track into the data directory, transcodes it into the scratch directory and publishes <stem>.mp3", async () => {
    const { stack, contentId, transcodes, audioWith } = setup({ durationMs: 60_000 });
    const olderAudio = await putCache(stack, contentId, "第 1 讲.mp3", Buffer.concat([MP3_BYTES, Buffer.from("old")]));
    const video = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720 }), { quality: "720", qualityVerified: true });
    const progress: number[] = [];
    stack.h.bus.subscribe(({ event }) => {
      if (event.type === "stage.updated" && event.stageRun.stage === "cache_media" && event.stageRun.progress > 0) {
        progress.push(event.stageRun.progress);
      }
    });
    audioWith(4096);
    const request = cacheRequest({ type: "audio", quality: undefined });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(transcodes).toEqual([
      {
        input: join(stack.h.dir, "tmp", "platform", request.assetId as string),
        output: join(stack.stores.cache.directory(), ".amber-tmp", request.assetId as string, "download.mp3"),
        bitrateKbps: CACHE_AUDIO_MP3_KBPS,
      },
    ]);
    expect(await stack.files.list("tmp/platform")).toEqual([]);
    expect(resultOf(stack, taskId)).toEqual({
      assetId: request.assetId,
      fileName: "第 1 讲.mp3",
      requestedType: "audio",
      actualType: "audio",
      replaced: [olderAudio.id],
      evicted: [],
    });
    expect(assetOf(stack, request.assetId as string)).toMatchObject({ storageRef: "media/第 1 讲.mp3", mimeType: "audio/mpeg", sizeBytes: MP3_BYTES.length, qualityVerified: true });
    expect(assetOf(stack, request.assetId as string)).not.toHaveProperty("quality");
    expect(assetOf(stack, olderAudio.id)?.availability).toBe("evicted");
    expect(assetOf(stack, video.id)?.availability).toBe("available");
    expect(fileOf(stack, "第 1 讲.mp3")).toEqual(MP3_BYTES);
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4", "第 1 讲.mp3"]);
    // Download 0–0.7, transcode 0.7–1, never backwards.
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toEqual(expect.arrayContaining([0.35, 0.7, 0.85, 1]));
  });
});

describe("CacheMediaStageExecutor: requests from earlier versions", () => {
  it("fails a v1 request as outdated", async () => {
    const { stack, contentId } = setup();
    const taskId = await runCache(stack, contentId, { requestSchemaVersion: 1, quality: 720 });
    expect(errorOf(stack, taskId)?.code).toBe("invalid_request.cache_request_outdated");
  });

  it("completes a v2 request whose asset is registered", async () => {
    const { stack, contentId } = setup();
    const assetId = nextAssetId();
    await putCache(stack, contentId, "第 1 讲.mp4", mediaBytes({ height: 720 }), { id: assetId });
    const taskId = await runCache(stack, contentId, { requestSchemaVersion: 2, type: "video", quality: 720, fileName: "第 1 讲", assetId });
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(resultOf(stack, taskId)).toMatchObject({ assetId, fileName: "第 1 讲.mp4", actualType: "video", evicted: [] });
  });

  it.each([
    { name: "unchanged", content: "v2", recorded: "v2", left: [] as string[] },
    { name: "changed since", content: "changed", recorded: "v2", left: ["第 1 讲.mp4"] },
  ])("removes the unregistered file a v2 run left only when it is $name the recorded one, then fails as outdated", async ({ content, recorded, left }) => {
    const { stack, contentId } = setup();
    await mkdir(stack.stores.cache.directory(), { recursive: true });
    await writeFile(join(stack.stores.cache.directory(), "第 1 讲.mp4"), mediaBytes({ salt: content }));
    const taskId = createTaskOfKind(stack.h, "cache_media", { requestSchemaVersion: 2, type: "video", quality: 720, fileName: "第 1 讲", assetId: nextAssetId() }, { contentId });
    const run = stageRunsOf(stack.h, taskId)[0];
    stack.h.repository.withTransaction((scope) =>
      scope.workUnits.insert(LOCAL.userId, {
        id: "01UNIT".padEnd(26, "0"),
        stageRunId: run?.id as string,
        key: "cache_media:download",
        status: "succeeded",
        attempt: 1,
        retryCount: 0,
        inputDigest: "sha256:in",
        outputRef: "media/第 1 讲.mp4",
        outputDigest: digestOf(mediaBytes({ salt: recorded })),
      }),
    );
    stack.h.scheduler.start();
    stack.h.scheduler.kick();
    await waitFor(() => ["succeeded", "failed"].includes(taskOf(stack.h, taskId).statusProjection));
    expect(errorOf(stack, taskId)?.code).toBe("invalid_request.cache_request_outdated");
    expect(cacheFiles(stack)).toEqual(left);
    expect(workUnitsOf(stack.h, taskId)).toHaveLength(1);
  });
});

describe("CacheMediaStageExecutor: interrupted replacement", () => {
  it("keeps the record and holds the path when a failed swap cannot be moved back", async () => {
    let failMoveIn = false;
    const { stack, contentId, videoSource, holds } = setup({
      cacheOverrides: {
        async moveIn(this: CacheFileStore, from: string, ref: string) {
          if (failMoveIn) {
            throw Object.assign(new Error("I/O error"), { code: "EIO" });
          }
          return (Object.getPrototypeOf(this) as CacheFileStore).moveIn(from, ref);
        },
      },
    });
    const old = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ height: 720, salt: "old" }), { quality: "720", qualityVerified: true });
    videoSource({ height: 720 }, { height: 720, salt: "new" });
    failMoveIn = true;
    const request = cacheRequest({ quality: 720 });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    expect(assetOf(stack, old.id)?.availability).toBe("available");
    const dir = join(stack.stores.cache.directory(), ".amber-tmp", request.assetId as string);
    expect(existsSync(join(dir, SWAP_RECORD_FILE))).toBe(true);
    expect(readFileSync(join(dir, "displaced"))).toEqual(mediaBytes({ height: 720, salt: "old" }));
    expect(holds.isHeld("media/第 1 讲 [720P].mp4")).toBe(true);
  });

  it("moves the displaced cache back when the new file cannot be renamed onto the target", async () => {
    const moves: Array<{ from: string; ref: string }> = [];
    let failed = false;
    const { stack, contentId, videoSource, holds } = setup({
      cacheOverrides: {
        async moveIn(this: CacheFileStore, from: string, ref: string) {
          moves.push({ from, ref });
          // Only the finished download's rename fails, once; the way back must still work.
          if (!failed && /^download\./u.test(basename(from))) {
            failed = true;
            throw Object.assign(new Error("I/O error"), { code: "EIO" });
          }
          return (Object.getPrototypeOf(this) as CacheFileStore).moveIn(from, ref);
        },
      },
    });
    const oldBytes = mediaBytes({ height: 720, salt: "old" });
    const old = await putCache(stack, contentId, "第 1 讲 [720P].mp4", oldBytes, { quality: "720", qualityVerified: true });
    videoSource({ height: 720 }, { height: 720, salt: "new" });
    const request = cacheRequest({ quality: 720 });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    expect(failed).toBe(true);
    // The download's rename failed, then the displaced copy went back to the target.
    expect(moves.map((move) => [basename(move.from), move.ref])).toEqual([
      ["download.mp4", "media/第 1 讲 [720P].mp4"],
      ["displaced", "media/第 1 讲 [720P].mp4"],
    ]);
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(oldBytes);
    expect(assetOf(stack, old.id)).toMatchObject({ availability: "available", storageRef: "media/第 1 讲 [720P].mp4", fingerprint: digestOf(oldBytes) });
    expect(assetOf(stack, request.assetId as string)).toBeUndefined();
    expect(cachesOf(stack, contentId).map((asset) => asset.id)).toEqual([old.id]);
    expect(holds.isHeld("media/第 1 讲 [720P].mp4")).toBe(false);
    expect(existsSync(join(stack.stores.cache.directory(), ".amber-tmp", request.assetId as string))).toBe(false);
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4"]);
  });

  it("leaves the existing cache and its row alone when its path waits for an interrupted replacement", async () => {
    const { stack, contentId, videoSource, holds } = setup();
    const oldBytes = mediaBytes({ height: 720, salt: "old" });
    const old = await putCache(stack, contentId, "第 1 讲 [720P].mp4", oldBytes, { quality: "720", qualityVerified: true });
    holds.add({
      scratchId: "01HELD",
      record: { v: 1, targetRef: "media/第 1 讲 [720P].mp4", newAssetId: "01HELD", newSizeBytes: 1, newDigest: "sha256:x" },
    });
    videoSource({ height: 720 }, { height: 720, salt: "new" });
    const request = cacheRequest({ quality: 720 });
    const taskId = await runCache(stack, contentId, request);
    expect(errorOf(stack, taskId)?.code).toBe("conflict.cache_recovery_pending");
    expect(assetOf(stack, old.id)).toMatchObject({ availability: "available", storageRef: "media/第 1 讲 [720P].mp4", fingerprint: digestOf(oldBytes) });
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(oldBytes);
    expect(assetOf(stack, request.assetId as string)).toBeUndefined();
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [720P].mp4"]);
    expect(holds.isHeld("media/第 1 讲 [720P].mp4")).toBe(true);
  });
});

describe("CacheMediaStageExecutor: unknown quality", () => {
  it("never replaces a video cache of unknown quality, whatever tier is cached next", async () => {
    const { stack, contentId, inspectWith, fetchWith } = setup();
    // The picture says 720, but the row records the quality as unknown: it takes no part in same-tier replacement.
    const unknownBytes = mediaBytes({ height: 720, salt: "unknown" });
    const unknown = await putCache(stack, contentId, "第 1 讲.mp4", unknownBytes, { quality: "", qualityVerified: true });
    let height = 360;
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4", height }));
    fetchWith(async (_ref, _auth, opts) => {
      await writeFile(opts.output.path, mediaBytes({ height }));
      return { sizeBytes: 1, mimeType: "video/mp4", acquisition: "guest" };
    });
    for (const tier of [360, 720, 1080] as const) {
      height = tier;
      const taskId = await runCache(stack, contentId, cacheRequest({ quality: tier }));
      expect(taskOf(stack.h, taskId).statusProjection, String(tier)).toBe("succeeded");
      expect(resultOf(stack, taskId)["replaced"], String(tier)).toEqual([]);
      expect(assetOf(stack, unknown.id), String(tier)).toMatchObject({ availability: "available", quality: "", qualityVerified: true });
    }
    expect(fileOf(stack, "第 1 讲.mp4")).toEqual(unknownBytes);
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [1080P].mp4", "第 1 讲 [360P].mp4", "第 1 讲 [720P].mp4", "第 1 讲.mp4"]);
  });
});

describe("CacheMediaStageExecutor: input digest", () => {
  it("changes with the type, the cap, the stem, the expected height, the overwrite confirmation and the asset id", async () => {
    const { stack, contentId, videoSource, inspectWith, calls } = setup();
    // Every run stops at the format check, so no asset is registered and one asset id can be run again.
    videoSource({}, {});
    inspectWith(async () => ({ hasVideo: false }));
    Object.assign(stack.h.platforms.bilibili, {
      inspectAudio: async () => {
        throw amberError("invalid_request", "stop at the format check", { code: "invalid_request.cache_request_outdated" });
      },
    });
    const assetId = nextAssetId();
    const base = { quality: 720, stem: "第 1 讲", expectedHeight: 720, overwrite: { assetId: "01OVERWRITTEN", fileName: "第 1 讲 [720P].mp4" }, assetId };
    const digestOf = async (fields: Record<string, unknown>): Promise<string> => {
      const taskId = await runCache(stack, contentId, cacheRequest(fields));
      expect(errorOf(stack, taskId)?.code).toBe("invalid_request.cache_request_outdated");
      const units = workUnitsOf(stack.h, taskId);
      expect(units).toHaveLength(1);
      return units[0]?.inputDigest as string;
    };
    const baseline = await digestOf(base);
    expect(baseline).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await digestOf(base)).toBe(baseline);
    const { overwrite: _overwrite, ...withoutOverwrite } = base;
    const variants: Record<string, Record<string, unknown>> = {
      type: { ...base, type: "audio", quality: undefined },
      cap: { ...base, quality: 1080 },
      stem: { ...base, stem: "第 2 讲" },
      expectedHeight: { ...base, expectedHeight: 1080 },
      noExpectedHeight: { ...base, expectedHeight: undefined },
      noOverwrite: withoutOverwrite,
      overwriteAsset: { ...base, overwrite: { ...base.overwrite, assetId: "01OTHEROVERWRITTEN" } },
      overwriteName: { ...base, overwrite: { ...base.overwrite, fileName: "第 1 讲 [720P].webm" } },
      assetId: { ...base, assetId: nextAssetId() },
    };
    const digests = new Map<string, string>([["baseline", baseline]]);
    for (const [name, fields] of Object.entries(variants)) {
      digests.set(name, await digestOf(fields));
    }
    for (const [name, digest] of digests) {
      if (name !== "baseline") expect(digest, name).not.toBe(baseline);
    }
    expect(new Set(digests.values()).size).toBe(digests.size);
    expect(calls.some((call) => call.method === "fetchVideo")).toBe(false);
  });
});

describe("CacheMediaStageExecutor: v4 requests for an exact tier", () => {
  const v4Request = (fields: Record<string, unknown> = {}) => cacheRequest({ requestSchemaVersion: 4, ...fields });

  it("asks the adapter for the tier, publishes the download in it and reports nothing above a cap", async () => {
    const { stack, contentId, calls, videoSource } = setup();
    // An ultra-wide picture: 854×274 is 480P by its equivalent height.
    videoSource({ height: 274, sizeBytes: 100 }, { width: 854, height: 274 });
    const request = v4Request({ quality: 480 });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(resultOf(stack, taskId)).toEqual({
      assetId: request.assetId,
      fileName: "第 1 讲 [480P].mp4",
      requestedType: "video",
      actualType: "video",
      height: 480,
      replaced: [],
      evicted: [],
    });
    const available = AMPLE_USAGE.freeBytes - LOW_WATER_FREE_GB * GB;
    expect(calls).toEqual([
      { method: "inspectVideo", tier: 480 },
      { method: "fetchVideo", tier: 480, maxBytes: Math.floor(available / CACHE_DOWNLOAD_PEAK_FACTOR) },
    ]);
  });

  it("fails with cache_quality_mismatch when the download is another tier, publishing nothing and keeping the caches", async () => {
    const { stack, contentId, videoSource } = setup();
    const old480 = await putCache(stack, contentId, "第 1 讲 [480P].mp4", mediaBytes({ width: 854, height: 480, salt: "old 480" }), { quality: "480", qualityVerified: true });
    const old720 = await putCache(stack, contentId, "第 1 讲 [720P].mp4", mediaBytes({ width: 1280, height: 720, salt: "old 720" }), { quality: "720", qualityVerified: true });
    // Asked for 480P, the download came out 1280×410: 720P.
    videoSource({ height: 274 }, { width: 1280, height: 410 });
    const request = v4Request({ quality: 480 });
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    const error = errorOf(stack, taskId);
    expect(error).toMatchObject({ class: "invalid_request", code: "invalid_request.cache_quality_mismatch" });
    expect(error?.userMessage).toContain("720P");
    expect(error?.userMessage).toContain("480P");
    expect(assetOf(stack, request.assetId)).toBeUndefined();
    expect(assetOf(stack, old480.id)).toMatchObject({ availability: "available", storageRef: "media/第 1 讲 [480P].mp4" });
    expect(assetOf(stack, old720.id)).toMatchObject({ availability: "available", storageRef: "media/第 1 讲 [720P].mp4" });
    expect(fileOf(stack, "第 1 讲 [480P].mp4")).toEqual(mediaBytes({ width: 854, height: 480, salt: "old 480" }));
    expect(fileOf(stack, "第 1 讲 [720P].mp4")).toEqual(mediaBytes({ width: 1280, height: 720, salt: "old 720" }));
    // No new file and no scratch directory are left behind.
    expect(cacheFiles(stack)).toEqual(["第 1 讲 [480P].mp4", "第 1 讲 [720P].mp4"]);
    expect(existsSync(join(stack.stores.cache.directory(), ".amber-tmp", request.assetId as string))).toBe(false);
  });

  it("selects the tier again when the stage is re-run", async () => {
    const { stack, contentId, calls, videoSource } = setup();
    videoSource({ height: 274 }, { width: 1280, height: 410 });
    const request = v4Request({ quality: 480 });
    const taskId = await runCache(stack, contentId, request);
    expect(errorOf(stack, taskId)?.code).toBe("invalid_request.cache_quality_mismatch");
    videoSource({ height: 274 }, { width: 854, height: 274 });
    calls.length = 0;
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "cache_media" });
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded");
    expect(calls.map((call) => ({ method: call.method, tier: call.tier, maxHeight: call.maxHeight }))).toEqual([
      { method: "inspectVideo", tier: 480, maxHeight: undefined },
      { method: "fetchVideo", tier: 480, maxHeight: undefined },
    ]);
    expect(assetOf(stack, request.assetId)).toMatchObject({ storageRef: "media/第 1 讲 [480P].mp4", availability: "available" });
  });

  it("downloads under the default cap without a quality, reporting a tier above it", async () => {
    const { stack, contentId, calls, videoSource } = setup();
    videoSource({ height: 1440 }, { width: 2560, height: 1440 });
    const { quality: _quality, ...request } = v4Request();
    const taskId = await runCache(stack, contentId, request);
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(resultOf(stack, taskId)).toMatchObject({ fileName: "第 1 讲 [1440P].mp4", height: 1440, aboveRequested: true });
    expect(calls.map((call) => ({ method: call.method, tier: call.tier, maxHeight: call.maxHeight }))).toEqual([
      { method: "inspectVideo", tier: undefined, maxHeight: CACHE_MEDIA_MAX_HEIGHT },
      { method: "fetchVideo", tier: undefined, maxHeight: CACHE_MEDIA_MAX_HEIGHT },
    ]);
  });

  it("keeps the v3 digest as it was and gives v4 another one for the same fields", async () => {
    const { stack, contentId, videoSource, inspectWith } = setup();
    // Every run stops at the format check, so one asset id can be run again.
    videoSource({}, {});
    inspectWith(async () => ({ hasVideo: false }));
    const assetId = nextAssetId();
    const fields = { quality: 720, stem: "第 1 讲", expectedHeight: 720, overwrite: { assetId: "01OVERWRITTEN", fileName: "第 1 讲 [720P].mp4" }, assetId };
    const digestOfRun = async (request: Record<string, unknown>): Promise<string> => {
      const taskId = await runCache(stack, contentId, request);
      expect(errorOf(stack, taskId)?.code).toBe("invalid_request.cache_request_outdated");
      return workUnitsOf(stack.h, taskId)[0]?.inputDigest as string;
    };
    const v3 = await digestOfRun(cacheRequest(fields));
    const v4 = await digestOfRun(cacheRequest({ ...fields, requestSchemaVersion: 4 }));
    // The v3 fields, in the order stored v3 work units were digested with.
    const content = stack.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
    const source = content?.source as { platformContentId: string; platformPartId: string };
    const v3Fields = ["bilibili", source.platformContentId, source.platformPartId, contentId, "video", 720, "第 1 讲", 720, "01OVERWRITTEN", "第 1 讲 [720P].mp4", assetId];
    expect(v3).toBe(`sha256:${createHash("sha256").update(JSON.stringify(v3Fields), "utf8").digest("hex")}`);
    expect(v4).toBe(`sha256:${createHash("sha256").update(JSON.stringify([...v3Fields, "v4"]), "utf8").digest("hex")}`);
    expect(v4).not.toBe(v3);
  });
});
