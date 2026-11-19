import { z } from "zod";
import {
  CONTENT_DESCRIPTION_MAX_CHARS,
  FIGURE_CAPTION_MAX_CHARS,
  IMPORT_BATCH_MAX,
  NOTE_COMMENT_MAX_CHARS,
  SPEAKER_PALETTE_SIZE,
  SPEAKERS_PER_CONTENT_MAX,
} from "../../../shared/defaults.ts";
import { FIGURE_ANCHOR_SIDES, FIGURE_SOURCES, figureWidthSchema } from "../../../shared/dto/figure.ts";
import { SPEAKER_AVATAR_MIMES } from "../../../shared/dto/speaker.ts";
import { CONTENT_SOURCE_KINDS, NOTE_COLORS, NOTE_MARKS, TIMING_FIDELITIES, TRANSCRIPT_KINDS } from "../../../shared/enums.ts";
import { normalizeSpeakerName } from "../../../shared/speakers.ts";

/**
 * The documents inside a content pack (`.amberpack`, an uncompressed tar). Entries, in order:
 *
 *   header.json                         ContentPackHeader: what the pack holds, every entry with its size
 *   collections.json                    CollectionsDocument
 *   contents/<n>/content.json           ContentDocument
 *   contents/<n>/revisions/<m>.json     RevisionDocument, one per carried revision
 *   contents/<n>/avatars/<k>.<ext>      speaker photos
 *   contents/<n>/figures/<k>.webp       figure images
 *   media/<n>/<k>.<ext>                 media files
 *   manifest.json                       PackManifest: SHA-256 of every other entry
 *
 * No database goes into a pack, and nothing a pack carries is trusted: every document is
 * parsed with these strict schemas (unknown fields are refused), every revision is checked by
 * the transcript invariants, every note anchor by the note rules, every image structurally.
 * Objects carry their transfer identity (`key`); local ids, user ids, absolute paths and
 * Profile ids never appear. Sentences are named by their revision and ordinal.
 */

export const CONTENT_PACK_FORMAT = "amber-content-pack";
export const CONTENT_PACK_FORMAT_VERSION = 1;

export const PACK_HEADER_ENTRY = "header.json";
export const PACK_COLLECTIONS_ENTRY = "collections.json";
export const PACK_MANIFEST_ENTRY = "manifest.json";

/** Entry names a pack may hold; anything else is refused before it is read. */
export const PACK_ENTRY_NAME = /^(header\.json|collections\.json|manifest\.json|contents\/\d{1,4}\/content\.json|contents\/\d{1,4}\/revisions\/\d{1,4}\.json|contents\/\d{1,4}\/avatars\/\d{1,4}\.(webp|png|jpg)|contents\/\d{1,4}\/figures\/\d{1,4}\.webp|media\/\d{1,4}\/\d{1,4}\.[a-z0-9]{1,8})$/;

const keySchema = z.string().min(1).max(128);
const msSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const entrySchema = z.string().regex(PACK_ENTRY_NAME);

export const packEntrySchema = z.object({ name: entrySchema, size: countSchema }).strict();

export const contentPackHeaderSchema = z
  .object({
    format: z.literal(CONTENT_PACK_FORMAT),
    formatVersion: z.number().int().positive(),
    amberVersion: z.string().max(64),
    /** Packs are never encrypted; the field is there so a later encrypted format is told apart. */
    encryption: z.literal("none"),
    createdAt: msSchema,
    contents: z.array(z.object({ key: keySchema, title: z.string().max(1000).exactOptional(), entry: entrySchema }).strict()).max(IMPORT_BATCH_MAX),
    /** Every entry that follows the header, in archive order, manifest excluded. */
    entries: z.array(packEntrySchema),
  })
  .strict();
export type ContentPackHeader = z.infer<typeof contentPackHeaderSchema>;

export const packManifestSchema = z
  .object({ entries: z.array(z.object({ name: entrySchema, size: countSchema, sha256: sha256Schema }).strict()) })
  .strict();
export type PackManifest = z.infer<typeof packManifestSchema>;

/** A collection with only the carried members, in the collection's order. */
export const collectionsDocumentSchema = z
  .object({
    collections: z.array(
      z
        .object({
          key: keySchema,
          name: z.string().min(1).max(200),
          description: z.string().max(5000).exactOptional(),
          platformCollectionId: z.string().max(200).exactOptional(),
          contentKeys: z.array(keySchema).min(1).max(IMPORT_BATCH_MAX),
        })
        .strict(),
    ),
  })
  .strict();
export type CollectionsDocument = z.infer<typeof collectionsDocumentSchema>;

/** How a revision was made where it came from: the whitelist `PackGeneration` keeps. */
export const packGenerationSchema = z
  .object({
    kind: z.literal("pack"),
    originalKind: z.enum(TRANSCRIPT_KINDS),
    originalGeneration: z.enum(["platform", "imported", "asr", "llm", "manual"]),
    modelName: z.string().min(1).max(200).exactOptional(),
  })
  .strict();

/** A sentence reference inside the pack: a carried revision and the sentence's ordinal there. */
const sentenceRefSchema = z.object({ revisionKey: keySchema, ordinal: countSchema }).strict();

export const packSpeakerSchema = z
  .object({
    /** Transfer identity: the Content identity the speaker belongs to and its id there. */
    originContentKey: keySchema,
    originSpeakerId: z.string().min(1).max(128),
    ordinal: z.number().int().positive(),
    /** Must normalize to a usable speaker name; the import stores the normalized form. */
    name: z
      .string()
      .min(1)
      .max(200)
      .refine((name) => {
        const normalized = normalizeSpeakerName(name);
        return normalized !== undefined && normalized !== "too_long";
      })
      .exactOptional(),
    nameConfirmedAt: msSchema.exactOptional(),
    colorIndex: z.number().int().min(0).max(SPEAKER_PALETTE_SIZE - 1),
    avatar: z.object({ entry: entrySchema, mime: z.enum(SPEAKER_AVATAR_MIMES) }).strict().exactOptional(),
  })
  .strict();
export type PackSpeaker = z.infer<typeof packSpeakerSchema>;

export const packRevisionSchema = z
  .object({
    key: keySchema,
    entry: entrySchema,
    kind: z.enum(TRANSCRIPT_KINDS),
    /** The parent's transfer identity; it may be carried in the same pack or already be on the target. */
    parentKey: keySchema.exactOptional(),
    language: z.string().min(1).max(35),
    timingFidelity: z.enum(TIMING_FIDELITIES),
    generation: packGenerationSchema,
    looseJoin: z.literal(true).exactOptional(),
    segmentCount: countSchema,
    createdAt: msSchema,
    archivedAt: msSchema.exactOptional(),
    speakersConfirmedAt: msSchema.exactOptional(),
    /** On a translation: whether it was its language's current translation. */
    currentTranslation: z.boolean().exactOptional(),
  })
  .strict();
export type PackRevision = z.infer<typeof packRevisionSchema>;

export const packNoteSchema = z
  .object({
    key: keySchema,
    start: sentenceRefSchema,
    startOffset: countSchema,
    end: sentenceRefSchema,
    endOffset: z.number().int().positive(),
    quote: z.string().max(100000),
    mark: z.enum(NOTE_MARKS),
    color: z.enum(NOTE_COLORS),
    comment: z.string().min(1).max(NOTE_COMMENT_MAX_CHARS).exactOptional(),
    createdAt: msSchema,
    updatedAt: msSchema,
  })
  .strict();
export type PackNote = z.infer<typeof packNoteSchema>;

export const packFigureSchema = z
  .object({
    key: keySchema,
    entry: entrySchema,
    source: z.enum(FIGURE_SOURCES),
    capturedAtMs: msSchema.exactOptional(),
    displayMs: msSchema,
    anchor: z.object({ revisionKey: keySchema, ordinal: countSchema, side: z.enum(FIGURE_ANCHOR_SIDES) }).strict().exactOptional(),
    sortKey: z.number().int(),
    widthRatio: figureWidthSchema,
    caption: z.string().min(1).max(FIGURE_CAPTION_MAX_CHARS).exactOptional(),
    image: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), bytes: z.number().int().positive(), sha256: sha256Schema }).strict(),
    createdAt: msSchema,
    updatedAt: msSchema,
  })
  .strict();
export type PackFigure = z.infer<typeof packFigureSchema>;

export const packMediaSchema = z
  .object({
    key: keySchema,
    entry: entrySchema,
    /** `original`: the user's own file (`external_local` / `managed_upload`); `cache`: a platform cache. */
    kind: z.enum(["original", "cache"]),
    displayName: z.string().max(1024).exactOptional(),
    mimeType: z.string().min(1).max(200),
    sizeBytes: countSchema,
    sha256: sha256Schema,
    durationMs: msSchema.exactOptional(),
    /** A video cache's picture height as recorded; `""` = audio cache. */
    quality: z.string().max(16).exactOptional(),
    /** A cache file's name in the cache directory, which encodes platform identity and quality. */
    cacheFileName: z.string().max(255).exactOptional(),
  })
  .strict();
export type PackMedia = z.infer<typeof packMediaSchema>;

export const contentDocumentSchema = z
  .object({
    key: keySchema,
    source: z
      .object({
        kind: z.enum(CONTENT_SOURCE_KINDS),
        sourceUrl: z.string().max(4096).exactOptional(),
        platformContentId: z.string().max(200).exactOptional(),
        platformPartId: z.string().max(200).exactOptional(),
        platformCollectionId: z.string().max(200).exactOptional(),
        channelId: z.string().max(200).exactOptional(),
        channelTitle: z.string().max(1000).exactOptional(),
      })
      .strict(),
    title: z.string().max(1000).exactOptional(),
    customTitle: z.string().max(1000).exactOptional(),
    coverUrl: z.string().max(4096).exactOptional(),
    durationMs: msSchema.exactOptional(),
    publishedAt: z.number().int().exactOptional(),
    rawLanguage: z.string().max(35).exactOptional(),
    /** At most the stored limit in code points (two UTF-16 units each at worst); normalized and capped again on import. */
    description: z.string().max(CONTENT_DESCRIPTION_MAX_CHARS * 2).exactOptional(),
    descriptionTruncated: z.literal(true).exactOptional(),
    /** `sha256:<hex>` of the original file, carried even when the file itself is not. */
    fingerprint: z.string().max(100).exactOptional(),
    primaryRevisionKey: keySchema.exactOptional(),
    speakers: z.array(packSpeakerSchema).max(SPEAKERS_PER_CONTENT_MAX),
    revisions: z.array(packRevisionSchema).max(1000),
    notes: z.array(packNoteSchema),
    figures: z.array(packFigureSchema),
    platformChapters: z.array(z.object({ startMs: msSchema, endMs: msSchema.exactOptional(), title: z.string().max(1000) }).strict()).max(1000).exactOptional(),
    media: z.array(packMediaSchema).max(100),
    createdAt: msSchema,
  })
  .strict();
export type ContentDocument = z.infer<typeof contentDocumentSchema>;

/** One sentence; `speaker` indexes `ContentDocument.speakers`; `sources` are ordinals in the parent revision. */
export const packSegmentSchema = z
  .object({
    startMs: msSchema,
    endMs: z.number().int().positive(),
    text: z.string().max(100000),
    words: z.array(z.object({ text: z.string().max(10000), startMs: msSchema, endMs: msSchema }).strict()).exactOptional(),
    speaker: z.number().int().nonnegative().exactOptional(),
    paragraphStart: z.boolean().exactOptional(),
    sources: z.array(countSchema).exactOptional(),
  })
  .strict();
export type PackSegment = z.infer<typeof packSegmentSchema>;

export const revisionDocumentSchema = z.object({ key: keySchema, segments: z.array(packSegmentSchema) }).strict();
export type RevisionDocument = z.infer<typeof revisionDocumentSchema>;
