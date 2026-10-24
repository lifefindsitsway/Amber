import { createHash } from "node:crypto";
import { join } from "node:path";
import { audioCacheFileName, cacheFileNameOf, cacheQualityTier, cacheRefOf, isCacheRef, videoCacheFileName } from "../../../shared/cache-file-name.ts";
import {
  CACHE_AUDIO_MP3_KBPS,
  CACHE_DISK_CHECK_INTERVAL_MS,
  CACHE_DOWNLOAD_PEAK_FACTOR,
  CACHE_MEDIA_MAX_HEIGHT,
  CACHE_UNKNOWN_SIZE_RESERVE_GB,
} from "../../../shared/defaults.ts";
import { BYTES_PER_GB } from "../../../shared/units.ts";
import type { Content } from "../../domain/content.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import { verifiedCacheHeight, type MediaAsset } from "../../domain/media-asset.ts";
import { cacheMediaTaskRequestSchema, type CacheMediaTaskRequestV2, type CacheMediaTaskRequestV3 } from "../../domain/task-request.ts";
import { FileTooLargeError } from "../../ports/file-store.ts";
import type { LocalMediaIngest } from "../../ports/local-media-ingest.ts";
import type { Logger } from "../../ports/logger.ts";
import type { Repository } from "../../ports/repository.ts";
import type { SubtitleMuxer } from "../../ports/subtitle-muxer.ts";
import { readCacheVolumes, type CacheDownloadLedger, type CacheReservation, type CacheVolume } from "../cache-download-ledger.ts";
import type { CacheHoldRegistry } from "../cache-holds.ts";
import type { CachePathLocks } from "../cache-path-locks.ts";
import { pictureStream, verifyCacheQualities, videoContainerOf } from "../cache-quality.ts";
import { cacheTypeOf, identityOf, matchesIdentity, publishCache, type FileIdentity } from "../cache-swap.ts";
import { cacheVolumeLow } from "../disk-watermark.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import type { MediaFiles } from "../media-files.ts";
import type { InstanceSettingsSource } from "../scheduler.ts";
import { platformTarget, taskContent, type PlatformAccess, type PlatformTarget } from "./platform-access.ts";
import { monotonic } from "./progress.ts";

export interface CacheMediaStageDeps {
  repository: Repository;
  /**
   * The cache store holds every `platform_cache` file and the scratch directories of the
   * downloads; the data store holds the downloaded audio track while it is transcoded.
   */
  media: Pick<MediaFiles, "cache" | "data">;
  platforms: PlatformAccess;
  ingest: Pick<LocalMediaIngest, "transcodeAudio">;
  /** Reads the height and container of a finished download. */
  muxer: Pick<SubtitleMuxer, "inspect">;
  /** The low-water marks the budget and the running checks use. */
  settings: InstanceSettingsSource;
  /** Whether the data directory and the cache directory are on one volume, so both reservations draw on the same free space. */
  sameVolume: () => boolean | Promise<boolean>;
  /** Space reserved by the cache downloads in flight, shared with the submission's inspection. */
  ledger: CacheDownloadLedger;
  /** Serializes everything that replaces or removes a file at one cache path. */
  locks: CachePathLocks;
  /** Interrupted replacements waiting for the user; their paths take no new cache. */
  holds: CacheHoldRegistry;
  /**
   * Settles the interrupted replacements of a cache directory that was not mounted at
   * start-up, once it is; runs before a download is admitted.
   */
  recoverSwaps?: () => Promise<void>;
  /** Defaults to `CACHE_DISK_CHECK_INTERVAL_MS`. */
  diskCheckIntervalMs?: number;
  logger?: Logger;
  now?: () => number;
}

type CacheMediaType = CacheMediaTaskRequestV3["type"];

const DOWNLOAD_UNIT_KEY = "cache_media:download";
const MP3_MIME = "audio/mpeg";
/** The share of an audio cache's progress taken by the download; the transcode takes the rest. */
const AUDIO_DOWNLOAD_PROGRESS_SHARE = 0.7;
/** Headroom over the nominal MP3 size in the disk budget: container overhead and rounding. */
const MP3_SIZE_MARGIN = 1.1;
/**
 * Where the audio track waits for its transcode: the data directory's platform scratch
 * directory, whose leftovers the start-up sweep removes.
 */
const AUDIO_SCRATCH_DIR = "tmp/platform";
/** The finished download's name inside its scratch directory, before it is published. */
const DOWNLOAD_BASENAME = "download";
const UNKNOWN_SIZE_RESERVE_BYTES = CACHE_UNKNOWN_SIZE_RESERVE_GB * BYTES_PER_GB;

function outdated(message: string): never {
  throw amberError("invalid_request", message, { code: "invalid_request.cache_request_outdated" });
}

function diskLow(volume: CacheVolume): Error {
  return amberError("disk_low", `the ${volume} volume ran low while caching`, { code: "disk_low.cache_volume", details: { volume } });
}

/** A download stopped at its byte budget means the volume has no more room for it. */
function asDiskLow(error: unknown, volume: CacheVolume): unknown {
  if (error instanceof FileTooLargeError || (isAmberError(error) && error.appError.class === "media_too_large")) {
    return diskLow(volume);
  }
  return error;
}

/** The MP3 size of `durationMs` at `CACHE_AUDIO_MP3_KBPS`, with headroom; `undefined` when the duration is unknown. */
export function mp3EstimateBytes(durationMs: number | undefined): number | undefined {
  return durationMs === undefined ? undefined : Math.ceil(((durationMs / 1000) * CACHE_AUDIO_MP3_KBPS * 1000 * MP3_SIZE_MARGIN) / 8);
}

/** What a video cache download reserves on the cache volume: the peak of the separate streams plus their merge. */
export function videoReservation(estimatedBytes: number | undefined): Partial<CacheReservation> {
  return { cache: CACHE_DOWNLOAD_PEAK_FACTOR * (estimatedBytes ?? UNKNOWN_SIZE_RESERVE_BYTES) };
}

/** What an audio cache reserves: the downloaded track on the data volume, the MP3 on the cache volume. */
export function audioReservation(trackBytes: number | undefined, durationMs: number | undefined): Partial<CacheReservation> {
  return { data: trackBytes ?? UNKNOWN_SIZE_RESERVE_BYTES, cache: mp3EstimateBytes(durationMs) ?? UNKNOWN_SIZE_RESERVE_BYTES };
}

/** What the run that published the cache reports; absent when an earlier attempt published it. */
interface Published {
  asset: MediaAsset;
  replaced: string[];
  aboveRequested: boolean;
}

/**
 * The `cache_media` stage (client only): downloads a platform Content into a
 * `platform_cache` asset whose id and file stem the request froze at submission (schema v3).
 * `resultJson` = `{ assetId, fileName, requestedType, actualType, height?, aboveRequested?,
 * replaced, evicted }`; `evicted` is always empty, caches are never evicted automatically.
 *
 * - Budget: before downloading, each volume the download writes to must keep its low-water
 *   mark after this download's reservation and those of the downloads in flight
 *   (`CacheDownloadLedger`), else `disk_low`. A video reserves
 *   `CACHE_DOWNLOAD_PEAK_FACTOR` × its estimated size on the cache volume; audio its track
 *   on the data volume and the MP3 on the cache volume; an unknown size reserves
 *   `CACHE_UNKNOWN_SIZE_RESERVE_GB`. The adapter stops at the byte budget, and every
 *   `CACHE_DISK_CHECK_INTERVAL_MS` both volumes are read again: one below its low-water
 *   mark stops the download with `disk_low`. Any failure leaves the existing caches alone.
 * - Video: the format check must find a picture (else `cache_request_outdated`); the file
 *   is downloaded into `.amber-tmp/<assetId>/`, then ffprobe reads its picture size and
 *   container, which name it `<stem> [<tier>P].<ext>` (no picture → `cache_request_outdated`,
 *   no height → `cache_probe_failed`). A video whose tier is above the requested cap is kept
 *   and reported as `aboveRequested`.
 * - Audio: the best audio track goes into the data directory and is transcoded to MP3
 *   (`CACHE_AUDIO_MP3_KBPS`) into the scratch directory, named `<stem>.mp3`.
 * - Publishing follows the replacement protocol of `publishCache`: this Content's cache of
 *   the same type and quality is replaced, another Content's only when the request carries
 *   the user's confirmation, an unregistered or changed file never.
 *
 * The work is one file-backed WorkUnit under the heavy semaphore. A request whose asset is
 * already registered is complete. Requests from before quality-labelled names (schema v1
 * and v2) fail with `invalid_request.cache_request_outdated`, after removing a file a v2
 * run downloaded but never registered.
 */
export class CacheMediaStageExecutor implements StageExecutor {
  private readonly deps: CacheMediaStageDeps;
  private readonly now: () => number;

  constructor(deps: CacheMediaStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { task } = context;
    const owner = task.userId;
    const parsed = cacheMediaTaskRequestSchema.parse(context.request);
    if (parsed.requestSchemaVersion === 1) {
      outdated("this cache request predates named cache files");
    }
    const registered = this.deps.repository.withTransaction((scope) => scope.mediaAssets.get(owner, parsed.assetId));
    if (registered !== undefined) {
      // A crash after the asset was registered and before the stage settled.
      return { resultJson: resultOf(registered, parsed.type, undefined) };
    }
    if (parsed.requestSchemaVersion === 2) {
      await this.discardUnregistered(context, parsed);
      outdated("this cache request predates quality-labelled cache files");
    }
    const request = parsed;
    const content = taskContent(this.deps.repository, context);
    const target = platformTarget(this.deps.platforms, content);
    if (target === undefined) {
      throw amberError("invalid_request", "only platform contents have media to cache", { params: { detail: "contentId" } });
    }
    if (!(await this.deps.media.cache.isAvailable())) {
      throw amberError("conflict", "the video cache root is not available", { code: "conflict.cache_unavailable" });
    }
    await this.deps.recoverSwaps?.();
    let published: Published | undefined;
    await context.runUnit({
      key: DOWNLOAD_UNIT_KEY,
      inputDigest: inputDigestOf(target, content.id, request),
      storage: "file",
      store: "cache",
      run: (signal) =>
        context.withHeavySlot(async () => {
          const progress = monotonic((value) => context.reportProgress(value));
          const job: CacheJob = { owner, content, target, request, progress, signal };
          published = await this.cache(job);
          return { outputRef: published.asset.storageRef, outputDigest: published.asset.fingerprint as string };
        }),
    });
    if (published !== undefined) {
      return { resultJson: resultOf(published.asset, request.type, published) };
    }
    // The unit was completed by an earlier attempt, which also registered the asset.
    const asset = this.deps.repository.withTransaction((scope) => scope.mediaAssets.get(owner, request.assetId));
    if (asset === undefined) {
      throw amberError("internal", "the cached file was never registered");
    }
    return { resultJson: resultOf(asset, request.type, undefined) };
  }

  /**
   * A v2 run that downloaded its file and crashed before registering it left the file under
   * the name it froze; that file is removed when it is still exactly the one recorded and
   * no row holds the name. Nothing else is touched.
   */
  private async discardUnregistered(context: StageExecutionContext, request: CacheMediaTaskRequestV2): Promise<void> {
    const { task } = context;
    const outputs = this.deps.repository
      .withTransaction((scope) => scope.workUnits.listByTask(task.userId, task.id))
      .filter((unit) => unit.key === DOWNLOAD_UNIT_KEY && unit.outputRef !== undefined && unit.outputDigest !== undefined);
    const cache = this.deps.media.cache;
    if (!(await cache.isAvailable())) {
      return;
    }
    for (const unit of outputs) {
      const ref = unit.outputRef as string;
      if (!isCacheRef(ref)) {
        continue;
      }
      await this.deps.locks.withLock(ref, async () => {
        const held = this.deps.repository.withTransaction((scope) =>
          scope.mediaAssets.listCachesByStorageRefUnscoped(ref).some((asset) => asset.availability === "available"),
        );
        const stored = await cache.stat(ref);
        if (held || stored === null) {
          return;
        }
        if ((await matchesIdentity(cache.pathOf(ref), { sizeBytes: stored.sizeBytes, digest: unit.outputDigest as string })) === true) {
          await cache.remove(ref);
          this.deps.logger?.info("cache_outdated_file_removed", { assetId: request.assetId });
        }
      });
    }
  }

  /** Budget, download, probe and publish; the reservation and the scratch directory go however it ends. */
  private async cache(job: CacheJob): Promise<Published> {
    const { cache } = this.deps.media;
    if (this.deps.holds.get(job.request.assetId) !== undefined) {
      throw amberError("conflict", "an interrupted replacement waits for this cache", { code: "conflict.cache_recovery_pending" });
    }
    try {
      return job.request.type === "video" ? await this.cacheVideo(job) : await this.cacheAudio(job);
    } finally {
      this.deps.ledger.release(job.request.assetId);
      // A directory still holding a replacement record is kept for the recovery.
      await cache.removeScratchDir(job.request.assetId).catch((error: unknown) =>
        this.deps.logger?.warn("cache_scratch_remove_failed", { error: (error as NodeJS.ErrnoException | undefined)?.code ?? "error" }),
      );
    }
  }

  private async cacheVideo(job: CacheJob): Promise<Published> {
    const { adapter, auth, ref: platformRef } = job.target;
    if (typeof adapter.inspectVideo !== "function" || typeof adapter.fetchVideo !== "function") {
      throw amberError("internal", `the ${adapter.kind} adapter cannot download video`);
    }
    const maxHeight = job.request.quality ?? CACHE_MEDIA_MAX_HEIGHT;
    const inspected = await adapter.inspectVideo(platformRef, auth, { maxHeight }, job.signal);
    if (!inspected.hasVideo) {
      outdated("the source offers no picture any more; cache its audio instead");
    }
    const space = await this.admit(job.request.assetId, videoReservation(inspected.sizeBytes));
    const maxBytes = Math.floor(space.cache / CACHE_DOWNLOAD_PEAK_FACTOR);
    const cache = this.deps.media.cache;
    const scratch = await cache.openScratch(job.request.assetId);
    const announcedExt = inspected.mimeType === "video/webm" ? "webm" : "mp4";
    const downloadPath = join(scratch.path, `${DOWNLOAD_BASENAME}.${announcedExt}`);
    let acquisition: MediaAsset["acquisition"];
    await this.watchingDisks(job.signal, async (signal) => {
      try {
        const fetched = await adapter.fetchVideo?.(platformRef, auth, { maxHeight, maxBytes, output: { path: downloadPath, scratchDir: scratch.path } }, job.progress, signal);
        acquisition = fetched?.acquisition;
      } catch (error) {
        throw asDiskLow(error, "cache");
      }
    });
    const inspection = await this.deps.muxer.inspect(downloadPath, job.signal).catch((error: unknown) => {
      if (job.signal.aborted) {
        throw error;
      }
      throw amberError("invalid_request", "ffprobe cannot read the downloaded file", { code: "invalid_request.cache_probe_failed" });
    });
    const picture = pictureStream(inspection);
    if (picture === undefined) {
      outdated("the downloaded file has no picture; cache its audio instead");
    }
    if (picture.height === undefined) {
      throw amberError("invalid_request", "the downloaded file's height cannot be read", { code: "invalid_request.cache_probe_failed" });
    }
    const container = videoContainerOf(inspection);
    if (container === undefined) {
      throw amberError("media_unsupported_type", `the download is a ${inspection.container} file`, { params: { formats: "mp4, webm" } });
    }
    const identity = await this.identityOf(downloadPath);
    const tier = cacheQualityTier(picture.height, picture.width);
    const targetRef = cacheRefOf(videoCacheFileName(job.request.stem, tier, container.ext));
    // Earlier builds recorded the requested cap, or the encoded height, as the quality; the
    // old cache this one replaces is found by the tier of its file.
    await verifyCacheQualities(
      { repository: this.deps.repository, cache, muxer: this.deps.muxer, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
      this.deps.repository.withTransaction((scope) => scope.mediaAssets.listByContent(job.owner, job.content.id)),
      job.signal,
    );
    const done = await publishCache(this.swapDeps(), {
      owner: job.owner,
      contentId: job.content.id,
      assetId: job.request.assetId,
      downloadPath,
      targetRef,
      type: "video",
      height: tier,
      mimeType: container.mimeType,
      identity,
      ...(acquisition === undefined ? {} : { acquisition }),
      ...(job.request.overwrite === undefined ? {} : { overwrite: job.request.overwrite }),
      createdAt: this.now(),
    });
    job.progress(1);
    // A cap names a tier (720, 1080): a portrait or rotated video encoded taller than wide is
    // not above a cap its tier fits, even when the format filter had to fall back to it.
    return { ...done, aboveRequested: tier > maxHeight };
  }

  private async cacheAudio(job: CacheJob): Promise<Published> {
    const { adapter, auth, ref: platformRef } = job.target;
    if (typeof adapter.inspectAudio !== "function") {
      throw amberError("internal", `the ${adapter.kind} adapter cannot inspect audio`);
    }
    const announced = (await adapter.inspectAudio(platformRef, auth, job.signal)).sizeBytes;
    const space = await this.admit(job.request.assetId, audioReservation(announced, job.content.durationMs));
    const cache = this.deps.media.cache;
    const data = this.deps.media.data;
    const scratch = await cache.openScratch(job.request.assetId);
    const downloadPath = join(scratch.path, `${DOWNLOAD_BASENAME}.mp3`);
    const trackRef = `${AUDIO_SCRATCH_DIR}/${job.request.assetId}`;
    try {
      await this.watchingDisks(job.signal, async (signal) => {
        try {
          await data.writeAtomic(
            trackRef,
            async (partial) => {
              await adapter.fetchAudio(platformRef, auth, { path: partial }, (value) => job.progress(value * AUDIO_DOWNLOAD_PROGRESS_SHARE), signal, {
                maxBytes: space.data,
              });
            },
            { maxBytes: space.data },
          );
        } catch (error) {
          throw asDiskLow(error, "data");
        }
        job.progress(AUDIO_DOWNLOAD_PROGRESS_SHARE);
        await this.deps.ingest.transcodeAudio(
          { path: data.pathOf(trackRef) },
          { path: downloadPath },
          { bitrateKbps: CACHE_AUDIO_MP3_KBPS },
          (value) => job.progress(AUDIO_DOWNLOAD_PROGRESS_SHARE + value * (1 - AUDIO_DOWNLOAD_PROGRESS_SHARE)),
          signal,
        );
      });
    } finally {
      await data.remove(trackRef).catch(() => undefined);
    }
    const identity = await this.identityOf(downloadPath);
    const done = await publishCache(this.swapDeps(), {
      owner: job.owner,
      contentId: job.content.id,
      assetId: job.request.assetId,
      downloadPath,
      targetRef: cacheRefOf(audioCacheFileName(job.request.stem)),
      type: "audio",
      mimeType: MP3_MIME,
      identity,
      ...(job.request.overwrite === undefined ? {} : { overwrite: job.request.overwrite }),
      createdAt: this.now(),
    });
    job.progress(1);
    return { ...done, aboveRequested: false };
  }

  /** Reads both volumes and reserves `need` against them; returns the room each had for this download. */
  private async admit(assetId: string, need: Partial<CacheReservation>): Promise<{ data: number; cache: number }> {
    const usage = await readCacheVolumes({ data: this.deps.media.data, cache: this.deps.media.cache, sameVolume: this.deps.sameVolume });
    const space = this.deps.ledger.admit(assetId, usage, this.deps.settings.effective(), need);
    return { data: space.data.availableBytes, cache: space.cache.availableBytes };
  }

  /**
   * Runs `work` while both volumes are read every `diskCheckIntervalMs`: one below its
   * low-water mark aborts the work and the run fails with `disk_low`. An unreadable volume
   * stops nothing; the next reading decides.
   */
  private async watchingDisks(signal: AbortSignal, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    if (signal.aborted) {
      forward();
    }
    let low: CacheVolume | undefined;
    let checking = false;
    const check = async () => {
      if (checking || low !== undefined) {
        return;
      }
      checking = true;
      try {
        const settings = this.deps.settings.effective();
        const [data, cache] = await Promise.all([this.deps.media.data.diskUsage(), this.deps.media.cache.diskUsage()]);
        low = cacheVolumeLow(cache, settings) ? "cache" : cacheVolumeLow(data, settings) ? "data" : undefined;
        if (low !== undefined) {
          controller.abort();
        }
      } catch {
        // Unreadable now; the next tick tries again.
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), this.deps.diskCheckIntervalMs ?? CACHE_DISK_CHECK_INTERVAL_MS);
    try {
      await work(controller.signal);
    } catch (error) {
      if (low !== undefined && !signal.aborted) {
        throw diskLow(low);
      }
      throw error;
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", forward);
    }
    if (low !== undefined) {
      throw diskLow(low);
    }
  }

  private async identityOf(path: string): Promise<FileIdentity> {
    const identity = await identityOf(path);
    if (identity === null) {
      throw amberError("internal", "the download left no file", { code: "internal.tool_failed" });
    }
    return identity;
  }

  private swapDeps() {
    return {
      repository: this.deps.repository,
      cache: this.deps.media.cache,
      locks: this.deps.locks,
      holds: this.deps.holds,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    };
  }
}

interface CacheJob {
  owner: string;
  content: Content;
  target: PlatformTarget;
  request: CacheMediaTaskRequestV3;
  progress: (progress: number) => void;
  signal: AbortSignal;
}

function resultOf(asset: MediaAsset, requestedType: CacheMediaType, published: Published | undefined): Record<string, unknown> {
  const height = verifiedCacheHeight(asset);
  return {
    assetId: asset.id,
    fileName: cacheFileNameOf(asset.storageRef),
    requestedType,
    actualType: cacheTypeOf(asset) ?? requestedType,
    ...(height === undefined ? {} : { height }),
    ...(published?.aboveRequested === true ? { aboveRequested: true } : {}),
    replaced: published?.replaced ?? [],
    evicted: [],
  };
}

/** Everything that decides the cache file: source, what was asked for, the frozen stem, expected height, confirmation and asset id. */
function inputDigestOf(target: PlatformTarget, contentId: string, request: CacheMediaTaskRequestV3): string {
  const fields = [
    target.adapter.kind,
    target.ref.platformContentId,
    target.ref.platformPartId ?? "",
    contentId,
    request.type,
    request.quality ?? "",
    request.stem,
    request.expectedHeight ?? "",
    request.overwrite?.assetId ?? "",
    request.overwrite?.fileName ?? "",
    request.assetId,
  ];
  return `sha256:${createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex")}`;
}
