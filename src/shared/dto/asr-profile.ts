import { z } from "zod";
import { ASR_MODEL_ID_PATTERN } from "../asr-presets.ts";
import { ASR_PROVIDERS, CREDENTIAL_STATUSES } from "../enums.ts";
import { modelPricingSchema } from "../model-pricing.ts";

const nameSchema = z.string().trim().min(1).max(100);

const modelIdSchema = z.string().trim().regex(ASR_MODEL_ID_PATTERN);

/**
 * A model of a profile. `family` is the request family it follows, absent when
 * none resolves; then `available` is false: it stays listed so the user can remove it, but
 * cannot be picked. `testedAt` is the last successful "test connection".
 */
export const asrProfileModelDtoSchema = z.object({
  modelId: z.string().min(1),
  family: z.string().min(1).exactOptional(),
  available: z.boolean(),
  pricing: modelPricingSchema.exactOptional(),
  testedAt: z.number().int().exactOptional(),
});
export type AsrProfileModelDto = z.infer<typeof asrProfileModelDtoSchema>;

/**
 * One of the user's ASR profiles: one service account with
 * its models in the user's order. The key never appears in a DTO; `hasCredential` is
 * `credentialStatus !== "missing"`. `inUse` is true while an unfinished Task is bound to it.
 */
export const asrProfileDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(ASR_PROVIDERS),
  models: z.array(asrProfileModelDtoSchema).min(1),
  baseURL: z.string().min(1).exactOptional(),
  credentialStatus: z.enum(CREDENTIAL_STATUSES),
  hasCredential: z.boolean(),
  inUse: z.boolean(),
  createdAt: z.number().int().nonnegative(),
});
export type AsrProfileDto = z.infer<typeof asrProfileDtoSchema>;

/** `GET /api/asr-profiles`: in the user's order. */
export const asrProfileListDtoSchema = z.object({ items: z.array(asrProfileDtoSchema) });
export type AsrProfileListDto = z.infer<typeof asrProfileListDtoSchema>;

/**
 * A model in a create or update request. A model the provider knows takes its own family
 * (another one is refused); any other model names one of the provider's families. A kept
 * model keeps its family.
 */
export const asrProfileModelInputSchema = z
  .object({
    modelId: modelIdSchema,
    family: z.string().min(1).exactOptional(),
  })
  .strict();
export type AsrProfileModelInput = z.infer<typeof asrProfileModelInputSchema>;

/**
 * `POST /api/asr-profiles`. `models` defaults to the provider's recommended ones, without
 * repeats. A `preset_only` provider accepts only its
 * listed endpoints as `baseURL` and stores the first when none is given.
 * Creating a profile never sets a default.
 */
export const asrProfileCreateSchema = z
  .object({
    name: nameSchema,
    provider: z.enum(ASR_PROVIDERS),
    models: z.array(asrProfileModelInputSchema).min(1).exactOptional(),
    baseURL: z.string().min(1).exactOptional(),
  })
  .strict();
export type AsrProfileCreate = z.infer<typeof asrProfileCreateSchema>;

/**
 * `PATCH /api/asr-profiles/:id`. `models` replaces the list in the given order; kept models
 * keep their family, price and test time; a model with no usable family may stay but not be
 * added. `baseURL: null` returns to the provider's default endpoint.
 */
export const asrProfilePatchSchema = z
  .object({
    name: nameSchema.exactOptional(),
    models: z.array(asrProfileModelInputSchema).min(1).exactOptional(),
    baseURL: z.string().min(1).nullable().exactOptional(),
  })
  .strict();
export type AsrProfilePatch = z.infer<typeof asrProfilePatchSchema>;

/** `PUT /api/asr-profiles/order`: every profile of the user exactly once, in the new order. */
export const asrProfileOrderRequestSchema = z.object({ profileIds: z.array(z.string().min(1)).min(1) }).strict();
export type AsrProfileOrderRequest = z.infer<typeof asrProfileOrderRequestSchema>;

/** `POST /api/asr-profiles/:id/test`: transcribe a short generated test sound with one model. */
export const asrModelTestRequestSchema = z.object({ modelId: z.string().min(1) }).strict();
export type AsrModelTestRequest = z.infer<typeof asrModelTestRequestSchema>;

/**
 * Outcome of a model test: `transcribed` (a result, possibly empty text),
 * `no_speech` (the provider found no speech in the test sound, which still proves the
 * model runs), or `accepted` (a job was accepted but gave no result in time; it was
 * cancelled best-effort). `remoteCancelled` is true only when the provider confirmed the
 * cancellation; otherwise the job may still run and be billed. `testedAt` is set when the
 * outcome was stored on the model.
 */
export const asrModelTestResultDtoSchema = z.object({
  modelId: z.string().min(1),
  result: z.enum(["transcribed", "no_speech", "accepted"]),
  textPreview: z.string().exactOptional(),
  latencyMs: z.number().int().nonnegative(),
  remoteCancelled: z.boolean().exactOptional(),
  testedAt: z.number().int().exactOptional(),
});
export type AsrModelTestResultDto = z.infer<typeof asrModelTestResultDtoSchema>;

/** What "test key" learned about the account; units are the provider's own. */
export const asrProbeDtoSchema = z.object({
  subscriptionStatus: z.string().exactOptional(),
  usedUnits: z.number().nonnegative().exactOptional(),
  limitUnits: z.number().nonnegative().exactOptional(),
});
export type AsrProbeDto = z.infer<typeof asrProbeDtoSchema>;
