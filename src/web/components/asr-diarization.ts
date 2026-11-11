import { ASR_PRESETS, asrDiarizationSupport, type AsrDiarizationSupport } from "../../shared/asr-presets.ts";
import type { AsrProfileDto } from "../../shared/dto/asr-profile.ts";
import type { AsrModelRefDto } from "../../shared/dto/model-ref.ts";

/**
 * What speaker identification can do for a chosen transcription model and content length:
 * no model chosen yet, a model that does not offer it, audio longer than the provider
 * recommends (identification may fail there), or available.
 */
export type DiarizationOffer =
  | { status: "no_model" }
  | { status: "unsupported" }
  | { status: "over_recommended"; support: AsrDiarizationSupport }
  | { status: "available"; support: AsrDiarizationSupport };

/**
 * Judges the model the way the server's pre-checks do, from what the provider documents for
 * the profile's own provider (a typed-in model never has it). An unknown duration is never
 * held against the model: the server measures the extracted audio before it asks the provider.
 */
export function diarizationOffer(profiles: readonly AsrProfileDto[], ref: AsrModelRefDto | undefined, durationMs: number | undefined): DiarizationOffer {
  if (ref === undefined) return { status: "no_model" };
  const profile = profiles.find((item) => item.id === ref.asrProfileId);
  if (profile === undefined) return { status: "unsupported" };
  const support = asrDiarizationSupport(ASR_PRESETS[profile.provider], ref.modelId);
  if (support === undefined) return { status: "unsupported" };
  const limit = support.recommendedMaxDurationSec;
  if (limit !== undefined && durationMs !== undefined && durationMs > limit * 1000) return { status: "over_recommended", support };
  return { status: "available", support };
}

/** The speaker count a text field holds: empty is "auto"; anything but a whole number is `"invalid"`. */
export function parseSpeakerCount(text: string): number | undefined | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : "invalid";
}

/** Whether the model's range refuses the speaker count; a count is refused, never clamped. */
export function speakerCountOutOfRange(support: AsrDiarizationSupport, count: number | undefined | "invalid"): boolean {
  if (count === undefined) return false;
  return count === "invalid" || count < support.speakerCount.min || count > support.speakerCount.max;
}

/**
 * The one-line note under a model choice about what the speaker identification setting will do with it:
 * nothing is said while the setting is off or no model is chosen.
 */
export function diarizationNoteKey(settingOn: boolean, offer: DiarizationOffer): "willIdentify" | "unsupported" | "overRecommended" | undefined {
  if (!settingOn || offer.status === "no_model") return undefined;
  if (offer.status === "unsupported") return "unsupported";
  return offer.status === "over_recommended" ? "overRecommended" : "willIdentify";
}
