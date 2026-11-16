import { CONTENT_DESCRIPTION_MAX_CHARS } from "../../shared/defaults.ts";

/** What one read of a platform video's description gave: text, the platform's explicit "none", or nothing readable this time. */
export type PlatformDescription = { state: "found"; text: string } | { state: "empty" } | { state: "unknown" };

/** Line separators a description may arrive with; all become `\n`. NEL (U+0085) is a C1 control otherwise removed. */
const LINE_BREAKS = /\r\n|[\r\u0085\u2028\u2029]/g;
/** C0 / C1 controls except `\t` (U+0009) and `\n` (U+000A). */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u0084\u0086-\u009F]/g;
/**
 * Bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069): an unbalanced one
 * reorders whatever the page shows after the description. The plain direction marks
 * (U+200E, U+200F, U+061C) affect only neighbouring characters and are kept.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const TRAILING_SPACE = /\s+$/;
/** More than two blank lines in a row. */
const BLANK_RUN = /\n{4,}/g;

/**
 * A description as stored: `\n` line breaks, no trailing white space on any line, no
 * leading or trailing blank lines, at most two blank lines in a row, and no control,
 * bidi embedding, override or isolate characters (`\n`, `\t` and direction marks stay).
 */
export function normalizeDescription(raw: string): string {
  const lines = raw.replace(LINE_BREAKS, "\n").replace(CONTROLS, "").replace(BIDI_CONTROLS, "").split("\n");
  return lines
    .map((line) => line.replace(TRAILING_SPACE, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(BLANK_RUN, "\n\n\n");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function codePointCount(text: string): number {
  let count = 0;
  for (const _ of text) {
    count++;
  }
  return count;
}

/**
 * Keeps at most `max` code points: a longer text is cut after the last whole grapheme
 * cluster that ends within the limit, so a combining mark, an emoji or a ZWJ sequence is
 * never split. Nothing is appended; `truncated` says whether anything was cut.
 */
export function capDescription(text: string, max: number = CONTENT_DESCRIPTION_MAX_CHARS): { text: string; truncated: boolean } {
  // A UTF-16 length within the limit means the code points are too; most texts stop here.
  if (text.length <= max || codePointCount(text) <= max) {
    return { text, truncated: false };
  }
  let kept = 0;
  let end = 0;
  // The segmenter iterates lazily, so a long text is only segmented up to the cut.
  for (const { segment, index } of graphemes.segment(text)) {
    const size = codePointCount(segment);
    if (kept + size > max) {
      break;
    }
    kept += size;
    end = index + segment.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/**
 * What a platform's raw description field says. A string that is not empty after
 * normalization is `found` with the normalized text; an empty one, or one equal to a
 * platform's placeholder for "no description" (compared after normalization and trimming),
 * is `empty`; anything that is not a string (`null`, missing, another type) is `unknown`.
 */
export function classifyPlatformDescription(raw: unknown, emptyPlaceholders: readonly string[] = []): PlatformDescription {
  if (typeof raw !== "string") {
    return { state: "unknown" };
  }
  const text = normalizeDescription(raw);
  if (text === "" || emptyPlaceholders.includes(text.trim())) {
    return { state: "empty" };
  }
  return { state: "found", text };
}

/**
 * Issues the time a description request is sent, strictly increasing within the process.
 * A stored description is only replaced by the answer to a later request; two requests
 * sent in the same millisecond, or after the system clock went back, still get an order.
 * The source stage and the manual fetch share one instance.
 */
export class DescriptionClock {
  private readonly now: () => number;
  private last = Number.NEGATIVE_INFINITY;

  constructor(now: () => number) {
    this.now = now;
  }

  issue(): number {
    const time = Math.max(this.now(), this.last + 1);
    this.last = time;
    return time;
  }
}
