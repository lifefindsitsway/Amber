import { ASR_PRESETS, asrModelFamily } from "../../../../shared/asr-presets.ts";
import { ASR_HTTP_TIMEOUT_MIN } from "../../../../shared/defaults.ts";
import type { CanonicalAsrResult } from "../../../domain/asr.ts";
import { amberError } from "../../../domain/errors.ts";
import type { AsrProviderProfile } from "../../../domain/provider-profile.ts";
import type { TranscriptWord } from "../../../domain/transcript.ts";
import type {
  AsrProbeResult,
  AsrProviderCapabilities,
  AsrSyncProvider,
  AsrProviderDescriptor,
  AsrProviderFactory,
  AsrTranscribeInput,
  AsrTranscribeOptions,
} from "../../../ports/asr-provider.ts";
import type { FileStore } from "../../../ports/file-store.ts";
import type { OutboundHttpClient, OutboundResponse } from "../../../ports/outbound-http.ts";
import type { SecretStore } from "../../../ports/secret-store.ts";
import { httpError, transportError } from "./errors.ts";
import { fromElevenLabsLanguage, toElevenLabsLanguage } from "./language.ts";
import { multipartStream } from "../shared/multipart.ts";
import { mergeSentences, sentenceParamsFor, type MergeWord, type MergedSentence, type SentenceParams } from "./sentences.ts";

export { DEFAULT_SENTENCE_PARAMS, mergeSentences, sentenceParamsFor, ZH_SENTENCE_PARAMS, type SentenceParams } from "./sentences.ts";
export { fromElevenLabsLanguage, toElevenLabsLanguage } from "./language.ts";

export const ELEVENLABS_DESCRIPTOR: AsrProviderDescriptor = ASR_PRESETS.elevenlabs;

const DEFAULT_BASE_URL = (ASR_PRESETS.elevenlabs.endpoints[0] as { baseURL: string }).baseURL;
const MS_PER_MINUTE = 60_000;
/**
 * Upload plus provider-managed transcription of long audio takes a fraction of its
 * playing time; allowing the full playing time keeps hours-long lectures from timing out
 * while `ASR_HTTP_TIMEOUT_MIN` stays the floor for short ones.
 */
const TIMEOUT_PER_AUDIO_MS = 1;
/** The account lookup answers at once; the named defaults include no ASR probe timeout. */
const PROBE_TIMEOUT_MS = 20_000;
/** Share of the stage progress given to uploading; the rest arrives with the answer. */
const UPLOAD_PROGRESS_SHARE = 0.5;

/**
 * Official limits from the API reference: the file must be "less than 5.0GB",
 * read as decimal gigabytes because that is the stricter reading; 10 hours; keyterms at
 * most 1000, each under 50 characters and at most 5 words.
 */
export const ELEVENLABS_CAPABILITIES: AsrProviderCapabilities & { delivery: "sync" } = {
  wordTimestamps: true,
  segmentTimestamps: false,
  diarization: true,
  terminologyBias: true,
  maxFileBytes: 5 * 1000 ** 3,
  maxDurationSec: 10 * 3600,
  maxTerminologyEntries: 1000,
  maxTerminologyTermChars: 49,
  maxTerminologyWords: 5,
  chunkingStrategy: "providerManaged",
  delivery: "sync",
};

interface FamilySpec {
  capabilities: AsrProviderCapabilities & { delivery: "sync" };
  /**
   * Whether `no_verbatim` is sent. The API reference says it is "only supported with
   * scribe_v2"; `false` is its default, so leaving it out
   * elsewhere changes nothing.
   */
  noVerbatimParam: boolean;
}

/**
 * Static per-family declaration, keyed by the preset's family ids. Both families share the
 * API, features and limits; they differ only in `no_verbatim`.
 */
const FAMILIES: Readonly<Record<string, FamilySpec>> = {
  scribe_v2: { capabilities: ELEVENLABS_CAPABILITIES, noVerbatimParam: true },
  scribe: { capabilities: ELEVENLABS_CAPABILITIES, noVerbatimParam: false },
};

/** The spec of a model of the profile, by its family; any other model is unavailable. */
function modelSpec(profile: AsrProviderProfile, modelId: string): FamilySpec {
  const entry = profile.models.find((model) => model.modelId === modelId);
  const family = entry === undefined ? undefined : asrModelFamily(ELEVENLABS_DESCRIPTOR, entry);
  const spec = family !== undefined && Object.hasOwn(FAMILIES, family.id) ? FAMILIES[family.id] : undefined;
  if (spec === undefined) {
    throw amberError("asr_failed", "the model has no request family this adapter supports", { code: "asr_failed.model_unavailable" });
  }
  return spec;
}

export interface ElevenLabsAsrProviderFactoryOptions {
  http: OutboundHttpClient;
  files: Pick<FileStore, "read">;
  secrets: Pick<SecretStore, "reveal" | "revealVersioned">;
  now?: () => number;
}

/**
 * ElevenLabs Speech-to-Text (Scribe). Everything named after the service stays in this
 * directory. Invariant: callers see `CanonicalAsrResult` only.
 */
export class ElevenLabsAsrProviderFactory implements AsrProviderFactory {
  readonly descriptor = ELEVENLABS_DESCRIPTOR;
  private readonly options: ElevenLabsAsrProviderFactoryOptions;

  constructor(options: ElevenLabsAsrProviderFactoryOptions) {
    this.options = options;
  }

  create(profile: AsrProviderProfile, modelId: string): AsrSyncProvider {
    return new ElevenLabsAsrProvider(profile, modelId, modelSpec(profile, modelId), this.options);
  }

  async probe(profile: AsrProviderProfile, signal: AbortSignal): Promise<AsrProbeResult> {
    let response: OutboundResponse;
    let body: string;
    try {
      response = await this.options.http.request({
        url: `${baseUrlOf(profile)}/v1/user`,
        method: "GET",
        headers: { "xi-api-key": apiKey(profile, this.options.secrets), accept: "application/json" },
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      body = await response.text();
    } catch (error) {
      // A read-only lookup costs nothing, so any transport failure is simply retryable.
      throw transportError(error, signal, false);
    }
    if (response.status !== 200) {
      throw httpError(response.status, body);
    }
    return probeResult(body);
  }
}

class ElevenLabsAsrProvider implements AsrSyncProvider {
  readonly id = ELEVENLABS_DESCRIPTOR.provider;
  readonly capabilities: AsrProviderCapabilities & { delivery: "sync" };
  private readonly profile: AsrProviderProfile;
  private readonly modelId: string;
  private readonly spec: FamilySpec;
  private readonly options: ElevenLabsAsrProviderFactoryOptions;

  constructor(profile: AsrProviderProfile, modelId: string, spec: FamilySpec, options: ElevenLabsAsrProviderFactoryOptions) {
    this.profile = profile;
    this.modelId = modelId;
    this.spec = spec;
    this.capabilities = spec.capabilities;
    this.options = options;
  }

  async transcribe(input: AsrTranscribeInput, opts: AsrTranscribeOptions): Promise<CanonicalAsrResult> {
    const { signal, onProgress } = opts;
    const { audio } = input;
    const language = toElevenLabsLanguage(input.language);
    const fields: Array<readonly [string, string]> = [
      ["model_id", this.modelId],
      ["timestamps_granularity", "word"],
      ["diarize", "false"],
      ["tag_audio_events", "false"],
      // Raw ASR is evidence: filler words are left to proofreading, never dropped here.
      ...(this.spec.noVerbatimParam ? [["no_verbatim", "false"] as const] : []),
      ...(language === undefined ? [] : [["language_code", language] as const]),
      ...input.terminology.map((entry) => ["keyterms", entry.term] as const),
    ];
    const body = multipartStream(fields, {
      name: "file",
      filename: `audio${extensionOf(audio.mimeType)}`,
      contentType: audio.mimeType,
      sizeBytes: audio.sizeBytes,
      stream: withProgress(this.options.files.read(audio.storageRef), audio.sizeBytes, onProgress),
    });
    const timeoutMs = Math.max(ASR_HTTP_TIMEOUT_MIN * MS_PER_MINUTE, (audio.durationMs ?? 0) * TIMEOUT_PER_AUDIO_MS);

    // The key is revealed once and reported with its version; the request below is sent with
    // exactly that key. A throw from the callback means "do not send".
    const { plaintext: key, version } = revealVersioned(this.profile, this.options.secrets);
    opts.onRequestStart({ sentAt: this.options.now?.() ?? Date.now(), credential: version });
    let response: OutboundResponse;
    let text: string;
    try {
      response = await this.options.http.request({
        url: `${baseUrlOf(this.profile)}/v1/speech-to-text`,
        method: "POST",
        headers: { "xi-api-key": key, accept: "application/json" },
        body,
        signal,
        timeoutMs,
      });
      text = await response.text();
    } catch (error) {
      throw transportError(error, signal, true);
    }
    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status, text);
    }
    const result = canonicalFromResponse(text, { model: this.modelId, ...(audio.durationMs === undefined ? {} : { durationMs: audio.durationMs }) });
    onProgress?.(1);
    return result;
  }
}

function baseUrlOf(profile: AsrProviderProfile): string {
  return (profile.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Revealed per call and dropped with the request; never logged or put in an error. */
function apiKey(profile: AsrProviderProfile, secrets: Pick<SecretStore, "reveal">): string {
  if (profile.credentialRef === undefined) {
    throw amberError("asr_unconfigured", "ASR profile has no credential");
  }
  return secrets.reveal(profile.userId, profile.credentialRef);
}

/** The profile's key with its version, for the one paid request that reports it; callers must not keep or log it. */
function revealVersioned(profile: AsrProviderProfile, secrets: Pick<SecretStore, "revealVersioned">): ReturnType<SecretStore["revealVersioned"]> {
  if (profile.credentialRef === undefined) {
    throw amberError("asr_unconfigured", "ASR profile has no credential");
  }
  return secrets.revealVersioned(profile.userId, profile.credentialRef);
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

interface ResponseWord {
  text: string;
  type: string;
  start?: number | null;
  end?: number | null;
  speaker_id?: string | null;
}

/** Full-width punctuation and closing marks that never start a word. */
const LEADING_CJK_PUNCTUATION = /^[。，、；：！？…）」』”’]+/u;

export interface CanonicalContext {
  model: string;
  /** Locally probed duration of the submitted audio. */
  durationMs?: number;
}

/**
 * Turns a 200 answer into `CanonicalAsrResult`: words keep their own timing (seconds to
 * whole milliseconds); sentences are merged here because the service returns none.
 * The answer was paid for, so an unreadable one is `asr_timeout`: its
 * outcome is unknown to Amber, and only the user may decide to pay again.
 */
export function canonicalFromResponse(
  text: string,
  context: CanonicalContext,
  merge: (words: readonly MergeWord[], params: SentenceParams) => MergedSentence[] = mergeSentences,
): CanonicalAsrResult {
  const parsed = parseResponse(text);
  const language = fromElevenLabsLanguage(parsed.language_code);
  const words: MergeWord[] = [];
  let spaceBefore = false;
  for (const token of parsed.words) {
    if (token.type === "spacing") {
      spaceBefore = spaceBefore || /\s/u.test(token.text);
      continue;
    }
    if (token.type !== "word") {
      continue;
    }
    if (typeof token.start === "number" && typeof token.end === "number" && Number.isFinite(token.start) && Number.isFinite(token.end)) {
      const startMs = Math.max(0, Math.round(token.start * 1000));
      const endMs = Math.max(startMs, Math.round(token.end * 1000));
      let wordText = token.text;
      // Chinese answers glue the punctuation that ends a word to the start of the next
      // token ("。OK，"); it belongs to the previous word, where sentence breaks look for it.
      const leading = LEADING_CJK_PUNCTUATION.exec(wordText)?.[0];
      const previous = words.at(-1);
      if (leading !== undefined && previous !== undefined) {
        previous.text += leading;
        wordText = wordText.slice(leading.length);
      }
      if (wordText.trim() !== "") {
        words.push({ text: wordText, startMs, endMs, spaceBefore, ...(typeof token.speaker_id === "string" ? { speakerId: token.speaker_id } : {}) });
      }
    }
    spaceBefore = false;
  }
  const segments = merge(words, sentenceParamsFor(language));
  const transcriptWords: TranscriptWord[] = words.map(({ text: wordText, startMs, endMs }) => ({ text: wordText, startMs, endMs }));
  return {
    text: parsed.text,
    language,
    segments,
    words: transcriptWords,
    provider: ELEVENLABS_DESCRIPTOR.provider,
    model: context.model,
    durationMs: context.durationMs ?? words.at(-1)?.endMs ?? 0,
  };
}

function parseResponse(text: string): { language_code: string; text: string; words: ResponseWord[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw amberError("asr_timeout", "speech-to-text answered with something other than JSON");
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record["language_code"] !== "string" ||
    typeof record["text"] !== "string" ||
    !Array.isArray(record["words"]) ||
    !(record["words"] as unknown[]).every(isResponseWord)
  ) {
    throw amberError("asr_timeout", "speech-to-text answer does not have the documented shape");
  }
  return record as { language_code: string; text: string; words: ResponseWord[] };
}

function isResponseWord(value: unknown): value is ResponseWord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const word = value as Record<string, unknown>;
  const optionalNumber = (key: string): boolean => word[key] === undefined || word[key] === null || typeof word[key] === "number";
  return typeof word["text"] === "string" && typeof word["type"] === "string" && optionalNumber("start") && optionalNumber("end");
}

function probeResult(body: string): AsrProbeResult {
  let subscription: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body) as { subscription?: unknown };
    if (typeof parsed.subscription === "object" && parsed.subscription !== null) {
      subscription = parsed.subscription as Record<string, unknown>;
    }
  } catch {
    // The key was accepted (HTTP 200); a body we cannot read only loses the summary.
  }
  const result: AsrProbeResult = {};
  if (typeof subscription["status"] === "string") {
    result.subscriptionStatus = subscription["status"];
  }
  if (typeof subscription["character_count"] === "number") {
    result.usedUnits = subscription["character_count"];
  }
  if (typeof subscription["character_limit"] === "number") {
    result.limitUnits = subscription["character_limit"];
  }
  return result;
}
