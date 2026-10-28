import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatDto, ChatMessageDto, ChatThreadDto } from "../../../src/shared/dto/chat.ts";
import { ChatComposer, ChatComposerProvider } from "../../../src/web/chat/chat-composer.tsx";
import { ChatPanel } from "../../../src/web/chat/chat-panel.tsx";
import { SelectionToolbar } from "../../../src/web/chat/selection-toolbar.tsx";
import { ContentPageProvider, type ContentPageState } from "../../../src/web/pages/content/content-context.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { CITED_SEGMENT_ID, contentDetail, revision, SEGMENTS } from "../../fixtures/web/content-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";
import { provider } from "../../fixtures/web/shell-data.ts";

const MODEL = { providerProfileId: "p1", modelId: "m-chat" };
const PROVIDERS = { items: [provider("p1", "Relay", ["m-default", "m-chat"])] };
const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, chatModelRef: MODEL, defaultModelRef: { providerProfileId: "p1", modelId: "m-default" }, updatedAt: 1 };

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function stream(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Messages are written loosely; segment ids in fixtures are plain strings. */
function chatOf(messages: Array<Record<string, unknown>> = [], context: ChatDto["context"] = { mode: "full", estimatedTokens: 12_345 }): ChatDto {
  return { thread: messages.length === 0 ? null : { id: "th1", createdAt: 0 }, messages: messages as unknown as ChatMessageDto[], context };
}

/** Routes for the panel plus a POST handler (questions and retries); returns every call, the POST included. */
function api(
  options: {
    chat?: (call: RecordedCall) => ChatDto;
    post?: (call: RecordedCall) => Response;
    providers?: unknown;
    threads?: (call: RecordedCall) => { threads: ChatThreadDto[] };
    settings?: Record<string, unknown>;
    webSearch?: { credentialStatus: "missing" | "configured" | "unavailable"; service?: "tavily" };
    routes?: Parameters<typeof mockApi>[0];
  } = {},
) {
  const { calls } = mockApi({
    "GET /api/providers": { body: options.providers ?? PROVIDERS },
    "GET /api/settings": { body: { ...SETTINGS, ...options.settings } },
    "PATCH /api/settings": (call) => ({ body: { ...SETTINGS, ...options.settings, ...(call.body as object) } }),
    "GET /api/web-search": { body: options.webSearch ?? { credentialStatus: "missing" } },
    "GET /api/contents/c1/chat/threads": (call) => ({ body: (options.threads ?? (() => ({ threads: [] })))(call) }),
    "GET /api/contents/c1/chat": (call) => ({ body: (options.chat ?? (() => chatOf()))(call) }),
    "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
    ...options.routes,
  });
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if ((init.method ?? "GET") === "POST" && (url.endsWith("/chat/messages") || url.endsWith("/retry"))) {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const call: RecordedCall & { signal?: AbortSignal } = { method: "POST", path: url, headers, body: JSON.parse(String(init.body)), ...(init.signal == null ? {} : { signal: init.signal }) };
      calls.push(call);
      return options.post === undefined ? stream([]) : options.post(call);
    }
    return base(input, init);
  });
  return calls;
}

function Page(props: { children: ReactNode; select?: ContentPageState["select"]; openTab?: ContentPageState["openTab"] }) {
  const [controller] = useState(() => new PlayerController());
  const [composer] = useState(() => new ChatComposer());
  const state: ContentPageState = {
    content: contentDetail(),
    primaryRevisionId: "r1",
    selection: undefined,
    select: props.select ?? (() => undefined),
    openTab: props.openTab ?? (() => undefined),
    highlightThreshold: 80,
    setHighlightThreshold: () => undefined,
    openSubtitleEditor: () => undefined,
  };
  return (
    <PlayerControllerProvider controller={controller}>
      <ContentPageProvider value={state}>
        <ChatComposerProvider composer={composer}>{props.children}</ChatComposerProvider>
      </ContentPageProvider>
    </PlayerControllerProvider>
  );
}

const input = () => screen.getByTestId("chat-input") as HTMLTextAreaElement;

describe("ChatPanel", () => {
  it("streams an answer with a clickable citation and suggestions, then reads the stored thread", async () => {
    let stored = false;
    const answer = `先看重排序 [[seg:${CITED_SEGMENT_ID}]]。`;
    const calls = api({
      chat: () =>
        stored
          ? chatOf([
              { id: "m1", role: "user", text: "讲了什么？", status: "complete", citations: [], createdAt: 1 },
              {
                id: "m2",
                role: "assistant",
                text: answer,
                status: "complete",
                contextTranscriptRevisionId: "r1",
                citations: [{ transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID }],
                suggestions: ["为什么要重排序？"],
                createdAt: 2,
              },
            ])
          : chatOf(),
      post: () => {
        stored = true;
        return stream([
          frame("answer.delta", { delta: "先看重排序 " }),
          frame("citation", { transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID, startMs: 75_000 }),
          frame("answer.delta", { delta: `[[seg:${CITED_SEGMENT_ID}]]。` }),
          frame("suggestions", { items: ["为什么要重排序？"] }),
          frame("done", { threadId: "th1", userMessageId: "m1", messageId: "m2", status: "complete" }),
        ]);
      },
    });
    const select = vi.fn();
    const openTab = vi.fn();
    renderApp(
      <Page select={select} openTab={openTab}>
        <ChatPanel fill={false} />
      </Page>,
    );
    const mode = await screen.findByTestId("chat-mode");
    expect(mode.getAttribute("data-mode")).toBe("full");
    expect(mode.getAttribute("title")).toContain("12,345");
    expect((screen.getByTestId("chat-model") as HTMLSelectElement).value).toBe("p1\u0000m-chat");
    expect(calls.some((call) => call.path === "/api/contents/c1/chat?providerProfileId=p1&modelId=m-chat")).toBe(true);

    fireEvent.change(input(), { target: { value: "讲了什么？" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    const citation = await waitFor(() => {
      const button = screen.getByTestId("chat-messages").querySelector(`[data-citation='${CITED_SEGMENT_ID}']`);
      expect(button?.textContent).toBe("1:15");
      return button as HTMLElement;
    });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({ text: "讲了什么？", modelRef: MODEL });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
    expect(post?.headers["accept"]).toBe("text/event-stream");
    expect(await screen.findByTestId("chat-suggestion")).toBeTruthy();

    fireEvent.click(citation);
    expect(select).toHaveBeenCalledWith({ revisionId: "r1", segmentId: CITED_SEGMENT_ID }, 75_000);
    expect(openTab).toHaveBeenCalledWith("transcript");

    // A suggestion only fills the input.
    const posts = calls.filter((call) => call.method === "POST").length;
    fireEvent.click(screen.getByTestId("chat-suggestion"));
    expect(input().value).toBe("为什么要重排序？");
    expect(calls.filter((call) => call.method === "POST").length).toBe(posts);
  });

  it("marks an answer whose stream broke before done as interrupted, never as complete", async () => {
    let stored = false;
    api({
      // The server stores what was streamed as `interrupted` when the stream breaks.
      chat: () =>
        stored
          ? chatOf([
              { id: "m1", role: "user", text: "继续", status: "complete", citations: [], createdAt: 1 },
              { id: "m2", role: "assistant", text: "说到一半", status: "interrupted", citations: [], createdAt: 2 },
            ])
          : chatOf(),
      post: () => {
        stored = true;
        return stream([frame("answer.delta", { delta: "说到一半" })]);
      },
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "继续" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      const answer = screen.getAllByTestId("chat-message").find((element) => element.getAttribute("data-role") === "assistant");
      expect(answer?.getAttribute("data-status")).toBe("interrupted");
      expect(answer?.textContent).toContain("说到一半");
    });
    expect(screen.getByTestId("chat-message-status")).toBeTruthy();
  });

  it("keeps reading the history after a stop until the server has stored the answer as interrupted", async () => {
    // The first read after the stop still finds the answer streaming: the server has not
    // seen the disconnect yet. The panel must not stay on that state.
    let reads = 0;
    const question = { id: "m1", role: "user", text: "停一下", status: "complete", citations: [], createdAt: 1 };
    api({
      chat: () => {
        reads += 1;
        if (reads === 1) return chatOf();
        return chatOf([question, { id: "m2", role: "assistant", text: "", status: reads === 2 ? "streaming" : "interrupted", citations: [], createdAt: 2 }]);
      },
      post: (call) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const signal = (call as { signal?: AbortSignal }).signal;
              signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "停一下" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    fireEvent.click(await screen.findByTestId("chat-stop"));
    await waitFor(
      () => {
        const answer = screen.getAllByTestId("chat-message").find((element) => element.getAttribute("data-role") === "assistant");
        expect(answer?.getAttribute("data-status")).toBe("interrupted");
      },
      { timeout: 3000 },
    );
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("lets the user ask before there is a transcript, labelling such answers as not grounded in the video", async () => {
    let stored = false;
    api({
      chat: () =>
        stored
          ? chatOf(
              [
                { id: "m1", role: "user", text: "讲什么？", status: "complete", citations: [], createdAt: 1 },
                // No contextTranscriptRevisionId: answered in the metadata mode.
                { id: "m2", role: "assistant", text: "字幕尚未就绪，以下回答未依据视频原文。", status: "complete", citations: [], createdAt: 2 },
              ],
              { mode: "metadata", estimatedTokens: 300 },
            )
          : chatOf([], { mode: "metadata", estimatedTokens: 300 }),
      post: () => {
        stored = true;
        return stream([frame("answer.delta", { delta: "字幕尚未就绪，以下回答未依据视频原文。" }), frame("done", { threadId: "th1", userMessageId: "m1", messageId: "m2", status: "complete" })]);
      },
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    expect((await screen.findByTestId("chat-mode")).getAttribute("data-mode")).toBe("metadata");
    expect(screen.getByTestId("chat-mode").textContent).toBe("基本信息");
    expect(screen.getByTestId("chat-metadata-hint")).toBeTruthy();
    expect(screen.queryByTestId("chat-unavailable")).toBeNull();
    expect(input().disabled).toBe(false);
    fireEvent.change(input(), { target: { value: "讲什么？" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      const answer = screen.getAllByTestId("chat-message").find((element) => element.getAttribute("data-role") === "assistant");
      expect(answer?.getAttribute("data-status")).toBe("complete");
      expect(answer?.querySelector('[data-testid="chat-ungrounded"]')?.textContent).toBe("未依据视频原文");
    });
  });

  it("greys the input out with a way to configure when the model's context window is unknown", async () => {
    const calls = api({ chat: () => chatOf([], { mode: "unavailable", reason: "context_window_unknown" }) });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    const notice = await screen.findByTestId("chat-unavailable");
    expect(notice.getAttribute("data-reason")).toBe("context_window_unknown");
    expect(screen.getByTestId("chat-configure").getAttribute("href")).toBe("/settings/models");
    expect(input().disabled).toBe(true);
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("shows the same hint and gives the question back when the POST is refused with 422", async () => {
    api({
      post: () =>
        new Response(
          JSON.stringify({ error: { class: "llm_capability", code: "llm_capability.context_window_unknown", retryDisposition: "never", userMessage: "" } }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "能讲讲吗" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    expect((await screen.findByTestId("chat-unavailable")).getAttribute("data-reason")).toBe("context_window_unknown");
    expect(input().value).toBe("能讲讲吗");
    expect(screen.queryAllByTestId("chat-message")).toEqual([]);
  });

  it("asks to configure a model when none is usable", async () => {
    api({ providers: { items: [] }, chat: () => chatOf([], { mode: "unavailable", reason: "no_model" }) });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    expect((await screen.findByTestId("chat-unavailable")).getAttribute("data-reason")).toBe("no_model");
    expect(input().disabled).toBe(true);
  });

  it("folds to one input line and back", async () => {
    api();
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.click(screen.getByTestId("chat-collapse"));
    expect(screen.getByTestId("chat-panel").getAttribute("data-size")).toBe("collapsed");
    expect(screen.queryByTestId("chat-messages")).toBeNull();
    expect(screen.getByTestId("chat-input")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-expand"));
    expect(screen.getByTestId("chat-messages")).toBeTruthy();
  });

  it("explains a selected sentence by pre-filling the input with a quote, without sending", async () => {
    const calls = api();
    renderApp(
      <Page>
        <div data-revision-id="r1" data-explainable>
          <span data-segment-id={CITED_SEGMENT_ID}>再看重排序。</span>
        </div>
        <ChatPanel fill={false} />
        <SelectionToolbar />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    const sentence = document.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)?.firstChild as Text;
    const range = document.createRange();
    range.setStart(sentence, 2);
    range.setEnd(sentence, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(document);
    fireEvent.click(await screen.findByTestId("selection-explain"));

    await waitFor(() => expect(input().value).toBe("解释一下「重排序」"));
    expect(screen.getByTestId("chat-quote").textContent).toContain("再看重排序。");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);

    const posted = calls.length;
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(calls.length).toBeGreaterThan(posted));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      text: "解释一下「重排序」",
      modelRef: MODEL,
      quote: { transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID },
    });
  });

  it("drops an earlier quote when a summary selection is explained, so it is not sent along", async () => {
    const calls = api();
    renderApp(
      <Page>
        <div data-revision-id="r1" data-explainable>
          <span data-segment-id={CITED_SEGMENT_ID}>再看重排序。</span>
        </div>
        <div data-testid="summary-body" data-explainable>
          <p>先召回后重排序。</p>
        </div>
        <ChatPanel fill={false} />
        <SelectionToolbar />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    const select = (node: Text, start: number, end: number): void => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent.mouseUp(document);
    };
    select(document.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)?.firstChild as Text, 2, 5);
    fireEvent.click(await screen.findByTestId("selection-explain"));
    await waitFor(() => expect(screen.getByTestId("chat-quote")).toBeTruthy());

    select(screen.getByTestId("summary-body").querySelector("p")?.firstChild as Text, 0, 4);
    fireEvent.click(await screen.findByTestId("selection-explain"));
    await waitFor(() => expect(input().value).toBe("解释一下「先召回后」"));
    expect(screen.queryByTestId("chat-quote")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ text: "解释一下「先召回后」", modelRef: MODEL });
  });
});

/** Fires a right click and reports whether the browser menu was prevented. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const menuLabels = (): Array<string | null> => screen.getAllByRole("menuitem").map((item) => item.textContent);

describe("chat message context menus", () => {
  function stubClipboard() {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    return writeText;
  }

  const stored = () =>
    chatOf([
      { id: "m1", role: "user", text: "讲了什么？", status: "complete", citations: [], createdAt: 1 },
      {
        id: "m2",
        role: "assistant",
        text: `先看重排序 [[seg:${CITED_SEGMENT_ID}]]，另见 [[unresolved:s9]]。`,
        status: "complete",
        contextTranscriptRevisionId: "r1",
        citations: [{ transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID }],
        createdAt: 2,
      },
    ]);

  it("copies an answer with citations turned into timestamps, and jumps only from a resolved citation", async () => {
    const writeText = stubClipboard();
    api({ chat: stored });
    const select = vi.fn();
    const openTab = vi.fn();
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Page select={select} openTab={openTab}>
          <ChatPanel fill={false} />
        </Page>
      </ContextMenuHost>,
    );
    const badge = await screen.findByRole("button", { name: "1:15" }, { timeout: 5000 });
    const answer = badge.closest("[data-role='assistant']") as HTMLElement;
    expect(rightClick(within(answer).getByText(/先看重排序/))).toBe(true);
    expect(menuLabels()).toEqual(["复制回答"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-answer"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("先看重排序 [1:15]，另见 。"));

    rightClick(answer.querySelector("[data-citation='unresolved']") as HTMLElement);
    expect(menuLabels()).toEqual(["复制回答"]);
    fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });

    rightClick(badge);
    expect(menuLabels()).toEqual(["复制回答", "跳转到原文"]);
    fireEvent.click(screen.getByTestId("context-menu-item-jump-to-source"));
    expect(select).toHaveBeenCalledWith({ revisionId: "r1", segmentId: CITED_SEGMENT_ID }, 75_000);
    expect(openTab).toHaveBeenCalledWith("transcript");
  });

  it("copies the user's own question", async () => {
    const writeText = stubClipboard();
    api({ chat: stored });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Page>
          <ChatPanel fill={false} />
        </Page>
      </ContextMenuHost>,
    );
    const question = await screen.findByText("讲了什么？");
    expect(rightClick(question)).toBe(true);
    expect(menuLabels()).toEqual(["复制"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("讲了什么？"));
  });

  it("greys out copying an answer while it streams", async () => {
    const encoder = new TextEncoder();
    api({
      post: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(frame("answer.delta", { delta: "先看重排序" })));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Page>
          <ChatPanel fill={false} />
        </Page>
      </ContextMenuHost>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "讲了什么？" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    const partial = await screen.findByText("先看重排序");
    expect(partial.closest("[data-role='assistant']")?.getAttribute("data-status")).toBe("streaming");
    rightClick(partial);
    expect(screen.getByTestId("context-menu-item-copy-answer").getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(screen.getByTestId("chat-stop"));
  });
});

/** An SSE answer the test feeds frame by frame; closing it ends the stream. */
function controlledStream(call: RecordedCall & { signal?: AbortSignal }) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        call.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  return {
    response,
    push: (event: string, data: unknown) => act(() => controller.enqueue(encoder.encode(frame(event, data)))),
    close: () => act(() => controller.close()),
  };
}

const user = (id: string, text: string, createdAt = Date.UTC(2026, 9, 26, 2, 0)) => ({ id, role: "user", text, status: "complete", citations: [], createdAt });
const answer = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  role: "assistant",
  text,
  status: "complete",
  citations: [],
  contextTranscriptRevisionId: "r1",
  createdAt: Date.UTC(2026, 9, 26, 2, 0),
  finishedAt: Date.UTC(2026, 9, 26, 2, 1),
  modelRef: { providerProfileId: "p1", modelId: "m-chat", providerNameSnapshot: "Relay", modelDisplaySnapshot: "m-chat", protocolSnapshot: "openai_compatible" },
  ...extra,
});
const threadOf = (id: string, title?: string, lastMessageAt?: number): ChatThreadDto => ({
  id,
  createdAt: Date.UTC(2026, 9, 25, 0, 0),
  ...(title === undefined ? {} : { title }),
  ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
});
const threadIdOf = (call: RecordedCall): string | undefined => new URL(call.path, "http://x").searchParams.get("threadId") ?? undefined;
const turnsShown = () => screen.getAllByTestId("chat-turn");
const renderPanel = () =>
  renderApp(
    <Page>
      <ChatPanel fill={false} />
    </Page>,
  );

describe("chat threads", () => {
  afterEach(() => sessionStorage.clear());

  const THREADS = [threadOf("th2", "第二个会话", Date.UTC(2026, 9, 26, 15, 30)), threadOf("th1", "第一个会话", Date.UTC(2026, 9, 25, 1, 0))];
  const HISTORY: Record<string, ChatDto> = {
    th1: chatOf([user("u1", "第一问"), answer("a1", "第一个回答")]),
    th2: { ...chatOf([user("u2", "第二问"), answer("a2", "第二个回答")]), thread: THREADS[0]! },
  };

  it("opens the latest thread, lists every thread with its last message time, and switches on request", async () => {
    const calls = api({ threads: () => ({ threads: THREADS }), chat: (call) => HISTORY[threadIdOf(call) ?? "th2"]! });
    renderPanel();
    expect(await screen.findByText("第二个回答")).toBeTruthy();
    expect(screen.getByTestId("chat-thread-title").textContent).toBe("第二个会话");
    expect(sessionStorage.getItem("amber.chat.thread:c1")).toBe("th2");

    fireEvent.click(screen.getByTestId("chat-thread-menu"));
    const items = await screen.findAllByTestId("chat-thread-item");
    // Beijing time: 15:30 UTC is 23:30 in Beijing.
    expect(items.map((item) => item.textContent)).toEqual(["第二个会话2026-10-26 23:30", "第一个会话2026-10-25 09:00"]);
    fireEvent.click(within(items[1]!).getByText("第一个会话"));
    expect(await screen.findByText("第一个回答")).toBeTruthy();
    expect(screen.queryByText("第二个回答")).toBeNull();
    expect(calls.some((call) => call.path.startsWith("/api/contents/c1/chat?threadId=th1&"))).toBe(true);
    expect(sessionStorage.getItem("amber.chat.thread:c1")).toBe("th1");
  });

  it("restores the thread of this page session after a reload, or the latest when it is gone", async () => {
    sessionStorage.setItem("amber.chat.thread:c1", "th1");
    api({ threads: () => ({ threads: THREADS }), chat: (call) => HISTORY[threadIdOf(call) ?? "th2"]! });
    const first = renderPanel();
    expect(await screen.findByText("第一个回答")).toBeTruthy();
    first.unmount();

    sessionStorage.setItem("amber.chat.thread:c1", "gone");
    renderPanel();
    expect(await screen.findByText("第二个回答")).toBeTruthy();
    expect(sessionStorage.getItem("amber.chat.thread:c1")).toBe("th2");
  });

  it("names the menu 「历史对话」 while there is no thread yet", async () => {
    api();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("chat-thread-title").textContent).toBe("历史对话"));
    expect(screen.getByTestId("chat-thread-menu").getAttribute("title")).toBe("历史对话");
  });

  it("starts a new thread, names the menu 「历史对话」 while it has no title, lists it as 「新对话」 and asks before deleting one", async () => {
    let threads = THREADS;
    const fresh = threadOf("th3");
    const calls = api({
      threads: () => ({ threads }),
      chat: (call) => (threadIdOf(call) === "th3" ? { ...chatOf(), thread: fresh } : HISTORY[threadIdOf(call) ?? "th2"]!),
      routes: {
        "POST /api/contents/c1/chat/threads": () => {
          threads = [fresh, ...THREADS];
          return { status: 201, body: { thread: fresh } };
        },
        "DELETE /api/contents/c1/chat/threads/th3": () => {
          threads = THREADS;
          return { status: 204 };
        },
      },
    });
    renderPanel();
    await screen.findByText("第二个回答");
    fireEvent.click(screen.getByTestId("chat-new-thread"));
    await waitFor(() => expect(screen.getByTestId("chat-thread-title").textContent).toBe("历史对话"));
    expect(screen.getByTestId("chat-thread-menu").getAttribute("title")).toBe("历史对话");
    expect(screen.getByText("就视频内容提问，回答会附带可点的原文出处。")).toBeTruthy();

    fireEvent.click(screen.getByTestId("chat-thread-menu"));
    const items = await screen.findAllByTestId("chat-thread-item");
    expect(items[0]?.getAttribute("data-thread-id")).toBe("th3");
    expect(within(items[0]!).getByText("新对话")).toBeTruthy();
    fireEvent.click(within(items[0]!).getByTestId("chat-thread-delete"));
    expect(await screen.findByText("删除会话「新对话」？其中的全部对话将被删除，无法恢复。")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-dialog-ok"));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/contents/c1/chat/threads/th3")).toBe(true));
    // The deleted thread was open: the latest one opens instead.
    expect(await screen.findByText("第二个回答")).toBeTruthy();
  });

  it("keeps a thread's answer streaming while another thread is open, with each thread's own draft", async () => {
    const live: Array<ReturnType<typeof controlledStream>> = [];
    let th1Done = false;
    const calls = api({
      threads: () => ({ threads: THREADS }),
      chat: (call) => {
        if (threadIdOf(call) === "th1" && th1Done) return chatOf([user("u1", "第一问"), answer("a1", "第一个回答"), user("u3", "第三问"), answer("a3", "流完的回答")]);
        return HISTORY[threadIdOf(call) ?? "th2"]!;
      },
      post: (call) => {
        const next = controlledStream(call);
        live.push(next);
        return next.response;
      },
    });
    sessionStorage.setItem("amber.chat.thread:c1", "th1");
    renderPanel();
    await screen.findByText("第一个回答");
    fireEvent.change(input(), { target: { value: "第三问" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(live).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ text: "第三问", threadId: "th1" });
    await live[0]!.push("answer.delta", { delta: "流到一半" });
    expect(await screen.findByText("流到一半")).toBeTruthy();

    // Over to th2: th1's stream is not stopped, th2 can be asked at once and keeps its draft.
    fireEvent.click(screen.getByTestId("chat-thread-menu"));
    fireEvent.click(within((await screen.findAllByTestId("chat-thread-item"))[0]!).getByText("第二个会话"));
    expect(await screen.findByText("第二个回答")).toBeTruthy();
    expect(screen.queryByText("流到一半")).toBeNull();
    expect(screen.queryByTestId("chat-stop")).toBeNull();
    expect((calls.find((call) => call.method === "POST") as { signal?: AbortSignal }).signal?.aborted).toBe(false);
    fireEvent.change(input(), { target: { value: "第二个会话的草稿" } });
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(false);
    await live[0]!.push("answer.delta", { delta: "，继续" });

    // Back to th1: the progress made meanwhile is there, with the stop button.
    fireEvent.click(screen.getByTestId("chat-thread-menu"));
    const th1Item = (await screen.findAllByTestId("chat-thread-item"))[1]!;
    expect(th1Item.textContent).toContain("生成中");
    fireEvent.click(within(th1Item).getByText("第一个会话"));
    expect(await screen.findByText("流到一半，继续")).toBeTruthy();
    expect(screen.getByTestId("chat-stop")).toBeTruthy();
    expect(input().value).toBe("");

    th1Done = true;
    await live[0]!.push("done", { threadId: "th1", userMessageId: "u3", messageId: "a3", status: "complete" });
    await live[0]!.close();
    expect(await screen.findByText("流完的回答")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("chat-stop")).toBeNull());

    fireEvent.click(screen.getByTestId("chat-thread-menu"));
    fireEvent.click(within((await screen.findAllByTestId("chat-thread-item"))[0]!).getByText("第二个会话"));
    await screen.findByText("第二个回答");
    expect(input().value).toBe("第二个会话的草稿");
  });

  it("names a first thread from the answer's done event", async () => {
    let threads: ChatThreadDto[] = [];
    let stored = false;
    const calls = api({
      threads: () => ({ threads }),
      chat: () => (stored ? { ...chatOf([user("u1", "第一问"), answer("a1", "回答")]), thread: threadOf("th9") } : chatOf()),
      post: () => {
        stored = true;
        threads = [threadOf("th9", "第一问")];
        return stream([frame("answer.delta", { delta: "回答" }), frame("done", { threadId: "th9", userMessageId: "u1", messageId: "a1", status: "complete" })]);
      },
    });
    renderPanel();
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "第一问" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getByTestId("chat-thread-title").textContent).toBe("第一问"));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ text: "第一问", modelRef: MODEL });
    expect(sessionStorage.getItem("amber.chat.thread:c1")).toBe("th9");
    expect(screen.getAllByText("回答")).toHaveLength(1);
  });
});

describe("chat thread rename and pin", () => {
  afterEach(() => sessionStorage.clear());

  const TH2 = threadOf("th2", "第二个会话", Date.UTC(2026, 9, 26, 15, 30));
  const TH1 = threadOf("th1", "第一个会话", Date.UTC(2026, 9, 25, 1, 0));
  const HISTORY: Record<string, ChatDto> = {
    th1: chatOf([user("u1", "第一问"), answer("a1", "第一个回答")]),
    th2: { ...chatOf([user("u2", "第二问"), answer("a2", "第二个回答")]), thread: TH2 },
  };
  const historyOf = (call: RecordedCall): ChatDto => HISTORY[threadIdOf(call) ?? "th2"]!;
  const patches = (calls: RecordedCall[], threadId: string) =>
    calls.filter((call) => call.method === "PATCH" && call.path === `/api/contents/c1/chat/threads/${threadId}`).map((call) => call.body);
  const openMenu = async () => {
    fireEvent.click(screen.getByTestId("chat-thread-menu"));
    return screen.findAllByTestId("chat-thread-item");
  };
  const rowButtons = (item: HTMLElement) => [...item.querySelectorAll<HTMLButtonElement>("button[data-testid]")];

  it("offers rename, pin and delete on every row in that order, and pins / unpins in the server's order", async () => {
    let threads = [TH2, TH1];
    const calls = api({
      threads: () => ({ threads }),
      chat: historyOf,
      routes: {
        "PATCH /api/contents/c1/chat/threads/th1": (call) => {
          const pinned = (call.body as { pinned: boolean }).pinned;
          const th1 = pinned ? { ...TH1, pinnedAt: Date.UTC(2026, 9, 27) } : TH1;
          threads = pinned ? [th1, TH2] : [TH2, TH1];
          return { body: { thread: th1 } };
        },
      },
    });
    renderPanel();
    await screen.findByText("第二个回答");
    let items = await openMenu();
    for (const item of items) expect(rowButtons(item).map((button) => button.dataset.testid)).toEqual(["chat-thread-rename", "chat-thread-pin", "chat-thread-delete"]);
    expect(screen.queryByTestId("chat-thread-pinned")).toBeNull();
    expect(within(items[1]!).getByRole("button", { name: "重命名会话「第一个会话」" })).toBeTruthy();
    const pin = within(items[1]!).getByRole("button", { name: "置顶会话「第一个会话」" });
    expect(pin.getAttribute("title")).toBe("置顶");

    fireEvent.click(pin);
    await waitFor(() => expect(patches(calls, "th1")).toEqual([{ pinned: true }]));
    // The list is read back and shown in the server's order, the menu still open.
    await waitFor(async () => expect((await screen.findAllByTestId("chat-thread-item")).map((item) => item.getAttribute("data-thread-id"))).toEqual(["th1", "th2"]));
    items = screen.getAllByTestId("chat-thread-item");
    expect(within(items[0]!).getByTestId("chat-thread-pinned").getAttribute("aria-label")).toBe("已置顶");
    expect(within(items[1]!).queryByTestId("chat-thread-pinned")).toBeNull();
    const unpin = within(items[0]!).getByRole("button", { name: "取消置顶会话「第一个会话」" });
    expect(unpin.getAttribute("title")).toBe("取消置顶");
    // Pinning a thread does not open it: the latest created one stays open.
    expect(screen.getByTestId("chat-thread-title").textContent).toBe("第二个会话");
    expect(screen.getByText("第二个回答")).toBeTruthy();
    expect(screen.queryByTestId("chat-thread-title-pinned")).toBeNull();

    fireEvent.click(within(items[0]!).getByText("第一个会话"));
    expect(await screen.findByText("第一个回答")).toBeTruthy();
    expect(screen.getByTestId("chat-thread-title-pinned").getAttribute("aria-label")).toBe("已置顶");

    items = await openMenu();
    fireEvent.click(within(items[0]!).getByRole("button", { name: "取消置顶会话「第一个会话」" }));
    await waitFor(() => expect(patches(calls, "th1")).toEqual([{ pinned: true }, { pinned: false }]));
    await waitFor(() => expect(screen.queryByTestId("chat-thread-title-pinned")).toBeNull());
    expect(screen.getAllByTestId("chat-thread-item").map((item) => item.getAttribute("data-thread-id"))).toEqual(["th2", "th1"]);
  });

  it("renames a thread in a dialog, a blank name going back to the title from its first question", async () => {
    let th2 = TH2;
    const calls = api({
      threads: () => ({ threads: [th2, TH1] }),
      chat: historyOf,
      routes: {
        "PATCH /api/contents/c1/chat/threads/th2": (call) => {
          const title = (call.body as { title: string | null }).title;
          if (title === "坏名字") {
            return { status: 400, body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "名称不可用" } } };
          }
          th2 = title === null ? TH2 : { ...TH2, title, customTitle: title };
          return { body: { thread: th2 } };
        },
      },
    });
    renderPanel();
    await screen.findByText("第二个回答");
    let items = await openMenu();
    fireEvent.click(within(items[0]!).getByRole("button", { name: "重命名会话「第二个会话」" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("重命名会话")).toBeTruthy();
    expect(within(dialog).getByText("留空则恢复为首问标题。")).toBeTruthy();
    const field = within(dialog).getByTestId("chat-thread-rename-input") as HTMLInputElement;
    expect(field.value).toBe("第二个会话");
    expect(field.maxLength).toBeGreaterThan(0);

    // A refusal stays in the dialog with the name typed.
    fireEvent.change(field, { target: { value: "坏名字" } });
    fireEvent.click(within(dialog).getByTestId("chat-thread-rename-save"));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("名称不可用");
    expect(field.value).toBe("坏名字");

    fireEvent.change(field, { target: { value: "  新名字  " } });
    fireEvent.click(within(dialog).getByTestId("chat-thread-rename-save"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(patches(calls, "th2").at(-1)).toEqual({ title: "新名字" });
    await waitFor(() => expect(screen.getByTestId("chat-thread-title").textContent).toBe("新名字"));

    items = await openMenu();
    fireEvent.click(within(items[0]!).getByRole("button", { name: "重命名会话「新名字」" }));
    const again = within(await screen.findByRole("dialog")).getByTestId("chat-thread-rename-input") as HTMLInputElement;
    expect(again.value).toBe("新名字");
    fireEvent.change(again, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("chat-thread-rename-save"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(patches(calls, "th2").at(-1)).toEqual({ title: null });
    await waitFor(() => expect(screen.getByTestId("chat-thread-title").textContent).toBe("第二个会话"));

    // Unchanged: nothing is sent.
    items = await openMenu();
    fireEvent.click(within(items[0]!).getByTestId("chat-thread-rename"));
    fireEvent.click(await screen.findByTestId("chat-thread-rename-save"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(patches(calls, "th2")).toHaveLength(3);
  });

  it("can rename and pin a thread whose answer is streaming, but not delete it", async () => {
    const live: Array<ReturnType<typeof controlledStream>> = [];
    let th2 = TH2;
    const calls = api({
      threads: () => ({ threads: [th2, TH1] }),
      chat: historyOf,
      post: (call) => {
        const next = controlledStream(call);
        live.push(next);
        return next.response;
      },
      routes: {
        "PATCH /api/contents/c1/chat/threads/th2": () => {
          th2 = { ...TH2, pinnedAt: Date.UTC(2026, 9, 27) };
          return { body: { thread: th2 } };
        },
      },
    });
    renderPanel();
    await screen.findByText("第二个回答");
    fireEvent.change(input(), { target: { value: "第三问" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(live).toHaveLength(1));
    await live[0]!.push("answer.delta", { delta: "流到一半" });
    await screen.findByText("流到一半");

    const [item] = await openMenu();
    expect((within(item!).getByTestId("chat-thread-delete") as HTMLButtonElement).disabled).toBe(true);
    expect((within(item!).getByTestId("chat-thread-rename") as HTMLButtonElement).disabled).toBe(false);
    const pin = within(item!).getByTestId("chat-thread-pin") as HTMLButtonElement;
    expect(pin.disabled).toBe(false);
    fireEvent.click(pin);
    await waitFor(() => expect(patches(calls, "th2")).toEqual([{ pinned: true }]));
    await waitFor(() => expect(screen.getByTestId("chat-thread-title-pinned")).toBeTruthy());
    // The answer keeps streaming.
    expect((calls.find((call) => call.method === "POST") as { signal?: AbortSignal }).signal?.aborted).toBe(false);
    expect(screen.getByText("流到一半")).toBeTruthy();
    expect(screen.getByTestId("chat-stop")).toBeTruthy();

    fireEvent.click(within(screen.getAllByTestId("chat-thread-item")[0]!).getByTestId("chat-thread-rename"));
    expect(((await screen.findByTestId("chat-thread-rename-input")) as HTMLInputElement).value).toBe("第二个会话");
    fireEvent.click(screen.getByTestId("chat-stop"));
  });

  it("shows why a pin was refused", async () => {
    api({
      threads: () => ({ threads: [TH2, TH1] }),
      chat: historyOf,
      routes: {
        "PATCH /api/contents/c1/chat/threads/th1": {
          status: 404,
          body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "会话不存在" } },
        },
      },
    });
    renderPanel();
    await screen.findByText("第二个回答");
    const items = await openMenu();
    fireEvent.click(within(items[1]!).getByTestId("chat-thread-pin"));
    expect((await screen.findByRole("alert")).textContent).toContain("会话不存在");
  });
});

describe("chat turns", () => {
  const STORED = (extra: Array<Record<string, unknown>> = []) =>
    chatOf([
      user("u1", "第一问"),
      answer("a1", `第一个回答 [[seg:${CITED_SEGMENT_ID}]]`, { citations: [{ transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID }] }),
      user("u2", "第二问"),
      answer("a2", "第二个回答"),
      ...extra,
    ]);

  it("shows a footer on every answer, retry only on the last turn, and a failed retry beside the answer still in force", async () => {
    api({
      chat: () =>
        STORED([{ id: "a3", role: "assistant", text: "", status: "failed", citations: [], createdAt: Date.UTC(2026, 9, 26, 3, 0), finishedAt: Date.UTC(2026, 9, 26, 3, 2) }]),
    });
    renderPanel();
    expect(await screen.findByText("第二个回答")).toBeTruthy();
    expect(screen.getAllByTestId("chat-turn-footer")).toHaveLength(2);
    expect(screen.getAllByTestId("chat-turn-retry")).toHaveLength(1);
    const [first, second] = turnsShown();
    expect(within(first!).queryByTestId("chat-turn-retry")).toBeNull();
    expect(within(second!).getByTestId("chat-turn-retry")).toBeTruthy();
    expect(within(second!).getByTestId("chat-retry-failed").textContent).toBe("上次重试失败：回答失败 · 2026-10-26 11:02");
    expect(within(second!).getByTestId("chat-turn-time").textContent).toBe("2026-10-26 10:01");
    expect(within(second!).getByTestId("chat-turn-model").textContent).toBe("Relay · m-chat");
  });

  it("shows the stored reason of a failed retry after a reload", async () => {
    const quota = { class: "llm_failed", code: "llm_failed.quota", retryDisposition: "never", userMessage: "模型服务账户额度不足" };
    api({
      chat: () =>
        STORED([{ id: "a3", role: "assistant", text: "", status: "failed", error: quota, citations: [], createdAt: Date.UTC(2026, 9, 26, 3, 0), finishedAt: Date.UTC(2026, 9, 26, 3, 2) }]),
    });
    renderPanel();
    expect(await screen.findByText("第二个回答")).toBeTruthy();
    expect(screen.getByTestId("chat-retry-failed").textContent).toBe("上次重试失败：模型服务账户额度不足 · 2026-10-26 11:02");
  });

  it("retries the last answer with its own model, showing the new attempt over the old answer while it streams", async () => {
    let live!: ReturnType<typeof controlledStream>;
    let retried = false;
    const calls = api({
      chat: () => (retried ? chatOf([user("u1", "第一问"), answer("a1", "第一个回答"), user("u2", "第二问"), answer("a4", "新的回答")]) : STORED()),
      post: (call) => {
        live = controlledStream(call);
        return live.response;
      },
    });
    renderPanel();
    await screen.findByText("第二个回答");
    fireEvent.click(screen.getByTestId("chat-turn-retry"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const post = calls.find((call) => call.method === "POST");
    expect(post?.path).toBe("/api/contents/c1/chat/messages/a2/retry");
    expect(post?.body).toEqual({});
    expect(post?.headers["idempotency-key"]).toBeTruthy();
    await live.push("answer.delta", { delta: "重新生成中" });
    expect(await screen.findByText("重新生成中")).toBeTruthy();
    expect(screen.queryByText("第二个回答")).toBeNull();
    expect(turnsShown()).toHaveLength(2);
    // Nothing else may run in this thread meanwhile: no retry, deletes greyed out, stop instead of send.
    expect(screen.queryByTestId("chat-turn-retry")).toBeNull();
    expect((within(turnsShown()[0]!).getByTestId("chat-turn-delete") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("chat-stop")).toBeTruthy();
    retried = true;
    await live.push("done", { threadId: "th1", userMessageId: "u2", messageId: "a4", status: "complete" });
    await live.close();
    expect(await screen.findByText("新的回答")).toBeTruthy();
    expect(screen.queryByText("第二个回答")).toBeNull();
  });

  it("asks before retrying with the selected model when the answer's model is gone", async () => {
    const calls = api({
      chat: () => STORED(),
      post: (call) =>
        (call.body as { modelRef?: unknown }).modelRef === undefined
          ? new Response(
              JSON.stringify({
                error: { class: "llm_unconfigured", code: "llm_unconfigured.model_missing", retryDisposition: "never", userMessage: "", details: { providerProfileId: "p0", modelId: "old" } },
              }),
              { status: 422, headers: { "content-type": "application/json" } },
            )
          : stream([]),
    });
    renderPanel();
    await screen.findByText("第二个回答");
    fireEvent.click(screen.getByTestId("chat-turn-retry"));
    expect(await screen.findByText("原模型已不存在，改用当前选中的模型重试？")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-dialog-ok"));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{}, { modelRef: MODEL }]);
  });

  it("deletes one turn after a confirmation", async () => {
    const calls = api({ chat: () => STORED(), routes: { "POST /api/contents/c1/chat/turns/delete": { body: { deleted: ["u1", "a1"] } } } });
    renderPanel();
    await screen.findByText("第二个回答");
    fireEvent.click(within(turnsShown()[0]!).getByTestId("chat-turn-delete"));
    expect(await screen.findByText("删除这一轮问答？删除后它不再显示，也不再进入之后的对话。")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-dialog-ok"));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/c1/chat/turns/delete")).toBe(true));
    expect(calls.find((call) => call.path === "/api/contents/c1/chat/turns/delete")?.body).toEqual({ messageIds: ["u1"] });
  });

  it("deletes the picked turns together from the selection bar", async () => {
    const calls = api({ chat: () => STORED(), routes: { "POST /api/contents/c1/chat/turns/delete": { body: { deleted: ["u1", "a1", "u2", "a2"] } } } });
    renderPanel();
    await screen.findByText("第二个回答");
    expect(screen.queryByTestId("chat-turn-check")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-select"));
    const boxes = screen.getAllByTestId("chat-turn-check");
    expect(boxes).toHaveLength(2);
    expect(screen.getByTestId("chat-select-count").textContent).toBe("已选 0 轮");
    expect((screen.getByTestId("chat-select-delete") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect(screen.getByTestId("chat-select-count").textContent).toBe("已选 2 轮");
    fireEvent.click(screen.getByTestId("chat-select-delete"));
    expect(await screen.findByText("删除所选的 2 轮问答？删除后它们不再显示，也不再进入之后的对话。")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-dialog-ok"));
    await waitFor(() => expect(screen.queryByTestId("chat-select-bar")).toBeNull());
    expect(calls.find((call) => call.path === "/api/contents/c1/chat/turns/delete")?.body).toEqual({ messageIds: ["u1", "u2"] });
  });

  it("shows why a delete was refused", async () => {
    api({
      chat: () => STORED(),
      routes: {
        "POST /api/contents/c1/chat/turns/delete": {
          status: 409,
          body: { error: { class: "conflict", code: "conflict.chat_inflight", retryDisposition: "never", userMessage: "这个对话还有正在生成的回答，请等它结束或先停止生成" } },
        },
      },
    });
    renderPanel();
    await screen.findByText("第二个回答");
    fireEvent.click(within(turnsShown()[1]!).getByTestId("chat-turn-delete"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-ok"));
    expect((await screen.findByRole("alert")).textContent).toContain("这个对话还有正在生成的回答");
  });

  it("clears every thread after a confirmation", async () => {
    const calls = api({ threads: () => ({ threads: [threadOf("th1")] }), chat: () => STORED(), routes: { "DELETE /api/contents/c1/chat": { status: 204 } } });
    renderPanel();
    await screen.findByText("第二个回答");
    fireEvent.click(screen.getByTestId("chat-clear"));
    expect(await screen.findByText("清空后这段内容的全部会话及其对话历史将被删除，无法恢复。")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-dialog-ok"));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/contents/c1/chat")).toBe(true));
  });

  it("copies an answer with timestamps, web source numbers and the list of cited sources", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const sources = [
      { id: "w1", index: 1, url: "https://news.example/a", title: "第一篇", excerpt: "", fetchedAt: 1 },
      { id: "w2", index: 2, url: "https://news.example/b", title: "没有引用的一篇", excerpt: "", fetchedAt: 1 },
    ];
    api({
      chat: () =>
        chatOf([
          user("u1", "最新进展？"),
          answer("a1", `视频里讲到 [[seg:${CITED_SEGMENT_ID}]]，最新消息见 [[web:w1]]。`, {
            citations: [{ transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID }],
            webSearch: { mode: "auto", status: "searched", planned: 1, requested: 1, succeeded: 1, queries: ["进展"], sources },
          }),
        ]),
    });
    renderPanel();
    await screen.findByRole("button", { name: "1:15" }, { timeout: 5000 });
    expect(screen.getByTestId("chat-search-status").textContent).toContain("搜索到 2 个来源");
    expect(screen.getByTestId("chat-messages").querySelector("[data-web-citation='w1']")?.textContent).toBe("[1]");
    fireEvent.click(screen.getByTestId("chat-turn-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("视频里讲到 [1:15]，最新消息见 [1]。\n\n来源：\n[1] 第一篇 https://news.example/a"));
  });
});

describe("chat web search", () => {
  it("sends the remembered setting, forces a search for one message only, and remembers off / auto", async () => {
    const calls = api({ settings: { chatWebSearchMode: "auto" }, webSearch: { service: "tavily", credentialStatus: "configured" } });
    renderPanel();
    await screen.findByTestId("chat-mode");
    const toggle = await screen.findByTestId("chat-web-search");
    expect(toggle.getAttribute("data-mode")).toBe("auto");
    fireEvent.change(input(), { target: { value: "今天的新闻？" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ webSearch: "auto" });

    fireEvent.keyDown(screen.getByTestId("chat-web-search"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("chat-web-search-force"));
    expect(screen.getByTestId("chat-web-search").getAttribute("data-mode")).toBe("force");
    await waitFor(() => expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true));
    fireEvent.change(input(), { target: { value: "再搜一次" } });
    await waitFor(() => expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "POST")[1]?.body).toMatchObject({ webSearch: "force" });
    expect(screen.getByTestId("chat-web-search").getAttribute("data-mode")).toBe("auto");
    // Forcing is never remembered; choosing off is.
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
    fireEvent.keyDown(screen.getByTestId("chat-web-search"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("chat-web-search-off"));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ chatWebSearchMode: "off" }));
    expect(screen.getByTestId("chat-web-search").getAttribute("data-mode")).toBe("off");
  });

  it("is greyed out with a way to configure when no search service is set up, and sends no web search", async () => {
    const calls = api({ settings: { chatWebSearchMode: "auto" } });
    renderPanel();
    await screen.findByTestId("chat-mode");
    expect((await screen.findByTestId("chat-web-search") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("chat-web-search-configure").getAttribute("href")).toBe("/settings/web-search");
    fireEvent.change(input(), { target: { value: "问一下" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ text: "问一下", modelRef: MODEL });
  });

  it("keeps the question and offers the settings when a forced search has no service", async () => {
    api({
      webSearch: { service: "tavily", credentialStatus: "configured" },
      post: () =>
        new Response(
          JSON.stringify({
            error: { class: "web_search_failed", code: "web_search_failed.unconfigured", retryDisposition: "never", userMessage: "尚未配置联网搜索服务", action: "configure_web_search" },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    });
    renderPanel();
    await screen.findByTestId("chat-mode");
    fireEvent.keyDown(await screen.findByTestId("chat-web-search"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("chat-web-search-force"));
    fireEvent.change(input(), { target: { value: "搜一下" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    expect((await screen.findByRole("alert")).textContent).toContain("尚未配置联网搜索服务");
    expect(within(screen.getByRole("alert")).getByTestId("chat-web-search-configure").getAttribute("href")).toBe("/settings/web-search");
    expect(input().value).toBe("搜一下");
    expect(screen.getByTestId("chat-web-search").getAttribute("data-mode")).toBe("force");
  });

  it("shows the search status line from the stream, then the sources as [n] links", async () => {
    let live!: ReturnType<typeof controlledStream>;
    api({
      webSearch: { service: "tavily", credentialStatus: "configured" },
      post: (call) => {
        live = controlledStream(call);
        return live.response;
      },
    });
    renderPanel();
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "最新版本是多少？" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(live).toBeDefined());
    await live.push("search.started", { planned: 2, queries: ["Amber 最新版本", "Amber release"] });
    expect((await screen.findByTestId("chat-search-status")).textContent).toBe("正在搜索：Amber 最新版本 · Amber release");
    const source = { id: "w1", index: 1, url: "https://example.org/release", title: "发布说明", excerpt: "…", fetchedAt: 1 };
    await live.push("search.done", { status: "partial", requested: 2, succeeded: 1, sources: [source] });
    await live.push("answer.delta", { delta: "最新版本见 [[web:w1]]。" });
    await waitFor(() => expect(screen.getByTestId("chat-search-status").textContent).toContain("部分查询失败，搜索到 1 个来源"));
    const link = screen.getByTestId("chat-messages").querySelector("[data-web-citation='w1']");
    expect(link?.textContent).toBe("[1]");
    expect(link?.getAttribute("href")).toBe("https://example.org/release");
    fireEvent.click(screen.getByTestId("chat-stop"));
  });
});

describe("chat input", () => {
  it("is resized from a grip on its top edge: dragging up makes it taller, down shorter, a double click restores it", async () => {
    api();
    renderPanel();
    await screen.findByTestId("chat-mode");
    const grip = screen.getByTestId("chat-input-resizer");
    expect(grip.getAttribute("role")).toBe("separator");
    // The grip sits above the text, at the top of the box.
    expect(screen.getByTestId("chat-box").firstElementChild).toBe(grip);
    const box = input();
    box.getBoundingClientRect = () => ({ height: 80 }) as DOMRect;
    fireEvent.pointerDown(grip, { button: 0, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: 380, pointerId: 1 });
    expect(box.style.height).toBe("200px");
    fireEvent.pointerMove(grip, { clientY: 540, pointerId: 1 });
    expect(box.style.height).toBe("40px");
    fireEvent.pointerUp(grip, { pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: 100, pointerId: 1 });
    expect(box.style.height).toBe("40px");

    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(box.style.height).toBe("96px");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(box.style.height).toBe("64px");
    fireEvent.doubleClick(grip);
    expect(box.style.height).toBe("");

    fireEvent.click(screen.getByTestId("chat-collapse"));
    expect(screen.queryByTestId("chat-input-resizer")).toBeNull();
  });

  it("grows with its text up to a cap, can be dragged, and drops a dragged height when folded", async () => {
    api();
    renderPanel();
    await screen.findByTestId("chat-mode");
    const box = input();
    expect(box.className).toContain("field-sizing-content");
    // The textarea's own corner handle grows it downwards; the grip on the top edge replaces it.
    expect(box.className).toContain("resize-none");
    expect(box.className).not.toContain("resize-y");
    expect(box.className).toContain("min-h-14");
    expect(box.className).toContain("max-h-60");
    expect(box.getAttribute("rows")).toBe("2");

    fireEvent.click(screen.getByTestId("chat-full"));
    expect(input().className).toContain("max-h-[45cqh]");
    expect(input().className).not.toContain("max-h-60");
    expect(screen.getByTestId("chat-panel").className).toContain("[container-type:size]");

    input().style.height = "200px";
    fireEvent.click(screen.getByTestId("chat-collapse"));
    expect(input().style.height).toBe("");
    expect(input().className).toContain("resize-none");
    expect(input().getAttribute("rows")).toBe("1");
  });

  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    const calls = api();
    renderPanel();
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "第一行" } });
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
  });
});
