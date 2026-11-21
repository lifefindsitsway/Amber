import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AsrServiceMark, LlmModelMark } from "../../../src/web/models/model-mark.tsx";

const marks = (container: HTMLElement): Array<string | null> => [...container.querySelectorAll("svg")].map((icon) => icon.getAttribute("data-vendor-icon"));

describe("LlmModelMark", () => {
  it("prefers the model name, then the profile's service, then the neutral glyph", () => {
    const { container } = render(
      <div>
        <LlmModelMark modelId="deepseek-v3" presetId="qwen" />
        <LlmModelMark modelId="relay-model" presetId="qwen" />
        <LlmModelMark modelId="relay-model" presetId="custom" />
        <LlmModelMark modelId="relay-model" presetId={undefined} />
        <LlmModelMark modelId="relay-model" presetId="elevenlabs" />
        <LlmModelMark modelId="glm-5" size={14} />
      </div>,
    );
    expect(marks(container)).toEqual(["deepseek", "qwen", "neutral", "neutral", "neutral", "glm"]);
    const sizes = [...container.querySelectorAll("svg")].map((icon) => icon.getAttribute("width"));
    expect(sizes).toEqual(["16", "16", "16", "16", "16", "14"]);
  });

  it("gives Claude models their own mark, and keeps the company mark for the service", () => {
    const { container } = render(
      <div>
        <LlmModelMark modelId="claude-opus-5-5" presetId="anthropic" />
        <LlmModelMark modelId="claude-sonnet-5-5" presetId="custom" />
        <LlmModelMark modelId="relay-model" presetId="anthropic" />
        <LlmModelMark modelId="relay-model" presetId="claude" />
      </div>,
    );
    expect(marks(container)).toEqual(["claude", "claude", "anthropic", "neutral"]);
  });
});

describe("AsrServiceMark", () => {
  it("follows the service only", () => {
    const { container } = render(
      <div>
        <AsrServiceMark provider="elevenlabs" />
        <AsrServiceMark provider="dashscope" />
        <AsrServiceMark provider={undefined} />
        <AsrServiceMark provider="openai" />
        <AsrServiceMark provider="toString" />
      </div>,
    );
    expect(marks(container)).toEqual(["elevenlabs", "dashscope", "neutral", "neutral", "neutral"]);
  });
});
