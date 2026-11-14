import { describe, expect, it } from "vitest";
import { DroppedCues } from "../../../../src/server/domain/subtitle-formats/dropped.ts";

describe("dropped cues", () => {
  it("counts every one and keeps a few short samples", () => {
    const dropped = new DroppedCues();
    for (const sample of [" a ", "b", "c", "d"]) dropped.add(sample);
    dropped.add("x".repeat(100));
    expect(dropped.toJSON()).toEqual({ count: 5, samples: ["a", "b", "c"] });
    const long = new DroppedCues();
    long.add("👍".repeat(61));
    expect(long.toJSON().samples).toEqual([`${"👍".repeat(60)}…`]);
  });
});
