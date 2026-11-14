import { z } from "zod";
import { asrModelRefSchema, modelRefSchema } from "./model-ref.ts";
import { languageTagSchema } from "./language.ts";
import { diarizationRequestSchema } from "./speaker.ts";
import { subtitleImportOptionsSchema, timedSubtitleFormatSchema } from "./subtitle-import.ts";

export { languageTagSchema };

/** Per-import processing settings, frozen into each created Task's request. */
export const importSettingsSchema = z
  .object({
    templateId: z.string().min(1).exactOptional(),
    modelRef: modelRefSchema.exactOptional(),
    /** The ASR model to transcribe with; absent = none chosen, as for `modelRef`. */
    asrModelRef: asrModelRefSchema.exactOptional(),
    outputLanguage: languageTagSchema.exactOptional(),
    autoProofread: z.boolean().default(true),
    /** Speaker identification; absent = the user's "identify speakers" setting at submission. */
    diarization: diarizationRequestSchema.exactOptional(),
  })
  .strict();
export type ImportSettings = z.infer<typeof importSettingsSchema>;

/** A subtitle carried with a new Content; format decided by content when not given. */
export const initialSubtitleTextSchema = z
  .object({
    text: z.string().min(1),
    format: timedSubtitleFormatSchema.exactOptional(),
    language: languageTagSchema,
    options: subtitleImportOptionsSchema.exactOptional(),
  })
  .strict();
export type InitialSubtitleText = z.infer<typeof initialSubtitleTextSchema>;

/**
 * Which parts of a multi-part submission to import: the first, all of them, or the
 * listed part ids. Required when a URL without `p=` names a submission with several parts.
 */
export const importPartsSchema = z.union([z.literal("first"), z.literal("all"), z.array(z.string().min(1)).min(1)]);
export type ImportParts = z.infer<typeof importPartsSchema>;

export const importItemSchema = z
  .object({
    url: z.string().min(1).max(2048),
    parts: importPartsSchema.exactOptional(),
    initialSubtitle: initialSubtitleTextSchema.exactOptional(),
  })
  .strict();
export type ImportItem = z.infer<typeof importItemSchema>;

export const importCollectionTargetSchema = z.union([
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ name: z.string().trim().min(1) }).strict(),
]);
export type ImportCollectionTarget = z.infer<typeof importCollectionTargetSchema>;

/**
 * `POST /api/contents/import`. The number of items is checked by the
 * service after expansion so an oversized batch gets `invalid_request.batch_too_large`.
 */
export const importRequestSchema = z
  .object({
    items: z.array(importItemSchema).min(1),
    settings: importSettingsSchema.default({ autoProofread: true }),
    collection: importCollectionTargetSchema.exactOptional(),
  })
  .strict();
export type ImportRequest = z.infer<typeof importRequestSchema>;

/**
 * 202 body; one Task and Content id per imported item, in item order.
 * `skippedTrashedContentIds` lists Contents in the trash that an expanded collection or an
 * expired direct item named; they were not imported. Absent from older servers.
 */
export const importResponseSchema = z.object({
  importBatchId: z.string().min(1),
  taskIds: z.array(z.string().min(1)),
  contentIds: z.array(z.string().min(1)),
  skippedTrashedContentIds: z.array(z.string().min(1)).exactOptional(),
});
export type ImportResponse = z.infer<typeof importResponseSchema>;

export const inspectRequestSchema = z.object({ url: z.string().min(1).max(2048) }).strict();
export type InspectRequest = z.infer<typeof inspectRequestSchema>;

const durationSchema = z.number().int().nonnegative();

/** `POST /api/contents/inspect`: what a URL would import, without creating anything. */
export const inspectResponseSchema = z.object({
  kind: z.enum(["single", "multipart", "collection"]),
  canonicalUrl: z.string().min(1),
  title: z.string().exactOptional(),
  parts: z
    .array(z.object({ platformPartId: z.string().min(1), index: z.number().int().positive(), title: z.string(), durationMs: durationSchema }))
    .exactOptional(),
  itemCount: z.number().int().nonnegative().exactOptional(),
  items: z
    .array(
      z.object({
        platformContentId: z.string().min(1),
        platformPartId: z.string().min(1).exactOptional(),
        title: z.string().exactOptional(),
        durationMs: durationSchema.exactOptional(),
        canonicalUrl: z.string().min(1),
      }),
    )
    .exactOptional(),
});
export type InspectResponse = z.infer<typeof inspectResponseSchema>;
