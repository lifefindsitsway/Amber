import { link, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { statfsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { monotonicFactory } from "ulid";
import { IMPORTED_ORIGINALS_DIR_PREFIX } from "../../shared/backup-names.ts";
import { cacheFileNameOf, cacheRefOf, isValidCacheFileName } from "../../shared/cache-file-name.ts";
import { CONTENT_PACK_PREVIEW_TTL_MS } from "../../shared/defaults.ts";
import {
  contentPackImportDecisionsSchema,
  type ContentPackCompareRequest,
  type ContentPackImportDecisions,
  type ContentPackImportJobDto,
  type ContentPackImportRequest,
  type ContentPackJobAcceptedDto,
  type PackCollectionDecision,
  type PackCollectionResult,
  type PackContentDiff,
  type PackContentResult,
} from "../../shared/dto/content-pack.ts";
import type { FileGrant } from "../../shared/dto/local-media.ts";
import type { AppError } from "../../shared/errors.ts";
import { AmberError, amberError, appError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { CacheGate, Release } from "../pipeline/cache-gate.ts";
import type { CacheHoldRegistry } from "../pipeline/cache-holds.ts";
import type { CachePathLocks } from "../pipeline/cache-path-locks.ts";
import { cacheRowsAt, matchesIdentity, SWAP_RECORD_FILE, syncDirectory, writeSwapRecord } from "../pipeline/cache-swap.ts";
import { cacheVolumeLow, diskLowAfterWriting, diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import type { MediaFiles } from "../pipeline/media-files.ts";
import { toAppError } from "../pipeline/retry.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import { assetRef } from "../pipeline/stages/source-media.ts";
import type { ContentPackSource, PackDocuments } from "../ports/content-pack.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { LocalMediaIngest } from "../ports/local-media-ingest.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { ContentPackEngine, PackImportMediaPlan, PackPreviewState, PlacedPackMedia, PreparedPackContent, PreparedPackImport } from "./content-pack-engine.ts";
import { readableFileSize } from "./local-file-access.ts";
import { type OpenPackFile, PackJobSlots, packWorkPaths, quotaShortfall, writeRecord } from "./content-pack-jobs.ts";
import { journalSchema, settleJournal, type ImportJournal, type JournalFile } from "./content-pack-journal.ts";
import type { StorageQuota } from "./storage-quota.ts";

/** How often an upload checks the data volume's watermark while it streams. */
const UPLOAD_DISK_CHECK_BYTES = 64 * 1024 * 1024;
/** The uploaded pack inside its job directory. */
const UPLOADED_PACK_FILE = "upload.bin";
/** Suffix of a staged original beside its final place. */
const STAGED_SUFFIX = ".amber-partial";
/** The staged cache file inside the new asset's cache scratch directory. */
const STAGED_CACHE_FILE = "pack";
/** Longest name of a placed original, in UTF-8 bytes: room is left for the staging suffix within a 255-byte name. */
const ORIGINAL_NAME_MAX_BYTES = 180;
/** Longest extension a carried display name may keep; anything longer takes the entry's own. */
const ORIGINAL_EXT_MAX_CHARS = 16;
/** The kept images of an import inside its job directory. */
const IMAGES_DIR = "images";

export interface ContentPackImportServiceOptions {
  mode: "server" | "local";
  repository: Repository;
  /** The library side: plans, documents, previews and per-Content commits. */
  engine: ContentPackEngine;
  files: FileStore;
  media: MediaFiles;
  /** Local mode: checks the shell's `pack_input` and `pack_originals_dir` grants. */
  grants?: FileGrantVerifier;
  logger?: Logger;
  openPack: OpenPackFile;
  /** Reads a staged media file's leading bytes to check its container against its document. */
  ingest: Pick<LocalMediaIngest, "sniffContainer">;
  /** A shared lease is held while files are placed and Contents committed. */
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  /** Cache files are placed under their path lock, as every other cache writer does. */
  locks: Pick<CachePathLocks, "withLock">;
  /** Interrupted cache replacements waiting for the user; nothing is placed at a held path. */
  holds?: Pick<CacheHoldRegistry, "isHeld">;
  /** `<data dir>/tmp/content-packs`. */
  workDir: string;
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  /** Server mode: per-user storage limits, applied to the upload and to originals placed in managed storage. */
  quota?: StorageQuota;
  /** Shared with the export service: one content pack job per user. */
  slots?: PackJobSlots;
  now?: () => number;
  newId?: () => string;
  /** Free bytes of the volume holding `path` (local-mode originals directory). */
  freeBytes?: (path: string) => number;
  /**
   * False until the start-up recovery has finished. It settles and clears the jobs' working
   * directory, so no job may start or commit before.
   */
  backgroundReady?: () => boolean;
}

const RUNNING = new Set<ContentPackImportJobDto["status"]>(["receiving", "previewing", "awaiting_decisions", "importing"]);

interface ImportJob {
  owner: string;
  dto: ContentPackImportJobDto;
  controller: AbortController;
  done: Promise<void>;
  packPath?: string;
  /** `imports/<jobId>/`: the upload (server mode) and the images waiting for their commit. */
  jobDir: string;
  /** Set from the moment a commit is accepted until it has started or was refused. */
  committing?: boolean;
  source?: ContentPackSource | undefined;
  documents?: PackDocuments | undefined;
  state?: PackPreviewState | undefined;
  decisions?: ContentPackImportDecisions;
  /** Carried Content key → local Content, for the collections. */
  contentIds?: Map<string, string>;
  expiry?: NodeJS.Timeout | undefined;
}

/** One media entry on its way into place. */
interface Placement {
  plan: PackImportMediaPlan;
  /** Absolute path of the final file. */
  finalPath: string;
  /** Absolute path of the staged file beside it. */
  tempPath: string;
  location: PlacedPackMedia["location"];
  /** A cache file: its ref and the new asset's scratch directory. */
  cache?: { ref: string; scratchId: string };
  /** The single read created the staged file; only then is it this job's to remove. */
  staged: boolean;
  placed: boolean;
  /** Its Content committed: the file is the library's now. */
  committed: boolean;
}

function freeBytesOf(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function notFound(): AmberError {
  return amberError("not_found", "no such content pack import");
}

function jobState(message: string): AmberError {
  return amberError("conflict", message, { code: "conflict.pack_job_state" });
}

/** Why a staged file could not be written, as the failure of its Content. */
function stagingFailure(code: string, contentId: string): AppError {
  if (code === "ENOSPC" || code === "EDQUOT") return appError("disk_low");
  return appError("conflict", { code: "conflict.pack_target_changed", details: { contentId } });
}

/** A carried media file that is not the container its document declares. */
function containerMismatch(entry: string): AppError {
  return appError("backup_invalid", { code: "backup_invalid.pack_entry", details: { entry, reason: "container" } });
}

function startingUp(): AmberError {
  return amberError("conflict", "start-up recovery still running", { code: "conflict.starting_up" });
}

/** Cuts `text` to at most `maxBytes` of UTF-8, at a code point boundary. */
function fitBytes(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function emptyResult(key: string, title: string | undefined, status: PackContentResult["status"], extra: Partial<PackContentResult> = {}): PackContentResult {
  return {
    key,
    ...(title === undefined ? {} : { title }),
    status,
    added: { revisions: 0, speakers: 0, figures: 0, notes: 0, media: 0 },
    updated: { figures: 0, notes: 0 },
    conflicts: { revisions: 0, figures: 0, notes: 0, media: 0 },
    placedByTime: 0,
    ...extra,
  };
}

/** Characters Windows refuses in a file name, and C0 / C1 controls. */
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu;
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

/**
 * A file name for a carried original: its display name made safe, else its entry's own name.
 * The extension is kept only when short; the whole name fits `ORIGINAL_NAME_MAX_BYTES`.
 */
function originalNameOf(plan: PackImportMediaPlan): string {
  const entryExt = plan.entry.slice(plan.entry.lastIndexOf(".") + 1);
  const raw = win32.basename((plan.media.displayName ?? "").replace(/\\/g, "/"));
  const cleaned = raw.replace(UNSAFE_NAME, "").replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");
  const dot = cleaned.lastIndexOf(".");
  const typed = dot > 0 ? cleaned.slice(dot + 1) : "";
  const ext = typed !== "" && typed.length <= ORIGINAL_EXT_MAX_CHARS && /^[\p{L}\p{N}_-]+$/u.test(typed) ? typed : entryExt;
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  let safeStem = fitBytes(stem, ORIGINAL_NAME_MAX_BYTES - Buffer.byteLength(`.${ext}`, "utf8")).trim();
  if (safeStem === "") safeStem = basename(plan.entry, `.${entryExt}`);
  if (RESERVED_NAME.test(safeStem)) safeStem = `${safeStem}_`;
  return `${safeStem}.${ext}`;
}

/** `name`, or `name (2)`, `name (3)` … so that no two placed originals share a name (case folded). */
function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let index = 2; taken.has(candidate.toLowerCase()); index += 1) {
    candidate = `${stem} (${index})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Moves `from` to `to` without ever replacing a file at `to`: a hard link fails if `to`
 * exists; where links are not supported, the check and the rename are as close as possible.
 */
async function moveNoClobber(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
    await rm(from, { force: true });
    return;
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw error;
  }
  if ((await lstat(to).catch(() => undefined)) !== undefined) {
    throw Object.assign(new Error("target exists"), { code: "EEXIST" });
  }
  await rename(from, to);
}

/** Runs `work` holding every lock of `refs`, taken in one order so two jobs never wait on each other. */
function withLocks<T>(locks: Pick<CachePathLocks, "withLock">, refs: readonly string[], work: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(refs.map((ref) => ref.toLowerCase()))].sort();
  const step = (index: number): Promise<T> => {
    const ref = sorted[index];
    return ref === undefined ? work() : locks.withLock(ref, () => step(index + 1));
  };
  return step(0);
}

/**
 * Content pack imports: preview, the user's decisions, then one verified read and per-Content
 * commits, collections last. Jobs live in memory; each keeps a journal in the data directory
 * so a crash between placing files and committing is finished or rolled back at start-up.
 *
 * The import never writes a library table itself: the engine relates the pack to the library
 * and commits each Content in one transaction. This service decides where each carried file
 * goes, stages it during the single sequential read, moves it into place right before its
 * Content commits and takes it away again when that commit fails.
 */
export class ContentPackImportService {
  private readonly options: ContentPackImportServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly freeBytes: (path: string) => number;
  private readonly slots: PackJobSlots;
  private readonly jobs = new Map<string, ImportJob>();
  /** The user's latest import; an earlier finished one is forgotten when a new one starts. */
  private readonly latest = new Map<string, string>();

  constructor(options: ContentPackImportServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.freeBytes = options.freeBytes ?? freeBytesOf;
    this.slots = options.slots ?? new PackJobSlots();
  }

  /** Local mode: previews the pack file the user picked. */
  async startFromFile(principal: RequestPrincipal, request: ContentPackImportRequest): Promise<ContentPackJobAcceptedDto> {
    this.checkReady();
    const grant = request.grant;
    const grants = this.options.grants;
    if (grant === undefined || grants === undefined || !grants.verify(grant, { path: grant.path, purpose: "pack_input" })) {
      throw amberError("unauthenticated", "content pack grant rejected", { code: "unauthenticated.file_grant" });
    }
    await readableFileSize(grant.path, "grant.path");
    const job = this.createJob(principal.userId, "previewing", "preview");
    job.packPath = grant.path;
    job.done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.preview(job));
    return { jobId: job.dto.jobId };
  }

  /**
   * Server mode: streams the uploaded body into the job's staging area, then previews it.
   * The body is never held in memory; it counts against the user's storage limit while it
   * streams and stops at the disk watermark. An interrupted upload leaves nothing behind.
   */
  async startFromUpload(principal: RequestPrincipal, fileName: string | undefined, body: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<ContentPackJobAcceptedDto> {
    this.checkReady();
    const owner = principal.userId;
    const low = await diskLowError(this.options.disk, this.options.settings.effective());
    if (low !== undefined) throw new AmberError(low, "disk below the low-water mark");
    const job = this.createJob(owner, "receiving", "upload");
    if (fileName !== undefined) job.dto.fileName = fileName;
    const dir = job.jobDir;
    job.packPath = join(dir, UPLOADED_PACK_FILE);
    const aborted = (): void => job.controller.abort();
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    const receiving = (async () => {
      let reservation: Awaited<ReturnType<StorageQuota["begin"]>>;
      try {
        reservation = await this.options.quota?.begin(owner);
        await mkdir(dir, { recursive: true });
        await this.receive(job, reservation === undefined ? body : reservation.meter(body));
      } catch (error) {
        await this.endWithFailure(job, error);
        throw error;
      } finally {
        reservation?.release();
        signal.removeEventListener("abort", aborted);
      }
    })();
    // A cancel during the upload waits for the receiving end to clean up.
    job.done = receiving.then(
      () => undefined,
      () => undefined,
    );
    await receiving;
    job.dto.status = "previewing";
    job.dto.phase = "preview";
    job.done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.preview(job));
    return { jobId: job.dto.jobId };
  }

  get(principal: RequestPrincipal, jobId: string): ContentPackImportJobDto {
    const job = this.owned(principal, jobId);
    this.expireIfDue(job);
    return structuredClone(job.dto);
  }

  compare(principal: RequestPrincipal, jobId: string, request: ContentPackCompareRequest): PackContentDiff {
    const job = this.owned(principal, jobId);
    this.expireIfDue(job);
    if (job.dto.status !== "awaiting_decisions" || job.documents === undefined || job.state === undefined) {
      throw jobState("the import is not waiting for decisions");
    }
    return this.options.engine.compare(job.owner, job.documents, job.state, request.key, request.targetContentId);
  }

  /**
   * Accepts the user's decisions and starts the import. Checked first, nothing changed
   * when any fails: the job waits for decisions, the originals directory grant (local mode),
   * the engine's preparation, the cache gate's shared lease, and the space the files need
   * (disk watermark, storage limit, cache volume, originals volume).
   */
  async commit(principal: RequestPrincipal, jobId: string, input: ContentPackImportDecisions): Promise<ContentPackImportJobDto> {
    const job = this.owned(principal, jobId);
    this.checkReady();
    this.expireIfDue(job);
    // Claimed in the same synchronous turn as the check: a second commit (a double click) is
    // refused here, before any of the waits below could let it through.
    if (job.dto.status !== "awaiting_decisions" || job.committing === true || job.documents === undefined || job.state === undefined) {
      throw jobState("the import is not waiting for decisions");
    }
    job.committing = true;
    let release: Release | undefined;
    try {
      const decisions = contentPackImportDecisionsSchema.parse(input);
      const originalsDir = decisions.originalsDir === undefined ? undefined : await this.checkOriginalsDir(decisions.originalsDir);
      const prepared = this.options.engine.prepareImport(job.owner, job.documents, job.state, decisions);
      if (this.options.mode === "local" && originalsDir === undefined && prepared.media.some((plan) => plan.targetKind === "external_local" && !plan.fills)) {
        throw amberError("invalid_request", "carried originals need a directory", { params: { detail: "originalsDir" } });
      }
      release = this.options.gate.tryShared();
      if (release === undefined) {
        throw gateConflict(this.options.gate);
      }
      await this.checkSpace(principal, prepared, originalsDir);
      // A cancel or discard may have ended the job while the checks waited.
      if (job.dto.status !== "awaiting_decisions") {
        throw jobState("the import ended while its decisions were checked");
      }
      if (job.expiry !== undefined) clearTimeout(job.expiry);
      job.decisions = decisions;
      job.dto.status = "importing";
      job.dto.phase = "read";
      job.dto.bytesDone = 0;
      delete job.dto.expiresAt;
      const lease = release;
      job.done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.runImport(job, prepared, originalsDir, lease));
      return structuredClone(job.dto);
    } catch (error) {
      release?.();
      throw error;
    } finally {
      job.committing = false;
    }
  }

  async cancel(principal: RequestPrincipal, jobId: string): Promise<ContentPackImportJobDto> {
    const job = this.owned(principal, jobId);
    this.expireIfDue(job);
    if (job.dto.status === "awaiting_decisions") {
      await this.endJob(job, "cancelled");
    } else if (RUNNING.has(job.dto.status)) {
      job.controller.abort();
      await job.done;
    }
    return structuredClone(job.dto);
  }

  /** Writes the collections that failed again; the Contents are not touched. */
  retryCollections(principal: RequestPrincipal, jobId: string): ContentPackImportJobDto {
    const job = this.owned(principal, jobId);
    const result = job.dto.result;
    const failed = new Set(result?.collections.filter((item) => item.status === "failed").map((item) => item.key) ?? []);
    if (job.dto.status !== "finished" || result === undefined || job.documents === undefined || job.decisions === undefined || failed.size === 0) {
      throw jobState("no collection of this import can be retried");
    }
    this.slots.claim(job.owner, jobId);
    try {
      const decisions = (job.decisions.collections ?? []).filter((decision) => failed.has(decision.key));
      const retried = this.commitCollections(job, decisions);
      const byKey = new Map(retried.map((item) => [item.key, item]));
      result.collections = result.collections.map((item) => byKey.get(item.key) ?? item);
      if (!result.collections.some((item) => item.status === "failed")) job.documents = undefined;
    } finally {
      this.slots.release(job.owner, jobId);
    }
    return structuredClone(job.dto);
  }

  /** Drops the job and its staging. */
  async discard(principal: RequestPrincipal, jobId: string): Promise<void> {
    const job = this.owned(principal, jobId);
    if (job.dto.status === "awaiting_decisions") {
      await this.endJob(job, "cancelled");
    } else if (RUNNING.has(job.dto.status)) {
      job.controller.abort();
      await job.done;
    }
    await this.removeJobDir(job);
    this.jobs.delete(jobId);
    if (this.latest.get(job.owner) === jobId) this.latest.delete(job.owner);
  }

  /** The caller's running import, if any (from the upload until it finishes, fails or is cancelled). */
  active(principal: RequestPrincipal): string | undefined {
    const jobId = this.latest.get(principal.userId);
    const job = jobId === undefined ? undefined : this.jobs.get(jobId);
    if (job === undefined) return undefined;
    this.expireIfDue(job);
    return RUNNING.has(job.dto.status) ? jobId : undefined;
  }

  /** Stops running imports before the database closes under them. */
  async close(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.expiry !== undefined) clearTimeout(job.expiry);
      if (RUNNING.has(job.dto.status) && job.dto.status !== "awaiting_decisions") {
        job.controller.abort();
        await job.done;
      }
    }
  }

  /**
   * Finishes or rolls back imports a crash interrupted; run once at start-up, after the cache
   * replacements were recovered. Idempotent. Each journal is settled (see `settleJournal`) and
   * removed; a journal that cannot be settled stays for the next start. Uploads and previews
   * never outlive the process: their directory goes.
   */
  async recover(): Promise<void> {
    const paths = packWorkPaths(this.options.workDir);
    let names: string[] = [];
    try {
      names = (await readdir(paths.journal)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    for (const name of names) {
      const path = join(paths.journal, name);
      let journal: ImportJournal;
      try {
        const handle = await open(path, "r");
        try {
          journal = journalSchema.parse(JSON.parse(await handle.readFile("utf8")));
        } finally {
          await handle.close();
        }
      } catch {
        this.options.logger?.error("content_pack_journal_unreadable", { name });
        continue;
      }
      try {
        const outcome = await settleJournal(journal, {
          assetOf: (owner, assetId) => this.options.repository.withTransaction((scope) => scope.mediaAssets.get(owner, assetId)),
          logger: this.options.logger,
        });
        await rm(path, { force: true });
        this.options.logger?.info("content_pack_journal_settled", { jobId: journal.jobId, ...outcome });
      } catch (error) {
        this.options.logger?.error("content_pack_journal_settle_failed", { jobId: journal.jobId, error: errorCode(error) ?? "error" });
      }
    }
    await rm(paths.imports, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------------------------

  private checkReady(): void {
    if (this.options.backgroundReady?.() === false) {
      throw startingUp();
    }
  }

  private createJob(owner: string, status: ContentPackImportJobDto["status"], phase: ContentPackImportJobDto["phase"]): ImportJob {
    const jobId = this.newId();
    this.slots.claim(owner, jobId);
    const previous = this.latest.get(owner);
    if (previous !== undefined) {
      const old = this.jobs.get(previous);
      if (old !== undefined && !RUNNING.has(old.dto.status)) {
        void this.removeJobDir(old);
        this.jobs.delete(previous);
      }
    }
    const job: ImportJob = {
      owner,
      dto: { jobId, status, phase, bytesDone: 0, bytesTotal: 0 },
      controller: new AbortController(),
      done: Promise.resolve(),
      jobDir: join(packWorkPaths(this.options.workDir).imports, jobId),
    };
    this.jobs.set(jobId, job);
    this.latest.set(owner, jobId);
    return job;
  }

  private owned(principal: RequestPrincipal, jobId: string): ImportJob {
    const job = this.jobs.get(jobId);
    // Another user's job is answered exactly like an unknown one.
    if (job === undefined || job.owner !== principal.userId) {
      throw notFound();
    }
    return job;
  }

  private async receive(job: ImportJob, body: AsyncIterable<Uint8Array>): Promise<void> {
    const signal = job.controller.signal;
    const handle = await open(job.packPath as string, "wx", 0o600);
    let sinceCheck = 0;
    try {
      for await (const chunk of body) {
        signal.throwIfAborted();
        let done = 0;
        while (done < chunk.length) {
          done += (await handle.write(chunk, done, chunk.length - done)).bytesWritten;
        }
        job.dto.bytesDone += chunk.length;
        sinceCheck += chunk.length;
        if (sinceCheck >= UPLOAD_DISK_CHECK_BYTES) {
          sinceCheck = 0;
          const low = await diskLowError(this.options.disk, this.options.settings.effective());
          if (low !== undefined) throw new AmberError(low, "disk below the low-water mark during an upload");
        }
      }
      signal.throwIfAborted();
      await handle.sync();
    } finally {
      await handle.close();
    }
    job.dto.bytesTotal = job.dto.bytesDone;
  }

  private async preview(job: ImportJob): Promise<void> {
    const signal = job.controller.signal;
    try {
      const source = this.options.openPack(job.packPath as string);
      job.source = source;
      job.dto.bytesTotal = await source.sizeBytes();
      const documents = await source.readDocuments(signal);
      signal.throwIfAborted();
      const analysis = this.options.engine.analyzeImport(job.owner, documents);
      const collections = this.options.engine.collections.preview(job.owner, documents);
      job.documents = documents;
      job.state = analysis.state;
      job.dto.preview = {
        pack: {
          formatVersion: documents.header.formatVersion,
          createdAt: documents.header.createdAt,
          amberVersion: documents.header.amberVersion,
          sizeBytes: job.dto.bytesTotal,
          mediaBytes: documents.contents.reduce((sum, content) => sum + content.document.media.reduce((bytes, media) => bytes + media.sizeBytes, 0), 0),
        },
        contents: analysis.contents,
        collections,
      };
      job.dto.status = "awaiting_decisions";
      job.dto.bytesDone = job.dto.bytesTotal;
      const expiresAt = this.now() + CONTENT_PACK_PREVIEW_TTL_MS;
      job.dto.expiresAt = expiresAt;
      job.expiry = setTimeout(() => this.expireIfDue(job), CONTENT_PACK_PREVIEW_TTL_MS + 1);
      job.expiry.unref();
    } catch (error) {
      await this.endWithFailure(job, error);
    }
  }

  /** A preview nobody decided on in time is cancelled and its upload removed. */
  private expireIfDue(job: ImportJob): void {
    // A commit accepted before the deadline is not undone by it.
    if (job.dto.status === "awaiting_decisions" && job.committing !== true && job.dto.expiresAt !== undefined && this.now() >= job.dto.expiresAt) {
      void this.endJob(job, "cancelled");
    }
  }

  /** Ends a job that is not running work: status, slot, staging, memory. */
  private async endJob(job: ImportJob, status: "failed" | "cancelled", error?: AppError): Promise<void> {
    job.dto.status = status;
    if (error !== undefined) job.dto.error = error;
    if (job.expiry !== undefined) clearTimeout(job.expiry);
    job.expiry = undefined;
    job.documents = undefined;
    job.state = undefined;
    job.source = undefined;
    this.slots.release(job.owner, job.dto.jobId);
    await this.removeJobDir(job);
  }

  private async endWithFailure(job: ImportJob, error: unknown): Promise<void> {
    if (job.controller.signal.aborted) {
      await this.endJob(job, "cancelled");
      return;
    }
    const appErr = toAppError(error);
    if (appErr.code === "internal") {
      this.options.logger?.error("content_pack_import_failed", { jobId: job.dto.jobId, error: errorCode(error) ?? (error instanceof Error ? error.name : "error") });
    }
    await this.endJob(job, "failed", appErr);
  }

  private async removeJobDir(job: ImportJob): Promise<void> {
    await rm(job.jobDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * The directory the shell named under the folder the user picked: signed for exactly this
   * path, named `Amber-Imported-…`, inside an existing folder, and new or still empty.
   */
  private async checkOriginalsDir(grant: FileGrant): Promise<string> {
    const grants = this.options.grants;
    if (this.options.mode !== "local" || grants === undefined || !grants.verify(grant, { path: grant.path, purpose: "pack_originals_dir" })) {
      throw amberError("unauthenticated", "originals directory grant rejected", { code: "unauthenticated.file_grant" });
    }
    const path = grant.path;
    const invalid = (reason: string): never => {
      throw amberError("invalid_request", reason, { params: { detail: "originalsDir" } });
    };
    if (!isAbsolute(path) && !win32.isAbsolute(path)) invalid("originals directory is not absolute");
    if (!win32.basename(path.replace(/\\/g, "/")).startsWith(IMPORTED_ORIGINALS_DIR_PREFIX)) invalid("originals directory is not named for an import");
    if ((await stat(dirname(path)).catch(() => undefined))?.isDirectory() !== true) invalid("the folder for the originals does not exist");
    const existing = await lstat(path).catch(() => undefined);
    if (existing !== undefined && (!existing.isDirectory() || (await readdir(path)).length > 0)) {
      invalid("originals directory exists and is not empty");
    }
    return path;
  }

  private async checkSpace(principal: RequestPrincipal, prepared: PreparedPackImport, originalsDir: string | undefined): Promise<void> {
    const bytesOf = (kind: PackImportMediaPlan["targetKind"]): number =>
      prepared.media.filter((plan) => plan.targetKind === kind).reduce((sum, plan) => sum + plan.media.sizeBytes, 0);
    const settings = this.options.settings.effective();
    const managed = bytesOf("managed_upload");
    if (managed > 0) {
      const low = await diskLowAfterWriting(this.options.disk, settings, managed);
      if (low !== undefined) throw new AmberError(low, "not enough space for the carried originals");
      const quota = this.options.quota;
      if (quota !== undefined) {
        const shortfall = quotaShortfall(await quota.usage(principal), managed);
        if (shortfall !== undefined) throw shortfall;
      }
    }
    const cache = bytesOf("platform_cache");
    if (cache > 0) {
      if (!(await this.options.media.cache.isAvailable())) {
        throw amberError("conflict", "the video cache root is not available", { code: "conflict.cache_unavailable" });
      }
      const usage = await this.options.media.cache.diskUsage();
      if (cacheVolumeLow({ ...usage, freeBytes: usage.freeBytes - cache }, settings)) {
        throw amberError("disk_low", "not enough space in the cache directory");
      }
    }
    // Originals go to the new directory or, filled in, back beside their registered path:
    // each volume they land on must hold its share. A missing folder is the plan's to report.
    const byVolume = new Map<number | string, { dir: string; bytes: number }>();
    for (const plan of prepared.media) {
      if (plan.targetKind !== "external_local") continue;
      const existing = plan.fills ? plan.existingLocation : undefined;
      const dir = existing !== undefined && "path" in existing ? dirname(existing.path) : originalsDir === undefined ? undefined : dirname(originalsDir);
      if (dir === undefined) continue;
      const device = statSync(dir, { throwIfNoEntry: false })?.dev;
      if (device === undefined) continue;
      const volume = byVolume.get(device) ?? { dir, bytes: 0 };
      volume.bytes += plan.media.sizeBytes;
      byVolume.set(device, volume);
    }
    for (const volume of byVolume.values()) {
      if (this.freeBytes(volume.dir) < volume.bytes) {
        throw amberError("disk_low", "not enough space for the carried originals");
      }
    }
  }

  /** Where each chosen media entry goes; a Content whose file has no valid place fails before anything is read. */
  private async plan(job: ImportJob, prepared: PreparedPackImport, originalsDir: string | undefined): Promise<{ placements: Placement[]; failed: Map<string, AppError> }> {
    const placements: Placement[] = [];
    const failed = new Map<string, AppError>();
    const taken = new Set<string>();
    for (const plan of prepared.media) {
      if (failed.has(plan.contentKey)) continue;
      try {
        placements.push(await this.placementOf(job, plan, originalsDir, taken));
      } catch (error) {
        failed.set(plan.contentKey, toAppError(error));
      }
    }
    // A Content refused here takes nothing along: the cache scratch its earlier files opened goes.
    for (const placement of placements) {
      if (failed.has(placement.plan.contentKey)) await this.discardStaged(placement);
    }
    return { placements: placements.filter((placement) => !failed.has(placement.plan.contentKey)), failed };
  }

  private async placementOf(job: ImportJob, plan: PackImportMediaPlan, originalsDir: string | undefined, taken: Set<string>): Promise<Placement> {
    const existing = plan.fills ? plan.existingLocation : undefined;
    if (plan.fills && existing === undefined) {
      throw amberError("conflict", "the asset to fill in has no location", { code: "conflict.pack_target_changed", details: { contentId: plan.contentId } });
    }
    const base = { plan, staged: false, placed: false, committed: false };
    const jobId = job.dto.jobId;
    if (plan.targetKind === "platform_cache") {
      const ref = existing !== undefined && "storageRef" in existing ? existing.storageRef : plan.media.cacheFileName === undefined ? undefined : cacheRefOf(plan.media.cacheFileName);
      if (ref === undefined || !isValidCacheFileName(cacheFileNameOf(ref))) {
        throw amberError("conflict", "the cache file has no valid name", { code: "conflict.cache_file_foreign" });
      }
      const scratch = await this.options.media.cache.openScratch(plan.assetId);
      return {
        ...base,
        finalPath: this.options.media.cache.pathOf(ref),
        tempPath: join(scratch.path, `${STAGED_CACHE_FILE}-${jobId}`),
        location: { storageRef: ref },
        cache: { ref, scratchId: plan.assetId },
      };
    }
    if (plan.targetKind === "managed_upload") {
      const ref = existing !== undefined && "storageRef" in existing ? existing.storageRef : assetRef({ userId: job.owner, contentId: plan.contentId, id: plan.assetId });
      const finalPath = this.options.media.data.pathOf(ref);
      await mkdir(dirname(finalPath), { recursive: true });
      return { ...base, finalPath, tempPath: `${finalPath}.${jobId}.partial`, location: { storageRef: ref } };
    }
    if (existing !== undefined && "path" in existing) {
      // The registered file's folder may be on a drive that is not connected right now.
      const folder = dirname(existing.path);
      if ((await stat(folder).catch(() => undefined))?.isDirectory() !== true) {
        throw amberError("conflict", "the folder of the file to fill in is not there", { code: "conflict.pack_target_changed", details: { contentId: plan.contentId } });
      }
      // A short name of the job's own beside it, whatever the length of the registered name.
      return { ...base, finalPath: existing.path, tempPath: join(folder, `.${jobId}-${plan.assetId}${STAGED_SUFFIX}`), location: { path: existing.path } };
    }
    if (originalsDir === undefined) {
      throw amberError("invalid_request", "carried originals need a directory", { params: { detail: "originalsDir" } });
    }
    const finalPath = join(originalsDir, uniqueName(originalNameOf(plan), taken));
    return { ...base, finalPath, tempPath: `${finalPath}.${jobId}${STAGED_SUFFIX}`, location: { path: finalPath } };
  }

  private journalOf(job: ImportJob, placements: readonly Placement[], originalsDir: { path: string; created: boolean } | undefined, phases: Record<string, ImportJournal["contents"][string]>): ImportJournal {
    return {
      v: 1,
      jobId: job.dto.jobId,
      owner: job.owner,
      createdAt: this.now(),
      ...(originalsDir === undefined ? {} : { originalsDir }),
      files: placements.map(
        (placement): JournalFile => ({
          entry: placement.plan.entry,
          contentKey: placement.plan.contentKey,
          assetId: placement.plan.assetId,
          targetKind: placement.plan.targetKind,
          fills: placement.plan.fills,
          finalPath: placement.finalPath,
          tempPath: placement.tempPath,
          sizeBytes: placement.plan.media.sizeBytes,
          sha256: placement.plan.media.sha256,
          ...(placement.cache === undefined ? {} : { cacheRef: placement.cache.ref }),
        }),
      ),
      contents: phases,
    };
  }

  private async runImport(job: ImportJob, prepared: PreparedPackImport, originalsDirPath: string | undefined, release: Release): Promise<void> {
    const signal = job.controller.signal;
    const documents = job.documents as PackDocuments;
    const source = job.source as ContentPackSource;
    const journalDir = packWorkPaths(this.options.workDir).journal;
    const journalName = `${job.dto.jobId}.json`;
    const phases: Record<string, ImportJournal["contents"][string]> = {};
    const results: PackContentResult[] = [...prepared.refused];
    let placements: Placement[] = [];
    let originalsDir: { path: string; created: boolean } | undefined;
    let journalWritten = false;
    let outcome: ContentPackImportJobDto["status"] = "failed";
    const saveJournal = async (): Promise<void> => {
      await writeRecord(journalDir, journalName, this.journalOf(job, placements, originalsDir, phases));
      journalWritten = true;
    };
    try {
      if (originalsDirPath !== undefined && prepared.media.some((plan) => plan.targetKind === "external_local" && !plan.fills)) {
        const existed = (await lstat(originalsDirPath).catch(() => undefined)) !== undefined;
        await mkdir(originalsDirPath, { recursive: false }).catch((error: unknown) => {
          if (errorCode(error) !== "EEXIST") throw error;
        });
        originalsDir = { path: originalsDirPath, created: !existed };
      }
      const planned = await this.plan(job, prepared, originalsDir?.path);
      placements = planned.placements;
      for (const content of prepared.contents) phases[content.key] = "pending";
      await mkdir(journalDir, { recursive: true });
      // Before any file exists, so a crash from here on finds every file it may have to remove.
      await saveJournal();

      const stage = new Map(placements.map((placement) => [placement.plan.entry, { path: placement.tempPath }]));
      // The images wait on disk until their Content commits; only that Content's are read back then.
      const imageDir = join(job.jobDir, IMAGES_DIR);
      await mkdir(imageDir, { recursive: true });
      const read = await source.readAll(
        documents.digests,
        stage,
        (bytesDone) => {
          job.dto.bytesDone = bytesDone;
        },
        signal,
        { keepImages: prepared.imageEntries, imageDir },
      );
      for (const placement of placements) placement.staged = read.staged.has(placement.plan.entry);
      job.dto.phase = "verify";
      // A file whose target could not be written fails its own Content; the others go on.
      for (const [entry, code] of read.failed) {
        const placement = placements.find((item) => item.plan.entry === entry);
        if (placement !== undefined && !planned.failed.has(placement.plan.contentKey)) {
          planned.failed.set(placement.plan.contentKey, stagingFailure(code, placement.plan.contentId));
          this.options.logger?.warn("content_pack_stage_failed", { jobId: job.dto.jobId, assetId: placement.plan.assetId, error: code });
        }
      }
      for (const placement of placements.filter((item) => planned.failed.has(item.plan.contentKey))) {
        await this.discardStaged(placement);
      }
      placements = placements.filter((placement) => !planned.failed.has(placement.plan.contentKey));
      for (const placement of placements) {
        const staged = read.staged.get(placement.plan.entry);
        if (staged === undefined || staged.sizeBytes !== placement.plan.media.sizeBytes || staged.sha256 !== placement.plan.media.sha256) {
          // The manifest agreed with the bytes but the Content document records another file:
          // the pack contradicts itself.
          throw amberError("backup_invalid", "a staged file does not match its document", {
            code: "backup_invalid.pack_entry",
            details: { entry: placement.plan.entry, reason: "digest" },
          });
        }
      }
      // The digest proves the bytes are the ones the pack declared, not that they are the
      // container the document names: a playlist or any other bytes labelled as a video
      // would reach every tool that opens the file. Such a file fails its own Content.
      for (const placement of placements) {
        if (!(await this.containerMatches(placement))) {
          planned.failed.set(placement.plan.contentKey, containerMismatch(placement.plan.entry));
          this.options.logger?.warn("content_pack_container_mismatch", { jobId: job.dto.jobId, assetId: placement.plan.assetId });
        }
      }
      for (const placement of placements.filter((item) => planned.failed.has(item.plan.contentKey))) {
        await this.discardStaged(placement);
      }
      placements = placements.filter((placement) => !planned.failed.has(placement.plan.contentKey));

      job.dto.phase = "contents";
      const contentIds = new Map<string, string>();
      for (const content of prepared.contents) {
        if (signal.aborted) break;
        const failure = planned.failed.get(content.key);
        let result: PackContentResult;
        if (content.action === "skip") {
          result = emptyResult(content.key, content.title, "skipped");
        } else if (failure !== undefined) {
          result = emptyResult(content.key, content.title, "failed", { error: failure });
        } else {
          result = await this.commitOne(job, documents, content, placements, read.imageFiles, phases, saveJournal);
        }
        results.push(result);
        const decided = job.decisions?.contents.find((decision) => decision.key === content.key);
        const localId = result.contentId ?? (result.status === "skipped" ? decided?.targetContentId : undefined);
        if (localId !== undefined && result.status !== "failed") contentIds.set(content.key, localId);
        // Every Content is its own transaction; other requests run between them.
        await new Promise((resolve) => setImmediate(resolve));
      }
      job.contentIds = contentIds;
      let collections: PackCollectionResult[] = [];
      if (!signal.aborted) {
        job.dto.phase = "collections";
        collections = this.commitCollections(job, job.decisions?.collections ?? []);
      }
      job.dto.result = { contents: results, collections };
      outcome = signal.aborted ? "cancelled" : "finished";
      job.dto.bytesDone = job.dto.bytesTotal;
    } catch (error) {
      if (signal.aborted) {
        outcome = "cancelled";
      } else {
        outcome = "failed";
        job.dto.error = toAppError(error);
        if (job.dto.error.code === "internal") {
          this.options.logger?.error("content_pack_import_failed", { jobId: job.dto.jobId, error: errorCode(error) ?? (error instanceof Error ? error.name : "error") });
        }
      }
      if (results.length > prepared.refused.length) {
        job.dto.result = { contents: results, collections: [] };
      }
    } finally {
      // Whatever was staged and never placed goes; placed files belong to committed Contents.
      for (const placement of placements) {
        if (!placement.placed) await this.discardStaged(placement);
      }
      if (originalsDir?.created === true) {
        await rmdir(originalsDir.path).catch(() => undefined);
      }
      // A file in place whose Content never committed (its rollback failed) keeps the journal
      // for the start-up recovery; otherwise nothing is left for it to settle.
      const unsettled = placements.some((placement) => placement.placed && !placement.committed);
      if (unsettled) {
        this.options.logger?.error("content_pack_import_unsettled", { jobId: job.dto.jobId });
      } else if (journalWritten) {
        await rm(join(journalDir, journalName), { force: true }).catch(() => undefined);
      }
      job.source = undefined;
      job.state = undefined;
      await this.removeJobDir(job);
      // The documents stay only for a retry of failed collections.
      if (outcome !== "finished" || !job.dto.result?.collections.some((item) => item.status === "failed")) job.documents = undefined;
      release();
      this.slots.release(job.owner, job.dto.jobId);
      // Published last: a client that sees the job end may start the next one at once.
      job.dto.status = outcome;
    }
  }

  /**
   * Places one Content's files, commits it, and takes the files away again if the commit
   * fails. Its images are read back from the job directory for this commit only.
   */
  private async commitOne(
    job: ImportJob,
    documents: PackDocuments,
    content: PreparedPackContent,
    allPlacements: readonly Placement[],
    imageFiles: ReadonlyMap<string, string>,
    phases: Record<string, ImportJournal["contents"][string]>,
    saveJournal: () => Promise<void>,
  ): Promise<PackContentResult> {
    const placements = allPlacements.filter((placement) => placement.plan.contentKey === content.key);
    const cacheRefs = placements.flatMap((placement) => (placement.cache === undefined ? [] : [placement.cache.ref]));
    return withLocks(this.options.locks, cacheRefs, async () => {
      const failed = async (error: unknown): Promise<PackContentResult> => {
        await this.rollBack(placements);
        phases[content.key] = "failed";
        return emptyResult(content.key, content.title, "failed", { error: toAppError(error) });
      };
      let images: Map<string, Uint8Array>;
      try {
        images = await this.imagesOf(documents, content.key, imageFiles);
      } catch (error) {
        return failed(error);
      }
      const placed = new Map<string, PlacedPackMedia>();
      try {
        for (const placement of placements) {
          await this.place(placement);
          placed.set(placement.plan.entry, { location: placement.location, sizeBytes: placement.plan.media.sizeBytes, sha256: placement.plan.media.sha256 });
        }
        phases[content.key] = "placed";
        // Without a journal naming them as placed, nothing could settle these files after a crash.
        await saveJournal();
      } catch (error) {
        return failed(error);
      }
      let result: PackContentResult;
      try {
        result = this.options.engine.commitContent(job.owner, documents, content, { images, media: placed, now: this.now() });
      } catch (error) {
        result = emptyResult(content.key, content.title, "failed", { error: toAppError(error) });
      }
      if (result.status === "failed") {
        await this.rollBack(placements);
        phases[content.key] = "failed";
      } else {
        for (const placement of placements) {
          placement.committed = true;
          await this.settleCacheRecord(placement);
        }
        phases[content.key] = "committed";
      }
      await saveJournal().catch(() => undefined);
      return result;
    });
  }

  /** Whether a staged file's leading bytes are a container its declared MIME type belongs to. */
  private async containerMatches(placement: Placement): Promise<boolean> {
    const declared = placement.plan.media.mimeType.toLowerCase();
    try {
      const sniffed = await this.options.ingest.sniffContainer(placement.tempPath);
      return sniffed !== undefined && sniffed.mimeTypes.some((mimeType) => mimeType.toLowerCase() === declared);
    } catch {
      return false;
    }
  }

  /** The image bytes one carried Content needs, read from the files `readAll` wrote. */
  private async imagesOf(documents: PackDocuments, key: string, imageFiles: ReadonlyMap<string, string>): Promise<Map<string, Uint8Array>> {
    const document = documents.contents.find((item) => item.document.key === key)?.document;
    const entries = document === undefined ? [] : [...document.speakers.flatMap((speaker) => (speaker.avatar === undefined ? [] : [speaker.avatar.entry])), ...document.figures.map((figure) => figure.entry)];
    const images = new Map<string, Uint8Array>();
    for (const entry of entries) {
      const path = imageFiles.get(entry);
      if (path !== undefined) images.set(entry, new Uint8Array(await readFile(path)));
    }
    return images;
  }

  /**
   * Moves one staged file into place. Nothing is ever overwritten: an original's name must be
   * free; a cache path must hold no file and no row (a fill may find its own row), must not
   * be held for the user, and is published through the replacement record so a crash before
   * the commit is undone by the cache recovery.
   */
  private async place(placement: Placement): Promise<void> {
    const conflict = (): AmberError => amberError("conflict", "the place of a carried file is taken", { code: "conflict.pack_target_changed", details: { contentId: placement.plan.contentId } });
    if (placement.cache !== undefined) {
      const { ref, scratchId } = placement.cache;
      const cache = this.options.media.cache;
      if (this.options.holds?.isHeld(ref) === true) {
        throw amberError("conflict", "an interrupted replacement of this cache path waits for the user", { code: "conflict.cache_recovery_pending" });
      }
      const rows = this.options.repository.withTransaction((scope) => cacheRowsAt(scope, ref));
      if (rows.some((row) => row.availability === "available" && row.id !== placement.plan.assetId)) {
        throw amberError("conflict", "another content's cache holds this file name", { code: "conflict.cache_name_taken", details: { fileName: cacheFileNameOf(ref) } });
      }
      if ((await cache.stat(ref)) !== null) {
        throw amberError("conflict", "a file already stands at the cache path", { code: "conflict.cache_file_foreign" });
      }
      await writeSwapRecord(cache.scratchPath(scratchId), {
        v: 1,
        targetRef: ref,
        newAssetId: placement.plan.assetId,
        newSizeBytes: placement.plan.media.sizeBytes,
        newDigest: `sha256:${placement.plan.media.sha256}`,
      });
      try {
        await cache.moveIn(placement.tempPath, ref);
      } catch (error) {
        await rm(join(cache.scratchPath(scratchId), SWAP_RECORD_FILE), { force: true });
        throw error;
      }
      placement.placed = true;
      return;
    }
    try {
      await moveNoClobber(placement.tempPath, placement.finalPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw conflict();
      throw error;
    }
    placement.placed = true;
    await syncDirectory(dirname(placement.finalPath)).catch(() => undefined);
  }

  /** Takes placed files away again (only while they are the carried bytes) and removes what was staged. */
  private async rollBack(placements: readonly Placement[]): Promise<void> {
    for (const placement of placements) {
      if (placement.placed) {
        const identity = { sizeBytes: placement.plan.media.sizeBytes, digest: `sha256:${placement.plan.media.sha256}` };
        try {
          if ((await matchesIdentity(placement.finalPath, identity)) === true) {
            await rm(placement.finalPath, { force: true });
          }
          placement.placed = false;
        } catch (error) {
          this.options.logger?.warn("content_pack_rollback_failed", { assetId: placement.plan.assetId, error: errorCode(error) ?? "error" });
        }
      }
      await this.discardStaged(placement);
    }
  }

  /** A committed cache's replacement record and scratch directory go, as after any publication. */
  private async settleCacheRecord(placement: Placement): Promise<void> {
    if (placement.cache === undefined) return;
    const cache = this.options.media.cache;
    try {
      await rm(join(cache.scratchPath(placement.cache.scratchId), SWAP_RECORD_FILE), { force: true });
      await syncDirectory(cache.scratchPath(placement.cache.scratchId)).catch(() => undefined);
      await cache.removeScratchDir(placement.cache.scratchId, { force: true });
    } catch (error) {
      this.options.logger?.warn("cache_scratch_remove_failed", { error: errorCode(error) ?? "error" });
    }
  }

  private async discardStaged(placement: Placement): Promise<void> {
    if (placement.staged) {
      await rm(placement.tempPath, { force: true }).catch(() => undefined);
      placement.staged = false;
    }
    // A new Content's managed directory was made for this file; left empty, it goes too.
    if (placement.plan.targetKind === "managed_upload" && !placement.plan.fills && !placement.placed && "storageRef" in placement.location) {
      const ref = placement.location.storageRef;
      await this.options.media.data.removeEmptyDirs(ref.slice(0, ref.lastIndexOf("/"))).catch(() => undefined);
    }
    if (placement.cache !== undefined) {
      const cache = this.options.media.cache;
      await rm(join(cache.scratchPath(placement.cache.scratchId), SWAP_RECORD_FILE), { force: true }).catch(() => undefined);
      await cache.removeScratchDir(placement.cache.scratchId, { force: true }).catch(() => undefined);
    }
  }

  /** The collections, each in its own transaction; a failure of the engine marks every one of them failed. */
  private commitCollections(job: ImportJob, decisions: readonly PackCollectionDecision[]): PackCollectionResult[] {
    if (decisions.length === 0 || job.documents === undefined) return [];
    try {
      return this.options.engine.collections.commit(job.owner, job.documents, decisions, job.contentIds ?? new Map(), this.now());
    } catch (error) {
      const failure = toAppError(error);
      const names = new Map(job.documents.collections.collections.map((collection) => [collection.key, collection.name]));
      return decisions.map((decision) => ({ key: decision.key, name: names.get(decision.key) ?? "", status: "failed", added: 0, error: failure }));
    }
  }
}
