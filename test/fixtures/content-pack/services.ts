import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPackFile, TarPackWriter } from "../../../src/server/adapters/backup/pack-archive.ts";
import { HmacFileGrantVerifier, signFileGrant } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { FlatCacheFileStore } from "../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { FfmpegMediaIngest } from "../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import type {
  ContentPackEngine,
  PackExportBuild,
  PackImportMediaPlan,
  PackPreviewState,
  PreparedPackContent,
} from "../../../src/server/application/content-pack-engine.ts";
import { ContentPackExportService, type ContentPackExportServiceOptions } from "../../../src/server/application/content-pack-export.ts";
import { ContentPackImportService, type ContentPackImportServiceOptions } from "../../../src/server/application/content-pack-import.ts";
import { PackJobSlots } from "../../../src/server/application/content-pack-jobs.ts";
import { amberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import type { InstanceSettings } from "../../../src/server/domain/runtime-support.ts";
import type { RequestPrincipal } from "../../../src/server/domain/user.ts";
import { CacheGate } from "../../../src/server/pipeline/cache-gate.ts";
import { CacheHoldRegistry } from "../../../src/server/pipeline/cache-holds.ts";
import { CachePathLocks } from "../../../src/server/pipeline/cache-path-locks.ts";
import { SplitMediaFiles } from "../../../src/server/pipeline/media-files.ts";
import type { Repository } from "../../../src/server/ports/repository.ts";
import { FILE_GRANT_TTL_MS } from "../../../src/shared/defaults.ts";
import type { PackCollectionResult, PackContentResult } from "../../../src/shared/dto/content-pack.ts";
import type { FileGrant } from "../../../src/shared/dto/local-media.ts";
import type { PackDocuments } from "../../../src/server/ports/content-pack.ts";

/**
 * The content pack job services over temporary directories, real stores, locks and archive
 * code, with a scripted engine in place of the library side and a repository that knows only
 * the media rows the tests put in it.
 */

export const principal = (userId: string, mode: "local" | "server" = "local"): RequestPrincipal => ({ userId, mode, role: "user", mustChangePassword: false });

export interface EngineScript {
  /** Builds the export; defaults to a build the test hands in. */
  build?: PackExportBuild;
  /** Called inside `buildExport` before it returns. */
  beforeBuild?: (hooks: Parameters<ContentPackEngine["buildExport"]>[2]) => Promise<void>;
  /** The kind each media entry is imported as. */
  targetKind?: PackImportMediaPlan["targetKind"];
  /** Content keys whose commit fails. */
  failCommit?: Set<string>;
  /** Content keys already committed: the next preparation skips them. */
  committed?: Set<string>;
  /** Fill-in plans: entry → existing location. */
  fills?: Map<string, { path: string } | { storageRef: string }>;
  /** Makes `collections.commit` throw. */
  failCollections?: boolean;
}

export interface FakeEngine extends ContentPackEngine {
  script: EngineScript;
  commits: Array<{ key: string; media: Map<string, { location: unknown; sizeBytes: number; sha256: string }>; images: number; imageEntries: string[] }>;
  /** Runs inside `commitContent`, before it answers. */
  onCommit?: (key: string) => void;
  collectionCommits: Array<{ keys: string[]; contentIds: Map<string, string> }>;
}

function result(key: string, status: PackContentResult["status"], contentId?: string): PackContentResult {
  return {
    key,
    status,
    ...(contentId === undefined ? {} : { contentId }),
    added: { revisions: 1, speakers: 0, figures: 0, notes: 0, media: 0 },
    updated: { figures: 0, notes: 0 },
    conflicts: { revisions: 0, figures: 0, notes: 0, media: 0 },
    placedByTime: 0,
  };
}

export function fakeEngine(script: EngineScript = {}): FakeEngine {
  const engine: FakeEngine = {
    script,
    commits: [],
    collectionCommits: [],
    exportPlan: () => ({ contents: [], collections: [] }),
    validateSelection: (owner, selection) => {
      if (selection.contents.some((content) => !content.contentId.startsWith(`${owner}-`) && !content.contentId.startsWith("content-"))) {
        throw amberError("not_found", "no such content");
      }
    },
    async buildExport(_owner, _selection, hooks) {
      const build = engine.script.build;
      if (build === undefined) throw new Error("no build scripted");
      for (const content of build.contents) {
        for (const media of content.media) {
          media.sha256 = await hooks.hashMedia({ assetId: media.assetId, contentId: media.contentId, kind: media.kind, location: media.location, sizeBytes: media.sizeBytes }, hooks.signal);
        }
      }
      await engine.script.beforeBuild?.(hooks);
      return build;
    },
    analyzeImport: (_owner, documents) => ({
      contents: documents.contents.map((content) => ({
        key: content.document.key,
        sourceKind: content.document.source.kind,
        match: "new" as const,
        candidates: [],
        diff: { revisions: [], speakers: [], figures: { new: 0, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 }, notes: { new: 0, existing: 0, differs: 0, unplaceable: 0 }, platformChapters: "none" as const, media: [], overLimit: [] },
      })),
      state: {} as PackPreviewState,
    }),
    compare: () => ({ revisions: [], speakers: [], figures: { new: 0, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 }, notes: { new: 0, existing: 0, differs: 0, unplaceable: 0 }, platformChapters: "none", media: [], overLimit: [] }),
    prepareImport(owner, documents, _state, decisions) {
      const contents: PreparedPackContent[] = [];
      const media: PackImportMediaPlan[] = [];
      const images = new Set<string>();
      for (const decision of decisions.contents) {
        const content = documents.contents.find((item) => item.document.key === decision.key);
        if (content === undefined) throw amberError("invalid_request", "unknown key", { params: { detail: "contents" } });
        const action = engine.script.committed?.has(decision.key) === true ? "skip" : decision.action;
        contents.push({ key: decision.key, action, ...(content.document.title === undefined ? {} : { title: content.document.title }) });
        if (action === "skip") continue;
        for (const figure of content.document.figures) images.add(figure.entry);
        for (const speaker of content.document.speakers) if (speaker.avatar !== undefined) images.add(speaker.avatar.entry);
        if (content.document.cover !== undefined) images.add(content.document.cover.entry);
        for (const item of content.document.media) {
          if (!(decision.mediaKeys ?? []).includes(item.key)) continue;
          const fill = engine.script.fills?.get(item.entry);
          media.push({
            entry: item.entry,
            contentKey: decision.key,
            contentId: `${owner}-${decision.key}`,
            assetId: `asset${decision.key.replace(/\W/gu, "")}`,
            fills: fill !== undefined,
            targetKind: engine.script.targetKind ?? "external_local",
            media: item,
            ...(fill === undefined ? {} : { existingLocation: fill }),
          });
        }
      }
      return { contents, media, imageEntries: images, refused: [] };
    },
    commitContent(owner, _documents, prepared, inputs) {
      engine.commits.push({ key: prepared.key, media: new Map(inputs.media), images: inputs.images.size, imageEntries: [...inputs.images.keys()].sort() });
      engine.onCommit?.(prepared.key);
      if (engine.script.failCommit?.has(prepared.key) === true) {
        return { ...result(prepared.key, "failed"), error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "x" } };
      }
      engine.script.committed ??= new Set();
      engine.script.committed.add(prepared.key);
      return result(prepared.key, "imported", `${owner}-${prepared.key}`);
    },
    collections: {
      preview: () => [],
      commit(_owner, _documents: PackDocuments, decisions, contentIds) {
        engine.collectionCommits.push({ keys: decisions.map((decision) => decision.key), contentIds: new Map(contentIds) });
        if (engine.script.failCollections === true) throw new Error("collections failed");
        return decisions.map((decision): PackCollectionResult => ({ key: decision.key, name: decision.key, status: "created", collectionId: `c-${decision.key}`, added: 1 }));
      },
    },
  };
  return engine;
}

export interface Rows {
  assets: MediaAsset[];
}

/** A repository with only the media asset reads the job services use. */
export function fakeRepository(rows: Rows): Repository {
  const scope = {
    mediaAssets: {
      get: (owner: string, id: string) => rows.assets.find((asset) => asset.userId === owner && asset.id === id),
      listCachesByStorageRefUnscoped: (ref: string) => rows.assets.filter((asset) => asset.kind === "platform_cache" && asset.storageRef === ref),
      listAvailableCachesUnscoped: () => rows.assets.filter((asset) => asset.kind === "platform_cache" && asset.availability === "available"),
    },
  };
  return { withTransaction: <T>(work: (s: typeof scope) => T): T => work(scope) } as unknown as Repository;
}

export interface Env {
  root: string;
  dataDir: string;
  workDir: string;
  outside: string;
  media: SplitMediaFiles;
  files: LocalFileStore;
  gate: CacheGate;
  locks: CachePathLocks;
  holds: CacheHoldRegistry;
  slots: PackJobSlots;
  rows: Rows;
  engine: FakeEngine;
  clock: { now: number };
  freeBytes: { value: number };
  disk: { freeBytes: number; totalBytes: number; usedBytes: number };
  grant(path: string, purpose: FileGrant["purpose"]): FileGrant;
  exports(mode?: "local" | "server", overrides?: Partial<ContentPackExportServiceOptions>): ContentPackExportService;
  imports(mode?: "local" | "server", overrides?: Partial<ContentPackImportServiceOptions>): ContentPackImportService;
  close(): void;
}

const KEY = Buffer.alloc(32, 7);
const SETTINGS = { concurrencyPipeline: 1, maxDataGB: 1000, lowWaterFreeGB: 0, lowWaterFreeRatio: 0, uploadRetentionDefault: "keep", updatedAt: 0 } as unknown as InstanceSettings;

export function createEnv(script: EngineScript = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "amber-pack-svc-"));
  const dataDir = join(root, "data");
  const outside = join(root, "outside");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const files = new LocalFileStore(dataDir);
  const media = new SplitMediaFiles(files, (dir, options) => new FlatCacheFileStore(dir, options), join(dataDir, "media"));
  const env: Env = {
    root,
    dataDir,
    workDir: join(dataDir, "tmp", "content-packs"),
    outside,
    media,
    files,
    gate: new CacheGate(),
    locks: new CachePathLocks(),
    holds: new CacheHoldRegistry(),
    slots: new PackJobSlots(),
    rows: { assets: [] },
    engine: fakeEngine(script),
    clock: { now: 1_700_000_000_000 },
    freeBytes: { value: Number.MAX_SAFE_INTEGER },
    disk: { freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12, usedBytes: 0 },
    grant: (path, purpose) => signFileGrant(KEY, { path, purpose, expiresAt: Date.now() + FILE_GRANT_TTL_MS - 1000 }),
    exports: (mode = "local", overrides = {}) =>
      new ContentPackExportService({
        mode,
        repository: fakeRepository(env.rows),
        engine: env.engine,
        files,
        media,
        ...(mode === "local" ? { grants: new HmacFileGrantVerifier(KEY) } : {}),
        appVersion: "0.0.0-test",
        writer: new TarPackWriter(),
        gate: env.gate,
        locks: env.locks,
        ingest: { normalizeImage: () => Promise.reject(new Error("not expected")) },
        workDir: env.workDir,
        disk: { diskUsage: async () => ({ ...env.disk }) },
        settings: { effective: () => SETTINGS },
        slots: env.slots,
        now: () => env.clock.now,
        freeBytes: () => env.freeBytes.value,
        ...overrides,
      }),
    imports: (mode = "local", overrides = {}) =>
      new ContentPackImportService({
        mode,
        repository: fakeRepository(env.rows),
        engine: env.engine,
        files,
        media,
        ...(mode === "local" ? { grants: new HmacFileGrantVerifier(KEY) } : {}),
        openPack: openPackFile,
        // The real header check: it reads only leading bytes and starts no tool.
        ingest: new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: root, env: {} }),
        gate: env.gate,
        locks: env.locks,
        holds: env.holds,
        workDir: env.workDir,
        disk: { diskUsage: async () => ({ ...env.disk }) },
        settings: { effective: () => SETTINGS },
        slots: env.slots,
        now: () => env.clock.now,
        freeBytes: () => env.freeBytes.value,
        ...overrides,
      }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
  return env;
}

/** Polls until `check` holds. */
export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function* chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield part;
}
