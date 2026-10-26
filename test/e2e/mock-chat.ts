import type { Page, Request, Route } from "@playwright/test";
import {
  chatDtoSchema,
  chatMessageDtoSchema,
  chatMessageRequestSchema,
  chatRetryRequestSchema,
  chatStreamEventSchemas,
  chatThreadCreatedDtoSchema,
  chatThreadPatchRequestSchema,
  chatThreadsDtoSchema,
  chatTurnsDeleteRequestSchema,
  type ChatMessageDto,
  type ChatStreamEventType,
  type ChatThreadDto,
  type WebSourceDto,
} from "../../src/shared/dto/chat.ts";
import { providerListDtoSchema } from "../../src/shared/dto/provider.ts";
import { webSearchProfileDtoSchema, webSearchProfilePutSchema, type WebSearchProfileDto } from "../../src/shared/dto/web-search.ts";
import { BILI_REVISION, BILIBILI_CONTENT, CITED_INDEX, CITED_START_MS, PROFILE, providerProfile, REVISION, segmentId } from "./mock-backend.ts";

/**
 * The fake chat of the browser smoke: per page, every Content's threads with their
 * messages; answers streamed as a single SSE body whose events are parsed with the shared
 * schemas (optionally held back for a while, so a page can switch threads meanwhile);
 * thread renaming and pinning, retries, turn deletion and a fake web search service. A switch makes a Content's model
 * report an unknown context window until an override is saved.
 */

interface MockThread {
  id: string;
  createdAt: number;
  customTitle?: string;
  pinnedAt?: number;
  messages: ChatMessageDto[];
}

interface ChatState {
  threads: Map<string, MockThread[]>;
  unknownWindow: Set<string>;
  /** Contents answered in the metadata mode, as if they had no transcript yet. */
  noTranscript: Set<string>;
  webSearch: WebSearchProfileDto;
  /** How long an answer is held back before it is sent. */
  delayMs: number;
  next: number;
}

const states = new WeakMap<Page, ChatState>();

function stateOf(page: Page): ChatState {
  let state = states.get(page);
  if (state === undefined) {
    state = { threads: new Map(), unknownWindow: new Set(), noTranscript: new Set(), webSearch: { credentialStatus: "missing" }, delayMs: 0, next: 0 };
    states.set(page, state);
  }
  return state;
}

/** Makes `GET chat` of this Content report `context_window_unknown` until the Profile is saved with a context window. */
export function setContextWindowUnknown(page: Page, contentId: string): void {
  stateOf(page).unknownWindow.add(contentId);
}

/** Makes this Content's chat run in the metadata mode (no transcript yet). */
export function setNoTranscript(page: Page, contentId: string): void {
  stateOf(page).noTranscript.add(contentId);
}

/** Holds every later answer back for `ms` before its stream is sent. */
export function setChatDelay(page: Page, ms: number): void {
  stateOf(page).delayMs = ms;
}

/** A configured search service, so the chat's web search switch is usable. */
export function setWebSearchConfigured(page: Page): void {
  stateOf(page).webSearch = { service: "tavily", credentialStatus: "configured" };
}

/** The metadata-mode answer: it says it is not grounded and cites nothing. */
export const CHAT_METADATA_ANSWER = "字幕尚未就绪，以下回答未依据视频原文。";

/** The answer every question gets; it cites the sentence the summary cites too. */
export const CHAT_ANSWER_PREFIX = "这一讲的重点在第八句";
export const CHAT_SUGGESTIONS = ["第八句具体讲了什么？", "还有哪些例子？"];
/** A retried answer starts with this instead. */
export const CHAT_RETRY_PREFIX = "换个角度说";
/** The single page every web search finds. */
export const CHAT_WEB_SOURCE = { url: "https://news.example.org/amber", title: "模拟新闻报道" };
/** Messages are stamped from this moment on, a minute apart: 15:40 UTC is 23:40 in Beijing. */
export const CHAT_CLOCK_START = Date.UTC(2026, 9, 26, 15, 40);
const MINUTE = 60_000;

const revisionOf = (contentId: string): string => (contentId === BILIBILI_CONTENT ? BILI_REVISION : REVISION);

function sse<T extends ChatStreamEventType>(type: T, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(chatStreamEventSchemas[type].parse(data))}\n\n`;
}

const idOf = (state: ChatState, kind: string): string => `01J00000000000000000${kind}${String(++state.next).padStart(3, "0")}`;
const clock = (state: ChatState): number => CHAT_CLOCK_START + state.next * MINUTE;

function titleOf(thread: MockThread): string | undefined {
  return thread.customTitle ?? thread.messages.find((message) => message.role === "user")?.text.split("\n")[0];
}

function threadDto(thread: MockThread): ChatThreadDto {
  const title = titleOf(thread);
  const last = thread.messages.at(-1);
  return {
    id: thread.id,
    createdAt: thread.createdAt,
    ...(title === undefined ? {} : { title }),
    ...(thread.customTitle === undefined ? {} : { customTitle: thread.customTitle }),
    ...(thread.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
    ...(last === undefined ? {} : { lastMessageAt: last.finishedAt ?? last.createdAt }),
  };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function refuse(route: Route, status: number, errorClass: string, code: string, extra: Record<string, unknown> = {}): Promise<void> {
  return json(route, { error: { class: errorClass, code, retryDisposition: "never", userMessage: "", ...extra } }, status);
}

/** Splits a thread's messages into turns: a question and the answers after it. */
function turnsOf(messages: readonly ChatMessageDto[]): ChatMessageDto[][] {
  const turns: ChatMessageDto[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([message]);
    else turns.at(-1)?.push(message);
  }
  return turns;
}

/**
 * One answer to `question` with the given prefix: the cited sentence, and — when the web was
 * searched — the page found. Returns the stored message and the SSE body that streams it.
 */
function answer(state: ChatState, contentId: string, threadId: string, userMessageId: string, prefix: string, search: boolean, replaces?: string) {
  const id = idOf(state, "ANS");
  if (state.noTranscript.has(contentId)) {
    const stored = chatMessageDtoSchema.parse({
      id,
      role: "assistant",
      text: CHAT_METADATA_ANSWER,
      status: "complete",
      citations: [],
      createdAt: clock(state),
      finishedAt: clock(state),
      modelRef: { providerProfileId: PROFILE, modelId: "mock-model", providerNameSnapshot: "模拟模型", modelDisplaySnapshot: "mock-model", protocolSnapshot: "openai_compatible" },
    });
    const body = [sse("answer.delta", { delta: CHAT_METADATA_ANSWER }), sse("done", { threadId, userMessageId, messageId: id, status: "complete" })].join("");
    return { stored, body };
  }
  const revision = revisionOf(contentId);
  const cited = segmentId(revision, CITED_INDEX);
  const source: WebSourceDto | undefined = search ? { id: idOf(state, "WEB"), index: 1, ...CHAT_WEB_SOURCE, excerpt: "模拟摘录", fetchedAt: clock(state) } : undefined;
  const deltas = [`${prefix} `, `[[seg:${cited}]]`, source === undefined ? "。" : `，另见报道 [[web:${source.id}]]。`];
  const stored = chatMessageDtoSchema.parse({
    id,
    role: "assistant",
    text: deltas.join(""),
    status: "complete",
    contextTranscriptRevisionId: revision,
    citations: [{ transcriptRevisionId: revision, segmentId: cited }],
    suggestions: CHAT_SUGGESTIONS,
    modelRef: { providerProfileId: PROFILE, modelId: "mock-model", providerNameSnapshot: "模拟模型", modelDisplaySnapshot: "mock-model", protocolSnapshot: "openai_compatible" },
    ...(source === undefined ? {} : { webSearch: { mode: "auto", status: "searched", planned: 1, requested: 1, succeeded: 1, queries: ["Amber 最新消息"], sources: [source] } }),
    ...(replaces === undefined ? {} : { replacesMessageId: replaces }),
    createdAt: clock(state),
    finishedAt: clock(state),
  });
  const body = [
    ...(source === undefined
      ? []
      : [sse("search.started", { planned: 1, queries: ["Amber 最新消息"] }), sse("search.done", { status: "searched", requested: 1, succeeded: 1, sources: [source] })]),
    sse("answer.delta", { delta: deltas[0] }),
    sse("citation", { transcriptRevisionId: revision, segmentId: cited, startMs: CITED_START_MS }),
    sse("answer.delta", { delta: deltas[1] }),
    sse("answer.delta", { delta: deltas[2] }),
    sse("suggestions", { items: CHAT_SUGGESTIONS }),
    sse("usage", { inputTokens: 1200, outputTokens: 40 }),
    sse("done", { threadId, userMessageId, messageId: id, status: "complete" }),
  ].join("");
  return { stored, body };
}

/** `/api/web-search*`; false for anything else. */
async function handleWebSearch(route: Route, request: Request, path: string, state: ChatState): Promise<boolean> {
  const method = request.method();
  if (path === "/api/web-search") {
    if (method === "GET") {
      await json(route, webSearchProfileDtoSchema.parse(state.webSearch));
      return true;
    }
    if (method === "PUT") {
      state.webSearch = { ...state.webSearch, service: webSearchProfilePutSchema.parse(request.postDataJSON()).service };
      await json(route, state.webSearch);
      return true;
    }
    if (method === "DELETE") {
      state.webSearch = { credentialStatus: "missing" };
      await route.fulfill({ status: 204, body: "" });
      return true;
    }
  }
  if (path === "/api/web-search/credential" && method === "PUT") {
    state.webSearch = { ...state.webSearch, credentialStatus: "configured" };
    await json(route, state.webSearch);
    return true;
  }
  if (path === "/api/web-search/test" && method === "POST") {
    await json(route, { ok: true, resultCount: 5 });
    return true;
  }
  return false;
}

/** `/api/contents/:id/chat*`, `/api/web-search*` and the Profile reads / saves of the unknown-context-window switch; false for anything else. */
export async function handleChat(route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const page = request.frame().page();
  const state = stateOf(page);

  if (await handleWebSearch(route, request, path, state)) {
    return true;
  }

  // While a window is unknown the Profile lists its model without one; saving the Profile
  // editor (PATCH with the model's context window) is the user filling it in.
  if (state.unknownWindow.size > 0 && method === "GET" && path === "/api/providers") {
    await json(route, providerListDtoSchema.parse({ items: [providerProfile(undefined)] }));
    return true;
  }
  if (method === "PATCH" && path === `/api/providers/${PROFILE}`) {
    const window = (request.postDataJSON() as { models?: Array<{ contextWindowTokens?: number }> }).models?.[0]?.contextWindowTokens;
    if (window !== undefined && window > 0) {
      state.unknownWindow.clear();
    }
    await json(route, providerProfile(window));
    return true;
  }

  const match = /^\/api\/contents\/([^/]+)\/chat(\/.*)?$/.exec(path);
  if (match === null) {
    return false;
  }
  const contentId = match[1] as string;
  const rest = match[2] ?? "";
  const threads = state.threads.get(contentId) ?? [];
  state.threads.set(contentId, threads);
  const latest = (): MockThread | undefined => threads.at(-1);
  const find = (id: string | null | undefined): MockThread | undefined => (id === null || id === undefined ? latest() : threads.find((thread) => thread.id === id));
  const create = (): MockThread => {
    const thread = { id: idOf(state, "THR"), createdAt: clock(state), messages: [] };
    threads.push(thread);
    return thread;
  };
  const inflight = (thread: MockThread | undefined): boolean => thread?.messages.some((message) => message.status === "streaming") === true;

  if (method === "GET" && rest === "") {
    const context = state.unknownWindow.has(contentId)
      ? { mode: "unavailable", reason: "context_window_unknown" }
      : state.noTranscript.has(contentId)
        ? { mode: "metadata", estimatedTokens: 321 }
        : { mode: "full", estimatedTokens: 4321 };
    const thread = find(url.searchParams.get("threadId"));
    if (url.searchParams.has("threadId") && thread === undefined) {
      await refuse(route, 404, "not_found", "not_found");
      return true;
    }
    await json(route, chatDtoSchema.parse({ thread: thread === undefined ? null : threadDto(thread), messages: thread?.messages ?? [], context }));
    return true;
  }

  if (method === "GET" && rest === "/threads") {
    // Pinned first, the latest pin first; then the latest created first (threads are kept in creation order).
    const listed = [...threads].reverse().sort((a, b) => (b.pinnedAt ?? -1) - (a.pinnedAt ?? -1));
    await json(route, chatThreadsDtoSchema.parse({ threads: listed.map(threadDto) }));
    return true;
  }

  if (method === "POST" && rest === "/threads") {
    const current = latest();
    const thread = current !== undefined && current.messages.length === 0 ? current : create();
    await json(route, chatThreadCreatedDtoSchema.parse({ thread: threadDto(thread) }), 201);
    return true;
  }

  const threadMatch = /^\/threads\/([^/]+)$/.exec(rest);
  if (method === "PATCH" && threadMatch !== null) {
    const thread = threads.find((item) => item.id === threadMatch[1]);
    const parsed = chatThreadPatchRequestSchema.safeParse(request.postDataJSON());
    if (!parsed.success) {
      await refuse(route, 400, "invalid_request", "invalid_request");
      return true;
    }
    if (thread === undefined) {
      await refuse(route, 404, "not_found", "not_found");
      return true;
    }
    // Allowed while an answer streams. A blank or null title drops the user's own name.
    const { title, pinned } = parsed.data;
    if (title !== undefined) {
      if (title === null || title === "") delete thread.customTitle;
      else thread.customTitle = title;
    }
    if (pinned === true) {
      state.next += 1;
      thread.pinnedAt = clock(state);
    } else if (pinned === false) {
      delete thread.pinnedAt;
    }
    await json(route, chatThreadCreatedDtoSchema.parse({ thread: threadDto(thread) }));
    return true;
  }
  if (method === "DELETE" && threadMatch !== null) {
    const index = threads.findIndex((thread) => thread.id === threadMatch[1]);
    if (inflight(threads[index])) {
      await refuse(route, 409, "conflict", "conflict.chat_inflight");
      return true;
    }
    if (index >= 0) threads.splice(index, 1);
    await route.fulfill({ status: 204, body: "" });
    return true;
  }

  if (method === "DELETE" && rest === "") {
    if (threads.some(inflight)) {
      await refuse(route, 409, "conflict", "conflict.chat_inflight");
      return true;
    }
    state.threads.delete(contentId);
    await route.fulfill({ status: 204, body: "" });
    return true;
  }

  if (method === "POST" && rest === "/turns/delete") {
    const { messageIds } = chatTurnsDeleteRequestSchema.parse(request.postDataJSON());
    const deleted: string[] = [];
    for (const thread of threads) {
      const turns = turnsOf(thread.messages);
      const doomed = turns.filter((turn) => turn.some((message) => messageIds.includes(message.id)));
      if (doomed.length > 0 && inflight(thread)) {
        await refuse(route, 409, "conflict", "conflict.chat_inflight");
        return true;
      }
      for (const turn of doomed) deleted.push(...turn.map((message) => message.id));
      thread.messages = thread.messages.filter((message) => !deleted.includes(message.id));
    }
    await json(route, { deleted });
    return true;
  }

  // The stream is held back as asked; the answer is stored `streaming` meanwhile, as the
  // server would, and completed just before it is sent.
  const respond = async (thread: MockThread, placeholder: ChatMessageDto, stored: ChatMessageDto, body: string): Promise<void> => {
    thread.messages.push(placeholder);
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    thread.messages = thread.messages.map((message) => (message.id === placeholder.id ? stored : message));
    await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => undefined);
  };

  if (method === "POST" && rest === "/messages") {
    const asked = chatMessageRequestSchema.parse(request.postDataJSON());
    const configured = state.webSearch.credentialStatus === "configured";
    if (asked.webSearch === "force" && !configured) {
      await refuse(route, 422, "web_search_failed", "web_search_failed.unconfigured", { action: "configure_web_search" });
      return true;
    }
    const thread = asked.threadId === undefined ? (latest() ?? create()) : find(asked.threadId);
    if (thread === undefined) {
      await refuse(route, 404, "not_found", "not_found");
      return true;
    }
    if (inflight(thread)) {
      await refuse(route, 409, "conflict", "conflict.chat_inflight");
      return true;
    }
    const user = chatMessageDtoSchema.parse({
      id: idOf(state, "USR"),
      role: "user",
      text: asked.text,
      status: "complete",
      citations: asked.quote === undefined ? [] : [asked.quote],
      ...(asked.quote === undefined ? {} : { quote: asked.quote }),
      createdAt: clock(state),
    });
    thread.messages.push(user);
    const search = configured && (asked.webSearch === "force" || asked.webSearch === "auto");
    const { stored, body } = answer(state, contentId, thread.id, user.id, CHAT_ANSWER_PREFIX, search);
    await respond(thread, { ...stored, text: "", status: "streaming", finishedAt: undefined } as ChatMessageDto, stored, body);
    return true;
  }

  const retryMatch = /^\/messages\/([^/]+)\/retry$/.exec(rest);
  if (method === "POST" && retryMatch !== null) {
    const asked = chatRetryRequestSchema.parse(request.postDataJSON());
    const thread = threads.find((item) => item.messages.some((message) => message.id === retryMatch[1]));
    const turn = thread === undefined ? undefined : turnsOf(thread.messages).at(-1);
    if (thread === undefined || turn === undefined || !turn.some((message) => message.id === retryMatch[1])) {
      await refuse(route, 409, "conflict", "conflict.chat_retry_not_last");
      return true;
    }
    if (inflight(thread)) {
      await refuse(route, 409, "conflict", "conflict.chat_inflight");
      return true;
    }
    const user = turn[0] as ChatMessageDto;
    const search = state.webSearch.credentialStatus === "configured" && asked.webSearch !== undefined && asked.webSearch !== "off";
    const { stored, body } = answer(state, contentId, thread.id, user.id, CHAT_RETRY_PREFIX, search, retryMatch[1]);
    // Earlier failed attempts go first; a successful retry then replaces the answer it retried.
    thread.messages = thread.messages.filter((message) => message.role === "user" || !turn.includes(message) || message.id === retryMatch[1]);
    await respond(thread, { ...stored, text: "", status: "streaming", finishedAt: undefined } as ChatMessageDto, stored, body);
    thread.messages = thread.messages.filter((message) => message.id !== retryMatch[1]);
    return true;
  }
  return false;
}
