import { useIsMutating, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CONTENT_DESCRIPTION_MAX_CHARS } from "../../../shared/defaults.ts";
import { contentDescriptionFetchDtoSchema, type ContentDescriptionFetchDto, type ContentDetailDto } from "../../../shared/dto/content.ts";
import { ApiError } from "../../api/client.ts";
import { useApi, useTask } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { PlainDescription } from "../../components/plain-description.tsx";
import { useLatestTask } from "./content-data.ts";

/** One key for every entry that fetches a Content's description, so they share one state. */
const fetchKey = (contentId: string) => ["content-description-fetch", contentId] as const;

/**
 * Fetching a platform video's description on the user's click (the title row's 「获取简介」
 * and the menu's 「重新获取简介」). The answer is the Content as it stands, which replaces the
 * detail in the cache; nothing else is refreshed, so playback, chat drafts and the reading
 * position are untouched.
 */
export function useDescriptionFetch(contentId: string): { fetch: () => void; pending: boolean } {
  const client = useApi();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey: fetchKey(contentId),
    mutationFn: () => client.post(`/api/contents/${encodeURIComponent(contentId)}/description/fetch`, contentDescriptionFetchDtoSchema, { body: {} }),
    onSuccess: (answer) => {
      queryClient.setQueryData<ContentDetailDto>(queryKeys.content(contentId), answer.content);
    },
  });
  const pending = useIsMutating({ mutationKey: fetchKey(contentId) }) > 0;
  return { fetch: () => (pending ? undefined : mutation.mutate()), pending };
}

/**
 * Whether the title row offers 「获取简介」: a platform Content whose description was never
 * settled, while its source stage is not about to read it anyway. Only the source stage
 * counts: a transcription waiting for its model, or later stages queued or running, do not
 * hide it.
 */
export function useOffersDescriptionFetch(content: ContentDetailDto): boolean {
  const platform = content.source.kind !== "local";
  const latest = useLatestTask(content.id);
  const task = latest.data ?? undefined;
  const view = useTask(platform && task !== undefined && task.statusProjection !== "succeeded" && task.statusProjection !== "failed" && task.statusProjection !== "cancelled" ? task.id : undefined);
  if (!platform || content.descriptionCheckedAt !== undefined || latest.isPending) return false;
  if (task === undefined) return true;
  if (task.statusProjection === "succeeded" || task.statusProjection === "failed" || task.statusProjection === "cancelled") return true;
  const source = view.detail?.stageRuns.filter((run) => run.stage === "source").at(-1);
  // An unfinished Task whose stages are not read yet may still be about to fetch the source.
  if (view.detail === undefined) return false;
  return source === undefined || (source.status !== "pending" && source.status !== "running");
}

/** The description under the title row, and one line saying how the last fetch went. */
export function ContentDescription(props: { content: ContentDetailDto }) {
  const { content } = props;
  const { t } = useTranslation();
  const { fetch, pending } = useDescriptionFetch(content.id);
  // The last fetch on this page: its outcome is said once, under the description.
  const last = useMutationState({
    filters: { mutationKey: fetchKey(content.id) },
    select: (mutation) => ({ status: mutation.state.status, data: mutation.state.data as ContentDescriptionFetchDto | undefined, error: mutation.state.error }),
  }).at(-1);
  const retry = (
    <button type="button" className="rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent" onClick={fetch} data-testid="content-description-retry">
      {t("common.action.retry")}
    </button>
  );
  let status: ReactNode = null;
  if (pending) {
    status = t("contentView.description.fetching");
  } else if (last?.status === "error") {
    const error = last.error;
    const message = error instanceof ApiError ? (error.error.userMessage !== "" ? error.error.userMessage : t(`errors.${error.error.class}`)) : t("common.state.loadFailed");
    status = (
      <>
        <span className="text-danger">{message}</span>
        {" · "}
        {retry}
      </>
    );
  } else if (last?.status === "success" && last.data?.result === "empty") {
    status = t("contentView.description.empty");
  } else if (last?.status === "success" && last.data?.result === "unknown") {
    status = (
      <>
        {t("contentView.description.unknown")}
        {" · "}
        {retry}
      </>
    );
  }
  const text = content.description;
  if (text === undefined && status === null) return null;
  return (
    <>
      {text === undefined ? null : <PlainDescription text={text} truncated={content.descriptionTruncated === true} maxChars={CONTENT_DESCRIPTION_MAX_CHARS} />}
      {status === null ? null : (
        <p className="text-xs text-muted" role="status" data-testid="content-description-status">
          {status}
        </p>
      )}
    </>
  );
}

/** 「获取简介」 at the end of the title row's small print, styled like the collection links there. */
export function DescriptionFetchButton(props: { content: ContentDetailDto }) {
  const { t } = useTranslation();
  const offered = useOffersDescriptionFetch(props.content);
  const { fetch, pending } = useDescriptionFetch(props.content.id);
  if (!offered) return null;
  return (
    <button
      type="button"
      className="rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:text-muted disabled:no-underline"
      disabled={pending}
      onClick={fetch}
      data-testid="content-description-fetch"
    >
      {t("contentView.description.fetch")}
    </button>
  );
}
