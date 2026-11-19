import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  contentPackActiveDtoSchema,
  contentPackCompareRequestSchema,
  contentPackExportJobDtoSchema,
  contentPackExportPlanDtoSchema,
  contentPackExportPlanRequestSchema,
  contentPackExportRequestSchema,
  contentPackImportDecisionsSchema,
  contentPackImportJobDtoSchema,
  contentPackImportRequestSchema,
  contentPackJobAcceptedDtoSchema,
  packContentDiffSchema,
} from "../../../shared/dto/content-pack.ts";
import type { ContentPackExportService } from "../../application/content-pack-export.ts";
import type { ContentPackImportService } from "../../application/content-pack-import.ts";
import { contentDisposition } from "../../domain/export/filename.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const jobParamsSchema = z.object({ id: z.string().min(1).max(64) });
const PACK_MIME = "application/octet-stream";

/**
 * Content pack export and import, both run modes. Local mode reads and writes the files the
 * user picked in the shell's dialogs; server mode downloads a pack it built and takes an
 * upload as a raw request body, neither ever held in memory whole.
 */
export function registerContentPackRoutes(
  app: FastifyInstance,
  deps: { mode: "server" | "local"; exports: ContentPackExportService; imports: ContentPackImportService },
): void {
  const { exports, imports } = deps;

  app.get("/api/content-packs/active", async (request, reply) => {
    const principal = principalOf(request);
    const exportJobId = exports.active(principal);
    const importJobId = imports.active(principal);
    return sendValidated(reply, 200, contentPackActiveDtoSchema, {
      ...(exportJobId === undefined ? {} : { exportJobId }),
      ...(importJobId === undefined ? {} : { importJobId }),
    });
  });

  app.post("/api/content-packs/export-plan", async (request, reply) => {
    const body = parseInput(contentPackExportPlanRequestSchema, request.body, "body");
    return sendValidated(reply, 200, contentPackExportPlanDtoSchema, exports.plan(principalOf(request), body));
  });

  app.post("/api/content-packs/exports", async (request, reply) => {
    const body = parseInput(contentPackExportRequestSchema, request.body, "body");
    return sendValidated(reply, 202, contentPackJobAcceptedDtoSchema, await exports.start(principalOf(request), body));
  });

  app.get("/api/content-packs/exports/:id", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    return sendValidated(reply, 200, contentPackExportJobDtoSchema, exports.get(principalOf(request), id));
  });

  app.post("/api/content-packs/exports/:id/cancel", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    return sendValidated(reply, 200, contentPackExportJobDtoSchema, await exports.cancel(principalOf(request), id));
  });

  if (deps.mode === "server") {
    // A plain link the browser downloads to disk itself; the page never holds the pack.
    app.get("/api/content-packs/exports/:id/file", async (request, reply) => {
      const { id } = parseInput(jobParamsSchema, request.params, "params");
      const file = exports.download(principalOf(request), id);
      const stream = createReadStream(file.path);
      // Only a download that went out whole removes the pack; an interrupted one may be tried again.
      reply.raw.once("close", () => file.onSent(reply.raw.writableFinished));
      return reply
        .code(200)
        .header("content-type", PACK_MIME)
        .header("content-length", String(file.sizeBytes))
        .header("content-disposition", contentDisposition(file.fileName))
        .header("cache-control", "no-store")
        .send(stream);
    });

    // The pack as the raw request body, streamed to the job's staging area.
    void app.register(async (scope) => {
      scope.addContentTypeParser(PACK_MIME, (_request, payload, done) => done(null, payload));
      scope.post("/api/content-packs/imports/upload", async (request, reply) => {
        const fileName = single(request.headers["x-amber-filename"]);
        const decoded = fileName === undefined ? undefined : safeDecode(fileName);
        const body = request.body as AsyncIterable<Uint8Array>;
        const signal = abortOnClose(reply);
        return sendValidated(reply, 202, contentPackJobAcceptedDtoSchema, await imports.startFromUpload(principalOf(request), decoded, body, signal));
      });
    });
  } else {
    app.post("/api/content-packs/imports", async (request, reply) => {
      const body = parseInput(contentPackImportRequestSchema, request.body, "body");
      return sendValidated(reply, 202, contentPackJobAcceptedDtoSchema, await imports.startFromFile(principalOf(request), body));
    });
  }

  app.get("/api/content-packs/imports/:id", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    return sendValidated(reply, 200, contentPackImportJobDtoSchema, imports.get(principalOf(request), id));
  });

  app.post("/api/content-packs/imports/:id/compare", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    const body = parseInput(contentPackCompareRequestSchema, request.body, "body");
    return sendValidated(reply, 200, packContentDiffSchema, imports.compare(principalOf(request), id, body));
  });

  app.post("/api/content-packs/imports/:id/commit", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    const body = parseInput(contentPackImportDecisionsSchema, request.body, "body");
    return sendValidated(reply, 202, contentPackImportJobDtoSchema, await imports.commit(principalOf(request), id, body));
  });

  app.post("/api/content-packs/imports/:id/cancel", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    return sendValidated(reply, 200, contentPackImportJobDtoSchema, await imports.cancel(principalOf(request), id));
  });

  app.post("/api/content-packs/imports/:id/retry-collections", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    return sendValidated(reply, 202, contentPackImportJobDtoSchema, imports.retryCollections(principalOf(request), id));
  });

  app.delete("/api/content-packs/imports/:id", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    await imports.discard(principalOf(request), id);
    return reply.code(204).send();
  });
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The file name header is percent-encoded UTF-8; a malformed one is ignored. */
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value).slice(0, 255);
  } catch {
    return undefined;
  }
}

/**
 * Aborts when the client goes away before the answer was sent. The response is watched, not
 * the request: a request emits `close` as soon as its body has been read, which is no sign
 * of the client leaving and would cancel every upload that reached its end.
 */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
