import type { AsrProviderId } from "./enums.ts";

/** One official endpoint (region) of an ASR provider. */
export interface AsrPresetEndpoint {
  /** Stable id of the region, for the UI's region names. */
  id: string;
  baseURL: string;
}

/**
 * A request shape of one provider's transcription API: which optional
 * parameters a model of it receives. A model the user types in names one; a known model
 * has its own.
 */
export interface AsrModelFamily {
  id: string;
  /** Whether requests carry the user's terminology as hot words. */
  terminology: boolean;
}

/**
 * Speaker identification a model offers, from the provider's official documentation.
 * `reference`: the provider tries to output that many speakers; `maximum`: at most that many.
 * Past `recommendedMaxDurationSec` the provider documents that identification may fail.
 */
export interface AsrDiarizationSupport {
  speakerCount: { min: number; max: number; semantics: "reference" | "maximum" };
  recommendedMaxDurationSec?: number;
}

/**
 * What an ASR provider offers its profiles: suggested models in the order the
 * UI lists them, those a new profile starts with, the one "test key" uses, the request
 * families a model may follow and the family of each model Amber knows, and where requests
 * may go. Any other model id may be added with a family. `preset_only` restricts the Base URL to
 * the listed endpoints; `any` accepts any Base URL (still subject to the network policy)
 * and uses the first endpoint when none is stored. Pure data, shared with the
 * UI; adapters publish it as their descriptor so the service layer names no provider.
 */
export interface AsrPreset {
  provider: AsrProviderId;
  baseUrlPolicy: "preset_only" | "any";
  endpoints: readonly AsrPresetEndpoint[];
  /** Suggestions for "add model"; not a limit. */
  models: readonly string[];
  /** A new profile's models until the user changes them; never a default for Tasks. */
  recommendedModels: readonly string[];
  /** The model a key check names where the provider's check needs one; independent of the user's order. */
  defaultModel: string;
  families: readonly AsrModelFamily[];
  /** The family the UI starts a typed-in model with: the one sending the fewest optional parameters. */
  customModelFamily: string;
  /** The family of every model Amber knows; such a model cannot be given another. */
  knownModels: Readonly<Record<string, string>>;
  /**
   * Speaker identification of the known models that offer it. A typed-in model never has it,
   * even in the same family: the family describes request parameters, not what was verified.
   */
  diarization: Readonly<Record<string, AsrDiarizationSupport>>;
}

/** Speaker identification of a profile's model, when Amber knows the model offers it. */
export function asrDiarizationSupport(preset: AsrPreset, modelId: string): AsrDiarizationSupport | undefined {
  return Object.hasOwn(preset.diarization, modelId) ? preset.diarization[modelId] : undefined;
}

/** A model id as typed in: letters, digits and `._:/-`, starting with a letter or digit. */
export const ASR_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * The family a profile's model follows: the one stored with it, else the one Amber knows it
 * by. `undefined` when neither names a family the provider still has; such a model cannot
 * be used (`asr_failed.model_unavailable`).
 */
export function asrModelFamily(preset: AsrPreset, entry: { modelId: string; family?: string }): AsrModelFamily | undefined {
  const id = Object.hasOwn(preset.knownModels, entry.modelId) ? preset.knownModels[entry.modelId] : entry.family;
  return preset.families.find((family) => family.id === id);
}

export const ASR_PRESETS: Readonly<Record<AsrProviderId, AsrPreset>> = {
  elevenlabs: {
    provider: "elevenlabs",
    baseUrlPolicy: "any",
    endpoints: [{ id: "default", baseURL: "https://api.elevenlabs.io" }],
    // Batch models of the speech-to-text API only; the realtime model streams over a
    // WebSocket and the first generation is deprecated.
    models: ["scribe_v2", "scribe_v2_medical"],
    recommendedModels: ["scribe_v2"],
    defaultModel: "scribe_v2",
    // The API reference documents `no_verbatim` for `scribe_v2` alone, so only that
    // family sends it.
    families: [
      { id: "scribe", terminology: true },
      { id: "scribe_v2", terminology: true },
    ],
    customModelFamily: "scribe",
    knownModels: { scribe_v2: "scribe_v2", scribe_v2_medical: "scribe" },
    // `num_speakers` is an upper bound, at most 32; Medical uses the same API and features.
    diarization: {
      scribe_v2: { speakerCount: { min: 1, max: 32, semantics: "maximum" } },
      scribe_v2_medical: { speakerCount: { min: 1, max: 32, semantics: "maximum" } },
    },
  },
  // Free quota exists only in the Beijing region, and the temporary upload space is
  // documented for it alone.
  dashscope: {
    provider: "dashscope",
    baseUrlPolicy: "preset_only",
    endpoints: [{ id: "cn-beijing", baseURL: "https://dashscope.aliyuncs.com" }],
    models: ["qwen-audio-3.1-asr-flash-filetrans", "fun-asr"],
    recommendedModels: ["qwen-audio-3.1-asr-flash-filetrans", "fun-asr"],
    defaultModel: "qwen-audio-3.1-asr-flash-filetrans",
    // Both families share one API; only qwen-audio-3.x takes inline hot words.
    families: [
      { id: "fun_asr", terminology: false },
      { id: "qwen_audio", terminology: true },
    ],
    customModelFamily: "fun_asr",
    knownModels: { "qwen-audio-3.1-asr-flash-filetrans": "qwen_audio", "fun-asr": "fun_asr" },
    // Both API references: `speaker_count` is a reference value from 2 to 100, mono audio
    // only, and audio over two hours may fail or time out with identification on.
    diarization: {
      "qwen-audio-3.1-asr-flash-filetrans": { speakerCount: { min: 2, max: 100, semantics: "reference" }, recommendedMaxDurationSec: 7200 },
      "fun-asr": { speakerCount: { min: 2, max: 100, semantics: "reference" }, recommendedMaxDurationSec: 7200 },
    },
  },
};
