import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PAGE_SIZE_DEFAULT, API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import {
  noteCreateRequestSchema,
  noteDtoSchema,
  noteGroupsDtoSchema,
  noteListDtoSchema,
  notePatchRequestSchema,
} from "../../../shared/dto/note.ts";
import type { NoteService } from "../../application/notes.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
const listQuerySchema = z.object({ revision: z.string().min(1).exactOptional() });
const groupsQuerySchema = z
  .object({
    cursor: z.string().min(1).exactOptional(),
    // A numbered page; excludes `cursor`.
    page: z.coerce.number().int().min(1).safe().exactOptional(),
    limit: z.coerce.number().int().min(1).max(API_PAGE_SIZE_MAX).default(API_PAGE_SIZE_DEFAULT),
  })
  .refine((query) => !(query.page !== undefined && query.cursor !== undefined), {
    message: "page and cursor exclude each other",
    path: ["page"],
  });

/** Notes on transcript text. */
export function registerNoteRoutes(app: FastifyInstance, deps: { notes: NoteService }): void {
  const { notes } = deps;

  app.get("/api/contents/:id/notes", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const { revision } = parseInput(listQuerySchema, request.query, "query");
    return sendValidated(reply, 200, noteListDtoSchema, notes.list(principalOf(request), id, revision));
  });

  app.post("/api/contents/:id/notes", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const key = idempotencyKeyOf(request);
    const body = parseInput(noteCreateRequestSchema, request.body, "body");
    const principal = principalOf(request);
    const result = notes.create(principal, id, body, key);
    // A replay answers with the note as it reads now (its quote is recut on every read); once
    // the note is gone, the recorded response is all there is to replay.
    const answer = result.replayed ? (notes.find(principal, result.body.id) ?? result.body) : result.body;
    return sendValidated(reply, result.status, noteDtoSchema, answer);
  });

  app.patch("/api/notes/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(notePatchRequestSchema, request.body, "body");
    return sendValidated(reply, 200, noteDtoSchema, notes.patch(principalOf(request), id, body));
  });

  app.delete("/api/notes/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    notes.delete(principalOf(request), id);
    return reply.code(204).send();
  });

  app.get("/api/notes/groups", async (request, reply) => {
    const query = parseInput(groupsQuerySchema, request.query, "query");
    return sendValidated(reply, 200, noteGroupsDtoSchema, notes.groups(principalOf(request), query));
  });
}
