import { vi } from "vitest";

/** jsdom has no ResizeObserver, which the popover positioning needs. */
export function stubResizeObserver(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

/** The leading bytes of a WebP, PNG and JPEG file: enough for the type check on a photo response. */
export const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export interface FetchCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Answer = Response | { status?: number; json?: unknown; bytes?: Uint8Array; type?: string };

/** Stubs `fetch` with answers by `"METHOD /path"` (the query string counts); anything else is 404. */
export function stubFetch(routes: Record<string, Answer | ((call: FetchCall) => Answer)>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    const call: FetchCall = { method, path, headers, ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}) };
    calls.push(call);
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const answer = typeof route === "function" ? route(call) : route;
    if (answer instanceof Response) return answer;
    if (answer.bytes !== undefined) return new Response(answer.bytes as BodyInit, { status: answer.status ?? 200, headers: { "content-type": answer.type ?? "image/webp" } });
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}
