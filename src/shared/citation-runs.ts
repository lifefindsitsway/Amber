/**
 * Stored citation markers as they appear in derived Markdown: canonical `[[seg:<id>]]` and
 * `[[unresolved:<alias>]]`. Model-side aliases (`[[s<n>]]`) never reach storage, but a
 * stage tidying raw model output can pass them through the same functions.
 */
const MARKER_SOURCE = String.raw`\[\[(?:seg:[^\]\s]+|unresolved:[^\]\s]+|s\d+)\]\]`;

/**
 * A run of adjacent markers: separated only by horizontal space or list punctuation, never
 * by a line break, so markers closing two paragraphs stay two runs.
 */
const RUN = new RegExp(String.raw`${MARKER_SOURCE}(?:[ \t　、，,；;]*${MARKER_SOURCE})*`, "g");
const MARKER = new RegExp(MARKER_SOURCE, "g");

/**
 * Keeps at most `max` distinct markers of each run, in their order, dropping the rest and the
 * separators between them; text outside runs is untouched. Models tend to cite every sentence
 * behind a claim; the first ones stand for the run.
 */
export function capCitationRuns(markdown: string, max: number): string {
  return markdown.replace(RUN, (run) => {
    const all = run.match(MARKER) ?? [];
    const distinct = [...new Set(all)];
    return all.length <= max && distinct.length === all.length ? run : distinct.slice(0, max).join("");
  });
}

const STRIP = new RegExp(String.raw`([ \t　]*)${RUN.source}[ \t　]*`, "g");
/** What may follow a removed run with no space before it: punctuation or a line break. */
const CLOSES_CLAUSE = /[，。、；：！？,.;:!?)）\n]/;

/**
 * Removes every citation run, for text that carries no citations (a collection summary). The
 * horizontal space after a run goes with it; the space before it goes too when punctuation or
 * the line end follows, so「结论 [[seg:x]]。」reads「结论。」.
 */
export function stripCitations(markdown: string): string {
  return markdown.replace(STRIP, (match, before: string, offset: number, text: string) => {
    const next = text[offset + match.length];
    return next === undefined || CLOSES_CLAUSE.test(next) ? "" : before;
  });
}
