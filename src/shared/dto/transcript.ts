import { z } from "zod";
import { transcriptRevisionDtoSchema } from "./content.ts";
import { modelRefSchema } from "./model-ref.ts";
import { SPEAKER_REVIEW_RESOLUTIONS, SPEAKER_REVIEW_STATES } from "../speakers.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();

export const transcriptSegmentDtoSchema = z.object({
  id: idSchema,
  revisionId: idSchema,
  ordinal: z.number().int().nonnegative(),
  startMs: msSchema,
  endMs: msSchema,
  text: z.string(),
  words: z.array(z.object({ text: z.string(), startMs: msSchema, endMs: msSchema })).exactOptional(),
  speakerId: z.string().exactOptional(),
  /** Semantic paragraph start marked by proofreading; absent on revisions without marks. */
  paragraphStart: z.boolean().exactOptional(),
  sourceSegmentIds: z.array(idSchema),
});
export type TranscriptSegmentDto = z.infer<typeof transcriptSegmentDtoSchema>;

/** `GET /api/transcript/revisions/:rid/segments`: one page in `ordinal` order. */
export const transcriptSegmentPageDtoSchema = z.object({
  revision: transcriptRevisionDtoSchema,
  items: z.array(transcriptSegmentDtoSchema),
  nextCursor: z.string().exactOptional(),
});
export type TranscriptSegmentPageDto = z.infer<typeof transcriptSegmentPageDtoSchema>;

/**
 * One sentence of a draft. `id` is the client's own handle for it across autosaves; the
 * committed `manual` revision always gets new segment ids. Timing, sources and speakers are
 * only checked on commit. Invariant: a committed revision and its segments never change, and
 * every segment id is globally unique.
 *
 * `speakerId`: a speaker of the Content, `null` = unassigned; absent (a draft saved before
 * drafts carried speakers) = the speaker of the first source sentence. `speakerReview` is how
 * applying speakers left the sentence; it lives in the draft only and never reaches a revision.
 */
export const transcriptDraftSegmentSchema = z
  .object({
    id: idSchema.exactOptional(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    text: z.string(),
    sourceSegmentIds: z.array(idSchema),
    speakerId: idSchema.nullable().exactOptional(),
    speakerReview: z.enum(SPEAKER_REVIEW_STATES).exactOptional(),
  })
  .strict();

/**
 * A draft version a write expects: the one last read or written, `null` when there must be
 * no draft yet. A mismatch is `conflict.draft_changed`.
 */
export const draftVersionSchema = z.number().int().positive();
export const expectedDraftVersionSchema = draftVersionSchema.nullable();

/** `PUT /api/contents/:id/transcript/draft`: replaces the Content's single transcript draft. */
export const transcriptDraftRequestSchema = z
  .object({
    baseRevisionId: idSchema,
    expectedVersion: expectedDraftVersionSchema,
    segments: z.array(transcriptDraftSegmentSchema),
  })
  .strict();
export type TranscriptDraftRequest = z.infer<typeof transcriptDraftRequestSchema>;

export const transcriptDraftDtoSchema = z.object({
  id: idSchema,
  contentId: idSchema,
  baseRevisionId: idSchema,
  version: draftVersionSchema,
  segments: z.array(transcriptDraftSegmentSchema),
  updatedAt: msSchema,
});
export type TranscriptDraftDto = z.infer<typeof transcriptDraftDtoSchema>;

/**
 * `POST /api/contents/:id/transcript/draft/commit`: commits the draft as a `manual` revision
 * that becomes the primary transcript. Refused with `conflict.draft_changed` when the draft is
 * no longer at `draftVersion`, and with `conflict.primary_changed` when the primary is no
 * longer `expectedPrimaryRevisionId`; never a silent overwrite.
 */
export const draftCommitRequestSchema = z
  .object({
    expectedPrimaryRevisionId: idSchema,
    draftVersion: draftVersionSchema,
    /**
     * What to do with sentences still marked `needs_review`: keep their suggested speakers as
     * confirmed by the user, or unassign them. Absent = unassign, so an unconfirmed speaker is
     * never taken as confirmed silently.
     */
    speakerReview: z.enum(SPEAKER_REVIEW_RESOLUTIONS).exactOptional(),
  })
  .strict();
export type DraftCommitRequest = z.infer<typeof draftCommitRequestSchema>;

export const SEGMENT_MAP_METHODS = ["lineage", "overlap", "nearest", "none"] as const;
export type SegmentMapMethod = (typeof SEGMENT_MAP_METHODS)[number];

/** `GET /api/transcript/segments/:sid/map?targetRevision=`. */
export const segmentMapDtoSchema = z.object({
  segmentId: idSchema.nullable(),
  method: z.enum(SEGMENT_MAP_METHODS),
});
export type SegmentMapDto = z.infer<typeof segmentMapDtoSchema>;

/** `POST /api/contents/:id/transcript/proofread` and `POST /api/contents/:id/chapters/regenerate`. */
export const derivedTaskRequestSchema = z.object({ modelRef: modelRefSchema.exactOptional() }).strict();
export type DerivedTaskRequest = z.infer<typeof derivedTaskRequestSchema>;
