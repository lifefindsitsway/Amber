import { describe, expect, it } from "vitest";
import { modelFamily } from "../../../src/web/models/model-family.ts";

describe("modelFamily", () => {
  it.each([
    ["gpt-6-sol", "openai"],
    ["chatgpt-4o-latest", "openai"],
    ["o1", "openai"],
    ["o3-mini", "openai"],
    ["o4.1", "openai"],
    ["claude-sonnet-5-5", "anthropic"],
    ["gemini-3-pro", "gemini"],
    ["gemma-3-27b", "gemini"],
    ["deepseek-chat", "deepseek"],
    ["qwen3-max", "qwen"],
    ["qwq-32b", "qwen"],
    ["qvq-max", "qwen"],
    ["glm-5", "glm"],
    ["chatglm3-6b", "glm"],
    ["kimi-k3", "kimi"],
    ["moonshot-v1-8k", "kimi"],
    ["grok-5", "grok"],
    ["grok:latest", "grok"],
  ])("names %s after %s", (model, mark) => {
    expect(modelFamily(model)).toBe(mark);
  });

  it("reads the last path segment, ignoring case and surrounding space", () => {
    expect(modelFamily("openai/gpt-6")).toBe("openai");
    expect(modelFamily("vendor/sub/Claude-Opus")).toBe("anthropic");
    expect(modelFamily("  DeepSeek-R2 ")).toBe("deepseek");
    expect(modelFamily("models/gemini-3-flash")).toBe("gemini");
  });

  it("needs the prefix to end at a digit, a separator or the end of the name", () => {
    expect(modelFamily("gptx")).toBeUndefined();
    expect(modelFamily("claudette")).toBeUndefined();
    expect(modelFamily("o1x")).toBeUndefined();
    expect(modelFamily("oracle-1")).toBeUndefined();
    expect(modelFamily("my-gpt-4")).toBeUndefined();
  });

  it("is a guess from the name: an alias that starts like a vendor's model matches", () => {
    expect(modelFamily("gpt-proxy")).toBe("openai");
  });

  it("knows nothing about other names", () => {
    expect(modelFamily("doubao-pro")).toBeUndefined();
    expect(modelFamily("")).toBeUndefined();
    expect(modelFamily("openai/")).toBeUndefined();
    expect(modelFamily("constructor")).toBeUndefined();
  });
});
