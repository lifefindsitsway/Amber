import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { contentDtoSchema, type TranscriptRevisionListItemDto } from "../../../shared/dto/content.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { searchKeys } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { newerAsrRevision } from "./content-data.ts";
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
export function AsrBanner(props: { contentId: string; revisions: readonly TranscriptRevisionListItemDto[]; primaryId: string | undefined }) {
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
  if (asr === undefined || primary === undefined || dismissed === asr.id) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-2 text-xs" data-testid="asr-banner">
      <span className="min-w-0 flex-1">
        {t("contentView.revisions.asrBanner", { time: revisionTimeLabel(asr.createdAt), label: revisionLabel(primary, undefined, t, i18n, props.revisions) })}
      </span>
      <Button size="sm" variant="primary" disabled={setPrimary.isPending} onClick={() => setPrimary.mutate(asr.id)} data-testid="asr-banner-set-primary">
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
      {setPrimary.error instanceof ApiError ? (
        <div className="basis-full">
          <ErrorView error={setPrimary.error.error} />
        </div>
      ) : null}
    </div>
  );
}
