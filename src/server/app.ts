import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import type { RunMode } from "../shared/enums.ts";
import { createLogger, httpLoggerOptions } from "./adapters/logger/index.ts";
import type { AdminService } from "./application/admin.ts";
import type { AsrProfileService } from "./application/asr-profile.ts";
import type { AuthService } from "./application/auth.ts";
import type { CacheHoldService } from "./application/cache-holds.ts";
import type { CacheRootService } from "./application/cache-root.ts";
import type { ChapterService } from "./application/chapters.ts";
import type { ExportService } from "./application/export.ts";
import type { HighlightService } from "./application/highlights.ts";
import type { TranslationService } from "./application/translations.ts";
import type { ChatService } from "./application/chat.ts";
import type { CollectionService } from "./application/collections.ts";
import type { ClientMediaTaskService } from "./application/client-media-tasks.ts";
import type { ContentService } from "./application/contents.ts";
import type { DerivedTaskService } from "./application/derived-tasks.ts";
import type { ImportContentService } from "./application/import-content.ts";
import type { InstanceSettingsService } from "./application/instance-settings.ts";
import type { LocalImportService } from "./application/local-import.ts";
import type { MediaAssetService } from "./application/media-assets.ts";
import type { NoteService } from "./application/notes.ts";
import type { PlatformAccountService } from "./application/platform-accounts.ts";
import type { PlatformQrLoginService } from "./application/platform-qr-login.ts";
import type { RelinkService } from "./application/relink.ts";
import type { BackupExportService } from "./application/backup-export.ts";
import type { RestoreReadinessService } from "./application/restore-readiness.ts";
import { installMaintenanceGuard, type Maintenance } from "./api/maintenance.ts";
import { registerBackupRoutes } from "./api/routes/backup.ts";
import type { OtherModelService } from "./application/other-models.ts";
import type { ProviderService } from "./application/providers.ts";
import type { RetranscribeService } from "./application/retranscribe.ts";
import type { SearchService } from "./application/search.ts";
import type { SettingsService } from "./application/settings.ts";
import type { StorageQuota } from "./application/storage-quota.ts";
import type { SummaryService } from "./application/summaries.ts";
import type { SummaryTemplateService } from "./application/summary-templates.ts";
import type { PromptService } from "./application/prompts.ts";
import type { TaskService } from "./application/tasks.ts";
import type { TerminologyService } from "./application/terminology.ts";
import type { TranscriptService } from "./application/transcripts.ts";
import type { TrashService } from "./application/trash.ts";
import type { UsageService } from "./application/usage.ts";
import type { WebSearchService } from "./application/web-search.ts";
import { installAuthentication } from "./api/auth.ts";
import { ClientIpResolver } from "./api/client-ip.ts";
import { LoginRateLimiter } from "./api/login-rate-limit.ts";
import { sessionIdOfRequest, setSessionCookie } from "./api/session-cookie.ts";
import { registerAuthRoutes } from "./api/routes/auth.ts";
import { registerSetupRoutes } from "./api/routes/setup.ts";
import { installErrorHandling } from "./api/errors.ts";
import { installSecurityHeaders, registerWebHosting, spaFallback } from "./api/web-hosting.ts";
import { registerAdminRoutes } from "./api/routes/admin.ts";
import { registerAsrProfileRoutes } from "./api/routes/asr-profiles.ts";
import { registerChapterRoutes } from "./api/routes/chapters.ts";
import { registerExportRoutes } from "./api/routes/export.ts";
import { registerFontRoutes, type BundledSubtitleFont } from "./api/routes/fonts.ts";
import { registerHighlightRoutes } from "./api/routes/highlights.ts";
import { registerTranslationRoutes } from "./api/routes/translations.ts";
import { registerChatRoutes } from "./api/routes/chat.ts";
import { registerClientMediaRoutes } from "./api/routes/client-media.ts";
import { registerCollectionRoutes } from "./api/routes/collections.ts";
import { registerContentRoutes, registerLocalFileRoute, registerUploadRoute } from "./api/routes/contents.ts";
import { registerInstanceSettingsRoutes } from "./api/routes/instance-settings.ts";
import { registerMediaDeleteRoute, registerMediaPlaybackRoutes } from "./api/routes/media.ts";
import { registerNoteRoutes } from "./api/routes/notes.ts";
import { registerOtherModelRoutes } from "./api/routes/other-models.ts";
import { registerPlatformAccountRoutes } from "./api/routes/platform-accounts.ts";
import { registerProviderRoutes } from "./api/routes/providers.ts";
import { registerSearchRoutes } from "./api/routes/search.ts";
import { registerSettingsRoutes } from "./api/routes/settings.ts";
import { registerSummaryRoutes } from "./api/routes/summaries.ts";
import { registerSummaryTemplateRoutes } from "./api/routes/summary-templates.ts";
import { registerPromptRoutes } from "./api/routes/prompts.ts";
import { registerSystemRoutes } from "./api/routes/system.ts";
import { registerTaskRoutes } from "./api/routes/tasks.ts";
import { registerTerminologyRoutes } from "./api/routes/terminology.ts";
import { registerTranscriptRoutes } from "./api/routes/transcripts.ts";
import { registerTrashRoutes } from "./api/routes/trash.ts";
import { registerStorageRoutes } from "./api/routes/storage.ts";
import { registerUsageRoutes } from "./api/routes/usage.ts";
import { registerWebSearchRoutes } from "./api/routes/web-search.ts";
import type { TaskEventBus } from "./pipeline/events.ts";
import type { AuthAdapter } from "./ports/auth-adapter.ts";
import type { Logger } from "./ports/logger.ts";

export interface AppLogOptions {
  level: string;
  /** Structured JSON lines; stderr for the sidecar, whose stdout carries only READY. */
  destination: { write(line: string): void };
}

/**
 * Server-mode login and request security: sessions and CSRF checks. Without it the
 * `[server]` auth and setup routes are not registered and no CSRF checks run.
 */
export interface ServerAuthDeps {
  service: AuthService;
  /** `AMBER_PUBLIC_ORIGIN`: Origin / Referer must match it exactly. */
  publicOrigin: string;
  /** `AMBER_TRUSTED_PROXY_CIDRS`: peers whose rightmost `X-Forwarded-For` hop is believed. */
  trustedProxyCidrs?: readonly string[];
  /** In-process login throttling; a fresh one by default. */
  loginLimiter?: LoginRateLimiter;
}

export interface AppDeps {
  /** `[server]` routes exist only in server mode and `[client]` routes only in local mode. */
  mode: RunMode;
  auth: AuthAdapter;
  /** Server mode: sessions, login, setup and CSRF. */
  serverAuth?: ServerAuthDeps;
  /** `/api/admin/*`; only credential reset exists in local mode. */
  admin?: AdminService;
  /** Server mode: the built SPA, served with deep-link fallback and without authentication. */
  webRoot?: string;
  bus: TaskEventBus;
  tasks: TaskService;
  instanceSettings: InstanceSettingsService;
  /** Per-user preferences, `/api/settings`. */
  settings?: SettingsService;
  /** Link import and inspect exist only when a platform-aware import service is composed in. */
  importContent?: ImportContentService;
  contents?: ContentService;
  /** The content trash: `DELETE /api/contents/:id` and `/api/trash*`. */
  trash?: TrashService;
  platformAccounts?: PlatformAccountService;
  /** Server mode only: QR code login. */
  platformQrLogin?: PlatformQrLoginService;
  asrProfiles?: AsrProfileService;
  providers?: ProviderService;
  /** The register of models Amber does not call, `/api/other-models*`. */
  otherModels?: OtherModelService;
  terminology?: TerminologyService;
  usage?: UsageService;
  retranscribe?: RetranscribeService;
  transcripts?: TranscriptService;
  chapters?: ChapterService;
  highlights?: HighlightService;
  translations?: TranslationService;
  /** Synchronous file export of Contents and Collections. */
  exports?: ExportService;
  /** The bundled subtitle font, `GET /api/fonts/subtitle` (both modes). */
  subtitleFont?: BundledSubtitleFont;
  summaryTemplates?: SummaryTemplateService;
  /** The customizable system prompts (both modes). */
  prompts?: PromptService;
  summaries?: SummaryService;
  collections?: CollectionService;
  search?: SearchService;
  chat?: ChatService;
  /** The caller's web search service, `/api/web-search*`. */
  webSearch?: WebSearchService;
  /** Notes on transcript text. */
  notes?: NoteService;
  /** "Proofread again", "regenerate chapters", "recompute highlights" and "translate". */
  derivedTasks?: DerivedTaskService;
  /** Upload [server] or local-file [client] import. */
  localImport?: LocalImportService;
  /** Server mode: `GET /api/storage`. */
  storageQuota?: StorageQuota;
  media?: MediaAssetService;
  /** Local mode: the `[client]` cache-media and burn Tasks. */
  clientMedia?: ClientMediaTaskService;
  /** Local mode: relinking a moved local file. */
  relink?: RelinkService;
  /** Local mode: the video cache location and its move. */
  cacheRoot?: CacheRootService;
  /** Local mode: interrupted cache replacements waiting for the user. */
  cacheHolds?: CacheHoldService;
  /** Local mode: the maintenance state before an update install and the activity summary. */
  maintenance?: Maintenance;
  /** Local mode: backup export and restore readiness. */
  backup?: { backupExport: BackupExportService; restoreReadiness: RestoreReadinessService };
  version: string;
  log: AppLogOptions | false;
  /** The only browser origin allowed by CORS (the desktop WebView in local mode). */
  corsOrigin?: string;
  /** Additional routes registered after the API routes. */
  extraRoutes?: (app: FastifyInstance) => void;
}

/** One explicitly registered route; framework-generated HEAD twins of GET routes are left out. */
export interface RegisteredRoute {
  method: string;
  url: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  /** Every explicitly registered route, so tests can reconcile them against the API route list. */
  routes: readonly RegisteredRoute[];
  /** The Logger port over the app's redacting logger, for the rest of the composition. */
  logger: Logger;
}

/**
 * The HTTP application: authentication before routing, runtime validation, the uniform
 * `{ error: AppError }` body, and the `/api` routes, the only business entry point. It holds
 * no state of its own; services are injected by the composition root.
 */
export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const app = Fastify({
    logger: deps.log === false ? false : httpLoggerOptions(deps.log),
    // Open SSE streams must not keep a closing server alive.
    forceCloseConnections: true,
  });
  const logger = createLogger(app.log);
  const routes = recordRoutes(app);
  // JSON endpoints accept JSON only: a simple text/plain body is a cross-site form vector.
  app.removeContentTypeParser("text/plain");
  if (deps.corsOrigin !== undefined) {
    await app.register(cors, {
      origin: deps.corsOrigin,
      credentials: false,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      // Export responses name their file; the WebView reads it like a browser download would.
      exposedHeaders: ["Content-Disposition"],
    });
  }
  if (deps.mode === "server") {
    // Before authentication, so rejections carry the headers too.
    installSecurityHeaders(app);
  }
  const serverAuth = deps.mode === "server" ? deps.serverAuth : undefined;
  if (serverAuth !== undefined) {
    // Unsigned: the session id is an opaque random value checked against the database.
    await app.register(cookie);
  }
  installAuthentication(
    app,
    deps.auth,
    serverAuth === undefined
      ? { mode: "local" }
      : {
          mode: "server",
          publicOrigin: serverAuth.publicOrigin,
          renewCookie: (request, reply, renewedUntil) => {
            const sessionId = sessionIdOfRequest(request);
            if (sessionId !== undefined) {
              setSessionCookie(reply, sessionId, renewedUntil);
            }
          },
        },
  );
  // `[client]` only; after authentication, so a refused caller still learns nothing.
  const maintenance = deps.mode === "local" ? deps.maintenance : undefined;
  if (maintenance !== undefined) {
    installMaintenanceGuard(app, maintenance);
  }
  const webRoot = deps.mode === "server" ? deps.webRoot : undefined;
  installErrorHandling(app, logger, webRoot === undefined ? {} : { notFoundFallback: spaFallback });

  registerSystemRoutes(app, {
    version: deps.version,
    mode: deps.mode,
    ...(serverAuth === undefined ? {} : { describe: (principal) => serverAuth.service.me(principal) }),
    ...(maintenance === undefined ? {} : { maintenance }),
  });
  registerAuthRoutes(app, {
    mode: deps.mode,
    ...(serverAuth === undefined
      ? {}
      : {
          server: {
            auth: serverAuth.service,
            limiter: serverAuth.loginLimiter ?? new LoginRateLimiter(),
            clientIp: new ClientIpResolver(serverAuth.trustedProxyCidrs),
          },
        }),
  });
  if (serverAuth !== undefined) {
    registerSetupRoutes(app, { auth: serverAuth.service });
  }
  registerTaskRoutes(app, { tasks: deps.tasks, bus: deps.bus });
  registerInstanceSettingsRoutes(app, { instanceSettings: deps.instanceSettings });
  if (deps.settings !== undefined) {
    registerSettingsRoutes(app, { settings: deps.settings });
  }
  registerContentRoutes(app, {
    ...(deps.importContent === undefined ? {} : { importContent: deps.importContent }),
    ...(deps.contents === undefined ? {} : { contents: deps.contents }),
    ...(deps.trash === undefined ? {} : { trash: deps.trash }),
    ...(deps.retranscribe === undefined ? {} : { retranscribe: deps.retranscribe }),
  });
  registerTranscriptRoutes(app, {
    ...(deps.transcripts === undefined ? {} : { transcripts: deps.transcripts }),
    ...(deps.derivedTasks === undefined ? {} : { derivedTasks: deps.derivedTasks }),
  });
  registerChapterRoutes(app, {
    ...(deps.chapters === undefined ? {} : { chapters: deps.chapters }),
    ...(deps.derivedTasks === undefined ? {} : { derivedTasks: deps.derivedTasks }),
  });
  registerHighlightRoutes(app, {
    ...(deps.highlights === undefined ? {} : { highlights: deps.highlights }),
    ...(deps.derivedTasks === undefined ? {} : { derivedTasks: deps.derivedTasks }),
  });
  registerTranslationRoutes(app, {
    ...(deps.translations === undefined ? {} : { translations: deps.translations }),
    ...(deps.derivedTasks === undefined ? {} : { derivedTasks: deps.derivedTasks }),
  });
  if (deps.trash !== undefined) {
    registerTrashRoutes(app, { trash: deps.trash });
  }
  if (deps.exports !== undefined) {
    registerExportRoutes(app, { exports: deps.exports });
  }
  if (deps.subtitleFont !== undefined) {
    registerFontRoutes(app, { font: deps.subtitleFont });
  }
  if (deps.summaryTemplates !== undefined) {
    registerSummaryTemplateRoutes(app, { summaryTemplates: deps.summaryTemplates });
  }
  if (deps.prompts !== undefined) {
    registerPromptRoutes(app, { prompts: deps.prompts });
  }
  if (deps.summaries !== undefined) {
    registerSummaryRoutes(app, { summaries: deps.summaries });
  }
  if (deps.collections !== undefined) {
    registerCollectionRoutes(app, { collections: deps.collections });
  }
  if (deps.search !== undefined) {
    registerSearchRoutes(app, { search: deps.search });
  }
  if (deps.chat !== undefined) {
    registerChatRoutes(app, { chat: deps.chat });
  }
  if (deps.webSearch !== undefined) {
    registerWebSearchRoutes(app, { webSearch: deps.webSearch });
  }
  if (deps.notes !== undefined) {
    registerNoteRoutes(app, { notes: deps.notes });
  }
  if (deps.asrProfiles !== undefined) {
    registerAsrProfileRoutes(app, { asrProfiles: deps.asrProfiles });
  }
  if (deps.providers !== undefined) {
    registerProviderRoutes(app, { providers: deps.providers });
  }
  if (deps.otherModels !== undefined) {
    registerOtherModelRoutes(app, { otherModels: deps.otherModels });
  }
  if (deps.terminology !== undefined) {
    registerTerminologyRoutes(app, { terminology: deps.terminology });
  }
  if (deps.usage !== undefined) {
    registerUsageRoutes(app, { usage: deps.usage });
  }
  if (deps.platformAccounts !== undefined) {
    registerPlatformAccountRoutes(app, {
      platformAccounts: deps.platformAccounts,
      mode: deps.mode,
      ...(deps.platformQrLogin === undefined ? {} : { qrLogin: deps.platformQrLogin }),
    });
  }
  if (deps.localImport !== undefined) {
    if (deps.mode === "server") {
      // Size limits are enforced per part by the upload route itself.
      await app.register(multipart, { throwFileSizeLimit: false });
      registerUploadRoute(app, { localImport: deps.localImport });
    } else {
      registerLocalFileRoute(app, { localImport: deps.localImport });
    }
  }
  if (deps.storageQuota !== undefined) {
    registerStorageRoutes(app, { quota: deps.storageQuota });
  }
  if (deps.media !== undefined) {
    if (deps.mode === "server") {
      registerMediaPlaybackRoutes(app, { media: deps.media });
    }
    registerMediaDeleteRoute(app, { media: deps.media });
    if (deps.mode === "local" && deps.clientMedia !== undefined && deps.relink !== undefined) {
      registerClientMediaRoutes(app, {
        clientMedia: deps.clientMedia,
        media: deps.media,
        relink: deps.relink,
        ...(deps.cacheRoot === undefined ? {} : { cacheRoot: deps.cacheRoot }),
        ...(deps.cacheHolds === undefined ? {} : { cacheHolds: deps.cacheHolds }),
      });
    }
  }
  if (deps.admin !== undefined) {
    registerAdminRoutes(app, { admin: deps.admin, mode: deps.mode });
  }
  if (deps.mode === "local" && deps.backup !== undefined) {
    registerBackupRoutes(app, deps.backup);
  }
  deps.extraRoutes?.(app);
  if (webRoot !== undefined) {
    await registerWebHosting(app, { root: webRoot });
  }
  return { app, logger, routes };
}

/**
 * Records routes as they are added. Fastify adds a HEAD twin right after each GET route that
 * does not opt out of it; such a twin is not an endpoint of its own and is skipped.
 */
function recordRoutes(app: FastifyInstance): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  const headTwins = new Set<string>();
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method === "HEAD" && headTwins.delete(route.url)) {
        continue;
      }
      if (method === "GET" && route.exposeHeadRoute !== false) {
        headTwins.add(route.url);
      }
      routes.push({ method, url: route.url });
    }
  });
  return routes;
}
