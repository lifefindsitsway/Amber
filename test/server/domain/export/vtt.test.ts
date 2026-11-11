import { describe, expect, it } from "vitest";
import { VTT_HEADER, vttCue, vttVoiceName } from "../../../../src/server/domain/export/vtt.ts";

describe("WebVTT", () => {
  it("starts with the signature and writes cues without ids", () => {
    expect(VTT_HEADER).toBe("WEBVTT\n\n");
    expect(vttCue({ startMs: 61_001, endMs: 62_000, text: "a\nb" })).toBe("00:01:01.001 --> 00:01:02.000\na b\n\n");
  });

  it("starts a cue with a voice tag when it has a speaker, leaving the cue text as it was", () => {
    expect(vttCue({ startMs: 0, endMs: 1000, text: "a<b>&c" }, "张三")).toBe("00:00:00.000 --> 00:00:01.000\n<v 张三>a<b>&c\n\n");
    expect(vttCue({ startMs: 0, endMs: 1000, text: "x" }, undefined)).toBe(vttCue({ startMs: 0, endMs: 1000, text: "x" }));
  });

  it("escapes markup characters of the voice name as character references", () => {
    expect(vttVoiceName("<b>&Tom>")).toBe("&lt;b&gt;&amp;Tom&gt;");
    expect(vttVoiceName("a&lt;b")).toBe("a&amp;lt;b");
    expect(vttVoiceName("a\nb")).toBe("a b");
    expect(vttCue({ startMs: 0, endMs: 1, text: "x" }, "A --> B")).toContain("<v A --&gt; B>x");
  });
});
