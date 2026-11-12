import { readFileSync } from "node:fs";
import type { GlyphAdvances } from "../../domain/export/subtitle-breaks.ts";
import type { Logger } from "../../ports/logger.ts";
import type { SubtitleFontMetrics } from "../../ports/subtitle-font-metrics.ts";

/**
 * Advance widths of an OpenType font, from its `cmap` (format 12, or format 4 when it has
 * none) and `hmtx`, in em (`unitsPerEm` from `head`). `undefined` for a file that is not a
 * readable OpenType font: every offset is checked, so a damaged file never reads past its end.
 */
export function readGlyphAdvances(bytes: Buffer): GlyphAdvances | undefined {
  try {
    return parse(bytes);
  } catch {
    return undefined;
  }
}

function parse(bytes: Buffer): GlyphAdvances | undefined {
  const tables = new Map<string, { offset: number; length: number }>();
  const count = bytes.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const offset = bytes.readUInt32BE(record + 8);
    const length = bytes.readUInt32BE(record + 12);
    if (offset + length > bytes.length) return undefined;
    tables.set(bytes.toString("latin1", record, record + 4), { offset, length });
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const cmap = tables.get("cmap");
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) return undefined;
  const unitsPerEm = bytes.readUInt16BE(head.offset + 18);
  const metrics = bytes.readUInt16BE(hhea.offset + 34);
  if (unitsPerEm === 0 || metrics === 0 || metrics * 4 > hmtx.length) return undefined;
  // Glyphs past the last full metric share its advance.
  const advance = (glyph: number): number => bytes.readUInt16BE(hmtx.offset + 4 * Math.min(glyph, metrics - 1)) / unitsPerEm;
  const glyphOf = cmapOf(bytes, cmap.offset, cmap.offset + cmap.length);
  if (glyphOf === undefined) return undefined;
  return {
    advanceEm(codePoint) {
      const glyph = glyphOf(codePoint);
      return glyph === 0 ? undefined : advance(glyph);
    },
  };
}

/** The code point → glyph lookup of the font's Unicode `cmap` subtable; glyph 0 means missing. */
function cmapOf(bytes: Buffer, start: number, end: number): ((codePoint: number) => number) | undefined {
  const subtables = bytes.readUInt16BE(start + 2);
  let format12: number | undefined;
  let format4: number | undefined;
  for (let index = 0; index < subtables; index += 1) {
    const record = start + 4 + index * 8;
    const platform = bytes.readUInt16BE(record);
    const encoding = bytes.readUInt16BE(record + 2);
    const offset = start + bytes.readUInt32BE(record + 4);
    if (offset >= end) continue;
    const format = bytes.readUInt16BE(offset);
    if (format === 12 && (platform === 0 || (platform === 3 && encoding === 10))) format12 ??= offset;
    if (format === 4 && (platform === 0 || (platform === 3 && encoding === 1))) format4 ??= offset;
  }
  if (format12 !== undefined) {
    const groups = bytes.readUInt32BE(format12 + 12);
    if (format12 + 16 + groups * 12 > end) return undefined;
    return (codePoint) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const group = format12 + 16 + mid * 12;
        const first = bytes.readUInt32BE(group);
        const last = bytes.readUInt32BE(group + 4);
        if (codePoint < first) hi = mid - 1;
        else if (codePoint > last) lo = mid + 1;
        else return bytes.readUInt32BE(group + 8) + codePoint - first;
      }
      return 0;
    };
  }
  if (format4 !== undefined) {
    const segments = bytes.readUInt16BE(format4 + 6) / 2;
    const ends = format4 + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    if (rangeOffsets + segments * 2 > end) return undefined;
    return (codePoint) => {
      if (codePoint > 0xffff) return 0;
      for (let index = 0; index < segments; index += 1) {
        if (codePoint > bytes.readUInt16BE(ends + index * 2)) continue;
        const first = bytes.readUInt16BE(starts + index * 2);
        if (codePoint < first) return 0;
        const delta = bytes.readUInt16BE(deltas + index * 2);
        const rangeOffset = bytes.readUInt16BE(rangeOffsets + index * 2);
        if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
        const at = rangeOffsets + index * 2 + rangeOffset + (codePoint - first) * 2;
        if (at + 2 > end) return 0;
        const glyph = bytes.readUInt16BE(at);
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
      return 0;
    };
  }
  return undefined;
}

/**
 * The bundled subtitle font's advances, read on first use and kept: the font is large and
 * never changes while the app runs. A font that cannot be read is reported once and then
 * stays `undefined`.
 */
export class BundledFontMetrics implements SubtitleFontMetrics {
  private readonly path: string;
  private readonly logger: Logger | undefined;
  private loaded = false;
  private cached: GlyphAdvances | undefined;

  constructor(path: string, logger?: Logger) {
    this.path = path;
    this.logger = logger;
  }

  advances(): GlyphAdvances | undefined {
    if (!this.loaded) {
      this.loaded = true;
      let bytes: Buffer | undefined;
      try {
        bytes = readFileSync(this.path);
      } catch {
        bytes = undefined;
      }
      this.cached = bytes === undefined ? undefined : readGlyphAdvances(bytes);
      if (this.cached === undefined) {
        this.logger?.warn("subtitle font metrics unavailable; styled subtitles are not pre-broken", { reason: bytes === undefined ? "unreadable" : "malformed" });
      }
    }
    return this.cached;
  }
}
