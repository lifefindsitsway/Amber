import { describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "../../../src/shared/dto/chat.ts";
import { readChatAnswer } from "../../../src/web/chat/chat-stream.ts";

const SEGMENT = "01JABCDEFGHJKMNPQRSTVWXYZ3";

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("readChatAnswer", () => {
  it("reassembles frames split across chunks and validates each event", async () => {
    const whole =
      frame("answer.delta", { delta: "先看" }) +
      frame("citation", { transcriptRevisionId: "r1", segmentId: SEGMENT, startMs: 75_000 }) +
      frame("answer.delta", { delta: `重排序 [[seg:${SEGMENT}]]` }) +
      frame("suggestions", { items: ["为什么？"] }) +
      frame("usage", { inputTokens: 10, outputTokens: 3 }) +
      frame("done", { threadId: "th1", userMessageId: "m1", messageId: "m2", status: "complete" });
    const chunks = [whole.slice(0, 7), whole.slice(7, 61), whole.slice(61, 200), whole.slice(200)];
    const events: ChatStreamEvent[] = [];
    const outcome = await readChatAnswer(sse(chunks), (event) => events.push(event));
    expect(outcome).toEqual({ kind: "stream", done: true });
    expect(events.map((event) => event.type)).toEqual(["answer.delta", "citation", "answer.delta", "suggestions", "usage", "done"]);
    expect(events.filter((event) => event.type === "answer.delta").map((event) => event.data.delta).join("")).toBe(`先看重排序 [[seg:${SEGMENT}]]`);
  });

  it("drops unknown or malformed frames and heartbeats, and reports a stream that ended before done", async () => {
    const events: ChatStreamEvent[] = [];
    const outcome = await readChatAnswer(
      sse([": heartbeat\n\n", frame("mystery", {}), "event: answer.delta\ndata: {not json\n\n", frame("citation", { segmentId: "x" }), frame("answer.delta", { delta: "半" })]),
      (event) => events.push(event),
    );
    expect(outcome).toEqual({ kind: "stream", done: false });
    expect(events).toEqual([{ type: "answer.delta", data: { delta: "半" } }]);
  });

  it("carries a failed answer's error on done", async () => {
    const events: ChatStreamEvent[] = [];
    await readChatAnswer(
      sse([frame("done", { threadId: "th1", userMessageId: "m1", messageId: "m2", status: "failed", error: { class: "llm_failed", code: "llm_failed", retryDisposition: "never", userMessage: "上游出错" } })]),
      (event) => events.push(event),
    );
    expect(events[0]).toMatchObject({ type: "done", data: { status: "failed", error: { class: "llm_failed" } } });
  });

  it("treats a JSON answer as the Idempotency-Key replay of the stored message", async () => {
    const message = { id: "m2", role: "assistant", text: "旧回答", status: "interrupted", citations: [], createdAt: 1 };
    const response = new Response(JSON.stringify({ message }), { status: 200, headers: { "content-type": "application/json" } });
    expect(await readChatAnswer(response, () => undefined)).toEqual({ kind: "replay", message });
  });
});
