import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { promptDtoSchema, promptListDtoSchema, promptUpdateRequestSchema, promptVersionListDtoSchema } from "../../../shared/dto/prompt.ts";
import type { PromptService } from "../../application/prompts.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });

/** `/api/prompts*`: the customizable system prompts. */
export function registerPromptRoutes(app: FastifyInstance, deps: { prompts: PromptService }): void {
  const { prompts } = deps;

  app.get("/api/prompts", async (request, reply) => {
    return sendValidated(reply, 200, promptListDtoSchema, prompts.list(principalOf(request)));
  });

  app.put("/api/prompts/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(promptUpdateRequestSchema, request.body, "body");
    return sendValidated(reply, 200, promptDtoSchema, prompts.update(principalOf(request), id, body));
  });

  app.delete("/api/prompts/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, promptDtoSchema, prompts.restore(principalOf(request), id));
  });

  app.get("/api/prompts/:id/versions", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, promptVersionListDtoSchema, prompts.versions(principalOf(request), id));
  });
}
