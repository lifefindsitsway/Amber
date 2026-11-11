import type { QueryClient } from "@tanstack/react-query";
import { contentKeys } from "../pages/content/content-data.ts";
import { noteKeys } from "../notes/note-keys.ts";
import { searchKeys } from "../search/search.ts";
import { queryKeys } from "./queries.ts";

/**
 * A Content moved into the trash, out of it, or purged for good, or had its speakers
 * changed. Other tabs of the same user show the same lists and pages, so the change is
 * broadcast to them as well.
 */
export interface ContentEvent {
  type: "trashed" | "restored" | "purged" | "speakersChanged";
  contentId: string;
}

/** Where an event came from: this tab already refreshed what it changed, other tabs did not. */
export interface ContentEventOrigin {
  remote: boolean;
}

type Listener = (event: ContentEvent, origin: ContentEventOrigin) => void;

const CONTENT_CHANNEL = "amber-content";
const CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set<ContentEvent["type"]>(["trashed", "restored", "purged", "speakersChanged"]);

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
 * Re-reads a Content's speaker list. Photo queries sit under the same prefix, but their keys
 * carry the photo version, so a changed photo already has a new key and unchanged photos
 * must not be downloaded again: only the list key itself is invalidated.
 */
export async function refreshSpeakerViews(queryClient: QueryClient, contentId: string): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: contentKeys.speakers(contentId), exact: true });
}

/**
 * A Content's speakers changed in this tab: its speaker list is read again here, and other
 * tabs are told to do the same.
 */
export function publishSpeakersChanged(bus: ContentEventBus, queryClient: QueryClient, contentId: string): void {
  void refreshSpeakerViews(queryClient, contentId);
  bus.publish({ type: "speakersChanged", contentId });
}
