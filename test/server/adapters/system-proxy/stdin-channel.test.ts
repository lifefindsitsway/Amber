import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { fromSystemMessage } from "../../../../src/server/adapters/system-proxy/config.ts";
import { SystemProxyState } from "../../../../src/server/adapters/system-proxy/state.ts";
import { listenSystemProxyMessages, SystemProxyLineReader, type StdinDiscard } from "../../../../src/server/adapters/system-proxy/stdin-channel.ts";
import type { SystemProxyMessage } from "../../../../src/server/adapters/system-proxy/config.ts";
import { SYSTEM_PROXY_MESSAGE_MAX_BYTES } from "../../../../src/shared/defaults.ts";

const line = (seq: number, http = "127.0.0.1:7890"): string =>
  `${JSON.stringify({ v: 1, type: "system_proxy", seq, config: { state: "manual", http, https: http, bypass: ["localhost"] } })}\n`;

function reader() {
  const messages: SystemProxyMessage[] = [];
  const discarded: StdinDiscard[] = [];
  const lines = new SystemProxyLineReader({ onMessage: (message) => messages.push(message), onDiscard: (reason) => discarded.push(reason) });
  return { lines, messages, discarded };
}

describe("SystemProxyLineReader", () => {
  it("assembles a message split into many chunks, even inside a multi-byte character", () => {
    const { lines, messages } = reader();
    const bytes = Buffer.from(line(1).replace('"localhost"', '"内网.example"'), "utf8");
    for (let index = 0; index < bytes.length; index += 3) lines.push(bytes.subarray(index, index + 3));
    expect(messages.map((message) => [message.seq, message.config.bypass])).toEqual([[1, ["内网.example"]]]);
  });

  it("reads several messages arriving in one chunk, CRLF included", () => {
    const { lines, messages } = reader();
    lines.push(Buffer.from(`${line(1)}${line(2).replace("\n", "\r\n")}\n${line(3).slice(0, 20)}`));
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);
    lines.push(Buffer.from(line(3).slice(20)));
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 3]);
  });

  it("drops a line over the size limit up to the next newline and reads on after it", () => {
    const { lines, messages, discarded } = reader();
    const long = "x".repeat(SYSTEM_PROXY_MESSAGE_MAX_BYTES + 10);
    lines.push(Buffer.from(long.slice(0, 5000)));
    lines.push(Buffer.from(long.slice(5000)));
    lines.push(Buffer.from(`"}\n${line(4)}`));
    expect(discarded).toEqual(["too_long"]);
    expect(messages.map((message) => message.seq)).toEqual([4]);
    // Exactly at the limit is still read.
    const padded = JSON.stringify({ v: 1, type: "system_proxy", seq: 5, config: { state: "off", bypass: ["a".repeat(1)] } });
    const fill = SYSTEM_PROXY_MESSAGE_MAX_BYTES - padded.length;
    const atLimit = padded.replace('["a"]', `["${"a".repeat(1 + fill)}"]`);
    expect(Buffer.byteLength(atLimit)).toBe(SYSTEM_PROXY_MESSAGE_MAX_BYTES);
    lines.push(Buffer.from(`${atLimit}\n`));
    expect(messages.map((message) => message.seq)).toEqual([4, 5]);
  });

  it("drops invalid JSON, invalid UTF-8 and messages outside the schema", () => {
    const { lines, messages, discarded } = reader();
    lines.push(Buffer.from('{"v":1,"type":\n'));
    lines.push(Buffer.concat([Buffer.from('{"v":1,"type":"system_proxy","seq":1,"config":{"state":"off","bypass":["'), Buffer.from([0xff]), Buffer.from('"]}}\n')]));
    lines.push(Buffer.from('{"v":2,"type":"system_proxy","seq":9,"config":{"state":"off","bypass":[]}}\n'));
    lines.push(Buffer.from('{"v":1,"type":"system_proxy","seq":9,"config":{"state":"manual","http":"user:pass@127.0.0.1:7890","bypass":[]}}\n'));
    lines.push(Buffer.from("\n\n"));
    expect(discarded).toEqual(["invalid_json", "invalid_json", "invalid_message", "invalid_message"]);
    expect(messages).toEqual([]);
  });
});

describe("listenSystemProxyMessages", () => {
  it("applies newer messages to the state, ignores stale ones and logs reasons without content", () => {
    const stdin = new PassThrough();
    const state = new SystemProxyState(fromSystemMessage({ v: 1, type: "system_proxy", seq: 2, config: { state: "off", bypass: [] } }));
    const logged: Array<[string, Record<string, unknown>]> = [];
    listenSystemProxyMessages(stdin, state, (event, fields) => logged.push([event, fields]));
    stdin.write(line(1, "10.9.9.9:1111"));
    stdin.write(line(2, "10.9.9.9:2222"));
    stdin.write(line(3, "10.9.9.9:3333"));
    stdin.write("garbage\n");
    expect(state.current.seq).toBe(3);
    expect(state.status().proxy).toEqual({ http: "10.9.9.9:3333", https: "10.9.9.9:3333" });
    expect(logged).toEqual([
      ["system_proxy_ignored", { reason: "stale_seq" }],
      ["system_proxy_ignored", { reason: "stale_seq" }],
      ["system_proxy_applied", { seq: 3, state: "manual" }],
      ["system_proxy_ignored", { reason: "invalid_json" }],
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/10\.9\.9\.9|localhost|garbage/);
  });
});
