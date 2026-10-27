import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  contentSummariesDtoSchema,
  summaryCreateRequestSchema,
  summaryCurrentRequestSchema,
  summaryRevisionListDtoSchema,
} from "../../../shared/dto/summary.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { SummaryService } from "../../application/summaries.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
const artifactParamsSchema = z.object({ aid: z.string().min(1) });
const artifactRevisionParamsSchema = z.object({ aid: z.string().min(1), rid: z.string().min(1) });

/** `/api/contents/:id/summaries` and `/api/summaries/:aid/*`. */
export function registerSummaryRoutes(app: FastifyInstance, deps: { summaries: SummaryService }): void {
  const { summaries } = deps;

  app.get("/api/contents/:id/summaries", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, contentSummariesDtoSchema, summaries.list(principalOf(request), id));
  });

  app.post("/api/contents/:id/summaries", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(summaryCreateRequestSchema, request.body, "body");
    const result = await summaries.create(principalOf(request), id, body, idempotencyKeyOf(request));
    return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
  });

  app.get("/api/summaries/:aid/revisions", async (request, reply) => {
    const { aid } = parseInput(artifactParamsSchema, request.params, "params");
    return sendValidated(reply, 200, summaryRevisionListDtoSchema, summaries.revisions(principalOf(request), aid));
  });

  app.put("/api/summaries/:aid/current", async (request, reply) => {
    const { aid } = parseInput(artifactParamsSchema, request.params, "params");
    const { revisionId } = parseInput(summaryCurrentRequestSchema, request.body, "body");
    return sendValidated(reply, 200, summaryRevisionListDtoSchema, summaries.setCurrent(principalOf(request), aid, revisionId));
  });

  app.delete("/api/summaries/:aid/revisions/:rid", async (request, reply) => {
    const { aid, rid } = parseInput(artifactRevisionParamsSchema, request.params, "params");
    return sendValidated(reply, 200, summaryRevisionListDtoSchema, summaries.deleteRevision(principalOf(request), aid, rid));
  });
}
