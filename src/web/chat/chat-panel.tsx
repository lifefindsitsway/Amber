import { useQueryClient } from "@tanstack/react-query";
import { BrushCleaning, ChevronDown, ChevronUp, Dock, GripHorizontal, ListChecks, Maximize2, MessageSquare, Minimize2, PictureInPicture2, Plus, Quote, Send, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { z } from "zod";
import { CHAT_DELETE_TURNS_MAX } from "../../shared/defaults.ts";
import {
  chatThreadCreatedDtoSchema,
  chatTurnsDeleteResultSchema,
  type ChatContextDto,
  type ChatMessageDto,
  type ChatQuote,
  type ChatStreamEvent,
  type ChatThreadDto,
  type ChatThreadsDto,
  type WebSourceDto,
} from "../../shared/dto/chat.ts";
import type { ModelRefDto } from "../../shared/dto/model-ref.ts";
import type { ChatMessageStatus, ChatWebSearchSetting, WebSearchMode } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, usePatchSettings, useProviders, useSettings, useWebSearchProfile } from "../api/queries.ts";
import { ErrorView } from "../components/error-view.tsx";
import { formatBeijingDateTime } from "../format.ts";
import { useContentPage } from "../pages/content/content-context.tsx";
import { ConfirmDialog } from "../pages/content/confirm-dialog.tsx";
import { usePlayerController } from "../player/player-controller.tsx";
import { Button } from "../ui/button.tsx";
import { RESIZE_EDGES, useFloatingBox, type BoxRect, type ResizeEdge } from "../ui/use-floating-box.ts";
import { useChatComposer, useComposerState, type QuoteDraft } from "./chat-composer.tsx";
import {
  chatKeys,
  chatModelOptions,
  defaultChatModel,
  groupTurns,
  latestThread,
  modelKey,
  readStoredThread,
  storeThread,
  turnDisplay,
  useChat,
  useChatThreads,
  usePatchChatThread,
  type ChatTurn,
} from "./chat-data.ts";
import { AssistantMessage, UserMessage } from "./chat-message.tsx";
import { readChatAnswer } from "./chat-stream.ts";
import { ChatInputResizer } from "./chat-input-resizer.tsx";
import { ChatThreadMenu, useThreadTitle } from "./chat-thread-menu.tsx";
import { ChatThreadRenameDialog } from "./chat-thread-rename-dialog.tsx";
import { TurnCheckbox, TurnSelectBar } from "./chat-turn-select.tsx";
import { storedSearchView, WebSearchToggle, type WebSearchView } from "./chat-web-search.tsx";

type PanelSize = "collapsed" | "normal" | "full";

/** The smallest floating window; a smaller viewport shrinks it to the viewport. */
const FLOAT_MIN_WIDTH_PX = 360;
const FLOAT_MIN_HEIGHT_PX = 280;
/** A message list scrolled to within this distance of its end counts as following the end. */
const AT_BOTTOM_PX = 8;

const NO_RECT: BoxRect = { left: 0, top: 0, width: 0, height: 0 };

/**
 * Where the panel is shown, for a page that keeps one panel across its layouts. The panel
 * stays mounted while it moves between the dock and the floating window, or has nowhere to
 * be shown at all, so no answer in flight and no draft is lost on the way.
 */
export interface ChatPlacement {
  /** The slot under the player; null while that column is not rendered. */
  dockHost: HTMLElement | null;
  /** Shown as a window fixed on the viewport instead of in the dock. */
  floating: boolean;
  /** Whether the layout allows floating; the dock offers it only then. */
  canFloat: boolean;
  onFloatingChange: (floating: boolean) => void;
  /** The floating window's stored place and size, clamped to the viewport when shown. */
  rect: BoxRect;
  /** A move or resize the user made. */
  onRectCommit: (rect: BoxRect) => void;
}

const EDGE_CLASS: Record<ResizeEdge, string> = {
  n: "-top-1 inset-x-3 h-2 cursor-ns-resize",
  s: "-bottom-1 inset-x-3 h-2 cursor-ns-resize",
  e: "-right-1 inset-y-3 w-2 cursor-ew-resize",
  w: "-left-1 inset-y-3 w-2 cursor-ew-resize",
  ne: "-right-1 -top-1 size-3 cursor-nesw-resize",
  nw: "-left-1 -top-1 size-3 cursor-nwse-resize",
  se: "-right-1 -bottom-1 size-3 cursor-nwse-resize",
  sw: "-left-1 -bottom-1 size-3 cursor-nesw-resize",
};

const GESTURE_CURSOR: Record<"move" | ResizeEdge, string> = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/** The answer being streamed, shown until the stored thread is read back. */
export interface PendingTurn {
  /** `retry`: a new attempt at the last turn, shown over the answer it replaces. */
  kind: "send" | "retry";
  question: string;
  quote: QuoteDraft | undefined;
  answer: string;
  /** Start times and revisions announced by `citation` events. */
  cited: Map<string, { transcriptRevisionId: string; startMs: number }>;
  suggestions: string[] | undefined;
  status: ChatMessageStatus;
  error: AppError | undefined;
  /** Sent while the context was `metadata`: the answer is not grounded in the video. */
  ungrounded: boolean;
  search: WebSearchView | undefined;
  sources: WebSourceDto[];
  /** The stored answer's id, known from `done`. */
  messageId: string | undefined;
}

export function pendingTurn(kind: PendingTurn["kind"], question: string, quote: QuoteDraft | undefined, ungrounded: boolean): PendingTurn {
  return { kind, question, quote, answer: "", cited: new Map(), suggestions: undefined, status: "streaming", error: undefined, ungrounded, search: undefined, sources: [], messageId: undefined };
}

const CONTEXT_WINDOW_UNKNOWN = "llm_capability.context_window_unknown";
const MODEL_MISSING = "llm_unconfigured.model_missing";

/** Folds one SSE event of the answer into the pending turn. */
export function applyChatEvent(turn: PendingTurn, event: ChatStreamEvent): PendingTurn {
  switch (event.type) {
    case "search.started":
      return { ...turn, search: { phase: "searching", queries: event.data.queries } };
    case "search.done":
      return {
        ...turn,
        search: { phase: "done", status: event.data.status, reason: event.data.reason, sources: event.data.sources, error: event.data.error },
        sources: event.data.sources,
      };
    case "answer.delta":
      return { ...turn, answer: turn.answer + event.data.delta };
    case "citation": {
      const cited = new Map(turn.cited);
      cited.set(event.data.segmentId, { transcriptRevisionId: event.data.transcriptRevisionId, startMs: event.data.startMs });
      return { ...turn, cited };
    }
    case "suggestions":
      return { ...turn, suggestions: event.data.items };
    case "done":
      return { ...turn, status: event.data.status, error: event.data.error, messageId: event.data.messageId };
    default:
      return turn;
  }
}

/**
 * What the panel keeps per thread, so a thread's draft, its answer in flight and its last
 * refusal stay with it while another thread is open.
 */
interface ThreadState {
  pending: PendingTurn | undefined;
  running: boolean;
  /** Why the last send or retry was refused before anything was stored. */
  error: AppError | undefined;
  draft: string;
  quote: QuoteDraft | undefined;
  /** Errors of answers that failed in this page, by message id; stored messages carry only their status. */
  failures: Record<string, AppError>;
}

const EMPTY_THREAD: ThreadState = { pending: undefined, running: false, error: undefined, draft: "", quote: undefined, failures: {} };

/** The state key of the thread a first question creates, until its `done` names it. */
const NEW_THREAD = "";

/**
 * The dialogue area of the middle column: the Content's threads, streamed answers with
 * clickable citations and web sources, per-turn copy / retry / delete, the model selector,
 * the web search switch and the context mode label. It folds to a single input line, and
 * fills the column when asked to or when the player is hidden. Nothing is sent without the
 * user pressing send. Switching threads never stops an answer: each thread keeps its own
 * draft and answer in flight, and the open thread is remembered for this page session.
 * Without `placement` it renders where it stands; with it, it goes to the dock or floats.
 */
export function ChatPanel(props: { fill: boolean; placement?: ChatPlacement }) {
  const { t } = useTranslation();
  const page = useContentPage();
  const contentId = page.content.id;
  const client = useApi();
  const queryClient = useQueryClient();
  const player = usePlayerController();
  const providers = useProviders();
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const webSearchProfile = useWebSearchProfile();
  const composer = useChatComposer();
  const composed = useComposerState();
  const titleOf = useThreadTitle();
  const options = useMemo(() => chatModelOptions(providers.data?.items ?? []), [providers.data]);
  const [picked, setPicked] = useState<ModelRefDto | undefined>(undefined);
  const modelRef = picked ?? defaultChatModel(options, settings.data);
  const ready = !providers.isPending && !settings.isPending;

  const threads = useChatThreads(contentId);
  const [chosen, setChosen] = useState<string | undefined>(() => readStoredThread(contentId));
  const threadList = threads.data?.threads;
  const thread: ChatThreadDto | undefined = threadList?.find((item) => item.id === chosen) ?? latestThread(threadList ?? []);
  const threadId = thread?.id;
  const key = threadId ?? NEW_THREAD;
  const activeKey = useRef(key);
  activeKey.current = key;
  const [states, setStates] = useState<Record<string, ThreadState>>({});
  const state = states[key] ?? EMPTY_THREAD;
  const controllers = useRef(new Map<string, AbortController>());
  // Read alongside the thread list rather than after it: an explicit choice is asked for by
  // id (until the list shows it is gone), otherwise the server's latest thread is the one shown.
  const requested = threadList === undefined || threadList.some((item) => item.id === chosen) ? chosen : undefined;
  const chat = useChat(contentId, requested, modelRef, { enabled: ready, poll: !state.running });

  const [size, setSize] = useState<PanelSize>("normal");
  const [input, setInput] = useState("");
  const [rememberedMode, setRememberedMode] = useState<ChatWebSearchSetting | undefined>(undefined);
  const [forceNext, setForceNext] = useState(false);
  const [actionError, setActionError] = useState<AppError | undefined>(undefined);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmTurns, setConfirmTurns] = useState<string[] | undefined>(undefined);
  const [confirmThread, setConfirmThread] = useState<ChatThreadDto | undefined>(undefined);
  const [renaming, setRenaming] = useState<ChatThreadDto | undefined>(undefined);
  const patchThread = usePatchChatThread(contentId);
  const [modelMissing, setModelMissing] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { placement } = props;
  const floating = placement?.floating === true;
  const floatBox = useFloatingBox({
    rect: placement?.rect ?? NO_RECT,
    minWidth: FLOAT_MIN_WIDTH_PX,
    minHeight: FLOAT_MIN_HEIGHT_PX,
    onCommit: (rect) => placement?.onRectCommit(rect),
  });
  // `undefined`: rendered in place; `null`: nowhere to show it, though the panel lives on.
  const target = placement === undefined ? undefined : floating ? document.body : placement.dockHost;
  // Moving to another container renders the list afresh; it comes back at the reader's place.
  const reading = useRef({ top: 0, atBottom: true });
  const onListScroll = (event: UIEvent<HTMLDivElement>): void => {
    const list = event.currentTarget;
    reading.current = { top: list.scrollTop, atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < AT_BOTTOM_PX };
  };
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    list.scrollTop = reading.current.atBottom ? list.scrollHeight : reading.current.top;
  }, [target]);

  const patch = (stateKey: string, change: (current: ThreadState) => ThreadState): void =>
    setStates((all) => ({ ...all, [stateKey]: change(all[stateKey] ?? EMPTY_THREAD) }));

  // "Explain" from the selection toolbar: the question is pre-filled, never sent.
  const prefillSeq = composed.prefill?.seq;
  useEffect(() => {
    if (composed.prefill === undefined) return;
    setInput(composed.prefill.text);
    setSize((current) => (current === "collapsed" ? "normal" : current));
    inputRef.current?.focus();
    // Keyed by the request number: only a new "explain" re-fills the input.
  }, [prefillSeq]);

  // Leaving the page stops every answer still streaming; switching threads stops none.
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
    },
    [],
  );

  useEffect(() => {
    if (threadId !== undefined) storeThread(contentId, threadId);
  }, [contentId, threadId]);

  // A dragged input height is dropped when the panel folds, so it comes back at its natural size.
  useEffect(() => {
    if (size === "collapsed" && !floating && inputRef.current !== null) inputRef.current.style.height = "";
  }, [size, floating]);

  const stored = chat.data?.messages ?? [];
  const pending = state.pending;
  // Once the stored thread holds the answer, it is shown from there.
  const live = pending !== undefined && pending.messageId !== undefined && stored.some((message) => message.id === pending.messageId) ? undefined : pending;
  const turns = useMemo(() => {
    const all = groupTurns(stored);
    const last = all.at(-1);
    // The stored copy of the turn this page is still streaming: shown from the stream instead.
    if (live?.kind === "send" && last !== undefined && (last.attempts.length === 0 || last.attempts.at(-1)?.status === "streaming")) return all.slice(0, -1);
    return all;
  }, [stored, live?.kind]);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [stored.length, pending?.answer, pending?.status, key]);

  const context: ChatContextDto | undefined = chat.data?.context;
  const contextUnknown = state.error?.code === CONTEXT_WINDOW_UNKNOWN;
  const unavailableReason = modelRef === undefined && providers.isSuccess ? "no_model" : contextUnknown ? "context_window_unknown" : context?.mode === "unavailable" ? context.reason : undefined;
  const blocked = unavailableReason !== undefined || modelRef === undefined;
  const threadBusy = state.running || stored.some((message) => message.status === "streaming");
  const anyRunning = threadBusy || Object.values(states).some((item) => item.running);
  const runningThreads = useMemo(() => new Set(Object.entries(states).flatMap(([stateKey, item]) => (item.running && stateKey !== NEW_THREAD ? [stateKey] : []))), [states]);
  const searchAvailable = webSearchProfile.data?.credentialStatus === "configured";
  const remembered: ChatWebSearchSetting = rememberedMode ?? settings.data?.chatWebSearchMode ?? "off";
  const webMode: WebSearchMode = forceNext ? "force" : remembered;
  const path = `/api/contents/${encodeURIComponent(contentId)}/chat`;

  const refreshAll = (): Promise<void> => queryClient.invalidateQueries({ queryKey: chatKeys.all(contentId) });

  /** The first answer of a new thread names it: its state and stream move under its id. */
  const adopt = (newThreadId: string): void => {
    setStates((all) => {
      const moved = all[NEW_THREAD];
      if (moved === undefined) return all;
      const { [NEW_THREAD]: _moved, ...rest } = all;
      return { ...rest, [newThreadId]: moved };
    });
    const controller = controllers.current.get(NEW_THREAD);
    if (controller !== undefined) {
      controllers.current.delete(NEW_THREAD);
      controllers.current.set(newThreadId, controller);
    }
    queryClient.setQueryData<ChatThreadsDto>(chatKeys.threads(contentId), (old) =>
      old === undefined || old.threads.some((item) => item.id === newThreadId) ? old : { threads: [{ id: newThreadId, createdAt: Date.now() }, ...old.threads] },
    );
    if (activeKey.current === NEW_THREAD) setChosen(newThreadId);
  };

  /**
   * Streams one answer (a new question or a retry) into its thread's state, whichever thread
   * is open meanwhile, then reads that thread back. A refusal before the stream started
   * stores nothing and goes to `onRefused`.
   */
  const runStream = async (startKey: string, url: string, body: unknown, turn: PendingTurn, onRefused: (error: AppError) => void): Promise<void> => {
    let streamKey = startKey;
    const controller = new AbortController();
    controllers.current.set(streamKey, controller);
    patch(streamKey, (current) => ({ ...current, pending: turn, running: true, error: undefined }));
    let persisted = true;
    try {
      const response = await client.postStream(url, { body, idempotent: true, signal: controller.signal });
      const outcome = await readChatAnswer(response, (event) => {
        if (event.type === "done") {
          if (streamKey === NEW_THREAD) {
            adopt(event.data.threadId);
            streamKey = event.data.threadId;
          }
          const failure = event.data.error;
          if (failure !== undefined) patch(streamKey, (current) => ({ ...current, failures: { ...current.failures, [event.data.messageId]: failure } }));
        }
        patch(streamKey, (current) => (current.pending === undefined ? current : { ...current, pending: applyChatEvent(current.pending, event) }));
      });
      if (outcome.kind === "stream" && !outcome.done) {
        patch(streamKey, (current) => (current.pending === undefined ? current : { ...current, pending: { ...current.pending, status: "interrupted" } }));
      }
    } catch (error) {
      if (error instanceof ApiError) {
        persisted = false;
        patch(streamKey, (current) => ({ ...current, pending: undefined, running: false }));
        onRefused(error.error);
      } else {
        patch(streamKey, (current) => (current.pending === undefined ? current : { ...current, pending: { ...current.pending, status: "interrupted" } }));
      }
    } finally {
      if (controllers.current.get(streamKey) === controller) controllers.current.delete(streamKey);
    }
    if (persisted) {
      await Promise.all([
        refreshAll(),
        // The thread may no longer be open; read it anyway so coming back shows the result at once.
        queryClient.invalidateQueries({ queryKey: chatKeys.threadAll(contentId, streamKey === NEW_THREAD ? undefined : streamKey), refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
      ]);
      patch(streamKey, (current) => ({ ...current, pending: undefined, running: false }));
    }
  };

  const positionMs = (): number | undefined => {
    const position = player.capabilities.timeTracking === "supported" ? player.currentTimeMs() : undefined;
    return position === undefined ? undefined : Math.max(0, Math.round(position));
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text === "" || modelRef === undefined || blocked || threadBusy) return;
    const startKey = key;
    const quote = composed.quote;
    const position = positionMs();
    const webSearch = searchAvailable ? webMode : undefined;
    const body = {
      text,
      modelRef,
      ...(threadId === undefined ? {} : { threadId }),
      ...(webSearch === undefined ? {} : { webSearch }),
      ...(quote === undefined ? {} : { quote: { transcriptRevisionId: quote.transcriptRevisionId, segmentId: quote.segmentId } satisfies ChatQuote }),
      ...(position === undefined ? {} : { positionMs: position }),
    };
    setInput("");
    setActionError(undefined);
    composer.clearQuote();
    setForceNext(false);
    setSize((current) => (current === "collapsed" ? "normal" : current));
    await runStream(startKey, `${path}/messages`, body, pendingTurn("send", text, quote, context?.mode === "metadata"), (error) => {
      // Refused before anything was stored: give the question back to its thread.
      if (activeKey.current === startKey) {
        setInput(text);
        composer.restoreQuote(quote);
        if (webSearch === "force") setForceNext(true);
      }
      patch(startKey, (current) => ({ ...current, error, ...(activeKey.current === startKey ? {} : { draft: text, quote }) }));
    });
  };

  /** Answers the last turn again; `model` is set once the user agreed to replace a model that is gone. */
  const retry = async (answerId: string, model?: ModelRefDto): Promise<void> => {
    if (threadBusy) return;
    const startKey = key;
    const position = positionMs();
    const webSearch = searchAvailable ? webMode : undefined;
    const body = {
      ...(model === undefined ? {} : { modelRef: model }),
      ...(webSearch === undefined ? {} : { webSearch }),
      ...(position === undefined ? {} : { positionMs: position }),
    };
    setActionError(undefined);
    if (webSearch === "force") setForceNext(false);
    await runStream(startKey, `${path}/messages/${encodeURIComponent(answerId)}/retry`, body, pendingTurn("retry", "", undefined, context?.mode === "metadata"), (error) => {
      if (error.code === MODEL_MISSING && model === undefined && activeKey.current === startKey) setModelMissing(answerId);
      else patch(startKey, (current) => ({ ...current, error }));
    });
  };

  /** Runs a delete or create with the panel's busy flag; a refusal (e.g. an answer in flight) is shown. */
  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError) setActionError(error.error);
      else throw error;
    } finally {
      setBusy(false);
    }
  };

  const deleteTurns = (messageIds: string[]): Promise<void> =>
    act(async () => {
      try {
        for (let start = 0; start < messageIds.length; start += CHAT_DELETE_TURNS_MAX) {
          await client.post(`${path}/turns/delete`, chatTurnsDeleteResultSchema, { body: { messageIds: messageIds.slice(start, start + CHAT_DELETE_TURNS_MAX) } });
        }
        setSelecting(false);
        setSelected(new Set());
      } finally {
        setConfirmTurns(undefined);
        await refreshAll();
      }
    });

  const selectThread = (next: string): void => {
    if (next === key) return;
    patch(key, (current) => ({ ...current, draft: input, quote: composed.quote }));
    const target = states[next] ?? EMPTY_THREAD;
    setInput(target.draft);
    composer.restoreQuote(target.quote);
    setChosen(next);
    setSelecting(false);
    setSelected(new Set());
    setActionError(undefined);
  };

  const newThread = (): Promise<void> =>
    act(async () => {
      const { thread: created } = await client.post(`${path}/threads`, chatThreadCreatedDtoSchema);
      // Read the list back rather than placing the thread here: the server decides the order.
      await queryClient.invalidateQueries({ queryKey: chatKeys.threads(contentId) });
      selectThread(created.id);
    });

  const deleteThread = (target: ChatThreadDto): Promise<void> =>
    act(async () => {
      try {
        await client.delete(`${path}/threads/${encodeURIComponent(target.id)}`, z.undefined());
        setStates(({ [target.id]: _gone, ...rest }) => rest);
        queryClient.removeQueries({ queryKey: chatKeys.threadAll(contentId, target.id) });
        if (target.id === key) {
          setChosen(undefined);
          storeThread(contentId, undefined);
          setInput("");
          composer.clearQuote();
        }
      } finally {
        setConfirmThread(undefined);
        await refreshAll();
      }
    });

  /** Pins or unpins without the busy flag: like renaming, it may happen while an answer streams. */
  const pinThread = (target: ChatThreadDto, pinned: boolean): void => {
    setActionError(undefined);
    patchThread.mutate(
      { threadId: target.id, patch: { pinned } },
      {
        onError: (error) => {
          if (error instanceof ApiError) setActionError(error.error);
        },
      },
    );
  };

  const clear = (): Promise<void> =>
    act(async () => {
      try {
        await client.delete(path, z.undefined());
        setStates({});
        setChosen(undefined);
        storeThread(contentId, undefined);
        setSelecting(false);
        setSelected(new Set());
      } finally {
        setConfirmClear(false);
        await refreshAll();
      }
    });

  const changeWebMode = (mode: WebSearchMode): void => {
    if (mode === "force") {
      setForceNext(true);
      return;
    }
    setForceNext(false);
    setRememberedMode(mode);
    // `force` is never remembered; off / auto are, here and by the server on the next send.
    if (mode !== (settings.data?.chatWebSearchMode ?? "off")) patchSettings.mutate({ chatWebSearchMode: mode });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  // The floating window has neither fold nor full height: its own size is what the user set.
  const shownSize: PanelSize = floating ? "normal" : size;
  const fill = floating || props.fill || shownSize === "full";
  const collapsed = shownSize === "collapsed";
  // In full height the section is a size container, so the input's cap can be a share of it.
  const frame = floating ? "" : collapsed ? "" : fill ? "min-h-96 flex-1 [container-type:size]" : "h-96";
  // The height is dragged from the grip on the box's top edge, so the textarea's own corner handle is off.
  const inputSize = collapsed ? "h-9 resize-none" : `field-sizing-content resize-none min-h-14 ${fill ? "max-h-[45cqh]" : "max-h-60"}`;

  const sendOrStop = state.running ? (
    <button
      type="button"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-ink text-surface hover:opacity-80"
      onClick={() => controllers.current.get(key)?.abort()}
      title={t("chat.stop")}
      aria-label={t("chat.stop")}
      data-testid="chat-stop"
    >
      <Square size={12} fill="currentColor" aria-hidden="true" />
    </button>
  ) : (
    <button
      type="button"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-glow text-accent-ink hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={blocked || threadBusy || input.trim() === ""}
      onClick={() => void send()}
      title={t("chat.send")}
      aria-label={t("chat.send")}
      data-testid="chat-send"
    >
      <Send size={14} aria-hidden="true" />
    </button>
  );

  const onSuggestion = (text: string): void => {
    setInput(text);
    inputRef.current?.focus();
  };

  const renderTurn = (turn: ChatTurn, index: number) => {
    const last = index === turns.length - 1;
    const overlay = last && live?.kind === "retry" ? live : undefined;
    const { answer, failedAttempt } = turnDisplay(turn);
    // The stored error, or the one the stream reported when it failed in this page.
    const failureOf = (message: ChatMessageDto): AppError | undefined => message.error ?? state.failures[message.id];
    const failure = failedAttempt === undefined ? undefined : failureOf(failedAttempt);
    // An interrupted attempt has no error: its status says what happened.
    const failedReason =
      failedAttempt === undefined ? undefined : failure !== undefined && failure.userMessage !== "" ? failure.userMessage : failedAttempt.status === "failed"
          ? t("chat.status.failed")
          : t("chat.status.interrupted");
    const body =
      overlay !== undefined ? (
        <AssistantMessage
          text={overlay.answer}
          status={overlay.status}
          revisionId={overlay.cited.values().next().value?.transcriptRevisionId ?? page.primaryRevisionId}
          ungrounded={overlay.ungrounded}
          citations={[...overlay.cited].map(([segmentId, cited]) => ({ segmentId, transcriptRevisionId: cited.transcriptRevisionId }))}
          knownTimes={overlay.cited}
          webSources={overlay.sources}
          search={overlay.search}
          suggestions={overlay.status === "complete" ? overlay.suggestions : undefined}
          error={overlay.error}
          onSuggestion={onSuggestion}
        />
      ) : answer === undefined ? null : (
        <AssistantMessage
          text={answer.text}
          status={answer.status}
          revisionId={answer.contextTranscriptRevisionId}
          ungrounded={answer.contextTranscriptRevisionId === undefined}
          citations={answer.citations}
          webSources={answer.webSearch?.sources ?? []}
          search={storedSearchView(answer.webSearch)}
          suggestions={last && live === undefined && answer.status === "complete" ? answer.suggestions : undefined}
          error={answer.status === "failed" ? failureOf(answer) : undefined}
          failedAttempt={
            failedAttempt === undefined || failedReason === undefined
              ? undefined
              : { reason: failedReason, time: formatBeijingDateTime(failedAttempt.finishedAt ?? failedAttempt.createdAt) }
          }
          footer={
            answer.status === "streaming"
              ? undefined
              : {
                  answer,
                  askedAt: turn.user?.createdAt,
                  onRetry: last && !selecting ? () => void retry(answer.id) : undefined,
                  onDelete: () => setConfirmTurns([turn.key]),
                  busy: threadBusy || busy,
                }
          }
          onSuggestion={onSuggestion}
        />
      );
    return (
      <div key={turn.key} className="flex gap-2" data-testid="chat-turn" data-turn={turn.key}>
        {selecting ? (
          <TurnCheckbox
            checked={selected.has(turn.key)}
            disabled={threadBusy}
            onChange={(checked) =>
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(turn.key);
                else next.delete(turn.key);
                return next;
              })
            }
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {turn.user === undefined ? null : <UserMessage text={turn.user.text} quote={turn.user.quote} />}
          {body}
        </div>
      </div>
    );
  };

  const refusal = state.error === undefined || contextUnknown ? undefined : state.error;

  // One box like a chat app's: the quote above the text; the model, web search, the context
  // mode and send along its bottom edge.
  const composerRow = (
    <div className="flex items-end gap-2">
      {collapsed ? <MessageSquare size={14} className="mb-2.5 shrink-0 text-muted" aria-hidden="true" /> : null}
      <div
        className={`flex min-w-0 flex-1 flex-col rounded-lg border border-line bg-surface focus-within:border-accent ${blocked ? "opacity-60" : ""}`}
        data-testid="chat-box"
      >
        {collapsed ? null : <ChatInputResizer target={inputRef} />}
        {composed.quote === undefined ? null : (
          <div className="mx-2 mt-2 flex items-start gap-2 rounded-md bg-sunken px-2 py-1 text-xs" data-testid="chat-quote">
            <Quote size={12} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <span className="line-clamp-2 flex-1">{composed.quote.text}</span>
            <button type="button" aria-label={t("chat.quote.remove")} className="text-muted hover:text-ink" onClick={() => composer.clearQuote()}>
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={collapsed ? 1 : 2}
            value={input}
            disabled={blocked}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            data-testid="chat-input"
            className={`flex-1 bg-transparent px-3 py-2 text-sm outline-none disabled:cursor-not-allowed ${inputSize}`}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {collapsed ? <div className="p-1">{sendOrStop}</div> : null}
        </div>
        {collapsed ? null : (
          <div className="flex flex-wrap items-center gap-2 px-2 pb-2 text-xs text-muted">
            {options.length === 0 ? null : (
              <select
                aria-label={t("chat.model")}
                title={t("chat.model")}
                data-testid="chat-model"
                className="h-7 max-w-64 min-w-0 truncate rounded-md border border-line bg-surface px-1.5 text-xs text-ink hover:border-accent"
                value={modelRef === undefined ? "" : modelKey(modelRef)}
                onChange={(event) => {
                  patch(key, (current) => ({ ...current, error: undefined }));
                  setPicked(options.find((option) => modelKey(option.modelRef) === event.target.value)?.modelRef);
                }}
              >
                {options.map((option) => (
                  <option key={modelKey(option.modelRef)} value={modelKey(option.modelRef)}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            {webSearchProfile.isPending ? null : <WebSearchToggle mode={searchAvailable ? webMode : "off"} available={searchAvailable} onChange={changeWebMode} />}
            {context !== undefined && context.mode !== "unavailable" && !contextUnknown ? (
              <span
                className="rounded bg-sunken px-1.5 py-0.5"
                data-testid="chat-mode"
                data-mode={context.mode}
                title={context.estimatedTokens === undefined ? undefined : t("chat.mode.estimate", { tokens: context.estimatedTokens.toLocaleString() })}
              >
                {t(`chat.mode.${context.mode}`)}
              </span>
            ) : null}
            <div className="ml-auto">{sendOrStop}</div>
          </div>
        )}
      </div>
      {collapsed ? (
        <Button size="sm" variant="ghost" aria-label={t("chat.expand")} title={t("chat.expand")} onClick={() => setSize("normal")} data-testid="chat-expand">
          <ChevronUp size={14} />
        </Button>
      ) : null}
    </div>
  );

  const showPendingSend = live?.kind === "send";
  const empty = turns.length === 0 && !showPendingSend;

  const threadMenu = (
    <ChatThreadMenu
      threads={threadList ?? []}
      current={thread}
      running={runningThreads}
      onSelect={selectThread}
      onRename={setRenaming}
      onPin={pinThread}
      onDelete={setConfirmThread}
    />
  );
  const selectDisabled = turns.length === 0 || selecting;
  const clearDisabled = (threadList ?? []).length === 0 || anyRunning || busy;

  const dockedHeader = (
    <header className="flex items-center gap-1">
      <MessageSquare size={14} className="shrink-0 text-muted" aria-hidden="true" />
      {threadMenu}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void newThread()} data-testid="chat-new-thread">
        <Plus size={14} aria-hidden="true" />
        {t("chat.threads.newThread")}
      </Button>
      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={selectDisabled} onClick={() => setSelecting(true)} data-testid="chat-select">
          {t("chat.select.start")}
        </Button>
        <Button size="sm" variant="ghost" disabled={clearDisabled} onClick={() => setConfirmClear(true)} data-testid="chat-clear">
          {t("chat.clear")}
        </Button>
        {props.fill ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSize(size === "full" ? "normal" : "full")}
            title={size === "full" ? t("chat.restore") : t("chat.full")}
            aria-label={size === "full" ? t("chat.restore") : t("chat.full")}
            data-testid="chat-full"
          >
            {size === "full" ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
        )}
        {placement?.canFloat === true ? (
          <Button size="sm" variant="ghost" onClick={() => placement.onFloatingChange(true)} title={t("chat.float")} aria-label={t("chat.float")} data-testid="chat-float">
            <PictureInPicture2 size={14} />
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setSize("collapsed")} title={t("chat.collapse")} aria-label={t("chat.collapse")} data-testid="chat-collapse">
          <ChevronDown size={14} />
        </Button>
      </div>
    </header>
  );

  // A narrow window has room for icons only; the whole row, controls aside, moves the window.
  const floatingHeader = (
    <header className="flex cursor-move touch-none select-none items-center gap-1" {...floatBox.moveHandle}>
      <span
        role="button"
        tabIndex={0}
        aria-label={t("chat.move")}
        title={t("chat.move")}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-sunken hover:text-ink focus-visible:bg-sunken focus-visible:ring-2 focus-visible:ring-accent"
        onKeyDown={floatBox.onKeyDown}
        data-testid="chat-drag-handle"
      >
        <GripHorizontal size={14} aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1">{threadMenu}</div>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => void newThread()}
        title={t("chat.threads.newThread")}
        aria-label={t("chat.threads.newThread")}
        data-testid="chat-new-thread"
      >
        <Plus size={14} aria-hidden="true" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={selectDisabled}
        onClick={() => setSelecting(true)}
        title={t("chat.select.start")}
        aria-label={t("chat.select.start")}
        data-testid="chat-select"
      >
        <ListChecks size={14} aria-hidden="true" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={clearDisabled}
        onClick={() => setConfirmClear(true)}
        title={t("chat.clearAll")}
        aria-label={t("chat.clearAll")}
        data-testid="chat-clear"
      >
        {/* A broom, not a bin: this clears every thread, unlike a thread's own delete. */}
        <BrushCleaning size={14} aria-hidden="true" />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => placement?.onFloatingChange(false)} title={t("chat.dock")} aria-label={t("chat.dock")} data-testid="chat-dock">
        <Dock size={14} aria-hidden="true" />
      </Button>
    </header>
  );

  const sectionClass = floating
    ? "fixed z-[25] flex flex-col gap-2 rounded-md border border-line bg-surface p-3 shadow-xl [container-type:size]"
    : `flex flex-col gap-2 rounded-md border border-line p-3 ${frame}`;
  const section = (
    <section
      className={sectionClass}
      style={floating ? floatBox.box : undefined}
      aria-label={t("chat.title")}
      data-testid="chat-panel"
      data-size={shownSize}
      data-floating={floating ? "true" : undefined}
    >
      {collapsed ? null : floating ? floatingHeader : dockedHeader}
      {collapsed ? null : (
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto" onScroll={onListScroll} data-testid="chat-messages" data-thread={threadId ?? ""}>
          {empty ? <p className="py-6 text-center text-xs text-muted">{t("chat.empty")}</p> : null}
          {turns.map(renderTurn)}
          {live === undefined || !showPendingSend ? null : (
            <div data-testid="chat-turn" data-turn="pending">
              <UserMessage text={live.question} quote={live.quote} quoteText={live.quote?.text} />
              <AssistantMessage
                text={live.answer}
                status={live.status}
                revisionId={live.cited.values().next().value?.transcriptRevisionId ?? page.primaryRevisionId}
                ungrounded={live.ungrounded}
                citations={[...live.cited].map(([segmentId, cited]) => ({ segmentId, transcriptRevisionId: cited.transcriptRevisionId }))}
                knownTimes={live.cited}
                webSources={live.sources}
                search={live.search}
                suggestions={live.status === "complete" ? live.suggestions : undefined}
                error={live.error}
                onSuggestion={onSuggestion}
              />
            </div>
          )}
        </div>
      )}
      {selecting && !collapsed ? (
        <TurnSelectBar
          count={selected.size}
          busy={busy || threadBusy}
          onDelete={() => setConfirmTurns([...selected])}
          onCancel={() => {
            setSelecting(false);
            setSelected(new Set());
          }}
        />
      ) : null}
      {unavailableReason === undefined ? null : <Unavailable reason={unavailableReason} />}
      {unavailableReason === undefined && context?.mode === "metadata" ? (
        <p className="rounded-md bg-sunken px-2 py-1.5 text-xs text-muted" data-testid="chat-metadata-hint">
          {t("chat.metadataHint")}
        </p>
      ) : null}
      {refusal === undefined ? null : (
        <ErrorView error={refusal}>
          {refusal.action === "configure_web_search" ? (
            <Link to="/settings/web-search" className="text-xs text-accent hover:underline" data-testid="chat-web-search-configure">
              {t("chat.webSearch.configure")}
            </Link>
          ) : undefined}
        </ErrorView>
      )}
      {actionError === undefined ? null : <ErrorView error={actionError} />}
      {composerRow}
      {floating
        ? RESIZE_EDGES.map((edge) => (
            <div
              key={edge}
              aria-label={t("chat.resize", { edge: t(`chat.edges.${edge}`) })}
              title={t("chat.resize", { edge: t(`chat.edges.${edge}`) })}
              className={`absolute z-10 touch-none ${EDGE_CLASS[edge]}`}
              data-testid={`chat-resize-${edge}`}
              {...floatBox.resizeHandle(edge)}
            />
          ))
        : null}
    </section>
  );

  // The dialogs are outside the moving section, so one that is open stays open as it is,
  // typed text included, when the panel docks or floats.
  return (
    <>
      {target === undefined ? section : target === null ? null : createPortal(section, target)}
      {floating && floatBox.active !== undefined
        ? createPortal(<div className="fixed inset-0 z-[24]" style={{ cursor: GESTURE_CURSOR[floatBox.active] }} data-testid="chat-drag-overlay" />, document.body)
        : null}
      <ConfirmDialog
        open={confirmClear}
        title={t("chat.clearTitle")}
        message={t("chat.clearConfirm")}
        confirmLabel={t("chat.clear")}
        busy={busy}
        onConfirm={() => void clear()}
        onCancel={() => setConfirmClear(false)}
      />
      <ConfirmDialog
        open={confirmTurns !== undefined}
        title={confirmTurns !== undefined && confirmTurns.length > 1 ? t("chat.select.confirmTitle") : t("chat.turn.delete")}
        message={confirmTurns !== undefined && confirmTurns.length > 1 ? t("chat.select.confirm", { count: confirmTurns.length }) : t("chat.turn.deleteConfirm")}
        confirmLabel={t("common.action.delete")}
        busy={busy}
        onConfirm={() => void (confirmTurns === undefined ? undefined : deleteTurns(confirmTurns))}
        onCancel={() => setConfirmTurns(undefined)}
      />
      <ConfirmDialog
        open={confirmThread !== undefined}
        title={t("chat.threads.delete")}
        message={t("chat.threads.deleteConfirm", { title: titleOf(confirmThread) })}
        confirmLabel={t("common.action.delete")}
        busy={busy}
        onConfirm={() => void (confirmThread === undefined ? undefined : deleteThread(confirmThread))}
        onCancel={() => setConfirmThread(undefined)}
      />
      <ChatThreadRenameDialog contentId={contentId} thread={renaming} onOpenChange={(open) => (open ? undefined : setRenaming(undefined))} />
      <ConfirmDialog
        open={modelMissing !== undefined}
        title={t("chat.modelMissing.title")}
        message={t("chat.modelMissing.message")}
        confirmLabel={t("chat.modelMissing.confirm")}
        busy={modelRef === undefined}
        onConfirm={() => {
          const answerId = modelMissing;
          setModelMissing(undefined);
          if (answerId !== undefined && modelRef !== undefined) void retry(answerId, modelRef);
        }}
        onCancel={() => setModelMissing(undefined)}
      />
    </>
  );
}

function Unavailable(props: { reason: "no_model" | "context_window_unknown" }) {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap items-center gap-2 rounded-md bg-sunken px-2 py-1.5 text-xs text-muted" data-testid="chat-unavailable" data-reason={props.reason}>
      {t(`chat.unavailable.${props.reason}`)}
      <Link to="/settings/models" className="text-accent hover:underline" data-testid="chat-configure">
        {t("chat.configure")}
      </Link>
    </p>
  );
}
