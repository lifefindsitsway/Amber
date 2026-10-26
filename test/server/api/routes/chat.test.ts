import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { registerProviderRoutes } from "../../../../src/server/api/routes/providers.ts";
import { ProviderService } from "../../../../src/server/application/providers.ts";
import type { LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import { CHAT_DELETE_TURNS_MAX } from "../../../../src/shared/defaults.ts";
import {
  chatDtoSchema,
  chatReplayDtoSchema,
  chatStreamEventSchemas,
  chatThreadCreatedDtoSchema,
  chatThreadsDtoSchema,
  chatTurnsDeleteResultSchema,
  type ChatStreamEventType,
} from "../../../../src/shared/dto/chat.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import { configureChatModel, seedChatContent, setContextWindow } from "../../../fixtures/pipeline/chat-data.ts";
import { BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, waitFor, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup(provider = new FakeLlmProvider()) {
  const h = createHarness({ llmProviders: [provider] });
  open.push(h);
  const fixture = seedChatContent(h, 6);
  const modelRef = configureChatModel(h, 128_000);
  const providers = new ProviderService({ repository: h.repository, secrets: h.secrets, prober: h.llm, newId: h.newId });
  const { app } = await h.app({ extraRoutes: (instance) => registerProviderRoutes(instance, { providers }) });
  return { h, app, provider, modelRef, ...fixture };
}

/** `event:` / `data:` frames of an SSE body, each data validated against its schema. */
function frames(body: string): Array<{ type: ChatStreamEventType; data: unknown }> {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      const type = (eventLine as string).slice("event: ".length) as ChatStreamEventType;
      return { type, data: chatStreamEventSchemas[type].parse(JSON.parse((dataLine as string).slice("data: ".length))) };
    });
}

describe("/api/contents/:id/chat", () => {
  it("returns the thread, its messages and the context of the chosen model", async () => {
    const { app, contentId, modelRef } = await setup();
    const url = `/api/contents/${contentId}/chat?providerProfileId=${modelRef.providerProfileId}&modelId=${modelRef.modelId}`;
    const response = await app.inject({ method: "GET", url, headers: auth });
    expect(response.statusCode).toBe(200);
    const chat = chatDtoSchema.parse(response.json());
    expect(chat).toMatchObject({ thread: null, messages: [], context: { mode: "full" } });
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat?modelId=x`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });

  it("streams an answer as SSE frames on the POST response and replays it by Idempotency-Key as JSON", async () => {
    const { app, provider, contentId, modelRef, segments } = await setup();
    provider.script({ events: reply("见 [[s1]]\n<<<suggestions>>>\n- 下一问\n- 再一问\n<<<end>>>") });
    const url = `/api/contents/${contentId}/chat/messages`;
    const headers = { ...auth, "idempotency-key": "chat-1" };
    const response = await app.inject({ method: "POST", url, headers, payload: { text: "讲了什么", modelRef } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = frames(response.body);
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(["citation", "answer.delta", "suggestions", "usage", "done"]));
    expect(events.at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
    expect(response.body).not.toContain("<<<");
    expect(response.body).not.toMatch(/\[\[s\d/);
    expect(events.filter((event) => event.type === "answer.delta").map((event) => (event.data as { delta: string }).delta).join("")).toBe(`见 [[seg:${segments[0]?.id}]]`);

    const replay = await app.inject({ method: "POST", url, headers, payload: { text: "讲了什么", modelRef } });
    expect(replay.statusCode).toBe(200);
    expect(chatReplayDtoSchema.parse(replay.json()).message).toMatchObject({ status: "complete", suggestions: ["下一问", "再一问"] });
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses with a JSON error before streaming: bad body, foreign Content, unknown context window", async () => {
    const { h, app, contentId, modelRef } = await setup();
    const url = `/api/contents/${contentId}/chat/messages`;
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { text: "", modelRef } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { text: "q", modelRef, extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob, payload: { text: "q", modelRef } })).statusCode).toBe(404);

    // Historical data: a model whose user-stated window was never filled in.
    setContextWindow(h, modelRef, undefined);
    const refused = await app.inject({ method: "POST", url, headers: auth, payload: { text: "q", modelRef } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      class: "llm_capability",
      code: "llm_capability.context_window_unknown",
      details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
    });
    const chosen = `providerProfileId=${modelRef.providerProfileId}&modelId=${modelRef.modelId}`;
    const get = await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat?${chosen}`, headers: auth });
    expect(get.json().context).toEqual({ mode: "unavailable", reason: "context_window_unknown" });

    // Filling in the override through the provider API makes chat usable again.
    const override = await app.inject({
      method: "PUT",
      url: `/api/providers/${modelRef.providerProfileId}/models/${encodeURIComponent(modelRef.modelId)}/override`,
      headers: auth,
      payload: { limits: { contextWindowTokens: 64_000 } },
    });
    expect(override.statusCode).toBe(200);
    const accepted = await app.inject({ method: "POST", url, headers: auth, payload: { text: "q", modelRef } });
    expect(accepted.statusCode).toBe(200);
    expect(frames(accepted.body).at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
  });

  it("deletes the history with 204", async () => {
    const { app, contentId, modelRef } = await setup();
    await app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages`, headers: auth, payload: { text: "q", modelRef } });
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}/chat`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}/chat`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat`, headers: auth })).json().messages).toEqual([]);
  });

  it("marks the answer interrupted when the client disconnects mid-stream, keeping what streamed", async () => {
    const provider = new FakeLlmProvider();
    let released = false;
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "第一段回答。" };
      // Waits like a slow upstream until the call is aborted.
      while (!opts.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      released = true;
      yield { type: "text_delta", delta: "不应保存" };
      yield { type: "done", stopReason: "aborted" };
    });
    const { h, app, contentId, modelRef } = await setup(provider);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ text: "讲一下", modelRef });
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path: `/api/contents/${contentId}/chat/messages`, headers: { ...auth, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (chunk.includes("第一段回答")) {
              req.destroy();
              resolve();
            }
          });
        },
      );
      req.on("error", () => undefined);
      req.on("close", () => resolve());
      setTimeout(() => reject(new Error("no first delta")), 5_000);
      req.end(body);
    });

    const assistant = () => h.chat.get(LOCAL, contentId, {}).messages[1];
    await waitFor(() => assistant()?.status === "interrupted");
    expect(released).toBe(true);
    expect(assistant()?.text).toBe("第一段回答。");
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId)).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
  });
});

describe("/api/contents/:id/chat threads, retries and turns", () => {
  async function ask(app: Awaited<ReturnType<typeof setup>>["app"], contentId: string, payload: Record<string, unknown>) {
    const response = await app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages`, headers: auth, payload });
    expect(response.statusCode).toBe(200);
    return frames(response.body).at(-1)?.data as { threadId: string; userMessageId: string; messageId: string; status: string };
  }

  it("lists, creates and deletes threads; GET picks one by threadId", async () => {
    const { app, contentId, modelRef } = await setup();
    const base = `/api/contents/${contentId}/chat`;
    expect(chatThreadsDtoSchema.parse((await app.inject({ method: "GET", url: `${base}/threads`, headers: auth })).json())).toEqual({ threads: [] });
    const created = await app.inject({ method: "POST", url: `${base}/threads`, headers: auth });
    expect(created.statusCode).toBe(200);
    const first = chatThreadCreatedDtoSchema.parse(created.json()).thread;
    expect(chatThreadCreatedDtoSchema.parse((await app.inject({ method: "POST", url: `${base}/threads`, headers: auth })).json()).thread.id).toBe(first.id);
    const done = await ask(app, contentId, { text: "第一个会话的问题\n第二行", modelRef });
    expect(done.threadId).toBe(first.id);
    const second = chatThreadCreatedDtoSchema.parse((await app.inject({ method: "POST", url: `${base}/threads`, headers: auth })).json()).thread;
    const listed = chatThreadsDtoSchema.parse((await app.inject({ method: "GET", url: `${base}/threads`, headers: auth })).json());
    expect(listed.threads.map((thread) => [thread.id, thread.title])).toEqual([
      [second.id, undefined],
      [first.id, "第一个会话的问题"],
    ]);
    const picked = chatDtoSchema.parse((await app.inject({ method: "GET", url: `${base}?threadId=${first.id}`, headers: auth })).json());
    expect(picked.thread?.id).toBe(first.id);
    expect(picked.messages).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: `${base}?threadId=unknown`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${base}/threads`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${base}/threads/${first.id}`, headers: bob })).statusCode).toBe(404);
    const patch = (id: string, payload: unknown, headers = auth) => app.inject({ method: "PATCH", url: `${base}/threads/${id}`, headers, payload: payload as Record<string, unknown> });
    const renamed = await patch(first.id, { title: "改过的名字", pinned: true });
    expect(renamed.statusCode).toBe(200);
    expect(chatThreadCreatedDtoSchema.parse(renamed.json()).thread).toMatchObject({ id: first.id, title: "改过的名字", customTitle: "改过的名字" });
    expect(chatThreadsDtoSchema.parse((await app.inject({ method: "GET", url: `${base}/threads`, headers: auth })).json()).threads[0]?.id).toBe(first.id);
    expect(chatThreadCreatedDtoSchema.parse((await patch(first.id, { title: null })).json()).thread.title).toBe("第一个会话的问题");
    expect((await patch(first.id, {})).statusCode).toBe(400);
    expect((await patch(first.id, { title: "长".repeat(256) })).statusCode).toBe(400);
    expect((await patch(first.id, { pinned: "yes" })).statusCode).toBe(400);
    expect((await patch(first.id, { pinned: true }, bob)).statusCode).toBe(404);
    expect((await patch("unknown", { pinned: true })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${base}/threads/${first.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `${base}/threads/${first.id}`, headers: auth })).statusCode).toBe(404);
  });

  it("retries the last answer as SSE with a required Idempotency-Key and replays it as JSON", async () => {
    const { app, provider, contentId, modelRef } = await setup();
    const first = await ask(app, contentId, { text: "问题", modelRef });
    const url = `/api/contents/${contentId}/chat/messages/${first.messageId}/retry`;
    expect((await app.inject({ method: "POST", url, headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "retry-1" }, payload: { extra: 1 } })).statusCode).toBe(400);
    provider.script({ events: reply("重新回答") });
    const headers = { ...auth, "idempotency-key": "retry-1" };
    const response = await app.inject({ method: "POST", url, headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const done = frames(response.body).at(-1);
    expect(done).toMatchObject({ type: "done", data: { threadId: first.threadId, userMessageId: first.userMessageId, status: "complete" } });
    const newId = (done?.data as { messageId: string }).messageId;

    const replay = await app.inject({ method: "POST", url, headers, payload: {} });
    expect(replay.statusCode).toBe(200);
    expect(chatReplayDtoSchema.parse(replay.json()).message).toMatchObject({ id: newId, text: "重新回答", replacesMessageId: first.messageId });
    const calls = provider.calls.length;

    // The replaced answer is gone: retrying it again is refused, the new one may be retried.
    const stale = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "retry-2" }, payload: {} });
    expect(stale.statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages/${newId}/retry`, headers: { ...auth, "idempotency-key": "retry-3" }, payload: {} })).statusCode).toBe(200);
    expect(provider.calls).toHaveLength(calls + 1);
    expect((await app.inject({ method: "POST", url, headers: { ...bob, "idempotency-key": "retry-4" }, payload: {} })).statusCode).toBe(404);
  });

  it("refuses retries before streaming: not the last turn, a model that is gone, a forced search without a service", async () => {
    const { h, app, contentId, modelRef } = await setup();
    const first = await ask(app, contentId, { text: "一", modelRef });
    const second = await ask(app, contentId, { text: "二", modelRef });
    const retryOf = (messageId: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages/${messageId}/retry`, headers: { ...auth, "idempotency-key": `k-${h.newId()}` }, payload });
    const notLast = await retryOf(first.messageId);
    expect(notLast.statusCode).toBe(409);
    expect(notLast.json().error.code).toBe("conflict.chat_retry_not_last");
    const forced = await retryOf(second.messageId, { webSearch: "force" });
    expect(forced.statusCode).toBe(422);
    expect(forced.json().error).toMatchObject({ code: "web_search_failed.unconfigured", action: "configure_web_search" });
    h.db.prepare("DELETE FROM model_capability WHERE profile_id = ? AND model_id = ?").run(modelRef.providerProfileId, modelRef.modelId);
    const missing = await retryOf(second.messageId);
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toMatchObject({ code: "llm_unconfigured.model_missing", details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId } });
    expect(chatDtoSchema.parse((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat`, headers: auth })).json()).messages).toHaveLength(4);
  });

  it("refuses a forced search without a service before anything is stored", async () => {
    const { app, contentId, modelRef } = await setup();
    const response = await app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages`, headers: auth, payload: { text: "新闻", modelRef, webSearch: "force" } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("web_search_failed.unconfigured");
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat`, headers: auth })).json()).toMatchObject({ thread: null, messages: [] });
  });

  it("deletes whole turns and validates the id list", async () => {
    const { app, contentId, modelRef } = await setup();
    const first = await ask(app, contentId, { text: "一", modelRef });
    await ask(app, contentId, { text: "二", modelRef });
    const url = `/api/contents/${contentId}/chat/turns/delete`;
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { messageIds: [] } })).statusCode).toBe(400);
    const tooMany = Array.from({ length: CHAT_DELETE_TURNS_MAX + 1 }, (_, index) => `m${index}`);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { messageIds: tooMany } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob, payload: { messageIds: [first.messageId] } })).statusCode).toBe(404);
    const response = await app.inject({ method: "POST", url, headers: auth, payload: { messageIds: [first.userMessageId] } });
    expect(response.statusCode).toBe(200);
    expect(chatTurnsDeleteResultSchema.parse(response.json())).toEqual({ deleted: [first.userMessageId, first.messageId] });
    const chat = chatDtoSchema.parse((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat`, headers: auth })).json());
    expect(chat.messages.map((message) => message.text)).toEqual(["二", "ok"]);
    expect(chat.thread?.title).toBe("二");
  });

  it("answers 409 conflict.chat_inflight while a thread is answering, and clearing waits for every thread", async () => {
    const provider = new FakeLlmProvider();
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    provider.script(async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "开头" };
      await released;
      yield { type: "done", stopReason: "stop" };
    });
    const { h, app, contentId, modelRef } = await setup(provider);
    const streaming = app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages`, headers: auth, payload: { text: "慢问题", modelRef } });
    await waitFor(() => h.chat.hasInflightFor(LOCAL.userId, contentId));
    const threadId = h.chat.get(LOCAL, contentId, {}).thread?.id as string;
    const busy = [
      await app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages`, headers: auth, payload: { text: "q", modelRef, threadId } }),
      await app.inject({ method: "DELETE", url: `/api/contents/${contentId}/chat/threads/${threadId}`, headers: auth }),
      await app.inject({ method: "DELETE", url: `/api/contents/${contentId}/chat`, headers: auth }),
    ];
    expect(busy.map((response) => [response.statusCode, response.json().error.code])).toEqual([
      [409, "conflict.chat_inflight"],
      [409, "conflict.chat_inflight"],
      [409, "conflict.chat_inflight"],
    ]);
    release();
    expect(frames((await streaming).body).at(-1)).toMatchObject({ type: "done", data: { status: "complete", threadId } });
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}/chat`, headers: auth })).statusCode).toBe(204);
  });
});
