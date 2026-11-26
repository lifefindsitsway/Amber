import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import { contentDtoSchema, type TranscriptRevisionListItemDto } from "../../../shared/dto/content.ts";
import { transcriptSegmentPageDtoSchema } from "../../../shared/dto/transcript.ts";
import { asrDiarizationRecordSchema } from "../../../shared/dto/speaker.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, queryString } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { searchKeys } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { Banner } from "../../ui/notice.tsx";
import { newerAsrRevision } from "./content-data.ts";
import { speakerCountOf } from "./speaker-draft.ts";
import { revisionLabel, revisionTimeLabel } from "./labels.ts";

/** Per Content, the ASR revision whose banner the user dismissed; a newer one shows again. */
export function asrBannerStorageKey(contentId: string): string {
  return `amber.transcript.asrBanner.${contentId}`;
}

function readDismissed(contentId: string): string | null {
  try {
    return localStorage.getItem(asrBannerStorageKey(contentId));
  } catch {
    return null;
  }
}

function writeDismissed(contentId: string, revisionId: string): void {
  try {
    localStorage.setItem(asrBannerStorageKey(contentId), revisionId);
  } catch {
    // Private mode without storage: the banner is dismissed for this visit only.
  }
}

/**
 * Tells the user a re-transcription finished while their own (imported, manual or corrected)
 * transcript stayed current, since publishing an ASR original never displaces it. They may
 * switch to it or dismiss the notice for that revision.
 */
export function AsrBanner(props: {
  contentId: string;
  revisions: readonly TranscriptRevisionListItemDto[];
  primaryId: string | undefined;
  /**
   * Called with the new recognition's revision when the user chooses to apply its speakers to
   * the current version. Given, the banner offers that first when the new recognition names at
   * least two speakers; absent, the banner is as it always was. Like every banner action, these
   * are outlined buttons: a side suggestion never outshines the page's own main action.
   */
  onApplySpeakers?: (sourceRevisionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(() => readDismissed(props.contentId));
  const asr = newerAsrRevision(props.revisions, props.primaryId);
  const primary = props.revisions.find((revision) => revision.id === props.primaryId);
  const setPrimary = useMutation({
    mutationFn: (revisionId: string) =>
      client.put(`/api/contents/${encodeURIComponent(props.contentId)}/primary-transcript`, contentDtoSchema, { body: { revisionId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.content(props.contentId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      await queryClient.invalidateQueries({ queryKey: searchKeys.all });
    },
  });
  // A recognition that records it identified nobody has no speakers to look for. Revisions
  // are immutable, so the first page of sentences (where a second speaker shows up) is read once.
  const record = asr === undefined ? undefined : asrDiarizationRecordSchema.safeParse(asr.generation["diarization"]);
  const mayHaveSpeakers = record === undefined || !record.success || record.data.status === "applied";
  const speakers = useQuery({
    queryKey: ["content", props.contentId, "asr-banner-speakers", asr?.id ?? ""],
    queryFn: async () => {
      const page = await client.get(`/api/transcript/revisions/${encodeURIComponent(asr?.id ?? "")}/segments${queryString({ limit: API_PAGE_SIZE_MAX })}`, transcriptSegmentPageDtoSchema);
      return speakerCountOf(page.items);
    },
    enabled: props.onApplySpeakers !== undefined && asr !== undefined && mayHaveSpeakers && dismissed !== asr.id,
    staleTime: Infinity,
    retry: false,
  });
  if (asr === undefined || primary === undefined || dismissed === asr.id) return null;
  const speakerCount = props.onApplySpeakers === undefined ? 0 : (speakers.data ?? 0);
  const applySpeakers = speakerCount >= 2 ? props.onApplySpeakers : undefined;
  return (
    // A state of the whole pane with a decision to make (switch or dismiss): a strip across
    // its top, in the neutral tone since nothing is wrong.
    <>
      <Banner
        tone="info"
        testId="asr-banner"
        actions={
          <>
            {applySpeakers === undefined ? null : (
              <>
                <span className="text-note text-muted">{t("speakerEditor.banner.speakers", { count: speakerCount })}</span>
                <Button size="sm" onClick={() => applySpeakers(asr.id)} data-testid="asr-banner-apply-speakers">
                  {t("speakerEditor.banner.apply")}
                </Button>
              </>
            )}
            <Button size="sm" loading={setPrimary.isPending} onClick={() => setPrimary.mutate(asr.id)} data-testid="asr-banner-set-primary">
              {t("contentView.revisions.asrBannerSetPrimary")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                writeDismissed(props.contentId, asr.id);
                setDismissed(asr.id);
              }}
              data-testid="asr-banner-dismiss"
            >
              {t("contentView.revisions.asrBannerDismiss")}
            </Button>
          </>
        }
      >
        {t("contentView.revisions.asrBanner", { time: revisionTimeLabel(asr.createdAt), label: revisionLabel(primary, undefined, t, i18n, props.revisions) })}
      </Banner>
      {setPrimary.error instanceof ApiError ? (
        <div className="border-b border-line px-4 py-2">
          <ErrorView error={setPrimary.error.error} />
        </div>
      ) : null}
    </>
  );
}
