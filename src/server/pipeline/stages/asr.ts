import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { asrModelFamily } from "../../../shared/asr-presets.ts";
import {
  ASR_JOB_MAX_WAIT_HOURS,
  ASR_KEYTERMS_MAX,
  ASR_POLL_INTERVAL_MAX_MS,
  ASR_POLL_INTERVAL_MS,
  RETRY_MAX,
  SPEAKERS_PER_CONTENT_MAX,
} from "../../../shared/defaults.ts";
import type { DiarizationRequest } from "../../../shared/dto/speaker.ts";
import type { SegmentId } from "../../../shared/ids.ts";
import { BYTES_PER_GB } from "../../../shared/units.ts";
import { ASR_AWAIT_UNIT_KEY, ASR_SUBMIT_UNIT_KEY } from "../../../shared/work-steps.ts";
import {
  assignWordsAcrossSpeakers,
  parseAsrSubmitRecord,
  truncateTerminologyForAsr,
  type AsrSubmitRecord,
  type CanonicalAsrResult,
} from "../../domain/asr.ts";
import { decideDiarization, persistedDecision, type DiarizationDecision } from "../../domain/asr-diarization.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import type { Content } from "../../domain/content.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import type { MediaAsset } from "../../domain/media-asset.ts";
import type { AsrProviderProfile } from "../../domain/provider-profile.ts";
import type { TerminologyEntry } from "../../domain/terminology.ts";
import { canonicalLanguageTag } from "../../domain/subtitle-file.ts";
import { taskRequestView } from "../../domain/task-request.ts";
import { revisionTakesPrimary, type AsrDiarizationRecord, type TranscriptRevision, type TranscriptSegment, type TranscriptWord } from "../../domain/transcript.ts";
import type { AsrJobOutcome, UsageOutcome } from "../../domain/usage.ts";
import type { WorkUnit } from "../../domain/task.ts";
import {
  isAsrJobProvider,
  type AsrJobHandle,
  type AsrJobProvider,
  type AsrJobReport,
  type AsrProvider,
  type AsrProviderFactory,
  type AsrSyncProvider,
} from "../../ports/asr-provider.ts";
import type { FileStore } from "../../ports/file-store.ts";
import type { Logger } from "../../ports/logger.ts";
import type { LocalMediaIngest } from "../../ports/local-media-ingest.ts";
import type { Repository, RepositoryScope } from "../../ports/repository.ts";
import { captureAsrSend, fillAsrJobReport, type AsrSendContext } from "../asr-usage.ts";
import { UnitDeferred, type StageExecutionContext, type StageExecutor, type StageOutcome, type UnitIdentity } from "../executor.ts";
import type { MediaFiles } from "../media-files.ts";
import { ensureExtractedAudio } from "./extracted-audio.ts";
import { platformTarget, taskContent, type PlatformAccess } from "./platform-access.ts";
import { span } from "./progress.ts";
import { availableMediaSource, taskScratchRef } from "./source-media.ts";

export interface AsrStageDeps {
  repository: Repository;
  /** The data store: audio and checkpoints live here. */
  files: FileStore;
  /** Where the source media is read from by its kind; defaults to `files` for every kind. */
  media?: Pick<MediaFiles, "storeFor">;
  ingest: LocalMediaIngest;
  /** Platform Contents without a cached video download their audio through here. */
  platforms?: PlatformAccess;
  /** The factory implementing a profile's provider; composed from the adapters. */
  asr(provider: AsrProviderProfile["provider"]): AsrProviderFactory | undefined;
  /** Diagnostics only: never keys, URLs, upstream text or transcript content. */
  logger?: Logger;
  now?: () => number;
  newId?: () => string;
  /** Source of the polling jitter; `Math.random` by default. */
  random?: () => number;
}

/**
 * The stage's progress segments, one per step in order: the platform audio
 * download ends at `ASR_FETCH_PROGRESS_END`, the extraction at `ASR_EXTRACT_PROGRESS_END`,
 * and the upload and transcription fill the rest. Without a download (a local file or a
 * cached video) the extraction takes the download's share too. A step whose output
 * already exists is skipped, so the bar starts at the segment of the first step that runs.
 */
const ASR_FETCH_PROGRESS_END = 0.4;
const ASR_EXTRACT_PROGRESS_END = 0.5;
/**
 * Where a job's upload and submission end. The wait for its result moves nothing, so the
 * bar stops short of full until the result is published rather than sitting at 100%.
 */
const ASR_JOB_SUBMITTED_PROGRESS = 0.9;
const SECONDS_PER_HOUR = 3600;
const MS_PER_HOUR = 3_600_000;
/** Growth of the interval between two state queries of a job. */
const POLL_BACKOFF_FACTOR = 1.5;
/** A provider-named wait is honoured up to this many longest polling intervals. */
const RETRY_AFTER_CAP_FACTOR = 10;
/** Relative spread of a polling wait, both ways. */
const POLL_JITTER = 0.1;

/**
 * Codes with which a job ended for good on the provider's side: a re-run after one of them
 * submits the audio again rather than taking the ended job over.
 */
export const JOB_ENDED_CODES: ReadonlySet<string> = new Set([
  "asr_failed.job_failed",
  "asr_failed.job_expired",
  "asr_failed.invalid_audio",
  "media_no_audio",
]);

/** What one run of the stage submits: the bound profile and model, the Content, the terminology to send and the audio, taken on demand. */
interface Submission {
  context: StageExecutionContext;
  profile: AsrProviderProfile;
  modelId: string;
  content: Content;
  terminology: TerminologyEntry[];
  audio: () => Promise<{ asset: MediaAsset; audioMs: number }>;
  /**
   * Whether this submission identifies speakers. Undecided only when a job's submission is
   * re-entered after it was made, which never takes the audio or sends anything again.
   */
  diarization: DiarizationDecision | undefined;
}

function checkpointRefOf(taskId: string, unit: Pick<UnitIdentity, "id">): string {
  return `${taskScratchRef(taskId)}/asr-${unit.id}.json`;
}

/** The checkpoint as read back from disk; written by this stage from the provider's result. */
const checkpointSchema = z.object({
  text: z.string(),
  language: z.string(),
  segments: z.array(
    z.object({ startMs: z.number(), endMs: z.number(), text: z.string(), speakerId: z.string().exactOptional() }),
  ),
  words: z.array(z.object({ text: z.string(), startMs: z.number(), endMs: z.number(), speakerId: z.string().exactOptional() })).exactOptional(),
  provider: z.string(),
  model: z.string(),
  rawResponseRef: z.string().exactOptional(),
  durationMs: z.number(),
});

export interface Sentence {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
}

const CJK_EDGE_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const CJK_EDGE_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The `asr` stage of `process_content` and `retranscribe`, run with the ASR
 * model the stage is bound to. Audio is taken on demand once the requirement holds and
 * the whole file goes to the provider. A synchronous provider answers in one paid,
 * file-backed WorkUnit; a job provider is submitted once (`asr:submit`, keeping the job
 * handle) and its job awaited (`asr:await`). Either way the provider-neutral result is the
 * checkpoint under `tmp/tasks/<taskId>/`: a crash after the result reached the disk, a
 * confirmed re-send or a re-run of the stage then publishes from that file instead of
 * paying again. Every submission that crossed the send boundary is recorded as usage on
 * its own, right after the call.
 *
 * The published revision is the immutable `asr` original, with real word timing
 * (`exact_words`) when the provider returned usable words and sentence timing only
 * (`segment_only`) otherwise; words are assigned to sentences by their midpoint. It becomes
 * primary only when there is no primary yet or the current primary is itself a root revision
 * (`platform` or `asr`), so manual, imported and corrected revisions stay.
 */
export class AsrStageExecutor implements StageExecutor {
  private readonly deps: AsrStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly random: () => number;

  constructor(deps: AsrStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
    this.random = deps.random ?? Math.random;
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const content = taskContent(repository, context);
    const owner = content.userId;
    const ref = context.asrModelRef;
    const profile = ref === undefined ? undefined : repository.withTransaction((scope) => scope.asrProfiles.get(owner, ref.asrProfileId));
    const entry = ref === undefined ? undefined : profile?.models.find((model) => model.modelId === ref.modelId);
    if (ref === undefined || profile?.credentialRef === undefined || entry === undefined) {
      throw amberError("asr_unconfigured", "no ASR profile with a credential listing the bound model");
    }
    const factory = this.deps.asr(profile.provider);
    if (factory === undefined) {
      throw amberError("internal", "no ASR adapter for the profile's provider");
    }
    // A model whose request family no longer resolves stays on the profile for the user to
    // remove, but cannot transcribe.
    if (asrModelFamily(factory.descriptor, entry) === undefined) {
      throw amberError("asr_failed", "the bound model has no request family the provider supports", { code: "asr_failed.model_unavailable" });
    }
    const { modelId } = ref;
    const provider = factory.create(profile, modelId);
    // A job submitted in this attempt is never submitted again: its unit keeps the digest it
    // was submitted under, whatever the terminology or language became since.
    const anchored = isAsrJobProvider(provider) ? this.submittedUnit(owner, context) : undefined;
    const audio = this.audioOnDemand(context);
    const requested = taskRequestView(context.task.requestJson).diarization;
    let diarization: DiarizationDecision | undefined;
    if (anchored === undefined) {
      const { asset, audioMs } = await audio();
      checkProviderLimits(provider, asset, audioMs);
      // Decided on the audio actually extracted and before anything is sent: a request that
      // insists on speaker identification never reaches the provider without it.
      diarization = decideDiarization(requested, provider.capabilities.diarization, audioMs);
      if (requested?.mode === "required" && !diarization.effective) {
        throw amberError("asr_failed", "speaker identification was required but cannot be done", {
          code: "asr_failed.diarization_unavailable",
          details: { reason: diarization.reason ?? "unsupported" },
        });
      }
    }

    const effective = repository.withTransaction((scope) => scope.terminology.effectiveFor(owner, content.id));
    const reasons: string[] = [];
    const biased = provider.capabilities.terminologyBias;
    const terms = truncateTerminologyForAsr(biased ? effective : [], provider.capabilities, ASR_KEYTERMS_MAX);
    if (!biased && effective.length > 0) {
      reasons.push("terminology_not_applied");
    }
    if (terms.droppedTooLong > 0 || terms.cutOff > 0) {
      reasons.push("terminology_truncated");
    }
    const digestBase = {
      audio: this.audioSource(content),
      language: content.rawLanguage ?? null,
      terms: terms.entries.map((entry) => entry.term),
      asrProfileId: profile.id,
      provider: profile.provider,
      model: modelId,
      // The endpoint is part of the job's identity: a job is only known where it was submitted.
      baseURL: profile.baseURL ?? null,
      // Part of the request's identity only when identification takes place, so a request
      // without it keeps the digest it always had.
      ...(diarization?.effective === true ? { diarization: { speakerCount: diarization.speakerCount ?? null } } : {}),
    };
    const submission: Submission = { context, profile, modelId, content, terminology: terms.entries, audio, diarization };
    const transcribed = isAsrJobProvider(provider)
      ? await this.transcribeAsJob(provider, submission, anchored?.inputDigest ?? digestOf(canonicalJson({ ...digestBase, submissionGeneration: this.submissionGeneration(owner, context) })))
      : { result: await this.transcribeAtOnce(provider, submission, digestOf(canonicalJson(digestBase))), diarization };
    const { result } = transcribed;

    const { revision, segments, merged, droppedWords } = this.buildRevision(content, profile, modelId, result, requested, transcribed.diarization);
    if (merged > 0) {
      reasons.push("asr_segment_merged");
    }
    if (droppedWords > 0) {
      reasons.push("speaker_overlap_words_dropped");
    }
    if (revision.timingFidelity === "segment_only" && provider.capabilities.wordTimestamps) {
      reasons.push("asr_words_dropped");
    }
    const language = revision.language;
    return {
      resultJson: {
        revisionId: revision.id,
        reasons,
        terminology: { sent: terms.entries.length, droppedTooLong: terms.droppedTooLong, cutOff: terms.cutOff },
        ...(droppedWords > 0 ? { speakerOverlapWordsDropped: droppedWords } : {}),
      },
      publish: (scope) => {
        const published = this.registerSpeakers(scope, content, segments);
        if (published.truncated && !reasons.includes("speakers_truncated")) {
          reasons.push("speakers_truncated");
        }
        scope.transcripts.insertRevision(owner, finalRevision(revision, published.segments), published.segments);
        const current = scope.contents.getIncludingTrashed(owner, content.id);
        const primary =
          current?.primaryTranscriptRevisionId === undefined ? undefined : scope.transcripts.getRevision(owner, current.primaryTranscriptRevisionId);
        if (revisionTakesPrimary(revision, primary)) {
          scope.contents.setPrimaryTranscript(owner, content.id, revision.id, this.now());
          scope.search.syncContent(owner, content.id);
        }
        this.writeRawLanguage(scope, content, language);
      },
    };
  }

  /**
   * The extracted audio, taken on first use and kept for the rest of the run. A job stage
   * re-entered after its submission never needs it.
   */
  private audioOnDemand(context: StageExecutionContext): () => Promise<{ asset: MediaAsset; audioMs: number }> {
    let taken: Promise<{ asset: MediaAsset; audioMs: number }> | undefined;
    return () => {
      taken ??= (async () => {
        const report = (progress: number): void => context.reportProgress(progress);
        const { asset } = await ensureExtractedAudio(context, {
          repository: this.deps.repository,
          files: this.deps.files,
          ...(this.deps.media === undefined ? {} : { media: this.deps.media }),
          ingest: this.deps.ingest,
          ...(this.deps.platforms === undefined ? {} : { platforms: this.deps.platforms }),
          now: this.now,
          newId: this.newId,
        }, {
          fetch: span(report, 0, ASR_FETCH_PROGRESS_END),
          extract: span(report, ASR_FETCH_PROGRESS_END, ASR_EXTRACT_PROGRESS_END),
          extractAlone: span(report, 0, ASR_EXTRACT_PROGRESS_END),
        });
        return { asset, audioMs: asset.durationMs ?? context.content?.durationMs ?? 0 };
      })();
      return taken;
    };
  }

  /** A synchronous provider: one paid, file-backed unit whose output is the result itself. */
  private async transcribeAtOnce(provider: AsrSyncProvider, submission: Submission, inputDigest: string): Promise<CanonicalAsrResult> {
    const { context } = submission;
    const taskId = context.task.id;
    const output = await context.runUnit({
      key: ASR_SUBMIT_UNIT_KEY,
      inputDigest,
      storage: "file",
      billing: "asr",
      checkpointRef: (unit: UnitIdentity) => checkpointRefOf(taskId, unit),
      run: async (signal: AbortSignal, unit: UnitIdentity) => {
        const result = await this.submit(provider, submission, signal);
        return this.writeCheckpoint(taskId, unit, result);
      },
    });
    return this.readCheckpoint(output.outputRef);
  }

  /**
   * A job provider: `asr:submit` uploads and creates the job once and keeps
   * its handle (DB-only, paid from the moment the creating request is sent); `asr:await`
   * asks for the job's state once per run and waits as `pending` in between, freeing the
   * Task slot, until the result is ready and written as the checkpoint. Queries are free,
   * so a crash while waiting just queries again.
   */
  private async transcribeAsJob(
    provider: AsrJobProvider,
    submission: Submission,
    inputDigest: string,
  ): Promise<{ result: CanonicalAsrResult; diarization: DiarizationDecision | undefined }> {
    const { context, profile } = submission;
    const taskId = context.task.id;
    const stored = await context.runUnit<AsrSubmitRecord>({
      key: ASR_SUBMIT_UNIT_KEY,
      inputDigest,
      billing: "asr",
      paidCallStart: "explicit",
      run: async (signal: AbortSignal, unit: UnitIdentity) => this.submitJob(provider, submission, signal, unit),
    });
    // Either form of the record: a handle alone (older) or a handle with its usage row.
    const record = parseAsrSubmitRecord(stored);
    if (record === undefined) {
      throw amberError("internal", "stored ASR job handle does not match its schema");
    }
    const { handle, usageId } = record;
    // The decision the job was submitted with outranks any made now; a record from before
    // decisions were kept was submitted without identification.
    const diarization: DiarizationDecision = record.diarization ?? submission.diarization ?? { effective: false, status: "off" };
    const owner = submission.content.userId;
    const output = await context.runUnit({
      key: ASR_AWAIT_UNIT_KEY,
      inputDigest: digestOf(canonicalJson({ jobId: handle.jobId, asrProfileId: profile.id })),
      storage: "file",
      checkpointRef: (unit: UnitIdentity) => checkpointRefOf(taskId, unit),
      run: async (signal: AbortSignal, unit: UnitIdentity) => {
        if (this.now() - handle.submittedAt > ASR_JOB_MAX_WAIT_HOURS * MS_PER_HOUR) {
          throw amberError("asr_failed", "the ASR job exceeded the longest wait", { code: "asr_failed.job_expired" });
        }
        // A remote end state completes the submission's usage row; a record without a row
        // (older, or never written) simply has nothing to complete.
        const onJobReport =
          usageId === undefined ? undefined : (report: AsrJobReport): void => fillAsrJobReport(this.deps.repository, this.deps.logger, owner, usageId, report);
        const status = await context.withHeavySlot(() => provider.poll(handle, { signal, ...(onJobReport === undefined ? {} : { onJobReport }) }));
        switch (status.state) {
          case "pending":
            throw new UnitDeferred(this.now() + asrPollDelayMs(unit.attempt, status.retryAfterMs, this.random), { resetRetries: true });
          case "missing":
            // A job may take a moment to become visible; a few answers are tolerated as
            // transient before the job counts as gone.
            if (unit.retryCount + 1 < RETRY_MAX) {
              throw amberError("asr_failed", "the ASR job is not known to the provider yet");
            }
            throw amberError("asr_failed", "the ASR job is not known to the provider", { code: "asr_failed.job_expired" });
          case "done":
            return this.writeCheckpoint(taskId, unit, status.result);
        }
      },
    });
    return { result: await this.readCheckpoint(output.outputRef), diarization };
  }

  /** The `asr:submit` unit this attempt already completed, if any. */
  private submittedUnit(owner: string, context: StageExecutionContext): WorkUnit | undefined {
    return this.deps.repository.withTransaction((scope) =>
      scope.workUnits
        .listByStageRun(owner, context.stageRun.id)
        .find((unit) => unit.key === ASR_SUBMIT_UNIT_KEY && unit.status === "succeeded"),
    );
  }

  /**
   * How many earlier attempts saw their job end for good on the provider's side. It is part
   * of the submission digest, so a re-run after such an end submits anew, while a re-run
   * after a local or transient failure takes the earlier job over instead of paying again.
   */
  private submissionGeneration(owner: string, context: StageExecutionContext): number {
    const taskId = context.task.id;
    return this.deps.repository.withTransaction((scope) => {
      const earlier = new Set(
        scope.stageRuns
          .listByTask(owner, taskId)
          .filter((run) => run.stage === context.stageRun.stage && run.attempt < context.stageRun.attempt)
          .map((run) => run.id),
      );
      return scope.workUnits
        .listByTask(owner, taskId)
        .filter(
          (unit) =>
            earlier.has(unit.stageRunId) &&
            unit.key === ASR_AWAIT_UNIT_KEY &&
            unit.status === "failed" &&
            unit.error !== undefined &&
            JOB_ENDED_CODES.has(unit.error.code),
        ).length;
    });
  }

  private async writeCheckpoint(taskId: string, unit: UnitIdentity, result: CanonicalAsrResult): Promise<{ outputRef: string; outputDigest: string }> {
    const outputRef = checkpointRefOf(taskId, unit);
    const written = await this.deps.files.writeAtomic(outputRef, Buffer.from(canonicalJson(result), "utf8"));
    return { outputRef, outputDigest: written.digest };
  }

  /** One paid submission, recorded as usage the moment it ends unless it never left. */
  private async submit(provider: AsrSyncProvider, submission: Submission, signal: AbortSignal): Promise<CanonicalAsrResult> {
    const { context, content, terminology, profile, modelId } = submission;
    const { asset, audioMs } = await submission.audio();
    const send = captureAsrSend(this.deps.repository, this.deps.logger, profile, modelId);
    let result: CanonicalAsrResult;
    try {
      result = await provider.transcribe(
        { audio: asset, terminology, ...languageOf(content), ...diarizationInput(submission.diarization) },
        { signal, onProgress: span((progress) => context.reportProgress(progress), ASR_EXTRACT_PROGRESS_END, 1), onRequestStart: send.onRequestStart },
      );
    } catch (error) {
      const outcome = failedOutcome(error, signal);
      if (outcome !== undefined) {
        this.recordUsage(submission, audioMs, outcome, send.context(), syncJobOutcome(outcome));
      }
      throw error;
    }
    this.recordUsage(submission, audioMs, "succeeded", send.context(), syncJobOutcome("succeeded"));
    return result;
  }

  /**
   * Creates the job. Only a failure after the creating request was on its way can have been
   * billed, so only then is usage recorded; the upload before it is free. The usage row's id
   * is chosen up front and returned with the handle, so the job's later end state can be
   * filled into that row.
   */
  private async submitJob(provider: AsrJobProvider, submission: Submission, signal: AbortSignal, unit: UnitIdentity): Promise<AsrSubmitRecord> {
    const { context, content, terminology, profile, modelId } = submission;
    const { asset, audioMs } = await submission.audio();
    const send = captureAsrSend(this.deps.repository, this.deps.logger, profile, modelId);
    let sent = false;
    let handle: AsrJobHandle;
    try {
      handle = await provider.submit(
        { audio: asset, terminology, ...languageOf(content), ...diarizationInput(submission.diarization) },
        {
          signal,
          onProgress: span((progress) => context.reportProgress(progress), ASR_EXTRACT_PROGRESS_END, ASR_JOB_SUBMITTED_PROGRESS),
          onRequestStart: (info) => {
            // From here a crash leaves the outcome unknown. A refusal to mark it means the
            // request must not be sent, so nothing counts as sent.
            unit.markPaidCallStart();
            sent = true;
            send.onRequestStart(info);
          },
        },
      );
    } catch (error) {
      const outcome = sent ? failedOutcome(error, signal) : undefined;
      if (outcome !== undefined) {
        this.recordUsage(submission, audioMs, outcome, send.context());
      }
      throw error;
    }
    const usageId = this.newId();
    this.recordUsage(submission, audioMs, "succeeded", send.context(), { id: usageId, jobId: handle.jobId });
    return {
      handle: { version: handle.version, provider: handle.provider, jobId: handle.jobId, submittedAt: handle.submittedAt },
      usageId,
      ...(submission.diarization === undefined ? {} : { diarization: persistedDecision(submission.diarization) }),
    };
  }

  /** One usage row; `extra` carries what only a job or a synchronous call knows (see `syncJobOutcome`). */
  private recordUsage(
    submission: Submission,
    audioMs: number,
    outcome: UsageOutcome,
    send: AsrSendContext | undefined,
    extra: { id?: string; jobId?: string; jobOutcome?: AsrJobOutcome } = {},
  ): void {
    const { context, profile, modelId, content } = submission;
    this.deps.repository.withTransaction((scope) =>
      scope.asrUsage.insert({
        id: extra.id ?? this.newId(),
        userId: content.userId,
        asrProfileId: profile.id,
        profileIdSnapshot: profile.id,
        profileNameSnapshot: profile.name,
        provider: profile.provider,
        model: modelId,
        feature: "transcribe",
        outcome,
        ...(extra.jobId === undefined ? {} : { jobId: extra.jobId }),
        ...(extra.jobOutcome === undefined ? {} : { jobOutcome: extra.jobOutcome }),
        audioMs,
        ...send,
        taskId: context.task.id,
        contentId: content.id,
        createdAt: this.now(),
      }),
    );
  }

  /**
   * What the audio is made from, stable across re-extraction and re-download: the original
   * or cached file's fingerprint, else the platform identity. The digest must not depend on
   * the extracted bytes, or a re-run after the Task's audio was cleaned up could never reuse
   * a paid result.
   */
  private audioSource(content: Content): string {
    const source = this.deps.repository.withTransaction((scope) => availableMediaSource(scope, content.userId, content.id));
    if (source !== undefined) {
      return source.fingerprint ?? `asset:${source.id}`;
    }
    const target = this.deps.platforms === undefined ? undefined : platformTarget(this.deps.platforms, content);
    if (target === undefined) {
      throw amberError("media_missing", "no media to transcribe");
    }
    return `platform:${target.adapter.kind}:${target.ref.platformContentId}:${target.ref.platformPartId ?? ""}`;
  }

  private async readCheckpoint(ref: string): Promise<CanonicalAsrResult> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.deps.files.read(ref)) {
      chunks.push(chunk);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      throw amberError("internal", `unreadable ASR checkpoint: ${String(error)}`);
    }
    const checked = checkpointSchema.safeParse(parsed);
    if (!checked.success) {
      throw amberError("internal", "ASR checkpoint does not match the canonical result");
    }
    return checked.data;
  }

  /**
   * The `asr` revision. Sentences are normalized deterministically before the segment
   * invariants are enforced (every committed segment carries a valid time range, since
   * citations point at it): blank ones are dropped (they carry no text), overlaps are clipped to the
   * previous end, and a sentence left without positive duration is merged into its
   * neighbour rather than dropped, so no recognized text is lost (a result whose only
   * sentence is instantaneous gets the shortest valid span). Words are then assigned
   * by midpoint to the surviving sentences.
   */
  private buildRevision(
    content: Content,
    profile: AsrProviderProfile,
    modelId: string,
    result: CanonicalAsrResult,
    requested: DiarizationRequest | undefined,
    decision: DiarizationDecision | undefined,
  ): { revision: TranscriptRevision; segments: TranscriptSegment[]; merged: number; droppedWords: number } {
    // An upstream that names speakers although none were asked for must not create any.
    const labelled = decision?.effective === true ? result : withoutSpeakers(result);
    const { sentences, merged } = normalizeSentences(labelled.segments);
    if (sentences.length === 0) {
      // Nothing recognizable was said; the closest existing meaning is "nothing to transcribe".
      throw amberError("media_no_audio", "the ASR result holds no speech");
    }
    const words = (labelled.words ?? [])
      .map((word) => ({
        text: word.text,
        startMs: Math.round(word.startMs),
        endMs: Math.round(word.endMs),
        ...(word.speakerId === undefined ? {} : { speakerId: word.speakerId }),
      }))
      .filter((word) => word.text.trim() !== "" && word.startMs >= 0 && word.startMs <= word.endMs);
    const { assigned, dropped } = assignWordsAcrossSpeakers(sentences, words);
    const revisionId = this.newId();
    const segments: TranscriptSegment[] = sentences.map((sentence, ordinal) => ({
      id: this.newId() as SegmentId,
      revisionId,
      ordinal,
      startMs: sentence.startMs,
      endMs: sentence.endMs,
      text: sentence.text,
      // Without usable words the revision claims sentence timing only and carries none. The
      // speaker labels only served to place words; a revision keeps text and times.
      ...(words.length > 0
        ? { words: (assigned[ordinal] as typeof words).map(({ text, startMs, endMs }): TranscriptWord => ({ text, startMs, endMs })) }
        : {}),
      // Still the provider's label here; `registerSpeakers` turns labels into identities at publish.
      ...(sentence.speakerId === undefined ? {} : { speakerId: sentence.speakerId }),
      sourceSegmentIds: [],
    }));
    const identified = sentences.some((sentence) => sentence.speakerId !== undefined);
    const revision: TranscriptRevision = {
      id: revisionId,
      contentId: content.id,
      kind: "asr",
      language: canonicalLanguageTag(result.language) ?? "und",
      timingFidelity: words.length > 0 ? "exact_words" : "segment_only",
      generation: { kind: "asr", asrProfileId: profile.id, modelId, diarization: diarizationRecord(requested, decision, identified) },
      segmentCount: segments.length,
      createdAt: this.now(),
    };
    return { revision, segments, merged, droppedWords: dropped };
  }

  /**
   * Turns the provider's speaker labels into identities: one new ULID per distinct label, in
   * order of first appearance, registered as the Content's speakers; the segments then carry
   * only those ids. Runs inside the publishing transaction, so the rows and the revision
   * that uses them are written together or not at all. Labels beyond the Content's room for
   * speakers stay unassigned.
   */
  private registerSpeakers(scope: RepositoryScope, content: Content, segments: readonly TranscriptSegment[]): { segments: TranscriptSegment[]; truncated: boolean } {
    const labels = [...new Set(segments.flatMap((segment) => (segment.speakerId === undefined ? [] : [segment.speakerId])))];
    if (labels.length === 0) {
      return { segments: [...segments], truncated: false };
    }
    const owner = content.userId;
    const room = Math.max(0, SPEAKERS_PER_CONTENT_MAX - scope.speakers.count(owner, content.id));
    const ids = new Map(labels.slice(0, room).map((label) => [label, this.newId()]));
    if (ids.size > 0) {
      scope.speakers.insert(owner, content.id, [...ids.values()].map((id) => ({ id })), this.now());
    }
    return {
      segments: segments.map((segment) => {
        if (segment.speakerId === undefined) {
          return segment;
        }
        const { speakerId: label, ...rest } = segment;
        const id = ids.get(label);
        return id === undefined ? rest : { ...rest, speakerId: id };
      }),
      truncated: labels.length > ids.size,
    };
  }

  private writeRawLanguage(scope: RepositoryScope, content: Content, language: string): void {
    if (language !== "und" && scope.contents.getIncludingTrashed(content.userId, content.id)?.rawLanguage === undefined) {
      scope.contents.setMetadata(content.userId, content.id, { rawLanguage: language }, this.now());
    }
  }
}

/** The result with every speaker label removed, from segments and words alike. */
function withoutSpeakers(result: CanonicalAsrResult): CanonicalAsrResult {
  return {
    ...result,
    segments: result.segments.map(({ speakerId: _label, ...rest }) => rest),
    ...(result.words === undefined ? {} : { words: result.words.map(({ speakerId: _label, ...rest }) => rest) }),
  };
}

/**
 * The revision as inserted: identification that took place but left no sentence with a
 * speaker (every label fell outside the Content's room) is recorded as `no_speakers`.
 */
function finalRevision(revision: TranscriptRevision, segments: readonly TranscriptSegment[]): TranscriptRevision {
  const { generation } = revision;
  if (generation.kind !== "asr" || generation.diarization?.status !== "applied" || segments.some((segment) => segment.speakerId !== undefined)) {
    return revision;
  }
  return { ...revision, generation: { ...generation, diarization: { ...generation.diarization, status: "no_speakers" } } };
}

/** What the revision records about speaker identification: the outcome, and the count asked for. */
function diarizationRecord(requested: DiarizationRequest | undefined, decision: DiarizationDecision | undefined, identified: boolean): AsrDiarizationRecord {
  const outcome = decision ?? { effective: false as const, status: "off" as const };
  const status = outcome.effective ? (identified ? "applied" : "no_speakers") : outcome.status;
  return {
    status,
    ...(requested === undefined || requested.mode === "off" || requested.speakerCount === undefined ? {} : { requestedSpeakerCount: requested.speakerCount }),
  };
}

/**
 * Waiting time before the next state query of a job, for the query run number `attempt`
 * (1-based): the provider's own wait, bounded, else a growing interval from
 * `ASR_POLL_INTERVAL_MS` up to `ASR_POLL_INTERVAL_MAX_MS`; either is spread by a jitter so
 * many waiting Tasks do not query in step.
 */
export function asrPollDelayMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  const base =
    retryAfterMs === undefined
      ? Math.min(ASR_POLL_INTERVAL_MAX_MS, ASR_POLL_INTERVAL_MS * POLL_BACKOFF_FACTOR ** Math.max(0, attempt - 1))
      : Math.min(Math.max(0, retryAfterMs), RETRY_AFTER_CAP_FACTOR * ASR_POLL_INTERVAL_MAX_MS);
  return Math.round(base * (1 + (random() * 2 - 1) * POLL_JITTER));
}

function languageOf(content: Content): { language?: string } {
  return content.rawLanguage === undefined ? {} : { language: content.rawLanguage };
}

/** The request's identification part: present only when this submission identifies speakers. */
function diarizationInput(decision: DiarizationDecision | undefined): { diarization?: { speakerCount?: number } } {
  if (decision?.effective !== true) {
    return {};
  }
  return { diarization: decision.speakerCount === undefined ? {} : { speakerCount: decision.speakerCount } };
}

/** Provider limits are checked locally before anything is sent; the audio is never degraded to fit. */
function checkProviderLimits(provider: AsrProvider, audio: MediaAsset, audioMs: number): void {
  const { maxFileBytes, maxDurationSec } = provider.capabilities;
  if (audio.sizeBytes > maxFileBytes) {
    throw amberError("media_too_large", "audio exceeds the provider's file limit", {
      params: { limit: `${Math.floor((maxFileBytes / BYTES_PER_GB) * 10) / 10} GB` },
    });
  }
  if (audioMs > maxDurationSec * 1000) {
    throw amberError("media_too_long", "audio exceeds the provider's duration limit", {
      params: { limit: `${Math.floor((maxDurationSec / SECONDS_PER_HOUR) * 10) / 10} h` },
    });
  }
}

/**
 * For a synchronous call the request is the whole job, so its end state is known when the
 * row is written; an unknown outcome stays unknown. A job's end state is never derived from
 * its creating request: it only ever comes from the provider's report.
 */
function syncJobOutcome(outcome: UsageOutcome): { jobOutcome?: AsrJobOutcome } {
  return outcome === "outcome_unknown" ? {} : { jobOutcome: outcome };
}

/**
 * Usage outcome of a failed submission, or `undefined` when nothing was sent: a failure
 * before the last chunk left is never billed. A failure the adapter did not classify is
 * counted as unknown once the call was aborted mid-way, since it may have been billed.
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

/**
 * Sentences ordered by start with the invariants enforced. Each speaker's sentences form a
 * stream of their own, and sentences without a speaker form one more: clipping to the
 * previous end and merging only ever happen inside a stream, so overlap between streams is
 * kept as recognized. Without speakers there is one stream and the rules are the plain
 * ones. The result is ordered by start, which per-stream clipping can disturb.
 */
export function normalizeSentences(raw: CanonicalAsrResult["segments"]): { sentences: Sentence[]; merged: number } {
  const ordered = raw
    .map((segment) => ({
      startMs: Math.max(0, Math.round(segment.startMs)),
      endMs: Math.round(segment.endMs),
      text: segment.text.trim(),
      ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
    }))
    .filter((segment) => segment.text !== "")
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => a.segment.startMs - b.segment.startMs || a.index - b.index)
    .map(({ segment }) => segment);
  const sentences: Sentence[] = [];
  // The latest sentence of each stream.
  const latest = new Map<string | undefined, Sentence>();
  const push = (sentence: Sentence): void => {
    sentences.push(sentence);
    latest.set(sentence.speakerId, sentence);
  };
  // Only a speakerless instant sentence with nothing before it waits to be merged into the
  // next speakerless one; a sentence of a speaker is never pulled into another's.
  let pending: Sentence | undefined;
  let merged = 0;
  for (const segment of ordered) {
    if (pending !== undefined && segment.speakerId !== undefined) {
      push({ ...pending, endMs: pending.startMs + 1 });
      pending = undefined;
    }
    const previous = latest.get(segment.speakerId);
    const startMs = previous === undefined ? segment.startMs : Math.max(segment.startMs, previous.endMs);
    let current: Sentence = { ...segment, startMs };
    if (pending !== undefined) {
      current = { ...current, startMs: Math.min(pending.startMs, current.startMs), text: joinText(pending.text, current.text) };
      pending = undefined;
    }
    if (current.endMs > current.startMs) {
      push(current);
      continue;
    }
    merged += 1;
    if (previous !== undefined) {
      previous.text = joinText(previous.text, current.text);
      previous.endMs = Math.max(previous.endMs, current.endMs);
    } else if (current.speakerId === undefined) {
      pending = current;
    } else {
      // Nothing of this speaker before it to merge into, and it must not pull a later
      // sentence's start earlier: it stays a sentence of its own, as short as is valid.
      push({ ...current, endMs: current.startMs + 1 });
    }
  }
  if (pending !== undefined) {
    // Everything recognized fits in one instant: the shortest valid span keeps the text
    // citable (start < end) without moving its start.
    push({ ...pending, endMs: pending.startMs + 1 });
  }
  // A stable sort: already ordered input (no speakers) is left exactly as it is.
  sentences.sort((a, b) => a.startMs - b.startMs);
  return { sentences, merged };
}

/** Joins texts without a space between two CJK characters, with one otherwise. */
function joinText(left: string, right: string): string {
  return CJK_EDGE_END.test(left) && CJK_EDGE_START.test(right) ? `${left}${right}` : `${left} ${right}`;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
