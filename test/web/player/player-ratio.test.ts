import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYER_PORTRAIT_MAX_VIEWPORT_RATIO, PLAYER_RATIO_MEMORY_MAX } from "../../../src/shared/defaults.ts";
import { playerHeight, readPlayerRatio, rememberPlayerRatio } from "../../../src/web/player/player-ratio.ts";

const STORAGE_KEY = "amber.player.ratios";
const SCOPE = { userId: "u1", contentId: "c1", assetId: "a1" };

beforeEach(() => localStorage.clear());

describe("playerHeight", () => {
  it("keeps 16:9 for landscape and wider videos", () => {
    expect(playerHeight(640, 16 / 9, 800)).toBeCloseTo(360);
    expect(playerHeight(640, 21 / 9, 800)).toBeCloseTo(360);
  });

  it("grows a portrait or square video up to its share of the column's visible height", () => {
    // Portrait 9:16 in a tall column: capped by the column.
    expect(playerHeight(400, 9 / 16, 1000)).toBeCloseTo(PLAYER_PORTRAIT_MAX_VIEWPORT_RATIO * 1000);
    // Square in a tall column: the whole picture fits under the cap.
    expect(playerHeight(400, 1, 1000)).toBe(400);
    // 4:3 under the cap.
    expect(playerHeight(400, 4 / 3, 2000)).toBeCloseTo(300);
  });

  it("never drops below the 16:9 height, however short the column", () => {
    expect(playerHeight(400, 9 / 16, 100)).toBe(225);
    expect(playerHeight(400, 1, 0)).toBe(225);
  });
});

describe("player ratio memory", () => {
  it("returns the ratio remembered for the same user, Content and file only", () => {
    rememberPlayerRatio(SCOPE, 0.5625);
    expect(readPlayerRatio(SCOPE)).toBe(0.5625);
    expect(readPlayerRatio({ ...SCOPE, assetId: "a2" })).toBeUndefined();
    expect(readPlayerRatio({ ...SCOPE, contentId: "c2" })).toBeUndefined();
    expect(readPlayerRatio({ ...SCOPE, userId: "u2" })).toBeUndefined();
  });

  it("ignores stored values that are not finite or lie outside [0.25, 16/9]", () => {
    const stored = [
      { userId: "u1", contentId: "c1", assetId: "nan", ratio: null },
      { userId: "u1", contentId: "c1", assetId: "inf", ratio: "Infinity" },
      { userId: "u1", contentId: "c1", assetId: "low", ratio: 0.2 },
      { userId: "u1", contentId: "c1", assetId: "high", ratio: 2 },
      { userId: "u1", contentId: "c1", assetId: "text", ratio: "0.5" },
      { userId: "u1", contentId: "c1", assetId: "floor", ratio: 0.25 },
      { userId: "u1", contentId: "c1", assetId: "wide", ratio: 16 / 9 },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    for (const assetId of ["nan", "inf", "low", "high", "text"]) expect(readPlayerRatio({ ...SCOPE, assetId })).toBeUndefined();
    expect(readPlayerRatio({ ...SCOPE, assetId: "floor" })).toBe(0.25);
    expect(readPlayerRatio({ ...SCOPE, assetId: "wide" })).toBe(16 / 9);
  });

  it("reads a damaged value as nothing remembered", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readPlayerRatio(SCOPE)).toBeUndefined();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ a1: 0.5 }));
    expect(readPlayerRatio(SCOPE)).toBeUndefined();
  });

  it("does not write values outside the range", () => {
    rememberPlayerRatio(SCOPE, Number.NaN);
    rememberPlayerRatio(SCOPE, Number.POSITIVE_INFINITY);
    rememberPlayerRatio(SCOPE, 0.1);
    rememberPlayerRatio(SCOPE, 3);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it(`keeps at most PLAYER_RATIO_MEMORY_MAX (${PLAYER_RATIO_MEMORY_MAX}) entries, dropping the oldest`, () => {
    for (let index = 0; index <= PLAYER_RATIO_MEMORY_MAX; index += 1) rememberPlayerRatio({ ...SCOPE, assetId: `a${index}` }, 0.5);
    expect(readPlayerRatio({ ...SCOPE, assetId: "a0" })).toBeUndefined();
    expect(readPlayerRatio({ ...SCOPE, assetId: "a1" })).toBe(0.5);
    expect(readPlayerRatio({ ...SCOPE, assetId: `a${PLAYER_RATIO_MEMORY_MAX}` })).toBe(0.5);
    expect((JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown[]).length).toBe(PLAYER_RATIO_MEMORY_MAX);
  });

  it("makes a rewritten entry the newest, so it outlives the ones written after it before", () => {
    for (let index = 0; index < PLAYER_RATIO_MEMORY_MAX; index += 1) rememberPlayerRatio({ ...SCOPE, assetId: `a${index}` }, 0.5);
    rememberPlayerRatio({ ...SCOPE, assetId: "a0" }, 0.75);
    rememberPlayerRatio({ ...SCOPE, assetId: "extra" }, 0.5);
    expect(readPlayerRatio({ ...SCOPE, assetId: "a0" })).toBe(0.75);
    expect(readPlayerRatio({ ...SCOPE, assetId: "a1" })).toBeUndefined();
  });

  it("treats storage that throws as having nothing remembered", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readPlayerRatio(SCOPE)).toBeUndefined();
    expect(() => rememberPlayerRatio(SCOPE, 0.5)).not.toThrow();
  });
});
