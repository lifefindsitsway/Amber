import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalFromResultFile,
  DASHSCOPE_DESCRIPTOR,
  DashscopeAsrProviderFactory,
  inferLanguage,
  toDashscopeLanguageHint,
} from "../../../../../src/server/adapters/asr/dashscope/index.ts";
import { AmberError, isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../../../src/server/domain/media-asset.ts";
import type { AsrModelEntry, AsrProviderProfile } from "../../../../../src/server/domain/provider-profile.ts";
import type { AsrJobHandle, AsrJobProvider, AsrJobReport } from "../../../../../src/server/ports/asr-provider.ts";
import { OutboundHttpError, type OutboundRequest, type OutboundResponse, type OutboundStreamBody } from "../../../../../src/server/ports/outbound-http.ts";
import { ASR_PRESETS } from "../../../../../src/shared/asr-presets.ts";
import { ASR_RESULT_MAX_MB } from "../../../../../src/shared/defaults.ts";
import { KNOWN_MISHEARD_TERMS } from "../../../../fixtures/asr/index.ts";

const API_KEY = "<dashscope-test-key>";
const BASE = "https://dashscope.aliyuncs.com";
const UPLOAD_HOST = "https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com";
const RESULT_URL = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json?Expires=1&Signature=abc";
const AUDIO = new Uint8Array(Array.from({ length: 40_000 }, (_, index) => index % 253));
const QWEN = "qwen-audio-3.1-asr-flash-filetrans";

const fixture = (name: "zh" | "en"): string => readFileSync(join(import.meta.dirname, `../../../../fixtures/asr/dashscope-${name}.json`), "utf8");

function profile(models: ReadonlyArray<string | AsrModelEntry> = [QWEN, "fun-asr"]): AsrProviderProfile {
  const entries = models.map((model) => (typeof model === "string" ? { modelId: model } : model));
  return { id: "asr-1", userId: "user-1", name: "百炼", provider: "dashscope", models: entries, credentialRef: "secret-1", createdAt: 0 };
}

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

interface Answer {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

interface Captured {
  request: OutboundRequest;
  bytes?: Buffer;
}

const POLICY = {
  request_id: "req-policy",
  data: {
    policy: "cG9saWN5",
    signature: "c2lnbmF0dXJl",
    upload_dir: "dashscope-instant/abc/2026-10-16/xyz",
    upload_host: UPLOAD_HOST,
    expire_in_seconds: 300,
    max_file_size_mb: 1024,
    capacity_limit_mb: 999999999,
    oss_access_key_id: "LTAI-test",
    x_oss_object_acl: "private",
    x_oss_forbid_overwrite: "true",
  },
};

type Route = (request: OutboundRequest) => Answer | Error;

/** Answers by request kind; anything unscripted fails the test. */
function routes(overrides: Partial<Record<"policy" | "upload" | "submit" | "poll" | "result" | "cancel", Route>> = {}): Route {
  const defaults: Record<string, Route> = {
    policy: () => ({ body: JSON.stringify(POLICY) }),
    upload: () => ({ status: 200, body: "" }),
    submit: () => ({ body: JSON.stringify({ request_id: "req-submit", output: { task_id: "task-123", task_status: "PENDING" } }) }),
    poll: () => ({
      body: JSON.stringify({
        request_id: "req-poll",
        output: { task_id: "task-123", task_status: "SUCCEEDED", results: [{ file_url: "oss://x", transcription_url: RESULT_URL, subtask_status: "SUCCEEDED" }] },
      }),
    }),
    result: () => ({ body: fixture("zh") }),
    cancel: () => ({ body: JSON.stringify({ request_id: "req-cancel" }) }),
  };
  const table = { ...defaults, ...overrides } as Record<string, Route>;
  return (request) => {
    const kind = request.url.startsWith(UPLOAD_HOST)
      ? "upload"
      : request.url.startsWith(`${BASE}/api/v1/uploads`)
        ? "policy"
        : request.url.endsWith("/asr/transcription")
          ? "submit"
          : request.url.endsWith("/cancel")
            ? "cancel"
            : request.url.startsWith(`${BASE}/api/v1/tasks/`)
              ? "poll"
              : "result";
    return (table[kind] as Route)(request);
  };
}

class StubHttp {
  readonly captured: Captured[] = [];
  private readonly route: Route;

  constructor(route: Route) {
    this.route = route;
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
    const answer = this.route(request);
    if (answer instanceof Error) {
      throw answer;
    }
    const bytes = new TextEncoder().encode(answer.body ?? "");
    return {
      status: answer.status ?? 200,
      headers: new Map(Object.entries(answer.headers ?? {})),
      body: (async function* () {
        // Several chunks, so bounded reads are exercised chunk by chunk.
        for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
          yield bytes.subarray(offset, offset + 4096);
        }
      })(),
      text: async () => new TextDecoder().decode(bytes),
    };
  }
}

const KEY_VERSION = { versionId: "version-1", setAt: 1_700_000_000_000 };

function setup(route: Route = routes(), model = QWEN, models?: ReadonlyArray<string | AsrModelEntry>) {
  const http = new StubHttp(route);
  const reveals: string[] = [];
  const factory = new DashscopeAsrProviderFactory({
    http,
    files: {
      read: async function* () {
        for (let offset = 0; offset < AUDIO.byteLength; offset += 16_384) {
          yield AUDIO.subarray(offset, offset + 16_384);
        }
      },
    },
    secrets: {
      reveal: () => {
        reveals.push("reveal");
        return API_KEY;
      },
      revealVersioned: () => {
        reveals.push("revealVersioned");
        return { plaintext: API_KEY, version: KEY_VERSION };
      },
    },
    now: () => 1_000,
    newId: () => "01JOBFILE",
  });
  return { http, factory, reveals, provider: factory.create(profile(models), model) };
}

const signal = (): AbortSignal => new AbortController().signal;
const HANDLE: AsrJobHandle = { version: 1, provider: "dashscope", jobId: "task-123", submittedAt: 1_000 };

async function failure(promise: Promise<unknown>): Promise<AmberError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(isAmberError(error)).toBe(true);
  return error as AmberError;
}

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
  return result;
}

async function submit(provider: AsrJobProvider, terminology = [...KNOWN_MISHEARD_TERMS], language: string | undefined = "zh-CN") {
  const events: string[] = [];
  const handle = await provider.submit(
    { audio: ASSET, terminology, ...(language === undefined ? {} : { language }) },
    { signal: signal(), onRequestStart: () => events.push("paid") },
  );
  return { handle, events };
}

describe("descriptor and per-model capabilities", () => {
  it("publishes the shared preset", () => {
    expect(DASHSCOPE_DESCRIPTOR).toBe(ASR_PRESETS.dashscope);
    expect(DASHSCOPE_DESCRIPTOR.models).toEqual([QWEN, "fun-asr"]);
  });

  it("declares terminology bias for qwen-audio and not for fun-asr, both as jobs", () => {
    const qwen = setup(routes(), QWEN).provider.capabilities;
    const fun = setup(routes(), "fun-asr").provider.capabilities;
    expect(qwen).toMatchObject({ delivery: "job", terminologyBias: true, maxTerminologyEntries: 2000, wordTimestamps: true, maxDurationSec: 43_200 });
    expect(fun).toMatchObject({ delivery: "job", terminologyBias: false, wordTimestamps: true, maxDurationSec: 43_200 });
    expect(qwen.maxFileBytes).toBe(1024 * 1024 * 1024);
  });

  it("refuses a model not on the profile, or one whose family does not resolve", () => {
    const cases: Array<[string, Array<string | AsrModelEntry>]> = [
      ["paraformer-v2", [QWEN, "fun-asr"]],
      ["paraformer-v2", ["paraformer-v2"]],
      ["paraformer-v2", [{ modelId: "paraformer-v2", family: "paraformer" }]],
    ];
    for (const [model, models] of cases) {
      let thrown: unknown;
      try {
        setup(routes(), model, models);
      } catch (error) {
        thrown = error;
      }
      expect(isAmberError(thrown) && thrown.appError.code).toBe("asr_failed.model_unavailable");
    }
  });

  it("gives a known model its own family whatever the entry names", () => {
    expect(setup(routes(), "fun-asr", [{ modelId: "fun-asr", family: "qwen_audio" }]).provider.capabilities.terminologyBias).toBe(false);
  });

  it("gives a typed-in model its family's capabilities", () => {
    const qwen = setup(routes(), "qwen3-asr-flash-filetrans", [{ modelId: "qwen3-asr-flash-filetrans", family: "qwen_audio" }]).provider.capabilities;
    const fun = setup(routes(), "fun-asr-2026", [{ modelId: "fun-asr-2026", family: "fun_asr" }]).provider.capabilities;
    expect(qwen).toMatchObject({ terminologyBias: true, maxTerminologyEntries: 2000 });
    expect(fun).toMatchObject({ terminologyBias: false });
  });
});

describe("submit", () => {
  it("asks for upload space, uploads the file last, then creates the job right after onRequestStart", async () => {
    const order: string[] = [];
    const base = routes();
    const { http, provider } = setup((request) => {
      order.push(request.url.endsWith("/asr/transcription") ? "submit" : request.url.startsWith(UPLOAD_HOST) ? "upload" : "policy");
      return base(request);
    });
    const events: string[] = [];
    const handle = await (provider as AsrJobProvider).submit(
      { audio: ASSET, terminology: [...KNOWN_MISHEARD_TERMS], language: "zh-CN" },
      { signal: signal(), onRequestStart: () => events.push(`paid after ${order.length}`) },
    );
    expect(order).toEqual(["policy", "upload", "submit"]);
    expect(events).toEqual(["paid after 2"]);
    expect(handle).toEqual({ version: 1, provider: "dashscope", jobId: "task-123", submittedAt: 1_000 });

    const [policy, upload, job] = http.captured as [Captured, Captured, Captured];
    expect(policy.request.url).toBe(`${BASE}/api/v1/uploads?action=getPolicy&model=${QWEN}`);
    expect(policy.request.headers?.["authorization"]).toBe(`Bearer ${API_KEY}`);

    expect(upload.request.headers?.["authorization"]).toBeUndefined();
    const body = upload.request.body as OutboundStreamBody;
    expect(upload.bytes?.byteLength).toBe(body.contentLength);
    const sent = parts(upload.bytes as Buffer, body.contentType);
    expect(sent.map((part) => part.name)).toEqual([
      "OSSAccessKeyId",
      "Signature",
      "policy",
      "x-oss-object-acl",
      "x-oss-forbid-overwrite",
      "key",
      "success_action_status",
      "file",
    ]);
    const key = sent.find((part) => part.name === "key")?.content.toString("utf8");
    expect(key).toBe(`${POLICY.data.upload_dir}/01JOBFILE.flac`);
    expect(Buffer.compare(sent.at(-1)?.content as Buffer, Buffer.from(AUDIO))).toBe(0);

    expect(job.request.headers).toMatchObject({ "x-dashscope-async": "enable", "x-dashscope-ossresourceresolve": "enable", authorization: `Bearer ${API_KEY}` });
    const request = JSON.parse(job.request.body as string) as { model: string; input: { file_urls: string[] }; parameters: Record<string, unknown> };
    expect(request.model).toBe(QWEN);
    expect(request.input.file_urls).toEqual([`oss://${key}`]);
    expect(request.parameters).toEqual({
      channel_id: [0],
      diarization_enabled: false,
      special_word_filter: JSON.stringify({ system_reserved_filter: false }),
      language_hints: ["zh"],
      vocabulary: Object.fromEntries(KNOWN_MISHEARD_TERMS.map((entry) => [entry.term, 4])),
    });
    expect(typeof request.parameters["special_word_filter"]).toBe("string");
  });

  it("sends no vocabulary for fun-asr and no hints for a language the model does not list", async () => {
    const { http, provider } = setup(routes(), "fun-asr");
    await submit(provider as AsrJobProvider, [...KNOWN_MISHEARD_TERMS], "de");
    const job = http.captured.find((entry) => entry.request.url.endsWith("/asr/transcription")) as Captured;
    const request = JSON.parse(job.request.body as string) as { parameters: Record<string, unknown> };
    expect(request.parameters).toEqual({
      channel_id: [0],
      diarization_enabled: false,
      special_word_filter: JSON.stringify({ system_reserved_filter: false }),
    });
    expect(http.captured[0]?.request.url).toContain("model=fun-asr");
  });

  it("submits each model of one profile under its own model id, with the same key", async () => {
    const { http, factory } = setup();
    for (const model of [QWEN, "fun-asr"]) {
      await submit(factory.create(profile(), model) as AsrJobProvider, [], "zh");
    }
    const jobs = http.captured.filter((entry) => entry.request.url.endsWith("/asr/transcription"));
    expect(jobs.map((entry) => (JSON.parse(entry.request.body as string) as { model: string }).model)).toEqual([QWEN, "fun-asr"]);
    expect(jobs.map((entry) => entry.request.headers?.["authorization"])).toEqual([`Bearer ${API_KEY}`, `Bearer ${API_KEY}`]);
    const policies = http.captured.filter((entry) => entry.request.url.includes("action=getPolicy"));
    expect(policies.map((entry) => new URL(entry.request.url).searchParams.get("model"))).toEqual([QWEN, "fun-asr"]);
  });

  it("sends a typed-in model id as typed, with its family's parameters", async () => {
    const custom = "qwen3-asr-flash-filetrans:2026/v1";
    const qwen = setup(routes(), custom, [{ modelId: custom, family: "qwen_audio" }]);
    await submit(qwen.provider as AsrJobProvider, [...KNOWN_MISHEARD_TERMS], "ko");
    const qwenPolicy = qwen.http.captured[0] as Captured;
    expect(qwenPolicy.request.url).toBe(`${BASE}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(custom)}`);
    expect(new URL(qwenPolicy.request.url).searchParams.get("model")).toBe(custom);
    const qwenJob = JSON.parse((qwen.http.captured.find((entry) => entry.request.url.endsWith("/asr/transcription")) as Captured).request.body as string) as { model: string; parameters: Record<string, unknown> };
    expect(qwenJob.model).toBe(custom);
    expect(qwenJob.parameters["language_hints"]).toEqual(["ko"]);
    expect(qwenJob.parameters["vocabulary"]).toEqual(Object.fromEntries(KNOWN_MISHEARD_TERMS.map((entry) => [entry.term, 4])));

    const fun = setup(routes(), "fun-asr-2026", [{ modelId: "fun-asr-2026", family: "fun_asr" }]);
    await submit(fun.provider as AsrJobProvider, [...KNOWN_MISHEARD_TERMS], "zh");
    const funJob = JSON.parse((fun.http.captured.find((entry) => entry.request.url.endsWith("/asr/transcription")) as Captured).request.body as string) as { model: string; parameters: Record<string, unknown> };
    expect(funJob.model).toBe("fun-asr-2026");
    expect(funJob.parameters).not.toHaveProperty("vocabulary");
    expect(funJob.parameters["language_hints"]).toEqual(["zh"]);
  });

  it("sends no vocabulary without terminology", async () => {
    const { http, provider } = setup();
    await submit(provider as AsrJobProvider, [], undefined);
    const job = http.captured.find((entry) => entry.request.url.endsWith("/asr/transcription")) as Captured;
    expect((JSON.parse(job.request.body as string) as { parameters: Record<string, unknown> }).parameters).not.toHaveProperty("vocabulary");
  });

  it("refuses an upload host outside the service's storage before sending anything else", async () => {
    const { http, provider } = setup(routes({ policy: () => ({ body: JSON.stringify({ data: { ...POLICY.data, upload_host: "https://evil.example.com" } }) }) }));
    const error = await failure(submit(provider as AsrJobProvider));
    expect(error.appError.code).toBe("asr_failed.job_failed");
    expect(http.captured).toHaveLength(1);
  });

  it("refuses audio over the size the policy grants", async () => {
    const { provider } = setup(routes({ policy: () => ({ body: JSON.stringify({ data: { ...POLICY.data, max_file_size_mb: 0.01 } }) }) }));
    expect((await failure(submit(provider as AsrJobProvider))).appError.class).toBe("media_too_large");
  });

  it("refuses an oversized control answer", async () => {
    const { provider } = setup(routes({ policy: () => ({ body: "x".repeat(1024 * 1024 + 1) }) }));
    expect((await failure(submit(provider as AsrJobProvider))).appError.code).toBe("asr_failed.job_failed");
  });

  it.each([
    ["submit 500", { submit: () => ({ status: 500, body: JSON.stringify({ code: "InternalError", message: "boom" }) }) }, "asr_timeout", "outcome_unknown"],
    ["submit lost after send", { submit: () => new OutboundHttpError("after_send", "network") }, "asr_timeout", "outcome_unknown"],
    ["submit refused before send", { submit: () => new OutboundHttpError("before_send", "network") }, "asr_failed.unreachable", "safe"],
    ["submit 429", { submit: () => ({ status: 429, headers: { "retry-after": "7" }, body: JSON.stringify({ code: "Throttling", message: "slow" }) }) }, "asr_failed.rate_limited", "policy"],
    ["submit 400 invalid file", { submit: () => ({ status: 400, body: JSON.stringify({ code: "InvalidFile.Format", message: "bad" }) }) }, "asr_failed.invalid_audio", "never"],
    ["submit 403 free tier", { submit: () => ({ status: 403, body: JSON.stringify({ code: "AllocationQuota.FreeTierOnly", message: "The free tier of the model has been exhausted." }) }) }, "asr_quota.free_tier_exhausted", "never"],
    ["submit 403 access denied", { submit: () => ({ status: 403, body: JSON.stringify({ code: "AccessDenied", message: "no" }) }) }, "asr_failed.permission", "never"],
    ["submit 404 model", { submit: () => ({ status: 404, body: JSON.stringify({ code: "ModelNotFound", message: "no model" }) }) }, "asr_failed.model_unavailable", "never"],
    ["submit 200 without task id", { submit: () => ({ body: "{}" }) }, "asr_timeout", "outcome_unknown"],
    ["policy 401", { policy: () => ({ status: 401, body: JSON.stringify({ code: "InvalidApiKey", message: "Invalid API-key provided." }) }) }, "asr_failed.auth", "never"],
    ["policy 400 arrears", { policy: () => ({ status: 400, body: JSON.stringify({ code: "Arrearage", message: "overdue" }) }) }, "asr_quota", "never"],
    ["policy 400 model", { policy: () => ({ status: 400, body: JSON.stringify({ code: "InvalidParameter", message: "model" }) }) }, "asr_failed.model_unavailable", "never"],
    ["policy 503", { policy: () => ({ status: 503, body: "" }) }, "asr_failed", "policy"],
    ["policy transport", { policy: () => new OutboundHttpError("after_send", "timeout") }, "asr_failed.unreachable", "safe"],
    ["upload 403 policy expired", { upload: () => ({ status: 403, body: "<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy expired.</Message></Error>" }) }, "asr_failed", "policy"],
    ["upload 400", { upload: () => ({ status: 400, body: "<Error><Code>InvalidArgument</Code></Error>" }) }, "asr_failed.invalid_audio", "never"],
    ["upload transport", { upload: () => new OutboundHttpError("after_send", "network") }, "asr_failed.unreachable", "safe"],
  ] as const)("classifies %s", async (_name, override, code, disposition) => {
    const { provider } = setup(routes(override as Parameters<typeof routes>[0]));
    const error = await failure(submit(provider as AsrJobProvider));
    expect(error.appError.code).toBe(code);
    expect(error.appError.retryDisposition).toBe(disposition);
    expect(JSON.stringify(error.appError)).not.toContain(API_KEY);
    expect(error.appError.details === undefined || Object.keys(error.appError.details).every((key) => key === "retryAfterMs")).toBe(true);
  });

  it("carries the upstream code and message, and the throttle wait", async () => {
    const { provider } = setup(routes({ submit: () => ({ status: 429, headers: { "retry-after": "7" }, body: JSON.stringify({ code: "Throttling", message: "slow down" }) }) }));
    const error = await failure(submit(provider as AsrJobProvider));
    expect(error.appError.upstreamMessage).toBe("Throttling: slow down");
    expect(error.appError.details).toEqual({ retryAfterMs: 7000 });
  });

  it("does not call onRequestStart when the upload fails", async () => {
    const { provider } = setup(routes({ upload: () => ({ status: 500, body: "" }) }));
    const events: string[] = [];
    await failure((provider as AsrJobProvider).submit({ audio: ASSET, terminology: [] }, { signal: signal(), onRequestStart: () => events.push("paid") }));
    expect(events).toEqual([]);
  });
});

describe("request start", () => {
  it("creates the job with the key it reported, and only that request reports a start", async () => {
    const events: string[] = [];
    const base = routes();
    // Each reveal hands out a different key, so a second reveal between report and send would show.
    let revealed = 0;
    const http = new StubHttp((request) => {
      events.push(`${request.url.endsWith("/asr/transcription") ? "submit" : request.url.startsWith(UPLOAD_HOST) ? "upload" : "policy"} ${String(request.headers?.["authorization"])}`);
      return base(request);
    });
    const factory = new DashscopeAsrProviderFactory({
      http,
      files: { read: async function* () { yield AUDIO; } },
      secrets: {
        reveal: () => `plain-${(revealed += 1)}`,
        revealVersioned: () => ({ plaintext: `paid-${(revealed += 1)}`, version: { versionId: `version-${revealed}`, setAt: revealed } }),
      },
      now: () => 4_242,
      newId: () => "01JOBFILE",
    });
    const provider = factory.create(profile(), QWEN) as AsrJobProvider;
    const infos: unknown[] = [];
    await provider.submit(
      { audio: ASSET, terminology: [] },
      {
        signal: signal(),
        onRequestStart: (info) => {
          infos.push(info);
          events.push("started");
        },
      },
    );
    expect(events).toEqual(["policy Bearer plain-1", "upload undefined", "started", "submit Bearer paid-2"]);
    expect(infos).toEqual([{ sentAt: 4_242, credential: { versionId: "version-2", setAt: 2 } }]);

    // Later queries reveal on their own and never report a start.
    await provider.poll(HANDLE, { signal: signal() });
    const poll = http.captured.find((entry) => entry.request.url === `${BASE}/api/v1/tasks/task-123`);
    expect(poll?.request.headers?.["authorization"]).toBe("Bearer plain-3");
    expect(infos).toHaveLength(1);
  });

  it("sends nothing and creates no job when the start callback refuses", async () => {
    const { http, provider } = setup();
    const refusal = new Error("do not send");
    await expect(
      (provider as AsrJobProvider).submit(
        { audio: ASSET, terminology: [] },
        {
          signal: signal(),
          onRequestStart: () => {
            throw refusal;
          },
        },
      ),
    ).rejects.toBe(refusal);
    expect(http.captured.some((entry) => entry.request.url.endsWith("/asr/transcription"))).toBe(false);
  });

  it("reveals the paid key once, for the creating request only", async () => {
    const { reveals, provider } = setup();
    await submit(provider as AsrJobProvider);
    // The upload space is asked for with an ordinary reveal; the upload carries none.
    expect(reveals).toEqual(["reveal", "revealVersioned"]);
  });
});

describe("poll", () => {
  it("reports a queued or running job as pending", async () => {
    for (const status of ["PENDING", "RUNNING"]) {
      const { provider } = setup(routes({ poll: () => ({ body: JSON.stringify({ output: { task_id: "task-123", task_status: status } }) }) }));
      expect(await (provider as AsrJobProvider).poll(HANDLE, { signal: signal() })).toEqual({ state: "pending" });
    }
  });

  it("reports a throttled query as pending with the service's wait", async () => {
    const { provider } = setup(routes({ poll: () => ({ status: 429, headers: { "retry-after": "3" }, body: "{}" }) }));
    expect(await (provider as AsrJobProvider).poll(HANDLE, { signal: signal() })).toEqual({ state: "pending", retryAfterMs: 3000 });
  });

  it("reports an unknown job as missing", async () => {
    const unknown = setup(routes({ poll: () => ({ body: JSON.stringify({ output: { task_id: "task-123", task_status: "UNKNOWN" } }) }) }));
    expect(await (unknown.provider as AsrJobProvider).poll(HANDLE, { signal: signal() })).toEqual({ state: "missing" });
    const notFound = setup(routes({ poll: () => ({ status: 404, body: JSON.stringify({ code: "NotFound" }) }) }));
    expect(await (notFound.provider as AsrJobProvider).poll(HANDLE, { signal: signal() })).toEqual({ state: "missing" });
  });

  it("downloads and normalizes the result of a finished job without our key", async () => {
    const { http, provider } = setup();
    const status = await (provider as AsrJobProvider).poll(HANDLE, { signal: signal() });
    expect(http.captured[0]?.request.url).toBe(`${BASE}/api/v1/tasks/task-123`);
    const download = http.captured[1] as Captured;
    expect(download.request.url).toBe(RESULT_URL);
    expect(download.request.headers?.["authorization"]).toBeUndefined();
    expect(status).toMatchObject({ state: "done", result: { provider: "dashscope", model: QWEN, language: "zh", durationMs: 5200 } });
    if (status.state !== "done") {
      throw new Error("not done");
    }
    expect(status.result.segments).toEqual([
      { startMs: 100, endMs: 2300, text: "欢迎来到生成式软件工程。" },
      { startMs: 2600, endMs: 4900, text: "今天我们讲提示词。" },
    ]);
    expect(status.result.words?.map((word) => word.text)).toEqual(["欢迎", "来到", "生成式", "软件工程。", "今天", "我们", "讲", "提示词。"]);
  });

  it("refuses a result link outside the service's storage", async () => {
    const { http, provider } = setup(
      routes({
        poll: () => ({
          body: JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{ subtask_status: "SUCCEEDED", transcription_url: "https://evil.example.com/r.json" }] } }),
        }),
      }),
    );
    expect((await failure((provider as AsrJobProvider).poll(HANDLE, { signal: signal() }))).appError.code).toBe("asr_failed.job_failed");
    expect(http.captured).toHaveLength(1);
  });

  it("refuses a result over ASR_RESULT_MAX_MB", async () => {
    const { provider } = setup(routes({ result: () => ({ body: " ".repeat(ASR_RESULT_MAX_MB * 1024 * 1024 + 1) }) }));
    expect((await failure((provider as AsrJobProvider).poll(HANDLE, { signal: signal() }))).appError.code).toBe("asr_failed.job_failed");
  });

  it.each([
    ["no valid fragment", "SUCCESS_WITH_NO_VALID_FRAGMENT", "media_no_audio"],
    ["decode error", "DECODE_ERROR", "asr_failed.invalid_audio"],
    ["expired", "FILE_TRANS_TASK_EXPIRED", "asr_failed.job_expired"],
    ["download failed", "FILE_DOWNLOAD_FAILED", "asr_failed.job_failed"],
  ])("maps a failed file (%s)", async (_name, code, expected) => {
    const { provider } = setup(
      routes({ poll: () => ({ body: JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{ subtask_status: "FAILED", code, message: "m" }] } }) }) }),
    );
    const error = await failure((provider as AsrJobProvider).poll(HANDLE, { signal: signal() }));
    expect(error.appError.code).toBe(expected);
    expect(error.appError.retryDisposition).toBe("never");
  });

  it("maps a failed or cancelled job", async () => {
    const failed = setup(routes({ poll: () => ({ body: JSON.stringify({ output: { task_status: "FAILED", code: "InternalError", message: "m" } }) }) }));
    expect((await failure((failed.provider as AsrJobProvider).poll(HANDLE, { signal: signal() }))).appError.code).toBe("asr_failed.job_failed");
    const cancelled = setup(routes({ poll: () => ({ body: JSON.stringify({ output: { task_status: "CANCELED" } }) }) }));
    expect((await failure((cancelled.provider as AsrJobProvider).poll(HANDLE, { signal: signal() }))).appError.code).toBe("asr_failed.job_expired");
  });

  it("retries server errors and transport failures of a state query", async () => {
    const server = setup(routes({ poll: () => ({ status: 502, body: "" }) }));
    expect((await failure((server.provider as AsrJobProvider).poll(HANDLE, { signal: signal() }))).appError.retryDisposition).toBe("policy");
    const lost = setup(routes({ poll: () => new OutboundHttpError("after_send", "network") }));
    expect((await failure((lost.provider as AsrJobProvider).poll(HANDLE, { signal: signal() }))).appError.code).toBe("asr_failed.unreachable");
  });

  it("refuses a handle of another provider or version", async () => {
    const { http, provider } = setup();
    expect((await failure((provider as AsrJobProvider).poll({ ...HANDLE, provider: "elevenlabs" }, { signal: signal() }))).appError.class).toBe("internal");
    expect((await failure((provider as AsrJobProvider).poll({ ...HANDLE, version: 2 } as unknown as AsrJobHandle, { signal: signal() }))).appError.class).toBe("internal");
    expect(http.captured).toHaveLength(0);
  });
});

describe("job reports", () => {
  const succeeded = (extra: Record<string, unknown>, results: unknown = [{ file_url: "oss://x", transcription_url: RESULT_URL, subtask_status: "SUCCEEDED" }]) =>
    JSON.stringify({ request_id: "req-poll", output: { task_id: "task-123", task_status: "SUCCEEDED", results }, ...extra });

  async function pollReports(route: Route): Promise<{ reports: AsrJobReport[]; outcome: "done" | AmberError }> {
    const { provider } = setup(route);
    const reports: AsrJobReport[] = [];
    const attempt = (provider as AsrJobProvider).poll(HANDLE, { signal: signal(), onJobReport: (report) => reports.push(report) });
    const outcome = await attempt.then(
      () => "done" as const,
      (thrown: unknown) => thrown as AmberError,
    );
    return { reports, outcome };
  }

  it("reports a qwen-audio success with billed tokens and time from the measured usage", async () => {
    const usage = { duration: 12, input_tokens: 150, output_tokens: 39, total_tokens: 189 };
    const { reports, outcome } = await pollReports(routes({ poll: () => ({ body: succeeded({ usage }) }) }));
    expect(outcome).toBe("done");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ remote: "succeeded", usage: { billedInputTokens: 150, billedOutputTokens: 39, billedAudioMs: 12_000 } });
    // The raw record keeps the whitelisted fields as received, total_tokens included.
    expect(JSON.parse(reports[0]?.rawUsageJson as string)).toEqual(usage);
  });

  it("reports a fun-asr success with billed time only", async () => {
    const { reports } = await pollReports(routes({ poll: () => ({ body: succeeded({ usage: { duration: 12 } }) }) }));
    expect(reports[0]).toEqual({ remote: "succeeded", usage: { billedAudioMs: 12_000 }, rawUsageJson: JSON.stringify({ duration: 12 }) });
  });

  it("reports a failed job without any billing when the answer has no usage", async () => {
    const body = JSON.stringify({
      output: { task_id: "task-123", task_status: "FAILED", code: "DECODE_ERROR", message: "decode", results: [{ subtask_status: "FAILED", code: "DECODE_ERROR", usage: {} }] },
    });
    const { reports, outcome } = await pollReports(routes({ poll: () => ({ body }) }));
    expect(isAmberError(outcome) && outcome.appError.code).toBe("asr_failed.invalid_audio");
    expect(reports).toEqual([{ remote: "failed" }]);
  });

  it("reports a failed subtask of a succeeded task as failed, and a cancelled job as cancelled", async () => {
    const subtask = JSON.stringify({
      output: { task_status: "SUCCEEDED", results: [{ subtask_status: "FAILED", code: "DECODE_ERROR", message: "m" }] },
    });
    const failed = await pollReports(routes({ poll: () => ({ body: subtask }) }));
    expect(failed.reports).toEqual([{ remote: "failed" }]);
    const cancelled = await pollReports(routes({ poll: () => ({ body: JSON.stringify({ output: { task_status: "CANCELED" } }) }) }));
    expect(isAmberError(cancelled.outcome) && cancelled.outcome.appError.code).toBe("asr_failed.job_expired");
    expect(cancelled.reports).toEqual([{ remote: "cancelled" }]);
  });

  it("reads usage leniently: whitelisted finite numbers only, seconds only without duration", async () => {
    const messy = { input_tokens: "150", output_tokens: 39.4, total_tokens: -1, seconds: 7.25, duration: null, request_url: "https://x.example/?Signature=secret", unknown_field: 5 };
    const { reports } = await pollReports(routes({ poll: () => ({ body: succeeded({ usage: messy }) }) }));
    expect(reports[0]).toEqual({ remote: "succeeded", usage: { billedOutputTokens: 39, billedAudioMs: 7250 }, rawUsageJson: JSON.stringify({ output_tokens: 39.4, seconds: 7.25 }) });
    expect(reports[0]?.rawUsageJson).not.toContain("Signature");

    const both = await pollReports(routes({ poll: () => ({ body: succeeded({ usage: { duration: 3, seconds: 9 } }) }) }));
    expect(both.reports[0]?.usage).toEqual({ billedAudioMs: 3000 });

    const onlyTotal = await pollReports(routes({ poll: () => ({ body: succeeded({ usage: { total_tokens: 10 } }) }) }));
    expect(onlyTotal.reports[0]).toEqual({ remote: "succeeded", rawUsageJson: JSON.stringify({ total_tokens: 10 }) });

    for (const usage of [undefined, null, [], "x", {}]) {
      const none = await pollReports(routes({ poll: () => ({ body: succeeded(usage === undefined ? {} : { usage }) }) }));
      expect(none.reports).toEqual([{ remote: "succeeded" }]);
    }
  });

  it("reports a success before the result is downloaded", async () => {
    const events: string[] = [];
    const { provider } = setup(
      routes({
        result: () => {
          events.push("download");
          return { body: fixture("zh") };
        },
      }),
    );
    await (provider as AsrJobProvider).poll(HANDLE, { signal: signal(), onJobReport: (report) => events.push(`report ${report.remote}`) });
    expect(events).toEqual(["report succeeded", "download"]);
  });

  it("has already reported a remote success when the download or the normalization fails locally", async () => {
    const download = await pollReports(routes({ result: () => ({ status: 500, body: "" }) }));
    expect(isAmberError(download.outcome)).toBe(true);
    expect(download.reports).toEqual([{ remote: "succeeded" }]);

    const malformed = await pollReports(routes({ result: () => ({ body: JSON.stringify({ transcripts: [] }) }) }));
    expect(isAmberError(malformed.outcome) && malformed.outcome.appError.code).toBe("asr_failed.job_failed");
    expect(malformed.reports).toEqual([{ remote: "succeeded" }]);
  });

  it("reports nothing while the job is pending, throttled, unknown or an unreadable state", async () => {
    const answers: Route[] = [
      routes({ poll: () => ({ body: JSON.stringify({ output: { task_status: "RUNNING" }, usage: { duration: 3 } }) }) }),
      routes({ poll: () => ({ status: 429, headers: { "retry-after": "3" }, body: "{}" }) }),
      routes({ poll: () => ({ body: JSON.stringify({ output: { task_status: "UNKNOWN" } }) }) }),
      routes({ poll: () => ({ status: 404, body: "{}" }) }),
      routes({ poll: () => ({ status: 502, body: "" }) }),
      routes({ poll: () => ({ body: "not json" }) }),
    ];
    for (const route of answers) {
      expect((await pollReports(route)).reports).toEqual([]);
    }
  });

  it("is not disturbed by a report callback that throws", async () => {
    const { provider } = setup(routes({ poll: () => ({ body: succeeded({ usage: { duration: 12 } }) }) }));
    const status = await (provider as AsrJobProvider).poll(HANDLE, {
      signal: signal(),
      onJobReport: () => {
        throw new Error("bookkeeping failed");
      },
    });
    expect(status.state).toBe("done");
    const failing = setup(routes({ poll: () => ({ body: JSON.stringify({ output: { task_status: "FAILED", code: "InternalError" } }) }) }));
    const error = await failure(
      (failing.provider as AsrJobProvider).poll(HANDLE, {
        signal: signal(),
        onJobReport: () => {
          throw new Error("bookkeeping failed");
        },
      }),
    );
    expect(error.appError.code).toBe("asr_failed.job_failed");
  });
});

describe("cancel", () => {
  it("reports cancelled, already terminal, or throws", async () => {
    const ok = setup();
    expect(await (ok.provider as AsrJobProvider).cancel?.(HANDLE, { signal: signal() })).toBe("cancelled");
    expect(ok.http.captured[0]?.request).toMatchObject({ url: `${BASE}/api/v1/tasks/task-123/cancel`, method: "POST" });
    const late = setup(routes({ cancel: () => ({ status: 400, body: JSON.stringify({ code: "UnsupportedOperation", message: "running" }) }) }));
    expect(await (late.provider as AsrJobProvider).cancel?.(HANDLE, { signal: signal() })).toBe("already_terminal");
    const broken = setup(routes({ cancel: () => ({ status: 500, body: "" }) }));
    expect((await failure((broken.provider as AsrJobProvider).cancel?.(HANDLE, { signal: signal() }) as Promise<unknown>)).appError.retryDisposition).toBe("policy");
  });
});

describe("probe", () => {
  it("asks for upload space for the preset's default model, whatever the profile lists and in any order", async () => {
    const { http, factory } = setup();
    expect(await factory.probe(profile(["fun-asr", QWEN]), signal())).toEqual({});
    expect(await factory.probe(profile(["fun-asr"]), signal())).toEqual({});
    expect(http.captured.map((entry) => entry.request.url)).toEqual([
      `${BASE}/api/v1/uploads?action=getPolicy&model=${DASHSCOPE_DESCRIPTOR.defaultModel}`,
      `${BASE}/api/v1/uploads?action=getPolicy&model=${DASHSCOPE_DESCRIPTOR.defaultModel}`,
    ]);
  });

  it("reports an invalid key as asr_failed.auth", async () => {
    const { factory } = setup(routes({ policy: () => ({ status: 401, body: JSON.stringify({ code: "InvalidApiKey", message: "Invalid API-key provided." }) }) }));
    expect((await failure(factory.probe(profile(), signal()))).appError.code).toBe("asr_failed.auth");
  });
});

describe("result normalization", () => {
  it("keeps English words with their punctuation and infers English", () => {
    const result = canonicalFromResultFile(fixture("en"), { provider: "dashscope", model: "fun-asr" });
    expect(result.language).toBe("en");
    expect(result.segments.map((segment) => segment.text)).toEqual([
      "Welcome to the course on software engineering.",
      "Today we talk about prompts, and how to write them.",
    ]);
    expect(result.words?.slice(-3).map((word) => word.text)).toEqual(["to", "write", "them."]);
    expect(result.words?.find((word) => word.text.startsWith("prompts"))?.text).toBe("prompts,");
  });

  it("leaves out the blank word the service puts between an English word and the Chinese after it, keeping the others", () => {
    const file = JSON.parse(fixture("zh")) as { transcripts: Array<{ sentences: Array<{ words: Array<{ begin_time: number; end_time: number; text: string; punctuation?: string }> }> }> };
    const words = file.transcripts[0]?.sentences[0]?.words as Array<{ begin_time: number; end_time: number; text: string; punctuation?: string }>;
    const before = words[0] as { begin_time: number; end_time: number };
    words.splice(1, 0, { begin_time: before.end_time, end_time: before.end_time, text: " ", punctuation: "" });
    const result = canonicalFromResultFile(JSON.stringify(file), { provider: "dashscope", model: QWEN });
    expect(result.words?.map((word) => word.text)).toEqual(["欢迎", "来到", "生成式", "软件工程。", "今天", "我们", "讲", "提示词。"]);
  });

  it("drops every word when a sentence's words are all blank", () => {
    const file = JSON.parse(fixture("zh")) as { transcripts: Array<{ sentences: Array<{ words: Array<{ text: string; punctuation?: string }> }> }> };
    for (const word of file.transcripts[0]?.sentences[1]?.words ?? []) {
      word.text = " ";
      word.punctuation = "";
    }
    expect(canonicalFromResultFile(JSON.stringify(file), { provider: "dashscope", model: QWEN }).words).toBeUndefined();
  });

  it("drops every word when one sentence's words do not spell it", () => {
    const file = JSON.parse(fixture("zh")) as { transcripts: Array<{ sentences: Array<{ words: Array<{ text: string }> }> }> };
    (file.transcripts[0]?.sentences[1]?.words[0] as { text: string }).text = "明天";
    const result = canonicalFromResultFile(JSON.stringify(file), { provider: "dashscope", model: QWEN });
    expect(result.words).toBeUndefined();
    expect(result.segments).toHaveLength(2);
  });

  it("drops every word when word times run backwards or a sentence has none", () => {
    const backwards = JSON.parse(fixture("zh")) as { transcripts: Array<{ sentences: Array<{ words: Array<{ begin_time: number }> }> }> };
    (backwards.transcripts[0]?.sentences[0]?.words[2] as { begin_time: number }).begin_time = 50;
    expect(canonicalFromResultFile(JSON.stringify(backwards), { provider: "dashscope", model: QWEN }).words).toBeUndefined();
    const none = JSON.parse(fixture("zh")) as { transcripts: Array<{ sentences: Array<{ words?: unknown }> }> };
    delete (none.transcripts[0]?.sentences[1] as { words?: unknown }).words;
    expect(canonicalFromResultFile(JSON.stringify(none), { provider: "dashscope", model: QWEN }).words).toBeUndefined();
  });

  it("refuses a file without the documented shape", () => {
    let thrown: unknown;
    try {
      canonicalFromResultFile(JSON.stringify({ transcripts: [] }), { provider: "dashscope", model: QWEN });
    } catch (error) {
      thrown = error;
    }
    expect(isAmberError(thrown) && thrown.appError.code).toBe("asr_failed.job_failed");
  });

  it("infers the language from the script only when unambiguous", () => {
    expect(inferLanguage("今日はいい天気です")).toBe("ja");
    expect(inferLanguage("안녕하세요")).toBe("ko");
    expect(inferLanguage("今天天气很好")).toBe("zh");
    expect(inferLanguage("Bonjour à tous, aujourd'hui nous parlons de logiciels et de méthodes de travail en équipe, avec des exemples simples.")).toBe("und");
    expect(inferLanguage("12345")).toBe("und");
    // A stray line in another script does not relabel the text.
    const english = "You are in danger. I brought you here to warn you. They are watching you, Neo. It is the question that drives us.";
    expect(inferLanguage(`${english} まあ。 ${english}`)).toBe("en");
    expect(inferLanguage("那搁是对对搁ai什么的，你把那些因素都送进去，是ai告诉你干什么")).toBe("zh");
    expect(inferLanguage("東京都の天気は晴れです。明日は雨が降るでしょう。")).toBe("ja");
    // No dominant script: nothing is claimed.
    expect(inferLanguage("今天天气很好 and the weather is nice today in the city")).toBe("und");
  });

  it("maps a language tag to a hint the model lists", () => {
    const hints = new Set(["zh", "en", "ja"]);
    expect(toDashscopeLanguageHint("zh-Hans-CN", hints)).toBe("zh");
    expect(toDashscopeLanguageHint("en-US", hints)).toBe("en");
    expect(toDashscopeLanguageHint("de", hints)).toBeUndefined();
    expect(toDashscopeLanguageHint("not a tag!", hints)).toBeUndefined();
    expect(toDashscopeLanguageHint(undefined, hints)).toBeUndefined();
  });
});
