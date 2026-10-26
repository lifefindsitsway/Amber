import { afterEach, describe, expect, it } from "vitest";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { LlmCallAttribution, LlmRequest, LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import type { TokenUsage } from "../../../src/server/domain/usage.ts";
import type { Logger, LogFields } from "../../../src/server/ports/logger.ts";
import { OutboundHttpError } from "../../../src/server/ports/outbound-http.ts";
import { LlmGateway } from "../../../src/server/application/llm-gateway.ts";
import type { LlmLane, LlmLanes } from "../../../src/server/application/llm-lanes.ts";
import { LlmCallDeferred } from "../../../src/server/pipeline/executor.ts";
import { AnthropicMessagesProvider } from "../../../src/server/adapters/llm/anthropic-messages/index.ts";
import { OpenAiCompatibleProvider } from "../../../src/server/adapters/llm/openai-compatible/index.ts";
import { anthropicFixture } from "../../fixtures/llm/anthropic-messages/index.ts";
import { EQUIVALENT_GOLDEN, EQUIVALENT_REQUEST } from "../../fixtures/llm/equivalent.ts";
import { FAKE_USAGE, FakeLlmProvider, reply } from "../../fixtures/llm/fake-llm.ts";
import { openAiStream } from "../../fixtures/llm/openai-compatible/index.ts";
import { ReplayHttp } from "../../fixtures/llm/replay-http.ts";
import { BOB, configureLlm, createHarness, createTaskOfKind, LOCAL, taskOf, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
function setup(options: { protocol?: "openai_compatible" | "anthropic_messages"; audioMimeTypes?: string[]; window?: number } = {}) {
  const fake = new FakeLlmProvider({ ...(options.audioMimeTypes === undefined ? {} : { audioMimeTypes: options.audioMimeTypes }) });
  const h = createHarness({
    llmProviders: options.protocol === "anthropic_messages" ? [new FakeLlmProvider({ protocol: "anthropic_messages" })] : [fake],
  });
  open.push(h);
  const modelRef = configureLlm(h);
  if (options.window !== undefined) {
    pinWindow(h.llm, modelRef, options.window);
  }
  return { h, fake, modelRef };
}

/** The gateway's model lanes; private, reached here only to observe and pin them. */
const lanesOf = (gateway: LlmGateway): LlmLanes => (gateway as unknown as { lanes: LlmLanes }).lanes;

/**
 * Pins a lane's window, so a test can watch the fair order one grant at a time instead of
 * the window growing with every success.
 */
function pinWindow(gateway: LlmGateway, modelRef: ModelRef, size: number): LlmLane {
  const lane = lanesOf(gateway).get(modelRef);
  lane.window = size;
  const finish = lane.finish.bind(lane);
  lane.finish = (ticket, feedback) => {
    const effect = finish(ticket, feedback);
    lane.window = size;
    return effect;
  };
  return lane;
}

afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.close().catch(() => undefined);
  }
});

const CHAT: LlmCallAttribution = { userId: LOCAL.userId, feature: "chat" };
const request = (modelRef: ModelRef, extra: Partial<LlmRequest> = {}): LlmRequest => ({
  modelRef,
  system: "be brief",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  ...extra,
});
const usageRows = (h: Harness): TokenUsage[] => h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
const setOverride = (h: Harness, modelRef: ModelRef, flags: Record<string, string>): void => {
  h.db.prepare("UPDATE model_capability SET flags_user_override_json = ? WHERE profile_id = ?").run(JSON.stringify(flags), modelRef.providerProfileId);
};
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a rejection");
};
const signal = (): AbortSignal => new AbortController().signal;

describe("resolution", () => {
  it("rejects unknown profiles, unlisted models, missing or undecryptable keys and unknown protocols, recording nothing", async () => {
    const { h, fake, modelRef } = setup();
    expect(await codeOf(h.llm.complete(CHAT, request({ ...modelRef, providerProfileId: "nope" }), { signal: signal() }))).toBe("llm_unconfigured");
    expect(await codeOf(h.llm.complete(CHAT, request({ ...modelRef, modelId: "other" }), { signal: signal() }))).toBe("llm_unconfigured");
    // Another user's profile behaves like an unknown one.
    expect(await codeOf(h.llm.complete({ ...CHAT, userId: "bob" }, request(modelRef), { signal: signal() }))).toBe("llm_unconfigured");

    const ref = (h.db.prepare("SELECT credential_ref FROM provider_profile WHERE id = ?").get(modelRef.providerProfileId) as { credential_ref: string }).credential_ref;
    h.markCredentialUnavailable(ref);
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef), { signal: signal() }))).toBe("internal.secret_unavailable");
    h.restoreCredential(ref);

    h.db.prepare("UPDATE provider_profile SET credential_ref = NULL WHERE id = ?").run(modelRef.providerProfileId);
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef), { signal: signal() }))).toBe("llm_unconfigured");
    expect(fake.calls).toHaveLength(0);
    expect(usageRows(h)).toEqual([]);
  });

  it("fails as internal when no adapter speaks the profile's protocol", async () => {
    const { h, modelRef } = setup({ protocol: "anthropic_messages" });
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef), { signal: signal() }))).toBe("internal");
    expect(usageRows(h)).toEqual([]);
  });

  it("refuses audio and structured output the model or protocol cannot take, before calling the adapter", async () => {
    const { h, fake, modelRef } = setup({ audioMimeTypes: ["audio/wav"] });
    const audio = (mimeType: string): Partial<LlmRequest> => ({
      messages: [{ role: "user", content: [{ type: "audio", mimeType, dataRef: "tmp/a.wav" }] }],
    });
    // audioInput is unknown by default: audio needs an explicit `supported`.
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef, audio("audio/wav")), { signal: signal() }))).toBe("llm_capability");
    setOverride(h, modelRef, { audioInput: "supported" });
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef, audio("audio/mpeg")), { signal: signal() }))).toBe("llm_capability");
    await h.llm.complete(CHAT, request(modelRef, audio("audio/wav")), { signal: signal() });
    expect(fake.calls).toHaveLength(1);

    const json: Partial<LlmRequest> = { responseFormat: { type: "json_schema", schema: { type: "object" } } };
    await h.llm.complete(CHAT, request(modelRef, json), { signal: signal() });
    setOverride(h, modelRef, { structuredOutput: "unsupported" });
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef, json), { signal: signal() }))).toBe("llm_capability");
    expect(fake.calls).toHaveLength(2);
    expect(usageRows(h)).toHaveLength(2);
  });
});

describe("describe", () => {
  it("returns the effective capability, the protocol's audio formats and the snapshot without calling or recording", () => {
    const { h, fake, modelRef } = setup({ audioMimeTypes: ["audio/wav"] });
    setOverride(h, modelRef, { audioInput: "supported" });
    h.db.prepare("UPDATE model_capability SET limits_user_override_json = ? WHERE profile_id = ?").run(JSON.stringify({ contextWindowTokens: 64_000 }), modelRef.providerProfileId);
    const described = h.llm.describe(LOCAL.userId, modelRef);
    expect(described.capability.flags).toMatchObject({ audioInput: "supported", structuredOutput: "unknown" });
    expect(described.capability.limits).toEqual({ contextWindowTokens: 64_000 });
    expect(described.audioMimeTypes).toEqual(["audio/wav"]);
    expect(described.snapshot).toEqual({ ...modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: modelRef.modelId, protocolSnapshot: "openai_compatible" });
    expect(fake.calls).toHaveLength(0);
    expect(usageRows(h)).toEqual([]);
  });

  it("fails like a call would before sending", async () => {
    const { h, modelRef } = setup();
    expect(await codeOf(Promise.resolve().then(() => h.llm.describe(LOCAL.userId, { ...modelRef, modelId: "other" })))).toBe("llm_unconfigured");
    expect(await codeOf(Promise.resolve().then(() => h.llm.describe("bob", modelRef)))).toBe("llm_unconfigured");
  });
});

describe("usage", () => {
  it("records one row per call with the model snapshot and the reported tokens", async () => {
    const { h, fake, modelRef } = setup();
    fake.script({ events: reply("hello") });
    const completion = await h.llm.complete(CHAT, request(modelRef), { signal: signal() });
    expect(completion).toMatchObject({ text: "hello", stopReason: "stop", usage: FAKE_USAGE });
    expect(fake.calls[0]?.opts.profile).toMatchObject({ id: modelRef.providerProfileId, name: "relay" });
    expect(fake.calls[0]?.opts.effectiveCapability).toMatchObject({ modelId: "model-a" });
    expect(usageRows(h)).toEqual([
      {
        id: completion.invocationId,
        userId: LOCAL.userId,
        modelRef: { ...modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: "model-a", protocolSnapshot: "openai_compatible" },
        feature: "chat",
        outcome: "succeeded",
        inputTokens: 12,
        outputTokens: 5,
        rawUsageJson: FAKE_USAGE.rawJson,
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("leaves token counts absent when the upstream reported none", async () => {
    const { h, fake, modelRef } = setup();
    fake.script({ events: reply("x", null) });
    await h.llm.complete(CHAT, request(modelRef), { signal: signal() });
    const [row] = usageRows(h);
    expect(row?.outcome).toBe("succeeded");
    expect(row).not.toHaveProperty("inputTokens");
    expect(row).not.toHaveProperty("rawUsageJson");
  });

  it("records nothing for failures before the send boundary, and retries them only outside the pipeline", async () => {
    const { h, fake, modelRef } = setup();
    const unreachable = () => ({ events: [], error: amberError("llm_failed", "down", { code: "llm_failed.unreachable" }) });
    fake.script(unreachable(), unreachable(), unreachable(), unreachable());
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef), { signal: signal() }))).toBe("llm_failed.unreachable");
    expect(fake.calls).toHaveLength(4);

    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    fake.script(unreachable());
    expect(await codeOf(h.llm.complete({ ...CHAT, feature: "summary", taskId }, request(modelRef), { signal: signal() }))).toBe("llm_failed.unreachable");
    expect(fake.calls).toHaveLength(5);
    expect(usageRows(h)).toEqual([]);
  });

  it("records an upstream error inside the stream as failed and throws llm_failed", async () => {
    const { h, fake, modelRef } = setup();
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    fake.script({ events: [{ type: "text_delta", delta: "pa" }, { type: "done", stopReason: "error", raw: "overloaded" }] });
    const error = await h.llm.complete({ ...CHAT, feature: "summary", taskId }, request(modelRef), { signal: signal() }).catch((caught: unknown) => caught);
    expect(isAmberError(error) && error.appError).toMatchObject({ class: "llm_failed", upstreamMessage: "overloaded" });
    expect(usageRows(h).map((row) => [row.outcome, row.taskId])).toEqual([["failed", taskId]]);
    expect(fake.calls).toHaveLength(1);
  });

  it("records a refusal as failed and throws llm_failed.refused without retrying, even outside the pipeline", async () => {
    const { h, fake, modelRef } = setup();
    const refused: LlmStreamEvent[] = [{ type: "text_delta", delta: "pa" }, { type: "usage", usage: FAKE_USAGE }, { type: "done", stopReason: "refused", raw: "refusal: cyber" }];
    fake.script({ events: refused }, { events: reply("never sent") });
    const error = await h.llm.complete(CHAT, request(modelRef), { signal: signal() }).catch((caught: unknown) => caught);
    expect(isAmberError(error) && error.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.refused", retryDisposition: "never", upstreamMessage: "refusal: cyber" });
    expect(fake.calls).toHaveLength(1);
    expect(usageRows(h).map((row) => [row.outcome, row.inputTokens])).toEqual([["failed", FAKE_USAGE.inputTokens]]);
  });

  it("records a streamed refusal as failed and passes done(refused) to the consumer", async () => {
    const { h, fake, modelRef } = setup();
    fake.script({ events: [{ type: "done", stopReason: "refused", raw: "refusal: unspecified" }] });
    const seen: LlmStreamEvent[] = [];
    for await (const event of h.llm.stream(CHAT, request(modelRef), { signal: signal() })) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: "done", stopReason: "refused", raw: "refusal: unspecified" }]);
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["failed"]);
  });

  it("records an unknown outcome when the call fails after sending", async () => {
    const { h, fake, modelRef } = setup();
    fake.script({ events: [{ type: "text_delta", delta: "a" }], error: amberError("llm_outcome_unknown", "idle") });
    expect(await codeOf(h.llm.complete(CHAT, request(modelRef), { signal: signal() }))).toBe("llm_outcome_unknown");
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
    expect(fake.calls).toHaveLength(1);
  });

  it("tells a cancellation before sending (no row) from one after sending (outcome unknown)", async () => {
    const { h, fake, modelRef } = setup();
    const cancelled = (phase: "before_send" | "after_send") => {
      const controller = new AbortController();
      fake.script(async function* (): AsyncGenerator<LlmStreamEvent> {
        controller.abort();
        throw new OutboundHttpError(phase, "aborted");
      });
      return h.llm.complete(CHAT, request(modelRef), { signal: controller.signal }).catch((error: unknown) => error);
    };
    expect(await cancelled("before_send")).toBeInstanceOf(OutboundHttpError);
    expect(usageRows(h)).toEqual([]);
    expect(await cancelled("after_send")).toBeInstanceOf(OutboundHttpError);
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
    // Cancelled while waiting for a slot: the adapter is never called.
    const controller = new AbortController();
    controller.abort();
    await h.llm.complete(CHAT, request(modelRef), { signal: controller.signal }).catch(() => undefined);
    expect(fake.calls).toHaveLength(2);
  });

  it("records an unknown outcome and frees the slot when the consumer stops before done", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    fake.script({ events: reply("hello") });
    const stream = h.llm.stream(CHAT, request(modelRef), { signal: signal() });
    for await (const event of stream) {
      expect(event).toEqual({ type: "text_delta", delta: "h" });
      break;
    }
    expect(usageRows(h)).toEqual([expect.objectContaining({ id: stream.invocationId, outcome: "outcome_unknown" })]);
    await h.llm.complete(CHAT, request(modelRef), { signal: signal() });
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["outcome_unknown", "succeeded"]);
  });
});

describe("onCallStart", () => {
  it("runs once the slot is granted and before the adapter is called, never while queued", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    const order: string[] = [];
    let release: () => void = () => undefined;
    fake.script(
      () =>
        (async function* () {
          order.push("adapter:first");
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          yield* reply("a");
        })(),
      () =>
        (async function* () {
          order.push("adapter:second");
          yield* reply("b");
        })(),
    );
    const first = h.llm.complete(CHAT, request(modelRef), { signal: signal(), onCallStart: () => order.push("start:first") });
    const second = h.llm.complete(CHAT, request(modelRef), { signal: signal(), onCallStart: () => order.push("start:second") });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["start:first", "adapter:first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "adapter:first", "start:second", "adapter:second"]);
  });

  it("is not called for a call cancelled while it waits for a slot", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    let release: () => void = () => undefined;
    fake.script(() =>
      (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield* reply("a");
      })(),
    );
    const first = h.llm.complete(CHAT, request(modelRef), { signal: signal() });
    const controller = new AbortController();
    let started = 0;
    const queued = h.llm.complete(CHAT, request(modelRef), { signal: controller.signal, onCallStart: () => (started += 1) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await queued.catch(() => undefined);
    release();
    await first;
    expect(started).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it("fails before the adapter, records nothing and frees the slot when it throws", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    const failed = h.llm.complete({ ...CHAT, taskId: "t1", workUnitId: "w1" }, request(modelRef), {
      signal: signal(),
      onCallStart: () => {
        throw amberError("internal", "bookkeeping failed");
      },
    });
    expect(await codeOf(failed)).toBe("internal");
    expect(fake.calls).toHaveLength(0);
    expect(usageRows(h)).toEqual([]);
    // The slot was handed back: the next call gets it at once.
    await expect(h.llm.complete(CHAT, request(modelRef), { signal: signal() })).resolves.toMatchObject({ text: "ok" });
  });
});

describe("retries", () => {
  it("retries a stream outside the pipeline only until its first event reached the consumer", async () => {
    const { h, fake, modelRef } = setup();
    // Server errors: retried by policy without cooling the lane down.
    fake.script(
      { events: [], error: amberError("llm_failed") },
      { events: [{ type: "text_delta", delta: "a" }], error: amberError("llm_failed") },
    );
    const received: string[] = [];
    const stream = h.llm.stream(CHAT, request(modelRef), { signal: signal() });
    const error = await (async () => {
      for await (const event of stream) {
        received.push(event.type);
      }
    })().catch((caught: unknown) => caught);
    expect(isAmberError(error) && error.appError.class).toBe("llm_failed");
    expect(received).toEqual(["text_delta"]);
    expect(fake.calls).toHaveLength(2);
    // Each attempt crossed the send boundary and has its own row.
    const rows = usageRows(h);
    expect(rows.map((row) => row.outcome)).toEqual(["failed", "failed"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(stream.invocationId).toBe(rows[1]?.id);
  });

  it("lets complete() retry outside the pipeline, but never inside it", async () => {
    const { h, fake, modelRef } = setup();
    fake.script({ events: [{ type: "done", stopReason: "error", raw: "boom" }] }, { events: reply("ok") });
    expect((await h.llm.complete(CHAT, request(modelRef), { signal: signal() })).text).toBe("ok");
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["failed", "succeeded"]);

    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    fake.script({ events: [], error: amberError("llm_rate_limited") });
    // Inside the pipeline the failure carries the lane's cooldown for the unit to wait out.
    expect(await codeOf(h.llm.complete({ ...CHAT, feature: "summary", taskId }, request(modelRef), { signal: signal() }))).toBe("llm_rate_limited.retry_after");
    expect(fake.calls).toHaveLength(3);
  });
});

describe("probe", () => {
  it("records each probe request as test_connection usage and reports what was measured", async () => {
    const { h, fake, modelRef } = setup();
    fake.scriptProbe("stream", { result: "supported", latencyMs: 42, call: { outcome: "succeeded", usage: FAKE_USAGE } });
    fake.scriptProbe("structuredOutput", { result: "unsupported", call: { outcome: "failed" } });
    const outcome = await h.llm.probe(LOCAL.userId, modelRef, signal());
    expect(outcome).toEqual({ observed: { stream: "supported", structuredOutput: "unsupported", tools: "supported" }, latencyMs: 42 });
    const rows = usageRows(h);
    expect(rows.map((row) => [row.feature, row.outcome, row.inputTokens])).toEqual([
      ["test_connection", "succeeded", 12],
      ["test_connection", "failed", undefined],
      ["test_connection", "succeeded", 12],
    ]);
    expect(rows[1]).not.toHaveProperty("inputTokens");
  });

  it("retries only the failing check, never re-sending completed ones", async () => {
    const { h, fake, modelRef } = setup();
    fake.scriptProbe(
      "tools",
      { error: amberError("llm_failed"), call: { outcome: "failed" } },
      { error: amberError("llm_failed", "down", { code: "llm_failed.unreachable" }) },
      { result: "unsupported", call: { outcome: "succeeded", usage: FAKE_USAGE } },
    );
    const outcome = await h.llm.probe(LOCAL.userId, modelRef, signal());
    expect(outcome.observed.tools).toBe("unsupported");
    expect(fake.probeRuns).toEqual({ stream: 1, structuredOutput: 1, tools: 3 });
    // The before-send failure reported no call and left no row.
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["succeeded", "succeeded", "failed", "succeeded"]);
  });

  it("keeps the rows of earlier checks when a later check finally fails", async () => {
    const { h, fake, modelRef } = setup();
    fake.scriptProbe("tools", { error: amberError("llm_failed", "bad key", { code: "llm_failed.auth" }), call: { outcome: "failed" } });
    expect(await codeOf(h.llm.probe(LOCAL.userId, modelRef, signal()))).toBe("llm_failed.auth");
    expect(fake.probeRuns).toEqual({ stream: 1, structuredOutput: 1, tools: 1 });
    expect(usageRows(h).map((row) => [row.feature, row.outcome])).toEqual([
      ["test_connection", "succeeded"],
      ["test_connection", "succeeded"],
      ["test_connection", "failed"],
    ]);
  });

  it("checks the profile and credential before probing", async () => {
    const { h, fake, modelRef } = setup();
    h.db.prepare("UPDATE provider_profile SET credential_ref = NULL WHERE id = ?").run(modelRef.providerProfileId);
    expect(await codeOf(h.llm.probe(LOCAL.userId, modelRef, signal()))).toBe("llm_unconfigured");
    expect(fake.probeRuns).toEqual({ stream: 0, structuredOutput: 0, tools: 0 });
  });
});

describe("both protocols through the gateway", () => {
  it("normalize the equivalent fixtures to the same text, stop reason and usage, events in order", async () => {
    let harness: Harness | undefined;
    const secrets = { reveal: (owner: string, ref: string): string => (harness as Harness).secrets.reveal(owner, ref) };
    const openAiHttp = new ReplayHttp(() => ({ status: 200, body: openAiStream("equivalent") }), 5);
    const anthropicHttp = new ReplayHttp(() => ({ status: 200, body: anthropicFixture("equivalent.sse") }), 11);
    harness = createHarness({
      llmProviders: [
        new OpenAiCompatibleProvider({ http: openAiHttp, secrets, files: { read: async function* () {} } }),
        new AnthropicMessagesProvider({ http: anthropicHttp, secrets }),
      ],
    });
    open.push(harness);
    const openAiRef = configureLlm(harness);
    const anthropicRef = configureLlm(harness);
    harness.db.prepare("UPDATE provider_profile SET protocol = 'anthropic_messages', base_url = 'https://llm.invalid' WHERE id = ?").run(anthropicRef.providerProfileId);

    const run = async (modelRef: ModelRef): Promise<LlmStreamEvent[]> => {
      const events: LlmStreamEvent[] = [];
      for await (const event of (harness as Harness).llm.stream(CHAT, { ...EQUIVALENT_REQUEST, modelRef }, { signal: signal() })) {
        events.push(event);
      }
      return events;
    };
    const normalized = (events: LlmStreamEvent[]) => {
      const kinds = events.map((event) => event.type);
      // `text_delta*` → `usage?` → `done`, done exactly once and last; delta counts may differ.
      expect(kinds.join(" ")).toMatch(/^(text_delta )*(usage )?done$/);
      const usage = events.find((event) => event.type === "usage");
      const done = events.at(-1);
      return {
        text: events.map((event) => (event.type === "text_delta" ? event.delta : "")).join(""),
        stopReason: done?.type === "done" ? done.stopReason : undefined,
        usage: usage?.type === "usage" ? { inputTokens: usage.usage.inputTokens, outputTokens: usage.usage.outputTokens } : undefined,
      };
    };
    const viaOpenAi = normalized(await run(openAiRef));
    const viaAnthropic = normalized(await run(anthropicRef));
    expect(viaOpenAi).toEqual(EQUIVALENT_GOLDEN);
    expect(viaAnthropic).toEqual(EQUIVALENT_GOLDEN);
    expect(openAiHttp.requests[0]?.url).toBe("https://llm.invalid/v1/chat/completions");
    expect(anthropicHttp.requests[0]?.url).toBe("https://llm.invalid/v1/messages");
    expect(usageRows(harness).map(({ modelRef, inputTokens, outputTokens, outcome }) => [modelRef.providerProfileId, inputTokens, outputTokens, outcome])).toEqual([
      [openAiRef.providerProfileId, 42, 23, "succeeded"],
      [anthropicRef.providerProfileId, 42, 23, "succeeded"],
    ]);
  });
});

describe("fair LLM slots", () => {
  /** Logs every adapter call and probe check by label, in the order slots were granted. */
  function observe(fake: FakeLlmProvider, hold: ReadonlySet<string> = new Set()) {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const stream = fake.stream.bind(fake);
    fake.stream = (req, opts) => {
      const label = String(req.system);
      log.push(label);
      if (!hold.has(label)) {
        return stream(req, opts);
      }
      return (async function* () {
        await new Promise<void>((resolve) => gates.set(label, resolve));
        yield* reply("held");
      })();
    };
    const probe = fake.probe.bind(fake);
    fake.probe = (profile, modelId) =>
      probe(profile, modelId).map((check) => ({
        ...check,
        run: (context) => {
          log.push(`probe:${check.flag}`);
          return check.run(context);
        },
      }));
    const release = async (label: string): Promise<void> => {
      await waitUntil(() => gates.has(label));
      gates.get(label)?.();
    };
    return { log, release };
  }
  const waitUntil = async (check: () => boolean): Promise<void> => {
    for (let round = 0; !check(); round += 1) {
      if (round > 200) {
        throw new Error("condition not reached");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const labelled = (modelRef: ModelRef, label: string): LlmRequest => request(modelRef, { system: label });
  const taskCall = (h: Harness, modelRef: ModelRef, taskId: string, label: string, userId = LOCAL.userId) =>
    h.llm.complete({ userId, feature: "summary", taskId }, labelled(modelRef, label), {
      signal: signal(),
      task: { createdAt: taskOf(h, taskId, userId).createdAt, id: taskId },
    });

  it("gives a chat the next free slot while a Task has five requests queued, and keeps one user's chats and probes in one group", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    const { log, release } = observe(fake, new Set(["task:0"]));
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 1 });
    const calls = [0, 1, 2, 3, 4, 5].map((n) => taskCall(h, modelRef, taskId, `task:${n}`));
    await waitUntil(() => log.length === 1);
    const chats = [1, 2].map((n) => h.llm.complete(CHAT, labelled(modelRef, `chat:${n}`), { signal: signal() }));
    const probed = h.llm.probe(LOCAL.userId, modelRef, signal());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(log).toEqual(["task:0"]);
    await release("task:0");
    await Promise.all([...calls, ...chats, probed]);
    // One foreground group alternates with the Task group. Separate groups per chat or
    // probe would have put chat:2 and the probe ahead of task:1. The probe's later checks
    // are asked one by one, each after the previous one ended.
    expect(log).toEqual([
      "task:0",
      "chat:1",
      "task:1",
      "chat:2",
      "task:2",
      "probe:stream",
      "task:3",
      "probe:structuredOutput",
      "task:4",
      "probe:tools",
      "task:5",
    ]);
  });

  it("rotates three Tasks on one lane as three groups, while another user's lane is not held up at all", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    const bobRef = configureLlm(h, BOB.userId);
    const { log, release } = observe(fake, new Set(["a1:0"]));
    const a1 = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 1 });
    const a2 = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 2 });
    const a3 = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 3 });
    const b1 = createTaskOfKind(h, "regenerate_summary", { modelRef: bobRef }, { createdAt: 4, userId: BOB.userId });
    const calls = [taskCall(h, modelRef, a1, "a1:0")];
    await waitUntil(() => log.length === 1);
    for (const n of [1, 2]) {
      calls.push(taskCall(h, modelRef, a1, `a1:${n}`));
    }
    for (const n of [0, 1, 2]) {
      calls.push(taskCall(h, modelRef, a2, `a2:${n}`), taskCall(h, modelRef, a3, `a3:${n}`));
    }
    // Bob's profile is a lane of its own: his calls go out while user A's lane is held.
    const bobCalls = [0, 1, 2].map((n) => taskCall(h, bobRef, b1, `b1:${n}`, BOB.userId));
    await Promise.all(bobCalls);
    expect(log.filter((label) => label.startsWith("b1"))).toEqual(["b1:0", "b1:1", "b1:2"]);
    expect(log.filter((label) => label.startsWith("a"))).toEqual(["a1:0"]);
    await release("a1:0");
    await Promise.all(calls);
    // On one lane the fair unit is the Task.
    expect(log.filter((label) => label.startsWith("a"))).toEqual(["a1:0", "a2:0", "a3:0", "a1:1", "a2:1", "a3:1", "a1:2", "a2:2", "a3:2"]);
  });

  it("holds no slot during a chat's retry backoff and queues the retry in the same foreground group", async () => {
    const fake = new FakeLlmProvider();
    const h = createHarness({ llmProviders: [fake] });
    open.push(h);
    const modelRef = configureLlm(h);
    let endBackoff: () => void = () => undefined;
    let backingOff = false;
    const gateway = new LlmGateway({
      repository: h.repository,
      secrets: h.secrets,
      providers: [fake],
      sleep: () => {
        backingOff = true;
        return new Promise<void>((resolve) => {
          endBackoff = resolve;
        });
      },
    });
    pinWindow(gateway, modelRef, 1);
    const { log, release } = observe(fake, new Set(["t1"]));
    // A server error: retried by policy, but no reason for the lane to cool down.
    fake.script({ events: [], error: amberError("llm_failed") });
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 1 });
    const task = { createdAt: 1, id: taskId };
    const call = (label: string, options: { task?: typeof task } = {}) =>
      gateway.complete(options.task === undefined ? CHAT : { ...CHAT, feature: "summary", taskId }, labelled(modelRef, label), { signal: signal(), ...options });

    const chat1 = call("chat1");
    await waitUntil(() => backingOff);
    // The slot is free while chat1 backs off: a Task call gets it at once.
    const t1 = call("t1", { task });
    await waitUntil(() => log.includes("t1"));
    const chat2 = call("chat2");
    const t2 = call("t2", { task });
    endBackoff();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await release("t1");
    await Promise.all([chat1, t1, chat2, t2]);
    // chat1's retry waits behind chat2 in the user's one foreground group; as a group of its
    // own it would have gone before t2.
    expect(log).toEqual(["chat1", "t1", "chat2", "t2", "chat1"]);
  });
});

describe("model lanes", () => {
  /** A gateway on the harness's state with its own clock and no cooldown spread. */
  function laneGateway(h: Harness, fake: FakeLlmProvider, logger?: Logger) {
    const clock = { now: 1_000_000 };
    const sleeps: number[] = [];
    const gateway = new LlmGateway({
      repository: h.repository,
      secrets: h.secrets,
      providers: [fake],
      ...(logger === undefined ? {} : { logger }),
      now: () => clock.now,
      random: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { gateway, clock, sleeps };
  }
  /** A scripted call that waits for its gate, then answers or fails. */
  function held(outcome: { error?: unknown } = {}) {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const step = () =>
      (async function* () {
        await opened;
        if (outcome.error !== undefined) {
          throw outcome.error;
        }
        yield* reply("ok");
      })();
    return { step, open };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));
  /** A call of a real Task, so it is not retried here and its usage row has a valid Task. */
  const inTask = (h: Harness, modelRef: ModelRef) => {
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    return { attribution: { ...CHAT, feature: "summary" as const, taskId }, task: { createdAt: taskOf(h, taskId).createdAt, id: taskId } };
  };

  it("cools a lane down on a rate limit: waiting Task calls are deferred unsent, foreground calls fail with the wait, and afterwards one goes at a time", async () => {
    const { h, fake, modelRef } = setup();
    const { gateway, clock, sleeps } = laneGateway(h, fake);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 1 });
    const task = { createdAt: 1, id: taskId };
    const taskCall = (label: string) => gateway.complete({ ...CHAT, feature: "summary", taskId }, request(modelRef, { system: label }), { signal: signal(), task });
    const limited = held({ error: amberError("llm_rate_limited") });
    const second = held();
    const third = held();
    fake.script(limited.step, second.step, third.step);
    const inFlight = [taskCall("a"), taskCall("b"), taskCall("c")];
    await settle();
    // The window (LLM_WINDOW_INITIAL) is full: these wait.
    const waitingTask = taskCall("d");
    const waitingChat = gateway.complete(CHAT, request(modelRef, { system: "chat" }), { signal: signal() });
    await settle();
    expect(fake.calls).toHaveLength(3);

    limited.open();
    const failure = await inFlight[0]!.catch((error: unknown) => error);
    // The Task's own failure carries how long the lane now waits.
    expect(isAmberError(failure) && failure.appError).toMatchObject({
      code: "llm_rate_limited.retry_after",
      retryDisposition: "policy",
      details: { retryAfterMs: 5000 },
    });
    const deferred = await waitingTask.catch((error: unknown) => error);
    expect(deferred).toBeInstanceOf(LlmCallDeferred);
    expect((deferred as LlmCallDeferred).notBefore).toBe(clock.now + 5000);
    const chatFailure = await waitingChat.catch((error: unknown) => error);
    expect(isAmberError(chatFailure) && chatFailure.appError).toMatchObject({ code: "llm_rate_limited.retry_after", details: { retryAfterMs: 5000 } });
    expect(sleeps).toEqual([]);
    // New calls are turned away at once while it cools down, without a gateway retry.
    await expect(taskCall("e")).rejects.toBeInstanceOf(LlmCallDeferred);
    expect(fake.calls).toHaveLength(3);

    // Answers of the old round neither widen the window nor end the cooldown.
    second.open();
    third.open();
    await Promise.all(inFlight.slice(1));
    clock.now += 5000;
    const next = held();
    fake.script(next.step);
    const after = [taskCall("f"), taskCall("g")];
    await settle();
    expect(fake.calls.map((call) => call.request.system)).toEqual(["a", "b", "c", "f"]);
    next.open();
    await Promise.all(after);
    expect(fake.calls.map((call) => call.request.system)).toEqual(["a", "b", "c", "f", "g"]);
    // Only requests that were sent are recorded.
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["failed", "succeeded", "succeeded", "succeeded", "succeeded"]);
  });


  it("logs every lane change with its profile and model identifiers", async () => {
    const { h, fake, modelRef } = setup();
    const entries: Array<{ message: string; fields?: LogFields }> = [];
    const logger: Logger = {
      debug: (message, fields) => void entries.push({ message, ...(fields === undefined ? {} : { fields }) }),
      info: (message, fields) => void entries.push({ message, ...(fields === undefined ? {} : { fields }) }),
      warn: () => undefined,
      error: () => undefined,
      child: () => logger,
    };
    const { gateway } = laneGateway(h, fake, logger);
    fake.script({ events: [], error: amberError("llm_rate_limited") });

    expect(await codeOf(gateway.complete(inTask(h, modelRef).attribution, request(modelRef), { signal: signal() }))).toBe("llm_rate_limited.retry_after");

    for (const message of ["llm_lane_window", "llm_lane_cooldown"]) {
      expect(entries.find((entry) => entry.message === message)?.fields).toMatchObject(modelRef);
    }
  });

  it("keeps lanes apart: a cooling model does not hold up another model of the same profile", async () => {
    const { h, fake, modelRef } = setup();
    h.db.prepare("INSERT INTO model_capability (profile_id, model_id, position, flags_declared_json, limits_declared_json) SELECT profile_id, 'model-b', 1, flags_declared_json, limits_declared_json FROM model_capability WHERE profile_id = ?").run(modelRef.providerProfileId);
    const other: ModelRef = { ...modelRef, modelId: "model-b" };
    const { gateway } = laneGateway(h, fake);
    fake.script({ events: [], error: amberError("llm_rate_limited") });
    const { attribution } = inTask(h, modelRef);
    expect(await codeOf(gateway.complete(attribution, request(modelRef), { signal: signal() }))).toBe("llm_rate_limited.retry_after");
    expect(await codeOf(gateway.complete(CHAT, request(modelRef), { signal: signal() }))).toBe("llm_rate_limited.retry_after");
    await expect(gateway.complete(CHAT, request(other), { signal: signal() })).resolves.toMatchObject({ text: "ok" });
  });

  it("starts a changed profile over on a new lane, which an old call's late rate limit does not reach", async () => {
    const { h, fake, modelRef } = setup();
    const { gateway } = laneGateway(h, fake);
    const late = held({ error: amberError("llm_rate_limited") });
    fake.script(late.step);
    const old = gateway.complete(inTask(h, modelRef).attribution, request(modelRef), { signal: signal() });
    await settle();
    gateway.profileChanged(modelRef.providerProfileId);
    late.open();
    expect(await codeOf(old)).toBe("llm_rate_limited.retry_after");
    await expect(gateway.complete(CHAT, request(modelRef), { signal: signal() })).resolves.toMatchObject({ text: "ok" });
  });

  it("builds a deferred request only once admitted, checks it, then calls onCallStart and the adapter", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    const order: string[] = [];
    const first = held();
    fake.script(first.step);
    const occupying = h.llm.complete(CHAT, request(modelRef), { signal: signal() });
    await settle();
    const deferred = h.llm.complete(
      inTask(h, modelRef).attribution,
      {
        modelRef,
        prepare: async () => {
          order.push("prepare");
          return request(modelRef, { system: "prepared" });
        },
      },
      { signal: signal(), onCallStart: () => order.push("start") },
    );
    await settle();
    expect(order).toEqual([]);
    first.open();
    await Promise.all([occupying, deferred]);
    expect(order).toEqual(["prepare", "start"]);
    expect(fake.calls.at(-1)?.request.system).toBe("prepared");
  });

  it("records nothing and frees the lane when preparing fails or the prepared request asks for what the model cannot take", async () => {
    const { h, fake, modelRef } = setup({ window: 1 });
    let started = 0;
    const failing = h.llm.complete(
      inTask(h, modelRef).attribution,
      {
        modelRef,
        prepare: async () => {
          throw amberError("internal", "clip failed");
        },
      },
      { signal: signal(), onCallStart: () => (started += 1) },
    );
    expect(await codeOf(failing)).toBe("internal");
    const audio = h.llm.complete(
      inTask(h, modelRef).attribution,
      { modelRef, prepare: async () => request(modelRef, { messages: [{ role: "user", content: [{ type: "audio", mimeType: "audio/wav", dataRef: "tmp/a.wav" }] }] }) },
      { signal: signal(), onCallStart: () => (started += 1) },
    );
    expect(await codeOf(audio)).toBe("llm_capability");
    expect(started).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(usageRows(h)).toEqual([]);
    await expect(h.llm.complete(CHAT, request(modelRef), { signal: signal() })).resolves.toMatchObject({ text: "ok" });
  });

  it("cools down on an overload without shrinking the window, and passes the wait on", async () => {
    const { h, fake, modelRef } = setup();
    const { gateway } = laneGateway(h, fake);
    fake.script({ events: [], error: amberError("llm_failed", "busy", { code: "llm_failed.overloaded" }) });
    const failure = await gateway.complete(inTask(h, modelRef).attribution, request(modelRef), { signal: signal() }).catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError).toMatchObject({ code: "llm_failed.overloaded", retryDisposition: "policy", details: { retryAfterMs: 5000 } });
    const lane = lanesOf(gateway).get(modelRef);
    expect({ window: lane.window, limited: lane.limited }).toEqual({ window: 3, limited: false });
  });

  it("does not let quota, ambiguous-limit or other upstream errors cool the lane", async () => {
    const { h, fake, modelRef } = setup();
    const { gateway } = laneGateway(h, fake);
    fake.script(
      { events: [], error: amberError("llm_failed", "quota", { code: "llm_failed.quota" }) },
      { events: [], error: amberError("llm_failed", "ambiguous", { code: "llm_failed.limit_ambiguous" }) },
      { events: [], error: amberError("llm_failed", "server error") },
    );
    const { attribution } = inTask(h, modelRef);
    expect(await codeOf(gateway.complete(attribution, request(modelRef), { signal: signal() }))).toBe("llm_failed.quota");
    expect(await codeOf(gateway.complete(attribution, request(modelRef), { signal: signal() }))).toBe("llm_failed.limit_ambiguous");
    expect(await codeOf(gateway.complete(attribution, request(modelRef), { signal: signal() }))).toBe("llm_failed");
    expect(lanesOf(gateway).get(modelRef).coolingUntil()).toBeUndefined();
  });
});
