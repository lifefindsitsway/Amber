/** One recognized word with the spacing that preceded it in the response. */
export interface MergeWord {
  text: string;
  startMs: number;
  endMs: number;
  /** A spacing token with whitespace came before it; Chinese words usually have none. */
  spaceBefore: boolean;
  speakerId?: string;
}

export interface MergedSentence {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
}

/**
 * Sentence parameters. Tuning may move a value only within fixed ranges and never changes
 * the rule order: pause 300–1500 ms, sentence length 15–60 s, 20–80 Chinese characters or
 * 15–60 words.
 */
export interface SentenceParams {
  name: "zh" | "default";
  /** A gap at least this long between two words ends a sentence. */
  pauseMs: number;
  maxDurationMs: number;
  /** In `unit`s; Chinese counts characters because it has no spaces between words. */
  maxUnits: number;
  unit: "chars" | "words";
}

// Tuned on the fixtures under test/fixtures/asr. Lecture Chinese runs at roughly 4–5
// characters a second, so 40 characters is a subtitle-sized sentence of 8–10 s; spoken
// English at about 2.5 words a second makes 35 words some 14 s. Pauses between clauses
// in Chinese lectures are shorter than the breaths English speakers take between sentences.
export const ZH_SENTENCE_PARAMS: SentenceParams = { name: "zh", pauseMs: 700, maxDurationMs: 20_000, maxUnits: 40, unit: "chars" };
export const DEFAULT_SENTENCE_PARAMS: SentenceParams = { name: "default", pauseMs: 800, maxDurationMs: 20_000, maxUnits: 35, unit: "words" };

/** One parameter set per transcript, chosen by its main language; never switched per sentence. */
export function sentenceParamsFor(language: string): SentenceParams {
  return language.split("-")[0]?.toLowerCase() === "zh" ? ZH_SENTENCE_PARAMS : DEFAULT_SENTENCE_PARAMS;
}

const SENTENCE_END = /[.!?。！？…]+["'”’」』)）]*$/u;
const FULL_STOP_ONLY = /(?<![.!?。！？…])\.["'”’」』)）]*$/u;
const CLAUSE_END = /[,，、;；:：]["'”’」』)）]*$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The speaker of every word. A word keeps the label the service gave it. A word without one
 * inherits only when the nearest labelled word before it and the nearest after it name the
 * same speaker and both are closer than the pause threshold; otherwise it stays unknown, so
 * a long silence or a change of voice never lends a speaker to a word nobody attributed.
 * Without any label the words come back untouched.
 */
export function resolveSpeakers(words: readonly MergeWord[], params: Pick<SentenceParams, "pauseMs">): readonly MergeWord[] {
  if (words.every((word) => word.speakerId === undefined)) {
    return words;
  }
  const previousLabelled: number[] = [];
  let last = -1;
  words.forEach((word, index) => {
    previousLabelled.push(last);
    if (word.speakerId !== undefined) {
      last = index;
    }
  });
  const nextLabelled: number[] = new Array<number>(words.length).fill(-1);
  let following = -1;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    nextLabelled[index] = following;
    if ((words[index] as MergeWord).speakerId !== undefined) {
      following = index;
    }
  }
  return words.map((word, index) => {
    if (word.speakerId !== undefined) {
      return word;
    }
    const before = words[previousLabelled[index] as number];
    const after = words[nextLabelled[index] as number];
    if (
      before?.speakerId !== undefined &&
      before.speakerId === after?.speakerId &&
      word.startMs - before.endMs < params.pauseMs &&
      after.startMs - word.endMs < params.pauseMs
    ) {
      return { ...word, speakerId: before.speakerId };
    }
    return word;
  });
}

/**
 * Groups words into sentences with a fixed rule order: a change of speaker (including
 * between a known and an unknown one) ends the sentence; a word ending in
 * sentence-final punctuation ends the sentence; otherwise a pause of `pauseMs` or more
 * before the next word does; a sentence that would outgrow `maxDurationMs` or `maxUnits`
 * is cut where the speaker most likely paused: after clause punctuation if it has any,
 * else at its longest gap between words (see `overflowCut`).
 *
 * Each sentence has `startMs < endMs`. Sentences of one speaker (or all without one) come
 * out ordered and non-overlapping: a start is moved to that stream's previous end when
 * words overlap, and a zero-length sentence is given one millisecond. Sentences of
 * different speakers keep their real times and may overlap.
 */
export function mergeSentences(rawWords: readonly MergeWord[], params: SentenceParams): MergedSentence[] {
  const words = resolveSpeakers(rawWords, params);
  const sentences: MergedSentence[] = [];
  // The previous end of each speaker's own sentences; unknown speakers share one stream.
  const previousEnds = new Map<string | undefined, number>();
  const flush = (group: readonly MergeWord[]): void => {
    const first = group[0];
    const last = group.at(-1);
    if (first === undefined || last === undefined) {
      return;
    }
    const startMs = Math.max(first.startMs, previousEnds.get(first.speakerId) ?? 0);
    const endMs = Math.max(last.endMs, startMs + 1);
    const text = group.map((word, index) => (index > 0 && word.spaceBefore ? ` ${word.text}` : word.text)).join("").trim();
    sentences.push({ startMs, endMs, text, ...(first.speakerId === undefined ? {} : { speakerId: first.speakerId }) });
    previousEnds.set(first.speakerId, endMs);
  };

  let current: MergeWord[] = [];
  words.forEach((word, index) => {
    if (current.length > 0 && (current[0] as MergeWord).speakerId !== word.speakerId) {
      flush(current);
      current = [];
    }
    if (current.length > 0 && overflows(current, word, params)) {
      const cut = overflowCut(current, word);
      flush(current.slice(0, cut));
      current = current.slice(cut);
      if (current.length > 0 && overflows(current, word, params)) {
        flush(current);
        current = [];
      }
    }
    current.push(word);
    const next = words[index + 1];
    if (endsSentence(word, next, params) || (next !== undefined && next.startMs - word.endMs >= params.pauseMs)) {
      flush(current);
      current = [];
    }
  });
  flush(current);
  return sentences;
}

function endsSentence(word: MergeWord, next: MergeWord | undefined, params: SentenceParams): boolean {
  const text = word.text.trim();
  if (!SENTENCE_END.test(text)) {
    return false;
  }
  // In space-separated text a lone full stop before a lowercase word is an abbreviation.
  if (params.unit === "words" && FULL_STOP_ONLY.test(text) && next !== undefined && /^\p{Ll}/u.test(next.text.trim())) {
    return false;
  }
  return true;
}

function overflows(current: readonly MergeWord[], next: MergeWord, params: SentenceParams): boolean {
  const first = current[0] as MergeWord;
  if (next.endMs - first.startMs > params.maxDurationMs) {
    return true;
  }
  const units = current.reduce((sum, word) => sum + unitsOf(word.text, params), 0);
  return units + unitsOf(next.text, params) > params.maxUnits;
}

/** Characters for Chinese (a Latin word or number inside counts as one), words otherwise. */
export function unitsOf(text: string, params: Pick<SentenceParams, "unit">): number {
  if (params.unit === "chars") {
    const cjk = text.match(CJK)?.length ?? 0;
    return cjk > 0 ? cjk : LETTER_OR_DIGIT.test(text) ? 1 : 0;
  }
  return LETTER_OR_DIGIT.test(text) ? 1 : 0;
}

/**
 * Where to cut a sentence that cannot take `next`, as the number of words that stay in
 * it: after the clause punctuation followed by the longest gap, or, without clause
 * punctuation, at the longest gap including the one before `next`. Ties go to the later
 * position, so evenly paced speech is cut right before `next`.
 */
function overflowCut(current: readonly MergeWord[], next: MergeWord): number {
  const positions = current.map((word, index) => ({
    index,
    gap: (current[index + 1] ?? next).startMs - word.endMs,
    clause: index < current.length - 1 && CLAUSE_END.test(word.text.trim()),
  }));
  const clauses = positions.filter((position) => position.clause);
  const candidates = clauses.length > 0 ? clauses : positions;
  let best: (typeof positions)[number] | undefined;
  for (const position of candidates) {
    if (best === undefined || position.gap >= best.gap) {
      best = position;
    }
  }
  return (best as (typeof positions)[number]).index + 1;
}
