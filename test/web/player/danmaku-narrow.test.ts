import { describe, expect, it } from "vitest";
import { DANMAKU_NARROW_PICTURE_PX, isNarrowPlayer } from "../../../src/web/player/danmaku-narrow.ts";

describe("isNarrowPlayer", () => {
  it("is narrow below the threshold only, and never before the picture is measured", () => {
    expect([
      isNarrowPlayer({ x: 0, width: 0 }),
      isNarrowPlayer({ x: 0, width: 1 }),
      isNarrowPlayer({ x: 0, width: DANMAKU_NARROW_PICTURE_PX - 1 }),
      isNarrowPlayer({ x: 0, width: DANMAKU_NARROW_PICTURE_PX }),
    ]).toEqual([false, true, true, false]);
  });

  it("goes by the bar across the video box, not the picture: a portrait video in a wide player is not narrow", () => {
    // 720×1280 in a 1006×566 box: a 318 px picture centred with 344 px on each side.
    expect(isNarrowPlayer({ x: 344, width: 318 })).toBe(false);
    // The same picture in a box hardly wider than itself is narrow.
    expect(isNarrowPlayer({ x: 10, width: 318 })).toBe(true);
  });
});
