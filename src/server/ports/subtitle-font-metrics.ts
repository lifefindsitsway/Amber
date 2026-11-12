import type { GlyphAdvances } from "../domain/export/subtitle-breaks.ts";

/**
 * Advance widths of the bundled subtitle font, which styled ASS output breaks its lines by.
 * `undefined` when the font cannot be read: lines are then left to the renderer to wrap.
 */
export interface SubtitleFontMetrics {
  advances(): GlyphAdvances | undefined;
}
