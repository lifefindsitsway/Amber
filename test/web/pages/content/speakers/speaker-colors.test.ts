import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEAKER_PALETTE_SIZE } from "../../../../../src/shared/defaults.ts";
import { paletteSlot, speakerColorStyle, speakerColorVars } from "../../../../../src/web/pages/content/speakers/speaker-colors.ts";

const CSS = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");

/** Every declaration of the blocks that open with this exact selector, later blocks winning. */
function declarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const block of CSS.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))) {
    for (const line of (block[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found[line[1] as string] = (line[2] as string).trim();
  }
  return found;
}

const THEMES: Record<string, Record<string, string>> = {
  light: { ...declarations("@theme"), ...declarations(":root") },
  dark: declarations(".dark"),
  "bean-green": declarations('html[data-theme="bean-green"]'),
  parchment: declarations('html[data-theme="parchment"]'),
};

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** A theme's colour: its own declaration, else the light theme's (the eye-care themes inherit only what they do not set). */
const colorOf = (theme: string, name: string): string => {
  const value = THEMES[theme]?.[name] ?? THEMES["light"]?.[name];
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${theme}: ${name} is not a hex colour (${String(value)})`);
  return value;
};

const SLOTS = Array.from({ length: SPEAKER_PALETTE_SIZE }, (_, slot) => slot);

describe("speaker palette tokens", () => {
  for (const theme of Object.keys(THEMES)) {
    describe(theme, () => {
      it("defines a text colour and a fill for every slot", () => {
        for (const slot of SLOTS) {
          expect(THEMES[theme]?.[`--speaker-${slot}-fg`], `${theme} --speaker-${slot}-fg`).toMatch(/^#[0-9a-f]{6}$/i);
          expect(THEMES[theme]?.[`--speaker-${slot}-bg`], `${theme} --speaker-${slot}-bg`).toMatch(/^#[0-9a-f]{6}$/i);
        }
      });

      it("keeps every text colour at 4.5:1 on the surface", () => {
        const surface = colorOf(theme, "--color-surface");
        for (const slot of SLOTS) expect(contrast(colorOf(theme, `--speaker-${slot}-fg`), surface), `slot ${slot}`).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps every text colour readable on the panel and sunken grounds too", () => {
        for (const ground of ["--color-panel", "--color-sunken"]) {
          for (const slot of SLOTS) expect(contrast(colorOf(theme, `--speaker-${slot}-fg`), colorOf(theme, ground)), `slot ${slot} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("draws the monogram (the text colour) on its fill at 4.5:1", () => {
        for (const slot of SLOTS) expect(contrast(colorOf(theme, `--speaker-${slot}-fg`), colorOf(theme, `--speaker-${slot}-bg`)), `slot ${slot}`).toBeGreaterThanOrEqual(4.5);
      });

      it("tells neighbouring slots apart by lightness as well as hue", () => {
        for (const slot of SLOTS) {
          const next = (slot + 1) % SPEAKER_PALETTE_SIZE;
          expect(contrast(colorOf(theme, `--speaker-${slot}-fg`), colorOf(theme, `--speaker-${next}-fg`)), `slots ${slot} and ${next}`).toBeGreaterThanOrEqual(1.08);
        }
      });

      it("never repeats a colour inside the palette", () => {
        const fg = SLOTS.map((slot) => colorOf(theme, `--speaker-${slot}-fg`).toLowerCase());
        expect(new Set(fg).size).toBe(SPEAKER_PALETTE_SIZE);
      });
    });
  }
});

describe("speakerColorVars", () => {
  it("names the theme tokens of a slot", () => {
    expect(speakerColorVars(0)).toEqual({ fg: "var(--speaker-0-fg)", bg: "var(--speaker-0-bg)" });
    expect(speakerColorVars(SPEAKER_PALETTE_SIZE - 1).fg).toBe(`var(--speaker-${SPEAKER_PALETTE_SIZE - 1}-fg)`);
  });

  it("wraps an index outside the palette instead of naming a token that does not exist", () => {
    expect(paletteSlot(SPEAKER_PALETTE_SIZE)).toBe(0);
    expect(paletteSlot(-1)).toBe(SPEAKER_PALETTE_SIZE - 1);
    expect(paletteSlot(Number.NaN)).toBe(0);
    expect(speakerColorVars(SPEAKER_PALETTE_SIZE + 2).bg).toBe("var(--speaker-2-bg)");
  });

  it("sets the pair as custom properties for descendants", () => {
    expect(speakerColorStyle(3)).toEqual({ "--speaker-fg": "var(--speaker-3-fg)", "--speaker-bg": "var(--speaker-3-bg)" });
  });
});
