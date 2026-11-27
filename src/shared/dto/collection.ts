import { z } from "zod";
import { DISPLAY_NAME_MAX_CHARS } from "../defaults.ts";
import { CONTENT_SOURCE_KINDS, CONTENT_PROCESSING_STATUSES } from "../enums.ts";
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
  /** Version of the local cover copy; absent when the Content has none. A changed version means a new picture. */
  coverImageVersion: z.number().int().positive().exactOptional(),
  durationMs: z.number().int().nonnegative().exactOptional(),
  processingStatus: z.enum(CONTENT_PROCESSING_STATUSES),
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
  /**
   * How many current members' summaries were generated with speakers that no longer hold, as
   * they are now — the members a summary submitted now would caution. Absent when there are none.
   */
  speakerContextChangedMembers: z.number().int().positive().exactOptional(),
});
export type CollectionSummaryDto = z.infer<typeof collectionSummaryDtoSchema>;

const uniqueIdListSchema = z
  .array(idSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate id" });

/**
 * `POST /api/collections/:id/items/remove`: the Contents leave this collection only, all in
 * one transaction; any id that is not a visible member rejects the whole request with
 * `not_found`. Answers the collection's detail.
 */
export const collectionItemsRemoveRequestSchema = z.object({ contentIds: uniqueIdListSchema }).strict();
export type CollectionItemsRemoveRequest = z.infer<typeof collectionItemsRemoveRequestSchema>;

/**
 * `GET /api/collections/:id/delete-plan`: what deleting the collection would do. A member is
 * exclusive when it is outside the trash and belongs to no other collection; only exclusive
 * members are moved to the trash, shared ones stay.
 */
export const collectionDeletePlanDtoSchema = z.object({
  /** Members outside the trash. */
  memberCount: z.number().int().nonnegative(),
  /** In collection order; the `expectedContentIds` the delete request must repeat. */
  exclusiveContentIds: z.array(idSchema),
  /** Members outside the trash that also belong to another collection. */
  sharedCount: z.number().int().nonnegative(),
  /** Members already in the trash; their membership ends, their trash time is kept. */
  trashedMemberCount: z.number().int().nonnegative(),
  /** Exclusive members with unfinished Tasks of their own. */
  exclusiveWithTasksCount: z.number().int().nonnegative(),
  /** Unfinished Tasks of the collection itself (its summary). */
  collectionTaskCount: z.number().int().nonnegative(),
  /** Exclusive members frozen by another collection's unfinished summary: deleting with contents is refused while any is listed. */
  blocked: z.array(z.object({ contentId: idSchema, title: z.string().exactOptional(), collections: z.array(z.object({ id: idSchema, name: z.string().exactOptional() })) })),
});
export type CollectionDeletePlanDto = z.infer<typeof collectionDeletePlanDtoSchema>;

/**
 * `POST /api/collections/:id/delete` (accepts `Idempotency-Key`). `contents: "keep"` behaves
 * like `DELETE /api/collections/:id` except that `cancelTasks` may first cancel the
 * collection's own unfinished Tasks. `exclusive` also moves the exclusive members to the
 * trash; the server recomputes them and answers `conflict.collection_members_changed` when
 * they differ from `expectedContentIds`. The database part is all or nothing.
 */
export const collectionDeleteRequestSchema = z
  .object({
    contents: z.enum(["exclusive", "keep"]),
    cancelTasks: z.boolean(),
    expectedContentIds: z.array(idSchema).exactOptional(),
  })
  .strict()
  .refine((body) => body.contents === "keep" || body.expectedContentIds !== undefined, { message: "expectedContentIds is required with contents: exclusive" });
export type CollectionDeleteRequest = z.infer<typeof collectionDeleteRequestSchema>;

export const collectionDeleteResultDtoSchema = z.object({
  trashedIds: z.array(idSchema),
  cancelledTaskCount: z.number().int().nonnegative(),
});
export type CollectionDeleteResultDto = z.infer<typeof collectionDeleteResultDtoSchema>;
