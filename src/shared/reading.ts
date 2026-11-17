import { PARAGRAPH_GAP_MS, PARAGRAPH_MAX_CHARS } from "./defaults.ts";

/** What the reading rules need from a sentence; transcript segments and export cues both fit. */
export interface ReadingSentence {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  /** Paragraph start as proofreading or a manual edit marked it; absent on revisions without marks. */
  paragraphStart?: boolean;
  /**
   * The sentence's revision has paragraph marks but joins its sentences as an unmarked one
   * does (an unproofread transcript paragraphed by hand). Absent = false.
   */
  looseJoin?: boolean;
}

/** CJK letters and the full-width punctuation blocks: text that runs on without spaces. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/**
 * Punctuation a proofreading pass may add or change without changing what was said:
 * sentence and clause marks, quotes and brackets. Hyphens, `#`, `@`, `%`, `&`, `_`, `+` and
 * `/` are content (`-I`, `10%`, `#tag`) and are deliberately absent.
 */
const SYNTAX_PUNCTUATION = new Set("。，！？；：、,.!?;:「」『』“”‘’\"'（）()…—【】《》〈〉[]");

/** Marks that end a sentence; a closing quote or bracket may follow them. */
const SENTENCE_END = new Set("。！？.!?…");
const CLOSING = new Set("”’\"'』」】）》〉)]");

function lastChar(text: string): string {
  return text.at(-1) ?? "";
}

/** Whether `text` ends a sentence, allowing closing quotes or brackets after the final mark. */
export function endsSentence(text: string): boolean {
  let end = text.trimEnd().length;
  while (end > 0 && CLOSING.has(text[end - 1] ?? "")) {
    end -= 1;
  }
  return end > 0 && SENTENCE_END.has(text[end - 1] ?? "");
}

/** The last character of `text` that is not syntax punctuation or whitespace, if any. */
function lastContentChar(text: string): string {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index] ?? "";
    if (!SYNTAX_PUNCTUATION.has(char) && !/\s/u.test(char)) {
      return char;
    }
  }
  return "";
}

/**
 * Whether the revision a sentence belongs to carries paragraph marks, which then decide where
 * its paragraphs break. Marks are all-or-nothing within a revision, so any one of its
 * sentences answers for all of them.
 */
export function hasParagraphs(sentence: { paragraphStart?: boolean }): boolean {
  return sentence.paragraphStart !== undefined;
}

/**
 * Whether a sentence's revision joins its sentences as a proofread one does: it has paragraph
 * marks and is not loosely joined. Proofreading restored the punctuation, so a bare sentence
 * end there means one sentence runs across two time slices. A transcript paragraphed by hand
 * without proofreading keeps the unmarked joining, so its text reads exactly as before.
 */
export function isMarked(sentence: { paragraphStart?: boolean; looseJoin?: boolean }): boolean {
  return sentence.paragraphStart !== undefined && sentence.looseJoin !== true;
}

/**
 * What goes between two consecutive sentences when they are shown or copied as running
 * text: nothing after full-width punctuation, nothing after ASCII
 * punctuation that closes a CJK sentence continued in CJK (`第一句.第二句`), and a space
 * everywhere else, including after an English sentence that is followed by CJK. Where the
 * first sentence has no closing punctuation the revision decides: in a `marked` one the
 * punctuation was restored, so a bare end means one sentence runs across two time slices
 * and CJK on both sides is joined directly; an unmarked transcript gets a space so it stays
 * readable without punctuation.
 */
export function readingSeparator(before: string, after: string, marked: boolean): string {
  if (before === "" || after === "") {
    return "";
  }
  const last = lastChar(before);
  if (!SYNTAX_PUNCTUATION.has(last)) {
    return marked && WIDE.test(last) && WIDE.test(after[0] ?? "") ? "" : " ";
  }
  if (WIDE.test(last)) {
    return "";
  }
  return WIDE.test(after[0] ?? "") && WIDE.test(lastContentChar(before)) ? "" : " ";
}

/** Joins sentences of one revision with `readingSeparator`; empty texts contribute nothing. */
export function joinReading(texts: readonly string[], marked: boolean): string {
  let joined = "";
  for (const text of texts) {
    const trimmed = text.trim();
    if (trimmed === "") {
      continue;
    }
    joined = joined === "" ? trimmed : `${joined}${readingSeparator(joined, trimmed, marked)}${trimmed}`;
  }
  return joined;
}

/**
 * Decides where reading paragraphs break. Paragraphs follow the
 * content: a revision whose sentences carry `paragraphStart` (proofreading or a manual edit
 * marked them) breaks exactly at the marked sentences and at a change of speaker, which the
 * proofreading protocol cannot see; pauses and length play no part. A revision without marks
 * falls back to readability rules so an unproofread transcript is not one wall of text: a
 * pause longer than `PARAGRAPH_GAP_MS` or a change of speaker; once a paragraph holds
 * `PARAGRAPH_MAX_CHARS`, the next sentence that ends with a sentence mark; twice the cap in
 * any case. A sentence is never split, so one long sentence may exceed the cap on its own.
 * The mode is fixed by the first sentence, since marks are all-or-nothing within a revision.
 * Sentences are fed one at a time, which lets a long transcript stream through without
 * being held whole.
 */
export class ReadingBreaks {
  private last: ReadingSentence | undefined;
  private chars = 0;
  private semantic = false;

  /** Feeds the next sentence; `true` when it starts a new paragraph (always for the first). */
  push(sentence: ReadingSentence): boolean {
    if (this.last === undefined) {
      this.semantic = hasParagraphs(sentence);
    }
    const breaks = this.last === undefined || this.breaksAfter(this.last, sentence);
    if (breaks) {
      this.chars = 0;
    }
    this.chars += sentence.text.trim().length;
    this.last = sentence;
    return breaks;
  }

  private breaksAfter(previous: ReadingSentence, next: ReadingSentence): boolean {
    if (next.speakerId !== previous.speakerId) {
      return true;
    }
    if (this.semantic) {
      return next.paragraphStart === true;
    }
    if (next.startMs - previous.endMs > PARAGRAPH_GAP_MS) {
      return true;
    }
    if (this.chars >= PARAGRAPH_MAX_CHARS * 2) {
      return true;
    }
    return this.chars >= PARAGRAPH_MAX_CHARS && endsSentence(previous.text);
  }
}

export interface ReadingParagraph<T extends ReadingSentence> {
  startMs: number;
  speakerId?: string;
  segments: T[];
}

/** Groups sentences into reading paragraphs with `ReadingBreaks`; the batch form for views that hold the transcript. */
export function readingParagraphs<T extends ReadingSentence>(sentences: readonly T[]): ReadingParagraph<T>[] {
  const paragraphs: ReadingParagraph<T>[] = [];
  const breaks = new ReadingBreaks();
  for (const sentence of sentences) {
    const current = paragraphs.at(-1);
    if (breaks.push(sentence) || current === undefined) {
      paragraphs.push({ startMs: sentence.startMs, ...(sentence.speakerId === undefined ? {} : { speakerId: sentence.speakerId }), segments: [sentence] });
    } else {
      current.segments.push(sentence);
    }
  }
  return paragraphs;
}

/** A chapter as the reading rules need it: where it starts and what to call it. */
export interface ReadingChapter {
  startMs: number;
  title: string;
}

export interface ReadingSection<T extends ReadingSentence> {
  /** Absent for the sentences before the first chapter. */
  chapter?: ReadingChapter;
  sentences: T[];
}

/**
 * Splits sentences into chapter sections: a chapter start is a boundary above
 * paragraphs, so each section is paragraphed on its own. Chapters are projected by time — a
 * sentence belongs to the last chapter starting at or before it — which makes them apply to
 * any revision of the Content, not only the one they were made from. Sentences before the
 * first chapter form an untitled leading section; chapters without a sentence are dropped.
 */
export function readingSections<T extends ReadingSentence>(sentences: readonly T[], chapters: readonly ReadingChapter[]): ReadingSection<T>[] {
  const ordered = [...chapters].sort((a, b) => a.startMs - b.startMs);
  const sections: ReadingSection<T>[] = [];
  let next = 0;
  for (const sentence of sentences) {
    // Several chapters may start before this sentence; the latest one takes it.
    let opened: ReadingChapter | undefined;
    while (next < ordered.length && (ordered[next] as ReadingChapter).startMs <= sentence.startMs) {
      opened = ordered[next];
      next += 1;
    }
    const current = sections.at(-1);
    if (opened !== undefined || current === undefined) {
      sections.push({ ...(opened === undefined ? {} : { chapter: opened }), sentences: [sentence] });
    } else {
      current.sentences.push(sentence);
    }
  }
  return sections;
}

function withoutSyntaxPunctuation(text: string): string {
  let kept = "";
  for (const char of text) {
    if (!SYNTAX_PUNCTUATION.has(char) && !/\s/u.test(char)) {
      kept += char;
    }
  }
  return kept;
}

/**
 * Whether two texts differ only in syntax punctuation and whitespace: what a proofreading
 * pass adds when it restores punctuation, which the reading view does not mark as an AI
 * change. Any other character, including `-`, `%` or `#`, counts as a change.
 */
export function isOnlyPunctuationChange(before: string, after: string): boolean {
  return before !== after && withoutSyntaxPunctuation(before) === withoutSyntaxPunctuation(after);
}
