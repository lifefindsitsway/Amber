import { describe, expect, it } from "vitest";
import { VTT_HEADER, vttCue, vttText, vttVoiceName } from "../../../../src/server/domain/export/vtt.ts";

describe("WebVTT", () => {
  it("starts with the signature and writes cues without ids", () => {
    expect(VTT_HEADER).toBe("WEBVTT\n\n");
    expect(vttCue({ startMs: 61_001, endMs: 62_000, text: "a\nb" })).toBe("00:01:01.001 --> 00:01:02.000\na b\n\n");
  });

  it("starts a cue with a voice tag when it has a speaker", () => {
    expect(vttCue({ startMs: 0, endMs: 1000, text: "a<b>&c" }, "张三")).toBe("00:00:00.000 --> 00:00:01.000\n<v 张三>a&lt;b&gt;&amp;c\n\n");
    expect(vttCue({ startMs: 0, endMs: 1000, text: "x" }, undefined)).toBe(vttCue({ startMs: 0, endMs: 1000, text: "x" }));
  });

  it("escapes markup characters of the voice name as character references", () => {
    expect(vttVoiceName("<b>&Tom>")).toBe("&lt;b&gt;&amp;Tom&gt;");
    expect(vttVoiceName("a&lt;b")).toBe("a&amp;lt;b");
    expect(vttVoiceName("a\nb")).toBe("a b");
    expect(vttCue({ startMs: 0, endMs: 1, text: "x" }, "A --> B")).toContain("<v A --&gt; B>x");
  });

  it("escapes &, < and > in the cue text, once each, and leaves text without them as it was", () => {
    expect(vttCue({ startMs: 0, endMs: 1000, text: "x <b>bold</b> & y > z" })).toBe("00:00:00.000 --> 00:00:01.000\nx &lt;b&gt;bold&lt;/b&gt; &amp; y &gt; z\n\n");
    expect(vttText("a&lt;b")).toBe("a&amp;lt;b");
    expect(vttText("1 --> 2")).toBe("1 --&gt; 2");
    expect(vttText("a\r\nb")).toBe("a b");
    for (const plain of ["你好，世界", "It's \"quoted\" — fine.", "{\\b1}x", "👨‍👩‍👧"]) {
      expect(vttText(plain)).toBe(plain);
      expect(vttCue({ startMs: 0, endMs: 1, text: plain })).toBe(`00:00:00.000 --> 00:00:00.001\n${plain}\n\n`);
    }
  });
});
