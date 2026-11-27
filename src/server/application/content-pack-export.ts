import { lstatSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { CONTENT_PACK_FILE_EXTENSION } from "../../shared/backup-names.ts";
import { CONTENT_PACK_EXPORT_TTL_MS, FIGURE_WEBP_QUALITY, SPEAKER_AVATAR_MAX_PX } from "../../shared/defaults.ts";
import type {
  ContentPackExportJobDto,
  ContentPackExportPlanDto,
  ContentPackExportPlanRequest,
  ContentPackExportRequest,
  ContentPackJobAcceptedDto,
  ContentPackSelection,
} from "../../shared/dto/content-pack.ts";
import type { FileGrant } from "../../shared/dto/local-media.ts";
import { CONTENT_PACK_BASE_FORMAT_VERSION, CONTENT_PACK_COVER_FORMAT_VERSION, CONTENT_PACK_FORMAT, PACK_COLLECTIONS_ENTRY } from "../domain/content-pack/document.ts";
import { AmberError, amberError, appError } from "../domain/errors.ts";
import { exportFilename } from "../domain/export/filename.ts";
import { inspectPackAvatar } from "../domain/figure-image.ts";
import { isPlatform } from "../domain/platform.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { CacheGate } from "../pipeline/cache-gate.ts";
import type { CachePathLocks } from "../pipeline/cache-path-locks.ts";
import { diskLowAfterWriting, diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import type { MediaFiles } from "../pipeline/media-files.ts";
import { toAppError } from "../pipeline/retry.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import type { ContentPackWriter, PackWriteEntry } from "../ports/content-pack.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { LocalMediaIngest } from "../ports/local-media-ingest.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { ContentPackEngine, PackExportBuild, PackExportMedia } from "./content-pack-engine.ts";
import { localStamp, PackJobSlots, packWorkPaths, quotaShortfall, sha256OfFile } from "./content-pack-jobs.ts";
import type { StorageQuota } from "./storage-quota.ts";

/** FAT and DrvFs keep modification times to whole seconds (FAT to two). */
const RECORD_TIME_SLACK_MS = 2000;
/** Room for the header, manifest and tar framing on top of the entries, per entry. */
const FRAMING_BYTES_PER_ENTRY = 2048;
/** The file name a server-mode pack is stored under in its job directory. */
const SERVER_PACK_FILE = `pack.${CONTENT_PACK_FILE_EXTENSION}`;

const jobRecordSchema = z.object({ jobId: z.string().min(1), target: z.string().min(1), startedAt: z.number().int() });
type JobRecord = z.infer<typeof jobRecordSchema>;

export interface ContentPackExportServiceOptions {
  mode: "server" | "local";
  repository: Repository;
  /** The library side: plans, documents, previews and per-Content commits. */
  engine: ContentPackEngine;
  files: FileStore;
  media: MediaFiles;
  /** Local mode: checks the shell's `pack_output` grant. */
  grants?: FileGrantVerifier;
  appVersion: string;
  logger?: Logger;
  writer: ContentPackWriter;
  /** A shared lease is held while a job runs: no cache move, backup export or update install meanwhile. */
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  /** Each cache file is hashed and copied under its path lock, so nothing replaces it meanwhile. */
  locks: Pick<CachePathLocks, "withLock">;
  /** Re-encodes speaker photos that fail the pack's avatar check. */
  ingest: Pick<LocalMediaIngest, "normalizeImage">;
  /** `<data dir>/tmp/content-packs`. */
  workDir: string;
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  /** Shared with the import service: one content pack job per user. */
  slots?: PackJobSlots;
  now?: () => number;
  newId?: () => string;
  /** Free bytes of the volume holding `path` (local mode destination). */
  freeBytes?: (path: string) => number;
  /**
   * Server mode: per-user storage limits. The pack waits in the data directory until it is
   * downloaded, so it counts against the user's limit like an upload would.
   */
  quota?: Pick<StorageQuota, "usage">;
  /**
   * False until the start-up recovery has finished. It clears the jobs' working directory,
   * so no job may start before.
   */
  backgroundReady?: () => boolean;
}

interface ExportJob {
  owner: string;
  dto: ContentPackExportJobDto;
  controller: AbortController;
  done: Promise<void>;
  /** Server mode: the finished pack until it is downloaded or expires. */
  file?: string | undefined;
  expiry?: NodeJS.Timeout | undefined;
  /** The status the job ends in; published only after its lease and slot are given back. */
  final?: ContentPackExportJobDto["status"];
}

function freeBytesOf(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Only a pack that carries a cover needs the format that has them; any other stays readable by older builds. */
function formatVersionOf(build: PackExportBuild): number {
  return build.contents.some((content) => content.document.cover !== undefined) ? CONTENT_PACK_COVER_FORMAT_VERSION : CONTENT_PACK_BASE_FORMAT_VERSION;
}

/** Platform Contents that travel with their cover URL only, having no local copy to carry. */
function coversLeftOut(build: PackExportBuild): number {
  return build.contents.filter((content) => isPlatform(content.document.source.kind) && content.document.cover === undefined).length;
}

function notFound(): AmberError {
  return amberError("not_found", "no such content pack export");
}

/**
 * Content pack exports. Local mode writes the pack to the file the user picked; server mode
 * builds it in the data directory's temporary area for one plain download.
 *
 * A job: the engine checks the selection again and builds every document (media digests the
 * library does not record are computed here, cache files under their path lock); then the
 * archive is written entry by entry, each media file copied under its lock and hashed again
 * — a file that no longer matches its document fails the job naming its Content. The whole
 * job holds a shared lease of the cache gate. Jobs live in memory, one per user at a time.
 */
export class ContentPackExportService {
  private readonly options: ContentPackExportServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly freeBytes: (path: string) => number;
  private readonly slots: PackJobSlots;
  private readonly jobs = new Map<string, ExportJob>();
  /** The user's latest export; an earlier one is forgotten (and its file removed) when a new one starts. */
  private readonly latest = new Map<string, string>();

  constructor(options: ContentPackExportServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.freeBytes = options.freeBytes ?? freeBytesOf;
    this.slots = options.slots ?? new PackJobSlots();
  }

  plan(principal: RequestPrincipal, request: ContentPackExportPlanRequest): ContentPackExportPlanDto {
    return this.options.engine.exportPlan(principal.userId, request);
  }

  /**
   * `POST /content-packs/exports`. In order: the destination grant (local mode), the engine's
   * check of the selection, the start-up recovery has finished (`conflict.starting_up`), the
   * disk watermark and the storage limit (server mode), the user's job slot and
   * the cache gate's shared lease; the exact space is checked once the documents exist.
   */
  async start(principal: RequestPrincipal, request: ContentPackExportRequest): Promise<ContentPackJobAcceptedDto> {
    const owner = principal.userId;
    const target = this.options.mode === "local" ? this.checkTarget(request.grant) : undefined;
    // Read-only, so it may answer first: another user's Content is unknown whatever the state.
    this.options.engine.validateSelection(owner, request.selection);
    if (this.options.backgroundReady?.() === false) {
      throw amberError("conflict", "start-up recovery still running", { code: "conflict.starting_up" });
    }
    if (this.options.mode === "server") {
      const low = await diskLowError(this.options.disk, this.options.settings.effective());
      if (low !== undefined) throw new AmberError(low, "disk below the low-water mark");
      // A user already at the limit is told now, not after the documents were built.
      await this.checkQuota(principal, 1);
    }
    const jobId = this.newId();
    this.slots.claim(owner, jobId);
    const release = this.options.gate.tryShared();
    if (release === undefined) {
      this.slots.release(owner, jobId);
      throw gateConflict(this.options.gate);
    }
    const paths = packWorkPaths(this.options.workDir);
    const startedAt = this.now();
    try {
      await mkdir(paths.exports, { recursive: true });
      if (target !== undefined) {
        await writeFile(join(paths.exports, `${jobId}.json`), JSON.stringify({ jobId, target, startedAt } satisfies JobRecord), { flag: "wx" });
      }
    } catch (error) {
      release();
      this.slots.release(owner, jobId);
      throw error;
    }
    this.forgetPrevious(owner);
    const job: ExportJob = {
      owner,
      dto: { jobId, status: "running", phase: "documents", bytesDone: 0, bytesTotal: 0 },
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(jobId, job);
    this.latest.set(owner, jobId);
    job.done = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(principal, job, request.selection, target, startedAt))
      .finally(async () => {
        await rm(join(paths.exports, `${jobId}.json`), { force: true }).catch(() => undefined);
        await rm(join(paths.scratch, jobId), { recursive: true, force: true }).catch(() => undefined);
        release();
        this.slots.release(owner, jobId);
        // A client that sees the job end may start the next one at once.
        job.dto.status = job.final ?? "failed";
      });
    return { jobId };
  }

  get(principal: RequestPrincipal, jobId: string): ContentPackExportJobDto {
    const job = this.owned(principal, jobId);
    this.expireIfDue(job);
    return structuredClone(job.dto);
  }

  async cancel(principal: RequestPrincipal, jobId: string): Promise<ContentPackExportJobDto> {
    const job = this.owned(principal, jobId);
    if (job.dto.status === "running") {
      job.controller.abort();
      await job.done;
    }
    return structuredClone(job.dto);
  }

  /**
   * Server mode: the finished pack for download. `onSent(true)` after the whole file went
   * out removes it; an interrupted download keeps it for another try until it expires.
   */
  download(principal: RequestPrincipal, jobId: string): { path: string; fileName: string; sizeBytes: number; onSent: (complete: boolean) => void } {
    const job = this.owned(principal, jobId);
    this.expireIfDue(job);
    const file = job.file;
    const result = job.dto.result;
    if (this.options.mode !== "server" || job.dto.status !== "succeeded" || file === undefined || result === undefined) {
      throw notFound();
    }
    return {
      path: file,
      fileName: result.fileName,
      sizeBytes: result.sizeBytes,
      onSent: (complete) => {
        if (complete && job.file === file) {
          this.dropFile(job);
        }
      },
    };
  }

  /** The caller's running export, if any. */
  active(principal: RequestPrincipal): string | undefined {
    const jobId = this.latest.get(principal.userId);
    const job = jobId === undefined ? undefined : this.jobs.get(jobId);
    return job?.dto.status === "running" ? jobId : undefined;
  }

  /** Stops a running export before the database closes under it. */
  async close(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.expiry !== undefined) clearTimeout(job.expiry);
      if (job.dto.status === "running") {
        job.controller.abort();
        await job.done;
      }
    }
  }

  /**
   * Start-up: removes what interrupted exports left. A local-mode `<target>.partial` goes
   * only when its job record names it, it is a regular file and it changed after the job
   * started; server-mode packs and records go with the directory.
   */
  async sweepLeftovers(): Promise<void> {
    const dir = packWorkPaths(this.options.workDir).exports;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      let record: JobRecord;
      try {
        record = jobRecordSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      } catch {
        this.options.logger?.warn("content_pack_export_record_unreadable");
        continue;
      }
      const partial = `${record.target}.partial`;
      const stats = lstatSync(partial, { throwIfNoEntry: false });
      if (stats?.isFile() === true && stats.mtimeMs + RECORD_TIME_SLACK_MS >= record.startedAt) {
        await rm(partial, { force: true });
        this.options.logger?.info("content_pack_export_leftover_removed", { jobId: record.jobId });
      } else if (stats !== undefined) {
        this.options.logger?.warn("content_pack_export_leftover_kept", { jobId: record.jobId });
      }
    }
    await rm(dir, { recursive: true, force: true });
    await rm(packWorkPaths(this.options.workDir).scratch, { recursive: true, force: true });
  }

  private owned(principal: RequestPrincipal, jobId: string): ExportJob {
    const job = this.jobs.get(jobId);
    // Another user's job is answered exactly like an unknown one.
    if (job === undefined || job.owner !== principal.userId) {
      throw notFound();
    }
    return job;
  }

  /** The destination the shell's save dialog signed as a `pack_output` grant. */
  private checkTarget(grant: FileGrant | undefined): string {
    const grants = this.options.grants;
    if (grant === undefined || grants === undefined || !grants.verify(grant, { path: grant.path, purpose: "pack_output" })) {
      throw amberError("unauthenticated", "content pack destination grant rejected", { code: "unauthenticated.file_grant" });
    }
    const target = grant.path;
    const invalid = (reason: string): never => {
      throw amberError("invalid_request", reason, { params: { detail: "grant.path" } });
    };
    if (!isAbsolute(target) && !win32.isAbsolute(target)) invalid("destination is not absolute");
    if (!target.toLowerCase().endsWith(`.${CONTENT_PACK_FILE_EXTENSION}`)) invalid("destination has the wrong extension");
    const existing = lstatSync(target, { throwIfNoEntry: false });
    // A link or junction would let the pack land somewhere the user did not pick.
    if (existing !== undefined && !existing.isFile()) invalid("destination is not a regular file");
    if (statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory() !== true) invalid("destination folder does not exist");
    if (lstatSync(`${target}.partial`, { throwIfNoEntry: false }) !== undefined) {
      throw amberError("conflict", "a partial content pack already exists at the destination", { code: "conflict.pack_job_active" });
    }
    return target;
  }

  private async run(principal: RequestPrincipal, job: ExportJob, selection: ContentPackSelection, target: string | undefined, startedAt: number): Promise<void> {
    const signal = job.controller.signal;
    const paths = packWorkPaths(this.options.workDir);
    const serverFile = join(paths.exports, job.dto.jobId, SERVER_PACK_FILE);
    try {
      signal.throwIfAborted();
      const build = await this.options.engine.buildExport(job.owner, selection, {
        hashMedia: (media, hookSignal) => this.withMediaFile(media, (path) => sha256OfFile(path, hookSignal)),
        normalizeAvatar: (bytes, hookSignal) => this.normalizeAvatar(job.dto.jobId, bytes, hookSignal),
        signal,
      });
      signal.throwIfAborted();
      const entries = this.entriesOf(build);
      const documentBytes = entries.reduce((sum, entry) => sum + ("bytes" in entry ? entry.bytes.length : 0), 0);
      job.dto.bytesTotal = entries.reduce((sum, entry) => sum + ("bytes" in entry ? entry.bytes.length : entry.size), 0);
      const need = job.dto.bytesTotal + (entries.length + 2) * FRAMING_BYTES_PER_ENTRY;
      await this.checkSpace(target, need);
      if (target === undefined) await this.checkQuota(principal, need);
      const destination = target ?? serverFile;
      if (target === undefined) {
        await mkdir(dirname(serverFile), { recursive: true });
      }
      job.dto.phase = "media";
      const written = await this.options.writer.write({
        target: destination,
        header: {
          format: CONTENT_PACK_FORMAT,
          formatVersion: formatVersionOf(build),
          amberVersion: this.options.appVersion,
          encryption: "none",
          createdAt: startedAt,
          contents: build.contents.map((content) => ({ key: content.document.key, entry: content.entry, ...(content.title === undefined ? {} : { title: content.title }) })),
        },
        entries,
        signal,
        onProgress: (bytesDone) => {
          job.dto.bytesDone = bytesDone;
          job.dto.phase = bytesDone < documentBytes ? "documents" : "media";
        },
      });
      if (!written.ok) {
        const content = build.contents.find((item) => item.contentId === written.changedContentId);
        job.final = "failed";
        job.dto.error = appError("media_changed");
        job.dto.failedContent = { contentId: written.changedContentId, ...(content?.title === undefined ? {} : { title: content.title }) };
        this.options.logger?.warn("content_pack_export_media_changed", { jobId: job.dto.jobId, contentId: written.changedContentId });
        return;
      }
      job.dto.phase = "finalize";
      job.dto.bytesDone = job.dto.bytesTotal;
      job.final = "succeeded";
      const fileName =
        target === undefined
          ? exportFilename(build.contents.length === 1 ? build.contents[0]?.title : undefined, `Amber-${localStamp(startedAt)}`, CONTENT_PACK_FILE_EXTENSION)
          : win32.basename(target.replace(/\\/g, "/"));
      job.dto.result = { fileName, sizeBytes: written.sizeBytes, contents: build.contents.length, coversLeftOut: coversLeftOut(build) };
      if (target === undefined) {
        const expiresAt = this.now() + CONTENT_PACK_EXPORT_TTL_MS;
        job.file = serverFile;
        job.dto.result.downloadPath = `/api/content-packs/exports/${job.dto.jobId}/file`;
        job.dto.result.expiresAt = expiresAt;
        job.expiry = setTimeout(() => this.expireIfDue(job), CONTENT_PACK_EXPORT_TTL_MS + 1);
        job.expiry.unref();
      }
      this.options.logger?.info("content_pack_export_finished", { jobId: job.dto.jobId, sizeBytes: written.sizeBytes, contents: build.contents.length });
    } catch (error) {
      if (signal.aborted) {
        job.final = "cancelled";
      } else {
        job.final = "failed";
        job.dto.error = toAppError(error);
        this.options.logger?.error("content_pack_export_failed", { jobId: job.dto.jobId, code: job.dto.error.code });
      }
      if (target === undefined) {
        await rm(dirname(serverFile), { recursive: true, force: true });
      }
    }
  }

  /** Archive order: collections, then each Content's document, revisions and images, then every media file. */
  private entriesOf(build: PackExportBuild): PackWriteEntry[] {
    const json = (name: string, value: unknown): PackWriteEntry => ({ name, bytes: Buffer.from(JSON.stringify(value), "utf8") });
    const entries: PackWriteEntry[] = [json(PACK_COLLECTIONS_ENTRY, build.collections)];
    for (const content of build.contents) {
      entries.push(json(content.entry, content.document));
      for (const revision of content.revisions) entries.push(json(revision.entry, revision.document));
      for (const image of content.images) entries.push({ name: image.entry, bytes: image.bytes });
    }
    for (const content of build.contents) {
      for (const media of content.media) {
        entries.push({
          name: media.entry,
          size: media.sizeBytes,
          sha256: media.sha256,
          contentId: media.contentId,
          withFile: (work) => this.withMediaFile(media, work),
        });
      }
    }
    return entries;
  }

  /** Runs `work` with the media file's path; a cache file under its path lock. */
  private withMediaFile<T>(media: Pick<PackExportMedia, "kind" | "location">, work: (path: string) => Promise<T>): Promise<T> {
    const { location } = media;
    if ("path" in location) {
      return work(location.path);
    }
    if (media.kind === "cache") {
      return this.options.locks.withLock(location.storageRef, () => work(this.options.media.cache.pathOf(location.storageRef)));
    }
    return work(this.options.media.data.pathOf(location.storageRef));
  }

  /** A speaker photo the pack's structural check refuses, re-encoded to WebP through job files. */
  private async normalizeAvatar(jobId: string, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    const dir = join(packWorkPaths(this.options.workDir).scratch, jobId);
    await mkdir(dir, { recursive: true });
    const name = this.newId();
    const input = join(dir, `${name}.in`);
    const output = join(dir, `${name}.webp`);
    try {
      await writeFile(input, bytes, { flag: "wx" });
      await this.options.ingest.normalizeImage({ path: input }, { path: output }, { maxLongEdge: SPEAKER_AVATAR_MAX_PX, quality: FIGURE_WEBP_QUALITY }, signal);
      const normalized = await readFile(output);
      if (!inspectPackAvatar(normalized, "image/webp").ok) {
        throw amberError("invalid_request", "a speaker photo cannot be carried", { code: "invalid_request.figure_image", details: { reason: "corrupt" } });
      }
      return normalized;
    } finally {
      await rm(input, { force: true });
      await rm(output, { force: true });
    }
  }

  private async checkSpace(target: string | undefined, need: number): Promise<void> {
    if (target !== undefined) {
      if (this.freeBytes(dirname(target)) < need) {
        throw amberError("disk_low", "not enough free space for the content pack");
      }
      return;
    }
    // The pack waits in the data directory until downloaded: it counts against the watermark.
    const low = await diskLowAfterWriting(this.options.disk, this.options.settings.effective(), need);
    if (low !== undefined) {
      throw new AmberError(low, "not enough free space for the content pack");
    }
  }

  private async checkQuota(principal: RequestPrincipal, need: number): Promise<void> {
    const quota = this.options.quota;
    if (quota === undefined) return;
    const shortfall = quotaShortfall(await quota.usage(principal), need);
    if (shortfall !== undefined) throw shortfall;
  }

  private expireIfDue(job: ExportJob): void {
    const expiresAt = job.dto.result?.expiresAt;
    if (job.file !== undefined && expiresAt !== undefined && this.now() >= expiresAt) {
      this.dropFile(job);
    }
  }

  /** The download is gone for good: the file, its link and its timer. */
  private dropFile(job: ExportJob): void {
    const file = job.file;
    job.file = undefined;
    if (job.expiry !== undefined) clearTimeout(job.expiry);
    job.expiry = undefined;
    if (job.dto.result !== undefined) {
      delete job.dto.result.downloadPath;
      delete job.dto.result.expiresAt;
    }
    if (file !== undefined) {
      void rm(dirname(file), { recursive: true, force: true }).catch((error: unknown) =>
        this.options.logger?.warn("content_pack_export_file_remove_failed", { error: (error as NodeJS.ErrnoException).code ?? "error" }),
      );
    }
  }

  private forgetPrevious(owner: string): void {
    const previous = this.latest.get(owner);
    const job = previous === undefined ? undefined : this.jobs.get(previous);
    if (job !== undefined && previous !== undefined && job.dto.status !== "running") {
      this.dropFile(job);
      this.jobs.delete(previous);
    }
  }
}
