import type { FastifyInstance } from "fastify";
import {
  contentTrashPlanDtoSchema,
  contentTrashPlanRequestSchema,
  contentTrashRequestSchema,
  contentTrashResultDtoSchema,
} from "../../../shared/dto/trash.ts";
import type { TrashService } from "../../application/trash.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

/**
 * Moving several Contents to the trash at once. Another user's Content is reported as
 * `missing`, exactly like an unknown id.
 */
export function registerContentTrashRoutes(app: FastifyInstance, deps: { trash: TrashService }): void {
  const { trash } = deps;

  app.post("/api/contents/trash-plan", async (request, reply) => {
    const { contentIds } = parseInput(contentTrashPlanRequestSchema, request.body, "body");
    return sendValidated(reply, 200, contentTrashPlanDtoSchema, trash.plan(principalOf(request), contentIds));
  });

  app.post("/api/contents/trash", async (request, reply) => {
    const body = parseInput(contentTrashRequestSchema, request.body, "body");
    return sendValidated(reply, 200, contentTrashResultDtoSchema, await trash.trashMany(principalOf(request), body));
  });
}
