import { describe, expect, it } from "vitest";
import {
  READER_FONT_NAME_MAX_CHARS,
  READER_FONT_SIZE_DEFAULT,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_LINE_HEIGHT_DEFAULT,
  READER_MARGIN_DEFAULT,
  READER_MARGIN_MAX,
  READER_MARGIN_MIN,
} from "../../src/shared/defaults.ts";
import {
  READER_FONTS,
  READER_LINE_HEIGHT_OPTIONS,
  READER_TYPOGRAPHY_DEFAULTS,
  readerCustomFontSchema,
  readerSideMargin,
  readerTypographyKey,
  readerTypographySchema,
} from "../../src/shared/reader-typography.ts";

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

describe("readerTypographySchema fonts", () => {
  it("accepts a value saved before fonts could be chosen, and every font with or without a custom name", () => {
    expect(readerTypographySchema.safeParse({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true }).success).toBe(true);
    for (const font of READER_FONTS) {
      expect(readerTypographySchema.safeParse({ ...READER_TYPOGRAPHY_DEFAULTS, font }).success).toBe(true);
      expect(readerTypographySchema.safeParse({ ...READER_TYPOGRAPHY_DEFAULTS, font, customFont: "霞鹜文楷" }).success).toBe(true);
    }
    expect(readerTypographySchema.safeParse({ ...READER_TYPOGRAPHY_DEFAULTS, customFont: "Kaiti SC" }).success).toBe(true);
  });

  it("rejects an unknown font, an explicit undefined and a custom name that could leave a CSS value", () => {
    const bad: unknown[] = [
      { ...READER_TYPOGRAPHY_DEFAULTS, font: "default" },
      { ...READER_TYPOGRAPHY_DEFAULTS, font: "comic" },
      { ...READER_TYPOGRAPHY_DEFAULTS, font: undefined },
      { ...READER_TYPOGRAPHY_DEFAULTS, font: 1 },
      { ...READER_TYPOGRAPHY_DEFAULTS, font: "custom", customFont: "a;b" },
      { ...READER_TYPOGRAPHY_DEFAULTS, customFont: "" },
      { ...READER_TYPOGRAPHY_DEFAULTS, customFont: null },
    ];
    for (const value of bad) expect(readerTypographySchema.safeParse(value).success).toBe(false);
  });
});

describe("readerTypographySchema side margin", () => {
  it("is optional, so values saved before it existed stay valid, and takes whole px within the bounds", () => {
    expect(readerTypographySchema.safeParse({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true }).success).toBe(true);
    for (const sideMargin of [READER_MARGIN_MIN, READER_MARGIN_DEFAULT, 57, READER_MARGIN_MAX]) {
      expect(readerTypographySchema.safeParse({ ...READER_TYPOGRAPHY_DEFAULTS, sideMargin }).success, String(sideMargin)).toBe(true);
    }
  });

  it("rejects a margin outside the bounds, fractional, not a number or explicitly undefined", () => {
    for (const sideMargin of [READER_MARGIN_MIN - 1, READER_MARGIN_MAX + 1, 56.5, "56", null, undefined]) {
      expect(readerTypographySchema.safeParse({ ...READER_TYPOGRAPHY_DEFAULTS, sideMargin }).success, String(sideMargin)).toBe(false);
    }
  });

  it("reads the stored margin, or the default when none is stored", () => {
    expect(readerSideMargin(READER_TYPOGRAPHY_DEFAULTS)).toBe(READER_MARGIN_DEFAULT);
    expect(readerSideMargin({ ...READER_TYPOGRAPHY_DEFAULTS, sideMargin: 120 })).toBe(120);
  });
});

describe("readerCustomFontSchema", () => {
  it("takes a plain family name up to READER_FONT_NAME_MAX_CHARS characters", () => {
    for (const name of ["Kaiti", "Source Han Serif SC", "霞鹜文楷 屏幕阅读版", "x".repeat(READER_FONT_NAME_MAX_CHARS)]) {
      expect(readerCustomFontSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it("refuses quotes, a backslash, a semicolon, braces, a comma, control characters, padding, empty and too long", () => {
    const bad = ['A"B', "A'B", "A\\B", "A;B", "A{B", "A}B", "A,B", "A\nB", "A\u0000B", "A\u007fB", " A", "A ", "", "   ", "x".repeat(READER_FONT_NAME_MAX_CHARS + 1)];
    for (const name of bad) expect(readerCustomFontSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
  });
});

describe("readerTypographyKey", () => {
  it("is per user", () => {
    expect(readerTypographyKey("u1")).toBe("amber.reader.typography.u1");
  });
});
