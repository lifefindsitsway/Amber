import { describe, expect, it, vi } from "vitest";
import { OpenAiResponsesProvider } from "../../../../../src/server/adapters/llm/openai-responses/index.ts";
import { AmberError, isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../../src/server/domain/llm.ts";
import type { CapabilityFlags, ModelCapability, ProviderProfile } from "../../../../../src/server/domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../../../src/server/domain/usage.ts";
import type { LlmProbeCall, LlmProbeCheck } from "../../../../../src/server/ports/llm-provider.ts";
import type { Logger, LogFields } from "../../../../../src/server/ports/logger.ts";
import { OutboundHttpError, type OutboundRequest, type OutboundResponse } from "../../../../../src/server/ports/outbound-http.ts";
import { LLM_PROBE_MAX_OUTPUT_TOKENS, LLM_PROBE_TIMEOUT_MS, LLM_STREAM_IDLE_TIMEOUT_MS } from "../../../../../src/shared/defaults.ts";
import { EQUIVALENT_GOLDEN, EQUIVALENT_REQUEST } from "../../../../fixtures/llm/equivalent.ts";
import { responsesBody, responsesError, responsesStream } from "../../../../fixtures/llm/openai-responses/index.ts";

const API_KEY = "<openai-responses-test-key>";
const PROFILE: ProviderProfile = {
  id: "profile-under-test",
  userId: "user-1",
  name: "Responses",
  protocol: "openai_responses",
  baseURL: "https://responses.example.invalid/v1/",
  credentialRef: "secret-1",
  models: [],
  createdAt: 0,
};

const { credentialRef: _credentialRef, ...KEYLESS } = PROFILE;

const UNKNOWN_FLAGS: CapabilityFlags = {
  stream: "unknown",
  tools: "unknown",
  structuredOutput: "unknown",
  vision: "unknown",
  audioInput: "unknown",
  reasoning: "unknown",
};

function capability(override: Partial<CapabilityFlags> = {}): ModelCapability {
  return {
    modelId: "model-under-test",
    flags: { declared: UNKNOWN_FLAGS, userOverride: override },
    limits: { declared: {}, userOverride: { contextWindowTokens: 128_000 } },
  };
}

type Answer =
  | {
      status?: number;
      headers?: Readonly<Record<string, string>>;
      body?: string | string[];
      bodyError?: Error;
      hang?: boolean;
      /** Response headers never arrive; an abort fails the request in this phase. */
      noHeaders?: "before_send" | "after_send";
    }
  | Error;

function abortable(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    const abort = (): void => reject(new OutboundHttpError("after_send", "aborted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Captures requests and answers from a script; a body given as an array arrives in those chunks. */
class ScriptedHttp {
  readonly requests: OutboundRequest[] = [];
  private readonly answers: Answer[];

  constructor(...answers: Answer[]) {
    this.answers = answers;
  }

  get bodies(): Array<Record<string, unknown>> {
    return this.requests.map((request) => JSON.parse(request.body as string) as Record<string, unknown>);
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    const answer = this.answers.shift() ?? { status: 500, body: "{}" };
    if (answer instanceof Error) {
      throw answer;
    }
    const signal = request.signal;
    const phase = answer.noHeaders;
    if (phase !== undefined) {
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new OutboundHttpError(phase, "aborted")), { once: true });
      });
    }
    const pieces = typeof answer.body === "string" ? [answer.body] : (answer.body ?? []);
    const body = (async function* (): AsyncIterable<Uint8Array> {
      for (const piece of pieces) {
        yield new TextEncoder().encode(piece);
      }
      if (answer.bodyError !== undefined) {
        throw answer.bodyError;
      }
      if (answer.hang === true) {
        await abortable(signal);
      }
    })();
    return {
      status: answer.status ?? 200,
      headers: new Map(Object.entries(answer.headers ?? {})),
      body,
      async text() {
        let text = "";
        for await (const chunk of body) {
          text += new TextDecoder().decode(chunk);
        }
        return text;
      },
    };
  }
}

class RecordingLogger implements Logger {
  readonly warnings: Array<[string, LogFields | undefined]> = [];
  debug(): void {}
  info(): void {}
  warn(message: string, fields?: LogFields): void {
    this.warnings.push([message, fields]);
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

const KEY_VERSION = { versionId: "version-1", setAt: 1_700_000_000_000 };

function setup(http: ScriptedHttp, logger?: Logger) {
  const revealed: string[] = [];
  const provider = new OpenAiResponsesProvider({
    http,
    secrets: {
      revealVersioned: (_owner, ref) => {
        revealed.push(ref);
        return { plaintext: API_KEY, version: KEY_VERSION };
      },
    },
    ...(logger === undefined ? {} : { logger }),
    now: (() => {
      let time = 1_000;
      return () => (time += 7);
    })(),
  });
  return { provider, revealed };
}

async function events(source: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const result: LlmStreamEvent[] = [];
  for await (const event of source) {
    result.push(event);
  }
  return result;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (thrown: unknown) => thrown,
  );
}

const live = (): AbortSignal => new AbortController().signal;
const noStartReport = (): void => undefined;
const streamOf = (
  provider: OpenAiResponsesProvider,
  request: LlmRequest = EQUIVALENT_REQUEST,
  cap = capability(),
  signal = live(),
  onRequestStart: (info: RequestStartInfo) => void = noStartReport,
) => provider.stream(request, { signal, effectiveCapability: cap, profile: PROFILE, onRequestStart });

const PLAIN = capability({ stream: "unsupported" });

/** One SSE event in OpenAI's shape. */
const sse = (payload: Record<string, unknown>): string => `event: ${String(payload["type"])}\ndata: ${JSON.stringify(payload)}\n\n`;
const textDelta = (delta: string): string => sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta });
const terminal = (type: string, response: Record<string, unknown>): string => sse({ type, response });
const message = (...parts: Array<Record<string, unknown>>) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: parts });
const outputText = (text: string) => ({ type: "output_text", text, annotations: [] });
const USAGE = { input_tokens: 9, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 };

function sliced(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    pieces.push(text.slice(offset, offset + size));
  }
  return pieces;
}

describe("OpenAiResponsesProvider.stream", () => {
  it("normalizes the equivalent fixture to the golden completion, whatever the chunking, skipping the reasoning item", async () => {
    for (const size of [7, 64, 100_000]) {
      const { provider } = setup(new ScriptedHttp({ body: sliced(responsesStream("equivalent"), size) }));
      const result = await events(streamOf(provider));
      const deltas = result.filter((event) => event.type === "text_delta");
      expect(deltas.map((event) => event.delta).join("")).toBe(EQUIVALENT_GOLDEN.text);
      expect(deltas).toHaveLength(4);
      expect(result.slice(-2)).toEqual([
        {
          type: "usage",
          usage: {
            ...EQUIVALENT_GOLDEN.usage,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            rawJson: '{"input_tokens":42,"input_tokens_details":{"cached_tokens":0},"output_tokens":23,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":65}',
          },
        },
        { type: "done", stopReason: EQUIVALENT_GOLDEN.stopReason, raw: "completed" },
      ]);
    }
  });

  it("reads xAI's usage, where output leaves reasoning out, and ignores the trailing [DONE]", async () => {
    const logger = new RecordingLogger();
    const http = new ScriptedHttp({ body: responsesStream("xai"), hang: true });
    const { provider } = setup(http, logger);
    const result = await events(streamOf(provider));
    expect(result.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual(["Hi ", "there."]);
    const usage = result.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ usage: { inputTokens: 32, outputTokens: 119, cacheReadTokens: 6, reasoningTokens: 110 } });
    expect(JSON.parse((usage as { usage: { rawJson: string } }).usage.rawJson)).toMatchObject({ total_tokens: 151, cost_in_usd_ticks: 12345 });
    expect(result.at(-1)).toEqual({ type: "done", stopReason: "stop", raw: "completed" });
    expect(logger.warnings).toEqual([]);
    // The terminal event ends the call: the connection is released, nothing more is awaited.
    expect(http.requests[0]?.signal.aborted).toBe(true);
  });

  it("logs counts that add up neither way and keeps output as reported", async () => {
    const logger = new RecordingLogger();
    const usage = { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 99 };
    const body = textDelta("hi") + terminal("response.completed", { status: "completed", output: [message(outputText("hi"))], usage });
    const { provider } = setup(new ScriptedHttp({ body }), logger);
    const result = await events(streamOf(provider));
    expect(result.find((event) => event.type === "usage")).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 } });
    expect(logger.warnings).toEqual([["llm_usage_inconsistent", { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, totalTokens: 99 }]]);
  });

  it("emits no usage event when the terminal event carries none", async () => {
    const body = textDelta("hi") + terminal("response.completed", { status: "completed", output: [message(outputText("hi"))], usage: null });
    const { provider } = setup(new ScriptedHttp({ body }));
    expect(await events(streamOf(provider))).toEqual([
      { type: "text_delta", delta: "hi" },
      { type: "done", stopReason: "stop", raw: "completed" },
    ]);
  });

  it("delivers the text of a terminal event when the upstream streamed no deltas", async () => {
    const body = terminal("response.completed", { status: "completed", output: [{ type: "reasoning", summary: [] }, message(outputText("A"), outputText("B"))], usage: USAGE });
    const { provider } = setup(new ScriptedHttp({ body }));
    expect((await events(streamOf(provider))).map((event) => event.type)).toEqual(["text_delta", "usage", "done"]);
  });

  it("maps a refusal to done(refused) with its explanation, streamed or whole", async () => {
    const refusal = { type: "refusal", refusal: "I can't help with that." };
    const body =
      sse({ type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "I can't " }) +
      sse({ type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "help with that." }) +
      sse({ type: "response.refusal.done", item_id: "msg_1", output_index: 0, content_index: 0, refusal: "I can't help with that." }) +
      terminal("response.completed", { status: "completed", output: [message(refusal)], usage: USAGE });
    const streamed = setup(new ScriptedHttp({ body }));
    expect(await events(streamOf(streamed.provider))).toEqual([
      { type: "usage", usage: expect.objectContaining({ inputTokens: 9, outputTokens: 4 }) },
      { type: "done", stopReason: "refused", raw: "refusal: I can't help with that." },
    ]);
    const whole = setup(new ScriptedHttp({ body: JSON.stringify({ status: "completed", output: [message(refusal)] }) }));
    expect(await events(streamOf(whole.provider, EQUIVALENT_REQUEST, PLAIN))).toEqual([{ type: "done", stopReason: "refused", raw: "refusal: I can't help with that." }]);
  });

  it("maps running out of output tokens to length and any other incomplete reason to error", async () => {
    const cut = textDelta("par") + terminal("response.incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message(outputText("par"))], usage: USAGE });
    const length = setup(new ScriptedHttp({ body: cut }));
    expect((await events(streamOf(length.provider))).at(-1)).toEqual({ type: "done", stopReason: "length", raw: "max_output_tokens" });
    const filtered = textDelta("par") + terminal("response.incomplete", { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] });
    const other = setup(new ScriptedHttp({ body: filtered }));
    expect(await events(streamOf(other.provider))).toEqual([
      { type: "text_delta", delta: "par" },
      { type: "done", stopReason: "error", raw: "incomplete: content_filter" },
    ]);
    const whole = setup(new ScriptedHttp({ body: JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message(outputText("par"))] }) }));
    expect(await events(streamOf(whole.provider, EQUIVALENT_REQUEST, PLAIN))).toEqual([
      { type: "text_delta", delta: "par" },
      { type: "done", stopReason: "length", raw: "max_output_tokens" },
    ]);
  });

  it("ends with done(error) on response.failed or an error event, after text already streamed", async () => {
    const failed = textDelta("par") + terminal("response.failed", { status: "failed", error: { code: "server_error", message: "The server had an error." }, output: [], usage: USAGE });
    const first = setup(new ScriptedHttp({ body: failed }));
    expect(await events(streamOf(first.provider))).toEqual([
      { type: "text_delta", delta: "par" },
      { type: "usage", usage: expect.objectContaining({ inputTokens: 9 }) },
      { type: "done", stopReason: "error", raw: "server_error: The server had an error." },
    ]);
    const errored = textDelta("par") + sse({ type: "error", code: "ERR_SOMETHING", message: "Something went wrong", param: null, sequence_number: 3 });
    const second = setup(new ScriptedHttp({ body: errored }));
    expect(await events(streamOf(second.provider))).toEqual([
      { type: "text_delta", delta: "par" },
      { type: "done", stopReason: "error", raw: "ERR_SOMETHING: Something went wrong" },
    ]);
    const noCode = setup(new ScriptedHttp({ body: sse({ type: "error", code: null, message: "Something went wrong", param: null }) }));
    expect(await events(streamOf(noCode.provider))).toEqual([{ type: "done", stopReason: "error", raw: "Something went wrong" }]);
  });

  it("treats a stream that stops before a terminal event as an unknown outcome, a [DONE] included", async () => {
    for (const body of [textDelta("par"), `${textDelta("par")}data: [DONE]\n\n`]) {
      const { provider } = setup(new ScriptedHttp({ body }));
      const error = (await failure(events(streamOf(provider)))) as AmberError;
      expect(error.appError).toMatchObject({ class: "llm_outcome_unknown", retryDisposition: "outcome_unknown" });
    }
  });

  it("treats a malformed event as an upstream failure", async () => {
    const { provider } = setup(new ScriptedHttp({ body: "data: {not json\n\n" }));
    expect(((await failure(events(streamOf(provider)))) as AmberError).appError.class).toBe("llm_failed");
  });

  it("passes over function call items, whether their arguments come in pieces or whole", async () => {
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", status: "completed" };
    const pieces =
      sse({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } }) +
      sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"q":' }) +
      sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '"x"}' }) +
      sse({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"q":"x"}' }) +
      sse({ type: "response.output_item.done", output_index: 0, item: { ...call, arguments: '{"q":"x"}' } });
    const whole = `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { ...call, arguments: '{"q":"x"}' } })}\n\n`;
    for (const prefix of [pieces, whole]) {
      const body = prefix + textDelta("ok") + terminal("response.completed", { status: "completed", output: [{ ...call, arguments: '{"q":"x"}' }, message(outputText("ok"))] });
      const { provider } = setup(new ScriptedHttp({ body }));
      expect(await events(streamOf(provider))).toEqual([
        { type: "text_delta", delta: "ok" },
        { type: "done", stopReason: "stop", raw: "completed" },
      ]);
    }
  });

  it("sends instructions, plain-text input and store: false to /responses, with the key only in the authorization header", async () => {
    const http = new ScriptedHttp({ body: responsesStream("equivalent") });
    const { provider, revealed } = setup(http);
    await events(
      streamOf(provider, {
        ...EQUIVALENT_REQUEST,
        messages: [
          { role: "user", content: [{ type: "text", text: "Q1" }] },
          { role: "assistant", content: [{ type: "text", text: "A1" }] },
          { role: "user", content: [{ type: "text", text: "Q2 " }, { type: "text", text: "continued" }] },
        ],
      }),
    );
    const [request] = http.requests;
    expect(request?.url).toBe("https://responses.example.invalid/v1/responses");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ authorization: `Bearer ${API_KEY}`, "content-type": "application/json", accept: "text/event-stream" });
    // The output watchdog bounds the wait for headers too; no transport-level timeout.
    expect(request?.timeoutMs).toBeUndefined();
    expect(revealed).toEqual(["secret-1"]);
    expect(http.bodies[0]).toEqual({
      model: "model-under-test",
      instructions: "You are a concise assistant.",
      input: [
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2 continued" },
      ],
      stream: true,
      store: false,
    });
  });

  it("leaves unset optional parameters out and sends the JSON schema flat under text.format", async () => {
    const http = new ScriptedHttp({ body: responsesBody() }, { body: responsesBody() });
    const { provider } = setup(http);
    await events(streamOf(provider, { ...EQUIVALENT_REQUEST, system: "" }, PLAIN));
    await events(
      streamOf(
        provider,
        { ...EQUIVALENT_REQUEST, maxOutputTokens: 512, optional: { temperature: 0.2 }, responseFormat: { type: "json_schema", schema: { type: "object" } } },
        PLAIN,
      ),
    );
    const [plain, full] = http.bodies;
    for (const key of ["instructions", "stream", "stream_options", "max_output_tokens", "temperature", "text", "tools", "tool_choice", "previous_response_id"]) {
      expect(plain).not.toHaveProperty(key);
    }
    expect(plain).toMatchObject({ store: false });
    expect(Object.values(plain ?? {})).not.toContain(null);
    expect(full).toMatchObject({
      max_output_tokens: 512,
      temperature: 0.2,
      store: false,
      text: { format: { type: "json_schema", name: "output", schema: { type: "object" }, strict: true } },
    });
    expect(http.requests[0]?.headers).toMatchObject({ accept: "application/json" });
  });

  it("falls back to one plain request when streaming is known unsupported, with the same event sequence", async () => {
    const http = new ScriptedHttp({ body: responsesBody() });
    const { provider } = setup(http);
    const result = await events(streamOf(provider, EQUIVALENT_REQUEST, PLAIN));
    expect(http.bodies[0]).not.toHaveProperty("stream");
    expect(result).toEqual([
      { type: "text_delta", delta: EQUIVALENT_GOLDEN.text },
      { type: "usage", usage: expect.objectContaining({ ...EQUIVALENT_GOLDEN.usage, cacheReadTokens: 32, reasoningTokens: 0 }) },
      { type: "done", stopReason: "stop", raw: "completed" },
    ]);
  });

  it("fails a plain answer that is only an error object", async () => {
    const { provider } = setup(new ScriptedHttp({ body: JSON.stringify({ error: { code: "server_error", message: "boom" } }) }));
    const error = (await failure(events(streamOf(provider, EQUIVALENT_REQUEST, PLAIN)))) as AmberError;
    expect(error.appError).toMatchObject({ class: "llm_failed", upstreamMessage: "server_error: boom" });
  });

  it("refuses audio before sending anything", async () => {
    const http = new ScriptedHttp();
    const { provider } = setup(http);
    expect(provider.audioMimeTypes).toEqual([]);
    expect(provider.protocol).toBe("openai_responses");
    const request: LlmRequest = { ...EQUIVALENT_REQUEST, messages: [{ role: "user", content: [{ type: "audio", mimeType: "audio/wav", dataRef: "x" }] }] };
    const error = (await failure(events(streamOf(provider, request)))) as AmberError;
    expect(error.appError.class).toBe("llm_capability");
    expect(http.requests).toHaveLength(0);
  });

  it("fails when the upstream rejects store: false, without re-sending it", async () => {
    const answer = responsesError("storeRejected");
    const http = new ScriptedHttp({ status: answer.status, body: answer.body }, { body: responsesStream("equivalent") });
    const { provider } = setup(http);
    const error = (await failure(events(streamOf(provider)))) as AmberError;
    expect(error.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.invalid_request", retryDisposition: "never" });
    expect(http.requests).toHaveLength(1);
  });

  it.each([
    ["auth", "llm_failed", "llm_failed.auth", "never"],
    ["insufficientQuota", "llm_failed", "llm_failed.quota", "never"],
    ["contextLength", "llm_capability", "llm_capability.context_length", "never"],
    ["modelNotFound", "llm_failed", "llm_failed.model_not_found", "never"],
    ["rateLimited", "llm_rate_limited", "llm_rate_limited", "policy"],
    ["serverError", "llm_failed", "llm_failed", "policy"],
    ["badRequest", "llm_failed", "llm_failed.invalid_request", "never"],
  ])("maps the %s answer to %s / %s (%s)", async (name, errorClass, code, disposition) => {
    const answer = responsesError(name);
    const { provider } = setup(new ScriptedHttp({ status: answer.status, body: answer.body }));
    const error = (await failure(events(streamOf(provider)))) as AmberError;
    expect(isAmberError(error)).toBe(true);
    expect(error.appError).toMatchObject({ class: errorClass, code, retryDisposition: disposition });
    expect(error.appError.upstreamMessage?.length).toBeGreaterThan(0);
    expect(error.message).toMatch(/^responses answered HTTP/);
    expect(JSON.stringify(error.appError)).not.toContain(API_KEY);
  });

  it("reads retry-after and tells a bare 429 apart from a rate limit", async () => {
    const { provider } = setup(new ScriptedHttp({ status: 429, headers: { "retry-after": "7" }, body: "" }, { status: 429, body: "" }));
    const timed = (await failure(events(streamOf(provider)))) as AmberError;
    expect(timed.appError).toMatchObject({ code: "llm_rate_limited.retry_after", details: { retryAfterMs: 7000 } });
    const bare = (await failure(events(streamOf(provider)))) as AmberError;
    expect(bare.appError).toMatchObject({ code: "llm_failed.limit_ambiguous" });
  });

  it("classifies transport failures by the send boundary", async () => {
    const before = setup(new ScriptedHttp(new OutboundHttpError("before_send", "network"))).provider;
    expect(((await failure(events(streamOf(before)))) as AmberError).appError).toMatchObject({ code: "llm_failed.unreachable", retryDisposition: "safe" });
    const after = setup(new ScriptedHttp(new OutboundHttpError("after_send", "timeout"))).provider;
    expect(((await failure(events(streamOf(after)))) as AmberError).appError.class).toBe("llm_outcome_unknown");
    const broken = setup(new ScriptedHttp({ body: [textDelta("a")], bodyError: new OutboundHttpError("after_send", "network") })).provider;
    expect(((await failure(events(streamOf(broken)))) as AmberError).appError.class).toBe("llm_outcome_unknown");
  });

  it("passes the caller's cancellation through with its phase, before and after sending", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const early = setup(new ScriptedHttp(new OutboundHttpError("before_send", "aborted"))).provider;
    const before = await failure(events(streamOf(early, EQUIVALENT_REQUEST, capability(), cancelled.signal)));
    expect(before).toBeInstanceOf(OutboundHttpError);
    expect((before as OutboundHttpError).phase).toBe("before_send");

    const controller = new AbortController();
    const { provider } = setup(new ScriptedHttp({ body: [textDelta("a")], hang: true }));
    const iterator = streamOf(provider, EQUIVALENT_REQUEST, capability(), controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "a" });
    const pending = iterator.next();
    controller.abort();
    const after = await failure(pending);
    expect(after).toBeInstanceOf(OutboundHttpError);
    expect((after as OutboundHttpError).phase).toBe("after_send");
  });

  it("gives up on an idle stream as an unknown outcome and aborts the request", async () => {
    vi.useFakeTimers();
    try {
      const http = new ScriptedHttp({ body: [textDelta("a")], hang: true });
      const { provider } = setup(http);
      const pending = failure(events(streamOf(provider)));
      await vi.advanceTimersByTimeAsync(LLM_STREAM_IDLE_TIMEOUT_MS + 1);
      expect(((await pending) as AmberError).appError.class).toBe("llm_outcome_unknown");
      expect(http.requests[0]?.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenAiResponsesProvider request start", () => {
  it("reports each request once, before sending, with the version of the key that is sent", async () => {
    const http = new ScriptedHttp({ body: responsesStream("equivalent") });
    const { provider } = setup(http);
    const starts: RequestStartInfo[] = [];
    await events(streamOf(provider, EQUIVALENT_REQUEST, capability(), live(), (info) => starts.push(info)));
    expect(starts).toEqual([{ sentAt: expect.any(Number), credential: KEY_VERSION }]);
    expect(http.requests).toHaveLength(1);
  });

  it("does not report when the request cannot be built or there is no key, and sends nothing when the callback throws", async () => {
    const http = new ScriptedHttp();
    const { provider } = setup(http);
    const starts: RequestStartInfo[] = [];
    const audio: LlmRequest = { ...EQUIVALENT_REQUEST, messages: [{ role: "user", content: [{ type: "audio", mimeType: "audio/wav", dataRef: "x" }] }] };
    await failure(events(streamOf(provider, audio, capability(), live(), (info) => starts.push(info))));
    const keyless = provider.stream(EQUIVALENT_REQUEST, {
      signal: live(),
      effectiveCapability: capability(),
      profile: KEYLESS,
      onRequestStart: (info) => starts.push(info),
    });
    expect(((await failure(events(keyless))) as AmberError).appError.class).toBe("llm_unconfigured");
    expect(starts).toEqual([]);
    const refused = new Error("stop");
    expect(
      await failure(
        events(
          streamOf(provider, EQUIVALENT_REQUEST, capability(), live(), () => {
            throw refused;
          }),
        ),
      ),
    ).toBe(refused);
    expect(http.requests).toHaveLength(0);
  });
});

describe("OpenAiResponsesProvider.probe", () => {
  type RunResult = { kind: string; result?: string; status?: string; reason?: string; latencyMs: number };

  async function runAll(http: ScriptedHttp, logger?: Logger) {
    const { provider } = setup(http, logger);
    const checks = provider.probe(PROFILE, "model-under-test");
    const calls: Array<[string, LlmProbeCall]> = [];
    const results: Array<[string, unknown]> = [];
    const starts: string[] = [];
    for (const check of checks) {
      try {
        results.push([
          check.kind,
          await check.run({ signal: live(), onRequestStart: () => starts.push(check.kind), onCall: (call) => calls.push([check.kind, call]) }),
        ]);
      } catch (error) {
        results.push([check.kind, error]);
      }
    }
    return { checks, calls, results, starts, bodies: http.bodies };
  }

  const verdicts = (results: Array<[string, unknown]>) =>
    results.map(([, result]) => (result instanceof Error ? (isAmberError(result) ? result.appError.code : result.name) : ((result as RunResult).result ?? (result as RunResult).status)));
  const whole = (response: Record<string, unknown>): Answer => ({ body: JSON.stringify({ status: "completed", usage: USAGE, ...response }) });
  const okText = whole({ output: [message(outputText("OK"))] });
  const okJson = whole({ output: [{ type: "reasoning", summary: [] }, message(outputText('{"ok":true}'))] });
  const toolCall = whole({ output: [{ type: "function_call", call_id: "call_1", name: "report_status", arguments: '{"ok":true}', status: "completed" }] });
  const cut = (output: unknown[] = []): Answer => whole({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output });
  const streamed = (): Answer => ({ body: responsesStream("equivalent") });
  const errorAnswer = (name: string): Answer => {
    const answer = responsesError(name);
    return { status: answer.status, body: answer.body };
  };

  it("runs the basic call, then the stream, JSON and tools checks, one capped request each", async () => {
    const http = new ScriptedHttp(okText, streamed(), okJson, toolCall);
    const { checks, calls, results, starts, bodies } = await runAll(http);
    expect(checks.map((check) => check.kind)).toEqual(["basic", "stream", "structuredOutput", "tools"]);
    expect(http.requests).toHaveLength(4);
    expect(starts).toEqual(["basic", "stream", "structuredOutput", "tools"]);
    for (const body of bodies) {
      expect(body).toMatchObject({ model: "model-under-test", max_output_tokens: LLM_PROBE_MAX_OUTPUT_TOKENS, store: false });
      expect(body).not.toHaveProperty("stream_options");
      expect(body).not.toHaveProperty("tool_choice");
    }
    expect(bodies[0]).not.toHaveProperty("stream");
    expect(bodies[1]).toMatchObject({ stream: true });
    expect(bodies[2]).toMatchObject({ text: { format: { type: "json_schema", name: "output", strict: true } } });
    expect(bodies[3]).toMatchObject({ tools: [{ type: "function", name: "report_status", strict: true }] });
    expect(bodies[3]?.["tools"]).not.toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.anything() })]));
    // The JSON prompt asks for no JSON.
    expect(JSON.stringify(bodies[2]?.["input"])).not.toMatch(/json/i);
    expect(JSON.stringify(bodies[2]?.["input"])).not.toMatch(/\bok\b/);
    expect(results.map(([, result]) => result)).toEqual([
      { kind: "basic", status: "connected", latencyMs: expect.any(Number) },
      { kind: "stream", result: "supported", latencyMs: expect.any(Number) },
      { kind: "structuredOutput", result: "supported", latencyMs: expect.any(Number) },
      { kind: "tools", result: "supported", latencyMs: expect.any(Number) },
    ]);
    expect(calls).toEqual([
      ["basic", { outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9, outputTokens: 4 }) }],
      ["stream", { outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 42, outputTokens: 23 }) }],
      ["structuredOutput", { outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9 }) }],
      ["tools", { outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9 }) }],
    ]);
  });

  it("calls the basic check incomplete when the cap cut it off before any text, connected otherwise", async () => {
    const http = new ScriptedHttp(cut([{ type: "reasoning", summary: [] }]), cut([message(outputText("O"))]));
    const { provider } = setup(http);
    const [basic] = provider.probe(PROFILE, "model-under-test");
    const run = () => (basic as LlmProbeCheck).run({ signal: live(), onRequestStart: noStartReport, onCall: () => undefined });
    expect(await run()).toMatchObject({ kind: "basic", status: "incomplete" });
    expect(await run()).toMatchObject({ kind: "basic", status: "connected" });
  });

  it("is inconclusive when the cap cut the JSON or tools check off, while a cut-off stream still shows streaming works", async () => {
    const truncatedStream = { body: textDelta("O") + terminal("response.incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: USAGE }) };
    const http = new ScriptedHttp(okText, truncatedStream, cut([message(outputText('{"o'))]), cut());
    const { results, calls } = await runAll(http);
    expect(results.slice(1).map(([, result]) => result)).toEqual([
      { kind: "stream", result: "supported", latencyMs: expect.any(Number) },
      { kind: "structuredOutput", result: "inconclusive", reason: "truncated", latencyMs: expect.any(Number) },
      { kind: "tools", result: "inconclusive", reason: "truncated", latencyMs: expect.any(Number) },
    ]);
    expect(calls.map(([, call]) => call.outcome)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  });

  it("learns unsupported when a 200 answer shows the stream, JSON schema or tools were ignored", async () => {
    // A relay that ignores `stream` answers with one JSON body.
    const http = new ScriptedHttp(okText, okText, okText, okText);
    const { results, calls } = await runAll(http);
    expect(verdicts(results)).toEqual(["connected", "unsupported", "unsupported", "unsupported"]);
    expect(calls[1]).toEqual(["stream", { outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9 }) }]);
  });

  it("judges a JSON answer to the stream check like a plain answer: only a normal response is unsupported", async () => {
    const errorObject: Answer = { body: JSON.stringify({ error: { code: "server_error", message: "boom", type: "server_error", param: null } }) };
    const failedResponse = whole({ status: "failed", error: { code: "server_error", message: "boom" }, output: [] });
    const refusal = whole({ output: [message({ type: "refusal", refusal: "No." })] });
    const malformed: Answer = { body: "<html>gateway</html>" };
    const outcomes: Array<[unknown, LlmProbeCall[]]> = [];
    for (const answer of [errorObject, failedResponse, refusal, malformed]) {
      const { provider } = setup(new ScriptedHttp(answer));
      const stream = provider.probe(PROFILE, "model-under-test")[1] as LlmProbeCheck;
      const calls: LlmProbeCall[] = [];
      outcomes.push([await failure(stream.run({ signal: live(), onRequestStart: noStartReport, onCall: (call) => calls.push(call) })), calls]);
    }
    expect(outcomes.map(([error]) => (error as AmberError).appError)).toEqual([
      expect.objectContaining({ code: "llm_failed", upstreamMessage: "server_error: boom" }),
      expect.objectContaining({ code: "llm_failed", upstreamMessage: "server_error: boom" }),
      expect.objectContaining({ code: "llm_failed.refused" }),
      // Neither JSON nor an event stream: a stream without a terminal event.
      expect.objectContaining({ class: "llm_outcome_unknown" }),
    ]);
    expect(outcomes.map(([, calls]) => calls)).toEqual([
      [{ outcome: "failed" }],
      [{ outcome: "failed", usage: expect.objectContaining({ inputTokens: 9 }) }],
      [{ outcome: "failed", usage: expect.objectContaining({ inputTokens: 9 }) }],
      [{ outcome: "outcome_unknown" }],
    ]);
  });

  it("reports an unreadable 200 answer as an unknown outcome, an error object as failed", async () => {
    const outcomes: LlmProbeCall[][] = [];
    for (const body of ["[]", '{"status":"comp', "<html>gateway</html>", JSON.stringify({ error: { message: "boom" } })]) {
      const { provider } = setup(new ScriptedHttp({ body }));
      const basic = provider.probe(PROFILE, "model-under-test")[0] as LlmProbeCheck;
      const calls: LlmProbeCall[] = [];
      const error = (await failure(basic.run({ signal: live(), onRequestStart: noStartReport, onCall: (call) => calls.push(call) }))) as AmberError;
      expect(error.appError.class).toBe("llm_failed");
      outcomes.push(calls);
    }
    expect(outcomes).toEqual([[{ outcome: "outcome_unknown" }], [{ outcome: "outcome_unknown" }], [{ outcome: "outcome_unknown" }], [{ outcome: "failed" }]]);
    // A broken event in a stream is unreadable too.
    const { provider } = setup(new ScriptedHttp({ body: "data: {not json\n\n" }));
    const stream = provider.probe(PROFILE, "model-under-test")[1] as LlmProbeCheck;
    const calls: LlmProbeCall[] = [];
    await failure(stream.run({ signal: live(), onRequestStart: noStartReport, onCall: (call) => calls.push(call) }));
    expect(calls).toEqual([{ outcome: "outcome_unknown" }]);
  });

  it("learns unsupported only from an explicit refusal of the probed feature", async () => {
    const http = new ScriptedHttp(okText, errorAnswer("streamUnsupported"), errorAnswer("textFormatUnsupported"), errorAnswer("toolsUnsupported"));
    const { results, calls } = await runAll(http);
    expect(verdicts(results)).toEqual(["connected", "unsupported", "unsupported", "unsupported"]);
    expect(calls.slice(1).map(([, call]) => call)).toEqual([{ outcome: "failed" }, { outcome: "failed" }, { outcome: "failed" }]);
  });

  it("is inconclusive on a bad request it cannot place, but fails the basic call on it", async () => {
    const bad = errorAnswer("badRequest");
    const http = new ScriptedHttp(okText, bad, { status: 422, body: JSON.stringify({ error: { message: "Unprocessable." } }) }, bad);
    const { results } = await runAll(http);
    expect(results.slice(1).map(([, result]) => (result as RunResult).reason)).toEqual(["upstream_rejected", "upstream_rejected", "upstream_rejected"]);
    const basic = await runAll(new ScriptedHttp(bad));
    expect(verdicts(basic.results)[0]).toBe("llm_failed.invalid_request");
    expect(basic.calls[0]).toEqual(["basic", { outcome: "failed" }]);
  });

  it("fails the basic call when the upstream rejects store: false, without re-sending it", async () => {
    const http = new ScriptedHttp(errorAnswer("storeRejected"));
    const { provider } = setup(http);
    const [basic] = provider.probe(PROFILE, "model-under-test");
    const calls: LlmProbeCall[] = [];
    const error = (await failure((basic as LlmProbeCheck).run({ signal: live(), onRequestStart: noStartReport, onCall: (call) => calls.push(call) }))) as AmberError;
    expect(error.appError.code).toBe("llm_failed.invalid_request");
    expect(http.requests).toHaveLength(1);
    expect(calls).toEqual([{ outcome: "failed" }]);
  });

  it("throws, after reporting the call, for authentication, unknown model, quota, rate limit and server errors", async () => {
    const http = new ScriptedHttp(errorAnswer("auth"), errorAnswer("modelNotFound"), errorAnswer("insufficientQuota"), errorAnswer("rateLimited"));
    const { results, calls } = await runAll(http);
    expect(verdicts(results)).toEqual(["llm_failed.auth", "llm_failed.model_not_found", "llm_failed.quota", "llm_rate_limited"]);
    expect(calls.map(([, call]) => call.outcome)).toEqual(["failed", "failed", "failed", "failed"]);
    const server = await runAll(new ScriptedHttp(okText, errorAnswer("serverError")));
    expect((server.results[1]?.[1] as AmberError).appError).toMatchObject({ class: "llm_failed", retryDisposition: "policy" });
  });

  it("fails on a refusal or a failed response, reporting the call as failed with its usage", async () => {
    const refusal = whole({ output: [message({ type: "refusal", refusal: "No." })] });
    const failedResponse = whole({ status: "failed", error: { code: "server_error", message: "boom" }, output: [] });
    const http = new ScriptedHttp(refusal, okText, refusal, failedResponse);
    const { results, calls } = await runAll(http);
    expect((results[0]?.[1] as AmberError).appError).toMatchObject({ code: "llm_failed.refused", retryDisposition: "never", upstreamMessage: "refusal: No." });
    expect((results[2]?.[1] as AmberError).appError).toMatchObject({ code: "llm_failed.refused" });
    expect((results[3]?.[1] as AmberError).appError).toMatchObject({ class: "llm_failed", upstreamMessage: "server_error: boom" });
    expect(calls).toEqual([
      ["basic", { outcome: "failed", usage: expect.objectContaining({ inputTokens: 9 }) }],
      ["stream", { outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9 }) }],
      ["structuredOutput", { outcome: "failed", usage: expect.objectContaining({ inputTokens: 9 }) }],
      ["tools", { outcome: "failed", usage: expect.objectContaining({ inputTokens: 9 }) }],
    ]);
  });

  it("ignores the trailing [DONE] after the terminal event, and leaves a stream without one unknown", async () => {
    const xai = await runAll(new ScriptedHttp(okText, { body: responsesStream("xai") }));
    expect(verdicts(xai.results).slice(0, 2)).toEqual(["connected", "supported"]);
    expect(xai.calls[1]).toEqual(["stream", { outcome: "succeeded", usage: expect.objectContaining({ outputTokens: 119 }) }]);
    const open = await runAll(new ScriptedHttp(okText, { body: `${textDelta("O")}data: [DONE]\n\n` }));
    expect((open.results[1]?.[1] as AmberError).appError.class).toBe("llm_outcome_unknown");
    expect(open.calls[1]).toEqual(["stream", { outcome: "outcome_unknown" }]);
  });

  it("logs inconsistent probe usage too", async () => {
    const logger = new RecordingLogger();
    await runAll(new ScriptedHttp(whole({ output: [message(outputText("OK"))], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 5 } })), logger);
    expect(logger.warnings).toEqual([["llm_usage_inconsistent", { inputTokens: 1, outputTokens: 1, reasoningTokens: null, totalTokens: 5 }]]);
  });

  it("reports nothing for a failure before sending and an unknown outcome after it", async () => {
    const http = new ScriptedHttp(new OutboundHttpError("before_send", "network"), new OutboundHttpError("after_send", "network"), {
      body: ['{"status":'],
      bodyError: new OutboundHttpError("after_send", "network"),
    });
    const { calls, results } = await runAll(http);
    expect((results[0]?.[1] as AmberError).appError.code).toBe("llm_failed.unreachable");
    expect((results[1]?.[1] as AmberError).appError.class).toBe("llm_outcome_unknown");
    expect((results[2]?.[1] as AmberError).appError.class).toBe("llm_outcome_unknown");
    expect(calls).toEqual([
      ["stream", { outcome: "outcome_unknown" }],
      ["structuredOutput", { outcome: "outcome_unknown" }],
      // The unscripted fourth request answers 500: a plain failure.
      ["tools", { outcome: "failed" }],
    ]);
  });

  it("follows the send boundary when the caller cancels", async () => {
    const { provider } = setup(new ScriptedHttp(new OutboundHttpError("before_send", "aborted"), new OutboundHttpError("after_send", "aborted")));
    const [first, second] = provider.probe(PROFILE, "model-under-test");
    const controller = new AbortController();
    controller.abort();
    const calls: LlmProbeCall[] = [];
    const before = await failure((first as LlmProbeCheck).run({ signal: controller.signal, onRequestStart: noStartReport, onCall: (call) => calls.push(call) }));
    const after = await failure((second as LlmProbeCheck).run({ signal: controller.signal, onRequestStart: noStartReport, onCall: (call) => calls.push(call) }));
    expect(before).toBeInstanceOf(OutboundHttpError);
    expect(after).toBeInstanceOf(OutboundHttpError);
    expect(calls).toEqual([{ outcome: "outcome_unknown" }]);
  });

  it("bounds a probe request by LLM_PROBE_TIMEOUT_MS as a whole", async () => {
    vi.useFakeTimers();
    try {
      const http = new ScriptedHttp({ noHeaders: "after_send" });
      const { provider } = setup(http);
      const [basic] = provider.probe(PROFILE, "model-under-test");
      const calls: LlmProbeCall[] = [];
      const pending = failure((basic as LlmProbeCheck).run({ signal: live(), onRequestStart: noStartReport, onCall: (call) => calls.push(call) }));
      await vi.advanceTimersByTimeAsync(LLM_PROBE_TIMEOUT_MS + 1);
      expect(((await pending) as AmberError).appError.class).toBe("llm_outcome_unknown");
      expect(calls).toEqual([{ outcome: "outcome_unknown" }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing and reports nothing when the start callback throws", async () => {
    const http = new ScriptedHttp(okText);
    const { provider } = setup(http);
    const [basic] = provider.probe(PROFILE, "model-under-test");
    const refused = new Error("stop");
    const calls: LlmProbeCall[] = [];
    const error = await failure(
      (basic as LlmProbeCheck).run({
        signal: live(),
        onRequestStart: () => {
          throw refused;
        },
        onCall: (call) => calls.push(call),
      }),
    );
    expect(error).toBe(refused);
    expect(http.requests).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});
