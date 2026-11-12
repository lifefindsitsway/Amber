import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto } from "../../../../../shared/dto/speaker.ts";
import type { SpeakerReviewDto } from "../../../../../shared/dto/transcript.ts";
import { ApiError } from "../../../../api/client.ts";
import { refreshSpeakerReviewViews } from "../../../../api/content-events.ts";
import { ErrorView } from "../../../../components/error-view.tsx";
import { formatDateTime } from "../../../../format.ts";
import { Button } from "../../../../ui/button.tsx";
import { Loading } from "../../../../ui/feedback.tsx";
import { SpeakerAvatar } from "../speaker-avatar.tsx";
import { speakerLabel, useSetSpeakersConfirmed, useSpeakerReview, useSpeakers } from "../speaker-data.ts";
import { SPEAKER_POPOVER_CLASS } from "../speaker-edit-popover.tsx";
import { ReviewSampleList, type SampleListSentence } from "./review-sample-list.tsx";
import { SpeakerReviewBadge } from "./speaker-review-badge.tsx";

/** What the panel needs to know about the revision it reviews. */
export interface SpeakerReviewTarget {
  contentId: string;
  revisionId: string;
  /** The revision's sentences in reading order, once loaded: for the samples and each speaker's first turn. */
  sentences: readonly SampleListSentence[] | undefined;
  /** Scrolls the reader to a sentence: the first one of the speaker picked in the roster. */
  onLocate: (segmentId: string) => void;
  /** The cross-recognition summary shown under 「辅助核对」, when there is one to show. */
  crossCheck?: ReactNode;
}

/** The share of the speaker's assigned time as the roster writes it. */
function shareText(t: TFunction, assignedMs: number, totalMs: number): string {
  if (totalMs <= 0) return t("speakerReview.panel.share", { percent: 0 });
  const percent = Math.round((assignedMs / totalMs) * 100);
  return assignedMs > 0 && percent < 1 ? t("speakerReview.panel.shareLow") : t("speakerReview.panel.share", { percent });
}

/**
 * Reviewing who said what in one revision. Only numbers with a stored source: speakers,
 * unassigned sentences and names still to confirm; the sentences committed on accepted
 * suggestions and those still waiting in the draft get a line each, only when there are any.
 * A revision keeps no per-sentence "unsure" state, so there is no such count. The roster is in
 * order of first appearance and leads to each speaker's first turn. 「辅助核对」 (folded) holds
 * the sampled clips and the cross-recognition summary. Confirming sends the roster digest
 * that was read, so a window showing an older roster is refused; the panel then reads the
 * roster again and says so. No paid action starts from here.
 */
export function SpeakerReviewPanel(props: SpeakerReviewTarget & { titleId?: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const fallbackTitleId = useId();
  const titleId = props.titleId ?? fallbackTitleId;
  const review = useSpeakerReview(props.contentId, props.revisionId);
  const speakerList = useSpeakers(props.contentId);
  const setConfirmed = useSetSpeakersConfirmed(props.contentId);
  const [assistOpen, setAssistOpen] = useState(false);
  const [rosterChanged, setRosterChanged] = useState(false);
  const speakers = useMemo(() => new Map((speakerList.data?.items ?? []).map((speaker) => [speaker.id, speaker])), [speakerList.data]);
  const firstSentence = useMemo(() => {
    const first = new Map<string, string>();
    for (const sentence of props.sentences ?? []) {
      if (sentence.speakerId !== undefined && !first.has(sentence.speakerId)) first.set(sentence.speakerId, sentence.id);
    }
    return first;
  }, [props.sentences]);

  const submit = (data: SpeakerReviewDto, confirmed: boolean): void => {
    setRosterChanged(false);
    setConfirmed.mutate(
      { revisionId: data.revisionId, request: confirmed ? { confirmed: true, expectedRosterDigest: data.rosterDigest } : { confirmed: false } },
      {
        onError: (error) => {
          if (error instanceof ApiError && error.error.code === "conflict.speakers_changed") {
            // The roster this window showed is not the current one: read it again, confirm nothing.
            setRosterChanged(true);
            setConfirmed.reset();
            void refreshSpeakerReviewViews(queryClient, props.contentId);
          }
        },
      },
    );
  };

  const header = (
    <header className="flex flex-col gap-0.5 px-3 pt-3 pb-2">
      <h3 id={titleId} className="text-sm font-semibold">
        {t("speakerReview.panel.title")}
      </h3>
      <p className="text-xs text-muted">{t("speakerReview.panel.subtitle")}</p>
    </header>
  );
  if (review.isError) {
    return (
      <div data-testid="speaker-review-panel">
        {header}
        <p className="px-3 pb-3 text-xs text-danger" role="alert">
          {t("speakerReview.panel.loadFailed")}
        </p>
      </div>
    );
  }
  const data = review.data;
  if (data === undefined || speakerList.data === undefined) {
    return (
      <div data-testid="speaker-review-panel">
        {header}
        <Loading />
      </div>
    );
  }
  const totalMs = data.speakers.reduce((sum, entry) => sum + entry.assignedMs, 0);
  const failure = setConfirmed.error instanceof ApiError ? setConfirmed.error : undefined;
  const stats: Array<[string, string, number]> = [
    ["speakers", t("speakerReview.panel.stats.speakers"), data.speakers.length],
    ["unassigned", t("speakerReview.panel.stats.unassigned"), data.unassigned],
    ["pending-names", t("speakerReview.panel.stats.pendingNames"), data.pendingNames],
  ];

  return (
    <div className="flex flex-col" data-testid="speaker-review-panel">
      {header}
      <dl className="grid grid-cols-3 gap-2 px-3 pb-2" aria-label={t("speakerReview.panel.stats.label")}>
        {stats.map(([key, label, value]) => (
          <div key={key} className="flex flex-col rounded-md bg-sunken/60 px-2 py-1.5" data-testid={`speaker-review-stat-${key}`}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="text-base font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {data.acceptedSuggestions === undefined && data.draftNeedsReview === undefined ? null : (
        <ul className="flex flex-col gap-0.5 px-3 pb-2 text-xs text-muted">
          {data.acceptedSuggestions === undefined ? null : <li data-testid="speaker-review-accepted">{t("speakerReview.panel.acceptedSuggestions", { count: data.acceptedSuggestions })}</li>}
          {data.draftNeedsReview === undefined ? null : <li data-testid="speaker-review-draft">{t("speakerReview.panel.draftNeedsReview", { count: data.draftNeedsReview })}</li>}
        </ul>
      )}
      <section className="border-t border-line py-1.5" aria-labelledby={`${titleId}-roster`}>
        <h4 id={`${titleId}-roster`} className="px-3 pb-1 text-xs font-medium text-muted">
          {t("speakerReview.panel.roster")}
        </h4>
        <ul data-testid="speaker-review-roster">
          {data.speakers.map((entry) => {
            const speaker = speakers.get(entry.id);
            if (speaker === undefined) return null;
            return <RosterRow key={entry.id} contentId={props.contentId} speaker={speaker} sentences={entry.sentences} share={shareText(t, entry.assignedMs, totalMs)} firstSentence={firstSentence.get(entry.id)} onLocate={props.onLocate} />;
          })}
        </ul>
      </section>
      <section className="border-t border-line py-1">
        <button
          type="button"
          aria-expanded={assistOpen}
          aria-controls={`${titleId}-assist`}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          onClick={() => setAssistOpen(!assistOpen)}
          data-testid="speaker-review-assist-toggle"
        >
          {assistOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          {t("speakerReview.panel.assist")}
        </button>
        {assistOpen ? (
          <div id={`${titleId}-assist`} className="flex flex-col gap-3 px-3 pt-1 pb-2" data-testid="speaker-review-assist">
            {props.sentences === undefined ? <Loading /> : <ReviewSampleList contentId={props.contentId} sentences={props.sentences} speakers={speakers} />}
            {props.crossCheck === undefined ? null : <div data-testid="speaker-review-cross-check">{props.crossCheck}</div>}
          </div>
        ) : null}
      </section>
      <p className="border-t border-line px-3 py-2 text-xs text-muted" data-testid="speaker-review-disclaimer">
        {t("speakerReview.panel.disclaimer")}
      </p>
      {rosterChanged ? (
        <p className="px-3 pb-2 text-xs text-danger" role="alert" data-testid="speaker-review-roster-changed">
          {t("speakerReview.panel.rosterChanged")}
        </p>
      ) : null}
      {failure === undefined ? null : (
        <div className="px-3 pb-2">
          <ErrorView error={failure.error} />
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-3 py-2.5" data-testid="speaker-review-footer">
        {data.confirmedAt === undefined ? (
          <Button size="sm" variant="primary" disabled={setConfirmed.isPending || review.isFetching} onClick={() => submit(data, true)} data-testid="speaker-review-confirm">
            {t("speakerReview.panel.confirm")}
          </Button>
        ) : (
          <>
            <span className="mr-auto text-xs text-muted" data-testid="speaker-review-confirmed-at">
              {t("speakerReview.panel.confirmedAt", { time: formatDateTime(data.confirmedAt, i18n.language) })}
            </span>
            <Button size="sm" disabled={setConfirmed.isPending} onClick={() => submit(data, false)} data-testid="speaker-review-unconfirm">
              {t("speakerReview.panel.unconfirm")}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

function RosterRow(props: { contentId: string; speaker: SpeakerDto; sentences: number; share: string; firstSentence: string | undefined; onLocate: (segmentId: string) => void }) {
  const { t } = useTranslation();
  const name = speakerLabel(t, props.speaker);
  const pendingName = props.speaker.name !== undefined && props.speaker.nameConfirmed !== true;
  const { firstSentence, onLocate } = props;
  return (
    <li data-testid="speaker-review-roster-row" data-speaker-id={props.speaker.id}>
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-default"
        aria-label={t("speakerReview.panel.locate", { name })}
        disabled={firstSentence === undefined}
        onClick={() => {
          if (firstSentence !== undefined) onLocate(firstSentence);
        }}
        data-testid="speaker-review-locate"
      >
        <SpeakerAvatar contentId={props.contentId} speaker={props.speaker} size={28} decorative />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium" title={name}>
              {name}
            </span>
            {pendingName ? (
              <span className="shrink-0 rounded border border-dashed border-muted/70 px-1 text-[11px] text-muted" data-testid="speaker-review-name-pending">
                {t("speakerReview.panel.namePending")}
              </span>
            ) : null}
          </span>
          <span className="block truncate text-xs text-muted tabular-nums">
            {t("speakerReview.panel.sentences", { count: props.sentences })}
            {" · "}
            {props.share}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The review mark with its panel, for the reader's toolbar beside the revision picker; only in
 * speaker mode (nothing otherwise). The mark reads the review; until it arrives the revision
 * list's `speakersConfirmedAt` stands in. Picking a speaker in the roster closes the panel and
 * locates their first turn.
 */
export function SpeakerReviewControl(props: SpeakerReviewTarget & { speakerMode: boolean; speakersConfirmedAt?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const review = useSpeakerReview(props.contentId, props.speakerMode ? props.revisionId : undefined);
  if (!props.speakerMode || review.isError) return null;
  const confirmed = review.data === undefined ? props.speakersConfirmedAt !== undefined : review.data.confirmedAt !== undefined;
  const { onLocate } = props;
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <SpeakerReviewBadge confirmed={confirmed} pendingNames={review.data?.pendingNames ?? 0} aria-haspopup="dialog" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={`${SPEAKER_POPOVER_CLASS} w-[24rem] max-w-[calc(100vw-16px)]`}
          aria-labelledby={titleId}
          data-testid="speaker-review-popover"
        >
          <SpeakerReviewPanel
            {...props}
            titleId={titleId}
            onLocate={(segmentId) => {
              setOpen(false);
              onLocate(segmentId);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
