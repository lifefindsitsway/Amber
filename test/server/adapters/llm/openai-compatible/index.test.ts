import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../../../../../src/server/adapters/llm/openai-compatible/index.ts";
import { AmberError, amberError, isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../../src/server/domain/llm.ts";
import type { CapabilityFlags, ModelCapability, ProviderProfile } from "../../../../../src/server/domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../../../src/server/domain/usage.ts";
import type { LlmProbeCall, LlmProbeCheck, LlmProbeResult } from "../../../../../src/server/ports/llm-provider.ts";
import { OutboundHttpError, type OutboundRequest, type OutboundResponse } from "../../../../../src/server/ports/outbound-http.ts";
import {
  LLM_FIRST_OUTPUT_TIMEOUT_MS,
  LLM_PROBE_MAX_OUTPUT_TOKENS,
  LLM_STREAM_IDLE_TIMEOUT_MS,
  LLM_TOKEN_PARAM_CACHE_MAX,
} from "../../../../../src/shared/defaults.ts";
import { EQUIVALENT_GOLDEN, EQUIVALENT_REQUEST } from "../../../../fixtures/llm/equivalent.ts";
import { openAiCompletion, openAiError, openAiStream } from "../../../../fixtures/llm/openai-compatible/index.ts";

const API_KEY = "<openai-compatible-test-key>";
const PROFILE: ProviderProfile = {
  id: "profile-under-test",
  userId: "user-1",
  name: "Relay",
  protocol: "openai_compatible",
  baseURL: "https://relay.example.invalid/v1",
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

function capability(override: Partial<CapabilityFlags> = {}): ModelCapability {
  return {
    modelId: "model-under-test",
    flags: { declared: UNKNOWN_FLAGS, userOverride: override },
    limits: { declared: {}, userOverride: { contextWindowTokens: 128_000 } },
  };
}

/** A pause inside a scripted body; aborting the request ends it as the transport would. */
type Wait = { waitMs: number };

type Answer =
  | {
      status?: number;
      headers?: Readonly<Record<string, string>>;
      body?: string | Array<string | Wait>;
      bodyError?: Error;
      hang?: boolean;
      /** Response headers never arrive; an abort fails the request in this phase. */
      noHeaders?: "before_send" | "after_send";
    }
  | Error;

function abortable(signal: AbortSignal, ms?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new OutboundHttpError("after_send", "aborted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    if (ms !== undefined) {
      setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
    }
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
        if (typeof piece === "string") {
          yield new TextEncoder().encode(piece);
        } else {
          await abortable(signal, piece.waitMs);
        }
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

function setup(http: ScriptedHttp, files: Record<string, Uint8Array> = {}) {
  const revealed: string[] = [];
  const provider = new OpenAiCompatibleProvider({
    http,
    secrets: {
      revealVersioned: (_owner, ref) => {
        revealed.push(ref);
        return { plaintext: API_KEY, version: KEY_VERSION };
      },
    },
    files: {
      read: (ref) =>
        (async function* () {
          const bytes = files[ref];
          if (bytes === undefined) {
            throw new Error(`no file ${ref}`);
          }
          yield bytes;
        })(),
    },
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
const KEY_VERSION = { versionId: "version-1", setAt: 1_700_000_000_000 };
const noStartReport = (): void => undefined;
const streamOf = (
  provider: OpenAiCompatibleProvider,
  request: LlmRequest = EQUIVALENT_REQUEST,
  cap = capability(),
  signal = live(),
  onRequestStart: (info: RequestStartInfo) => void = noStartReport,
) => provider.stream(request, { signal, effectiveCapability: cap, profile: PROFILE, onRequestStart });

/** Splits text into fixed-size pieces so SSE events straddle chunk boundaries. */
function sliced(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    pieces.push(text.slice(offset, offset + size));
  }
  return pieces;
}

describe("OpenAiCompatibleProvider.stream", () => {
  it("normalizes the equivalent fixture to the golden completion, whatever the chunking", async () => {
    for (const size of [7, 64, 100_000]) {
      const http = new ScriptedHttp({ body: sliced(openAiStream("equivalent"), size) });
      const { provider } = setup(http);
      const result = await events(streamOf(provider));
      const deltas = result.filter((event) => event.type === "text_delta");
      expect(deltas.map((event) => event.delta).join("")).toBe(EQUIVALENT_GOLDEN.text);
      expect(result.slice(-2)).toEqual([
        { type: "usage", usage: { ...EQUIVALENT_GOLDEN.usage, rawJson: '{"prompt_tokens":42,"completion_tokens":23,"total_tokens":65}' } },
        { type: "done", stopReason: EQUIVALENT_GOLDEN.stopReason, raw: "stop" },
      ]);
      expect(result.slice(0, -2).every((event) => event.type === "text_delta")).toBe(true);
    }
  });

  it("reads cached and reasoning breakdowns, keeps the raw usage and maps length", async () => {
    const { provider } = setup(new ScriptedHttp({ body: openAiStream("regression") }));
    const result = await events(streamOf(provider));
    expect(result.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual(["Hello", ", world", "."]);
    const usage = result.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ usage: { inputTokens: 1200, outputTokens: 64, cacheReadTokens: 1024, reasoningTokens: 48 } });
    expect(JSON.parse((usage as { usage: { rawJson: string } }).usage.rawJson)).toMatchObject({ prompt_tokens_details: { cached_tokens: 1024 } });
    expect(result.at(-1)).toEqual({ type: "done", stopReason: "length", raw: "length" });
  });

  it("parses the recorded relay answer: text, stop and no usage event", async () => {
    const { provider } = setup(new ScriptedHttp({ body: openAiStream("recorded") }));
    expect(await events(streamOf(provider))).toEqual([
      { type: "text_delta", delta: "OK" },
      { type: "done", stopReason: "stop", raw: "stop" },
    ]);
  });

  it("emits no usage event when the upstream reports none", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const { provider } = setup(new ScriptedHttp({ body }));
    expect(await events(streamOf(provider))).toEqual([
      { type: "text_delta", delta: "hi" },
      { type: "done", stopReason: "stop", raw: "stop" },
    ]);
  });

  it("ends with done(error) when the upstream reports an error inside the stream", async () => {
    const error = openAiError("inStream").body;
    const body = `data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}\n\ndata: ${error}\n\n`;
    const { provider } = setup(new ScriptedHttp({ body }));
    const result = await events(streamOf(provider));
    expect(result).toEqual([
      { type: "text_delta", delta: "par" },
      { type: "done", stopReason: "error", raw: "server_error: The server had an error while processing your request." },
    ]);
  });

  it("maps a content_filter finish to done(refused), streamed or whole", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"par"},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n';
    const streamed = setup(new ScriptedHttp({ body }));
    expect(await events(streamOf(streamed.provider))).toEqual([
      { type: "text_delta", delta: "par" },
      { type: "done", stopReason: "refused", raw: "content_filter" },
    ]);
    const whole = setup(new ScriptedHttp({ body: JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] }) }));
    expect(await events(streamOf(whole.provider, EQUIVALENT_REQUEST, capability({ stream: "unsupported" })))).toEqual([
      { type: "done", stopReason: "refused", raw: "content_filter" },
    ]);
  });

  it("treats a stream that stops before finishing as an unknown outcome", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}\n\n';
    const { provider } = setup(new ScriptedHttp({ body }));
    const error = (await failure(events(streamOf(provider)))) as AmberError;
    expect(error.appError).toMatchObject({ class: "llm_outcome_unknown", retryDisposition: "outcome_unknown" });
  });

  it("treats a malformed chunk as an upstream failure", async () => {
    const { provider } = setup(new ScriptedHttp({ body: "data: {not json\n\n" }));
    const error = (await failure(events(streamOf(provider)))) as AmberError;
    expect(error.appError.class).toBe("llm_failed");
  });

  it("sends a minimal streaming request with the key only in the authorization header", async () => {
    const http = new ScriptedHttp({ body: openAiStream("equivalent") });
    const { provider, revealed } = setup(http);
    await events(streamOf(provider));
    const [request] = http.requests;
    expect(request?.url).toBe("https://relay.example.invalid/v1/chat/completions");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ authorization: `Bearer ${API_KEY}`, "content-type": "application/json" });
    // The output watchdog bounds the wait for headers too; no transport-level timeout.
    expect(request?.timeoutMs).toBeUndefined();
    expect(request?.url).not.toContain(API_KEY);
    expect(revealed).toEqual(["secret-1"]);
    expect(http.bodies[0]).toEqual({
      model: "model-under-test",
      messages: [
        { role: "system", content: "You are a concise assistant." },
        { role: "user", content: "用一句话介绍 Amber。" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("leaves unset optional parameters out of the body instead of sending null", async () => {
    const http = new ScriptedHttp({ body: openAiStream("equivalent") }, { body: openAiStream("equivalent") });
    const { provider } = setup(http);
    await events(streamOf(provider));
    await events(
      streamOf(provider, {
        ...EQUIVALENT_REQUEST,
        maxOutputTokens: 512,
        optional: { temperature: 0.2 },
        responseFormat: { type: "json_schema", schema: { type: "object" } },
      }),
    );
    const [plain, full] = http.bodies;
    for (const key of ["temperature", "max_tokens", "max_completion_tokens", "response_format", "top_p", "tools"]) {
      expect(plain).not.toHaveProperty(key);
    }
    expect(Object.values(plain ?? {})).not.toContain(null);
    expect(full).toMatchObject({
      max_tokens: 512,
      temperature: 0.2,
      response_format: { type: "json_schema", json_schema: { name: "output", schema: { type: "object" }, strict: true } },
    });
  });

  it("encodes audio parts as input_audio and multi-part content as an array", async () => {
    const http = new ScriptedHttp({ body: openAiStream("equivalent") });
    const { provider } = setup(http, { "tmp/tasks/t/clip.wav": new Uint8Array([1, 2, 3]) });
    expect(provider.audioMimeTypes).toEqual(["audio/mpeg", "audio/wav"]);
    await events(
      streamOf(provider, {
        ...EQUIVALENT_REQUEST,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe:" },
              { type: "audio", mimeType: "audio/wav", dataRef: "tmp/tasks/t/clip.wav" },
            ],
          },
        ],
      }),
    );
    expect(http.bodies[0]?.["messages"]).toEqual([
      { role: "system", content: "You are a concise assistant." },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe:" },
          { type: "input_audio", input_audio: { data: "AQID", format: "wav" } },
        ],
      },
    ]);
  });

  it("refuses an audio format it cannot encode before sending anything", async () => {
    const http = new ScriptedHttp();
    const { provider } = setup(http);
    const request: LlmRequest = {
      ...EQUIVALENT_REQUEST,
      messages: [{ role: "user", content: [{ type: "audio", mimeType: "audio/flac", dataRef: "x" }] }],
    };
    const error = (await failure(events(streamOf(provider, request)))) as AmberError;
    expect(error.appError.class).toBe("llm_capability");
    expect(http.requests).toHaveLength(0);
  });

  it("falls back to one plain request when streaming is known unsupported", async () => {
    const http = new ScriptedHttp({ body: openAiCompletion() });
    const { provider } = setup(http);
    const result = await events(streamOf(provider, EQUIVALENT_REQUEST, capability({ stream: "unsupported" })));
    expect(http.bodies[0]).toMatchObject({ stream: false });
    expect(http.bodies[0]).not.toHaveProperty("stream_options");
    expect(http.requests[0]).not.toHaveProperty("timeoutMs");
    expect(result).toEqual([
      { type: "text_delta", delta: EQUIVALENT_GOLDEN.text },
      { type: "usage", usage: expect.objectContaining({ ...EQUIVALENT_GOLDEN.usage, cacheReadTokens: 0 }) },
      { type: "done", stopReason: "stop", raw: "stop" },
    ]);
  });

  it.each([
    ["auth", "llm_failed", "llm_failed.auth", "never"],
    ["forbidden", "llm_failed", "llm_failed.auth", "never"],
    ["insufficientBalance", "llm_failed", "llm_failed.quota", "never"],
    ["insufficientQuota", "llm_failed", "llm_failed.quota", "never"],
    ["relayQuota", "llm_failed", "llm_failed.quota", "never"],
    ["contextLength", "llm_capability", "llm_capability.context_length", "never"],
    ["modelNotFound", "llm_failed", "llm_failed.model_not_found", "never"],
    ["rateLimited", "llm_rate_limited", "llm_rate_limited", "policy"],
    ["serverError", "llm_failed", "llm_failed", "policy"],
    ["badRequest", "llm_failed", "llm_failed.invalid_request", "never"],
    ["maxTokensRejected", "llm_failed", "llm_failed.invalid_request", "never"],
  ])("maps the %s answer to %s / %s (%s)", async (name, errorClass, code, disposition) => {
    const answer = openAiError(name);
    const { provider } = setup(new ScriptedHttp({ status: answer.status, body: answer.body }));
    const error = (await failure(events(streamOf(provider)))) as AmberError;
    expect(isAmberError(error)).toBe(true);
    expect(error.appError).toMatchObject({ class: errorClass, code, retryDisposition: disposition });
    expect(error.appError.upstreamMessage?.length).toBeGreaterThan(0);
    expect(JSON.stringify(error.appError)).not.toContain(API_KEY);
    expect(error.message).not.toContain(API_KEY);
  });

  it("reads retry-after from the response headers and tells a bare 429 apart from a rate limit", async () => {
    const { provider } = setup(new ScriptedHttp({ status: 429, headers: { "retry-after": "7" }, body: "" }, { status: 429, body: "" }));
    const timed = (await failure(events(streamOf(provider)))) as AmberError;
    expect(timed.appError).toMatchObject({ class: "llm_rate_limited", code: "llm_rate_limited.retry_after", retryDisposition: "policy", details: { retryAfterMs: 7000 } });
    expect(timed.message).toContain("evidence=retry_after");
    const bare = (await failure(events(streamOf(provider)))) as AmberError;
    expect(bare.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.limit_ambiguous", retryDisposition: "never" });
  });

  it("classifies transport failures by the send boundary", async () => {
    const before = setup(new ScriptedHttp(new OutboundHttpError("before_send", "network"))).provider;
    expect(((await failure(events(streamOf(before)))) as AmberError).appError).toMatchObject({ code: "llm_failed.unreachable", retryDisposition: "safe" });
    const after = setup(new ScriptedHttp(new OutboundHttpError("after_send", "timeout"))).provider;
    expect(((await failure(events(streamOf(after)))) as AmberError).appError.class).toBe("llm_outcome_unknown");
    const broken = setup(new ScriptedHttp({ body: ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], bodyError: new OutboundHttpError("after_send", "network") })).provider;
    expect(((await failure(events(streamOf(broken)))) as AmberError).appError.class).toBe("llm_outcome_unknown");
  });

  it("passes the caller's cancellation through with its phase", async () => {
    const controller = new AbortController();
    const http = new ScriptedHttp({ body: ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], hang: true });
    const { provider } = setup(http);
    const iterator = streamOf(provider, EQUIVALENT_REQUEST, capability(), controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "a" });
    const pending = iterator.next();
    controller.abort();
    const error = await failure(pending);
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect((error as OutboundHttpError).phase).toBe("after_send");
  });

  it("gives up on an idle stream as an unknown outcome and aborts the request", async () => {
    vi.useFakeTimers();
    try {
      const http = new ScriptedHttp({ body: ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], hang: true });
      const { provider } = setup(http);
      const pending = failure(events(streamOf(provider)));
      await vi.advanceTimersByTimeAsync(LLM_STREAM_IDLE_TIMEOUT_MS + 1);
      const error = (await pending) as AmberError;
      expect(error.appError.class).toBe("llm_outcome_unknown");
      expect(http.requests[0]?.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenAiCompatibleProvider.stream output watchdog", () => {
  const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  const text = (content: string): string => sse({ choices: [{ delta: { content } }] });
  const reasoning = (content: string): string => sse({ choices: [{ delta: { reasoning_content: content } }] });
  const finish = [sse({ choices: [{ delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"];
  const wait = (waitMs: number): Wait => ({ waitMs });
  const every = (count: number, waitMs: number, piece: string): Array<string | Wait> =>
    Array.from({ length: count }, () => [wait(waitMs), piece]).flat();

  async function settle<T>(promise: Promise<T>, advanceMs: number): Promise<T> {
    await vi.advanceTimersByTimeAsync(advanceMs);
    return promise;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a model that reasons silently past the stream idle limit", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ body: [wait(4 * 60_000), text("答"), ...finish] });
    const { provider } = setup(http);
    const result = await settle(events(streamOf(provider)), 4 * 60_000 + 1);
    expect(result.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", delta: "答" }]);
    expect(result.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  it("counts streamed reasoning as output, so a long visible reasoning phase completes", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ body: [...every(8, 50_000, reasoning("想")), text("答"), ...finish] });
    const { provider } = setup(http);
    const result = await settle(events(streamOf(provider)), 8 * 50_000 + 1);
    expect(result.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", delta: "答" }]);
  });

  it("does not let comments or empty deltas before any output extend LLM_FIRST_OUTPUT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ body: [...every(10, 30_000, ": keep-alive\n\n"), ...every(10, 30_000, text(""))], hang: true });
    const { provider } = setup(http);
    const pending = failure(events(streamOf(provider)));
    await vi.advanceTimersByTimeAsync(LLM_FIRST_OUTPUT_TIMEOUT_MS - 1);
    expect(http.requests[0]?.signal.aborted).toBe(false);
    const error = (await settle(pending, 1)) as AmberError;
    expect(error.appError.class).toBe("llm_outcome_unknown");
  });

  it("does not let comments after the answer started reset LLM_STREAM_IDLE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ body: [text("a"), ...every(10, 20_000, ": keep-alive\n\n")], hang: true });
    const { provider } = setup(http);
    const pending = failure(events(streamOf(provider)));
    await vi.advanceTimersByTimeAsync(LLM_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(http.requests[0]?.signal.aborted).toBe(false);
    const error = (await settle(pending, 1)) as AmberError;
    expect(error.appError.class).toBe("llm_outcome_unknown");
  });

  it("does not count the time the consumer holds a delivered delta", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ body: [text("a"), text("b"), text("c"), ...finish] });
    const { provider } = setup(http);
    const iterator = streamOf(provider)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "a" });
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "b" });
    await vi.advanceTimersByTimeAsync(3 * LLM_STREAM_IDLE_TIMEOUT_MS);
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "c" });
    expect(http.requests[0]?.signal.aborted).toBe(false);
  });

  it("classifies a request whose headers never arrive by its send boundary", async () => {
    vi.useFakeTimers();
    const unsent = setup(new ScriptedHttp({ noHeaders: "before_send" })).provider;
    const notSent = failure(events(streamOf(unsent)));
    const safe = (await settle(notSent, LLM_FIRST_OUTPUT_TIMEOUT_MS)) as AmberError;
    expect(safe.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.unreachable", retryDisposition: "safe" });

    const sent = setup(new ScriptedHttp({ noHeaders: "after_send" })).provider;
    const notAnswered = failure(events(streamOf(sent)));
    const unknown = (await settle(notAnswered, LLM_FIRST_OUTPUT_TIMEOUT_MS)) as AmberError;
    expect(unknown.appError).toMatchObject({ class: "llm_outcome_unknown", retryDisposition: "outcome_unknown" });
  });

  it("bounds a non-streaming answer by LLM_FIRST_OUTPUT_TIMEOUT_MS as a whole", async () => {
    vi.useFakeTimers();
    const http = new ScriptedHttp({ body: [], hang: true });
    const { provider } = setup(http);
    const pending = failure(events(streamOf(provider, EQUIVALENT_REQUEST, capability({ stream: "unsupported" }))));
    await vi.advanceTimersByTimeAsync(LLM_FIRST_OUTPUT_TIMEOUT_MS - 1);
    expect(http.requests[0]?.signal.aborted).toBe(false);
    const error = (await settle(pending, 1)) as AmberError;
    expect(error.appError.class).toBe("llm_outcome_unknown");
  });

  it("leaves no timer behind once the answer is done or the caller cancels", async () => {
    vi.useFakeTimers();
    const done = setup(new ScriptedHttp({ body: [text("a"), ...finish] })).provider;
    await events(streamOf(done));
    expect(vi.getTimerCount()).toBe(0);

    const controller = new AbortController();
    const cancelled = setup(new ScriptedHttp({ body: [text("a")], hang: true })).provider;
    const pending = failure(events(streamOf(cancelled, EQUIVALENT_REQUEST, capability(), controller.signal)));
    await vi.advanceTimersByTimeAsync(LLM_STREAM_IDLE_TIMEOUT_MS - 1);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("OpenAiCompatibleProvider.probe", () => {
  const completion = (message: Record<string, unknown>, finishReason = "stop") =>
    JSON.stringify({ choices: [{ message, finish_reason: finishReason }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
  const answered = completion({ content: "OK" });
  const jsonBody = completion({ content: "{\"ok\":true}" });
  const toolCallBody = completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "report_ok", arguments: "{}" } }] }, "tool_calls");
  const truncatedBody = completion({ content: "", reasoning_content: "Let me think" }, "length");
  const error = (name: string): Answer => {
    const { status, body } = openAiError(name);
    return { status, body };
  };

  type Run = { kind: string; result?: LlmProbeResult; error?: unknown; calls: LlmProbeCall[] };

  async function runCheck(check: LlmProbeCheck, signal = live()): Promise<Run> {
    const calls: LlmProbeCall[] = [];
    try {
      return { kind: check.kind, result: await check.run({ signal, onRequestStart: noStartReport, onCall: (call) => calls.push(call) }), calls };
    } catch (thrown) {
      return { kind: check.kind, error: thrown, calls };
    }
  }

  async function runAll(http: ScriptedHttp, provider = setup(http).provider, modelId = "model-under-test", profile = PROFILE) {
    const checks = provider.probe(profile, modelId);
    const runs: Run[] = [];
    for (const check of checks) {
      runs.push(await runCheck(check));
    }
    return { checks, runs, bodies: http.bodies };
  }

  /** The check of one kind, alone. */
  async function runOne(http: ScriptedHttp, kind: string, provider = setup(http).provider, modelId = "model-under-test", profile = PROFILE): Promise<Run> {
    const check = provider.probe(profile, modelId).find((candidate) => candidate.kind === kind) as LlmProbeCheck;
    return runCheck(check);
  }

  const codeOf = (run: Run): string | undefined => (isAmberError(run.error) ? run.error.appError.code : undefined);

  it("offers the basic call, then the stream, JSON and tools checks, one request each with the probe token cap", async () => {
    const http = new ScriptedHttp({ body: openAiCompletion() }, { body: openAiStream("equivalent") }, { body: jsonBody }, { body: toolCallBody });
    const { checks, runs, bodies } = await runAll(http);
    expect(checks.map((check) => check.kind)).toEqual(["basic", "stream", "structuredOutput", "tools"]);
    expect(http.requests).toHaveLength(4);
    expect(bodies.map((body) => body["max_tokens"])).toEqual(Array(4).fill(LLM_PROBE_MAX_OUTPUT_TOKENS));
    expect(bodies.some((body) => Object.hasOwn(body, "max_completion_tokens"))).toBe(false);
    expect(bodies[0]).toEqual({ model: "model-under-test", max_tokens: LLM_PROBE_MAX_OUTPUT_TOKENS, stream: false, messages: [{ role: "user", content: "Reply with OK." }] });
    // The stream check is shaped like every streamed request, usage option included.
    expect(bodies[1]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(bodies[2]).toMatchObject({ stream: false, response_format: { type: "json_schema" } });
    expect(bodies[3]).toMatchObject({ stream: false, tools: [{ type: "function" }] });
    // The JSON prompt asks for no JSON, and tool use is requested, never forced.
    expect(JSON.stringify(bodies[2]?.["messages"])).not.toMatch(/ok/);
    expect(Object.hasOwn(bodies[3] ?? {}, "tool_choice")).toBe(false);
    expect(runs.map((run) => run.result)).toEqual([
      { kind: "basic", status: "connected", latencyMs: 14 },
      { kind: "stream", result: "supported", latencyMs: 14 },
      { kind: "structuredOutput", result: "supported", latencyMs: 14 },
      { kind: "tools", result: "supported", latencyMs: 14 },
    ]);
    expect(runs.map((run) => run.calls)).toEqual([
      [{ outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 42, outputTokens: 23 }) }],
      [{ outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 42, outputTokens: 23 }) }],
      [{ outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9, outputTokens: 4 }) }],
      [{ outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9, outputTokens: 4 }) }],
    ]);
  });

  it("calls a basic answer cut off before any answer text incomplete, and connected once there is text", async () => {
    const cut = await runOne(new ScriptedHttp({ body: truncatedBody }), "basic");
    expect(cut.result).toMatchObject({ kind: "basic", status: "incomplete" });
    expect(cut.calls).toEqual([{ outcome: "succeeded", usage: expect.objectContaining({ outputTokens: 4 }) }]);
    const partial = await runOne(new ScriptedHttp({ body: completion({ content: "O" }, "length") }), "basic");
    expect(partial.result).toMatchObject({ kind: "basic", status: "connected" });
  });

  it("fails the basic call on every error answer, a refusal and an unclassified bad request included, after reporting it", async () => {
    for (const [answer, code] of [
      [error("auth"), "llm_failed.auth"],
      [error("modelNotFound"), "llm_failed.model_not_found"],
      [error("insufficientBalance"), "llm_failed.quota"],
      [error("rateLimited"), "llm_rate_limited"],
      [{ status: 429, headers: { "retry-after": "3" }, body: "{}" }, "llm_rate_limited.retry_after"],
      [error("serverError"), "llm_failed"],
      [error("badRequest"), "llm_failed.invalid_request"],
      [{ body: completion({ content: "" }, "content_filter") }, "llm_failed.refused"],
    ] as const) {
      const run = await runOne(new ScriptedHttp(answer), "basic");
      expect(codeOf(run), JSON.stringify(answer)).toBe(code);
      expect(run.calls.map((call) => call.outcome)).toEqual(["failed"]);
    }
  });

  it("leaves a 200 answer it cannot read with an unknown outcome, and fails one carrying an error object", async () => {
    for (const [kind, body] of [
      ["basic", "<html>gateway</html>"],
      ["structuredOutput", '{"choices":[{"message":{"content":"O'],
      ["tools", JSON.stringify({ result: "ok" })],
      ["stream", "<html>gateway</html>"],
      ["stream", 'data: {"choices":[{"delta":{"content":"O"},"finish_reason":null}]}\n\ndata: {"choi\n\n'],
    ] as const) {
      const run = await runOne(new ScriptedHttp({ body }), kind);
      expect(isAmberError(run.error) && run.error.appError.class, `${kind} ${body}`).toBe("llm_outcome_unknown");
      expect(run.calls.map((call) => call.outcome), `${kind} ${body}`).toEqual(["outcome_unknown"]);
    }
    const inStream = openAiError("inStream");
    for (const kind of ["basic", "tools", "stream"]) {
      const run = await runOne(new ScriptedHttp({ body: inStream.body }), kind);
      expect(isAmberError(run.error) && run.error.appError.code, kind).toBe("llm_failed");
      expect(run.calls.map((call) => call.outcome), kind).toEqual(["failed"]);
    }
  });

  it("still connects a model that cannot stream, and learns unsupported from the refusal of streaming or its usage option", async () => {
    const usageOptionRefused = JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options", type: "invalid_request_error", param: null, code: null } });
    const http = new ScriptedHttp({ body: answered }, error("streamUnsupported"), { body: jsonBody }, { body: toolCallBody });
    const { runs } = await runAll(http);
    expect(runs.map((run) => run.result && ("status" in run.result ? run.result.status : run.result.result))).toEqual(["connected", "unsupported", "supported", "supported"]);
    expect(runs[1]?.calls).toEqual([{ outcome: "failed" }]);
    const refused = await runOne(new ScriptedHttp({ status: 400, body: usageOptionRefused }), "stream");
    expect(refused.result).toMatchObject({ kind: "stream", result: "unsupported" });
  });

  it("learns unsupported when a stream was asked for and one JSON answer came back", async () => {
    const run = await runOne(new ScriptedHttp({ body: openAiCompletion() }), "stream");
    expect(run.result).toMatchObject({ kind: "stream", result: "unsupported" });
    expect(run.calls).toEqual([{ outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 42 }) }]);
  });

  it("supports streaming once the stream says how it finished, a cut-off answer included, and fails it otherwise", async () => {
    // Cut off by the cap, the stream still worked as a stream.
    const cut = await runOne(new ScriptedHttp({ body: openAiStream("regression") }), "stream");
    expect(cut.result).toMatchObject({ kind: "stream", result: "supported" });
    expect(cut.calls).toEqual([{ outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 1200, reasoningTokens: 48 }) }]);
    // A relay that sends no [DONE] after the finishing chunk.
    const noDone = await runOne(new ScriptedHttp({ body: 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' }), "stream");
    expect(noDone.result).toMatchObject({ result: "supported" });
    expect(noDone.calls).toEqual([{ outcome: "succeeded" }]);

    const unfinished = await runOne(new ScriptedHttp({ body: 'data: {"choices":[{"delta":{"content":"O"},"finish_reason":null}]}\n\n' }), "stream");
    expect(isAmberError(unfinished.error) && unfinished.error.appError.class).toBe("llm_outcome_unknown");
    expect(unfinished.calls).toEqual([{ outcome: "outcome_unknown" }]);

    const inStream = openAiError("inStream");
    const failed = await runOne(new ScriptedHttp({ body: `data: ${inStream.body}\n\n` }), "stream");
    expect(isAmberError(failed.error) && [failed.error.appError.code, failed.error.appError.upstreamMessage]).toEqual(["llm_failed", "server_error: The server had an error while processing your request."]);
    expect(failed.calls).toEqual([{ outcome: "failed" }]);

    const filtered = await runOne(new ScriptedHttp({ body: 'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n' }), "stream");
    expect(codeOf(filtered)).toBe("llm_failed.refused");
    expect(filtered.calls).toEqual([{ outcome: "failed" }]);
  });

  it("learns unsupported when a 200 answer shows the JSON schema or the tools were silently ignored", async () => {
    for (const kind of ["structuredOutput", "tools"]) {
      const run = await runOne(new ScriptedHttp({ body: answered }), kind);
      expect(run.result).toMatchObject({ kind, result: "unsupported" });
      expect(run.calls.map((call) => call.outcome)).toEqual(["succeeded"]);
    }
  });

  it("cannot decide a JSON or tools check whose answer was cut off before the feature could show", async () => {
    for (const kind of ["structuredOutput", "tools"]) {
      const run = await runOne(new ScriptedHttp({ body: truncatedBody }), kind);
      expect(run.result).toMatchObject({ kind, result: "inconclusive", reason: "truncated" });
      expect(run.calls.map((call) => call.outcome)).toEqual(["succeeded"]);
    }
    // Schema-shaped JSON proves the feature even when the cap was reached right after it.
    const complete = await runOne(new ScriptedHttp({ body: completion({ content: "{\"ok\":true}" }, "length") }), "structuredOutput");
    expect(complete.result).toMatchObject({ result: "supported" });
  });

  it("learns unsupported from a refusal saying the response format is unavailable", async () => {
    // DeepSeek's answer to a `json_schema` response format, recorded 2026-10-01.
    const unavailable = JSON.stringify({ error: { message: "This response_format type is unavailable now (request_id: <redacted>)", type: "invalid_request_error" } });
    const run = await runOne(new ScriptedHttp({ status: 400, body: unavailable }), "structuredOutput");
    expect(run.result).toMatchObject({ result: "unsupported" });
    expect(run.calls).toEqual([{ outcome: "failed" }]);
  });

  it("learns unsupported only from an explicit refusal of the probed feature, and cannot decide on another bad request", async () => {
    const http = new ScriptedHttp({ body: answered }, error("streamUnsupported"), error("responseFormatUnsupported"), error("toolsUnsupported"));
    const { runs } = await runAll(http);
    expect(runs.slice(1).map((run) => run.result)).toEqual([
      { kind: "stream", result: "unsupported", latencyMs: 14 },
      { kind: "structuredOutput", result: "unsupported", latencyMs: 14 },
      { kind: "tools", result: "unsupported", latencyMs: 14 },
    ]);
    for (const kind of ["stream", "structuredOutput", "tools"]) {
      const unclear = await runOne(new ScriptedHttp(error("badRequest")), kind);
      expect(unclear.result).toEqual({ kind, result: "inconclusive", reason: "upstream_rejected", latencyMs: 14 });
      expect(unclear.calls).toEqual([{ outcome: "failed" }]);
      const unprocessable = await runOne(new ScriptedHttp({ status: 422, body: "{}" }), kind);
      expect(unprocessable.result).toMatchObject({ result: "inconclusive", reason: "upstream_rejected" });
    }
  });

  it("fails a capability check on authentication, unknown model, quota, rate limit and server errors", async () => {
    for (const [answer, code] of [
      [error("auth"), "llm_failed.auth"],
      [error("modelNotFound"), "llm_failed.model_not_found"],
      [error("insufficientQuota"), "llm_failed.quota"],
      [{ status: 429, headers: { "retry-after": "2" }, body: JSON.stringify({ error: { message: "slow", code: null } }) }, "llm_rate_limited.retry_after"],
      [{ status: 503, body: JSON.stringify({ error: { message: "busy", type: "server_is_overloaded" } }) }, "llm_failed.overloaded"],
      [error("serverError"), "llm_failed"],
      [error("contextLength"), "llm_capability.context_length"],
    ] as const) {
      const run = await runOne(new ScriptedHttp(answer), "tools");
      expect(codeOf(run), JSON.stringify(answer)).toBe(code);
      expect(run.calls).toEqual([{ outcome: "failed" }]);
    }
    const limited = await runOne(new ScriptedHttp({ status: 429, headers: { "retry-after": "2" }, body: "{}" }), "structuredOutput");
    expect(isAmberError(limited.error) && limited.error.appError.details).toEqual({ retryAfterMs: 2000 });
  });

  it("reports nothing for a failure before sending and an unknown outcome after it", async () => {
    const http = new ScriptedHttp(new OutboundHttpError("before_send", "network"), new OutboundHttpError("after_send", "network"), {
      body: ["{\"choices\":"],
      bodyError: new OutboundHttpError("after_send", "network"),
    });
    const { provider } = setup(http);
    const before = await runOne(http, "basic", provider);
    const after = await runOne(http, "structuredOutput", provider);
    const broken = await runOne(http, "tools", provider);
    expect(codeOf(before)).toBe("llm_failed.unreachable");
    expect(isAmberError(after.error) && after.error.appError.class).toBe("llm_outcome_unknown");
    expect(isAmberError(broken.error) && broken.error.appError.class).toBe("llm_outcome_unknown");
    expect([before.calls, after.calls, broken.calls]).toEqual([[], [{ outcome: "outcome_unknown" }], [{ outcome: "outcome_unknown" }]]);
    // A network failure is never answered with the other token parameter.
    expect(http.bodies.every((body) => Object.hasOwn(body, "max_tokens"))).toBe(true);
  });

  it("follows the send boundary when the caller cancels", async () => {
    const { provider } = setup(new ScriptedHttp(new OutboundHttpError("before_send", "aborted"), new OutboundHttpError("after_send", "aborted")));
    const [first, second] = provider.probe(PROFILE, "model-under-test");
    const controller = new AbortController();
    controller.abort();
    const before = await runCheck(first as LlmProbeCheck, controller.signal);
    const after = await runCheck(second as LlmProbeCheck, controller.signal);
    expect(before.error).toBeInstanceOf(OutboundHttpError);
    expect(after.error).toBeInstanceOf(OutboundHttpError);
    expect([...before.calls, ...after.calls]).toEqual([{ outcome: "outcome_unknown" }]);
  });
});

describe("OpenAiCompatibleProvider.probe max_tokens fallback", () => {
  const answered = JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
  const rejected = (): Answer => {
    const { status, body } = openAiError("maxTokensRejected");
    return { status, body };
  };
  // Both parameters named in the message, without `param`.
  const namesBoth: Answer = { status: 400, body: JSON.stringify({ error: { message: "max_tokens is deprecated for this model, please use max_completion_tokens", type: "invalid_request_error" } }) };
  const tokenParams = (http: ScriptedHttp) => http.bodies.map((body) => (Object.hasOwn(body, "max_tokens") ? "max_tokens" : Object.hasOwn(body, "max_completion_tokens") ? "max_completion_tokens" : "none"));

  async function run(provider: OpenAiCompatibleProvider, kind = "basic", modelId = "model-under-test", profile = PROFILE) {
    const check = provider.probe(profile, modelId).find((candidate) => candidate.kind === kind) as LlmProbeCheck;
    const calls: LlmProbeCall[] = [];
    const starts: RequestStartInfo[] = [];
    try {
      const result = await check.run({ signal: live(), onRequestStart: (info) => starts.push(info), onCall: (call) => calls.push(call) });
      return { result, calls, starts };
    } catch (error) {
      return { error, calls, starts };
    }
  }

  it("re-sends the check once with max_completion_tokens when the upstream names max_tokens as the rejected parameter, reporting both requests", async () => {
    const http = new ScriptedHttp(rejected(), { body: answered });
    const { provider } = setup(http);
    const outcome = await run(provider);
    expect(outcome.result).toMatchObject({ kind: "basic", status: "connected" });
    expect(outcome.calls).toEqual([{ outcome: "failed" }, { outcome: "succeeded", usage: expect.objectContaining({ inputTokens: 9 }) }]);
    expect(outcome.starts).toHaveLength(2);
    expect(tokenParams(http)).toEqual(["max_tokens", "max_completion_tokens"]);
    expect(http.bodies[1]?.["max_completion_tokens"]).toBe(LLM_PROBE_MAX_OUTPUT_TOKENS);
  });

  it("also falls back when the error names both parameters, on any check", async () => {
    const http = new ScriptedHttp(namesBoth, { body: answered });
    const outcome = await run(setup(http).provider, "tools");
    expect(outcome.result).toMatchObject({ kind: "tools", result: "unsupported" });
    expect(outcome.calls.map((call) => call.outcome)).toEqual(["failed", "succeeded"]);
    expect(tokenParams(http)).toEqual(["max_tokens", "max_completion_tokens"]);
  });

  it("does not fall back on a bad request about something else, on wording naming only one parameter, or twice", async () => {
    const vague: Answer = { status: 400, body: JSON.stringify({ error: { message: "max_tokens is too large", type: "invalid_request_error" } }) };
    for (const answer of [{ status: openAiError("badRequest").status, body: openAiError("badRequest").body }, vague]) {
      const http = new ScriptedHttp(answer, { body: answered });
      const outcome = await run(setup(http).provider);
      expect(isAmberError(outcome.error) && outcome.error.appError.code).toBe("llm_failed.invalid_request");
      expect(http.requests).toHaveLength(1);
    }
    const twice = new ScriptedHttp(rejected(), rejected(), { body: answered });
    const provider = setup(twice).provider;
    const outcome = await run(provider, "structuredOutput");
    expect(outcome.result).toMatchObject({ result: "inconclusive", reason: "upstream_rejected" });
    expect(outcome.calls.map((call) => call.outcome)).toEqual(["failed", "failed"]);
    // The re-sent request was refused over its cap too: nothing was learned to remember.
    await run(provider, "basic");
    expect(tokenParams(twice)).toEqual(["max_tokens", "max_completion_tokens", "max_tokens"]);
  });

  it("remembers the fallback only when the re-sent request was not refused over max_completion_tokens", async () => {
    const completionRejected: Answer = { status: 400, body: JSON.stringify({ error: { message: "max_completion_tokens is not supported", type: "invalid_request_error", param: "max_completion_tokens" } }) };
    const refused = new ScriptedHttp(rejected(), completionRejected, { body: answered });
    const refusedProvider = setup(refused).provider;
    await run(refusedProvider, "basic");
    await run(refusedProvider, "basic");
    expect(tokenParams(refused)).toEqual(["max_tokens", "max_completion_tokens", "max_tokens"]);

    // Refused for another reason, the re-sent request still showed the parameter is accepted.
    const auth = openAiError("auth");
    const other = new ScriptedHttp(rejected(), { status: auth.status, body: auth.body }, { body: answered });
    const otherProvider = setup(other).provider;
    expect(isAmberError((await run(otherProvider, "basic")).error)).toBe(true);
    await run(otherProvider, "basic");
    expect(tokenParams(other)).toEqual(["max_tokens", "max_completion_tokens", "max_completion_tokens"]);

    // A re-sent request that never got an answer settles nothing.
    const lost = new ScriptedHttp(rejected(), new OutboundHttpError("after_send", "network"), { body: answered });
    const lostProvider = setup(lost).provider;
    await run(lostProvider, "basic");
    await run(lostProvider, "basic");
    expect(tokenParams(lost)).toEqual(["max_tokens", "max_completion_tokens", "max_tokens"]);
  });

  it("remembers the endpoint: later checks and probes of the same profile, endpoint and model start with max_completion_tokens", async () => {
    const http = new ScriptedHttp(rejected(), ...Array.from({ length: 8 }, () => ({ body: answered })));
    const { provider } = setup(http);
    await run(provider, "basic");
    await run(provider, "tools");
    // Equal up to a trailing slash: the same endpoint.
    await run(provider, "basic", "model-under-test", { ...PROFILE, baseURL: `${PROFILE.baseURL}/` });
    await run(provider, "basic", "other-model");
    await run(provider, "basic", "model-under-test", { ...PROFILE, id: "other-profile" });
    await run(provider, "basic", "model-under-test", { ...PROFILE, baseURL: "https://elsewhere.example.invalid/v1" });
    expect(tokenParams(http)).toEqual(["max_tokens", "max_completion_tokens", "max_completion_tokens", "max_completion_tokens", "max_tokens", "max_tokens", "max_tokens"]);
  });

  it("keeps at most LLM_TOKEN_PARAM_CACHE_MAX endpoints, forgetting the oldest first", async () => {
    const answers: Answer[] = [];
    for (let index = 0; index <= LLM_TOKEN_PARAM_CACHE_MAX; index += 1) {
      answers.push(rejected(), { body: answered });
    }
    answers.push({ body: answered }, { body: answered });
    const http = new ScriptedHttp(...answers);
    const { provider } = setup(http);
    for (let index = 0; index <= LLM_TOKEN_PARAM_CACHE_MAX; index += 1) {
      await run(provider, "basic", `model-${index}`);
    }
    const before = http.requests.length;
    await run(provider, "basic", "model-0");
    await run(provider, "basic", "model-1");
    expect(tokenParams(http).slice(before)).toEqual(["max_tokens", "max_completion_tokens"]);
  });
});

describe("OpenAiCompatibleProvider request start", () => {
  const AUDIO_REQUEST: LlmRequest = {
    ...EQUIVALENT_REQUEST,
    messages: [{ role: "user", content: [{ type: "audio", mimeType: "audio/wav", dataRef: "tmp/tasks/t/missing.wav" }] }],
  };

  /** A store whose key and version change at every reveal, so a second reveal would show in the request. */
  function rotating(log: string[]): { provider: OpenAiCompatibleProvider; http: ScriptedHttp } {
    let reveals = 0;
    const http = new ScriptedHttp(...Array.from({ length: 5 }, () => ({ body: openAiStream("equivalent") })));
    const original = http.request.bind(http);
    http.request = (request) => {
      log.push(`send ${String(request.headers?.["authorization"])}`);
      return original(request);
    };
    const provider = new OpenAiCompatibleProvider({
      http,
      secrets: {
        revealVersioned: () => {
          reveals += 1;
          log.push(`reveal ${reveals}`);
          return { plaintext: `key-${reveals}`, version: { versionId: `version-${reveals}`, setAt: reveals * 10 } };
        },
      },
      files: { read: () => (async function* () { throw new Error("no file"); })() },
      now: () => 5_000,
    });
    return { provider, http };
  }

  it("reports each request once, between the reveal and the send, with the version of the key that is sent", async () => {
    const log: string[] = [];
    const infos: RequestStartInfo[] = [];
    const { provider } = rotating(log);
    const record = (info: RequestStartInfo): void => {
      infos.push(info);
      log.push("started");
    };
    await events(streamOf(provider, EQUIVALENT_REQUEST, capability(), live(), record));
    await events(streamOf(provider, EQUIVALENT_REQUEST, capability(), live(), record));
    expect(log).toEqual(["reveal 1", "started", "send Bearer key-1", "reveal 2", "started", "send Bearer key-2"]);
    expect(infos).toEqual([
      { sentAt: 5_000, credential: { versionId: "version-1", setAt: 10 } },
      { sentAt: 5_000, credential: { versionId: "version-2", setAt: 20 } },
    ]);
  });

  it("reports the plain-answer fallback request too", async () => {
    const http = new ScriptedHttp({ body: JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) });
    const { provider } = setup(http);
    const infos: RequestStartInfo[] = [];
    await events(streamOf(provider, EQUIVALENT_REQUEST, capability({ stream: "unsupported" }), live(), (info) => infos.push(info)));
    expect(infos).toHaveLength(1);
  });

  it("does not report when the request cannot be built or there is no key", async () => {
    const http = new ScriptedHttp({ body: openAiStream("equivalent") });
    const { provider, revealed } = setup(http);
    const infos: RequestStartInfo[] = [];
    const encoding = await failure(events(streamOf(provider, AUDIO_REQUEST, capability(), live(), (info) => infos.push(info))));
    expect(encoding).toBeInstanceOf(Error);
    const unconfigured = await failure(
      events(provider.stream(EQUIVALENT_REQUEST, { signal: live(), effectiveCapability: capability(), profile: { ...PROFILE, credentialRef: undefined as never }, onRequestStart: (info) => infos.push(info) })),
    );
    expect((unconfigured as AmberError).appError.class).toBe("llm_unconfigured");
    expect(infos).toEqual([]);
    expect(http.requests).toEqual([]);
    expect(revealed).toEqual([]);
  });

  it("sends nothing when the start callback throws", async () => {
    const http = new ScriptedHttp({ body: openAiStream("equivalent") });
    const { provider } = setup(http);
    const refusal = new Error("do not send");
    const thrown = await failure(
      events(
        streamOf(provider, EQUIVALENT_REQUEST, capability(), live(), () => {
          throw refusal;
        }),
      ),
    );
    expect(thrown).toBe(refusal);
    expect(http.requests).toEqual([]);
  });

  it("reports every probe request, and nothing is sent when the callback throws", async () => {
    const log: string[] = [];
    const { provider } = rotating(log);
    const checks = provider.probe(PROFILE, "model-under-test");
    const infos: RequestStartInfo[] = [];
    for (const check of checks) {
      await check.run({ signal: live(), onRequestStart: (info) => infos.push(info), onCall: () => undefined }).catch(() => undefined);
    }
    expect(infos.map((info) => info.credential.versionId)).toEqual(["version-1", "version-2", "version-3", "version-4"]);
    expect(log.filter((entry) => entry.startsWith("send"))).toEqual(["send Bearer key-1", "send Bearer key-2", "send Bearer key-3", "send Bearer key-4"]);

    const http = new ScriptedHttp({ body: openAiStream("equivalent") });
    const refused = setup(http).provider.probe(PROFILE, "model-under-test")[0] as LlmProbeCheck;
    const calls: LlmProbeCall[] = [];
    const refusal = new Error("do not send");
    const thrown = await failure(
      refused.run({
        signal: live(),
        onRequestStart: () => {
          throw refusal;
        },
        onCall: (call) => calls.push(call),
      }),
    );
    expect(thrown).toBe(refusal);
    expect(http.requests).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("proxy errors and route", () => {
  const proxyErrors = () => [
    amberError("network_proxy_failed", "cannot connect to the proxy", { code: "network_proxy_failed.rejected" }),
    amberError("network_proxy_unsupported", "the proxy configuration cannot be used", { code: "network_proxy_unsupported.socks" }),
  ];
  const runBasic = (http: ScriptedHttp) =>
    (setup(http).provider.probe(PROFILE, "model-under-test")[0] as LlmProbeCheck).run({ signal: new AbortController().signal, onRequestStart: () => undefined, onCall: () => undefined });

  it("passes proxy errors from outbound HTTP on unchanged, in a stream and in test connection", async () => {
    for (const error of proxyErrors()) {
      expect(await failure(events(streamOf(setup(new ScriptedHttp(error)).provider)))).toBe(error);
      expect(await failure(runBasic(new ScriptedHttp(error)))).toBe(error);
    }
  });

  it("reports the path of the basic test call from the outbound response", async () => {
    class ProxiedHttp extends ScriptedHttp {
      override async request(request: OutboundRequest): Promise<OutboundResponse> {
        return Object.assign(await super.request(request), { route: "proxy" as const });
      }
    }
    expect(await runBasic(new ProxiedHttp({ body: openAiCompletion() }))).toMatchObject({ kind: "basic", status: "connected", route: "proxy" });
    expect(await runBasic(new ScriptedHttp({ body: openAiCompletion() }))).not.toHaveProperty("route");
  });
});
