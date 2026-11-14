import { Fragment, type CSSProperties } from "react";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { isMarked, readingSeparator } from "../../../shared/reading.ts";
import { DecoratedText } from "../../notes/decorated-text.tsx";
import type { SentenceNote } from "../../notes/note-anchor.ts";
import { formatDuration } from "../../format.ts";
import { termRanges } from "../../search/search.ts";
import type { ReaderTypography } from "./reader-typography.ts";

/** What the sentences of a paragraph are drawn with, the same in a plain paragraph and in a turn. */
export interface SentenceViewProps {
  /** The sentence the user picked (a citation, a search hit, a click). */
  selectedId: string | undefined;
  /** The sentence playing now: the primary highlight. */
  currentId: string | undefined;
  /** Further sentences covering the playing moment while sentences overlap: a weaker mark. */
  overlapIds: ReadonlySet<string>;
  changes: ReadonlyMap<string, "ai" | "user">;
  search: string;
  notes: ReadonlyMap<string, SentenceNote[]>;
  onOpenNotes: (segmentId: string, noteIds: string[]) => void;
  onSentence: (segment: TranscriptSegmentDto) => void;
}

/**
 * The reader's scroll box: scrollbar gutters reserved on both edges, so the column inside keeps
 * the same middle whether or not a scrollbar shows. Defined in the style sheet with the column.
 */
export const READER_SCROLLER_CLASS = "reader-scroller";
/**
 * The reading column every row is set in. It holds the user's side margin (`--reader-margin`) as
 * equal padding on both sides, narrowed alike only when the pane is too narrow for it, and sets
 * the reading size from `--reader-font-size`.
 */
export const READER_COLUMN_CLASS = "reader-column";
/** Marks a reading-column row that has no gutter of its own and indents to the text's edge. */
export const READER_INDENT_ATTRIBUTE = "data-reader-indent";
/** Space between paragraphs and between turns, in em so both follow the font size. */
export const PARAGRAPH_GAP_EM = 0.75;
export const TURN_GAP_EM = 1;
/**
 * Marks what the reader shows among the text but nobody said (a turn's speaker header, a play
 * button): a text selection leaves it out of what it takes.
 */
export const READER_META_ATTRIBUTE = "data-reader-meta";

/** Font size and line height of the reading body; everything inside sizes in em from here. */
export function readerBodyStyle(typography: Pick<ReaderTypography, "fontSize" | "lineHeight">): CSSProperties {
  return { fontSize: `${typography.fontSize}px`, lineHeight: typography.lineHeight };
}

/**
 * A paragraph's start time, opening its text: it plays from the paragraph's first sentence.
 * `data-reading-time` keeps it out of the text a selection takes. The type is small, so a
 * pseudo-element extends the hit area to 24px tall around it; being absolutely positioned, it
 * leaves the line box and the baseline to the text. The button's own line is no taller than its
 * type: its size follows the browser's font size, not the reading size, and a taller line would
 * push a small reading text's first line apart from the rest.
 */
export function ReaderTime(props: { startMs: number; onSeek: () => void }) {
  return (
    <button
      type="button"
      className="relative mr-2 font-mono text-xs leading-none text-accent hover:underline before:absolute before:inset-x-0 before:top-1/2 before:h-6 before:-translate-y-1/2 before:content-['']"
      data-reading-time
      onClick={props.onSeek}
    >
      {formatDuration(props.startMs)}
    </button>
  );
}

/**
 * The sentences of one paragraph as clickable runs, with the reading separators between them.
 * The separator is a bare text node so it is neither clickable nor marked as changed.
 */
export function SentenceRuns(props: SentenceViewProps & { segments: readonly TranscriptSegmentDto[] }) {
  return (
    <>
      {props.segments.map((segment, index) => {
        const change = props.changes.get(segment.id);
        const overlap = segment.id !== props.currentId && props.overlapIds.has(segment.id);
        const marks = [
          segment.id === props.selectedId ? "bg-accent-soft ring-1 ring-accent/50" : "",
          segment.id === props.currentId ? "underline decoration-accent decoration-2" : "",
          // Dotted and thinner: weaker by shape as well as by tone, so it does not rely on colour.
          overlap ? "bg-accent-soft/40 underline decoration-dotted decoration-accent/70 decoration-2" : "",
          change === "ai" ? "bg-sky-500/15" : change === "user" ? "bg-emerald-500/15" : "",
        ].join(" ");
        const previous = index === 0 ? undefined : props.segments[index - 1];
        return (
          <Fragment key={segment.id}>
            {previous === undefined ? null : readingSeparator(previous.text, segment.text, isMarked(previous))}
            <span
              data-segment-id={segment.id}
              {...(segment.id === props.currentId ? { "data-testid": "current-sentence" } : {})}
              {...(overlap ? { "data-overlap-current": "true" } : {})}
              {...(segment.id === props.selectedId ? { "aria-current": "true" as const } : {})}
              className={`cursor-pointer rounded hover:bg-sunken ${marks}`}
              onClick={() => {
                // The click that ends a drag selection is not a request to play from here.
                if (window.getSelection()?.isCollapsed === false) return;
                props.onSentence(segment);
              }}
            >
              <DecoratedText
                text={segment.text}
                notes={props.notes.get(segment.id) ?? []}
                search={props.search === "" ? [] : termRanges(segment.text, props.search)}
                onOpenNotes={(noteIds) => props.onOpenNotes(segment.id, noteIds)}
              />
            </span>
          </Fragment>
        );
      })}
    </>
  );
}
