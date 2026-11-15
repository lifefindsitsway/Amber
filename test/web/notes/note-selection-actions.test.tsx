import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NOTE_SPAN_MAX_SEGMENTS } from "../../../src/shared/defaults.ts";
import { NoteSelectionActions } from "../../../src/web/notes/note-selection-actions.tsx";
import { NotesUiProvider } from "../../../src/web/notes/note-ui-context.tsx";
import { ContentPageProvider } from "../../../src/web/pages/content/content-context.tsx";
import { useSegments } from "../../../src/web/pages/content/content-data.ts";
import type { SelectionBounds } from "../../../src/web/ui/dom-selection.ts";
import { revision, segment, SEGMENTS } from "../../fixtures/web/content-data.ts";
import { pageState } from "../../fixtures/web/reader-speakers.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const BUTTONS = ["selection-note-underline", "selection-note-background", "selection-note-comment"] as const;
const RECT = { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 };
const GAP_REASON = "选区包含未显示的原文，请显示完整原文后再建笔记";

/** Shows once the sentences the actions check against have arrived. */
function Loaded() {
  const segments = useSegments("r1");
  return segments.data === undefined ? null : <span data-testid="loaded" />;
}

function mount(bounds: SelectionBounds, crossesGap: boolean | undefined, items = SEGMENTS) {
  const { calls } = mockApi({ "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items } } });
  renderApp(
    <ContentPageProvider value={pageState()}>
      <NotesUiProvider>
        <NoteSelectionActions bounds={bounds} rect={RECT} close={() => undefined} {...(crossesGap === undefined ? {} : { crossesGap })} />
        <Loaded />
      </NotesUiProvider>
    </ContentPageProvider>,
    { route: "/contents/c1?tab=transcript", path: "/contents/:id" },
  );
  return calls;
}

const within = (from: number, to: number): SelectionBounds => ({ revisionId: "r1", start: { segmentId: "s1", offset: from }, end: { segmentId: "s1", offset: to } });

async function buttons(): Promise<HTMLButtonElement[]> {
  return Promise.all(BUTTONS.map(async (id) => (await screen.findByTestId(id)) as HTMLButtonElement));
}

describe("NoteSelectionActions", () => {
  it("offers the three actions for a selection the view shows whole", async () => {
    mount(within(0, 2), false);
    await screen.findByTestId("loaded");
    for (const button of await buttons()) {
      expect(button.disabled).toBe(false);
      expect(button.title).toBe("");
    }
  });

  it("disables the three actions with the reason when the selection crosses hidden text, and posts nothing", async () => {
    const calls = mount(within(0, 2), true);
    // Once the sentences are in, only the hidden text can be what disables them.
    await screen.findByTestId("loaded");
    for (const button of await buttons()) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(GAP_REASON);
      fireEvent.click(button);
    }
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(screen.queryByTestId("note-compose")).toBeNull();
  });

  it("gives the too-long reason for a selection over too many sentences without hidden text", async () => {
    const many = Array.from({ length: NOTE_SPAN_MAX_SEGMENTS + 1 }, (_, index) => segment(`m${index}`, index, index * 1_000, index * 1_000 + 900, `第${index}句。`));
    const tooLong: SelectionBounds = { revisionId: "r1", start: { segmentId: "m0", offset: 0 }, end: { segmentId: `m${NOTE_SPAN_MAX_SEGMENTS}`, offset: 2 } };
    mount(tooLong, false, many);
    await waitFor(async () => expect((await buttons())[0]?.title).toBe(`一条笔记最多跨 ${NOTE_SPAN_MAX_SEGMENTS} 句`));
  });

  it("names the hidden text first even when the selection is also too long", async () => {
    const many = Array.from({ length: NOTE_SPAN_MAX_SEGMENTS + 1 }, (_, index) => segment(`m${index}`, index, index * 1_000, index * 1_000 + 900, `第${index}句。`));
    const tooLong: SelectionBounds = { revisionId: "r1", start: { segmentId: "m0", offset: 0 }, end: { segmentId: `m${NOTE_SPAN_MAX_SEGMENTS}`, offset: 2 } };
    mount(tooLong, true, many);
    await screen.findByTestId("loaded");
    for (const button of await buttons()) expect(button.title).toBe(GAP_REASON);
  });

  it("names the hidden text first when the selected sentences are unknown", async () => {
    mount({ revisionId: "r1", start: { segmentId: "gone", offset: 0 }, end: { segmentId: "gone", offset: 1 } }, true);
    await screen.findByTestId("loaded");
    for (const button of await buttons()) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(GAP_REASON);
    }
  });
});
