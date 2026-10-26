import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatDtoSchema, chatThreadCreatedDtoSchema, chatThreadsDtoSchema, type ChatMessageDto, type ChatThreadDto, type ChatThreadPatchRequest } from "../../shared/dto/chat.ts";
import type { ModelRefDto } from "../../shared/dto/model-ref.ts";
import type { ProviderProfileDto } from "../../shared/dto/provider.ts";
import type { UserSettingsDto } from "../../shared/dto/settings.ts";
import { queryString } from "../api/queries.ts";
import { useApi } from "../api/context.tsx";

/**
 * How often the history is read again while an answer is still `streaming` on the server: a
 * stopped answer is stored as `interrupted` only once the server has seen the disconnect.
 */
const STREAMING_REFRESH_MS = 1000;

export const chatKeys = {
  all: (contentId: string) => ["chat", contentId] as const,
  threads: (contentId: string) => ["chat", contentId, "threads"] as const,
  /** Every read of one thread, whatever model it was read for; `""` = the latest thread. */
  threadAll: (contentId: string, threadId: string | undefined) => ["chat", contentId, "thread", threadId ?? ""] as const,
  thread: (contentId: string, threadId: string | undefined, modelRef: ModelRefDto | undefined) =>
    ["chat", contentId, "thread", threadId ?? "", modelRef?.providerProfileId ?? "", modelRef?.modelId ?? ""] as const,
};

/** A model the dialogue can use, with the label of the model selector. */
export interface ChatModelOption {
  modelRef: ModelRefDto;
  label: string;
}

export function modelKey(modelRef: ModelRefDto): string {
  return `${modelRef.providerProfileId}\u0000${modelRef.modelId}`;
}

/** Every model of a Profile with a stored credential, in the user's order. */
export function chatModelOptions(profiles: readonly ProviderProfileDto[]): ChatModelOption[] {
  return profiles
    .filter((profile) => profile.hasCredential)
    .flatMap((profile) =>
      profile.models.map((model) => ({ modelRef: { providerProfileId: profile.id, modelId: model.modelId }, label: `${profile.name} · ${model.modelId}` })),
    );
}

/** The selector's default: the last chat model, then the default model, then the first one listed. */
export function defaultChatModel(options: readonly ChatModelOption[], settings: UserSettingsDto | undefined): ModelRefDto | undefined {
  const listed = (modelRef: ModelRefDto | undefined): ModelRefDto | undefined =>
    modelRef === undefined ? undefined : options.find((option) => modelKey(option.modelRef) === modelKey(modelRef))?.modelRef;
  return listed(settings?.chatModelRef) ?? listed(settings?.defaultModelRef) ?? options[0]?.modelRef;
}

/** `GET /api/contents/:id/chat/threads`: the Content's threads, pinned first, then newest first. */
export function useChatThreads(contentId: string, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: chatKeys.threads(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}/chat/threads`, chatThreadsDtoSchema),
    enabled,
    staleTime: 0,
  });
}

/**
 * `PATCH /api/contents/:id/chat/threads/:tid`: renames or pins a thread. Afterwards the list
 * and every read thread are read again, since the server decides the order and the title.
 */
export function usePatchChatThread(contentId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: string; patch: ChatThreadPatchRequest }) =>
      client.patch(`/api/contents/${encodeURIComponent(contentId)}/chat/threads/${encodeURIComponent(input.threadId)}`, chatThreadCreatedDtoSchema, {
        body: input.patch,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.all(contentId) }),
  });
}

/**
 * `GET /api/contents/:id/chat` for one thread (absent: the latest) and the selected model:
 * history plus the context the next question would get. `poll` re-reads it while an answer
 * of that thread is still streaming on the server and this page is not streaming it itself.
 */
export function useChat(contentId: string, threadId: string | undefined, modelRef: ModelRefDto | undefined, options: { enabled: boolean; poll: boolean }) {
  const client = useApi();
  return useQuery({
    queryKey: chatKeys.thread(contentId, threadId, modelRef),
    queryFn: () =>
      client.get(
        `/api/contents/${encodeURIComponent(contentId)}/chat${queryString({ threadId, providerProfileId: modelRef?.providerProfileId, modelId: modelRef?.modelId })}`,
        chatDtoSchema,
      ),
    enabled: options.enabled,
    // The context depends on model settings edited elsewhere; read it afresh on every mount.
    staleTime: 0,
    refetchInterval: (query) =>
      options.poll && query.state.data?.messages.some((message) => message.status === "streaming") === true ? STREAMING_REFRESH_MS : false,
  });
}

/**
 * The thread opened when none is remembered: the latest created, as the server picks it when
 * asked without a thread id. Not the first listed, since a pinned thread lists above it.
 */
export function latestThread(threads: readonly ChatThreadDto[]): ChatThreadDto | undefined {
  return threads.reduce<ChatThreadDto | undefined>(
    (latest, item) => (latest === undefined || item.createdAt > latest.createdAt || (item.createdAt === latest.createdAt && item.id > latest.id) ? item : latest),
    undefined,
  );
}

/** The page-session key remembering which thread of a Content was open. */
export function threadStorageKey(contentId: string): string {
  return `amber.chat.thread:${contentId}`;
}

export function readStoredThread(contentId: string): string | undefined {
  try {
    return sessionStorage.getItem(threadStorageKey(contentId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeThread(contentId: string, threadId: string | undefined): void {
  try {
    if (threadId === undefined) sessionStorage.removeItem(threadStorageKey(contentId));
    else sessionStorage.setItem(threadStorageKey(contentId), threadId);
  } catch {
    // Storage may be unavailable (privacy mode); the thread is then simply not remembered.
  }
}

/**
 * One turn: a question and every answer attempt that follows it up to the next question.
 * `user` is absent only for answers stored ahead of any question.
 */
export interface ChatTurn {
  key: string;
  user: ChatMessageDto | undefined;
  attempts: ChatMessageDto[];
}

/** Splits a thread's messages, oldest first, into turns. */
export function groupTurns(messages: readonly ChatMessageDto[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    if (message.role === "user" || last === undefined) {
      turns.push({ key: message.id, user: message.role === "user" ? message : undefined, attempts: message.role === "user" ? [] : [message] });
    } else {
      last.attempts.push(message);
    }
  }
  return turns;
}

/** The answer that counts for a turn: the last complete attempt, else the last attempt. */
export function effectiveAnswer(turn: ChatTurn): ChatMessageDto | undefined {
  return turn.attempts.findLast((attempt) => attempt.status === "complete") ?? turn.attempts.at(-1);
}

/**
 * What a turn shows: a retry still streaming covers the answer it replaces; otherwise the
 * effective answer, plus the later attempt that failed or broke off while it stays in force.
 */
export function turnDisplay(turn: ChatTurn): { answer: ChatMessageDto | undefined; failedAttempt: ChatMessageDto | undefined } {
  const last = turn.attempts.at(-1);
  if (last?.status === "streaming") return { answer: last, failedAttempt: undefined };
  const answer = effectiveAnswer(turn);
  const failedAttempt = last !== undefined && last !== answer && (last.status === "failed" || last.status === "interrupted") ? last : undefined;
  return { answer, failedAttempt };
}
