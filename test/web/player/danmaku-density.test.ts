import { describe, expect, it } from "vitest";
import type { DanmakuItem } from "../../../src/shared/dto/danmaku.ts";
import { thinByWeight } from "../../../src/web/player/danmaku-density.ts";

const item = (timeMs: number, weight: number, text = `${timeMs}-${weight}`): DanmakuItem => ({ timeMs, mode: "scroll", color: 0xffffff, weight, text });

describe("thinByWeight", () => {
  it("keeps everything at full density and in sparse stretches", () => {
    const items = [item(0, 1), item(10, 1), item(5000, 3), item(9000, 2), item(9500, 2)];
    expect(thinByWeight(items, 1)).toEqual(items);
    // Each second holds at most two items here, so even the lowest density keeps them.
    expect(thinByWeight(items, 0.1)).toEqual(items);
  });

  it("keeps the share of a dense second with the highest weights, in time order", () => {
    const dense = Array.from({ length: 10 }, (_, index) => item(index * 10, index === 3 || index === 7 ? 9 : 1));
    const kept = thinByWeight(dense, 0.3);
    expect(kept).toHaveLength(3);
    expect(kept.filter((entry) => entry.weight === 9)).toHaveLength(2);
    expect(kept.map((entry) => entry.timeMs)).toEqual([...kept.map((entry) => entry.timeMs)].sort((a, b) => a - b));
  });

  it("keeps a subset of a higher density's choice at a lower one, so turning density down only removes items", () => {
    const items = Array.from({ length: 400 }, (_, index) => item(Math.floor(index / 40) * 1000 + index, (index * 7) % 11 === 0 ? 4 : 2));
    let previous = new Set(thinByWeight(items, 1));
    for (const density of [0.9, 0.7, 0.5, 0.3, 0.1]) {
      const kept = thinByWeight(items, density);
      for (const entry of kept) expect(previous.has(entry)).toBe(true);
      expect(kept.length).toBeLessThan(previous.size);
      previous = new Set(kept);
    }
  });
});
