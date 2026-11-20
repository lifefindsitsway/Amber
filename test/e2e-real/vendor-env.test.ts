import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LLM_PRESETS, officialBaseUrl } from "../../src/shared/llm-presets.ts";
import {
  allowedVariables,
  describeAddress,
  ENV_FILE_VARIABLE,
  loadVendorEnv,
  parseVendorEnv,
  redact,
  renderReportJson,
  renderReportMarkdown,
  REPO_ROOT,
  runStamp,
  sanitizeUpstream,
  VENDORS,
  vendorEnvPath,
  VendorEnvError,
  vendorPassed,
  type RunReport,
  type VendorConfig,
} from "./vendor-env.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/vendor-env/", import.meta.url));
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const byVendor = (configs: VendorConfig[], vendor: string): VendorConfig => {
  const found = configs.find((config) => config.vendor === vendor);
  if (found === undefined) {
    throw new Error(`no ${vendor}`);
  }
  return found;
};

/** A key that must never come back in any message. */
const SECRET = "xxxx-secret-that-must-not-leak-9f3a";

function problemsOf(content: string): readonly string[] {
  try {
    parseVendorEnv(content);
  } catch (error) {
    expect(error).toBeInstanceOf(VendorEnvError);
    const problems = (error as VendorEnvError).problems;
    expect((error as Error).message).not.toContain(SECRET);
    for (const problem of problems) {
      expect(problem).not.toContain(SECRET);
    }
    return problems;
  }
  throw new Error("expected a VendorEnvError");
}

describe("vendor env loader", () => {
  it("reads only whitelisted variables, skips vendors without a key and resolves the rest", () => {
    const before = { ...process.env };
    const configs = parseVendorEnv(fixture("partial.env"));
    expect(process.env).toEqual(before);
    expect(configs.map((config) => config.vendor)).toEqual(VENDORS.map((vendor) => vendor.vendor));

    expect(configs.filter((config) => config.status === "ready").map((config) => config.vendor)).toEqual(["ANTHROPIC", "DEEPSEEK", "QWEN", "GLM", "GROK"]);
    for (const vendor of ["OPENAI", "KIMI", "GEMINI"]) {
      const skipped = byVendor(configs, vendor);
      expect(skipped).toMatchObject({ status: "skip", apiKey: "" });
      expect(skipped.reason).toContain(`${vendor}_API_KEY 未填写`);
    }

    expect(byVendor(configs, "ANTHROPIC")).toEqual({
      vendor: "ANTHROPIC",
      presetId: "anthropic",
      status: "ready",
      protocol: "anthropic_messages",
      baseURL: "https://api.anthropic.com",
      modelId: "fake-anthropic-model",
      contextWindowTokens: 200000,
      apiKey: "xxxx-fake-anthropic-key-0001",
    });
    expect(byVendor(configs, "DEEPSEEK")).toMatchObject({ protocol: "anthropic_messages", baseURL: "https://api.deepseek.com/anthropic" });
    expect(byVendor(configs, "QWEN")).toMatchObject({ protocol: "openai_compatible", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" });
    expect(byVendor(configs, "GLM")).toMatchObject({ baseURL: "https://api.z.ai/api/paas/v4" });
    // A relay address is used as given, normalized.
    expect(byVendor(configs, "GROK")).toMatchObject({ protocol: "openai_responses", baseURL: "https://relay.example.com/v1", contextWindowTokens: 131072 });
    expect(byVendor(configs, "ANTHROPIC")).not.toHaveProperty("reason");
  });

  it("never reads variables outside the whitelist", () => {
    const allowed = allowedVariables();
    expect(allowed).not.toContain("AMBER_SECRET_KEY");
    expect(allowed).not.toContain("OPENAI_REGION");
    expect(allowed).toEqual(expect.arrayContaining(["QWEN_REGION", "QWEN_WORKSPACE_ID", "KIMI_REGION", "GLM_REGION", "GROK_PROTOCOL"]));
    expect(allowed.filter((name) => name.endsWith("_WORKSPACE_ID"))).toEqual(["QWEN_WORKSPACE_ID"]);
    // A stray region for a single-region vendor changes nothing.
    expect(byVendor(parseVendorEnv(fixture("partial.env")), "OPENAI").baseURL).toBe("https://api.openai.com/v1");
  });

  it("takes the official address for each preset and default when the Base URL is empty", () => {
    const configs = parseVendorEnv(fixture("official.env"));
    expect(configs.every((config) => config.status === "ready")).toBe(true);
    expect(configs.map(({ vendor, protocol, baseURL }) => ({ vendor, protocol, baseURL }))).toEqual([
      { vendor: "ANTHROPIC", protocol: "anthropic_messages", baseURL: "https://api.anthropic.com" },
      { vendor: "OPENAI", protocol: "openai_responses", baseURL: "https://api.openai.com/v1" },
      { vendor: "DEEPSEEK", protocol: "openai_compatible", baseURL: "https://api.deepseek.com" },
      // Tokyo only through the workspace host; the id is trimmed and lower-cased.
      { vendor: "QWEN", protocol: "openai_compatible", baseURL: "https://ws-fake-0001.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1" },
      { vendor: "KIMI", protocol: "openai_compatible", baseURL: "https://api.moonshot.ai/v1" },
      { vendor: "GLM", protocol: "openai_compatible", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
      { vendor: "GEMINI", protocol: "openai_compatible", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
      { vendor: "GROK", protocol: "openai_responses", baseURL: "https://api.x.ai/v1" },
    ]);
    const qwenDefault = byVendor(parseVendorEnv("QWEN_API_KEY=xxxx-k\nQWEN_MODEL_ID=m\n"), "QWEN");
    expect(qwenDefault.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it.each(
    VENDORS.flatMap(({ vendor, presetId }) => {
      const preset = LLM_PRESETS.find((item) => item.id === presetId);
      return (preset?.regions ?? []).flatMap((region) =>
        region.endpoints.map((endpoint) => ({ vendor, presetId, region: region.id, protocol: endpoint.protocol, regions: preset?.regions.length ?? 0 })),
      );
    }),
  )("$vendor · $region · $protocol resolves to the preset's address", ({ vendor, presetId, region, protocol, regions }) => {
    const preset = LLM_PRESETS.find((item) => item.id === presetId);
    if (preset === undefined) {
      throw new Error(presetId);
    }
    const lines = [`${vendor}_API_KEY=xxxx-k`, `${vendor}_MODEL_ID=m`, `${vendor}_PROTOCOL=${protocol}`];
    if (regions > 1) {
      lines.push(`${vendor}_REGION=${region}`);
    }
    const general = officialBaseUrl(preset, { regionId: region, protocol });
    if (general === undefined) {
      lines.push(`${vendor}_WORKSPACE_ID=ws1`);
    }
    const config = byVendor(parseVendorEnv(lines.join("\n")), vendor);
    const expected = general ?? officialBaseUrl(preset, { regionId: region, protocol, workspaceId: "ws1" });
    expect(expected).toMatch(/^https:\/\//);
    expect(config).toMatchObject({ status: "ready", protocol, baseURL: expected });
  });

  describe("configuration errors name the variable and never the key", () => {
    const withKey = (vendor: string, ...lines: string[]): string => [`${vendor}_API_KEY=${SECRET}`, `${vendor}_MODEL_ID=m`, ...lines].join("\n");

    it.each([
      { name: "a plain-http address", env: withKey("ANTHROPIC", "ANTHROPIC_BASE_URL=http://relay.example.com"), variable: "ANTHROPIC_BASE_URL" },
      { name: "an address that is not a URL", env: withKey("ANTHROPIC", "ANTHROPIC_BASE_URL=relay.example.com/v1"), variable: "ANTHROPIC_BASE_URL" },
      { name: "an interface path at the end", env: withKey("OPENAI", "OPENAI_BASE_URL=https://relay.example.com/v1/chat/completions"), variable: "OPENAI_BASE_URL" },
      { name: "a Responses path at the end", env: withKey("GROK", "GROK_BASE_URL=https://relay.example.com/v1/responses/"), variable: "GROK_BASE_URL" },
      { name: "a Messages path at the end", env: withKey("ANTHROPIC", "ANTHROPIC_BASE_URL=https://relay.example.com/v1/messages"), variable: "ANTHROPIC_BASE_URL" },
      { name: "an invalid workspace id", env: withKey("QWEN", "QWEN_WORKSPACE_ID=bad_id!"), variable: "QWEN_WORKSPACE_ID" },
      { name: "a workspace id ending in a hyphen", env: withKey("QWEN", "QWEN_WORKSPACE_ID=ws-"), variable: "QWEN_WORKSPACE_ID" },
      { name: "an unknown region", env: withKey("KIMI", "KIMI_REGION=mars"), variable: "KIMI_REGION" },
      { name: "an unknown GLM region", env: withKey("GLM", "GLM_REGION=eu"), variable: "GLM_REGION" },
      { name: "Tokyo without a workspace id", env: withKey("QWEN", "QWEN_REGION=ap-northeast-1"), variable: "QWEN_WORKSPACE_ID" },
      { name: "Frankfurt without a workspace id", env: withKey("QWEN", "QWEN_REGION=eu-central-1"), variable: "QWEN_REGION" },
      { name: "a protocol the preset does not serve", env: withKey("GEMINI", "GEMINI_PROTOCOL=anthropic_messages"), variable: "GEMINI_PROTOCOL" },
      { name: "Responses on DeepSeek", env: withKey("DEEPSEEK", "DEEPSEEK_PROTOCOL=openai_responses"), variable: "DEEPSEEK_PROTOCOL" },
      { name: "a misspelled protocol", env: withKey("GROK", "GROK_PROTOCOL=openai-responses"), variable: "GROK_PROTOCOL" },
      { name: "a window with a unit", env: withKey("GLM", "GLM_CONTEXT_WINDOW=128k"), variable: "GLM_CONTEXT_WINDOW" },
      { name: "a zero window", env: withKey("GLM", "GLM_CONTEXT_WINDOW=0"), variable: "GLM_CONTEXT_WINDOW" },
      { name: "a negative window", env: withKey("GLM", "GLM_CONTEXT_WINDOW=-5"), variable: "GLM_CONTEXT_WINDOW" },
      { name: "a fractional window", env: withKey("GLM", "GLM_CONTEXT_WINDOW=1.5"), variable: "GLM_CONTEXT_WINDOW" },
      { name: "a key without a model", env: `GROK_API_KEY=${SECRET}\nGROK_MODEL_ID=`, variable: "GROK_MODEL_ID" },
    ])("$name", ({ env, variable }) => {
      const problems = problemsOf(env);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(variable);
    });

    it("never repeats the value of a protocol or region variable, only its name and the choices", () => {
      const problems = problemsOf(`${withKey("OPENAI", `OPENAI_PROTOCOL=${SECRET}`)}\n${withKey("GLM", "GLM_REGION=weird-region-42")}\n`);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toBe("OPENAI_PROTOCOL 不是该预设支持的协议，可选：openai_compatible、openai_responses");
      expect(problems[1]).toBe("GLM_REGION 不是已知地域，可选：cn、intl");
      const kimi = byVendor(parseVendorEnv("KIMI_REGION=weird-region-42\nKIMI_PROTOCOL=odd-protocol-7\n"), "KIMI");
      expect(kimi.reason).toContain("KIMI_REGION");
      expect(kimi.reason).toContain("KIMI_PROTOCOL");
      expect(kimi.reason).not.toContain("weird-region-42");
      expect(kimi.reason).not.toContain("odd-protocol-7");
    });

    it("reports every vendor's problems at once", () => {
      const problems = problemsOf(`${withKey("KIMI", "KIMI_REGION=mars")}\n${withKey("GLM", "GLM_CONTEXT_WINDOW=x")}\n`);
      expect(problems).toHaveLength(2);
      expect(problems.join("\n")).toMatch(/KIMI_REGION[\s\S]*GLM_CONTEXT_WINDOW/);
    });

    it("lets a vendor without a key carry its mistakes into the skip reason instead of failing", () => {
      const kimi = byVendor(parseVendorEnv("KIMI_REGION=mars\nKIMI_MODEL_ID=\n"), "KIMI");
      expect(kimi.status).toBe("skip");
      expect(kimi.reason).toContain("KIMI_API_KEY 未填写");
      expect(kimi.reason).toContain("KIMI_REGION");
    });
  });

  it("reads the repository's .env unless the override names another file", () => {
    expect(vendorEnvPath({})).toBe(join(REPO_ROOT, ".env"));
    const path = join(FIXTURES, "partial.env");
    expect(vendorEnvPath({ [ENV_FILE_VARIABLE]: path })).toBe(path);
    const before = { ...process.env };
    const configs = loadVendorEnv(vendorEnvPath({ [ENV_FILE_VARIABLE]: path }));
    expect(process.env).toEqual(before);
    expect(byVendor(configs, "GLM").status).toBe("ready");
  });

  it("describes official addresses with their region and hides custom ones", () => {
    const official = byVendor(parseVendorEnv(fixture("official.env")), "QWEN");
    expect(describeAddress(official)).toEqual({ label: "官方地址 · 日本（东京） · 工作空间专属地址", host: "ws-fake-0001.ap-northeast-1.maas.aliyuncs.com" });
    expect(describeAddress({ presetId: "anthropic", protocol: "anthropic_messages", baseURL: "https://api.anthropic.com" })).toEqual({ label: "官方地址", host: "api.anthropic.com" });
    expect(describeAddress({ presetId: "grok", protocol: "openai_responses", baseURL: "https://relay.example.com/v1" })).toEqual({ label: "自定义地址" });
  });
});

describe("redaction", () => {
  it("replaces every occurrence of every key, the longest first, and ignores empty keys", () => {
    expect(redact("a xxxx-k1 b xxxx-k1-long c xxxx-k1", ["", "xxxx-k1", "xxxx-k1-long"])).toBe("a <redacted> b <redacted> c <redacted>");
    expect(redact("nothing here", [""])).toBe("nothing here");
  });

  it("cleans an upstream explanation: keys and hidden strings out, one line, truncated", () => {
    const text = `Invalid key ${SECRET}\n for https://relay.example.com/v1 ${"x".repeat(400)}`;
    const clean = sanitizeUpstream(text, [SECRET], ["https://relay.example.com/v1"]);
    expect(clean).not.toContain(SECRET);
    expect(clean).not.toContain("relay.example.com");
    expect(clean).not.toContain("\n");
    expect(clean.length).toBeLessThanOrEqual(301);
    expect(clean.endsWith("…")).toBe(true);
  });

  it("names run directories in UTC+8", () => {
    expect(runStamp(new Date(Date.UTC(2026, 10, 20, 16, 5, 9)))).toBe("20261121-000509");
  });
});

describe("report rendering", () => {
  const OTHER = "xxxx-other-vendor-key-77";

  function sampleReport(): RunReport {
    return {
      startedAt: Date.UTC(2026, 10, 20, 2, 0, 0),
      finishedAt: Date.UTC(2026, 10, 20, 2, 3, 0),
      requestCap: 6,
      vendors: [
        {
          vendor: "DEEPSEEK",
          presetId: "deepseek",
          status: "ready",
          protocol: "openai_compatible",
          address: "官方地址",
          host: "api.deepseek.com",
          modelId: "fake-deepseek-model",
          keyFilled: true,
          credentialStatus: "configured",
          probe: {
            passed: true,
            checks: [
              { stage: "basic", result: "connected", latencyMs: 812 },
              { stage: "stream", result: "supported", latencyMs: 640 },
              { stage: "structuredOutput", result: "inconclusive", reason: "truncated", latencyMs: 900 },
              { stage: "tools", result: "unsupported", latencyMs: 700 },
            ],
          },
          shortRequest: {
            executed: true,
            passed: false,
            latencyMs: 300,
            // Upstream text that echoed a key: the renderer must not let it through.
            error: { stage: "short", code: "llm_failed.invalid_request", upstreamMessage: `bad request for key ${SECRET}` },
            text: `OK ${SECRET}`,
          },
          usage: [
            { stage: "basic", feature: "test_connection", outcome: "succeeded", inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, reasoningTokens: 0, rawUsageSaved: true },
            { stage: "short", feature: "chat", outcome: "failed", rawUsageSaved: false },
          ],
          requestCount: 5,
          assertions: [{ name: "凭据状态为 configured", ok: true }],
        },
        {
          vendor: "KIMI",
          presetId: "kimi",
          status: "skip",
          skipReason: `KIMI_API_KEY 未填写 ${OTHER}`,
          protocol: "openai_compatible",
          address: "官方地址",
          modelId: "",
          keyFilled: false,
          usage: [],
          requestCount: 0,
          assertions: [],
        },
      ],
    };
  }

  it("writes stages, error codes, usage and request totals, with test connection and the short request judged apart", () => {
    const markdown = renderReportMarkdown(sampleReport(), [SECRET, OTHER]);
    expect(markdown).toContain("测试连接通过");
    expect(markdown).toContain("极短请求未通过");
    expect(markdown).toContain("极短请求 · `llm_failed.invalid_request`");
    expect(markdown).toContain("| JSON | inconclusive | truncated | 900 |");
    expect(markdown).toContain("| 基础调用 | test_connection | succeeded | 12 | 3 | 0 | — | 0 | 已保存 |");
    expect(markdown).toContain("| 合计 | 5 | 6 |");
    expect(markdown).toContain("Key：已填写");
    expect(markdown).toContain("Key：未填写");
    expect(markdown).toContain("开始：2026-11-20 10:00:00（UTC+8）");
  });

  it("contains no key in either file, even when the data carried one", () => {
    const keys = [SECRET, OTHER];
    const markdown = renderReportMarkdown(sampleReport(), keys);
    const json = renderReportJson(sampleReport(), keys);
    for (const key of keys) {
      expect(markdown).not.toContain(key);
      expect(json).not.toContain(key);
    }
    const parsed = JSON.parse(json) as { totals: { requests: number; perVendor: Record<string, number> } };
    expect(parsed.totals).toEqual({ requests: 5, perVendor: { DEEPSEEK: 5, KIMI: 0 } });
  });

  it("passes a vendor only when test connection, the short request and every assertion hold", () => {
    const [deepseek, kimi] = sampleReport().vendors;
    if (deepseek === undefined || kimi === undefined) {
      throw new Error("sample");
    }
    expect(vendorPassed(deepseek)).toBe(false);
    expect(vendorPassed({ ...deepseek, shortRequest: { executed: true, passed: true } })).toBe(true);
    expect(vendorPassed({ ...deepseek, shortRequest: { executed: true, passed: true }, assertions: [{ name: "x", ok: false }] })).toBe(false);
    expect(vendorPassed(kimi)).toBe(false);
  });
});
