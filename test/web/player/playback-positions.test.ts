import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYBACK_RESUME_MAX_ENTRIES } from "../../../src/shared/defaults.ts";
import { deletePlaybackPosition, playbackStorageKey, readPlaybackPosition, writePlaybackPosition } from "../../../src/web/player/playback-positions.ts";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("playback positions", () => {
  it("keeps one record per Content under a key of the user", () => {
    writePlaybackPosition("u1", "c1", { positionMs: 90_000, durationMs: 600_000, updatedAt: 5 });
    writePlaybackPosition("u1", "c2", { positionMs: 45_000, updatedAt: 6 });
    expect(playbackStorageKey("u1")).toBe("amber.playback.u1");
    expect(readPlaybackPosition("u1", "c1")).toEqual({ positionMs: 90_000, durationMs: 600_000, updatedAt: 5 });
    expect(readPlaybackPosition("u1", "c2")).toEqual({ positionMs: 45_000, updatedAt: 6 });
    // Another account in the same browser sees nothing.
    expect(readPlaybackPosition("u2", "c1")).toBeUndefined();
    deletePlaybackPosition("u1", "c1");
    expect(readPlaybackPosition("u1", "c1")).toBeUndefined();
    expect(readPlaybackPosition("u1", "c2")).toBeDefined();
    deletePlaybackPosition("u1", "c2");
    expect(localStorage.getItem(playbackStorageKey("u1"))).toBeNull();
  });

  it("drops the least recently saved records past the limit and keeps the one just written", () => {
    for (let index = 0; index < PLAYBACK_RESUME_MAX_ENTRIES; index += 1) {
      writePlaybackPosition("u1", `c${index}`, { positionMs: 40_000, updatedAt: 1_000 + index });
    }
    // Saving c0 again makes it the most recent, so c1 is the oldest when one more arrives.
    writePlaybackPosition("u1", "c0", { positionMs: 50_000, updatedAt: 5_000 });
    writePlaybackPosition("u1", "new", { positionMs: 60_000, updatedAt: 6_000 });
    const stored = JSON.parse(localStorage.getItem(playbackStorageKey("u1")) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(PLAYBACK_RESUME_MAX_ENTRIES);
    expect(readPlaybackPosition("u1", "c1")).toBeUndefined();
    expect(readPlaybackPosition("u1", "c0")?.positionMs).toBe(50_000);
    expect(readPlaybackPosition("u1", "new")?.positionMs).toBe(60_000);
  });

  it("keeps the record just written even when every timestamp ties", () => {
    for (let index = 0; index <= PLAYBACK_RESUME_MAX_ENTRIES; index += 1) {
      writePlaybackPosition("u1", `c${index}`, { positionMs: 40_000, updatedAt: 1 });
    }
    expect(readPlaybackPosition("u1", `c${PLAYBACK_RESUME_MAX_ENTRIES}`)).toBeDefined();
    expect(readPlaybackPosition("u1", "c0")).toBeUndefined();
  });

  it("reads damaged storage as empty and ignores malformed records", () => {
    localStorage.setItem(playbackStorageKey("u1"), "{not json");
    expect(readPlaybackPosition("u1", "c1")).toBeUndefined();
    localStorage.setItem(playbackStorageKey("u1"), JSON.stringify([1, 2]));
    expect(readPlaybackPosition("u1", "c1")).toBeUndefined();
    localStorage.setItem(
      playbackStorageKey("u1"),
      JSON.stringify({ bad: { positionMs: "x", updatedAt: 1 }, negative: { positionMs: -1, updatedAt: 1 }, good: { positionMs: 31_000, updatedAt: 1 } }),
    );
    expect(readPlaybackPosition("u1", "bad")).toBeUndefined();
    expect(readPlaybackPosition("u1", "negative")).toBeUndefined();
    expect(readPlaybackPosition("u1", "good")?.positionMs).toBe(31_000);
    // A write over a damaged value starts afresh.
    localStorage.setItem(playbackStorageKey("u2"), "{not json");
    writePlaybackPosition("u2", "c1", { positionMs: 31_000, updatedAt: 1 });
    expect(readPlaybackPosition("u2", "c1")?.positionMs).toBe(31_000);
  });

  it("is silent when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readPlaybackPosition("u1", "c1")).toBeUndefined();
    expect(() => writePlaybackPosition("u1", "c1", { positionMs: 31_000, updatedAt: 1 })).not.toThrow();
    expect(() => deletePlaybackPosition("u1", "c1")).not.toThrow();
  });
});
