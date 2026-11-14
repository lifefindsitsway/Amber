import { describe, expect, it } from "vitest";
import { SPEAKER_NAME_MAX_GRAPHEMES } from "../../../../src/shared/defaults.ts";
import { defaultLabelOrdinal, defaultSpeakerLabel, linePrefix, speakerKeyOf } from "../../../../src/server/domain/subtitle-formats/speaker-names.ts";

describe("leading speaker names", () => {
  it("takes a full-width colon with or without a following space", () => {
    expect(linePrefix("张三：你好")).toEqual({ key: "张三", rest: "你好" });
    expect(linePrefix("张三：  你好")).toEqual({ key: "张三", rest: "你好" });
    expect(linePrefix(" 李 四 ：你好")).toEqual({ key: "李 四", rest: "你好" });
  });

  it("takes a half-width colon only when white space follows", () => {
    expect(linePrefix("Alice: hello")).toEqual({ key: "Alice", rest: "hello" });
    expect(linePrefix("Alice:hello")).toBeUndefined();
    expect(linePrefix("ratio 3:2 is fine")).toBeUndefined();
  });

  it("decides by the first colon of the line", () => {
    expect(linePrefix("http://example.com 张三：你好")).toBeUndefined();
    expect(linePrefix("张三：他说: 好")).toEqual({ key: "张三", rest: "他说: 好" });
  });

  it("keeps an empty rest for a line that is only a name", () => {
    expect(linePrefix("张三：")).toEqual({ key: "张三", rest: "" });
  });

  it("refuses times, numbers, URL schemes and text with sentence punctuation", () => {
    expect(linePrefix("12：30 开始")).toBeUndefined();
    expect(linePrefix("12: 30")).toBeUndefined();
    expect(linePrefix("2024：年度回顾")).toBeUndefined();
    expect(linePrefix("https：//example.com")).toBeUndefined();
    expect(linePrefix("https://example.com")).toBeUndefined();
    expect(linePrefix("结束了。然后：继续")).toBeUndefined();
    expect(linePrefix("Really? Yes: ok")).toBeUndefined();
    expect(linePrefix("Dr. Smith: hello")).toBeUndefined();
    expect(linePrefix("等一下……好：走")).toBeUndefined();
    expect(linePrefix("先这样；然后：走")).toBeUndefined();
    expect(linePrefix("：没有名字")).toBeUndefined();
    expect(linePrefix("没有冒号")).toBeUndefined();
  });

  it("allows commas inside a name, as exports write them", () => {
    expect(linePrefix("Alice Smith-Johnson, PhD：They're ok")).toEqual({ key: "Alice Smith-Johnson, PhD", rest: "They're ok" });
    expect(linePrefix("Alice Smith-Johnson, PhD: They're ok")?.key).toBe("Alice Smith-Johnson, PhD");
  });

  it("accepts a word such as 注意 as a name: the count and the user decide", () => {
    expect(linePrefix("注意：这里很重要")).toEqual({ key: "注意", rest: "这里很重要" });
  });

  it("bounds the name by grapheme clusters", () => {
    const longest = "名".repeat(SPEAKER_NAME_MAX_GRAPHEMES);
    expect(linePrefix(`${longest}：好`)?.key).toBe(longest);
    expect(linePrefix(`${longest}名：好`)).toBeUndefined();
    // A family emoji is one cluster of several code points.
    expect(linePrefix(`${"👨‍👩‍👧".repeat(SPEAKER_NAME_MAX_GRAPHEMES)}：好`)?.rest).toBe("好");
  });

  it("normalizes the key: controls removed and spaces collapsed", () => {
    expect(linePrefix("张\u202E三：好")?.key).toBe("张 三");
    expect(speakerKeyOf("  a   b ")).toBe("a b");
    expect(speakerKeyOf("   ")).toBeUndefined();
    expect(speakerKeyOf("x".repeat(SPEAKER_NAME_MAX_GRAPHEMES + 1))).toBeUndefined();
  });
});

describe("default speaker labels", () => {
  it("reads N back from exactly the label exports write", () => {
    expect(defaultSpeakerLabel(3)).toBe("发言人 3");
    expect(defaultLabelOrdinal(defaultSpeakerLabel(3))).toBe(3);
    expect(defaultLabelOrdinal("发言人 12")).toBe(12);
  });

  it("takes nothing else as the default label", () => {
    expect(defaultLabelOrdinal("发言人 0")).toBeUndefined();
    expect(defaultLabelOrdinal("发言人 03")).toBeUndefined();
    expect(defaultLabelOrdinal("发言人3")).toBeUndefined();
    expect(defaultLabelOrdinal("发言人 3 号")).toBeUndefined();
    expect(defaultLabelOrdinal("Speaker 3")).toBeUndefined();
  });
});
