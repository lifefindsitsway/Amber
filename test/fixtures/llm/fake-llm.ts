import type { LlmProtocol } from "../../../src/shared/enums.ts";
import type { LlmRequest, LlmStreamEvent, RawUsage } from "../../../src/server/domain/llm.ts";
import type { ProviderProfile } from "../../../src/server/domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../src/server/domain/usage.ts";
import type { LlmProbeCall, LlmProbeCheck, LlmProbeInconclusiveReason, LlmProbeKind, LlmProvider, LlmStreamOptions } from "../../../src/server/ports/llm-provider.ts";

/**
 * One scripted adapter call: events to yield, optionally followed by a thrown error. Like a
 * real adapter, the fake reports the request start first; `noStart` scripts a call that
 * failed before the request could be sent.
 */
export type FakeLlmStep =
  | { events: readonly LlmStreamEvent[]; error?: unknown; delayMs?: number; noStart?: boolean }
  | ((request: LlmRequest, opts: LlmStreamOptions) => AsyncIterable<LlmStreamEvent>);

/**
 * One scripted probe check: the calls to report (each one crossed the send boundary), then a
 * result or an error. `status` is the basic call's result, `result` a capability check's.
 */
export type FakeProbeStep = (
  | { status: "connected" | "incomplete"; latencyMs?: number }
  | { result: "supported" | "unsupported" | "inconclusive"; reason?: LlmProbeInconclusiveReason; latencyMs?: number }
  | { error: unknown }
) & { call?: LlmProbeCall | readonly LlmProbeCall[] };

export const FAKE_USAGE: RawUsage = { inputTokens: 12, outputTokens: 5, rawJson: '{"prompt_tokens":12,"completion_tokens":5}' };

/** `text_delta*` → `usage?` → `done` for a successful reply; `null` usage sends no usage event. */
export function reply(text: string, usage: RawUsage | null = FAKE_USAGE): LlmStreamEvent[] {
  return [
    ...[...text].map((delta): LlmStreamEvent => ({ type: "text_delta", delta })),
    ...(usage === null ? [] : [{ type: "usage", usage } satisfies LlmStreamEvent]),
    { type: "done", stopReason: "stop" },
  ];
}

/**
 * Scriptable LlmProvider. Each `stream` call takes the next scripted step (a default reply
 * when none is left) and records the request and options it received; each probe check
 * takes the next step of its kind.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly protocol: LlmProtocol;
  readonly audioMimeTypes: readonly string[];
  readonly calls: Array<{ request: LlmRequest; opts: LlmStreamOptions }> = [];
  readonly probeRuns: Record<LlmProbeKind, number> = { basic: 0, stream: 0, structuredOutput: 0, tools: 0 };
  private readonly steps: FakeLlmStep[] = [];
  private readonly probeSteps: Record<LlmProbeKind, FakeProbeStep[]> = { basic: [], stream: [], structuredOutput: [], tools: [] };
  /** Called whenever a stream starts or ends, to observe concurrency. */
  onActive?: (delta: 1 | -1) => void;
  /** What the request-start reports carry: the key version in force and the send time (now when unset). */
  credential = { versionId: "key-version-1", setAt: 1_000 };
  sentAt: number | undefined;
  /** Every request start reported, streams and probe requests alike. */
  readonly requestStarts: RequestStartInfo[] = [];

  constructor(options: { protocol?: LlmProtocol; audioMimeTypes?: readonly string[] } = {}) {
    this.protocol = options.protocol ?? "openai_compatible";
    this.audioMimeTypes = options.audioMimeTypes ?? [];
  }

  script(...steps: FakeLlmStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  scriptProbe(kind: LlmProbeKind, ...steps: FakeProbeStep[]): this {
    this.probeSteps[kind].push(...steps);
    return this;
  }

  private requestInfo(): RequestStartInfo {
    const info = { sentAt: this.sentAt ?? Date.now(), credential: { ...this.credential } };
    this.requestStarts.push(info);
    return info;
  }

  stream(request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.calls.push({ request, opts });
    const step = this.steps.shift() ?? { events: reply("ok") };
    const fake = this;
    if (typeof step === "function") {
      return (async function* () {
        opts.onRequestStart(fake.requestInfo());
        yield* step(request, opts);
      })();
    }
    return (async function* () {
      if (step.noStart !== true) {
        opts.onRequestStart(fake.requestInfo());
      }
      fake.onActive?.(1);
      try {
        if (step.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        }
        yield* step.events;
        if (step.error !== undefined) {
          throw step.error;
        }
      } finally {
        fake.onActive?.(-1);
      }
    })();
  }

  probe(_profile: ProviderProfile, _modelId: string): readonly LlmProbeCheck[] {
    const kinds: LlmProbeKind[] = ["basic", "stream", "structuredOutput", "tools"];
    return kinds.map((kind) => ({
      kind,
      run: async ({ onCall, onRequestStart }) => {
        this.probeRuns[kind] += 1;
        const fallback: FakeProbeStep =
          kind === "basic" ? { status: "connected", call: { outcome: "succeeded", usage: FAKE_USAGE } } : { result: "supported", call: { outcome: "succeeded", usage: FAKE_USAGE } };
        const step = this.probeSteps[kind].shift() ?? fallback;
        const calls = step.call === undefined ? [] : Array.isArray(step.call) ? step.call : [step.call as LlmProbeCall];
        // Each request that crossed the send boundary reports its start first.
        for (const call of calls) {
          onRequestStart(this.requestInfo());
          onCall(call);
        }
        if ("error" in step) {
          throw step.error;
        }
        const latencyMs = step.latencyMs ?? 7;
        if ("status" in step) {
          if (kind !== "basic") {
            throw new Error(`a status was scripted for the ${kind} check`);
          }
          return { kind, status: step.status, latencyMs };
        }
        if (kind === "basic") {
          throw new Error("a capability result was scripted for the basic call");
        }
        return { kind, result: step.result, ...(step.reason === undefined ? {} : { reason: step.reason }), latencyMs };
      },
    }));
  }
}
