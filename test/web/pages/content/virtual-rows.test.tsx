import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, onTestFinished } from "vitest";
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

describe("VirtualRows pinned row", () => {
  it("keeps the pinned row mounted outside the window and drops it once unpinned", () => {
    // jsdom has no layout: give every element a height so the virtualizer computes a window.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 400 });
    onTestFinished(() => {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    });
    const items = Array.from({ length: 300 }, (_, index) => `row ${index}`);
    const view = (pinnedIndex: number | undefined) => (
      <VirtualRows items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} testId="rows" pinnedIndex={pinnedIndex} />
    );
    const { rerender } = render(view(250));
    const list = screen.getByTestId("rows");
    expect(list.querySelector('[data-row-index="0"]')).not.toBeNull();
    expect(list.querySelector('[data-row-index="100"]')).toBeNull();
    expect(list.querySelector('[data-row-index="250"]')).not.toBeNull();
    rerender(view(undefined));
    expect(list.querySelector('[data-row-index="250"]')).toBeNull();
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
