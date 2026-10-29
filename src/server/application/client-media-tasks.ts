import { statSync } from "node:fs";
import { monotonicFactory } from "ulid";
import {
  audioCacheFileName,
  cacheFileNameOf,
  CACHE_QUALITY_TIERS,
  cacheQualityTier,
  cacheRefOf,
  fittedCacheStem,
  isCacheRef,
  labelledStem,
  sameCacheFileName,
  sanitizeCacheStem,
  videoCacheFileName,
} from "../../shared/cache-file-name.ts";
import { CACHE_MEDIA_MAX_HEIGHT } from "../../shared/defaults.ts";
import type { BurnRequest, CacheMediaInspectDto, CacheMediaInspectRequest, CacheMediaQualitiesDto, CacheMediaRequest, ContentCacheDto } from "../../shared/dto/media.ts";
import type { TaskAcceptedDto } from "../../shared/dto/task.ts";
import type { TaskKind } from "../../shared/enums.ts";
import { cacheFile } from "../../shared/i18n/zh-CN/cache-file.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import { displayTitle, displayTitleOf, type Content } from "../domain/content.ts";
import { AmberError, amberError, appError } from "../domain/errors.ts";
import { isVideoCache, verifiedCacheHeight, type MediaAsset } from "../domain/media-asset.ts";
import { incompatibleStreamDetail, mp4IncompatibleStreams } from "../domain/export/container-policy.ts";
import { burnTaskRequestSchema, cacheMediaTaskRequestSchema, cacheMediaTaskRequestV4Schema } from "../domain/task-request.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { VideoTarget } from "../ports/platform-source.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { SubtitleMuxer } from "../ports/subtitle-muxer.ts";
import { readCacheVolumes, type CacheDownloadLedger, type CacheReservation } from "../pipeline/cache-download-ledger.ts";
import type { CacheHoldRegistry } from "../pipeline/cache-holds.ts";
import { verifyCacheQualities } from "../pipeline/cache-quality.ts";
import { cacheRowsAt, cacheTypeOf, sameQualityCaches } from "../pipeline/cache-swap.ts";
import { cacheVolumeLow, diskLowAfterWriting, diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import type { FairGroupRef } from "../pipeline/fair-semaphore.ts";
import type { CacheFileStore } from "../pipeline/media-files.ts";
import { laneConflict, laneKeys, mutationLaneError } from "../pipeline/lane.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { transact } from "../pipeline/publish.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import { audioReservation, mp3EstimateBytes, videoReservation } from "../pipeline/stages/cache-media.ts";
import { platformTarget, type PlatformAccess } from "../pipeline/stages/platform-access.ts";
import { assetPath, availableVideoSource, isOriginalMedia, type AssetPathResolver } from "../pipeline/stages/source-media.ts";
import { createTask } from "../pipeline/task-state.ts";
import { jsonRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";
import type { TaskControl } from "./tasks.ts";

export const CACHE_MEDIA_ROUTE = "POST /api/contents/:id/cache-media";
export const BURN_ROUTE = "POST /api/contents/:id/burn";

export interface ClientMediaTaskServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  /** The data directory's volume, where a burn product and an audio cache's track land. */
  disk: DiskUsageProbe;
  /** The cache store: a download lands on its volume, which may not be the data directory's. */
  cache: Pick<CacheFileStore, "diskUsage" | "isAvailable" | "directory" | "pathOf">;
  /**
   * Whether a file exists at a cache ref right now. Synchronous because it is asked inside
   * the submitting transaction, which cannot await.
   */
  cacheFileExists: (ref: string) => boolean;
  /** Whether the data directory and the cache directory are on one volume. */
  sameVolume: () => boolean | Promise<boolean>;
  /** Space the cache downloads in flight reserved, which the inspection's disk answer counts. */
  ledger: Pick<CacheDownloadLedger, "space">;
  /** Interrupted cache replacements waiting for the user. */
  holds: Pick<CacheHoldRegistry, "isHeld">;
  /**
   * Settles the interrupted replacements of a cache directory that was not mounted at
   * start-up, once it is, so an inspection reports their holds and no cache Task is
   * admitted before them.
   */
  recoverSwaps?: () => Promise<void>;
  /** The platform adapters and logins, for the format check of an inspection. */
  platforms: PlatformAccess;
  /** The managed heavy-job governor the inspection's format check and probes run under. */
  heavy?: { run<T>(ref: FairGroupRef, signal: AbortSignal, work: () => Promise<T>): Promise<T> };
  settings: InstanceSettingsSource;
  /** Where a source video is read from by its kind, for inspecting it before a styled export. */
  media: AssetPathResolver;
  /** Reads the streams of a styled export's source video and the height of video caches. */
  muxer: Pick<SubtitleMuxer, "inspect">;
  now?: () => number;
  newId?: () => string;
}

/** What the format check expects a cache request to produce. */
interface CacheEstimate {
  type: "video" | "audio";
  height?: number;
  ext: "mp4" | "webm" | "mp3";
  /** The expected size of the cache file. */
  sizeBytes?: number;
  /** What the download reserves per volume. */
  reservation: Partial<CacheReservation>;
}

/**
 * The client-only Tasks: caching a platform video or its audio as a `platform_cache` asset
 * and burning subtitles into a video. Both are 202 + Task, carry an Idempotency-Key and
 * freeze their request at submission.
 */
export class ClientMediaTaskService {
  private readonly options: ClientMediaTaskServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  /**
   * The last inspection's expected height per owner, Content, type, cap and stem, which the
   * submission right after it freezes as its estimate. Consumed by that submission.
   */
  private readonly estimates = new Map<string, number>();

  constructor(options: ClientMediaTaskServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /**
   * `POST /api/contents/:id/cache-media/inspect` [client]: what a cache request would
   * produce, without downloading, inside the owner's foreground slot of the heavy-job
   * governor. The format check gives the expected type, height, container and size (a
   * source without picture is expected as audio); the answer names the file the request
   * is expected to write (`[?P]` while the tier is unknown), this Content's caches it
   * would replace, another Content's registered cache holding that name, whether a foreign
   * file, another Content's unfinished cache Task or an interrupted replacement holds it,
   * the room on both volumes and the Content's caches. Video caches an earlier build
   * registered without reading their height are probed first, so the list and the
   * replacement are right.
   */
  async inspectCacheMedia(principal: RequestPrincipal, contentId: string, body: CacheMediaInspectRequest, signal: AbortSignal): Promise<CacheMediaInspectDto> {
    const owner = principal.userId;
    const cache = this.options.cache;
    if (!(await cache.isAvailable())) {
      throw amberError("conflict", "the video cache root is not available", { code: "conflict.cache_unavailable" });
    }
    await this.options.recoverSwaps?.();
    const type = body.type ?? "video";
    const { content, stem } = this.options.repository.withTransaction((scope) => {
      const found = this.platformContent(scope, owner, contentId);
      return { content: found, stem: this.stemFor(found, body.fileName) };
    });
    const work = async (): Promise<CacheMediaInspectDto> => {
      await verifyCacheQualities(
        { repository: this.options.repository, cache, muxer: this.options.muxer },
        this.options.repository.withTransaction((scope) => scope.mediaAssets.listByContent(owner, content.id)),
        signal,
      );
      const estimate = await this.estimate(content, type, videoTargetOf(body.quality), signal);
      const fileName = estimate.type === "audio" ? audioCacheFileName(stem) : videoCacheFileName(stem, estimate.height, estimate.ext as "mp4" | "webm");
      // A name with an unknown height is only shown; nothing can hold it yet.
      const nameKnown = estimate.type === "audio" || estimate.height !== undefined;
      const ref = cacheRefOf(fileName);
      const usage = await readCacheVolumes({ data: this.options.disk, cache, sameVolume: this.options.sameVolume });
      const space = this.options.ledger.space(usage, this.options.settings.effective(), estimate.reservation);
      const answer = this.options.repository.withTransaction((scope) => {
        const own = scope.mediaAssets.listByContent(owner, content.id);
        const replaces = [
          ...sameQualityCaches(own, estimate.type, estimate.height),
          ...(nameKnown ? own.filter((asset) => asset.availability === "available" && sameCacheFileName(asset.storageRef, ref)) : []),
        ].filter((asset, index, all) => all.findIndex((other) => other.id === asset.id) === index);
        const holder = nameKnown ? cacheRowsAt(scope, ref).find((asset) => asset.availability === "available") : undefined;
        const foreignHolder = holder !== undefined && holder.contentId !== content.id;
        const holderContent = foreignHolder ? scope.contents.getIncludingTrashed(holder.userId, holder.contentId) : undefined;
        const holderTitle = holderContent === undefined ? undefined : displayTitleOf(holderContent);
        return {
          replaces: replaces.map((asset) => {
            const height = verifiedCacheHeight(asset);
            return { assetId: asset.id, fileName: cacheFileNameOf(asset.storageRef), ...(height === undefined ? {} : { height }), sizeBytes: asset.sizeBytes };
          }),
          ...(foreignHolder && holder.userId === owner
            ? {
                overwrite: {
                  assetId: holder.id,
                  contentId: holder.contentId,
                  ...(holderTitle === undefined ? {} : { title: holderTitle }),
                  fileName: cacheFileNameOf(holder.storageRef),
                  sizeBytes: holder.sizeBytes,
                },
              }
            : {}),
          foreignFile: nameKnown && this.isForeign(scope, ref, holder, owner),
          pendingName: this.pendingName(scope, content, estimate.type, stem, estimate.height),
          caches: own.filter((asset) => asset.availability === "available" && cacheTypeOf(asset) !== undefined).map(contentCacheDto),
        };
      });
      const estimateKey = this.estimateKey(owner, content.id, type, body.quality, stem);
      if (estimate.height !== undefined || estimate.type === "audio") {
        this.estimates.set(estimateKey, estimate.height ?? 0);
      } else {
        // The latest inspection knows no height: an earlier one's must not be frozen in its place.
        this.estimates.delete(estimateKey);
      }
      return {
        expected: {
          type: estimate.type,
          ...(estimate.height === undefined ? {} : { height: estimate.height }),
          ext: estimate.ext,
          ...(estimate.sizeBytes === undefined ? {} : { sizeBytes: estimate.sizeBytes }),
        },
        expectedFileName: fileName,
        ...answer,
        recoveryHold: nameKnown && this.options.holds.isHeld(ref),
        disk: {
          cache: { freeBytes: space.cache.freeBytes, lowWaterBytes: space.cache.lowWaterBytes },
          ...(estimate.type === "audio" ? { data: { freeBytes: space.data.freeBytes, lowWaterBytes: space.data.lowWaterBytes } } : {}),
          ok: space.shortfall === undefined,
        },
      };
    };
    const heavy = this.options.heavy;
    return heavy === undefined ? work() : heavy.run({ key: `foreground:${owner}`, createdAt: this.now() }, signal, work);
  }

  /**
   * `GET /api/contents/:id/cache-media/qualities` [client]: the quality tiers the source
   * currently offers, read from the platform's metadata with the login the download would
   * use, inside the owner's foreground slot of the heavy-job governor. The adapter names
   * each tier with the picture size of the stream a download in that tier selects; tiers
   * outside `CACHE_QUALITY_TIERS` are dropped and the rest returned ascending, one entry per
   * tier: `available` when there are any, `audio_only` when the source lists no usable video
   * stream, `unknown` when its metadata has no format list. Nothing is read from the cache
   * directory, so an unmounted cache root does not stop the probe. A yt-dlp failure is
   * passed on as is.
   */
  async listCacheQualities(principal: RequestPrincipal, contentId: string, signal: AbortSignal): Promise<CacheMediaQualitiesDto> {
    const owner = principal.userId;
    const content = this.options.repository.withTransaction((scope) => this.platformContent(scope, owner, contentId));
    const work = async (): Promise<CacheMediaQualitiesDto> => {
      const target = platformTarget(this.options.platforms, content);
      if (target === undefined) {
        throw amberError("invalid_request", "only platform contents have media to cache", { params: { detail: "contentId" } });
      }
      const { adapter, auth, ref } = target;
      if (typeof adapter.listVideoQualities !== "function") {
        throw amberError("internal", `the ${adapter.kind} adapter cannot list video qualities`);
      }
      const listed = await adapter.listVideoQualities(ref, auth, signal);
      if (listed === undefined) {
        return { status: "unknown", qualities: [] };
      }
      const qualities = CACHE_QUALITY_TIERS.flatMap((tier) => {
        const found = listed.find((quality) => quality.tier === tier);
        return found === undefined ? [] : [{ tier, width: found.width, height: found.height }];
      });
      return qualities.length === 0 ? { status: "audio_only", qualities: [] } : { status: "available", qualities };
    };
    const heavy = this.options.heavy;
    return heavy === undefined ? work() : heavy.run({ key: `foreground:${owner}`, createdAt: this.now() }, signal, work);
  }

  /**
   * Only a platform Content has media to download. `type` defaults to
   * `video`, downloaded in the requested tier exactly, or without one under the height cap
   * `CACHE_MEDIA_MAX_HEIGHT`. The low-water probe
   * is the cache volume's for a video, and also the data volume's for audio, which is
   * downloaded into the data directory before it is transcoded into the cache; the stage
   * reserves the full budget once the sizes are known. An unmounted custom cache root
   * refuses the Task up front (`conflict.cache_unavailable`).
   *
   * Frozen with the request (schema v4): the cleaned stem, the new asset's id, the tier, the
   * height the preceding inspection expected and the user's confirmation to replace another
   * Content's cache (`overwriteAssetId`). That cache must still be available, the owner's,
   * hold the expected file name and have a fingerprint, and its Content must have no
   * unfinished Task. Another Content's unfinished cache Task with the same stem and a same or
   * unknown height refuses the request (`conflict.cache_name_pending`): the two would race
   * for one file name.
   */
  async cacheMedia(principal: RequestPrincipal, contentId: string, body: CacheMediaRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const cache = this.options.cache;
    if (!(await cache.isAvailable())) {
      throw amberError("conflict", "the video cache root is not available", { code: "conflict.cache_unavailable" });
    }
    await this.options.recoverSwaps?.();
    const type = body.type ?? "video";
    const probes = type === "audio" ? [this.options.disk] : [];
    // The estimate is consumed only once the Task exists: a submission refused after reading
    // it (a lane conflict, a failed transaction) leaves it for the retry.
    let consumed: string | undefined;
    const result = await this.create(principal, contentId, body, idempotencyKey, CACHE_MEDIA_ROUTE, "cache_media", () => this.checkDisks(probes, [cache]), (content, scope) => {
      if (content.source.kind === "local") {
        throw amberError("invalid_request", "only platform contents have media to cache", { params: { detail: "contentId" } });
      }
      const stem = this.stemFor(content, body.fileName);
      const key = this.estimateKey(owner, content.id, type, body.quality, stem);
      const estimated = this.estimates.get(key);
      const expectedHeight = type === "video" && estimated !== undefined && estimated > 0 ? estimated : undefined;
      if (this.pendingName(scope, content, type, stem, expectedHeight)) {
        throw amberError("conflict", "another content's unfinished cache task uses this file name", { code: "conflict.cache_name_pending" });
      }
      const expectedName = type === "audio" ? audioCacheFileName(stem) : expectedHeight === undefined ? undefined : labelledStem(stem, expectedHeight);
      const overwrite = body.overwriteAssetId === undefined ? undefined : this.checkOverwrite(scope, owner, content, body.overwriteAssetId, type, expectedName);
      consumed = key;
      return canonicalJson(
        cacheMediaTaskRequestV4Schema.parse({
          requestSchemaVersion: 4,
          kind: "cache_media",
          type,
          // Only a tier the user chose is frozen: without one the download keeps the cap meaning.
          ...(type === "video" && body.quality !== undefined ? { quality: body.quality } : {}),
          stem,
          ...(expectedHeight === undefined ? {} : { expectedHeight }),
          assetId: this.newId(),
          ...(overwrite === undefined ? {} : { overwrite }),
        }),
      );
    });
    if (consumed !== undefined) {
      this.estimates.delete(consumed);
    }
    return result;
  }

  /** The owner's Content as a cache source: it must exist and come from a platform. */
  private platformContent(scope: RepositoryScope, owner: string, contentId: string): Content {
    const content = scope.contents.get(owner, contentId);
    if (content === undefined) {
      throw amberError("not_found", `content ${contentId}`);
    }
    if (content.source.kind === "local") {
      throw amberError("invalid_request", "only platform contents have media to cache", { params: { detail: "contentId" } });
    }
    return content;
  }

  /**
   * The stem of the cache file name: the cleaned request name when the request has one,
   * else the cleaned display title; whichever cleans to nothing becomes the i18n untitled
   * name. Shortened to fit the Windows path limit under the current cache directory. Never
   * numbered: the same name means the same cache.
   */
  private stemFor(content: Content, requested: string | undefined): string {
    // A name the user typed but that cleans to nothing falls back to the untitled name, not
    // to the title: the user cleared the prefilled title on purpose.
    const base = sanitizeCacheStem(requested ?? displayTitle(content) ?? "") ?? (sanitizeCacheStem(cacheFile.untitled) as string);
    const fitted = fittedCacheStem(base, this.options.cache.directory());
    if (fitted === undefined) {
      throw amberError("invalid_request", "the cache directory path leaves no room for a file name", { params: { detail: "fileName" } });
    }
    return fitted;
  }

  // A named tier and an omitted one select differently (exactly that tier, or the best under
  // the default cap), so their estimates are kept apart even when the tier is the cap.
  private estimateKey(owner: string, contentId: string, type: string, quality: number | undefined, stem: string): string {
    return [owner, contentId, type, type === "video" ? (quality === undefined ? "cap" : String(quality)) : "", stem.toLowerCase()].join("\u0000");
  }

  /** The format check: what the adapter would download for `type` and the video `target`. */
  private async estimate(content: Content, type: "video" | "audio", target: VideoTarget, signal: AbortSignal): Promise<CacheEstimate> {
    const platform = platformTarget(this.options.platforms, content);
    if (platform === undefined) {
      throw amberError("invalid_request", "only platform contents have media to cache", { params: { detail: "contentId" } });
    }
    const { adapter, auth, ref } = platform;
    if (type === "video") {
      if (typeof adapter.inspectVideo !== "function") {
        throw amberError("internal", `the ${adapter.kind} adapter cannot download video`);
      }
      const video = await adapter.inspectVideo(ref, auth, target, signal);
      if (video.hasVideo) {
        return {
          type: "video",
          ...(video.height === undefined ? {} : { height: cacheQualityTier(video.height, video.width) }),
          ext: video.mimeType === "video/webm" ? "webm" : "mp4",
          ...(video.sizeBytes === undefined ? {} : { sizeBytes: video.sizeBytes }),
          reservation: videoReservation(video.sizeBytes),
        };
      }
    }
    if (typeof adapter.inspectAudio !== "function") {
      throw amberError("internal", `the ${adapter.kind} adapter cannot inspect audio`);
    }
    const audio = await adapter.inspectAudio(ref, auth, signal);
    const mp3 = mp3EstimateBytes(content.durationMs);
    return { type: "audio", ext: "mp3", ...(mp3 === undefined ? {} : { sizeBytes: mp3 }), reservation: audioReservation(audio.sizeBytes, content.durationMs) };
  }

  /**
   * Whether the file at `ref` would be refused as foreign: a file no available row holds
   * (unless an evicted row of the same size left it behind), a holder without fingerprint,
   * or another user's cache. The digest itself is checked when the cache is published.
   */
  private isForeign(scope: RepositoryScope, ref: string, holder: MediaAsset | undefined, owner: string): boolean {
    if (!this.options.cacheFileExists(ref)) {
      return false;
    }
    if (holder !== undefined) {
      return holder.fingerprint === undefined || holder.fingerprint === "" || holder.userId !== owner;
    }
    const size = statSize(this.options.cache.pathOf(ref));
    return !cacheRowsAt(scope, ref).some((asset) => asset.fingerprint !== undefined && asset.sizeBytes === size);
  }

  /**
   * Whether another Content's unfinished cache Task froze the same stem for the same type
   * with the same or an unknown height: both would write one file name.
   */
  private pendingName(scope: RepositoryScope, content: Content, type: "video" | "audio", stem: string, height: number | undefined): boolean {
    return scope.tasks.listUnfinished().some((task) => {
      if (task.kind !== "cache_media" || task.contentId === content.id) {
        return false;
      }
      const request = cacheMediaTaskRequestSchema.safeParse(JSON.parse(task.requestJson));
      // Only version 3 and later freeze a stem; older requests are refused by their stage.
      if (!request.success || request.data.requestSchemaVersion === 1 || request.data.requestSchemaVersion === 2 || request.data.type !== type || !sameCacheFileName(request.data.stem, stem)) {
        return false;
      }
      return type === "audio" || height === undefined || request.data.expectedHeight === undefined || request.data.expectedHeight === height;
    });
  }

  /**
   * The confirmation to replace another Content's cache, checked at submission: still the
   * owner's available cache, holding the expected name (`conflict.cache_name_taken`
   * otherwise), registered with a fingerprint (`conflict.cache_file_foreign`), and its
   * Content without unfinished Tasks (`conflict.tasks_unfinished`).
   */
  private checkOverwrite(
    scope: RepositoryScope,
    owner: string,
    content: Content,
    assetId: string,
    type: "video" | "audio",
    expectedName: string | undefined,
  ): { assetId: string; fileName: string } {
    const held = scope.mediaAssets.get(owner, assetId);
    const fileName = held === undefined || !isCacheRef(held.storageRef) ? undefined : cacheFileNameOf(held.storageRef);
    const holdsName =
      fileName !== undefined &&
      expectedName !== undefined &&
      (type === "audio" ? sameCacheFileName(fileName, expectedName) : fileName.toLowerCase().startsWith(`${expectedName.toLowerCase()}.`));
    if (held === undefined || held.kind !== "platform_cache" || held.availability !== "available" || held.contentId === content.id || !holdsName) {
      throw amberError("conflict", "the cache to replace no longer holds the expected file name", { code: "conflict.cache_name_taken" });
    }
    if (held.fingerprint === undefined || held.fingerprint === "") {
      throw amberError("conflict", "the cache to replace has no fingerprint to verify it by", { code: "conflict.cache_file_foreign" });
    }
    if (scope.tasks.listByContent(owner, held.contentId).some((task) => !isTerminalProjection(task.statusProjection))) {
      throw amberError("conflict", "the content whose cache would be replaced has unfinished tasks", { code: "conflict.tasks_unfinished" });
    }
    return { assetId: held.id, fileName: fileName as string };
  }

  /**
   * The revisions are checked the way subtitle export checks them: both belong to the
   * Content, the exported original is not itself a translation, and a translation is one of
   * that original. A video must be available now (the original or a video cache; an audio
   * cache has no picture).
   *
   * Without `delivery` / `container` / `style` this is the legacy burn-in, frozen as schema
   * version 1, whose stage picks the source when it runs. With them (schema version 2) the
   * source is the user's `sourceAssetId` (the original or one of the video caches, available
   * and of this Content) or else the original, else the highest cached quality; it is
   * inspected now and frozen with its fingerprint; a soft-subtitle MP4
   * is refused when the source has streams outside the MP4 rule, and the data volume must
   * stay above the low-water mark after an output the size of the source.
   */
  async burn(principal: RequestPrincipal, contentId: string, body: BurnRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const { delivery, container, style } = body;
    if (delivery === undefined || container === undefined || style === undefined) {
      return this.create(principal, contentId, body, idempotencyKey, BURN_ROUTE, "burn", () => this.checkDisks([this.options.disk]), (content, scope) => {
        checkBurnRevisions(scope, owner, content, body);
        if (availableVideoSource(scope, owner, content.id) === undefined) {
          throw amberError("media_missing", "no available video to burn subtitles into");
        }
        return canonicalJson(
          burnTaskRequestSchema.parse({
            requestSchemaVersion: 1,
            kind: "burn",
            mode: body.mode,
            revisionId: body.revisionId,
            ...(body.translationRevisionId === undefined ? {} : { translationRevisionId: body.translationRevisionId }),
          }),
        );
      });
    }
    let source: MediaAsset | undefined;
    const prepare = async (): Promise<void> => {
      const picked = this.options.repository.withTransaction((scope) => {
        const content = scope.contents.get(owner, contentId);
        if (content === undefined) {
          throw amberError("not_found", `content ${contentId}`);
        }
        checkBurnRevisions(scope, owner, content, body);
        return body.sourceAssetId === undefined ? availableVideoSource(scope, owner, content.id) : chosenSource(scope, owner, content, body.sourceAssetId);
      });
      if (picked === undefined) {
        throw amberError("media_missing", "no available video to export subtitles with");
      }
      const inspection = await this.options.muxer.inspect(assetPath(picked, this.options.media), new AbortController().signal);
      if (delivery === "soft" && container === "mp4") {
        const incompatible = mp4IncompatibleStreams(inspection.streams);
        if (incompatible.length > 0) {
          throw amberError("invalid_request", "the video has streams an MP4 cannot carry", {
            code: "invalid_request.container_unsupported",
            details: { streams: incompatible.map(incompatibleStreamDetail) },
          });
        }
      }
      // The output is about the size of the source: re-encoding at a comparable quality or copying it.
      const low = await diskLowAfterWriting(this.options.disk, this.options.settings.effective(), picked.sizeBytes);
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark after the export");
      }
      source = picked;
    };
    return this.create(principal, contentId, body, idempotencyKey, BURN_ROUTE, "burn", prepare, (content, scope) => {
      checkBurnRevisions(scope, owner, content, body);
      const frozen = source === undefined ? undefined : scope.mediaAssets.get(owner, source.id);
      // The inspected file must still be there, unchanged, when the request is frozen.
      if (frozen === undefined || frozen.availability !== "available" || frozen.fingerprint !== source?.fingerprint) {
        throw amberError("media_missing", "the video to export subtitles with is no longer available");
      }
      return canonicalJson(
        burnTaskRequestSchema.parse({
          requestSchemaVersion: 2,
          kind: "burn",
          mode: body.mode,
          revisionId: body.revisionId,
          ...(body.translationRevisionId === undefined ? {} : { translationRevisionId: body.translationRevisionId }),
          source: { assetId: frozen.id, ...(frozen.fingerprint === undefined ? {} : { fingerprint: frozen.fingerprint }) },
          delivery,
          container,
          style,
        }),
      );
    });
  }

  /**
   * The low-water gate of new work on each volume it writes to. Data volumes also answer to
   * `maxDataGB`; the cache volume only to its free-space floor, the cache having no size cap.
   */
  private async checkDisks(disks: readonly DiskUsageProbe[], cacheVolumes: readonly DiskUsageProbe[] = []): Promise<void> {
    const settings = this.options.settings.effective();
    for (const disk of disks) {
      const low = await diskLowError(disk, settings);
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark");
      }
    }
    for (const disk of cacheVolumes) {
      if (cacheVolumeLow(await disk.diskUsage(), settings)) {
        throw new AmberError(appError("disk_low"), "cache volume below the low-water mark");
      }
    }
  }

  private async create(
    principal: RequestPrincipal,
    contentId: string,
    body: CacheMediaRequest | BurnRequest,
    idempotencyKey: string | undefined,
    route: string,
    kind: TaskKind,
    /** Checks that only run for a new request, never for a replay: disk space, source inspection. */
    precheck: () => Promise<void>,
    requestJsonFor: (content: Content, scope: RepositoryScope) => string,
  ): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const context = { userId: owner, route, key: idempotencyKey, requestDigest: jsonRequestDigest({ contentId, body }) };
    const replay = this.options.repository.withTransaction((scope) =>
      idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, route, idempotencyKey),
    );
    if (replay === undefined) {
      await precheck();
    }
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
      runIdempotent(scope, context, this.now(), () => {
        const content = scope.contents.get(owner, contentId);
        if (content === undefined) {
          throw amberError("not_found", `content ${contentId}`);
        }
        const requestJson = requestJsonFor(content, scope);
        const candidate = { id: "", kind, requestJson };
        const others = scope.tasks
          .listByContent(owner, contentId)
          .filter((task) => !isTerminalProjection(task.statusProjection))
          .map((task) => ({ task, keys: laneKeys(task, content.source.kind) }));
        const blocking = laneConflict(laneKeys(candidate, content.source.kind), others);
        if (blocking !== undefined) {
          throw mutationLaneError(blocking, "another unfinished task works on the same stages");
        }
        const task = createTask(scope, outbox, {
          task: { id: this.newId(), userId: owner, contentId, kind, requestJson, createdAt: this.now() },
          sourceKind: content.source.kind,
          newId: this.newId,
        });
        return { status: 202, body: { taskId: task.id }, resourceRefs: [task.id] };
      }),
    );
    if (!result.replayed) {
      this.options.control.kick();
    }
    return result;
  }
}

/**
 * Both revisions belong to the Content, the original is not itself a translation, and a
 * translation is one of that original — the checks subtitle export makes.
 */
function checkBurnRevisions(scope: RepositoryScope, owner: string, content: Content, body: BurnRequest): void {
  const revision = scope.transcripts.getRevision(owner, body.revisionId);
  if (revision === undefined || revision.contentId !== content.id) {
    throw amberError("not_found", "transcript revision not found");
  }
  if (revision.kind === "translated") {
    throw amberError("invalid_request", "burn the translation through translationRevisionId", { params: { detail: "revisionId" } });
  }
  if (body.translationRevisionId !== undefined) {
    const translation = scope.transcripts.getRevision(owner, body.translationRevisionId);
    if (translation === undefined || translation.contentId !== content.id) {
      throw amberError("not_found", "transcript revision not found");
    }
    if (translation.kind !== "translated" || translation.parentRevisionId !== revision.id) {
      throw amberError("invalid_request", "the translation is not a translation of the burned revision", { params: { detail: "translationRevisionId" } });
    }
  }
}

/**
 * The source video the user picked for a styled export: an asset of this Content
 * (`invalid_request` otherwise) holding the original or a video cache, available now
 * (`media_missing` otherwise).
 */
function chosenSource(scope: RepositoryScope, owner: string, content: Content, assetId: string): MediaAsset {
  const asset = scope.mediaAssets.get(owner, assetId);
  if (asset === undefined || asset.contentId !== content.id || !(isOriginalMedia(asset) || isVideoCache(asset))) {
    throw amberError("invalid_request", "the source video is not an original or a video cache of this content", { params: { detail: "sourceAssetId" } });
  }
  if (asset.availability !== "available") {
    throw amberError("media_missing", "the chosen source video is not available");
  }
  return asset;
}

/** One cache of the Content as the cache dialog lists it. */
function contentCacheDto(asset: MediaAsset): ContentCacheDto {
  const height = verifiedCacheHeight(asset);
  const type = cacheTypeOf(asset) as "video" | "audio";
  return {
    assetId: asset.id,
    type,
    ...(height === undefined ? {} : { height }),
    verified: type === "audio" || asset.qualityVerified === true,
    fileName: isCacheRef(asset.storageRef) ? cacheFileNameOf(asset.storageRef) : (asset.displayName ?? asset.id),
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
  };
}

/** What an inspection asks the adapter for: the chosen tier exactly, or without one the default cap. */
function videoTargetOf(quality: number | undefined): VideoTarget {
  return quality === undefined ? { maxHeight: CACHE_MEDIA_MAX_HEIGHT } : { tier: quality };
}

/** Size of the file at `path`, or `undefined` when it cannot be read. */
function statSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
