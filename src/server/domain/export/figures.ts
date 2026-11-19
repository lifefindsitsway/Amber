import type { FigureLayout, PlaceableFigure, PlacementSentence } from "../../../shared/figure-placement.ts";
import { exportFile } from "../../../shared/i18n/zh-CN/export-file.ts";
import { fillText, markdownInline, markdownStamp } from "./markdown.ts";
import { ParagraphBuilder, type Paragraph } from "./paragraphs.ts";
import { markdownTime } from "./time-format.ts";

/**
 * Figures inside an exported Markdown or TXT transcript: where each one goes between the
 * export's own paragraphs, its number, and how it is written. Only the figure blocks are new;
 * the paragraphs around them are written exactly as without figures.
 */

/** What a figure block needs besides its place. */
export interface ExportFigure extends PlaceableFigure {
  /** Only on a captured frame. */
  capturedAtMs?: number;
  caption?: string;
}

/** The archive path of the `number`th figure in reading order: `images/001.webp`, three digits at least. */
export function figureImagePath(number: number): string {
  return `images/${String(number).padStart(3, "0")}.webp`;
}

/** A paragraph as the export cut it, with its sentences, so figures can be placed against exactly those paragraphs. */
export interface SentenceParagraph {
  paragraph: Paragraph;
  sentences: PlacementSentence[];
}

/**
 * The export's `ParagraphBuilder` that also remembers which sentences went into each
 * paragraph. Sentences without an id are grouped the same way and simply not recorded.
 */
export class SentenceParagraphBuilder {
  private readonly builder = new ParagraphBuilder();
  private sentences: PlacementSentence[] = [];

  push(sentence: Parameters<ParagraphBuilder["push"]>[0] & { id?: string }): SentenceParagraph | undefined {
    const closed = this.builder.push(sentence);
    let result: SentenceParagraph | undefined;
    if (closed !== undefined) {
      result = { paragraph: closed, sentences: this.sentences };
      this.sentences = [];
    }
    if (sentence.id !== undefined) {
      this.sentences.push({ id: sentence.id, startMs: sentence.startMs });
    }
    return result;
  }

  flush(): SentenceParagraph | undefined {
    const open = this.builder.flush();
    const sentences = this.sentences;
    this.sentences = [];
    return open === undefined ? undefined : { paragraph: open, sentences };
  }
}

/** A written piece of a transcript section: a chapter heading or a paragraph, with the text the export writes for it. */
export type SectionPiece = { kind: "heading"; text: string } | { kind: "paragraph"; text: string; sentences: readonly PlacementSentence[] };

/** The section with its figures between the pieces; `number` counts figures in reading order from 1. */
export type SectionItem<F> = { kind: "text"; text: string } | { kind: "figure"; figure: F; number: number };

/** Whether a placed figure leads into the paragraph below rather than following the one above. */
function leadsIn(entry: { figure: PlaceableFigure; via: string }): boolean {
  return entry.via !== "time" && entry.figure.anchor !== undefined && entry.figure.anchor !== null && entry.figure.anchor.side === "before";
}

/**
 * Puts each placed figure into the section: the figures of gap `k` stand right after
 * paragraph `k - 1`, in the layout's order. When a chapter heading stands between the two
 * paragraphs, a figure anchored before the next paragraph goes after the heading, next to
 * the paragraph it belongs to; the others stay with the paragraph above. Figures are
 * numbered in the order they are written, which is the reading order; every figure of the
 * layout is written exactly once.
 */
export function interleaveFigures<F extends PlaceableFigure>(pieces: readonly SectionPiece[], layout: FigureLayout<F>): { items: Array<SectionItem<F>>; figures: F[] } {
  const items: Array<SectionItem<F>> = [];
  const figures: F[] = [];
  const written = new Set<F>();
  const byGap = new Map<number, Array<{ figure: F; via: string }>>();
  for (const entry of layout.placed) {
    const list = byGap.get(entry.gap) ?? [];
    list.push(entry);
    byGap.set(entry.gap, list);
  }
  const write = (entries: ReadonlyArray<{ figure: F; via: string }>, only?: (entry: { figure: F; via: string }) => boolean): void => {
    for (const entry of entries) {
      if (written.has(entry.figure) || (only !== undefined && !only(entry))) continue;
      written.add(entry.figure);
      figures.push(entry.figure);
      items.push({ kind: "figure", figure: entry.figure, number: figures.length });
    }
  };
  let gap = 0;
  for (const piece of pieces) {
    const here = byGap.get(gap) ?? [];
    if (piece.kind === "heading") {
      write(here, (entry) => !leadsIn(entry));
      items.push({ kind: "text", text: piece.text });
      continue;
    }
    write(here);
    items.push({ kind: "text", text: piece.text });
    gap += 1;
  }
  write(byGap.get(gap) ?? []);
  // A layout made for other paragraphs never loses a figure: what is left goes last.
  write(layout.placed);
  return { items, figures };
}

/**
 * One line of a caption as literal Markdown: inline markup escaped like a speaker name, plus
 * whatever would open a block at the start of a line (heading, list, quote, setext
 * underline, numbered item), so no caption can end the figure block or restructure the
 * document. Surrounding white space is dropped; it carries no meaning in Markdown.
 */
export function markdownCaptionLine(line: string): string {
  const escaped = markdownInline(line.trim()).replace(/\$/g, "\\$");
  return escaped.replace(/^([#+=-])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
}

/**
 * A figure block of the Markdown transcript: the image line, then the caption line
 * `图 N · [mm:ss](link) · caption` — the time only for a captured frame, linked like the
 * paragraphs' stamps; each further caption line on its own line. Lines of one block end in a
 * hard line break so they show as lines in every renderer; blank caption lines are left out,
 * since a blank line would end the block. Ends with a blank line, like a paragraph.
 */
export function markdownFigureBlock(number: number, figure: ExportFigure, link: (ms: number) => string | undefined): string {
  const label = fillText(exportFile.figure, { number: String(number) });
  const captionLines = (figure.caption ?? "").split(/\r\n|\r|\n/).filter((line) => line.trim() !== "").map(markdownCaptionLine);
  const head = [label, ...(figure.capturedAtMs === undefined ? [] : [markdownStamp(figure.capturedAtMs, link(figure.capturedAtMs))]), ...captionLines.slice(0, 1)].join(" · ");
  const lines = [`![${label}](${figureImagePath(number)})`, head, ...captionLines.slice(1)];
  return `${lines.join("\\\n")}\n\n`;
}

/**
 * A figure block of the TXT transcript, without the blank line that separates it from its
 * neighbours: `[图 N · mm:ss · images/00N.webp]`, the time only for a captured frame, and
 * the caption as written on the next lines.
 */
export function txtFigureBlock(number: number, figure: ExportFigure): string {
  const label = fillText(exportFile.figure, { number: String(number) });
  const marker = `[${[label, ...(figure.capturedAtMs === undefined ? [] : [markdownTime(figure.capturedAtMs)]), figureImagePath(number)].join(" · ")}]\n`;
  const caption = (figure.caption ?? "").replace(/\r\n|\r/g, "\n").replace(/\n+$/, "");
  return caption.trim() === "" ? marker : `${marker}${caption}\n`;
}
