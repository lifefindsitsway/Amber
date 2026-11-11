import { describe, expect, it } from "vitest";
import { draftKey, type DraftSegment } from "../../../../src/web/pages/content/speaker-draft.ts";
import { leadViews, LeadStore } from "../../../../src/web/pages/content/use-speaker-editing.tsx";

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
