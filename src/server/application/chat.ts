import { monotonicFactory } from "ulid";
import { CHAT_SEARCH_PLAN_TURNS, CHAT_THREAD_TITLE_MAX_CHARS } from "../../shared/defaults.ts";
import type {
  ChatContextDto,
  ChatDto,
  ChatMessageDto,
  ChatMessageRequest,
  ChatQuery,
  ChatRetryRequest,
  ChatStreamEvent,
  ChatThreadCreatedDto,
  ChatThreadDto,
  ChatThreadPatchRequest,
  ChatThreadsDto,
  ChatTurnsDeleteRequest,
  ChatTurnsDeleteResult,
} from "../../shared/dto/chat.ts";
import type { WebSearchMode } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import type { SpeakerContextState } from "../../shared/dto/speaker-context.ts";
import {
  chatThreadTitle,
  effectiveAnswer,
  groupTurns,
  lastMessageOf,
  type ChatCompaction,
  type ChatContextUsed,
  type ChatMessage,
  type ChatSpeakerBasis,
  type ChatThread,
} from "../domain/chat.ts";
import { mergedSpeakerBases } from "../domain/chat-speakers.ts";
import type { SpeakerContextSnapshot } from "../domain/speaker-context.ts";
import {
  beijingDate,
  chooseChatMode,
  citationAliasTable,
  citedSegmentIds,
  compactionPrompt,
  fitWebSources,
  planChatRequest,
  turnsToCompact,
  type ChatMetadata,
  type ChatModelIdentity,
  type ChatPlanInput,
  type ChatQuoteText,
  type ChatRequestPlan,
  type ChatTurnText,
  type ChatWebMaterial,
} from "../domain/chat-context.ts";
import { ChatStreamAssembler, type ChatAnswer } from "../domain/chat-stream.ts";
import { finalizeCitations } from "../domain/citations.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import { amberError, appError } from "../domain/errors.ts";
import type { ModelRef, ModelRefSnapshot } from "../domain/model-ref.ts";
import { CHAT_COMPACTION_PROMPT, DEFAULT_SUMMARY_TEMPLATE_ID } from "../domain/prompts.ts";
import { effectiveCapability } from "../domain/provider-profile.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { ChatWebSearch } from "../domain/web-search.ts";
import type { LlmModelDescription } from "../pipeline/executor.ts";
import { resolvePrompt } from "../pipeline/prompts.ts";
import { toAppError } from "../pipeline/retry.ts";
import type { Logger } from "../ports/logger.ts";
import type { ChatThreadSummary, Repository, RepositoryScope } from "../ports/repository.ts";
import { jsonRequestDigest } from "./idempotency.ts";
import type { LlmGateway } from "./llm-gateway.ts";
import { defaultSettings, defaultSummaryTemplateIdOf, outputLanguageFor } from "./settings.ts";
import type { ChatWebSearcher } from "./web-search.ts";
import {
  answerBasis,
  basisSpeakerState,
  chatCandidates,
  chatSpeakers,
  chatSummary,
  messageSpeakerContext,
  type ChatAnswerBasis,
  type ChatCandidates,
  type ChatSpeakers,
} from "./chat-speakers.ts";
import { SpeakerLineageReader } from "./speaker-lineage.ts";

export const CHAT_ROUTE = "POST /api/contents/:id/chat/messages";
export const CHAT_RETRY_ROUTE = "POST /api/contents/:id/chat/messages/:mid/retry";

export interface ChatServiceOptions {
  repository: Repository;
  llm: LlmGateway;
  logger: Logger;
  /** Absent: no search service at all, so `auto` is skipped and `force` refused. */
  webSearch?: ChatWebSearcher;
  /** Compares the speakers older answers and summaries were given with now; one is made when absent. */
  speakerLineage?: SpeakerLineageReader;
  newId?: () => string;
  now?: () => number;
}

/** A POST either replays a stored answer or streams a new one. */
export type ChatSendResult = { kind: "replay"; message: ChatMessageDto } | { kind: "stream"; events: AsyncIterable<ChatStreamEvent> };

/** An answer streaming in this process; `done` settles once its final state is stored. */
interface InflightAnswer {
  contentId: string;
  threadId: string;
  controller: AbortController;
  done: Promise<void>;
}

/** Everything about a thread a request plans with, read in one transaction. */
interface ThreadState {
  content: Content;
  /** Absent while the Content has no transcript: the metadata mode. */
  primaryRevisionId: string | undefined;
  input: Omit<ChatPlanInput, "contextWindowTokens" | "question" | "quote" | "positionMs">;
  thread: ChatThread | undefined;
  /** Uncompacted turns with the id of their last message and, when their answer read speakers, its basis. */
  turns: HistoryTurn[];
  /** Every earlier question of the thread, oldest first, compacted or not. */
  questions: string[];
  startMs: Map<string, number>;
  /** The speakers this answer reads, taken with the sentences; absent: none. */
  speakers: ChatSpeakers | undefined;
  /** The thread's current compaction, whose speaker bases a new compaction carries on. */
  compaction: ChatCompaction | undefined;
  /** The default summary was left out because its speakers no longer hold. */
  summaryOmitted: boolean;
}

/** What `answer` needs of a request that passed every check and stored its messages. */
interface PreparedAnswer {
  state: ThreadState;
  /** The planning input without web material. */
  input: ChatPlanInput;
  /** Every index query of the answer, made with the transcript; planning only chooses among them. */
  candidates: ChatCandidates;
  thread: ChatThread;
  userMessageId: string;
  assistantMessageId: string;
  webSearch: WebSearchMode;
  /** The owner had a usable search service when the request was accepted. */
  webConfigured: boolean;
  structuredOutput: boolean;
  /** On a retry: the effective answer the new attempt replaces once it completes. */
  replacesMessageId?: string;
}

/**
 * Chat threads of a Content. Answers stream from the LlmGateway (which holds the LLM slot
 * and records usage); every message is stored before the call so a half-streamed answer is
 * never mistaken for a complete one. A thread has at most one answer streaming: sending,
 * retrying, deleting turns or deleting the thread meanwhile is refused, so the context an
 * answer started with and the compaction it may write cannot interleave with a deletion.
 * Compaction folds older turns only when the request does not fit; its failure never
 * blocks the answer.
 */
export class ChatService {
  private readonly options: ChatServiceOptions;
  private readonly newId: () => string;
  private readonly now: () => number;
  /** Streaming answers per owner, so an account can be quiesced before deletion. */
  private readonly inflight = new Map<string, Set<InflightAnswer>>();
  private readonly lineage: SpeakerLineageReader;

  constructor(options: ChatServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
    this.now = options.now ?? Date.now;
    this.lineage = options.speakerLineage ?? new SpeakerLineageReader();
  }

  /** `GET chat`: one thread (the newest unless `threadId` names another) with every message and attempt. */
  get(principal: RequestPrincipal, contentId: string, query: ChatQuery): ChatDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = this.requireContent(scope, owner, contentId);
      const thread = query.threadId === undefined ? scope.chat.latestThread(owner, contentId) : this.requireThread(scope, owner, contentId, query.threadId);
      const messages = thread === undefined ? [] : scope.chat.listMessages(owner, thread.id);
      const shown = this.messagesDto(scope, owner, content, messages);
      return {
        thread: thread === undefined ? null : threadDto(thread),
        messages: shown,
        context: this.context(scope, owner, content, thread, query),
      };
    });
  }

  /** `GET chat/threads`: newest first. */
  threads(principal: RequestPrincipal, contentId: string): ChatThreadsDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      return { threads: scope.chat.listThreads(owner, contentId).map(threadDto) };
    });
  }

  /** "New conversation": the newest thread while it has no message yet, else a new one. */
  createThread(principal: RequestPrincipal, contentId: string): ChatThreadCreatedDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      const latest = scope.chat.latestThread(owner, contentId);
      if (latest !== undefined && latest.lastMessageAt === undefined) {
        return { thread: threadDto(latest) };
      }
      const thread: ChatThread = { id: this.newId(), contentId, createdAt: this.now() };
      scope.chat.insertThread(owner, thread);
      return { thread: threadDto(thread) };
    });
  }

  /**
   * `PATCH chat/threads/:tid`: renames (a blank or `null` title returns to the one taken from
   * the first question) and pins or unpins. Neither touches a message, so an answer streaming
   * in the thread does not stand in the way. Pinning an already pinned thread keeps its time.
   */
  updateThread(principal: RequestPrincipal, contentId: string, threadId: string, body: ChatThreadPatchRequest): ChatThreadCreatedDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      const thread = this.requireThread(scope, owner, contentId, threadId);
      const wanted = body.title === undefined ? undefined : (body.title ?? "").trim();
      const customTitle = wanted === undefined ? thread.customTitle : wanted === "" ? undefined : wanted;
      const pinnedAt = body.pinned === undefined ? thread.pinnedAt : body.pinned ? (thread.pinnedAt ?? this.now()) : undefined;
      scope.chat.updateThread(owner, threadId, { customTitle, pinnedAt });
      const updated = scope.chat.getThread(owner, threadId);
      if (updated === undefined) {
        throw amberError("not_found", "chat thread not found for this content");
      }
      return { thread: threadDto(updated) };
    });
  }

  /** `DELETE chat/threads/:tid`: the thread's messages and compactions go, usage rows and idempotency records stay. */
  deleteThread(principal: RequestPrincipal, contentId: string, threadId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      this.requireThread(scope, owner, contentId, threadId);
      this.requireIdle(owner, threadId);
      scope.chat.deleteThread(owner, threadId);
    });
  }

  /** `DELETE chat`: every thread of the Content goes, refused while any of them is answering. */
  clear(principal: RequestPrincipal, contentId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      if (this.hasInflightFor(owner, contentId)) {
        throw chatInflight();
      }
      scope.chat.deleteThreadsOf(owner, contentId);
    });
  }

  /**
   * `POST chat/turns/delete`: each id stands for its whole turn (the question and every
   * attempt). Compactions that ended on a deleted message move to the nearest earlier kept
   * message of their thread, or go when there is none. Returns every deleted message id.
   */
  deleteTurns(principal: RequestPrincipal, contentId: string, body: ChatTurnsDeleteRequest): ChatTurnsDeleteResult {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      const selected = new Map<string, Set<string>>();
      for (const messageId of body.messageIds) {
        const message = scope.chat.getMessage(owner, messageId);
        const thread = message === undefined ? undefined : scope.chat.getThread(owner, message.threadId);
        if (message === undefined || thread === undefined || thread.contentId !== contentId) {
          throw amberError("not_found", "chat message not found for this content");
        }
        const ids = selected.get(thread.id) ?? new Set<string>();
        ids.add(messageId);
        selected.set(thread.id, ids);
      }
      for (const threadId of selected.keys()) {
        this.requireIdle(owner, threadId);
      }
      const deleted: string[] = [];
      for (const [threadId, ids] of selected) {
        const doomed = groupTurns(scope.chat.listMessages(owner, threadId))
          .map((turn) => [turn.user, ...turn.attempts])
          .filter((turn) => turn.some((message) => ids.has(message.id)))
          .flat()
          .map((message) => message.id);
        removeMessages(scope, owner, threadId, doomed);
        deleted.push(...doomed);
      }
      return { deleted };
    });
  }

  /**
   * Validates and stores the question, then returns the answer stream. Every refusal
   * (unknown content or thread, a thread already answering, foreign quote, unusable model,
   * unknown context window, a fixed part beyond the budget, a forced search without a
   * search service) is thrown here, before anything is stored or streams.
   */
  send(principal: RequestPrincipal, contentId: string, body: ChatMessageRequest, idempotencyKey: string | undefined, signal: AbortSignal): ChatSendResult {
    const owner = principal.userId;
    const digest = jsonRequestDigest({ contentId, ...body });
    const replay = this.replay(owner, contentId, CHAT_ROUTE, idempotencyKey, digest);
    if (replay !== undefined) {
      return { kind: "replay", message: replay };
    }

    const description = this.options.llm.describe(owner, body.modelRef);
    const contextWindowTokens = requireContextWindow(description, body.modelRef);
    const webSearch = body.webSearch ?? "off";
    const webConfigured = this.webConfigured(owner, webSearch);
    const prepared = this.options.repository.withTransaction((scope): PreparedAnswer => {
      const content = this.requireContent(scope, owner, contentId);
      const existing = body.threadId === undefined ? scope.chat.latestThread(owner, contentId) : this.requireThread(scope, owner, contentId, body.threadId);
      if (existing !== undefined) {
        this.requireIdle(owner, existing.id);
      }
      const now = this.now();
      const state = this.state(scope, owner, content, existing);
      const quote = body.quote === undefined ? undefined : this.quoteText(scope, owner, contentId, body.quote);
      const candidates = candidatesOf(scope, owner, state, quote, body.text);
      const input = planInput(state, description.snapshot, contextWindowTokens, body.text, quote, body.positionMs, now, candidates);
      // Only the checks that do not depend on web material; the real plan follows the search.
      planChatRequest(input);

      const thread: ChatThread = existing ?? { id: this.newId(), contentId, createdAt: now };
      if (existing === undefined) {
        scope.chat.insertThread(owner, thread);
      }
      const userMessage: ChatMessage = {
        id: this.newId(),
        threadId: thread.id,
        role: "user",
        text: body.text,
        status: "complete",
        citations: body.quote === undefined ? [] : [{ transcriptRevisionId: body.quote.transcriptRevisionId, segmentId: body.quote.segmentId }],
        createdAt: now,
      };
      const assistantMessage = this.newAttempt(thread.id, description.snapshot, state, now);
      scope.chat.insertMessage(owner, userMessage);
      scope.chat.insertMessage(owner, assistantMessage);
      this.remember(scope, owner, body.modelRef, body.webSearch, now);
      this.recordKey(scope, owner, CHAT_ROUTE, idempotencyKey, digest, [userMessage.id, assistantMessage.id], now);
      return {
        state,
        input,
        candidates,
        thread,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        webSearch,
        webConfigured,
        structuredOutput: description.capability.flags.structuredOutput === "supported",
      };
    });
    return this.start(owner, contentId, body.modelRef, description.snapshot, prepared, signal);
  }

  /**
   * `POST chat/messages/:mid/retry`: answers the thread's last turn again. `messageId` must
   * be that turn's effective answer. The new attempt is answered from the turns before it
   * with the current primary revision and the quoted sentence's current text; its failed
   * and interrupted predecessors go first. The replaced answer goes once the new one
   * completes; a failed or interrupted attempt stays visible and the old answer stays in
   * effect.
   */
  retry(principal: RequestPrincipal, contentId: string, messageId: string, body: ChatRetryRequest, idempotencyKey: string, signal: AbortSignal): ChatSendResult {
    const owner = principal.userId;
    const digest = jsonRequestDigest({ contentId, messageId, ...body });
    const replay = this.replay(owner, contentId, CHAT_RETRY_ROUTE, idempotencyKey, digest);
    if (replay !== undefined) {
      return { kind: "replay", message: replay };
    }

    const modelRef = this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      const { replaced } = this.retryTarget(scope, owner, contentId, messageId);
      if (body.modelRef !== undefined) {
        return body.modelRef;
      }
      const original = replaced.modelRef;
      const exists =
        original !== undefined &&
        scope.providerProfiles.get(owner, original.providerProfileId)?.models.some((model) => model.modelId === original.modelId) === true;
      if (original === undefined || !exists) {
        throw amberError("llm_unconfigured", "the model of the retried answer is no longer configured", {
          code: "llm_unconfigured.model_missing",
          ...(original === undefined ? {} : { details: { providerProfileId: original.providerProfileId, modelId: original.modelId } }),
        });
      }
      return { providerProfileId: original.providerProfileId, modelId: original.modelId };
    });
    const description = this.options.llm.describe(owner, modelRef);
    const contextWindowTokens = requireContextWindow(description, modelRef);
    const webSearch = body.webSearch ?? "off";
    const webConfigured = this.webConfigured(owner, webSearch);
    const prepared = this.options.repository.withTransaction((scope): PreparedAnswer => {
      const content = this.requireContent(scope, owner, contentId);
      const { thread, turn, replaced } = this.retryTarget(scope, owner, contentId, messageId);
      const now = this.now();
      const state = this.state(scope, owner, content, thread, turn.user.id);
      const quoted = turn.user.citations[0];
      const quote = quoted === undefined ? undefined : this.storedQuote(scope, owner, contentId, quoted);
      const candidates = candidatesOf(scope, owner, state, quote, turn.user.text);
      const input = planInput(state, description.snapshot, contextWindowTokens, turn.user.text, quote, body.positionMs, now, candidates);
      planChatRequest(input);

      const stale = turn.attempts.filter((attempt) => attempt.id !== replaced.id && (attempt.status === "failed" || attempt.status === "interrupted")).map((attempt) => attempt.id);
      const attempt: ChatMessage = { ...this.newAttempt(thread.id, description.snapshot, state, now), replacesMessageId: replaced.id };
      removeMessages(scope, owner, thread.id, stale);
      scope.chat.insertMessage(owner, attempt);
      // A replay of the key that made a removed attempt now shows the attempt that took its place.
      scope.idempotency.rebindResourceRefs(owner, stale, attempt.id);
      this.remember(scope, owner, body.modelRef, body.webSearch, now);
      this.recordKey(scope, owner, CHAT_RETRY_ROUTE, idempotencyKey, digest, [turn.user.id, attempt.id], now);
      return {
        state,
        input,
        candidates,
        thread,
        userMessageId: turn.user.id,
        assistantMessageId: attempt.id,
        webSearch,
        webConfigured,
        structuredOutput: description.capability.flags.structuredOutput === "supported",
        replacesMessageId: replaced.id,
      };
    });
    return this.start(owner, contentId, modelRef, description.snapshot, prepared, signal);
  }

  /** Whether any answer of the owner is still streaming in this process. */
  hasInflight(ownerUserId: string): boolean {
    return (this.inflight.get(ownerUserId)?.size ?? 0) > 0;
  }

  /** Whether any answer of any owner is still streaming in this process; backups and updates wait for none. */
  hasAnyInflight(): boolean {
    return [...this.inflight.values()].some((entries) => entries.size > 0);
  }

  /** Whether an answer about this Content is still streaming in this process; a purge waits for it. */
  hasInflightFor(ownerUserId: string, contentId: string): boolean {
    return [...(this.inflight.get(ownerUserId) ?? [])].some((entry) => entry.contentId === contentId);
  }

  /**
   * Aborts the answers streaming about a Content that went to the trash. It does not wait:
   * each answer stores its `interrupted` state once its stream is next read, which may be
   * never for a client that went away, and moving to the trash must not hang on that.
   */
  abortContent(ownerUserId: string, contentId: string): void {
    for (const entry of this.inflight.get(ownerUserId) ?? []) {
      if (entry.contentId === contentId) {
        entry.controller.abort(new Error("content moved to the trash"));
      }
    }
  }

  /**
   * Aborts every answer the owner has streaming and resolves once each has stored its
   * final (`interrupted`) state; used before the account is deleted.
   */
  async abortOwner(ownerUserId: string): Promise<void> {
    const entries = [...(this.inflight.get(ownerUserId) ?? [])];
    for (const entry of entries) {
      entry.controller.abort(new Error("account is being deleted"));
    }
    await Promise.allSettled(entries.map((entry) => entry.done));
  }

  /** Start-up: answers a previous process left `streaming` become `interrupted`. */
  recoverInterrupted(): number {
    const now = this.now();
    return this.options.repository.withTransaction((scope) => scope.chat.interruptStreaming(now));
  }

  /**
   * The stored answer of a replayed `Idempotency-Key`, as it is now (still `streaming`
   * while it streams); undefined for a new key. Never calls a model.
   */
  private replay(owner: string, contentId: string, route: string, idempotencyKey: string | undefined, digest: string): ChatMessageDto | undefined {
    return this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      if (idempotencyKey === undefined) {
        return undefined;
      }
      const stored = scope.idempotency.get(owner, route, idempotencyKey);
      if (stored === undefined) {
        return undefined;
      }
      if (stored.requestDigest !== digest) {
        throw amberError("idempotency_conflict", "idempotency key reused with a different request");
      }
      const [, assistantId] = JSON.parse(stored.resourceRefsJson) as string[];
      const message = assistantId === undefined ? undefined : scope.chat.getMessage(owner, assistantId);
      if (message === undefined) {
        throw amberError("not_found", "the replayed answer was deleted", { code: "not_found.chat_answer_deleted" });
      }
      const content = this.requireContent(scope, owner, contentId);
      return this.messagesDto(scope, owner, content, [message])[0] as ChatMessageDto;
    });
  }

  /** Refuses a forced search without a usable search service; tells whether one is there. */
  private webConfigured(owner: string, mode: WebSearchMode): boolean {
    if (mode === "off") {
      return false;
    }
    const configured = this.options.webSearch?.isConfigured(owner) ?? false;
    if (mode === "force" && !configured) {
      throw amberError("web_search_failed", "a forced web search needs a configured search service", { code: "web_search_failed.unconfigured" });
    }
    return configured;
  }

  /** The thread, last turn and effective answer a retry of `messageId` replaces; every refusal of a retry target. */
  private retryTarget(scope: RepositoryScope, owner: string, contentId: string, messageId: string) {
    const message = scope.chat.getMessage(owner, messageId);
    const thread = message === undefined ? undefined : scope.chat.getThread(owner, message.threadId);
    if (message === undefined || thread === undefined || thread.contentId !== contentId) {
      throw amberError("not_found", "chat message not found for this content");
    }
    this.requireIdle(owner, thread.id);
    const turn = groupTurns(scope.chat.listMessages(owner, thread.id)).at(-1);
    const replaced = turn === undefined ? undefined : effectiveAnswer(turn);
    if (turn === undefined || replaced === undefined || replaced.id !== messageId) {
      throw amberError("conflict", "only the effective answer of the thread's last turn can be retried", { code: "conflict.chat_retry_not_last" });
    }
    return { thread, turn, replaced };
  }

  /** A new answer attempt; it keeps the speakers it reads from the start, so a failed or interrupted attempt keeps them too. */
  private newAttempt(threadId: string, snapshot: ModelRefSnapshot, state: ThreadState, now: number): ChatMessage {
    const speakerContext: SpeakerContextSnapshot | undefined = state.speakers?.snapshot;
    return {
      id: this.newId(),
      threadId,
      role: "assistant",
      text: "",
      status: "streaming",
      modelRef: snapshot,
      ...(state.primaryRevisionId === undefined ? {} : { contextTranscriptRevisionId: state.primaryRevisionId }),
      ...(speakerContext === undefined ? {} : { speakerContext: structuredClone(speakerContext) }),
      citations: [],
      createdAt: now,
    };
  }

  /** "Remember last": the chosen model, and the search setting unless it was a one-off forced search. */
  private remember(scope: RepositoryScope, owner: string, modelRef: ModelRef | undefined, webSearch: WebSearchMode | undefined, now: number): void {
    if (modelRef === undefined && (webSearch === undefined || webSearch === "force")) {
      return;
    }
    const settings = scope.userSettings.get(owner) ?? defaultSettings(owner, now);
    scope.userSettings.put({
      ...settings,
      ...(modelRef === undefined ? {} : { chatModelRef: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId } }),
      ...(webSearch === "off" || webSearch === "auto" ? { chatWebSearchMode: webSearch } : {}),
      updatedAt: now,
    });
  }

  private recordKey(scope: RepositoryScope, owner: string, route: string, key: string | undefined, digest: string, refs: readonly string[], now: number): void {
    if (key === undefined) {
      return;
    }
    scope.idempotency.insert({
      userId: owner,
      route,
      key,
      requestDigest: digest,
      responseStatus: 200,
      responseBodyJson: JSON.stringify({ messageId: refs.at(-1) }),
      resourceRefsJson: JSON.stringify(refs),
      createdAt: now,
    });
  }

  /** Registers the answer as streaming on its thread and returns its events. */
  private start(owner: string, contentId: string, modelRef: ModelRef, snapshot: ModelRefSnapshot, prepared: PreparedAnswer, signal: AbortSignal): ChatSendResult {
    // Registered in the same synchronous step as the commit that stored the `streaming`
    // message, so no check can fall between the two.
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal.reason);
    if (signal.aborted) {
      forward();
    } else {
      signal.addEventListener("abort", forward, { once: true });
    }
    let settle = (): void => undefined;
    const entry: InflightAnswer = { contentId, threadId: prepared.thread.id, controller, done: new Promise<void>((resolve) => (settle = resolve)) };
    const entries = this.inflight.get(owner) ?? new Set<InflightAnswer>();
    entries.add(entry);
    this.inflight.set(owner, entries);
    const release = (): void => {
      signal.removeEventListener("abort", forward);
      entries.delete(entry);
      if (entries.size === 0 && this.inflight.get(owner) === entries) {
        this.inflight.delete(owner);
      }
      settle();
    };
    return { kind: "stream", events: tracked(this.answer(owner, modelRef, snapshot, prepared, controller.signal), release) };
  }

  private requireIdle(owner: string, threadId: string): void {
    if ([...(this.inflight.get(owner) ?? [])].some((entry) => entry.threadId === threadId)) {
      throw chatInflight();
    }
  }

  private async *answer(owner: string, modelRef: ModelRef, snapshot: ModelRefSnapshot, prepared: PreparedAnswer, signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const { state, thread, userMessageId, assistantMessageId } = prepared;
    let status: ChatMessage["status"] = "failed";
    let error: AppError | undefined;
    let assembler: ChatStreamAssembler | undefined;
    let answer: ChatAnswer = { text: "", citations: [] };
    let stop: string | undefined;
    let webSearch: ChatWebSearch | undefined;
    try {
      const searched = yield* this.searchWeb(owner, modelRef, prepared, signal);
      webSearch = searched?.record;
      // Planned again with the web material in, which may change the mode, hits and budget.
      const input: ChatPlanInput = searched?.web === undefined ? prepared.input : { ...prepared.input, web: searched.web };
      const hits = prepared.candidates.hits;
      let plan = planChatRequest(input, hits);
      if (plan.overBudget) {
        plan = (await this.compact(owner, modelRef, snapshot, { state, input, thread, hits }, signal)) ?? plan;
      }
      // Only now is it known what the answer actually reads: web material may have pushed
      // the full text into retrieval, and retrieval may have taken a selection of someone's
      // speech. The answer keeps it, so a reload shows the same; an answer that reads no
      // speakers and lost no summary sends nothing, exactly as before speakers existed.
      const used = contextUsed(state, plan);
      if (used !== undefined) {
        this.options.repository.withTransaction((scope) => scope.chat.recordContextUsed(owner, assistantMessageId, used));
        yield { type: "context", data: { ...used } };
      }
      assembler = new ChatStreamAssembler(plan.table, (segmentId) => state.startMs.get(segmentId) ?? 0, input.web?.sources ?? []);
      const stream = this.options.llm.stream(
        { userId: owner, feature: "chat", contentId: state.content.id, chatMessageId: assistantMessageId },
        { modelRef, system: plan.system, messages: plan.messages },
        { signal },
      );
      for await (const event of stream) {
        if (signal.aborted) {
          break;
        }
        if (event.type === "text_delta") {
          yield* assembler.push(event.delta).map(toStreamEvent);
        } else if (event.type === "usage") {
          yield { type: "usage", data: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens } };
        } else {
          stop = event.stopReason;
          if (event.stopReason === "error") {
            error = appError("llm_failed", event.raw === undefined ? {} : { upstreamMessage: event.raw });
          } else if (event.stopReason === "refused") {
            error = appError("llm_failed", { code: "llm_failed.refused", ...(event.raw === undefined ? {} : { upstreamMessage: event.raw }) });
          }
        }
      }
      if (signal.aborted || stop === "aborted") {
        status = "interrupted";
      } else if (error === undefined) {
        status = "complete";
        const finished = assembler.finish();
        answer = finished.answer;
        yield* finished.events.map(toStreamEvent);
        if (answer.suggestions !== undefined) {
          yield { type: "suggestions", data: { items: answer.suggestions } };
        }
      }
    } catch (thrown) {
      if (signal.aborted) {
        status = "interrupted";
      } else {
        status = "failed";
        error = toAppError(thrown);
      }
    }
    // A refused answer is incomplete by definition: none of it is kept.
    if (status !== "complete" && assembler !== undefined && stop !== "refused") {
      answer = assembler.partial();
    }
    const finishedAt = this.now();
    try {
      this.options.repository.withTransaction((scope) => {
        scope.chat.finishMessage(owner, {
          id: assistantMessageId,
          text: answer.text,
          status,
          citations: answer.citations,
          ...(answer.suggestions === undefined ? {} : { suggestions: answer.suggestions }),
          ...(webSearch === undefined ? {} : { webSearch }),
          ...(error === undefined || status !== "failed" ? {} : { error }),
          finishedAt,
        });
        const replaced = prepared.replacesMessageId;
        if (status === "complete" && replaced !== undefined) {
          removeMessages(scope, owner, thread.id, [replaced]);
          // A replay of the key that made the replaced answer now shows this one.
          scope.idempotency.rebindResourceRefs(owner, [replaced], assistantMessageId);
        }
      });
    } catch (thrown) {
      // The thread may have been deleted with its Content while the answer streamed.
      this.options.logger.warn("chat_answer_not_stored", { code: toAppError(thrown).code });
    }
    yield { type: "done", data: { threadId: thread.id, userMessageId, messageId: assistantMessageId, status, ...(error === undefined ? {} : { error }) } };
  }

  /**
   * The answer's web search, announced as `search.started` (when queries go out) and
   * `search.done`. Returns the record and, when a search actually ran, the material for the
   * request (empty when nothing usable came back or nothing fitted, so the model is told).
   * Undefined when the answer asked for no search.
   */
  private async *searchWeb(
    owner: string,
    modelRef: ModelRef,
    prepared: PreparedAnswer,
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, { record: ChatWebSearch; web?: ChatWebMaterial } | undefined> {
    const mode = prepared.webSearch;
    if (mode === "off") {
      return undefined;
    }
    const searcher = this.options.webSearch;
    if (!prepared.webConfigured || searcher === undefined) {
      const record = skippedSearch(mode, "unconfigured");
      yield searchDone(record);
      return { record };
    }
    const title = displayTitle(prepared.state.content);
    const plan = await searcher.plan({
      owner,
      mode,
      modelRef,
      structuredOutput: prepared.structuredOutput,
      ...(title === undefined ? {} : { title }),
      recentQuestions: prepared.state.questions.slice(-CHAT_SEARCH_PLAN_TURNS),
      question: prepared.input.question,
      today: prepared.input.today ?? beijingDate(this.now()),
      contentId: prepared.state.content.id,
      chatMessageId: prepared.assistantMessageId,
      signal,
    });
    if (plan.queries.length === 0) {
      const record = skippedSearch(mode, plan.reason ?? "not_needed");
      yield searchDone(record);
      return { record };
    }
    yield { type: "search.started", data: { planned: plan.queries.length, queries: [...plan.queries] } };
    let record = await searcher.search(owner, plan, signal);
    if (record.sources.length > 0) {
      const fitted = fitWebSources(prepared.input, record.sources);
      record = fitted.dropped ? { ...record, status: "dropped", reason: "budget", sources: [] } : { ...record, sources: fitted.sources };
    }
    yield searchDone(record);
    return { record, web: { sources: record.sources } };
  }

  /**
   * Folds every uncompacted turn but the most recent `CHAT_RECENT_TURNS` into a new
   * compaction (the `chat.compaction` prompt) and plans again with it. Returns undefined
   * when there is nothing to fold or the call fails; the caller then goes on with the turns
   * that fit.
   */
  private async compact(
    owner: string,
    modelRef: ModelRef,
    snapshot: ModelRefSnapshot,
    prepared: { state: ThreadState; input: ChatPlanInput; thread: ChatThread; hits: readonly string[] },
    signal: AbortSignal,
  ): Promise<ChatRequestPlan | undefined> {
    const { state, input, thread, hits } = prepared;
    const older = turnsToCompact(state.turns);
    const last = older.at(-1);
    if (last === undefined) {
      return undefined;
    }
    try {
      const cited = citedSegmentIds([input.compaction ?? "", ...older.map((turn) => turn.answer)]);
      const sentences = this.options.repository.withTransaction((scope) =>
        cited.flatMap((segmentId) => {
          const segment = scope.transcripts.getSegment(owner, segmentId);
          return segment === undefined ? [] : [{ transcriptRevisionId: segment.revisionId, segmentId, text: segment.text }];
        }),
      );
      const table = citationAliasTable(sentences);
      const prompt = compactionPrompt({ ...(input.compaction === undefined ? {} : { compaction: input.compaction }), turns: older, outputLanguage: input.outputLanguage }, table);
      const completion = await this.options.llm.complete(
        { userId: owner, feature: "chat_compaction", contentId: state.content.id },
        { modelRef, system: "", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
        { signal },
      );
      const body = finalizeCitations(completion.text.trim(), table).body;
      // What the new compaction was built from, kept with it: the answers it absorbs may be
      // deleted later, and whether its text needs a speaker notice must not change then.
      // A failed answer left no text in it, so its speakers do not count.
      const absorbed = older.filter((turn) => turn.answer !== "");
      const speakerBases = mergedSpeakerBases(
        state.compaction?.speakerBases,
        absorbed.flatMap((turn) => (turn.speakerBasis === undefined ? [] : [turn.speakerBasis])),
      );
      // Judged already with the turns; merging bases changes no notice (see mergedSpeakerBases).
      const speakerStates = [
        ...(input.compactionSpeakerStates ?? []),
        ...absorbed.flatMap((turn) => (turn.speakerState === undefined ? [] : [turn.speakerState])),
      ];
      this.options.repository.withTransaction((scope) => {
        const id = this.newId();
        scope.chat.insertCompaction(owner, {
          id,
          threadId: thread.id,
          throughMessageId: last.lastMessageId,
          body,
          modelRef: snapshot,
          promptRef: { ...CHAT_COMPACTION_PROMPT.ref },
          promptSnapshot: prompt,
          ...(speakerBases.length === 0 ? {} : { speakerBases }),
          createdAt: this.now(),
        });
        scope.tokenUsage.attach(owner, [completion.invocationId], id);
      });
      const remaining = state.turns.slice(older.length);
      return planChatRequest({ ...input, compaction: body, ...(speakerStates.length === 0 ? {} : { compactionSpeakerStates: speakerStates }), turns: remaining }, hits);
    } catch (thrown) {
      if (signal.aborted) {
        throw thrown;
      }
      this.options.logger.warn("chat_compaction_failed", { code: toAppError(thrown).code });
      return undefined;
    }
  }

  /** `context` of `GET chat`: the chosen model's mode and estimate for an empty question on this thread. */
  private context(scope: RepositoryScope, owner: string, content: Content, thread: ChatThread | undefined, query: ChatQuery): ChatContextDto {
    const settings = scope.userSettings.get(owner);
    const modelRef: ModelRef | undefined =
      query.providerProfileId !== undefined && query.modelId !== undefined
        ? { providerProfileId: query.providerProfileId, modelId: query.modelId }
        : (settings?.chatModelRef ?? settings?.defaultModelRef);
    const profile = modelRef === undefined ? undefined : scope.providerProfiles.get(owner, modelRef.providerProfileId);
    const model = modelRef === undefined ? undefined : profile?.models.find((candidate) => candidate.modelId === modelRef.modelId);
    if (modelRef === undefined || profile === undefined || model === undefined) {
      return { mode: "unavailable", reason: "no_model" };
    }
    const contextWindowTokens = effectiveCapability(model).limits.contextWindowTokens;
    if (contextWindowTokens === undefined) {
      return { mode: "unavailable", reason: "context_window_unknown" };
    }
    const state = this.state(scope, owner, content, thread);
    const snapshot: ModelRefSnapshot = { ...modelRef, providerNameSnapshot: profile.name, modelDisplaySnapshot: modelRef.modelId, protocolSnapshot: profile.protocol };
    const input = planInput(state, snapshot, contextWindowTokens, "", undefined, undefined, this.now(), { hits: [] });
    const omitted = state.summaryOmitted ? { summaryOmitted: true as const } : {};
    try {
      const plan = planChatRequest(input);
      return { mode: plan.mode, estimatedTokens: plan.estimatedTokens, ...omitted };
    } catch {
      return { mode: chooseChatMode(input), ...omitted };
    }
  }

  private requireContent(scope: RepositoryScope, owner: string, contentId: string): Content {
    const content = scope.contents.get(owner, contentId);
    if (content === undefined) {
      throw amberError("not_found", "content not found for this owner");
    }
    return content;
  }

  /** A thread of this Content; another Content's thread is reported like an unknown one. */
  private requireThread(scope: RepositoryScope, owner: string, contentId: string, threadId: string): ChatThreadSummary {
    const thread = scope.chat.getThread(owner, threadId);
    if (thread === undefined || thread.contentId !== contentId) {
      throw amberError("not_found", "chat thread not found for this content");
    }
    return thread;
  }

  /**
   * The planning state of a thread (none yet: an empty history). With `before`, only the
   * messages before that one count: a retry answers its turn from the turns before it.
   */
  private state(scope: RepositoryScope, owner: string, content: Content, thread: ChatThread | undefined, before?: string): ThreadState {
    const contentId = content.id;
    const primaryRevisionId = content.primaryTranscriptRevisionId;
    const segments = primaryRevisionId === undefined ? [] : scope.transcripts.listSegments(owner, primaryRevisionId);
    // Taken with the sentences, in this transaction: a rename or another primary while the
    // answer streams cannot reach it.
    const speakers = primaryRevisionId === undefined ? undefined : chatSpeakers(scope, owner, contentId, primaryRevisionId, segments);
    const templateId = defaultSummaryTemplateIdOf(scope, owner) ?? DEFAULT_SUMMARY_TEMPLATE_ID;
    const artifact = scope.summaries.findArtifact(owner, contentId, templateId);
    const revision = artifact?.currentRevisionId === undefined ? undefined : scope.summaries.getRevision(owner, artifact.currentRevisionId);
    const carried = revision === undefined ? undefined : chatSummary(scope, owner, this.lineage, contentId, revision);
    const summary = carried?.kind === "carried" ? carried.text : undefined;
    const chapters = (scope.chapters.getCurrent(owner, contentId)?.chapters ?? []).map(({ startMs, endMs, title }) => ({ startMs, endMs, title }));
    const current = thread === undefined ? undefined : scope.chat.getThread(owner, thread.id);
    const compaction = current?.currentCompactionId === undefined ? undefined : scope.chat.getCompaction(owner, current.currentCompactionId);
    // How older chat text that read speakers compares with now, judged in this transaction
    // like every stored result. When this answer reads no speakers, any of it that did is
    // read against a transcript whose speakers are not confirmed: `unconfirmed`.
    const judge = (basis: ChatAnswerBasis): SpeakerContextState =>
      speakers === undefined ? "unconfirmed" : basisSpeakerState(scope, owner, this.lineage, contentId, basis).state;
    const compactionStates = (compaction?.speakerBases ?? []).map(judge);
    const all = thread === undefined ? [] : scope.chat.listMessages(owner, thread.id);
    const end = before === undefined ? -1 : all.findIndex((message) => message.id === before);
    const messages = end < 0 ? all : all.slice(0, end);
    const after = compaction === undefined ? 0 : all.findIndex((message) => message.id === compaction.throughMessageId) + 1;
    return {
      content,
      primaryRevisionId,
      input: {
        outputLanguage: outputLanguageFor(scope, owner, undefined),
        ...(primaryRevisionId === undefined ? { metadata: metadataOf(content, scope.referenceTexts.listByContent(owner, contentId).map((reference) => reference.text)) } : { revisionId: primaryRevisionId }),
        segments,
        ...(summary === undefined ? {} : { summary }),
        chapters,
        ...(compaction === undefined ? {} : { compaction: compaction.body }),
        ...(compactionStates.length === 0 ? {} : { compactionSpeakerStates: compactionStates }),
        ...(speakers === undefined ? {} : { speakers: speakers.reading }),
        turns: [],
        // Answers are not Tasks: each question reads the prompts in effect now, nothing is frozen.
        prompts: {
          system: resolvePrompt(scope, owner, "chat.system", undefined).text,
          metadata: resolvePrompt(scope, owner, "chat.system.metadata", undefined).text,
        },
      },
      thread,
      turns: turnsOf(messages.slice(Math.min(after, messages.length)), (segmentId) => scope.transcripts.getSegment(owner, segmentId)?.text, judge),
      questions: groupTurns(messages).map((turn) => turn.user.text),
      startMs: new Map(segments.map((segment) => [segment.id as string, segment.startMs])),
      speakers,
      compaction,
      summaryOmitted: carried?.kind === "omitted",
    };
  }

  /** Messages as shown; an answer whose speakers no longer match now says so. */
  private messagesDto(scope: RepositoryScope, owner: string, content: Content, messages: readonly ChatMessage[]): ChatMessageDto[] {
    return messages.map((message) => {
      const speakerContext = messageSpeakerContext(scope, owner, this.lineage, content.id, message);
      return speakerContext === undefined ? messageDto(message) : { ...messageDto(message), speakerContext };
    });
  }

  /** The quoted sentence, which must belong to a revision of this Content; its text comes from the store. */
  private quoteText(scope: RepositoryScope, owner: string, contentId: string, quote: { transcriptRevisionId: string; segmentId: string }): ChatQuoteText {
    const text = readQuote(scope, owner, contentId, quote);
    if (text === undefined) {
      throw amberError("invalid_request", "the quoted sentence is not part of this content", { params: { detail: "body.quote" } });
    }
    return text;
  }

  /** The stored quote of a retried question, read again; gone (its revision deleted) refuses the retry. */
  private storedQuote(scope: RepositoryScope, owner: string, contentId: string, quote: { transcriptRevisionId: string; segmentId: string }): ChatQuoteText {
    const text = readQuote(scope, owner, contentId, quote);
    if (text === undefined) {
      throw amberError("conflict", "the quoted sentence of the retried question can no longer be read", { code: "conflict.chat_quote_unavailable" });
    }
    return text;
  }
}

function readQuote(scope: RepositoryScope, owner: string, contentId: string, quote: { transcriptRevisionId: string; segmentId: string }): ChatQuoteText | undefined {
  const revision = scope.transcripts.getRevision(owner, quote.transcriptRevisionId);
  const segment = scope.transcripts.getSegment(owner, quote.segmentId);
  if (revision === undefined || revision.contentId !== contentId || segment === undefined || segment.revisionId !== revision.id) {
    return undefined;
  }
  return { segmentId: segment.id, text: segment.text };
}

/**
 * The retrieval candidates of one question, read in the transaction that read the thread
 * state: from the revision and the quoted text plus question only.
 */
function candidatesOf(scope: RepositoryScope, owner: string, state: ThreadState, quote: ChatQuoteText | undefined, question: string): ChatCandidates {
  const query = [quote?.text ?? "", question].join(" ").trim();
  return chatCandidates(scope, owner, state.primaryRevisionId, query, state.speakers);
}

/** The planning input of one question; web material is added once the search has run. */
function planInput(
  state: ThreadState,
  snapshot: ModelRefSnapshot,
  contextWindowTokens: number,
  question: string,
  quote: ChatQuoteText | undefined,
  positionMs: number | undefined,
  now: number,
  candidates: ChatCandidates,
): ChatPlanInput {
  const model: ChatModelIdentity = {
    profileName: snapshot.providerNameSnapshot,
    modelId: snapshot.modelId,
    ...(snapshot.protocolSnapshot === undefined ? {} : { protocol: snapshot.protocolSnapshot }),
  };
  const speakers = state.input.speakers;
  return {
    ...state.input,
    ...(speakers === undefined || candidates.person === undefined ? {} : { speakers: { ...speakers, person: candidates.person } }),
    contextWindowTokens,
    turns: state.turns,
    question,
    ...(quote === undefined ? {} : { quote }),
    ...(positionMs === undefined ? {} : { positionMs }),
    model,
    today: beijingDate(now),
  };
}

/**
 * Deletes messages of one thread. A compaction that ended on one of them first moves to the
 * nearest earlier kept message, or goes when there is none; the thread's current compaction
 * then falls back to the newest one left. The order matters: a compaction may not end on a
 * missing message, and the current pointer may not name a missing compaction.
 */
function removeMessages(scope: RepositoryScope, owner: string, threadId: string, messageIds: readonly string[]): void {
  if (messageIds.length === 0) {
    return;
  }
  const doomed = new Set(messageIds);
  const messages = scope.chat.listMessages(owner, threadId);
  const compactions = scope.chat.listCompactions(owner, threadId);
  const dropped = new Set<string>();
  for (const compaction of compactions) {
    if (!doomed.has(compaction.throughMessageId)) {
      continue;
    }
    const end = messages.findIndex((message) => message.id === compaction.throughMessageId);
    const kept = messages.slice(0, Math.max(0, end)).findLast((message) => !doomed.has(message.id));
    if (kept === undefined) {
      dropped.add(compaction.id);
    } else {
      scope.chat.moveCompaction(owner, compaction.id, kept.id);
    }
  }
  const current = scope.chat.getThread(owner, threadId)?.currentCompactionId;
  if (current !== undefined && dropped.has(current)) {
    scope.chat.setCurrentCompaction(owner, threadId, compactions.findLast((compaction) => !dropped.has(compaction.id))?.id);
  }
  for (const compactionId of dropped) {
    scope.chat.deleteCompaction(owner, compactionId);
  }
  scope.chat.deleteMessages(owner, messageIds);
}

/** A history turn as planned, with what a compaction absorbing it must keep. */
type HistoryTurn = ChatTurnText & {
  lastMessageId: string;
  /** The basis of its answer when that read speakers and has text; absent otherwise. */
  speakerBasis?: ChatSpeakerBasis;
};

/**
 * The turns of the history, each with its effective answer. A turn with an attempt still
 * streaming (another request in flight) is left out; a failed answer counts as empty. An
 * answer that read speakers and has text is judged by `judge`.
 */
function turnsOf(
  messages: readonly ChatMessage[],
  textOf: (segmentId: string) => string | undefined,
  judge: (basis: ChatAnswerBasis) => SpeakerContextState,
): HistoryTurn[] {
  return groupTurns(messages)
    .filter((turn) => !turn.attempts.some((attempt) => attempt.status === "streaming"))
    .map((turn) => {
      const answer = effectiveAnswer(turn);
      const quoted = turn.user.citations[0];
      const quoteText = quoted === undefined ? undefined : textOf(quoted.segmentId);
      const text = answer === undefined || answer.status === "failed" ? "" : answer.text;
      const basis = answer === undefined || text === "" ? undefined : answerBasis(answer);
      const revisionId = basis?.transcriptRevisionId;
      return {
        question: turn.user.text,
        ...(quoted === undefined || quoteText === undefined ? {} : { quote: { segmentId: quoted.segmentId, text: quoteText } }),
        answer: text,
        ...(basis === undefined ? {} : { speakerState: judge(basis) }),
        lastMessageId: lastMessageOf(turn).id,
        ...(basis === undefined || revisionId === undefined
          ? {}
          : { speakerBasis: { transcriptRevisionId: revisionId, speakerContext: basis.speakerContext, citedSegmentIds: [...basis.citedSegmentIds] } }),
      };
    });
}

/** What the metadata mode (the `chat.system.metadata` prompt) tells the model about a Content without a transcript. */
function metadataOf(content: Content, references: string[]): ChatMetadata {
  const title = displayTitle(content);
  return {
    source: content.source.kind,
    references,
    ...(title === undefined ? {} : { title }),
    ...(content.source.channelTitle === undefined ? {} : { channelTitle: content.source.channelTitle }),
    ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
    ...(content.publishedAt === undefined ? {} : { publishedAt: content.publishedAt }),
  };
}

function threadDto(thread: ChatThreadSummary): ChatThreadDto {
  const title = thread.customTitle ?? chatThreadTitle(thread.firstQuestion, CHAT_THREAD_TITLE_MAX_CHARS);
  return {
    id: thread.id,
    ...(title === undefined ? {} : { title }),
    ...(thread.customTitle === undefined ? {} : { customTitle: thread.customTitle }),
    ...(thread.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
    createdAt: thread.createdAt,
    ...(thread.lastMessageAt === undefined ? {} : { lastMessageAt: thread.lastMessageAt }),
    ...(thread.currentCompactionId === undefined ? {} : { currentCompactionId: thread.currentCompactionId }),
  };
}

function messageDto(message: ChatMessage): ChatMessageDto {
  const quote = message.role === "user" ? message.citations[0] : undefined;
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    status: message.status,
    ...(message.modelRef === undefined ? {} : { modelRef: { ...message.modelRef } }),
    ...(message.contextTranscriptRevisionId === undefined ? {} : { contextTranscriptRevisionId: message.contextTranscriptRevisionId }),
    ...(message.contextUsed === undefined ? {} : { contextUsed: { ...message.contextUsed } }),
    citations: message.role === "user" ? [] : message.citations.map((citation) => ({ ...citation })),
    ...(message.suggestions === undefined ? {} : { suggestions: [...message.suggestions] }),
    ...(quote === undefined ? {} : { quote: { ...quote } }),
    ...(message.webSearch === undefined ? {} : { webSearch: structuredClone(message.webSearch) }),
    ...(message.replacesMessageId === undefined ? {} : { replacesMessageId: message.replacesMessageId }),
    ...(message.error === undefined ? {} : { error: structuredClone(message.error) }),
    createdAt: message.createdAt,
    ...(message.finishedAt === undefined ? {} : { finishedAt: message.finishedAt }),
  };
}

/**
 * What an answer reports and keeps about the material it was finally planned with: only when
 * it reads speakers or the default summary was left out, which the estimate shown before
 * asking cannot tell; otherwise nothing, as before speakers existed.
 */
function contextUsed(state: ThreadState, plan: ChatRequestPlan): ChatContextUsed | undefined {
  if (state.speakers === undefined && !state.summaryOmitted) {
    return undefined;
  }
  return {
    mode: plan.mode,
    ...(plan.speakerClips === true ? { speakerClips: true as const } : {}),
    ...(state.summaryOmitted ? { summaryOmitted: true as const } : {}),
  };
}

function skippedSearch(mode: "auto" | "force", reason: NonNullable<ChatWebSearch["reason"]>): ChatWebSearch {
  return { mode, status: "skipped", reason, planned: 0, requested: 0, succeeded: 0, queries: [], sources: [] };
}

function searchDone(record: ChatWebSearch): ChatStreamEvent {
  return {
    type: "search.done",
    data: {
      status: record.status,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      requested: record.requested,
      succeeded: record.succeeded,
      sources: record.sources.map((source) => ({ ...source })),
      ...(record.error === undefined ? {} : { error: record.error }),
    },
  };
}

function toStreamEvent(event: ReturnType<ChatStreamAssembler["push"]>[number]): ChatStreamEvent {
  return event.type === "answer.delta"
    ? { type: "answer.delta", data: { delta: event.delta } }
    : { type: "citation", data: { ...event.citation, startMs: event.startMs } };
}

function requireContextWindow(description: LlmModelDescription, modelRef: ModelRef): number {
  const contextWindowTokens = description.capability.limits.contextWindowTokens;
  if (contextWindowTokens === undefined) {
    throw amberError("llm_capability", "the chat model has no context window", {
      code: "llm_capability.context_window_unknown",
      details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
    });
  }
  return contextWindowTokens;
}

function chatInflight() {
  return amberError("conflict", "an answer of this chat thread is still streaming", { code: "conflict.chat_inflight" });
}

/** Passes the events through and calls `release` once the stream ends, however it ends. */
async function* tracked<T>(events: AsyncIterable<T>, release: () => void): AsyncGenerator<T> {
  try {
    yield* events;
  } finally {
    release();
  }
}
