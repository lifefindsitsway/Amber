import { describe, expect, it } from "vitest";
import { mergeCollectionOrder } from "../../../src/server/domain/collection-merge.ts";

describe("mergeCollectionOrder", () => {
  it("creates the pack's order when the collection is empty", () => {
    expect(mergeCollectionOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns the local order unchanged when every carried member is already here (a repeated import)", () => {
    const local = ["c", "x", "b", "a"];
    expect(mergeCollectionOrder(local, ["a", "b", "c"])).toEqual(local);
  });

  it("keeps the local relative order even when the pack orders the same members the other way", () => {
    const merged = mergeCollectionOrder(["c", "b", "a"], ["a", "n1", "b", "n2", "c"]);
    expect(merged.filter((id) => ["a", "b", "c"].includes(id))).toEqual(["c", "b", "a"]);
    // Each new member follows the nearest earlier pack member that is here.
    expect(merged).toEqual(["c", "b", "n2", "a", "n1"]);
  });

  it("keeps trashed members (passed in like any other) in their slots", () => {
    const local = ["a", "trashed", "b"];
    expect(mergeCollectionOrder(local, ["a", "n", "b"])).toEqual(["a", "n", "trashed", "b"]);
  });

  it("works on a caller-sorted list whose stored positions had ties", () => {
    // Positions [0, 0, 1] sorted by (position, id) by the caller.
    expect(mergeCollectionOrder(["p", "q", "r"], ["q", "new", "r"])).toEqual(["p", "q", "new", "r"]);
  });

  it("carries 3 of 20 members into a new collection, then 3 more next to the first ones", () => {
    const first = mergeCollectionOrder([], ["m05", "m06", "m07"]);
    expect(first).toEqual(["m05", "m06", "m07"]);
    // The second pack holds m07 (already here) and the next members of the original 20.
    expect(mergeCollectionOrder(first, ["m07", "m08", "m09", "m10"])).toEqual(["m05", "m06", "m07", "m08", "m09", "m10"]);
    // A pack of earlier members anchors before the first one present.
    expect(mergeCollectionOrder(first, ["m01", "m02", "m05"])).toEqual(["m01", "m02", "m05", "m06", "m07"]);
  });

  it("inserts at both ends and in the middle", () => {
    expect(mergeCollectionOrder(["b", "d"], ["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps the pack's order among several new members sharing one anchor, ahead of local members after the anchor", () => {
    expect(mergeCollectionOrder(["a", "z"], ["a", "n1", "n2", "n3"])).toEqual(["a", "n1", "n2", "n3", "z"]);
    expect(mergeCollectionOrder(["a", "z"], ["n1", "n2", "z"])).toEqual(["a", "n1", "n2", "z"]);
  });

  it("interleaves new members between local ones whose order the pack reverses", () => {
    // n0 has nothing here before it: right before a, the first member here after it.
    expect(mergeCollectionOrder(["b", "a"], ["n0", "a", "n1", "b", "n2"])).toEqual(["b", "n2", "n0", "a", "n1"]);
    expect(mergeCollectionOrder(["a", "b"], ["n0", "a", "n1", "n2", "b", "n3"])).toEqual(["n0", "a", "n1", "n2", "b", "n3"]);
  });

  it("anchors on a trashed member like on any other, and leaves members the pack does not carry where they are", () => {
    // `t` is in the trash here; the pack carries it, so a new member placed after it lands next to it.
    expect(mergeCollectionOrder(["a", "t", "z"], ["t", "n"])).toEqual(["a", "t", "n", "z"]);
  });

  it("appends new members when none of the pack's members is here", () => {
    expect(mergeCollectionOrder(["a", "b"], ["x", "y"])).toEqual(["a", "b", "x", "y"]);
  });

  it("refuses duplicate ids", () => {
    expect(() => mergeCollectionOrder(["a", "a"], [])).toThrow(/duplicate/);
    expect(() => mergeCollectionOrder(["a"], ["b", "b"])).toThrow(/duplicate/);
  });
});
