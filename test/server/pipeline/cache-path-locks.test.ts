import { describe, expect, it } from "vitest";
import { CachePathLocks } from "../../../src/server/pipeline/cache-path-locks.ts";

describe("CachePathLocks", () => {
  it("runs work on one path one at a time, in order, folding case", async () => {
    const locks = new CachePathLocks();
    const events: string[] = [];
    let release!: () => void;
    const first = locks.withLock("media/A.mp4", async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push("first:end");
    });
    const second = locks.withLock("media/a.MP4", async () => {
      events.push("second");
    });
    const other = locks.withLock("media/b.mp4", async () => {
      events.push("other");
    });
    await other;
    expect(events).toEqual(["first:start", "other"]);
    expect(locks.isLocked("MEDIA/A.MP4")).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "other", "first:end", "second"]);
    expect(locks.isLocked("media/a.mp4")).toBe(false);
  });

  it("releases the lock when the work fails", async () => {
    const locks = new CachePathLocks();
    await expect(locks.withLock("media/a.mp4", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await locks.withLock("media/a.mp4", async () => "next")).toBe("next");
    expect(locks.isLocked("media/a.mp4")).toBe(false);
  });
});
