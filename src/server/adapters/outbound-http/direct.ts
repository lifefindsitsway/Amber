import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction, Socket } from "node:net";
import {
  OutboundHttpError,
  type OutboundFailurePhase,
  type OutboundHttpClient,
  type OutboundRequest,
  type OutboundResponse,
  type OutboundStreamBody,
} from "../../ports/outbound-http.ts";

/** An address the network policy has checked; the connection must go exactly there. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/** One hop as the policy layer sends it. */
export interface OutboundTransport {
  send(request: OutboundRequest, pinned?: PinnedAddress): Promise<OutboundResponse>;
}

/**
 * The raw HTTP transport under the network policy (`PolicyOutboundHttpClient`), which follows
 * redirects, checks every hop and pins the checked address through `send`.
 *
 * Redirects are never followed here: a 3xx is returned as is. A pinned request resolves
 * its host to the given address only and uses a connection of its own (`agent: false`):
 * a pooled keep-alive socket would skip the lookup and could still lead to an address
 * checked under an earlier allowlist or DNS answer. Failures are classified by the
 * send boundary that decides whether a paid call may be retried: a request becomes
 * `after_send` only once its last chunk (the headers alone for a request without a body)
 * has been handed to a connected socket, TLS handshake included. Anything earlier (DNS, refused connection, TLS, a connection
 * dropped mid-upload) leaves the upstream without a complete request and is `before_send`.
 * Streamed bodies are written chunk by chunk with backpressure, one chunk read ahead so the
 * last one is known before it is written. `timeoutMs` bounds the whole exchange up to the
 * response headers, upload included.
 */
export class DirectOutboundHttpClient implements OutboundHttpClient, OutboundTransport {
  request(request: OutboundRequest): Promise<OutboundResponse> {
    return this.send(request);
  }

  async send(request: OutboundRequest, pinned?: PinnedAddress): Promise<OutboundResponse> {
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("only http and https URLs are supported");
    }
    const body = await encodeBody(request.body);
    const headers: Record<string, string> = { ...request.headers };
    if (body.contentType !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["content-type"] = body.contentType;
    }
    if (body.stream !== undefined) {
      headers["content-length"] = String(body.stream.contentLength);
    } else if (body.bytes !== undefined) {
      headers["content-length"] = String(body.bytes.byteLength);
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<OutboundResponse>((resolve, reject) => {
      let phase: OutboundFailurePhase = "before_send";
      let connected = false;
      let lastChunkQueued = false;
      let settled = false;
      let incoming: IncomingMessage | undefined;
      const crossBoundaryIfComplete = (): void => {
        if (connected && lastChunkQueued) {
          phase = "after_send";
        }
      };
      const fail = (reason: OutboundHttpError["reason"], cause?: unknown): void => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new OutboundHttpError(phase, reason, { cause }));
        }
        outgoing.destroy();
      };
      const onAbort = (): void => fail("aborted", request.signal.reason);
      const timer =
        request.timeoutMs === undefined ? undefined : setTimeout(() => fail("timeout"), request.timeoutMs);
      const cleanup = (): void => {
        request.signal.removeEventListener("abort", onAbort);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };

      const outgoing = send(url, {
        method: request.method,
        headers,
        ...(pinned === undefined ? {} : { lookup: pinnedLookup(pinned), agent: false }),
      });
      outgoing.once("socket", (socket: Socket) => {
        const connectedEvent = url.protocol === "https:" ? "secureConnect" : "connect";
        const onConnected = (): void => {
          connected = true;
          crossBoundaryIfComplete();
        };
        // A reused keep-alive socket is already connected (and past its TLS handshake).
        if (!socket.connecting) {
          onConnected();
        } else {
          socket.once(connectedEvent, onConnected);
        }
      });
      outgoing.once("error", (error) => fail(request.signal.aborted ? "aborted" : "network", error));
      outgoing.once("response", (response: IncomingMessage) => {
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        incoming = response;
        cleanup();
        resolve(toResponse(response, request.signal));
      });

      if (request.signal.aborted) {
        fail("aborted", request.signal.reason);
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
      const queueLast = (chunk?: Uint8Array): void => {
        lastChunkQueued = true;
        crossBoundaryIfComplete();
        outgoing.end(chunk);
      };
      if (body.stream === undefined) {
        queueLast(body.bytes);
        return;
      }
      pumpStream(outgoing, body.stream, {
        stopped: () => settled,
        queueLast,
        fail: (cause) => fail("network", cause),
        // The upstream answered before the upload ended: the request is incomplete, so its
        // connection must not go back to the keep-alive pool.
        abandon: () => {
          if (incoming === undefined) {
            outgoing.destroy();
          } else {
            incoming.once("close", () => outgoing.destroy());
          }
        },
      }).catch((error: unknown) => fail("network", error));
    });
  }
}

/** A `lookup` that answers every query with the checked address and nothing else. */
function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      (callback as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

/** Writes a streamed body with backpressure, holding one chunk back to know which is last. */
async function pumpStream(
  outgoing: ClientRequest,
  body: OutboundStreamBody,
  control: {
    stopped(): boolean;
    queueLast(chunk?: Uint8Array): void;
    fail(cause: Error): void;
    abandon(): void;
  },
): Promise<void> {
  const iterator = body.stream[Symbol.asyncIterator]();
  let finished = false;
  try {
    let current = await iterator.next();
    let written = 0;
    while (!current.done) {
      const next = await iterator.next();
      if (control.stopped()) {
        control.abandon();
        return;
      }
      written += current.value.byteLength;
      // A length that disagrees with Content-Length is caught before the excess or the
      // final chunk goes out, so the upstream never holds a complete request.
      if (written > body.contentLength || (next.done === true && written !== body.contentLength)) {
        control.fail(new Error(`streamed body length disagrees with its declared ${body.contentLength} bytes`));
        return;
      }
      if (next.done === true) {
        finished = true;
        control.queueLast(current.value);
        return;
      }
      if (!outgoing.write(current.value)) {
        await drained(outgoing);
        if (control.stopped()) {
          control.abandon();
          return;
        }
      }
      current = next;
    }
    if (body.contentLength !== 0) {
      control.fail(new Error(`streamed body length disagrees with its declared ${body.contentLength} bytes`));
      return;
    }
    finished = true;
    control.queueLast();
  } finally {
    if (!finished) {
      await iterator.return?.();
    }
  }
}

function drained(outgoing: ClientRequest): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      outgoing.off("drain", done);
      outgoing.off("close", done);
      resolve();
    };
    outgoing.once("drain", done);
    outgoing.once("close", done);
  });
}

function toResponse(incoming: IncomingMessage, signal: AbortSignal): OutboundResponse {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const onAbort = (): void => {
    incoming.destroy(new OutboundHttpError("after_send", "aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  incoming.once("close", () => signal.removeEventListener("abort", onAbort));
  // A broken body stream means the upstream may have processed the request.
  const body = (async function* (): AsyncIterable<Uint8Array> {
    try {
      for await (const chunk of incoming) {
        yield chunk as Uint8Array;
      }
    } catch (error) {
      throw error instanceof OutboundHttpError ? error : new OutboundHttpError("after_send", "network", { cause: error });
    }
    if (!incoming.complete) {
      throw new OutboundHttpError("after_send", "network");
    }
  })();
  const setCookies = incoming.headers["set-cookie"] ?? [];
  return {
    status: incoming.statusCode ?? 0,
    headers,
    ...(setCookies.length === 0 ? {} : { setCookies }),
    destroy() {
      incoming.destroy();
    },
    body,
    async text() {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

interface EncodedBody {
  bytes?: Uint8Array;
  stream?: OutboundStreamBody;
  contentType?: string;
}

function isStreamBody(body: OutboundRequest["body"]): body is OutboundStreamBody {
  return typeof body === "object" && body !== null && "stream" in body && "contentLength" in body;
}

async function encodeBody(body: OutboundRequest["body"]): Promise<EncodedBody> {
  if (body === undefined) {
    return {};
  }
  if (typeof body === "string") {
    return { bytes: Buffer.from(body, "utf8") };
  }
  if (body instanceof Uint8Array) {
    return { bytes: body };
  }
  if (isStreamBody(body)) {
    return { stream: body, contentType: body.contentType };
  }
  // Multipart encoding (boundary included) by the platform's own FormData serializer.
  const encoded = new Response(body);
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    ...(encoded.headers.get("content-type") === null ? {} : { contentType: encoded.headers.get("content-type") as string }),
  };
}
