import { describe, expect, it } from "vitest";
import { captureAnchor, restoreAnchor, ROW_KEY_ATTRIBUTE } from "../../../../src/web/pages/content/scroll-anchor.ts";

const LIST_TOP = 100;

interface Layout {
  container: HTMLElement;
  rows: HTMLElement[];
  /** Changes every row's height, as a font size change does. */
  setHeights(heights: number | number[]): void;
}

/** A list jsdom cannot lay out: rects follow the row heights and the container's scrollTop, as a browser's would. */
function buildList(keys: string[], initial: number | number[]): Layout {
  const container = document.createElement("div");
  const rows = keys.map((key) => {
    const row = document.createElement("div");
    row.setAttribute(ROW_KEY_ATTRIBUTE, key);
    container.append(row);
    return row;
  });
  let heights: number[] = [];
  const setHeights = (value: number | number[]): void => {
    heights = Array.isArray(value) ? value : keys.map(() => value);
  };
  setHeights(initial);
  container.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: LIST_TOP, width: 400, height: 300 });
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => {
      const start = heights.slice(0, index).reduce((sum, height) => sum + height, 0);
      return DOMRect.fromRect({ x: 0, y: LIST_TOP + start - container.scrollTop, width: 400, height: heights[index] ?? 0 });
    };
  });
  return { container, rows, setHeights };
}

const keys = Array.from({ length: 40 }, (_, index) => `r${index}`);

describe("captureAnchor", () => {
  it("names the first row that reaches into the viewport and how far its top sits from it", () => {
    const { container } = buildList(keys, 50);
    container.scrollTop = 270;
    // Row 5 spans 250-300: its top is 20 px above the viewport top.
    expect(captureAnchor(container)).toEqual({ key: "r5", offset: -20 });
  });

  it("anchors on a row that starts exactly at the top with offset 0", () => {
    const { container } = buildList(keys, 50);
    container.scrollTop = 300;
    expect(captureAnchor(container)).toEqual({ key: "r6", offset: 0 });
  });

  it("skips rows that take no space", () => {
    const { container } = buildList(keys, [0, 0, 80, ...keys.slice(3).map(() => 80)]);
    container.scrollTop = 0;
    expect(captureAnchor(container)?.key).toBe("r2");
  });

  it("has no anchor in an empty list", () => {
    expect(captureAnchor(document.createElement("div"))).toBeUndefined();
  });

  it("copes with keys holding quotes and brackets", () => {
    const { container } = buildList(['a"b]', "c"], 50);
    expect(captureAnchor(container)?.key).toBe('a"b]');
  });
});

describe("restoreAnchor", () => {
  it("puts the same row back at the same distance after every row grew", () => {
    const { container, rows, setHeights } = buildList(keys, 50);
    container.scrollTop = 270;
    const anchor = captureAnchor(container);
    expect(anchor).toEqual({ key: "r5", offset: -20 });
    setHeights(80);
    expect(restoreAnchor(container, anchor as NonNullable<typeof anchor>)).toBe(true);
    expect(rows[5]?.getBoundingClientRect().top).toBe(LIST_TOP - 20);
    expect(container.scrollTop).toBe(420);
  });

  it("follows the row when rows shrink, and when only the rows above change", () => {
    const { container, rows, setHeights } = buildList(keys, 50);
    container.scrollTop = 270;
    const anchor = captureAnchor(container);
    setHeights(30);
    restoreAnchor(container, anchor as NonNullable<typeof anchor>);
    expect(rows[5]?.getBoundingClientRect().top).toBe(LIST_TOP - 20);
    expect(container.scrollTop).toBe(170);

    setHeights(keys.map((_, index) => (index < 5 ? 100 : 30)));
    restoreAnchor(container, anchor as NonNullable<typeof anchor>);
    expect(rows[5]?.getBoundingClientRect().top).toBe(LIST_TOP - 20);
  });

  it("leaves the scroll position alone when nothing moved", () => {
    const { container } = buildList(keys, 50);
    container.scrollTop = 275;
    const anchor = captureAnchor(container);
    restoreAnchor(container, anchor as NonNullable<typeof anchor>);
    expect(container.scrollTop).toBe(275);
  });

  it("reports a row that is gone and does not scroll", () => {
    const { container } = buildList(keys, 50);
    container.scrollTop = 120;
    expect(restoreAnchor(container, { key: "missing", offset: 0 })).toBe(false);
    expect(container.scrollTop).toBe(120);
  });
});
