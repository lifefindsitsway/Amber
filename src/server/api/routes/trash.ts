import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PAGE_SIZE_DEFAULT, API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import { contentDtoSchema } from "../../../shared/dto/content.ts";
import { trashListDtoSchema, trashPurgeAllDtoSchema, trashRestoreRequestSchema, trashRestoreResultDtoSchema } from "../../../shared/dto/trash.ts";
import type { TrashService } from "../../application/trash.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_PAGE_SIZE_MAX).default(API_PAGE_SIZE_DEFAULT),
    cursor: z.string().min(1).exactOptional(),
    // A numbered page; excludes `cursor`.
    page: z.coerce.number().int().min(1).safe().exactOptional(),
  })
  .strict()
  .refine((query) => !(query.page !== undefined && query.cursor !== undefined), {
    message: "page and cursor exclude each other",
    path: ["page"],
  });

/** The caller's own trash; another user's Content is `not_found`. */
export function registerTrashRoutes(app: FastifyInstance, deps: { trash: TrashService }): void {
  const { trash } = deps;

  app.get("/api/trash", async (request, reply) => {
    const query = parseInput(listQuerySchema, request.query, "query");
    return sendValidated(reply, 200, trashListDtoSchema, trash.list(principalOf(request), query));
  });

  // Each Content on its own; the answer tells restored, already active and failed apart.
  app.post("/api/trash/restore", async (request, reply) => {
    const { contentIds } = parseInput(trashRestoreRequestSchema, request.body, "body");
    return sendValidated(reply, 200, trashRestoreResultDtoSchema, trash.restoreMany(principalOf(request), contentIds));
  });

  app.post("/api/trash/:id/restore", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, contentDtoSchema, trash.restore(principalOf(request), id));
  });

  // 204 once the purge has committed; the files are removed afterwards by the pending-file worker.
  app.delete("/api/trash/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    await trash.purge(principalOf(request), id);
    return reply.code(204).send();
  });

  app.delete("/api/trash", async (request, reply) => {
    return sendValidated(reply, 200, trashPurgeAllDtoSchema, await trash.purgeAll(principalOf(request)));
  });
}
