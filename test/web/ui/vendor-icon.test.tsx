import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LLM_PRESET_IDS } from "../../../src/shared/llm-presets.ts";
import { VendorIcon, VendorMark } from "../../../src/web/ui/vendor-icon.tsx";

describe("VendorIcon", () => {
  it("draws a decorative mark for every vendor preset and one neutral glyph for the rest", () => {
    const { container } = render(
      <div>
        {LLM_PRESET_IDS.map((id) => (
          <VendorIcon key={id} presetId={id} />
        ))}
        <VendorIcon presetId={undefined} />
        <VendorIcon presetId="retired-vendor" />
        <VendorIcon presetId="constructor" />
        <VendorIcon presetId="dashscope" />
        <VendorMark mark="elevenlabs" />
        <VendorMark mark="dashscope" />
      </div>,
    );
    const icons = [...container.querySelectorAll("svg")];
    expect(icons.map((icon) => icon.getAttribute("data-vendor-icon"))).toEqual([
      "deepseek",
      "qwen",
      "kimi",
      "glm",
      "openai",
      "anthropic",
      "gemini",
      "grok",
      "neutral",
      "neutral",
      "neutral",
      "neutral",
      "neutral",
      "elevenlabs",
      "dashscope",
    ]);
    for (const icon of icons) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(icon.getAttribute("width")).toBe("16");
      // Nothing a reader would announce or a page could load.
      expect(icon.querySelector("title, script, image, use, a, foreignObject")).toBeNull();
      expect(icon.outerHTML).not.toMatch(/\son\w+=|href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/u);
    }
  });

  it("follows the text colour with the single-colour marks", () => {
    const { container } = render(
      <div>
        {(["kimi", "glm", "openai", "anthropic", "grok", "elevenlabs"] as const).map((id) => (
          <VendorMark key={id} mark={id} />
        ))}
      </div>,
    );
    for (const icon of container.querySelectorAll("svg")) {
      expect(icon.getAttribute("fill")).toBe("currentColor");
    }
  });

  it("gives each copy of a gradient mark its own gradient ids, all resolvable", () => {
    const { container } = render(
      <div>
        <VendorIcon presetId="gemini" />
        <VendorIcon presetId="gemini" />
      </div>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/u);
    }
    const references = [...container.querySelectorAll("path")].flatMap((element) => /^url\(#(.+)\)$/u.exec(element.getAttribute("fill") ?? "")?.[1] ?? []);
    expect(references).toHaveLength(6);
    for (const reference of references) {
      expect(ids).toContain(reference);
    }
  });
});
