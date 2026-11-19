import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef, useLayoutEffect, useRef, useState } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { VirtualRows, type VirtualRowsHandle } from "../../../../src/web/pages/content/virtual-rows.tsx";

function renderRows(count: number) {
  const handle = createRef<VirtualRowsHandle>();
  const items = Array.from({ length: count }, (_, index) => `row ${index}`);
  render(<VirtualRows ref={handle} items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} testId="rows" />);
  return { handle, list: screen.getByTestId("rows") };
}

describe("VirtualRows handle", () => {
  it("scrolls a short list to its top, its bottom and a row placed at the top", () => {
    const { handle, list } = renderRows(10);
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 900 });
    act(() => handle.current?.scrollToBottom());
    expect(list.scrollTop).toBe(900);
    act(() => handle.current?.scrollToTop());
    expect(list.scrollTop).toBe(0);
    const row = list.querySelector('[data-row-index="4"]') as HTMLElement;
    list.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 300, height: 400 });
    row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 260, width: 300, height: 40 });
    act(() => handle.current?.scrollToIndex(4, "start"));
    expect(list.scrollTop).toBe(160);
  });

  it("centres a row with scrollIntoView by default and ignores rows that are not there", () => {
    const { handle, list } = renderRows(10);
    const row = list.querySelector('[data-row-index="2"]') as HTMLElement;
    const calls: unknown[] = [];
    row.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      calls.push(options);
    };
    act(() => handle.current?.scrollToIndex(2));
    expect(calls).toEqual([{ block: "center" }]);
    act(() => handle.current?.scrollToIndex(99, "start"));
    expect(list.scrollTop).toBe(0);
  });

  it("drives a windowed list through the virtualizer without throwing", () => {
    const { handle } = renderRows(200);
    expect(() =>
      act(() => {
        handle.current?.scrollToIndex(120, "start");
        handle.current?.scrollToIndex(60);
        handle.current?.scrollToBottom();
        handle.current?.scrollToTop();
      }),
    ).not.toThrow();
  });
});

describe("VirtualRows scrollToIndex", () => {
  /**
   * A list following a selected row, as a reader does: `rows` may change (a filter), which
   * moves the selected row to another index; `goTo` asks the caller to put a row at the top
   * from its own layout effect once the change has rendered.
   */
  function Harness(props: { selected: string; log: string[]; api: { current?: { setRows: (rows: string[]) => void; goTo: (rows: string[], key: string) => void } } }) {
    const [state, setState] = useState<{ rows: string[]; goTo?: string }>({ rows: ["a", "c", "e"] });
    const handle = useRef<VirtualRowsHandle>(null);
    props.api.current = { setRows: (rows) => setState({ rows }), goTo: (rows, key) => setState({ rows, goTo: key }) };
    const { goTo, rows } = state;
    useLayoutEffect(() => {
      if (goTo === undefined) return;
      props.log.push(`top ${goTo}`);
      handle.current?.scrollToIndex(rows.indexOf(goTo), "start");
    }, [goTo, rows, props.log]);
    const target = rows.indexOf(props.selected);
    return (
      <VirtualRows
        ref={handle}
        items={rows}
        keyOf={(item) => item}
        render={(item) => <p>{item}</p>}
        estimateSize={40}
        scrollToIndex={target < 0 ? undefined : target}
        testId="rows"
      />
    );
  }

  function setup(selected: string) {
    const log: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      log.push(`centre ${this.textContent ?? ""}`);
    };
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    const api: { current?: { setRows: (rows: string[]) => void; goTo: (rows: string[], key: string) => void } } = {};
    render(<Harness selected={selected} log={log} api={api} />);
    const control = api.current;
    if (control === undefined) throw new Error("not mounted");
    return { log, control };
  }

  it("centres the target row when it first shows, and again when a change of rows moves it", () => {
    const { log, control } = setup("c");
    expect(log).toEqual(["centre c"]);
    act(() => control.setRows(["a", "b", "c", "d", "e"]));
    expect(log).toEqual(["centre c", "centre c"]);
  });

  it("leaves the view where the caller scrolled it during the commit that moved the target row", () => {
    const { log, control } = setup("e");
    log.length = 0;
    // The whole text comes back and the caller puts d at the top in the same commit: e, now
    // at another index, is not centred over it.
    act(() => control.goTo(["a", "b", "c", "d", "e"], "d"));
    expect(log).toEqual(["top d"]);
    // Later changes are followed again.
    act(() => control.setRows(["e"]));
    expect(log).toEqual(["top d", "centre e"]);
  });

  it("does not let a scroll made outside a commit hold back the next target change", () => {
    const handle = createRef<VirtualRowsHandle>();
    const centred = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = centred;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    const items = ["a", "b", "c"];
    const view = (target: number) => <VirtualRows ref={handle} items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} scrollToIndex={target} />;
    const { rerender } = render(view(0));
    centred.mockClear();
    act(() => handle.current?.scrollToTop());
    rerender(view(2));
    expect(centred).toHaveBeenCalledOnce();
  });
});

describe("VirtualRows pinned rows", () => {
  it("keeps the pinned rows mounted outside the window and drops them once unpinned", () => {
    // jsdom has no layout: give every element a height so the virtualizer computes a window.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 400 });
    onTestFinished(() => {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    });
    const items = Array.from({ length: 300 }, (_, index) => `row ${index}`);
    const view = (rows: readonly string[], pinnedKeys: readonly string[] | undefined) => (
      <VirtualRows items={rows} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} testId="rows" pinnedKeys={pinnedKeys} />
    );
    const { rerender } = render(view(items, ["row 250", "row 120"]));
    const list = screen.getByTestId("rows");
    const mounted = (key: string): boolean => Array.from(list.querySelectorAll("[data-row-key]")).some((row) => row.getAttribute("data-row-key") === key);
    expect(mounted("row 0")).toBe(true);
    expect(mounted("row 100")).toBe(false);
    expect(mounted("row 120")).toBe(true);
    expect(mounted("row 250")).toBe(true);
    // Rows in document order, the pinned ones after the window.
    const order = Array.from(list.querySelectorAll("[data-row-index]")).map((row) => Number(row.getAttribute("data-row-index")));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // A row added ahead moves the pinned rows to other indexes; they are still the ones kept.
    rerender(view(["new", ...items], ["row 250", "row 120"]));
    expect(mounted("row 250")).toBe(true);
    expect(list.querySelector('[data-row-index="251"]')?.getAttribute("data-row-key")).toBe("row 250");
    // A key no row has is ignored.
    rerender(view(items, ["gone"]));
    expect(mounted("row 250")).toBe(false);
    rerender(view(items, undefined));
    expect(mounted("row 120")).toBe(false);
  });

  it("hands the scrolling element to the caller once", () => {
    const seen: Array<HTMLDivElement | null> = [];
    const scrollerRef = (element: HTMLDivElement | null): void => void seen.push(element);
    const view = (rows: readonly string[]) => <VirtualRows items={rows} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} testId="rows" scrollerRef={scrollerRef} />;
    const { rerender } = render(view(["a"]));
    rerender(view(["a", "b"]));
    expect(seen).toEqual([screen.getByTestId("rows")]);
  });
});

describe("VirtualRows scroll anchor", () => {
  const rect = (top: number): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 300, height: 100 });

  it("anchors a short list on its first visible row and restores it after the rows grew", () => {
    let rowHeight = 50;
    const handle = createRef<VirtualRowsHandle>();
    const items = Array.from({ length: 20 }, (_, index) => `row ${index}`);
    render(<VirtualRows ref={handle} items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={50} testId="rows" />);
    const list = screen.getByTestId("rows");
    list.getBoundingClientRect = () => rect(0);
    list.querySelectorAll<HTMLElement>("[data-row-index]").forEach((row, index) => {
      row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: index * rowHeight - list.scrollTop, width: 300, height: rowHeight });
    });
    list.scrollTop = 130;
    const anchor = handle.current?.anchor();
    expect(anchor).toEqual({ key: "row 2", offset: -30 });
    rowHeight = 90;
    act(() => handle.current?.restoreAnchor(anchor as NonNullable<typeof anchor>));
    // Row 2 now starts at 180, so the list scrolls to 210 to leave it 30 px above the top again.
    expect(list.scrollTop).toBe(210);
  });

  describe("windowed", () => {
    function setup(rowHeight: { current: number; of?: ((index: number) => number) | undefined }, count = 300, estimateSize = 100, padding = 0) {
      // jsdom has no layout: rows report the current row height, the list a 400 px viewport.
      const heightOf = (index: number): number => rowHeight.of?.(index) ?? rowHeight.current;
      // The rows the virtualizer has measured so far, which it keeps at their real height.
      const measured = new Set<number>();
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get(this: HTMLElement) {
          if (!this.hasAttribute("data-row-index")) return 400;
          const index = Number(this.getAttribute("data-row-index"));
          measured.add(index);
          return heightOf(index);
        },
      });
      onTestFinished(() => {
        if (original !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      });
      const handle = createRef<VirtualRowsHandle>();
      const items = Array.from({ length: count }, (_, index) => `row ${index}`);
      const view = (estimate: number) => <VirtualRows ref={handle} items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={estimate} testId="rows" />;
      const result = render(view(estimateSize));
      const list = screen.getByTestId("rows");
      list.scrollTo = ((options: ScrollToOptions) => {
        list.scrollTop = options.top ?? 0;
      }) as typeof list.scrollTo;
      // The rows sit in a box below the list's top padding.
      Object.defineProperty(list.firstElementChild as HTMLElement, "offsetTop", { configurable: true, value: padding });
      // The browser's layout: a mounted row sits below every row before it and the padding, under the list's top at 0.
      const place = (): void =>
        list.querySelectorAll<HTMLElement>("[data-row-index]").forEach((row) => {
          const index = Number(row.dataset["rowIndex"]);
          row.getBoundingClientRect = () => {
            let start = 0;
            for (let before = 0; before < index; before += 1) start += heightOf(before);
            return DOMRect.fromRect({ x: 0, y: padding + start - list.scrollTop, width: 300, height: heightOf(index) });
          };
        });
      list.getBoundingClientRect = () => rect(0);
      // The scroll range the virtualizer clamps to comes from the real scroll height.
      Object.defineProperty(list, "scrollHeight", { configurable: true, value: count * estimateSize });
      Object.defineProperty(list, "clientHeight", { configurable: true, value: 400 });
      place();
      return { handle, list, view, rerender: result.rerender, place, measured };
    }

    const scrollTo = (list: HTMLElement, top: number): void => {
      act(() => {
        list.scrollTop = top;
        list.dispatchEvent(new Event("scroll"));
      });
    };

    it("names the first visible row and its offset from the viewport top", () => {
      const rowHeight = { current: 100 };
      const { handle, list, place } = setup(rowHeight);
      scrollTo(list, 270);
      place();
      expect(handle.current?.anchor()).toEqual({ key: "row 2", offset: -70 });
    });

    it("scrolls a mounted row back to its distance after the rows grew", () => {
      const rowHeight = { current: 100 };
      const { handle, list, view, rerender, place } = setup(rowHeight);
      scrollTo(list, 270);
      place();
      const anchor = handle.current?.anchor() as NonNullable<ReturnType<NonNullable<typeof handle.current>["anchor"]>>;
      rowHeight.current = 150;
      rerender(view(150));
      place();
      act(() => handle.current?.restoreAnchor(anchor));
      // Row 2 now starts at 300; it must sit 70 px above the viewport top again.
      expect(list.scrollTop).toBe(370);
    });

    it("moves to where the virtualizer puts a row that is not mounted, counting the rows it has measured at their size", () => {
      const rowHeight = { current: 100 };
      const { handle, list, measured } = setup(rowHeight, 300, 40);
      expect(list.querySelector('[data-row-index="250"]')).toBeNull();
      act(() => handle.current?.restoreAnchor({ key: "row 250", offset: 10 }));
      // Every row measured so far counts at its real 100 px, every other row at the 40 px estimate, less the 10 px offset.
      let expected = -10;
      for (let index = 0; index < 250; index += 1) expected += measured.has(index) ? 100 : 40;
      expect(measured.size).toBeGreaterThan(4);
      expect(list.scrollTop).toBe(expected);
    });

    it("measures the mounted rows again even while the list counts as scrolling, when only some of them changed size", () => {
      const rowHeight = { current: 100, of: undefined as ((index: number) => number) | undefined };
      const { handle, list, place } = setup(rowHeight);
      // A scroll event: for a while the virtualizer skips the rows it would measure itself.
      scrollTo(list, 270);
      const anchor = handle.current?.anchor() as NonNullable<ReturnType<NonNullable<typeof handle.current>["anchor"]>>;
      expect(anchor).toEqual({ key: "row 2", offset: -70 });
      // Only the even rows grew; jsdom has no resize observer to tell the virtualizer.
      rowHeight.of = (index) => (index % 2 === 0 ? 150 : 100);
      place();
      act(() => handle.current?.restoreAnchor(anchor));
      // Rows 0 and 1 now take 250 px; row 2 must sit 70 px above the viewport top again.
      expect(list.scrollTop).toBe(320);
    });

    it("keeps the list's padding out of the rows' positions", () => {
      const rowHeight = { current: 100 };
      const { handle, list, place } = setup(rowHeight, 300, 100, 8);
      scrollTo(list, 270);
      const anchor = handle.current?.anchor() as NonNullable<ReturnType<NonNullable<typeof handle.current>["anchor"]>>;
      // Row 2 starts 8 px lower than its position in the list, below the padding.
      expect(anchor).toEqual({ key: "row 2", offset: -62 });
      rowHeight.current = 150;
      place();
      act(() => handle.current?.restoreAnchor(anchor));
      expect(list.scrollTop).toBe(370);
      expect((list.querySelector('[data-row-index="2"]') as HTMLElement).getBoundingClientRect().top).toBe(-62);
    });

    it("keeps correcting over the next frames when rows above the anchor change size late", async () => {
      const rowHeight = { current: 100 };
      const { handle, list, place } = setup(rowHeight);
      scrollTo(list, 270);
      const anchor = handle.current?.anchor() as NonNullable<ReturnType<NonNullable<typeof handle.current>["anchor"]>>;
      rowHeight.current = 150;
      place();
      act(() => handle.current?.restoreAnchor(anchor));
      expect(list.scrollTop).toBe(370);
      // A late layout (a web font arriving) grows the rows again before the correction has settled.
      rowHeight.current = 200;
      await waitFor(() => expect(list.scrollTop).toBe(470), { timeout: 5_000 });
    });

    it("ignores an anchor whose row is gone", () => {
      const rowHeight = { current: 100 };
      const { handle, list } = setup(rowHeight);
      scrollTo(list, 500);
      act(() => handle.current?.restoreAnchor({ key: "nope", offset: 0 }));
      expect(list.scrollTop).toBe(500);
    });
  });
});

describe("VirtualRows restore loop", () => {
  type Result = import("../../../../src/web/pages/content/virtual-rows.tsx").RestoreLoopResult;

  /** Animation frames run by hand: `frame()` runs the ones queued so far. */
  function manualFrames() {
    const queue = new Map<number, FrameRequestCallback>();
    let next = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queue.set(next, callback);
      return next++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => void queue.delete(id));
    onTestFinished(() => void vi.unstubAllGlobals());
    const frame = (): void =>
      act(() => {
        const due = [...queue.values()];
        queue.clear();
        for (const callback of due) callback(0);
      });
    const frames = (count: number): void => {
      for (let index = 0; index < count; index += 1) frame();
    };
    return { frame, frames, pending: () => queue.size };
  }

  /** Records the results reported to `onDone`. */
  function recorder() {
    const results: Result[] = [];
    return { results, onDone: (result: Result): void => void results.push(result) };
  }

  /**
   * A list of `count` rows, each with two sentences, laid out as a browser would, from the DOM
   * itself: a row is drawn where its transform puts it (a windowed row) or below every row
   * before it (a plain list); its sentence `-a` starts at its top, `-b` 50 px below. The list is
   * 400 px tall at y = 0 and clamps its scroll position. The layout is in place before the first
   * render: the virtualizer reads the viewport's size when it mounts.
   */
  function mount(heightOf: (index: number) => number, options: { windowed: boolean; count: number; shift?: (id: string) => number }, scrollToIndex?: number) {
    const listOf = (): HTMLElement => screen.getByTestId("rows");
    const rowTop = (row: HTMLElement): number => {
      const list = listOf();
      const index = Number(row.getAttribute("data-row-index"));
      if (options.windowed) return Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? 0) - list.scrollTop;
      let start = 0;
      for (let before = 0; before < index; before += 1) start += heightOf(before);
      return start - list.scrollTop;
    };
    const originalRect = Element.prototype.getBoundingClientRect;
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute("data-testid") === "rows") return DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 400 });
      if (this instanceof HTMLElement && this.hasAttribute("data-row-index")) {
        return DOMRect.fromRect({ x: 0, y: rowTop(this), width: 300, height: heightOf(Number(this.getAttribute("data-row-index"))) });
      }
      const id = this.getAttribute("data-segment-id");
      const row = this.closest<HTMLElement>("[data-row-index]");
      if (id !== null && row !== null) return DOMRect.fromRect({ x: 0, y: rowTop(row) + (id.endsWith("-b") ? 50 : 0) + (options.shift?.(id) ?? 0), width: 300, height: 20 });
      return originalRect.call(this);
    };
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-row-index") ? heightOf(Number(this.getAttribute("data-row-index"))) : 400;
      },
    });
    onTestFinished(() => {
      Element.prototype.getBoundingClientRect = originalRect;
      if (originalHeight !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
    });

    const handle = createRef<VirtualRowsHandle>();
    const items = Array.from({ length: options.count }, (_, index) => `row ${index}`);
    const view = (target: number | undefined) => (
      <VirtualRows
        ref={handle}
        items={items}
        keyOf={(item) => item}
        render={(item) => (
          <p>
            <span data-segment-id={`${item}-a`}>a</span>
            <span data-segment-id={`${item}-b`}>b</span>
          </p>
        )}
        estimateSize={100}
        scrollToIndex={target}
        testId="rows"
      />
    );
    const result = render(view(scrollToIndex));
    const list = listOf();
    const scrollHeight = (): number => {
      if (options.windowed) return Number.parseFloat((list.firstElementChild as HTMLElement).style.height);
      let total = 0;
      for (let index = 0; index < options.count; index += 1) total += heightOf(index);
      return total;
    };
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: scrollHeight });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 400 });
    let scroll = 0;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scroll,
      set: (value: number) => {
        scroll = Math.max(0, Math.min(value, scrollHeight() - 400));
        // The virtualizer follows the list through its scroll events, as in a browser.
        list.dispatchEvent(new Event("scroll"));
      },
    });
    list.scrollTo = ((to: ScrollToOptions) => {
      list.scrollTop = to.top ?? 0;
    }) as typeof list.scrollTo;
    const lineTop = (id: string): number | undefined => {
      const sentence = Array.from(list.querySelectorAll("[data-segment-id]")).find((element) => element.getAttribute("data-segment-id") === id);
      return sentence?.getBoundingClientRect().top;
    };
    const api = (): VirtualRowsHandle => {
      if (handle.current === null) throw new Error("not mounted");
      return handle.current;
    };
    return { api, list, lineTop, rerender: (target: number | undefined) => result.rerender(view(target)), unmount: result.unmount };
  }

  for (const mode of [
    { name: "a plain list", count: 20, windowed: false },
    { name: "a windowed list", count: 300, windowed: true },
  ]) {
    describe(`in ${mode.name}`, () => {
      const far = mode.windowed ? 250 : 15;
      // Rows above the target grow past the estimate, as a long transcript's wrapped paragraphs do.
      const heightOf = (index: number): number => (index % 3 === 0 ? 160 : 100);
      const startOf = (index: number): number => {
        let start = 0;
        for (let before = 0; before < index; before += 1) start += heightOf(before);
        return start;
      };

      it("puts a sentence's first line at the offset and reports settled", () => {
        const { frames } = manualFrames();
        const { api, list, lineTop } = mount(heightOf, mode);
        const done = recorder();
        act(() => api().restoreSegment({ rowKey: `row ${far}`, segmentId: `row ${far}-b`, offset: 30 }, done.onDone));
        frames(RESTORE_FRAME_LIMIT);
        expect(done.results).toEqual(["settled"]);
        expect(lineTop(`row ${far}-b`)).toBeCloseTo(30, 1);
        // A windowed list draws the rows it never measured at the estimate: only a plain list's position is the sum of the real heights.
        if (!mode.windowed) expect(list.scrollTop).toBe(startOf(far) + 50 - 30);
      });

      it("puts a sentence that started above the top back at the same negative offset", () => {
        const { frames } = manualFrames();
        const { api, lineTop } = mount(heightOf, mode);
        const done = recorder();
        act(() => api().restoreSegment({ rowKey: `row ${far}`, segmentId: `row ${far}-a`, offset: -40 }, done.onDone));
        frames(RESTORE_FRAME_LIMIT);
        expect(done.results).toEqual(["settled"]);
        expect(lineTop(`row ${far}-a`)).toBeCloseTo(-40, 1);
      });

      it("reports edge when the list cannot scroll as far as the offset asks, at the top and at the end", () => {
        const { frames } = manualFrames();
        const { api, list, lineTop } = mount(heightOf, mode);
        const top = recorder();
        act(() => api().restoreSegment({ rowKey: "row 0", segmentId: "row 0-b", offset: 120 }, top.onDone));
        frames(RESTORE_FRAME_LIMIT);
        expect(top.results).toEqual(["edge"]);
        expect(list.scrollTop).toBe(0);
        expect(lineTop("row 0-b")).toBe(50);
        const last = mode.count - 1;
        const end = recorder();
        act(() => api().restoreSegment({ rowKey: `row ${last}`, segmentId: `row ${last}-a`, offset: 0 }, end.onDone));
        frames(RESTORE_FRAME_LIMIT);
        expect(end.results).toEqual(["edge"]);
        expect(list.scrollTop).toBe(list.scrollHeight - 400);
        expect(lineTop(`row ${last}-a`)).toBeGreaterThan(0);
      });

      it("reports capped when the sentence keeps moving, and missing for a row or a sentence that is not there", () => {
        const { frames, pending } = manualFrames();
        let reads = 0;
        // A sentence whose line keeps shifting (a layout that never settles).
        const { api } = mount(heightOf, { ...mode, shift: (id) => (id === "row 5-a" ? (reads++ % 2) * 10 : 0) });
        const restless = recorder();
        act(() => api().restoreSegment({ rowKey: "row 5", segmentId: "row 5-a", offset: 0 }, restless.onDone));
        frames(RESTORE_FRAME_LIMIT);
        expect(restless.results).toEqual(["capped"]);
        expect(pending()).toBe(0);
        const noRow = recorder();
        act(() => api().restoreSegment({ rowKey: "nope", segmentId: "row 5-a", offset: 0 }, noRow.onDone));
        expect(noRow.results).toEqual(["missing"]);
        const noSentence = recorder();
        act(() => api().restoreSegment({ rowKey: "row 5", segmentId: "row 6-a", offset: 0 }, noSentence.onDone));
        frames(RESTORE_FRAME_LIMIT - 2);
        expect(noSentence.results).toEqual([]);
        frames(2);
        expect(noSentence.results).toEqual(["missing"]);
      });

      it("reports how an anchor restore ended", () => {
        const { frames } = manualFrames();
        const { api } = mount(heightOf, mode);
        const found = recorder();
        act(() => api().restoreAnchor({ key: "row 3", offset: -20 }, found.onDone));
        frames(RESTORE_FRAME_LIMIT);
        expect(found.results).toEqual(["settled"]);
        const gone = recorder();
        act(() => api().restoreAnchor({ key: "nope", offset: 0 }, gone.onDone));
        expect(gone.results).toEqual(["missing"]);
      });

      it("runs one loop at a time: a newer restore, the reader's own scrolls and cancelRestore end the running one", () => {
        const { frames, pending } = manualFrames();
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = () => undefined;
        onTestFinished(() => {
          Element.prototype.scrollIntoView = original;
        });
        const { api, rerender, lineTop } = mount(heightOf, mode, 0);
        const first = recorder();
        const second = recorder();
        act(() => api().restoreSegment({ rowKey: `row ${far}`, segmentId: `row ${far}-a`, offset: 10 }, first.onDone));
        act(() => api().restoreSegment({ rowKey: "row 4", segmentId: "row 4-b", offset: 60 }, second.onDone));
        expect(first.results).toEqual(["cancelled"]);
        frames(RESTORE_FRAME_LIMIT);
        expect(second.results).toEqual(["settled"]);
        expect(lineTop("row 4-b")).toBeCloseTo(60, 1);
        // A windowed anchor restore runs a loop too; a plain list's restores it synchronously.
        const anchorLoop = mode.windowed ? [() => api().restoreAnchor({ key: "row 7", offset: 0 }, anchored.onDone)] : [];
        const anchored = recorder();
        const navigations: Array<[string, () => void]> = [
          ["scrollToIndex", () => api().scrollToIndex(2)],
          ["scrollToTop", () => api().scrollToTop()],
          ["scrollToBottom", () => api().scrollToBottom()],
          ["cancelRestore", () => api().cancelRestore()],
          ["centring", () => rerender(9)],
        ];
        for (const [name, navigate] of navigations) {
          const running = recorder();
          act(() => api().restoreSegment({ rowKey: "row 6", segmentId: "row 6-a", offset: 0 }, running.onDone));
          act(navigate);
          expect([name, running.results]).toEqual([name, ["cancelled"]]);
          expect(pending() === 0 || mode.windowed).toBe(true);
        }
        for (const start of anchorLoop) {
          act(start);
          act(() => api().scrollToTop());
          expect(anchored.results).toEqual(["cancelled"]);
        }
      });

      it("ends the running loop on the user's input, and stops listening once it ended", () => {
        const { frames } = manualFrames();
        const { api, list } = mount(heightOf, mode);
        for (const event of [new WheelEvent("wheel"), new KeyboardEvent("keydown", { key: "ArrowDown" }), new Event("pointerdown"), new Event("touchstart")]) {
          const running = recorder();
          act(() => api().restoreSegment({ rowKey: `row ${far}`, segmentId: `row ${far}-a`, offset: 0 }, running.onDone));
          const before = list.scrollTop;
          // On a row inside the list: the list hears it in the capture phase.
          act(() => void list.querySelector("[data-segment-id]")?.dispatchEvent(event));
          frames(3);
          expect([event.type, running.results]).toEqual([event.type, ["cancelled"]]);
          expect(list.scrollTop).toBe(before);
        }
        const settled = recorder();
        act(() => api().restoreSegment({ rowKey: "row 2", segmentId: "row 2-a", offset: 0 }, settled.onDone));
        frames(RESTORE_FRAME_LIMIT);
        act(() => void list.dispatchEvent(new WheelEvent("wheel")));
        expect(settled.results).toEqual(["settled"]);
      });

      it("stops quietly when the list unmounts mid-loop", () => {
        const { frames, pending } = manualFrames();
        const { api, unmount } = mount(heightOf, mode);
        const running = recorder();
        act(() => api().restoreSegment({ rowKey: `row ${far}`, segmentId: `row ${far}-a`, offset: 0 }, running.onDone));
        expect(() => unmount()).not.toThrow();
        expect(pending()).toBe(0);
        frames(3);
        expect(running.results).toEqual([]);
      });
    });
  }
});

/** More frames than a restore loop ever takes. */
const RESTORE_FRAME_LIMIT = 30;

describe("VirtualRows rows of different kinds", () => {
  it("puts a row's extra attributes on its wrapper, beside its key", () => {
    const items = ["a", "figure:x", "b"];
    render(<VirtualRows items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} rowAttributes={(item) => (item.startsWith("figure:") ? { "data-figure-row": "" } : undefined)} testId="rows" />);
    const wrappers = Array.from(screen.getByTestId("rows").querySelectorAll("[data-row-key]"));
    expect(wrappers.map((wrapper) => wrapper.hasAttribute("data-figure-row"))).toEqual([false, true, false]);
  });

  it("estimates a windowed list's rows one by one, so a tall row makes the list taller before it is measured", () => {
    const items = Array.from({ length: 200 }, (_, index) => `row ${index}`);
    const total = (estimate: number | ((index: number) => number)): number => {
      const { unmount } = render(<VirtualRows items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={estimate} testId="rows" />);
      const box = screen.getByTestId("rows").firstElementChild as HTMLElement;
      const height = Number.parseFloat(box.style.height);
      unmount();
      return height;
    };
    expect(total(40)).toBe(200 * 40);
    expect(total((index) => (index === 5 ? 1000 : 40))).toBe(199 * 40 + 1000);
  });
});

describe("VirtualRows windowing threshold and centring token", () => {
  it("windows by the rows the caller counts, not by every row", () => {
    // 140 text rows and 20 figure rows: below the threshold of text rows, so every row renders.
    const items = Array.from({ length: 160 }, (_, index) => `row ${index}`);
    render(<VirtualRows items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} windowCount={140} testId="rows" />);
    expect(screen.getByTestId("rows").querySelectorAll("[data-row-key]")).toHaveLength(160);
  });

  it("windows once the counted rows reach the threshold", () => {
    const items = Array.from({ length: 160 }, (_, index) => `row ${index}`);
    render(<VirtualRows items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} windowCount={150} testId="rows" />);
    expect(screen.getByTestId("rows").querySelectorAll("[data-row-key]").length).toBeLessThan(160);
  });

  it("with a token, centres the target when the token changes, not when the target only moves to another index", () => {
    const calls: number[] = [];
    // jsdom has no scrollIntoView: one that records which row asked is put in for this test.
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      calls.push(Number(this.getAttribute("data-row-index")));
    };
    onTestFinished(() => {
      HTMLElement.prototype.scrollIntoView = original;
    });
    const items = (extra: number) => [...Array.from({ length: extra }, (_, index) => `figure ${index}`), "a", "b", "c"];
    const view = (rows: string[], index: number, token: string) => (
      <VirtualRows items={rows} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} scrollToIndex={index} scrollToToken={token} testId="rows" />
    );
    const { rerender } = render(view(items(0), 1, "b"));
    expect(calls).toEqual([1]);
    // A figure row joins above: "b" is now at index 2, the token is the same.
    rerender(view(items(1), 2, "b"));
    expect(calls).toEqual([1]);
    // Another sentence is selected.
    rerender(view(items(1), 3, "c"));
    expect(calls).toEqual([1, 3]);
  });
});
