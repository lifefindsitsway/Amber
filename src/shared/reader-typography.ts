import { z } from "zod";
import { READER_FONT_SIZE_DEFAULT, READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN, READER_LINE_HEIGHT_DEFAULT, READER_LINE_HEIGHTS } from "./defaults.ts";

/**
 * The reading-view typography the web client keeps in local storage per user, shared so a
 * backup can carry and check it with the schema the reader parses it by.
 */

/** The line heights the reading view offers, in display order. */
export const READER_LINE_HEIGHT_OPTIONS: readonly number[] = READER_LINE_HEIGHTS.split(" ").map(Number);

export const readerTypographySchema = z
  .object({
    version: z.literal(1),
    fontSize: z.number().int().min(READER_FONT_SIZE_MIN).max(READER_FONT_SIZE_MAX),
    lineHeight: z.number().refine((value) => READER_LINE_HEIGHT_OPTIONS.includes(value)),
    showSpeakers: z.boolean(),
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
