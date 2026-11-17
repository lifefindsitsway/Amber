import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SpeakerDto } from "../../../../src/shared/dto/speaker.ts";
import { draftKey, type DraftSegment } from "../../../../src/web/pages/content/speaker-draft.ts";
import { countMissingSpeakers, leadViews, LeadStore, MenuSignal, nextRoster } from "../../../../src/web/pages/content/use-speaker-editing.tsx";
import { mockApi } from "../../../fixtures/web/render.tsx";
import { renderSpeakerEditor } from "../../../fixtures/web/speaker-editor.tsx";
import { MANAGED, managedRoutes } from "../../../fixtures/web/speaker-management.ts";

// The editor's result, as the draft editor got it on its last render.
const captured = vi.hoisted(() => ({ editing: undefined as unknown }));
vi.mock("../../../../src/web/pages/content/use-speaker-editing.tsx", async (original) => {
  const actual = await original<typeof import("../../../../src/web/pages/content/use-speaker-editing.tsx")>();
  return {
    ...actual,
    useSpeakerEditing: (...args: Parameters<typeof actual.useSpeakerEditing>) => {
      const result = actual.useSpeakerEditing(...args);
      captured.editing = result;
      return result;
    },
  };
});
type Editing = ReturnType<typeof import("../../../../src/web/pages/content/use-speaker-editing.tsx").useSpeakerEditing>;
const editing = (): Editing => captured.editing as Editing;
const leads = () => screen.getAllByTestId("speaker-lead");

const seg = (id: string): DraftSegment => ({ id, startMs: 0, endMs: 1_000, text: id, sourceSegmentIds: [id] });
const segments = ["1", "2", "3", "4", "5"].map(seg);
const resolved = ["a", "a", "b", "b", "a"];

describe("leadViews", () => {
  it("names the first sentence of each stretch of one speaker", () => {
    const views = leadViews(segments, resolved, new Set(), undefined, undefined, []);
    expect(views.map((view) => view.showName)).toEqual([true, false, true, false, true]);
  });

  it("under a filter names the first sentence of each stretch on screen, though its turn began before", () => {
    const views = leadViews(segments, resolved, new Set(), undefined, new Set([1, 3, 4]), []);
    expect(views[1]?.showName).toBe(true);
    // Sentence 3 follows a hidden one; 4 follows a shown sentence of another speaker.
    expect(views[3]?.showName).toBe(true);
    expect(views[4]?.showName).toBe(true);
    expect(leadViews(segments, resolved, new Set(), undefined, new Set([0, 1]), [])[1]?.showName).toBe(false);
  });

  it("marks selected sentences by key and keeps exactly one tab stop: the active sentence, else the first shown", () => {
    const selected = new Set([draftKey(segments[2] as DraftSegment, 2)]);
    expect(leadViews(segments, resolved, selected, undefined, undefined, []).map((view) => view.selected)).toEqual([false, false, true, false, false]);
    expect(leadViews(segments, resolved, new Set(), 3, undefined, []).map((view) => view.tabbable)).toEqual([false, false, false, true, false]);
    expect(leadViews(segments, resolved, new Set(), 3, new Set([1, 2]), []).map((view) => view.tabbable)).toEqual([false, true, false, false, false]);
  });

  it("reuses the views that did not change, so only the columns that changed render again", () => {
    const first = leadViews(segments, resolved, new Set(), undefined, undefined, []);
    const second = leadViews(segments, resolved, new Set([draftKey(segments[4] as DraftSegment, 4)]), undefined, undefined, first);
    expect(second.slice(0, 4).every((view, index) => view === first[index])).toBe(true);
    expect(second[4]).not.toBe(first[4]);
  });
});

describe("LeadStore", () => {
  it("tells subscribers only when some view is a new object", () => {
    const store = new LeadStore();
    let calls = 0;
    store.subscribe(() => (calls += 1));
    const views = leadViews(segments, resolved, new Set(), undefined, undefined, []);
    store.set(views);
    store.set(views);
    store.set(leadViews(segments, resolved, new Set(), undefined, undefined, views));
    expect(calls).toBe(1);
  });
});

describe("speakers of comparison transcriptions in the editor", () => {
  it("are offered in no roster, used or not, while the draft does not name them", async () => {
    const compared: SpeakerDto = { id: "spk-x", ordinal: 4, colorIndex: 3, used: true, comparisonOnly: true, referenced: true };
    mockApi(managedRoutes({ speakers: [...MANAGED, compared] }).routes);
    renderSpeakerEditor();
    fireEvent.click(await screen.findByTestId("speaker-panel-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("speaker-panel-row").length).toBeGreaterThan(0));
    const listed = () => screen.getAllByTestId("speaker-panel-row").map((row) => row.getAttribute("data-speaker-id"));
    expect(listed()).toEqual(["spk-a", "spk-b", "spk-c"]);
  });
});

const speaker = (id: string, ordinal: number, used = false): SpeakerDto => ({ id, ordinal, colorIndex: 0, used, referenced: used });

describe("nextRoster", () => {
  const a = speaker("a", 1, true);
  const b = speaker("b", 2, true);
  const c = speaker("c", 3);
  const eligible = (ids: string[]) => (item: SpeakerDto) => ids.includes(item.id);

  it("fixes the first roster in ordinal order, whatever order the list comes in", () => {
    expect(nextRoster([], [b, c, a], eligible(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("only appends a speaker that becomes eligible later, and keeps one that stops being so", () => {
    const first = nextRoster([], [a, b, c], eligible(["a", "b"]));
    const late = speaker("z", 0);
    expect(nextRoster(first, [late, a, b, c], eligible(["b", "c", "z"]))).toEqual(["a", "b", "z", "c"]);
  });

  it("drops a speaker that is no longer offered, and returns the same roster when nothing changes", () => {
    const first = nextRoster([], [a, b, c], eligible(["a", "b", "c"]));
    expect(nextRoster(first, [a, b, c], eligible(["a", "b", "c"]))).toBe(first);
    expect(nextRoster(first, [a, c], eligible(["a", "b", "c"]))).toEqual(["a", "c"]);
  });
});

describe("countMissingSpeakers", () => {
  it("counts the sentences naming a speaker the list does not have; unassigned ones are not missing", () => {
    expect(countMissingSpeakers(["a", null, "gone", "gone", "b"], new Set(["a", "b"]))).toBe(2);
    expect(countMissingSpeakers([null, "a"], new Map([["a", 1]]))).toBe(0);
  });
});

describe("MenuSignal", () => {
  it("changes the value of the requested column only, until the column takes the request", () => {
    const signal = new MenuSignal();
    let calls = 0;
    signal.subscribe(() => (calls += 1));
    expect(signal.nonceFor(3)).toBe(0);
    signal.request(3);
    const first = signal.nonceFor(3);
    expect(first).toBeGreaterThan(0);
    expect(signal.nonceFor(2)).toBe(0);
    signal.request(3);
    expect(signal.nonceFor(3)).not.toBe(first);
    signal.consume(2);
    expect(signal.nonceFor(3)).toBeGreaterThan(0);
    signal.consume(3);
    expect(signal.nonceFor(3)).toBe(0);
    expect(calls).toBe(3);
  });
});

describe("the ways in from the reading view", () => {
  it("opens a sentence's speaker menu with the focus on its column", async () => {
    mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    await waitFor(() => expect(leads()).toHaveLength(6));
    act(() => editing().openMenuAt(3));
    const menu = await screen.findByTestId("speaker-menu");
    expect(within(menu).getByTestId("speaker-menu-scope-sentence").textContent).toContain("0:12–0:16");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("speaker-menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(leads()[3]));
  });

  it("does nothing for a sentence a filter hides", async () => {
    mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    act(() => editing().setFilter({ kind: "speaker", speakerId: "spk-b" }));
    await waitFor(() => expect(leads()).toHaveLength(3));
    act(() => editing().openMenuAt(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("speaker-menu")).toBeNull();
  });
});

describe("sentences naming a deleted speaker", () => {
  it("are counted once the list has arrived, and made unassigned as one undoable step", async () => {
    mockApi(managedRoutes({ speakers: MANAGED.filter((speaker) => speaker.id !== "spk-b") }).routes);
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    await waitFor(() => expect(editing().missingCount).toBe(3));
    let changed = 0;
    act(() => {
      changed = editing().unassignMissing();
    });
    expect(changed).toBe(3);
    await waitFor(() => expect(editing().missingCount).toBe(0));
    expect(leads().map((lead) => lead.getAttribute("aria-label"))).toEqual(["发言人：陈明", "发言人：陈明", "发言人：未分配", "发言人：未分配", "发言人：未分配", "发言人：陈明"]);
    expect(screen.getByTestId("editor-undo").getAttribute("aria-label")).toBe("撤销：设为未分配（3 句）");
    let again = -1;
    act(() => {
      again = editing().unassignMissing();
    });
    expect(again).toBe(0);
  });
});
