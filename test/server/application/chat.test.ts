import { afterEach, describe, expect, it } from "vitest";
import { ChatService, type ChatSendResult } from "../../../src/server/application/chat.ts";
import type { ChatSearchPlan, ChatSearchPlanRequest, ChatWebSearcher } from "../../../src/server/application/web-search.ts";
import { amberError, appError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { UserSettings } from "../../../src/server/domain/runtime-support.ts";
import type { ChatWebSearch } from "../../../src/server/domain/web-search.ts";
import type { Repository } from "../../../src/server/ports/repository.ts";
import type { ChatMessageRequest, ChatRetryRequest, ChatStreamEvent } from "../../../src/shared/dto/chat.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../fixtures/llm/fake-llm.ts";
import { PipelineLlmProvider } from "../../fixtures/llm/pipeline-llm.ts";
import { configureChatModel, seedChatContent, setContextWindow } from "../../fixtures/pipeline/chat-data.ts";
import { BOB, createHarness, createLocalContent, LOCAL, silentLogger, type Harness } from "../../fixtures/pipeline/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function setup(provider: FakeLlmProvider = new FakeLlmProvider()) {
  h = createHarness({ llmProviders: [provider] });
  return { h, provider };
}

const never = () => new AbortController().signal;

async function collect(result: ChatSendResult): Promise<ChatStreamEvent[]> {
  if (result.kind !== "stream") {
    throw new Error("expected a stream");
  }
  const events: ChatStreamEvent[] = [];
  for await (const event of result.events) {
    events.push(event);
  }
  return events;
}

function errorCodeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

const textOf = (events: readonly ChatStreamEvent[]) => events.flatMap((event) => (event.type === "answer.delta" ? [event.data.delta] : [])).join("");
const doneOf = (events: readonly ChatStreamEvent[]) => events.find((event) => event.type === "done")?.data as Extract<ChatStreamEvent, { type: "done" }>["data"];

describe("chat context of GET", () => {
  it("names why the context is unavailable: no model, unknown window", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 10);
    expect(h.chat.get(LOCAL, contentId, {})).toEqual({ thread: null, messages: [], context: { mode: "unavailable", reason: "no_model" } });
    const modelRef = configureChatModel(h, 128_000);
    setContextWindow(h, modelRef, undefined);
    expect(h.chat.get(LOCAL, contentId, modelRef).context).toEqual({ mode: "unavailable", reason: "context_window_unknown" });
    setContextWindow(h, modelRef, 128_000);
    const context = h.chat.get(LOCAL, contentId, modelRef).context;
    expect(context.mode).toBe("full");
    expect(context.estimatedTokens).toBeGreaterThan(0);
  });

  it("falls back to the chat model, then the default model of the settings", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 128_000);
    h.userSettings.patch(LOCAL, { defaultModelRef: modelRef });
    expect(h.chat.get(LOCAL, contentId, {}).context.mode).toBe("full");
  });

  it("hides another user's Content", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    expect(errorCodeOf(() => h.chat.get(BOB, contentId, {}))).toBe("not_found");
  });
});

describe("sending a message", () => {
  it("streams canonical citations, suggestions and usage, then stores the answer and writes back the chat model", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId, revisionId, segments } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 128_000);
    provider.script({ events: reply("答案见 [[s2]]。\n<<<suggestions>>>\n- 追问一\n- 追问二\n<<<end>>>") });

    const events = await collect(h.chat.send(LOCAL, contentId, { text: "讲了什么？", modelRef }, undefined, never()));
    const seg2 = segments[1]?.id as string;
    expect(textOf(events)).toBe(`答案见 [[seg:${seg2}]]。`);
    expect(events.find((event) => event.type === "citation")?.data).toEqual({ transcriptRevisionId: revisionId, segmentId: seg2, startMs: 10_000 });
    expect(events.find((event) => event.type === "suggestions")?.data).toEqual({ items: ["追问一", "追问二"] });
    expect(events.find((event) => event.type === "usage")?.data).toEqual({ inputTokens: 12, outputTokens: 5 });
    const done = doneOf(events);
    expect(done.status).toBe("complete");
    expect(events.at(-1)?.type).toBe("done");

    const chat = h.chat.get(LOCAL, contentId, {});
    expect(chat.messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(chat.messages[1]).toMatchObject({
      id: done.messageId,
      text: `答案见 [[seg:${seg2}]]。`,
      citations: [{ transcriptRevisionId: revisionId, segmentId: seg2 }],
      suggestions: ["追问一", "追问二"],
      contextTranscriptRevisionId: revisionId,
      modelRef: { ...modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: "model-a" },
    });
    expect(h.userSettings.get(LOCAL).chatModelRef).toEqual(modelRef);
    const usage = h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: "chat", chatMessageId: done.messageId, contentId, outcome: "succeeded" });
    expect(provider.calls[0]?.request.system).toContain("【逐字稿】");
  });

  it("sends the quoted sentence's stored text, never the client's, and refuses quotes from elsewhere", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId, revisionId, segments } = seedChatContent(h, 5);
    const other = seedChatContent(h, 2);
    const modelRef = configureChatModel(h, 128_000);
    const quote = { transcriptRevisionId: revisionId, segmentId: segments[2]?.id as SegmentId };
    await collect(h.chat.send(LOCAL, contentId, { text: "解释一下这句话", modelRef, quote }, undefined, never()));
    const turn = provider.calls[0]?.request.messages.at(-1)?.content[0];
    expect(turn?.type === "text" && turn.text).toBe(`【用户选中的原文】[[s3]] ${segments[2]?.text}\n解释一下这句话`);
    expect(h.chat.get(LOCAL, contentId, {}).messages[0]?.quote).toEqual(quote);

    const foreign = { transcriptRevisionId: other.revisionId, segmentId: other.segments[0]?.id as SegmentId };
    expect(errorCodeOf(() => h.chat.send(LOCAL, contentId, { text: "q", modelRef, quote: foreign }, undefined, never()))).toBe("invalid_request");
    const mismatched = { transcriptRevisionId: revisionId, segmentId: other.segments[0]?.id as SegmentId };
    expect(errorCodeOf(() => h.chat.send(LOCAL, contentId, { text: "q", modelRef, quote: mismatched }, undefined, never()))).toBe("invalid_request");
  });

  it("answers a Content without a transcript in the metadata mode: basic facts and reference texts, no citations, not grounded", async () => {
    const provider = new PipelineLlmProvider();
    const { h } = setup(provider);
    const modelRef = configureChatModel(h, 128_000);
    const contentId = createLocalContent(h);
    h.repository.withTransaction((scope) => {
      scope.contents.setMetadata(LOCAL.userId, contentId, { title: "第一讲：梯度下降", durationMs: 3_725_000 }, 2);
      scope.referenceTexts.insert(LOCAL.userId, { id: h.newId(), contentId, origin: "txt_import", text: "讲义：学习率决定每一步走多远。", createdAt: 3 });
    });
    const context = h.chat.get(LOCAL, contentId, modelRef).context;
    expect(context.mode).toBe("metadata");
    expect(context.estimatedTokens).toBeGreaterThan(0);

    const events = await collect(h.chat.send(LOCAL, contentId, { text: "这一讲讲什么？", modelRef, positionMs: 5_000 }, undefined, never()));
    expect(events.at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
    expect(events.some((event) => event.type === "citation")).toBe(false);
    const system = provider.calls[0]?.request.system ?? "";
    expect(system).toContain("字幕尚未就绪");
    expect(system).toContain("标题：第一讲：梯度下降");
    expect(system).toContain("来源：本地文件");
    expect(system).toContain("时长：1:02:05");
    expect(system).toContain("【参考文本】\n讲义：学习率决定每一步走多远。");
    expect(system).not.toContain("【逐字稿】");
    const answer = h.chat.get(LOCAL, contentId, modelRef).messages.at(-1);
    expect(answer).toMatchObject({ role: "assistant", status: "complete", citations: [] });
    expect(answer?.contextTranscriptRevisionId).toBeUndefined();
    expect(answer?.text.startsWith("字幕尚未就绪")).toBe(true);
  });

  it("switches from the metadata mode to full text once a primary revision exists", () => {
    const { h } = setup();
    const modelRef = configureChatModel(h, 128_000);
    const empty = createLocalContent(h);
    expect(h.chat.get(LOCAL, empty, modelRef).context.mode).toBe("metadata");
    const { contentId } = seedChatContent(h, 5);
    expect(h.chat.get(LOCAL, contentId, modelRef).context.mode).toBe("full");
  });

  it("refuses before anything is stored: unknown context window, foreign Content", () => {
    const { h } = setup();
    const modelRef = configureChatModel(h, 128_000);
    const send = (contentId: string, principal = LOCAL) => () => h.chat.send(principal, contentId, { text: "q", modelRef }, undefined, never());
    const { contentId } = seedChatContent(h, 3);
    expect(errorCodeOf(send(contentId, BOB))).toBe("not_found");
    setContextWindow(h, modelRef, undefined);
    expect(errorCodeOf(send(contentId))).toBe("llm_capability.context_window_unknown");
    expect(h.chat.get(LOCAL, contentId, {}).messages).toEqual([]);
  });

  it("marks an answer failed when the upstream fails, keeping what streamed", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    provider.script({ events: [{ type: "text_delta", delta: "半截" }], error: amberError("llm_failed", "boom", { code: "llm_failed.quota" }) });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never()));
    expect(doneOf(events)).toMatchObject({ status: "failed", error: { code: "llm_failed.quota" } });
    // The reason is stored, so a reload still says why it failed.
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "failed", text: "半截", error: { code: "llm_failed.quota" } });
  });

  it("marks a refused answer failed with llm_failed.refused and keeps none of what streamed", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    provider.script({ events: [{ type: "text_delta", delta: "半截 [[s1]]" }, { type: "done", stopReason: "refused", raw: "refusal: cyber" }] });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never()));
    expect(doneOf(events)).toMatchObject({ status: "failed", error: { code: "llm_failed.refused", upstreamMessage: "refusal: cyber" } });
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "failed", text: "", citations: [] });
  });

  it("marks an aborted answer interrupted and records its usage as outcome_unknown", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const controller = new AbortController();
    provider.script(async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "已经说出的话" };
      controller.abort();
      yield { type: "text_delta", delta: "不会出现" };
      yield { type: "done", stopReason: "stop" };
    });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, controller.signal));
    expect(doneOf(events).status).toBe("interrupted");
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "interrupted", text: "已经说出的话" });
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId)).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
  });

  it("replays an Idempotency-Key with the stored answer and calls no model again", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const body: ChatMessageRequest = { text: "q", modelRef };
    await collect(h.chat.send(LOCAL, contentId, body, "key-1", never()));
    const replay = h.chat.send(LOCAL, contentId, body, "key-1", never());
    expect(replay.kind).toBe("replay");
    expect(replay.kind === "replay" && replay.message).toMatchObject({ role: "assistant", status: "complete", text: "ok" });
    expect(provider.calls).toHaveLength(1);
    expect(errorCodeOf(() => h.chat.send(LOCAL, contentId, { ...body, text: "other" }, "key-1", never()))).toBe("idempotency_conflict");
    expect(h.chat.get(LOCAL, contentId, {}).messages).toHaveLength(2);
  });

  it("clears the history; the next message starts a new thread", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never()));
    expect(() => h.chat.clear(BOB, contentId)).toThrow();
    h.chat.clear(LOCAL, contentId);
    expect(h.chat.get(LOCAL, contentId, {})).toMatchObject({ thread: null, messages: [] });
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId))).toHaveLength(1);
  });

  it("recovers answers a previous process left streaming", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    h.repository.withTransaction((scope) => {
      scope.chat.insertThread(LOCAL.userId, { id: "t", contentId, createdAt: 0 });
      scope.chat.insertMessage(LOCAL.userId, { id: "a", threadId: "t", role: "assistant", text: "half", status: "streaming", citations: [], createdAt: 1 });
    });
    expect(h.chat.recoverInterrupted()).toBe(1);
    expect(h.chat.get(LOCAL, contentId, {}).messages[0]?.status).toBe("interrupted");
  });
});

describe("long transcripts and history", () => {
  it("answers a transcript beyond the budget in retrieval mode with resolvable citations", async () => {
    const provider = new PipelineLlmProvider();
    const { h } = setup(provider);
    const { contentId, segments } = seedChatContent(h, 1_800);
    const modelRef = configureChatModel(h, 8_000);
    expect(h.chat.get(LOCAL, contentId, modelRef).context.mode).toBe("retrieval");

    const events = await collect(h.chat.send(LOCAL, contentId, { text: "反向传播的要点是什么？", modelRef }, undefined, never()));
    expect(doneOf(events).status).toBe("complete");
    const system = provider.calls[0]?.request.system ?? "";
    expect(system).toContain("【相关片段】");
    expect(system).toContain("反向传播");
    expect(system).not.toContain("【逐字稿】");
    const answer = h.chat.get(LOCAL, contentId, {}).messages[1];
    expect(answer?.text).toMatch(/\[\[seg:[0-9A-Z]{26}\]\]/);
    const ids = new Set(segments.map((segment) => segment.id as string));
    expect(answer?.citations.length).toBeGreaterThan(0);
    expect(answer?.citations.every((citation) => ids.has(citation.segmentId))).toBe(true);
  });

  /** Ten finished turns of about 750 tokens each, stored directly. */
  function seedHistory(h: Harness, contentId: string, turns = 10): void {
    h.repository.withTransaction((scope) => {
      scope.chat.insertThread(LOCAL.userId, { id: "thread", contentId, createdAt: 0 });
      for (let i = 0; i < turns; i += 1) {
        scope.chat.insertMessage(LOCAL.userId, { id: `u${String(i).padStart(2, "0")}`, threadId: "thread", role: "user", text: `问题 ${i}`, status: "complete", citations: [], createdAt: 10 + i * 2 });
        scope.chat.insertMessage(LOCAL.userId, {
          id: `v${String(i).padStart(2, "0")}`, threadId: "thread", role: "assistant", text: `回答 ${i} ${"长".repeat(500)}`, status: "complete", citations: [], createdAt: 11 + i * 2,
        });
      }
    });
  }

  it("folds older turns into a compaction when the history exceeds the budget", async () => {
    const provider = new PipelineLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 8_000);
    seedHistory(h, contentId);
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "继续", modelRef }, undefined, never()));
    expect(doneOf(events).status).toBe("complete");
    expect(provider.kinds()).toEqual(["chat_compaction", "chat"]);
    const chat = h.chat.get(LOCAL, contentId, {});
    expect(chat.thread?.currentCompactionId).toBeDefined();
    const compaction = h.repository.withTransaction((scope) => scope.chat.getCompaction(LOCAL.userId, chat.thread?.currentCompactionId as string));
    expect(compaction).toMatchObject({ throughMessageId: "v03", promptRef: { id: "chat.compaction", version: 1 } });
    expect(provider.calls[1]?.request.system).toContain("【此前对话的压缩摘要】");
    const usage = h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
    expect(usage.find((row) => row.feature === "chat_compaction")?.artifactRevisionId).toBe(compaction?.id);
    expect(chat.messages).toHaveLength(22);
  });

  it("keeps answering with the most recent turns when compaction fails", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 8_000);
    seedHistory(h, contentId);
    provider.script({ events: [], error: amberError("llm_failed", "denied", { code: "llm_failed.auth" }) }, { events: reply("好的") });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "继续", modelRef }, undefined, never()));
    expect(doneOf(events).status).toBe("complete");
    expect(h.chat.get(LOCAL, contentId, {}).thread?.currentCompactionId).toBeUndefined();
    const roles = provider.calls[1]?.request.messages.map((message) => message.role) ?? [];
    // At least the minimum turns, never the whole history.
    expect(roles.length).toBeGreaterThanOrEqual(5);
    expect(roles.length).toBeLessThan(21);
  });
});

describe("summaries do not depend on the chat context window", () => {
  it("still accepts a summary request when the window is unknown", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    setContextWindow(h, modelRef, undefined);
    const accepted = await h.summaries.create(LOCAL, contentId, { templateId: "summary.core", modelRef }, undefined);
    expect(accepted.status).toBe(202);
  });
});

describe("quiescing an owner", () => {
  it("tracks streaming answers per owner and abortOwner waits for their final state", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "开头" };
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "done", stopReason: "aborted" };
    });
    const result = h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never());
    expect(h.chat.hasInflight(LOCAL.userId)).toBe(true);
    expect(h.chat.hasInflight(BOB.userId)).toBe(false);
    const consumed = collect(result);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await h.chat.abortOwner(LOCAL.userId);
    expect(h.chat.hasInflight(LOCAL.userId)).toBe(false);
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "interrupted", text: "开头" });
    expect(doneOf(await consumed).status).toBe("interrupted");
    // Nothing streaming: resolves at once.
    await h.chat.abortOwner(BOB.userId);
  });

  it("tracks answers per Content; abortContent aborts only that Content's and returns at once", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const other = seedChatContent(h, 3).contentId;
    const modelRef = configureChatModel(h, 128_000);
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "开头" };
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "done", stopReason: "aborted" };
    });
    const result = h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never());
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(true);
    expect(h.chat.hasInflightFor(LOCAL.userId, other)).toBe(false);
    expect(h.chat.hasInflightFor(BOB.userId, contentId)).toBe(false);
    const consumed = collect(result);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.chat.abortContent(LOCAL.userId, other);
    h.chat.abortContent(BOB.userId, contentId);
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(true);
    // No await: the abort is only signalled.
    h.chat.abortContent(LOCAL.userId, contentId);
    expect(doneOf(await consumed).status).toBe("interrupted");
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(false);
  });
});

const send = (harness: Harness, contentId: string, body: ChatMessageRequest, key?: string) => collect(harness.chat.send(LOCAL, contentId, body, key, never()));
const retry = (harness: Harness, contentId: string, messageId: string, body: ChatRetryRequest = {}, key = `retry-${harness.newId()}`) =>
  collect(harness.chat.retry(LOCAL, contentId, messageId, body, key, never()));
const foreignKeyViolations = (harness: Harness) => harness.db.prepare("PRAGMA foreign_key_check").all();
const lastUserText = (request: LlmRequest | undefined) => request?.messages.filter((message) => message.role === "user").map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));

/**
 * Scripts the next model call to hold after a first delta until released (then it completes
 * with `text`) or aborted.
 */
function hold(provider: FakeLlmProvider, text = "新回答"): () => void {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
    yield { type: "text_delta", delta: "开头" };
    await Promise.race([released, new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }))]);
    if (opts.signal.aborted) {
      yield { type: "done", stopReason: "aborted" };
      return;
    }
    yield* reply(text);
  });
  return release;
}

describe("threads", () => {
  it("lists threads newest first with derived titles; a new conversation reuses the newest thread while it is empty", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    expect(h.chat.threads(LOCAL, contentId)).toEqual({ threads: [] });
    const first = h.chat.createThread(LOCAL, contentId).thread;
    expect(h.chat.createThread(LOCAL, contentId).thread).toEqual(first);

    const done = doneOf(await send(h, contentId, { text: `${"😀长".repeat(25)}\n第二行`, modelRef }));
    expect(done.threadId).toBe(first.id);
    const second = h.chat.createThread(LOCAL, contentId).thread;
    expect(second.id).not.toBe(first.id);
    const { threads } = h.chat.threads(LOCAL, contentId);
    expect(threads.map((thread) => thread.id)).toEqual([second.id, first.id]);
    expect(threads[0]).toEqual({ id: second.id, createdAt: second.createdAt });
    expect(threads[1]?.title).toBe("😀长".repeat(20));
    expect(threads[1]?.lastMessageAt).toBe(h.chat.get(LOCAL, contentId, { threadId: first.id }).messages.at(-1)?.createdAt);

    // The newest thread by default; another one by id.
    expect(h.chat.get(LOCAL, contentId, {}).thread?.id).toBe(second.id);
    expect(h.chat.get(LOCAL, contentId, {}).messages).toEqual([]);
    expect(h.chat.get(LOCAL, contentId, { threadId: first.id }).messages).toHaveLength(2);
    const doneSecond = doneOf(await send(h, contentId, { text: "第二个会话", modelRef }));
    expect(doneSecond.threadId).toBe(second.id);
    expect(doneOf(await send(h, contentId, { text: "回到第一个", modelRef, threadId: first.id })).threadId).toBe(first.id);

    // A thread of another Content, or of another owner, is not found.
    const other = seedChatContent(h, 2).contentId;
    expect(errorCodeOf(() => h.chat.get(LOCAL, other, { threadId: first.id }))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.send(LOCAL, other, { text: "q", modelRef, threadId: first.id }, undefined, never()))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.deleteThread(LOCAL, other, first.id))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.threads(BOB, contentId))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.createThread(BOB, contentId))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.deleteThread(BOB, contentId, first.id))).toBe("not_found");

    h.chat.deleteThread(LOCAL, contentId, first.id);
    expect(h.chat.threads(LOCAL, contentId).threads.map((thread) => thread.id)).toEqual([second.id]);
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId))).toHaveLength(3);
  });

  it("renames and pins threads: pinned first by latest pin, a blank title restores the derived one, the default stays the newest", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const a = doneOf(await send(h, contentId, { text: "第一个会话", modelRef })).threadId;
    await pause();
    const b = h.chat.createThread(LOCAL, contentId).thread.id;
    await send(h, contentId, { text: "第二个会话", modelRef, threadId: b });
    await pause();
    const c = h.chat.createThread(LOCAL, contentId).thread.id;
    expect(h.chat.createThread(LOCAL, contentId).thread.id).toBe(c);
    const order = () => h.chat.threads(LOCAL, contentId).threads.map((thread) => thread.id);
    expect(order()).toEqual([c, b, a]);

    const renamed = h.chat.updateThread(LOCAL, contentId, a, { title: "  我的会话  " }).thread;
    expect(renamed).toMatchObject({ id: a, title: "我的会话", customTitle: "我的会话" });
    const pinnedA = h.chat.updateThread(LOCAL, contentId, a, { pinned: true }).thread;
    expect(pinnedA.pinnedAt).toBeTypeOf("number");
    expect(pinnedA.title).toBe("我的会话");
    await pause();
    h.chat.updateThread(LOCAL, contentId, b, { pinned: true });
    expect(order()).toEqual([b, a, c]);
    // Pinning again keeps the original pin time, so the order does not move.
    await pause();
    expect(h.chat.updateThread(LOCAL, contentId, a, { pinned: true }).thread.pinnedAt).toBe(pinnedA.pinnedAt);
    expect(order()).toEqual([b, a, c]);
    h.chat.updateThread(LOCAL, contentId, b, { pinned: false });
    expect(order()).toEqual([a, c, b]);
    // Without a thread id the newest thread opens, pinned or not.
    expect(h.chat.get(LOCAL, contentId, {}).thread?.id).toBe(c);

    expect(h.chat.updateThread(LOCAL, contentId, a, { title: "   " }).thread).toEqual(expect.not.objectContaining({ customTitle: expect.anything() }));
    expect(h.chat.threads(LOCAL, contentId).threads[0]).toMatchObject({ id: a, title: "第一个会话" });
    h.chat.updateThread(LOCAL, contentId, a, { title: "再命名" });
    expect(h.chat.updateThread(LOCAL, contentId, a, { title: null }).thread.title).toBe("第一个会话");

    // Renaming and pinning touch no message: allowed while the thread answers; deleting is not.
    const release = hold(provider);
    const streaming = collect(h.chat.send(LOCAL, contentId, { text: "生成中", modelRef, threadId: a }, undefined, never()));
    expect(h.chat.updateThread(LOCAL, contentId, a, { title: "生成中改名", pinned: false }).thread).toMatchObject({ title: "生成中改名" });
    expect(errorCodeOf(() => h.chat.deleteThread(LOCAL, contentId, a))).toBe("conflict.chat_inflight");
    release();
    expect(doneOf(await streaming).status).toBe("complete");

    const other = seedChatContent(h, 2).contentId;
    expect(errorCodeOf(() => h.chat.updateThread(LOCAL, other, a, { pinned: true }))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.updateThread(BOB, contentId, a, { pinned: true }))).toBe("not_found");
    expect(foreignKeyViolations(h)).toEqual([]);
  });

  it("allows one answer in flight per thread: sending, retrying, deleting turns or the thread are refused there, other threads go on", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const a1 = doneOf(await send(h, contentId, { text: "A 第一问", modelRef }));
    const threadB = h.chat.createThread(LOCAL, contentId).thread.id;
    const b1 = doneOf(await send(h, contentId, { text: "B 第一问", modelRef, threadId: threadB }));

    const release = hold(provider);
    const streaming = collect(h.chat.send(LOCAL, contentId, { text: "A 第二问", modelRef, threadId: a1.threadId }, undefined, never()));
    const refusals = [
      () => h.chat.send(LOCAL, contentId, { text: "A 再问", modelRef, threadId: a1.threadId }, undefined, never()),
      () => h.chat.retry(LOCAL, contentId, a1.messageId, {}, "retry-a", never()),
      () => h.chat.deleteTurns(LOCAL, contentId, { messageIds: [a1.userMessageId] }),
      () => h.chat.deleteThread(LOCAL, contentId, a1.threadId),
      () => h.chat.clear(LOCAL, contentId),
    ];
    for (const refused of refusals) {
      expect(errorCodeOf(refused)).toBe("conflict.chat_inflight");
    }
    expect(h.chat.get(LOCAL, contentId, { threadId: a1.threadId }).messages.map((message) => message.status)).toEqual(["complete", "complete", "complete", "streaming"]);

    // Thread B is unaffected.
    const b2 = doneOf(await send(h, contentId, { text: "B 第二问", modelRef, threadId: threadB }));
    expect(b2.status).toBe("complete");
    expect(doneOf(await retry(h, contentId, b2.messageId)).status).toBe("complete");
    expect(h.chat.deleteTurns(LOCAL, contentId, { messageIds: [b1.userMessageId] }).deleted).toEqual([b1.userMessageId, b1.messageId]);
    h.chat.deleteThread(LOCAL, contentId, threadB);

    release();
    expect(doneOf(await streaming).status).toBe("complete");
    const a3 = doneOf(await send(h, contentId, { text: "A 第三问", modelRef, threadId: a1.threadId }));
    expect(doneOf(await retry(h, contentId, a3.messageId)).status).toBe("complete");
    expect(h.chat.deleteTurns(LOCAL, contentId, { messageIds: [a1.messageId] }).deleted).toEqual([a1.userMessageId, a1.messageId]);
    h.chat.clear(LOCAL, contentId);
    expect(h.chat.threads(LOCAL, contentId).threads).toEqual([]);
    expect(foreignKeyViolations(h)).toEqual([]);
  });
});

describe("retrying the last answer", () => {
  it("shows the old answer and the new attempt while it streams, leaves the turn out of the context, and keeps only the new answer", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    await send(h, contentId, { text: "第一问", modelRef });
    provider.script({ events: reply("旧回答") });
    const old = doneOf(await send(h, contentId, { text: "第二问", modelRef }));
    const withTurn = h.chat.get(LOCAL, contentId, modelRef).context.estimatedTokens ?? 0;

    const release = hold(provider);
    const result = h.chat.retry(LOCAL, contentId, old.messageId, {}, "retry-1", never());
    const during = h.chat.get(LOCAL, contentId, modelRef);
    expect(during.messages.slice(3).map((message) => [message.id === old.messageId, message.status, message.replacesMessageId])).toEqual([
      [true, "complete", undefined],
      [false, "streaming", old.messageId],
    ]);
    expect(during.context.estimatedTokens).toBeLessThan(withTurn);
    release();
    const events = await collect(result);
    const done = doneOf(events);
    expect(done).toMatchObject({ threadId: old.threadId, userMessageId: old.userMessageId, status: "complete" });
    expect(textOf(events)).toBe("开头新回答");

    // History is the turns before; the current question is the turn's own; the old answer is not in it.
    const request = provider.calls.at(-1)?.request;
    expect(lastUserText(request)).toEqual(["第一问", "第二问"]);
    expect(JSON.stringify(request?.messages)).not.toContain("旧回答");

    const after = h.chat.get(LOCAL, contentId, {}).messages;
    expect(after.map((message) => message.id)).toEqual([after[0]?.id, after[1]?.id, old.userMessageId, done.messageId]);
    expect(after[3]).toMatchObject({ status: "complete", text: "开头新回答", replacesMessageId: old.messageId, finishedAt: expect.any(Number) });
    // Usage of both answers stays.
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId)).filter((row) => row.feature === "chat")).toHaveLength(3);
    expect(foreignKeyViolations(h)).toEqual([]);
  });

  it("keeps the old answer in effect and the failed attempt visible; the next retry first removes the failed attempt", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const old = doneOf(await send(h, contentId, { text: "问题", modelRef }));
    provider.script({ events: [{ type: "text_delta", delta: "半截" }], error: amberError("llm_failed", "boom", { code: "llm_failed.quota" }) });
    const failed = doneOf(await retry(h, contentId, old.messageId));
    expect(failed).toMatchObject({ status: "failed", error: { code: "llm_failed.quota" } });
    const messages = h.chat.get(LOCAL, contentId, {}).messages;
    expect(messages.map((message) => [message.id, message.status])).toEqual([
      [old.userMessageId, "complete"],
      [old.messageId, "complete"],
      [failed.messageId, "failed"],
    ]);
    expect(messages[2]?.finishedAt).toBeGreaterThan(0);

    // The failed attempt is not the effective answer and cannot be retried; the old one can.
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, failed.messageId, {}, "retry-x", never()))).toBe("conflict.chat_retry_not_last");
    const release = hold(provider);
    const second = h.chat.retry(LOCAL, contentId, old.messageId, {}, "retry-2", never());
    expect(h.chat.get(LOCAL, contentId, {}).messages.map((message) => message.status)).toEqual(["complete", "complete", "streaming"]);
    release();
    const done = doneOf(await collect(second));
    expect(h.chat.get(LOCAL, contentId, {}).messages.map((message) => [message.id, message.status])).toEqual([
      [old.userMessageId, "complete"],
      [done.messageId, "complete"],
    ]);
  });

  it("only retries the effective answer of the thread's last turn", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const first = doneOf(await send(h, contentId, { text: "一", modelRef }));
    const second = doneOf(await send(h, contentId, { text: "二", modelRef }));
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, first.messageId, {}, "k1", never()))).toBe("conflict.chat_retry_not_last");
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, second.userMessageId, {}, "k2", never()))).toBe("conflict.chat_retry_not_last");
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, "unknown", {}, "k3", never()))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.retry(BOB, contentId, second.messageId, {}, "k4", never()))).toBe("not_found");
    const other = seedChatContent(h, 2).contentId;
    expect(errorCodeOf(() => h.chat.retry(LOCAL, other, second.messageId, {}, "k5", never()))).toBe("not_found");
    expect(h.chat.get(LOCAL, contentId, {}).messages).toHaveLength(4);
  });

  it("after an interruption recovery the old answer stays in effect and the attempt is interrupted", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const snapshot = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
    h.repository.withTransaction((scope) => {
      scope.chat.insertThread(LOCAL.userId, { id: "t", contentId, createdAt: 0 });
      scope.chat.insertMessage(LOCAL.userId, { id: "u", threadId: "t", role: "user", text: "q", status: "complete", citations: [], createdAt: 1 });
      scope.chat.insertMessage(LOCAL.userId, { id: "a", threadId: "t", role: "assistant", text: "旧", status: "complete", modelRef: snapshot, citations: [], createdAt: 2, finishedAt: 3 });
      scope.chat.insertMessage(LOCAL.userId, { id: "b", threadId: "t", role: "assistant", text: "半", status: "streaming", modelRef: snapshot, replacesMessageId: "a", citations: [], createdAt: 4 });
    });
    expect(h.chat.recoverInterrupted()).toBe(1);
    const messages = h.chat.get(LOCAL, contentId, {}).messages;
    expect(messages.map((message) => [message.id, message.status])).toEqual([
      ["u", "complete"],
      ["a", "complete"],
      ["b", "interrupted"],
    ]);
    expect(messages[2]?.finishedAt).toBeGreaterThan(0);
    // The effective answer is still the old one.
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, "b", {}, "k", never()))).toBe("conflict.chat_retry_not_last");
  });

  it("answers from the current primary revision and refuses a quote that can no longer be read", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId, revisionId, segments } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const old = doneOf(await send(h, contentId, { text: "这句", modelRef, quote: { transcriptRevisionId: revisionId, segmentId: segments[1]?.id as SegmentId } }));

    // A new primary revision: the retry is grounded in it.
    const next = h.newId();
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id: next, contentId, kind: "manual", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "manual" }, segmentCount: 1, createdAt: 3 },
        [{ id: h.newId() as SegmentId, revisionId: next, ordinal: 0, startMs: 0, endMs: 9_000, text: "新的主版本句子", sourceSegmentIds: [] }],
      );
      scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, next, 4);
    });
    const done = doneOf(await retry(h, contentId, old.messageId));
    expect(h.chat.get(LOCAL, contentId, {}).messages.at(-1)).toMatchObject({ id: done.messageId, contextTranscriptRevisionId: next });
    expect(provider.calls.at(-1)?.request.system).toContain("新的主版本句子");

    // The quoted sentence's revision is gone: nothing is stored.
    h.repository.withTransaction((scope) => scope.transcripts.deleteRevision(LOCAL.userId, revisionId));
    const before = h.chat.get(LOCAL, contentId, {}).messages;
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, done.messageId, {}, "k-quote", never()))).toBe("conflict.chat_quote_unavailable");
    expect(h.chat.get(LOCAL, contentId, {}).messages).toEqual(before);
    expect(h.repository.withTransaction((scope) => scope.idempotency.get(LOCAL.userId, "POST /api/contents/:id/chat/messages/:mid/retry", "k-quote"))).toBeUndefined();
  });

  it("uses the replaced answer's model unless one is given, and names a model that is gone", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const old = doneOf(await send(h, contentId, { text: "问题", modelRef }));
    const other = configureChatModel(h, 64_000);
    h.db.prepare("DELETE FROM model_capability WHERE profile_id = ? AND model_id = ?").run(modelRef.providerProfileId, modelRef.modelId);

    let refused: unknown;
    try {
      h.chat.retry(LOCAL, contentId, old.messageId, {}, "k-missing", never());
    } catch (error) {
      refused = error;
    }
    expect(isAmberError(refused) && refused.appError).toMatchObject({
      class: "llm_unconfigured",
      code: "llm_unconfigured.model_missing",
      details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
    });
    expect(h.chat.get(LOCAL, contentId, {}).messages).toHaveLength(2);

    const done = doneOf(await retry(h, contentId, old.messageId, { modelRef: other }));
    expect(done.status).toBe("complete");
    expect(h.chat.get(LOCAL, contentId, {}).messages.at(-1)?.modelRef).toMatchObject({ ...other, protocolSnapshot: "openai_compatible" });
    expect(h.userSettings.get(LOCAL).chatModelRef).toEqual(other);
  });
});

describe("idempotent replays", () => {
  it("follow a successful retry, report a deleted answer without calling the model, and show failed or streaming attempts as stored", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const body: ChatMessageRequest = { text: "问题", modelRef };
    const old = doneOf(await send(h, contentId, body, "send-1"));
    provider.script({ events: reply("替换后的回答") });
    const replaced = doneOf(await retry(h, contentId, old.messageId, {}, "retry-1"));
    const replay = (key: string, request = body) => h.chat.send(LOCAL, contentId, request, key, never());
    expect(replay("send-1")).toEqual({ kind: "replay", message: expect.objectContaining({ id: replaced.messageId, text: "替换后的回答" }) });
    expect(h.chat.retry(LOCAL, contentId, old.messageId, {}, "retry-1", never())).toEqual({ kind: "replay", message: expect.objectContaining({ id: replaced.messageId }) });
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, old.messageId, { webSearch: "auto" }, "retry-1", never()))).toBe("idempotency_conflict");

    // A failed retry's key shows the failed attempt.
    provider.script({ events: [], error: amberError("llm_failed", "boom", { code: "llm_failed.quota" }) });
    const failed = doneOf(await retry(h, contentId, replaced.messageId, {}, "retry-2"));
    expect(h.chat.retry(LOCAL, contentId, replaced.messageId, {}, "retry-2", never())).toEqual({
      kind: "replay",
      message: expect.objectContaining({ id: failed.messageId, status: "failed" }),
    });
    expect(replay("send-1")).toEqual({ kind: "replay", message: expect.objectContaining({ id: replaced.messageId, status: "complete" }) });

    // While streaming, a replay shows the answer as it is.
    const release = hold(provider);
    const streaming = collect(h.chat.send(LOCAL, contentId, { text: "再问", modelRef }, "send-2", never()));
    expect(replay("send-2", { text: "再问", modelRef })).toEqual({ kind: "replay", message: expect.objectContaining({ status: "streaming" }) });
    release();
    await streaming;

    // Deleted: not found, and no model is called.
    h.chat.deleteTurns(LOCAL, contentId, { messageIds: [old.userMessageId] });
    const calls = provider.calls.length;
    expect(errorCodeOf(() => replay("send-1"))).toBe("not_found.chat_answer_deleted");
    expect(errorCodeOf(() => h.chat.retry(LOCAL, contentId, old.messageId, {}, "retry-1", never()))).toBe("not_found.chat_answer_deleted");
    h.chat.clear(LOCAL, contentId);
    expect(errorCodeOf(() => replay("send-2", { text: "再问", modelRef }))).toBe("not_found.chat_answer_deleted");
    expect(provider.calls).toHaveLength(calls);
  });
});

describe("deleting turns", () => {
  it("removes whole turns, keeps the others in display and context, and recomputes the title", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const first = doneOf(await send(h, contentId, { text: "第一轮问题", modelRef }));
    await send(h, contentId, { text: "第二轮问题", modelRef });
    expect(h.chat.get(LOCAL, contentId, {}).thread?.title).toBe("第一轮问题");

    expect(h.chat.deleteTurns(LOCAL, contentId, { messageIds: [first.messageId] })).toEqual({ deleted: [first.userMessageId, first.messageId] });
    const chat = h.chat.get(LOCAL, contentId, {});
    expect(chat.messages.map((message) => message.text)).toEqual(["第二轮问题", "ok"]);
    expect(chat.thread?.title).toBe("第二轮问题");
    await send(h, contentId, { text: "第三轮问题", modelRef });
    expect(lastUserText(provider.calls.at(-1)?.request)).toEqual(["第二轮问题", "第三轮问题"]);
    // Usage rows stay, unlinked.
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId)).filter((row) => row.chatMessageId === undefined)).toHaveLength(1);
    expect(errorCodeOf(() => h.chat.deleteTurns(LOCAL, contentId, { messageIds: ["unknown"] }))).toBe("not_found");
    expect(errorCodeOf(() => h.chat.deleteTurns(BOB, contentId, { messageIds: [chat.messages[0]?.id as string] }))).toBe("not_found");
    const other = seedChatContent(h, 2).contentId;
    expect(errorCodeOf(() => h.chat.deleteTurns(LOCAL, other, { messageIds: [chat.messages[0]?.id as string] }))).toBe("not_found");
    expect(foreignKeyViolations(h)).toEqual([]);
  });

  it("re-anchors compactions that ended on a deleted turn, or deletes them, falling back to the newest one left", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const snapshot = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
    const compaction = (id: string, throughMessageId: string, createdAt: number) => ({
      id, threadId: "t", throughMessageId, body: `摘要 ${id}`, modelRef: snapshot, promptRef: { id: "chat.compaction", version: 1 }, promptSnapshot: "p", createdAt,
    });
    h.repository.withTransaction((scope) => {
      scope.chat.insertThread(LOCAL.userId, { id: "t", contentId, createdAt: 0 });
      for (let i = 0; i < 5; i += 1) {
        scope.chat.insertMessage(LOCAL.userId, { id: `u${i}`, threadId: "t", role: "user", text: `问题 ${i}`, status: "complete", citations: [], createdAt: 10 + i * 2 });
        scope.chat.insertMessage(LOCAL.userId, { id: `v${i}`, threadId: "t", role: "assistant", text: `回答 ${i}`, status: "complete", citations: [], createdAt: 11 + i * 2 });
      }
      scope.chat.insertCompaction(LOCAL.userId, compaction("k1", "v1", 100));
      scope.chat.insertCompaction(LOCAL.userId, compaction("k2", "v3", 200));
    });
    const compactions = () => h.repository.withTransaction((scope) => scope.chat.listCompactions(LOCAL.userId, "t")).map((row) => [row.id, row.throughMessageId]);
    const current = () => h.chat.get(LOCAL, contentId, {}).thread?.currentCompactionId;

    // The compacted turn the current compaction ended on: it now ends on the previous turn.
    expect(h.chat.deleteTurns(LOCAL, contentId, { messageIds: ["v3"] }).deleted).toEqual(["u3", "v3"]);
    expect(compactions()).toEqual([["k1", "v1"], ["k2", "v2"]]);
    expect(current()).toBe("k2");
    expect(h.chat.get(LOCAL, contentId, {}).messages).toHaveLength(8);

    // Every message before k1's end goes: k1 goes with it.
    expect(h.chat.deleteTurns(LOCAL, contentId, { messageIds: ["u0", "v1"] }).deleted).toEqual(["u0", "v0", "u1", "v1"]);
    expect(compactions()).toEqual([["k2", "v2"]]);
    expect(h.chat.get(LOCAL, contentId, {}).thread?.title).toBe("问题 2");

    // The current one goes too: nothing is left to fall back to.
    h.chat.deleteTurns(LOCAL, contentId, { messageIds: ["u2"] });
    expect(compactions()).toEqual([]);
    expect(current()).toBeUndefined();
    expect(h.chat.get(LOCAL, contentId, {}).messages.map((message) => message.id)).toEqual(["u4", "v4"]);
    expect(foreignKeyViolations(h)).toEqual([]);
  });

  it("falls back to the newest compaction left when the current one is deleted", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const snapshot = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
    h.repository.withTransaction((scope) => {
      scope.chat.insertThread(LOCAL.userId, { id: "t", contentId, createdAt: 0 });
      scope.chat.insertMessage(LOCAL.userId, { id: "u0", threadId: "t", role: "user", text: "零", status: "complete", citations: [], createdAt: 1 });
      scope.chat.insertMessage(LOCAL.userId, { id: "v0", threadId: "t", role: "assistant", text: "答", status: "complete", citations: [], createdAt: 2 });
      scope.chat.insertMessage(LOCAL.userId, { id: "u1", threadId: "t", role: "user", text: "一", status: "complete", citations: [], createdAt: 3 });
      const base = { threadId: "t", modelRef: snapshot, promptRef: { id: "chat.compaction", version: 1 }, promptSnapshot: "p" };
      scope.chat.insertCompaction(LOCAL.userId, { ...base, id: "k1", throughMessageId: "v0", body: "旧", createdAt: 10 });
      scope.chat.insertCompaction(LOCAL.userId, { ...base, id: "k2", throughMessageId: "u0", body: "新", createdAt: 20 });
    });
    h.chat.deleteTurns(LOCAL, contentId, { messageIds: ["u0"] });
    expect(h.chat.get(LOCAL, contentId, {}).thread?.currentCompactionId).toBeUndefined();
    expect(foreignKeyViolations(h)).toEqual([]);
  });
});

/** A scriptable web searcher; counts its calls. */
class FakeSearcher implements ChatWebSearcher {
  configured = true;
  plans: ChatSearchPlanRequest[] = [];
  searches = 0;
  planResult: (request: ChatSearchPlanRequest) => ChatSearchPlan = (request) => ({ mode: request.mode, queries: [request.question] });
  record: (plan: ChatSearchPlan) => ChatWebSearch = (plan) => ({
    mode: plan.mode,
    status: "searched",
    planned: plan.queries.length,
    requested: plan.queries.length,
    succeeded: plan.queries.length,
    queries: plan.queries,
    sources: [{ id: "01J0000000000000000000WEB1", index: 1, url: "https://example.com/news", title: "网页来源标题", excerpt: "网页摘录", fetchedAt: 1 }],
  });

  isConfigured(): boolean {
    return this.configured;
  }

  async plan(request: ChatSearchPlanRequest): Promise<ChatSearchPlan> {
    this.plans.push(request);
    return this.planResult(request);
  }

  async search(_owner: string, plan: ChatSearchPlan): Promise<ChatWebSearch> {
    this.searches += 1;
    return this.record(plan);
  }
}

/** The harness's chat with a web searcher behind it, over a repository that records settings writes. */
function webChat(harness: Harness, searcher: ChatWebSearcher | undefined) {
  const settings: UserSettings[] = [];
  const repository: Repository = {
    withTransaction: (work) =>
      harness.repository.withTransaction((scope) =>
        work({
          ...scope,
          userSettings: {
            ...scope.userSettings,
            put: (row: UserSettings) => {
              settings.push(row);
              scope.userSettings.put(row);
            },
          },
        }),
      ),
  };
  const chat = new ChatService({ repository, llm: harness.llm, logger: silentLogger, newId: harness.newId, ...(searcher === undefined ? {} : { webSearch: searcher }) });
  return { chat, settings };
}

describe("web search", () => {
  it("refuses a forced search without a search service before storing anything", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const searcher = new FakeSearcher();
    searcher.configured = false;
    for (const chat of [h.chat, webChat(h, searcher).chat]) {
      let refused: unknown;
      try {
        chat.send(LOCAL, contentId, { text: "今天的新闻", modelRef, webSearch: "force" }, "force-1", never());
      } catch (error) {
        refused = error;
      }
      expect(isAmberError(refused) && refused.appError).toMatchObject({ class: "web_search_failed", code: "web_search_failed.unconfigured", action: "configure_web_search" });
    }
    expect(h.chat.get(LOCAL, contentId, {})).toMatchObject({ thread: null, messages: [] });
    expect(searcher.plans).toEqual([]);
  });

  it("skips an automatic search without a search service and answers as usual", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const searcher = new FakeSearcher();
    searcher.configured = false;
    const { chat, settings } = webChat(h, searcher);
    const events = await collect(chat.send(LOCAL, contentId, { text: "q", modelRef, webSearch: "auto" }, undefined, never()));
    expect(events.map((event) => event.type).filter((type) => type.startsWith("search."))).toEqual(["search.done"]);
    expect(events.find((event) => event.type === "search.done")?.data).toEqual({ status: "skipped", reason: "unconfigured", requested: 0, succeeded: 0, sources: [] });
    expect(doneOf(events).status).toBe("complete");
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]?.webSearch).toEqual({
      mode: "auto", status: "skipped", reason: "unconfigured", planned: 0, requested: 0, succeeded: 0, queries: [], sources: [],
    });
    expect(searcher.plans).toEqual([]);
    expect(settings.at(-1)?.chatWebSearchMode).toBe("auto");
  });

  it("plans, searches and announces it before the answer, then hands the sources to the model and stores the record", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const searcher = new FakeSearcher();
    const { chat, settings } = webChat(h, searcher);
    for (const text of ["第一问", "第二问", "第三问"]) {
      await collect(chat.send(LOCAL, contentId, { text, modelRef }, undefined, never()));
    }
    provider.script({ events: reply("据报道 [[w1]]。") });
    const events = await collect(chat.send(LOCAL, contentId, { text: "最新进展？", modelRef, webSearch: "force" }, undefined, never()));
    const types = events.map((event) => event.type);
    expect(types.indexOf("search.started")).toBeLessThan(types.indexOf("search.done"));
    expect(types.indexOf("search.done")).toBeLessThan(types.indexOf("answer.delta"));
    expect(events.find((event) => event.type === "search.started")?.data).toEqual({ planned: 1, queries: ["最新进展？"] });
    const done = doneOf(events);
    expect(searcher.plans).toHaveLength(1);
    expect(searcher.plans[0]).toMatchObject({
      owner: LOCAL.userId,
      mode: "force",
      modelRef,
      structuredOutput: false,
      recentQuestions: ["第二问", "第三问"],
      question: "最新进展？",
      contentId,
      chatMessageId: done.messageId,
    });
    expect(searcher.plans[0]?.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const answer = h.chat.get(LOCAL, contentId, {}).messages.at(-1);
    expect(answer?.webSearch).toMatchObject({ mode: "force", status: "searched", requested: 1, sources: [{ id: "01J0000000000000000000WEB1", index: 1 }] });
    expect(answer?.finishedAt).toBeGreaterThan(0);
    expect(provider.calls.at(-1)?.request.system).toContain("网页来源标题");
    // A forced search is not remembered; the earlier sends left the setting alone.
    expect(settings.map((row) => row.chatWebSearchMode)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("records a planner's decision not to search and runs no query", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const searcher = new FakeSearcher();
    searcher.planResult = (request) => ({ mode: request.mode, queries: [], reason: "not_needed" });
    const { chat } = webChat(h, searcher);
    const events = await collect(chat.send(LOCAL, contentId, { text: "这一讲讲什么", modelRef, webSearch: "auto" }, undefined, never()));
    expect(events.filter((event) => event.type.startsWith("search.")).map((event) => event.data)).toEqual([
      { status: "skipped", reason: "not_needed", requested: 0, succeeded: 0, sources: [] },
    ]);
    expect(searcher.searches).toBe(0);
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]?.webSearch).toMatchObject({ status: "skipped", reason: "not_needed" });
  });

  it("tells the model a failed search found nothing and still answers", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const searcher = new FakeSearcher();
    const error = appError("web_search_failed", { code: "web_search_failed.unreachable" });
    searcher.record = (plan) => ({ mode: plan.mode, status: "failed", planned: 1, requested: 1, succeeded: 0, queries: plan.queries, sources: [], error });
    const { chat } = webChat(h, searcher);
    const events = await collect(chat.send(LOCAL, contentId, { text: "最新消息", modelRef, webSearch: "auto" }, undefined, never()));
    expect(events.find((event) => event.type === "search.done")?.data).toMatchObject({ status: "failed", requested: 1, succeeded: 0, error: { code: "web_search_failed.unreachable" } });
    expect(doneOf(events).status).toBe("complete");
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]?.webSearch).toMatchObject({ status: "failed", error: { code: "web_search_failed.unreachable" } });
  });

  it("hands the model only the sources that fit its budget, and drops the web material when none does", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const searcher = new FakeSearcher();
    const source = (index: number, excerpt: string) => ({ id: `01J000000000000000000WEB0${index}`, index, url: `https://example.com/${index}`, title: `来源 ${index}`, excerpt, fetchedAt: 1 });
    const huge = "很长的摘录".repeat(5_000);
    let sources = [source(1, "短摘录"), source(2, huge)];
    searcher.record = (plan) => ({ mode: plan.mode, status: "searched", planned: 1, requested: 1, succeeded: 1, queries: plan.queries, sources });
    const { chat } = webChat(h, searcher);

    const fitted = await collect(chat.send(LOCAL, contentId, { text: "新闻一", modelRef, webSearch: "force" }, undefined, never()));
    expect(fitted.find((event) => event.type === "search.done")?.data).toMatchObject({ status: "searched", sources: [{ index: 1, title: "来源 1" }] });
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]?.webSearch?.sources.map((kept) => kept.title)).toEqual(["来源 1"]);
    expect(provider.calls.at(-1)?.request.system).toContain("来源 1");
    expect(provider.calls.at(-1)?.request.system).not.toContain(huge);

    sources = [source(1, huge)];
    const dropped = await collect(chat.send(LOCAL, contentId, { text: "新闻二", modelRef, webSearch: "force" }, undefined, never()));
    expect(dropped.find((event) => event.type === "search.done")?.data).toEqual({ status: "dropped", reason: "budget", requested: 1, succeeded: 1, sources: [] });
    expect(doneOf(dropped).status).toBe("complete");
    expect(h.chat.get(LOCAL, contentId, {}).messages[3]?.webSearch).toMatchObject({ status: "dropped", reason: "budget", sources: [] });
    expect(provider.calls.at(-1)?.request.system).not.toContain("来源 1");
  });

  it("searches again on a retry with the setting the retry gives", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const searcher = new FakeSearcher();
    const { chat } = webChat(h, searcher);
    const old = doneOf(await collect(chat.send(LOCAL, contentId, { text: "问题", modelRef }, undefined, never())));
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]?.webSearch).toBeUndefined();
    const events = await collect(chat.retry(LOCAL, contentId, old.messageId, { webSearch: "force" }, "retry-web", never()));
    expect(events.map((event) => event.type).slice(0, 2)).toEqual(["search.started", "search.done"]);
    expect(searcher.plans[0]).toMatchObject({ question: "问题", recentQuestions: [] });
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]?.webSearch).toMatchObject({ mode: "force", status: "searched" });
  });
});

describe("the model is told who it is", () => {
  it("keeps the protocol in the answer's snapshot and names profile and model in the system prompt", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    await send(h, contentId, { text: "你是什么模型？", modelRef });
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]?.modelRef).toEqual({ ...modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: "model-a", protocolSnapshot: "openai_compatible" });
    const system = provider.calls[0]?.request.system ?? "";
    expect(system).toContain("relay");
    expect(system).toContain("model-a");
  });
});
