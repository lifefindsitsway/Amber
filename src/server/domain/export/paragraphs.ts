import { isMarked, ReadingBreaks, readingSeparator } from "../../../shared/reading.ts";
import { oneLine } from "./cues.ts";

/** A reading paragraph: consecutive sentences joined, with the start of the first one. */
export interface Paragraph {
  startMs: number;
  text: string;
  /** The speaker of the paragraph's sentences; a change of speaker always starts a paragraph. */
  speakerId?: string;
}

/**
 * Groups sentences into paragraphs exactly the way the transcript view reads them: the
 * break and joining rules are the shared `ReadingBreaks` /
 * `readingSeparator`, so a TXT export and the reading view never disagree. Sentences must
 * keep their `paragraphStart`, since it decides both the breaks and how a sentence without
 * closing punctuation joins the next. Sentences are fed one at a time, so a long transcript
 * never has to be held whole.
 */
export class ParagraphBuilder {
  private breaks = new ReadingBreaks();
  private current: Paragraph | undefined;

  /** Adds a sentence; returns the paragraph it closed, if any. */
  push(sentence: { startMs: number; endMs: number; text: string; speakerId?: string; paragraphStart?: boolean }): Paragraph | undefined {
    const text = oneLine(sentence.text).trim();
    let closed: Paragraph | undefined;
    if (this.breaks.push({ ...sentence, text }) && this.current !== undefined) {
      closed = this.current;
      this.current = undefined;
    }
    if (this.current === undefined) {
      this.current = { startMs: sentence.startMs, text, ...(sentence.speakerId === undefined ? {} : { speakerId: sentence.speakerId }) };
    } else if (text !== "") {
      this.current.text = this.current.text === "" ? text : `${this.current.text}${readingSeparator(this.current.text, text, isMarked(sentence))}${text}`;
    }
    return closed;
  }

  /**
   * The paragraph still open, if any. Closing it also forgets the running paragraph, so the
   * next sentence starts a fresh one: callers flush at a chapter start and at
   * the end.
   */
  flush(): Paragraph | undefined {
    const open = this.current;
    this.current = undefined;
    this.breaks = new ReadingBreaks();
    return open;
  }
}
