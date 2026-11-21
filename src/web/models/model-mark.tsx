import { asrProviderMark, presetMark, VendorMark } from "../ui/vendor-icon.tsx";
import { modelFamily } from "./model-family.ts";

interface MarkSize {
  /** Pixel size; 16 beside `text-sm`, 14 beside `text-xs`. */
  size?: number | undefined;
  className?: string | undefined;
}

/**
 * The mark beside an LLM model: the vendor its name points at, else the service of its profile,
 * else a neutral glyph. Decorative and never authoritative (see `modelFamily`).
 */
export function LlmModelMark({ modelId, presetId, size = 16, className }: MarkSize & { modelId: string; presetId?: string | undefined }) {
  return <VendorMark mark={modelFamily(modelId) ?? presetMark(presetId)} size={size} className={className} />;
}

/** The mark beside a transcription model or profile: its service only; unknown or deleted gets the neutral glyph. */
export function AsrServiceMark({ provider, size = 16, className }: MarkSize & { provider: string | undefined }) {
  return <VendorMark mark={asrProviderMark(provider)} size={size} className={className} />;
}
