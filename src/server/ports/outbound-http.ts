export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A request body written chunk by chunk, never held in memory as a whole (large audio
 * uploads). `contentLength` must equal the bytes the stream yields; it is sent as
 * `Content-Length` and tells the transport which chunk is the last one, which is where
 * the send boundary lies.
 */
export interface OutboundStreamBody {
  stream: AsyncIterable<Uint8Array>;
  contentType: string;
  contentLength: number;
}

export interface OutboundRequest {
  url: string;
  method: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array | FormData | OutboundStreamBody;
  /** Shared by every hop of a followed redirect chain. */
  signal: AbortSignal;
  /** Bounds each hop separately, up to its response headers. */
  timeoutMs?: number;
  /**
   * `follow` (default): GET / HEAD follow 3xx redirects, each hop re-checked by the
   * network policy and stripped of all but a few harmless headers when it changes origin;
   * other methods get the 3xx back. `manual`: the 3xx is returned and the caller walks
   * the chain itself, every request still checked.
   */
  redirect?: "follow" | "manual";
  /**
   * The target must be a public address in every run mode: private, loopback, link-local and
   * other reserved ranges are refused and the connection is pinned to the checked IP, even
   * where the mode otherwise trusts the network (the desktop client) and even for an origin an
   * administrator allowlisted. Set by platform adapters, whose targets are fixed public
   * platform hosts; user-configured endpoints never set it. The desktop client additionally
   * admits the fake-IP range proxy tools resolve every domain into, or platform requests behind
   * such a proxy would always fail.
   */
  publicOnly?: boolean;
}

export interface OutboundResponse {
  status: number;
  /** Repeated headers are joined with `, `; use `setCookies` for `Set-Cookie`. */
  headers: ReadonlyMap<string, string>;
  /**
   * Each `Set-Cookie` header as sent: joining them is lossy because `Expires` holds a
   * comma. Absent means none.
   */
  setCookies?: readonly string[];
  body: AsyncIterable<Uint8Array>;
  text(): Promise<string>;
  /**
   * Discards a response whose body is not wanted (an unfollowed 3xx, a status the caller rejects)
   * without reading it, releasing the connection at once. Every real transport implements it;
   * callers invoke it as `response.destroy?.()`.
   */
  destroy?(): void;
}

/**
 * Where a failed request stopped. Until the last chunk of the body is handed to the
 * socket the upstream cannot hold a complete request, so failures (DNS, refused
 * connection, TLS, a connection dropped mid-upload) are `before_send` and safe to retry.
 * From the last chunk on, `after_send` means the request may have been processed, so a
 * paid call becomes `outcome_unknown` and is not re-sent automatically.
 */
export type OutboundFailurePhase = "before_send" | "after_send";

/**
 * Transport failure of an outbound request. HTTP error statuses are not failures: they
 * arrive as responses. Carries no URL, headers or body so nothing sensitive can leak
 * through its message.
 */
export class OutboundHttpError extends Error {
  readonly phase: OutboundFailurePhase;
  readonly reason: "network" | "timeout" | "aborted";

  constructor(phase: OutboundFailurePhase, reason: "network" | "timeout" | "aborted", options?: { cause?: unknown }) {
    super(`outbound request failed ${phase === "before_send" ? "before" : "after"} sending (${reason})`, options);
    this.name = "OutboundHttpError";
    this.phase = phase;
    this.reason = reason;
  }
}

/**
 * Invariant: the single exit for HTTP to user-controllable
 * targets. The network policy lives inside the implementation: private, loopback,
 * link-local and metadata ranges are refused unless allowlisted, the connected IP is
 * the one that was checked, and redirects are re-validated. Adapters never re-implement it.
 * Policy refusals are `network_blocked_by_policy` AmberErrors raised before anything is sent.
 */
export interface OutboundHttpClient {
  request(request: OutboundRequest): Promise<OutboundResponse>;
}
