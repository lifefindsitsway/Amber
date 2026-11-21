import { Server } from "lucide-react";
import type { ComponentType } from "react";
import { ASR_PROVIDERS, type AsrProviderId } from "../../shared/enums.ts";
import { LLM_PRESET_IDS, type LlmPresetId } from "../../shared/llm-presets.ts";
import { AnthropicMark, BailianMark, ClaudeMark, DeepSeekMark, ElevenLabsMark, GeminiMark, GrokMark, KimiMark, OpenAiMark, QwenMark, ZaiMark, type MarkProps } from "./vendor-icons/marks.tsx";

/**
 * Model families whose models carry a mark of their own, apart from their vendor's: Claude
 * models get the orange Claude mark, while the Anthropic service keeps the company mark. Keyed
 * like the ids the model-name guess returns; never an LLM preset, so no profile shows them.
 */
const MODEL_FAMILY_MARKS = { claude: ClaudeMark } as const;

/** A mark that can be drawn: an LLM service preset other than "custom", a transcription service, or a model family above. */
export type VendorMarkId = Exclude<LlmPresetId, "custom"> | AsrProviderId | keyof typeof MODEL_FAMILY_MARKS;

const MARKS: Readonly<Record<VendorMarkId, ComponentType<MarkProps>>> = {
  deepseek: DeepSeekMark,
  qwen: QwenMark,
  kimi: KimiMark,
  glm: ZaiMark,
  openai: OpenAiMark,
  anthropic: AnthropicMark,
  gemini: GeminiMark,
  grok: GrokMark,
  elevenlabs: ElevenLabsMark,
  dashscope: BailianMark,
  ...MODEL_FAMILY_MARKS,
};

/** The mark of an LLM service preset id as stored on a profile; free text, so unknown ids have none. */
export function presetMark(presetId: string | undefined): VendorMarkId | undefined {
  return ownMark(presetId, LLM_PRESET_IDS);
}

/** The mark of a transcription service. */
export function asrProviderMark(provider: string | undefined): VendorMarkId | undefined {
  return ownMark(provider, ASR_PROVIDERS);
}

function ownMark(id: string | undefined, family: readonly string[]): VendorMarkId | undefined {
  // Own keys only: a stored id is free text and must not reach `Object.prototype`.
  return id !== undefined && family.includes(id) && Object.hasOwn(MARKS, id) ? (id as VendorMarkId) : undefined;
}

/**
 * The mark of a vendor, or one neutral server glyph when there is none. Always decorative: it
 * sits beside the written name, which is what assistive technology reads.
 */
export function VendorMark({ mark, size = 16, className = "" }: { mark: VendorMarkId | undefined; size?: number | undefined; className?: string | undefined }) {
  const Mark = mark === undefined ? undefined : MARKS[mark];
  if (Mark === undefined) {
    return <Server size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" className={`shrink-0 text-muted ${className}`} data-vendor-icon="neutral" />;
  }
  return <Mark width={size} height={size} className={`shrink-0 ${className}`} data-vendor-icon={mark} />;
}

/**
 * The mark of an LLM service preset; the custom preset, a profile without a preset and a
 * preset id this build does not know all get the neutral glyph.
 */
export function VendorIcon({ presetId, size = 16, className = "" }: { presetId: string | undefined; size?: number; className?: string }) {
  return <VendorMark mark={presetMark(presetId)} size={size} className={className} />;
}
