import { describe, expect, it } from "vitest";
import { READER_FONT_SIZE_DEFAULT, READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN, READER_LINE_HEIGHT_DEFAULT } from "../../src/shared/defaults.ts";
import { READER_LINE_HEIGHT_OPTIONS, READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey, readerTypographySchema } from "../../src/shared/reader-typography.ts";

describe("readerTypographySchema", () => {
  it("accepts the defaults, the font size bounds and every offered line height", () => {
    expect(readerTypographySchema.safeParse(READER_TYPOGRAPHY_DEFAULTS).success).toBe(true);
    expect(READER_TYPOGRAPHY_DEFAULTS).toEqual({ version: 1, fontSize: READER_FONT_SIZE_DEFAULT, lineHeight: READER_LINE_HEIGHT_DEFAULT, showSpeakers: true });
    for (const fontSize of [READER_FONT_SIZE_MIN, READER_FONT_SIZE_MAX]) {
      expect(readerTypographySchema.safeParse({ ...READER_TYPOGRAPHY_DEFAULTS, fontSize }).success).toBe(true);
    }
    for (const lineHeight of READER_LINE_HEIGHT_OPTIONS) {
      expect(readerTypographySchema.safeParse({ ...READER_TYPOGRAPHY_DEFAULTS, lineHeight }).success).toBe(true);
    }
  });

  it("rejects out-of-range, fractional, unknown and extra values", () => {
    const bad: unknown[] = [
      { ...READER_TYPOGRAPHY_DEFAULTS, fontSize: READER_FONT_SIZE_MIN - 1 },
      { ...READER_TYPOGRAPHY_DEFAULTS, fontSize: READER_FONT_SIZE_MAX + 1 },
      { ...READER_TYPOGRAPHY_DEFAULTS, fontSize: 16.5 },
      { ...READER_TYPOGRAPHY_DEFAULTS, lineHeight: 1.55 },
      { ...READER_TYPOGRAPHY_DEFAULTS, showSpeakers: "yes" },
      { ...READER_TYPOGRAPHY_DEFAULTS, version: 2 },
      { ...READER_TYPOGRAPHY_DEFAULTS, extra: 1 },
      { version: 1, fontSize: 16, lineHeight: 1.7 },
    ];
    for (const value of bad) expect(readerTypographySchema.safeParse(value).success).toBe(false);
  });
});

describe("readerTypographyKey", () => {
  it("is per user", () => {
    expect(readerTypographyKey("u1")).toBe("amber.reader.typography.u1");
  });
});
