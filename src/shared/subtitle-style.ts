import { z } from "zod";
import {
  SUBTITLE_BACKGROUND_COLOR,
  SUBTITLE_BACKGROUND_OPACITY_PCT,
  SUBTITLE_BACKGROUND_PADDING,
  SUBTITLE_BACKGROUND_PADDING_MAX,
  SUBTITLE_FONT_SIZE_MAX,
  SUBTITLE_FONT_SIZE_MIN,
  SUBTITLE_ORIGINAL_COLOR,
  SUBTITLE_ORIGINAL_FONT_SIZE,
  SUBTITLE_OUTLINE_COLOR,
  SUBTITLE_OUTLINE_WIDTH,
  SUBTITLE_OUTLINE_WIDTH_MAX,
  SUBTITLE_PLACEMENT_X_BP,
  SUBTITLE_PLACEMENT_Y_BP,
  SUBTITLE_TRANSLATION_COLOR,
  SUBTITLE_TRANSLATION_FONT_SIZE,
} from "./defaults.ts";
import { SUBTITLE_ANCHORS, SUBTITLE_BACKGROUND_SCOPES, SUBTITLE_BILINGUAL_ORDERS, type BurnMode } from "./enums.ts";

/** Basis points of the picture width or height: 0 is the left / top edge, 10000 the right / bottom one. */
export const BASIS_POINTS = 10000;

/** `#RRGGBB`, stored upper-case so equal colours always serialize (and digest) the same. */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/u)
  .transform((value) => value.toUpperCase());

const fontSizeSchema = z.number().int().min(SUBTITLE_FONT_SIZE_MIN).max(SUBTITLE_FONT_SIZE_MAX);
const basisPointSchema = z.number().int().min(0).max(BASIS_POINTS);

/**
 * When a subtitle shows who is speaking: `change` on the first subtitle of a turn (and again
 * after the same person has kept talking for a while), `every` on each subtitle.
 */
export const SUBTITLE_SPEAKER_MODES = ["change", "every"] as const;
export type SubtitleSpeakerMode = (typeof SUBTITLE_SPEAKER_MODES)[number];
const lineAppearanceSchema = z.object({ fontSize: fontSizeSchema, color: hexColorSchema }).strict();

/**
 * How subtitles look. Lengths are 1080p picture pixels — the unit of ASS at
 * `PlayResY: 1080` — so one value drives the player overlay and the exported ASS alike.
 */
export const subtitleAppearanceSchema = z
  .object({
    version: z.literal(1),
    original: lineAppearanceSchema,
    translation: lineAppearanceSchema,
    outline: z
      .object({ enabled: z.boolean(), color: hexColorSchema, width: z.number().int().min(0).max(SUBTITLE_OUTLINE_WIDTH_MAX) })
      .strict(),
    background: z
      .object({
        enabled: z.boolean(),
        color: hexColorSchema,
        opacityPct: z.number().int().min(0).max(100),
        padding: z.number().int().min(0).max(SUBTITLE_BACKGROUND_PADDING_MAX),
        // Added after the first release: preferences and queued requests saved without it read as `both`.
        scope: z.enum(SUBTITLE_BACKGROUND_SCOPES).default("both"),
      })
      .strict(),
    bilingualOrder: z.enum(SUBTITLE_BILINGUAL_ORDERS),
    // Absent = no speaker labels. Deliberately optional rather than defaulted: a default would be
    // written back into saved preferences and frozen burn requests and change their digests.
    speaker: z.enum(SUBTITLE_SPEAKER_MODES).exactOptional(),
  })
  .strict();
export type SubtitleAppearance = z.output<typeof subtitleAppearanceSchema>;

/**
 * Where subtitles sit: `x` is the block's horizontal centre and `y` the edge
 * named by `anchor` — top edge, centre or bottom edge — relative to the picture, not the
 * player box. The anchor is stored rather than derived from `y`, so one `y` never means two
 * geometries.
 */
export const subtitlePlacementSchema = z
  .object({ version: z.literal(1), xBp: basisPointSchema, yBp: basisPointSchema, anchor: z.enum(SUBTITLE_ANCHORS) })
  .strict();
export type SubtitlePlacement = z.output<typeof subtitlePlacementSchema>;

/** The full snapshot a subtitled export freezes. */
export const subtitleStyleSchema = z.object({ appearance: subtitleAppearanceSchema, placement: subtitlePlacementSchema }).strict();
export type SubtitleStyle = z.output<typeof subtitleStyleSchema>;

/** The system default appearance: outline on, background box off, original line first. */
export function defaultSubtitleAppearance(): SubtitleAppearance {
  return {
    version: 1,
    original: { fontSize: SUBTITLE_ORIGINAL_FONT_SIZE, color: SUBTITLE_ORIGINAL_COLOR },
    translation: { fontSize: SUBTITLE_TRANSLATION_FONT_SIZE, color: SUBTITLE_TRANSLATION_COLOR },
    outline: { enabled: true, color: SUBTITLE_OUTLINE_COLOR, width: SUBTITLE_OUTLINE_WIDTH },
    background: {
      enabled: false,
      color: SUBTITLE_BACKGROUND_COLOR,
      opacityPct: SUBTITLE_BACKGROUND_OPACITY_PCT,
      padding: SUBTITLE_BACKGROUND_PADDING,
      scope: "both",
    },
    bilingualOrder: "original_first",
  };
}

/** The system default placement: bottom centre, anchored at the block's bottom edge. */
export function defaultSubtitlePlacement(): SubtitlePlacement {
  return { version: 1, xBp: SUBTITLE_PLACEMENT_X_BP, yBp: SUBTITLE_PLACEMENT_Y_BP, anchor: "bottom" };
}

/**
 * Which background box a display mode draws: none when the box is off; one
 * block around everything shown when the mode is single-language or the scope is `both`;
 * otherwise the one bilingual line the scope names. The player overlay and the styled ASS
 * both decide through here.
 */
export function boxedLines(appearance: SubtitleAppearance, mode: BurnMode): "none" | "block" | "original" | "translation" {
  if (!appearance.background.enabled) return "none";
  if (mode !== "bilingual" || appearance.background.scope === "both") return "block";
  return appearance.background.scope;
}

/**
 * Box padding of a one-line box: `BorderStyle 3` draws no box at `Outline 0`, so it is at
 * least 1 on both sides to keep the overlay and the export alike.
 */
export function lineBoxPadding(appearance: SubtitleAppearance): number {
  return Math.max(appearance.background.padding, 1);
}
