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
    /**
     * Only for a collection URL: the chosen entries' `platformContentId`s in the order their
     * Tasks are queued. Non-empty, without duplicates, each still in the collection.
     */
    entries: z
      .array(z.string().min(1))
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate entry" })
      .exactOptional(),
    /** The `previewId` the entries were chosen from; reused while valid, otherwise the collection is listed again. */
    previewId: z.string().min(1).exactOptional(),
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
    /**
     * Every collection URL, including one a short link expands to, must carry `entries`;
     * one without answers `invalid_request.collection_choice_required`.
     */
    confirmCollections: z.boolean().exactOptional(),
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
  /** Collections the imported Contents joined: platform collections in input order, then the chosen target. Absent from older servers. */
  collectionIds: z.array(z.string().min(1)).exactOptional(),
});
export type ImportResponse = z.infer<typeof importResponseSchema>;

/**
 * `collectionId` names the local collection a collection preview compares against (the batch
 * add dialog's own); without it the local collection made from the same platform collection
 * is used. `previewId` + `offset` ask for a later page of a listed collection.
 */
export const inspectRequestSchema = z
  .object({
    url: z.string().min(1).max(2048),
    collectionId: z.string().min(1).exactOptional(),
    previewId: z.string().min(1).exactOptional(),
    offset: z.number().int().nonnegative().exactOptional(),
  })
  .strict();
export type InspectRequest = z.infer<typeof inspectRequestSchema>;

const durationSchema = z.number().int().nonnegative();

/**
 * What choosing a collection entry would do, most binding first: `unavailable` (private or
 * removed on the platform; cannot be chosen), `trashed` (its Content is in the trash; cannot
 * be chosen), `in_collection` (already a member of the compared local collection), `processing`
 * (its Content has an unfinished Task, which is reused), `in_library` (its Content exists and is
 * reused), `new`.
 */
export const COLLECTION_ENTRY_STATES = ["new", "in_library", "processing", "in_collection", "trashed", "unavailable"] as const;
export type CollectionEntryState = (typeof COLLECTION_ENTRY_STATES)[number];

/**
 * `POST /api/contents/inspect`: what a URL would import, without creating anything. For a
 * collection, `items` is one page of `COLLECTION_PREVIEW_PAGE_SIZE` entries starting at
 * `offset`, and `itemCount` counts every listed entry.
 */
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
        /** 0-based position in the platform's order. Present on collection previews. */
        index: z.number().int().nonnegative().exactOptional(),
        /** Cover image on a trusted platform image host; for the preview only. */
        coverUrl: z.string().min(1).exactOptional(),
        /** Parts of the submission; above 1 only the first is imported. */
        partCount: z.number().int().positive().exactOptional(),
        state: z.enum(COLLECTION_ENTRY_STATES).exactOptional(),
        /** The existing Content for `in_library`, `processing`, `in_collection` and `trashed`. */
        contentId: z.string().min(1).exactOptional(),
        unavailableReason: z.enum(["private", "removed", "unknown"]).exactOptional(),
      }),
    )
    .exactOptional(),
  /** Collection previews: the cache handle later pages and the import pass back. */
  previewId: z.string().min(1).exactOptional(),
  /** Entries the platform reports in total; absent when it does not say. */
  totalCount: z.number().int().nonnegative().exactOptional(),
  /** Set when the collection has more entries than `COLLECTION_PREVIEW_ITEMS_MAX` and only those were listed. */
  truncated: z.boolean().exactOptional(),
  /** `items` start at this position of the listed entries; `itemCount` is how many were listed. */
  offset: z.number().int().nonnegative().exactOptional(),
  /** Where the next page starts; absent on the last page. */
  nextOffset: z.number().int().positive().exactOptional(),
  /** The local collection the entry states were compared against, when there is one. */
  localCollection: z.object({ id: z.string().min(1), name: z.string() }).exactOptional(),
});
export type InspectResponse = z.infer<typeof inspectResponseSchema>;
