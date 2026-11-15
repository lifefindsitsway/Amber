import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { registerSelectionSource, selectionSourceAt, selectionSourceFor, useSelectionSource, type RegionSelection, type SelectionSource } from "../../../src/web/ui/selection-source.ts";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

const reading = (version: number): RegionSelection => ({ version, text: "正文", copyText: "正文", menuCopyText: "正文", sentenceCount: 1, crossesGap: false });
const sourceOf = (version: number): { current: SelectionSource } => ({ current: { read: () => reading(version) } });

function select(from: Node, to: Node): Selection {
  const selection = window.getSelection() as Selection;
  selection.setBaseAndExtent(from, 0, to, 1);
  return selection;
}

describe("selection sources", () => {
  it("answers for the nearest registered region around a node, and stops once it is removed", () => {
    document.body.innerHTML = `<div id="outer"><div id="inner"><p id="p">里面的字</p></div><p id="q">外面的字</p></div>`;
    const outer = document.querySelector("#outer") as HTMLElement;
    const inner = document.querySelector("#inner") as HTMLElement;
    const undoOuter = registerSelectionSource(outer, sourceOf(1));
    const undoInner = registerSelectionSource(inner, sourceOf(2));
    const p = (document.querySelector("#p") as HTMLElement).firstChild as Text;
    expect(selectionSourceAt(p)?.element).toBe(inner);
    expect(selectionSourceAt(p)?.source.read()?.version).toBe(2);
    expect(selectionSourceAt(inner)?.element).toBe(inner);
    expect(selectionSourceAt(document.querySelector("#q"))?.element).toBe(outer);
    undoInner();
    expect(selectionSourceAt(p)?.element).toBe(outer);
    undoOuter();
    expect(selectionSourceAt(p)).toBeUndefined();
    expect(selectionSourceAt(null)).toBeUndefined();
  });

  it("leaves a newer registration of the same element alone when an older one is undone", () => {
    document.body.innerHTML = `<div id="region">字</div>`;
    const region = document.querySelector("#region") as HTMLElement;
    const undoFirst = registerSelectionSource(region, sourceOf(1));
    registerSelectionSource(region, sourceOf(2));
    undoFirst();
    expect(selectionSourceAt(region)?.source.read()?.version).toBe(2);
  });

  it("gives a selection the region around the whole of it, and none when it reaches outside", () => {
    document.body.innerHTML = `<div id="region"><p id="a">第一段</p><p id="b">第二段</p></div><p id="c">别处</p>`;
    registerSelectionSource(document.querySelector("#region") as HTMLElement, sourceOf(1));
    const node = (id: string): Text => (document.querySelector(id) as HTMLElement).firstChild as Text;
    expect(selectionSourceFor(select(node("#a"), node("#b")))?.source.read()?.version).toBe(1);
    expect(selectionSourceFor(select(node("#a"), node("#c")))).toBeUndefined();
    window.getSelection()?.removeAllRanges();
    expect(selectionSourceFor(window.getSelection())).toBeUndefined();
    expect(selectionSourceFor(null)).toBeUndefined();
  });

  it("registers the element a component attaches the ref to, reading the source of the latest render", () => {
    function Region(props: { version: number }) {
      const ref = useSelectionSource<HTMLDivElement>({ read: () => reading(props.version) });
      return (
        <div ref={ref} data-testid="region">
          字
        </div>
      );
    }
    const { rerender, unmount } = render(<Region version={1} />);
    const region = screen.getByTestId("region");
    expect(selectionSourceAt(region)?.source.read()?.version).toBe(1);
    rerender(<Region version={2} />);
    expect(selectionSourceAt(region)?.source.read()?.version).toBe(2);
    unmount();
    expect(selectionSourceAt(region)).toBeUndefined();
  });
});
