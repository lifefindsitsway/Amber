import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ASR_PRESETS, asrDiarizationSupport, asrModelFamily } from "../../../../shared/asr-presets.ts";
import { ASR_HTTP_TIMEOUT_MIN, ASR_RESULT_MAX_MB } from "../../../../shared/defaults.ts";
import { asrJobHandleSchema, type CanonicalAsrResult } from "../../../domain/asr.ts";
import { amberError } from "../../../domain/errors.ts";
import type { AsrProviderProfile } from "../../../domain/provider-profile.ts";
import type {
  AsrJobCancelOutcome,
  AsrJobHandle,
  AsrJobProvider,
  AsrJobReport,
  AsrJobStatus,
  AsrProbeResult,
  AsrProviderCapabilities,
  AsrProviderDescriptor,
  AsrProviderFactory,
  AsrSubmitOptions,
  AsrTranscribeInput,
} from "../../../ports/asr-provider.ts";
import type { FileStore } from "../../../ports/file-store.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../../ports/outbound-http.ts";
import type { SecretStore } from "../../../ports/secret-store.ts";
import { multipartStream } from "../shared/multipart.ts";
import { BodyTooLargeError, readBounded } from "../shared/read-bounded.ts";
import { httpError, jobError, retryAfterMs, transportError, upstreamError, type DashscopePhase } from "./errors.ts";
import { toDashscopeLanguageHint } from "./language.ts";
import { canonicalFromResultFile } from "./result.ts";

export { inferLanguage, toDashscopeLanguageHint } from "./language.ts";
export { canonicalFromResultFile } from "./result.ts";

export const DASHSCOPE_DESCRIPTOR: AsrProviderDescriptor = ASR_PRESETS.dashscope;

const BYTES_PER_MB = 1024 * 1024;
const MS_PER_MINUTE = 60_000;
/** Control requests (upload space, job state, cancellation) answer at once. */
const CONTROL_TIMEOUT_MS = 20_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 10_000;
const RESULT_TIMEOUT_MS = 5 * MS_PER_MINUTE;
/** Upload time grows with the file; allowing the playing time keeps long lectures within bounds. */
const UPLOAD_TIMEOUT_PER_AUDIO_MS = 1;
/** Control answers are small JSON documents; anything larger is not one. */
const CONTROL_BODY_MAX_BYTES = BYTES_PER_MB;
/** Share of the submission's progress given to the upload; the rest arrives with the job. */
const UPLOAD_PROGRESS_SHARE = 0.9;
/** Hot-word weight the service recommends; 50 (super hot words) is not used. */
const VOCABULARY_WEIGHT = 4;
/** Upload hosts and result links must belong to the service's storage. */
const ALIYUN_HOST_SUFFIX = ".aliyuncs.com";

/** What both recorded-file families share, per the service's documentation and live checks. */
const SHARED_CAPABILITIES = {
  wordTimestamps: true,
  segmentTimestamps: true,
  // The upload space `getPolicy` grants (1024 MB measured for both models), below the
  // service's own 2 GB; each submission checks the size the policy names again.
  maxFileBytes: 1024 * BYTES_PER_MB,
  maxDurationSec: 12 * 3600,
  chunkingStrategy: "providerManaged",
  delivery: "job",
} as const;

interface FamilySpec {
  capabilities: AsrProviderCapabilities & { delivery: "job" };
  /** Whether terminology goes out as `vocabulary` hot words. */
  vocabulary: boolean;
  /** `language_hints` values the family documents. */
  languageHints: ReadonlySet<string>;
}

/**
 * Static per-family declaration, keyed by the preset's family ids: the families share an
 * interface but not every parameter. Only `qwen-audio-3.x` accepts hot words inline;
 * `fun-asr` needs a pre-built vocabulary id, which Amber does not manage.
 */
const FAMILIES: Readonly<Record<string, FamilySpec>> = {
  qwen_audio: {
    capabilities: { ...SHARED_CAPABILITIES, terminologyBias: true, maxTerminologyEntries: 2000 },
    vocabulary: true,
    languageHints: new Set(["zh", "yue", "en", "ja", "ko", "de", "fr", "ru", "es", "it", "pt", "ar"]),
  },
  fun_asr: {
    capabilities: { ...SHARED_CAPABILITIES, terminologyBias: false },
    vocabulary: false,
    languageHints: new Set(["zh", "en", "ja"]),
  },
};

/** The spec of a model of the profile, by its family; any other model is unavailable. */
function modelSpec(profile: AsrProviderProfile, modelId: string): FamilySpec {
  const entry = profile.models.find((model) => model.modelId === modelId);
  const family = entry === undefined ? undefined : asrModelFamily(DASHSCOPE_DESCRIPTOR, entry);
  const spec = family !== undefined && Object.hasOwn(FAMILIES, family.id) ? FAMILIES[family.id] : undefined;
  if (spec === undefined) {
    throw amberError("asr_failed", "the model has no request family this adapter supports", { code: "asr_failed.model_unavailable" });
  }
  return spec;
}

export interface DashscopeAsrProviderFactoryOptions {
  http: OutboundHttpClient;
  files: Pick<FileStore, "read">;
  secrets: Pick<SecretStore, "reveal" | "revealVersioned">;
  now?: () => number;
  newId?: () => string;
}

/**
 * Alibaba Cloud Model Studio (DashScope) recorded-file recognition: an asynchronous job
 * per file, fed through the service's temporary upload space. Everything named after the
 * service stays in this directory. Invariant: callers see `CanonicalAsrResult` only.
 */
export class DashscopeAsrProviderFactory implements AsrProviderFactory {
  readonly descriptor = DASHSCOPE_DESCRIPTOR;
  private readonly options: DashscopeAsrProviderFactoryOptions;

  constructor(options: DashscopeAsrProviderFactoryOptions) {
    this.options = options;
  }

  create(profile: AsrProviderProfile, modelId: string): AsrJobProvider {
    return new DashscopeAsrProvider(profile, modelId, modelSpec(profile, modelId), this.options);
  }

  /**
   * Asking for upload space is free and needs a valid key; model access is proven by the
   * first job. The request names the preset's default model, whatever models the profile
   * lists and in whatever order, so reordering never changes what the check does.
   */
  async probe(profile: AsrProviderProfile, signal: AbortSignal): Promise<AsrProbeResult> {
    await new DashscopeClient(profile, this.options).uploadPolicy(this.descriptor.defaultModel, signal);
    return {};
  }
}

const policySchema = z.object({
  data: z.object({
    policy: z.string().min(1),
    signature: z.string().min(1),
    upload_dir: z.string().min(1),
    upload_host: z.string().min(1),
    max_file_size_mb: z.number().positive(),
    oss_access_key_id: z.string().min(1),
    x_oss_object_acl: z.string().min(1),
    x_oss_forbid_overwrite: z.string().min(1),
  }),
});
type UploadPolicy = z.infer<typeof policySchema>["data"];

const submitSchema = z.object({ output: z.object({ task_id: z.string().min(1) }) });

const taskSchema = z.object({
  output: z.object({
    task_status: z.string().min(1),
    code: z.string().optional(),
    message: z.string().optional(),
    results: z
      .array(
        z.object({
          subtask_status: z.string().optional(),
          transcription_url: z.string().optional(),
          code: z.string().optional(),
          message: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

interface CallOptions {
  /** `false` for the storage upload and the signed result link, which carry their own authorization. */
  authorized?: boolean;
  /**
   * The authorization to send instead of revealing the key again: for the one paid request,
   * whose key was already revealed and reported with its version.
   */
  authorization?: string;
  limitBytes?: number;
}

interface Answer {
  response: OutboundResponse;
  text: string;
}

const SUBTASK_SUCCEEDED = "SUCCEEDED";
const NOT_FOUND = 404;
const TOO_MANY_REQUESTS = 429;
const BAD_REQUEST = 400;

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

type TaskResult = NonNullable<z.infer<typeof taskSchema>["output"]["results"]>[number];

/** Requests of one profile: base URL, key, bounded answers and the error matrix by phase. */
class DashscopeClient {
  private readonly profile: AsrProviderProfile;
  private readonly options: DashscopeAsrProviderFactoryOptions;
  readonly now: () => number;

  constructor(profile: AsrProviderProfile, options: DashscopeAsrProviderFactoryOptions) {
    this.profile = profile;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get baseUrl(): string {
    const fallback = (DASHSCOPE_DESCRIPTOR.endpoints[0] as { baseURL: string }).baseURL;
    return (this.profile.baseURL ?? fallback).replace(/\/+$/, "");
  }

  /** Revealed per call and dropped with the request; never logged or put in an error. */
  private authorization(): string {
    if (this.profile.credentialRef === undefined) {
      throw amberError("asr_unconfigured", "ASR profile has no credential");
    }
    return `Bearer ${this.options.secrets.reveal(this.profile.userId, this.profile.credentialRef)}`;
  }

  /**
   * The authorization of the paid request together with the version of the key behind it.
   * The caller reports the version and sends exactly this authorization, so what is
   * recorded is what was sent.
   */
  paidAuthorization(): { authorization: string; version: { versionId: string; setAt: number } } {
    if (this.profile.credentialRef === undefined) {
      throw amberError("asr_unconfigured", "ASR profile has no credential");
    }
    const { plaintext, version } = this.options.secrets.revealVersioned(this.profile.userId, this.profile.credentialRef);
    return { authorization: `Bearer ${plaintext}`, version };
  }

  /** Sends one request and reads its answer within `limitBytes`; error statuses become ASR errors. */
  async call(phase: DashscopePhase, request: OutboundRequest, options: CallOptions = {}): Promise<Answer> {
    const answer = await this.send(phase, request, options);
    if (!isSuccess(answer.response.status)) {
      throw httpError(phase, answer.response.status, answer.text, answer.response.headers, this.now());
    }
    return answer;
  }

  /** `call` without judging the status, for the answers a phase reads itself. */
  async send(phase: DashscopePhase, request: OutboundRequest, options: CallOptions = {}): Promise<Answer> {
    const { signal } = request;
    let response: OutboundResponse;
    let text: string;
    try {
      response = await this.options.http.request({
        ...request,
        headers: {
          ...(options.authorized === false ? {} : { authorization: options.authorization ?? this.authorization() }),
          ...request.headers,
        },
      });
      text = await readBounded(response.body, options.limitBytes ?? CONTROL_BODY_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw phase === "submit"
          ? amberError("asr_timeout", `dashscope ${phase} answer is too large`)
          : amberError("asr_failed", `dashscope ${phase} answer is too large`, { code: "asr_failed.job_failed", upstreamMessage: "result_unreadable" });
      }
      throw transportError(error, signal, phase);
    }
    return { response, text };
  }

  async uploadPolicy(model: string, signal: AbortSignal): Promise<UploadPolicy> {
    const query = new URLSearchParams({ action: "getPolicy", model });
    const { text } = await this.call("policy", {
      url: `${this.baseUrl}/api/v1/uploads?${query.toString()}`,
      method: "GET",
      headers: { accept: "application/json" },
      signal,
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
    const policy = policySchema.safeParse(parseJson(text))?.data?.data;
    if (policy === undefined || !isAliyunHttps(policy.upload_host)) {
      throw amberError("asr_failed", "unexpected upload policy", { code: "asr_failed.job_failed" });
    }
    return policy;
  }
}

class DashscopeAsrProvider implements AsrJobProvider {
  readonly id = DASHSCOPE_DESCRIPTOR.provider;
  readonly capabilities: AsrProviderCapabilities & { delivery: "job" };
  private readonly modelId: string;
  private readonly spec: FamilySpec;
  private readonly options: DashscopeAsrProviderFactoryOptions;
  private readonly client: DashscopeClient;

  constructor(profile: AsrProviderProfile, modelId: string, spec: FamilySpec, options: DashscopeAsrProviderFactoryOptions) {
    this.modelId = modelId;
    this.spec = spec;
    // Only the models Amber knows declare speaker identification; a typed-in one never does.
    const diarization = asrDiarizationSupport(DASHSCOPE_DESCRIPTOR, modelId);
    this.capabilities = diarization === undefined ? spec.capabilities : { ...spec.capabilities, diarization };
    this.options = options;
    this.client = new DashscopeClient(profile, options);
  }

  async submit(input: AsrTranscribeInput, opts: AsrSubmitOptions): Promise<AsrJobHandle> {
    const { signal, onProgress } = opts;
    const policy = await this.client.uploadPolicy(this.modelId, signal);
    const { audio } = input;
    if (audio.sizeBytes > policy.max_file_size_mb * BYTES_PER_MB) {
      throw amberError("media_too_large", "audio exceeds the upload space the service grants", { params: { limit: `${policy.max_file_size_mb} MB` } });
    }
    const name = this.options.newId?.() ?? randomUUID();
    const key = `${policy.upload_dir.replace(/\/+$/, "")}/${name}${extensionOf(audio.mimeType)}`;
    // The storage's form upload: the policy fields first, the file last (it ends the form).
    const body = multipartStream(
      [
        ["OSSAccessKeyId", policy.oss_access_key_id],
        ["Signature", policy.signature],
        ["policy", policy.policy],
        ["x-oss-object-acl", policy.x_oss_object_acl],
        ["x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite],
        ["key", key],
        ["success_action_status", "200"],
      ],
      {
        name: "file",
        filename: `${name}${extensionOf(audio.mimeType)}`,
        contentType: audio.mimeType,
        sizeBytes: audio.sizeBytes,
        stream: withProgress(this.options.files.read(audio.storageRef), audio.sizeBytes, onProgress),
      },
    );
    await this.client.call(
      "upload",
      {
        url: policy.upload_host,
        method: "POST",
        body,
        signal,
        timeoutMs: Math.max(ASR_HTTP_TIMEOUT_MIN * MS_PER_MINUTE, (audio.durationMs ?? 0) * UPLOAD_TIMEOUT_PER_AUDIO_MS),
      },
      { authorized: false },
    );

    const language = toDashscopeLanguageHint(input.language, this.spec.languageHints);
    const vocabulary = this.spec.vocabulary && input.terminology.length > 0
      ? Object.fromEntries(input.terminology.map((entry) => [entry.term, VOCABULARY_WEIGHT]))
      : undefined;
    const request = {
      model: this.modelId,
      input: { file_urls: [`oss://${key}`] },
      parameters: {
        channel_id: [0],
        diarization_enabled: input.diarization !== undefined,
        // A reference for the algorithm; the stage only passes it inside the model's range.
        ...(input.diarization?.speakerCount === undefined ? {} : { speaker_count: input.diarization.speakerCount }),
        // The HTTP API types this as a string holding JSON; switching the reserved filter
        // off keeps the raw transcript complete (it is evidence).
        special_word_filter: JSON.stringify({ system_reserved_filter: false }),
        ...(language === undefined ? {} : { language_hints: [language] }),
        ...(vocabulary === undefined ? {} : { vocabulary }),
      },
    };
    const payload = JSON.stringify(request);
    // Everything before this point is free. The key is revealed once, reported with its
    // version, and used for the creating request below; the upload space and later queries
    // reveal on their own and are not reported.
    const { authorization, version } = this.client.paidAuthorization();
    opts.onRequestStart({ sentAt: this.client.now(), credential: version });
    const { text } = await this.client.call(
      "submit",
      {
        url: `${this.client.baseUrl}/api/v1/services/audio/asr/transcription`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-dashscope-async": "enable",
          "x-dashscope-ossresourceresolve": "enable",
        },
        body: payload,
        signal,
        timeoutMs: SUBMIT_TIMEOUT_MS,
      },
      { authorization },
    );
    const submitted = submitSchema.safeParse(parseJson(text));
    if (!submitted.success) {
      // Accepted with an answer that names no job: a job may exist and be billed.
      throw amberError("asr_timeout", "dashscope accepted the job without a readable task id");
    }
    onProgress?.(1);
    return { version: 1, provider: this.id, jobId: submitted.data.output.task_id, submittedAt: this.client.now() };
  }

  async poll(handle: AsrJobHandle, opts: { signal: AbortSignal; onJobReport?(report: AsrJobReport): void }): Promise<AsrJobStatus> {
    const { signal } = opts;
    const jobId = this.jobIdOf(handle);
    const { response, text } = await this.client.send("poll", {
      url: `${this.client.baseUrl}/api/v1/tasks/${encodeURIComponent(jobId)}`,
      method: "GET",
      headers: { accept: "application/json" },
      signal,
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
    if (response.status === NOT_FOUND) {
      return { state: "missing" };
    }
    // A throttled state query is "not yet", with the service's own wait when it named one.
    if (response.status === TOO_MANY_REQUESTS) {
      const wait = retryAfterMs(response.headers.get("retry-after"), this.client.now());
      return wait === undefined ? { state: "pending" } : { state: "pending", retryAfterMs: wait };
    }
    if (!isSuccess(response.status)) {
      throw httpError("poll", response.status, text, response.headers, this.client.now());
    }
    const task = taskSchema.safeParse(parseJson(text));
    if (!task.success) {
      throw amberError("asr_failed", "dashscope task state is unreadable", { code: "asr_failed.job_failed" });
    }
    const { output } = task.data;
    // What the job's end state says about its billing, read from the answer itself and
    // reported once, before anything local can fail.
    const metering = meteringOf(parseJson(text));
    const report = (remote: AsrJobReport["remote"]): void => {
      try {
        opts.onJobReport?.({ remote, ...metering });
      } catch {
        // The report is bookkeeping: it must never decide whether the job's result is usable.
      }
    };
    switch (output.task_status) {
      case "PENDING":
      case "RUNNING":
        return { state: "pending" };
      case "UNKNOWN":
        return { state: "missing" };
      case "SUCCEEDED": {
        const results = output.results ?? [];
        report(results[0] !== undefined && results[0].subtask_status !== SUBTASK_SUCCEEDED ? "failed" : "succeeded");
        return { state: "done", result: await this.result(results, signal) };
      }
      case "FAILED":
      case "CANCELED":
        report(output.task_status === "FAILED" ? "failed" : "cancelled");
        throw jobError(failureOf(output), output.task_status);
      default:
        throw jobError(failureOf(output), output.task_status);
    }
  }

  async cancel(handle: AsrJobHandle, opts: { signal: AbortSignal }): Promise<AsrJobCancelOutcome> {
    const jobId = this.jobIdOf(handle);
    const { response, text } = await this.client.send("cancel", {
      url: `${this.client.baseUrl}/api/v1/tasks/${encodeURIComponent(jobId)}/cancel`,
      method: "POST",
      headers: { accept: "application/json" },
      signal: opts.signal,
      timeoutMs: CANCEL_TIMEOUT_MS,
    });
    if (isSuccess(response.status)) {
      return "cancelled";
    }
    // Only a job still waiting in the queue can be cancelled; any other is past it.
    if (response.status === BAD_REQUEST && upstreamError(text).code === "UnsupportedOperation") {
      return "already_terminal";
    }
    throw httpError("cancel", response.status, text, response.headers, this.client.now());
  }

  private jobIdOf(handle: AsrJobHandle): string {
    const checked = asrJobHandleSchema.safeParse(handle);
    if (!checked.success || checked.data.provider !== this.id) {
      throw amberError("internal", "the job handle does not belong to this provider");
    }
    return checked.data.jobId;
  }

  private async result(results: readonly TaskResult[], signal: AbortSignal): Promise<CanonicalAsrResult> {
    const file = results[0];
    if (file === undefined) {
      throw amberError("asr_failed", "dashscope job succeeded without a result", { code: "asr_failed.job_failed" });
    }
    if (file.subtask_status !== SUBTASK_SUCCEEDED || file.transcription_url === undefined) {
      throw jobError({ ...(file.code === undefined ? {} : { code: file.code }), ...(file.message === undefined ? {} : { message: file.message }) }, file.subtask_status ?? "FAILED");
    }
    if (!isAliyunHttps(file.transcription_url)) {
      throw amberError("asr_failed", "dashscope result link points outside its storage", { code: "asr_failed.job_failed" });
    }
    // The link is signed by the service; it carries no key of ours.
    const { text } = await this.client.call(
      "result",
      { url: file.transcription_url, method: "GET", signal, timeoutMs: RESULT_TIMEOUT_MS },
      { authorized: false, limitBytes: ASR_RESULT_MAX_MB * BYTES_PER_MB },
    );
    return canonicalFromResultFile(text, { provider: this.id, model: this.modelId });
  }
}

/** The numeric fields of the answer's top-level `usage` that Amber reads; nothing else of it is kept. */
const METERING_FIELDS = ["input_tokens", "output_tokens", "total_tokens", "duration", "seconds"] as const;
const MS_PER_SECOND = 1000;

/**
 * The billing quantities of a task answer, read leniently: only the whitelisted fields that
 * are finite non-negative numbers count, anything else in `usage` is ignored, and an answer
 * without any of them reports nothing. `rawUsageJson` holds exactly the kept fields as
 * received, so it can never carry a key, signature or URL. `duration` (seconds) is the
 * billed time; `seconds` is only consulted when `duration` is absent. `total_tokens` stays
 * in the raw record only.
 */
function meteringOf(answer: unknown): Pick<AsrJobReport, "usage" | "rawUsageJson"> {
  const usage = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>)["usage"] : undefined;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return {};
  }
  const received = usage as Record<string, unknown>;
  const kept: Partial<Record<(typeof METERING_FIELDS)[number], number>> = {};
  for (const field of METERING_FIELDS) {
    const value = received[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      kept[field] = value;
    }
  }
  if (Object.keys(kept).length === 0) {
    return {};
  }
  const seconds = kept.duration ?? kept.seconds;
  const billed: NonNullable<AsrJobReport["usage"]> = {
    ...(kept.input_tokens === undefined ? {} : { billedInputTokens: Math.round(kept.input_tokens) }),
    ...(kept.output_tokens === undefined ? {} : { billedOutputTokens: Math.round(kept.output_tokens) }),
    ...(seconds === undefined ? {} : { billedAudioMs: Math.round(seconds * MS_PER_SECOND) }),
  };
  return { ...(Object.keys(billed).length === 0 ? {} : { usage: billed }), rawUsageJson: JSON.stringify(kept) };
}

function failureOf(output: { code?: string | undefined; message?: string | undefined }): { code?: string; message?: string } {
  return { ...(output.code === undefined ? {} : { code: output.code }), ...(output.message === undefined ? {} : { message: output.message }) };
}

function isAliyunHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(ALIYUN_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extensionOf(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim();
  return subtype === undefined || !/^[a-z0-9.+-]+$/i.test(subtype) ? "" : `.${subtype.replace(/^x-/, "")}`;
}

async function* withProgress(
  chunks: AsyncIterable<Uint8Array>,
  total: number,
  onProgress: ((progress: number) => void) | undefined,
): AsyncIterable<Uint8Array> {
  let sent = 0;
  for await (const chunk of chunks) {
    sent += chunk.byteLength;
    yield chunk;
    if (onProgress !== undefined && total > 0) {
      onProgress(Math.min(1, sent / total) * UPLOAD_PROGRESS_SHARE);
    }
  }
}
