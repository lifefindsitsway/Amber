import { z } from "zod";
import { STALE_REASONS } from "./chapter.ts";
import { speakerContextDtoSchema } from "./speaker-context.ts";
import { QUALITY_REASONS } from "./summary.ts";
import { modelRefSnapshotDtoSchema } from "./usage.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();

/**
 * One AI highlight: a sentence of the revision the highlights were
 * built from, its 0–100 score and the model's one-line reason (`text`). `segmentText` is
 * the sentence itself; the times are the sentence's, for the timeline.
 */
export const highlightItemDtoSchema = z.object({
  segmentId: idSchema,
  score: z.number().int().min(0).max(100),
  text: z.string(),
  segmentText: z.string(),
  /** Who the sentence is given to in the revision the highlights were built from. */
  speakerId: idSchema.exactOptional(),
  startMs: msSchema,
  endMs: msSchema,
});
export type HighlightItemDto = z.infer<typeof highlightItemDtoSchema>;

/** A highlight revision with its derived freshness; items in time order. */
export const highlightRevisionDtoSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  transcriptRevisionId: idSchema,
  items: z.array(highlightItemDtoSchema),
  modelRef: modelRefSnapshotDtoSchema.exactOptional(),
  promptRef: z.object({ id: idSchema, version: z.number().int().positive() }).exactOptional(),
  quality: z.enum(["normal", "degraded"]),
  qualityReasons: z.array(z.enum(QUALITY_REASONS)),
  stale: z.boolean(),
  staleReason: z.enum(STALE_REASONS).exactOptional(),
  /** Present when the revision was generated with speakers, and only while the transcript it read is the primary or one of its ancestors. */
  speakerContext: speakerContextDtoSchema.exactOptional(),
  createdAt: msSchema,
});
export type HighlightRevisionDto = z.infer<typeof highlightRevisionDtoSchema>;

/** `GET /api/contents/:id/highlights`: the current revision and the unfinished Task recomputing them, if any. */
export const highlightsDtoSchema = z.object({
  artifactId: idSchema.exactOptional(),
  current: highlightRevisionDtoSchema.exactOptional(),
  activeTaskId: idSchema.exactOptional(),
});
export type HighlightsDto = z.infer<typeof highlightsDtoSchema>;
