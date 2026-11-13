import type { QueryClient } from "@tanstack/react-query";
import type { ChaptersDto } from "../../shared/dto/chapter.ts";
import { contentKeys } from "../pages/content/content-data.ts";
import { noteKeys } from "../notes/note-keys.ts";
import { searchKeys } from "../search/search.ts";
import { queryKeys } from "./queries.ts";

/**
 * A Content moved into the trash, out of it, or purged for good, had its speakers changed,
 * had a revision's speaker review confirmed or withdrawn, or had its current chapters switched.
 * Other tabs of the same user show the same lists and pages, so the change is broadcast to them
 * as well.
 */
export interface ContentEvent {
  type: "trashed" | "restored" | "purged" | "speakersChanged" | "speakerReviewChanged" | "chaptersChanged";
  contentId: string;
}

/** Where an event came from: this tab already refreshed what it changed, other tabs did not. */
export interface ContentEventOrigin {
  remote: boolean;
}

type Listener = (event: ContentEvent, origin: ContentEventOrigin) => void;

const CONTENT_CHANNEL = "amber-content";
const CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set<ContentEvent["type"]>([
  "trashed",
  "restored",
  "purged",
  "speakersChanged",
  "speakerReviewChanged",
  "chaptersChanged",
]);

/** Messages from other tabs are untrusted input in shape: anything else is ignored. */
function contentEventOf(data: unknown): ContentEvent | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { type, contentId } = data as Record<string, unknown>;
  if (typeof type !== "string" || !CONTENT_EVENT_TYPES.has(type) || typeof contentId !== "string" || contentId === "") return undefined;
  return { type: type as ContentEvent["type"], contentId };
}

/**
 * Content lifecycle events: listeners in this tab are called synchronously on `publish`, and
 * other tabs receive the event over a `BroadcastChannel`. A channel never delivers to the
 * object that posted, so this tab does not hear itself twice. Without `BroadcastChannel`
 * (old WebViews, some test environments) events stay within this tab.
 *
 * The channel opens lazily and `close` only drops it, so a provider remounted under
 * StrictMode reopens it on the next subscription or publish.
 */
export class ContentEventBus {
  private readonly listeners = new Set<Listener>();
  private channel: BroadcastChannel | undefined;

  publish(event: ContentEvent): void {
    this.emit(event, { remote: false });
    try {
      this.ensureChannel()?.postMessage(event);
    } catch {
      // A closed or unavailable channel only means other tabs refresh later on their own.
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensureChannel();
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.channel?.close();
    this.channel = undefined;
  }

  private ensureChannel(): BroadcastChannel | undefined {
    if (this.channel !== undefined || typeof BroadcastChannel === "undefined") return this.channel;
    const channel = new BroadcastChannel(CONTENT_CHANNEL);
    channel.onmessage = (message: MessageEvent<unknown>) => {
      const event = contentEventOf(message.data);
      if (event !== undefined) this.emit(event, { remote: true });
    };
    this.channel = channel;
    return channel;
  }

  private emit(event: ContentEvent, origin: ContentEventOrigin): void {
    for (const listener of [...this.listeners]) listener(event, origin);
  }
}

/**
 * Re-reads every view a Content's presence shows up in: lists, collections (members and
 * summaries), note groups, search results and the trash.
 */
export async function refreshContentViews(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll }),
    queryClient.invalidateQueries({ queryKey: queryKeys.collections }),
    queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails }),
    queryClient.invalidateQueries({ queryKey: noteKeys.groups }),
    queryClient.invalidateQueries({ queryKey: searchKeys.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.trash }),
  ]);
}

/**
 * Drops the cached detail, sub-resources and notes of a Content that can no longer be read.
 * A page still showing it reads its detail again and gets the server's `not_found`, rather
 * than keeping stale data on screen.
 */
export async function forgetContent(queryClient: QueryClient, contentId: string): Promise<void> {
  queryClient.removeQueries({ queryKey: queryKeys.content(contentId), type: "inactive" });
  queryClient.removeQueries({ queryKey: noteKeys.contentAll(contentId) });
  await queryClient.invalidateQueries({ queryKey: queryKeys.content(contentId), exact: true });
}

/**
 * Re-reads a Content's speaker list and the speaker reviews of its revisions (a rename, a
 * name confirmation or a review changes what a review shows). Photo queries sit under the
 * speaker list's prefix, but their keys carry the photo version, so a changed photo already
 * has a new key and unchanged photos must not be downloaded again: only the list key itself
 * is invalidated.
 */
export async function refreshSpeakerViews(queryClient: QueryClient, contentId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: contentKeys.speakers(contentId), exact: true }),
    queryClient.invalidateQueries({ queryKey: contentKeys.speakerReviews(contentId) }),
    // Whether an artifact's speaker basis still holds is derived on read from the names and
    // the review, so the artifacts, their revision lists, the collection summaries that count
    // members' bases, and search hits that show speakers are read again too.
    queryClient.invalidateQueries({ queryKey: contentKeys.summaries(contentId) }),
    queryClient.invalidateQueries({ queryKey: contentKeys.chapters(contentId) }),
    queryClient.invalidateQueries({ queryKey: contentKeys.highlights(contentId) }),
    queryClient.invalidateQueries({ queryKey: ["summary-revisions"] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails }),
    queryClient.invalidateQueries({ queryKey: searchKeys.all }),
  ]);
}

/**
 * A Content's speakers changed in this tab: its speaker list is read again here, and other
 * tabs are told to do the same.
 */
export function publishSpeakersChanged(bus: ContentEventBus, queryClient: QueryClient, contentId: string): void {
  void refreshSpeakerViews(queryClient, contentId);
  bus.publish({ type: "speakersChanged", contentId });
}

/**
 * Re-reads what a review changes: the speaker views (confirming a review also confirms the
 * names it covers) and the Content's revision list, whose items carry `speakersConfirmedAt`.
 * A plain speaker change leaves the revision list alone; a review does not.
 */
export async function refreshSpeakerReviewViews(queryClient: QueryClient, contentId: string): Promise<void> {
  await Promise.all([refreshSpeakerViews(queryClient, contentId), queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId), exact: true })]);
}

/** A revision's speaker review was confirmed or withdrawn in this tab: refreshed here, and other tabs are told. */
export function publishSpeakerReviewChanged(bus: ContentEventBus, queryClient: QueryClient, contentId: string): void {
  void refreshSpeakerReviewViews(queryClient, contentId);
  bus.publish({ type: "speakerReviewChanged", contentId });
}

/**
 * Re-reads what derives from a Content's current chapters: its summaries (a summary written on
 * other chapters turns stale) and the open summary revision lists, whose items carry the same
 * freshness. Revision lists are keyed by artifact, not Content, so all of them are read again.
 */
export async function refreshChapterDependents(queryClient: QueryClient, contentId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: contentKeys.summaries(contentId) }),
    queryClient.invalidateQueries({ queryKey: ["summary-revisions"] }),
  ]);
}

/**
 * Re-reads a Content's chapters and what derives from them. The chapter query is shared by the
 * chapter area, the player's timeline and the reading headings, so one key covers all three.
 */
export async function refreshChapterViews(queryClient: QueryClient, contentId: string): Promise<void> {
  await Promise.all([queryClient.invalidateQueries({ queryKey: contentKeys.chapters(contentId) }), refreshChapterDependents(queryClient, contentId)]);
}

/**
 * A Content's current chapters were switched in this tab: the server's answer replaces the
 * cached chapters (it is exactly what a fresh read returns, so none is made), what derives from
 * them is read again, and other tabs are told to read both.
 */
export function publishChaptersChanged(bus: ContentEventBus, queryClient: QueryClient, contentId: string, chapters: ChaptersDto): void {
  queryClient.setQueryData(contentKeys.chapters(contentId), chapters);
  void refreshChapterDependents(queryClient, contentId);
  bus.publish({ type: "chaptersChanged", contentId });
}
