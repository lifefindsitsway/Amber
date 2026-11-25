import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";

// Read as plain text: the CSS pipeline would resolve the stylesheet instead of returning its source.
const STYLES = readFileSync(join(REPO_ROOT, "src/web/styles.css"), "utf8");

/**
 * Every `--color-*` declared in the blocks opened by `selector`, merged in source order. A value
 * is a hex colour or a reference to another theme colour, kept as `var(--color-<name>)`.
 */
function colorsOf(selector: string): Record<string, string> {
  const colors: Record<string, string> = {};
  let from = 0;
  for (;;) {
    const start = STYLES.indexOf(`${selector} {`, from);
    if (start === -1) break;
    // Line-start only, so `.dark` does not match inside another selector.
    if (start > 0 && STYLES[start - 1] !== "\n") {
      from = start + 1;
      continue;
    }
    const end = STYLES.indexOf("}", start);
    for (const match of STYLES.slice(start, end).matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6}|var\(--color-[a-z-]+\))\s*;/g)) {
      colors[match[1] as string] = (match[2] as string).toLowerCase();
    }
    from = end;
  }
  return colors;
}

/**
 * Replaces each `var(--color-<name>)` with that theme's own value. Every theme selector applies to
 * the document root, so a reference declared in a theme block resolves against the same theme.
 */
function resolved(colors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, value] of Object.entries(colors)) {
    const target = /^var\(--color-([a-z-]+)\)$/.exec(value)?.[1];
    out[role] = target === undefined ? value : (colors[target] ?? value);
  }
  return out;
}

const BASE = colorsOf("@theme");
/** The eye-care themes are light: they override the default palette, never the dark one. */
const THEMES: Record<string, Record<string, string>> = {
  light: resolved(BASE),
  dark: resolved({ ...BASE, ...colorsOf(".dark") }),
  "bean-green": resolved({ ...BASE, ...colorsOf('html[data-theme="bean-green"]') }),
  parchment: resolved({ ...BASE, ...colorsOf('html[data-theme="parchment"]') }),
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Foreground → the grounds it is read on; every pair must clear the WCAG AA text ratio. `link` is
 * not listed: links, inline text actions and clickable timestamps share the accent colour, the
 * amber look users know, which falls below 4.5:1 on the light grounds. A test below pins it to
 * the accent instead.
 */
const PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["warn", ["surface", "panel", "sunken", "warn-soft"]],
  // Field errors sit on every ground, the sunken one included.
  ["danger", ["surface", "panel", "sunken", "danger-soft"]],
  ["ok", ["ok-soft"]],
  ["ink", ["warn-soft", "danger-soft", "ok-soft"]],
  ["muted", ["surface", "panel", "sunken", "warn-soft", "danger-soft", "ok-soft"]],
  // The final destructive button draws its label in the surface colour on the danger fill.
  ["surface", ["danger"]],
];

const TEXT_MIN = 4.5;

describe("theme colour contrast", () => {
  it("declares the shared roles in every theme", () => {
    for (const [name, colors] of Object.entries(THEMES)) {
      for (const role of ["surface", "panel", "sunken", "ink", "muted", "link", "warn", "warn-soft", "danger", "danger-soft", "ok", "ok-soft"]) {
        expect(colors[role], `${name}: --color-${role}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    // Each non-default theme sets its own notice colours rather than inheriting the light ones.
    for (const selector of [".dark", 'html[data-theme="bean-green"]', 'html[data-theme="parchment"]']) {
      expect(Object.keys(colorsOf(selector))).toEqual(expect.arrayContaining(["link", "warn", "warn-soft", "danger-soft", "ok-soft"]));
    }
  });

  it.each(Object.keys(THEMES))("draws links in the accent colour in the %s theme", (name) => {
    const colors = THEMES[name] as Record<string, string>;
    expect(colors["accent"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors["link"]).toBe(colors["accent"]);
  });

  it.each(Object.keys(THEMES))("keeps text readable in the %s theme", (name) => {
    const colors = THEMES[name] as Record<string, string>;
    const failures: string[] = [];
    for (const [foreground, grounds] of PAIRS) {
      for (const ground of grounds) {
        const ratio = contrast(colors[foreground] as string, colors[ground] as string);
        if (ratio < TEXT_MIN) failures.push(`${foreground} on ${ground}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("declares the colour scheme of the light and dark themes", () => {
    expect(STYLES).toMatch(/:root\s*{\s*color-scheme:\s*light;/);
    expect(/\n\.dark\s*{[^}]*color-scheme:\s*dark;/.test(STYLES)).toBe(true);
  });

  it("computes the WCAG ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
