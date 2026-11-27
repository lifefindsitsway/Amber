import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { COVER_CACHE_GC_MS, COVER_IMAGE_MAX_BYTES, COVER_LOAD_CONCURRENCY } from "../../shared/defaults.ts";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { base64Of } from "../pages/content/speakers/photo-crop.ts";

/** Which route serves a local cover: a Content in the trash is read through the trash. */
export type CoverScope = "content" | "trash";

/** Query keys of local cover images, apart from the Content queries so refreshing those never refetches an image. */
export const coverKeys = {
  all: ["cover"] as const,
  image: (scope: CoverScope, contentId: string, version: number) => ["cover", scope, contentId, version] as const,
};

/**
 * Runs at most `limit` loads at once, the rest waiting in order. A load whose signal aborts
 * while it waits leaves the queue without ever starting.
 */
export class CoverLoadLimiter {
  private readonly limit: number;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit = COVER_LOAD_CONCURRENCY) {
    this.limit = limit;
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await this.slot(signal);
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  private slot(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.running < this.limit) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        signal.removeEventListener("abort", leave);
        this.running += 1;
        resolve();
      };
      const leave = (): void => {
        const at = this.waiting.indexOf(start);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason);
      };
      this.waiting.push(start);
      signal.addEventListener("abort", leave, { once: true });
    });
  }
}

const sharedLimiter = new CoverLoadLimiter();

/**
 * Reads a local cover through the API client as a `data:` URL: the client authenticates the
 * request (a plain `<img src>` on the route would reach the desktop sidecar without its token),
 * and the page's image policy admits `data:` but not `blob:`.
 */
export async function loadCover(client: ApiClient, scope: CoverScope, contentId: string, signal: AbortSignal, limiter: CoverLoadLimiter = sharedLimiter): Promise<string> {
  const path = `/api/${scope === "trash" ? "trash" : "contents"}/${encodeURIComponent(contentId)}/cover`;
  const bytes = new Uint8Array(await limiter.run(signal, () => client.bytes(path, { accept: "image/webp", maxBytes: COVER_IMAGE_MAX_BYTES, signal })));
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") {
    throw new Error("not a WebP image");
  }
  return `data:image/webp;base64,${base64Of(bytes)}`;
}

/** Whether `element` is in the viewport; true at once where the browser cannot tell. */
function useInView(element: Element | null): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (element === null) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) setInView(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return inView;
}

export interface CoverProps {
  /** The address the platform gave; shown only when there is no local copy. */
  url?: string | undefined;
  /** With `version`: the Content whose local copy to show. */
  contentId?: string | undefined;
  /** `coverImageVersion`: the local copy exists; a new version is a new picture. */
  version?: number | undefined;
  /** The Content is in the trash, so its copy is read through the trash. */
  trashed?: boolean;
  /** The fixed size of the cover slot. */
  className?: string;
  /** For tests: the queue local loads wait in. */
  limiter?: CoverLoadLimiter;
}

/**
 * A Content's cover in a fixed slot, the same everywhere covers show. With a local copy it is
 * the only source: requested once the slot enters the viewport, at most
 * `COVER_LOAD_CONCURRENCY` at once, kept per version for `COVER_CACHE_GC_MS`, never retried
 * after a failure (the placeholder stays). Without one the platform's address is used,
 * without a Referer (some CDNs refuse foreign referrers) and over https (the page's image
 * policy admits nothing else). The picture is fitted whole and centered on the placeholder
 * color, so a portrait or square cover is not cropped, and it fades in unless the system asks
 * for reduced motion. Nothing changes the slot's size, before or after loading.
 */
export function Cover({ url, contentId, version, trashed = false, className = "h-12 w-20", limiter = sharedLimiter }: CoverProps) {
  if (contentId !== undefined && version !== undefined) {
    return <LocalCover contentId={contentId} version={version} scope={trashed ? "trash" : "content"} className={className} limiter={limiter} />;
  }
  return <CoverSlot src={url?.replace(/^http:\/\//, "https://")} className={className} />;
}

/** The local copy, loaded through the API once its slot is in view. */
function LocalCover(props: { contentId: string; version: number; scope: CoverScope; className: string; limiter: CoverLoadLimiter }) {
  const { contentId, version, scope, limiter } = props;
  const client = useApi();
  const queryClient = useQueryClient();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const inView = useInView(slot);
  const key = coverKeys.image(scope, contentId, version);
  // A query without data counts as stale, so enabling it again would load it again: a copy
  // that failed stays failed until its version changes or the cache is cleared.
  const failed = queryClient.getQueryState(key)?.status === "error";
  const image = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => loadCover(client, scope, contentId, signal, limiter),
    enabled: inView && !failed,
    // A version names one picture for good; a failed load is not tried again.
    staleTime: Infinity,
    gcTime: COVER_CACHE_GC_MS,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
  return <CoverSlot src={image.data} className={props.className} slotRef={setSlot} />;
}

/** The fixed slot: the placeholder color, and the picture fitted whole once it loads. */
function CoverSlot(props: { src: string | undefined; className: string; slotRef?: (element: HTMLDivElement | null) => void }) {
  const { src } = props;
  const [failed, setFailed] = useState<string>();
  const [loaded, setLoaded] = useState<string>();
  const shown = src !== undefined && src !== failed ? src : undefined;
  return (
    <div ref={props.slotRef} data-testid="cover" className={`${props.className} relative shrink-0 overflow-hidden rounded bg-sunken`}>
      {shown === undefined ? (
        <div data-testid="cover-placeholder" className="absolute inset-0" />
      ) : (
        <img
          src={shown}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={() => setLoaded(shown)}
          onError={() => setFailed(shown)}
          // The base style's max-width: 100% would let a shrink-to-fit table column squeeze it.
          className={`absolute inset-0 h-full w-full max-w-none object-contain transition-opacity duration-200 motion-reduce:transition-none ${loaded === shown ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}
