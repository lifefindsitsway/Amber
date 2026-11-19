import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { FIGURE_IMAGE_MAX_BYTES } from "../../../shared/defaults.ts";
import type { ApiClient } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { READER_SCROLLER_CLASS } from "./reader-sentences.tsx";
import { base64Of } from "./speakers/photo-crop.ts";

/**
 * Images no figure on screen shows any more are kept up to this many characters of `data:` URL
 * (about 36 MB of WebP), least recently shown dropped first: scrolling back is instant, while a
 * long session among many figures does not keep every image it ever showed.
 */
export const FIGURE_IMAGE_CACHE_CHARS = 48 * 1024 * 1024;
/** How far beyond the visible part of the list an image starts loading, so it is there when it scrolls in. */
const PRELOAD_MARGIN = "600px 0px";

/** What a figure shows: its image while loading, once loaded, or after the load failed. */
export type FigureImageState = { status: "loading" } | { status: "loaded"; url: string } | { status: "failed" };

interface Entry {
  state: FigureImageState;
  /** Figures on screen showing it now; at 0 it may be dropped. */
  refs: number;
  size: number;
  /** Order of last use, for dropping the least recently shown. */
  used: number;
  abort: AbortController | undefined;
}

const LOADING: FigureImageState = { status: "loading" };

/**
 * The images of figures, by the SHA-256 of their bytes: a figure's image never changes, so its
 * hash names it for good and needs no revalidation. A load nobody waits for any more is aborted;
 * a loaded image nobody shows is kept within `FIGURE_IMAGE_CACHE_CHARS`.
 *
 * The URL is a `data:` URL because the bytes come through `ApiClient`, which authenticates the
 * request (a plain `<img src>` on the image route would reach the desktop sidecar without its
 * token), and the page's image policy admits `data:` but not `blob:`. A `data:` URL holds no
 * resource, so dropping it from here is all releasing takes.
 */
export class FigureImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private clock = 0;
  private readonly limit: number;

  constructor(limit = FIGURE_IMAGE_CACHE_CHARS) {
    this.limit = limit;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The state of an image; `loading` for one never asked for. */
  state(key: string): FigureImageState {
    return this.entries.get(key)?.state ?? LOADING;
  }

  /** Characters held by images nobody shows. */
  idleSize(): number {
    let total = 0;
    for (const entry of this.entries.values()) if (entry.refs === 0) total += entry.size;
    return total;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * One more figure shows `key`: starts loading it unless it is loaded or loading. A failed
   * image is tried again only through `retry`. Returns the matching release.
   */
  acquire(key: string, load: (signal: AbortSignal) => Promise<string>): () => void {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { state: LOADING, refs: 0, size: 0, used: 0, abort: undefined };
      this.entries.set(key, entry);
      this.start(key, entry, load);
    }
    entry.refs += 1;
    entry.used = ++this.clock;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(key);
    };
  }

  /** Loads a failed image again for the figures showing it. */
  retry(key: string, load: (signal: AbortSignal) => Promise<string>): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.state.status !== "failed") return;
    entry.state = LOADING;
    this.start(key, entry, load);
    this.notify();
  }

  private start(key: string, entry: Entry, load: (signal: AbortSignal) => Promise<string>): void {
    const abort = new AbortController();
    entry.abort = abort;
    load(abort.signal).then(
      (url) => {
        if (this.entries.get(key) !== entry || entry.abort !== abort) return;
        entry.abort = undefined;
        entry.state = { status: "loaded", url };
        entry.size = url.length;
        this.trim();
        this.notify();
      },
      () => {
        if (this.entries.get(key) !== entry || entry.abort !== abort) return;
        entry.abort = undefined;
        entry.state = { status: "failed" };
        this.notify();
      },
    );
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (entry.state.status !== "loaded") {
      // Nobody waits for it: the request stops, and a later showing starts afresh.
      entry.abort?.abort();
      this.entries.delete(key);
      return;
    }
    this.trim();
  }

  /** Drops the least recently shown idle images until the idle ones fit the limit. */
  private trim(): void {
    let idle = this.idleSize();
    if (idle <= this.limit) return;
    const candidates = [...this.entries.entries()].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].used - b[1].used);
    for (const [key, entry] of candidates) {
      if (idle <= this.limit) break;
      this.entries.delete(key);
      idle -= entry.size;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const sharedCache = new FigureImageCache();

/** Reads a figure's image through the API client as a `data:` URL. */
export async function loadFigureImage(client: ApiClient, figureId: string, signal: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await client.bytes(`/api/figures/${encodeURIComponent(figureId)}/image`, { accept: "image/webp", maxBytes: FIGURE_IMAGE_MAX_BYTES, signal }));
  return `data:image/webp;base64,${base64Of(bytes)}`;
}

/**
 * Whether an element is in or near the visible part of its scrolling list (the reader's scroller,
 * not the window: the list scrolls inside the page, so only it says what is about to be seen).
 * Short transcripts mount every row, so being mounted alone does not mean an image is near.
 */
export function useNearView(element: Element | null): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (element === null) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry !== undefined) setNear(entry.isIntersecting);
      },
      { root: element.closest(`.${READER_SCROLLER_CLASS}`), rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return near;
}

/**
 * The image of a figure, loaded while `element` (the figure's frame) is near the visible part
 * of the list and released when it leaves or unmounts. `retry` loads a failed image again.
 */
export function useFigureImage(figure: { id: string; image: { sha256: string } }, element: Element | null, cache: FigureImageCache = sharedCache): { state: FigureImageState; retry: () => void } {
  const client = useApi();
  const near = useNearView(element);
  const key = figure.image.sha256;
  const id = figure.id;
  useEffect(() => {
    if (!near) return undefined;
    return cache.acquire(key, (signal) => loadFigureImage(client, id, signal));
  }, [near, key, id, client, cache]);
  const state = useSyncExternalStore(
    cache.subscribe,
    useCallback(() => cache.state(key), [cache, key]),
  );
  const retry = useCallback(() => cache.retry(key, (signal) => loadFigureImage(client, id, signal)), [cache, key, client, id]);
  return { state, retry };
}
