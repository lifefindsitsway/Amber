import type { Paragraph } from "./paragraphs.ts";

/**
 * One TXT paragraph: plain text without time stamps; paragraphs are separated by a blank
 * line. `speakerPrefix` (`名字：`) starts the paragraph when it is labelled.
 */
export function txtParagraph(paragraph: Paragraph, first: boolean, speakerPrefix = ""): string {
  return `${first ? "" : "\n"}${speakerPrefix}${paragraph.text}\n`;
}
