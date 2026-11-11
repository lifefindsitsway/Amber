import { SPEAKER_NAME_MAX_GRAPHEMES, SPEAKER_PALETTE_SIZE } from "./defaults.ts";

/** How a Task asks for speaker identification: from the setting, explicitly, or not at all. */
export const DIARIZATION_MODES = ["preferred", "required", "off"] as const;
export type DiarizationMode = (typeof DIARIZATION_MODES)[number];

/**
 * What an `asr` revision records about speaker identification: identified, requested but the
 * result named nobody, not requested, not offered by the model, or skipped because the audio
 * is longer than the provider recommends.
 */
export const DIARIZATION_STATUSES = ["applied", "no_speakers", "off", "unsupported", "over_recommended"] as const;
export type DiarizationStatus = (typeof DIARIZATION_STATUSES)[number];

/** Why identification that was required cannot be done: the model, the audio length, or the speaker count. */
export const DIARIZATION_UNAVAILABLE_REASONS = ["unsupported", "over_recommended", "speaker_count"] as const;
export type DiarizationUnavailableReason = (typeof DIARIZATION_UNAVAILABLE_REASONS)[number];

/** How a draft sentence got its speaker when speakers were applied: matched, or left for the user to confirm. */
export const SPEAKER_REVIEW_STATES = ["auto", "needs_review"] as const;
export type SpeakerReviewState = (typeof SPEAKER_REVIEW_STATES)[number];

/** What a commit does with sentences still waiting for confirmation: keep the suggestions, or unassign them. */
export const SPEAKER_REVIEW_RESOLUTIONS = ["accept_suggestions", "unassign"] as const;
export type SpeakerReviewResolution = (typeof SPEAKER_REVIEW_RESOLUTIONS)[number];

/** Which subtitle cues or text paragraphs carry the speaker's name: the first of each turn, or every one. */
export const SPEAKER_LABEL_MODES = ["turn", "every"] as const;
export type SpeakerLabelMode = (typeof SPEAKER_LABEL_MODES)[number];

// C0 and C1 controls, and the bidirectional embeddings, overrides, isolates and marks: a
// name with them could reorder the text around it wherever it is shown or exported.
const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The grapheme clusters of a text, as a reader counts characters. */
export function graphemesOf(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

/**
 * A speaker name as stored: controls and bidirectional formatting removed, runs of white
 * space collapsed, trimmed. `undefined` when nothing is left (an unnamed speaker) and
 * `"too_long"` past `SPEAKER_NAME_MAX_GRAPHEMES` clusters; a name is never cut silently.
 */
export function normalizeSpeakerName(raw: string): string | undefined | "too_long" {
  const cleaned = raw.replace(CONTROLS, " ").replace(/\s+/gu, " ").trim();
  if (cleaned === "") return undefined;
  return graphemesOf(cleaned).length > SPEAKER_NAME_MAX_GRAPHEMES ? "too_long" : cleaned;
}

/** The letter avatar of a named speaker: its first grapheme cluster, upper-cased when it has case. */
export function speakerMonogram(name: string): string {
  const first = graphemesOf(name.trim())[0] ?? "";
  return first.toLocaleUpperCase();
}

/** The color a new speaker starts with: speakers take the palette in turn by their ordinal (from 1). */
export function defaultSpeakerColorIndex(ordinal: number): number {
  return (((ordinal - 1) % SPEAKER_PALETTE_SIZE) + SPEAKER_PALETTE_SIZE) % SPEAKER_PALETTE_SIZE;
}
