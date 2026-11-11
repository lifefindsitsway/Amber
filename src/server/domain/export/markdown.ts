import { oneLine } from "./cues.ts";
import { markdownTime } from "./time-format.ts";

/** Fills `{{name}}` slots of a fixed export text; unknown slots are left as they are. */
export function fillText(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (slot, name: string) => values[name] ?? slot);
}

/** A time stamp `[mm:ss]`, linked when a back-link is given: `[mm:ss](url)`. */
export function markdownStamp(ms: number, url?: string): string {
  const stamp = `[${markdownTime(ms)}]`;
  return url === undefined ? stamp : `${stamp}(${url})`;
}

/** Where a cited sentence is, for rendering its marker; `undefined` when it cannot be found. */
export type CitationResolver = (segmentId: string) => { startMs: number; url?: string } | undefined;

const SEGMENT_MARKER = /\[\[seg:([^\]\s]+)\]\]/g;
const UNRESOLVED_MARKER = /\[\[unresolved:[^\]\s]*\]\]/g;

/**
 * A stored body with its markers rendered: `[[seg:<id>]]` becomes the
 * cited sentence's time stamp, linked when the resolver gives a URL; a marker that cannot
 * be resolved and every `[[unresolved:<alias>]]` become the `unresolved` text, in
 * brackets, rather than disappearing.
 */
export function renderCitations(body: string, resolve: CitationResolver, unresolved: string): string {
  return body
    .replace(SEGMENT_MARKER, (_marker, segmentId: string) => {
      const found = resolve(segmentId);
      return found === undefined ? `[${unresolved}]` : markdownStamp(found.startMs, found.url);
    })
    .replace(UNRESOLVED_MARKER, `[${unresolved}]`);
}

/** The quoted line under the title: the given parts joined by ` · `. */
export function headerLine(parts: readonly string[]): string {
  return `> ${parts.join(" · ")}\n`;
}

/** A chapter entry: `- [mm:ss](link) 标题 — 一句概要`. */
export function chapterLine(stamp: string, title: string, summary: string | undefined): string {
  const tail = summary === undefined || summary.trim() === "" ? "" : ` — ${oneLine(summary)}`;
  return `- ${stamp} ${oneLine(title)}${tail}\n`;
}

/** A chapter heading inside the transcript section, present only when chapters were exported too. */
export function transcriptChapterHeading(title: string): string {
  return `### ${oneLine(title)}\n\n`;
}

/**
 * A reading paragraph of the transcript section: `**[mm:ss](link)** text`, and for the
 * first paragraph of a speaker's turn `**名字** · **[mm:ss](link)** text`.
 */
export function transcriptParagraphLine(stamp: string, text: string, speaker?: string): string {
  return `${speaker === undefined ? "" : `**${markdownInline(speaker)}** · `}**${stamp}** ${text}\n\n`;
}

/**
 * A name as literal inline Markdown on one line: characters that could open emphasis, a
 * link, code, HTML or a character reference are backslash-escaped.
 */
export function markdownInline(text: string): string {
  return oneLine(text).replace(/[\\`*_\[\]<>&~|]/g, "\\$&");
}

/** A line of the subtitle section: `[mm:ss] text`, never linked. */
export function subtitleLine(ms: number, text: string): string {
  return `${markdownStamp(ms)} ${oneLine(text)}\n`;
}
