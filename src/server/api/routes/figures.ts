import type { MultipartFile, MultipartValue } from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { FIGURE_UPLOAD_MAX_BYTES } from "../../../shared/defaults.ts";
import { figureCaptureRequestSchema, figureDtoSchema, figureListDtoSchema, figurePatchRequestSchema } from "../../../shared/dto/figure.ts";
import type { FigureService, FigureUploadPart } from "../../application/figures.ts";
import { FileTooLargeError } from "../../ports/file-store.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1).max(64) });
const figureParamsSchema = z.object({ fid: z.string().min(1).max(64) });
const META_MAX_BYTES = 16 * 1024;
const UPLOAD_MAX_PARTS = 2;

/** The file stream of a part, ending in `FileTooLargeError` when the parser cut it at the limit. */
async function* partBytes(part: MultipartFile): AsyncIterable<Uint8Array> {
  for await (const chunk of part.file) {
    yield chunk as Buffer;
  }
  if (part.file.truncated) {
    throw new FileTooLargeError(FIGURE_UPLOAD_MAX_BYTES);
  }
}

/** Figures of the reading view. The upload takes multipart (`meta` then `file`). */
export function registerFigureRoutes(app: FastifyInstance, deps: { figures: FigureService }): void {
  const { figures } = deps;

  app.get("/api/contents/:id/figures", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, figureListDtoSchema, figures.list(principalOf(request), id));
  });

  app.post("/api/contents/:id/figures/capture", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(figureCaptureRequestSchema, request.body, "body");
    const signal = abortOnClose(reply);
    return sendValidated(reply, 201, figureDtoSchema, await figures.capture(principalOf(request), id, body, signal));
  });

  // A refused upload is answered before the browser finished sending; close the connection then.
  const closeIfBodyUnread = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.raw.complete) {
      void reply.header("connection", "close");
    }
  };
  app.post("/api/contents/:id/figures/upload", { onSend: closeIfBodyUnread }, async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const multipart = request.parts({ limits: { fileSize: FIGURE_UPLOAD_MAX_BYTES, fieldSize: META_MAX_BYTES, parts: UPLOAD_MAX_PARTS } });
    async function* parts(): AsyncIterable<FigureUploadPart> {
      for await (const part of multipart) {
        if (part.type === "file") {
          yield { kind: "file", name: part.fieldname, stream: partBytes(part) };
        } else {
          const value = (part as MultipartValue<unknown>).value;
          yield { kind: "field", name: part.fieldname, value: typeof value === "string" ? value : String(value) };
        }
      }
    }
    const signal = abortOnClose(reply);
    return sendValidated(reply, 201, figureDtoSchema, await figures.upload(principalOf(request), id, parts(), signal));
  });

  app.patch("/api/figures/:fid", async (request, reply) => {
    const { fid } = parseInput(figureParamsSchema, request.params, "params");
    const body = parseInput(figurePatchRequestSchema, request.body, "body");
    return sendValidated(reply, 200, figureDtoSchema, figures.patch(principalOf(request), fid, body));
  });

  app.delete("/api/figures/:fid", async (request, reply) => {
    const { fid } = parseInput(figureParamsSchema, request.params, "params");
    return sendValidated(reply, 200, figureDtoSchema, figures.delete(principalOf(request), fid));
  });

  app.post("/api/figures/:fid/restore", async (request, reply) => {
    const { fid } = parseInput(figureParamsSchema, request.params, "params");
    return sendValidated(reply, 200, figureDtoSchema, figures.restore(principalOf(request), fid));
  });

  app.get("/api/figures/:fid/image", async (request, reply) => {
    const { fid } = parseInput(figureParamsSchema, request.params, "params");
    const image = figures.image(principalOf(request), fid);
    const etag = `"${image.sha256}"`;
    if (request.headers["if-none-match"] === etag) {
      return reply.code(304).header("etag", etag).send();
    }
    return reply
      .code(200)
      .header("content-type", "image/webp")
      .header("etag", etag)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(image.bytes));
  });
}

/**
 * Aborts the image work when the client goes away before the answer. The response's `close`
 * is the signal: the request's own `close` already fires once its body has been read, which
 * would cancel every capture and upload in the middle of its work.
 */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => controller.abort());
  return controller.signal;
}
