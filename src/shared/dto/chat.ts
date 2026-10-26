import { z } from "zod";
import { CHAT_DELETE_TURNS_MAX, CHAT_MESSAGE_MAX_CHARS, DISPLAY_NAME_MAX_CHARS } from "../defaults.ts";
import { CHAT_MESSAGE_STATUSES, WEB_SEARCH_MODES, WEB_SEARCH_REASONS, WEB_SEARCH_STATUSES } from "../enums.ts";
import { appErrorSchema } from "../errors.ts";
import { segmentIdSchema } from "../ids.ts";
import { citationDtoSchema } from "./citation.ts";
import { modelRefSchema } from "./model-ref.ts";
import { modelRefSnapshotDtoSchema } from "./usage.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();


/** A sentence quoted from the transcript ("explain"); the server reads its text itself. */
export const chatQuoteSchema = z
  .object({
    transcriptRevisionId: idSchema,
    segmentId: segmentIdSchema,
  })
  .strict();
export type ChatQuote = z.infer<typeof chatQuoteSchema>;

/** `POST /api/contents/:id/chat/messages`. */
export const chatMessageRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
    modelRef: modelRefSchema,
    /** Absent: the Content's latest thread, created when there is none. */
    threadId: idSchema.optional(),
    /** Absent: `off`. */
    webSearch: z.enum(WEB_SEARCH_MODES).optional(),
    quote: chatQuoteSchema.optional(),
    /** Player position when the player tracks time; names the current chapter. */
    positionMs: msSchema.optional(),
  })
  .strict();
export type ChatMessageRequest = z.infer<typeof chatMessageRequestSchema>;

/**
 * `POST /api/contents/:id/chat/messages/:mid/retry`: answers the last turn again. `modelRef`
 * absent = the model of the answer being replaced.
 */
export const chatRetryRequestSchema = z
  .object({
    modelRef: modelRefSchema.optional(),
    webSearch: z.enum(WEB_SEARCH_MODES).optional(),
    positionMs: msSchema.optional(),
  })
  .strict();
export type ChatRetryRequest = z.infer<typeof chatRetryRequestSchema>;

/** `POST /api/contents/:id/chat/turns/delete`: each id stands for the whole turn it belongs to. */
export const chatTurnsDeleteRequestSchema = z
  .object({ messageIds: z.array(idSchema).min(1).max(CHAT_DELETE_TURNS_MAX) })
  .strict();
export type ChatTurnsDeleteRequest = z.infer<typeof chatTurnsDeleteRequestSchema>;

/** Every message that went, user questions and answers alike. */
export const chatTurnsDeleteResultSchema = z.object({ deleted: z.array(idSchema) });
export type ChatTurnsDeleteResult = z.infer<typeof chatTurnsDeleteResultSchema>;

/** `GET /api/contents/:id/chat?threadId=&providerProfileId=&modelId=`: the model ids go both or neither. */
export const chatQuerySchema = z
  .object({
    threadId: idSchema.optional(),
    providerProfileId: idSchema.optional(),
    modelId: idSchema.optional(),
  })
  .strict()
  .refine((query) => (query.providerProfileId === undefined) === (query.modelId === undefined), {
    message: "providerProfileId and modelId go together",
  });
export type ChatQuery = z.infer<typeof chatQuerySchema>;

/** `metadata`: no transcript yet, answers rest on the basic facts and the model's own knowledge. */
export const CHAT_CONTEXT_MODES = ["full", "retrieval", "metadata", "unavailable"] as const;
export type ChatContextMode = (typeof CHAT_CONTEXT_MODES)[number];

/** Why the context is `unavailable`. */
export const CHAT_CONTEXT_REASONS = ["no_model", "context_window_unknown"] as const;
export type ChatContextReason = (typeof CHAT_CONTEXT_REASONS)[number];

export const chatContextDtoSchema = z.object({
  mode: z.enum(CHAT_CONTEXT_MODES),
  /** A planning estimate for the label's hover, never a precise count. */
  estimatedTokens: z.number().int().nonnegative().optional(),
  reason: z.enum(CHAT_CONTEXT_REASONS).optional(),
});
export type ChatContextDto = z.infer<typeof chatContextDtoSchema>;

/** One web page an answer was given, with the excerpt the model actually saw. */
export const webSourceDtoSchema = z.object({
  /** Referenced from the answer's text as `[[web:<id>]]`. */
  id: idSchema,
  /** 1-based position within this answer; shown as `[n]`. */
  index: z.number().int().positive(),
  url: z.string().min(1),
  title: z.string(),
  excerpt: z.string(),
  publishedAt: msSchema.optional(),
  fetchedAt: msSchema,
});
export type WebSourceDto = z.infer<typeof webSourceDtoSchema>;

const countSchema = z.number().int().nonnegative();

/**
 * The web search of one answer: planned queries, requests actually sent, requests that
 * succeeded, and the sources handed to the model. `reason` says why it was skipped or dropped.
 */
export const chatWebSearchDtoSchema = z.object({
  mode: z.enum(["auto", "force"]),
  status: z.enum(WEB_SEARCH_STATUSES),
  reason: z.enum(WEB_SEARCH_REASONS).optional(),
  planned: countSchema,
  requested: countSchema,
  succeeded: countSchema,
  queries: z.array(z.string()),
  sources: z.array(webSourceDtoSchema),
  error: appErrorSchema.optional(),
});
export type ChatWebSearchDto = z.infer<typeof chatWebSearchDtoSchema>;

/**
 * One message. Citations appear in `text` as canonical `[[seg:<segmentId>]]` markers and
 * are indexed in `citations`; web citations appear as `[[web:<sourceId>]]` and resolve only
 * against this message's `webSearch.sources`. A user message's `quote` is the sentence it
 * asked about. An assistant message without `contextTranscriptRevisionId` was answered
 * without a transcript.
 */
export const chatMessageDtoSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  status: z.enum(CHAT_MESSAGE_STATUSES),
  modelRef: modelRefSnapshotDtoSchema.optional(),
  contextTranscriptRevisionId: idSchema.optional(),
  citations: z.array(citationDtoSchema),
  suggestions: z.array(z.string()).optional(),
  quote: chatQuoteSchema.optional(),
  webSearch: chatWebSearchDtoSchema.optional(),
  /** On a retry's answer: the answer it replaces (gone once the retry succeeded). */
  replacesMessageId: idSchema.optional(),
  /** Why a `failed` answer failed. */
  error: appErrorSchema.optional(),
  createdAt: msSchema,
  /** When an answer reached its final state; absent while streaming and on answers stored before it was recorded. */
  finishedAt: msSchema.optional(),
});
export type ChatMessageDto = z.infer<typeof chatMessageDtoSchema>;

/**
 * `title` is what the thread is called: the user's own `customTitle` when set, else the
 * first line of its first question; absent while it has neither. A pinned thread lists first.
 */
export const chatThreadDtoSchema = z.object({
  id: idSchema,
  title: z.string().optional(),
  customTitle: z.string().optional(),
  pinnedAt: msSchema.optional(),
  createdAt: msSchema,
  lastMessageAt: msSchema.optional(),
  currentCompactionId: idSchema.optional(),
});
export type ChatThreadDto = z.infer<typeof chatThreadDtoSchema>;

/**
 * `PATCH /api/contents/:id/chat/threads/:tid`: `title` renames (`null` or blank restores the
 * title taken from the first question), `pinned` pins or unpins; answers `{ thread }`.
 */
export const chatThreadPatchRequestSchema = z
  .object({ title: z.string().trim().max(DISPLAY_NAME_MAX_CHARS).nullable().optional(), pinned: z.boolean().optional() })
  .strict()
  .refine((body) => body.title !== undefined || body.pinned !== undefined, { message: "nothing to change" });
export type ChatThreadPatchRequest = z.infer<typeof chatThreadPatchRequestSchema>;

/** `GET /api/contents/:id/chat/threads`: pinned first (latest pin first), then newest first. */
export const chatThreadsDtoSchema = z.object({ threads: z.array(chatThreadDtoSchema) });
export type ChatThreadsDto = z.infer<typeof chatThreadsDtoSchema>;

/** `POST /api/contents/:id/chat/threads`: the latest thread when it is still empty, else a new one. */
export const chatThreadCreatedDtoSchema = z.object({ thread: chatThreadDtoSchema });
export type ChatThreadCreatedDto = z.infer<typeof chatThreadCreatedDtoSchema>;

/**
 * `GET /api/contents/:id/chat`: one thread's whole history, oldest first, including every
 * attempt of a turn; `thread` is null while the Content has none.
 */
export const chatDtoSchema = z.object({
  thread: chatThreadDtoSchema.nullable(),
  messages: z.array(chatMessageDtoSchema),
  context: chatContextDtoSchema,
});
export type ChatDto = z.infer<typeof chatDtoSchema>;

/** `Idempotency-Key` replay of a POST: the assistant message as stored. */
export const chatReplayDtoSchema = z.object({ message: chatMessageDtoSchema });
export type ChatReplayDto = z.infer<typeof chatReplayDtoSchema>;

/**
 * The SSE events of a chat answer: `answer.delta` carries canonical markers
 * only; `citation` announces each newly cited sentence with its start time; the control
 * section never reaches the client, only `suggestions`; `done` closes the stream.
 */
export const chatStreamEventSchemas = {
  "search.started": z.object({ planned: countSchema, queries: z.array(z.string()) }),
  "search.done": z.object({
    status: z.enum(WEB_SEARCH_STATUSES),
    reason: z.enum(WEB_SEARCH_REASONS).optional(),
    requested: countSchema,
    succeeded: countSchema,
    sources: z.array(webSourceDtoSchema),
    error: appErrorSchema.optional(),
  }),
  "answer.delta": z.object({ delta: z.string() }),
  citation: citationDtoSchema.extend({ startMs: msSchema }),
  suggestions: z.object({ items: z.array(z.string()) }),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }),
  done: z.object({
    threadId: idSchema,
    userMessageId: idSchema,
    messageId: idSchema,
    status: z.enum(CHAT_MESSAGE_STATUSES),
    error: appErrorSchema.optional(),
  }),
} as const;
export type ChatStreamEventType = keyof typeof chatStreamEventSchemas;
export type ChatStreamEvent = { [K in ChatStreamEventType]: { type: K; data: z.infer<(typeof chatStreamEventSchemas)[K]> } }[ChatStreamEventType];
