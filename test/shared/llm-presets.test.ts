import { describe, expect, it } from "vitest";
import { zhCN } from "../../src/shared/i18n/zh-CN/index.ts";
import {
  LLM_PRESET_IDS,
  LLM_PRESETS,
  endpointPathSuffix,
  hasRegions,
  isValidWorkspaceId,
  matchPresetAddress,
  normalizeWorkspaceId,
  officialBaseUrl,
  presetById,
  presetProtocols,
  supportsWorkspace,
} from "../../src/shared/llm-presets.ts";

function preset(id: string) {
  const found = presetById(id);
  if (found === undefined) {
    throw new Error(`no preset ${id}`);
  }
  return found;
}

describe("LLM presets", () => {
  it("lists the nine presets in display order, each with a display name", () => {
    expect(LLM_PRESETS.map((item) => item.id)).toEqual(["deepseek", "qwen", "kimi", "glm", "openai", "anthropic", "gemini", "grok", "custom"]);
    expect([...LLM_PRESET_IDS]).toEqual(LLM_PRESETS.map((item) => item.id));
    expect(LLM_PRESETS.map((item) => zhCN.llmPresets.name[item.id])).toEqual([
      "DeepSeek",
      "Qwen（通义千问）",
      "Kimi（月之暗面）",
      "GLM（智谱）",
      "OpenAI",
      "Anthropic",
      "Gemini",
      "Grok（xAI）",
      "自定义",
    ]);
  });

  it("gives every region of a multi-region preset a display name", () => {
    for (const item of LLM_PRESETS.filter(hasRegions)) {
      const names = (zhCN.llmPresets.region as Record<string, Record<string, string>>)[item.id];
      for (const region of item.regions) {
        expect(names?.[region.id], `${item.id}/${region.id}`).toBeTruthy();
      }
    }
  });

  it("uses the vendors' official default addresses and protocols", () => {
    const defaults = Object.fromEntries(
      LLM_PRESETS.filter((item) => item.id !== "custom").map((item) => {
        const first = presetProtocols(item)[0];
        return [item.id, first === undefined ? undefined : [first.protocol, officialBaseUrl(item, { protocol: first.protocol })]];
      }),
    );
    expect(defaults).toEqual({
      deepseek: ["openai_compatible", "https://api.deepseek.com"],
      qwen: ["openai_compatible", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
      kimi: ["openai_compatible", "https://api.moonshot.cn/v1"],
      glm: ["openai_compatible", "https://open.bigmodel.cn/api/paas/v4"],
      openai: ["openai_compatible", "https://api.openai.com/v1"],
      anthropic: ["anthropic_messages", "https://api.anthropic.com"],
      gemini: ["openai_compatible", "https://generativelanguage.googleapis.com/v1beta/openai"],
      grok: ["openai_responses", "https://api.x.ai/v1"],
    });
    expect(presetProtocols(preset("grok"))).toEqual([
      { protocol: "openai_responses", baseURL: "https://api.x.ai/v1" },
      { protocol: "openai_compatible", baseURL: "https://api.x.ai/v1", legacy: true },
    ]);
    expect(presetProtocols(preset("openai")).map((item) => item.protocol)).toEqual(["openai_compatible", "openai_responses"]);
    expect(presetProtocols(preset("custom"))).toEqual([]);
  });

  it("builds Qwen's general and workspace addresses, and requires a workspace in Tokyo and Frankfurt", () => {
    const qwen = preset("qwen");
    expect(supportsWorkspace(qwen)).toBe(true);
    expect(supportsWorkspace(preset("kimi"))).toBe(false);
    expect(officialBaseUrl(qwen, { protocol: "openai_compatible", regionId: "cn-hongkong" })).toBe("https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1");
    expect(officialBaseUrl(qwen, { protocol: "openai_compatible", regionId: "us-east-1" })).toBe("https://dashscope-us.aliyuncs.com/compatible-mode/v1");
    expect(officialBaseUrl(qwen, { protocol: "openai_compatible", regionId: "ap-southeast-1", workspaceId: "ws-01" })).toBe(
      "https://ws-01.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    expect(officialBaseUrl(qwen, { protocol: "openai_compatible", regionId: "ap-northeast-1" })).toBeUndefined();
    expect(officialBaseUrl(qwen, { protocol: "openai_compatible", regionId: "eu-central-1", workspaceId: "abc" })).toBe(
      "https://abc.eu-central-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    expect(officialBaseUrl(qwen, { protocol: "openai_compatible", regionId: "cn-beijing", workspaceId: "-bad" })).toBeUndefined();
    expect(officialBaseUrl(qwen, { protocol: "anthropic_messages", regionId: "cn-beijing" })).toBeUndefined();
    expect(officialBaseUrl(preset("kimi"), { protocol: "openai_compatible", regionId: "intl" })).toBe("https://api.moonshot.ai/v1");
    expect(officialBaseUrl(preset("glm"), { protocol: "openai_compatible", regionId: "intl" })).toBe("https://api.z.ai/api/paas/v4");
  });

  it("validates a workspace id as one lower-case DNS label", () => {
    expect(normalizeWorkspaceId("  WS-Abc ")).toBe("ws-abc");
    for (const good of ["a", "ws-01", "0abc9", "a".repeat(63)]) {
      expect(isValidWorkspaceId(good), good).toBe(true);
    }
    for (const bad of ["", "-a", "a-", "a.b", "a_b", "A", "a".repeat(64), "a b"]) {
      expect(isValidWorkspaceId(bad), bad).toBe(false);
    }
  });

  it("reads the region back from the address by exact match only", () => {
    const qwen = preset("qwen");
    expect(matchPresetAddress(qwen, "openai_compatible", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/")).toEqual({ regionId: "ap-southeast-1" });
    expect(matchPresetAddress(qwen, "openai_compatible", "HTTPS://WS9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).toEqual({
      regionId: "cn-beijing",
      workspaceId: "ws9",
    });
    expect(matchPresetAddress(qwen, "openai_compatible", "https://dashscope.aliyuncs.com/compatible-mode/v2")).toBeUndefined();
    expect(matchPresetAddress(qwen, "openai_compatible", "https://a.b.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).toBeUndefined();
    expect(matchPresetAddress(qwen, "openai_compatible", "http://dashscope.aliyuncs.com/compatible-mode/v1")).toBeUndefined();
    expect(matchPresetAddress(preset("kimi"), "openai_compatible", "https://api.moonshot.ai/v1")).toEqual({ regionId: "intl" });
    expect(matchPresetAddress(preset("grok"), "openai_compatible", "https://api.x.ai/v1")).toEqual({ regionId: "default" });
    expect(matchPresetAddress(preset("deepseek"), "openai_compatible", "https://api.deepseek.com/anthropic")).toBeUndefined();
    expect(matchPresetAddress(preset("deepseek"), "anthropic_messages", "https://api.deepseek.com/anthropic")).toEqual({ regionId: "default" });
    expect(matchPresetAddress(preset("openai"), "openai_compatible", "https://relay.example.com/v1")).toBeUndefined();
  });

  it("spots an interface path pasted at the end of a Base URL", () => {
    expect(endpointPathSuffix("https://api.moonshot.cn/v1/chat/completions")).toBe("/chat/completions");
    expect(endpointPathSuffix("https://api.x.ai/v1/responses/")).toBe("/responses");
    expect(endpointPathSuffix("https://api.anthropic.com/v1/Messages")).toBe("/messages");
    expect(endpointPathSuffix("https://api.moonshot.cn/v1")).toBeUndefined();
  });
});
