import { describe, expect, it } from "vitest";
import { normalizeUsage, parseResponse, ResponsesStreamReader, type StreamStep } from "../../../../../src/server/adapters/llm/openai-responses/decode.ts";
import type { LogFields } from "../../../../../src/server/ports/logger.ts";

function collector(): { log: LogFields[]; onInconsistent: (fields: LogFields) => void } {
  const log: LogFields[] = [];
  return { log, onInconsistent: (fields) => log.push(fields) };
}

describe("normalizeUsage", () => {
  it("takes output as is when input and output add up to the total (OpenAI: output includes reasoning)", () => {
    const { log, onInconsistent } = collector();
    const raw = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 70, output_tokens_details: { reasoning_tokens: 50 }, total_tokens: 170 };
    expect(normalizeUsage(raw, onInconsistent)).toEqual({
      inputTokens: 100,
      outputTokens: 70,
      cacheReadTokens: 40,
      reasoningTokens: 50,
      rawJson: JSON.stringify(raw),
    });
    expect(log).toEqual([]);
  });

  it("adds reasoning when only that adds up to the total (xAI: output leaves reasoning out)", () => {
    const { log, onInconsistent } = collector();
    const raw = {
      input_tokens: 32,
      input_tokens_details: { cached_tokens: 6 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 110 },
      total_tokens: 151,
      cost_in_usd_ticks: 12345,
    };
    const usage = normalizeUsage(raw, onInconsistent);
    expect(usage).toMatchObject({ inputTokens: 32, outputTokens: 119, cacheReadTokens: 6, reasoningTokens: 110 });
    // Cost fields are kept in the raw JSON only, never used.
    expect(Object.keys(usage ?? {}).sort()).toEqual(["cacheReadTokens", "inputTokens", "outputTokens", "rawJson", "reasoningTokens"]);
    expect(JSON.parse(usage?.rawJson ?? "{}")).toEqual(raw);
    expect(log).toEqual([]);
  });

  it("keeps output as is and reports counts that add up neither way", () => {
    const { log, onInconsistent } = collector();
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 99 }, onInconsistent)).toMatchObject({
      outputTokens: 5,
      reasoningTokens: 3,
    });
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 20 }, onInconsistent)).toMatchObject({ outputTokens: 5 });
    expect(log).toEqual([
      { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, totalTokens: 99 },
      { inputTokens: 10, outputTokens: 5, reasoningTokens: null, totalTokens: 20 },
    ]);
  });

  it("does not take zero reasoning as the explanation of a mismatch", () => {
    const { log, onInconsistent } = collector();
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16 }, onInconsistent)).toMatchObject({
      outputTokens: 5,
    });
    expect(log).toHaveLength(1);
  });

  it("never fakes missing counts", () => {
    const { log, onInconsistent } = collector();
    expect(normalizeUsage(undefined, onInconsistent)).toBeUndefined();
    expect(normalizeUsage(null, onInconsistent)).toBeUndefined();
    expect(normalizeUsage({ input_tokens: 10 }, onInconsistent)).toBeUndefined();
    expect(normalizeUsage({ output_tokens: 10 }, onInconsistent)).toBeUndefined();
    const partial = normalizeUsage({ input_tokens: 10, output_tokens: 4 }, onInconsistent);
    expect(partial).toEqual({ inputTokens: 10, outputTokens: 4, rawJson: '{"input_tokens":10,"output_tokens":4}' });
    // Without a total nothing can be checked, so nothing is reported.
    expect(log).toEqual([]);
  });
});

describe("parseResponse", () => {
  it("assembles only output_text of message items, in order", () => {
    const outcome = parseResponse(
      JSON.stringify({
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
          { type: "message", content: [{ type: "output_text", text: "A" }, { type: "output_text", text: "B" }] },
          { type: "function_call", name: "report_status", arguments: "{}" },
          { type: "message", content: [{ type: "output_text", text: "C" }] },
        ],
      }),
    );
    expect(outcome).toMatchObject({ text: "ABC", stopReason: "stop", raw: "completed", functionCalls: [{ name: "report_status", arguments: "{}" }] });
  });

  it("fails on a body that is only an error object, or not a JSON object", () => {
    expect(() => parseResponse(JSON.stringify({ error: { code: "server_error", message: "boom" } }))).toThrow(/error object/);
    expect(() => parseResponse("[]")).toThrow(/malformed/);
    expect(() => parseResponse("{nope")).toThrow(/malformed/);
  });

  it("maps statuses: incomplete by reason, failed and other statuses as errors", () => {
    expect(parseResponse(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))).toMatchObject({
      stopReason: "length",
      raw: "max_output_tokens",
    });
    expect(parseResponse(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "content_filter" } }))).toMatchObject({
      stopReason: "error",
      raw: "incomplete: content_filter",
    });
    expect(parseResponse(JSON.stringify({ status: "failed", error: { code: "server_error", message: "boom" } }))).toMatchObject({
      stopReason: "error",
      raw: "server_error: boom",
    });
    expect(parseResponse(JSON.stringify({ status: "cancelled" }))).toMatchObject({ stopReason: "error", raw: "cancelled" });
  });
});

describe("ResponsesStreamReader", () => {
  const event = (payload: Record<string, unknown>): string => JSON.stringify(payload);
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "report_status", status: "completed" };

  function run(events: string[]): StreamStep[] {
    const reader = new ResponsesStreamReader();
    return events.map((data) => reader.step(data));
  }

  it("takes a function call's final arguments when they were streamed in pieces", () => {
    const steps = run([
      event({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } }),
      event({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"o' }),
      event({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: 'k":true}' }),
      event({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"ok":true}' }),
      event({ type: "response.output_item.done", output_index: 0, item: { ...call, arguments: '{"ok":true}' } }),
      event({ type: "response.completed", response: { status: "completed", output: [{ ...call, arguments: '{"ok":true}' }] } }),
    ]);
    expect(steps.map((step) => step.kind)).toEqual(["ignored", "progress", "progress", "ignored", "ignored", "end"]);
    expect(steps.at(-1)).toMatchObject({ outcome: { text: "", stopReason: "stop", functionCalls: [{ name: "report_status", arguments: '{"ok":true}' }] } });
  });

  it("takes a function call given whole in one chunk, from the done items when the terminal event leaves output out", () => {
    const steps = run([
      event({ type: "response.output_item.done", output_index: 1, item: { type: "message", content: [{ type: "output_text", text: "done" }] } }),
      event({ type: "response.output_item.done", output_index: 0, item: { ...call, arguments: '{"ok":true}' } }),
      event({ type: "response.completed", response: { status: "completed" } }),
    ]);
    expect(steps.at(-1)).toMatchObject({ outcome: { text: "done", functionCalls: [{ name: "report_status", arguments: '{"ok":true}' }] } });
  });

  it("remembers a streamed refusal and takes the terminal event's name when its status is missing", () => {
    const steps = run([
      event({ type: "response.refusal.delta", delta: "I can't " }),
      event({ type: "response.refusal.delta", delta: "help." }),
      event({ type: "response.completed", response: {} }),
    ]);
    expect(steps.at(-1)).toMatchObject({ outcome: { stopReason: "refused", raw: "refusal: I can't help." } });
    expect(run([event({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })]).at(-1)).toMatchObject({
      outcome: { stopReason: "length" },
    });
  });

  it("uses the SSE event name when the data has no type", () => {
    const reader = new ResponsesStreamReader();
    expect(reader.step(event({ delta: "hi" }), "response.output_text.delta")).toEqual({ kind: "text", delta: "hi" });
  });

  it("does not count empty deltas or lifecycle events as output", () => {
    expect(
      run([
        event({ type: "response.created", response: { status: "in_progress" } }),
        event({ type: "response.output_text.delta", delta: "" }),
        event({ type: "response.reasoning_text.delta", delta: "" }),
        event({ type: "response.reasoning_summary_text.delta", delta: "x" }),
      ]).map((step) => step.kind),
    ).toEqual(["ignored", "ignored", "ignored", "progress"]);
  });
});
