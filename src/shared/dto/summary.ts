import { z } from "zod";
import { PROMPT_CUSTOM_MAX_CHARS, DISPLAY_NAME_MAX_CHARS } from "../defaults.ts";
import { STALE_REASONS } from "./chapter.ts";
import { citationDtoSchema } from "./citation.ts";
import { languageTagSchema } from "./import.ts";
import { modelRefSchema } from "./model-ref.ts";
import { modelRefSnapshotDtoSchema } from "./usage.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();
const promptRefDtoSchema = z.object({ id: idSchema, version: z.number().int().positive() });

/** Quality reasons derived from `quality`; `citation_degraded` is the only one. */
export const QUALITY_REASONS = ["citation_degraded"] as const;
export type QualityReason = (typeof QUALITY_REASONS)[number];

/**
 * A summary template. A builtin template's `name` is an i18n key; `deleted` marks a
 * soft-deleted custom template still shown because something was generated from it.
 */
export const summaryTemplateDtoSchema = z.object({
  id: idSchema,
  builtin: z.boolean(),
  name: z.string(),
  currentVersion: z.number().int().positive(),
  deleted: z.boolean(),
});
export type SummaryTemplateDto = z.infer<typeof summaryTemplateDtoSchema>;

/** `GET /api/summary-templates`: builtin first, then the user's own, deleted ones omitted. */
export const summaryTemplateListDtoSchema = z.object({ items: z.array(summaryTemplateDtoSchema) });
export type SummaryTemplateListDto = z.infer<typeof summaryTemplateListDtoSchema>;

export const summaryTemplateVersionDtoSchema = z.object({
  templateId: idSchema,
  version: z.number().int().positive(),
  prompt: z.string(),
  createdAt: msSchema,
});
export type SummaryTemplateVersionDto = z.infer<typeof summaryTemplateVersionDtoSchema>;

/** `GET /api/summary-templates/:id/versions`, oldest first. */
export const summaryTemplateVersionListDtoSchema = z.object({ items: z.array(summaryTemplateVersionDtoSchema) });
export type SummaryTemplateVersionListDto = z.infer<typeof summaryTemplateVersionListDtoSchema>;

const templateNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX_CHARS);
const templatePromptSchema = z.string().trim().min(1).max(PROMPT_CUSTOM_MAX_CHARS);

/** `POST /api/summary-templates`: a custom template and its version 1. */
export const summaryTemplateCreateRequestSchema = z.object({ name: templateNameSchema, prompt: templatePromptSchema }).strict();
export type SummaryTemplateCreateRequest = z.infer<typeof summaryTemplateCreateRequestSchema>;

/** `PATCH /api/summary-templates/:id`: a changed `prompt` appends a version; a name alone does not. */
export const summaryTemplatePatchRequestSchema = z
  .object({ name: templateNameSchema.exactOptional(), prompt: templatePromptSchema.exactOptional() })
  .strict()
  .refine((body) => body.name !== undefined || body.prompt !== undefined, { message: "nothing to change" });
export type SummaryTemplatePatchRequest = z.infer<typeof summaryTemplatePatchRequestSchema>;

/** A summary revision with its derived freshness and quality reasons. */
export const summaryRevisionDtoSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  /** Markdown with canonical `[[seg:<segmentId>]]` and `[[unresolved:<alias>]]` markers. */
  body: z.string(),
  citations: z.array(citationDtoSchema),
  chapterRevisionId: idSchema.exactOptional(),
  partialIds: z.array(idSchema).exactOptional(),
  transcriptRevisionId: idSchema,
  modelRef: modelRefSnapshotDtoSchema.exactOptional(),
  promptRef: promptRefDtoSchema.exactOptional(),
  quality: z.enum(["normal", "degraded"]),
  qualityReasons: z.array(z.enum(QUALITY_REASONS)),
  stale: z.boolean(),
  staleReason: z.enum(STALE_REASONS).exactOptional(),
  createdAt: msSchema,
});
export type SummaryRevisionDto = z.infer<typeof summaryRevisionDtoSchema>;

/** `GET /api/contents/:id/summaries`: one entry per template the Content can show. */
export const contentSummariesDtoSchema = z.object({
  templates: z.array(
    z.object({
      template: summaryTemplateDtoSchema,
      artifactId: idSchema.exactOptional(),
      current: summaryRevisionDtoSchema.exactOptional(),
      stale: z.boolean(),
      staleReason: z.enum(STALE_REASONS).exactOptional(),
      activeTaskId: idSchema.exactOptional(),
    }),
  ),
});
export type ContentSummariesDto = z.infer<typeof contentSummariesDtoSchema>;

/** `POST /api/contents/:id/summaries`. */
export const summaryCreateRequestSchema = z
  .object({ templateId: idSchema, modelRef: modelRefSchema.exactOptional(), outputLanguage: languageTagSchema.exactOptional() })
  .strict();
export type SummaryCreateRequest = z.infer<typeof summaryCreateRequestSchema>;

/** `GET /api/summaries/:aid/revisions`, oldest first. */
/**
 * `GET /api/summaries/:aid/revisions` (also the answer of switching or deleting one).
 * `frozenRevisionIds` are earlier revisions a collection summary was built from: like the
 * current one, they cannot be deleted.
 */
export const summaryRevisionListDtoSchema = z.object({
  artifactId: idSchema,
  currentRevisionId: idSchema.exactOptional(),
  items: z.array(summaryRevisionDtoSchema),
  frozenRevisionIds: z.array(idSchema),
});
export type SummaryRevisionListDto = z.infer<typeof summaryRevisionListDtoSchema>;

/** `PUT /api/summaries/:aid/current`. */
export const summaryCurrentRequestSchema = z.object({ revisionId: idSchema }).strict();
export type SummaryCurrentRequest = z.infer<typeof summaryCurrentRequestSchema>;

/** A persisted rolling-summary intermediate, expandable once the final is published. */
export const rollupPartialDtoSchema = z.object({
  id: idSchema,
  index: z.number().int().nonnegative(),
  body: z.string(),
  citations: z.array(citationDtoSchema),
  createdAt: msSchema,
});
export type RollupPartialDto = z.infer<typeof rollupPartialDtoSchema>;
