import { z } from "zod";
import { CACHE_MEDIA_TYPES, CACHE_QUALITY_TIERS } from "../cache-file-name.ts";
import { DISPLAY_NAME_MAX_CHARS } from "../defaults.ts";
import { BURN_MODES, SUBTITLE_DELIVERIES, SUBTITLE_VIDEO_CONTAINERS } from "../enums.ts";
import { subtitleStyleSchema } from "../subtitle-style.ts";

const idSchema = z.string().min(1);

/** A video height cap: one of the quality tiers. */
export const cacheQualitySchema = z.union(CACHE_QUALITY_TIERS.map((quality) => z.literal(quality)));

const cacheMediaFields = {
  type: z.enum(CACHE_MEDIA_TYPES).exactOptional(),
  quality: cacheQualitySchema.exactOptional(),
  fileName: z.string().max(DISPLAY_NAME_MAX_CHARS).exactOptional(),
};
const audioHasNoQuality = {
  check: (body: { type?: string; quality?: number }) => !(body.type === "audio" && body.quality !== undefined),
  params: { message: "quality applies to video caches only", path: ["quality"] },
};

/**
 * `POST /api/contents/:id/cache-media/inspect` [client]: what a cache request would produce,
 * without downloading. `type` defaults to `video`; `quality` is the height cap of a video
 * (`CACHE_MEDIA_MAX_HEIGHT` when absent) and is refused together with `audio`; `fileName` is
 * the stem, defaulting to the Content's display title and cleaned by the server.
 */
export const cacheMediaInspectRequestSchema = z.object(cacheMediaFields).strict().refine(audioHasNoQuality.check, audioHasNoQuality.params);
export type CacheMediaInspectRequest = z.infer<typeof cacheMediaInspectRequestSchema>;

/**
 * `POST /api/contents/:id/cache-media` [client]. The fields of the inspect request plus
 * `overwriteAssetId`: the user's confirmation that another Content's cache holding the same
 * file name may be replaced. The file name's quality label is decided by the finished file.
 */
export const cacheMediaRequestSchema = z
  .object({ ...cacheMediaFields, overwriteAssetId: idSchema.exactOptional() })
  .strict()
  .refine(audioHasNoQuality.check, audioHasNoQuality.params);
export type CacheMediaRequest = z.infer<typeof cacheMediaRequestSchema>;

/**
 * How the source's downloadable qualities were probed: `available` lists them,
 * `audio_only` means the probe succeeded but found no usable video stream, `unknown` means
 * no format list could be read.
 */
export const CACHE_QUALITY_STATUSES = ["available", "audio_only", "unknown"] as const;
export type CacheQualityStatus = (typeof CACHE_QUALITY_STATUSES)[number];

/**
 * Response of `GET /api/contents/:id/cache-media/qualities` [client]: the quality tiers the
 * source currently offers with the login the download would use, ascending and without
 * duplicates. Only the tiers: never the format list, its URLs or cookies. A listed tier is
 * a candidate, not a promise; the inspect estimate tells what would really be downloaded.
 */
export const cacheMediaQualitiesDtoSchema = z.object({ status: z.enum(CACHE_QUALITY_STATUSES), qualities: z.array(cacheQualitySchema) }).strict();
export type CacheMediaQualitiesDto = z.infer<typeof cacheMediaQualitiesDtoSchema>;

const volumeSpaceSchema = z.object({ freeBytes: z.number().int().nonnegative(), lowWaterBytes: z.number().int().nonnegative() }).strict();

/** One cache of the Content as the cache dialog lists it. `height` is absent for audio and for an unknown video quality. */
export const contentCacheDtoSchema = z
  .object({
    assetId: idSchema,
    type: z.enum(CACHE_MEDIA_TYPES),
    height: z.number().int().positive().exactOptional(),
    verified: z.boolean(),
    fileName: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ContentCacheDto = z.infer<typeof contentCacheDtoSchema>;

/**
 * Response of `POST /api/contents/:id/cache-media/inspect`. `expected` is an estimate: the
 * quality label of a video file is read from the finished download. `expected.type` is
 * `audio` when the source has no picture. `replaces` are this Content's caches the request
 * would replace; `overwrite` is another Content's registered cache holding the expected file
 * name, which needs the user's confirmation; `foreignFile`, `pendingName` and
 * `recoveryHold` block the request; `disk.ok` is false when a volume lacks room.
 */
export const cacheMediaInspectDtoSchema = z
  .object({
    expected: z
      .object({
        type: z.enum(CACHE_MEDIA_TYPES),
        height: z.number().int().positive().exactOptional(),
        ext: z.string(),
        sizeBytes: z.number().int().nonnegative().exactOptional(),
      })
      .strict(),
    expectedFileName: z.string(),
    replaces: z.array(z.object({ assetId: idSchema, fileName: z.string(), height: z.number().int().positive().exactOptional(), sizeBytes: z.number().int().nonnegative() }).strict()),
    overwrite: z.object({ assetId: idSchema, contentId: idSchema, title: z.string().exactOptional(), fileName: z.string(), sizeBytes: z.number().int().nonnegative() }).strict().exactOptional(),
    foreignFile: z.boolean(),
    pendingName: z.boolean(),
    recoveryHold: z.boolean(),
    disk: z.object({ cache: volumeSpaceSchema, data: volumeSpaceSchema.exactOptional(), ok: z.boolean() }).strict(),
    caches: z.array(contentCacheDtoSchema),
  })
  .strict();
export type CacheMediaInspectDto = z.infer<typeof cacheMediaInspectDtoSchema>;

/**
 * `POST /api/contents/:id/burn` [client], the subtitled video export: no output
 * path is accepted. `original` uses `revisionId`; `translation` the translation alone and
 * `bilingual` both lines, where `translationRevisionId` must be a translation whose parent is
 * `revisionId`. `delivery`, `container` and `style` come all together or not at all: without
 * them the request is the legacy fixed-style MP4 burn-in; a hard-subtitle export is MP4 only.
 * `sourceAssetId` picks the source video (the original file or one cached quality) and is
 * accepted only with the styled fields; without it the server picks the original, else the
 * highest cached quality.
 */
export const burnRequestSchema = z
  .object({
    revisionId: idSchema,
    translationRevisionId: idSchema.exactOptional(),
    mode: z.enum(BURN_MODES),
    delivery: z.enum(SUBTITLE_DELIVERIES).exactOptional(),
    container: z.enum(SUBTITLE_VIDEO_CONTAINERS).exactOptional(),
    style: subtitleStyleSchema.exactOptional(),
    sourceAssetId: idSchema.exactOptional(),
  })
  .strict()
  .refine((body) => body.sourceAssetId === undefined || body.delivery !== undefined, {
    message: "sourceAssetId needs delivery, container and style",
    path: ["sourceAssetId"],
  })
  .refine((body) => (body.mode === "original") === (body.translationRevisionId === undefined), {
    message: "translationRevisionId is required for translation and bilingual burns and only for them",
    path: ["translationRevisionId"],
  })
  .refine((body) => [body.delivery, body.container, body.style].every((field) => field === undefined) || [body.delivery, body.container, body.style].every((field) => field !== undefined), {
    message: "delivery, container and style are given together or not at all",
    path: ["delivery"],
  })
  .refine((body) => body.delivery !== "hard" || body.container === "mp4", {
    message: "a hard-subtitle export is MP4 only",
    path: ["container"],
  });
export type BurnRequest = z.infer<typeof burnRequestSchema>;

/** One burn product not yet saved out of the data directory (`GET /api/media/burn-outputs` [client]). */
export const burnOutputDtoSchema = z.object({
  assetId: idSchema,
  contentId: idSchema,
  taskId: idSchema,
  title: z.string().exactOptional(),
  /** `video/mp4` or `video/x-matroska`. */
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});
export type BurnOutputDto = z.infer<typeof burnOutputDtoSchema>;

/** Oldest first. */
export const burnOutputListDtoSchema = z.array(burnOutputDtoSchema);
export type BurnOutputListDto = z.infer<typeof burnOutputListDtoSchema>;
