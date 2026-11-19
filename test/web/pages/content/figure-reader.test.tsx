import { describe, expect, it } from "vitest";
import { dropGapAt } from "../../../../src/web/pages/content/figure-reader.tsx";

const rect = (top: number, bottom: number) => ({ top, bottom });

describe("dropGapAt", () => {
  const rows = [
    { rect: rect(0, 40), info: { kind: "heading" as const, paragraph: 0 } },
    { rect: rect(40, 140), info: { kind: "paragraph" as const, paragraph: 0 } },
    { rect: rect(140, 340), info: { kind: "figure" as const, gap: 1, id: "f" } },
    { rect: rect(340, 440), info: { kind: "paragraph" as const, paragraph: 1 } },
  ];
  it("takes the gap before a paragraph on its upper half and after it on its lower half", () => {
    expect(dropGapAt(rows, 60)).toBe(0);
    expect(dropGapAt(rows, 120)).toBe(1);
    expect(dropGapAt(rows, 380)).toBe(1);
    expect(dropGapAt(rows, 420)).toBe(2);
  });
  it("takes a figure's own gap over it and the gap a heading opens over the heading", () => {
    expect(dropGapAt(rows, 200)).toBe(1);
    expect(dropGapAt(rows, 10)).toBe(0);
  });
  it("lands after the last row past the end, and nowhere without rows", () => {
    expect(dropGapAt(rows, 900)).toBe(2);
    expect(dropGapAt([], 10)).toBeUndefined();
  });
});
