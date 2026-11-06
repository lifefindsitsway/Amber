import { ASR_TEST_AUDIO_MS, ASR_TEST_POLL_INTERVAL_MS, ASR_TEST_TIMEOUT_MS } from "../../shared/defaults.ts";
import type { AsrModelTestResultDto } from "../../shared/dto/asr-profile.ts";
import type { AsrModelFamily } from "../../shared/asr-presets.ts";
import type { CanonicalAsrResult } from "../domain/asr.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import type { AsrProviderProfile } from "../domain/provider-profile.ts";
import type { TerminologyEntry } from "../domain/terminology.ts";
import { testToneWav } from "../domain/test-audio.ts";
import type { AsrJobOutcome, RequestStartInfo, UsageOutcome } from "../domain/usage.ts";
import {
  isAsrJobProvider,
  type AsrJobHandle,
  type AsrJobProvider,
  type AsrJobReport,
  type AsrJobStatus,
  type AsrProviderFactory,
  type AsrSyncProvider,
  type AsrTranscribeInput,
} from "../ports/asr-provider.ts";
import type { FileStore } from "../ports/file-store.ts";

/** Scratch directory of model tests; a file there never outlives the request that wrote it. */
export const ASR_TEST_SCRATCH_DIR = "tmp/asr-test";

/** Characters of the recognized text a test answer shows. */
const TEXT_PREVIEW_CHARS = 100;
/** The language hint a test sends: the parameter every family accepts. */
const TEST_LANGUAGE = "zh";
/** The single hot word a family that takes terminology receives, so a refused parameter shows up in the test. */
const TEST_TERM: TerminologyEntry = { id: "test", ordinal: 0, term: "Amber", normalizedKey: "amber" };

export interface AsrModelTestDeps {
  files: Pick<FileStore, "writeAtomic" | "remove">;
  newId: () => string;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Passed to the adapter: notes the send time, key version and price as the paid request leaves. */
  onRequestStart: (info: RequestStartInfo) => void;
  /**
   * Records the one usage row of the test once a paid request may have been sent, together
   * with what `onRequestStart` noted, and returns the row's id. `jobOutcome` is given only
   * where the request itself is the whole job (a synchronous provider).
   */
  recordUsage: (usage: { outcome: UsageOutcome; jobId?: string; jobOutcome?: AsrJobOutcome }) => string;
  /** Completes a job's usage row with the provider's report of its remote end state. */
  fillJobReport: (usageId: string, report: AsrJobReport) => void;
}

export interface AsrModelTestRun {
  factory: AsrProviderFactory;
  profile: AsrProviderProfile;
  modelId: string;
  family: AsrModelFamily;
  signal: AbortSignal;
}

export type AsrModelTestOutcome = Pick<AsrModelTestResultDto, "result" | "textPreview" | "latencyMs" | "remoteCancelled">;

/** A job accepted but not finished in time, and whether the provider confirmed cancelling it. */
interface AcceptedJob {
  accepted: { remoteCancelled: boolean };
}

/**
 * "Test connection" of one ASR model: a generated `ASR_TEST_AUDIO_MS` tone,
 * written to a scratch file and removed afterwards, goes through the same adapter path as a
 * Task's transcription with the family's parameters. A sync provider answers directly; a
 * job is queried every `ASR_TEST_POLL_INTERVAL_MS` until `ASR_TEST_TIMEOUT_MS` after the
 * start, then cancelled best-effort and reported `accepted` (with `remoteCancelled` when the
 * provider confirmed the cancellation, which also completes the usage row). "No speech" from the provider
 * still proves the model runs. Never retried: each run is one user-triggered paid call.
 */
export async function runAsrModelTest(deps: AsrModelTestDeps, run: AsrModelTestRun): Promise<AsrModelTestOutcome> {
  const ref = `${ASR_TEST_SCRATCH_DIR}/${deps.newId()}.wav`;
  try {
    const stored = await deps.files.writeAtomic(ref, testToneWav(ASR_TEST_AUDIO_MS));
    const input: AsrTranscribeInput = {
      audio: { storageRef: ref, mimeType: "audio/wav", sizeBytes: stored.sizeBytes, durationMs: ASR_TEST_AUDIO_MS },
      language: TEST_LANGUAGE,
      terminology: run.family.terminology ? [TEST_TERM] : [],
    };
    const provider = run.factory.create(run.profile, run.modelId);
    const started = deps.now();
    const result = isAsrJobProvider(provider) ? await testJob(deps, provider, input, run.signal, started) : await testSync(deps, provider, input, run.signal);
    const latencyMs = Math.max(0, deps.now() - started);
    if (result === "no_speech") {
      return { result, latencyMs };
    }
    if (typeof result === "object" && "accepted" in result) {
      return { result: "accepted", latencyMs, ...(result.accepted.remoteCancelled ? { remoteCancelled: true } : {}) };
    }
    return { result: "transcribed", textPreview: previewOf(result), latencyMs };
  } finally {
    await deps.files.remove(ref).catch(() => undefined);
  }
}

async function testSync(deps: AsrModelTestDeps, provider: AsrSyncProvider, input: AsrTranscribeInput, signal: AbortSignal): Promise<CanonicalAsrResult | "no_speech"> {
  let result: CanonicalAsrResult;
  try {
    result = await provider.transcribe(input, { signal, onRequestStart: deps.onRequestStart });
  } catch (error) {
    if (isNoSpeech(error)) {
      // The provider processed the sound and found no speech: a completed call.
      deps.recordUsage({ outcome: "succeeded", jobOutcome: "succeeded" });
      return "no_speech";
    }
    const outcome = failedOutcome(error, signal);
    if (outcome !== undefined) {
      deps.recordUsage({ outcome, ...(outcome === "outcome_unknown" ? {} : { jobOutcome: outcome }) });
    }
    throw error;
  }
  deps.recordUsage({ outcome: "succeeded", jobOutcome: "succeeded" });
  return result;
}

async function testJob(
  deps: AsrModelTestDeps,
  provider: AsrJobProvider,
  input: AsrTranscribeInput,
  signal: AbortSignal,
  started: number,
): Promise<CanonicalAsrResult | "no_speech" | AcceptedJob> {
  let sent = false;
  let handle: AsrJobHandle;
  try {
    handle = await provider.submit(input, {
      signal,
      onRequestStart: (info) => {
        sent = true;
        deps.onRequestStart(info);
      },
    });
  } catch (error) {
    // Only a failure after the creating request was on its way can have been billed.
    const outcome = sent ? failedOutcome(error, signal) : undefined;
    if (outcome !== undefined) {
      deps.recordUsage({ outcome });
    }
    throw error;
  }
  const usageId = deps.recordUsage({ outcome: "succeeded", jobId: handle.jobId });
  for (;;) {
    if (deps.now() - started + ASR_TEST_POLL_INTERVAL_MS > ASR_TEST_TIMEOUT_MS) {
      let remoteCancelled = false;
      try {
        remoteCancelled = (await provider.cancel?.(handle, { signal })) === "cancelled";
      } catch {
        // Best-effort: the job was accepted, which is what the test reports either way.
      }
      if (remoteCancelled) {
        // Only a confirmed cancellation says anything about the remote job; a failed or
        // unsupported one leaves its state, and its billing, unknown.
        deps.fillJobReport(usageId, { remote: "cancelled" });
      }
      return { accepted: { remoteCancelled } };
    }
    await deps.sleep(ASR_TEST_POLL_INTERVAL_MS, signal);
    let status: AsrJobStatus;
    try {
      status = await provider.poll(handle, { signal, onJobReport: (report) => deps.fillJobReport(usageId, report) });
    } catch (error) {
      if (isNoSpeech(error)) {
        return "no_speech";
      }
      throw error;
    }
    switch (status.state) {
      case "pending":
        continue;
      case "missing":
        throw amberError("asr_failed", "the test job is not known to the provider", { code: "asr_failed.job_expired" });
      case "done":
        return status.result;
    }
  }
}

function isNoSpeech(error: unknown): boolean {
  return isAmberError(error) && error.appError.class === "media_no_audio";
}

/**
 * Usage outcome of a failed call, or `undefined` when nothing was sent; the same rule as
 * the asr stage: a `safe` failure never left, an unclassified one aborted mid-way may have
 * been billed.
 */
function failedOutcome(error: unknown, signal: AbortSignal): UsageOutcome | undefined {
  if (isAmberError(error)) {
    if (error.appError.retryDisposition === "safe") {
      return undefined;
    }
    return error.appError.retryDisposition === "outcome_unknown" ? "outcome_unknown" : "failed";
  }
  return signal.aborted ? "outcome_unknown" : "failed";
}

/** The recognized text, the provider's own whole text first, else its segments joined. */
function previewOf(result: CanonicalAsrResult): string {
  const whole = result.text.trim();
  const text =
    whole !== ""
      ? whole
      : result.segments
          .map((segment) => segment.text.trim())
          .filter((segment) => segment !== "")
          .join(" ");
  return Array.from(text).slice(0, TEXT_PREVIEW_CHARS).join("");
}
