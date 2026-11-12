import { CornerDownRight, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { speakerModeFor } from "../../../shared/speaker-turns.ts";
import { formatDuration } from "../../format.ts";
import { useSegments } from "./content-data.ts";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerLabel, useSpeakers } from "./speakers/speaker-data.ts";

/**
 * What 「播放这句」 can do with the mounted player: `play` plays the sentence and stops at
 * its end, `jump` only moves there (a player the page cannot start or read the time of),
 * `unsupported` offers nothing.
 */
export interface SentencePlayback {
  mode: "play" | "jump" | "unsupported";
  playRange: (startMs: number, endMs: number) => void;
}

/** A cited sentence as its card shows it; `speaker` only while its revision is read by speakers. */
export interface CitedSentence {
  segment: TranscriptSegmentDto;
  speaker?: SpeakerDto;
}

/**
 * The sentences of `revisionId` by id, each with its speaker when the revision is read by
 * speakers (a single anonymous speaker says nothing worth a card line). The speaker list is
 * only asked for when a sentence names a speaker.
 */
export function useCitedSentences(contentId: string, revisionId: string | undefined): (segmentId: string) => CitedSentence | undefined {
  const segments = useSegments(revisionId);
  const named = useMemo(() => (segments.data ?? []).some((segment) => segment.speakerId !== undefined), [segments.data]);
  const speakers = useSpeakers(contentId, named);
  const lookup = useMemo(() => {
    const list = segments.data ?? [];
    const roster = speakers.data?.items ?? [];
    const byId = new Map(roster.map((speaker) => [speaker.id, speaker]));
    const withSpeakers = named && speakerModeFor(list, roster);
    return new Map(
      list.map((segment) => {
        const speaker = withSpeakers && segment.speakerId !== undefined ? byId.get(segment.speakerId) : undefined;
        return [segment.id, speaker === undefined ? { segment } : { segment, speaker }] as const;
      }),
    );
  }, [segments.data, speakers.data, named]);
  return (segmentId) => lookup.get(segmentId);
}

/** How long the pointer may be away (crossing the gap to the card) before the card closes. */
const CLOSE_DELAY_MS = 150;

/**
 * Wraps a citation badge with a small card: the cited sentence, who says it, and
 * 「播放这句」 (「跳到这句」 when the player can only be moved). It opens on hover and on
 * keyboard focus; it is rendered right after the badge, so Tab moves from the badge into
 * the card's action, and Esc closes it and returns to the badge. Without a known sentence the
 * badge is left as it is.
 */
export function CitationCard(props: { contentId: string; cited: CitedSentence | undefined; playback: SentencePlayback; children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Esc hands focus back to the badge; that focus must not open the card again.
  const dismissed = useRef(false);
  useEffect(() => () => clearTimeout(closing.current), []);
  if (props.cited === undefined) return <>{props.children}</>;
  const { segment, speaker } = props.cited;
  const show = (): void => {
    clearTimeout(closing.current);
    setOpen(true);
  };
  const hideSoon = (): void => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const onFocus = (): void => {
    if (dismissed.current) dismissed.current = false;
    else show();
  };
  const onBlur = (event: FocusEvent<HTMLSpanElement>): void => {
    if (!(event.relatedTarget instanceof Node && wrapper.current?.contains(event.relatedTarget))) setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    dismissed.current = true;
    wrapper.current?.querySelector<HTMLElement>("[data-citation]")?.focus();
    dismissed.current = false;
  };
  const action = props.playback.mode;
  return (
    <span ref={wrapper} className="relative inline-block" onPointerEnter={show} onPointerLeave={hideSoon} onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
      {props.children}
      {open ? (
        <span
          role="group"
          aria-label={t("speakerContext.citation.card")}
          className="absolute top-full left-0 z-30 mt-1 block w-64 rounded-md border border-line bg-surface p-2 text-left text-xs leading-5 font-normal text-ink not-italic shadow-lg"
          data-testid="citation-card"
        >
          <span className="flex items-center gap-1.5 text-muted">
            {speaker === undefined ? null : (
              <>
                <SpeakerAvatar contentId={props.contentId} speaker={speaker} size={18} decorative />
                <span className="truncate font-medium text-ink" data-testid="citation-card-speaker">
                  {speakerLabel(t, speaker)}
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="font-mono">{formatDuration(segment.startMs)}</span>
          </span>
          <span className="mt-1 line-clamp-3 block">{segment.text}</span>
          {action === "unsupported" ? null : (
            <button
              type="button"
              className="mt-1.5 inline-flex h-6 items-center gap-1 rounded px-1.5 text-accent hover:bg-sunken"
              onClick={() => props.playback.playRange(segment.startMs, segment.endMs)}
              data-testid="citation-card-play"
            >
              {action === "play" ? <Play size={12} aria-hidden="true" /> : <CornerDownRight size={12} aria-hidden="true" />}
              {action === "play" ? t("speakerContext.citation.play") : t("speakerContext.citation.jump")}
            </button>
          )}
        </span>
      ) : null}
    </span>
  );
}
