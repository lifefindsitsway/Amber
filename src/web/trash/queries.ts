import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { contentDtoSchema } from "../../shared/dto/content.ts";
import { trashListDtoSchema, trashPurgeAllDtoSchema, trashRestoreResultDtoSchema, type TrashPurgeAllDto } from "../../shared/dto/trash.ts";
import { useApi, useContentEvents } from "../api/context.tsx";
import { forgetContent, refreshContentViews, type ContentEventBus } from "../api/content-events.ts";
import { queryKeys, queryString } from "../api/queries.ts";
import { forgetCacheDismissal } from "../cache-dismissed.ts";

/**
 * The trash re-reads itself this often: entries expire and the sweep purges them on the
 * server's clock, with no event telling the page.
 */
const TRASH_REFRESH_MS = 60_000;

/**
 * `GET /api/trash`, newest deletion first, one numbered page. The key sits under
 * `queryKeys.trash`, so every trash invalidation re-reads the page on screen; the timer too
 * re-reads only that page. The previous page's answer stays as placeholder while the next one
 * loads (for the pager's total; the page does not show its rows).
 */
export function useTrashList(position: { page: number; pageSize: number }) {
  const client = useApi();
  return useQuery({
    queryKey: [...queryKeys.trash, "list", position.page, position.pageSize],
    queryFn: ({ signal }) => client.get(`/api/trash${queryString({ limit: position.pageSize, page: position.page })}`, trashListDtoSchema, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: TRASH_REFRESH_MS,
  });
}

/** After a purge nothing of these Contents comes back: caches and remembered UI state go. */
async function afterPurge(queryClient: QueryClient, contentEvents: ContentEventBus, contentIds: readonly string[]): Promise<void> {
  for (const contentId of contentIds) {
    forgetCacheDismissal(contentId);
    contentEvents.publish({ type: "purged", contentId });
  }
  await Promise.all([...contentIds.map((contentId) => forgetContent(queryClient, contentId)), refreshContentViews(queryClient)]);
}

/** `POST /api/trash/:id/restore`: the Content reappears in every view it was in. */
export function useRestoreTrashItem() {
  const client = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  return useMutation({
    mutationFn: (contentId: string) => client.post(`/api/trash/${encodeURIComponent(contentId)}/restore`, contentDtoSchema),
    onSuccess: async (_content, contentId) => {
      contentEvents.publish({ type: "restored", contentId });
      await refreshContentViews(queryClient);
    },
    // An expired entry may have been swept meanwhile; the list shows what is left.
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.trash }),
  });
}

/**
 * `POST /api/trash/restore`: the server decides for each Content on its own whether it can
 * come back (restored, already back, expired, gone); the restored ones reappear in every view.
 */
export function useRestoreTrashItems() {
  const client = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  return useMutation({
    mutationFn: (contentIds: readonly string[]) => client.post("/api/trash/restore", trashRestoreResultDtoSchema, { body: { contentIds } }),
    onSuccess: async (result) => {
      for (const contentId of result.restoredIds) contentEvents.publish({ type: "restored", contentId });
      await refreshContentViews(queryClient);
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.trash }),
  });
}

/** `DELETE /api/trash/:id`; on a refusal the list is read again (the entry may be gone already). */
export function usePurgeTrashItem() {
  const client = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  return async (contentId: string): Promise<void> => {
    try {
      await client.delete(`/api/trash/${encodeURIComponent(contentId)}`, z.undefined());
    } catch (caught) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
      throw caught;
    }
    await afterPurge(queryClient, contentEvents, [contentId]);
  };
}

/**
 * `DELETE /api/trash`. Each entry is purged on its own; the ones that failed stay in the
 * trash, and the list is refreshed either way.
 */
export function useEmptyTrash() {
  const client = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  return async (): Promise<TrashPurgeAllDto> => {
    let result: TrashPurgeAllDto;
    try {
      result = await client.delete("/api/trash", trashPurgeAllDtoSchema);
    } catch (caught) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
      throw caught;
    }
    await afterPurge(queryClient, contentEvents, result.purgedIds);
    return result;
  };
}
