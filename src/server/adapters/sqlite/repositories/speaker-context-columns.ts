import { z } from "zod";
import type { ChatContextUsed, ChatSpeakerBasis } from "../../../domain/chat.ts";
import { speakerContextSnapshotSchema, type SpeakerContextSnapshot } from "../../../domain/speaker-context.ts";

const speakerBasesSchema = z.array(
  z.object({
    transcriptRevisionId: z.string().min(1),
    speakerContext: speakerContextSnapshotSchema,
    citedSegmentIds: z.array(z.string()),
  }),
);

const contextUsedSchema = z.object({
  mode: z.enum(["full", "retrieval", "metadata"]),
  speakerClips: z.literal(true).optional(),
  summaryOmitted: z.literal(true).optional(),
});

function parsed<T>(text: string | null, schema: z.ZodType<T>): T | null {
  if (text === null) {
    return null;
  }
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * `speaker_context_json` of an artifact, partial or chat answer. The column only ever says
 * how a stored result was produced, so a value of another shape (a restored backup bypasses
 * every writer) reads as absent — the result then shows no speaker state — instead of
 * making the whole row unreadable.
 */
export function speakerContextColumn(text: string | null): SpeakerContextSnapshot | null {
  return parsed(text, speakerContextSnapshotSchema);
}

/** `chat_compaction.speaker_bases_json`, read like `speakerContextColumn`. */
export function speakerBasesColumn(text: string | null): ChatSpeakerBasis[] | null {
  return parsed(text, speakerBasesSchema) as ChatSpeakerBasis[] | null;
}

/** `chat_message.context_used_json`, read like `speakerContextColumn`: another shape reads as absent. */
export function contextUsedColumn(text: string | null): ChatContextUsed | null {
  return parsed(text, contextUsedSchema) as ChatContextUsed | null;
}
