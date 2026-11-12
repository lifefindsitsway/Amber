import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BundledFontMetrics, readGlyphAdvances } from "../../../../src/server/adapters/fonts/otf-advances.ts";
import type { Logger } from "../../../../src/server/ports/logger.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

/** A minimal OpenType font: `head`, `hhea`, `hmtx` (three glyphs: 500, 1000 and 250 units) and the given `cmap` subtable. */
function font(cmapSubtable: Buffer, encoding: { platform: number; encoding: number }): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt16BE(1000, 18);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt16BE(3, 34);
  const hmtx = Buffer.alloc(12);
  [500, 1000, 250].forEach((advance, glyph) => hmtx.writeUInt16BE(advance, glyph * 4));
  const cmapHeader = Buffer.alloc(12);
  cmapHeader.writeUInt16BE(1, 2);
  cmapHeader.writeUInt16BE(encoding.platform, 4);
  cmapHeader.writeUInt16BE(encoding.encoding, 6);
  cmapHeader.writeUInt32BE(12, 8);
  const tables: Array<[string, Buffer]> = [
    ["cmap", Buffer.concat([cmapHeader, cmapSubtable])],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
  ];
  const directory = Buffer.alloc(12 + tables.length * 16);
  directory.writeUInt32BE(0x4f54544f, 0);
  directory.writeUInt16BE(tables.length, 4);
  let offset = directory.length;
  tables.forEach(([tag, data], index) => {
    const record = 12 + index * 16;
    directory.write(tag, record, "latin1");
    directory.writeUInt32BE(offset, record + 8);
    directory.writeUInt32BE(data.length, record + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...tables.map(([, data]) => data)]);
}

/** Format 12: `A` → glyph 2, `一` → glyph 1, `丁` → glyph 2. */
function format12(): Buffer {
  const groups: Array<[number, number, number]> = [
    [0x41, 0x41, 2],
    [0x4e00, 0x4e01, 1],
  ];
  const table = Buffer.alloc(16 + groups.length * 12);
  table.writeUInt16BE(12, 0);
  table.writeUInt32BE(table.length, 4);
  table.writeUInt32BE(groups.length, 12);
  groups.forEach(([first, last, glyph], index) => {
    table.writeUInt32BE(first, 16 + index * 12);
    table.writeUInt32BE(last, 20 + index * 12);
    table.writeUInt32BE(glyph, 24 + index * 12);
  });
  return table;
}

/** Format 4: `A` → glyph 1, `B` → glyph 2 by delta; the closing segment maps 0xFFFF. */
function format4(): Buffer {
  const segments = 2;
  const table = Buffer.alloc(16 + segments * 8);
  table.writeUInt16BE(4, 0);
  table.writeUInt16BE(table.length, 2);
  table.writeUInt16BE(segments * 2, 6);
  const ends = 14;
  table.writeUInt16BE(0x42, ends);
  table.writeUInt16BE(0xffff, ends + 2);
  const starts = ends + segments * 2 + 2;
  table.writeUInt16BE(0x41, starts);
  table.writeUInt16BE(0xffff, starts + 2);
  const deltas = starts + segments * 2;
  table.writeUInt16BE((1 - 0x41) & 0xffff, deltas);
  table.writeUInt16BE(1, deltas + 2);
  return table;
}

describe("readGlyphAdvances", () => {
  it("reads advances in em through a format 12 cmap", () => {
    const glyphs = readGlyphAdvances(font(format12(), { platform: 3, encoding: 10 }));
    expect(glyphs?.advanceEm(0x4e00)).toBe(1);
    expect(glyphs?.advanceEm(0x4e01)).toBe(0.25);
    expect(glyphs?.advanceEm(0x41)).toBe(0.25);
    expect(glyphs?.advanceEm(0x42)).toBeUndefined();
    expect(glyphs?.advanceEm(0x1f600)).toBeUndefined();
  });

  it("falls back to a format 4 cmap", () => {
    const glyphs = readGlyphAdvances(font(format4(), { platform: 3, encoding: 1 }));
    expect(glyphs?.advanceEm(0x41)).toBe(1);
    expect(glyphs?.advanceEm(0x42)).toBe(0.25);
    expect(glyphs?.advanceEm(0x43)).toBeUndefined();
    expect(glyphs?.advanceEm(0x10000)).toBeUndefined();
  });

  it("is undefined for a truncated or foreign file instead of reading past its end", () => {
    const whole = font(format12(), { platform: 3, encoding: 10 });
    expect(readGlyphAdvances(whole.subarray(0, whole.length - 20))).toBeUndefined();
    expect(readGlyphAdvances(Buffer.from("not a font at all"))).toBeUndefined();
    expect(readGlyphAdvances(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("BundledFontMetrics", () => {
  const recorder = (): Logger & { warnings: string[] } => {
    const warnings: string[] = [];
    const logger = { warnings, info: () => undefined, warn: (message: string) => warnings.push(message), error: () => undefined, debug: () => undefined, child: () => logger };
    return logger as unknown as Logger & { warnings: string[] };
  };

  it("reads the font once and keeps it", () => {
    const path = join(tempDataDir("amber-font-"), "font.otf");
    writeFileSync(path, font(format12(), { platform: 3, encoding: 10 }));
    const metrics = new BundledFontMetrics(path);
    const first = metrics.advances();
    expect(first?.advanceEm(0x4e00)).toBe(1);
    writeFileSync(path, "changed");
    expect(metrics.advances()).toBe(first);
  });

  it("is undefined without the font, and says so once", () => {
    const logger = recorder();
    const metrics = new BundledFontMetrics(join(tempDataDir("amber-font-"), "missing.otf"), logger);
    expect(metrics.advances()).toBeUndefined();
    expect(metrics.advances()).toBeUndefined();
    expect(logger.warnings).toHaveLength(1);
  });
});
