import { z } from "zod";
import { BURN_MODES } from "./enums.ts";

/**
 * The subtitle preferences the web client keeps in local storage, shared so a
 * backup can carry and check them with the same schemas the player reads them by.
 */

/** What the local player overlays: nothing, or one of the export modes. */
export const SUBTITLE_DISPLAY_MODES = ["off", ...BURN_MODES] as const;
export type SubtitleDisplayMode = (typeof SUBTITLE_DISPLAY_MODES)[number];

/**
 * The first format, which remembered one translation revision. It cannot tell "this language"
 * from "exactly this version", so it is read as following that revision's language. Still
 * accepted when read or restored from a backup; never written.
 */
export const trackPrefV1Schema = z
  .object({
    version: z.literal(1),
    mode: z.enum(SUBTITLE_DISPLAY_MODES),
    revisionId: z.string().min(1).exactOptional(),
    translationRevisionId: z.string().min(1).exactOptional(),
  })
  .strict();
export type SubtitleTrackPrefV1 = z.output<typeof trackPrefV1Schema>;

/**
 * The translation a Content's subtitles show: a language, which follows that language's
 * current translation (so a committed hand edit is shown at once), or one locked revision.
 */
export const translationPrefSchema = z
  .object({
    language: z.string().min(1),
    lockedRevisionId: z.string().min(1).exactOptional(),
  })
  .strict();
export type SubtitleTranslationPref = z.output<typeof translationPrefSchema>;

export const trackPrefV2Schema = z
  .object({
    version: z.literal(2),
    mode: z.enum(SUBTITLE_DISPLAY_MODES),
    revisionId: z.string().min(1).exactOptional(),
    translation: translationPrefSchema.exactOptional(),
  })
  .strict();
/** The display mode, original revision and translation picked for one Content; absent means "the defaults". Writes use only this format. */
export type SubtitleTrackPref = z.output<typeof trackPrefV2Schema>;

/** Every stored format: what reads and backups accept. */
export const trackPrefSchema = z.union([trackPrefV2Schema, trackPrefV1Schema]);
export type StoredSubtitleTrackPref = z.output<typeof trackPrefSchema>;

/**
 * A stored preference in the current format. A first-format translation only becomes its
 * language once the revisions are known; a revision no longer listed (or not a translation)
 * drops the translation choice, which then falls to the default pick.
 */
export function upgradeTrackPref(
  stored: StoredSubtitleTrackPref,
  revisions: ReadonlyArray<{ id: string; kind: string; language: string }>,
): SubtitleTrackPref {
  if (stored.version === 2) return stored;
  const translated = stored.translationRevisionId === undefined ? undefined : revisions.find((revision) => revision.id === stored.translationRevisionId && revision.kind === "translated");
  return {
    version: 2,
    mode: stored.mode,
    ...(stored.revisionId === undefined ? {} : { revisionId: stored.revisionId }),
    ...(translated === undefined ? {} : { translation: { language: translated.language } }),
  };
}

/**
 * Local UI preference keys. Every key carries the user id so two accounts in
 * one browser never inherit each other's subtitles.
 */
export const subtitlePrefKeys = {
  appearance: (userId: string) => `amber.subtitle.appearance.${userId}`,
  defaultPlacement: (userId: string) => `amber.subtitle.placement.${userId}`,
  placement: (userId: string, contentId: string) => `amber.subtitle.placement.${userId}.${contentId}`,
  track: (userId: string, contentId: string) => `amber.subtitle.track.${userId}.${contentId}`,
};
