import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ContentEventBus, publishSpeakersChanged, type ContentEvent, type ContentEventOrigin } from "../../../src/web/api/content-events.ts";
import { contentKeys } from "../../../src/web/pages/content/content-data.ts";

/**
 * A stand-in for `BroadcastChannel` shared by every bus in the test, as tabs share one
 * channel name: a post reaches every other open instance of the name, never the poster.
 */
function fakeBroadcastChannel() {
  const open = new Set<FakeChannel>();
  class FakeChannel {
    readonly name: string;
    onmessage: ((message: MessageEvent<unknown>) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      open.add(this);
    }
    postMessage(data: unknown): void {
      for (const other of open) {
        if (other !== this && other.name === this.name) other.onmessage?.({ data } as MessageEvent<unknown>);
      }
    }
    close(): void {
      open.delete(this);
    }
  }
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  return {
    open,
    /** A message as another tab (or a stranger on the same channel name) would send it. */
    deliver: (data: unknown) => {
      for (const channel of open) channel.onmessage?.({ data } as MessageEvent<unknown>);
    },
  };
}

function record(bus: ContentEventBus): Array<[ContentEvent, ContentEventOrigin]> {
  const seen: Array<[ContentEvent, ContentEventOrigin]> = [];
  bus.subscribe((event, origin) => seen.push([event, origin]));
  return seen;
}

describe("ContentEventBus", () => {
  it("calls this tab's listeners at once and reaches the other tabs over the amber-content channel", () => {
    const { open } = fakeBroadcastChannel();
    const here = new ContentEventBus();
    const there = new ContentEventBus();
    const heard = record(here);
    const elsewhere = record(there);
    here.publish({ type: "trashed", contentId: "c1" });
    expect(heard).toEqual([[{ type: "trashed", contentId: "c1" }, { remote: false }]]);
    expect(elsewhere).toEqual([[{ type: "trashed", contentId: "c1" }, { remote: true }]]);
    expect([...open].map((channel) => channel.name)).toEqual(["amber-content", "amber-content"]);
    there.publish({ type: "restored", contentId: "c1" });
    expect(heard.at(-1)).toEqual([{ type: "restored", contentId: "c1" }, { remote: true }]);
    expect(elsewhere).toHaveLength(2);
    here.close();
    there.close();
    expect(open.size).toBe(0);
  });

  it("ignores messages that are not content events", () => {
    const { deliver } = fakeBroadcastChannel();
    const bus = new ContentEventBus();
    const heard = record(bus);
    for (const junk of [null, "trashed", { type: "deleted", contentId: "c1" }, { type: "purged" }, { type: "purged", contentId: "" }, { type: "purged", contentId: 7 }]) {
      deliver(junk);
    }
    expect(heard).toEqual([]);
    deliver({ type: "purged", contentId: "c2", extra: true });
    expect(heard).toEqual([[{ type: "purged", contentId: "c2" }, { remote: true }]]);
    bus.close();
  });

  it("stays within the tab when BroadcastChannel is missing", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const bus = new ContentEventBus();
    const heard = record(bus);
    expect(() => bus.publish({ type: "purged", contentId: "c3" })).not.toThrow();
    expect(heard).toEqual([[{ type: "purged", contentId: "c3" }, { remote: false }]]);
    bus.close();
  });

  it("reopens the channel after close, as a provider remounted under StrictMode does", () => {
    const { open } = fakeBroadcastChannel();
    const bus = new ContentEventBus();
    const unsubscribe = bus.subscribe(() => undefined);
    bus.close();
    unsubscribe();
    expect(open.size).toBe(0);
    const heard = record(bus);
    expect(open.size).toBe(1);
    const other = new ContentEventBus();
    other.publish({ type: "trashed", contentId: "c4" });
    expect(heard).toEqual([[{ type: "trashed", contentId: "c4" }, { remote: true }]]);
    bus.close();
    other.close();
  });

  it("stops calling a listener once it unsubscribes", () => {
    fakeBroadcastChannel();
    const bus = new ContentEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();
    bus.publish({ type: "trashed", contentId: "c5" });
    expect(listener).not.toHaveBeenCalled();
    bus.close();
  });
});

describe("publishSpeakersChanged", () => {
  it("invalidates the speaker list of that Content here and tells the other tab, which hears it as remote", () => {
    const { open } = fakeBroadcastChannel();
    const here = new ContentEventBus();
    const there = new ContentEventBus();
    const heard = record(here);
    const elsewhere = record(there);
    const queryClient = new QueryClient();
    queryClient.setQueryData(contentKeys.speakers("c1"), { items: [] });
    queryClient.setQueryData(contentKeys.speakerAvatar("c1", "s1", 1), "blob");
    queryClient.setQueryData(contentKeys.speakers("c2"), { items: [] });
    publishSpeakersChanged(here, queryClient, "c1");
    expect(queryClient.getQueryState(contentKeys.speakers("c1"))?.isInvalidated).toBe(true);
    // A photo's key carries its version, so its bytes are not fetched again.
    expect(queryClient.getQueryState(contentKeys.speakerAvatar("c1", "s1", 1))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(contentKeys.speakers("c2"))?.isInvalidated).toBe(false);
    expect(heard).toEqual([[{ type: "speakersChanged", contentId: "c1" }, { remote: false }]]);
    expect(elsewhere).toEqual([[{ type: "speakersChanged", contentId: "c1" }, { remote: true }]]);
    here.close();
    there.close();
    expect(open.size).toBe(0);
  });

  it("is accepted from another tab only with a content id", () => {
    const { deliver } = fakeBroadcastChannel();
    const bus = new ContentEventBus();
    const heard = record(bus);
    deliver({ type: "speakersChanged" });
    deliver({ type: "speakersChanged", contentId: "" });
    expect(heard).toEqual([]);
    deliver({ type: "speakersChanged", contentId: "c9" });
    expect(heard).toEqual([[{ type: "speakersChanged", contentId: "c9" }, { remote: true }]]);
    bus.close();
  });
});
