import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { HighlightRevisionDto } from "../../../shared/dto/highlight.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { useProviders, useSettings } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { TaskFlow } from "../../components/task-flow.tsx";
import { formatDuration } from "../../format.ts";
import { HighlightBand, highlightTone } from "../../player/timeline.tsx";
import { Button } from "../../ui/button.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, useHighlights } from "./content-data.ts";
import { visibleHighlights } from "./highlight-items.ts";
import { useSentenceMenu } from "./sentence-menu.tsx";
import { SpeakerBasisLine, SpeakersNotReadHint, useTranscriptSpeakerState } from "./speaker-basis-notice.tsx";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerLabel, useSpeakers } from "./speakers/speaker-data.ts";

/**
 * AI 高光 tab: colour timeline, score threshold, explicit (re)generation
 * and the highlighted sentences. Opening it only reads; generating asks first.
 */
export function HighlightsTab() {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const contentId = page.content.id;
  const highlights = useHighlights(contentId);
  const providers = useProviders();
  const settings = useSettings();

  const recompute = useMutation({
    mutationFn: () =>
      client.post(`/api/contents/${encodeURIComponent(contentId)}/highlights/recompute`, taskAcceptedDtoSchema, {
        body: settings.data?.defaultModelRef === undefined ? {} : { modelRef: settings.data.defaultModelRef },
        idempotent: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.highlights(contentId) });
    },
  });

  if (highlights.isPending) return <Loading />;
  if (highlights.isError) {
    return highlights.error instanceof ApiError ? <ErrorView error={highlights.error.error} /> : <EmptyState title={t("common.state.loadFailed")} />;
  }
  const { current, activeTaskId } = highlights.data;
  const configured = (providers.data?.items.length ?? 0) > 0;
  const hasTranscript = page.primaryRevisionId !== undefined;
  const label = current === undefined ? t("contentView.highlights.generate") : t("contentView.highlights.regenerate");

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="highlights-tab">
      <div className="flex flex-wrap items-center gap-2">
        {configured ? (
          <Button
            size="sm"
            variant={current === undefined ? "primary" : "secondary"}
            disabled={activeTaskId !== undefined || !hasTranscript || recompute.isPending}
            onClick={() => recompute.mutate()}
            data-testid="highlights-generate"
          >
            {current === undefined ? <Sparkles size={14} /> : <RefreshCw size={14} />}
            {label}
          </Button>
        ) : (
          <Link to="/settings/models" className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs" data-testid="highlights-configure">
            {t("common.action.goConfigure")}
          </Link>
        )}
        {configured && hasTranscript ? <SpeakersNotReadHint contentId={contentId} revisionId={page.primaryRevisionId} testId="highlights-speakers-not-read" /> : null}
        <ThresholdSlider />
      </div>
      {!configured ? <p className="text-xs text-muted">{t("contentView.summary.needsModel")}</p> : null}
      {!hasTranscript ? <p className="text-xs text-muted">{t("contentView.highlights.needsTranscript")}</p> : null}
      {recompute.error instanceof ApiError ? <ErrorView error={recompute.error.error} /> : null}
      {activeTaskId === undefined ? null : <TaskFlow taskId={activeTaskId} />}
      {current?.stale === true ? (
        <div className="rounded-md border border-line bg-accent-soft px-3 py-2 text-xs" data-testid="highlights-stale">
          {t(`contentView.stale.${current.staleReason ?? "transcript_changed"}`)}
        </div>
      ) : null}
      {current === undefined ? null : (
        <SpeakerBasisLine
          contentId={contentId}
          primaryRevisionId={page.primaryRevisionId}
          stale={current.stale}
          speakerContext={current.speakerContext}
          testId="highlights-speaker-basis"
        />
      )}
      {current === undefined ? (
        <EmptyState title={t("contentView.highlights.empty")} hint={t("contentView.highlights.emptyHint")} />
      ) : (
        <HighlightList revision={current} />
      )}
    </div>
  );
}

function ThresholdSlider() {
  const { t } = useTranslation();
  const page = useContentPage();
  return (
    <label className="ml-auto flex items-center gap-2 text-xs">
      <span className="text-muted">{t("contentView.highlights.threshold")}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={page.highlightThreshold}
        onChange={(event) => page.setHighlightThreshold(Number(event.target.value))}
        data-testid="highlights-threshold"
        aria-label={t("contentView.highlights.threshold")}
      />
      <span className="w-14 font-mono">{t("contentView.highlights.thresholdValue", { value: page.highlightThreshold })}</span>
    </label>
  );
}

function HighlightList(props: { revision: HighlightRevisionDto }) {
  const { t } = useTranslation();
  const page = useContentPage();
  const { revision } = props;
  const visible = visibleHighlights(revision.items, page.highlightThreshold);
  // A card names the sentence's speaker only while the revision it came from is read by speakers.
  const named = revision.items.some((item) => item.speakerId !== undefined);
  const speakers = useSpeakers(page.content.id, named);
  const revisionState = useTranscriptSpeakerState(page.content.id, named ? revision.transcriptRevisionId : undefined);
  const speakerOf = (speakerId: string | undefined) =>
    speakerId === undefined || revisionState?.speakerMode !== true ? undefined : speakers.data?.items.find((speaker) => speaker.id === speakerId);
  const duration = page.content.durationMs ?? revision.items.reduce((end, item) => Math.max(end, item.endMs), 0);
  // The menu copies and explains the highlighted sentence itself, not the model's reason for it.
  const menuTarget = useSentenceMenu<HTMLOListElement>((segmentId) => {
    const item = revision.items.find((candidate) => candidate.segmentId === segmentId);
    return item === undefined ? undefined : { text: item.segmentText, startMs: item.startMs };
  }, { explainSentence: true });
  return (
    <div className="flex flex-col gap-2">
      {duration > 0 ? <HighlightBand durationMs={duration} highlights={visible} testId="highlights-timeline" /> : null}
      <p className="text-xs text-muted">{t("contentView.highlights.shown", { shown: visible.length, total: revision.items.length })}</p>
      {visible.length === 0 ? (
        <p className="text-sm text-muted">{t("contentView.highlights.noneAboveThreshold")}</p>
      ) : (
        <ol ref={menuTarget} className="flex flex-col gap-1" data-testid="highlight-items" data-revision-id={revision.transcriptRevisionId}>
          {visible.map((item) => {
            const speaker = speakerOf(item.speakerId);
            return (
              <li key={item.segmentId}>
                <button
                  type="button"
                  data-testid="highlight-item"
                  data-segment-id={item.segmentId}
                  data-segment-text={item.segmentText}
                  data-score={item.score}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken"
                  onClick={() => page.select({ revisionId: revision.transcriptRevisionId, segmentId: item.segmentId }, item.startMs)}
                >
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${highlightTone(item.score)}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{item.text}</span>
                    <span className="block text-xs text-muted">
                      {speaker === undefined ? null : (
                        <span className="mr-1.5 inline-flex items-center gap-1 align-middle text-ink" data-testid="highlight-speaker" data-speaker-id={speaker.id}>
                          <SpeakerAvatar contentId={page.content.id} speaker={speaker} size={16} decorative />
                          <span className="font-medium">{speakerLabel(t, speaker)}</span>
                        </span>
                      )}
                      {item.segmentText}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{t("contentView.highlights.score", { score: item.score })}</span>
                  <span className="w-14 shrink-0 text-right font-mono text-xs text-accent">{formatDuration(item.startMs)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
