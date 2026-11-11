import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import type { SpeakerShare } from "../../../shared/speaker-turns.ts";
import { formatDuration } from "../../format.ts";
import type { Paragraph } from "./content-data.ts";
import { PARAGRAPH_GAP_EM, READER_MEASURE_EM, readerBodyStyle, SentenceRuns, TURN_GAP_EM, type SentenceViewProps } from "./reader-sentences.tsx";
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

const GRID_COLUMNS: CSSProperties = { gridTemplateColumns: [`calc(var(${AVATAR_VAR}) + ${GUTTER_GAP_EM}em)`, `minmax(0, ${READER_MEASURE_EM}em)`].join(" ") };

const TRIGGER_CLASS = "inline-flex min-w-0 items-center rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A time button with the reader's usual look; it seeks like a paragraph's time does. */
function TimeButton(props: { ms: number; onSeek: () => void; className?: string }) {
  return (
    <button type="button" className={`font-mono text-xs text-accent hover:underline ${props.className ?? ""}`} data-reading-time onClick={props.onSeek}>
      {formatDuration(props.ms)}
    </button>
  );
}

/**
 * Who a turn belongs to: the avatar and the name, as one control that opens the identity
 * card. A speaker the list does not know, and sentences nobody was assigned to, show the
 * neutral avatar and 「未分配」 and open nothing.
 */
function SpeakerTag(props: { context: TurnContext; speakerId: string | undefined; part?: "both" | "avatar" | "name" }) {
  const { t } = useTranslation();
  const { context } = props;
  const part = props.part ?? "both";
  const speaker = props.speakerId === undefined ? undefined : context.speakers.get(props.speakerId);
  const avatarClass = part === "both" ? GUTTER_GAP_CLASS : "";
  if (speaker === undefined) {
    return (
      <span className="inline-flex min-w-0 items-center" data-testid="turn-speaker" data-unassigned="true">
        {part === "name" ? null : <SpeakerAvatar unassigned size="em" decorative={part === "both"} className={avatarClass} />}
        {part === "avatar" ? null : <span className="truncate font-semibold text-muted">{t("speakerIdentity.unassigned")}</span>}
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
      {part === "name" ? null : <SpeakerAvatar contentId={context.contentId} speaker={speaker} size="em" decorative={part === "both"} className={avatarClass} />}
      {part === "avatar" ? null : (
        <span className="truncate font-semibold" style={{ color: speakerColorVars(speaker.colorIndex).fg }} title={label}>
          {label}
        </span>
      )}
    </SpeakerIdentityCard>
  );
}

/**
 * Takes the avatar button of a compact row out of the tab order: the name beside it opens the
 * same card, and two stops for one control only slow the keyboard down. The button belongs to
 * the identity card, which has no prop for this.
 */
function skipTabStop(element: HTMLElement | null): void {
  element?.querySelector("button")?.setAttribute("tabindex", "-1");
}

/** The accessible name of a turn header: who and when. */
function useTurnLabel(context: TurnContext, turn: TurnPlace): string {
  const { t } = useTranslation();
  const speaker = turn.speakerId === undefined ? undefined : context.speakers.get(turn.speakerId);
  return t("speakerReader.turn.label", { name: speaker === undefined ? t("speakerIdentity.unassigned") : speakerLabel(t, speaker), time: formatDuration(turn.startMs) });
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
 * One paragraph of a speaker turn. The turn's first paragraph carries the header (avatar,
 * name, start time); the others sit under the same line. A short turn is one compact row:
 * the avatar in the gutter, the name running inline at the start of the text. A narrow pane
 * drops the gutter and puts the header above the text.
 */
export function TurnParagraph(props: SentenceViewProps & { context: TurnContext; paragraph: Paragraph; turn: TurnPlace; onSeekParagraph: () => void }) {
  const { context, paragraph, turn } = props;
  const label = useTurnLabel(context, turn);
  const marker = { [TURN_KEY_ATTRIBUTE]: turn.key, [TURN_SPEAKER_ATTRIBUTE]: turn.speakerId ?? "" };
  const runs = <SentenceRuns {...props} segments={paragraph.segments} />;
  const style = rowStyle(context, turn);
  const measure: CSSProperties = { maxWidth: `${READER_MEASURE_EM}em` };
  const time = <TimeButton ms={paragraph.startMs} onSeek={props.onSeekParagraph} className="mr-2" />;

  if (turn.compact && !context.narrow) {
    return (
      <div {...marker} role="group" aria-label={label} data-turn-layout="compact" className="grid items-start" style={{ ...style, ...GRID_COLUMNS }}>
        <div {...{ [TURN_HEADER_ATTRIBUTE]: "" }} data-reading-time ref={skipTabStop} style={{ marginTop: `calc((1lh - var(${AVATAR_VAR})) / 2)` }}>
          <SpeakerTag context={context} speakerId={turn.speakerId} part="avatar" />
        </div>
        <p className="break-words">
          <span data-reading-time className="mr-2 inline-block max-w-full align-bottom">
            <SpeakerTag context={context} speakerId={turn.speakerId} part="name" />
          </span>
          {time}
          {runs}
        </p>
      </div>
    );
  }

  const header = turn.first ? (
    <div
      role="group"
      aria-label={label}
      {...{ [TURN_HEADER_ATTRIBUTE]: "" }}
      data-reading-time
      data-testid="turn-header"
      className="flex min-w-0 items-center gap-2"
      style={{ minHeight: `var(${AVATAR_VAR})`, maxWidth: context.narrow ? `${READER_MEASURE_EM}em` : `calc(var(${AVATAR_VAR}) + ${GUTTER_GAP_EM}em + ${READER_MEASURE_EM}em)` }}
    >
      <SpeakerTag context={context} speakerId={turn.speakerId} />
      <TimeButton ms={turn.startMs} onSeek={props.onSeekParagraph} className="shrink-0" />
    </div>
  ) : null;

  if (context.narrow) {
    return (
      <div {...marker} data-turn-layout="narrow" style={style}>
        {header}
        <p className="break-words" style={{ ...measure, ...(header === null ? {} : { marginTop: "0.25em" }) }}>
          {turn.first ? null : time}
          {runs}
        </p>
      </div>
    );
  }
  return (
    <div {...marker} data-turn-layout="wide" style={style}>
      {header}
      <div className="grid" style={GRID_COLUMNS}>
        <TurnLine context={context} turn={turn} />
        <p className="break-words">
          {turn.first ? null : time}
          {runs}
        </p>
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
    <div
      aria-hidden="true"
      data-testid="turn-marker"
      data-visible={visible ? "true" : "false"}
      // The reader's scroller pads 1rem on the left and 0.5rem on top; the marker sits in its gutter.
      className={`pointer-events-none absolute z-10 flex justify-center transition-opacity motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`}
      style={{ left: "1rem", top: "0.5rem", width: AVATAR_EM_SIZE, fontSize: `${props.typography.fontSize}px`, transitionDuration: `${MARKER_FADE_MS}ms` }}
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
