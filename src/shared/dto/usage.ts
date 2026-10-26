import { z } from "zod";
import { ASR_USAGE_FEATURES, LLM_PROTOCOLS, TOKEN_USAGE_FEATURES } from "../enums.ts";

const usageOutcomeSchema = z.enum(["succeeded", "failed", "outcome_unknown"]);
const countSchema = z.number().int().nonnegative();

export const modelRefSnapshotDtoSchema = z.object({
  providerProfileId: z.string().min(1),
  modelId: z.string().min(1),
  providerNameSnapshot: z.string(),
  modelDisplaySnapshot: z.string(),
  /** The Profile's protocol at the time of the call; absent on records stored before it was kept. */
  protocolSnapshot: z.enum(LLM_PROTOCOLS).exactOptional(),
});

/** One LLM request; token counts are absent when the upstream reported none. */
export const tokenUsageDtoSchema = z.object({
  id: z.string().min(1),
  modelRef: modelRefSnapshotDtoSchema,
  feature: z.enum(TOKEN_USAGE_FEATURES),
  taskId: z.string().exactOptional(),
  workUnitId: z.string().exactOptional(),
  artifactRevisionId: z.string().exactOptional(),
  chatMessageId: z.string().exactOptional(),
  contentId: z.string().exactOptional(),
  outcome: usageOutcomeSchema,
  inputTokens: countSchema.exactOptional(),
  outputTokens: countSchema.exactOptional(),
  cacheReadTokens: countSchema.exactOptional(),
  cacheWriteTokens: countSchema.exactOptional(),
  reasoningTokens: countSchema.exactOptional(),
  createdAt: z.number().int(),
});
export type TokenUsageDto = z.infer<typeof tokenUsageDtoSchema>;

export const asrUsageDtoSchema = z.object({
  id: z.string().min(1),
  asrProfileId: z.string().exactOptional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  feature: z.enum(ASR_USAGE_FEATURES),
  outcome: usageOutcomeSchema,
  audioMs: countSchema,
  taskId: z.string().exactOptional(),
  contentId: z.string().exactOptional(),
  createdAt: z.number().int(),
});
export type AsrUsageDto = z.infer<typeof asrUsageDtoSchema>;

/**
 * Totals over the whole filtered range, not just the page. Token sums cover the rows
 * that reported counts; `incomplete` marks a group with at least one row that did not.
 */
export const usageTotalDtoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("llm"),
    modelRef: modelRefSnapshotDtoSchema,
    feature: z.enum(TOKEN_USAGE_FEATURES),
    calls: countSchema,
    inputTokens: countSchema.exactOptional(),
    outputTokens: countSchema.exactOptional(),
    incomplete: z.boolean(),
  }),
  z.object({
    kind: z.literal("asr"),
    provider: z.string().min(1),
    model: z.string().min(1),
    feature: z.enum(ASR_USAGE_FEATURES),
    calls: countSchema,
    audioMs: countSchema,
    incomplete: z.boolean(),
  }),
]);
export type UsageTotalDto = z.infer<typeof usageTotalDtoSchema>;

/** `GET /api/usage`; rows newest first, paged as one merged timeline. */
export const usageDtoSchema = z.object({
  llm: z.array(tokenUsageDtoSchema),
  asr: z.array(asrUsageDtoSchema),
  totals: z.array(usageTotalDtoSchema),
  nextCursor: z.string().min(1).exactOptional(),
});
export type UsageDto = z.infer<typeof usageDtoSchema>;
