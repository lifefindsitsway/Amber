import { z } from "zod";
import {
  CONTENT_SOURCE_KINDS,
  MEDIA_ASSET_KINDS,
  PROCESSING_STATUSES,
  TIMING_FIDELITIES,
  TRANSCRIPT_KINDS,
} from "../enums.ts";
import { nameSchema } from "./collection.ts";
import { languageTagSchema } from "./import.ts";

const idSchema = z.string().min(1);
const epochMsSchema = z.number().int().nonnegative();

export const contentSourceDtoSchema = z.object({
  kind: z.enum(CONTENT_SOURCE_KINDS),
  sourceUrl: z.string().exactOptional(),
  platformContentId: z.string().exactOptional(),
  platformPartId: z.string().exactOptional(),
  platformCollectionId: z.string().exactOptional(),
  channelId: z.string().exactOptional(),
  channelTitle: z.string().exactOptional(),
});

export const contentDtoSchema = z.object({
  id: idSchema,
  source: contentSourceDtoSchema,
  /** The title to show: the user's own (`customTitle`) when set, else the platform's or file's. */
  title: z.string().exactOptional(),
  /** Present only when the user renamed the Content; clearing it restores the original title. */
  customTitle: z.string().exactOptional(),
  /** When the user pinned the Content; pinned Contents list first. */
  pinnedAt: epochMsSchema.exactOptional(),
  coverUrl: z.string().exactOptional(),
  durationMs: z.number().int().nonnegative().exactOptional(),
  publishedAt: z.number().int().exactOptional(),
  rawLanguage: z.string().exactOptional(),
  primaryTranscriptRevisionId: idSchema.exactOptional(),
  importBatchId: idSchema.exactOptional(),
  processingStatus: z.enum(PROCESSING_STATUSES),
  /** The collections the Content belongs to, oldest membership first; `itemId` is the membership to remove. */
  collections: z.array(z.object({ id: idSchema, name: z.string(), itemId: idSchema })),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
export type ContentDto = z.infer<typeof contentDtoSchema>;

/**
 * A media file as the UI may see it: never its storage reference. `localPath` is the
 * absolute path on the user's own computer, present only in local mode for an available
 * `external_local` or `platform_cache` file so the desktop player can read it through the
 * asset protocol; server mode never sends it.
 */
export const mediaAssetDtoSchema = z.object({
  id: idSchema,
  localPath: z.string().min(1).max(4096).exactOptional(),
  kind: z.enum(MEDIA_ASSET_KINDS),
  displayName: z.string().exactOptional(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().exactOptional(),
  /** Height of a video cache read from the finished file; `""` is an unknown quality. */
  quality: z.string().exactOptional(),
  /** False for a cache row an earlier build registered whose `quality` has not been read from the file yet. */
  qualityVerified: z.boolean().exactOptional(),
  availability: z.enum(["available", "missing", "evicted"]),
  retentionPolicy: z.enum(["never_delete", "keep", "discard_after_audio", "evictable", "ephemeral"]),
  createdAt: epochMsSchema,
});
export type MediaAssetDto = z.infer<typeof mediaAssetDtoSchema>;

export const contentDetailDtoSchema = contentDtoSchema.extend({ media: z.array(mediaAssetDtoSchema) });
export type ContentDetailDto = z.infer<typeof contentDetailDtoSchema>;

export const contentListDtoSchema = z.object({
  items: z.array(contentDtoSchema),
  /** How many Contents match the filters across all pages. */
  total: z.number().int().nonnegative(),
  nextCursor: z.string().exactOptional(),
});
export type ContentListDto = z.infer<typeof contentListDtoSchema>;

export const transcriptRevisionDtoSchema = z.object({
  id: idSchema,
  contentId: idSchema,
  kind: z.enum(TRANSCRIPT_KINDS),
  parentRevisionId: idSchema.exactOptional(),
  language: z.string(),
  timingFidelity: z.enum(TIMING_FIDELITIES),
  generation: z.record(z.string(), z.unknown()),
  segmentCount: z.number().int().nonnegative(),
  createdAt: epochMsSchema,
});
export type TranscriptRevisionDto = z.infer<typeof transcriptRevisionDtoSchema>;

/** Counts of what keeps a revision (and the revisions deleted with it) from being deleted. */
export const revisionBlockersDtoSchema = z
  .object({
    children: z.number().int().nonnegative(),
    draft: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    highlights: z.number().int().nonnegative(),
    chatMessages: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    activeTasks: z.number().int().nonnegative(),
  })
  .strict();
export type RevisionBlockersDto = z.infer<typeof revisionBlockersDtoSchema>;

/**
 * A revision as the revision list returns it. `blockers` and `deletable` describe deleting
 * the revision alone; `descendantIds` are the revisions a delete with descendants would also
 * remove (their own blockers are in their own list items).
 */
export const transcriptRevisionListItemDtoSchema = transcriptRevisionDtoSchema.extend({
  archived: z.boolean(),
  archivedAt: epochMsSchema.exactOptional(),
  deletable: z.boolean(),
  blockers: revisionBlockersDtoSchema,
  descendantIds: z.array(idSchema),
});
export type TranscriptRevisionListItemDto = z.infer<typeof transcriptRevisionListItemDtoSchema>;

/** `PUT /api/transcript/revisions/:rid/archived`. */
export const revisionArchiveRequestSchema = z.object({ archived: z.boolean() }).strict();
export type RevisionArchiveRequest = z.infer<typeof revisionArchiveRequestSchema>;

export const transcriptRevisionListDtoSchema = z.object({
  primaryTranscriptRevisionId: idSchema.exactOptional(),
  revisions: z.array(transcriptRevisionListItemDtoSchema),
});
export type TranscriptRevisionListDto = z.infer<typeof transcriptRevisionListDtoSchema>;

export const primaryTranscriptRequestSchema = z.object({ revisionId: idSchema }).strict();
export type PrimaryTranscriptRequest = z.infer<typeof primaryTranscriptRequestSchema>;

/** `POST /api/contents/:id/subtitle-import`. */
export const subtitleImportRequestSchema = z
  .object({
    text: z.string().min(1),
    format: z.enum(["srt", "vtt", "txt", "md"]).exactOptional(),
    language: languageTagSchema.exactOptional(),
    filename: z.string().max(1024).exactOptional(),
  })
  .strict();
export type SubtitleImportRequest = z.infer<typeof subtitleImportRequestSchema>;

/** Exactly one of the two ids; `warnings` are reason codes such as `subtitle_cue_dropped`. */
export const subtitleImportResponseSchema = z.object({
  transcriptRevisionId: idSchema.exactOptional(),
  referenceTextId: idSchema.exactOptional(),
  warnings: z.array(z.string()),
});
export type SubtitleImportResponse = z.infer<typeof subtitleImportResponseSchema>;

/** `PATCH /api/contents/:id`: `title` renames (`null` restores the original), `pinned` pins or unpins. */
export const contentPatchRequestSchema = z
  .object({ title: nameSchema.nullable().exactOptional(), pinned: z.boolean().exactOptional() })
  .strict()
  .refine((body) => body.title !== undefined || body.pinned !== undefined, { message: "nothing to change" });
export type ContentPatchRequest = z.infer<typeof contentPatchRequestSchema>;
