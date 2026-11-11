import { describe, expect, it } from "vitest";
import { srtCue } from "../../../../src/server/domain/export/srt.ts";

describe("srtCue", () => {
  it("writes a numbered cue with one line per sentence", () => {
    expect(srtCue(1, { startMs: 1000, endMs: 2500, text: "第一行\n续" })).toBe("1\n00:00:01,000 --> 00:00:02,500\n第一行 续\n\n");
  });

  it("puts the speaker prefix before the original line only", () => {
    expect(srtCue(3, { startMs: 0, endMs: 1000, text: "你好", translation: "Hello" }, "张三：")).toBe("3\n00:00:00,000 --> 00:00:01,000\n张三：你好\nHello\n\n");
    expect(srtCue(3, { startMs: 0, endMs: 1000, text: "你好" }, "")).toBe(srtCue(3, { startMs: 0, endMs: 1000, text: "你好" }));
  });

  it("puts the translation on a second line of the same cue", () => {
    expect(srtCue(2, { startMs: 0, endMs: 1, text: "你好", translation: "Hello" })).toBe("2\n00:00:00,000 --> 00:00:00,001\n你好\nHello\n\n");
  });
});
