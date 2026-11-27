import { z } from "zod";
import { IMPORT_BATCH_MAX } from "../defaults.ts";
import { CONTENT_SOURCE_KINDS, TIMING_FIDELITIES, TRANSCRIPT_KINDS } from "../enums.ts";
import { appErrorSchema } from "../errors.ts";
import { fileGrantSchema } from "./local-media.ts";

/**
 * Content packs: picked Contents carried from one device to another and imported into a
 * library that may already hold them, as often as wanted. Keys (`key`, `*Key`) name objects
 * inside one pack; they are opaque to the client and are not local ids.
 */

const idSchema = z.string().min(1).max(64);
const keySchema = z.string().min(1).max(128);
const countSchema = z.number().int().nonnegative();
const msSchema = z.number().int().nonnegative();

/** Media kinds a pack can carry: the user's original file (`external_local` / `managed_upload`) and platform caches. */
export const PACK_MEDIA_KINDS = ["original", "cache"] as const;
export type PackMediaKind = (typeof PACK_MEDIA_KINDS)[number];

/** Why a media file cannot go into a pack. */
export const PACK_MEDIA_UNAVAILABLE_REASONS = ["missing", "discarded", "unreadable"] as const;
export type PackMediaUnavailableReason = (typeof PACK_MEDIA_UNAVAILABLE_REASONS)[number];

/** Why a Content cannot be exported at all (`invalid_request.pack_selection` uses the same codes). */
export const PACK_SELECTION_PROBLEMS = [
  /** A local Content with no transcript and no readable media file: nothing on the other device could use it. */
  "nothing_to_carry",
  /** A translation picked without the revision it was translated from. */
  "translation_without_parent",
  /** A revision, media file or collection that is not this Content's (or is a comparison transcription). */
  "not_carryable",
  "too_many_contents",
  "empty",
] as const;
export type PackSelectionProblem = (typeof PACK_SELECTION_PROBLEMS)[number];

// ---------------------------------------------------------------------------------------------
// Export

/** `POST /api/content-packs/export-plan`: everything the export wizard shows for these Contents. */
export const contentPackExportPlanRequestSchema = z
  .object({ contentIds: z.array(idSchema).min(1).max(IMPORT_BATCH_MAX), collectionId: idSchema.exactOptional() })
  .strict();
export type ContentPackExportPlanRequest = z.infer<typeof contentPackExportPlanRequestSchema>;

export const exportPlanRevisionSchema = z
  .object({
    id: idSchema,
    kind: z.enum(TRANSCRIPT_KINDS),
    parentRevisionId: idSchema.exactOptional(),
    language: z.string(),
    timingFidelity: z.enum(TIMING_FIDELITIES),
    generation: z.record(z.string(), z.unknown()),
    segmentCount: countSchema,
    createdAt: msSchema,
    primary: z.boolean(),
    archived: z.boolean(),
    /** A translation that is its language's current one. */
    currentTranslation: z.boolean(),
    /** Figures whose place is anchored to this revision, and notes made on it. */
    anchoredFigures: countSchema,
    notes: countSchema,
  })
  .strict();
export type ExportPlanRevision = z.infer<typeof exportPlanRevisionSchema>;

export const exportPlanMediaSchema = z
  .object({
    assetId: idSchema,
    kind: z.enum(PACK_MEDIA_KINDS),
    displayName: z.string().exactOptional(),
    mimeType: z.string(),
    sizeBytes: countSchema,
    quality: z.string().exactOptional(),
    unavailable: z.enum(PACK_MEDIA_UNAVAILABLE_REASONS).exactOptional(),
  })
  .strict();
export type ExportPlanMedia = z.infer<typeof exportPlanMediaSchema>;

export const exportPlanContentSchema = z
  .object({
    contentId: idSchema,
    title: z.string().exactOptional(),
    sourceKind: z.enum(CONTENT_SOURCE_KINDS),
    durationMs: msSchema.exactOptional(),
    /** Revisions a pack may carry: every revision but comparison transcriptions, archived ones flagged. */
    revisions: z.array(exportPlanRevisionSchema),
    figures: countSchema,
    notes: countSchema,
    speakers: countSchema,
    platformChapters: z.boolean(),
    media: z.array(exportPlanMediaSchema),
    /** Absent when the Content can be exported; `busyTaskId` names the unfinished Task that blocks it. */
    blocked: z.enum(["nothing_to_carry", "busy"]).exactOptional(),
    busyTaskId: idSchema.exactOptional(),
  })
  .strict();
export type ExportPlanContent = z.infer<typeof exportPlanContentSchema>;

/** A collection any of the Contents belongs to; `memberCount` counts its members outside the trash. */
export const exportPlanCollectionSchema = z
  .object({
    collectionId: idSchema,
    name: z.string(),
    memberCount: countSchema,
    /** The planned Contents that belong to it, in the collection's order. */
    contentIds: z.array(idSchema),
  })
  .strict();
export type ExportPlanCollection = z.infer<typeof exportPlanCollectionSchema>;

export const contentPackExportPlanDtoSchema = z
  .object({ contents: z.array(exportPlanContentSchema), collections: z.array(exportPlanCollectionSchema) })
  .strict();
export type ContentPackExportPlanDto = z.infer<typeof contentPackExportPlanDtoSchema>;

/**
 * What goes into a pack, every item named explicitly. `revisionIds` lists transcripts and
 * translations alike; a translation needs the revision it was translated from in the same list.
 * Notes and figures go only with `notes` / `figures`; a note whose revision is not carried
 * stays behind. Speakers named by carried revisions, platform chapters and the basic record
 * always go.
 */
export const contentPackSelectionSchema = z
  .object({
    contents: z
      .array(
        z
          .object({
            contentId: idSchema,
            revisionIds: z.array(idSchema).max(1000),
            figures: z.boolean(),
            notes: z.boolean(),
            mediaAssetIds: z.array(idSchema).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(IMPORT_BATCH_MAX),
    collectionIds: z.array(idSchema).max(1000),
  })
  .strict();
export type ContentPackSelection = z.infer<typeof contentPackSelectionSchema>;

/**
 * `POST /api/content-packs/exports`: in local mode `grant` is the shell's `pack_output` grant for
 * the file the user chose; server mode builds the pack in its temporary area for download. It
 * is optional in the schema so that a missing grant answers `unauthenticated.file_grant`.
 */
export const contentPackExportRequestSchema = z
  .object({ selection: contentPackSelectionSchema, grant: fileGrantSchema.exactOptional() })
  .strict();
export type ContentPackExportRequest = z.infer<typeof contentPackExportRequestSchema>;

export const contentPackJobAcceptedDtoSchema = z.object({ jobId: idSchema }).strict();
export type ContentPackJobAcceptedDto = z.infer<typeof contentPackJobAcceptedDtoSchema>;

export const PACK_JOB_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
export type PackJobStatus = (typeof PACK_JOB_STATUSES)[number];

/** `documents`: the JSON and small files; `media`: copying media files; `finalize`: manifest, sync, rename. */
export const PACK_EXPORT_PHASES = ["documents", "media", "finalize"] as const;
export type PackExportPhase = (typeof PACK_EXPORT_PHASES)[number];

/**
 * `GET /api/content-packs/exports/:id`. `failedContent` names the Content whose media file
 * changed while it was copied. In server mode `result.downloadPath` is the `/api` path the
 * browser downloads the finished pack from until `result.expiresAt`.
 */
export const contentPackExportJobDtoSchema = z
  .object({
    jobId: idSchema,
    status: z.enum(PACK_JOB_STATUSES),
    phase: z.enum(PACK_EXPORT_PHASES),
    bytesDone: countSchema,
    bytesTotal: countSchema,
    error: appErrorSchema.exactOptional(),
    failedContent: z.object({ contentId: idSchema, title: z.string().exactOptional() }).strict().exactOptional(),
    result: z
      .object({
        fileName: z.string(),
        sizeBytes: countSchema,
        contents: countSchema,
        /** Exported Contents that had no local cover copy, so the pack carries only their cover URL. */
        coversLeftOut: countSchema.exactOptional(),
        downloadPath: z.string().exactOptional(),
        expiresAt: msSchema.exactOptional(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();
export type ContentPackExportJobDto = z.infer<typeof contentPackExportJobDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Import

/** `POST /api/content-packs/imports` [client]: `grant` is the shell's `pack_input` grant. */
export const contentPackImportRequestSchema = z.object({ grant: fileGrantSchema.exactOptional() }).strict();
export type ContentPackImportRequest = z.infer<typeof contentPackImportRequestSchema>;

/**
 * `receiving`: the server is taking the uploaded file; `previewing`: reading and checking the
 * documents; `awaiting_decisions`: the preview is ready until `expiresAt`; `importing`: reading
 * the whole file again, verifying it and committing; `finished`: every chosen item was handled
 * (see `result`, which may hold failures); `failed` / `cancelled`: nothing more will happen.
 */
export const PACK_IMPORT_STATUSES = ["receiving", "previewing", "awaiting_decisions", "importing", "finished", "failed", "cancelled"] as const;
export type PackImportStatus = (typeof PACK_IMPORT_STATUSES)[number];

/** `read`: the single sequential read that stages media and hashes; `verify`: the manifest check; then commits. */
export const PACK_IMPORT_PHASES = ["upload", "preview", "read", "verify", "contents", "collections"] as const;
export type PackImportPhase = (typeof PACK_IMPORT_PHASES)[number];

/** How a carried Content relates to the library. */
export const PACK_MATCH_KINDS = [
  /** Nothing here has its identity or its media. */
  "new",
  /** A local Content has its identity, or the user merged it into one before. */
  "same",
  /** A local Content has the same media (file fingerprint or platform identity) but another identity. */
  "same_media",
  /** The only match is in the trash; the user must restore or delete it first. */
  "trashed",
] as const;
export type PackMatchKind = (typeof PACK_MATCH_KINDS)[number];

export const PACK_MATCH_REASONS = ["origin", "mapped", "fingerprint", "platform"] as const;
export type PackMatchReason = (typeof PACK_MATCH_REASONS)[number];

export const packCandidateSchema = z
  .object({
    contentId: idSchema,
    title: z.string().exactOptional(),
    durationMs: msSchema.exactOptional(),
    reason: z.enum(PACK_MATCH_REASONS),
    trashed: z.boolean(),
  })
  .strict();
export type PackCandidate = z.infer<typeof packCandidateSchema>;

/**
 * `new`: not here; `existing`: same identity and same content, skipped; `differs`: same
 * identity, different content (a revision or image is a conflict and is not imported; a note
 * or figure keeps the local one unless the user adopts the pack's).
 */
export const PACK_ITEM_STATES = ["new", "existing", "differs"] as const;
export type PackItemState = (typeof PACK_ITEM_STATES)[number];

export const packRevisionDiffSchema = z
  .object({
    key: keySchema,
    kind: z.enum(TRANSCRIPT_KINDS),
    /** What it was on the device it came from; differs from `kind` when it arrives as a standalone revision. */
    originalKind: z.enum(TRANSCRIPT_KINDS),
    language: z.string(),
    segmentCount: countSchema,
    createdAt: msSchema,
    archived: z.boolean(),
    modelName: z.string().exactOptional(),
    state: z.enum(PACK_ITEM_STATES),
    /** It becomes a root revision here because its parent is neither carried nor present. */
    standalone: z.boolean(),
    /** Refused: a translation whose original is neither carried nor present. */
    rejected: z.literal("translation_without_parent").exactOptional(),
    /** A local revision of another identity with the very same text and timing. */
    sameTextAs: idSchema.exactOptional(),
    /** What `sameTextAs` is, so the preview can name it the way the revision list does. */
    sameTextAsRevision: z
      .object({ kind: z.enum(TRANSCRIPT_KINDS), language: z.string(), createdAt: msSchema, modelName: z.string().exactOptional() })
      .strict()
      .exactOptional(),
    /** A translation that would become its language's current one (none exists here yet). */
    becomesCurrentTranslation: z.boolean(),
  })
  .strict();
export type PackRevisionDiff = z.infer<typeof packRevisionDiffSchema>;

const categoryCountsSchema = z.object({ new: countSchema, existing: countSchema, differs: countSchema }).strict();

/**
 * The latest change among the differing items on each side, shown for reference beside
 * 「采用包里的」 only: the two devices' clocks need not agree, so nothing is decided by it.
 */
const differsUpdatedAtSchema = z.object({ here: msSchema, pack: msSchema }).strict();

export const packSpeakerDiffSchema = z
  .object({
    key: keySchema,
    name: z.string().exactOptional(),
    ordinal: z.number().int().positive(),
    state: z.enum(PACK_ITEM_STATES),
    /** The local speaker it is (`existing` / `differs`), or a same-named one the user may merge it with (`new`). */
    localSpeakerId: idSchema.exactOptional(),
    localName: z.string().exactOptional(),
    sameNameCandidates: z.array(z.object({ speakerId: idSchema, name: z.string() }).strict()),
  })
  .strict();
export type PackSpeakerDiff = z.infer<typeof packSpeakerDiffSchema>;

export const packMediaDiffSchema = z
  .object({
    key: keySchema,
    kind: z.enum(PACK_MEDIA_KINDS),
    displayName: z.string().exactOptional(),
    sizeBytes: countSchema,
    quality: z.string().exactOptional(),
    /** `fill`: registered here but its file is missing, the pack fills it in; `conflict`: a cache name is taken by a different file. */
    state: z.enum(["new", "existing", "fill", "conflict"]),
  })
  .strict();
export type PackMediaDiff = z.infer<typeof packMediaDiffSchema>;

export const PACK_LIMITED_CATEGORIES = ["figures", "notes", "speakers"] as const;
export type PackLimitedCategory = (typeof PACK_LIMITED_CATEGORIES)[number];

/** What importing one carried Content into one target (or as a new Content) would change. */
export const packContentDiffSchema = z
  .object({
    /** Absent when it would be created as a new Content. */
    targetContentId: idSchema.exactOptional(),
    revisions: z.array(packRevisionDiffSchema),
    speakers: z.array(packSpeakerDiffSchema),
    figures: categoryCountsSchema.extend({
      /** Figures whose anchor revision is not here; they are placed by time. */
      placedByTime: countSchema,
      /** Figures deleted here and still restorable; never imported again. */
      deletedHere: countSchema,
      /** Present when some figures differ. */
      differsUpdatedAt: differsUpdatedAtSchema.exactOptional(),
    }),
    notes: categoryCountsSchema.extend({
      unplaceable: countSchema,
      /** Present when some notes differ. */
      differsUpdatedAt: differsUpdatedAtSchema.exactOptional(),
    }),
    /** `add`: the pack's platform chapters are written; `keep`: this Content already has its own; `none`: the pack has none. */
    platformChapters: z.enum(["add", "keep", "none"]),
    media: z.array(packMediaDiffSchema),
    /** Categories that would exceed their per-Content limit; such a category cannot be imported as chosen. */
    overLimit: z.array(z.object({ category: z.enum(PACK_LIMITED_CATEGORIES), over: z.number().int().positive(), limit: z.number().int().positive() }).strict()),
    /** The target's primary transcript when the preview was made; checked again on commit. */
    targetPrimaryRevisionId: idSchema.exactOptional(),
  })
  .strict();
export type PackContentDiff = z.infer<typeof packContentDiffSchema>;

export const packPreviewContentSchema = z
  .object({
    key: keySchema,
    title: z.string().exactOptional(),
    sourceKind: z.enum(CONTENT_SOURCE_KINDS),
    durationMs: msSchema.exactOptional(),
    match: z.enum(PACK_MATCH_KINDS),
    candidates: z.array(packCandidateSchema),
    /** The diff against the suggested target: the single candidate, or a new Content. */
    diff: packContentDiffSchema,
  })
  .strict();
export type PackPreviewContent = z.infer<typeof packPreviewContentSchema>;

export const packPreviewCollectionSchema = z
  .object({
    key: keySchema,
    name: z.string(),
    description: z.string().exactOptional(),
    /** The carried Contents in it, in the pack's order. */
    contentKeys: z.array(keySchema),
    /** `same`: identity, an earlier merge or the platform collection id matches; `same_name`: only the name does. */
    match: z.enum(["new", "same", "same_name"]),
    candidates: z.array(z.object({ collectionId: idSchema, name: z.string(), memberCount: countSchema }).strict()),
  })
  .strict();
export type PackPreviewCollection = z.infer<typeof packPreviewCollectionSchema>;

export const contentPackPreviewDtoSchema = z
  .object({
    pack: z
      .object({
        formatVersion: z.number().int().positive(),
        createdAt: msSchema,
        amberVersion: z.string(),
        sizeBytes: countSchema,
        mediaBytes: countSchema,
      })
      .strict(),
    contents: z.array(packPreviewContentSchema),
    collections: z.array(packPreviewCollectionSchema),
  })
  .strict();
export type ContentPackPreviewDto = z.infer<typeof contentPackPreviewDtoSchema>;

/** `POST /api/content-packs/imports/:id/compare`: the diff against a target the user picked by hand. */
export const contentPackCompareRequestSchema = z.object({ key: keySchema, targetContentId: idSchema }).strict();
export type ContentPackCompareRequest = z.infer<typeof contentPackCompareRequestSchema>;

/**
 * One carried Content's decision. Category switches leave a whole category behind;
 * `excludeRevisionKeys` / `mediaKeys` pick within. `adoptPack` takes the pack's version of the
 * notes and figures that differ (comment, mark, colour; caption, width, place); nothing is
 * deleted and no image is replaced. `setPrimaryRevisionKey` makes a carried transcript the
 * primary; `currentTranslationKeys` make carried translations their language's current one.
 * `sameSpeakers` merges a carried speaker into a same-named local one.
 */
export const packContentDecisionSchema = z
  .object({
    key: keySchema,
    action: z.enum(["skip", "import", "merge"]),
    targetContentId: idSchema.exactOptional(),
    revisions: z.boolean(),
    excludeRevisionKeys: z.array(keySchema).max(1000).default([]),
    figures: z.boolean(),
    notes: z.boolean(),
    mediaKeys: z.array(keySchema).max(100).default([]),
    adoptPack: z.boolean().default(false),
    setPrimaryRevisionKey: keySchema.exactOptional(),
    currentTranslationKeys: z.array(keySchema).max(100).default([]),
    sameSpeakers: z.array(z.object({ speakerKey: keySchema, localSpeakerId: idSchema }).strict()).max(1000).default([]),
  })
  .strict();
export type PackContentDecision = z.input<typeof packContentDecisionSchema>;

export const packCollectionDecisionSchema = z
  .object({ key: keySchema, action: z.enum(["skip", "create", "join"]), targetCollectionId: idSchema.exactOptional() })
  .strict();
export type PackCollectionDecision = z.infer<typeof packCollectionDecisionSchema>;

/** `POST /api/content-packs/imports/:id/commit`. `originalsDir` is the `pack_originals_dir` grant (local mode, when originals are imported). */
export const contentPackImportDecisionsSchema = z
  .object({
    contents: z.array(packContentDecisionSchema).max(IMPORT_BATCH_MAX),
    collections: z.array(packCollectionDecisionSchema).max(1000),
    originalsDir: fileGrantSchema.exactOptional(),
  })
  .strict();
export type ContentPackImportDecisions = z.input<typeof contentPackImportDecisionsSchema>;

export const packContentResultSchema = z
  .object({
    key: keySchema,
    title: z.string().exactOptional(),
    status: z.enum(["imported", "merged", "skipped", "failed"]),
    contentId: idSchema.exactOptional(),
    error: appErrorSchema.exactOptional(),
    added: z.object({ revisions: countSchema, speakers: countSchema, figures: countSchema, notes: countSchema, media: countSchema }).strict(),
    updated: z.object({ figures: countSchema, notes: countSchema }).strict(),
    /** Items not imported because they conflict with what is here, by category. */
    conflicts: z.object({ revisions: countSchema, figures: countSchema, notes: countSchema, media: countSchema }).strict(),
    placedByTime: countSchema,
  })
  .strict();
export type PackContentResult = z.infer<typeof packContentResultSchema>;

export const packCollectionResultSchema = z
  .object({
    key: keySchema,
    name: z.string(),
    status: z.enum(["created", "joined", "skipped", "failed"]),
    collectionId: idSchema.exactOptional(),
    added: countSchema,
    error: appErrorSchema.exactOptional(),
  })
  .strict();
export type PackCollectionResult = z.infer<typeof packCollectionResultSchema>;

export const contentPackImportResultSchema = z
  .object({ contents: z.array(packContentResultSchema), collections: z.array(packCollectionResultSchema) })
  .strict();
export type ContentPackImportResult = z.infer<typeof contentPackImportResultSchema>;

/** `GET /api/content-packs/imports/:id`. Jobs live in the server's memory; the journal survives a crash. */
export const contentPackImportJobDtoSchema = z
  .object({
    jobId: idSchema,
    status: z.enum(PACK_IMPORT_STATUSES),
    phase: z.enum(PACK_IMPORT_PHASES),
    fileName: z.string().exactOptional(),
    bytesDone: countSchema,
    bytesTotal: countSchema,
    expiresAt: msSchema.exactOptional(),
    error: appErrorSchema.exactOptional(),
    preview: contentPackPreviewDtoSchema.exactOptional(),
    result: contentPackImportResultSchema.exactOptional(),
  })
  .strict();
export type ContentPackImportJobDto = z.infer<typeof contentPackImportJobDtoSchema>;

/** `GET /api/content-packs/active`: the caller's running jobs, so a reloaded page can find them again. */
export const contentPackActiveDtoSchema = z
  .object({ exportJobId: idSchema.exactOptional(), importJobId: idSchema.exactOptional() })
  .strict();
export type ContentPackActiveDto = z.infer<typeof contentPackActiveDtoSchema>;
