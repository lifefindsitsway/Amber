import type { CSSProperties } from "react";
import { SPEAKER_PALETTE_SIZE } from "../../../../shared/defaults.ts";

/** The CSS custom properties of one palette slot: `fg` for text and lines, `bg` for fills and soft tints. */
export interface SpeakerColorVars {
  fg: string;
  bg: string;
}

/** Keeps a stored index inside the palette, so a value from an older or newer build still renders. */
export function paletteSlot(colorIndex: number): number {
  const size = SPEAKER_PALETTE_SIZE;
  const whole = Number.isFinite(colorIndex) ? Math.trunc(colorIndex) : 0;
  return ((whole % size) + size) % size;
}

/**
 * `var(...)` references to the theme tokens of a palette slot (defined per theme in the style
 * sheet), for inline styles. A monogram is drawn in `fg` on `bg`, which the tokens keep at 4.5:1.
 */
export function speakerColorVars(colorIndex: number): SpeakerColorVars {
  const slot = paletteSlot(colorIndex);
  return { fg: `var(--speaker-${slot}-fg)`, bg: `var(--speaker-${slot}-bg)` };
}

/** Sets the slot's colours as `--speaker-fg` / `--speaker-bg` on an element, so its descendants can use them in classes. */
export function speakerColorStyle(colorIndex: number): CSSProperties {
  const { fg, bg } = speakerColorVars(colorIndex);
  return { "--speaker-fg": fg, "--speaker-bg": bg } as CSSProperties;
}
