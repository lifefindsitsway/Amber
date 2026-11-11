import type { z } from "zod";
import { appErrorSchema, type AppError } from "../../shared/errors.ts";
import type { RunMode } from "../../shared/enums.ts";
import { versionDtoSchema } from "../../shared/dto/system.ts";

/** A failed `/api` call: the server's `AppError`, or a synthesized one for transport failures. */
export class ApiError extends Error {
  readonly status: number;
  readonly error: AppError;
  /** Seconds from a `Retry-After` header (rate-limited logins), when the server sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, error: AppError, retryAfterSeconds?: number) {
    super(error.code);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Where `/api` lives and which headers authenticate a call. */
export interface ApiEndpoint {
  /** Origin prefix; empty for same-origin (browser and the dev proxy). */
  baseUrl: string;
  /** The desktop sidecar's bearer token; never present in the browser. */
  token?: string;
}

export interface RequestOptions {
  body?: unknown;
  /** Task-creating and paid POSTs carry an Idempotency-Key. */
  idempotent?: boolean;
  /**
   * A caller-held Idempotency-Key, reused when retrying the same intent after an unknown
   * outcome; it wins over `idempotent`.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Extra request headers (the setup token). */
  headers?: Record<string, string>;
  /**
   * Whether a 401 hands control to `onUnauthenticated`. Calls that expect a 401 as an
   * answer (login, setup, password change, the auth gate's own probe) turn it off.
   */
  authRedirect?: boolean;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The single `/api` access point. Business components never see the run mode:
 * the desktop shell supplies endpoint + token, the browser talks to its own origin, and the
 * server mode adds the CSRF marker header. Responses are validated against the shared schema.
 */
export class ApiClient {
  /** Replaced in place when the desktop shell restarts the sidecar on a new port and token. */
  endpoint: ApiEndpoint;
  mode: RunMode | undefined;
  /**
   * Called when a server-mode request is answered 401: the session ended mid-use and the
   * app should return to `/login`. Never called in local mode.
   */
  onUnauthenticated: (() => void) | undefined;

  constructor(endpoint: ApiEndpoint, mode?: RunMode) {
    this.endpoint = endpoint;
    this.mode = mode;
  }

  /** Points every later call at a new endpoint (desktop sidecar restart). */
  setEndpoint(endpoint: ApiEndpoint): void {
    this.endpoint = endpoint;
  }

  /** Reads the run mode once; `/api/version` is public apart from the sidecar token. */
  async init(): Promise<this> {
    const version = await this.get("/api/version", versionDtoSchema);
    this.mode = version.mode;
    return this;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.endpoint.token === undefined ? {} : { authorization: `Bearer ${this.endpoint.token}` }),
      // Server-mode CSRF marker; the local sidecar's CORS allowlist does not admit it.
      ...(this.mode === "server" ? { "x-amber-request": "1" } : {}),
      ...extra,
    };
  }

  url(path: string): string {
    return `${this.endpoint.baseUrl}${path}`;
  }

  get<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.request("GET", path, schema, options);
  }

  post<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.request("POST", path, schema, options);
  }

  put<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.request("PUT", path, schema, options);
  }

  patch<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.request("PATCH", path, schema, options);
  }

  delete<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.request("DELETE", path, schema, options);
  }

  /** A raw streaming response (SSE); the caller owns the body. */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchOrThrow(this.url(path), {
      method: "GET",
      headers: this.headers({ accept: "text/event-stream" }),
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) {
      throw await this.failure(response, true);
    }
    return response;
  }

  /**
   * A POST whose answer streams as SSE (chat). Errors before the stream starts arrive as
   * JSON and throw; a 2xx answer is returned raw, and a JSON one is an idempotent replay.
   */
  async postStream(path: string, options: RequestOptions & { body: unknown; signal: AbortSignal }): Promise<Response> {
    const response = await this.fetchOrThrow(this.url(path), {
      method: "POST",
      headers: this.headers({
        accept: "text/event-stream",
        "content-type": "application/json",
        ...(options.idempotent === true ? { "idempotency-key": crypto.randomUUID() } : {}),
      }),
      credentials: "same-origin",
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
    if (!response.ok) {
      throw await this.failure(response, options.authRedirect !== false);
    }
    return response;
  }

  /**
   * A multipart POST (upload). The browser sets the multipart boundary; the CSRF marker
   * and the Idempotency-Key travel as usual.
   */
  async upload<T>(path: string, form: FormData, schema: z.ZodType<T>, options: Pick<RequestOptions, "idempotent" | "signal"> = {}): Promise<T> {
    const response = await this.fetchOrThrow(this.url(path), {
      method: "POST",
      headers: this.headers(options.idempotent === true ? { "idempotency-key": crypto.randomUUID() } : {}),
      credentials: "same-origin",
      body: form,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return this.parse(response, schema, true);
  }

  /**
   * A POST answered with a file (export): JSON errors throw like any other call; a 2xx body
   * is returned whole with the name its `Content-Disposition` gives it.
   */
  async postFile(path: string, body: unknown): Promise<ExportedFile> {
    const response = await this.fetchOrThrow(this.url(path), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await this.failure(response, true);
    }
    const filename = filenameOf(response.headers.get("content-disposition"));
    if (filename === undefined) {
      throw new ApiError(response.status, localError("internal", "file response without a file name"));
    }
    return { filename, blob: await response.blob() };
  }

  /**
   * A GET answered with raw bytes (the subtitle font). Authentication, the 401 redirect and
   * error conversion work as for JSON calls. The body must declare a `Content-Type` starting
   * with `acceptPrefix` (default: `accept`, which is what the request sends as its `Accept`
   * header; a caller offering several types sets the prefix to their common family) and stay
   * within `maxBytes`: a larger `Content-Length` is refused before
   * reading, and the read stops as soon as the bytes received pass the limit, so a lying or
   * missing header cannot make the page buffer an unbounded body.
   */
  async bytes(path: string, options: { accept: string; acceptPrefix?: string; maxBytes: number; signal?: AbortSignal }): Promise<ArrayBuffer> {
    const response = await this.fetchOrThrow(this.url(path), {
      method: "GET",
      headers: this.headers({ accept: options.accept }),
      credentials: "same-origin",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      throw await this.failure(response, true);
    }
    const refuse = async (message: string): Promise<never> => {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(response.status, localError("internal", message));
    };
    const type = (response.headers.get("content-type") ?? "").trim().toLowerCase();
    if (!type.startsWith((options.acceptPrefix ?? options.accept).toLowerCase())) {
      return refuse("unexpected content type");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > options.maxBytes) {
      return refuse("response too large");
    }
    if (response.body === null) {
      const whole = await response.arrayBuffer();
      if (whole.byteLength > options.maxBytes) throw new ApiError(response.status, localError("internal", "response too large"));
      return whole;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(response.status, localError("internal", "response too large"));
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }

  private async request<T>(method: Method, path: string, schema: z.ZodType<T>, options: RequestOptions): Promise<T> {
    const extra: Record<string, string> = {};
    if (options.body !== undefined) {
      extra["content-type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) {
      extra["idempotency-key"] = options.idempotencyKey;
    } else if (options.idempotent === true) {
      extra["idempotency-key"] = crypto.randomUUID();
    }
    const response = await this.fetchOrThrow(this.url(path), {
      method,
      headers: this.headers({ ...extra, ...options.headers }),
      credentials: "same-origin",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return this.parse(response, schema, options.authRedirect !== false);
  }

  private async parse<T>(response: Response, schema: z.ZodType<T>, authRedirect: boolean): Promise<T> {
    if (!response.ok) {
      throw await this.failure(response, authRedirect);
    }
    const text = await response.text();
    const parsed = schema.safeParse(text === "" ? undefined : JSON.parse(text));
    if (!parsed.success) {
      throw new ApiError(response.status, localError("internal", "response does not match the expected schema"));
    }
    return parsed.data;
  }

  /** The ApiError of a failed response; a server-mode 401 also reports the ended session. */
  private async failure(response: Response, authRedirect: boolean): Promise<ApiError> {
    if (response.status === 401 && authRedirect && this.mode === "server") {
      this.onUnauthenticated?.();
    }
    return errorOf(response);
  }

  private async fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new ApiError(0, localError("unknown", "backend unreachable"));
    }
  }
}

/** A downloaded file: its name and its bytes. */
export interface ExportedFile {
  filename: string;
  blob: Blob;
}

/**
 * The file name of a `Content-Disposition` header: the RFC 5987 `filename*=UTF-8''…` form
 * first, then a plain or quoted `filename=`. Path separators never survive.
 */
export function filenameOf(header: string | null): string | undefined {
  if (header === null) return undefined;
  let name: string | undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended !== null) {
    try {
      name = decodeURIComponent((extended[2] as string).trim());
    } catch {
      name = undefined;
    }
  }
  if (name === undefined) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    name = plain === null ? undefined : (plain[1]?.replace(/\\(.)/g, "$1") ?? plain[2]?.trim());
  }
  const safe = name?.replace(/[\\/]/g, "_").trim();
  return safe === undefined || safe === "" ? undefined : safe;
}

async function errorOf(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: unknown };
    const parsed = appErrorSchema.safeParse(body.error);
    if (parsed.success) {
      return new ApiError(response.status, parsed.data, retryAfterOf(response.headers.get("retry-after")));
    }
  } catch {
    // Not JSON: fall through to the synthesized error.
  }
  return new ApiError(response.status, localError(response.status === 404 ? "not_found" : "internal", `HTTP ${response.status}`));
}

/** Delay-seconds form of `Retry-After` (RFC 9110 §10.2.3); the date form is not used by Amber. */
function retryAfterOf(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/** An AppError for failures that never reached the server; its message is not user copy. */
function localError(errorClass: "internal" | "unknown" | "not_found", message: string): AppError {
  return {
    class: errorClass,
    code: errorClass,
    retryDisposition: "never",
    userMessage: "",
    upstreamMessage: message,
  };
}

/** Locates the backend: the desktop shell knows the sidecar; a browser uses its own origin. */
export async function resolveEndpoint(): Promise<ApiEndpoint> {
  const { isTauri, invoke } = await import("@tauri-apps/api/core");
  if (!isTauri()) {
    return { baseUrl: "" };
  }
  const { listen } = await import("@tauri-apps/api/event");
  for (;;) {
    const sidecar = await invoke<{ endpoint: string; token: string } | null>("sidecar_endpoint");
    if (sidecar !== null) {
      return { baseUrl: sidecar.endpoint, token: sidecar.token };
    }
    await new Promise<void>((resolve) => {
      void listen("sidecar://ready", () => resolve());
    });
  }
}
