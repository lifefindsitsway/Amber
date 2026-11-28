import { z } from "zod";

/** `stored`: download the stored cover links; `retry`: retry the last job's temporary failures; `refresh`: re-read platform metadata for expired links, then download. */
export const COVER_BACKFILL_MODES = ["stored", "refresh", "retry"] as const;
export const COVER_BACKFILL_STATES = ["running", "stopping", "stopped", "completed", "aborted_disk"] as const;
/** Failure groups shown to the user. */
export const COVER_BACKFILL_FAILURE_REASONS = ["link_expired", "platform_unreachable", "platform_refused", "image_rejected", "proxy_unavailable", "disk_low"] as const;
export type CoverBackfillFailureReason = (typeof COVER_BACKFILL_FAILURE_REASONS)[number];

export const coverBackfillStartRequestSchema = z
  .object({
    mode: z.enum(COVER_BACKFILL_MODES),
    /** Continue after this content id (the previous job's cursor). */
    afterId: z.string().min(1).exactOptional(),
    /** Required by `retry` and `refresh`: the job whose failures are taken up. */
    jobId: z.string().min(1).exactOptional(),
  })
  .strict();
export type CoverBackfillStartRequest = z.infer<typeof coverBackfillStartRequestSchema>;

const count = z.number().int().nonnegative();

export const coverBackfillJobDtoSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(COVER_BACKFILL_MODES),
    state: z.enum(COVER_BACKFILL_STATES),
    total: count,
    processed: count,
    saved: count,
    skipped: count,
    failed: z.partialRecord(z.enum(COVER_BACKFILL_FAILURE_REASONS), count),
    /** Failures `retry` would take up (temporary ones). */
    retryable: count,
    /** Expired links of platforms that can re-read them, which `refresh` would take up. */
    refreshable: count,
    /** Candidates after this job's cursor. */
    remaining: count,
    /** The cursor to pass as `afterId` to continue. */
    nextAfterId: z.string().min(1).exactOptional(),
  })
  .strict();
export type CoverBackfillJobDto = z.infer<typeof coverBackfillJobDtoSchema>;

/** `GET /api/covers/backfill` and the answer of every backfill mutation. */
export const coverBackfillStatusDtoSchema = z
  .object({
    candidates: count,
    job: coverBackfillJobDtoSchema.exactOptional(),
  })
  .strict();
export type CoverBackfillStatusDto = z.infer<typeof coverBackfillStatusDtoSchema>;
