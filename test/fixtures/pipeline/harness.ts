import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { LocalAuthAdapter } from "../../../src/server/adapters/auth/local/index.ts";
import { AesGcmSecretStore } from "../../../src/server/adapters/secret-store/aes-gcm-secret-store.ts";
import { openDatabase, type SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { sqliteSecretEnvelopeStore } from "../../../src/server/adapters/sqlite/repositories/secret-envelopes.ts";
import { buildApp, type AppDeps, type BuiltApp } from "../../../src/server/app.ts";
import { ensureLocalUser } from "../../../src/server/application/ensure-local-user.ts";
import { ChapterService } from "../../../src/server/application/chapters.ts";
import { ChatService } from "../../../src/server/application/chat.ts";
import { NoteService } from "../../../src/server/application/notes.ts";
import { ExportService } from "../../../src/server/application/export.ts";
import { HighlightService } from "../../../src/server/application/highlights.ts";
import { TranslationService } from "../../../src/server/application/translations.ts";
import { CollectionService } from "../../../src/server/application/collections.ts";
import { ContentService } from "../../../src/server/application/contents.ts";
import { DeleteContentService } from "../../../src/server/application/delete-content.ts";
import { PendingFileDeleter } from "../../../src/server/application/pending-file-delete.ts";
import { TrashService } from "../../../src/server/application/trash.ts";
import { FlatCacheFileStore } from "../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { DerivedTaskService } from "../../../src/server/application/derived-tasks.ts";
import { ImportContentService } from "../../../src/server/application/import-content.ts";
import { InstanceSettingsService } from "../../../src/server/application/instance-settings.ts";
import { SettingsService } from "../../../src/server/application/settings.ts";
import { LlmGateway } from "../../../src/server/application/llm-gateway.ts";
import { PlatformAccountService } from "../../../src/server/application/platform-accounts.ts";
import { PlatformRegistry } from "../../../src/server/application/platforms.ts";
import { SearchService } from "../../../src/server/application/search.ts";
import { SummaryService } from "../../../src/server/application/summaries.ts";
import { ensureBuiltinSummaryTemplates, SummaryTemplateService } from "../../../src/server/application/summary-templates.ts";
import { PromptService } from "../../../src/server/application/prompts.ts";
import { customizablePrompt, promptIdsOf } from "../../../src/server/domain/prompts.ts";
import { TaskService, type TaskControl } from "../../../src/server/application/tasks.ts";
import { TranscriptService } from "../../../src/server/application/transcripts.ts";
import { canonicalJson } from "../../../src/server/domain/canonical-json.ts";
import type { AsrModelRef, ModelRef, PromptRef } from "../../../src/server/domain/model-ref.ts";
import type { StageRun, Task, WorkUnit } from "../../../src/server/domain/task.ts";
import type { RequestPrincipal } from "../../../src/server/domain/user.ts";
import { CacheGate } from "../../../src/server/pipeline/cache-gate.ts";
import { TaskEventBus } from "../../../src/server/pipeline/events.ts";
import { SplitMediaFiles, type MediaFiles } from "../../../src/server/pipeline/media-files.ts";
import type { StageExecutor, StageExecutors } from "../../../src/server/pipeline/executor.ts";
import { latestAttempts } from "../../../src/server/pipeline/projection.ts";
import { transact } from "../../../src/server/pipeline/publish.ts";
import type { CredentialStatusSource } from "../../../src/server/pipeline/requirements.ts";
import { Scheduler } from "../../../src/server/pipeline/scheduler.ts";
import { createTask } from "../../../src/server/pipeline/task-state.ts";
import type { AuthAdapter } from "../../../src/server/ports/auth-adapter.ts";
import type { FileStore } from "../../../src/server/ports/file-store.ts";
import type { LlmProvider } from "../../../src/server/ports/llm-provider.ts";
import type { Logger } from "../../../src/server/ports/logger.ts";
import type { InstanceSettingsFields } from "../../../src/shared/dto/instance-settings.ts";
import type { StageId, TaskKind } from "../../../src/shared/enums.ts";
import type { PlatformAccess } from "../../../src/server/pipeline/stages/platform-access.ts";
import { insertRow, tempDataDir } from "../../tools/sqlite.ts";
import { FakePlatformAdapter } from "../platform/fake-adapter.ts";

/**
 * A complete in-process task stack on a temporary database: repository, secret store,
 * event bus, scheduler with stub stage executors, the task / import / settings services
 * and, on demand, the HTTP app. Stub executors and the stub platform adapter make no
 * network or paid calls.
 */

export const LOCAL_TOKEN = "local-token-".padEnd(64, "0");
export const BOB_TOKEN = "bob-token-".padEnd(64, "0");
export const LOCAL: RequestPrincipal = { userId: "local", mode: "local", role: "admin", mustChangePassword: false };
export const BOB: RequestPrincipal = { userId: "bob", mode: "local", role: "user", mustChangePassword: false };
const GB = 1024 ** 3;

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** Mutable disk usage; plenty of room unless a test lowers it. */
export class StubDisk {
  usage = { usedBytes: 1 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB };

  async diskUsage() {
    return { ...this.usage };
  }

  low(): void {
    this.usage = { usedBytes: 1 * GB, freeBytes: 1 * GB, totalBytes: 1000 * GB };
  }

  plenty(): void {
    this.usage = { usedBytes: 1 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB };
  }
}

/** An executor that succeeds at once and counts its runs. */
export function countingExecutor(resultJson?: unknown): StageExecutor & { calls: number } {
  const executor = {
    calls: 0,
    async run() {
      executor.calls += 1;
      return resultJson === undefined ? {} : { resultJson };
    },
  };
  return executor;
}

/** Instant-success executors for every stage of the platform `process_content` graph. */
export function platformPipelineExecutors(): Record<StageId, StageExecutor & { calls: number }> {
  const stages: StageId[] = ["source", "subtitle", "asr", "proofread", "chapter", "summary", "media", "highlight", "translate", "collection_summary", "burn", "cache_media"];
  const executors = Object.fromEntries(stages.map((stage) => [stage, countingExecutor()])) as Record<StageId, StageExecutor & { calls: number }>;
  // A valid platform track makes ASR unnecessary.
  executors.subtitle = countingExecutor({ verdict: "valid", reasons: [] });
  return executors;
}

export interface HarnessOptions {
  file?: string;
  executors?: StageExecutors;
  /** Lets the scheduler verify file-backed units on resume. */
  files?: Pick<FileStore, "digest">;
  overrides?: Partial<InstanceSettingsFields>;
  logger?: Logger;
  /** Adapters behind the harness's LlmGateway (none by default). */
  llmProviders?: readonly LlmProvider[];
  /** Random source of the gateway's cooldown spread; defaults to none (0). */
  random?: () => number;
}

export interface Harness {
  dir: string;
  file: string;
  db: SqliteConnection;
  repository: SqliteRepository;
  secrets: AesGcmSecretStore;
  bus: TaskEventBus;
  disk: StubDisk;
  /** The cache gate the scheduler and the media services share; tests take its exclusive lease to stand for a cache move. */
  gate: CacheGate;
  executors: StageExecutors;
  settings: InstanceSettingsService;
  /** Per-user preferences behind `/api/settings`. */
  userSettings: SettingsService;
  /** The LlmGateway handed to the scheduler; retries do not wait. */
  llm: LlmGateway;
  scheduler: Scheduler;
  tasks: TaskService;
  importContent: ImportContentService;
  contents: ContentService;
  /** The data and cache stores on the temp data directory, behind the pending-file worker. */
  media: MediaFiles;
  fileDeleter: PendingFileDeleter;
  deleteContent: DeleteContentService;
  trash: TrashService;
  transcripts: TranscriptService;
  chapters: ChapterService;
  highlights: HighlightService;
  translations: TranslationService;
  exports: ExportService;
  derivedTasks: DerivedTaskService;
  summaryTemplates: SummaryTemplateService;
  prompts: PromptService;
  summaries: SummaryService;
  collections: CollectionService;
  search: SearchService;
  chat: ChatService;
  notes: NoteService;
  platformAccounts: PlatformAccountService;
  /** Scripted platform adapters behind the registry; the real URL parsers decide what they accept. */
  platforms: { bilibili: FakePlatformAdapter; youtube: FakePlatformAdapter };
  platformAccess: PlatformAccess;
  newId: () => string;
  /**
   * The clock shared by the scheduler and the gateway. A wait for a unit's retry time (a
   * backoff or a lane cooldown) does not sleep: the scheduler's wake timer moves this clock
   * forward to the time it waits for. `waits` lists those jumps in milliseconds.
   */
  now: () => number;
  waits: number[];
  /** Queues the scheduler's wake timers instead of firing them, until `releaseWakes`. */
  holdWakes(): void;
  /** Fires the queued wake timers (unless cancelled meanwhile) and lets later ones fire at once again. */
  releaseWakes(): void;
  /** Makes the credential report `unavailable` to requirement checks, like a master key that no longer decrypts it. */
  markCredentialUnavailable(credentialRef: string): void;
  restoreCredential(credentialRef: string): void;
  app(options?: {
    withImport?: boolean;
    log?: { write(line: string): void };
    extraRoutes?: AppDeps["extraRoutes"];
    mode?: AppDeps["mode"];
    localImport?: AppDeps["localImport"];
    media?: AppDeps["media"];
    trash?: AppDeps["trash"];
  }): Promise<BuiltApp>;
  close(): Promise<void>;
}

const masterKeys = new Map<string, Buffer>();

export function createHarness(options: HarnessOptions = {}): Harness {
  const dir = options.file === undefined ? tempDataDir("amber-pipeline-") : join(options.file, "..");
  const file = options.file ?? join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups") });
  const repository = new SqliteRepository(db);
  ensureLocalUser(repository);
  ensureBuiltinSummaryTemplates(repository, 1);
  if (repository.withTransaction((scope) => scope.users.get(BOB.userId)) === undefined) {
    insertRow(db, "user", { id: BOB.userId, role: "user", status: "active", created_at: 1 });
  }
  // The same key across reopenings of one database, like a real master key.
  const masterKey = masterKeys.get(file) ?? randomBytes(32);
  masterKeys.set(file, masterKey);
  const secrets = new AesGcmSecretStore({ masterKey, envelopes: sqliteSecretEnvelopeStore(db) });
  // Requirement checks go through this stub so tests can take a credential away and give it
  // back without touching the secret rows a profile references.
  const unavailableCredentials = new Set<string>();
  const credentialStatus: CredentialStatusSource = {
    status: (owner, ref) => (ref !== undefined && unavailableCredentials.has(ref) ? "unavailable" : secrets.status(owner, ref)),
  };
  const bus = new TaskEventBus();
  const disk = new StubDisk();
  const gate = new CacheGate();
  const executors = options.executors ?? platformPipelineExecutors();
  const logger = options.logger ?? silentLogger;
  const newId = monotonicFactory();

  let scheduler: Scheduler | undefined;
  const control: TaskControl = { kick: () => scheduler?.kick(), abortTask: (id) => scheduler?.abortTask(id) };
  const settings = new InstanceSettingsService({ repository, overrides: options.overrides ?? {}, onChange: () => control.kick() });
  let skew = 0;
  const waits: number[] = [];
  const now = (): number => Date.now() + skew;
  const fire = (ms: number, wake: () => void): (() => void) => {
    const timer = setTimeout(() => {
      waits.push(ms);
      skew += Math.max(0, ms);
      wake();
    }, 0);
    return () => clearTimeout(timer);
  };
  // While held, wake timers queue instead of firing, so a test can observe a unit waiting
  // for its retry time; otherwise the jump happens on the next tick and the wait is a race.
  let held: Array<{ ms: number; wake: () => void; cancel?: () => void; cancelled: boolean }> | undefined;
  const wakeAfter = (ms: number, wake: () => void): (() => void) => {
    if (held === undefined) {
      return fire(ms, wake);
    }
    const entry: { ms: number; wake: () => void; cancel?: () => void; cancelled: boolean } = { ms, wake, cancelled: false };
    held.push(entry);
    return () => {
      entry.cancelled = true;
      entry.cancel?.();
    };
  };
  const llm = new LlmGateway({
    repository,
    secrets: credentialStatus,
    providers: options.llmProviders ?? [],
    newId,
    now,
    random: options.random ?? (() => 0),
    sleep: async () => undefined,
  });
  scheduler = new Scheduler({
    repository,
    secrets: credentialStatus,
    bus,
    executors,
    settings,
    disk,
    gate,
    mode: "local",
    logger,
    llm,
    newId,
    now,
    wakeAfter,
    sleep: async () => undefined,
    ...(options.files === undefined ? {} : { media: { data: options.files, cache: options.files } }),
  });
  const tasks = new TaskService({ repository, bus, control, secrets: credentialStatus, newId });
  const platforms = { bilibili: new FakePlatformAdapter("bilibili"), youtube: new FakePlatformAdapter("youtube") };
  const registry = new PlatformRegistry([platforms.bilibili, platforms.youtube]);
  const platformAccounts = new PlatformAccountService({ repository, secrets, platforms: registry, newId });
  const platformAccess: PlatformAccess = {
    adapterFor: (kind) => registry.adapterFor(kind),
    credentialFor: (owner, platform) => platformAccounts.credentialFor(owner, platform),
    markExpired: (owner, platform) => platformAccounts.markExpired(owner, platform),
  };
  const importContent = new ImportContentService({ repository, bus, control, platforms: registry, credentials: platformAccounts, disk, settings, newId });
  const contents = new ContentService({ repository, newId });
  const transcripts = new TranscriptService({ repository, newId });
  const chapters = new ChapterService({ repository });
  const highlights = new HighlightService({ repository });
  const translations = new TranslationService({ repository });
  const exports = new ExportService({ repository, version: "0.0.0-test" });
  const derivedTasks = new DerivedTaskService({ repository, bus, control, disk, settings, newId });
  const summaryTemplates = new SummaryTemplateService({ repository, newId });
  const prompts = new PromptService({ repository, now });
  const userSettings = new SettingsService({ repository });
  const summaries = new SummaryService({ repository, bus, control, disk, settings, newId });
  const collections = new CollectionService({ repository, bus, control, disk, settings, importContent, newId });
  const search = new SearchService({ repository });
  const chat = new ChatService({ repository, llm, logger, newId });
  const notes = new NoteService({ repository, newId });
  const media = new SplitMediaFiles(new LocalFileStore(dir), (cacheDir, cacheOptions) => new FlatCacheFileStore(cacheDir, cacheOptions), join(dir, "media"));
  let lateTrash: TrashService | undefined;
  const fileDeleter = new PendingFileDeleter({ repository, media, dataDir: dir, gate, afterDrain: () => lateTrash?.refresh(), logger, newId });
  const deleteContent = new DeleteContentService({ repository, gate, fileDeleter, chat });
  const trashService = new TrashService({ repository, deleteContent, fileDeleter, chat, logger });
  lateTrash = trashService;

  const auth: AuthAdapter = {
    authenticate(request) {
      const local = new LocalAuthAdapter(LOCAL_TOKEN).authenticate(request);
      if (local !== null) {
        return local;
      }
      return request.headers["authorization"] === `Bearer ${BOB_TOKEN}` ? BOB : null;
    },
  };

  const built: BuiltApp[] = [];
  return {
    dir,
    file,
    db,
    repository,
    secrets,
    bus,
    disk,
    gate,
    executors,
    settings,
    userSettings,
    llm,
    scheduler,
    tasks,
    importContent,
    contents,
    media,
    fileDeleter,
    deleteContent,
    trash: trashService,
    transcripts,
    chapters,
    highlights,
    translations,
    exports,
    derivedTasks,
    summaryTemplates,
    prompts,
    summaries,
    collections,
    search,
    chat,
    notes,
    platformAccounts,
    platforms,
    platformAccess,
    newId,
    now,
    waits,
    holdWakes: () => {
      held ??= [];
    },
    releaseWakes: () => {
      const pending = held ?? [];
      held = undefined;
      for (const entry of pending) {
        if (!entry.cancelled) entry.cancel = fire(entry.ms, entry.wake);
      }
    },
    markCredentialUnavailable: (credentialRef) => void unavailableCredentials.add(credentialRef),
    restoreCredential: (credentialRef) => void unavailableCredentials.delete(credentialRef),
    async app(appOptions = {}) {
      const app = await buildApp({
        mode: appOptions.mode ?? "local",
        auth,
        bus,
        tasks,
        instanceSettings: settings,
        settings: userSettings,
        ...(appOptions.withImport === false ? {} : {
              importContent,
              contents,
              trash: appOptions.trash ?? trashService,
              platformAccounts,
              transcripts,
              chapters,
              highlights,
              translations,
              exports,
              derivedTasks,
              summaryTemplates,
              prompts,
              summaries,
              collections,
              search,
              chat,
              notes,
            }),
        version: "0.0.0-test",
        log: appOptions.log === undefined ? false : { level: "info", destination: appOptions.log },
        ...(appOptions.extraRoutes === undefined ? {} : { extraRoutes: appOptions.extraRoutes }),
        ...(appOptions.localImport === undefined ? {} : { localImport: appOptions.localImport }),
        ...(appOptions.media === undefined ? {} : { media: appOptions.media }),
      });
      built.push(app);
      return app;
    },
    async close() {
      await scheduler?.stop();
      await trashService.stop();
      await fileDeleter.stop();
      for (const { app } of built) {
        await app.close();
      }
      db.close();
    },
  };
}

/** A provider profile with one model and a stored (placeholder) credential for `userId`. */
export function configureLlm(harness: Harness, userId = LOCAL.userId): ModelRef {
  const credentialRef = harness.secrets.store(userId, "<placeholder-llm-key>");
  const providerProfileId = harness.newId();
  insertRow(harness.db, "provider_profile", {
    id: providerProfileId,
    user_id: userId,
    name: "relay",
    protocol: "openai_compatible",
    base_url: "https://llm.invalid/v1",
    credential_ref: credentialRef,
    created_at: 1,
  });
  const unknown = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
  insertRow(harness.db, "model_capability", {
    profile_id: providerProfileId,
    model_id: "model-a",
    position: 0,
    flags_declared_json: JSON.stringify(unknown),
    limits_declared_json: "{}",
  });
  return { providerProfileId, modelId: "model-a" };
}

/** The credential reference behind a configured model, for the harness's credential stub. */
export function credentialRefOf(harness: Harness, modelRef: ModelRef): string {
  const row = harness.db.prepare("SELECT credential_ref FROM provider_profile WHERE id = ?").get(modelRef.providerProfileId) as
    | { credential_ref: string | null }
    | undefined;
  if (row?.credential_ref == null) {
    throw new Error(`profile ${modelRef.providerProfileId} has no credential`);
  }
  return row.credential_ref;
}

/** `inputJson` of each stage's latest attempt; absent inputs are `undefined`. */
export function stageInputsOf(harness: Harness, taskId: string, userId = LOCAL.userId): Record<string, string | undefined> {
  return Object.fromEntries(latestAttempts(stageRunsOf(harness, taskId, userId)).map((run) => [run.stage, run.inputJson]));
}

/** A provider profile without any credential. */
export function unconfiguredLlm(harness: Harness, userId = LOCAL.userId): ModelRef {
  const providerProfileId = harness.newId();
  insertRow(harness.db, "provider_profile", {
    id: providerProfileId, user_id: userId, name: "relay", protocol: "openai_compatible", base_url: "https://llm.invalid/v1", created_at: 1,
  });
  insertRow(harness.db, "model_capability", {
    profile_id: providerProfileId, model_id: "model-a", position: 0, flags_declared_json: "{}", limits_declared_json: "{}",
  });
  return { providerProfileId, modelId: "model-a" };
}

/**
 * An ASR profile with a key and its models (`scribe_v2` unless given), returned as the
 * reference to its first model. Unless `asDefault` is false that model also becomes the
 * user's default; submissions are still bound only by the `asrModelRef` they carry.
 */
export function configureAsr(
  harness: Harness,
  userId = LOCAL.userId,
  options: { asDefault?: boolean; name?: string; models?: string[] } = {},
): AsrModelRef {
  const credentialRef = harness.secrets.store(userId, "<placeholder-asr-key>");
  const id = harness.newId();
  const models = options.models ?? ["scribe_v2"];
  insertRow(harness.db, "asr_provider_profile", {
    id, user_id: userId, name: options.name ?? "ElevenLabs", provider: "elevenlabs", models_json: JSON.stringify(models.map((modelId) => ({ modelId }))), credential_ref: credentialRef, created_at: 1,
  });
  const ref: AsrModelRef = { asrProfileId: id, modelId: models[0] as string };
  if (options.asDefault !== false) {
    harness.repository.withTransaction((scope) => {
      const current = scope.userSettings.get(userId);
      scope.userSettings.put({
        ...(current ?? { userId, theme: "light", language: "zh-CN", shortcuts: {} }),
        defaultAsrModelRef: ref,
        updatedAt: Date.now(),
      });
    });
  }
  return ref;
}

/** Polls until `check` holds; the scheduler runs on real timers. */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A promise with its resolver exposed. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A local Content owned by `userId`, created directly (no import route involved). */
export function createLocalContent(harness: Harness, userId = LOCAL.userId): string {
  const id = harness.newId();
  harness.repository.withTransaction((scope) =>
    scope.contents.insert({ id, userId, source: { kind: "local" }, processingStatus: "queued", createdAt: 1, updatedAt: 1 }),
  );
  return id;
}

/** A Task of any kind on a local Content, created the way task-creating services do. */
export function createTaskOfKind(
  harness: Harness,
  kind: TaskKind,
  request: Record<string, unknown>,
  options: { contentId?: string; userId?: string; createdAt?: number } = {},
): string {
  const userId = options.userId ?? LOCAL.userId;
  const contentId = options.contentId ?? createLocalContent(harness, userId);
  return transact(harness.repository, harness.bus, (scope, outbox) =>
    createTask(scope, outbox, {
      task: {
        id: harness.newId(),
        userId,
        contentId,
        kind,
        requestJson: canonicalJson({ requestSchemaVersion: 1, kind, ...request }),
        createdAt: options.createdAt ?? Date.now(),
      },
      sourceKind: "local",
      newId: harness.newId,
    }).id,
  );
}

export function stageRunsOf(harness: Harness, taskId: string, userId = LOCAL.userId): StageRun[] {
  return harness.repository.withTransaction((scope) => scope.stageRuns.listByTask(userId, taskId));
}

export function workUnitsOf(harness: Harness, taskId: string, userId = LOCAL.userId): WorkUnit[] {
  return harness.repository.withTransaction((scope) => scope.workUnits.listByTask(userId, taskId));
}

export function taskOf(harness: Harness, taskId: string, userId = LOCAL.userId): Task {
  const task = harness.repository.withTransaction((scope) => scope.tasks.get(userId, taskId));
  if (task === undefined) {
    throw new Error(`task ${taskId} not found`);
  }
  return task;
}

/** Latest attempt's status per stage. */
export function stageStatuses(harness: Harness, taskId: string): Record<string, string> {
  return Object.fromEntries(latestAttempts(stageRunsOf(harness, taskId)).map((run) => [run.stage, run.status]));
}

/** The prompt versions a Task of `kind` freezes while every prompt is builtin. */
export function builtinPromptRefs(kind: TaskKind): Record<string, PromptRef> {
  return Object.fromEntries(promptIdsOf(kind).map((id) => [id, customizablePrompt(id)?.builtin.ref as PromptRef]));
}
