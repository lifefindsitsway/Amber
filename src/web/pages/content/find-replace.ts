import { TRANSCRIPT_FILLER_WORDS_ZH } from "../../../shared/defaults.ts";

/**
 * Plain-text find and replace over a draft's sentences, and the filler-word cleanup of a
 * Chinese draft. Pure functions: the editor keeps the state, these only compute. Offsets are
 * UTF-16 code units, the unit `setSelectionRange` takes, so a hit selects exactly its text.
 */

/** One hit: sentence `index`, text `[start, end)`. */
export interface TextMatch {
  index: number;
  start: number;
  end: number;
}

/**
 * Lower-cases without moving any offset: a character whose lower case has another length
 * (a dotted capital I, say) is compared as it is.
 */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (const ch of text) {
    const folded = ch.toLowerCase();
    out += folded.length === ch.length ? folded : ch;
  }
  return out;
}

/**
 * Every hit of `query` in reading order: left to right in each sentence, never overlapping
 * (after a hit the search resumes at its end). Plain text only, no patterns; an empty query
 * finds nothing.
 */
export function findMatches(texts: readonly string[], query: string, caseSensitive: boolean): TextMatch[] {
  if (query === "") return [];
  const needle = caseSensitive ? query : fold(query);
  const matches: TextMatch[] = [];
  texts.forEach((text, index) => {
    const haystack = caseSensitive ? text : fold(text);
    let from = 0;
    for (;;) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      matches.push({ index, start, end: start + needle.length });
      from = start + needle.length;
    }
  });
  return matches;
}

/** Hits grouped per sentence, rightmost first, so splicing one never moves the next. */
function bySentenceRightToLeft(matches: readonly TextMatch[]): Map<number, TextMatch[]> {
  const grouped = new Map<number, TextMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.index) ?? [];
    list.push(match);
    grouped.set(match.index, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => b.start - a.start);
  return grouped;
}

/**
 * Replaces the given hits with `replacement`. Sentences without a hit keep their very
 * string, so an undo snapshot of the old array shares everything that did not change.
 */
export function applyReplace(texts: readonly string[], matches: readonly TextMatch[], replacement: string): string[] {
  const next = [...texts];
  for (const [index, list] of bySentenceRightToLeft(matches)) {
    let text = next[index] ?? "";
    for (const match of list) text = text.slice(0, match.start) + replacement + text.slice(match.end);
    next[index] = text;
  }
  return next;
}

// Pause marks a cut may leave doubled or dangling: the comma, enumeration comma and semicolon
// of Chinese text. Quotes, brackets, ellipses and Latin punctuation are never touched.
const PAUSE = /^[，、；]$/;
const STRONG_PAUSE = /^；$/;
const MIDDLE_PAUSE = /^，$/;
/** Marks that end a clause: a pause right before one is dangling. */
const CLAUSE_END = /^[。！？!?]$/;

function pauseStrength(mark: string): number {
  if (STRONG_PAUSE.test(mark)) return 3;
  return MIDDLE_PAUSE.test(mark) ? 2 : 1;
}

const isPause = (mark: string | undefined): mark is string => mark !== undefined && PAUSE.test(mark);
const isClauseEnd = (mark: string | undefined): boolean => mark !== undefined && CLAUSE_END.test(mark);

/**
 * Deletes `[start, end)` and tidies the pause marks right at the cut: two pauses meeting keep
 * the stronger one (semicolon over comma over enumeration comma, the left one on a tie); a
 * pause opening the sentence or a clause goes; a pause left hanging before the clause's end
 * goes. Nothing further away is touched.
 */
export function cleanupAtCut(text: string, start: number, end: number): string {
  let before = text.slice(0, start);
  let after = text.slice(end);
  const left = before.at(-1);
  const right = after[0];
  if (left === undefined || isClauseEnd(left)) {
    if (isPause(right)) after = after.slice(1);
  } else if (isPause(left) && isPause(right)) {
    if (pauseStrength(right) > pauseStrength(left)) before = before.slice(0, -1);
    else after = after.slice(1);
  } else if (isPause(left) && (right === undefined || isClauseEnd(right))) {
    before = before.slice(0, -1);
  }
  return before + after;
}

/** Deletes several ranges of one sentence, rightmost first, tidying punctuation at each cut. */
export function applyCuts(text: string, ranges: ReadonlyArray<{ start: number; end: number }>): string {
  return [...ranges].sort((a, b) => b.start - a.start).reduce((current, range) => cleanupAtCut(current, range.start, range.end), text);
}

/** Deletes the given hits, tidying punctuation; untouched sentences keep their string. */
export function applyDelete(texts: readonly string[], matches: readonly TextMatch[]): string[] {
  const next = [...texts];
  for (const [index, list] of bySentenceRightToLeft(matches)) next[index] = applyCuts(next[index] ?? "", list);
  return next;
}

/** The filler words, in the order the editor lists them. */
export const FILLER_WORDS: readonly string[] = TRANSCRIPT_FILLER_WORDS_ZH.split(" ").filter((word) => word !== "");

/**
 * Pure hesitation sounds: nearly always noise wherever they stand. The other fillers are
 * sentence particles that can carry tone or a question.
 */
const HESITATION = /^[嗯呃额]$/;

/**
 * Common words that contain a filler character but are not fillers; a character inside one
 * of these is never offered. Kept as one pattern so a sentence is scanned once.
 */
const FILLER_EXCEPTIONS =
  /额度|额外|金额|名额|余额|限额|定额|份额|数额|总额|差额|超额|面额|配额|巨额|额头|额定|酒吧|网吧|吧台|贴吧|书吧|水吧|氧吧|吧唧|吧嗒|哈密|哈佛|哈尔滨|哈萨克|哈欠|哈达|哈勃|哈利|哈希|哈腰|哈气|哈马斯|呢子|呢绒|呢喃|毛呢|花呢|呢料|呢帽|喇嘛|干嘛|哎呀|咿呀/g;

/** Question marks: a particle right before one usually asks something. */
const QUESTION = /^[？?]$/;

/** Punctuation, symbols and spaces, which a sentence of only fillers may also hold. */
const NON_WORD = /[\p{P}\p{S}\s]/gu;

export type FillerConfidence = "high" | "maybe";

export interface FillerHit extends TextMatch {
  word: string;
  /** `high`: checked by default once its word is picked; `maybe`: may carry meaning, left unchecked. */
  confidence: FillerConfidence;
}

/** Text ranges covered by an exception word. */
function exceptionRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(FILLER_EXCEPTIONS)].map((match) => [match.index, match.index + match[0].length]);
}

/**
 * Sentences made of nothing but fillers and punctuation (「嗯。」「啊，呃……」). Deleting the
 * fillers would leave them empty, so they are offered as whole sentences, separately.
 */
export function wholeSentenceFillers(texts: readonly string[]): number[] {
  const indices: number[] = [];
  texts.forEach((text, index) => {
    const rest = text.replace(NON_WORD, "");
    if (rest === "") return;
    let remaining = rest;
    for (const word of FILLER_WORDS) remaining = remaining.split(word).join("");
    if (remaining === "") indices.push(index);
  });
  return indices;
}

/** The filler that starts at `at`, outside any exception word. */
function fillerAt(text: string, at: number, exceptions: ReadonlyArray<[number, number]>): string | undefined {
  if (exceptions.some(([start, end]) => at >= start && at < end)) return undefined;
  return FILLER_WORDS.find((word) => text.startsWith(word, at));
}

/**
 * Every filler occurrence a cleanup may delete, in reading order, outside sentences made only
 * of fillers (those are offered whole by `wholeSentenceFillers`).
 *
 * Hesitation sounds (嗯, 呃, 额) are high confidence. A particle (啊, 呢, 吧 …) is high
 * confidence at the start of the sentence or a clause, right before a pause mark, or doubled
 * up with another filler; it may carry meaning before a question mark, at the clause's end
 * (「好吧。」) or inside running text, and is offered unchecked there.
 */
export function fillerCandidates(texts: readonly string[]): FillerHit[] {
  const whole = new Set(wholeSentenceFillers(texts));
  const hits: FillerHit[] = [];
  texts.forEach((text, index) => {
    if (whole.has(index)) return;
    const exceptions = exceptionRanges(text);
    let at = 0;
    while (at < text.length) {
      const word = fillerAt(text, at, exceptions);
      if (word === undefined) {
        at += 1;
        continue;
      }
      hits.push({ index, start: at, end: at + word.length, word, confidence: "maybe" });
      at += word.length;
    }
    classify(text, hits.filter((hit) => hit.index === index));
  });
  return hits;
}

/** Sets each hit's confidence from what stands around it and the run of fillers it is in. */
function classify(text: string, hits: FillerHit[]): void {
  hits.forEach((hit, position) => {
    if (HESITATION.test(hit.word)) {
      hit.confidence = "high";
      return;
    }
    const previous = hits[position - 1];
    const next = hits[position + 1];
    const doubled = previous?.end === hit.start || next?.start === hit.end;
    // What follows the whole run of fillers this one belongs to.
    let runEnd = hit.end;
    for (let at = position + 1; hits[at]?.start === runEnd; at += 1) runEnd = hits[at]?.end ?? runEnd;
    const after = text[runEnd];
    const before = text[hit.start - 1];
    if (after !== undefined && QUESTION.test(after)) {
      hit.confidence = "maybe";
    } else if (doubled || before === undefined || isPause(before) || isClauseEnd(before) || isPause(after)) {
      hit.confidence = "high";
    } else {
      hit.confidence = "maybe";
    }
  });
}

/** Hits per filler word, in list order, for the word chips. */
export function fillerCounts(hits: readonly FillerHit[]): Array<{ word: string; count: number }> {
  return FILLER_WORDS.map((word) => ({ word, count: hits.filter((hit) => hit.word === word).length })).filter((entry) => entry.count > 0);
}

/** A short excerpt around a hit, split so the hit itself can be set in bold. */
export function hitContext(text: string, match: Pick<TextMatch, "start" | "end">, radius = 12): { before: string; hit: string; after: string; clippedStart: boolean; clippedEnd: boolean } {
  const from = Math.max(0, match.start - radius);
  const to = Math.min(text.length, match.end + radius);
  return {
    before: text.slice(from, match.start),
    hit: text.slice(match.start, match.end),
    after: text.slice(match.end, to),
    clippedStart: from > 0,
    clippedEnd: to < text.length,
  };
}
