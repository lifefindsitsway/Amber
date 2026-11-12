import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentEventBus } from "../../../src/web/api/content-events.ts";
import { useContentEvents } from "../../../src/web/api/context.tsx";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { contentKeys } from "../../../src/web/pages/content/content-data.ts";
import { noteKeys } from "../../../src/web/notes/note-keys.ts";
import { searchKeys } from "../../../src/web/search/search.ts";
import { useContentEventSync } from "../../../src/web/shell/content-sync.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

/** What a speaker change elsewhere does not touch; collection details and search hits derive speaker bases, so they are read again. */
const UNTOUCHED_BY_SPEAKERS = [queryKeys.contentsAll, queryKeys.collections, noteKeys.groups, [...queryKeys.trash, "list"], queryKeys.unfinishedTasks, queryKeys.taskHistory];
const SHOWN = [queryKeys.contentsAll, queryKeys.collections, queryKeys.collection("k1"), noteKeys.groups, searchKeys.query("x", "global"), [...queryKeys.trash, "list"], queryKeys.unfinishedTasks, queryKeys.taskHistory];

/** Mounts the sync hook and, like an open content page, an observed detail of `c-open`. */
function Harness(props: { onReady: (client: QueryClient, bus: ContentEventBus) => void }) {
  useContentEventSync();
  const client = useQueryClient();
  const bus = useContentEvents();
  props.onReady(client, bus);
  const open = useQuery({ queryKey: queryKeys.content("c-open"), queryFn: async () => ({ id: "c-open" }), staleTime: Infinity });
  return <p data-testid="open">{open.data?.id ?? "none"}</p>;
}

/** Channels the app opened; a message from another tab arrives on each of them. */
const channels: Array<{ onmessage: ((message: { data: unknown }) => void) | null }> = [];

function remote(data: unknown): void {
  act(() => {
    for (const channel of channels) channel.onmessage?.({ data });
  });
}

function seed(client: QueryClient): void {
  for (const key of SHOWN) client.setQueryData(key, { items: [] });
  client.setQueryData(queryKeys.content("c1"), { id: "c1" });
  client.setQueryData([...queryKeys.content("c1"), "transcript"], { segments: [] });
  client.setQueryData(noteKeys.content("c1"), { items: [] });
  client.setQueryData(noteKeys.content("c2"), { items: [] });
}

// A channel that delivers only what the test sends, so no real cross-process traffic reaches it.
beforeEach(() => {
  channels.length = 0;
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((message: { data: unknown }) => void) | null = null;
      constructor() {
        channels.push(this);
      }
      postMessage(): void {}
      close(): void {}
    },
  );
});

describe("useContentEventSync", () => {
  it("refreshes every view and forgets a Content trashed in another tab", async () => {
    mockApi({});
    let client: QueryClient | undefined;
    let bus: ContentEventBus | undefined;
    renderApp(<Harness onReady={(c, b) => ((client = c), (bus = b))} />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("c-open"));
    if (client === undefined || bus === undefined) throw new Error("not ready");
    seed(client);
    remote({ type: "trashed", contentId: "c1" });
    for (const key of SHOWN) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryData(queryKeys.content("c1"))).toBeUndefined();
    expect(client.getQueryData([...queryKeys.content("c1"), "transcript"])).toBeUndefined();
    expect(client.getQueryData(noteKeys.content("c1"))).toBeUndefined();
    expect(client.getQueryData(noteKeys.content("c2"))).toEqual({ items: [] });
  });

  it("keeps the open page's detail cached and reads it again when that Content is purged elsewhere", async () => {
    mockApi({});
    let client: QueryClient | undefined;
    let bus: ContentEventBus | undefined;
    renderApp(<Harness onReady={(c, b) => ((client = c), (bus = b))} />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("c-open"));
    if (client === undefined || bus === undefined) throw new Error("not ready");
    const before = client.getQueryState(queryKeys.content("c-open"))?.dataUpdateCount ?? 0;
    remote({ type: "purged", contentId: "c-open" });
    await waitFor(() => expect(client?.getQueryState(queryKeys.content("c-open"))?.dataUpdateCount).toBe(before + 1));
  });

  it("refreshes but forgets nothing on a restore elsewhere, and ignores this tab's own events", async () => {
    mockApi({});
    let client: QueryClient | undefined;
    let bus: ContentEventBus | undefined;
    renderApp(<Harness onReady={(c, b) => ((client = c), (bus = b))} />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("c-open"));
    if (client === undefined || bus === undefined) throw new Error("not ready");
    seed(client);
    act(() => bus?.publish({ type: "trashed", contentId: "c1" }));
    for (const key of SHOWN) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(client.getQueryData(queryKeys.content("c1"))).toEqual({ id: "c1" });
    remote({ type: "restored", contentId: "c1" });
    for (const key of SHOWN) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryData(queryKeys.content("c1"))).toEqual({ id: "c1" });
    expect(client.getQueryData(noteKeys.content("c1"))).toEqual({ items: [] });
  });
});

describe("useContentEventSync on speaker changes", () => {
  it("refreshes that Content's speaker list and what derives from names, not its photos or versions, when another tab changed them", async () => {
    mockApi({});
    let client: QueryClient | undefined;
    let bus: ContentEventBus | undefined;
    renderApp(<Harness onReady={(c, b) => ((client = c), (bus = b))} />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("c-open"));
    if (client === undefined || bus === undefined) throw new Error("not ready");
    seed(client);
    client.setQueryData(contentKeys.speakers("c1"), { items: [] });
    client.setQueryData(contentKeys.speakers("c2"), { items: [] });
    client.setQueryData(contentKeys.revisions("c1"), { items: [] });
    client.setQueryData(contentKeys.revisions("c2"), { items: [] });
    client.setQueryData(contentKeys.speakerAvatar("c1", "s1", 1), "blob");
    remote({ type: "speakersChanged", contentId: "c1" });
    expect(client.getQueryState(contentKeys.speakers("c1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(contentKeys.revisions("c1"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(contentKeys.speakerAvatar("c1", "s1", 1))?.isInvalidated).toBe(false);
    expect(client.getQueryState(contentKeys.speakers("c2"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(contentKeys.revisions("c2"))?.isInvalidated).toBe(false);
    for (const key of UNTOUCHED_BY_SPEAKERS) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.collection("k1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(searchKeys.query("x", "global"))?.isInvalidated).toBe(true);
    expect(client.getQueryData(queryKeys.content("c1"))).toEqual({ id: "c1" });
    expect(client.getQueryData(noteKeys.content("c1"))).toEqual({ items: [] });
  });

  it("refreshes that Content's speaker views and its revision list when another tab reviewed its speakers", async () => {
    mockApi({});
    let client: QueryClient | undefined;
    let bus: ContentEventBus | undefined;
    renderApp(<Harness onReady={(c, b) => ((client = c), (bus = b))} />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("c-open"));
    if (client === undefined || bus === undefined) throw new Error("not ready");
    seed(client);
    client.setQueryData(contentKeys.speakers("c1"), { items: [] });
    client.setQueryData(contentKeys.revisions("c1"), { items: [] });
    client.setQueryData(contentKeys.speakerReview("c1", "r1"), { revisionId: "r1" });
    client.setQueryData(contentKeys.revisions("c2"), { items: [] });
    client.setQueryData(contentKeys.speakerAvatar("c1", "s1", 1), "blob");
    remote({ type: "speakerReviewChanged", contentId: "c1" });
    expect(client.getQueryState(contentKeys.speakers("c1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(contentKeys.revisions("c1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(contentKeys.speakerReview("c1", "r1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(contentKeys.speakerAvatar("c1", "s1", 1))?.isInvalidated).toBe(false);
    expect(client.getQueryState(contentKeys.revisions("c2"))?.isInvalidated).toBe(false);
    for (const key of UNTOUCHED_BY_SPEAKERS) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.collection("k1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(searchKeys.query("x", "global"))?.isInvalidated).toBe(true);
  });

  it("leaves a speaker event of this tab to whoever published it", async () => {
    mockApi({});
    let client: QueryClient | undefined;
    let bus: ContentEventBus | undefined;
    renderApp(<Harness onReady={(c, b) => ((client = c), (bus = b))} />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("c-open"));
    if (client === undefined || bus === undefined) throw new Error("not ready");
    client.setQueryData(contentKeys.speakers("c1"), { items: [] });
    act(() => bus?.publish({ type: "speakersChanged", contentId: "c1" }));
    expect(client.getQueryState(contentKeys.speakers("c1"))?.isInvalidated).toBe(false);
  });
});
