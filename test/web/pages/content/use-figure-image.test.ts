import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FigureImageCache } from "../../../../src/web/pages/content/use-figure-image.ts";

/** A load the test resolves or fails by hand, recording whether it was aborted. */
function deferred() {
  let resolve: (url: string) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const calls: AbortSignal[] = [];
  const load = (signal: AbortSignal): Promise<string> => {
    calls.push(signal);
    return new Promise<string>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
  };
  return { load, calls, resolve: (url: string) => resolve(url), reject: () => reject(new Error("failed")) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("FigureImageCache", () => {
  it("loads an image once for every figure showing it", async () => {
    const cache = new FigureImageCache(1000);
    const load = deferred();
    const release1 = cache.acquire("k", load.load);
    const release2 = cache.acquire("k", load.load);
    expect(load.calls).toHaveLength(1);
    expect(cache.state("k")).toEqual({ status: "loading" });
    load.resolve("data:x");
    await settle();
    expect(cache.state("k")).toEqual({ status: "loaded", url: "data:x" });
    release1();
    release2();
  });

  it("aborts a load nobody waits for any more and starts afresh later", async () => {
    const cache = new FigureImageCache(1000);
    const load = deferred();
    const release = cache.acquire("k", load.load);
    release();
    expect(load.calls[0]?.aborted).toBe(true);
    expect(cache.has("k")).toBe(false);
    load.resolve("data:late");
    await settle();
    expect(cache.has("k")).toBe(false);
    cache.acquire("k", load.load);
    expect(load.calls).toHaveLength(2);
  });

  it("keeps idle images within its limit, dropping the least recently shown first", async () => {
    const cache = new FigureImageCache(10);
    const loads = ["a", "b", "c"].map((key) => {
      const load = deferred();
      const release = cache.acquire(key, load.load);
      load.resolve(`${key}`.repeat(4));
      return { key, release };
    });
    await settle();
    for (const { release } of loads) release();
    // Three idle images of 4 characters exceed 10: the first shown goes.
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.idleSize()).toBe(8);
  });

  it("never drops an image a figure still shows, however large", async () => {
    const cache = new FigureImageCache(2);
    const load = deferred();
    const release = cache.acquire("big", load.load);
    load.resolve("x".repeat(50));
    await settle();
    expect(cache.state("big").status).toBe("loaded");
    release();
    expect(cache.has("big")).toBe(false);
  });

  it("reports a failed load and loads it again on retry", async () => {
    const cache = new FigureImageCache(1000);
    const load = deferred();
    cache.acquire("k", load.load);
    load.reject();
    await settle();
    expect(cache.state("k")).toEqual({ status: "failed" });
    cache.retry("k", load.load);
    expect(cache.state("k")).toEqual({ status: "loading" });
    load.resolve("data:ok");
    await settle();
    expect(cache.state("k")).toEqual({ status: "loaded", url: "data:ok" });
  });
});

describe("useNearView", () => {
  it("watches the element against the reader's scroller, not the window", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useNearView } = await import("../../../../src/web/pages/content/use-figure-image.ts");
    const seen: Array<IntersectionObserverInit | undefined> = [];
    class Observer {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        seen.push(options);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const scroller = document.createElement("div");
    scroller.className = "absolute inset-0 reader-scroller";
    const frame = document.createElement("div");
    scroller.append(frame);
    document.body.append(scroller);
    onTestFinished(() => scroller.remove());
    renderHook(() => useNearView(frame));
    expect(seen[0]?.root).toBe(scroller);
  });
});
