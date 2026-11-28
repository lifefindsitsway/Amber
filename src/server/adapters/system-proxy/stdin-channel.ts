import type { Readable } from "node:stream";
import { SYSTEM_PROXY_MESSAGE_MAX_BYTES } from "../../../shared/defaults.ts";
import { systemProxyMessageSchema, type SystemProxyMessage } from "./config.ts";
import type { SystemProxyState } from "./state.ts";

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** Why a stdin line was dropped; logged without the line itself. */
export type StdinDiscard = "too_long" | "invalid_json" | "invalid_message";

/**
 * Splits stdin into lines by bytes, so a message may arrive in any number of chunks and several
 * messages in one. A line longer than `SYSTEM_PROXY_MESSAGE_MAX_BYTES` is dropped up to the next
 * newline without being held in memory. Each complete line must be one valid message; anything
 * else is dropped and changes nothing.
 */
export class SystemProxyLineReader {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private discarding = false;
  private readonly onMessage: (message: SystemProxyMessage) => void;
  private readonly onDiscard: (reason: StdinDiscard) => void;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(handlers: { onMessage(message: SystemProxyMessage): void; onDiscard(reason: StdinDiscard): void }) {
    this.onMessage = handlers.onMessage;
    this.onDiscard = handlers.onDiscard;
  }

  push(chunk: Uint8Array): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(NEWLINE, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!this.discarding) {
        this.pendingBytes += piece.length;
        if (this.pendingBytes > SYSTEM_PROXY_MESSAGE_MAX_BYTES + 1) {
          this.drop();
        } else {
          this.pending.push(Buffer.from(piece));
        }
      }
      if (end < 0) {
        return;
      }
      if (this.discarding) {
        this.discarding = false;
        this.onDiscard("too_long");
      } else {
        this.line(Buffer.concat(this.pending));
      }
      this.pending = [];
      this.pendingBytes = 0;
      start = end + 1;
    }
  }

  private drop(): void {
    this.discarding = true;
    this.pending = [];
    this.pendingBytes = 0;
  }

  private line(bytes: Buffer): void {
    const content = bytes.at(-1) === CARRIAGE_RETURN ? bytes.subarray(0, -1) : bytes;
    if (content.length === 0) {
      return;
    }
    if (content.length > SYSTEM_PROXY_MESSAGE_MAX_BYTES) {
      this.onDiscard("too_long");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(this.decoder.decode(content));
    } catch {
      this.onDiscard("invalid_json");
      return;
    }
    const message = systemProxyMessageSchema.safeParse(value);
    if (!message.success) {
      this.onDiscard("invalid_message");
      return;
    }
    this.onMessage(message.data);
  }
}

/**
 * Feeds the sidecar's stdin into the proxy state. Registered before READY so no message the
 * shell writes after start-up is missed. `log` gets an event name and fields without any message
 * content: a proxy line is configuration, but it is never echoed.
 */
export function listenSystemProxyMessages(
  stdin: Readable,
  state: SystemProxyState,
  log: (event: string, fields: Record<string, unknown>) => void,
): SystemProxyLineReader {
  const reader = new SystemProxyLineReader({
    onMessage: (message) => {
      const rejected = state.apply(message);
      if (rejected === undefined) {
        log("system_proxy_applied", { seq: message.seq, state: state.current.state });
      } else {
        log("system_proxy_ignored", { reason: rejected });
      }
    },
    onDiscard: (reason) => log("system_proxy_ignored", { reason }),
  });
  stdin.on("data", (chunk: Buffer | string) => reader.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
  return reader;
}
