import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "../../src/server/adapters/llm/anthropic-messages/index.ts";
import { OpenAiCompatibleProvider } from "../../src/server/adapters/llm/openai-compatible/index.ts";
import { OpenAiResponsesProvider } from "../../src/server/adapters/llm/openai-responses/index.ts";
import { DirectOutboundHttpClient } from "../../src/server/adapters/outbound-http/direct.ts";
import { LlmGateway } from "../../src/server/application/llm-gateway.ts";
import { ProviderService } from "../../src/server/application/providers.ts";
import { isAmberError } from "../../src/server/domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../src/server/domain/llm.ts";
import type { RequestPrincipal } from "../../src/server/domain/user.ts";
import type { LlmProbeCheck, LlmProvider, LlmStreamOptions } from "../../src/server/ports/llm-provider.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundRequest, type OutboundResponse } from "../../src/server/ports/outbound-http.ts";
import { probeResultDtoSchema, type CreateProviderRequest, type ProviderProfileDto } from "../../src/shared/dto/provider.ts";
import { createHarness, LOCAL, silentLogger, type Harness } from "../fixtures/pipeline/harness.ts";
import {
  describeAddress,
  loadVendorEnv,
  redact,
  renderReportJson,
  renderReportMarkdown,
  REQUESTS_PER_VENDOR_CAP,
  RUN_OUTPUT_ROOT,
  runStamp,
  sanitizeUpstream,
  TEST_PROFILE_PREFIX,
  vendorDisplayName,
  vendorPassed,
  type AssertionLine,
  type CheckLine,
  type StageError,
  type UsageLine,
  type VendorConfig,
  type VendorReport,
  type VendorStage,
} from "./vendor-env.ts";

/**
 * Real multi-vendor LLM test. Runs only with `AMBER_E2E_LLM=1` and a per-run approval: the
 * switch alone is not an approval. Keys, models and addresses come from the env file
 * (`vendor-env.ts`); a vendor without a key is skipped and sends nothing.
 *
 * Per vendor, inside one temporary in-process instance: create the profile with its key in
 * one call, "test connection" through ProviderService, then one very short streamed request
 * through the LlmGateway, then check the usage rows. Vendors run at most three at a time,
 * the steps of one vendor in order. Failed paid requests are never re-sent: the gateway's
 * automatic retry is switched off, and every vendor is held to `REQUESTS_PER_VENDOR_CAP`
 * requests by the HTTP client itself. The report goes to `.amber-dev/llm-vendors/<time>/`.
 */

const enabled = process.env["AMBER_E2E_LLM"] === "1";
const VENDOR_CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 300_000;
const SHORT_REQUEST_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 40 * 60_000;
const REPLY_PREVIEW_CHARS = 80;

/**
 * Failures after which the short request would only repeat the same answer (or make a limit
 * worse), so it is not sent.
 */
const STOP_AFTER_PROBE_FAILURE = [
  "llm_rate_limited",
  "llm_failed.auth",
  "llm_failed.quota",
  "llm_failed.limit_ambiguous",
  "llm_failed.overloaded",
  "llm_failed.model_not_found",
  "llm_failed.unreachable",
  "network_blocked_by_policy",
];

interface RequestRecord {
  host: string;
  /** Refused by this test before anything left; not a request. */
  refused?: string;
  status?: number;
  transportFailure?: "before_send" | "after_send";
}

interface CallRecord {
  stage: VendorStage;
  outcome: string;
}

/** Everything one vendor's run observed; reached through `current` from inside the adapters and the HTTP client. */
interface VendorRun {
  config: VendorConfig;
  host: string;
  otherKeys: readonly string[];
  requests: RequestRecord[];
  /** `onCall` reports of "test connection", in order. */
  calls: CallRecord[];
  checks: CheckLine[];
  /** The last failure an adapter threw, with the stage it was in. */
  lastFailure?: { stage: VendorStage; error: unknown } | undefined;
}

const current = new AsyncLocalStorage<VendorRun>();

/** Thrown in place of the gateway's backoff sleep: no automatic retry of a failed paid request. */
class RetrySuppressed extends Error {
  constructor() {
    super("automatic retry suppressed by the real test");
    this.name = "RetrySuppressed";
  }
}

/**
 * The only way out: attributes every request to the running vendor, sends nothing to a host
 * other than the vendor's, nothing that carries another vendor's key or lacks its own, and
 * nothing beyond the per-vendor cap. Only the host and the outcome are kept; never headers or bodies.
 */
class GuardedHttp implements OutboundHttpClient {
  orphanRequests = 0;
  private readonly inner = new DirectOutboundHttpClient();

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const run = current.getStore();
    if (run === undefined) {
      this.orphanRequests += 1;
      throw new Error("request outside a vendor run");
    }
    const record: RequestRecord = { host: new URL(request.url).host };
    run.requests.push(record);
    const headerValues = Object.values(request.headers ?? {});
    const carries = (key: string): boolean => headerValues.some((value) => value.includes(key));
    if (run.requests.filter((item) => item.refused === undefined).length > REQUESTS_PER_VENDOR_CAP) {
      record.refused = "cap";
    } else if (record.host !== run.host) {
      record.refused = "host";
    } else if (!carries(run.config.apiKey) || run.otherKeys.some((key) => key !== run.config.apiKey && carries(key))) {
      record.refused = "key";
    }
    if (record.refused !== undefined) {
      throw new Error(`request refused by the real test (${record.refused})`);
    }
    try {
      const response = await this.inner.request(request);
      record.status = response.status;
      return response;
    } catch (error) {
      if (error instanceof OutboundHttpError) {
        record.transportFailure = error.phase;
      }
      throw error;
    }
  }
}

/** Records each check's result and each adapter failure with its stage; changes nothing. */
class RecordingProvider implements LlmProvider {
  private readonly inner: LlmProvider;

  constructor(inner: LlmProvider) {
    this.inner = inner;
  }

  get protocol() {
    return this.inner.protocol;
  }

  get audioMimeTypes() {
    return this.inner.audioMimeTypes;
  }

  async *stream(request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    try {
      yield* this.inner.stream(request, opts);
    } catch (error) {
      const run = current.getStore();
      if (run !== undefined) {
        run.lastFailure = { stage: "short", error };
      }
      throw error;
    }
  }

  probe(...args: Parameters<LlmProvider["probe"]>): readonly LlmProbeCheck[] {
    return this.inner.probe(...args).map((check) => ({
      kind: check.kind,
      run: async (opts: Parameters<LlmProbeCheck["run"]>[0]) => {
        const run = current.getStore();
        const stage: CheckLine["stage"] = check.kind;
        try {
          const result = await check.run({
            ...opts,
            onCall: (call) => {
              run?.calls.push({ stage, outcome: call.outcome });
              opts.onCall(call);
            },
          });
          run?.checks.push({
            stage,
            result: result.kind === "basic" ? result.status : result.result,
            ...(result.kind !== "basic" && result.reason !== undefined ? { reason: result.reason } : {}),
            latencyMs: result.latencyMs,
          });
          return result;
        } catch (error) {
          if (run !== undefined) {
            run.lastFailure = { stage, error };
          }
          throw error;
        }
      },
    }));
  }
}

/** Creates the profile with its key in one call, as `POST /api/providers` with `credential` does. */
function createWithKey(providers: ProviderService, principal: RequestPrincipal, request: CreateProviderRequest, apiKey: string): ProviderProfileDto {
  return providers.create(principal, { ...request, credential: { value: apiKey } });
}

function codeOf(error: unknown): string {
  if (isAmberError(error)) {
    return error.appError.code;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
}

function stageErrorOf(run: VendorRun, error: unknown, fallbackStage: VendorStage, keys: readonly string[]): StageError {
  const failure = run.lastFailure;
  const cause = error instanceof RetrySuppressed && failure !== undefined ? failure.error : error;
  const stage = failure?.stage ?? fallbackStage;
  const hide = describeAddress(run.config).host === undefined ? [run.config.baseURL, run.host] : [];
  const upstream = isAmberError(cause) ? cause.appError.upstreamMessage : undefined;
  return {
    stage,
    code: sanitizeUpstream(codeOf(cause), keys, hide),
    ...(upstream === undefined ? {} : { upstreamMessage: sanitizeUpstream(upstream, keys, hide) }),
  };
}

async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

interface VendorOutcome {
  report: VendorReport;
  /** Key versions seen on this vendor's usage rows. */
  credentialVersions: Set<string>;
}

describe.skipIf(!enabled)("real LLM, every vendor in the env file", () => {
  it(
    "creates, tests and calls each vendor with its own key, records usage, and writes a key-free report",
    async () => {
      const startedAt = Date.now();
      const configs = loadVendorEnv();
      const keys = configs.map((config) => config.apiKey).filter((key) => key !== "");
      const ready = configs.filter((config) => config.status === "ready");

      const harness: Harness = createHarness();
      try {
        const http = new GuardedHttp();
        const secrets = harness.secrets;
        const adapters: LlmProvider[] = [
          new OpenAiCompatibleProvider({ http, secrets, files: { read: async function* () {} } }),
          new AnthropicMessagesProvider({ http, secrets }),
          new OpenAiResponsesProvider({ http, secrets }),
        ].map((adapter) => new RecordingProvider(adapter));
        const gateway = new LlmGateway({
          repository: harness.repository,
          secrets,
          providers: adapters,
          logger: silentLogger,
          newId: monotonicFactory(),
          sleep: async () => {
            throw new RetrySuppressed();
          },
        });
        const providers = new ProviderService({
          repository: harness.repository,
          secrets,
          prober: gateway,
          onChanged: (profileId, modelIds) => gateway.profileChanged(profileId, modelIds),
        });

        const runVendor = async (config: VendorConfig): Promise<VendorOutcome> => {
          const address = describeAddress(config);
          const base: VendorReport = {
            vendor: config.vendor,
            presetId: config.presetId,
            status: config.status,
            ...(config.reason === undefined ? {} : { skipReason: config.reason }),
            protocol: config.protocol,
            address: address.label,
            ...(address.host === undefined ? {} : { host: address.host }),
            modelId: config.modelId,
            ...(config.contextWindowTokens === undefined ? {} : { contextWindowTokens: config.contextWindowTokens }),
            keyFilled: config.apiKey !== "",
            usage: [],
            requestCount: 0,
            assertions: [],
          };
          if (config.status === "skip") {
            return { report: base, credentialVersions: new Set() };
          }
          const run: VendorRun = { config, host: new URL(config.baseURL).host, otherKeys: keys, requests: [], calls: [], checks: [] };
          return current.run(run, async () => {
            const report = base;
            const assertions: AssertionLine[] = report.assertions;

            let profile: ProviderProfileDto;
            try {
              profile = createWithKey(
                providers,
                LOCAL,
                {
                  name: `${TEST_PROFILE_PREFIX} ${vendorDisplayName(config.presetId)}`,
                  protocol: config.protocol,
                  baseURL: config.baseURL,
                  presetId: config.presetId,
                  models: [{ modelId: config.modelId, ...(config.contextWindowTokens === undefined ? {} : { contextWindowTokens: config.contextWindowTokens }) }],
                },
                config.apiKey,
              );
            } catch (error) {
              report.probe = { passed: false, checks: [], error: stageErrorOf(run, error, "create", keys) };
              report.shortRequest = { executed: false, passed: false, skippedBecause: "Profile 未创建" };
              assertions.push({ name: "Profile 与 Key 一次创建", ok: false, detail: codeOf(error) });
              return { report, credentialVersions: new Set() };
            }
            report.credentialStatus = profile.credentialStatus;
            assertions.push({ name: "凭据状态为 configured", ok: profile.credentialStatus === "configured", detail: profile.credentialStatus });

            const modelRef = { providerProfileId: profile.id, modelId: config.modelId };
            let probeBody: unknown;
            try {
              probeBody = (await providers.probe(LOCAL, profile.id, config.modelId, AbortSignal.timeout(PROBE_TIMEOUT_MS))).body;
              report.probe = { passed: true, checks: run.checks };
            } catch (error) {
              report.probe = { passed: false, checks: run.checks, error: stageErrorOf(run, error, "basic", keys) };
            }
            if (report.probe.passed) {
              const parsed = probeResultDtoSchema.safeParse(probeBody);
              const consistent =
                parsed.success &&
                parsed.data.basic.status === run.checks.find((check) => check.stage === "basic")?.result &&
                parsed.data.checks.every((check) => run.checks.find((line) => line.stage === check.flag)?.result === check.result);
              assertions.push({ name: "测试连接返回体符合格式且与逐项结果一致", ok: consistent, ...(parsed.success ? {} : { detail: "返回体不符合 probeResultDtoSchema" }) });
            }

            const stopCode = report.probe.error?.code;
            const capReached = run.requests.filter((item) => item.refused === undefined).length >= REQUESTS_PER_VENDOR_CAP;
            const stopBecause =
              stopCode !== undefined && STOP_AFTER_PROBE_FAILURE.some((prefix) => stopCode.startsWith(prefix))
                ? `测试连接以 ${stopCode} 失败，同类请求不再发送`
                : capReached
                  ? "已达到请求上限"
                  : run.requests.some((item) => item.refused === "host" || item.refused === "key")
                    ? "有请求因目标主机或 Key 不符被拦下"
                    : undefined;
            if (stopBecause !== undefined) {
              report.shortRequest = { executed: false, passed: false, skippedBecause: stopBecause };
            } else {
              run.lastFailure = undefined;
              const started = Date.now();
              let text = "";
              let stopReason: string | undefined;
              try {
                const stream = gateway.stream(
                  { userId: LOCAL.userId, feature: "chat" },
                  {
                    modelRef,
                    system: "Answer in one word.",
                    // No output cap, exactly as real features call it: a cap would exercise a request
                    // shape Amber never sends (and `max_tokens` is rejected by some reasoning models).
                    messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word OK." }] }],
                  },
                  { signal: AbortSignal.timeout(SHORT_REQUEST_TIMEOUT_MS) },
                );
                for await (const event of stream) {
                  if (event.type === "text_delta") {
                    text += event.delta;
                  } else if (event.type === "done") {
                    stopReason = event.stopReason;
                  }
                }
                const passed = (stopReason === "stop" || stopReason === "length") && text.trim() !== "";
                report.shortRequest = {
                  executed: true,
                  passed,
                  latencyMs: Date.now() - started,
                  ...(stopReason === undefined ? {} : { stopReason }),
                  text: redact(text.trim().slice(0, REPLY_PREVIEW_CHARS), keys),
                };
              } catch (error) {
                report.shortRequest = {
                  executed: true,
                  passed: false,
                  latencyMs: Date.now() - started,
                  error: stageErrorOf(run, error, "short", keys),
                };
              }
            }

            // Usage: one row per request that crossed the send boundary, in the order sent.
            const rows = harness.repository
              .withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId))
              .filter((row) => (row.providerProfileId ?? row.modelRef.providerProfileId) === profile.id);
            const crossed = run.requests.filter((item) => item.refused === undefined && item.transportFailure !== "before_send");
            const probeRows = rows.filter((row) => row.feature === "test_connection");
            report.usage = rows.map((row): UsageLine => {
              const probeIndex = probeRows.indexOf(row);
              return {
                stage: row.feature === "chat" ? "short" : (run.calls[probeIndex]?.stage ?? "unknown"),
                feature: row.feature,
                outcome: row.outcome,
                ...(row.inputTokens === undefined ? {} : { inputTokens: row.inputTokens }),
                ...(row.outputTokens === undefined ? {} : { outputTokens: row.outputTokens }),
                ...(row.cacheReadTokens === undefined ? {} : { cacheReadTokens: row.cacheReadTokens }),
                ...(row.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: row.cacheWriteTokens }),
                ...(row.reasoningTokens === undefined ? {} : { reasoningTokens: row.reasoningTokens }),
                rawUsageSaved: row.rawUsageJson !== undefined && row.rawUsageJson !== "",
              };
            });
            report.requestCount = run.requests.filter((item) => item.refused === undefined).length;

            assertions.push({ name: "每次越过发送边界都有一行用量", ok: rows.length === crossed.length, detail: `用量 ${rows.length} 行 / 请求 ${crossed.length} 次` });
            const mismatched = crossed.filter((request, index) => {
              const outcome = rows[index]?.outcome;
              if (request.transportFailure === "after_send") {
                return outcome !== "outcome_unknown";
              }
              if (request.status !== undefined && request.status >= 400) {
                return outcome !== "failed";
              }
              return outcome !== "succeeded" && outcome !== "failed";
            });
            assertions.push({ name: "outcome 与响应一致", ok: mismatched.length === 0, ...(mismatched.length === 0 ? {} : { detail: `${mismatched.length} 行不一致` }) });
            const succeededWithoutRaw = report.usage.filter((row) => row.outcome === "succeeded" && !row.rawUsageSaved).length;
            assertions.push({
              name: "成功的请求已保存原始用量",
              ok: succeededWithoutRaw === 0,
              ...(succeededWithoutRaw === 0 ? {} : { detail: `${succeededWithoutRaw} 行没有原始用量（上游未返回用量？）` }),
            });
            const refusedFor = (reason: string): number => run.requests.filter((item) => item.refused === reason).length;
            assertions.push({ name: "请求目标主机与配置一致", ok: refusedFor("host") === 0 && crossed.every((item) => item.host === run.host) });
            assertions.push({ name: "每次请求只带本厂商的 Key", ok: refusedFor("key") === 0 });
            assertions.push({ name: `请求次数不超过 ${REQUESTS_PER_VENDOR_CAP} 次`, ok: refusedFor("cap") === 0, detail: `${report.requestCount} 次` });

            return { report, credentialVersions: new Set(rows.flatMap((row) => (row.credentialVersion === undefined ? [] : [row.credentialVersion]))) };
          });
        };

        const outcomes = await inPool(configs, VENDOR_CONCURRENCY, runVendor);

        // Every profile used its own key version, and no version was shared.
        const seen = new Map<string, string>();
        for (const outcome of outcomes) {
          if (outcome.report.status !== "ready" || outcome.credentialVersions.size === 0) {
            continue;
          }
          const shared = [...outcome.credentialVersions].filter((version) => seen.has(version));
          outcome.report.assertions.push({
            name: "密钥版本唯一（本厂商只有一个，且与其他厂商不同）",
            ok: outcome.credentialVersions.size === 1 && shared.length === 0,
          });
          for (const version of outcome.credentialVersions) {
            seen.set(version, outcome.report.vendor);
          }
        }

        const report = { startedAt, finishedAt: Date.now(), requestCap: REQUESTS_PER_VENDOR_CAP, vendors: outcomes.map((outcome) => outcome.report) };
        // The report data itself must hold no key; redaction on write is only the last resort.
        const unredacted = renderReportMarkdown(report, []) + renderReportJson(report, []);
        const leaked = keys.some((key) => unredacted.includes(key));
        const markdown = renderReportMarkdown(report, keys);
        const json = renderReportJson(report, keys);
        const dir = join(RUN_OUTPUT_ROOT, runStamp(new Date(startedAt)));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "report.md"), markdown);
        writeFileSync(join(dir, "report.json"), json);

        expect(leaked, "report data contains a key before redaction").toBe(false);
        expect(keys.some((key) => markdown.includes(key) || json.includes(key))).toBe(false);
        expect(http.orphanRequests, "requests outside any vendor run").toBe(0);
        for (const outcome of outcomes.filter((item) => item.report.status === "skip")) {
          expect(outcome.report.requestCount, `${outcome.report.vendor} is skipped and must send nothing`).toBe(0);
        }
        expect(ready.length, "no vendor in the env file has a key").toBeGreaterThan(0);
        for (const outcome of outcomes.filter((item) => item.report.status === "ready")) {
          const failed = outcome.report.assertions.filter((assertion) => !assertion.ok).map((assertion) => assertion.name);
          expect.soft(failed, `${outcome.report.vendor}: assertions that did not hold (see ${dir})`).toEqual([]);
          expect.soft(vendorPassed(outcome.report), `${outcome.report.vendor}: test connection and short request (see ${dir})`).toBe(true);
        }
      } finally {
        await harness.close();
      }
    },
    RUN_TIMEOUT_MS,
  );
});
