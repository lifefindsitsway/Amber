import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endpoint,
  IdleTimeoutError,
  linkedController,
  OutputWatchdog,
  beginRequest,
  sseEvents,
  transportFailure,
  withIdleTimeout,
  type SseEvent,
} from "../../../../src/server/adapters/llm/shared.ts";
import { AmberError, isAmberError } from "../../../../src/server/domain/errors.ts";
import type { ProviderProfile } from "../../../../src/server/domain/provider-profile.ts";
import { OutboundHttpError } from "../../../../src/server/ports/outbound-http.ts";

const encoder = new TextEncoder();

async function* chunks(...parts: Array<string | Uint8Array>): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield typeof part === "string" ? encoder.encode(part) : part;
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) {
    result.push(item);
  }
  return result;
}

const PROFILE: ProviderProfile = {
  id: "profile-1",
  userId: "user-1",
  name: "Relay",
  protocol: "openai_compatible",
  baseURL: "https://relay.example.invalid/v1",
  credentialRef: "secret-1",
  models: [],
  createdAt: 0,
};

describe("sseEvents", () => {
  it("joins data lines, keeps event names and skips comments and other fields", async () => {
    const events = await collect(sseEvents(chunks(": keep-alive\n\nevent: message_start\nid: 7\ndata: {\"a\":\ndata: 1}\n\ndata: plain\nretry: 10\n\n")));
    expect(events).toEqual<SseEvent[]>([{ event: "message_start", data: '{"a":\n1}' }, { data: "plain" }]);
  });

  it("handles CRLF and CR line endings, including CRLF split across chunks", async () => {
    const events = await collect(sseEvents(chunks("data: one\r", "\n\r\ndata: two\r\rdata: three\n\n")));
    expect(events.map((event) => event.data)).toEqual(["one", "two", "three"]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = encoder.encode("data: 琥珀\n\n");
    const cut = bytes.indexOf(0xe7) + 1;
    const events = await collect(sseEvents(chunks(bytes.subarray(0, cut), bytes.subarray(cut))));
    expect(events).toEqual([{ data: "琥珀" }]);
  });

  it("delivers the last event of a stream that ends without a blank line", async () => {
    const events = await collect(sseEvents(chunks("data: first\n\ndata: [DONE]")));
    expect(events.map((event) => event.data)).toEqual(["first", "[DONE]"]);
  });

  it("strips exactly one leading space from a field value", async () => {
    const events = await collect(sseEvents(chunks("data:  two spaces\ndata:none\n\n")));
    expect(events).toEqual([{ data: " two spaces\nnone" }]);
  });
});

describe("withIdleTimeout", () => {
  it("passes items through while the source keeps talking", async () => {
    const source = (async function* () {
      yield 1;
      yield 2;
    })();
    expect(await collect(withIdleTimeout(source, 50, () => undefined))).toEqual([1, 2]);
  });

  it("fails with IdleTimeoutError and calls onIdle when the next item is too slow", async () => {
    let idled = 0;
    let closed = false;
    const source = (async function* () {
      try {
        yield 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield 2;
      } finally {
        closed = true;
      }
    })();
    const seen: number[] = [];
    const error = await (async () => {
      for await (const item of withIdleTimeout(source, 20, () => (idled += 1))) {
        seen.push(item);
      }
    })().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(IdleTimeoutError);
    expect(seen).toEqual([1]);
    expect(idled).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(closed).toBe(true);
  });
});

describe("OutputWatchdog", () => {
  const FIRST = 300;
  const IDLE = 60;
  const watchdog = (): { controller: AbortController; dog: OutputWatchdog } => {
    const controller = new AbortController();
    return { controller, dog: new OutputWatchdog(controller, { firstMs: FIRST, idleMs: IDLE }) };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows firstMs until the first output, then idleMs between outputs", async () => {
    vi.useFakeTimers();
    const { controller, dog } = watchdog();
    dog.start();
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    dog.progress();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    dog.progress();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts at firstMs when nothing is produced", async () => {
    vi.useFakeTimers();
    const { controller, dog } = watchdog();
    dog.start();
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not count time while suspended and allows idleMs after resuming", async () => {
    vi.useFakeTimers();
    const { controller, dog } = watchdog();
    dog.start();
    dog.suspend();
    await vi.advanceTimersByTimeAsync(FIRST * 3);
    dog.resume();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("never aborts after stop, even when progress is reported later", async () => {
    vi.useFakeTimers();
    const { controller, dog } = watchdog();
    dog.start();
    dog.stop();
    dog.progress();
    dog.resume();
    await vi.advanceTimersByTimeAsync(FIRST * 3);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("linkedController", () => {
  it("aborts with its parent but can abort alone", () => {
    const parent = new AbortController();
    const child = linkedController(parent.signal);
    const lone = linkedController(parent.signal);
    lone.abort();
    expect(parent.signal.aborted).toBe(false);
    parent.abort(new Error("cancelled"));
    expect(child.signal.aborted).toBe(true);
    expect((child.signal.reason as Error).message).toBe("cancelled");
  });

  it("starts aborted under an aborted parent", () => {
    const parent = new AbortController();
    parent.abort();
    expect(linkedController(parent.signal).signal.aborted).toBe(true);
  });
});

describe("transportFailure", () => {
  const live = new AbortController().signal;

  it("maps a failure before the send boundary to the safe unreachable code", () => {
    const error = transportFailure(new OutboundHttpError("before_send", "network"), live) as AmberError;
    expect(error.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.unreachable", retryDisposition: "safe" });
  });

  it("maps a failure after the send boundary and an idle stream to an unknown outcome", () => {
    for (const failure of [new OutboundHttpError("after_send", "network"), new OutboundHttpError("after_send", "timeout"), new IdleTimeoutError()]) {
      const error = transportFailure(failure, live) as AmberError;
      expect(error.appError).toMatchObject({ class: "llm_outcome_unknown", retryDisposition: "outcome_unknown" });
    }
  });

  it("passes the caller's own cancellation through with its phase", () => {
    const controller = new AbortController();
    controller.abort();
    for (const phase of ["before_send", "after_send"] as const) {
      const failure = new OutboundHttpError(phase, "aborted");
      expect(transportFailure(failure, controller.signal)).toBe(failure);
    }
  });

  it("leaves other errors untouched", () => {
    const failure = new TypeError("bug");
    expect(transportFailure(failure, live)).toBe(failure);
  });
});

describe("beginRequest and endpoint", () => {
  it("reveals the profile's own credential once, reports its version with the send time, and returns the key", () => {
    const calls: Array<[string, string]> = [];
    const secrets = {
      revealVersioned: (owner: string, ref: string) => (calls.push([owner, ref]), { plaintext: "key", version: { versionId: "v1", setAt: 5 } }),
    };
    const infos: unknown[] = [];
    expect(beginRequest(PROFILE, secrets, (info) => infos.push(info), () => 77)).toBe("key");
    expect(calls).toEqual([["user-1", "secret-1"]]);
    expect(infos).toEqual([{ sentAt: 77, credential: { versionId: "v1", setAt: 5 } }]);
  });

  it("refuses a profile without a credential before reporting anything, and lets a refusing callback through", () => {
    const secrets = { revealVersioned: () => ({ plaintext: "key", version: { versionId: "v1", setAt: 5 } }) };
    const infos: unknown[] = [];
    const { credentialRef: _, ...withoutKey } = PROFILE;
    const error = (() => {
      try {
        beginRequest(withoutKey, secrets, (info) => infos.push(info), () => 77);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(isAmberError(error) && error.appError.class).toBe("llm_unconfigured");
    expect(infos).toEqual([]);
    const refusal = new Error("do not send");
    expect(() =>
      beginRequest(PROFILE, secrets, () => {
        throw refusal;
      }, () => 77),
    ).toThrow(refusal);
  });

  it("appends the protocol path without doubling slashes", () => {
    expect(endpoint(PROFILE, "/chat/completions")).toBe("https://relay.example.invalid/v1/chat/completions");
    expect(endpoint({ ...PROFILE, baseURL: "https://relay.example.invalid/v1/" }, "/chat/completions")).toBe(
      "https://relay.example.invalid/v1/chat/completions",
    );
  });
});
