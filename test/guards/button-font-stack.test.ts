import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";

// Read as plain text: the CSS pipeline would resolve the stylesheet instead of returning its source.
const styles = readFileSync(join(REPO_ROOT, "src/web/styles.css"), "utf8");

describe("button font stack in the stylesheet", () => {
  it("draws curly quotes in buttons with the Latin UI font, not the CJK one", () => {
    const face = /@font-face\s*{[^}]*}/.exec(styles)?.[0] ?? "";
    expect(face).toContain('font-family: "Amber Latin Quotes"');
    expect(face).toContain('local("Segoe UI")');
    // Exactly the four curly quotes: any wider range would also move CJK punctuation or letters.
    expect(face).toMatch(/unicode-range:\s*U\+2018-2019,\s*U\+201C-201D;/);
  });

  it("puts the quote alias first in the button font stack, ahead of the CJK fonts", () => {
    const rule = /button\s*{\s*font-family:\s*([^;]+);/.exec(styles)?.[1] ?? "";
    expect(rule.split(",")[0]?.trim()).toBe('"Amber Latin Quotes"');
    expect(rule.indexOf("Amber Latin Quotes")).toBeLessThan(rule.indexOf("Microsoft YaHei"));
  });
});
