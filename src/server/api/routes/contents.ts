import type { MultipartFile, MultipartValue } from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { API_PAGE_SIZE_DEFAULT, API_PAGE_SIZE_MAX, CONTENT_LIST_IDS_MAX, SUBTITLE_IMPORT_MAX_BYTES } from "../../../shared/defaults.ts";
import {
  contentDetailDtoSchema,
  contentDtoSchema,
  contentListDtoSchema,
  contentPatchRequestSchema,
  primaryTranscriptRequestSchema,
  subtitleImportRequestSchema,
  subtitleImportResponseSchema,
  transcriptRevisionListDtoSchema,
} from "../../../shared/dto/content.ts";
import { importRequestSchema, importResponseSchema, inspectRequestSchema, inspectResponseSchema } from "../../../shared/dto/import.ts";
import { localFileRequestSchema } from "../../../shared/dto/local-media.ts";
import { asrModelRefSchema } from "../../../shared/dto/model-ref.ts";
import { diarizationRequestSchema } from "../../../shared/dto/speaker.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { CONTENT_SOURCE_KINDS, PROCESSING_STATUSES } from "../../../shared/enums.ts";
import type { ContentService } from "../../application/contents.ts";
import type { ImportContentService } from "../../application/import-content.ts";
import type { LocalImportService, UploadPart } from "../../application/local-import.ts";
import type { RetranscribeService } from "../../application/retranscribe.ts";
import type { TrashService } from "../../application/trash.ts";
import { FileTooLargeError } from "../../ports/file-store.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

/** Subtitle and cookie texts may reach `SUBTITLE_IMPORT_MAX_BYTES`; JSON escaping can double them. */
export const TEXT_BODY_LIMIT_BYTES = SUBTITLE_IMPORT_MAX_BYTES * 2;

const contentParamsSchema = z.object({ id: z.string().min(1) });
/** `retranscribe` may name the ASR profile to use (else the default applies); a client may also send no body at all. */
const retranscribeRequestSchema = z.object({ asrModelRef: asrModelRefSchema.exactOptional(), diarization: diarizationRequestSchema.exactOptional() }).strict();
/** `ids=a,b,c`: deduplicated, an empty entry is malformed rather than skipped. */
const contentIdsSchema = z
  .string()
  .transform((value) => [...new Set(value.split(","))])
  .pipe(z.array(z.string().min(1)).min(1).max(CONTENT_LIST_IDS_MAX));
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_PAGE_SIZE_MAX).default(API_PAGE_SIZE_DEFAULT),
    cursor: z.string().min(1).exactOptional(),
    // A numbered page; excludes `cursor`.
    page: z.coerce.number().int().min(1).safe().exactOptional(),
    status: z.enum(PROCESSING_STATUSES).exactOptional(),
    source: z.enum(CONTENT_SOURCE_KINDS).exactOptional(),
    collectionId: z.string().min(1).exactOptional(),
    // `uncollected=1` lists the Contents that belong to no collection.
    uncollected: z.enum(["0", "1"]).transform((value) => value === "1").exactOptional(),
    importBatchId: z.string().min(1).exactOptional(),
    ids: contentIdsSchema.exactOptional(),
  })
  .strict()
  .refine((query) => !(query.uncollected === true && query.collectionId !== undefined), {
    message: "uncollected and collectionId exclude each other",
    path: ["uncollected"],
  })
  .refine((query) => !(query.page !== undefined && query.cursor !== undefined), {
    message: "page and cursor exclude each other",
    path: ["page"],
  });

/**
 * Aborted when the client goes away, so platform lookups (yt-dlp, platform APIs) made on
 * behalf of a request stop with it.
 */
export function requestSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => controller.abort());
  return controller.signal;
}

export interface ContentRouteDeps {
  importContent?: ImportContentService;
  contents?: ContentService;
  /** `DELETE /api/contents/:id` moves the Content to the trash. */
  trash?: TrashService;
  retranscribe?: RetranscribeService;
}

/** `/api/contents*` for links and existing Contents. */
export function registerContentRoutes(app: FastifyInstance, deps: ContentRouteDeps): void {
  const { importContent, contents, trash, retranscribe } = deps;
  if (importContent !== undefined) {
    app.post("/api/contents/import", { bodyLimit: TEXT_BODY_LIMIT_BYTES }, async (request, reply) => {
      const body = parseInput(importRequestSchema, request.body, "body");
      const key = idempotencyKeyOf(request);
      const result = await importContent.import(principalOf(request), body, key, requestSignal(reply));
      return sendValidated(reply, result.status, importResponseSchema, result.body);
    });

    app.post("/api/contents/inspect", async (request, reply) => {
      const { url } = parseInput(inspectRequestSchema, request.body, "body");
      return sendValidated(reply, 200, inspectResponseSchema, await importContent.inspect(principalOf(request), url, requestSignal(reply)));
    });
  }

  if (contents !== undefined) {
    app.get("/api/contents", async (request, reply) => {
      const query = parseInput(listQuerySchema, request.query, "query");
      return sendValidated(reply, 200, contentListDtoSchema, contents.list(principalOf(request), query));
    });

    app.get("/api/contents/:id", async (request, reply) => {
      const { id } = parseInput(contentParamsSchema, request.params, "params");
      return sendValidated(reply, 200, contentDetailDtoSchema, contents.get(principalOf(request), id));
    });

    app.post("/api/contents/:id/subtitle-import", { bodyLimit: TEXT_BODY_LIMIT_BYTES }, async (request, reply) => {
      const { id } = parseInput(contentParamsSchema, request.params, "params");
      const body = parseInput(subtitleImportRequestSchema, request.body, "body");
      return sendValidated(reply, 201, subtitleImportResponseSchema, contents.importSubtitle(principalOf(request), id, body));
    });

    app.patch("/api/contents/:id", async (request, reply) => {
      const { id } = parseInput(contentParamsSchema, request.params, "params");
      const body = parseInput(contentPatchRequestSchema, request.body, "body");
      return sendValidated(reply, 200, contentDtoSchema, contents.patch(principalOf(request), id, body));
    });

    app.get("/api/contents/:id/transcript/revisions", async (request, reply) => {
      const { id } = parseInput(contentParamsSchema, request.params, "params");
      return sendValidated(reply, 200, transcriptRevisionListDtoSchema, contents.revisions(principalOf(request), id));
    });

    app.put("/api/contents/:id/primary-transcript", async (request, reply) => {
      const { id } = parseInput(contentParamsSchema, request.params, "params");
      const { revisionId } = parseInput(primaryTranscriptRequestSchema, request.body, "body");
      return sendValidated(reply, 200, contentDtoSchema, contents.setPrimary(principalOf(request), id, revisionId));
    });
  }

  if (retranscribe !== undefined) {
    app.post("/api/contents/:id/transcript/retranscribe", async (request, reply) => {
      const { id } = parseInput(contentParamsSchema, request.params, "params");
      const body = parseInput(retranscribeRequestSchema, request.body ?? {}, "body");
      const key = idempotencyKeyOf(request);
      const result = await retranscribe.retranscribe(principalOf(request), id, key, body.asrModelRef, body.diarization);
      return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
    });
  }

  if (trash !== undefined) {
    // To the trash, not gone: restorable for TRASH_RETENTION_DAYS.
    app.delete("/api/contents/:id", async (request, reply) => {
      const { id } = parseInput(contentParamsSchema, request.params, "params");
      trash.trash(principalOf(request), id);
      return reply.code(204).send();
    });
  }
}

/** Text parts are small JSON or flags; anything beyond this is not a legitimate client. */
const FIELD_MAX_BYTES = 64 * 1024;
const UPLOAD_MAX_PARTS = 5;

/**
 * The file stream of a part, ending in `FileTooLargeError` when the multipart parser cut it
 * at the per-part limit, so the service sees one error for every size limit.
 */
async function* partBytes(part: MultipartFile, limitBytes: number): AsyncIterable<Uint8Array> {
  for await (const chunk of part.file) {
    yield chunk as Buffer;
  }
  if (part.file.truncated) {
    throw new FileTooLargeError(limitBytes);
  }
}

/**
 * `POST /api/contents/upload` [server]: streaming multipart, written to disk part by part
 * and never buffered whole; limits apply per part inside the stream, not to the request's
 * `Content-Length`.
 */
export function registerUploadRoute(app: FastifyInstance, deps: { localImport: LocalImportService }): void {
  // An upload refused mid-body (quota, size limit, a bad part) is answered at once, but a
  // browser reads no response before it has sent the whole body, and the rest of that body
  // is no longer being read: closing the connection after the answer ends the wait.
  const closeIfBodyUnread = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.raw.complete) {
      void reply.header("connection", "close");
    }
  };
  app.post("/api/contents/upload", { onSend: closeIfBodyUnread }, async (request, reply) => {
    const key = idempotencyKeyOf(request);
    const limitBytes = deps.localImport.uploadLimitBytes;
    const multipart = request.parts({
      limits: { fileSize: limitBytes, fieldSize: FIELD_MAX_BYTES, parts: UPLOAD_MAX_PARTS },
    });
    async function* parts(): AsyncIterable<UploadPart> {
      for await (const part of multipart) {
        if (part.type === "file") {
          yield { kind: "file", name: part.fieldname, filename: part.filename, stream: partBytes(part, limitBytes) };
        } else {
          const value = (part as MultipartValue<unknown>).value;
          yield { kind: "field", name: part.fieldname, value: typeof value === "string" ? value : String(value) };
        }
      }
    }
    const result = await deps.localImport.upload(principalOf(request), parts(), key);
    return sendValidated(reply, result.status, importResponseSchema, result.body);
  });
}

/** `POST /api/contents/local-file` [client]: references a file the user picked in the shell's dialog. */
export function registerLocalFileRoute(app: FastifyInstance, deps: { localImport: LocalImportService }): void {
  app.post("/api/contents/local-file", async (request, reply) => {
    const body = parseInput(localFileRequestSchema, request.body, "body");
    const key = idempotencyKeyOf(request);
    const result = await deps.localImport.importLocalFile(principalOf(request), body, key);
    return sendValidated(reply, result.status, importResponseSchema, result.body);
  });
}
