import { describe, expect, it } from "vitest";
import { exportBlock, pageSelection, toggleSelected, togglePage } from "../../../../src/web/pages/library/selection.ts";

describe("library selection", () => {
  it("keeps the order rows were picked in", () => {
    expect(toggleSelected(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleSelected(["a", "b"], "a", false)).toEqual(["b"]);
    expect(toggleSelected(["a"], "a", true)).toEqual(["a"]);
  });

  it("picks a page, keeping picks from other pages, and unpicks a fully picked one", () => {
    expect(pageSelection([], ["a", "b"])).toBe("none");
    expect(pageSelection(["x", "a"], ["a", "b"])).toBe("some");
    expect(togglePage(["x", "a"], ["a", "b"])).toEqual(["x", "a", "b"]);
    expect(pageSelection(["x", "a", "b"], ["a", "b"])).toBe("all");
    expect(togglePage(["x", "a", "b"], ["a", "b"])).toEqual(["x"]);
    expect(pageSelection(["x"], [])).toBe("none");
  });

  it("refuses an empty pick and one larger than a pack takes", () => {
    expect(exportBlock(0, 50)).toBe("empty");
    expect(exportBlock(50, 50)).toBeUndefined();
    expect(exportBlock(51, 50)).toBe("tooMany");
  });
});
