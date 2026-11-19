import { describe, expect, it } from "vitest";
import { FIGURE_WIDTH_LARGE, FIGURE_WIDTH_MEDIUM, FIGURE_WIDTH_MIN_RATIO, FIGURE_WIDTH_SMALL } from "../../../../src/shared/defaults.ts";
import { draggedWidth } from "../../../../src/web/pages/content/figure-row.tsx";

describe("draggedWidth", () => {
  const column = { centerX: 500, columnPx: 800 };
  it("is twice the pointer's distance from the centre as a share of the column", () => {
    expect(draggedWidth({ ...column, pointerX: 500 + 220 })).toBe(0.55);
  });
  it("snaps to a preset when close to it", () => {
    expect(draggedWidth({ ...column, pointerX: 500 + 0.42 * 400 })).toBe(FIGURE_WIDTH_SMALL);
    expect(draggedWidth({ ...column, pointerX: 500 + 0.68 * 400 })).toBe(FIGURE_WIDTH_MEDIUM);
    expect(draggedWidth({ ...column, pointerX: 500 + 0.97 * 400 })).toBe(FIGURE_WIDTH_LARGE);
  });
  it("stays within the allowed widths", () => {
    expect(draggedWidth({ ...column, pointerX: 510 })).toBe(FIGURE_WIDTH_MIN_RATIO);
    expect(draggedWidth({ ...column, pointerX: 2000 })).toBe(FIGURE_WIDTH_LARGE);
    expect(draggedWidth({ centerX: 0, columnPx: 0, pointerX: 10 })).toBe(FIGURE_WIDTH_LARGE);
  });
});
