import { describe, expect, it } from "vitest";
import {
  figureImagePath,
  interleaveFigures,
  markdownCaptionLine,
  markdownFigureBlock,
  SentenceParagraphBuilder,
  txtFigureBlock,
  type ExportFigure,
  type SectionItem,
  type SectionPiece,
} from "../../../../src/server/domain/export/figures.ts";
import { placeFigures } from "../../../../src/shared/figure-placement.ts";

const figure = (id: string, overrides: Partial<ExportFigure> = {}): ExportFigure => ({ id, createdAt: 1, displayMs: 0, sortKey: 0, ...overrides });

const paragraph = (text: string, ids: string[]): SectionPiece => ({ kind: "paragraph", text, sentences: ids.map((id, index) => ({ id, startMs: Number(id.slice(1)) * 1000 + index })) });
const heading = (text: string): SectionPiece => ({ kind: "heading", text });

const shape = (items: ReadonlyArray<SectionItem<ExportFigure>>): string[] => items.map((item) => (item.kind === "text" ? item.text : `#${item.number}:${item.figure.id}`));

describe("figureImagePath", () => {
  it("numbers with three digits at least and nothing from the user", () => {
    expect(figureImagePath(1)).toBe("images/001.webp");
    expect(figureImagePath(42)).toBe("images/042.webp");
    expect(figureImagePath(1000)).toBe("images/1000.webp");
  });
});

describe("SentenceParagraphBuilder", () => {
  it("cuts paragraphs like the export and records each paragraph's sentences", () => {
    const builder = new SentenceParagraphBuilder();
    const out = [
      builder.push({ id: "a", startMs: 0, endMs: 900, text: "一。", paragraphStart: true }),
      builder.push({ id: "b", startMs: 1000, endMs: 1900, text: "二。", paragraphStart: false }),
      builder.push({ id: "c", startMs: 2000, endMs: 2900, text: "三。", paragraphStart: true }),
      builder.flush(),
    ];
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2]).toEqual({ paragraph: { startMs: 0, text: "一。二。" }, sentences: [{ id: "a", startMs: 0 }, { id: "b", startMs: 1000 }] });
    expect(out[3]).toEqual({ paragraph: { startMs: 2000, text: "三。" }, sentences: [{ id: "c", startMs: 2000 }] });
    expect(builder.flush()).toBeUndefined();
  });
});

describe("interleaveFigures", () => {
  const pieces = [paragraph("P0", ["s1", "s2"]), heading("H"), paragraph("P1", ["s3"]), paragraph("P2", ["s4"])];
  const layoutOf = (figures: ExportFigure[]) =>
    placeFigures({ readingRevisionId: "r", paragraphs: pieces.flatMap((piece) => (piece.kind === "paragraph" ? [{ segments: piece.sentences }] : [])), figures });

  it("writes each gap's figures after the paragraph above, numbered in reading order, whatever their creation order", () => {
    const figures = [
      figure("late", { anchor: { revisionId: "r", segmentId: "s4", side: "after" }, createdAt: 1 }),
      figure("early", { displayMs: 0, createdAt: 9 }),
      figure("middle", { anchor: { revisionId: "r", segmentId: "s3", side: "after" }, createdAt: 5 }),
    ];
    const { items, figures: numbered } = interleaveFigures(pieces, layoutOf(figures));
    expect(shape(items)).toEqual(["#1:early", "P0", "H", "P1", "#2:middle", "P2", "#3:late"]);
    expect(numbered.map((entry) => entry.id)).toEqual(["early", "middle", "late"]);
  });

  it("across a chapter heading, keeps after-anchored and timed figures above it and puts before-anchored ones next to their paragraph", () => {
    const figures = [
      figure("before", { anchor: { revisionId: "r", segmentId: "s3", side: "before" } }),
      figure("after", { anchor: { revisionId: "r", segmentId: "s2", side: "after" } }),
      figure("timed", { displayMs: 1500 }),
    ];
    expect(shape(interleaveFigures(pieces, layoutOf(figures)).items)).toEqual(["P0", "#1:after", "#2:timed", "H", "#3:before", "P1", "P2"]);
  });

  it("with no paragraph at all, still writes every figure once", () => {
    const layout = placeFigures({ readingRevisionId: "r", paragraphs: [], figures: [figure("a"), figure("b", { displayMs: 5 })] });
    expect(shape(interleaveFigures([], layout).items)).toEqual(["#1:a", "#2:b"]);
  });
});

describe("Markdown figure blocks", () => {
  it("write the image line and the caption line, the time only for a capture and linked like the paragraphs", () => {
    expect(markdownFigureBlock(3, figure("f", { capturedAtMs: 725_000, caption: "板书" }), (ms) => `https://e.com/v?t=${ms / 1000}`)).toBe(
      "![图 3](images/003.webp)\\\n图 3 · [12:05](https://e.com/v?t=725) · 板书\n\n",
    );
    expect(markdownFigureBlock(3, figure("f", { capturedAtMs: 725_000 }), () => undefined)).toBe("![图 3](images/003.webp)\\\n图 3 · [12:05]\n\n");
    expect(markdownFigureBlock(12, figure("f"), () => "unused")).toBe("![图 12](images/012.webp)\\\n图 12\n\n");
  });

  it("escape every caption line so no caption can break the block or the document", () => {
    const caption = ["a `b` ]c[ *d* _e_ <i>&amp; ~f~ g|h $x$ \\", "# 不是标题", "- 不是列表", "+ 也不是", "1. 不是编号", "2) 也不是", "---", "===", "", "   ", "  > 不是引用", "```", "![x](y)"].join("\n");
    const block = markdownFigureBlock(1, figure("f", { caption }), () => undefined);
    expect(block).toBe(
      [
        "![图 1](images/001.webp)\\",
        "图 1 · a \\`b\\` \\]c\\[ \\*d\\* \\_e\\_ \\<i\\>\\&amp; \\~f\\~ g\\|h \\$x\\$ \\\\\\",
        "\\# 不是标题\\",
        "\\- 不是列表\\",
        "\\+ 也不是\\",
        "1\\. 不是编号\\",
        "2\\) 也不是\\",
        "\\---\\",
        "\\===\\",
        "\\> 不是引用\\",
        "\\`\\`\\`\\",
        "!\\[x\\](y)",
        "",
        "",
      ].join("\n"),
    );
    // One block: no blank line inside it, every line but the last ends in a hard break.
    const lines = block.replace(/\n\n$/, "").split("\n");
    expect(lines.every((line) => line.trim() !== "")).toBe(true);
    expect(lines.slice(0, -1).every((line) => line.endsWith("\\"))).toBe(true);
  });

  it("caption lines keep CRLF and lone CR apart as lines", () => {
    expect(markdownFigureBlock(1, figure("f", { caption: "一\r\n二\r三" }), () => undefined)).toBe("![图 1](images/001.webp)\\\n图 1 · 一\\\n二\\\n三\n\n");
    expect(markdownCaptionLine("  12. x  ")).toBe("12\\. x");
  });
});

describe("TXT figure blocks", () => {
  it("write the marker line with the time only for a capture, then the caption as written", () => {
    expect(txtFigureBlock(3, figure("f", { capturedAtMs: 725_000, caption: "板书\n第二行 # [x]" }))).toBe("[图 3 · 12:05 · images/003.webp]\n板书\n第二行 # [x]\n");
    expect(txtFigureBlock(4, figure("f"))).toBe("[图 4 · images/004.webp]\n");
    expect(txtFigureBlock(5, figure("f", { capturedAtMs: 6_000_000, caption: "a\r\nb\n\n" }))).toBe("[图 5 · 1:40:00 · images/005.webp]\na\nb\n");
  });
});
