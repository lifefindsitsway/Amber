import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COVER_CACHE_GC_MS, COVER_LOAD_CONCURRENCY } from "../../../src/shared/defaults.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import { Cover, CoverLoadLimiter, coverKeys } from "../../../src/web/components/cover.tsx";

/** The bytes of a 1×1 WebP; the component only checks the container signature. */
const WEBP = Uint8Array.from(Buffer.from("RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00", "latin1"));

/** Observed slots, made visible by hand: nothing is in view until a test says so. */
const observed = new Map<Element, IntersectionObserverCallback>();
class Observer {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element): void {
    observed.set(element, this.callback);
  }
  disconnect(): void {
    for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element);
  }
}

function showAll(): void {
  act(() => {
    for (const [element, callback] of [...observed]) {
      callback([{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

interface PendingFetch {
  path: string;
  answer: (status?: number) => void;
}

/** A `fetch` whose answers the test releases; every call is recorded. */
function stubFetch(): { pending: PendingFetch[]; paths: () => string[] } {
  const pending: PendingFetch[] = [];
  const all: string[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    all.push(String(input));
    return new Promise<Response>((resolve) => {
      pending.push({
        path: String(input),
        answer: (status = 200) =>
          resolve(
            status === 200
              ? new Response(WEBP, { status, headers: { "content-type": "image/webp", "content-length": String(WEBP.length) } })
              : new Response(JSON.stringify({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }), { status, headers: { "content-type": "application/json" } }),
          ),
      });
    });
  });
  return { pending, paths: () => [...all] };
}

function providers(queryClient: QueryClient) {
  const client = new ApiClient({ baseUrl: "" }, "local");
  return ({ children }: { children: ReactNode }) => (
    <ApiProvider client={client} queryClient={queryClient}>
      {children}
    </ApiProvider>
  );
}

beforeEach(() => {
  observed.clear();
  vi.stubGlobal("IntersectionObserver", Observer);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const image = (container: HTMLElement) => container.querySelector("img");

describe("Cover with a local copy", () => {
  it("asks the local route only once the slot is in view, never the platform address", async () => {
    const api = stubFetch();
    const queryClient = createQueryClient();
    const { container } = render(<Cover url="https://i0.hdslb.com/cover.jpg" contentId="c1" version={2} limiter={new CoverLoadLimiter()} />, { wrapper: providers(queryClient) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.paths()).toEqual([]);
    expect(screen.getByTestId("cover-placeholder")).toBeTruthy();
    showAll();
    await waitFor(() => expect(api.paths()).toEqual(["/api/contents/c1/cover"]));
    api.pending[0]?.answer();
    await waitFor(() => expect(image(container)?.getAttribute("src")).toMatch(/^data:image\/webp;base64,/));
    expect(container.innerHTML).not.toContain("hdslb");
  });

  it("reads a trashed Content's copy through the trash", async () => {
    const api = stubFetch();
    render(<Cover contentId="c1" version={1} trashed limiter={new CoverLoadLimiter()} />, { wrapper: providers(createQueryClient()) });
    showAll();
    await waitFor(() => expect(api.paths()).toEqual(["/api/trash/c1/cover"]));
  });

  it("shows the placeholder when the local copy fails, without falling back or trying again", async () => {
    const api = stubFetch();
    const queryClient = createQueryClient();
    const view = render(<Cover url="https://i0.hdslb.com/cover.jpg" contentId="c1" version={1} limiter={new CoverLoadLimiter()} />, { wrapper: providers(queryClient) });
    showAll();
    await waitFor(() => expect(api.pending).toHaveLength(1));
    api.pending[0]?.answer(404);
    await waitFor(() => expect(queryClient.getQueryState(coverKeys.image("content", "c1", 1))?.status).toBe("error"));
    expect(image(view.container)).toBeNull();
    expect(screen.getByTestId("cover-placeholder")).toBeTruthy();
    // Shown again elsewhere: the failure stands.
    view.unmount();
    const again = render(<Cover contentId="c1" version={1} limiter={new CoverLoadLimiter()} />, { wrapper: providers(queryClient) });
    showAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.paths()).toHaveLength(1);
    expect(image(again.container)).toBeNull();
  });

  it(`has at most ${COVER_LOAD_CONCURRENCY} loads out at once, starting the next as one ends`, async () => {
    const api = stubFetch();
    const limiter = new CoverLoadLimiter();
    const ids = Array.from({ length: COVER_LOAD_CONCURRENCY + 4 }, (_, index) => `c${index}`);
    render(
      <>
        {ids.map((id) => (
          <Cover key={id} contentId={id} version={1} limiter={limiter} />
        ))}
      </>,
      { wrapper: providers(createQueryClient()) },
    );
    showAll();
    await waitFor(() => expect(api.pending).toHaveLength(COVER_LOAD_CONCURRENCY));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.pending).toHaveLength(COVER_LOAD_CONCURRENCY);
    api.pending[0]?.answer();
    await waitFor(() => expect(api.pending).toHaveLength(COVER_LOAD_CONCURRENCY + 1));
    for (const request of api.pending.slice(1)) request.answer();
    await waitFor(() => expect(api.pending).toHaveLength(ids.length));
    expect(new Set(api.paths()).size).toBe(ids.length);
  });

  it("keeps a loaded copy for COVER_CACHE_GC_MS per version, asks again for a new version, and forgets everything when the cache is cleared", async () => {
    const api = stubFetch();
    const queryClient = createQueryClient();
    const limiter = new CoverLoadLimiter();
    const first = render(<Cover contentId="c1" version={1} limiter={limiter} />, { wrapper: providers(queryClient) });
    showAll();
    await waitFor(() => expect(api.pending).toHaveLength(1));
    api.pending[0]?.answer();
    await waitFor(() => expect(image(first.container)).not.toBeNull());
    expect(queryClient.getQueryCache().find({ queryKey: coverKeys.image("content", "c1", 1) })?.options.gcTime).toBe(COVER_CACHE_GC_MS);
    first.unmount();

    // Scrolled back: the cached picture shows at once, with no request.
    const back = render(<Cover contentId="c1" version={1} limiter={limiter} />, { wrapper: providers(queryClient) });
    expect(image(back.container)?.getAttribute("src")).toMatch(/^data:image\/webp/);
    expect(api.paths()).toHaveLength(1);

    // A new version is a new picture.
    back.rerender(<Cover contentId="c1" version={2} limiter={limiter} />);
    showAll();
    await waitFor(() => expect(api.paths()).toHaveLength(2));
    back.unmount();

    // Logging out clears the query cache: nothing of the old session is shown from memory.
    queryClient.clear();
    const after = render(<Cover contentId="c1" version={1} limiter={limiter} />, { wrapper: providers(queryClient) });
    expect(image(after.container)).toBeNull();
    showAll();
    await waitFor(() => expect(api.paths()).toHaveLength(3));
  });
});

describe("Cover without a local copy", () => {
  it("uses the platform address over https without a Referer, and the placeholder once it fails", () => {
    const api = stubFetch();
    const { container } = render(<Cover url="http://i1.hdslb.com/cover.jpg" contentId="c1" />);
    const img = image(container);
    expect(img?.getAttribute("src")).toBe("https://i1.hdslb.com/cover.jpg");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.error(img as HTMLImageElement);
    expect(image(container)).toBeNull();
    expect(screen.getByTestId("cover-placeholder")).toBeTruthy();
    expect(api.paths()).toEqual([]);
  });

  it("is a plain placeholder with no address at all", () => {
    render(<Cover />);
    expect(screen.getByTestId("cover-placeholder")).toBeTruthy();
  });
});

describe("Cover layout", () => {
  it("fits the picture whole and centered in a fixed slot on the placeholder color, fading in unless motion is reduced", () => {
    const { container } = render(<Cover url="https://i0.hdslb.com/portrait.jpg" className="h-10 w-16" />);
    const slot = screen.getByTestId("cover");
    const before = slot.className;
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(["h-10", "w-16", "shrink-0", "overflow-hidden", "bg-sunken"]));
    const img = image(container) as HTMLImageElement;
    expect(img.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "inset-0", "h-full", "w-full", "object-contain", "max-w-none", "opacity-0", "motion-reduce:transition-none"]));
    fireEvent.load(img);
    expect(img.className).toContain("opacity-100");
    // The slot's size classes are the same before and after loading.
    expect(screen.getByTestId("cover").className).toBe(before);
  });
});
