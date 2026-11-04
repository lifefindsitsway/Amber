import { z } from "zod";
import { STALE_REASONS } from "./chapter.ts";
import { transcriptRevisionDtoSchema } from "./content.ts";
import { languageTagSchema } from "./import.ts";
import { modelRefSchema } from "./model-ref.ts";
import { draftVersionSchema, expectedDraftVersionSchema } from "./transcript.ts";

const idSchema = z.string().min(1);

/**
 * `POST /api/contents/:id/translations`. The source defaults to
 * the primary transcript and is frozen at submission; languages are normalized and
 * de-duplicated by the server.
 */
export const translationRequestSchema = z
  .object({
    targetLanguages: z.array(languageTagSchema).min(1),
    modelRef: modelRefSchema.exactOptional(),
    sourceRevisionId: idSchema.exactOptional(),
  })
  .strict();
export type TranslationRequest = z.infer<typeof translationRequestSchema>;

/**
 * One target language: its current `translated` revision and every translated revision
 * in that language, oldest first. A translation is stale when its parent is no longer the
 * primary transcript.
 */
export const translationEntryDtoSchema = z.object({
  artifactId: idSchema,
  targetLanguage: z.string(),
  current: transcriptRevisionDtoSchema.exactOptional(),
  revisions: z.array(transcriptRevisionDtoSchema),
  stale: z.boolean(),
  staleReason: z.enum(STALE_REASONS).exactOptional(),
  /** The language's unfinished hand edit, if any. */
  draft: z.object({ baseRevisionId: idSchema, version: draftVersionSchema, updatedAt: z.number().int().nonnegative() }).exactOptional(),
});
export type TranslationEntryDto = z.infer<typeof translationEntryDtoSchema>;

/** `GET /api/contents/:id/translations`: per-language translations and the unfinished translate Tasks. */
export const translationsDtoSchema = z.object({
  translations: z.array(translationEntryDtoSchema),
  activeTasks: z.array(z.object({ taskId: idSchema, targetLanguages: z.array(z.string()) })),
});
export type TranslationsDto = z.infer<typeof translationsDtoSchema>;

/** One sentence of a translation draft: the base sentence's id and its edited text. */
export const translationDraftSegmentSchema = z.object({ id: idSchema, text: z.string() }).strict();
export type TranslationDraftSegment = z.infer<typeof translationDraftSegmentSchema>;

/**
 * `PUT /api/contents/:id/translations/:language/draft`: replaces the language's draft whole.
 * Only text is sent: timing, order, speakers, paragraphs and sources always come from the base
 * translation, which must be of that language and not archived (and the current one when the
 * draft is new).
 */
export const translationDraftRequestSchema = z
  .object({
    baseRevisionId: idSchema,
    expectedVersion: expectedDraftVersionSchema,
    segments: z.array(translationDraftSegmentSchema),
  })
  .strict();
export type TranslationDraftRequest = z.infer<typeof translationDraftRequestSchema>;

export const translationDraftDtoSchema = z.object({
  id: idSchema,
  contentId: idSchema,
  targetLanguage: z.string(),
  baseRevisionId: idSchema,
  version: draftVersionSchema,
  segments: z.array(translationDraftSegmentSchema),
  updatedAt: z.number().int().nonnegative(),
});
export type TranslationDraftDto = z.infer<typeof translationDraftDtoSchema>;

/**
 * `POST /api/contents/:id/translations/:language/draft/commit`: commits the draft as a new
 * `translated` revision that becomes the language's current translation. Refused with
 * `conflict.draft_changed` when the draft is not at `draftVersion`, and with
 * `conflict.translation_changed` when the current translation is not `expectedRevisionId` or
 * when the draft's base is no longer current and `allowOutdatedBase` is absent.
 */
export const translationDraftCommitRequestSchema = z
  .object({
    expectedRevisionId: idSchema,
    draftVersion: draftVersionSchema,
    allowOutdatedBase: z.literal(true).exactOptional(),
  })
  .strict();
export type TranslationDraftCommitRequest = z.infer<typeof translationDraftCommitRequestSchema>;
