import type { LlmProtocol } from "../../../src/shared/enums.ts";
import type { LlmRequest, LlmStreamEvent, RawUsage } from "../../../src/server/domain/llm.ts";
import type { ProviderProfile } from "../../../src/server/domain/provider-profile.ts";
import type { RequestStartInfo } from "../../../src/server/domain/usage.ts";
import type { LlmProbeCall, LlmProbeCheck, LlmProbeFlag, LlmProvider, LlmStreamOptions } from "../../../src/server/ports/llm-provider.ts";

/**
 * One scripted adapter call: events to yield, optionally followed by a thrown error. Like a
 * real adapter, the fake reports the request start first; `noStart` scripts a call that
 * failed before the request could be sent.
 */
export type FakeLlmStep =
  | { events: readonly LlmStreamEvent[]; error?: unknown; delayMs?: number; noStart?: boolean }
  | ((request: LlmRequest, opts: LlmStreamOptions) => AsyncIterable<LlmStreamEvent>);

/** One scripted probe request: the call to report (if it crossed the send boundary), then a result or an error. */
export type FakeProbeStep =
  | { result: "supported" | "unsupported"; latencyMs?: number; call?: LlmProbeCall }
  | { error: unknown; call?: LlmProbeCall };

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
 * takes the next step of its flag.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly protocol: LlmProtocol;
  readonly audioMimeTypes: readonly string[];
  readonly calls: Array<{ request: LlmRequest; opts: LlmStreamOptions }> = [];
  readonly probeRuns: Record<LlmProbeFlag, number> = { stream: 0, structuredOutput: 0, tools: 0 };
  private readonly steps: FakeLlmStep[] = [];
  private readonly probeSteps: Record<LlmProbeFlag, FakeProbeStep[]> = { stream: [], structuredOutput: [], tools: [] };
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

  scriptProbe(flag: LlmProbeFlag, ...steps: FakeProbeStep[]): this {
    this.probeSteps[flag].push(...steps);
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
    const flags: LlmProbeFlag[] = ["stream", "structuredOutput", "tools"];
    return flags.map((flag) => ({
      flag,
      run: async ({ onCall, onRequestStart }) => {
        this.probeRuns[flag] += 1;
        const step = this.probeSteps[flag].shift() ?? { result: "supported", call: { outcome: "succeeded", usage: FAKE_USAGE } };
        // A request that crossed the send boundary reports its start first.
        if (step.call !== undefined) {
          onRequestStart(this.requestInfo());
          onCall(step.call);
        }
        if ("error" in step) {
          throw step.error;
        }
        return { result: step.result, latencyMs: step.latencyMs ?? 7 };
      },
    }));
  }
}
