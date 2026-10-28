import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { monotonicFactory } from "ulid";
import { DISPLAY_NAME_MAX_CHARS, MAX_UPLOAD_GB, SUBTITLE_IMPORT_MAX_BYTES } from "../../shared/defaults.ts";
import { importSettingsSchema, type ImportResponse, type ImportSettings } from "../../shared/dto/import.ts";
import type { LocalFileRequest } from "../../shared/dto/local-media.ts";
import { BYTES_PER_GB, BYTES_PER_MB } from "../../shared/units.ts";
import type { Content } from "../domain/content.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import { defaultRetentionPolicy } from "../domain/media-asset.ts";
import { canonicalLanguageTag, decodeSubtitleText, importedTranscript, parseTimedSubtitle, type ParsedSubtitle } from "../domain/subtitle-file.ts";
import type { ProcessContentRequest } from "../domain/task-request.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";
import { FileTooLargeError, type FileStore } from "../ports/file-store.ts";
import type { LocalMediaIngest, MediaProbe } from "../ports/local-media-ingest.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import type { FairSemaphore } from "../pipeline/fair-semaphore.ts";
import { type Outbox, transact } from "../pipeline/publish.ts";
import { modelRefProblem } from "../pipeline/requirements.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import { assetRef, isOriginalMedia } from "../pipeline/stages/source-media.ts";
import { createTask } from "../pipeline/task-state.ts";
import { freezePromptRefs } from "./prompts.ts";
import { jsonRequestDigest, multipartRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";
import type { QuotaReservation, StorageQuota } from "./storage-quota.ts";
import { asrModelRefForSubmission } from "./settings.ts";
import { resolveTemplateRef } from "./summary-templates.ts";
import type { TaskControl } from "./tasks.ts";

export const UPLOAD_ROUTE = "POST /api/contents/upload";
export const LOCAL_FILE_ROUTE = "POST /api/contents/local-file";

/** One multipart part as the HTTP layer hands it over; file streams must be consumed in order. */
export type UploadPart =
  | { kind: "field"; name: string; value: string }
  | { kind: "file"; name: string; filename: string | undefined; stream: AsyncIterable<Uint8Array> };

/** Fixed part order of `POST /contents/upload`; `file` is required and last. */
const UPLOAD_PART_ORDER = ["settings", "allowDuplicate", "subtitleLanguage", "subtitle", "file"] as const;
type UploadPartName = (typeof UPLOAD_PART_ORDER)[number];
const FILE_PARTS: ReadonlySet<UploadPartName> = new Set(["subtitle", "file"]);

export interface LocalImportServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  files: FileStore;
  ingest: LocalMediaIngest;
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  /** Per-user storage limits of uploads; without it uploads are bounded by the disk watermark only. */
  quota?: StorageQuota;
  /** Local mode only: the verifier of file dialog grants. */
  grants?: FileGrantVerifier;
  /** Streaming limit of the media part; `MAX_UPLOAD_GB` unless a test lowers it. */
  maxUploadBytes?: number;
  /**
   * The instance's managed heavy-job governor: the upload-validation ffprobe
   * takes a slot in the uploader's foreground group. Without it the probe runs directly.
   */
  heavy?: Pick<FairSemaphore, "run">;
  now?: () => number;
  newId?: () => string;
}

interface InitialSubtitle {
  subtitle: ParsedSubtitle;
  language: string;
}

interface LocalContentInput {
  owner: string;
  contentId: string;
  asset: MediaAsset;
  settings: ImportSettings;
  allowDuplicate: boolean;
  initialSubtitle: InitialSubtitle | undefined;
  sourceType: "upload" | "local_file";
}

function invalid(detail: string, message = `invalid ${detail}`): AmberError {
  return amberError("invalid_request", message, { params: { detail } });
}

function tooLarge(limitBytes: number): AmberError {
  const limit = limitBytes >= BYTES_PER_GB ? `${limitBytes / BYTES_PER_GB} GB` : `${Math.round(limitBytes / BYTES_PER_MB)} MB`;
  return amberError("media_too_large", `part exceeds ${limitBytes} bytes`, { params: { limit } });
}

/** BCP-47 tags are stored in canonical case (`zh-cn` → `zh-CN`). */
function canonicalLanguage(tag: string, detail: string): string {
  const canonical = canonicalLanguageTag(tag);
  if (canonical === undefined) {
    throw invalid(detail);
  }
  return canonical;
}

function displayNameOf(filename: string | undefined): string | undefined {
  const name = filename === undefined ? "" : basename(filename.replace(/\\/g, "/")).trim();
  return name === "" ? undefined : name.slice(0, DISPLAY_NAME_MAX_CHARS);
}

function parseSubtitle(bytes: Uint8Array, language: string): InitialSubtitle {
  return { subtitle: parseTimedSubtitle(decodeSubtitleText(bytes)), language };
}

async function readLimited(stream: AsyncIterable<Uint8Array>, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new FileTooLargeError(limitBytes);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Entry points for local media: `upload` streams a server upload
 * into a `managed_upload`; `importLocalFile` references a file on the user's disk as
 * `external_local`. Both create the ImportBatch, Content, MediaAsset, optional `imported`
 * revision (made primary) and the `process_content` Task in one transaction; nothing is
 * probed here beyond what the entry point needs, the `media` stage does the rest.
 */
export class LocalImportService {
  private readonly options: LocalImportServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxUploadBytes: number;

  constructor(options: LocalImportServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_GB * BYTES_PER_GB;
  }

  /** Per-part streaming limit the HTTP layer hands to its multipart parser. */
  get uploadLimitBytes(): number {
    return this.maxUploadBytes;
  }

  /**
   * `POST /api/contents/upload` [server]. Parts arrive in the fixed order; the media part
   * is written through `writeAtomic` with a streaming limit and sniffed (magic bytes +
   * ffprobe) before it is committed. After that, a duplicate, an idempotent replay or a
   * database failure removes the new file again.
   */
  async upload(principal: RequestPrincipal, parts: AsyncIterable<UploadPart>, idempotencyKey?: string): Promise<IdempotentResult<ImportResponse>> {
    const owner = principal.userId;
    const replay = await this.checkDiskUnlessReplay(owner, UPLOAD_ROUTE, idempotencyKey);
    const reservation = replay ? undefined : await this.options.quota?.begin(owner);
    try {
      return await this.receiveUpload(owner, parts, idempotencyKey, reservation);
    } finally {
      // Committed bytes are now counted on disk; an abandoned upload left nothing behind.
      reservation?.release();
    }
  }

  private async receiveUpload(
    owner: string,
    parts: AsyncIterable<UploadPart>,
    idempotencyKey: string | undefined,
    reservation: QuotaReservation | undefined,
  ): Promise<IdempotentResult<ImportResponse>> {
    let settings: ImportSettings = importSettingsSchema.parse({});
    let allowDuplicate = false;
    let subtitleLanguage: string | undefined;
    let subtitleBytes: Buffer | undefined;
    let initialSubtitle: InitialSubtitle | undefined;
    let written: { ref: string; asset: MediaAsset } | undefined;
    let position = -1;
    try {
      for await (const part of parts) {
        const index = UPLOAD_PART_ORDER.indexOf(part.name as UploadPartName);
        const name = part.name as UploadPartName;
        if (index < 0 || index <= position || written !== undefined || (part.kind === "file") !== FILE_PARTS.has(name)) {
          throw invalid("parts", `unexpected part ${JSON.stringify(part.name)}`);
        }
        position = index;
        if (part.kind === "field") {
          if (name === "settings") {
            settings = this.parseSettings(part.value);
          } else if (name === "allowDuplicate") {
            if (part.value !== "true" && part.value !== "false") {
              throw invalid("allowDuplicate");
            }
            allowDuplicate = part.value === "true";
          } else {
            subtitleLanguage = canonicalLanguage(part.value, "subtitleLanguage");
          }
          continue;
        }
        if (name === "subtitle") {
          if (subtitleLanguage === undefined) {
            throw invalid("subtitleLanguage", "a subtitle needs its language");
          }
          subtitleBytes = await this.readPart(part.stream, SUBTITLE_IMPORT_MAX_BYTES);
          initialSubtitle = parseSubtitle(subtitleBytes, subtitleLanguage);
          continue;
        }
        written = await this.receiveMedia(owner, part.filename, reservation === undefined ? part.stream : reservation.meter(part.stream));
      }
      if (written === undefined) {
        throw invalid("file", "the media part is missing");
      }
    } catch (error) {
      if (written !== undefined) {
        await this.discardUpload(written.ref);
      }
      throw error;
    }

    const media = written;
    const requestDigest = multipartRequestDigest({
      mediaSha256: media.asset.fingerprint as string,
      ...(subtitleBytes === undefined ? {} : { subtitleSha256: `sha256:${createHash("sha256").update(subtitleBytes).digest("hex")}` }),
      metadata: { settings, allowDuplicate, ...(subtitleLanguage === undefined ? {} : { subtitleLanguage }) },
    });
    return this.commit(owner, { route: UPLOAD_ROUTE, key: idempotencyKey, requestDigest }, media.ref, {
      owner,
      contentId: media.asset.contentId,
      asset: media.asset,
      settings,
      allowDuplicate,
      initialSubtitle,
      sourceType: "upload",
    });
  }

  /**
   * `POST /api/contents/local-file` [client]: the file stays where it is. Invariant: Amber
   * never deletes an `external_local` file.
   */
  async importLocalFile(principal: RequestPrincipal, body: LocalFileRequest, idempotencyKey?: string): Promise<IdempotentResult<ImportResponse>> {
    const owner = principal.userId;
    const grants = this.options.grants;
    if (grants === undefined) {
      throw new TypeError("local file import needs a file grant verifier");
    }
    this.checkGrant(grants, body.grant, body.path);
    if (body.initialSubtitle !== undefined) {
      this.checkGrant(grants, body.initialSubtitle.grant, body.initialSubtitle.path);
    }
    const settings = body.settings;
    const sizeBytes = await this.checkReadableFile(body.path, "path");
    let initialSubtitle: InitialSubtitle | undefined;
    if (body.initialSubtitle !== undefined) {
      const subtitleSize = await this.checkReadableFile(body.initialSubtitle.path, "initialSubtitle.path");
      if (subtitleSize > SUBTITLE_IMPORT_MAX_BYTES) {
        throw tooLarge(SUBTITLE_IMPORT_MAX_BYTES);
      }
      const language = canonicalLanguage(body.initialSubtitle.language, "initialSubtitle.language");
      initialSubtitle = parseSubtitle(await readFile(body.initialSubtitle.path), language);
    }
    await this.checkDiskUnlessReplay(owner, LOCAL_FILE_ROUTE, idempotencyKey);
    const fingerprint = await sha256File(body.path);

    const contentId = this.newId();
    const asset: MediaAsset = {
      id: this.newId(),
      userId: owner,
      contentId,
      kind: "external_local",
      storageRef: body.path,
      mimeType: "application/octet-stream",
      sizeBytes,
      fingerprint,
      availability: "available",
      retentionPolicy: defaultRetentionPolicy("external_local", this.options.settings.effective().uploadRetentionDefault),
      createdAt: this.now(),
    };
    const displayName = displayNameOf(body.path);
    if (displayName !== undefined) {
      asset.displayName = displayName;
    }
    return this.commit(owner, { route: LOCAL_FILE_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest(body) }, undefined, {
      owner,
      contentId,
      asset,
      settings,
      allowDuplicate: body.allowDuplicate,
      initialSubtitle,
      sourceType: "local_file",
    });
  }

  private parseSettings(value: string): ImportSettings {
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      throw invalid("settings");
    }
    const parsed = importSettingsSchema.safeParse(json);
    if (!parsed.success) {
      throw invalid("settings");
    }
    return parsed.data;
  }

  private async readPart(stream: AsyncIterable<Uint8Array>, limitBytes: number): Promise<Buffer> {
    try {
      return await readLimited(stream, limitBytes);
    } catch (error) {
      throw error instanceof FileTooLargeError ? tooLarge(error.limitBytes) : error;
    }
  }

  private async receiveMedia(owner: string, filename: string | undefined, stream: AsyncIterable<Uint8Array>): Promise<{ ref: string; asset: MediaAsset }> {
    const contentId = this.newId();
    const assetId = this.newId();
    const ref = assetRef({ userId: owner, contentId, id: assetId });
    let probe: MediaProbe | undefined;
    let stored;
    try {
      stored = await this.options.files.writeAtomic(ref, stream, {
        maxBytes: this.maxUploadBytes,
        beforeCommit: async (partial) => {
          probe = await this.probeAsHeavyJob(owner, partial);
        },
      });
    } catch (error) {
      await this.discardUpload(ref);
      throw error instanceof FileTooLargeError ? tooLarge(error.limitBytes) : error;
    }
    const probed = probe as MediaProbe;
    const asset: MediaAsset = {
      id: assetId,
      userId: owner,
      contentId,
      kind: "managed_upload",
      storageRef: ref,
      mimeType: probed.mimeType,
      sizeBytes: stored.sizeBytes,
      durationMs: probed.durationMs,
      fingerprint: stored.digest,
      availability: "available",
      retentionPolicy: defaultRetentionPolicy("managed_upload", this.options.settings.effective().uploadRetentionDefault),
      createdAt: this.now(),
    };
    const displayName = displayNameOf(filename);
    if (displayName !== undefined) {
      asset.displayName = displayName;
    }
    return { ref, asset };
  }

  /**
   * The upload's ffprobe counts against the instance's heavy-job capacity like pipeline
   * work does, so concurrent uploads cannot run more probes than the task count allows.
   * The HTTP layer hands no cancellation signal down, hence one that never aborts.
   */
  private probeAsHeavyJob(owner: string, path: string): Promise<MediaProbe> {
    const signal = new AbortController().signal;
    const work = (): Promise<MediaProbe> => this.options.ingest.probe(path, signal);
    const heavy = this.options.heavy;
    return heavy === undefined ? work() : heavy.run({ key: `foreground:${owner}`, createdAt: this.now() }, signal, work);
  }

  private checkGrant(grants: FileGrantVerifier, grant: LocalFileRequest["grant"], path: string): void {
    if (!grants.verify(grant, { path, purpose: "local_file" })) {
      throw amberError("unauthenticated", "file grant is missing, forged or expired", { code: "unauthenticated.file_grant" });
    }
  }

  /** Absolute path of an existing, readable regular file; returns its size. */
  private async checkReadableFile(path: string, detail: string): Promise<number> {
    if (!isAbsolute(path)) {
      throw invalid(detail, "path is not absolute");
    }
    try {
      const stats = await stat(path);
      if (!stats.isFile()) {
        throw invalid(detail, "path is not a regular file");
      }
      await access(path, constants.R_OK);
      return stats.size;
    } catch (error) {
      if (error instanceof AmberError) {
        throw error;
      }
      throw invalid(detail, "path does not name a readable file");
    }
  }

  /** Returns whether the request replays a stored one. */
  private async checkDiskUnlessReplay(owner: string, route: string, key: string | undefined): Promise<boolean> {
    // A replay answers even while new work is paused, so it is checked before the watermark.
    const replay = key === undefined ? undefined : this.options.repository.withTransaction((scope) => scope.idempotency.get(owner, route, key));
    if (replay !== undefined) {
      return true;
    }
    const low = await diskLowError(this.options.disk, this.options.settings.effective());
    if (low !== undefined) {
      throw new AmberError(low, "disk below the low-water mark");
    }
    return false;
  }

  /**
   * Removes an upload nothing references, with the directory made for it: each upload gets a
   * fresh Content id, so nothing else writes there.
   */
  private async discardUpload(ref: string): Promise<void> {
    await this.options.files.remove(ref);
    await this.options.files.removeEmptyDirs(ref.slice(0, ref.lastIndexOf("/")));
  }

  /** Creates everything in one transaction; a committed upload file is removed again if nothing ends up referencing it. */
  private async commit(
    owner: string,
    idempotency: { route: string; key: string | undefined; requestDigest: string },
    uploadedRef: string | undefined,
    input: LocalContentInput,
  ): Promise<IdempotentResult<ImportResponse>> {
    let result: IdempotentResult<ImportResponse>;
    try {
      result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
        runIdempotent(scope, { userId: owner, ...idempotency }, this.now(), () => this.create(scope, outbox, input)),
      );
    } catch (error) {
      if (uploadedRef !== undefined) {
        await this.discardUpload(uploadedRef);
      }
      throw error;
    }
    if (result.replayed) {
      if (uploadedRef !== undefined) {
        await this.discardUpload(uploadedRef);
      }
    } else {
      this.options.control.kick();
    }
    return result;
  }

  private create(scope: RepositoryScope, outbox: Outbox, input: LocalContentInput) {
    const { owner, contentId, asset, settings } = input;
    if (settings.modelRef !== undefined && modelRefProblem(scope, owner, settings.modelRef) !== undefined) {
      throw amberError("invalid_request", "modelRef does not name an owned model", { params: { detail: "settings.modelRef" } });
    }
    const templateRef = resolveTemplateRef(scope, owner, settings.templateId, "settings.templateId");
    const asrModelRef = asrModelRefForSubmission(scope, owner, settings.asrModelRef, "settings.asrModelRef");
    if (asset.fingerprint !== undefined && !input.allowDuplicate) {
      // A Content in the trash still holds its file; one outside it is the better answer.
      const candidates = scope.mediaAssets
        .findByFingerprint(owner, asset.fingerprint)
        .filter(isOriginalMedia)
        .map((original) => ({ contentId: original.contentId, trashed: scope.contents.get(owner, original.contentId) === undefined }));
      const duplicate = candidates.find((candidate) => !candidate.trashed) ?? candidates[0];
      if (duplicate !== undefined) {
        throw amberError("conflict", "a file with the same content already exists", {
          code: "conflict.duplicate_file",
          details: { duplicateOfContentId: duplicate.contentId, trashed: duplicate.trashed },
        });
      }
    }
    const now = this.now();
    const batchId = this.newId();
    scope.importBatches.insert({ id: batchId, userId: owner, createdAt: now, sourceType: input.sourceType, totalItems: 1 });
    const content: Content = { id: contentId, userId: owner, source: { kind: "local" }, importBatchId: batchId, processingStatus: "queued", createdAt: now, updatedAt: now };
    scope.contents.insert(content);
    scope.mediaAssets.insert(asset);
    const created = [batchId, contentId, asset.id];

    let initialSubtitleRevisionId: string | undefined;
    if (input.initialSubtitle !== undefined) {
      initialSubtitleRevisionId = this.newId();
      const { revision, segments } = importedTranscript({
        revisionId: initialSubtitleRevisionId,
        contentId,
        language: input.initialSubtitle.language,
        subtitle: input.initialSubtitle.subtitle,
        newId: this.newId,
        createdAt: now,
      });
      scope.transcripts.insertRevision(owner, revision, segments);
      scope.contents.setPrimaryTranscript(owner, contentId, revision.id, now);
      created.push(revision.id);
    }
    scope.search.syncContent(owner, contentId);
    const request: ProcessContentRequest = {
      requestSchemaVersion: 1,
      kind: "process_content",
      promptRefs: freezePromptRefs(scope, owner, "process_content"),
      ...(settings.modelRef === undefined ? {} : { modelRef: settings.modelRef }),
      ...(asrModelRef === undefined ? {} : { asrModelRef }),
      ...(settings.outputLanguage === undefined ? {} : { outputLanguage: settings.outputLanguage }),
      autoProofread: settings.autoProofread,
      templateRef,
      ...(initialSubtitleRevisionId === undefined ? {} : { initialSubtitleRevisionId }),
    };
    const task = createTask(scope, outbox, {
      task: { id: this.newId(), userId: owner, contentId, kind: "process_content", requestJson: canonicalJson(request), createdAt: now },
      sourceKind: "local",
      newId: this.newId,
    });
    created.push(task.id);
    return { status: 202, body: { importBatchId: batchId, taskIds: [task.id], contentIds: [contentId], skippedTrashedContentIds: [] }, resourceRefs: created };
  }
}
