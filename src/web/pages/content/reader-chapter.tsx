import { Play } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "../../format.ts";

/** One title line, in the title's own em. */
const TITLE_LINE = 1.35;
/**
 * The title's type. `em` here is the reading font size the column sets, so the title follows the
 * reader's size within readable bounds. The play button's slot repeats it so that one line height
 * in em is exactly one title line in both.
 */
const TITLE_TYPE: CSSProperties = { fontSize: `clamp(${["18px", "1.25em", "36px"].join(", ")})`, lineHeight: TITLE_LINE };

/**
 * A chapter start inside the reading view: a boundary above paragraphs. `seek` is where its
 * section starts playing, absent when no sentence of the section is shown; `first` marks the
 * heading that opens the list.
 *
 * The root carries no font size and no inline padding: its vertical space is in reading-font ems,
 * and its left edge is the text's left edge. Its text is the title alone, so copying or reading
 * the row yields just the title.
 */
export function ChapterHeading(props: { title: string; first: boolean; seek?: { ms: number; onSeek: () => void } }) {
  const { t } = useTranslation();
  const { seek } = props;
  const label = seek === undefined ? "" : t("contentView.transcript.chapterPlay", { time: formatDuration(seek.ms) });
  return (
    <div className={`group flex items-start gap-1 ${props.first ? "pt-[0.25em]" : "pt-[1.5em]"} pb-[0.5em]`} data-testid="transcript-chapter">
      <h3
        className={`min-w-0 font-semibold break-words ${seek === undefined ? "" : "cursor-pointer"}`}
        style={TITLE_TYPE}
        data-testid="chapter-title"
        // The title stays plain selectable text; the play button below is the keyboard path to the
        // same action, so the click here is a pointer convenience only.
        onClick={
          seek === undefined
            ? undefined
            : () => {
                // A click that ends a drag selection is not a request to play.
                if (window.getSelection()?.isCollapsed === false) return;
                seek.onSeek();
              }
        }
      >
        {props.title}
      </h3>
      {seek === undefined ? null : (
        // Exactly one title line tall and outside the heading, so the button sits on the first line
        // after the title, never makes the row taller (a 24px button fits the smallest 18px × 1.35
        // line), and leaves the heading's accessible name to the title alone.
        <span className="flex shrink-0 items-center" style={{ ...TITLE_TYPE, height: `${TITLE_LINE}em` }}>
          <button
            type="button"
            aria-label={label}
            title={label}
            data-testid="chapter-play"
            data-reader-meta=""
            // Revealed like the row menus: on hovering the heading row or on keyboard focus, always on
            // touch screens. Opacity keeps it focusable while it is not shown.
            className="flex size-6 items-center justify-center rounded text-muted opacity-0 group-hover:opacity-100 hover:bg-sunken hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none pointer-coarse:opacity-100"
            onClick={() => seek.onSeek()}
          >
            <Play size={14} aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}
