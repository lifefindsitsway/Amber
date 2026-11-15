import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDto } from "../../../src/shared/dto/note.ts";
import { NotePopover } from "../../../src/web/notes/note-popover.tsx";
import { NotesUiProvider, useNotesUi } from "../../../src/web/notes/note-ui-context.tsx";
import { ContentPageProvider, type ContentPageState } from "../../../src/web/pages/content/content-context.tsx";
import { contentDetail } from "../../fixtures/web/content-data.ts";
import { note } from "../../fixtures/web/note-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";

// Radix starts listening for outside presses a tick after the layer mounts, and a non-modal
// popover only dismisses once the press completes as a click.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function pressOutside(): void {
  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
}

const ANCHOR = { transcriptRevisionId: "r1", startSegmentId: "s1", startOffset: 0, endSegmentId: "s1", endOffset: 2 };
const RECT = { top: 10, left: 10, bottom: 30, right: 60, width: 50, height: 20 };
const FAILURE = { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } };

/** A reading view with one run of note n1 that can be unmounted, as a windowed row is. */
function Harness() {
  const ui = useNotesUi();
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" data-testid="toggle-run" onClick={() => setShown(!shown)} />
      <button type="button" data-testid="start-compose" onClick={() => ui.openCompose({ anchor: ANCHOR, rect: RECT, excerpt: "今天" })} />
      <button type="button" data-testid="start-compose-across" onClick={() => ui.openCompose({ anchor: { ...ANCHOR, endSegmentId: "s2", endOffset: 3 }, rect: RECT, excerpt: "今天讲检索。后一句" })} />
      <div data-revision-id="r1" data-notes>
        {shown ? (
          <span data-segment-id="s1">
            <span role="button" tabIndex={0} data-testid="note-run" data-note-ids="n1" onClick={() => ui.openView({ noteIds: ["n1"], segmentId: "s1", revisionId: "r1" })}>
              今天
            </span>
            讲检索。
          </span>
        ) : null}
        <span data-segment-id="s2">后一句。</span>
      </div>
      <button type="button" data-testid="transcript-notes-link" />
      <NotePopover />
    </>
  );
}

function open(routes: Parameters<typeof mockApi>[0] = {}, items: NoteDto[] = [note("n1", { view: { segments: [{ segmentId: "s1", startOffset: 0, endOffset: 2 }], exact: true } })]) {
  const api = mockApi({ "GET /api/contents/c1/notes": { body: { items } }, ...routes });
  const state: ContentPageState = {
    content: contentDetail(),
    primaryRevisionId: "r1",
    selection: undefined,
    select: vi.fn(),
    openTab: vi.fn(),
    highlightThreshold: 0,
    setHighlightThreshold: vi.fn(),
    openSubtitleEditor: vi.fn(),
  };
  renderApp(
    <ContentPageProvider value={state}>
      <NotesUiProvider>
        <Harness />
      </NotesUiProvider>
    </ContentPageProvider>,
    { route: "/contents/c1?tab=transcript&revision=r1" },
  );
  return api;
}

const writes = (calls: RecordedCall[]) => calls.filter((call) => call.method !== "GET");

async function openView() {
  fireEvent.click(screen.getByTestId("note-run"));
  const popover = await screen.findByTestId("note-popover");
  await within(popover).findByTestId("note-card");
  await settle();
  return popover;
}

async function editComment(text: string) {
  fireEvent.click(await screen.findByTestId("note-comment-edit"));
  fireEvent.change(screen.getByTestId("note-comment-input"), { target: { value: text } });
}

beforeEach(() => {
  localStorage.clear();
});

describe("NotePopover viewing notes", () => {
  it("lists the run's note, recolours it, remembers the colour and disables its controls while the change is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = open({ "PATCH /api/notes/n1": { body: note("n1", { color: "green" }) } });
    const fetching = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if (init.method === "PATCH") await gate;
      return fetching(input, init);
    });
    const popover = await openView();
    fireEvent.click(within(popover).getByTestId("note-color-green"));
    await waitFor(() => expect((within(popover).getByTestId("note-color-pink") as HTMLButtonElement).disabled).toBe(true));
    expect((within(popover).getByTestId("note-delete") as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect((within(popover).getByTestId("note-color-pink") as HTMLButtonElement).disabled).toBe(false));
    expect(writes(calls).map((call) => [call.method, call.path, call.body])).toEqual([["PATCH", "/api/notes/n1", { color: "green" }]]);
    expect(localStorage.getItem("amber.notes.color.background")).toBe("green");
  });

  it("closes on an outside press or Esc when nothing is unsaved, giving focus back to the run after Esc", async () => {
    open();
    await openView();
    pressOutside();
    await waitFor(() => expect(screen.queryByTestId("note-popover")).toBeNull());
    const popover = await openView();
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("note-popover")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("note-run"));
  });

  it("refuses Esc and outside presses while a comment edit is unsaved, and says why", async () => {
    open();
    const popover = await openView();
    await editComment("一个想法");
    fireEvent.keyDown(popover, { key: "Escape" });
    pressOutside();
    expect(screen.getByTestId("note-popover")).toBeTruthy();
    expect(screen.getByTestId("note-dirty").textContent).toBe("有未保存的评论");
    // Another run cannot replace unsaved work either.
    fireEvent.click(screen.getByTestId("note-run"));
    expect((screen.getByTestId("note-comment-input") as HTMLTextAreaElement).value).toBe("一个想法");
    fireEvent.click(screen.getByTestId("note-comment-cancel"));
    pressOutside();
    await waitFor(() => expect(screen.queryByTestId("note-popover")).toBeNull());
  });

  it("goes detached when its run unmounts with unsaved text, keeps the text and anchors again when the run is back", async () => {
    open();
    await openView();
    await editComment("滚走也别丢");
    fireEvent.click(screen.getByTestId("toggle-run"));
    const detached = await screen.findByTestId("note-popover-detached");
    expect(screen.queryByTestId("note-popover")).toBeNull();
    expect((within(detached).getByTestId("note-comment-input") as HTMLTextAreaElement).value).toBe("滚走也别丢");
    expect(within(detached).getByTestId("note-locate-anchor").textContent).toBe("定位原文");
    expect(detached.textContent).toContain("今天");
    fireEvent.click(screen.getByTestId("toggle-run"));
    const popover = await screen.findByTestId("note-popover");
    expect((within(popover).getByTestId("note-comment-input") as HTMLTextAreaElement).value).toBe("滚走也别丢");
  });

  it("closes when its run unmounts with nothing unsaved", async () => {
    open();
    await openView();
    fireEvent.click(screen.getByTestId("toggle-run"));
    await waitFor(() => expect(screen.queryByTestId("note-popover")).toBeNull());
    expect(screen.queryByTestId("note-popover-detached")).toBeNull();
  });

  it("keeps a comment whose save failed and retries the same change", async () => {
    let patches = 0;
    const { calls } = open({
      "PATCH /api/notes/n1": () => {
        patches += 1;
        return patches === 1 ? FAILURE : { body: note("n1", { comment: "想法" }) };
      },
    });
    await openView();
    await editComment("想法");
    fireEvent.click(screen.getByTestId("note-comment-save"));
    const retry = await screen.findByTestId("note-comment-retry");
    expect((screen.getByTestId("note-comment-input") as HTMLTextAreaElement).value).toBe("想法");
    expect(screen.getByRole("alert").textContent).toBe("保存失败，输入已保留");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByTestId("note-comment-input")).toBeNull());
    expect(writes(calls).map((call) => call.body)).toEqual([{ comment: "想法" }, { comment: "想法" }]);
  });

  it("deletes in two steps and closes once the run has no note left", async () => {
    let deleted = false;
    open({
      "GET /api/contents/c1/notes": () => ({ body: { items: deleted ? [] : [note("n1", { view: { segments: [{ segmentId: "s1", startOffset: 0, endOffset: 2 }], exact: true } })] } }),
      "DELETE /api/notes/n1": () => {
        deleted = true;
        return { status: 204 };
      },
    });
    await openView();
    fireEvent.click(screen.getByTestId("note-delete"));
    fireEvent.click(screen.getByTestId("note-delete-confirm"));
    await waitFor(() => expect(screen.queryByTestId("note-popover")).toBeNull());
  });

  it("offers the anchor revision for a note shown approximately", async () => {
    open({}, [note("n1", { transcriptRevisionId: "r0", startSegmentId: "a1", view: { segments: [{ segmentId: "s1", startOffset: 0, endOffset: 8 }], exact: false } })]);
    const popover = await openView();
    expect(within(popover).getByTestId("note-approximate").textContent).toBe("基于另一版本，按整句显示在原版本查看");
  });
});

describe("NotePopover composing a comment", () => {
  it("writes nothing when cancelled and posts once with a fixed key when saved", async () => {
    const { calls } = open({ "POST /api/contents/c1/notes": { status: 201, body: note("n9", { comment: "想法" }) } });
    fireEvent.click(screen.getByTestId("start-compose"));
    const compose = await screen.findByTestId("note-compose");
    expect(document.activeElement).toBe(within(compose).getByTestId("note-compose-input"));
    expect((within(compose).getByTestId("note-compose-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(compose).getByTestId("note-compose-cancel"));
    await waitFor(() => expect(screen.queryByTestId("note-compose")).toBeNull());
    expect(writes(calls)).toEqual([]);

    fireEvent.click(screen.getByTestId("start-compose"));
    fireEvent.change(await screen.findByTestId("note-compose-input"), { target: { value: " 想法 " } });
    fireEvent.click(screen.getByTestId("note-color-green"));
    fireEvent.click(screen.getByTestId("note-compose-save"));
    await waitFor(() => expect(screen.queryByTestId("note-compose")).toBeNull());
    const posts = writes(calls);
    expect(posts.map((call) => call.body)).toEqual([{ ...ANCHOR, mark: "underline", color: "green", comment: "想法" }]);
    expect(posts[0]?.headers["idempotency-key"]).toBeTruthy();
    expect(localStorage.getItem("amber.notes.color.underline")).toBe("green");
  });

  it("keeps the draft through an outside press and a failed save, and retries with the same key", async () => {
    let posts = 0;
    const { calls } = open({
      "POST /api/contents/c1/notes": () => {
        posts += 1;
        return posts === 1 ? FAILURE : { status: 201, body: note("n9", { comment: "想法" }) };
      },
    });
    fireEvent.click(screen.getByTestId("start-compose"));
    fireEvent.change(await screen.findByTestId("note-compose-input"), { target: { value: "想法" } });
    await settle();
    pressOutside();
    expect(screen.getByTestId("note-dirty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("note-compose-save"));
    await waitFor(() => expect(screen.getByTestId("note-compose-save").textContent).toBe("重试"));
    expect((screen.getByTestId("note-compose-input") as HTMLTextAreaElement).value).toBe("想法");
    fireEvent.click(screen.getByTestId("note-compose-save"));
    await waitFor(() => expect(screen.queryByTestId("note-compose")).toBeNull());
    const sent = writes(calls);
    expect(sent.length).toBe(2);
    expect(sent[1]?.headers["idempotency-key"]).toBe(sent[0]?.headers["idempotency-key"]);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
  });

  it("stays open for a selection whose first sentence is not in the document while its last one is", async () => {
    open();
    // A selection across more screens than the windowed list keeps: its first row is unmounted.
    fireEvent.click(screen.getByTestId("toggle-run"));
    fireEvent.click(screen.getByTestId("start-compose-across"));
    const compose = await screen.findByTestId("note-compose");
    await settle();
    expect(screen.getByTestId("note-popover").contains(compose)).toBe(true);
    expect(document.activeElement).toBe(within(compose).getByTestId("note-compose-input"));
  });

  it("closes an untouched draft once neither end of its selection is in the document", async () => {
    open();
    fireEvent.click(screen.getByTestId("start-compose"));
    await screen.findByTestId("note-compose");
    fireEvent.click(screen.getByTestId("toggle-run"));
    await waitFor(() => expect(screen.queryByTestId("note-compose")).toBeNull());
  });

  it("refuses a second draft while one is unsaved", async () => {
    open();
    fireEvent.click(screen.getByTestId("start-compose"));
    fireEvent.change(await screen.findByTestId("note-compose-input"), { target: { value: "草稿" } });
    fireEvent.click(screen.getByTestId("note-run"));
    expect(screen.getByTestId("note-compose")).toBeTruthy();
    expect((screen.getByTestId("note-compose-input") as HTMLTextAreaElement).value).toBe("草稿");
  });
});
