import { amberError } from "../../domain/errors.ts";
import type { ProviderProfile } from "../../domain/provider-profile.ts";
import type { RequestStartInfo } from "../../domain/usage.ts";
import { OutboundHttpError } from "../../ports/outbound-http.ts";
import type { SecretStore } from "../../ports/secret-store.ts";

/** One server-sent event: the `event:` name if any and the joined `data:` lines. */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parses a `text/event-stream` body (WHATWG HTML 9.2). Chunk boundaries may fall anywhere,
 * including inside a multi-byte character; comments and `id` / `retry` fields are ignored.
 */
export async function* sseEvents(body: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = (): SseEvent | undefined => {
    const result = data.length === 0 ? undefined : { ...(event === undefined ? {} : { event }), data: data.join("\n") };
    event = undefined;
    data = [];
    return result;
  };
  const lines = function* (final: boolean): Generator<string> {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      // A lone trailing CR may be the first half of CRLF still in flight.
      if (match === null || (!final && match[0] === "\r" && match.index === buffer.length - 1)) {
        break;
      }
      yield buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
    }
  };
  const handle = (line: string): SseEvent | undefined => {
    if (line === "") {
      return dispatch();
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
    return undefined;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (const line of lines(false)) {
      const dispatched = handle(line);
      if (dispatched !== undefined) {
        yield dispatched;
      }
    }
  }
  buffer += decoder.decode();
  for (const line of lines(true)) {
    const dispatched = handle(line);
    if (dispatched !== undefined) {
      yield dispatched;
    }
  }
  // A stream that ends without a blank line still delivers its last event.
  if (buffer !== "") {
    handle(buffer);
  }
  const last = dispatch();
  if (last !== undefined) {
    yield last;
  }
}

/** Raised when an upstream stays silent longer than the idle limit. */
export class IdleTimeoutError extends Error {
  constructor() {
    super("upstream stream went idle");
    this.name = "IdleTimeoutError";
  }
}

/**
 * Yields `source` but fails with `IdleTimeoutError` when the next item takes longer than
 * `idleMs`; `onIdle` runs first so the caller can abort the underlying request.
 */
export async function* withIdleTimeout<T>(source: AsyncIterable<T>, idleMs: number, onIdle: () => void): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onIdle();
          reject(new IdleTimeoutError());
        }, idleMs);
      });
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([iterator.next(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

/**
 * Bounds an LLM request by model output rather than by bytes on the wire.
 * `start` (just before the request is handed to outbound HTTP) allows `firstMs` until the
 * model first produces anything, response headers included, so a model that reasons in
 * silence is not cut off. Every later output (`progress`) allows `idleMs` again.
 * Heartbeats, empty deltas and metadata must not call it, or a live connection that has
 * stopped producing would never expire. `suspend` / `resume` bracket handing text to the
 * consumer, so a slow consumer is not taken for a stalled upstream.
 *
 * On expiry it only aborts `controller`: the failure keeps its send-boundary phase and
 * `transportFailure` classifies it, so a request that never fully left stays
 * safe to retry.
 */
export class OutputWatchdog {
  private readonly controller: AbortController;
  private readonly firstMs: number;
  private readonly idleMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(controller: AbortController, limits: { firstMs: number; idleMs: number }) {
    this.controller = controller;
    this.firstMs = limits.firstMs;
    this.idleMs = limits.idleMs;
  }

  start(): void {
    this.arm(this.firstMs);
  }

  progress(): void {
    this.arm(this.idleMs);
  }

  suspend(): void {
    this.clear();
  }

  resume(): void {
    this.arm(this.idleMs);
  }

  /** Final: nothing aborts afterwards. Safe to call more than once. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private arm(ms: number): void {
    if (this.stopped) {
      return;
    }
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.controller.abort();
    }, ms);
  }

  private clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** A signal that aborts with `parent` and can also be aborted locally (idle timeout). */
export function linkedController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  }
  return controller;
}

/**
 * A transport failure of an LLM request as the caller sees it. The caller's own
 * cancellation passes through unchanged (its `phase` says whether the request was sent);
 * a failure before the send boundary is safe to retry; afterwards, including an idle
 * stream, the request may have been processed and billed, so the outcome is unknown.
 */
export function transportFailure(error: unknown, callerSignal: AbortSignal): unknown {
  if (callerSignal.aborted && error instanceof OutboundHttpError) {
    return error;
  }
  if (error instanceof IdleTimeoutError) {
    return amberError("llm_outcome_unknown", error.message);
  }
  if (error instanceof OutboundHttpError) {
    return error.phase === "before_send"
      ? amberError("llm_failed", error.message, { code: "llm_failed.unreachable" })
      : amberError("llm_outcome_unknown", error.message);
  }
  return error;
}

/**
 * The profile's key for one request, revealed once and reported through `onRequestStart`
 * together with its version and the send time. The caller must send with the returned key
 * right away: revealing again would let the recorded version differ from the key actually
 * sent. The callback is the last thing that can stop the request, so a throw from it
 * propagates and nothing is sent. The key must not be kept or logged.
 */
export function beginRequest(
  profile: ProviderProfile,
  secrets: Pick<SecretStore, "revealVersioned">,
  onRequestStart: (info: RequestStartInfo) => void,
  now: () => number,
): string {
  if (profile.credentialRef === undefined) {
    throw amberError("llm_unconfigured", "provider profile has no credential");
  }
  const { plaintext, version } = secrets.revealVersioned(profile.userId, profile.credentialRef);
  onRequestStart({ sentAt: now(), credential: version });
  return plaintext;
}

/** `baseURL` is stored without a trailing slash; the protocol path is appended here. */
export function endpoint(profile: ProviderProfile, path: string): string {
  return `${profile.baseURL.replace(/\/+$/u, "")}${path}`;
}
