import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerContextDto } from "../../../shared/dto/speaker-context.ts";
import { speakerModeFor } from "../../../shared/speaker-turns.ts";
import { useRevisions, useSegments } from "./content-data.ts";
import { speakerBasisNotice, speakersNotRead, type TranscriptSpeakerState } from "./speaker-basis.ts";
import { useSpeakers } from "./speakers/speaker-data.ts";

/**
 * Whether `revisionId` is read by speakers and whether they are reviewed; undefined while
 * any of it is loading or without a revision. The speaker list is only asked for when a
 * sentence names a speaker, so a text without speakers costs no extra request.
 */
export function useTranscriptSpeakerState(contentId: string, revisionId: string | undefined): TranscriptSpeakerState | undefined {
  const revisions = useRevisions(contentId);
  const segments = useSegments(revisionId);
  const named = useMemo(() => (segments.data ?? []).some((segment) => segment.speakerId !== undefined), [segments.data]);
  const speakers = useSpeakers(contentId, named);
  const speakerMode = useMemo(
    () => (segments.data === undefined ? undefined : named ? (speakers.data === undefined ? undefined : speakerModeFor(segments.data, speakers.data.items)) : false),
    [segments.data, named, speakers.data],
  );
  if (revisionId === undefined || revisions.data === undefined || speakerMode === undefined) return undefined;
  const revision = revisions.data.revisions.find((item) => item.id === revisionId);
  return { speakerMode, confirmed: revision?.speakersConfirmedAt !== undefined };
}

/**
 * The single line an AI result shows about the speakers it was generated with (or could be
 * generated with now). Text, not colour, carries the state; it is a note, so a screen reader
 * reads it with the result rather than announcing it.
 */
export function SpeakerBasisLine(props: {
  contentId: string;
  primaryRevisionId: string | undefined;
  stale: boolean;
  speakerContext: SpeakerContextDto | undefined;
  testId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  // The primary's state only matters for a result made without speakers; otherwise nothing extra is read.
  const needsPrimary = !props.stale && props.speakerContext === undefined;
  const primary = useTranscriptSpeakerState(props.contentId, needsPrimary ? props.primaryRevisionId : undefined);
  const notice = speakerBasisNotice(t, { stale: props.stale, speakerContext: props.speakerContext, primary });
  if (notice === undefined) return null;
  return (
    <p role="note" className={`text-xs text-muted ${props.className ?? ""}`} data-testid={props.testId} data-state={notice.state}>
      {notice.text}
    </p>
  );
}

/**
 * 「发言人未核对，本次不读取」 beside a generation entry, while the transcript it reads is
 * read by speakers that are not reviewed. Never a confirmation step: it only says what the
 * request will leave out.
 */
export function SpeakersNotReadHint(props: { contentId: string; revisionId: string | undefined; testId: string; className?: string }) {
  const { t } = useTranslation();
  const state = useTranscriptSpeakerState(props.contentId, props.revisionId);
  if (!speakersNotRead(state)) return null;
  return (
    <span className={`text-xs text-muted ${props.className ?? ""}`} data-testid={props.testId}>
      {t("speakerContext.notRead")}
    </span>
  );
}
