import { describe, expect, it } from "vitest";
import {
  capDescription,
  classifyPlatformDescription,
  DescriptionClock,
  normalizeDescription,
} from "../../../src/server/domain/content-description.ts";
import { CONTENT_DESCRIPTION_MAX_CHARS } from "../../../src/shared/defaults.ts";

describe("normalizeDescription", () => {
  it("turns every line break into \\n", () => {
    expect(normalizeDescription("a\r\nb\rc\u2028d\u2029e\u0085f\ng")).toBe("a\nb\nc\nd\ne\nf\ng");
  });

  it("strips trailing white space of each line but keeps leading indentation", () => {
    expect(normalizeDescription("a  \t\n  b\u3000\n\tc ")).toBe("a\n  b\n\tc");
  });

  it("drops leading and trailing blank lines", () => {
    expect(normalizeDescription("\n  \n\t\nbody\n \n\n")).toBe("body");
  });

  it("keeps at most two blank lines in a row", () => {
    expect(normalizeDescription("a\n\nb\n\n\nc\n\n\n\n\n\nd\n \n\t\n  \n \ne")).toBe("a\n\nb\n\n\nc\n\n\nd\n\n\ne");
  });

  it("removes control characters except \\n and \\t", () => {
    expect(normalizeDescription("a\u0000b\u0007c\u000Bd\u000Ce\u001Bf\u007Fg\u009Fh\ti")).toBe("abcdefgh\ti");
  });

  it("removes bidi embeddings, overrides and isolates but keeps direction marks", () => {
    const formatting = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
    expect(normalizeDescription(`a${formatting}b`)).toBe("ab");
    expect(normalizeDescription("a\u200Eb\u200Fc\u061Cd")).toBe("a\u200Eb\u200Fc\u061Cd");
  });

  it("is empty for white space and controls alone", () => {
    expect(normalizeDescription(" \n\t\r\n\u0000\u202E ")).toBe("");
  });
});

describe("capDescription", () => {
  it("keeps exactly the limit unchanged", () => {
    const text = "字".repeat(CONTENT_DESCRIPTION_MAX_CHARS);
    expect(capDescription(text)).toEqual({ text, truncated: false });
  });

  it("counts code points, not UTF-16 units", () => {
    // 10000 astral characters are 20000 UTF-16 units and still within the limit.
    const text = "😀".repeat(CONTENT_DESCRIPTION_MAX_CHARS);
    expect(capDescription(text)).toEqual({ text, truncated: false });
  });

  it("cuts one code point over the limit", () => {
    const text = "a".repeat(CONTENT_DESCRIPTION_MAX_CHARS + 1);
    expect(capDescription(text)).toEqual({ text: "a".repeat(CONTENT_DESCRIPTION_MAX_CHARS), truncated: true });
  });

  it("never splits a combining sequence that straddles the limit", () => {
    const head = "a".repeat(CONTENT_DESCRIPTION_MAX_CHARS - 1);
    // "e" + COMBINING ACUTE ACCENT occupy code points 10000 and 10001.
    expect(capDescription(`${head}e\u0301`)).toEqual({ text: head, truncated: true });
  });

  it("never splits an emoji with a modifier or a ZWJ sequence", () => {
    const head = "a".repeat(CONTENT_DESCRIPTION_MAX_CHARS - 1);
    // Thumbs up + skin tone: two code points.
    expect(capDescription(`${head}👍🏽`)).toEqual({ text: head, truncated: true });
    // Family (man ZWJ woman ZWJ girl): five code points.
    const family = "👨\u200D👩\u200D👧";
    const shorter = "a".repeat(CONTENT_DESCRIPTION_MAX_CHARS - 3);
    expect(capDescription(`${shorter}${family}`)).toEqual({ text: shorter, truncated: true });
  });

  it("keeps a whole grapheme that ends exactly at the limit and appends nothing", () => {
    const head = "a".repeat(CONTENT_DESCRIPTION_MAX_CHARS - 2);
    expect(capDescription(`${head}e\u0301b`)).toEqual({ text: `${head}e\u0301`, truncated: true });
  });

  it("takes a custom limit", () => {
    expect(capDescription("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(capDescription("abc", 3)).toEqual({ text: "abc", truncated: false });
  });
});

describe("classifyPlatformDescription", () => {
  it("is found for text that survives normalization, with the normalized text", () => {
    expect(classifyPlatformDescription("  hello  \r\nworld\n\n")).toEqual({ state: "found", text: "  hello\nworld" });
  });

  it("is empty for an empty or white-space-only string", () => {
    expect(classifyPlatformDescription("")).toEqual({ state: "empty" });
    expect(classifyPlatformDescription(" \n\t\u3000 ")).toEqual({ state: "empty" });
  });

  it("treats a placeholder as empty only when the platform names it", () => {
    expect(classifyPlatformDescription("-", ["-"])).toEqual({ state: "empty" });
    expect(classifyPlatformDescription(" -\n", ["-"])).toEqual({ state: "empty" });
    expect(classifyPlatformDescription("-")).toEqual({ state: "found", text: "-" });
    expect(classifyPlatformDescription("- item", ["-"])).toEqual({ state: "found", text: "- item" });
  });

  it("is unknown for anything that is not a string", () => {
    expect(classifyPlatformDescription(null)).toEqual({ state: "unknown" });
    expect(classifyPlatformDescription(undefined)).toEqual({ state: "unknown" });
    expect(classifyPlatformDescription(42)).toEqual({ state: "unknown" });
    expect(classifyPlatformDescription({ text: "x" })).toEqual({ state: "unknown" });
  });
});

describe("DescriptionClock", () => {
  it("follows the clock while it moves forward", () => {
    let now = 1000;
    const clock = new DescriptionClock(() => now);
    expect(clock.issue()).toBe(1000);
    now = 2000;
    expect(clock.issue()).toBe(2000);
  });

  it("orders requests sent in the same millisecond", () => {
    const clock = new DescriptionClock(() => 1000);
    expect([clock.issue(), clock.issue(), clock.issue()]).toEqual([1000, 1001, 1002]);
  });

  it("keeps increasing when the clock is set back", () => {
    let now = 5000;
    const clock = new DescriptionClock(() => now);
    expect(clock.issue()).toBe(5000);
    now = 100;
    expect(clock.issue()).toBe(5001);
    now = 9000;
    expect(clock.issue()).toBe(9000);
  });
});
