import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fromProxyEnv,
  fromSystemProxyEnv,
  parseProxyAddress,
  readProxyConfiguration,
  SYSTEM_PROXY_ENV,
  systemProxyMessageSchema,
} from "../../../../src/server/adapters/system-proxy/config.ts";
import { decideRoute } from "../../../../src/server/adapters/system-proxy/route.ts";
import { SystemProxyState } from "../../../../src/server/adapters/system-proxy/state.ts";
import { SYSTEM_PROXY_BYPASS_MAX_ENTRIES } from "../../../../src/shared/defaults.ts";
import { networkStatusDtoSchema } from "../../../../src/shared/dto/network.ts";

interface Fixture {
  valid: Array<{ name: string; message: unknown }>;
  invalid: Array<{ name: string; line: string }>;
}

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/system-proxy/messages.json"), "utf8")) as Fixture;

/** Expands the fixture's generated lines; everything else is the literal line. */
function invalidLine(line: string): string {
  const generated = /^GENERATE:bypass:(\d+)$/u.exec(line);
  if (generated === null) {
    return line;
  }
  const bypass = Array.from({ length: Number(generated[1]) }, (_, index) => `host-${index}.example`);
  return JSON.stringify({ v: 1, type: "system_proxy", seq: 9, config: { state: "off", bypass } });
}

describe("system proxy messages", () => {
  it("accepts every valid message of the shared fixture and rejects every invalid one", () => {
    for (const { name, message } of FIXTURE.valid) {
      expect([name, systemProxyMessageSchema.safeParse(message).success]).toEqual([name, true]);
    }
    for (const { name, line } of FIXTURE.invalid) {
      let value: unknown;
      try {
        value = JSON.parse(invalidLine(line));
      } catch {
        continue;
      }
      expect([name, systemProxyMessageSchema.safeParse(value).success]).toEqual([name, false]);
    }
    expect(FIXTURE.invalid.some(({ line }) => line === `GENERATE:bypass:${SYSTEM_PROXY_BYPASS_MAX_ENTRIES + 1}`)).toBe(true);
  });

  it("accepts the shell's other forms: a failed reading after an off one, an IPv6 proxy, exceptions with an unusable state", () => {
    const readFailed = { v: 1, type: "system_proxy", seq: 3, config: { state: "error", reason: "read_failed", bypass: [] } };
    expect(systemProxyMessageSchema.safeParse(readFailed).success).toBe(true);
    const ipv6 = { v: 1, type: "system_proxy", seq: 4, config: { state: "manual", http: "[::1]:7890", https: "[::1]:7890", bypass: [] } };
    expect(systemProxyMessageSchema.safeParse(ipv6).success).toBe(true);
    const state = new SystemProxyState(fromSystemProxyEnv(JSON.stringify(ipv6)));
    expect(state.decideRoute(new URL("https://api.example.com/"))).toEqual({ kind: "proxy", endpoint: { host: "::1", port: 7890 }, seq: 4 });
    expect(state.status().proxy).toEqual({ http: "[::1]:7890", https: "[::1]:7890" });
    // The shell never reports `scheme`: that reason belongs to the environment variables.
    expect(systemProxyMessageSchema.safeParse({ v: 1, type: "system_proxy", seq: 5, config: { state: "unsupported", reason: "scheme", bypass: [] } }).success).toBe(false);
  });

  it("enters system proxy mode from AMBER_SYSTEM_PROXY and ignores the standard variables then", () => {
    const message = FIXTURE.valid.find(({ name }) => name === "off")?.message;
    const config = readProxyConfiguration({ [SYSTEM_PROXY_ENV]: JSON.stringify(message), https_proxy: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" });
    expect([config.source, config.state, config.seq]).toEqual(["system", "off", 4]);
    expect(decideRoute(config, new URL("https://api.example.com/"))).toEqual({ kind: "direct" });

    for (const value of ["", "not json", '{"v":1}']) {
      const broken = readProxyConfiguration({ [SYSTEM_PROXY_ENV]: value, https_proxy: "http://127.0.0.1:9" });
      expect([broken.source, broken.state, broken.reason, broken.seq]).toEqual(["system", "unsupported", "unparsable", 0]);
      expect(decideRoute(broken, new URL("https://api.example.com/"))).toEqual({ kind: "refuse", reason: "unparsable" });
    }
    const env = readProxyConfiguration({ https_proxy: "http://127.0.0.1:9" });
    expect([env.source, env.state]).toEqual(["env", "manual"]);
  });
});

describe("proxy addresses", () => {
  it("takes a bare host:port as http, refuses other schemes and rejects anything that is not just an address", () => {
    expect(parseProxyAddress("127.0.0.1:7890", { credentials: false })).toEqual({ endpoint: { host: "127.0.0.1", port: 7890 } });
    expect(parseProxyAddress("HTTP://Proxy.Example:8080/", { credentials: false })).toEqual({ endpoint: { host: "proxy.example", port: 8080 } });
    expect(parseProxyAddress("http://proxy.example", { credentials: false })).toEqual({ endpoint: { host: "proxy.example", port: 80 } });
    for (const scheme of ["https://proxy.example:443", "socks5://127.0.0.1:1080", "socks5h://127.0.0.1:1080"]) {
      expect(parseProxyAddress(scheme, { credentials: true })).toEqual({ refused: "scheme" });
    }
    for (const broken of ["http://[::1", "http://proxy.example:8080/path", "http://proxy.example:8080/?q=1", "http://proxy.example:0", "http://proxy.example:70000"]) {
      expect([broken, parseProxyAddress(broken, { credentials: true })]).toEqual([broken, { refused: "unparsable" }]);
    }
  });

  it("keeps environment credentials in memory only and out of the status", () => {
    expect(parseProxyAddress("http://us%40er:p%3Ass@127.0.0.1:3128", { credentials: true })).toEqual({
      endpoint: { host: "127.0.0.1", port: 3128, credentials: { username: "us@er", password: "p:ss" } },
    });
    expect(parseProxyAddress("http://user:pass@127.0.0.1:3128", { credentials: false })).toEqual({ refused: "unparsable" });
    const state = new SystemProxyState(fromProxyEnv({ HTTPS_PROXY: "http://proxy-user:proxy-pass@127.0.0.1:3128" }));
    const status = state.status();
    expect(status).toEqual({ source: "env", state: "manual", proxy: { https: "127.0.0.1:3128" } });
    expect(networkStatusDtoSchema.parse(status)).toEqual(status);
    expect(JSON.stringify(status)).not.toMatch(/proxy-user|proxy-pass/);
  });
});
