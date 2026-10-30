import { describe, expect, it } from "vitest";
import { parseUpdateNotes } from "../../../src/web/desktop/update-notes.ts";

describe("update notes layout", () => {
  it("reads the plain-text feed layout: an opening paragraph, then titled sections of items", () => {
    expect(parseUpdateNotes("本次更新重点。\n\n新增\n• 一项\n• 二项\n\n修复\n• 三项")).toEqual([
      { kind: "paragraph", text: "本次更新重点。" },
      { kind: "section", title: "新增", items: ["一项", "二项"] },
      { kind: "section", title: "修复", items: ["三项"] },
    ]);
  });

  it("reads Markdown headings and list marks the same way and drops emphasis and code marks", () => {
    expect(parseUpdateNotes("### 新增\n\n- 一项 **重点**\n* 二项 `代码`\n\n## 修复 ##\n+ 三项\r\n")).toEqual([
      { kind: "section", title: "新增", items: ["一项 重点", "二项 代码"] },
      { kind: "section", title: "修复", items: ["三项"] },
    ]);
  });

  it("keeps items without a title in an untitled section and lines with no items as paragraphs", () => {
    expect(parseUpdateNotes("• 一项\n\n结尾一句。\n另一句。")).toEqual([
      { kind: "section", items: ["一项"] },
      { kind: "paragraph", text: "结尾一句。" },
      { kind: "paragraph", text: "另一句。" },
    ]);
    expect(parseUpdateNotes("修复 <b>若干</b> 问题")).toEqual([{ kind: "paragraph", text: "修复 <b>若干</b> 问题" }]);
    expect(parseUpdateNotes(" \n\n")).toEqual([]);
  });
});
