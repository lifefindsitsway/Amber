import { z } from "zod";
import { CREDENTIAL_STATUSES, LLM_PROTOCOLS, TRI_STATES } from "../enums.ts";
import { LLM_PRESET_IDS } from "../llm-presets.ts";
import { modelPricingSchema } from "../model-pricing.ts";

const triSchema = z.enum(TRI_STATES);
const tokenCountSchema = z.number().int().positive();

export const capabilityFlagsSchema = z.object({
  stream: triSchema,
  tools: triSchema,
  structuredOutput: triSchema,
  vision: triSchema,
  audioInput: triSchema,
  reasoning: triSchema,
});
export type CapabilityFlagsDto = z.infer<typeof capabilityFlagsSchema>;

export const capabilityLimitsSchema = z.object({
  contextWindowTokens: tokenCountSchema.exactOptional(),
  maxOutputTokens: tokenCountSchema.exactOptional(),
});

/** The three layers as stored, plus the field-wise effective value. */
export const modelCapabilityDtoSchema = z.object({
  modelId: z.string().min(1),
  flags: z.object({
    declared: capabilityFlagsSchema,
    observed: capabilityFlagsSchema.partial().exactOptional(),
    userOverride: capabilityFlagsSchema.partial().exactOptional(),
  }),
  limits: z.object({
    declared: capabilityLimitsSchema,
    observed: capabilityLimitsSchema.exactOptional(),
    userOverride: capabilityLimitsSchema.exactOptional(),
  }),
  observedAt: z.number().int().exactOptional(),
  effective: z.object({ flags: capabilityFlagsSchema, limits: capabilityLimitsSchema }),
  /** The user's own price; display only, outside the capability layers. */
  pricing: modelPricingSchema.exactOptional(),
});
export type ModelCapabilityDto = z.infer<typeof modelCapabilityDtoSchema>;

/** Never carries the key; `hasCredential` is `credentialStatus !== "missing"`. */
export const providerProfileDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: z.enum(LLM_PROTOCOLS),
  baseURL: z.string().min(1),
  /** The preset chosen at creation; display only (icon and region). A preset id later retired reads back as is. */
  presetId: z.string().min(1).exactOptional(),
  models: z.array(modelCapabilityDtoSchema),
  createdAt: z.number().int(),
  credentialStatus: z.enum(CREDENTIAL_STATUSES),
  hasCredential: z.boolean(),
});
export type ProviderProfileDto = z.infer<typeof providerProfileDtoSchema>;

export const providerListDtoSchema = z.object({ items: z.array(providerProfileDtoSchema) });
export type ProviderListDto = z.infer<typeof providerListDtoSchema>;

/** `PUT /api/providers/order`: every profile of the user exactly once, in the new order. */
export const providerOrderRequestSchema = z.object({ profileIds: z.array(z.string().min(1)).min(1) }).strict();
export type ProviderOrderRequest = z.infer<typeof providerOrderRequestSchema>;

/**
 * Both limits are optional (probing cannot measure them; features that need the window ask for
 * it where they start). On update, for a model kept by id: an omitted limit keeps the stored
 * value, a number replaces it, `null` clears it. On create, `null` equals omitted.
 */
export const providerModelInputSchema = z
  .object({
    modelId: z.string().trim().min(1),
    contextWindowTokens: tokenCountSchema.nullable().exactOptional(),
    maxOutputTokens: tokenCountSchema.nullable().exactOptional(),
  })
  .strict();

export const createProviderRequestSchema = z
  .object({
    name: z.string().trim().min(1),
    protocol: z.enum(LLM_PROTOCOLS),
    baseURL: z.string().trim().min(1),
    presetId: z.enum(LLM_PRESET_IDS).exactOptional(),
    models: z.array(providerModelInputSchema),
  })
  .strict();
/** The key that may come with it is defined at the server's API boundary only. */
export type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;

/** `models` replaces the whole list; models kept by id keep their probed and overridden layers. */
export const updateProviderRequestSchema = z
  .object({
    name: z.string().trim().min(1).exactOptional(),
    /** Display only; `null` clears it. */
    presetId: z.enum(LLM_PRESET_IDS).nullable().exactOptional(),
    baseURL: z.string().trim().min(1).exactOptional(),
    models: z.array(providerModelInputSchema).exactOptional(),
  })
  .strict();
export type UpdateProviderRequest = z.infer<typeof updateProviderRequestSchema>;

/** Each present layer replaces the stored `userOverride` layer; a `null` field clears it. */
export const modelOverrideRequestSchema = z
  .object({
    flags: z
      .object({
        stream: triSchema.nullable(),
        tools: triSchema.nullable(),
        structuredOutput: triSchema.nullable(),
        vision: triSchema.nullable(),
        audioInput: triSchema.nullable(),
        reasoning: triSchema.nullable(),
      })
      .partial()
      .strict()
      .exactOptional(),
    limits: z
      .object({ contextWindowTokens: tokenCountSchema.nullable(), maxOutputTokens: tokenCountSchema.nullable() })
      .partial()
      .strict()
      .exactOptional(),
  })
  .strict();
export type ModelOverrideRequest = z.infer<typeof modelOverrideRequestSchema>;

export const probeRequestSchema = z.object({ modelId: z.string().min(1) }).strict();

export const PROBE_BASIC_STATUSES = ["connected", "incomplete"] as const;
export type ProbeBasicStatus = (typeof PROBE_BASIC_STATUSES)[number];
export const PROBE_CHECK_FLAGS = ["stream", "structuredOutput", "tools"] as const;
export type ProbeCheckFlag = (typeof PROBE_CHECK_FLAGS)[number];
export const PROBE_CHECK_RESULTS = ["supported", "unsupported", "inconclusive"] as const;
export type ProbeCheckResult = (typeof PROBE_CHECK_RESULTS)[number];
/** Why a check could not decide: cut off by the output cap, a 400/422 it could not classify, or rate limited. */
export const PROBE_INCONCLUSIVE_REASONS = ["truncated", "upstream_rejected", "rate_limited"] as const;
export type ProbeInconclusiveReason = (typeof PROBE_INCONCLUSIVE_REASONS)[number];

/**
 * What "test connection" found. `basic` is the plain non-streamed call; each check is one
 * capability. `supported` / `unsupported` were written to `observed`, `inconclusive` cleared
 * that flag's `observed`; `observed` repeats the model's observed flags after the write.
 */
export const probeResultDtoSchema = z.object({
  modelId: z.string().min(1),
  basic: z.object({ status: z.enum(PROBE_BASIC_STATUSES), latencyMs: z.number().nonnegative() }).strict(),
  checks: z.array(
    z
      .object({
        flag: z.enum(PROBE_CHECK_FLAGS),
        result: z.enum(PROBE_CHECK_RESULTS),
        reason: z.enum(PROBE_INCONCLUSIVE_REASONS).exactOptional(),
      })
      .strict(),
  ),
  observed: capabilityFlagsSchema.pick({ stream: true, structuredOutput: true, tools: true }).partial(),
  observedAt: z.number().int(),
});
export type ProbeResultDto = z.infer<typeof probeResultDtoSchema>;
