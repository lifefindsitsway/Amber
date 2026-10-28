import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  collectionCreateRequestSchema,
  collectionDetailDtoSchema,
  collectionItemAddRequestSchema,
  collectionItemDtoSchema,
  collectionListDtoSchema,
  collectionOrderRequestSchema,
  collectionPatchRequestSchema,
  collectionSummaryDtoSchema,
  collectionSummaryRequestSchema,
} from "../../../shared/dto/collection.ts";
import { importResponseSchema } from "../../../shared/dto/import.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { CollectionService } from "../../application/collections.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
const itemParamsSchema = z.object({ id: z.string().min(1), iid: z.string().min(1) });

/** `/api/collections*`. */
export function registerCollectionRoutes(app: FastifyInstance, deps: { collections: CollectionService }): void {
  const { collections } = deps;

  app.get("/api/collections", async (request, reply) => {
    return sendValidated(reply, 200, collectionListDtoSchema, collections.list(principalOf(request)));
  });

  app.post("/api/collections", async (request, reply) => {
    const body = parseInput(collectionCreateRequestSchema, request.body, "body");
    return sendValidated(reply, 201, collectionDetailDtoSchema, collections.create(principalOf(request), body));
  });

  app.get("/api/collections/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, collectionDetailDtoSchema, collections.get(principalOf(request), id));
  });

  app.patch("/api/collections/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(collectionPatchRequestSchema, request.body, "body");
    return sendValidated(reply, 200, collectionDetailDtoSchema, collections.patch(principalOf(request), id, body));
  });

  app.delete("/api/collections/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    collections.delete(principalOf(request), id);
    return reply.code(204).send();
  });

  app.post("/api/collections/:id/items", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(collectionItemAddRequestSchema, request.body, "body");
    const result = await collections.addItem(principalOf(request), id, body, idempotencyKeyOf(request));
    return result.status === 202
      ? sendValidated(reply, 202, importResponseSchema, result.body)
      : sendValidated(reply, 200, collectionItemDtoSchema, result.body);
  });

  app.put("/api/collections/:id/items/order", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const { itemIds } = parseInput(collectionOrderRequestSchema, request.body, "body");
    return sendValidated(reply, 200, collectionDetailDtoSchema, collections.reorder(principalOf(request), id, itemIds));
  });

  app.delete("/api/collections/:id/items/:iid", async (request, reply) => {
    const { id, iid } = parseInput(itemParamsSchema, request.params, "params");
    collections.removeItem(principalOf(request), id, iid);
    return reply.code(204).send();
  });

  app.post("/api/collections/:id/summary", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(collectionSummaryRequestSchema, request.body ?? {}, "body");
    const result = await collections.createSummary(principalOf(request), id, body, idempotencyKeyOf(request));
    return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
  });

  app.get("/api/collections/:id/summary", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, collectionSummaryDtoSchema, collections.getSummary(principalOf(request), id));
  });

  app.delete("/api/collections/:id/summary", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    collections.deleteSummary(principalOf(request), id);
    return reply.code(204).send();
  });
}
