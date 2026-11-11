import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useContentEvents } from "../api/context.tsx";
import { forgetContent, refreshContentViews, refreshSpeakerViews } from "../api/content-events.ts";
import { queryKeys } from "../api/queries.ts";

/**
 * Follows changes made in the user's other tabs. After a trash change this tab's lists,
 * collections, notes, search and trash are read again, and a Content that is no longer
 * readable is forgotten; after a speaker change only that Content's speaker list is.
 * Changes made in this tab were refreshed by whoever made them.
 */
export function useContentEventSync(): void {
  const contentEvents = useContentEvents();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      contentEvents.subscribe((event, origin) => {
        if (!origin.remote) return;
        if (event.type === "speakersChanged") {
          // Speakers touch no list: only the open page's speaker list is read again.
          void refreshSpeakerViews(queryClient, event.contentId);
          return;
        }
        if (event.type === "trashed" || event.type === "purged") {
          void forgetContent(queryClient, event.contentId);
        }
        void refreshContentViews(queryClient);
        // Its tasks leave (or rejoin) the task lists, unfinished and finished alike, with it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll });
      }),
    [contentEvents, queryClient],
  );
}
