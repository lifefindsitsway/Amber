import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  chatDtoSchema,
  chatMessageRequestSchema,
  chatQuerySchema,
  chatReplayDtoSchema,
  chatRetryRequestSchema,
  chatStreamEventSchemas,
  chatThreadCreatedDtoSchema,
  chatThreadPatchRequestSchema,
  chatThreadsDtoSchema,
  chatTurnsDeleteRequestSchema,
  chatTurnsDeleteResultSchema,
} from "../../../shared/dto/chat.ts";
import type { ChatSendResult, ChatService } from "../../application/chat.ts";
import { amberError } from "../../domain/errors.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
const threadParamsSchema = z.object({ id: z.string().min(1), tid: z.string().min(1) });
const messageParamsSchema = z.object({ id: z.string().min(1), mid: z.string().min(1) });

/**
 * `/api/contents/:id/chat*`. A new answer (sent or retried) streams as SSE on the POST
 * response itself; every refusal is a plain JSON error raised before the stream starts.
 * The client going away aborts the upstream call and leaves the answer `interrupted`; a
 * replayed `Idempotency-Key` gets the stored answer as JSON.
 */
export function registerChatRoutes(app: FastifyInstance, deps: { chat: ChatService }): void {
  const { chat } = deps;

  app.get("/api/contents/:id/chat", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const query = parseInput(chatQuerySchema, request.query, "query");
    return sendValidated(reply, 200, chatDtoSchema, chat.get(principalOf(request), id, query));
  });

  app.get("/api/contents/:id/chat/threads", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, chatThreadsDtoSchema, chat.threads(principalOf(request), id));
  });

  app.post("/api/contents/:id/chat/threads", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, chatThreadCreatedDtoSchema, chat.createThread(principalOf(request), id));
  });

  app.patch("/api/contents/:id/chat/threads/:tid", async (request, reply) => {
    const { id, tid } = parseInput(threadParamsSchema, request.params, "params");
    const body = parseInput(chatThreadPatchRequestSchema, request.body, "body");
    return sendValidated(reply, 200, chatThreadCreatedDtoSchema, chat.updateThread(principalOf(request), id, tid, body));
  });

  app.delete("/api/contents/:id/chat/threads/:tid", async (request, reply) => {
    const { id, tid } = parseInput(threadParamsSchema, request.params, "params");
    chat.deleteThread(principalOf(request), id, tid);
    return reply.code(204).send();
  });

  app.post("/api/contents/:id/chat/messages", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(chatMessageRequestSchema, request.body, "body");
    const key = idempotencyKeyOf(request);
    const controller = new AbortController();
    return respond(request, reply, controller, chat.send(principalOf(request), id, body, key, controller.signal));
  });

  app.post("/api/contents/:id/chat/messages/:mid/retry", async (request, reply) => {
    const { id, mid } = parseInput(messageParamsSchema, request.params, "params");
    const body = parseInput(chatRetryRequestSchema, request.body ?? {}, "body");
    // A retry is a paid call: without a key a lost response could only be answered by calling again.
    const key = idempotencyKeyOf(request);
    if (key === undefined) {
      throw amberError("invalid_request", "a retry needs an Idempotency-Key", { params: { detail: "Idempotency-Key" } });
    }
    const controller = new AbortController();
    return respond(request, reply, controller, chat.retry(principalOf(request), id, mid, body, key, controller.signal));
  });

  app.post("/api/contents/:id/chat/turns/delete", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(chatTurnsDeleteRequestSchema, request.body, "body");
    return sendValidated(reply, 200, chatTurnsDeleteResultSchema, chat.deleteTurns(principalOf(request), id, body));
  });

  app.delete("/api/contents/:id/chat", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    chat.clear(principalOf(request), id);
    return reply.code(204).send();
  });
}

/** A replay as JSON, or the answer's events as SSE frames. */
async function respond(request: FastifyRequest, reply: FastifyReply, controller: AbortController, result: ChatSendResult): Promise<FastifyReply | undefined> {
  if (result.kind === "replay") {
    return sendValidated(reply, 200, chatReplayDtoSchema, { message: result.message });
  }

  reply.hijack();
  const raw = reply.raw;
  // The response, not the request, closes when the client goes away (see api/sse.ts).
  raw.once("close", () => controller.abort());
  raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Drained to the end even after the client left, so the answer's final state is stored.
  // A session revoked meanwhile ends the stream, which aborts the answer.
  const guard = request.sessionGuard;
  for await (const event of result.events) {
    const data = chatStreamEventSchemas[event.type].parse(event.data);
    if (guard?.revoked() === true && !raw.destroyed) {
      raw.destroy();
    }
    if (!raw.destroyed && !raw.writableEnded) {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
  if (!raw.destroyed && !raw.writableEnded) {
    raw.end();
  }
  return undefined;
}
