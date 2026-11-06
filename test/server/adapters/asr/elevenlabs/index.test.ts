import { describe, expect, it } from "vitest";
import {
  canonicalFromResponse,
  DEFAULT_SENTENCE_PARAMS,
  ELEVENLABS_CAPABILITIES,
  ELEVENLABS_DESCRIPTOR,
  ElevenLabsAsrProviderFactory,
  mergeSentences,
  ZH_SENTENCE_PARAMS,
  type SentenceParams,
} from "../../../../../src/server/adapters/asr/elevenlabs/index.ts";
import { AmberError, isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { RequestStartInfo } from "../../../../../src/server/domain/usage.ts";
import type { AsrTranscribeOptions } from "../../../../../src/server/ports/asr-provider.ts";
import type { MediaAsset } from "../../../../../src/server/domain/media-asset.ts";
import type { AsrProviderProfile } from "../../../../../src/server/domain/provider-profile.ts";
import { OutboundHttpError, type OutboundRequest, type OutboundResponse, type OutboundStreamBody } from "../../../../../src/server/ports/outbound-http.ts";
import { ASR_HTTP_TIMEOUT_MIN } from "../../../../../src/shared/defaults.ts";
import { asrResponse, KNOWN_MISHEARD_TERMS } from "../../../../fixtures/asr/index.ts";

const API_KEY = "<elevenlabs-test-key>";
const AUDIO = new Uint8Array(Array.from({ length: 70_000 }, (_, index) => index % 251));
const PROFILE: AsrProviderProfile = {
  id: "asr-1",
  userId: "user-1",
  name: "ElevenLabs",
  provider: "elevenlabs",
  models: [{ modelId: "scribe_v2" }, { modelId: "scribe_v2_medical" }],
  credentialRef: "secret-1",
  createdAt: 0,
};
const ASSET: MediaAsset = {
  id: "asset-1",
  userId: "user-1",
  contentId: "content-1",
  kind: "extracted_audio",
  taskId: "task-1",
  storageRef: "assets/user-1/content-1/asset-1",
  mimeType: "audio/flac",
  sizeBytes: AUDIO.byteLength,
  durationMs: 12_000,
  availability: "available",
  retentionPolicy: "ephemeral",
  createdAt: 0,
};

interface Captured {
  request: OutboundRequest;
  /** The streamed body as sent, for `OutboundStreamBody` requests. */
  bytes?: Buffer;
}

type Answer = { status?: number; body?: string } | Error;

/** Collects requests (draining stream bodies the way a transport would) and answers from a script. */
class CapturingHttp {
  readonly captured: Captured[] = [];
  private readonly answer: (request: OutboundRequest) => Answer;

  constructor(answer: (request: OutboundRequest) => Answer) {
    this.answer = answer;
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const entry: Captured = { request };
    this.captured.push(entry);
    if (typeof request.body === "object" && request.body !== null && "stream" in request.body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of (request.body as OutboundStreamBody).stream) {
        chunks.push(chunk);
      }
      entry.bytes = Buffer.concat(chunks);
    }
    const answer = this.answer(request);
    if (answer instanceof Error) {
      throw answer;
    }
    const text = answer.body ?? "";
    return {
      status: answer.status ?? 200,
      headers: new Map(),
      body: (async function* () {
        yield new TextEncoder().encode(text);
      })(),
      text: async () => text,
    };
  }
}

function setup(answer: (request: OutboundRequest) => Answer, files = { read: chunked(AUDIO) }) {
  const http = new CapturingHttp(answer);
  const revealed: Array<[string, string]> = [];
  const factory = new ElevenLabsAsrProviderFactory({
    http,
    files,
    secrets: {
      reveal: (owner, ref) => {
        revealed.push([owner, ref]);
        return API_KEY;
      },
      revealVersioned: (owner, ref) => {
        revealed.push([owner, ref]);
        return { plaintext: API_KEY, version: KEY_VERSION };
      },
    },
  });
  return { http, factory, revealed, provider: factory.create(PROFILE, "scribe_v2") };
}

function chunked(bytes: Uint8Array, size = 16_384): (ref: string) => AsyncIterable<Uint8Array> {
  return async function* () {
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      yield bytes.subarray(offset, offset + size);
    }
  };
}

const signal = (): AbortSignal => new AbortController().signal;
const KEY_VERSION = { versionId: "version-1", setAt: 1_700_000_000_000 };
const options = (): AsrTranscribeOptions => ({ signal: signal(), onRequestStart: () => undefined });

/** The parts of a multipart body: name, optional filename and content as bytes. */
function parts(bytes: Buffer, contentType: string): Array<{ name: string; filename?: string; content: Buffer }> {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] as string;
  const delimiter = Buffer.from(`--${boundary}`);
  const result: Array<{ name: string; filename?: string; content: Buffer }> = [];
  let start = bytes.indexOf(delimiter) + delimiter.byteLength;
  for (;;) {
    const next = bytes.indexOf(delimiter, start);
    if (next < 0) {
      break;
    }
    const part = bytes.subarray(start + 2, next - 2);
    const headerEnd = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const name = /name="([^"]+)"/.exec(headers)?.[1] as string;
    const filename = /filename="([^"]+)"/.exec(headers)?.[1];
    result.push({ name, ...(filename === undefined ? {} : { filename }), content: part.subarray(headerEnd + 4) });
    start = next + delimiter.byteLength;
  }
  expect(bytes.subarray(start).toString("utf8")).toBe("--\r\n");
  return result;
}

async function failure(promise: Promise<unknown>): Promise<AmberError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(isAmberError(error)).toBe(true);
  return error as AmberError;
}

describe("ElevenLabs descriptor and capabilities", () => {
  it("publishes the provider and the default model for new profiles", () => {
    expect(ELEVENLABS_DESCRIPTOR).toMatchObject({
      provider: "elevenlabs",
      defaultModel: "scribe_v2",
      models: ["scribe_v2", "scribe_v2_medical"],
      recommendedModels: ["scribe_v2"],
      baseUrlPolicy: "any",
    });
  });

  it("offers batch models only: neither the realtime model nor the deprecated first generation", () => {
    expect(ELEVENLABS_DESCRIPTOR.models).not.toContain("scribe_v2_realtime");
    expect(ELEVENLABS_DESCRIPTOR.models).not.toContain("scribe_v1");
  });

  it("gives every model the same limits, and refuses a model not on the profile or without a family", () => {
    const { factory } = setup(() => ({ body: asrResponse("en") }));
    for (const model of ELEVENLABS_DESCRIPTOR.models) {
      expect(factory.create(PROFILE, model).capabilities).toEqual(ELEVENLABS_CAPABILITIES);
    }
    const custom = { ...PROFILE, models: [{ modelId: "scribe_v3", family: "scribe" }, { modelId: "scribe_v4" }, { modelId: "scribe_v5", family: "whisper" }] };
    expect(factory.create(custom, "scribe_v3").capabilities).toEqual(ELEVENLABS_CAPABILITIES);
    for (const [profile, model] of [[PROFILE, "scribe_v2_realtime"], [custom, "scribe_v4"], [custom, "scribe_v5"]] as const) {
      let thrown: unknown;
      try {
        factory.create(profile, model);
      } catch (error) {
        thrown = error;
      }
      expect(isAmberError(thrown) && thrown.appError.code).toBe("asr_failed.model_unavailable");
    }
  });

  it("declares the official limits", () => {
    expect(ELEVENLABS_CAPABILITIES).toMatchObject({
      wordTimestamps: true,
      segmentTimestamps: false,
      terminologyBias: true,
      maxDurationSec: 36_000,
      maxTerminologyEntries: 1000,
      maxTerminologyTermChars: 49,
      maxTerminologyWords: 5,
      chunkingStrategy: "providerManaged",
      delivery: "sync",
    });
    expect(ELEVENLABS_CAPABILITIES.maxFileBytes).toBe(5_000_000_000);
  });
});

describe("transcribe request", () => {
  it("reports the request start with the version of the key it is then sent with, right before sending", async () => {
    const events: string[] = [];
    const infos: RequestStartInfo[] = [];
    const http = new CapturingHttp((request) => {
      events.push(`send ${String(request.headers?.["xi-api-key"])}`);
      return { body: asrResponse("en") };
    });
    // A store whose value and version change after every reveal: only one reveal may happen.
    let reveals = 0;
    const factory = new ElevenLabsAsrProviderFactory({
      http,
      files: { read: chunked(AUDIO) },
      now: () => 1_234,
      secrets: {
        reveal: () => API_KEY,
        revealVersioned: () => {
          reveals += 1;
          events.push(`reveal ${reveals}`);
          return { plaintext: `key-${reveals}`, version: { versionId: `version-${reveals}`, setAt: reveals } };
        },
      },
    });
    await factory.create(PROFILE, "scribe_v2").transcribe(
      { audio: ASSET, terminology: [] },
      {
        signal: signal(),
        onRequestStart: (info) => {
          infos.push(info);
          events.push("started");
        },
      },
    );
    expect(events).toEqual(["reveal 1", "started", "send key-1"]);
    expect(infos).toEqual([{ sentAt: 1_234, credential: { versionId: "version-1", setAt: 1 } }]);
  });

  it("sends nothing when the start callback refuses, and never reports a start without a credential", async () => {
    const { http, provider } = setup(() => ({ body: asrResponse("en") }));
    const refusal = new Error("do not send");
    await expect(provider.transcribe({ audio: ASSET, terminology: [] }, { signal: signal(), onRequestStart: () => { throw refusal; } })).rejects.toBe(refusal);
    expect(http.captured).toEqual([]);

    const started: unknown[] = [];
    const unconfigured = setup(() => ({ body: asrResponse("en") })).factory.create({ ...PROFILE, credentialRef: undefined as never }, "scribe_v2");
    const error = await failure(unconfigured.transcribe({ audio: ASSET, terminology: [] }, { signal: signal(), onRequestStart: (info) => started.push(info) }));
    expect(error.appError.class).toBe("asr_unconfigured");
    expect(started).toEqual([]);
  });

  it("streams a multipart body with the fixed options, the terms as keyterms and the audio bytes", async () => {
    const { http, provider, revealed } = setup(() => ({ body: asrResponse("mixed") }));
    await provider.transcribe({ audio: ASSET, language: "zh-Hans", terminology: [...KNOWN_MISHEARD_TERMS] }, options());

    const [{ request, bytes }] = http.captured as [Captured];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(request.headers?.["xi-api-key"]).toBe(API_KEY);
    expect(revealed).toEqual([["user-1", "secret-1"]]);
    const body = request.body as OutboundStreamBody;
    expect(body.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(bytes?.byteLength).toBe(body.contentLength);

    const sent = parts(bytes as Buffer, body.contentType);
    const field = (name: string): string[] => sent.filter((part) => part.name === name).map((part) => part.content.toString("utf8"));
    expect(field("model_id")).toEqual(["scribe_v2"]);
    expect(field("timestamps_granularity")).toEqual(["word"]);
    expect(field("diarize")).toEqual(["false"]);
    expect(field("tag_audio_events")).toEqual(["false"]);
    expect(field("no_verbatim")).toEqual(["false"]);
    expect(field("language_code")).toEqual(["zho"]);
    expect(field("keyterms")).toEqual(KNOWN_MISHEARD_TERMS.map((entry) => entry.term));
    expect(field("file_format")).toEqual([]);
    const file = sent.at(-1);
    expect(file?.name).toBe("file");
    expect(file?.filename).toBe("audio.flac");
    expect(Buffer.compare(file?.content as Buffer, Buffer.from(AUDIO))).toBe(0);
  });

  it("leaves language_code out when the language does not map and sends no keyterms without terms", async () => {
    const { http, provider } = setup(() => ({ body: asrResponse("en") }));
    await provider.transcribe({ audio: ASSET, terminology: [] }, options());
    const { request, bytes } = http.captured[0] as Captured;
    const sent = parts(bytes as Buffer, (request.body as OutboundStreamBody).contentType);
    expect(sent.map((part) => part.name)).toEqual(["model_id", "timestamps_granularity", "diarize", "tag_audio_events", "no_verbatim", "file"]);
  });

  it("sends the chosen model, and no_verbatim only to the model the API reference documents it for", async () => {
    const { http, factory } = setup(() => ({ body: asrResponse("en") }));
    const result = await factory.create(PROFILE, "scribe_v2_medical").transcribe({ audio: ASSET, terminology: [...KNOWN_MISHEARD_TERMS] }, options());
    expect(result.model).toBe("scribe_v2_medical");
    const { request, bytes } = http.captured[0] as Captured;
    const sent = parts(bytes as Buffer, (request.body as OutboundStreamBody).contentType);
    const field = (name: string): string[] => sent.filter((part) => part.name === name).map((part) => part.content.toString("utf8"));
    expect(field("model_id")).toEqual(["scribe_v2_medical"]);
    expect(field("no_verbatim")).toEqual([]);
    expect(field("keyterms")).toEqual(KNOWN_MISHEARD_TERMS.map((entry) => entry.term));
  });

  it("sends a typed-in model id as typed, with no_verbatim only for the scribe_v2 family", async () => {
    const custom = { ...PROFILE, models: [{ modelId: "scribe_v3", family: "scribe" }, { modelId: "scribe_v2:beta/1", family: "scribe_v2" }] };
    const sentFields = async (model: string): Promise<(name: string) => string[]> => {
      const { http, factory } = setup(() => ({ body: asrResponse("en") }));
      const result = await factory.create(custom, model).transcribe({ audio: ASSET, terminology: [...KNOWN_MISHEARD_TERMS] }, options());
      expect(result.model).toBe(model);
      const { request, bytes } = http.captured[0] as Captured;
      const sent = parts(bytes as Buffer, (request.body as OutboundStreamBody).contentType);
      return (name) => sent.filter((part) => part.name === name).map((part) => part.content.toString("utf8"));
    };
    const plain = await sentFields("scribe_v3");
    expect(plain("model_id")).toEqual(["scribe_v3"]);
    expect(plain("no_verbatim")).toEqual([]);
    expect(plain("keyterms")).toEqual(KNOWN_MISHEARD_TERMS.map((entry) => entry.term));
    const v2 = await sentFields("scribe_v2:beta/1");
    expect(v2("model_id")).toEqual(["scribe_v2:beta/1"]);
    expect(v2("no_verbatim")).toEqual(["false"]);
  });

  it("allows at least ASR_HTTP_TIMEOUT_MIN and scales the timeout with long audio", async () => {
    const { http, provider } = setup(() => ({ body: asrResponse("en") }));
    await provider.transcribe({ audio: ASSET, terminology: [] }, options());
    await provider.transcribe({ audio: { ...ASSET, durationMs: 3 * 3_600_000 }, terminology: [] }, options());
    expect(http.captured.map((entry) => entry.request.timeoutMs)).toEqual([ASR_HTTP_TIMEOUT_MIN * 60_000, 3 * 3_600_000]);
  });

  it("fails the upload when the file does not hold the recorded number of bytes", async () => {
    const { provider } = setup(() => ({ body: asrResponse("en") }), { read: chunked(AUDIO.subarray(1)) });
    await expect(provider.transcribe({ audio: ASSET, terminology: [] }, options())).rejects.toThrow(/smaller than recorded/);
    const larger = setup(() => ({ body: asrResponse("en") }), { read: chunked(new Uint8Array(AUDIO.byteLength + 1)) });
    await expect(larger.provider.transcribe({ audio: ASSET, terminology: [] }, options())).rejects.toThrow(/larger than recorded/);
  });

  it("keeps line breaks out of field values so a term cannot end its part", async () => {
    const { http, provider } = setup(() => ({ body: asrResponse("en") }));
    const term = { id: "t", ordinal: 1, term: "two\r\nlines", normalizedKey: "two lines" };
    await provider.transcribe({ audio: ASSET, terminology: [term] }, options());
    const { request, bytes } = http.captured[0] as Captured;
    const sent = parts(bytes as Buffer, (request.body as OutboundStreamBody).contentType);
    expect(sent.filter((part) => part.name === "keyterms").map((part) => part.content.toString("utf8"))).toEqual(["two lines"]);
  });

  it("reports upload progress up to half and completion at the end", async () => {
    const { provider } = setup(() => ({ body: asrResponse("en") }));
    const progress: number[] = [];
    await provider.transcribe({ audio: ASSET, terminology: [] }, { ...options(), onProgress: (value) => progress.push(value) });
    expect(progress.at(-2)).toBe(0.5);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("refuses a profile without a credential before sending anything", async () => {
    const { http, factory } = setup(() => ({ body: asrResponse("en") }));
    const { credentialRef: _none, ...unconfigured } = PROFILE;
    const error = await failure(factory.create(unconfigured, "scribe_v2").transcribe({ audio: ASSET, terminology: [] }, options()));
    expect(error.appError.class).toBe("asr_unconfigured");
    expect(http.captured).toHaveLength(0);
  });

  it("uses the profile's base URL without a trailing slash", async () => {
    const { http, factory } = setup(() => ({ body: asrResponse("en") }));
    await factory.create({ ...PROFILE, baseURL: "https://relay.example.com/eleven/" }, "scribe_v2").transcribe({ audio: ASSET, terminology: [] }, options());
    expect(http.captured[0]?.request.url).toBe("https://relay.example.com/eleven/v1/speech-to-text");
  });
});

describe("transcribe answer", () => {
  it("keeps word timing in whole milliseconds, drops spacing tokens and merges sentences (English)", async () => {
    const { provider } = setup(() => ({ body: asrResponse("en") }));
    const result = await provider.transcribe({ audio: ASSET, terminology: [] }, options());
    expect(result.language).toBe("en");
    expect(result.provider).toBe("elevenlabs");
    expect(result.model).toBe("scribe_v2");
    expect(result.durationMs).toBe(12_000);
    expect(result.words?.every((word) => Number.isInteger(word.startMs) && Number.isInteger(word.endMs) && word.startMs <= word.endMs)).toBe(true);
    expect(result.words?.some((word) => word.text.trim() === "")).toBe(false);
    expect(result.segments.map((segment) => segment.text)).toEqual([
      "Welcome to generative software engineering.",
      "Today we look at prompts, e.g. how a model reads them.",
      "The first thing to notice is that a prompt is not a magic spell but a specification that the model tries to satisfy,",
      "and like every specification it can be vague, contradictory or incomplete in ways that only show up when you run it so that is the idea",
      "and then we move on to the tools",
    ]);
    for (const [index, segment] of result.segments.entries()) {
      expect(segment.startMs).toBeLessThan(segment.endMs);
      expect(segment.startMs).toBeGreaterThanOrEqual(result.segments[index - 1]?.endMs ?? 0);
    }
  });

  it("merges a Chinese transcript with the Chinese parameters (mixed with English terms)", async () => {
    const { provider } = setup(() => ({ body: asrResponse("mixed") }));
    const result = await provider.transcribe({ audio: ASSET, terminology: [] }, options());
    expect(result.language).toBe("zh");
    expect(result.segments.map((segment) => segment.text)).toEqual([
      "今天我们用 Claude Opus 4.5 来搜索代码。",
      "编译的时候加上 -I 参数，告诉编译器头文件在哪里。",
      "这就是生成式软件工程。",
    ]);
  });

  it("splits an over-long Chinese sentence at its comma and at a pause", () => {
    const result = canonicalFromResponse(asrResponse("zh-synthetic"), { model: "scribe_v2" });
    expect(result.segments.map((segment) => segment.text)).toEqual([
      "欢迎来到生成式软件工程。",
      "这门课我们要讨论的问题是当大语言模型已经能写出相当多的代码，",
      "程序员的工作会变成什么样子以及我们应该怎样重新组织软件开发的过程",
      "好我们先看第一个例子",
      "这个例子很简单。",
    ]);
    expect(result.durationMs).toBe(result.words?.at(-1)?.endMs);
  });

  it("moves punctuation glued to the next token back to its word (recorded Chinese answer)", () => {
    const result = canonicalFromResponse(asrResponse("zh-recorded"), { model: "scribe_v2" });
    expect(result.language).toBe("zh");
    const texts = result.segments.map((segment) => segment.text);
    expect(texts.slice(0, 2)).toEqual(["是的。", "OK，所以我讲了为什么我，我要来上，呃，这门课。"]);
    expect(texts).toContain("啊，这门课的题目叫生成式软件工程，所以我其实是，是一门软件工程课。");
    for (const text of texts) {
      expect(text).not.toMatch(/^[。，、；：！？…]/u);
    }
    for (const word of result.words ?? []) {
      expect(word.text).not.toMatch(/^[。，、；：！？…]/u);
      expect(word.startMs).toBeLessThanOrEqual(word.endMs);
    }
    let previousEnd = 0;
    for (const segment of result.segments) {
      expect(segment.startMs).toBeGreaterThanOrEqual(previousEnd);
      expect(segment.startMs).toBeLessThan(segment.endMs);
      previousEnd = segment.endMs;
    }
    // No recognized character is lost by moving punctuation between tokens.
    const answer = JSON.parse(asrResponse("zh-recorded")) as { words: Array<{ type: string; text: string }> };
    const recognized = answer.words.filter((word) => word.type === "word").map((word) => word.text).join("");
    expect((result.words ?? []).map((word) => word.text).join("")).toBe(recognized);
  });

  it("uses each language's own parameter set, never the other one", () => {
    const seen: Array<{ language: string; params: SentenceParams }> = [];
    for (const name of ["en", "zh-synthetic", "mixed"] as const) {
      canonicalFromResponse(asrResponse(name), { model: "scribe_v2" }, (words, params) => {
        seen.push({ language: name, params });
        return mergeSentences(words, params);
      });
    }
    expect(seen).toEqual([
      { language: "en", params: DEFAULT_SENTENCE_PARAMS },
      { language: "zh-synthetic", params: ZH_SENTENCE_PARAMS },
      { language: "mixed", params: ZH_SENTENCE_PARAMS },
    ]);
  });

  it("treats an unreadable paid answer as an unknown outcome", async () => {
    for (const body of ["<html>oops</html>", JSON.stringify({ text: "x" }), JSON.stringify({ language_code: "eng", text: "", words: [{ text: 1 }] })]) {
      const { provider } = setup(() => ({ body }));
      const error = await failure(provider.transcribe({ audio: ASSET, terminology: [] }, options()));
      expect(error.appError).toMatchObject({ class: "asr_timeout", retryDisposition: "outcome_unknown" });
    }
  });

  it("skips words without timing and audio events", () => {
    const body = JSON.stringify({
      language_code: "eng",
      text: "hello (laughter) world",
      words: [
        { text: "hello", type: "word", start: 0, end: 0.5 },
        { text: " ", type: "spacing", start: 0.5, end: 0.5 },
        { text: "(laughter)", type: "audio_event", start: 0.5, end: 1 },
        { text: "lost", type: "word", start: null, end: null },
        { text: " ", type: "spacing" },
        { text: "world", type: "word", start: 1, end: 1.4 },
      ],
    });
    const result = canonicalFromResponse(body, { model: "scribe_v2" });
    expect(result.words).toEqual([
      { text: "hello", startMs: 0, endMs: 500 },
      { text: "world", startMs: 1000, endMs: 1400 },
    ]);
    expect(result.segments).toEqual([{ startMs: 0, endMs: 1400, text: "hello world" }]);
  });
});

describe("transcribe errors", () => {
  const cases: Array<{ status: number; body: object | string; class: string; code: string; retryDisposition: string }> = [
    { status: 401, body: { detail: { type: "authentication_error", code: "invalid_api_key", message: "The provided API key is invalid." } }, class: "asr_failed", code: "asr_failed.auth", retryDisposition: "never" },
    // Recorded answer for a restricted key without the endpoint's permission (2026-10-01).
    { status: 401, body: { detail: { status: "missing_permissions", code: "unauthorized", type: "authentication_error", message: "The API key you used is missing the permission user_read to execute this operation." } }, class: "asr_failed", code: "asr_failed.permission", retryDisposition: "never" },
    { status: 403, body: { detail: { type: "authorization_error", code: "model_access_denied" } }, class: "asr_failed", code: "asr_failed.permission", retryDisposition: "never" },
    { status: 403, body: { detail: { code: "forbidden" } }, class: "asr_failed", code: "asr_failed.auth", retryDisposition: "never" },
    // An unknown path, not an unknown model: the address or key is wrong.
    { status: 404, body: "not found", class: "asr_failed", code: "asr_failed.auth", retryDisposition: "never" },
    // Model refusals as the API's error reference documents them.
    { status: 404, body: { detail: { type: "not_found", code: "model_not_found", message: "Model not found", param: "model_id" } }, class: "asr_failed", code: "asr_failed.model_unavailable", retryDisposition: "never" },
    { status: 400, body: { detail: { type: "validation_error", code: "unsupported_model", status: "unsupported_model", param: "model_id" } }, class: "asr_failed", code: "asr_failed.model_unavailable", retryDisposition: "never" },
    { status: 400, body: { detail: { type: "validation_error", code: "invalid_parameters", message: "Invalid model id", param: "model_id" } }, class: "asr_failed", code: "asr_failed.model_unavailable", retryDisposition: "never" },
    { status: 404, body: { detail: { status: "model_not_available", message: "The model does not exist." } }, class: "asr_failed", code: "asr_failed.model_unavailable", retryDisposition: "never" },
    // A parameter the model does not take is about the request, not the model.
    { status: 400, body: { detail: { type: "validation_error", code: "invalid_parameters", message: "The 'keyterms' parameter is only supported with the 'scribe_v2' model.", param: "keyterms" } }, class: "asr_failed", code: "asr_failed.invalid_audio", retryDisposition: "never" },
    { status: 402, body: { detail: { type: "payment_required", code: "insufficient_credits" } }, class: "asr_quota", code: "asr_quota", retryDisposition: "never" },
    { status: 401, body: { detail: { status: "quota_exceeded", message: "This request exceeds your quota." } }, class: "asr_quota", code: "asr_quota", retryDisposition: "never" },
    { status: 400, body: { detail: { type: "validation_error", code: "invalid_audio" } }, class: "asr_failed", code: "asr_failed.invalid_audio", retryDisposition: "never" },
    { status: 422, body: { detail: [{ loc: ["body", "file"], msg: "field required", type: "missing" }] }, class: "asr_failed", code: "asr_failed.invalid_audio", retryDisposition: "never" },
    { status: 413, body: "", class: "asr_failed", code: "asr_failed.invalid_audio", retryDisposition: "never" },
    { status: 429, body: { detail: { code: "rate_limit_exceeded" } }, class: "asr_failed", code: "asr_failed", retryDisposition: "policy" },
    { status: 500, body: { detail: { code: "internal_error" } }, class: "asr_failed", code: "asr_failed", retryDisposition: "policy" },
    { status: 503, body: "", class: "asr_failed", code: "asr_failed", retryDisposition: "policy" },
    { status: 409, body: "", class: "asr_failed", code: "asr_failed", retryDisposition: "policy" },
  ];

  for (const testCase of cases) {
    it(`maps HTTP ${testCase.status} ${JSON.stringify(testCase.body).slice(0, 40)} to ${testCase.code}`, async () => {
      const body = typeof testCase.body === "string" ? testCase.body : JSON.stringify(testCase.body);
      const { provider } = setup(() => ({ status: testCase.status, body }));
      const error = await failure(provider.transcribe({ audio: ASSET, terminology: [] }, options()));
      expect(error.appError).toMatchObject({ class: testCase.class, code: testCase.code, retryDisposition: testCase.retryDisposition });
      expect(JSON.stringify(error.appError)).not.toContain(API_KEY);
      expect(error.message).not.toContain(API_KEY);
    });
  }

  it("keeps the upstream code and message, never the key", async () => {
    const { provider } = setup(() => ({ status: 401, body: JSON.stringify({ detail: { code: "invalid_api_key", message: "The provided API key is invalid." } }) }));
    const error = await failure(provider.transcribe({ audio: ASSET, terminology: [] }, options()));
    expect(error.appError.upstreamMessage).toBe("invalid_api_key: The provided API key is invalid.");
  });

  it("classifies transport failures by the send boundary", async () => {
    const before = await failure(setup(() => new OutboundHttpError("before_send", "network")).provider.transcribe({ audio: ASSET, terminology: [] }, options()));
    expect(before.appError).toMatchObject({ class: "asr_failed", code: "asr_failed.unreachable", retryDisposition: "safe" });
    for (const reason of ["network", "timeout"] as const) {
      const after = await failure(setup(() => new OutboundHttpError("after_send", reason)).provider.transcribe({ audio: ASSET, terminology: [] }, options()));
      expect(after.appError).toMatchObject({ class: "asr_timeout", retryDisposition: "outcome_unknown", action: "confirm_resend" });
    }
  });

  it("passes the caller's own cancellation through untouched", async () => {
    const controller = new AbortController();
    const reason = new Error("task cancelled");
    const { provider } = setup(() => {
      controller.abort(reason);
      return new OutboundHttpError("after_send", "aborted");
    });
    await expect(provider.transcribe({ audio: ASSET, terminology: [] }, { signal: controller.signal, onRequestStart: () => undefined })).rejects.toBe(reason);
  });
});

describe("probe", () => {
  it("looks up the account with the key and summarizes the subscription", async () => {
    const { http, factory } = setup(() => ({
      body: JSON.stringify({ subscription: { status: "free", character_count: 17_231, character_limit: 100_000, tier: "free" }, xi_api_key_preview: "abc" }),
    }));
    expect(await factory.probe(PROFILE, signal())).toEqual({ subscriptionStatus: "free", usedUnits: 17_231, limitUnits: 100_000 });
    const [{ request }] = http.captured as [Captured];
    expect(request).toMatchObject({ method: "GET", url: "https://api.elevenlabs.io/v1/user" });
    expect(request.headers?.["xi-api-key"]).toBe(API_KEY);
    expect(request.body).toBeUndefined();
    expect(request.timeoutMs).toBeGreaterThan(0);
  });

  it("accepts a 200 it cannot summarize", async () => {
    const { factory } = setup(() => ({ body: "not json" }));
    expect(await factory.probe(PROFILE, signal())).toEqual({});
  });

  it("reports a rejected key as asr_failed.auth and any transport failure as retryable", async () => {
    const rejected = await failure(setup(() => ({ status: 401, body: "{}" })).factory.probe(PROFILE, signal()));
    expect(rejected.appError).toMatchObject({ code: "asr_failed.auth", action: "configure_asr" });
    const underScoped = await failure(
      setup(() => ({ status: 401, body: JSON.stringify({ detail: { status: "missing_permissions", code: "unauthorized" } }) })).factory.probe(PROFILE, signal()),
    );
    expect(underScoped.appError).toMatchObject({ code: "asr_failed.permission", action: "configure_asr", retryDisposition: "never" });
    for (const phase of ["before_send", "after_send"] as const) {
      const error = await failure(setup(() => new OutboundHttpError(phase, "timeout")).factory.probe(PROFILE, signal()));
      expect(error.appError).toMatchObject({ code: "asr_failed.unreachable", retryDisposition: "safe" });
    }
  });
});
