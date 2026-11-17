import { ReadingBreaks, readingSections, type ReadingChapter, type ReadingSentence } from "./reading.ts";

/**
 * Paragraph marks of a transcript draft, as pure functions shared by the editor and the
 * server, so what the editor shows is what a commit keeps.
 *
 * A draft is in one of two modes. Without explicit paragraphs no sentence carries
 * `paragraphStart`, and a commit inherits the base revision's marks through the sentences'
 * sources. With explicit paragraphs every sentence carries a boolean, the first one `true`,
 * and a commit takes them as they are. Any other mix is invalid. Every operation here returns
 * a new array and keeps unchanged items as the same objects, so undo snapshots share them.
 */

/** What the paragraph rules read of a draft sentence. */
export interface ParagraphItem {
  paragraphStart?: boolean;
}

/** Why a draft's paragraph marks are invalid: some sentences carry one and others not, or the first does not open a paragraph. */
export type ParagraphProblem = "mixed" | "first_not_start";

/** `undefined` when the marks are valid: none at all, or one on every sentence with the first `true`. An empty draft is valid. */
export function validateParagraphState(items: readonly ParagraphItem[]): ParagraphProblem | undefined {
  const first = items[0];
  if (first === undefined) return undefined;
  const explicit = first.paragraphStart !== undefined;
  for (const item of items) {
    if ((item.paragraphStart !== undefined) !== explicit) return "mixed";
  }
  return explicit && first.paragraphStart !== true ? "first_not_start" : undefined;
}

/** Whether a (valid) draft has explicit paragraphs. */
export function hasExplicitParagraphs(items: readonly ParagraphItem[]): boolean {
  return items[0]?.paragraphStart !== undefined;
}

/**
 * The paragraph marks a sentence list inherits from its base: a sentence takes the mark of its
 * first source sentence; when one source was split into several sentences only the first of
 * them may open a paragraph; a sentence without sources opens none; the first sentence always
 * does. When the list dropped a sentence that opened a paragraph, the next base sentence the
 * list still uses opens it instead, so deleting a paragraph's first sentence does not merge the
 * rest into the paragraph before (several dropped openers in a row still open one paragraph).
 * A base without marks yields none, so an edit never invents paragraphs nobody marked.
 *
 * `base` must iterate in sentence order: "the next base sentence" is taken from it.
 */
export function inheritedParagraphStarts(
  base: ReadonlyMap<string, ParagraphItem>,
  drafted: ReadonlyArray<{ sourceSegmentIds: readonly string[] }>,
): Array<boolean | undefined> {
  let marked = false;
  for (const segment of base.values()) {
    marked ||= segment.paragraphStart !== undefined;
  }
  if (!marked) {
    return drafted.map(() => undefined);
  }
  const kept = new Set(drafted.flatMap((segment) => segment.sourceSegmentIds));
  const opens = new Set<string>();
  let carried = false;
  for (const [id, segment] of base) {
    const start = segment.paragraphStart === true;
    if (kept.has(id)) {
      if (start || carried) {
        opens.add(id);
      }
      carried = false;
    } else {
      carried ||= start;
    }
  }
  let previousFirst: string | undefined;
  return drafted.map((segment, index) => {
    const first = segment.sourceSegmentIds[0];
    const inherited = first !== undefined && first !== previousFirst && opens.has(first);
    previousFirst = first;
    return index === 0 || inherited;
  });
}

/**
 * Gives every sentence an explicit mark: `starts[index]` (the first sentence always `true`).
 * A draft that already has explicit paragraphs is returned unchanged.
 */
export function materializeParagraphs<T extends ParagraphItem>(items: readonly T[], starts: readonly boolean[]): T[] {
  if (hasExplicitParagraphs(items)) return [...items];
  return items.map((item, index) => ({ ...item, paragraphStart: index === 0 || starts[index] === true }));
}

/**
 * Where an unmarked transcript's paragraphs start as the reading view shows them: chapter
 * starts, changes of speaker, and the readability fallback of `ReadingBreaks` inside each
 * chapter. This is what a draft freezes when it first gets explicit paragraphs, so turning a
 * transcript's paragraphs explicit changes nothing a reader sees. Marks the sentences carry are
 * ignored: this is only asked of drafts without them.
 */
export function derivedParagraphStarts(sentences: readonly ReadingSentence[], chapters: readonly ReadingChapter[]): boolean[] {
  const starts = new Array<boolean>(sentences.length).fill(false);
  const indexOf = new Map<ReadingSentence, number>();
  sentences.forEach((sentence, index) => indexOf.set(sentence, index));
  for (const section of readingSections(sentences, chapters)) {
    const breaks = new ReadingBreaks();
    for (const sentence of section.sentences) {
      const { paragraphStart: _ignored, looseJoin: _loose, ...unmarked } = sentence;
      void _ignored;
      void _loose;
      if (breaks.push(unmarked)) starts[indexOf.get(sentence) as number] = true;
    }
  }
  return starts;
}

/**
 * Indices of the sentences a chapter starts at, as the reading view projects chapters onto
 * sentences by time. The very first sentence is included only when a chapter starts there.
 */
export function chapterStartIndices(sentences: readonly ReadingSentence[], chapters: readonly ReadingChapter[]): Set<number> {
  const indices = new Set<number>();
  const indexOf = new Map<ReadingSentence, number>();
  sentences.forEach((sentence, index) => indexOf.set(sentence, index));
  for (const section of readingSections(sentences, chapters)) {
    const first = section.sentences[0];
    if (section.chapter !== undefined && first !== undefined) indices.add(indexOf.get(first) as number);
  }
  return indices;
}

function withStart<T extends ParagraphItem>(items: readonly T[], index: number, value: boolean): T[] {
  if (!hasExplicitParagraphs(items)) {
    throw new Error("paragraph operations need explicit paragraphs; materialize the draft first");
  }
  if (index <= 0 || index >= items.length) {
    throw new Error(`no sentence at ${index} whose paragraph start may change`);
  }
  const item = items[index] as T;
  if (item.paragraphStart === value) return [...items];
  const next = [...items];
  next[index] = { ...item, paragraphStart: value };
  return next;
}

/** Starts a new paragraph at the sentence at `index` (not the first). The draft must have explicit paragraphs. */
export function splitParagraph<T extends ParagraphItem>(items: readonly T[], index: number): T[] {
  return withStart(items, index, true);
}

/**
 * Joins the paragraph starting at `index` (not the first) to the one before. The draft must have
 * explicit paragraphs. A change of speaker or a chapter start there still breaks the paragraph
 * when it is read; callers offer the action only where it has an effect.
 */
export function mergeParagraph<T extends ParagraphItem>(items: readonly T[], index: number): T[] {
  return withStart(items, index, false);
}

/**
 * Fixes the marks right after a sentence was cut in two, the halves at `leftIndex` and
 * `leftIndex + 1` both carrying the original's mark: the left half keeps it and the right half
 * opens a paragraph only when `rightStarts`. Without explicit paragraphs nothing changes, and
 * `rightStarts` must be false: materialize the draft before splitting to start one.
 */
export function splitSentenceWithParagraphs<T extends ParagraphItem>(split: readonly T[], leftIndex: number, rightStarts: boolean): T[] {
  if (!hasExplicitParagraphs(split)) {
    if (rightStarts) throw new Error("starting a paragraph at a split needs explicit paragraphs; materialize the draft first");
    return [...split];
  }
  const right = split[leftIndex + 1];
  if (right === undefined || split[leftIndex] === undefined) throw new Error(`no split halves at ${leftIndex}`);
  if (right.paragraphStart === rightStarts) return [...split];
  const next = [...split];
  next[leftIndex + 1] = { ...right, paragraphStart: rightStarts };
  return next;
}

/**
 * Drops the sentences at `remove`. With explicit paragraphs a dropped sentence that opened a
 * paragraph hands that on to the next sentence kept, so the rest of its paragraph does not
 * merge into the one before; several dropped openers in a row still open one paragraph, and
 * one dropped at the very end opens nothing. The first sentence kept always opens one.
 */
export function removeSentencesWithParagraphs<T extends ParagraphItem>(items: readonly T[], remove: ReadonlySet<number>): T[] {
  const explicit = hasExplicitParagraphs(items);
  const next: T[] = [];
  let carried = false;
  items.forEach((item, index) => {
    if (remove.has(index)) {
      carried ||= explicit && item.paragraphStart === true;
      return;
    }
    const opens = explicit && (next.length === 0 || carried) && item.paragraphStart !== true;
    next.push(opens ? { ...item, paragraphStart: true } : item);
    carried = false;
  });
  return next;
}

/** Why a paragraph start cannot be merged into the paragraph before: the first sentence, a chapter start, or a change of speaker. */
export type MergeBlock = "first" | "chapter" | "speaker";

/**
 * What opens a paragraph at a sentence in the editor: explicit marks (or, without them, the
 * derived starts), changes of speaker and chapter starts, each reported apart so the editor
 * can say why a start cannot be merged.
 */
export interface ParagraphStartInfo {
  /** The sentence opens a paragraph, for any of the reasons. */
  start: boolean;
  /** `undefined` when "merge into the paragraph before" applies (an explicit or derived start only). */
  mergeBlock?: MergeBlock;
}

/**
 * Paragraph starts of a draft as the editor shows them. `speakers[i]` is the sentence's
 * effective speaker (`null` or `undefined` = unassigned); `chapterStarts` from
 * `chapterStartIndices`; `derived` from `derivedParagraphStarts`, used only while the draft has
 * no explicit paragraphs.
 */
export function paragraphStartInfo(
  items: readonly ParagraphItem[],
  speakers: ReadonlyArray<string | null | undefined>,
  chapterStarts: ReadonlySet<number>,
  derived: readonly boolean[],
): ParagraphStartInfo[] {
  const explicit = hasExplicitParagraphs(items);
  return items.map((item, index) => {
    if (index === 0) return { start: true, mergeBlock: "first" };
    if (chapterStarts.has(index)) return { start: true, mergeBlock: "chapter" };
    if ((speakers[index] ?? null) !== (speakers[index - 1] ?? null)) return { start: true, mergeBlock: "speaker" };
    return { start: explicit ? item.paragraphStart === true : derived[index] === true };
  });
}
