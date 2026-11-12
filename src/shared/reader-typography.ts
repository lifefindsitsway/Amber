import { z } from "zod";
import {
  READER_FONT_NAME_MAX_CHARS,
  READER_FONT_SIZE_DEFAULT,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_LINE_HEIGHT_DEFAULT,
  READER_LINE_HEIGHTS,
} from "./defaults.ts";

/**
 * The reading-view typography the web client keeps in local storage per user, shared so a
 * backup can carry and check it with the schema the reader parses it by.
 */

/** The line heights the reading view offers, in display order. */
export const READER_LINE_HEIGHT_OPTIONS: readonly number[] = READER_LINE_HEIGHTS.split(" ").map(Number);

/**
 * The fonts the reading view can be set to besides its default: three faces Amber ships
 * (`sans`, `serif`, `kai`) and `custom`, a font of this machine the user names. No `font`
 * at all is the default, the system font stack the reading view always had.
 */
export const READER_FONTS = ["sans", "serif", "kai", "custom"] as const;
export type ReaderFont = (typeof READER_FONTS)[number];

/** The shipped faces the reading-font route serves; `sans` is the subtitle font and comes from its route. */
export const READER_FONT_FACES = ["serif", "kai"] as const;
export type ReaderFontFace = (typeof READER_FONT_FACES)[number];

/**
 * A font family typed by the user. It ends up in a CSS value, so it may not hold what could
 * end or extend one: quotes, a backslash, `;`, braces, a comma, or control characters.
 */
export const readerCustomFontSchema = z
  .string()
  .min(1)
  .max(READER_FONT_NAME_MAX_CHARS)
  .regex(/^[^"'\\;{},\p{Cc}]+$/u)
  .refine((value) => value.trim() === value && value !== "");

export const readerTypographySchema = z
  .object({
    version: z.literal(1),
    fontSize: z.number().int().min(READER_FONT_SIZE_MIN).max(READER_FONT_SIZE_MAX),
    lineHeight: z.number().refine((value) => READER_LINE_HEIGHT_OPTIONS.includes(value)),
    showSpeakers: z.boolean(),
    // Added after the first release and optional, so preferences and backups saved without them stay valid.
    font: z.enum(READER_FONTS).exactOptional(),
    /** Kept while another font is selected, so switching back to `custom` restores it. */
    customFont: readerCustomFontSchema.exactOptional(),
  })
  .strict();
export type ReaderTypography = z.output<typeof readerTypographySchema>;

export const READER_TYPOGRAPHY_DEFAULTS: Readonly<ReaderTypography> = Object.freeze({
  version: 1,
  fontSize: READER_FONT_SIZE_DEFAULT,
  lineHeight: READER_LINE_HEIGHT_DEFAULT,
  showSpeakers: true,
});

export function readerTypographyKey(userId: string): string {
  return `amber.reader.typography.${userId}`;
}
