import { z } from "zod";
import { SPEAKER_PALETTE_SIZE } from "../defaults.ts";
import { segmentIdSchema } from "../ids.ts";
import { SPEAKER_CONTEXT_STATES } from "./speaker-context.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();

/** Upper bound of a search query's length; longer input is a client error, not a query. */
export const SEARCH_QUERY_MAX_CHARS = 200;

/** `GET /api/search?q=&scope=`; `scope` defaults to `global`. */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_CHARS),
    scope: z.string().min(1).optional(),
  })
  .strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * A highlighted span of `snippet`: `[start, end)` in UTF-16 code units, the unit of
 * JavaScript string indices. Hits carry offsets rather than HTML.
 */
export const searchRangeSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() });
export type SearchRange = z.infer<typeof searchRangeSchema>;

const hitText = { snippet: z.string(), ranges: z.array(searchRangeSchema) };

/** A Content matched by its title or by an imported reference text; reference-text hits group here. */
export const contentHitDtoSchema = z.object({
  contentId: idSchema,
  title: z.string().optional(),
  matchedIn: z.enum(["title", "reference"]),
  ...hitText,
});
export type ContentHitDto = z.infer<typeof contentHitDtoSchema>;

const speakerColorSchema = z.number().int().min(0).max(SPEAKER_PALETTE_SIZE - 1);

/** Who a matched sentence is given to. `confirmed`: the revision's speakers are reviewed; otherwise the name is only a label. */
export const hitSpeakerDtoSchema = z.object({
  id: idSchema,
  ordinal: z.number().int().positive(),
  name: z.string().min(1).optional(),
  colorIndex: speakerColorSchema,
  confirmed: z.boolean(),
});
export type HitSpeakerDto = z.infer<typeof hitSpeakerDtoSchema>;

/** A sentence of a Content's primary revision; opens `?tab=transcript&revision=&segment=`. */
export const segmentHitDtoSchema = z.object({
  contentId: idSchema,
  contentTitle: z.string().optional(),
  transcriptRevisionId: idSchema,
  segmentId: segmentIdSchema,
  startMs: msSchema,
  speaker: hitSpeakerDtoSchema.optional(),
  ...hitText,
});
export type SegmentHitDto = z.infer<typeof segmentHitDtoSchema>;

/** The current revision of one of a Content's summaries. */
export const summaryHitDtoSchema = z.object({
  contentId: idSchema,
  contentTitle: z.string().optional(),
  artifactId: idSchema,
  templateId: idSchema,
  summaryRevisionId: idSchema,
  /** Present on a summary generated with speakers; anything but `consistent` means its attributions may no longer hold. */
  speakerContextState: z.enum(SPEAKER_CONTEXT_STATES).optional(),
  ...hitText,
});
export type SummaryHitDto = z.infer<typeof summaryHitDtoSchema>;

/** A Collection matched by its name or description; only in the `global` scope. */
export const collectionHitDtoSchema = z.object({
  collectionId: idSchema,
  name: z.string(),
  ...hitText,
});
export type CollectionHitDto = z.infer<typeof collectionHitDtoSchema>;

/**
 * A speaker whose name matches the query, in a Content whose primary revision names that
 * speaker. A name match only: the same name in two Contents is two hits, never one person.
 * Opens the Content's reading view filtered to the speaker.
 */
export const speakerHitDtoSchema = z.object({
  contentId: idSchema,
  contentTitle: z.string().optional(),
  speakerId: idSchema,
  ordinal: z.number().int().positive(),
  name: z.string().min(1),
  colorIndex: speakerColorSchema,
  /** Sentences of the primary revision given to the speaker. */
  sentences: z.number().int().nonnegative(),
});
export type SpeakerHitDto = z.infer<typeof speakerHitDtoSchema>;

/** Each group holds at most `SEARCH_GROUP_LIMIT` hits, best first. `speakers` only in the `global` and `library` scopes, and only when a name matches. */
export const searchResultDtoSchema = z.object({
  contents: z.array(contentHitDtoSchema),
  segments: z.array(segmentHitDtoSchema),
  summaries: z.array(summaryHitDtoSchema),
  collections: z.array(collectionHitDtoSchema),
  speakers: z.array(speakerHitDtoSchema).optional(),
});
export type SearchResultDto = z.infer<typeof searchResultDtoSchema>;
