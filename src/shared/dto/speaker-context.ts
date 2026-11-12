import { z } from "zod";

const idSchema = z.string().min(1);

/**
 * How the speakers an AI result was generated with compare with the speakers as they are
 * now. It is derived on read and never stored, and it is separate from freshness: a result
 * can be fresh and still credit a statement to the wrong person. Listed most severe first;
 * a result reports the first state that holds.
 *
 * - `attribution_changed`: a sentence the result read now belongs to someone else.
 * - `evidence_removed`: a sentence the result cites is gone from the current transcript.
 * - `unknown`: the two transcripts cannot be compared sentence by sentence.
 * - `names_changed`: a speaker would be presented to the model under another label now.
 * - `unconfirmed`: the current transcript's speakers are not reviewed.
 * - `consistent`: none of the above.
 */
export const SPEAKER_CONTEXT_STATES = ["attribution_changed", "evidence_removed", "unknown", "names_changed", "unconfirmed", "consistent"] as const;
export type SpeakerContextState = (typeof SPEAKER_CONTEXT_STATES)[number];

/**
 * The speaker context of a result or of a chat answer: who the model was told the speakers
 * were (`label` is the text it saw), and how that compares with now. Absent on anything
 * generated without speakers.
 */
export const speakerContextDtoSchema = z.object({
  state: z.enum(SPEAKER_CONTEXT_STATES),
  speakers: z.array(z.object({ id: idSchema, label: z.string().min(1) })),
  /** With `attribution_changed`: how many sentences changed hands. */
  changedSentences: z.number().int().positive().exactOptional(),
  /** With `evidence_removed`: how many cited sentences are gone. */
  removedCitations: z.number().int().positive().exactOptional(),
  /** With `names_changed`: the speakers whose label differs, as it was and as it would be now. */
  renamed: z.array(z.object({ id: idSchema, was: z.string().min(1), now: z.string().min(1) })).exactOptional(),
});
export type SpeakerContextDto = z.infer<typeof speakerContextDtoSchema>;
