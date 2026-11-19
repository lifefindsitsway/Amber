import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { z } from "zod";
import { CONTENT_PACK_POLL_MS } from "../../../shared/defaults.ts";
import {
  contentPackActiveDtoSchema,
  contentPackExportJobDtoSchema,
  contentPackExportPlanDtoSchema,
  contentPackImportJobDtoSchema,
  contentPackJobAcceptedDtoSchema,
  packContentDiffSchema,
  type ContentPackActiveDto,
  type ContentPackExportJobDto,
  type ContentPackExportPlanDto,
  type ContentPackImportDecisions,
  type ContentPackImportJobDto,
  type ContentPackSelection,
  type PackContentDiff,
} from "../../../shared/dto/content-pack.ts";
import type { FileGrant } from "../../../shared/dto/local-media.ts";
import { appErrorSchema } from "../../../shared/errors.ts";
import { ApiError, type ApiClient } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";

/**
 * The content pack endpoints and their jobs. Jobs are polled while they run; both run modes
 * use the same calls except where the file comes from and goes to: the desktop client hands
 * the sidecar a signed path, server mode uploads the file as the raw request body and
 * downloads the finished pack through a plain link, so the page never holds a pack.
 */

const BASE = "/api/content-packs";

export const packKeys = {
  all: ["content-packs"] as const,
  active: ["content-packs", "active"] as const,
  plan: (contentIds: readonly string[], collectionId: string | undefined) => ["content-packs", "plan", contentIds.join(","), collectionId ?? ""] as const,
  exportJob: (jobId: string) => ["content-packs", "export", jobId] as const,
  importJob: (jobId: string) => ["content-packs", "import", jobId] as const,
};

const path = (kind: "exports" | "imports", jobId: string, tail = ""): string => `${BASE}/${kind}/${encodeURIComponent(jobId)}${tail}`;

export function fetchExportPlan(client: ApiClient, contentIds: readonly string[], collectionId: string | undefined): Promise<ContentPackExportPlanDto> {
  return client.post(`${BASE}/export-plan`, contentPackExportPlanDtoSchema, { body: { contentIds, ...(collectionId === undefined ? {} : { collectionId }) } });
}

export async function startExport(client: ApiClient, selection: ContentPackSelection, grant: FileGrant | undefined): Promise<string> {
  const answer = await client.post(`${BASE}/exports`, contentPackJobAcceptedDtoSchema, { body: { selection, ...(grant === undefined ? {} : { grant }) } });
  return answer.jobId;
}

export function cancelExport(client: ApiClient, jobId: string): Promise<ContentPackExportJobDto> {
  return client.post(path("exports", jobId, "/cancel"), contentPackExportJobDtoSchema);
}

/** The absolute URL of a finished server-mode pack, for a plain `<a download>`. */
export function downloadUrl(client: ApiClient, downloadPath: string): string {
  return client.url(downloadPath);
}

export async function startImportFromFile(client: ApiClient, grant: FileGrant): Promise<string> {
  const answer = await client.post(`${BASE}/imports`, contentPackJobAcceptedDtoSchema, { body: { grant } });
  return answer.jobId;
}

export function comparePack(client: ApiClient, jobId: string, key: string, targetContentId: string): Promise<PackContentDiff> {
  return client.post(path("imports", jobId, "/compare"), packContentDiffSchema, { body: { key, targetContentId } });
}

/** The decisions sent per import job, for the result page; the job itself does not echo them. */
const sentDecisions = new Map<string, ContentPackImportDecisions>();

export async function commitImport(client: ApiClient, jobId: string, decisions: ContentPackImportDecisions): Promise<ContentPackImportJobDto> {
  const job = await client.post(path("imports", jobId, "/commit"), contentPackImportJobDtoSchema, { body: decisions });
  sentDecisions.set(jobId, decisions);
  return job;
}

/** What the user decided for a job's collection, when this page sent it (not after a reload). */
export function decidedCollectionAction(jobId: string, key: string): "skip" | "create" | "join" | undefined {
  return sentDecisions.get(jobId)?.collections.find((decision) => decision.key === key)?.action;
}

export function cancelImport(client: ApiClient, jobId: string): Promise<ContentPackImportJobDto> {
  return client.post(path("imports", jobId, "/cancel"), contentPackImportJobDtoSchema);
}

export function retryCollections(client: ApiClient, jobId: string): Promise<ContentPackImportJobDto> {
  return client.post(path("imports", jobId, "/retry-collections"), contentPackImportJobDtoSchema);
}

export async function discardImport(client: ApiClient, jobId: string): Promise<void> {
  await client.delete(path("imports", jobId), z.unknown());
}

export interface UploadHandle {
  /** Resolves with the job id once the server has the whole file. */
  done: Promise<string>;
  abort: () => void;
}

/**
 * Uploads a pack as the raw request body. The `File` itself is the body, so the browser
 * streams it from disk; XHR rather than fetch because only XHR reports upload progress.
 * The file name travels percent-encoded, as header values are not UTF-8.
 */
export function uploadPack(client: ApiClient, file: File, onProgress: (loaded: number, total: number) => void): UploadHandle {
  const request = new XMLHttpRequest();
  const done = new Promise<string>((resolve, reject) => {
    request.open("POST", client.url(`${BASE}/imports/upload`));
    request.withCredentials = true;
    for (const [name, value] of Object.entries(client.headers({ "content-type": "application/octet-stream", "x-amber-filename": encodeURIComponent(file.name) }))) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    request.onload = () => {
      const body = parseJson(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        const accepted = contentPackJobAcceptedDtoSchema.safeParse(body);
        if (accepted.success) resolve(accepted.data.jobId);
        else reject(new ApiError(request.status, localError("internal", "response does not match the expected schema")));
        return;
      }
      if (request.status === 401 && client.mode === "server") client.onUnauthenticated?.();
      const error = appErrorSchema.safeParse((body as { error?: unknown } | undefined)?.error);
      reject(new ApiError(request.status, error.success ? error.data : localError("internal", `HTTP ${request.status}`)));
    };
    request.onerror = () => reject(new ApiError(0, localError("unknown", "backend unreachable")));
    request.onabort = () => reject(new DOMException("upload aborted", "AbortError"));
    request.send(file);
  });
  return { done, abort: () => request.abort() };
}

function parseJson(text: string): unknown {
  try {
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function localError(errorClass: "internal" | "unknown", message: string) {
  return { class: errorClass, code: errorClass, retryDisposition: "never" as const, userMessage: "", upstreamMessage: message };
}

/** The caller's running pack jobs; a page that offers pack actions reads it to find a job again after a reload. */
export function useActivePackJobs(enabled = true) {
  const client = useApi();
  return useQuery<ContentPackActiveDto>({
    queryKey: packKeys.active,
    queryFn: () => client.get(`${BASE}/active`, contentPackActiveDtoSchema),
    enabled,
    // A job that ends elsewhere (another tab) is noticed when the page is used again.
    staleTime: CONTENT_PACK_POLL_MS,
  });
}

const EXPORT_RUNNING = new Set<ContentPackExportJobDto["status"]>(["running"]);
const IMPORT_POLLING = new Set<ContentPackImportJobDto["status"]>(["receiving", "previewing", "importing"]);

/** An export job, polled while it runs. */
export function useExportJob(jobId: string | undefined) {
  const client = useApi();
  return useQuery({
    queryKey: packKeys.exportJob(jobId ?? ""),
    queryFn: () => client.get(path("exports", jobId ?? ""), contentPackExportJobDtoSchema),
    enabled: jobId !== undefined,
    refetchInterval: (query) => (query.state.data === undefined || EXPORT_RUNNING.has(query.state.data.status) ? CONTENT_PACK_POLL_MS : false),
  });
}

/**
 * An import job, polled while the server works on it; a preview waiting for decisions is
 * read again only near its expiry, so the page learns it ran out.
 */
export function useImportJob(jobId: string | undefined) {
  const client = useApi();
  return useQuery({
    queryKey: packKeys.importJob(jobId ?? ""),
    queryFn: () => client.get(path("imports", jobId ?? ""), contentPackImportJobDtoSchema),
    enabled: jobId !== undefined,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || IMPORT_POLLING.has(data.status)) return CONTENT_PACK_POLL_MS;
      if (data.status === "awaiting_decisions" && data.expiresAt !== undefined) return Math.max(CONTENT_PACK_POLL_MS, data.expiresAt - Date.now() + CONTENT_PACK_POLL_MS);
      return false;
    },
  });
}

/** Re-reads what an import may have changed: lists, collections, the trash, tasks, the active jobs. */
export function useRefreshAfterImport(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.collections });
    void queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails });
    // Every open Content page: a merge adds revisions, speakers, notes and figures to it.
    void queryClient.invalidateQueries({ queryKey: ["content"] });
    void queryClient.invalidateQueries({ queryKey: packKeys.active });
  }, [queryClient]);
}
