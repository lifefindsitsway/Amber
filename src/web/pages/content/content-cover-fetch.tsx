import { useIsMutating, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { contentCoverFetchDtoSchema, type ContentDetailDto } from "../../../shared/dto/content.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { useToast } from "../../ui/toast.tsx";

/** One key for every entry that fetches a Content's cover again, so they share one state. */
const fetchKey = (contentId: string) => ["content-cover-fetch", contentId] as const;

/**
 * Fetching a platform Content's cover again on the user's click (the menu's 「重新获取封面」).
 * The answer replaces the detail in the cache; the lists that show covers (the library, the
 * collections, the trash) are refreshed so they pick up the new version, which every cover on
 * screen then loads as a new picture.
 */
export function useCoverFetch(contentId: string): { fetch: () => void; pending: boolean } {
  const client = useApi();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationKey: fetchKey(contentId),
    mutationFn: () => client.post(`/api/contents/${encodeURIComponent(contentId)}/cover/fetch`, contentCoverFetchDtoSchema, { body: {} }),
    onSuccess: (answer) => {
      queryClient.setQueryData<ContentDetailDto>(queryKeys.content(contentId), answer.content);
      void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
      toast.show({ tone: "success", message: t("contentView.cover.updated") });
    },
  });
  const pending = useIsMutating({ mutationKey: fetchKey(contentId) }) > 0;
  return { fetch: () => (pending ? undefined : mutation.mutate()), pending };
}

/**
 * One line under the title row while the cover is being fetched again, and why the last
 * attempt failed (the old cover stays).
 */
export function CoverFetchStatus(props: { contentId: string }) {
  const { t } = useTranslation();
  const pending = useIsMutating({ mutationKey: fetchKey(props.contentId) }) > 0;
  const last = useMutationState({
    filters: { mutationKey: fetchKey(props.contentId) },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  }).at(-1);
  let status: string | undefined;
  if (pending) {
    status = t("contentView.cover.fetching");
  } else if (last?.status === "error") {
    const error = last.error;
    const reason = error instanceof ApiError ? (error.error.userMessage !== "" ? error.error.userMessage : t(`errors.${error.error.class}`)) : t("common.state.loadFailed");
    status = t("contentView.cover.failed", { reason });
  }
  if (status === undefined) return null;
  return (
    <p className={`text-note ${pending ? "text-muted" : "text-danger"}`} role="status" data-testid="content-cover-status">
      {status}
    </p>
  );
}
