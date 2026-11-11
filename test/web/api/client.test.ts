import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiClient, ApiError, filenameOf } from "../../../src/web/api/client.ts";

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

describe("ApiClient", () => {
  it("sends the sidecar token, an idempotency key on request and validates the answer", async () => {
    const calls = stubFetch(202, { taskId: "t1" });
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:9", token: "tok" }, "local");
    const result = await client.post("/api/x", z.object({ taskId: z.string() }), { body: { a: 1 }, idempotent: true });
    expect(result).toEqual({ taskId: "t1" });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("http://127.0.0.1:9/api/x");
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["x-amber-request"]).toBeUndefined();
  });

  it("sends later calls to a replaced endpoint with its token", async () => {
    const calls = stubFetch(200, {});
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:9", token: "old" }, "local");
    client.setEndpoint({ baseUrl: "http://127.0.0.1:10", token: "new" });
    await client.get("/api/y", z.object({}));
    expect(calls[0]?.url).toBe("http://127.0.0.1:10/api/y");
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe("Bearer new");
  });

  it("adds the CSRF marker only in server mode and never a token in the browser", async () => {
    const calls = stubFetch(200, {});
    await new ApiClient({ baseUrl: "" }, "server").get("/api/y", z.object({}));
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-amber-request"]).toBe("1");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("surfaces the server AppError", async () => {
    stubFetch(409, { error: { class: "conflict", code: "conflict.primary_changed", retryDisposition: "never", userMessage: "x", details: { currentPrimaryRevisionId: "r2" } } });
    const failure = await new ApiClient({ baseUrl: "" }, "local").get("/api/z", z.object({})).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).error.code).toBe("conflict.primary_changed");
  });

  it("reads the run mode from /api/version", async () => {
    stubFetch(200, { version: "0.0.0", mode: "local" });
    const client = await new ApiClient({ baseUrl: "" }).init();
    expect(client.mode).toBe("local");
  });

  it("streams a POST with an idempotency key and the SSE accept header, returning the raw response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("event: done\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const response = await new ApiClient({ baseUrl: "", token: "tok" }, "local").postStream("/api/c/chat/messages", {
      body: { text: "q" },
      idempotent: true,
      signal: new AbortController().signal,
    });
    expect(await response.text()).toContain("event: done");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ text: "q" }));
    expect(headers["accept"]).toBe("text/event-stream");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["authorization"]).toBe("Bearer tok");
  });

  it("throws the AppError a streaming POST was refused with before streaming", async () => {
    stubFetch(422, { error: { class: "llm_capability", code: "llm_capability.context_window_unknown", retryDisposition: "never", userMessage: "" } });
    const failure = await new ApiClient({ baseUrl: "" }, "local")
      .postStream("/api/c/chat/messages", { body: {}, signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(422);
    expect((failure as ApiError).error.code).toBe("llm_capability.context_window_unknown");
  });
});

describe("filenameOf", () => {
  it("prefers the RFC 5987 UTF-8 name and falls back to a plain or quoted one", () => {
    expect(filenameOf(`attachment; filename*=UTF-8''${encodeURIComponent("第一讲：检索.md")}`)).toBe("第一讲：检索.md");
    expect(filenameOf(`attachment; filename="a.srt"; filename*=UTF-8''${encodeURIComponent("讲 义.srt")}`)).toBe("讲 义.srt");
    expect(filenameOf('attachment; filename="say \\"hi\\".txt"')).toBe('say "hi".txt');
    expect(filenameOf("attachment; filename=plain.vtt")).toBe("plain.vtt");
  });

  it("never lets a path through and has no name without a header", () => {
    expect(filenameOf(`attachment; filename*=UTF-8''${encodeURIComponent("../../etc/passwd")}`)).toBe(".._.._etc_passwd");
    expect(filenameOf("attachment")).toBeUndefined();
    expect(filenameOf(null)).toBeUndefined();
  });
});

describe("ApiClient.postFile", () => {
  it("returns the file with its name, and throws the AppError of a refusal", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response("WEBVTT\n", { status: 200, headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("第一讲.vtt")}` } })
        : new Response(JSON.stringify({ error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "" } }), { status: 400 });
    });
    const client = new ApiClient({ baseUrl: "" }, "server");
    const file = await client.postFile("/api/contents/c1/export", { format: "vtt", revisionId: "r1" });
    expect(file.filename).toBe("第一讲.vtt");
    expect(await file.blob.text()).toBe("WEBVTT\n");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ format: "vtt", revisionId: "r1" });
    expect((calls[0]?.init.headers as Record<string, string>)["x-amber-request"]).toBe("1");
    const failure = await client.postFile("/api/contents/c1/export", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(400);
  });

  it("reports a server-mode 401 to onUnauthenticated unless the call opts out; never in local mode", async () => {
    const unauthenticated = { error: { class: "unauthenticated", code: "unauthenticated", retryDisposition: "never", userMessage: "" } };
    stubFetch(401, unauthenticated);
    const server = new ApiClient({ baseUrl: "" }, "server");
    const ended = vi.fn();
    server.onUnauthenticated = ended;
    await expect(server.get("/api/a", z.unknown())).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledTimes(1);
    await expect(server.post("/api/auth/login", z.unknown(), { body: {}, authRedirect: false })).rejects.toBeInstanceOf(ApiError);
    await expect(server.stream("/api/tasks/events", new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledTimes(2);
    const local = new ApiClient({ baseUrl: "" }, "local");
    local.onUnauthenticated = ended;
    await expect(local.get("/api/a", z.unknown())).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it("carries Retry-After seconds and extra headers", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ error: { class: "rate_limited", code: "rate_limited", retryDisposition: "never", userMessage: "" } }), {
        status: 429,
        headers: { "retry-after": "8" },
      });
    });
    const failure = await new ApiClient({ baseUrl: "" }, "server")
      .post("/api/setup", z.unknown(), { body: {}, headers: { "x-amber-setup-token": "t" }, authRedirect: false })
      .catch((error: unknown) => error);
    expect((failure as ApiError).retryAfterSeconds).toBe(8);
    expect((calls[0]?.headers as Record<string, string>)["x-amber-setup-token"]).toBe("t");
  });

  it("uploads multipart bodies without overriding the browser's content type", async () => {
    const calls = stubFetch(202, { ok: true });
    const form = new FormData();
    form.append("file", new File(["x"], "a.mp4"));
    await new ApiClient({ baseUrl: "" }, "server").upload("/api/contents/upload", form, z.object({ ok: z.boolean() }), { idempotent: true });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.init.body).toBe(form);
    expect(headers["content-type"]).toBeUndefined();
    expect(headers["x-amber-request"]).toBe("1");
    expect(headers["idempotency-key"]).toBeTruthy();
  });
});

describe("ApiClient.bytes", () => {
  const FONT = { accept: "font/otf", maxBytes: 8 };
  function stubBytes(response: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response();
    });
    return calls;
  }

  it("reads the body with the sidecar token, the CSRF marker in server mode and the accepted type", async () => {
    const calls = stubBytes(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "font/otf" } }));
    const local = await new ApiClient({ baseUrl: "http://127.0.0.1:9", token: "tok" }, "local").bytes("/api/fonts/subtitle", FONT);
    expect([...new Uint8Array(local)]).toEqual([1, 2, 3]);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("http://127.0.0.1:9/api/fonts/subtitle");
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(headers["accept"]).toBe("font/otf");
    expect(calls[0]?.init.credentials).toBe("same-origin");
    await new ApiClient({ baseUrl: "" }, "server").bytes("/api/fonts/subtitle", FONT);
    const server = calls[1]?.init.headers as Record<string, string>;
    expect(server["x-amber-request"]).toBe("1");
    expect(server["authorization"]).toBeUndefined();
  });

  it("sends the accepted types as the header and checks the response type against the prefix", async () => {
    const calls = stubBytes(() => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
    const options = { accept: "image/webp, image/png, image/jpeg", acceptPrefix: "image/", maxBytes: 8 };
    const bytes = await new ApiClient({ baseUrl: "" }, "local").bytes("/api/photo", options);
    expect([...new Uint8Array(bytes)]).toEqual([1]);
    expect((calls[0]?.init.headers as Record<string, string>)["accept"]).toBe("image/webp, image/png, image/jpeg");
    // Without a prefix the whole accept text is the prefix, so a list never matches a single type.
    const strict = await new ApiClient({ baseUrl: "" }, "local").bytes("/api/photo", { accept: options.accept, maxBytes: 8 }).catch((error: unknown) => error);
    expect(strict).toBeInstanceOf(ApiError);
    stubBytes(() => new Response(new Uint8Array([1]), { headers: { "content-type": "text/html" } }));
    const wrong = await new ApiClient({ baseUrl: "" }, "local").bytes("/api/photo", options).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(ApiError);
  });

  it("hands a server-mode 401 to onUnauthenticated and throws the AppError", async () => {
    stubBytes(() => new Response(JSON.stringify({ error: { class: "unauthenticated", code: "unauthenticated", retryDisposition: "never", userMessage: "" } }), { status: 401 }));
    const client = new ApiClient({ baseUrl: "" }, "server");
    const onUnauthenticated = vi.fn();
    client.onUnauthenticated = onUnauthenticated;
    const failure = await client.bytes("/api/fonts/subtitle", FONT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it("refuses another content type", async () => {
    stubBytes(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
    const failure = await new ApiClient({ baseUrl: "" }, "local").bytes("/api/fonts/subtitle", FONT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).error.upstreamMessage).toBe("unexpected content type");
  });

  it("refuses a declared length over the limit before reading, and an undeclared body once it passes the limit", async () => {
    let pulled = 0;
    stubBytes(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(5));
            },
          }),
          { headers: { "content-type": "font/otf", "content-length": "9" } },
        ),
    );
    const declared = await new ApiClient({ baseUrl: "" }, "local").bytes("/api/fonts/subtitle", FONT).catch((error: unknown) => error);
    expect((declared as ApiError).error.upstreamMessage).toBe("response too large");
    expect(pulled).toBeLessThanOrEqual(1);

    pulled = 0;
    stubBytes(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(5));
            },
          }),
          { headers: { "content-type": "font/otf" } },
        ),
    );
    const streamed = await new ApiClient({ baseUrl: "" }, "local").bytes("/api/fonts/subtitle", FONT).catch((error: unknown) => error);
    expect((streamed as ApiError).error.upstreamMessage).toBe("response too large");
    // Two chunks pass the limit of 8; reading stops there rather than draining the endless body.
    expect(pulled).toBeLessThanOrEqual(3);
  });
});
