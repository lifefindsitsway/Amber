import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { LlmProtocol } from "../../src/shared/enums.ts";
import { llmPresets } from "../../src/shared/i18n/zh-CN/ui-llm-presets.ts";
import {
  endpointPathSuffix,
  hasRegions,
  isValidWorkspaceId,
  matchPresetAddress,
  normalizeBaseUrl,
  normalizeWorkspaceId,
  officialBaseUrl,
  presetById,
  presetProtocols,
  supportsWorkspace,
  type LlmPreset,
  type LlmPresetId,
} from "../../src/shared/llm-presets.ts";

/**
 * Per-vendor settings for the real multi-vendor LLM tests, read from an env file that holds
 * real keys. The file is parsed, never imported into `process.env`, so no other code in the
 * process can pick a key up by accident, and only the variables named here are read.
 *
 * Nothing this module produces (errors, reports) may contain a key: messages never interpolate
 * a key, and everything written out goes through `redact` with every key as a last resort.
 *
 * Also runs under Node's own type stripping (the seed script), so erasable syntax only.
 */

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Overrides the env file read; defaults to `.env` at the repository root. */
export const ENV_FILE_VARIABLE = "AMBER_E2E_ENV_FILE";

/** Where reports and seed lists go; ignored by git. */
export const RUN_OUTPUT_ROOT = join(REPO_ROOT, ".amber-dev", "llm-vendors");

/** Requests one vendor may send in one automatic run: four checks, one fallback, one short request. */
export const REQUESTS_PER_VENDOR_CAP = 6;

/** Name prefix that marks a profile created by these tools; cleanup removes nothing else. */
export const TEST_PROFILE_PREFIX = "[测试]";

export const VENDORS = [
  { vendor: "ANTHROPIC", presetId: "anthropic" },
  { vendor: "OPENAI", presetId: "openai" },
  { vendor: "DEEPSEEK", presetId: "deepseek" },
  { vendor: "QWEN", presetId: "qwen" },
  { vendor: "KIMI", presetId: "kimi" },
  { vendor: "GLM", presetId: "glm" },
  { vendor: "GEMINI", presetId: "gemini" },
  { vendor: "GROK", presetId: "grok" },
] as const satisfies ReadonlyArray<{ vendor: string; presetId: LlmPresetId }>;

export type VendorPrefix = (typeof VENDORS)[number]["vendor"];

export interface VendorConfig {
  vendor: VendorPrefix;
  presetId: LlmPresetId;
  /** `skip`: no key was given; the vendor sends nothing and does not count as a failure. */
  status: "ready" | "skip";
  reason?: string;
  protocol: LlmProtocol;
  /** Normalized; empty when a skipped vendor's address could not be resolved. */
  baseURL: string;
  modelId: string;
  contextWindowTokens?: number;
  /** Empty when skipped. Never printed, logged or written anywhere. */
  apiKey: string;
}

/** Configuration errors, each naming the variable at fault and never a key. */
export class VendorEnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`.env 配置有误：\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "VendorEnvError";
    this.problems = problems;
  }
}

/** Display name of a preset, as the settings page shows it. */
export function vendorDisplayName(presetId: LlmPresetId): string {
  return llmPresets.name[presetId];
}

/** The variables one vendor may set: a region only where the preset has several, a workspace only where it offers one. */
export function vendorVariables(vendor: VendorPrefix, preset: LlmPreset): string[] {
  const names = ["BASE_URL", "API_KEY", "MODEL_ID", "CONTEXT_WINDOW", "PROTOCOL"];
  if (hasRegions(preset)) {
    names.push("REGION");
  }
  if (supportsWorkspace(preset)) {
    names.push("WORKSPACE_ID");
  }
  return names.map((name) => `${vendor}_${name}`);
}

/** Every variable this module reads; anything else in the file is ignored. */
export function allowedVariables(): string[] {
  return VENDORS.flatMap(({ vendor, presetId }) => vendorVariables(vendor, requirePreset(presetId)));
}

function requirePreset(presetId: LlmPresetId): LlmPreset {
  const preset = presetById(presetId);
  if (preset === undefined) {
    throw new Error(`unknown preset ${presetId}`);
  }
  return preset;
}

/** The env file this run reads. */
export function vendorEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_FILE_VARIABLE];
  return override === undefined || override === "" ? join(REPO_ROOT, ".env") : resolve(override);
}

/** Reads and resolves the env file; throws `VendorEnvError` listing every problem at once. */
export function loadVendorEnv(path: string = vendorEnvPath()): VendorConfig[] {
  return parseVendorEnv(readFileSync(path, "utf8"));
}

/** As `loadVendorEnv`, from the file's content. */
export function parseVendorEnv(content: string): VendorConfig[] {
  const parsed = parseEnv(content);
  const allowed = new Set(allowedVariables());
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) {
    if (allowed.has(name) && value !== undefined) {
      values.set(name, value.trim());
    }
  }
  const read = (name: string): string => values.get(name) ?? "";
  const problems: string[] = [];
  const configs = VENDORS.map(({ vendor, presetId }) => resolveVendor(vendor, presetId, read, problems));
  if (problems.length > 0) {
    // A key pasted into the wrong variable must not come back in a message.
    const keys = configs.map((config) => config.apiKey);
    throw new VendorEnvError(problems.map((problem) => redact(problem, keys)));
  }
  return configs;
}

function resolveVendor(vendor: VendorPrefix, presetId: LlmPresetId, read: (name: string) => string, problems: string[]): VendorConfig {
  const preset = requirePreset(presetId);
  const apiKey = read(`${vendor}_API_KEY`);
  const ready = apiKey !== "";
  // A skipped vendor's mistakes are reported as its skip reason, never as a failure.
  const found: string[] = [];
  const protocols = presetProtocols(preset).map((endpoint) => endpoint.protocol);
  const protocolVar = `${vendor}_PROTOCOL`;
  const protocolRaw = read(protocolVar);
  let protocol = protocols[0] as LlmProtocol;
  if (protocolRaw !== "") {
    const match = protocols.find((candidate) => candidate === protocolRaw);
    if (match === undefined) {
      found.push(`${protocolVar} 不是该预设支持的协议，可选：${protocols.join("、")}`);
    } else {
      protocol = match;
    }
  }

  let regionId: string | undefined;
  if (hasRegions(preset)) {
    const regionVar = `${vendor}_REGION`;
    const regionRaw = read(regionVar);
    if (regionRaw !== "") {
      if (preset.regions.some((region) => region.id === regionRaw)) {
        regionId = regionRaw;
      } else {
        found.push(`${regionVar} 不是已知地域，可选：${preset.regions.map((region) => region.id).join("、")}`);
      }
    }
  }

  let workspaceId: string | undefined;
  if (supportsWorkspace(preset)) {
    const workspaceVar = `${vendor}_WORKSPACE_ID`;
    const workspaceRaw = read(workspaceVar);
    if (workspaceRaw !== "") {
      const normalized = normalizeWorkspaceId(workspaceRaw);
      if (isValidWorkspaceId(normalized)) {
        workspaceId = normalized;
      } else {
        found.push(`${workspaceVar} 不是合法的工作空间 ID（只能含小写字母、数字与连字符，且不以连字符开头或结尾）`);
      }
    }
  }

  const baseUrlVar = `${vendor}_BASE_URL`;
  const baseUrlRaw = read(baseUrlVar);
  let baseURL = "";
  if (baseUrlRaw === "") {
    const official = officialBaseUrl(preset, { protocol, ...(regionId === undefined ? {} : { regionId }), ...(workspaceId === undefined ? {} : { workspaceId }) });
    if (official !== undefined) {
      baseURL = normalizeBaseUrl(official);
    } else if (found.length === 0) {
      const region = regionId ?? preset.regions[0]?.id ?? "";
      found.push(
        workspaceId === undefined && hasRegions(preset)
          ? `${vendor}_REGION=${region} 只能经工作空间专属地址访问，须填写 ${vendor}_WORKSPACE_ID（或在 ${baseUrlVar} 填写完整地址）`
          : `${baseUrlVar} 未填写，且该预设在当前协议 / 地域下没有官方地址`,
      );
    }
  } else {
    const normalized = normalizeBaseUrl(baseUrlRaw);
    const suffix = endpointPathSuffix(normalized);
    if (!isHttpsUrl(normalized)) {
      found.push(`${baseUrlVar} 必须是 https:// 开头的完整地址`);
    } else if (suffix !== undefined) {
      found.push(`${baseUrlVar} 末尾不应带接口路径 ${suffix}，只填到版本路径为止`);
    } else {
      baseURL = normalized;
    }
  }

  const modelVar = `${vendor}_MODEL_ID`;
  const modelId = read(modelVar);
  if (modelId === "") {
    found.push(`${modelVar} 未填写`);
  }

  const windowVar = `${vendor}_CONTEXT_WINDOW`;
  const windowRaw = read(windowVar);
  let contextWindowTokens: number | undefined;
  if (windowRaw !== "") {
    const value = /^[0-9]+$/.test(windowRaw) ? Number(windowRaw) : Number.NaN;
    if (Number.isSafeInteger(value) && value > 0) {
      contextWindowTokens = value;
    } else {
      found.push(`${windowVar} 必须是正整数（token 数）`);
    }
  }

  const base = {
    vendor,
    presetId,
    protocol,
    baseURL,
    modelId,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  };
  if (!ready) {
    const reason = [`${vendor}_API_KEY 未填写`, ...found].join("；");
    return { ...base, status: "skip", reason, apiKey: "" };
  }
  problems.push(...found);
  return { ...base, status: "ready", apiKey };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

/** What an address is, without spelling out a custom one (relay addresses stay out of reports). */
export function describeAddress(config: Pick<VendorConfig, "presetId" | "protocol" | "baseURL">): { label: string; host?: string } {
  const preset = requirePreset(config.presetId);
  const match = config.baseURL === "" ? undefined : matchPresetAddress(preset, config.protocol, config.baseURL);
  if (match === undefined) {
    return { label: "自定义地址" };
  }
  const host = new URL(config.baseURL).host;
  const regions = llmPresets.region as Record<string, Record<string, string> | undefined>;
  const regionName = hasRegions(preset) ? regions[config.presetId]?.[match.regionId] ?? match.regionId : undefined;
  const parts = ["官方地址", ...(regionName === undefined ? [] : [regionName]), ...(match.workspaceId === undefined ? [] : ["工作空间专属地址"])];
  return { label: parts.join(" · "), host };
}

const REDACTED = "<redacted>";

/** Replaces every occurrence of every non-empty key; the last line of defence before anything is written. */
export function redact(text: string, keys: readonly string[]): string {
  const distinct = [...new Set(keys.filter((key) => key !== ""))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of distinct) {
    out = out.split(key).join(REDACTED);
  }
  return out;
}

const UPSTREAM_MESSAGE_MAX_CHARS = 300;

/** An upstream explanation fit for a report: keys and given strings (a custom address) removed, one line, truncated. */
export function sanitizeUpstream(text: string, keys: readonly string[], hide: readonly string[] = []): string {
  let out = redact(text, keys);
  for (const value of hide.filter((item) => item !== "")) {
    out = out.split(value).join("<hidden>");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > UPSTREAM_MESSAGE_MAX_CHARS ? `${out.slice(0, UPSTREAM_MESSAGE_MAX_CHARS)}…` : out;
}

/** `YYYYMMDD-HHmmss` in UTC+8, the run directory name. */
export function runStamp(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${parts["year"]}${parts["month"]}${parts["day"]}-${parts["hour"]}${parts["minute"]}${parts["second"]}`;
}

function clock(at: number): string {
  const stamp = runStamp(new Date(at));
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
}

// ---------------------------------------------------------------------------------------------
// Report

export type VendorStage = "create" | "basic" | "stream" | "structuredOutput" | "tools" | "short";

export const STAGE_LABELS: Readonly<Record<VendorStage, string>> = {
  create: "创建 Profile",
  basic: "基础调用",
  stream: "流式",
  structuredOutput: "JSON",
  tools: "工具",
  short: "极短请求",
};

export interface StageError {
  stage: VendorStage;
  code: string;
  /** Already sanitized. */
  upstreamMessage?: string;
}

export interface CheckLine {
  stage: Exclude<VendorStage, "create" | "short">;
  /** `connected` / `incomplete` for the basic call, `supported` / `unsupported` / `inconclusive` for a flag. */
  result: string;
  reason?: string;
  latencyMs?: number;
}

export interface UsageLine {
  stage: VendorStage | "unknown";
  feature: string;
  outcome: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  rawUsageSaved: boolean;
}

export interface AssertionLine {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VendorReport {
  vendor: VendorPrefix;
  presetId: LlmPresetId;
  status: "ready" | "skip";
  skipReason?: string;
  protocol: LlmProtocol;
  address: string;
  /** Only for an official address. */
  host?: string;
  modelId: string;
  contextWindowTokens?: number;
  keyFilled: boolean;
  credentialStatus?: string;
  probe?: { passed: boolean; checks: CheckLine[]; error?: StageError };
  shortRequest?: {
    executed: boolean;
    passed: boolean;
    skippedBecause?: string;
    latencyMs?: number;
    stopReason?: string;
    /** The model's reply, truncated. */
    text?: string;
    error?: StageError;
  };
  usage: UsageLine[];
  requestCount: number;
  assertions: AssertionLine[];
}

export interface RunReport {
  startedAt: number;
  finishedAt: number;
  requestCap: number;
  vendors: VendorReport[];
}

/** Whether the vendor passed everything it ran; a skipped vendor is neither. */
export function vendorPassed(report: VendorReport): boolean {
  return (
    report.status === "ready" &&
    report.probe?.passed === true &&
    report.shortRequest?.passed === true &&
    report.assertions.every((assertion) => assertion.ok)
  );
}

function cell(value: string | number | undefined): string {
  return value === undefined ? "—" : String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function stageError(error: StageError | undefined): string {
  if (error === undefined) {
    return "";
  }
  return `${STAGE_LABELS[error.stage]} · \`${error.code}\`${error.upstreamMessage === undefined ? "" : ` — ${error.upstreamMessage}`}`;
}

/** `report.md`; every key is redacted from the result. */
export function renderReportMarkdown(report: RunReport, keys: readonly string[]): string {
  const lines: string[] = [];
  lines.push("# 多厂商 LLM 真实测试报告", "");
  lines.push(`- 开始：${clock(report.startedAt)}（UTC+8）`);
  lines.push(`- 结束：${clock(report.finishedAt)}（UTC+8）`);
  lines.push(`- 每家自动测试请求上限：${report.requestCap} 次`);
  lines.push("- 「测试连接通过」与「极短请求通过」分别判定；二者都通过也不代表该厂商的所有 AI 功能可用。", "");

  lines.push("## 结论", "");
  lines.push("| 厂商 | 状态 | 测试连接 | 极短请求 | 请求次数 | 断言 |", "|---|---|---|---|---|---|");
  for (const vendor of report.vendors) {
    if (vendor.status === "skip") {
      lines.push(`| ${cell(vendorDisplayName(vendor.presetId))} | SKIP | — | — | 0 | — |`);
      continue;
    }
    const probe = vendor.probe === undefined ? "未执行" : vendor.probe.passed ? "通过" : `未通过（${stageError(vendor.probe.error) || "见下文"}）`;
    const short =
      vendor.shortRequest === undefined || !vendor.shortRequest.executed
        ? `未执行${vendor.shortRequest?.skippedBecause === undefined ? "" : `（${vendor.shortRequest.skippedBecause}）`}`
        : vendor.shortRequest.passed
          ? "通过"
          : `未通过（${stageError(vendor.shortRequest.error) || "见下文"}）`;
    const failed = vendor.assertions.filter((assertion) => !assertion.ok).length;
    lines.push(`| ${cell(vendorDisplayName(vendor.presetId))} | 已运行 | ${cell(probe)} | ${cell(short)} | ${vendor.requestCount} | ${failed === 0 ? "全部成立" : `${failed} 项不成立`} |`);
  }
  lines.push("");

  for (const vendor of report.vendors) {
    lines.push(`## ${vendorDisplayName(vendor.presetId)}（${vendor.vendor}）`, "");
    lines.push(`- 预设：\`${vendor.presetId}\` · 协议：\`${vendor.protocol}\``);
    lines.push(`- 地址：${vendor.address}${vendor.host === undefined ? "" : `（\`${vendor.host}\`）`}`);
    lines.push(`- 模型：${vendor.modelId === "" ? "未填写" : `\`${vendor.modelId}\``} · 上下文窗口：${vendor.contextWindowTokens ?? "未填写"}`);
    lines.push(`- Key：${vendor.keyFilled ? "已填写" : "未填写"}${vendor.credentialStatus === undefined ? "" : ` · 凭据状态：\`${vendor.credentialStatus}\``}`);
    if (vendor.status === "skip") {
      lines.push(`- SKIP：${vendor.skipReason ?? ""}`, "");
      continue;
    }
    lines.push("", "### 测试连接", "");
    if (vendor.probe === undefined) {
      lines.push("未执行。", "");
    } else {
      if (vendor.probe.checks.length === 0) {
        lines.push("没有完成的检查项。");
      } else {
        lines.push("| 项 | 结果 | 原因 | 延迟（ms） |", "|---|---|---|---|");
        for (const check of vendor.probe.checks) {
          lines.push(`| ${STAGE_LABELS[check.stage]} | ${cell(check.result)} | ${cell(check.reason)} | ${cell(check.latencyMs)} |`);
        }
      }
      lines.push("", `结论：${vendor.probe.passed ? "测试连接通过" : "测试连接未通过"}`);
      if (vendor.probe.error !== undefined) {
        lines.push(`错误：${stageError(vendor.probe.error)}`);
      }
      lines.push("");
    }
    lines.push("### 极短请求", "");
    const short = vendor.shortRequest;
    if (short === undefined || !short.executed) {
      lines.push(`未执行${short?.skippedBecause === undefined ? "" : `：${short.skippedBecause}`}。`, "");
    } else {
      lines.push(`- 结论：${short.passed ? "极短请求通过" : "极短请求未通过"}`);
      lines.push(`- 延迟：${short.latencyMs ?? "—"} ms · 结束原因：${short.stopReason === undefined ? "—" : `\`${short.stopReason}\``} · 回复：${short.text === undefined ? "—" : `「${short.text}」`}`);
      if (short.error !== undefined) {
        lines.push(`- 错误：${stageError(short.error)}`);
      }
      lines.push("");
    }
    lines.push("### 用量（每次越过发送边界一行）", "");
    if (vendor.usage.length === 0) {
      lines.push("无。", "");
    } else {
      lines.push("| 阶段 | 功能 | outcome | 输入 | 输出 | 缓存读 | 缓存写 | 推理 | 原始用量 |", "|---|---|---|---|---|---|---|---|---|");
      for (const row of vendor.usage) {
        lines.push(
          `| ${row.stage === "unknown" ? "未知" : STAGE_LABELS[row.stage]} | ${row.feature} | ${row.outcome} | ${cell(row.inputTokens)} | ${cell(row.outputTokens)} | ${cell(row.cacheReadTokens)} | ${cell(row.cacheWriteTokens)} | ${cell(row.reasoningTokens)} | ${row.rawUsageSaved ? "已保存" : "无"} |`,
        );
      }
      lines.push("");
    }
    lines.push("### 断言", "");
    for (const assertion of vendor.assertions) {
      lines.push(`- ${assertion.ok ? "✅" : "❌"} ${assertion.name}${assertion.detail === undefined ? "" : `：${assertion.detail}`}`);
    }
    lines.push("");
  }

  lines.push("## 请求次数汇总", "");
  lines.push("| 厂商 | 请求次数 | 上限 |", "|---|---|---|");
  let total = 0;
  for (const vendor of report.vendors) {
    total += vendor.requestCount;
    lines.push(`| ${cell(vendorDisplayName(vendor.presetId))} | ${vendor.requestCount} | ${vendor.status === "skip" ? 0 : report.requestCap} |`);
  }
  lines.push(`| 合计 | ${total} | ${report.vendors.filter((vendor) => vendor.status === "ready").length * report.requestCap} |`, "");
  return redact(lines.join("\n"), keys);
}

/** `report.json`; every key is redacted from the result. */
export function renderReportJson(report: RunReport, keys: readonly string[]): string {
  const totals = {
    requests: report.vendors.reduce((sum, vendor) => sum + vendor.requestCount, 0),
    perVendor: Object.fromEntries(report.vendors.map((vendor) => [vendor.vendor, vendor.requestCount])),
  };
  return redact(`${JSON.stringify({ ...report, totals }, null, 2)}\n`, keys);
}
