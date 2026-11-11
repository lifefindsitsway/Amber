import { z } from "zod";
import type { AsrDiarizationSupport } from "../../shared/asr-presets.ts";
import type { DiarizationRequest } from "../../shared/dto/speaker.ts";
import type { DiarizationStatus, DiarizationUnavailableReason } from "../../shared/speakers.ts";

/**
 * Whether one transcription identifies speakers, as decided before anything is sent. When it
 * does not, `status` is what the revision records and `reason` why a request that insisted on
 * identification (`required`) cannot be honored.
 */
export type DiarizationDecision =
  | { effective: true; speakerCount?: number }
  | { effective: false; status: Extract<DiarizationStatus, "off" | "unsupported" | "over_recommended">; reason?: DiarizationUnavailableReason };

/**
 * The decision as persisted with a submitted job, so a re-entry reuses it instead of deciding
 * again on audio it no longer holds. Only what the revision records is kept; `reason` matters
 * to a request that failed and is not stored.
 */
export const diarizationDecisionSchema = z.union([
  z.object({ effective: z.literal(true), speakerCount: z.number().int().positive().exactOptional() }).strict(),
  z.object({ effective: z.literal(false), status: z.enum(["off", "unsupported", "over_recommended"]) }).strict(),
]);

/** The decision as it is persisted. */
export function persistedDecision(decision: DiarizationDecision): z.infer<typeof diarizationDecisionSchema> {
  return decision.effective
    ? decision.speakerCount === undefined
      ? { effective: true }
      : { effective: true, speakerCount: decision.speakerCount }
    : { effective: false, status: decision.status };
}

/** Whether `count` lies in the speaker range a model declares. */
export function speakerCountInRange(support: AsrDiarizationSupport, count: number): boolean {
  return count >= support.speakerCount.min && count <= support.speakerCount.max;
}

/**
 * Effective only when identification is asked for, the model offers it, the speaker count (if
 * any) lies in the model's range and the audio is not longer than the model recommends.
 * A count out of range is never clamped: it makes the request unsatisfiable.
 */
export function decideDiarization(
  request: DiarizationRequest | undefined,
  support: AsrDiarizationSupport | undefined,
  audioMs: number | undefined,
): DiarizationDecision {
  if (request === undefined || request.mode === "off") {
    return { effective: false, status: "off" };
  }
  if (support === undefined) {
    return { effective: false, status: "unsupported", reason: "unsupported" };
  }
  if (request.speakerCount !== undefined && !speakerCountInRange(support, request.speakerCount)) {
    return { effective: false, status: "unsupported", reason: "speaker_count" };
  }
  if (support.recommendedMaxDurationSec !== undefined && audioMs !== undefined && audioMs > support.recommendedMaxDurationSec * 1000) {
    return { effective: false, status: "over_recommended", reason: "over_recommended" };
  }
  return request.speakerCount === undefined ? { effective: true } : { effective: true, speakerCount: request.speakerCount };
}
