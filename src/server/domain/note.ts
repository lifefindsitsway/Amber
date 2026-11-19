import { NOTE_SPAN_MAX_SEGMENTS } from "../../shared/defaults.ts";
import type { NoteColor, NoteMark } from "../../shared/enums.ts";
import { isMarked, readingSeparator } from "../../shared/reading.ts";
import type { TranscriptRevision, TranscriptSegment } from "./transcript.ts";

/**
 * A user's mark on a span of one transcript revision. The anchor
 * (revision, sentences, offsets) and `quote` never change after creation; offsets are
 * UTF-16 code units inside the sentence text.
 */
export interface Note {
  id: string;
  userId: string;
  contentId: string;
  transcriptRevisionId: string;
  startSegmentId: string;
  startOffset: number;
  endSegmentId: string;
  endOffset: number;
  quote: string;
  mark: NoteMark;
  color: NoteColor;
  comment?: string;
  /**
   * The id this note had on the device a content pack carried it from; absent for one created
   * here. Its transfer identity is `originId ?? id`. Written on insert only.
   */
  originId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Where a note sits: a revision, its first and last sentence and the offsets inside them. */
export type NoteAnchor = Pick<Note, "transcriptRevisionId" | "startSegmentId" | "startOffset" | "endSegmentId" | "endOffset">;

/** What anchor checks need from a sentence. */
interface AnchorSentence {
  id: string;
  revisionId: string;
  ordinal: number;
  text: string;
}

/**
 * Why an anchor is refused: `anchor` for one outside its revision, out of order or cutting a
 * character in half; `span` for one covering more than `NOTE_SPAN_MAX_SEGMENTS` sentences.
 */
export type NoteAnchorProblem = "anchor" | "span";

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Whether `offset` falls between the two halves of a UTF-16 surrogate pair, i.e. inside one character. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length && isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset));
}

/**
 * Checks an anchor against its revision and its two end sentences. The
 * revision must already be known to belong to the note's Content; `start` / `end` are the
 * sentences looked up by id, `undefined` when there is no such sentence. Offsets are
 * `0 ≤ startOffset < len(start)` and `0 < endOffset ≤ len(end)`, ordered within one
 * sentence; translations are not read in the transcript view and so never anchor a note.
 */
export function noteAnchorProblem(
  anchor: NoteAnchor,
  revision: Pick<TranscriptRevision, "id" | "kind">,
  start: AnchorSentence | undefined,
  end: AnchorSentence | undefined,
): NoteAnchorProblem | undefined {
  if (revision.kind === "translated" || anchor.transcriptRevisionId !== revision.id) {
    return "anchor";
  }
  if (start === undefined || end === undefined || start.revisionId !== revision.id || end.revisionId !== revision.id) {
    return "anchor";
  }
  const { startOffset, endOffset } = anchor;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || start.ordinal > end.ordinal) {
    return "anchor";
  }
  if (startOffset < 0 || startOffset >= start.text.length || endOffset <= 0 || endOffset > end.text.length) {
    return "anchor";
  }
  if (start.id === end.id && startOffset >= endOffset) {
    return "anchor";
  }
  if (splitsSurrogatePair(start.text, startOffset) || splitsSurrogatePair(end.text, endOffset)) {
    return "anchor";
  }
  return end.ordinal - start.ordinal + 1 > NOTE_SPAN_MAX_SEGMENTS ? "span" : undefined;
}

/**
 * The anchored text as stored in `quote`, cut from the server's own copy of
 * the sentences rather than trusted from the client. `range` is the sentences from the
 * start to the end sentence in reading order. Within one sentence it is the plain slice;
 * across sentences the start's tail, every middle sentence whole and the end's head, joined
 * by the reading separator that the two full neighbouring sentences call for;
 * the sentences must keep `paragraphStart` and `looseJoin` as read from storage, which tell
 * whether their revision joins as a marked one, exactly as the reading view joins them.
 */
export function noteQuote(
  range: ReadonlyArray<Pick<TranscriptSegment, "text" | "paragraphStart" | "looseJoin">>,
  startOffset: number,
  endOffset: number,
): string {
  const first = range[0];
  if (first === undefined) {
    return "";
  }
  if (range.length === 1) {
    return first.text.slice(startOffset, endOffset);
  }
  let quote = first.text.slice(startOffset);
  for (let index = 1; index < range.length; index += 1) {
    const previous = range[index - 1];
    const before = previous?.text ?? "";
    const sentence = range[index]?.text ?? "";
    const piece = index === range.length - 1 ? sentence.slice(0, endOffset) : sentence;
    quote += readingSeparator(before, sentence, previous !== undefined && isMarked(previous)) + piece;
  }
  return quote;
}
