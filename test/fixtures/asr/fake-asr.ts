import type { CanonicalAsrResult } from "../../../src/server/domain/asr.ts";
import { amberError } from "../../../src/server/domain/errors.ts";
import type { RequestStartInfo } from "../../../src/server/domain/usage.ts";
import type { AsrProviderProfile } from "../../../src/server/domain/provider-profile.ts";
import type {
  AsrJobCancelOutcome,
  AsrJobHandle,
  AsrJobReport,
  AsrJobStatus,
  AsrProbeResult,
  AsrProvider,
  AsrProviderCapabilities,
  AsrProviderDescriptor,
  AsrProviderFactory,
  AsrSubmitOptions,
  AsrTranscribeInput,
} from "../../../src/server/ports/asr-provider.ts";
import { asrModelFamily } from "../../../src/shared/asr-presets.ts";

/** Generous limits, so only tests that lower them hit the local checks. */
export const FAKE_ASR_CAPABILITIES: AsrProviderCapabilities & { delivery: "sync" } = {
  wordTimestamps: true,
  segmentTimestamps: false,
  terminologyBias: true,
  maxFileBytes: 5 * 1024 ** 3,
  maxDurationSec: 10 * 3600,
  maxTerminologyEntries: 1000,
  maxTerminologyTermChars: 49,
  maxTerminologyWords: 5,
  chunkingStrategy: "providerManaged",
  delivery: "sync",
};

/** A short Chinese result whose words line up with its two sentences. */
export function fakeAsrResult(overrides: Partial<CanonicalAsrResult> = {}): CanonicalAsrResult {
  return {
    text: "欢迎来到生成式软件工程。今天讲提示词。",
    language: "zh",
    segments: [
      { startMs: 0, endMs: 1200, text: "欢迎来到生成式软件工程。" },
      { startMs: 1500, endMs: 2600, text: "今天讲提示词。" },
    ],
    words: [
      { text: "欢迎", startMs: 0, endMs: 300 },
      { text: "来到", startMs: 300, endMs: 600 },
      { text: "生成式软件工程。", startMs: 600, endMs: 1200 },
      { text: "今天", startMs: 1500, endMs: 1800 },
      { text: "讲", startMs: 1800, endMs: 2000 },
      { text: "提示词。", startMs: 2000, endMs: 2600 },
    ],
    provider: "fake",
    model: "fake-model",
    durationMs: 2600,
    ...overrides,
  };
}

export interface FakeAsrCall {
  input: AsrTranscribeInput;
  profileId: string;
  modelId: string;
  /** The request family the model resolved to, as a real adapter would pick its parameters by. */
  family: string;
}

/** What a scripted job submission does: hand out a job, fail, or run a custom step. */
export type FakeSubmitOutcome = "job" | Error | ((opts: AsrSubmitOptions) => Promise<AsrJobHandle>);

/**
 * A scripted ASR provider factory: each `transcribe` takes the next scripted outcome (the
 * last one repeats) and is logged with the terminology it received. Nothing goes online.
 * With `delivery = "job"` the providers it creates are job providers instead: `submit`
 * takes the next of `submitOutcomes` (a failing one first reports the paid call as started
 * unless `failBeforeSend`), `poll` the next of `pollOutcomes`, both repeating the last.
 * Like the real adapters, `create` refuses a model not on the profile or whose family does
 * not resolve with `asr_failed.model_unavailable`.
 */
export class FakeAsrFactory implements AsrProviderFactory {
  readonly descriptor: AsrProviderDescriptor = { provider: "elevenlabs", baseUrlPolicy: "any", endpoints: [{ id: "default", baseURL: "https://asr.example.test" }], models: ["scribe_v2", "fake-model"], recommendedModels: ["scribe_v2"], defaultModel: "scribe_v2", families: [{ id: "fake_basic", terminology: false }, { id: "fake", terminology: true }], customModelFamily: "fake_basic", knownModels: { scribe_v2: "fake", "fake-model": "fake" }, diarization: {} };
  readonly calls: FakeAsrCall[] = [];
  readonly probes: string[] = [];
  capabilities: AsrProviderCapabilities = { ...FAKE_ASR_CAPABILITIES };
  delivery: "sync" | "job" = "sync";
  readonly submits: FakeAsrCall[] = [];
  readonly polls: AsrJobHandle[] = [];
  readonly cancels: AsrJobHandle[] = [];
  submitOutcomes: FakeSubmitOutcome[] = ["job"];
  pollOutcomes: Array<AsrJobStatus | Error> = [{ state: "done", result: fakeAsrResult() }];
  cancelOutcome: AsrJobCancelOutcome | Error = "cancelled";
  /**
   * The remote end state each `poll` reports before it answers, in the order of `pollOutcomes`
   * (the last repeats; `undefined` reports nothing), as a real adapter's `onJobReport` would.
   */
  pollReports: Array<AsrJobReport | undefined> = [];
  /** What `onRequestStart` is called with: the key version in force and the send time (now when unset). */
  credential = { versionId: "key-version-1", setAt: 1_000 };
  sentAt: number | undefined;
  /** Every request start the fake providers reported. */
  readonly requestStarts: RequestStartInfo[] = [];
  /** A failing scripted submission fails before the paid request (nothing billed). */
  failBeforeSend = false;
  private jobs = 0;
  outcomes: Array<CanonicalAsrResult | Error | (() => Promise<CanonicalAsrResult>)> = [fakeAsrResult()];
  probeOutcome: AsrProbeResult | Error = { subscriptionStatus: "active", usedUnits: 10, limitUnits: 100 };
  /** Progress each `transcribe` reports, in order, before taking its outcome. */
  progressSteps: number[] = [];

  private requestInfo(): RequestStartInfo {
    const info = { sentAt: this.sentAt ?? Date.now(), credential: { ...this.credential } };
    this.requestStarts.push(info);
    return info;
  }

  create(profile: AsrProviderProfile, modelId: string): AsrProvider {
    const entry = profile.models.find((model) => model.modelId === modelId);
    const family = entry === undefined ? undefined : asrModelFamily(this.descriptor, entry);
    if (family === undefined) {
      throw amberError("asr_failed", "the model has no request family the fake supports", { code: "asr_failed.model_unavailable" });
    }
    if (this.delivery === "job") {
      return this.createJob(profile, modelId, family.id);
    }
    return {
      id: "fake",
      capabilities: { ...this.capabilities, delivery: "sync" },
      transcribe: async (input, opts) => {
        this.calls.push({ input, profileId: profile.id, modelId, family: family.id });
        for (const step of this.progressSteps) {
          opts.onProgress?.(step);
        }
        const outcome = this.outcomes[Math.min(this.calls.length - 1, this.outcomes.length - 1)];
        opts.onRequestStart(this.requestInfo());
        if (outcome instanceof Error) {
          throw outcome;
        }
        return typeof outcome === "function" ? outcome() : (outcome as CanonicalAsrResult);
      },
    };
  }

  private createJob(profile: AsrProviderProfile, modelId: string, family: string): AsrProvider {
    return {
      id: "fake",
      capabilities: { ...this.capabilities, delivery: "job" },
      submit: async (input, opts) => {
        this.submits.push({ input, profileId: profile.id, modelId, family });
        for (const step of this.progressSteps) {
          opts.onProgress?.(step);
        }
        const outcome = this.submitOutcomes[Math.min(this.submits.length - 1, this.submitOutcomes.length - 1)];
        if (typeof outcome === "function") {
          return outcome(opts);
        }
        if (outcome instanceof Error) {
          if (!this.failBeforeSend) {
            opts.onRequestStart(this.requestInfo());
          }
          throw outcome;
        }
        opts.onRequestStart(this.requestInfo());
        this.jobs += 1;
        return { version: 1, provider: "fake", jobId: `job-${this.jobs}`, submittedAt: Date.now() };
      },
      poll: async (handle, opts) => {
        this.polls.push(handle);
        const index = Math.min(this.polls.length - 1, this.pollOutcomes.length - 1);
        const outcome = this.pollOutcomes[index] as AsrJobStatus | Error;
        const report = this.pollReports[Math.min(index, this.pollReports.length - 1)];
        if (report !== undefined) {
          opts.onJobReport?.(report);
        }
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
      cancel: async (handle) => {
        this.cancels.push(handle);
        if (this.cancelOutcome instanceof Error) {
          throw this.cancelOutcome;
        }
        return this.cancelOutcome;
      },
    };
  }

  async probe(profile: AsrProviderProfile): Promise<AsrProbeResult> {
    this.probes.push(profile.id);
    if (this.probeOutcome instanceof Error) {
      throw this.probeOutcome;
    }
    return this.probeOutcome;
  }
}
