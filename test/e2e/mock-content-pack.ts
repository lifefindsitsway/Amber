import type { Page, Request, Route } from "@playwright/test";
import { taskDetailDtoSchema } from "../../src/shared/dto/task.ts";
import type { TaskKind } from "../../src/shared/enums.ts";
import { collectionDetailDtoSchema, collectionListDtoSchema, collectionSummaryDtoSchema, type CollectionDetailDto } from "../../src/shared/dto/collection.ts";
import { contentDetailDtoSchema, contentListDtoSchema, transcriptRevisionListDtoSchema, type ContentDto } from "../../src/shared/dto/content.ts";
import {
  contentPackActiveDtoSchema,
  contentPackExportJobDtoSchema,
  contentPackExportPlanDtoSchema,
  contentPackExportPlanRequestSchema,
  contentPackExportRequestSchema,
  contentPackImportDecisionsSchema,
  contentPackImportJobDtoSchema,
  packContentDiffSchema,
  type ContentPackExportJobDto,
  type ContentPackImportDecisions,
  type ContentPackImportJobDto,
  type ContentPackImportResult,
  type ContentPackPreviewDto,
  type ExportPlanCollection,
  type ExportPlanContent,
  type PackContentDiff,
} from "../../src/shared/dto/content-pack.ts";

/**
 * The content pack routes of the browser smoke. `handleContentPack` sits in the mock
 * backend's dispatch chain and only says that no pack job is running, so every page that
 * looks for one finds none. A spec that exercises packs installs `installContentPackMock`
 * on top: Playwright runs the route registered last first, and whatever this mock does
 * not serve falls through to the mock backend. Jobs advance one step per poll, so the
 * dialogs show their progress before they finish.
 */

export async function handleContentPack(route: Route, request: Request, url: URL): Promise<boolean> {
  if (request.method() === "GET" && url.pathname === "/api/content-packs/active") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(contentPackActiveDtoSchema.parse({})) });
    return true;
  }
  return false;
}

export interface PackScenario {
  /** Library rows; absent = the mock backend's own list. Status and id filters apply. */
  library?: ContentDto[];
  /** Collections with their members; absent = the mock backend's (none). */
  collections?: CollectionDetailDto[];
  /** Contents without any transcript: their revision list is empty. */
  noTranscript?: string[];
  /** The export plan of each Content, by id. */
  plan?: Record<string, ExportPlanContent>;
  planCollections?: ExportPlanCollection[];
  /** What a server-mode download is called. */
  exportFileName?: string;
  /** The preview an import shows. */
  preview?: ContentPackPreviewDto;
  /** Diffs `compare` answers, by target Content. */
  compare?: Record<string, PackContentDiff>;
  /** The import's result for the decisions it got. */
  importResult?: (decisions: ContentPackImportDecisions) => ContentPackImportResult;
  /** A job already running when the page loads (a reload in the middle of an import). */
  runningImport?: ContentPackImportJobDto;
  /** Unfinished tasks that keep Contents out of an export, by id: their Content and kind. */
  tasks?: Record<string, { contentId: string; kind: TaskKind }>;
}

export interface PackMock {
  /** Every pack request with its JSON body (the upload: its file name and size). */
  calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }>;
  /** The decisions of the last commit. */
  decisions(): ContentPackImportDecisions | undefined;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const notFound = (route: Route) => json(route, { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }, 404);

export async function installContentPackMock(page: Page, scenario: PackScenario, options: { mode: "server" | "local" } = { mode: "server" }): Promise<PackMock> {
  const calls: PackMock["calls"] = [];
  let exportJob: ContentPackExportJobDto | undefined;
  let exportPolls = 0;
  let importJob: ContentPackImportJobDto | undefined = scenario.runningImport;
  let importPolls = 0;
  let decisions: ContentPackImportDecisions | undefined;
  let jobCounter = 0;
  const newJobId = (): string => `01J0000000000000000PACKJ${String((jobCounter += 1)).padStart(2, "0")}`;
  const now = Date.now();

  const advanceExport = (): void => {
    if (exportJob === undefined || exportJob.status !== "running") return;
    exportPolls += 1;
    if (exportPolls === 1) {
      exportJob = { ...exportJob, phase: "media", bytesDone: Math.floor(exportJob.bytesTotal / 2) };
      return;
    }
    const fileName = scenario.exportFileName ?? "内容包.amberpack";
    exportJob = {
      ...exportJob,
      status: "succeeded",
      phase: "finalize",
      bytesDone: exportJob.bytesTotal,
      result: {
        fileName,
        sizeBytes: exportJob.bytesTotal,
        contents: 1,
        ...(options.mode === "server" ? { downloadPath: `/api/content-packs/exports/${exportJob.jobId}/file`, expiresAt: Date.now() + 3_600_000 } : {}),
      },
    };
  };

  const advanceImport = (): void => {
    if (importJob === undefined) return;
    importPolls += 1;
    if (importJob.status === "previewing") {
      if (scenario.preview === undefined) throw new Error("the scenario has no preview");
      importJob = { ...importJob, status: "awaiting_decisions", phase: "preview", expiresAt: Date.now() + 3_600_000, preview: scenario.preview };
    } else if (importJob.status === "importing" && importPolls > 1) {
      const result = scenario.importResult?.(decisions ?? { contents: [], collections: [] }) ?? { contents: [], collections: [] };
      const { preview: _preview, ...rest } = importJob;
      importJob = { ...rest, status: "finished", phase: "collections", bytesDone: rest.bytesTotal, result };
    }
  };

  const active = () =>
    contentPackActiveDtoSchema.parse({
      ...(exportJob?.status === "running" ? { exportJobId: exportJob.jobId } : {}),
      ...(importJob !== undefined && ["receiving", "previewing", "awaiting_decisions", "importing"].includes(importJob.status) ? { importJobId: importJob.jobId } : {}),
    });

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = (): unknown => {
      try {
        return request.postDataJSON() as unknown;
      } catch {
        return undefined;
      }
    };

    // Library, collections and empty revision lists, when the scenario names them.
    if (method === "GET" && path === "/api/contents" && scenario.library !== undefined) {
      const status = url.searchParams.get("status");
      const ids = url.searchParams.get("ids")?.split(",");
      const collectionId = url.searchParams.get("collectionId");
      const items = scenario.library.filter(
        (item) => (status === null || item.processingStatus === status) && (ids === undefined || ids.includes(item.id)) && (collectionId === null || item.collections.some((entry) => entry.id === collectionId)),
      );
      return json(route, contentListDtoSchema.parse({ items, total: items.length }));
    }
    if (method === "GET" && scenario.collections !== undefined) {
      if (path === "/api/collections") {
        return json(route, collectionListDtoSchema.parse({ items: scenario.collections.map(({ items: _items, ...collection }) => collection) }));
      }
      const collection = scenario.collections.find((entry) => path === `/api/collections/${entry.id}`);
      if (collection !== undefined) return json(route, collectionDetailDtoSchema.parse(collection));
      if (scenario.collections.some((entry) => path === `/api/collections/${entry.id}/summary`)) return json(route, collectionSummaryDtoSchema.parse({ stale: false }));
    }
    const bare = scenario.noTranscript?.find((id) => path.startsWith(`/api/contents/${id}`));
    if (method === "GET" && bare !== undefined && scenario.library !== undefined) {
      const content = scenario.library.find((item) => item.id === bare);
      if (path === `/api/contents/${bare}` && content !== undefined) return json(route, contentDetailDtoSchema.parse({ ...content, media: [] }));
      if (path === `/api/contents/${bare}/transcript/revisions`) return json(route, transcriptRevisionListDtoSchema.parse({ revisions: [] }));
    }

    const task = method === "GET" ? Object.entries(scenario.tasks ?? {}).find(([id]) => path === `/api/tasks/${id}`) : undefined;
    if (task !== undefined) {
      const [id, { contentId, kind }] = task;
      return json(route, taskDetailDtoSchema.parse({ id, contentId, kind, statusProjection: "running", createdAt: now, stageRuns: [], workUnits: [], eventSeq: 0 }));
    }
    if (!path.startsWith("/api/content-packs")) return route.fallback();
    const isUpload = path === "/api/content-packs/imports/upload";
    calls.push({
      method,
      path,
      ...(isUpload ? { headers: request.headers(), body: { size: request.postDataBuffer()?.byteLength ?? 0 } } : method === "GET" ? {} : { body: body() }),
    });

    if (method === "GET" && path === "/api/content-packs/active") return json(route, active());
    if (method === "POST" && path === "/api/content-packs/export-plan") {
      const { contentIds } = contentPackExportPlanRequestSchema.parse(body());
      const contents = contentIds.flatMap((id) => scenario.plan?.[id] ?? []);
      const collections = (scenario.planCollections ?? [])
        .map((collection) => ({ ...collection, contentIds: collection.contentIds.filter((id) => contentIds.includes(id)) }))
        .filter((collection) => collection.contentIds.length > 0);
      return json(route, contentPackExportPlanDtoSchema.parse({ contents, collections }));
    }
    if (method === "POST" && path === "/api/content-packs/exports") {
      const request = contentPackExportRequestSchema.parse(body());
      if (options.mode === "local" && request.grant === undefined) {
        return json(route, { error: { class: "unauthenticated", code: "unauthenticated.file_grant", retryDisposition: "never", userMessage: "" } }, 401);
      }
      const total = request.selection.contents.reduce((sum, item) => sum + item.mediaAssetIds.length * 1024 * 1024 + 4096, 0);
      exportJob = contentPackExportJobDtoSchema.parse({ jobId: newJobId(), status: "running", phase: "documents", bytesDone: 0, bytesTotal: total });
      exportPolls = 0;
      return json(route, { jobId: exportJob.jobId }, 202);
    }
    if (exportJob !== undefined && path.startsWith(`/api/content-packs/exports/${exportJob.jobId}`)) {
      const tail = path.slice(`/api/content-packs/exports/${exportJob.jobId}`.length);
      if (method === "GET" && tail === "") {
        const shown = exportJob;
        advanceExport();
        return json(route, contentPackExportJobDtoSchema.parse(shown));
      }
      if (method === "POST" && tail === "/cancel") {
        exportJob = { ...exportJob, status: "cancelled" };
        return json(route, contentPackExportJobDtoSchema.parse(exportJob));
      }
      if (method === "GET" && tail === "/file" && exportJob.result !== undefined) {
        return route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exportJob.result.fileName)}` },
          body: "amberpack",
        });
      }
    }

    const startImport = (fileName: string | undefined): Promise<void> => {
      importJob = contentPackImportJobDtoSchema.parse({ jobId: newJobId(), status: "previewing", phase: "preview", bytesDone: 0, bytesTotal: 0, ...(fileName === undefined ? {} : { fileName }) });
      importPolls = 0;
      return json(route, { jobId: importJob.jobId }, 202);
    };
    if (method === "POST" && path === "/api/content-packs/imports/upload") {
      const header = request.headers()["x-amber-filename"];
      return startImport(header === undefined ? undefined : decodeURIComponent(header));
    }
    if (method === "POST" && path === "/api/content-packs/imports") return startImport(undefined);
    if (importJob !== undefined && path.startsWith(`/api/content-packs/imports/${importJob.jobId}`)) {
      const tail = path.slice(`/api/content-packs/imports/${importJob.jobId}`.length);
      if (method === "GET" && tail === "") {
        const shown = importJob;
        advanceImport();
        return json(route, contentPackImportJobDtoSchema.parse(shown));
      }
      if (method === "POST" && tail === "/compare") {
        const { targetContentId } = body() as { targetContentId: string };
        const diff = scenario.compare?.[targetContentId];
        return diff === undefined ? notFound(route) : json(route, packContentDiffSchema.parse(diff));
      }
      if (method === "POST" && tail === "/commit") {
        const sent = contentPackImportDecisionsSchema.parse(body());
        // As the server: one local Content takes at most one carried Content per import.
        const targets = sent.contents.flatMap((decision) => (decision.action === "merge" && decision.targetContentId !== undefined ? [decision.targetContentId] : []));
        if (new Set(targets).size !== targets.length) {
          return json(route, { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "", details: { detail: "targetContentId" } } }, 400);
        }
        decisions = sent;
        const { expiresAt: _expires, ...rest } = importJob;
        importJob = { ...rest, status: "importing", phase: "read", bytesDone: 0, bytesTotal: scenario.preview?.pack.sizeBytes ?? 1 };
        importPolls = 0;
        return json(route, contentPackImportJobDtoSchema.parse(importJob), 202);
      }
      if (method === "POST" && tail === "/retry-collections" && importJob.result !== undefined) {
        importJob = {
          ...importJob,
          result: {
            ...importJob.result,
            collections: importJob.result.collections.map((item) => (item.status === "failed" ? { key: item.key, name: item.name, status: "created" as const, collectionId: `col-${item.key}`, added: 2 } : item)),
          },
        };
        return json(route, contentPackImportJobDtoSchema.parse(importJob), 202);
      }
      if (method === "POST" && tail === "/cancel") {
        importJob = { ...importJob, status: "cancelled" };
        return json(route, contentPackImportJobDtoSchema.parse(importJob));
      }
      if (method === "DELETE" && tail === "") {
        importJob = undefined;
        return route.fulfill({ status: 204 });
      }
    }
    return notFound(route);
  });

  return { calls, decisions: () => decisions };
}

/**
 * Makes the page believe it runs in the desktop client: `isTauri`, the sidecar endpoint at
 * the page's own origin (the mock backend answers it) and the three pack dialogs, which
 * hand back the paths given here with a test grant. Any other shell command answers null.
 */
export async function installFakeDesktopShell(page: Page, picks: { destination?: string; source?: string; originalsParent?: string }): Promise<void> {
  await page.addInitScript((given) => {
    let callback = 0;
    const grant = (path: string, purpose: string) => ({ path, grant: { path, purpose, expiresAt: Date.now() + 300_000, sig: "e2e-signature" } });
    const shell = window as unknown as Record<string, unknown>;
    shell["isTauri"] = true;
    shell["__AMBER_E2E_SHELL_CALLS__"] = [];
    shell["__TAURI_INTERNALS__"] = {
      transformCallback: () => (callback += 1),
      unregisterCallback: () => undefined,
      convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        (shell["__AMBER_E2E_SHELL_CALLS__"] as unknown[]).push({ command, args });
        switch (command) {
          case "sidecar_endpoint":
            return { endpoint: window.location.origin, token: "e2e-token" };
          case "pick_pack_destination":
            return given.destination === undefined ? null : grant(given.destination, "pack_output");
          case "pick_pack_source":
            return given.source === undefined ? null : grant(given.source, "pack_input");
          case "pick_pack_originals_dir":
            return given.originalsParent === undefined ? null : grant(`${given.originalsParent}/Amber-Imported-${String(args["localStamp"])}`, "pack_originals_dir");
          case "plugin:event|listen":
            return (callback += 1);
          default:
            return null;
        }
      },
    };
  }, picks);
}
