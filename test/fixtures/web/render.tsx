import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";
import type { RunMode } from "../../../src/shared/enums.ts";
import { ApiClient, type ApiEndpoint } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import { ShortcutProvider } from "../../../src/web/shortcut-registry.tsx";
import { TooltipProvider } from "../../../src/web/ui/tooltip.tsx";

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  /** Multipart parts in send order, for FormData bodies. */
  form?: Array<[string, string | File]>;
  headers: Record<string, string>;
}

/** A file answer (export): its text and the name `Content-Disposition` gives it. */
export interface FileReply {
  filename: string;
  text: string;
}

type ReplyValue = { status?: number; body?: unknown; file?: FileReply; headers?: Record<string, string> };
type Reply = ReplyValue | ((call: RecordedCall) => ReplyValue);

/**
 * Stubs `fetch` with a route table keyed `"METHOD /path"` (the query string is part of the
 * path; a key without one also matches any query). Unmatched calls answer 404 `not_found`.
 * Every call is recorded, so tests can assert that nothing was posted.
 */
export function mockApi(routes: Record<string, Reply>): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: RecordedCall = {
      method,
      path,
      headers,
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}),
      ...(init.body instanceof FormData ? { form: [...init.body.entries()] as Array<[string, string | File]> } : {}),
    };
    calls.push(call);
    const reply = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
    if (reply === undefined) {
      return json(404, { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } });
    }
    const { status = 200, body, file, headers: replyHeaders = {} } = typeof reply === "function" ? reply(call) : reply;
    if (file !== undefined) {
      return new Response(file.text, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}` },
      });
    }
    if (path.endsWith("/events")) {
      // SSE: an open stream that never yields, so subscribers just stay connected.
      return new Response(new ReadableStream({ start: () => undefined }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return json(status, body, replyHeaders);
  });
  return { calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Renders inside the app providers at `route`; `path` is the route pattern (default: any). */
export function renderApp(
  ui: ReactNode,
  options: { route?: string; path?: string; mode?: RunMode; endpoint?: ApiEndpoint } = {},
): RenderResult & { client: ApiClient } {
  const client = new ApiClient(options.endpoint ?? { baseUrl: "" }, options.mode ?? "local");
  const result = render(
    <ApiProvider client={client} queryClient={createQueryClient()}>
      <ShortcutProvider overrides={{}}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[options.route ?? "/"]}>
            <Routes>
              <Route path={options.path ?? "*"} element={ui} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </ShortcutProvider>
    </ApiProvider>,
  );
  return { ...result, client };
}
