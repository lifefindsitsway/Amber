import { Server } from "lucide-react";
import type { ComponentType } from "react";
import type { LlmPresetId } from "../../shared/llm-presets.ts";
import { AnthropicMark, ChatGlmMark, DeepSeekMark, GeminiMark, GrokMark, KimiMark, OpenAiMark, QwenMark, type MarkProps } from "./vendor-icons/marks.tsx";

const MARKS: Readonly<Partial<Record<LlmPresetId, ComponentType<MarkProps>>>> = {
  deepseek: DeepSeekMark,
  qwen: QwenMark,
  kimi: KimiMark,
  glm: ChatGlmMark,
  openai: OpenAiMark,
  anthropic: AnthropicMark,
  gemini: GeminiMark,
  grok: GrokMark,
};

/**
 * The mark of an LLM service preset; the custom preset, a profile without a preset and a
 * preset id this build does not know all get one neutral server glyph. Always decorative: it
 * sits beside the service's written name, which is what assistive technology reads.
 */
export function VendorIcon({ presetId, size = 16, className = "" }: { presetId: string | undefined; size?: number; className?: string }) {
  // Own keys only: a stored id is free text and must not reach `Object.prototype`.
  const Mark = presetId !== undefined && Object.hasOwn(MARKS, presetId) ? MARKS[presetId as LlmPresetId] : undefined;
  if (Mark === undefined) {
    return <Server size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" className={`shrink-0 text-muted ${className}`} data-vendor-icon="neutral" />;
  }
  return <Mark width={size} height={size} className={`shrink-0 ${className}`} data-vendor-icon={presetId} />;
}
