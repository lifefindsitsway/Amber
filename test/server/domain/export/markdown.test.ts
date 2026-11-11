import { describe, expect, it } from "vitest";
import {
  chapterLine,
  fillText,
  headerLine,
  markdownInline,
  markdownStamp,
  renderCitations,
  subtitleLine,
  transcriptParagraphLine,
} from "../../../../src/server/domain/export/markdown.ts";

describe("Markdown export pieces", () => {
  it("fill known slots only", () => {
    expect(fillText("来源：{{source}} {{other}}", { source: "x" })).toBe("来源：x {{other}}");
  });

  it("link a stamp only when a URL is given", () => {
    expect(markdownStamp(763_000, "https://e.com/v?t=763")).toBe("[12:43](https://e.com/v?t=763)");
    expect(markdownStamp(763_000)).toBe("[12:43]");
  });

  it("render resolved, unknown and unresolved markers", () => {
    const body = "甲 [[seg:01AAA]] 乙 [[seg:01BBB]] 丙 [[unresolved:s7]]";
    const rendered = renderCitations(body, (id) => (id === "01AAA" ? { startMs: 5000, url: "u" } : undefined), "引用无法定位");
    expect(rendered).toBe("甲 [00:05](u) 乙 [引用无法定位] 丙 [引用无法定位]");
  });

  it("write the header, chapter, paragraph and subtitle lines of the Markdown export format", () => {
    expect(headerLine(["来源：x", "时长 0:01:00"])).toBe("> 来源：x · 时长 0:01:00\n");
    expect(chapterLine("[00:00](u)", "开场", "问候")).toBe("- [00:00](u) 开场 — 问候\n");
    expect(chapterLine("[00:00]", "开场", undefined)).toBe("- [00:00] 开场\n");
    expect(transcriptParagraphLine("[00:01]", "段落")).toBe("**[00:01]** 段落\n\n");
    expect(subtitleLine(61_000, "一\n二")).toBe("[01:01] 一 二\n");
  });

  it("names the speaker before the time stamp of a turn's first paragraph", () => {
    expect(transcriptParagraphLine("[00:01](u)", "段落", "张三")).toBe("**张三** · **[00:01](u)** 段落\n\n");
    expect(transcriptParagraphLine("[00:01]", "段落", undefined)).toBe(transcriptParagraphLine("[00:01]", "段落"));
  });

  it("escapes Markdown in a speaker name and keeps it on one line", () => {
    expect(markdownInline("**x_y**")).toBe("\\*\\*x\\_y\\*\\*");
    expect(markdownInline("[a](b) <i>&amp; `c` ~d~ e|f")).toBe("\\[a\\](b) \\<i\\>\\&amp; \\`c\\` \\~d\\~ e\\|f");
    expect(markdownInline("a\\b")).toBe("a\\\\b");
    expect(markdownInline("甲\n乙 👨‍👩‍👧")).toBe("甲 乙 👨‍👩‍👧");
    expect(transcriptParagraphLine("[00:01]", "段落", "**x_y**")).toBe("**\\*\\*x\\_y\\*\\*** · **[00:01]** 段落\n\n");
  });
});
