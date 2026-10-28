import { z } from "zod";
import { DISPLAY_NAME_MAX_CHARS } from "../defaults.ts";
import { CONTENT_SOURCE_KINDS, PROCESSING_STATUSES } from "../enums.ts";
import { STALE_REASONS } from "./chapter.ts";
import { citationDtoSchema } from "./citation.ts";
import { importSettingsSchema, languageTagSchema } from "./import.ts";
import { modelRefSchema } from "./model-ref.ts";
import { QUALITY_REASONS, rollupPartialDtoSchema } from "./summary.ts";
import { modelRefSnapshotDtoSchema } from "./usage.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();
/** A user-given display name: collections, and a Content's own title. */
export const nameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX_CHARS);

export const collectionDtoSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().exactOptional(),
  platformCollectionId: z.string().exactOptional(),
  itemCount: z.number().int().nonnegative(),
  createdAt: msSchema,
  /**
   * The last change that counts for a collection: edits, members joining or leaving or moving
   * to and from the trash, order, a rollup summary; members' own processing does not count.
   */
  updatedAt: msSchema,
});
export type CollectionDto = z.infer<typeof collectionDtoSchema>;

/** `GET /api/collections`, oldest first. */
export const collectionListDtoSchema = z.object({ items: z.array(collectionDtoSchema) });
export type CollectionListDto = z.infer<typeof collectionListDtoSchema>;

/** One member: the item and what the list shows of its Content. */
export const collectionItemDtoSchema = z.object({
  id: idSchema,
  contentId: idSchema,
  position: z.number().int(),
  addedAt: msSchema,
  title: z.string().exactOptional(),
  coverUrl: z.string().exactOptional(),
  durationMs: z.number().int().nonnegative().exactOptional(),
  processingStatus: z.enum(PROCESSING_STATUSES),
  pinnedAt: msSchema.exactOptional(),
  /** The Content's canonical source URL; absent for local files. */
  sourceUrl: z.string().exactOptional(),
  /** The Content's source kind, shaped like `ContentDto.source` cut to what the list shows. */
  source: z.object({ kind: z.enum(CONTENT_SOURCE_KINDS) }),
  /** The Content's own last change, as the content list shows it; not the item's. */
  updatedAt: msSchema,
});
export type CollectionItemDto = z.infer<typeof collectionItemDtoSchema>;

/** `GET /api/collections/:id` (and the answer of PATCH / order changes): items in order. */
export const collectionDetailDtoSchema = collectionDtoSchema.extend({ items: z.array(collectionItemDtoSchema) });
export type CollectionDetailDto = z.infer<typeof collectionDetailDtoSchema>;

/** `POST /api/collections`. */
export const collectionCreateRequestSchema = z.object({ name: nameSchema, description: z.string().exactOptional() }).strict();
export type CollectionCreateRequest = z.infer<typeof collectionCreateRequestSchema>;

/** `PATCH /api/collections/:id`; `description: null` clears it. */
export const collectionPatchRequestSchema = z
  .object({ name: nameSchema.exactOptional(), description: z.string().nullable().exactOptional() })
  .strict()
  .refine((body) => body.name !== undefined || body.description !== undefined, { message: "nothing to change" });
export type CollectionPatchRequest = z.infer<typeof collectionPatchRequestSchema>;

/**
 * `POST /api/collections/:id/items`: exactly one of `url` (imported into the collection,
 * 202 with the import answer) and `contentId` (enrolled, 200 with the item).
 */
export const collectionItemAddRequestSchema = z
  .object({
    url: z.string().min(1).max(2048).exactOptional(),
    contentId: idSchema.exactOptional(),
    settings: importSettingsSchema.exactOptional(),
  })
  .strict()
  .refine((body) => (body.url === undefined) !== (body.contentId === undefined), { message: "exactly one of url and contentId" });
export type CollectionItemAddRequest = z.infer<typeof collectionItemAddRequestSchema>;

/** `PUT /api/collections/:id/items/order`: the complete new order. */
export const collectionOrderRequestSchema = z.object({ itemIds: z.array(idSchema).min(1) }).strict();
export type CollectionOrderRequest = z.infer<typeof collectionOrderRequestSchema>;

/** `POST /api/collections/:id/summary`. */
export const collectionSummaryRequestSchema = z
  .object({ modelRef: modelRefSchema.exactOptional(), outputLanguage: languageTagSchema.exactOptional() })
  .strict();
export type CollectionSummaryRequest = z.infer<typeof collectionSummaryRequestSchema>;

export const collectionSummaryRevisionDtoSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  body: z.string(),
  citations: z.array(citationDtoSchema),
  inputItems: z.array(
    z.object({
      collectionItemId: idSchema,
      contentId: idSchema,
      summaryRevisionId: idSchema.exactOptional(),
      transcriptRevisionId: idSchema.exactOptional(),
      position: z.number().int(),
    }),
  ),
  partials: z.array(rollupPartialDtoSchema),
  modelRef: modelRefSnapshotDtoSchema.exactOptional(),
  promptRef: z.object({ id: idSchema, version: z.number().int().positive() }).exactOptional(),
  quality: z.enum(["normal", "degraded"]),
  qualityReasons: z.array(z.enum(QUALITY_REASONS)),
  stale: z.boolean(),
  staleReason: z.enum(STALE_REASONS).exactOptional(),
  createdAt: msSchema,
});
export type CollectionSummaryRevisionDto = z.infer<typeof collectionSummaryRevisionDtoSchema>;

/** `GET /api/collections/:id/summary`: the current revision with its partials inline. */
export const collectionSummaryDtoSchema = z.object({
  artifactId: idSchema.exactOptional(),
  current: collectionSummaryRevisionDtoSchema.exactOptional(),
  stale: z.boolean(),
  staleReason: z.enum(STALE_REASONS).exactOptional(),
  /** Set, with `current` withheld, while a member the current revision summarised is in the trash. */
  hiddenReason: z.literal("member_trashed").exactOptional(),
  activeTaskId: idSchema.exactOptional(),
});
export type CollectionSummaryDto = z.infer<typeof collectionSummaryDtoSchema>;
