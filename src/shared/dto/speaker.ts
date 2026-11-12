import { z } from "zod";
import { SPEAKER_PALETTE_SIZE } from "../defaults.ts";
import { DIARIZATION_MODES, DIARIZATION_STATUSES } from "../speakers.ts";

const idSchema = z.string().min(1);
const colorIndexSchema = z.number().int().min(0).max(SPEAKER_PALETTE_SIZE - 1);

/** Image types a speaker photo may have; the server decides the type from the bytes, not from this field. */
export const SPEAKER_AVATAR_MIMES = ["image/webp", "image/png", "image/jpeg"] as const;
export type SpeakerAvatarMime = (typeof SPEAKER_AVATAR_MIMES)[number];

/**
 * One speaker of a Content. `avatarVersion` is present when the speaker has a photo and
 * changes with every new one, so a client caches the photo by it. `used`: some unarchived
 * revision or the Content's transcript draft names the speaker; unused speakers are hidden.
 * `nameConfirmed`: the name was saved as the person's confirmed name, which is what lets an
 * AI request use it; absent = not confirmed. `comparisonOnly`: only transcriptions made for
 * comparison name the speaker, so rosters and pickers leave it out; absent = false.
 */
export const speakerDtoSchema = z.object({
  id: idSchema,
  ordinal: z.number().int().positive(),
  name: z.string().min(1).exactOptional(),
  colorIndex: colorIndexSchema,
  avatarVersion: z.number().int().positive().exactOptional(),
  used: z.boolean(),
  nameConfirmed: z.boolean().exactOptional(),
  comparisonOnly: z.boolean().exactOptional(),
});
export type SpeakerDto = z.infer<typeof speakerDtoSchema>;

/** `GET /api/contents/:id/speakers`: in `ordinal` order. */
export const speakerListDtoSchema = z.object({ items: z.array(speakerDtoSchema) });
export type SpeakerListDto = z.infer<typeof speakerListDtoSchema>;

/**
 * `POST /api/contents/:id/speakers`: a new identity; the name is normalized and may be left
 * out. `nameConfirmed: true` records the name as confirmed by the user; without it a name is
 * stored unconfirmed, whoever the caller is.
 */
export const speakerCreateRequestSchema = z
  .object({ name: z.string().exactOptional(), colorIndex: colorIndexSchema.exactOptional(), nameConfirmed: z.boolean().exactOptional() })
  .strict();
export type SpeakerCreateRequest = z.infer<typeof speakerCreateRequestSchema>;

/** A photo upload: base64 of the bytes. `null` in a patch removes the photo. */
export const speakerAvatarUploadSchema = z.object({ data: z.base64(), mime: z.enum(SPEAKER_AVATAR_MIMES) }).strict();

/**
 * `PATCH /api/contents/:id/speakers/:sid`: change the name (`null` or blank = unnamed), the
 * color or the photo; or copy another speaker of the same user, a snapshot of its name,
 * color and photo as they are now. A request that writes a name (the current one re-sent
 * included, or a copied one) confirms it only with `nameConfirmed: true`; a name changed
 * without it becomes unconfirmed. Colour and photo changes, and the flag sent without a
 * name, leave the confirmation alone.
 */
export const speakerPatchRequestSchema = z.union([
  z
    .object({
      name: z.string().nullable().exactOptional(),
      colorIndex: colorIndexSchema.exactOptional(),
      avatar: speakerAvatarUploadSchema.nullable().exactOptional(),
      nameConfirmed: z.boolean().exactOptional(),
    })
    .strict(),
  z.object({ copyFrom: z.object({ contentId: idSchema, speakerId: idSchema }).strict(), nameConfirmed: z.boolean().exactOptional() }).strict(),
]);
export type SpeakerPatchRequest = z.infer<typeof speakerPatchRequestSchema>;

/** One suggestion: a named speaker of another of the user's Contents, most recently changed first. */
export const speakerSuggestionDtoSchema = z.object({
  contentId: idSchema,
  speakerId: idSchema,
  name: z.string().min(1),
  colorIndex: colorIndexSchema,
  avatarVersion: z.number().int().positive().exactOptional(),
  contentTitle: z.string().exactOptional(),
});
export type SpeakerSuggestionDto = z.infer<typeof speakerSuggestionDtoSchema>;

/** `GET /api/speakers/suggestions?q=`. */
export const speakerSuggestionListDtoSchema = z.object({ items: z.array(speakerSuggestionDtoSchema) });
export type SpeakerSuggestionListDto = z.infer<typeof speakerSuggestionListDtoSchema>;

/**
 * Speaker identification asked of a transcription. The speaker count is a hint whose meaning
 * depends on the model (a reference value or an upper bound); out of the model's range it is
 * refused, never clamped.
 */
export const diarizationRequestSchema = z
  .object({ mode: z.enum(DIARIZATION_MODES), speakerCount: z.number().int().positive().exactOptional() })
  .strict();
export type DiarizationRequest = z.infer<typeof diarizationRequestSchema>;

/** What an `asr` revision's `generation.diarization` records; absent on revisions made before it was recorded. */
export const asrDiarizationRecordSchema = z.object({
  status: z.enum(DIARIZATION_STATUSES),
  requestedSpeakerCount: z.number().int().positive().exactOptional(),
});
export type AsrDiarizationRecordDto = z.infer<typeof asrDiarizationRecordSchema>;
