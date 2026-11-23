import { describe, expect, it } from "vitest";
import {
  chosenDuration,
  emptySession,
  hoursAndMinutes,
  missingChoice,
  movedToFront,
  platformOrder,
  processingOrder,
  pruneChoice,
  rangeBetween,
  setChosen,
  withDefaults,
  withFirstPage,
  withOrder,
  withPage,
  type PreviewEntry,
  type PreviewSession,
} from "../../../../src/web/components/collection-preview/state.ts";

const URL = "https://www.youtube.com/playlist?list=PLabcdefghij0123456789";

/** `durationMs: null` lists the entry without a duration. */
function entry(id: string, state: PreviewEntry["state"] = "new", durationMs: number | null = 60_000): PreviewEntry {
  return { platformContentId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, title: id, state, ...(durationMs === null ? {} : { durationMs }) };
}

function page(items: PreviewEntry[], extra: Record<string, unknown> = {}) {
  return { kind: "collection" as const, canonicalUrl: URL, previewId: "pv1", itemCount: 100, items, ...extra };
}

/** A first page read, then the defaults within `budget` (a no-op once the session was chosen). */
function firstPage(session: PreviewSession, read: ReturnType<typeof page>, budget: number): PreviewSession {
  return withDefaults(withFirstPage(session, read), budget);
}

describe("collection preview state", () => {
  it("chooses nothing on reading the first page alone; the defaults are given separately", () => {
    const session = withFirstPage(emptySession(URL), page([entry("a"), entry("b")]));
    expect(session.entries.map((item) => item.platformContentId)).toEqual(["a", "b"]);
    expect(session.selected.size).toBe(0);
    expect(session.chosen).toBe(false);
    const chosen = withDefaults(session, 1);
    expect([...chosen.selected]).toEqual(["a"]);
    expect(withDefaults(setChosen(chosen, ["b"], true), 0)).toEqual(setChosen(chosen, ["b"], true));
  });

  it("chooses the first page's entries not imported yet, never trashed, unavailable or already in the collection", () => {
    const session = firstPage(
      emptySession(URL),
      page([entry("a"), entry("b", "in_library"), entry("c", "processing"), entry("d", "in_collection"), entry("e", "trashed"), entry("f", "unavailable")]),
      50,
    );
    expect([...session.selected]).toEqual(["a", "b", "c"]);
    expect(session.chosen).toBe(true);
  });

  it("keeps the default choice within the budget left by other collections", () => {
    const session = firstPage(emptySession(URL), page([entry("a"), entry("b"), entry("c")]), 2);
    expect([...session.selected]).toEqual(["a", "b"]);
    expect(firstPage(emptySession(URL), page([entry("a")]), -3).selected.size).toBe(0);
  });

  it("never adds to the user's choice on a later read, and drops only what is gone or no longer choosable", () => {
    const first = setChosen(firstPage(emptySession(URL), page([entry("a"), entry("b"), entry("c")]), 50), ["a"], false);
    const reread = firstPage(first, page([entry("z"), entry("b", "trashed"), entry("c")]), 50);
    expect([...reread.selected].sort()).toEqual(["b", "c"]);
    expect([...pruneChoice(reread).selected]).toEqual(["c"]);
  });

  it("tells whether chosen entries are still to be found on later pages", () => {
    const session = { ...emptySession(URL), entries: [entry("a")], selected: new Set(["a", "q"]) };
    expect(missingChoice(session)).toBe(true);
    expect(missingChoice(withPage(session, page([entry("q")])))).toBe(false);
  });

  it("appends later pages without listing an entry twice", () => {
    const session = withPage(firstPage(emptySession(URL), page([entry("a"), entry("b")], { nextOffset: 2 }), 50), page([entry("b"), entry("c")]));
    expect(session.entries.map((item) => item.platformContentId)).toEqual(["a", "b", "c"]);
    expect(session.nextOffset).toBeUndefined();
  });

  it("orders the chosen entries by the platform until the user arranges them, then adds new choices at the end", () => {
    let session = firstPage(emptySession(URL), page([entry("a"), entry("b"), entry("c"), entry("d", "in_collection")]), 50);
    expect(processingOrder(session)).toEqual(["a", "b", "c"]);
    session = movedToFront(session, "c");
    expect(processingOrder(session)).toEqual(["c", "a", "b"]);
    session = setChosen(session, ["d"], true);
    expect(processingOrder(session)).toEqual(["c", "a", "b", "d"]);
    session = setChosen(session, ["a"], false);
    expect(processingOrder(session)).toEqual(["c", "b", "d"]);
    session = withOrder(session, ["d", "b", "c"]);
    expect(processingOrder(session)).toEqual(["d", "b", "c"]);
    expect(processingOrder(platformOrder(session))).toEqual(["b", "c", "d"]);
  });

  it("does not choose entries that cannot be chosen", () => {
    const session = firstPage(emptySession(URL), page([entry("a", "trashed"), entry("b", "unavailable")]), 50);
    expect(setChosen(session, ["a", "b"], true).selected.size).toBe(0);
  });

  it("sums the chosen durations and says when some are unknown", () => {
    const session = firstPage(emptySession(URL), page([entry("a", "new", 3_600_000), entry("b", "new", 720_000), entry("c", "new", null)]), 50);
    expect(chosenDuration(session)).toEqual({ totalMs: 4_320_000, complete: false });
    expect(chosenDuration(setChosen(session, ["c"], false))).toEqual({ totalMs: 4_320_000, complete: true });
    expect(chosenDuration(setChosen(session, ["a", "b"], false))).toBeUndefined();
    expect(hoursAndMinutes(4_320_000)).toEqual({ hours: 1, minutes: 12 });
    expect(hoursAndMinutes(3_599_000)).toEqual({ hours: 1, minutes: 0 });
  });

  it("takes a Shift range in either direction", () => {
    expect(rangeBetween(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(["a", "b"], "x", "b")).toBeUndefined();
  });
});
