import { z } from "zod";
import { FIGURE_CAPTION_MAX_CHARS, FIGURE_WIDTH_MIN_RATIO } from "../defaults.ts";

const idSchema = z.string().min(1).max(64);
const msSchema = z.number().int().nonnegative();

/** `capture`: a frame of the Content's own video; `upload`: an image the user uploaded or pasted. */
export const FIGURE_SOURCES = ["capture", "upload"] as const;
export type FigureSource = (typeof FIGURE_SOURCES)[number];

/** Which side of its anchor sentence's paragraph a figure stands on. */
export const FIGURE_ANCHOR_SIDES = ["before", "after"] as const;
export type FigureAnchorSide = (typeof FIGURE_ANCHOR_SIDES)[number];

/** Why an uploaded or pasted image was refused (`invalid_request.figure_image`). */
export const FIGURE_IMAGE_PROBLEMS = ["unsupported", "corrupt", "too_large", "too_many_pixels"] as const;
export type FigureImageProblem = (typeof FIGURE_IMAGE_PROBLEMS)[number];

/** Why no frame could be captured (`invalid_request.figure_frame`). */
export const FIGURE_FRAME_PROBLEMS = ["no_video", "past_end", "failed"] as const;
export type FigureFrameProblem = (typeof FIGURE_FRAME_PROBLEMS)[number];

/**
 * The sentence a figure was last put next to, in the revision the user was reading then. A
 * soft reference: when that revision is gone or the figure is shown against another one that
 * cannot map the sentence, the figure falls back to its `displayMs`.
 */
export const figureAnchorSchema = z
  .object({ revisionId: idSchema, segmentId: idSchema, side: z.enum(FIGURE_ANCHOR_SIDES) })
  .strict();
export type FigureAnchor = z.infer<typeof figureAnchorSchema>;

/**
 * Where a figure goes. `displayMs` is always set: a capture's own time, or the start of the
 * sentence an uploaded image was placed by. `anchor` is absent when the figure is placed by
 * time only. `sortKey` orders figures that land in the same gap, smaller first.
 */
export const figurePlacementSchema = z
  .object({ displayMs: msSchema, anchor: figureAnchorSchema.nullable(), sortKey: z.number().int() })
  .strict();
export type FigurePlacement = z.infer<typeof figurePlacementSchema>;

/** Shown width as a share of the reading column. */
export const figureWidthSchema = z.number().min(FIGURE_WIDTH_MIN_RATIO).max(1);

/** Plain text; blank captions are stored as none. Line breaks are kept. */
export const figureCaptionSchema = z.string().max(FIGURE_CAPTION_MAX_CHARS);

export const figureDtoSchema = z
  .object({
    id: idSchema,
    contentId: idSchema,
    source: z.enum(FIGURE_SOURCES),
    /** Only on a capture: the media time of the frame. Never changes. */
    capturedAtMs: msSchema.exactOptional(),
    placement: figurePlacementSchema,
    widthRatio: figureWidthSchema,
    caption: z.string().min(1).exactOptional(),
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        bytes: z.number().int().positive(),
        /** Hex SHA-256 of the WebP bytes; the image URL's ETag. */
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    /** Bumped by every change of caption, width or place; a PATCH names the version it read. */
    version: z.number().int().positive(),
    /** Present while the figure is recently deleted and still restorable. */
    deletedAt: msSchema.exactOptional(),
    createdAt: msSchema,
    updatedAt: msSchema,
  })
  .strict();
export type FigureDto = z.infer<typeof figureDtoSchema>;

/**
 * `GET /api/contents/:id/figures`: `items` are the live figures in no particular order (the
 * reader places them); `recentlyDeleted` the ones still restorable, newest deletion first.
 * `limit` is the per-Content cap, which both lists count against.
 */
export const figureListDtoSchema = z
  .object({ items: z.array(figureDtoSchema), recentlyDeleted: z.array(figureDtoSchema), limit: z.number().int().positive() })
  .strict();
export type FigureListDto = z.infer<typeof figureListDtoSchema>;

/**
 * `POST /api/contents/:id/figures/capture`: a frame of `assetId` (a video file of this Content
 * the server can read) at `atMs`, clamped to the media's length. Without `placement` the figure
 * is placed by its capture time.
 */
export const figureCaptureRequestSchema = z
  .object({
    assetId: idSchema,
    atMs: msSchema,
    placement: figurePlacementSchema.exactOptional(),
    widthRatio: figureWidthSchema.exactOptional(),
  })
  .strict();
export type FigureCaptureRequest = z.infer<typeof figureCaptureRequestSchema>;

/**
 * The `meta` field of `POST /api/contents/:id/figures/upload` (multipart; `meta` first, then
 * `file`). The image is identified by its signature, never by its name or declared type.
 */
export const figureUploadMetaSchema = z
  .object({ placement: figurePlacementSchema, widthRatio: figureWidthSchema.exactOptional() })
  .strict();
export type FigureUploadMeta = z.infer<typeof figureUploadMetaSchema>;

/** `PATCH /api/figures/:fid`: `caption: null` (or blank) removes it. The image never changes. */
export const figurePatchRequestSchema = z
  .object({
    version: z.number().int().positive(),
    caption: figureCaptionSchema.nullable().exactOptional(),
    widthRatio: figureWidthSchema.exactOptional(),
    placement: figurePlacementSchema.exactOptional(),
  })
  .strict()
  .refine((body) => body.caption !== undefined || body.widthRatio !== undefined || body.placement !== undefined, { message: "nothing to change" });
export type FigurePatchRequest = z.infer<typeof figurePatchRequestSchema>;
