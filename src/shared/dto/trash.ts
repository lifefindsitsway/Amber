import { z } from "zod";
import { contentSourceDtoSchema } from "./content.ts";

const idSchema = z.string().min(1);
const epochMsSchema = z.number().int().nonnegative();

/**
 * One Content in the trash (`GET /api/trash`). `purgeAt` is
 * `trashedAt + TRASH_RETENTION_DAYS`; `expired` means it can no longer be restored and only
 * waits for the sweep. `mediaBytes` sums the Content's available files Amber would delete.
 */
export const trashItemDtoSchema = z.object({
  id: idSchema,
  title: z.string().exactOptional(),
  source: contentSourceDtoSchema,
  coverUrl: z.string().exactOptional(),
  /** Version of the local cover copy, read through the trash cover route; absent when there is none. */
  coverImageVersion: z.number().int().positive().exactOptional(),
  durationMs: z.number().int().nonnegative().exactOptional(),
  trashedAt: epochMsSchema,
  purgeAt: epochMsSchema,
  expired: z.boolean(),
  mediaBytes: z.number().int().nonnegative(),
});
export type TrashItemDto = z.infer<typeof trashItemDtoSchema>;

export const trashListDtoSchema = z.object({
  items: z.array(trashItemDtoSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().exactOptional(),
});
export type TrashListDto = z.infer<typeof trashListDtoSchema>;

/** `DELETE /api/trash`: every entry is purged in its own transaction; failures do not stop the rest. */
export const trashPurgeAllDtoSchema = z.object({
  purgedIds: z.array(idSchema),
  failed: z.array(z.object({ contentId: idSchema, code: z.string().min(1) })),
});
export type TrashPurgeAllDto = z.infer<typeof trashPurgeAllDtoSchema>;

/** Contents named once each; the service rejects more than `CONTENT_TRASH_BATCH_MAX` with `invalid_request.batch_too_large`. */
const contentIdListSchema = z
  .array(idSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate content id" });

/**
 * Where a Content stands before it is moved to the trash, most binding first:
 * `missing` (not found for this user), `trashed` (already in the trash, nothing to do),
 * `blocked` (an unfinished collection summary froze it as input; deleting waits for that
 * summary), `tasks` (its own Tasks are unfinished and must be cancelled first), `ready`.
 */
export const CONTENT_TRASH_PLAN_STATES = ["ready", "tasks", "blocked", "trashed", "missing"] as const;
export type ContentTrashPlanState = (typeof CONTENT_TRASH_PLAN_STATES)[number];

/** `POST /api/contents/trash-plan`: read-only. */
export const contentTrashPlanRequestSchema = z.object({ contentIds: contentIdListSchema }).strict();
export type ContentTrashPlanRequest = z.infer<typeof contentTrashPlanRequestSchema>;

export const contentTrashPlanItemDtoSchema = z.object({
  contentId: idSchema,
  /** Absent for `missing` and for Contents without a title yet. */
  title: z.string().exactOptional(),
  state: z.enum(CONTENT_TRASH_PLAN_STATES),
  /** The Content's own unfinished Tasks; present when `state` is `tasks`. */
  unfinishedTaskCount: z.number().int().positive().exactOptional(),
  /** The collections whose unfinished summary froze it; present when `state` is `blocked`. Names of deleted collections are absent. */
  blockingCollections: z.array(z.object({ id: idSchema, name: z.string().exactOptional() })).exactOptional(),
});
export type ContentTrashPlanItemDto = z.infer<typeof contentTrashPlanItemDtoSchema>;

/** In request order. */
export const contentTrashPlanDtoSchema = z.object({ items: z.array(contentTrashPlanItemDtoSchema) });
export type ContentTrashPlanDto = z.infer<typeof contentTrashPlanDtoSchema>;

/** `POST /api/contents/trash`. `cancelTasks` cancels the Contents' own unfinished Tasks first; never another collection's summary. */
export const contentTrashRequestSchema = z.object({ contentIds: contentIdListSchema, cancelTasks: z.boolean() }).strict();
export type ContentTrashRequest = z.infer<typeof contentTrashRequestSchema>;

/**
 * Why one Content was not moved: `tasks` (unfinished Tasks and `cancelTasks` was false, or a
 * Task started meanwhile), `stopping` (cancelled, but its work had not stopped within
 * `CONTENT_TRASH_DRAIN_TIMEOUT_MS`), `summarizing` (frozen by an unfinished collection
 * summary), `missing`, `internal`.
 */
export const CONTENT_TRASH_FAILURE_REASONS = ["tasks", "stopping", "summarizing", "missing", "internal"] as const;
export type ContentTrashFailureReason = (typeof CONTENT_TRASH_FAILURE_REASONS)[number];

/** Each Content is moved in its own transaction; one failing does not stop the rest. Repeating the request is safe. */
export const contentTrashResultDtoSchema = z.object({
  trashedIds: z.array(idSchema),
  alreadyTrashedIds: z.array(idSchema),
  failed: z.array(z.object({ contentId: idSchema, reason: z.enum(CONTENT_TRASH_FAILURE_REASONS) })),
  /** Tasks this request cancelled, whether or not their Content was then moved; cancelling cannot be undone. */
  cancelledTaskCount: z.number().int().nonnegative(),
});
export type ContentTrashResultDto = z.infer<typeof contentTrashResultDtoSchema>;

/** `POST /api/trash/restore`; at most `CONTENT_TRASH_BATCH_MAX` ids. */
export const trashRestoreRequestSchema = z.object({ contentIds: contentIdListSchema }).strict();
export type TrashRestoreRequest = z.infer<typeof trashRestoreRequestSchema>;

export const TRASH_RESTORE_FAILURE_REASONS = ["expired", "missing", "internal"] as const;
export type TrashRestoreFailureReason = (typeof TRASH_RESTORE_FAILURE_REASONS)[number];

/** Each Content is restored in its own transaction. `alreadyActiveIds` were not in the trash. */
export const trashRestoreResultDtoSchema = z.object({
  restoredIds: z.array(idSchema),
  alreadyActiveIds: z.array(idSchema),
  failed: z.array(z.object({ contentId: idSchema, reason: z.enum(TRASH_RESTORE_FAILURE_REASONS) })),
});
export type TrashRestoreResultDto = z.infer<typeof trashRestoreResultDtoSchema>;
