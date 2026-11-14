import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import type { SpeakerShare } from "../../../shared/speaker-turns.ts";
import type { Paragraph } from "./content-data.ts";
import { READER_TEXT_ATTRIBUTE } from "./reader-font.ts";
import { PARAGRAPH_GAP_EM, READER_COLUMN_CLASS, READER_META_ATTRIBUTE, READER_SCROLLER_CLASS, ReaderTime, readerBodyStyle, SentenceRuns, TURN_GAP_EM, type SentenceViewProps } from "./reader-sentences.tsx";
import { MARKER_FADE_MS, TURN_HEADER_ATTRIBUTE, TURN_KEY_ATTRIBUTE, TURN_SPEAKER_ATTRIBUTE, useFadedTurn, type StickyTurn } from "./reader-sticky.ts";
import type { TurnPlace } from "./reader-rows.ts";
import type { ReaderTypography } from "./reader-typography.ts";
import { SpeakerAvatar, AVATAR_EM_SIZE } from "./speakers/speaker-avatar.tsx";
import { speakerColorVars } from "./speakers/speaker-colors.ts";
import { speakerLabel } from "./speakers/speaker-data.ts";
import { SpeakerIdentityCard } from "./speakers/speaker-identity-card.tsx";

/** Below this width of the reading pane the gutter gives way to avatar and name above the text. */
export const READER_NARROW_MAX_PX = 520;

/** Space between the avatar and the name, and so the gutter's width beyond the avatar, in em. */
const GUTTER_GAP_EM = 0.75;
/**
 * The gutter's width in a wide speaker layout: the avatar and the gap after it. Rows without a
 * gutter of their own (chapter headings) indent by it so they line up with the names and the text.
 */
export const READER_GUTTER = `calc(${AVATAR_EM_SIZE} + ${GUTTER_GAP_EM}em)`;
/** The same gap as a class, for the avatar that is followed by its name. */
const GUTTER_GAP_CLASS = "mr-[0.75em]";

/** Everything a turn needs to know besides its own paragraph. */
export interface TurnContext {
  contentId: string;
  speakers: ReadonlyMap<string, SpeakerDto>;
  shares: ReadonlyMap<string, SpeakerShare>;
  typography: Pick<ReaderTypography, "fontSize" | "lineHeight">;
  /** The pane is narrow: no gutter, the header sits above the text. */
  narrow: boolean;
}

/** The avatar's diameter as a custom property, so the line, the gutter and the name column agree with it. */
const AVATAR_VAR = "--reader-avatar";

const rowStyle = (context: TurnContext, turn: TurnPlace): CSSProperties =>
  ({
    ...readerBodyStyle(context.typography),
    [AVATAR_VAR]: AVATAR_EM_SIZE,
    paddingBottom: `${turn.last ? TURN_GAP_EM : PARAGRAPH_GAP_EM}em`,
  }) as CSSProperties;

// The text column takes what the reading column leaves after the gutter.
const GRID_COLUMNS: CSSProperties = { gridTemplateColumns: [`calc(var(${AVATAR_VAR}) + ${GUTTER_GAP_EM}em)`, `minmax(${["0", "1fr"].join(", ")})`].join(" ") };

/** Marks a turn's paragraph as sentence text, which takes the reading font; the header around it keeps the UI font. */
const READER_TEXT = { [READER_TEXT_ATTRIBUTE]: "" };

const TRIGGER_CLASS = "inline-flex min-w-0 items-center rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Who a turn belongs to: the avatar and the name, as one control that opens the identity
 * card. A speaker the list does not know, and sentences nobody was assigned to, show the
 * neutral avatar and 「未分配」 and open nothing. The avatar sits beside the written name, so
 * it is decorative.
 */
function SpeakerTag(props: { context: TurnContext; speakerId: string | undefined }) {
  const { t } = useTranslation();
  const { context } = props;
  const speaker = props.speakerId === undefined ? undefined : context.speakers.get(props.speakerId);
  if (speaker === undefined) {
    return (
      <span className="inline-flex min-w-0 items-center" data-testid="turn-speaker" data-unassigned="true">
        <SpeakerAvatar unassigned size="em" decorative className={GUTTER_GAP_CLASS} />
        <span className="truncate font-semibold text-muted">{t("speakerIdentity.unassigned")}</span>
      </span>
    );
  }
  const label = speakerLabel(t, speaker);
  const share = context.shares.get(speaker.id);
  return (
    <SpeakerIdentityCard
      contentId={context.contentId}
      speaker={speaker}
      {...(share === undefined ? {} : { sentences: share.sentences, durationShare: share.share })}
      triggerClassName={TRIGGER_CLASS}
      testId="turn-speaker"
    >
      <SpeakerAvatar contentId={context.contentId} speaker={speaker} size="em" decorative className={GUTTER_GAP_CLASS} />
      <span className="truncate font-semibold" style={{ color: speakerColorVars(speaker.colorIndex).fg }} title={label}>
        {label}
      </span>
    </SpeakerIdentityCard>
  );
}

/** The accessible name of a turn header: who speaks. Each paragraph's time button says when. */
function useTurnLabel(context: TurnContext, turn: TurnPlace): string {
  const { t } = useTranslation();
  const speaker = turn.speakerId === undefined ? undefined : context.speakers.get(turn.speakerId);
  return speaker === undefined ? t("speakerIdentity.unassigned") : speakerLabel(t, speaker);
}

/** The line a turn's paragraphs share, in the speaker's colour; it runs on through the gap to the next paragraph of the turn. */
function TurnLine(props: { context: TurnContext; turn: TurnPlace }) {
  const speaker = props.turn.speakerId === undefined ? undefined : props.context.speakers.get(props.turn.speakerId);
  const color = speaker === undefined ? "var(--color-line)" : `color-mix(${["in srgb", `${speakerColorVars(speaker.colorIndex).fg} 55%`, "transparent"].join(", ")})`;
  return (
    <div className="relative" aria-hidden="true">
      <span
        data-testid="turn-line"
        className="absolute w-0.5 rounded-full"
        style={{
          left: `calc(var(${AVATAR_VAR}) / 2 - 1px)`,
          top: props.turn.first ? "0.25em" : 0,
          bottom: props.turn.last ? 0 : `-${PARAGRAPH_GAP_EM}em`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}

/**
 * One paragraph of a speaker turn. The turn's first paragraph carries the header (avatar and
 * name) on a line of its own; every paragraph opens with its time and sits under the turn's
 * line. A narrow pane drops the gutter and the line.
 */
export function TurnParagraph(props: SentenceViewProps & { context: TurnContext; paragraph: Paragraph; turn: TurnPlace; onSeekParagraph: () => void }) {
  const { context, paragraph, turn } = props;
  const label = useTurnLabel(context, turn);
  const marker = { [TURN_KEY_ATTRIBUTE]: turn.key, [TURN_SPEAKER_ATTRIBUTE]: turn.speakerId ?? "" };
  const style = rowStyle(context, turn);
  const text = (
    <p className="break-words" {...READER_TEXT} style={context.narrow && turn.first ? { marginTop: "0.25em" } : undefined}>
      <ReaderTime startMs={paragraph.startMs} onSeek={props.onSeekParagraph} />
      <SentenceRuns {...props} segments={paragraph.segments} />
    </p>
  );

  // Not said by anyone: a selection across turns leaves the speaker's name out.
  const header = turn.first ? (
    <div
      role="group"
      aria-label={label}
      {...{ [TURN_HEADER_ATTRIBUTE]: "", [READER_META_ATTRIBUTE]: "" }}
      data-testid="turn-header"
      className="flex min-w-0 items-center"
      style={{ minHeight: `var(${AVATAR_VAR})` }}
    >
      <SpeakerTag context={context} speakerId={turn.speakerId} />
    </div>
  ) : null;

  if (context.narrow) {
    return (
      <div {...marker} data-turn-layout="narrow" style={style}>
        {header}
        {text}
      </div>
    );
  }
  return (
    <div {...marker} data-turn-layout="wide" style={style}>
      {header}
      <div className="grid" style={GRID_COLUMNS}>
        <TurnLine context={context} turn={turn} />
        {text}
      </div>
    </div>
  );
}

/**
 * The small avatar at the top of the gutter while a long turn goes on and its header has
 * scrolled away. It never takes pointer input and is hidden from assistive technology (the
 * turn header already names the speaker); it fades in and out rather than jumping.
 */
export function StickyTurnMarker(props: {
  contentId: string;
  speakers: ReadonlyMap<string, SpeakerDto>;
  turn: StickyTurn | undefined;
  typography: Pick<ReaderTypography, "fontSize" | "lineHeight">;
}) {
  const { shown, visible } = useFadedTurn(props.turn);
  const speaker = shown?.speakerId === undefined ? undefined : props.speakers.get(shown.speakerId);
  return (
    // A still copy of the reader's box: the same scrollbar gutters and reading column (with its
    // margin) as the scroller, so the marker's column starts exactly where the rows' avatars do at any
    // width and font size, without measuring the rows.
    <div aria-hidden="true" className={`${READER_SCROLLER_CLASS} pointer-events-none absolute inset-0 z-10 overflow-hidden`}>
      <div className={`${READER_COLUMN_CLASS} relative`}>
        <div
          aria-hidden="true"
          data-testid="turn-marker"
          data-visible={visible ? "true" : "false"}
          className={`absolute top-0 flex justify-center transition-opacity motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`}
          // The column's margin is its padding, which an absolute box does not respect: start where the rows' avatars do.
          style={{ insetInlineStart: "var(--reader-inset)", width: AVATAR_EM_SIZE, fontSize: `${props.typography.fontSize}px`, transitionDuration: `${MARKER_FADE_MS}ms` }}
        >
          {shown === undefined ? null : (
            <span className="rounded-full bg-surface" data-speaker-id={shown.speakerId ?? ""}>
              {speaker === undefined ? (
                <SpeakerAvatar unassigned size="em" variant="muted" decorative />
              ) : (
                <SpeakerAvatar contentId={props.contentId} speaker={speaker} size="em" variant="muted" decorative />
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Whether the element is narrower than `READER_NARROW_MAX_PX`, followed as it resizes. Before
 * the first measurement (or where nothing can be measured) the pane counts as wide.
 */
export function useIsNarrow(element: HTMLElement | null): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (element === null) return;
    const measure = (width: number): void => setNarrow(width > 0 && width < READER_NARROW_MAX_PX);
    measure(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return narrow;
}
