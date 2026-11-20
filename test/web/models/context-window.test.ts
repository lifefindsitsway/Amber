import { describe, expect, it } from "vitest";
import { CONTEXT_WINDOW_SUGGESTIONS, parseTokenCount } from "../../../src/web/models/context-window.ts";

describe("parseTokenCount", () => {
  it("reads digits, thousands separators and K / M suffixes", () => {
    expect(parseTokenCount("128000")).toBe(128_000);
    expect(parseTokenCount(" 128,000 ")).toBe(128_000);
    expect(parseTokenCount("128 000")).toBe(128_000);
    expect(parseTokenCount("128K")).toBe(128_000);
    expect(parseTokenCount("128k")).toBe(128_000);
    expect(parseTokenCount("1M")).toBe(1_000_000);
    expect(parseTokenCount("1.5m")).toBe(1_500_000);
  });

  it("refuses anything but a positive, exactly representable integer", () => {
    for (const text of ["", "0", "-1", "12.5", "abc", "1e6", "0k", "1.0001k", "99999999999999999999"]) {
      expect(parseTokenCount(text)).toBeUndefined();
    }
  });
});

describe("CONTEXT_WINDOW_SUGGESTIONS", () => {
  it("offers the common sizes in decimal tokens, ascending", () => {
    expect(CONTEXT_WINDOW_SUGGESTIONS.map((item) => item.label)).toEqual(["32K", "64K", "128K", "200K", "256K", "1M"]);
    expect(CONTEXT_WINDOW_SUGGESTIONS.map((item) => item.tokens)).toEqual([32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000]);
    for (const item of CONTEXT_WINDOW_SUGGESTIONS) expect(parseTokenCount(item.label)).toBe(item.tokens);
  });
});
