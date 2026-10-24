import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import packageJson from "../../package.json" with { type: "json" };
import { SERVER_PORT_DEFAULT, SETUP_TOKEN_TTL_MIN } from "../shared/defaults.ts";
import { ensureDataDir } from "./adapters/file-store/data-dir.ts";
import { CACHE_DIR_NAME } from "../shared/app-identity.ts";
import { FlatCacheFileStore } from "./adapters/file-store/flat-cache-file-store.ts";
import { LocalFileStore } from "./adapters/file-store/local-file-store.ts";
import { FILE_GRANT_KEY_ENV, HmacFileGrantVerifier, parseFileGrantKey } from "./adapters/file-grant/hmac-file-grant.ts";
import { LocalAuthAdapter } from "./adapters/auth/local/index.ts";
import { DashscopeAsrProviderFactory } from "./adapters/asr/dashscope/index.ts";
import { ElevenLabsAsrProviderFactory } from "./adapters/asr/elevenlabs/index.ts";
import { AnthropicMessagesProvider } from "./adapters/llm/anthropic-messages/index.ts";
import { OpenAiCompatibleProvider } from "./adapters/llm/openai-compatible/index.ts";
import { FfmpegVideoBurner } from "./adapters/media-ingest/ffmpeg-burner.ts";
import { FfmpegSubtitleMuxer } from "./adapters/media-ingest/ffmpeg-subtitle-muxer.ts";
import { BundledSubtitleFont, SUBTITLE_FONT_FILE } from "./api/routes/fonts.ts";
import { FfmpegMediaIngest } from "./adapters/media-ingest/ffmpeg-media-ingest.ts";
import { PolicyOutboundHttpClient } from "./adapters/outbound-http/policy-client.ts";
import { BilibiliAdapter } from "./adapters/platform/bilibili/index.ts";
import { BilibiliQrLogin } from "./adapters/platform/bilibili/qr-login.ts";
import { YoutubeAdapter } from "./adapters/platform/youtube/index.ts";
import { YtDlp } from "./adapters/platform/yt-dlp.ts";
import { NodeProcessRunner } from "./adapters/process-runner/node-process-runner.ts";
import { AesGcmSecretStore } from "./adapters/secret-store/aes-gcm-secret-store.ts";
import { MASTER_KEY_ENV, resolveMasterKey } from "./adapters/secret-store/master-key.ts";
import { LOCAL_MASTER_KEY_ROTATION, ServerMasterKeyRotation } from "./adapters/secret-store/rotation.ts";
import { Argon2PasswordHasher, ServerAuthAdapter, SetupToken } from "./adapters/auth/server/index.ts";
import { openDatabase } from "./adapters/sqlite/database.ts";
import { SqliteBackupStore } from "./adapters/sqlite/backup-store.ts";
import { TarBackupArchiveWriter } from "./adapters/backup/archive-writer.ts";
import { Maintenance } from "./api/maintenance.ts";
import { BackupExportService } from "./application/backup-export.ts";
import { RestoreReadinessService } from "./application/restore-readiness.ts";
import { recoverInterruptedRestore } from "./restore.ts";
import { SqliteRepository } from "./adapters/sqlite/repository.ts";
import { sqliteSecretEnvelopeStore } from "./adapters/sqlite/repositories/secret-envelopes.ts";
import { buildApp, type RegisteredRoute, type ServerAuthDeps } from "./app.ts";
import { AdminService, type AdminTaskControl } from "./application/admin.ts";
import { AsrProfileService } from "./application/asr-profile.ts";
import { AuthService, ensureAdminBootstrap } from "./application/auth.ts";
import { CacheRootService } from "./application/cache-root.ts";
import { ChapterService } from "./application/chapters.ts";
import { ExportService } from "./application/export.ts";
import { HighlightService } from "./application/highlights.ts";
import { TranslationService } from "./application/translations.ts";
import { ChatService } from "./application/chat.ts";
import { NoteService } from "./application/notes.ts";
import { PendingFileDeleter } from "./application/pending-file-delete.ts";
import { CacheHoldService } from "./application/cache-holds.ts";
import { ClientMediaTaskService } from "./application/client-media-tasks.ts";
import { CollectionService } from "./application/collections.ts";
import { ContentService } from "./application/contents.ts";
import { DeleteContentService } from "./application/delete-content.ts";
import { DerivedTaskService } from "./application/derived-tasks.ts";
import { ensureLocalUser } from "./application/ensure-local-user.ts";
import { ImportContentService } from "./application/import-content.ts";
import { ensureInstanceSettings, InstanceSettingsService, readInstanceSettingsEnv } from "./application/instance-settings.ts";
import { LlmGateway } from "./application/llm-gateway.ts";
import { LocalImportService } from "./application/local-import.ts";
import { MediaAssetService } from "./application/media-assets.ts";
import { PlatformAccountService } from "./application/platform-accounts.ts";
import { PlatformQrLoginService } from "./application/platform-qr-login.ts";
import { PlatformRegistry } from "./application/platforms.ts";
import { OtherModelService } from "./application/other-models.ts";
import { ProviderService } from "./application/providers.ts";
import { RelinkService } from "./application/relink.ts";
import { RetranscribeService } from "./application/retranscribe.ts";
import { SearchService } from "./application/search.ts";
import { SessionRevocations } from "./application/session-revocations.ts";
import { StorageQuota } from "./application/storage-quota.ts";
import { SettingsService } from "./application/settings.ts";
import { SummaryService } from "./application/summaries.ts";
import { ensureBuiltinSummaryTemplates, SummaryTemplateService } from "./application/summary-templates.ts";
import { TaskService, type TaskControl } from "./application/tasks.ts";
import { TerminologyService } from "./application/terminology.ts";
import { TranscriptService } from "./application/transcripts.ts";
import { TrashService } from "./application/trash.ts";
import { UsageService } from "./application/usage.ts";
import { AssetJanitor } from "./pipeline/asset-janitor.ts";
import { CacheDownloadLedger } from "./pipeline/cache-download-ledger.ts";
import { CacheHoldRegistry } from "./pipeline/cache-holds.ts";
import { CachePathLocks } from "./pipeline/cache-path-locks.ts";
import { CacheGate } from "./pipeline/cache-gate.ts";
import { TaskEventBus } from "./pipeline/events.ts";
import { SplitMediaFiles } from "./pipeline/media-files.ts";
import { FairSemaphore } from "./pipeline/fair-semaphore.ts";
import { Scheduler } from "./pipeline/scheduler.ts";
import { AsrStageExecutor } from "./pipeline/stages/asr.ts";
import { BurnStageExecutor } from "./pipeline/stages/burn.ts";
import { CacheMediaStageExecutor } from "./pipeline/stages/cache-media.ts";
import { ChapterStageExecutor } from "./pipeline/stages/chapter.ts";
import { HighlightStageExecutor } from "./pipeline/stages/highlight.ts";
import { TranslateStageExecutor } from "./pipeline/stages/translate.ts";
import { CollectionSummaryStageExecutor } from "./pipeline/stages/collection-summary.ts";
import { MediaStageExecutor } from "./pipeline/stages/media.ts";
import type { PlatformAccess } from "./pipeline/stages/platform-access.ts";
import { ProofreadStageExecutor } from "./pipeline/stages/proofread.ts";
import { SourceStageExecutor } from "./pipeline/stages/source.ts";
import { SubtitleStageExecutor } from "./pipeline/stages/subtitle.ts";
import { SummaryStageExecutor } from "./pipeline/stages/summary.ts";
import type { AsrProviderId } from "../shared/enums.ts";
import type { AsrProviderFactory } from "./ports/asr-provider.ts";
import type { AuthAdapter } from "./ports/auth-adapter.ts";
import type { Repository } from "./ports/repository.ts";
import type { Logger } from "./ports/logger.ts";
import { childProcessEnv } from "./ports/process-runner.ts";

/** Origin of the Tauri WebView on Windows (`useHttpsScheme` is false). */
const TAURI_ORIGIN = "http://tauri.localhost";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

interface CommonConfig {
  dataDir: string;
  binDir: string;
  logLevel: LogLevel;
  /** Structured log lines; the sidecar's stdout carries only READY. */
  logDestination: { write(line: string): void };
  /** Variables still read during composition (master key, instance overrides, preset admin). */
  env: NodeJS.ProcessEnv;
}

export interface LocalConfig extends CommonConfig {
  mode: "local";
  token: string;
  /** HMAC key of the shell's file grants. */
  fileGrantKey: Buffer;
}

export interface ServerConfig extends CommonConfig {
  mode: "server";
  /** `AMBER_PUBLIC_ORIGIN`: CSRF origin checks match it exactly. */
  publicOrigin: string;
  /** `AMBER_TRUSTED_PROXY_CIDRS`. */
  trustedProxyCidrs: readonly string[];
  /** The built SPA; defaults to `dist/web` beside the server bundle. */
  webRoot?: string;
}

export type ComposeConfig = LocalConfig | ServerConfig;

/** A composed backend, not yet listening. */
export interface Composition {
  app: FastifyInstance;
  logger: Logger;
  /** Explicitly registered routes, so tests can reconcile them against the API route list. */
  routes: readonly RegisteredRoute[];
  repository: Repository;
  /**
   * Server mode before its first administrator exists: the one-time token the wizard asks
   * for, to be printed once to the console and kept nowhere else: the one bootstrap exception
   * to secrets never reaching output.
   */
  setupToken?: { value: string; ttlMinutes: number };
  /** Sweeping, search readiness and scheduling; run once the server listens. */
  startBackground(): Promise<void>;
  /** Whether `startBackground` has finished its sweeps and recovery. */
  backgroundReady(): boolean;
  shutdown(): Promise<void>;
}

/** Start-up diagnostics before the app logger exists, as structured lines on stderr. */
export function startupLog(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: Date.now(), event, ...fields })}\n`);
}

/**
 * The built SPA served in server mode: `dist/web` beside `dist/server/server.js`, or the
 * repository's `dist/web` when the server runs from source.
 */
export function defaultWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(join("src", "server")) ? join(here, "..", "..", "dist", "web") : join(here, "..", "web");
}

/**
 * The composition root shared by both run modes: every service is created here and nowhere
 * else. The two modes differ only in the AuthAdapter, the outbound network policy, the first
 * user, CORS versus static hosting, and the routes marked `[client]` (local mode only) or
 * `[server]` (server mode only).
 */
export async function compose(config: ComposeConfig): Promise<Composition> {
  const layout = ensureDataDir(config.dataDir);
  // The cache directory in use is read on every measurement: it moves when the user changes
  // the cache location, and only when it lies inside the data directory does excluding it matter.
  const files: LocalFileStore = new LocalFileStore(layout.root, { usageExclude: (): string[] => [media.cache.directory()] });
  // The data store plus the video cache store, which the desktop user may move to another
  // volume; the asset kind decides which one a file lives in.
  const media = new SplitMediaFiles(files, (dir, options) => new FlatCacheFileStore(dir, options), join(layout.root, CACHE_DIR_NAME));
  const gate = new CacheGate();

  if (config.mode === "local") {
    // An interrupted restore is settled before anything opens the database it may replace.
    startupLog("restore_recovery", { outcome: await recoverInterruptedRestore(layout.root) });
  }
  const { db, from, to, backupPath } = openDatabase(layout.database, { backupDir: layout.backups });
  startupLog("database_ready", { schemaFrom: from, schemaTo: to, ...(backupPath === undefined ? {} : { backupPath }) });
  const repository = new SqliteRepository(db);
  if (config.mode === "local") {
    ensureLocalUser(repository);
  }
  ensureBuiltinSummaryTemplates(repository, Date.now());

  const envelopes = sqliteSecretEnvelopeStore(db);
  const masterKey = resolveMasterKey({
    mode: config.mode,
    env: config.env,
    secretsDir: layout.secrets,
    hasEnvelopes: () => envelopes.anyExists(),
  });
  startupLog("master_key", masterKey.state === "present" ? { state: masterKey.state, source: masterKey.source } : masterKey);
  const secrets = new AesGcmSecretStore({
    masterKey: masterKey.state === "present" ? masterKey.key : undefined,
    envelopes,
  });
  const overrides = readInstanceSettingsEnv(config.env);
  ensureInstanceSettings(repository);

  // The scheduler is created after the app so it can use the app's redacting logger; the
  // services reach it through this late-bound control.
  const bus = new TaskEventBus();
  let scheduler: Scheduler | undefined;
  const control: TaskControl = {
    kick: () => scheduler?.kick(),
    abortTask: (taskId) => scheduler?.abortTask(taskId),
  };
  // A changed task count applies at the next scheduling pass, which also drains the heavy-job governor.
  const instanceSettings = new InstanceSettingsService({ repository, overrides, onChange: () => control.kick() });
  // The one managed heavy-job governor, shared by the pipeline and API-side probing and parsing.
  // Its capacity is the number of Tasks allowed to run, so Amber never runs more managed heavy
  // jobs at once than it processes Tasks.
  const heavy = new FairSemaphore(() => instanceSettings.effective().concurrencyPipeline);
  // Before anything resolves a cache path: a stored custom root applies from the first request.
  media.cache.setRoot(instanceSettings.effective().cacheRoot);
  // The ASR factories are composed further down, once the outbound client exists; a
  // cancellation only looks one up at run time.
  const tasks = new TaskService({
    repository,
    bus,
    control,
    secrets,
    asr: (provider) => asrFactoryFor(provider),
    logger: lateLogger(() => appLogger?.child({ component: "tasks" })),
  });
  // The app's redacting logger exists only once the app is built; until then nothing logs.
  let appLogger: Logger | undefined;
  // Late-bound like the scheduler: the cache root service and the trash are created further down.
  let cacheRoot: CacheRootService | undefined;
  let lateTrash: TrashService | undefined;
  // The janitor, created last, settles interrupted cache replacements before cache Tasks are admitted.
  let lateJanitor: AssetJanitor | undefined;
  const recoverCacheSwaps = async (): Promise<void> => {
    await lateJanitor?.ensureSwapsRecovered();
  };
  // Everything that replaces or removes a file at one cache path takes that path's lock;
  // replacements interrupted by a crash wait in the hold registry for the user; downloads
  // in flight reserve their disk space in the ledger.
  const cachePaths = new CachePathLocks();
  const cacheHoldRegistry = new CacheHoldRegistry();
  const cacheLedger = new CacheDownloadLedger();
  // A cache directory that cannot be read counts as sharing the data volume: the stricter budget.
  const cacheSharesDataVolume = (): boolean => {
    const data = statSync(layout.root, { throwIfNoEntry: false });
    const cache = statSync(media.cache.directory(), { throwIfNoEntry: false });
    return data === undefined || cache === undefined || data.dev === cache.dev;
  };
  // Files of purged Contents and deleted users, removed after their deletion commits.
  const fileDeleter = new PendingFileDeleter({
    repository,
    media,
    dataDir: layout.root,
    gate,
    locks: cachePaths,
    foreignCacheRoot: async (rootPath) => cacheRoot?.ownedStoreOver(rootPath),
    afterDrain: () => lateTrash?.refresh(),
    logger: lateLogger(() => appLogger?.child({ component: "pending_file_delete" })),
  });

  const runner = new NodeProcessRunner();
  const ingest = new FfmpegMediaIngest({ runner, binDir: config.binDir, env: childProcessEnv(config.env) });
  // The bundled fonts directory sits beside AMBER_BIN_DIR in the runtime assets.
  const fontsDir = join(dirname(config.binDir), "fonts");
  const subtitleFont = new BundledSubtitleFont(join(fontsDir, SUBTITLE_FONT_FILE));
  const muxer = new FfmpegSubtitleMuxer({ runner, binDir: config.binDir, fontPath: subtitleFont.path, env: childProcessEnv(config.env) });
  // Server mode only: uploads count against `storageLimitGB`; local files are only referenced, never copied.
  const quota = config.mode === "server" ? new StorageQuota({ repository, files }) : undefined;
  // Local mode: one key verifies the shell's file grants and signs the sidecar's burn-output grants.
  const grants = config.mode === "local" ? new HmacFileGrantVerifier(config.fileGrantKey) : undefined;
  const localImport = new LocalImportService({
    repository,
    bus,
    control,
    files,
    ingest,
    disk: files,
    settings: instanceSettings,
    heavy,
    ...(grants === undefined ? {} : { grants }),
    ...(quota === undefined ? {} : { quota }),
  });
  const mediaAssets = new MediaAssetService({ repository, media, gate, locks: cachePaths, ...(grants === undefined ? {} : { grants }) });
  const ytDlp = new YtDlp({ runner, binDir: config.binDir, dataDir: config.dataDir, env: childProcessEnv(config.env) });
  // Server mode applies the outbound network policy to every hop: private and reserved
  // address ranges are refused unless an administrator allowlisted the exact origin, the
  // connection goes to the address that was checked, and every redirect is checked again.
  // It reads the allowlist on each request so an administrator's change applies at once;
  // local mode keeps the same redirect semantics without address checks.
  const http =
    config.mode === "server"
      ? new PolicyOutboundHttpClient({
          mode: "strict",
          allowlist: () => new Set(repository.withTransaction((scope) => scope.networkAllowlist.list().map((entry) => entry.origin))),
        })
      : new PolicyOutboundHttpClient({ mode: "permissive" });
  const targets = config.mode === "server" ? { targets: http } : {};
  const platforms = new PlatformRegistry([new BilibiliAdapter({ ytDlp, http }), new YoutubeAdapter({ ytDlp, http })]);
  const platformAccounts = new PlatformAccountService({ repository, secrets, platforms });
  const platformAccess: PlatformAccess = {
    adapterFor: (kind) => platforms.adapterFor(kind),
    credentialFor: (owner, platform) => platformAccounts.credentialFor(owner, platform),
    markExpired: (owner, platform) => platformAccounts.markExpired(owner, platform),
  };
  // QR code login is the server's way in; the desktop client has its login window.
  const platformQrLogin =
    config.mode === "server" ? new PlatformQrLoginService({ logins: [new BilibiliQrLogin({ http })], accounts: platformAccounts }) : undefined;
  const importContent = new ImportContentService({
    repository,
    bus,
    control,
    platforms,
    credentials: platformAccounts,
    disk: files,
    settings: instanceSettings,
    heavy,
  });
  const contents = new ContentService({
    repository,
    ...(config.mode === "local"
      ? { localPaths: { pathOf: (ref: string) => media.cache.pathOf(ref), isFile: isExistingFile, cacheAvailable: () => media.cache.isAvailableSync() } }
      : {}),
  });
  // One adapter per `AsrProviderProfile.provider`; a new provider adds an entry here.
  const asrFactories = new Map<AsrProviderId, AsrProviderFactory>(
    [new ElevenLabsAsrProviderFactory({ http, files, secrets }), new DashscopeAsrProviderFactory({ http, files, secrets })].map((factory) => [
      factory.descriptor.provider,
      factory,
    ]),
  );
  const asrFactoryFor = (provider: AsrProviderId): AsrProviderFactory | undefined => asrFactories.get(provider);
  const asrProfiles = new AsrProfileService({ repository, secrets, factories: asrFactories, files, ...targets });
  // One adapter per `ProviderProfile.protocol`; the gateway picks by protocol.
  const llmGateway = new LlmGateway({
    repository,
    secrets,
    providers: [new OpenAiCompatibleProvider({ http, secrets, files }), new AnthropicMessagesProvider({ http, secrets })],
    logger: lateLogger(() => appLogger?.child({ component: "llm_gateway" })),
  });
  const providers = new ProviderService({
    repository,
    secrets,
    prober: llmGateway,
    onChanged: (profileId, modelIds) => llmGateway.profileChanged(profileId, modelIds),
    ...targets,
  });
  const otherModels = new OtherModelService({ repository });
  const terminology = new TerminologyService({ repository });
  const settings = new SettingsService({ repository });
  const usage = new UsageService({ repository });
  const retranscribe = new RetranscribeService({ repository, bus, control, disk: files, settings: instanceSettings });
  const derivedTasks = new DerivedTaskService({ repository, bus, control, disk: files, settings: instanceSettings });
  const transcripts = new TranscriptService({ repository });
  const chapters = new ChapterService({ repository });
  const highlights = new HighlightService({ repository });
  const translations = new TranslationService({ repository });
  const exports = new ExportService({ repository, version: packageJson.version });
  const clientMedia =
    config.mode === "local"
      ? new ClientMediaTaskService({
          repository,
          bus,
          control,
          disk: files,
          cache: media.cache,
          cacheFileExists: (ref) => statSync(media.cache.pathOf(ref), { throwIfNoEntry: false }) !== undefined,
          sameVolume: cacheSharesDataVolume,
          ledger: cacheLedger,
          holds: cacheHoldRegistry,
          recoverSwaps: recoverCacheSwaps,
          platforms: platformAccess,
          heavy,
          settings: instanceSettings,
          media,
          muxer,
        })
      : undefined;
  const relink = grants === undefined ? undefined : new RelinkService({ repository, ingest, grants, heavy });
  const summaryTemplates = new SummaryTemplateService({ repository });
  const summaries = new SummaryService({ repository, bus, control, disk: files, settings: instanceSettings });
  const collections = new CollectionService({ repository, bus, control, disk: files, settings: instanceSettings, importContent });
  const chat = new ChatService({ repository, llm: llmGateway, logger: lateLogger(() => appLogger?.child({ component: "chat" })) });
  // Before any request can start a new answer.
  chat.recoverInterrupted();
  const deleteContent = new DeleteContentService({ repository, gate, fileDeleter, chat });
  const trash = new TrashService({ repository, deleteContent, fileDeleter, chat, logger: lateLogger(() => appLogger?.child({ component: "trash" })) });
  lateTrash = trash;
  // Local mode only: interrupted cache replacements waiting for the user.
  const cacheHolds =
    grants === undefined
      ? undefined
      : new CacheHoldService({
          repository,
          cache: media.cache,
          holds: cacheHoldRegistry,
          locks: cachePaths,
          gate,
          logger: lateLogger(() => appLogger?.child({ component: "cache_holds" })),
        });
  // Local mode only: the video cache location and its move.
  cacheRoot =
    grants === undefined
      ? undefined
      : new CacheRootService({
          repository,
          settings: instanceSettings,
          media,
          gate,
          grants,
          dataDir: layout.root,
          storeFactory: (dir, options) => new FlatCacheFileStore(dir, options),
          fileDeleter,
          ...(cacheHolds === undefined ? {} : { holds: () => cacheHolds.list() }),
          logger: lateLogger(() => appLogger?.child({ component: "cache_root" })),
        });
  const search = new SearchService({ repository });
  const notes = new NoteService({ repository });
  // Local mode only: the client backup and the maintenance state before an update install.
  let backgroundReady = false;
  const backupStore = grants === undefined ? undefined : new SqliteBackupStore({ db, file: layout.database });
  const backupExport =
    grants === undefined || backupStore === undefined
      ? undefined
      : new BackupExportService({
          repository,
          store: backupStore,
          writer: new TarBackupArchiveWriter(),
          grants,
          gate,
          cache: media.cache,
          chat,
          backgroundReady: () => backgroundReady,
          exportDir: join(layout.root, "tmp", "export"),
          version: packageJson.version,
          logger: lateLogger(() => appLogger?.child({ component: "backup_export" })),
        });
  const maintenance =
    backupExport === undefined
      ? undefined
      : new Maintenance({
          gate,
          unfinishedTasks: () => repository.withTransaction((scope) => scope.tasks.listUnfinished().length),
          chatInflight: () => chat.hasAnyInflight(),
          backupExportActive: () => backupExport.active(),
        });
  const backup =
    backupExport === undefined || backupStore === undefined
      ? undefined
      : { backupExport, restoreReadiness: new RestoreReadinessService({ repository, store: backupStore }) };
  // Revocations are shared by the AuthAdapter, SSE streams and the administration.
  const revocations = new SessionRevocations();
  const hasher = new Argon2PasswordHasher();
  const adminControl: AdminTaskControl = {
    ...control,
    settleTasks: (taskIds) => scheduler?.settleTasks(taskIds) ?? Promise.resolve(),
    isExecuting: (taskId) => scheduler?.isExecuting(taskId) ?? false,
  };
  let auth: AuthAdapter;
  let serverAuth: ServerAuthDeps | undefined;
  let setupToken: SetupToken | undefined;
  if (config.mode === "server") {
    // An instance without any login credential takes its first administrator from the
    // environment, or else opens the wizard behind a fresh setup token.
    const bootstrap = await ensureAdminBootstrap({ repository, hasher, env: config.env });
    startupLog("admin_bootstrap", { outcome: bootstrap });
    setupToken = bootstrap === "setup_required" ? new SetupToken() : undefined;
    auth = new ServerAuthAdapter({ repository, revocations });
    serverAuth = {
      service: new AuthService({ repository, hasher, revocations, ...(setupToken === undefined ? {} : { setupToken }) }),
      publicOrigin: config.publicOrigin,
      trustedProxyCidrs: config.trustedProxyCidrs,
    };
  } else {
    auth = new LocalAuthAdapter(config.token);
  }
  const admin = new AdminService({
    repository,
    bus,
    control: adminControl,
    chat,
    hasher,
    revocations,
    files,
    fileDeleter,
    // Local mode: the desktop shell rotates the key in Credential Manager after the reset.
    rotation:
      config.mode === "server"
        ? new ServerMasterKeyRotation({ keyMode: keyModeOf(config.env), secretsDir: layout.secrets, store: secrets })
        : LOCAL_MASTER_KEY_ROTATION,
    logger: lateLogger(() => appLogger?.child({ component: "admin" })),
  });
  const { app, logger, routes } = await buildApp({
    mode: config.mode,
    auth,
    ...(serverAuth === undefined ? {} : { serverAuth }),
    admin,
    bus,
    tasks,
    instanceSettings,
    settings,
    importContent,
    contents,
    trash,
    platformAccounts,
    ...(platformQrLogin === undefined ? {} : { platformQrLogin }),
    asrProfiles,
    providers,
    otherModels,
    terminology,
    usage,
    retranscribe,
    derivedTasks,
    transcripts,
    chapters,
    highlights,
    translations,
    exports,
    subtitleFont,
    summaryTemplates,
    summaries,
    collections,
    search,
    chat,
    notes,
    localImport,
    media: mediaAssets,
    ...(clientMedia === undefined ? {} : { clientMedia }),
    ...(relink === undefined ? {} : { relink }),
    ...(cacheRoot === undefined ? {} : { cacheRoot }),
    ...(cacheHolds === undefined ? {} : { cacheHolds }),
    ...(quota === undefined ? {} : { storageQuota: quota }),
    ...(maintenance === undefined ? {} : { maintenance }),
    ...(backup === undefined ? {} : { backup }),
    version: packageJson.version,
    log: { level: config.logLevel, destination: config.logDestination },
    ...(config.mode === "local" ? { corsOrigin: TAURI_ORIGIN } : { webRoot: config.webRoot ?? defaultWebRoot() }),
  });
  appLogger = logger;
  // Platform caches and burned videos exist only on the desktop client.
  const clientExecutors =
    config.mode !== "local"
      ? {}
      : {
          cache_media: new CacheMediaStageExecutor({
            repository,
            media,
            platforms: platformAccess,
            ingest,
            muxer,
            settings: instanceSettings,
            sameVolume: cacheSharesDataVolume,
            ledger: cacheLedger,
            locks: cachePaths,
            holds: cacheHoldRegistry,
            recoverSwaps: recoverCacheSwaps,
            logger: logger.child({ component: "cache_media" }),
          }),
          burn: new BurnStageExecutor({
            repository,
            files,
            media,
            burner: new FfmpegVideoBurner({ runner, binDir: config.binDir, fontsDir, env: childProcessEnv(config.env) }),
            subtitles: (owner, contentId, request) => exports.exportContentOf(owner, contentId, request).body,
            muxer,
            styledSubtitles: (owner, contentId, request) => exports.styledAssOf(owner, contentId, request),
            fontDigest: () => subtitleFont.digest(),
          }),
        };
  scheduler = new Scheduler({
    repository,
    secrets,
    bus,
    executors: {
      media: new MediaStageExecutor({ repository, files, ingest, mode: config.mode }),
      source: new SourceStageExecutor({ repository, platforms: platformAccess }),
      subtitle: new SubtitleStageExecutor({ repository, platforms: platformAccess }),
      asr: new AsrStageExecutor({ repository, files, media, ingest, platforms: platformAccess, asr: asrFactoryFor }),
      proofread: new ProofreadStageExecutor({ repository, files, media, ingest, platforms: platformAccess }),
      chapter: new ChapterStageExecutor({ repository }),
      highlight: new HighlightStageExecutor({ repository }),
      translate: new TranslateStageExecutor({ repository }),
      summary: new SummaryStageExecutor({ repository }),
      collection_summary: new CollectionSummaryStageExecutor({ repository }),
      ...clientExecutors,
    },
    llm: llmGateway,
    heavy,
    settings: instanceSettings,
    disk: files,
    gate,
    media,
    mode: config.mode,
    logger: logger.child({ component: "scheduler" }),
  });
  const janitor = new AssetJanitor({
    repository,
    media,
    bus,
    logger: logger.child({ component: "asset_janitor" }),
    keepTaskScratch: config.logLevel === "debug",
    pendingRefs: () => fileDeleter.currentPendingRefs(),
    // Platform caches exist only on the desktop client.
    ...(config.mode === "local" ? { swaps: { holds: cacheHoldRegistry, locks: cachePaths }, muxer } : {}),
  });
  lateJanitor = janitor;
  janitor.start();
  let background: Promise<void> | undefined;
  let stopping = false;

  return {
    app,
    logger,
    routes,
    repository,
    ...(setupToken === undefined ? {} : { setupToken: { value: setupToken.value, ttlMinutes: SETUP_TOKEN_TTL_MIN } }),
    startBackground() {
      background = (async () => {
        // Interrupted cache replacements come first: until they are settled, the files at
        // their paths may be the only copies, which nothing after this may move or remove.
        await janitor.recoverSwaps().catch((error: unknown) => startupLog("cache_swap_recovery_failed", { message: String(error) }));
        if (stopping) return;
        // An unfinished cache move is settled next, so the sweep sees a consistent pair of stores.
        await cacheRoot?.recover().catch((error: unknown) => startupLog("cache_root_recovery_failed", { message: String(error) }));
        if (stopping) return;
        // Expired trash goes before the file sweep; the worker removes their files first, so
        // the sweep walks directories that no longer change under it.
        await trash.sweep().catch((error: unknown) => startupLog("trash_sweep_failed", { message: String(error) }));
        await fileDeleter.whenIdle();
        // The sweep finishes before the scheduler runs anything.
        await janitor.sweep().catch((error: unknown) => startupLog("asset_sweep_failed", { message: String(error) }));
        try {
          backupExport?.sweepLeftovers();
        } catch (error) {
          startupLog("backup_export_sweep_failed", { message: String(error) });
        }
        // A stop requested during the sweep must not start work on a closing database.
        if (stopping) return;
        trash.arm();
        search.ensureReady();
        scheduler?.start();
        backgroundReady = true;
      })();
      return background;
    },
    backgroundReady: () => backgroundReady,
    async shutdown() {
      stopping = true;
      // A SIGTERM right after listen can land mid-sweep; the database stays open until it ends.
      await background;
      maintenance?.disarm();
      // A running export reads the database and the cache files; it stops before either closes.
      await backupExport?.close();
      await scheduler?.stop();
      // Neither the trash timer nor the file worker may write once the database is closed.
      await trash.stop();
      await fileDeleter.stop();
      // A copy still running is rolled back before the database closes under it.
      await cacheRoot?.close();
      await app.close();
      db.close();
    },
  };
}

/** Whether `path` names an existing regular file; any error reads as "not there". */
function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where the server's master key comes from: one supplied by `AMBER_SECRET_KEY` is
 * `external_env`, and "reset all credentials" keeps using it; otherwise it is
 * `managed_persistent` in `<data dir>/secrets/master.key`, and a reset replaces that file.
 */
function keyModeOf(env: NodeJS.ProcessEnv): "external_env" | "managed_persistent" {
  const fromEnv = env[MASTER_KEY_ENV];
  return fromEnv === undefined || fromEnv === "" ? "managed_persistent" : "external_env";
}

/** A Logger that forwards to one resolved later; calls before that are dropped. */
function lateLogger(resolve: () => Logger | undefined): Logger {
  return {
    debug: (message, fields) => resolve()?.debug(message, fields),
    info: (message, fields) => resolve()?.info(message, fields),
    warn: (message, fields) => resolve()?.warn(message, fields),
    error: (message, fields) => resolve()?.error(message, fields),
    child: (bindings) => lateLogger(() => resolve()?.child(bindings)),
  };
}

// Process configuration from the environment variables.


const TOKEN_MIN_LENGTH = 32;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function readConfig(env: NodeJS.ProcessEnv): ComposeConfig {
  const mode = env["AMBER_MODE"];
  if (mode !== "local" && mode !== "server") {
    throw new Error(`unsupported AMBER_MODE: ${mode === undefined ? "(unset)" : JSON.stringify(mode)}`);
  }
  const dataDir = env["AMBER_DATA_DIR"];
  const binDir = env["AMBER_BIN_DIR"];
  if (!dataDir || !binDir) {
    throw new Error("AMBER_DATA_DIR and AMBER_BIN_DIR are required");
  }
  const logLevel = env["AMBER_LOG_LEVEL"] ?? "info";
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new Error(`AMBER_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }
  const common = { dataDir, binDir, logLevel: logLevel as LogLevel, logDestination: process.stderr, env };
  if (mode === "local") {
    const token = env["AMBER_SIDECAR_TOKEN"] ?? "";
    if (token.length < TOKEN_MIN_LENGTH) {
      throw new Error(`AMBER_SIDECAR_TOKEN must be at least ${TOKEN_MIN_LENGTH} characters`);
    }
    return { ...common, mode, token, fileGrantKey: parseFileGrantKey(env[FILE_GRANT_KEY_ENV]) } satisfies LocalConfig;
  }
  return {
    ...common,
    mode,
    publicOrigin: parsePublicOrigin(env["AMBER_PUBLIC_ORIGIN"]),
    trustedProxyCidrs: (env["AMBER_TRUSTED_PROXY_CIDRS"] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
  } satisfies ServerConfig;
}

/**
 * `AMBER_PUBLIC_ORIGIN`: `https://host[:port]`, or `http://` only for a
 * loopback host so a local check still runs in a secure context. Returned as an origin.
 */
export function parsePublicOrigin(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("AMBER_PUBLIC_ORIGIN is required in server mode");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AMBER_PUBLIC_ORIGIN must be an origin such as https://amber.example.com");
  }
  const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!bare || !secure || value.replace(/\/$/u, "") !== url.origin) {
    throw new Error("AMBER_PUBLIC_ORIGIN must be https://host[:port] (http:// only for 127.0.0.1 or localhost), without a path");
  }
  return url.origin;
}

/**
 * Server mode is for development and testing: it listens on loopback
 * unless `AMBER_HOST` asks for another interface.
 */
export function listenAddress(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const host = env["AMBER_HOST"] || "127.0.0.1";
  const portText = env["AMBER_PORT"];
  const port = portText === undefined || portText === "" ? SERVER_PORT_DEFAULT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AMBER_PORT must be a TCP port number");
  }
  return { host, port };
}
