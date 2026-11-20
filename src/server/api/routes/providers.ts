import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelPricingRequestSchema } from "../../../shared/dto/model-pricing.ts";
import {
  createProviderRequestSchema,
  modelOverrideRequestSchema,
  probeRequestSchema,
  probeResultDtoSchema,
  providerListDtoSchema,
  providerOrderRequestSchema,
  providerProfileDtoSchema,
  updateProviderRequestSchema,
} from "../../../shared/dto/provider.ts";
import type { ProviderService } from "../../application/providers.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";
import { requestSignal } from "./contents.ts";

/** Secret-bearing request bodies: defined here on the server only, never in `src/shared` (the shared-secrets guard). */
const putCredentialRequestSchema = z.object({ value: z.string().min(1) }).strict();
const createWithCredentialRequestSchema = createProviderRequestSchema.extend({ credential: putCredentialRequestSchema.exactOptional() });
const profileParamsSchema = z.object({ id: z.string().min(1) });
// Fastify decodes the `encodeURIComponent`-ed model id in the path.
const modelParamsSchema = z.object({ id: z.string().min(1), mid: z.string().min(1) });

/** `/api/providers*`. */
export function registerProviderRoutes(app: FastifyInstance, deps: { providers: ProviderService }): void {
  const { providers } = deps;

  app.get("/api/providers", async (request, reply) => sendValidated(reply, 200, providerListDtoSchema, providers.list(principalOf(request))));

  app.post("/api/providers", async (request, reply) => {
    const body = parseInput(createWithCredentialRequestSchema, request.body, "body");
    const key = idempotencyKeyOf(request);
    await providers.checkBaseUrl(body.baseURL);
    return sendValidated(reply, 201, providerProfileDtoSchema, providers.create(principalOf(request), body, key));
  });

  app.put("/api/providers/order", async (request, reply) => {
    const { profileIds } = parseInput(providerOrderRequestSchema, request.body, "body");
    return sendValidated(reply, 200, providerListDtoSchema, providers.reorder(principalOf(request), profileIds));
  });

  app.patch("/api/providers/:id", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const body = parseInput(updateProviderRequestSchema, request.body, "body");
    await providers.checkBaseUrl(body.baseURL);
    return sendValidated(reply, 200, providerProfileDtoSchema, providers.update(principalOf(request), id, body));
  });

  app.delete("/api/providers/:id", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    providers.delete(principalOf(request), id);
    return reply.code(204).send();
  });

  app.put("/api/providers/:id/credential", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const { value } = parseInput(putCredentialRequestSchema, request.body, "body");
    return sendValidated(reply, 200, providerProfileDtoSchema, providers.putCredential(principalOf(request), id, value));
  });

  app.post("/api/providers/:id/probe", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const { modelId } = parseInput(probeRequestSchema, request.body, "body");
    const key = idempotencyKeyOf(request);
    const result = await providers.probe(principalOf(request), id, modelId, requestSignal(reply), key);
    return sendValidated(reply, result.status, probeResultDtoSchema, result.body);
  });

  app.put("/api/providers/:id/models/:mid/override", async (request, reply) => {
    const { id, mid } = parseInput(modelParamsSchema, request.params, "params");
    const body = parseInput(modelOverrideRequestSchema, request.body, "body");
    return sendValidated(reply, 200, providerProfileDtoSchema, providers.putOverride(principalOf(request), id, mid, body));
  });

  app.put("/api/providers/:id/model-pricing", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const body = parseInput(modelPricingRequestSchema, request.body, "body");
    return sendValidated(reply, 200, providerProfileDtoSchema, providers.setModelPricing(principalOf(request), id, body));
  });
}
