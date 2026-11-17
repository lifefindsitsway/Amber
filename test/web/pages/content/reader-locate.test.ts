import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_LOCATE_PULSE_MS, READER_LOCATE_VIEWPORT_RATIO } from "../../../../src/shared/defaults.ts";
import type { TranscriptSegmentDto } from "../../../../src/shared/dto/transcript.ts";
import {
  LOCATE_PULSE_ATTRIBUTE,
  LocatePulse,
  locateAvailability,
  locateOffset,
  locateTarget,
  PendingLocate,
  useReaderLocate,
} from "../../../../src/web/pages/content/reader-locate.ts";
import { readerSections, viewRowKey, viewRows } from "../../../../src/web/pages/content/reader-rows.ts";
import { filteredRowKey, type FilteredRow } from "../../../../src/web/pages/content/speaker-filter.ts";
import type { RestoreLoopResult, VirtualRowsHandle } from "../../../../src/web/pages/content/virtual-rows.tsx";
import { segment } from "../../../fixtures/web/content-data.ts";

/** Sentences 1 s long with a 1 s pause after each: a pause shorter than a paragraph break. */
const SENTENCES: TranscriptSegmentDto[] = ["a", "b", "c", "d"].map((id, index) => segment(id, index, index * 2_000, index * 2_000 + 1_000, `${id}。`));

describe("locateTarget", () => {
  it("takes the sentence playing now", () => {
    expect(locateTarget(SENTENCES, 2_500)?.id).toBe("b");
    expect(locateTarget(SENTENCES, 2_000)?.id).toBe("b");
  });

  it("takes 0 ms as a time", () => {
    expect(locateTarget(SENTENCES, 0)?.id).toBe("a");
  });

  it("has nothing without a time or without sentences", () => {
    expect(locateTarget(SENTENCES, undefined)).toBeUndefined();
    expect(locateTarget([], 1_000)).toBeUndefined();
  });

  it("in a pause, takes the sentence whose span is nearest", () => {
    // b ends at 3000, c starts at 4000.
    expect(locateTarget(SENTENCES, 3_200)?.id).toBe("b");
    expect(locateTarget(SENTENCES, 3_800)?.id).toBe("c");
    // A sentence's end is exclusive: at it, playback has just left the sentence, which is still the nearest.
    expect(locateTarget(SENTENCES, 3_000)?.id).toBe("b");
  });

  it("in a pause equally far from two sentences, takes the later one", () => {
    expect(locateTarget(SENTENCES, 3_500)?.id).toBe("c");
  });

  it("before the first and after the last sentence, takes those", () => {
    const late = [segment("x", 0, 5_000, 6_000, "x。"), segment("y", 1, 7_000, 8_000, "y。")];
    expect(locateTarget(late, 0)?.id).toBe("x");
    expect(locateTarget(late, 60_000)?.id).toBe("y");
  });

  it("with overlapping sentences, takes the reader's primary: the pinned one while it covers the time, else the later start", () => {
    const overlap = [segment("long", 0, 0, 10_000, "长。"), segment("short", 1, 4_000, 6_000, "插话。")];
    expect(locateTarget(overlap, 5_000)?.id).toBe("short");
    expect(locateTarget(overlap, 5_000, "long")?.id).toBe("long");
    expect(locateTarget(overlap, 8_000, "short")?.id).toBe("long");
  });
});

describe("locateAvailability and locateOffset", () => {
  it("is absent without time tracking, waiting without a time, ready with one (0 ms included)", () => {
    expect(locateAvailability(false, 1_000)).toBe("absent");
    expect(locateAvailability(false, undefined)).toBe("absent");
    expect(locateAvailability(true, undefined)).toBe("waiting");
    expect(locateAvailability(true, 0)).toBe("ready");
    expect(locateAvailability(true, 12_345)).toBe("ready");
  });

  it("places the first line at the configured share of the reading area's height", () => {
    expect(locateOffset(600)).toBeCloseTo(600 * READER_LOCATE_VIEWPORT_RATIO);
    expect(locateOffset(0)).toBe(0);
  });
});

describe("PendingLocate", () => {
  const view = (shown: readonly string[], filterKey: string, revisionId = "r1") => ({ revisionId, filterKey, shows: (id: string) => shown.includes(id) });

  it("waits while the filter has not cleared, then hands out the sentence once", () => {
    const pending = new PendingLocate();
    pending.register({ segmentId: "c", revisionId: "r1", filterKey: "sp1", area: null });
    expect(pending.segmentId).toBe("c");
    expect(pending.take(view(["a"], "sp1"))).toBeUndefined();
    expect(pending.segmentId).toBe("c");
    expect(pending.take(view(["a", "c"], ""))).toBe("c");
    expect(pending.segmentId).toBeUndefined();
    expect(pending.take(view(["a", "c"], ""))).toBeUndefined();
  });

  it("is dropped when the filter changes to another selection that still hides the sentence", () => {
    const pending = new PendingLocate();
    pending.register({ segmentId: "c", revisionId: "r1", filterKey: "sp1", area: null });
    expect(pending.take(view(["b"], "sp2"))).toBeUndefined();
    expect(pending.segmentId).toBeUndefined();
    // Even if the sentence shows later, nothing is waiting for it any more.
    expect(pending.take(view(["c"], ""))).toBeUndefined();
  });

  it("is dropped when the rows belong to another revision", () => {
    const pending = new PendingLocate();
    pending.register({ segmentId: "c", revisionId: "r1", filterKey: "sp1", area: null });
    expect(pending.take(view(["c"], "", "r2"))).toBeUndefined();
    expect(pending.segmentId).toBeUndefined();
  });

  it.each(["wheel", "touchstart", "keydown", "pointerdown"])("is dropped by %s in the reading area, and stops listening", (type) => {
    const area = document.createElement("div");
    const inner = document.createElement("span");
    area.append(inner);
    const removed = vi.spyOn(area, "removeEventListener");
    const pending = new PendingLocate();
    pending.register({ segmentId: "c", revisionId: "r1", filterKey: "sp1", area });
    inner.dispatchEvent(new Event(type, { bubbles: true }));
    expect(pending.segmentId).toBeUndefined();
    expect(removed).toHaveBeenCalledTimes(4);
    expect(pending.take(view(["c"], ""))).toBeUndefined();
  });

  it("is dropped by cancel, and a new registration replaces the old one", () => {
    const area = document.createElement("div");
    const pending = new PendingLocate();
    pending.register({ segmentId: "b", revisionId: "r1", filterKey: "sp1", area });
    pending.register({ segmentId: "c", revisionId: "r1", filterKey: "sp1", area });
    expect(pending.segmentId).toBe("c");
    pending.cancel();
    expect(pending.segmentId).toBeUndefined();
    // Listeners of the dropped registrations are gone: input now changes nothing.
    pending.register({ segmentId: "d", revisionId: "r1", filterKey: "sp1", area: null });
    area.dispatchEvent(new Event("wheel"));
    expect(pending.segmentId).toBe("d");
  });

  it("stops listening once spent", () => {
    const area = document.createElement("div");
    const removed = vi.spyOn(area, "removeEventListener");
    const pending = new PendingLocate();
    pending.register({ segmentId: "c", revisionId: "r1", filterKey: "sp1", area });
    expect(pending.take(view(["c"], ""))).toBe("c");
    expect(removed).toHaveBeenCalledTimes(4);
  });
});

describe("LocatePulse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the element for the fade's length, then leaves nothing behind", () => {
    const element = document.createElement("span");
    const pulse = new LocatePulse();
    pulse.start(element);
    expect(element.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(true);
    expect(element.style.getPropertyValue("--reader-locate-pulse")).toBe(`${READER_LOCATE_PULSE_MS}ms`);
    vi.advanceTimersByTime(READER_LOCATE_PULSE_MS - 1);
    expect(element.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(element.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(false);
    expect(element.getAttribute("style") ?? "").toBe("");
  });

  it("starts again on a repeat, for a whole fade from the repeat", () => {
    const element = document.createElement("span");
    const pulse = new LocatePulse();
    pulse.start(element);
    vi.advanceTimersByTime(READER_LOCATE_PULSE_MS - 100);
    const removed = vi.spyOn(element, "removeAttribute");
    pulse.start(element);
    // The attribute went away and came back, which restarts the animation.
    expect(removed).toHaveBeenCalledWith(LOCATE_PULSE_ATTRIBUTE);
    expect(element.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(true);
    vi.advanceTimersByTime(READER_LOCATE_PULSE_MS - 1);
    expect(element.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(element.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(false);
  });

  it("moves to another element at once, and stop clears it early", () => {
    const first = document.createElement("span");
    const second = document.createElement("span");
    const pulse = new LocatePulse();
    pulse.start(first);
    pulse.start(second);
    expect(first.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(false);
    expect(second.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(true);
    pulse.stop();
    expect(second.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a row unmounted meanwhile alone, and a fresh one unmarked", () => {
    const row = document.createElement("div");
    const element = document.createElement("span");
    row.append(element);
    document.body.append(row);
    const pulse = new LocatePulse();
    pulse.start(element);
    row.remove();
    vi.advanceTimersByTime(READER_LOCATE_PULSE_MS);
    expect(element.hasAttribute(LOCATE_PULSE_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useReaderLocate", () => {
  /** Paragraphs split by pauses longer than a paragraph break: one row per sentence. */
  const SPREAD = ["a", "b", "c", "d"].map((id, index) => segment(id, index, index * 10_000, index * 10_000 + 5_000, `${id}。`, { speakerId: index % 2 === 0 ? "sp1" : "sp2" }));
  const ALL: FilteredRow[] = viewRows(readerSections(SPREAD, []), { turns: false });
  /** 「只看」 sp1: only a and c; b and d are hidden. */
  const ONLY_SP1: FilteredRow[] = ALL.filter((row) => row.kind === "paragraph" && row.paragraph.segments.every((item) => item.speakerId === "sp1"));
  const rowKey = (row: FilteredRow): string => filteredRowKey(row, viewRowKey);

  /** A scroller 500 px tall holding a span per sentence, and a handle that records its restores. */
  function setup() {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
    for (const item of SPREAD) {
      const span = document.createElement("span");
      span.setAttribute("data-segment-id", item.id);
      scroller.append(span);
    }
    const area = document.createElement("div");
    area.append(scroller);
    document.body.append(area);
    const restores: Array<{ target: { rowKey: string; segmentId: string; offset: number }; onDone: ((result: RestoreLoopResult) => void) | undefined }> = [];
    const handle = {
      restoreSegment: (target: { rowKey: string; segmentId: string; offset: number }, onDone?: (result: RestoreLoopResult) => void) => {
        restores.push({ target, onDone });
      },
    } as unknown as VirtualRowsHandle;
    const reader: RefObject<VirtualRowsHandle | null> = { current: handle };
    return { scroller, area, reader, restores };
  }

  interface Props {
    tracking: boolean;
    time: number | undefined;
    rows: FilteredRow[];
    filterKey: string;
    navigation: number;
    revisionId: string;
  }

  function mount(initial: Partial<Props> = {}) {
    const { scroller, area, reader, restores } = setup();
    const calls: string[] = [];
    const clear = vi.fn(() => calls.push("clear"));
    const onNavigate = vi.fn(() => calls.push("navigate"));
    const props: Props = { tracking: true, time: 12_000, rows: ALL, filterKey: "", navigation: 0, revisionId: "r1", ...initial };
    const hook = renderHook((p: Props) =>
      useReaderLocate({
        reader,
        area,
        scroller: () => scroller,
        revisionId: p.revisionId,
        segments: SPREAD,
        tracking: p.tracking,
        time: p.time,
        pinnedId: undefined,
        rows: p.rows,
        rowKey,
        filter: { active: p.filterKey !== "", key: p.filterKey, clear },
        onNavigate,
        navigation: p.navigation,
      }),
    { initialProps: props });
    const rerender = (next: Partial<Props>): void => {
      Object.assign(props, next);
      hook.rerender({ ...props });
    };
    return { hook, rerender, scroller, area, restores, clear, onNavigate, calls };
  }

  it("has no button without time tracking, a waiting one without a time, and a ready one at 0 ms", () => {
    expect(mount({ tracking: false }).hook.result.current.button).toBeUndefined();
    const waiting = mount({ time: undefined }).hook.result.current.button;
    expect(waiting).toMatchObject({ waiting: true, showsAll: false });
    expect(mount({ time: 0 }).hook.result.current.button).toMatchObject({ waiting: false, showsAll: false });
  });

  it("does nothing while waiting", () => {
    const { hook, restores, onNavigate } = mount({ time: undefined });
    act(() => hook.result.current.button?.onLocate());
    expect(restores).toEqual([]);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("first ends any other navigation, then puts the sentence's row and first line at the configured height; never seeks or selects", () => {
    const { hook, restores, onNavigate } = mount({ time: 12_000 });
    act(() => hook.result.current.button?.onLocate());
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(restores.map((restore) => restore.target)).toEqual([{ rowKey: "b", segmentId: "b", offset: 500 * READER_LOCATE_VIEWPORT_RATIO }]);
  });

  it("in a pause, goes to the nearest sentence, the later one on a tie", () => {
    // b ends at 15000, c starts at 20000.
    const { hook, rerender, restores } = mount({ time: 16_000 });
    act(() => hook.result.current.button?.onLocate());
    rerender({ time: 17_500 });
    act(() => hook.result.current.button?.onLocate());
    expect(restores.map((restore) => restore.target.segmentId)).toEqual(["b", "c"]);
  });

  describe("the arrival fade", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each<RestoreLoopResult>(["settled", "edge", "capped"])("marks the sentence once the scroll ended %s", (result) => {
      const { hook, scroller, restores } = mount({ time: 12_000 });
      act(() => hook.result.current.button?.onLocate());
      restores[0]?.onDone?.(result);
      const marked = scroller.querySelector(`[${LOCATE_PULSE_ATTRIBUTE}]`);
      expect(marked?.getAttribute("data-segment-id")).toBe("b");
      vi.advanceTimersByTime(READER_LOCATE_PULSE_MS);
      expect(scroller.querySelector(`[${LOCATE_PULSE_ATTRIBUTE}]`)).toBeNull();
    });

    it.each<RestoreLoopResult>(["cancelled", "missing"])("marks nothing when the scroll ended %s", (result) => {
      const { hook, scroller, restores } = mount({ time: 12_000 });
      act(() => hook.result.current.button?.onLocate());
      restores[0]?.onDone?.(result);
      expect(scroller.querySelector(`[${LOCATE_PULSE_ATTRIBUTE}]`)).toBeNull();
    });

    it("clears the mark when the reader unmounts", () => {
      const { hook, scroller, restores } = mount({ time: 12_000 });
      act(() => hook.result.current.button?.onLocate());
      restores[0]?.onDone?.("settled");
      hook.unmount();
      expect(scroller.querySelector(`[${LOCATE_PULSE_ATTRIBUTE}]`)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("with 「只看」 hiding the playing sentence", () => {
    it("says it will show every speaker, clears the filter after ending other navigations, and scrolls once the rows show the sentence", () => {
      const { hook, rerender, restores, calls } = mount({ time: 12_000, rows: ONLY_SP1, filterKey: "sp1" });
      expect(hook.result.current.button).toMatchObject({ waiting: false, showsAll: true });
      act(() => hook.result.current.button?.onLocate());
      expect(calls).toEqual(["navigate", "clear"]);
      expect(restores).toEqual([]);
      // A render before the address changed (the player's time moving on) keeps it waiting.
      rerender({ time: 12_100 });
      expect(restores).toEqual([]);
      rerender({ rows: ALL, filterKey: "" });
      expect(restores.map((restore) => restore.target)).toEqual([{ rowKey: "b", segmentId: "b", offset: 500 * READER_LOCATE_VIEWPORT_RATIO }]);
      expect(hook.result.current.button?.showsAll).toBe(false);
      // One-shot: later renders do not scroll again.
      rerender({ time: 12_200 });
      expect(restores).toHaveLength(1);
    });

    it("does not say so, nor clear the filter, when the playing sentence is shown", () => {
      const { hook, restores, clear } = mount({ time: 22_000, rows: ONLY_SP1, filterKey: "sp1" });
      expect(hook.result.current.button?.showsAll).toBe(false);
      act(() => hook.result.current.button?.onLocate());
      expect(clear).not.toHaveBeenCalled();
      expect(restores.map((restore) => restore.target.segmentId)).toEqual(["c"]);
    });

    it.each(["wheel", "touchstart", "keydown", "pointerdown"])("is dropped by %s in the reading area before the rows update", (type) => {
      const { hook, rerender, restores, scroller } = mount({ time: 12_000, rows: ONLY_SP1, filterKey: "sp1" });
      act(() => hook.result.current.button?.onLocate());
      scroller.dispatchEvent(new Event(type, { bubbles: true }));
      rerender({ rows: ALL, filterKey: "" });
      expect(restores).toEqual([]);
    });

    it("is dropped by another navigation on the page", () => {
      const { hook, rerender, restores } = mount({ time: 12_000, rows: ONLY_SP1, filterKey: "sp1" });
      act(() => hook.result.current.button?.onLocate());
      rerender({ navigation: 1 });
      rerender({ rows: ALL, filterKey: "" });
      expect(restores).toEqual([]);
    });

    it("is dropped by the reader's own navigation (cancel)", () => {
      const { hook, rerender, restores } = mount({ time: 12_000, rows: ONLY_SP1, filterKey: "sp1" });
      act(() => hook.result.current.button?.onLocate());
      act(() => hook.result.current.cancel());
      rerender({ rows: ALL, filterKey: "" });
      expect(restores).toEqual([]);
    });

    it("is dropped when the filter changes to other speakers instead", () => {
      const { hook, rerender, restores } = mount({ time: 12_000, rows: ONLY_SP1, filterKey: "sp1" });
      act(() => hook.result.current.button?.onLocate());
      rerender({ rows: ONLY_SP1.slice(0, 1), filterKey: "sp1,sp3" });
      rerender({ rows: ALL, filterKey: "" });
      expect(restores).toEqual([]);
    });

    it("is dropped when another revision is shown", () => {
      const { hook, rerender, restores } = mount({ time: 12_000, rows: ONLY_SP1, filterKey: "sp1" });
      act(() => hook.result.current.button?.onLocate());
      rerender({ rows: ALL, filterKey: "", revisionId: "r2" });
      expect(restores).toEqual([]);
    });
  });
});
