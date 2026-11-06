import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesProvider } from "../../../../../src/server/adapters/llm/anthropic-messages/index.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../../src/server/domain/llm.ts";
import type { CapabilityFlags, ModelCapability, ProviderProfile } from "../../../../../src/server/domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../../../src/server/domain/usage.ts";
import type { LlmProbeCall, LlmProbeCheck } from "../../../../../src/server/ports/llm-provider.ts";
import { OutboundHttpError, type OutboundRequest, type OutboundResponse } from "../../../../../src/server/ports/outbound-http.ts";
import {
  LLM_FIRST_OUTPUT_TIMEOUT_MS,
  LLM_MAX_OUTPUT_TOKENS_DEFAULT,
  LLM_PROBE_MAX_OUTPUT_TOKENS,
  LLM_PROBE_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_MS,
} from "../../../../../src/shared/defaults.ts";
import { anthropicError, anthropicFixture, type AnthropicErrorName } from "../../../../fixtures/llm/anthropic-messages/index.ts";
import { EQUIVALENT_GOLDEN, EQUIVALENT_REQUEST } from "../../../../fixtures/llm/equivalent.ts";

const API_KEY = "<anthropic-test-key>";
const KEY_VERSION = { versionId: "version-1", setAt: 1_700_000_000_000 };
const ignoreStart = (): void => undefined;
const BASE_URL = "https://llm.example.test";
const PROFILE: ProviderProfile = {
  id: "profile-under-test",
  userId: "user-1",
  name: "Test relay",
  protocol: "anthropic_messages",
  baseURL: BASE_URL,
  credentialRef: "secret-1",
  models: [],
  createdAt: 0,
};
const UNKNOWN_FLAGS: CapabilityFlags = {
  stream: "unknown",
  tools: "unknown",
  structuredOutput: "unknown",
  vision: "unknown",
  audioInput: "unknown",
  reasoning: "unknown",
};

function capability(overrides: { flags?: Partial<CapabilityFlags>; maxOutputTokens?: number } = {}): ModelCapability {
  return {
    modelId: "model-under-test",
    flags: { declared: UNKNOWN_FLAGS, ...(overrides.flags === undefined ? {} : { userOverride: overrides.flags }) },
    limits: {
      declared: {},
      userOverride: { contextWindowTokens: 200_000, ...(overrides.maxOutputTokens === undefined ? {} : { maxOutputTokens: overrides.maxOutputTokens }) },
    },
  };
}

/** A pause inside a scripted body; aborting the request ends it as the transport would. */
type Wait = { waitMs: number };

/**
 * A scripted answer: a body split into chunks (with pauses), a body that stalls after its
 * chunks, response headers that never arrive (an abort fails in the given phase), or a
 * transport failure.
 */
type Answer =
  | {
      status?: number;
      headers?: Readonly<Record<string, string>>;
      chunks?: readonly (string | Uint8Array | Wait)[];
      stall?: boolean;
      noHeaders?: "before_send" | "after_send";
    }
  | Error;

class ScriptedHttp {
  readonly requests: OutboundRequest[] = [];
  private readonly answers: Answer[];

  constructor(...answers: Answer[]) {
    this.answers = answers;
  }

  get bodies(): Record<string, unknown>[] {
    return this.requests.map((request) => JSON.parse(request.body as string) as Record<string, unknown>);
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    const answer = this.answers.shift() ?? new Error("no scripted answer left");
    if (answer instanceof Error) {
      throw answer;
    }
    const { signal } = request;
    const phase = answer.noHeaders;
    if (phase !== undefined) {
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new OutboundHttpError(phase, "aborted")), { once: true });
      });
    }
    const chunks = (answer.chunks ?? []).map((chunk) => (typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk));
    const body = (async function* (): AsyncIterable<Uint8Array> {
      for (const chunk of chunks) {
        if (signal.aborted) {
          throw new OutboundHttpError("after_send", "aborted");
        }
        if (chunk instanceof Uint8Array) {
          yield chunk;
          continue;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(new OutboundHttpError("after_send", "aborted"));
          signal.addEventListener("abort", abort, { once: true });
          setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, chunk.waitMs);
        });
      }
      if (answer.stall === true) {
        await new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new OutboundHttpError("after_send", "aborted"));
          }
          signal.addEventListener("abort", () => reject(new OutboundHttpError("after_send", "aborted")), { once: true });
        });
      }
    })();
    return {
      status: answer.status ?? 200,
      headers: new Map(Object.entries(answer.headers ?? {})),
      body,
      async text() {
        const parts: Uint8Array[] = [];
        for await (const chunk of body) {
          parts.push(chunk);
        }
        return Buffer.concat(parts).toString("utf8");
      },
    };
  }
}

function provider(http: ScriptedHttp, now?: () => number): AnthropicMessagesProvider {
  return new AnthropicMessagesProvider({
    http,
    secrets: {
      revealVersioned: (owner, ref) => ({ plaintext: owner === "user-1" && ref === "secret-1" ? API_KEY : "wrong", version: KEY_VERSION }),
    },
    ...(now === undefined ? {} : { now }),
  });
}

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const result: LlmStreamEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

/** Splits text into byte chunks of `size`, cutting through multi-byte characters. */
function bytesOf(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

const errorAnswer = (name: AnthropicErrorName): Answer => {
  const { status, body } = anthropicError(name);
  return { status, chunks: [body] };
};

const textOf = (events: LlmStreamEvent[]): string =>
  events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");

function expectInvariant(events: LlmStreamEvent[]): void {
  const kinds = events.map((event) => event.type).join(" ");
  expect(kinds).toMatch(/^(text_delta )*(usage )?done$/);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AnthropicMessagesProvider.stream", () => {
  it("normalizes the equivalent stream to the golden completion", async () => {
    const http = new ScriptedHttp({ chunks: bytesOf(anthropicFixture("equivalent.sse"), 5) });
    const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
    expectInvariant(events);
    expect(textOf(events)).toBe(EQUIVALENT_GOLDEN.text);
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject(EQUIVALENT_GOLDEN.usage);
    expect(usage?.type === "usage" && Object.keys(usage.usage).sort()).toEqual(["inputTokens", "outputTokens", "rawJson"]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop", raw: "end_turn" });
  });

  it("parses the recorded relay answer: text, merged usage with zero cache counts, end_turn", async () => {
    const http = new ScriptedHttp({ chunks: bytesOf(anthropicFixture("recorded.sse"), 13) });
    const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
    expectInvariant(events);
    expect(textOf(events)).toBe("OK");
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({ inputTokens: 48, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop", raw: "end_turn" });
  });

  it("sends the documented request: endpoint, version and key headers, required max_tokens", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] });
    await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
    const [request] = http.requests;
    expect(request?.url).toBe(`${BASE_URL}/v1/messages`);
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(request?.url).not.toContain(API_KEY);
    // The output watchdog bounds the wait for headers too; no transport-level timeout.
    expect(request?.timeoutMs).toBeUndefined();
    expect(http.bodies[0]).toEqual({
      model: "model-under-test",
      max_tokens: LLM_MAX_OUTPUT_TOKENS_DEFAULT,
      system: EQUIVALENT_REQUEST.system,
      messages: [{ role: "user", content: [{ type: "text", text: "用一句话介绍 Amber。" }] }],
      stream: true,
    });
  });

  it("leaves unset optional parameters out of the body instead of sending null", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] });
    const request: LlmRequest = { ...EQUIVALENT_REQUEST, system: "" };
    await collect(provider(http).stream(request, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
    const body = http.bodies[0] ?? {};
    for (const key of ["temperature", "output_config", "system", "top_p", "tools"]) {
      expect(Object.hasOwn(body, key), key).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain("null");
  });

  it("sends optional parameters and structured output only when set", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] });
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
    const request: LlmRequest = { ...EQUIVALENT_REQUEST, optional: { temperature: 0.2 }, responseFormat: { type: "json_schema", schema }, maxOutputTokens: 512 };
    await collect(provider(http).stream(request, { signal: new AbortController().signal, effectiveCapability: capability({ maxOutputTokens: 1024 }), profile: PROFILE, onRequestStart: ignoreStart }));
    expect(http.bodies[0]).toMatchObject({ temperature: 0.2, max_tokens: 512, output_config: { format: { type: "json_schema", schema } } });
  });

  it("fills the required max_tokens from the request, then the effective limit, then the named default", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] }, { chunks: [anthropicFixture("equivalent.sse")] });
    const signal = new AbortController().signal;
    await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal, effectiveCapability: capability({ maxOutputTokens: 1024 }), profile: PROFILE, onRequestStart: ignoreStart }));
    await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
    expect(http.bodies.map((body) => body["max_tokens"])).toEqual([1024, LLM_MAX_OUTPUT_TOKENS_DEFAULT]);
  });

  it("ignores pings and thinking, counts cache reads and writes as input, and maps a max_tokens stop to length", async () => {
    const http = new ScriptedHttp({ chunks: bytesOf(anthropicFixture("realistic.sse"), 7) });
    const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
    expectInvariant(events);
    expect(textOf(events)).toBe("Transcript-first means the timeline is the source");
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({ inputTokens: 12 + 100 + 2048, outputTokens: 64, cacheReadTokens: 2048, cacheWriteTokens: 100 });
    expect(usage?.type === "usage" && JSON.parse(usage.usage.rawJson)).toMatchObject({ input_tokens: 12, cache_read_input_tokens: 2048, output_tokens: 64 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "length", raw: "max_tokens" });
  });

  it("reports an error event inside a started stream as done(error) without usage", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("in-stream-error.sse")] });
    const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
    expect(events).toEqual([
      { type: "text_delta", delta: "Amber " },
      { type: "done", stopReason: "error", raw: "overloaded_error: Overloaded" },
    ]);
  });

  it("treats a stream that breaks off before message_stop as an unknown outcome", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("truncated.sse")] });
    const error = await failure(collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })));
    expect(isAmberError(error) && error.appError.class).toBe("llm_outcome_unknown");
  });

  it("asks for a whole answer when streaming is unsupported and synthesizes one delta", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("non-stream.json")] });
    const events = await collect(
      provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability({ flags: { stream: "unsupported" } }), profile: PROFILE, onRequestStart: ignoreStart }),
    );
    expect(Object.hasOwn(http.bodies[0] ?? {}, "stream")).toBe(false);
    expect(http.requests[0]?.timeoutMs).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["text_delta", "usage", "done"]);
    expect(textOf(events)).toBe(EQUIVALENT_GOLDEN.text);
    expect(events[1]?.type === "usage" && events[1].usage).toMatchObject(EQUIVALENT_GOLDEN.usage);
  });

  it("refuses audio before any request: the protocol has no audio input", async () => {
    const http = new ScriptedHttp();
    const request: LlmRequest = { ...EQUIVALENT_REQUEST, messages: [{ role: "user", content: [{ type: "audio", mimeType: "audio/wav", dataRef: "tmp/a.wav" }] }] };
    const error = await failure(collect(provider(http).stream(request, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })));
    expect(isAmberError(error) && error.appError.class).toBe("llm_capability");
    expect(http.requests).toHaveLength(0);
    expect(provider(http).audioMimeTypes).toEqual([]);
  });

  it("maps HTTP error answers per class, keeps the upstream message and never the key", async () => {
    const cases: Array<[AnthropicErrorName, string, string]> = [
      ["authentication", "llm_failed.auth", "never"],
      ["permission", "llm_failed.auth", "never"],
      ["billing", "llm_failed.quota", "never"],
      ["payment", "llm_failed.quota", "never"],
      ["not_found", "llm_failed.model_not_found", "never"],
      ["rate_limit", "llm_rate_limited", "policy"],
      ["overloaded", "llm_failed.overloaded", "policy"],
      ["server", "llm_failed", "policy"],
      ["context_length", "llm_capability.context_length", "never"],
      ["invalid_request", "llm_failed.invalid_request", "never"],
    ];
    for (const [name, code, disposition] of cases) {
      const http = new ScriptedHttp(errorAnswer(name));
      const error = await failure(collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })));
      expect(isAmberError(error), name).toBe(true);
      if (isAmberError(error)) {
        expect([name, error.appError.code, error.appError.retryDisposition]).toEqual([name, code, disposition]);
        expect(error.appError.upstreamMessage).toContain(JSON.parse(anthropicError(name).body).error.type);
        expect(JSON.stringify(error.appError) + error.message).not.toContain(API_KEY);
      }
    }
  });

  it("reads retry-after from the response headers of a rate-limited stream request", async () => {
    const { status, body } = anthropicError("rate_limit");
    const http = new ScriptedHttp({ status, headers: { "retry-after": "12" }, chunks: [body] });
    const error = await failure(collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })));
    expect(isAmberError(error) && error.appError).toMatchObject({ class: "llm_rate_limited", code: "llm_rate_limited.retry_after", details: { retryAfterMs: 12000 } });
  });

  it("classifies transport failures by the send boundary and passes the caller's cancellation through", async () => {
    const signal = new AbortController().signal;
    const before = await failure(collect(provider(new ScriptedHttp(new OutboundHttpError("before_send", "network"))).stream(EQUIVALENT_REQUEST, { signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })));
    expect(isAmberError(before) && [before.appError.code, before.appError.retryDisposition]).toEqual(["llm_failed.unreachable", "safe"]);
    const after = await failure(collect(provider(new ScriptedHttp(new OutboundHttpError("after_send", "timeout"))).stream(EQUIVALENT_REQUEST, { signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })));
    expect(isAmberError(after) && [after.appError.class, after.appError.retryDisposition]).toEqual(["llm_outcome_unknown", "outcome_unknown"]);

    const controller = new AbortController();
    const http = new ScriptedHttp({ chunks: [anthropicFixture("truncated.sse")], stall: true });
    const events: LlmStreamEvent[] = [];
    const cancelled = failure(
      (async () => {
        for await (const event of provider(http).stream(EQUIVALENT_REQUEST, { signal: controller.signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })) {
          events.push(event);
          controller.abort();
        }
      })(),
    );
    const error = await cancelled;
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect(error instanceof OutboundHttpError && [error.phase, error.reason]).toEqual(["after_send", "aborted"]);
  });

  it("gives up on a stream idle longer than LLM_STREAM_IDLE_TIMEOUT_MS as an unknown outcome and closes it", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ chunks: [anthropicFixture("truncated.sse")], stall: true });
    const pending = failure(collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart })));
    await vi.advanceTimersByTimeAsync(LLM_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(http.requests[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(isAmberError(error) && error.appError.class).toBe("llm_outcome_unknown");
    expect(http.requests[0]?.signal.aborted).toBe(true);
  });
});

describe("AnthropicMessagesProvider.stream output watchdog", () => {
  const event = (payload: Record<string, unknown>): string => `event: ${String(payload["type"])}\ndata: ${JSON.stringify(payload)}\n\n`;
  const start = event({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } });
  const ping = event({ type: "ping" });
  const text = (value: string): string => event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: value } });
  const thinking = (value: string): string => event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: value } });
  const finish = [
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    event({ type: "message_stop" }),
  ];
  const wait = (waitMs: number): Wait => ({ waitMs });
  const every = (count: number, waitMs: number, piece: string): Array<string | Wait> =>
    Array.from({ length: count }, () => [wait(waitMs), piece]).flat();
  const streamOf = (http: ScriptedHttp, signal = new AbortController().signal, cap = capability()) =>
    provider(http).stream(EQUIVALENT_REQUEST, { signal, effectiveCapability: cap, profile: PROFILE, onRequestStart: ignoreStart });

  async function settle<T>(promise: Promise<T>, advanceMs: number): Promise<T> {
    await vi.advanceTimersByTimeAsync(advanceMs);
    return promise;
  }

  it("waits for a model that stays silent past the stream idle limit after message_start", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ chunks: [start, wait(4 * 60_000), text("答"), ...finish] });
    const events = await settle(collect(streamOf(http)), 4 * 60_000 + 1);
    expect(textOf(events)).toBe("答");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  it("counts thinking deltas as output, so a long visible thinking phase completes", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ chunks: [start, ...every(8, 50_000, thinking("想")), text("答"), ...finish] });
    const events = await settle(collect(streamOf(http)), 8 * 50_000 + 1);
    expect(textOf(events)).toBe("答");
  });

  it("does not let pings or empty thinking before any output extend LLM_FIRST_OUTPUT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ chunks: [start, ...every(10, 30_000, ping), ...every(10, 30_000, thinking(""))], stall: true });
    const pending = failure(collect(streamOf(http)));
    await vi.advanceTimersByTimeAsync(LLM_FIRST_OUTPUT_TIMEOUT_MS - 1);
    expect(http.requests[0]?.signal.aborted).toBe(false);
    const error = await settle(pending, 1);
    expect(isAmberError(error) && error.appError.class).toBe("llm_outcome_unknown");
  });

  it("does not let pings after the answer started reset LLM_STREAM_IDLE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ chunks: [start, text("a"), ...every(10, 20_000, ping)], stall: true });
    const pending = failure(collect(streamOf(http)));
    await vi.advanceTimersByTimeAsync(LLM_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(http.requests[0]?.signal.aborted).toBe(false);
    const error = await settle(pending, 1);
    expect(isAmberError(error) && error.appError.class).toBe("llm_outcome_unknown");
  });

  it("does not count the time the consumer holds a delivered delta", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ chunks: [start, text("a"), text("b"), text("c"), ...finish] });
    const iterator = streamOf(http)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "a" });
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "b" });
    await vi.advanceTimersByTimeAsync(3 * LLM_STREAM_IDLE_TIMEOUT_MS);
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "c" });
    expect(http.requests[0]?.signal.aborted).toBe(false);
  });

  it("classifies a request whose headers never arrive by its send boundary", async () => {
    vi.useFakeTimers();
    const notSent = failure(collect(streamOf(new ScriptedHttp({ noHeaders: "before_send" }))));
    const safe = await settle(notSent, LLM_FIRST_OUTPUT_TIMEOUT_MS);
    expect(isAmberError(safe) && safe.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.unreachable", retryDisposition: "safe" });

    const notAnswered = failure(collect(streamOf(new ScriptedHttp({ noHeaders: "after_send" }))));
    const unknown = await settle(notAnswered, LLM_FIRST_OUTPUT_TIMEOUT_MS);
    expect(isAmberError(unknown) && unknown.appError).toMatchObject({ class: "llm_outcome_unknown", retryDisposition: "outcome_unknown" });
  });

  it("bounds a non-streaming answer by LLM_FIRST_OUTPUT_TIMEOUT_MS as a whole", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ chunks: [], stall: true });
    const pending = failure(collect(streamOf(http, new AbortController().signal, capability({ flags: { stream: "unsupported" } }))));
    await vi.advanceTimersByTimeAsync(LLM_FIRST_OUTPUT_TIMEOUT_MS - 1);
    expect(http.requests[0]?.signal.aborted).toBe(false);
    const error = await settle(pending, 1);
    expect(isAmberError(error) && error.appError.class).toBe("llm_outcome_unknown");
  });

  it("leaves no timer behind once the answer is done or the caller cancels", async () => {
    vi.useFakeTimers();
    await collect(streamOf(new ScriptedHttp({ chunks: [start, text("a"), ...finish] })));
    expect(vi.getTimerCount()).toBe(0);

    const controller = new AbortController();
    const pending = failure(collect(streamOf(new ScriptedHttp({ chunks: [start, text("a")], stall: true }), controller.signal)));
    await vi.advanceTimersByTimeAsync(LLM_STREAM_IDLE_TIMEOUT_MS - 1);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("AnthropicMessagesProvider.probe", () => {
  const run = (check: LlmProbeCheck, signal = new AbortController().signal) => {
    const calls: LlmProbeCall[] = [];
    return { calls, result: check.run({ signal, onRequestStart: ignoreStart, onCall: (call) => calls.push(call) }) };
  };
  const okJson = JSON.stringify({ type: "message", content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 5 } });

  it("returns the stream, JSON and tools checks without sending anything yet", () => {
    const http = new ScriptedHttp();
    const checks = provider(http).probe(PROFILE, "model-under-test");
    expect(checks.map((check) => check.flag)).toEqual(["stream", "structuredOutput", "tools"]);
    expect(http.requests).toHaveLength(0);
  });

  const toolUse = JSON.stringify({
    type: "message",
    content: [{ type: "tool_use", id: "t1", name: "report_status", input: { ok: true } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 290, output_tokens: 16 },
  });

  it("sends one minimal request per check and reports each call once with its usage", async () => {
    let clock = 1_000;
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] }, { chunks: [okJson] }, { chunks: [toolUse] });
    const checks = provider(http, () => (clock += 25)).probe(PROFILE, "model-under-test");
    for (const check of checks) {
      const { calls, result } = run(check);
      // The counting clock is also read once for the request-start report, between the two latency readings.
      expect(await result).toEqual({ result: "supported", latencyMs: 50 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.outcome).toBe("succeeded");
      expect(calls[0]?.usage?.outputTokens).toBeGreaterThan(0);
    }
    expect(http.requests.map((request) => request.timeoutMs)).toEqual([LLM_PROBE_TIMEOUT_MS, LLM_PROBE_TIMEOUT_MS, LLM_PROBE_TIMEOUT_MS]);
    const [stream, json, tools] = http.bodies;
    expect(http.bodies.map((body) => body["max_tokens"])).toEqual([LLM_PROBE_MAX_OUTPUT_TOKENS, LLM_PROBE_MAX_OUTPUT_TOKENS, LLM_PROBE_MAX_OUTPUT_TOKENS]);
    expect(stream).toMatchObject({ model: "model-under-test", stream: true });
    expect(json).toMatchObject({ output_config: { format: { type: "json_schema" } } });
    expect(Object.hasOwn(json ?? {}, "stream") || Object.hasOwn(tools ?? {}, "stream")).toBe(false);
    expect(tools).toMatchObject({ tools: [{ name: "report_status" }] });
    // Tool use is requested in the prompt, never forced: several models reject a forced choice.
    expect(Object.hasOwn(tools ?? {}, "tool_choice")).toBe(false);
    expect(JSON.stringify(json?.["messages"])).not.toMatch(/json|ok"/i);
    expect(Object.hasOwn(stream ?? {}, "tools") || Object.hasOwn(stream ?? {}, "output_config")).toBe(false);
  });

  it("records unsupported when a 200 answer shows the output format or the tools were silently ignored", async () => {
    // DeepSeek's Anthropic endpoint accepts `output_config` but only honours `effort`.
    const plain = JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 34, output_tokens: 2 } });
    const http = new ScriptedHttp({ chunks: [plain] }, { chunks: [plain] });
    const [, json, tools] = provider(http).probe(PROFILE, "model-under-test");
    for (const check of [json!, tools!]) {
      const { calls, result } = run(check);
      expect((await result) as { result: string }).toMatchObject({ result: "unsupported" });
      expect(calls).toEqual([expect.objectContaining({ outcome: "succeeded" })]);
    }
  });

  it("records unsupported only when the upstream explicitly rejects the probed feature", async () => {
    const http = new ScriptedHttp(errorAnswer("unsupported_output_config"), errorAnswer("unsupported_tools"), errorAnswer("unsupported_tools"));
    const [stream, json, tools] = provider(http).probe(PROFILE, "model-under-test");
    const jsonRun = run(json!);
    expect((await jsonRun.result) as { result: string }).toMatchObject({ result: "unsupported" });
    expect(jsonRun.calls).toEqual([{ outcome: "failed" }]);
    const toolsRun = run(tools!);
    expect((await toolsRun.result) as { result: string }).toMatchObject({ result: "unsupported" });
    // A rejection naming another feature proves nothing about streaming.
    const streamRun = run(stream!);
    const error = await failure(streamRun.result);
    expect(isAmberError(error) && error.appError.code).toBe("llm_failed.invalid_request");
    expect(streamRun.calls).toEqual([{ outcome: "failed" }]);
  });

  it("classifies a probe's limit answer with its retry-after header", async () => {
    const { status, body } = anthropicError("overloaded");
    const http = new ScriptedHttp({ status, headers: { "retry-after": "5" }, chunks: [body] });
    const { calls, result } = run(provider(http).probe(PROFILE, "model-under-test")[1]!);
    const error = await failure(result);
    expect(isAmberError(error) && error.appError).toMatchObject({ code: "llm_failed.overloaded", retryDisposition: "policy", details: { retryAfterMs: 5000 } });
    expect(calls).toEqual([{ outcome: "failed" }]);
  });

  it("throws other failures as probe errors and still reports the call", async () => {
    for (const [name, code] of [
      ["authentication", "llm_failed.auth"],
      ["payment", "llm_failed.quota"],
      ["not_found", "llm_failed.model_not_found"],
      ["server", "llm_failed"],
    ] as const) {
      const http = new ScriptedHttp(errorAnswer(name));
      const { calls, result } = run(provider(http).probe(PROFILE, "model-under-test")[1]!);
      const error = await failure(result);
      expect(isAmberError(error) && error.appError.code, name).toBe(code);
      expect(calls).toEqual([{ outcome: "failed" }]);
    }
  });

  it("reports nothing for a failure before the send boundary and an unknown outcome after it", async () => {
    const before = run(provider(new ScriptedHttp(new OutboundHttpError("before_send", "network"))).probe(PROFILE, "m")[0]!);
    const beforeError = await failure(before.result);
    expect(isAmberError(beforeError) && beforeError.appError.code).toBe("llm_failed.unreachable");
    expect(before.calls).toEqual([]);

    const after = run(provider(new ScriptedHttp(new OutboundHttpError("after_send", "network"))).probe(PROFILE, "m")[0]!);
    const afterError = await failure(after.result);
    expect(isAmberError(afterError) && afterError.appError.class).toBe("llm_outcome_unknown");
    expect(after.calls).toEqual([{ outcome: "outcome_unknown" }]);

    const truncated = run(provider(new ScriptedHttp({ chunks: [anthropicFixture("truncated.sse")] })).probe(PROFILE, "m")[0]!);
    await failure(truncated.result);
    expect(truncated.calls).toEqual([{ outcome: "outcome_unknown" }]);
  });

  it("follows the send boundary on cancellation: nothing before it, outcome_unknown after it", async () => {
    const early = new AbortController();
    early.abort();
    const before = run(provider(new ScriptedHttp(new OutboundHttpError("before_send", "aborted"))).probe(PROFILE, "m")[1]!, early.signal);
    const beforeError = await failure(before.result);
    expect(beforeError instanceof OutboundHttpError && beforeError.phase).toBe("before_send");
    expect(before.calls).toEqual([]);

    const late = new AbortController();
    const http = new ScriptedHttp({ chunks: ['event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n'], stall: true });
    const after = run(provider(http).probe(PROFILE, "m")[0]!, late.signal);
    setTimeout(() => late.abort(), 5);
    const afterError = await failure(after.result);
    expect(afterError instanceof OutboundHttpError && afterError.phase).toBe("after_send");
    expect(after.calls).toEqual([{ outcome: "outcome_unknown" }]);
  });

  it("does not report a request that never started because the profile has no key", async () => {
    const http = new ScriptedHttp();
    const { credentialRef: _dropped, ...withoutKey } = PROFILE;
    const { calls, result } = run(provider(http).probe(withoutKey, "m")[0]!);
    const error = await failure(result);
    expect(isAmberError(error) && error.appError.class).toBe("llm_unconfigured");
    expect(calls).toEqual([]);
    expect(http.requests).toHaveLength(0);
  });
});

describe("AnthropicMessagesProvider.probe stream errors", () => {
  it("fails the stream check on an error event inside the stream and reports the call as failed", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("in-stream-error.sse")] });
    const calls: LlmProbeCall[] = [];
    const [stream] = provider(http).probe(PROFILE, "m");
    const error = await failure(stream!.run({ signal: new AbortController().signal, onRequestStart: ignoreStart, onCall: (call) => calls.push(call) }));
    expect(isAmberError(error) && [error.appError.code, error.appError.upstreamMessage]).toEqual(["llm_failed", "overloaded_error: Overloaded"]);
    expect(calls).toEqual([{ outcome: "failed" }]);
  });
});

describe("AnthropicMessagesProvider safety refusals", () => {
  const sse = (...events: object[]): string => events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 3479, output_tokens: 0 } } };
  const cyber = { type: "refusal", category: "cyber", explanation: "This request was declined because it could enable cyber harm." };
  const refusal = (stopDetails: unknown) => ({ type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: 0 } });
  const stop = { type: "message_stop" };
  const options = (flags?: Partial<CapabilityFlags>) => ({ signal: new AbortController().signal, effectiveCapability: capability(flags === undefined ? {} : { flags }), profile: PROFILE, onRequestStart: ignoreStart });

  it("normalizes a refusal before any output to done(refused) with its category and explanation, after the usage", async () => {
    const http = new ScriptedHttp({ chunks: [sse(start, refusal(cyber), stop)] });
    const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, options()));
    expectInvariant(events);
    expect(events.map((event) => event.type)).toEqual(["usage", "done"]);
    expect(events[0]?.type === "usage" && events[0].usage).toMatchObject({ inputTokens: 3479, outputTokens: 0 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "refused", raw: "refusal: cyber — This request was declined because it could enable cyber harm." });
  });

  it("reports a mid-stream refusal whose details are null as refused, after the partial text", async () => {
    const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "部分" } };
    const http = new ScriptedHttp({ chunks: [sse(start, delta, refusal(null), stop)] });
    const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, options()));
    expect(textOf(events)).toBe("部分");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "refused", raw: "refusal: unspecified" });
  });

  it("reads the refusal of a whole answer the same way", async () => {
    const body = JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: "refusal", stop_details: { ...cyber, explanation: null }, usage: { input_tokens: 10, output_tokens: 0 } });
    const http = new ScriptedHttp({ chunks: [body] });
    const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, options({ stream: "unsupported" })));
    expect(events.map((event) => event.type)).toEqual(["usage", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "refused", raw: "refusal: cyber" });
  });

  it("fails a probe check the model refused as llm_failed.refused and reports the call as failed", async () => {
    const http = new ScriptedHttp({ chunks: [sse(start, refusal(cyber), stop)] });
    const calls: LlmProbeCall[] = [];
    const [stream] = provider(http).probe(PROFILE, "m");
    const error = await failure(stream!.run({ signal: new AbortController().signal, onRequestStart: ignoreStart, onCall: (call) => calls.push(call) }));
    expect(isAmberError(error) && [error.appError.code, error.appError.retryDisposition, error.appError.upstreamMessage]).toEqual([
      "llm_failed.refused",
      "never",
      `refusal: cyber — ${cyber.explanation}`,
    ]);
    expect(calls.map((call) => call.outcome)).toEqual(["failed"]);
  });
});

const sse = (...events: Array<[string, unknown]>): string => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** A complete answer whose usage the two usage-bearing events carry as given. */
const answerWithUsage = (start: Record<string, unknown>, delta: Record<string, unknown>): string =>
  sse(
    ["message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: start } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: delta }],
    ["message_stop", { type: "message_stop" }],
  );

async function usageOf(body: string) {
  const http = new ScriptedHttp({ chunks: [body] });
  const events = await collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: ignoreStart }));
  const usage = events.find((event) => event.type === "usage");
  return usage?.type === "usage" ? usage.usage : undefined;
}

describe("AnthropicMessagesProvider one-hour cache writes", () => {
  it("reads the one-hour share of cache writes and keeps the total as cacheWriteTokens", async () => {
    const usage = await usageOf(
      answerWithUsage(
        { input_tokens: 0, output_tokens: 1 },
        { input_tokens: 12, output_tokens: 64, cache_read_input_tokens: 2048, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } },
      ),
    );
    expect(usage).toMatchObject({ inputTokens: 12 + 2048 + 300, outputTokens: 64, cacheReadTokens: 2048, cacheWriteTokens: 300, cacheWrite1hTokens: 200 });
    expect(JSON.parse(usage?.rawJson as string)).toMatchObject({ cache_creation: { ephemeral_1h_input_tokens: 200 } });
  });

  it("merges the breakdown like the other usage fields: the later event wins, an earlier one stays when the later has none", async () => {
    const overridden = await usageOf(
      answerWithUsage(
        { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 } },
        { input_tokens: 12, output_tokens: 64, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } },
      ),
    );
    expect(overridden).toMatchObject({ cacheWriteTokens: 300, cacheWrite1hTokens: 200 });
    const kept = await usageOf(
      answerWithUsage(
        { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 80, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 80 } },
        { output_tokens: 64 },
      ),
    );
    expect(kept).toMatchObject({ outputTokens: 64, cacheWriteTokens: 80, cacheWrite1hTokens: 80 });
  });

  it("leaves it absent when the upstream does not break cache writes down, and ignores a malformed breakdown", async () => {
    const plain = await usageOf(answerWithUsage({ input_tokens: 5, output_tokens: 1 }, { output_tokens: 9, cache_creation_input_tokens: 100 }));
    expect(plain).toMatchObject({ cacheWriteTokens: 100 });
    expect(plain).not.toHaveProperty("cacheWrite1hTokens");
    for (const breakdown of [{ ephemeral_1h_input_tokens: "200" }, { ephemeral_1h_input_tokens: -1 }, { ephemeral_5m_input_tokens: 100 }, "x"]) {
      const odd = await usageOf(answerWithUsage({ input_tokens: 5, output_tokens: 1 }, { output_tokens: 9, cache_creation_input_tokens: 100, cache_creation: breakdown }));
      expect(odd).not.toHaveProperty("cacheWrite1hTokens");
    }
  });

  it("reads it from a whole answer too", async () => {
    const http = new ScriptedHttp({
      chunks: [
        JSON.stringify({
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } },
        }),
      ],
    });
    const events = await collect(
      provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability({ flags: { stream: "unsupported" } }), profile: PROFILE, onRequestStart: ignoreStart }),
    );
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({ cacheWriteTokens: 30, cacheWrite1hTokens: 20 });
  });
});

describe("AnthropicMessagesProvider request start", () => {
  /** A store whose key and version change at every reveal, so a second reveal would show in the request. */
  function rotating(log: string[], http: ScriptedHttp): AnthropicMessagesProvider {
    let reveals = 0;
    const original = http.request.bind(http);
    http.request = (request) => {
      log.push(`send ${String(request.headers?.["x-api-key"])}`);
      return original(request);
    };
    return new AnthropicMessagesProvider({
      http,
      secrets: {
        revealVersioned: () => {
          reveals += 1;
          log.push(`reveal ${reveals}`);
          return { plaintext: `key-${reveals}`, version: { versionId: `version-${reveals}`, setAt: reveals * 10 } };
        },
      },
      now: () => 9_000,
    });
  }
  const run = (target: AnthropicMessagesProvider, onRequestStart: (info: RequestStartInfo) => void) =>
    collect(target.stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart }));

  it("reports each request once, between the reveal and the send, with the version of the key that is sent", async () => {
    const log: string[] = [];
    const infos: RequestStartInfo[] = [];
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] }, { chunks: [anthropicFixture("equivalent.sse")] });
    const target = rotating(log, http);
    const record = (info: RequestStartInfo): void => {
      infos.push(info);
      log.push("started");
    };
    await run(target, record);
    await run(target, record);
    expect(log).toEqual(["reveal 1", "started", "send key-1", "reveal 2", "started", "send key-2"]);
    expect(infos).toEqual([
      { sentAt: 9_000, credential: { versionId: "version-1", setAt: 10 } },
      { sentAt: 9_000, credential: { versionId: "version-2", setAt: 20 } },
    ]);
  });

  it("does not report when the request cannot be built or there is no key, and sends nothing when the callback throws", async () => {
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] });
    const infos: RequestStartInfo[] = [];
    const audio: LlmRequest = { ...EQUIVALENT_REQUEST, messages: [{ role: "user", content: [{ type: "audio", mimeType: "audio/wav", dataRef: "tmp/a.wav" }] }] };
    await failure(collect(provider(http).stream(audio, { signal: new AbortController().signal, effectiveCapability: capability(), profile: PROFILE, onRequestStart: (info) => infos.push(info) })));
    const unconfigured = await failure(
      collect(provider(http).stream(EQUIVALENT_REQUEST, { signal: new AbortController().signal, effectiveCapability: capability(), profile: { ...PROFILE, credentialRef: undefined as never }, onRequestStart: (info) => infos.push(info) })),
    );
    expect(isAmberError(unconfigured) && unconfigured.appError.class).toBe("llm_unconfigured");
    expect(infos).toEqual([]);

    const refusal = new Error("do not send");
    const thrown = await failure(
      run(provider(http), () => {
        throw refusal;
      }),
    );
    expect(thrown).toBe(refusal);
    expect(http.requests).toEqual([]);
  });

  it("reports every probe request, and nothing is sent when the callback throws", async () => {
    const log: string[] = [];
    const http = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] }, { status: 500, chunks: ["{}"] }, { status: 500, chunks: ["{}"] });
    const checks = rotating(log, http).probe(PROFILE, "model-under-test");
    const infos: RequestStartInfo[] = [];
    for (const check of checks) {
      await check.run({ signal: new AbortController().signal, onRequestStart: (info) => infos.push(info), onCall: () => undefined }).catch(() => undefined);
    }
    expect(infos.map((info) => info.credential.versionId)).toEqual(["version-1", "version-2", "version-3"]);
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual(["send key-1", "send key-2", "send key-3"]);

    const refused = new ScriptedHttp({ chunks: [anthropicFixture("equivalent.sse")] });
    const calls: LlmProbeCall[] = [];
    const refusal = new Error("do not send");
    const thrown = await failure(
      (provider(refused).probe(PROFILE, "model-under-test")[0] as LlmProbeCheck).run({
        signal: new AbortController().signal,
        onRequestStart: () => {
          throw refusal;
        },
        onCall: (call) => calls.push(call),
      }),
    );
    expect(thrown).toBe(refusal);
    expect(refused.requests).toEqual([]);
    expect(calls).toEqual([]);
  });
});
