import { z } from "zod";
import { DANMAKU_TEXT_MAX_CHARS } from "../defaults.ts";
import { appErrorSchema } from "../errors.ts";

const msSchema = z.number().int().nonnegative();

/** How a danmaku moves: across the picture, or held at its top or bottom. */
export const DANMAKU_MODES = ["scroll", "top", "bottom"] as const;
export type DanmakuMode = (typeof DANMAKU_MODES)[number];

/**
 * One danmaku as Amber keeps it: no sender hash, no platform id. `color` is `0xRRGGBB`;
 * `weight` (0–10) is the platform's density weight, used to thin dense stretches.
 * `text` is plain text with control and invisible characters removed.
 */
export const danmakuItemSchema = z
  .object({
    timeMs: msSchema,
    mode: z.enum(DANMAKU_MODES),
    color: z.number().int().min(0).max(0xffffff),
    weight: z.number().int().min(0).max(10),
    text: z.string().min(1).max(DANMAKU_TEXT_MAX_CHARS),
  })
  .strict();
export type DanmakuItem = z.infer<typeof danmakuItemSchema>;

export const danmakuSnapshotSchema = z
  .object({ fetchedAt: msSchema, count: z.number().int().nonnegative(), items: z.array(danmakuItemSchema) })
  .strict();
export type DanmakuSnapshot = z.infer<typeof danmakuSnapshotSchema>;

/**
 * `GET /api/contents/:id/danmaku`: `supported` is whether the Content's platform offers
 * danmaku at all; `snapshot` is absent until a fetch succeeded. Items are in time order.
 */
export const danmakuSnapshotDtoSchema = z
  .object({ supported: z.boolean(), snapshot: danmakuSnapshotSchema.exactOptional() })
  .strict();
export type DanmakuSnapshotDto = z.infer<typeof danmakuSnapshotDtoSchema>;

/**
 * `POST /api/contents/:id/danmaku/fetch`: `fetched` replaced the snapshot; `empty` means the
 * request worked and the video has no danmaku (the snapshot is replaced by an empty one);
 * `failed` sent nothing usable back, kept the previous snapshot and says why in `error`.
 * `snapshot` is the snapshot as it stands afterwards.
 */
export const DANMAKU_FETCH_RESULTS = ["fetched", "empty", "failed"] as const;
export type DanmakuFetchResult = (typeof DANMAKU_FETCH_RESULTS)[number];
export const danmakuFetchResultDtoSchema = z
  .object({
    result: z.enum(DANMAKU_FETCH_RESULTS),
    snapshot: danmakuSnapshotSchema.exactOptional(),
    /** Present when `result` is `failed`. */
    error: appErrorSchema.exactOptional(),
    /** The platform answered with more items than Amber keeps; items were dropped, lowest weight first. */
    truncated: z.literal(true).exactOptional(),
  })
  .strict();
export type DanmakuFetchResultDto = z.infer<typeof danmakuFetchResultDtoSchema>;

/** The danmaku summary a Content detail carries when its platform offers danmaku. */
export const contentDanmakuSummarySchema = z
  .object({ fetchedAt: msSchema.exactOptional(), count: z.number().int().nonnegative().exactOptional() })
  .strict();
export type ContentDanmakuSummary = z.infer<typeof contentDanmakuSummarySchema>;
