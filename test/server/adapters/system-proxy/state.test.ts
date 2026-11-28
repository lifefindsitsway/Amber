import { describe, expect, it } from "vitest";
import { fromProxyEnv, fromSystemMessage, type SystemProxyMessage } from "../../../../src/server/adapters/system-proxy/config.ts";
import { SystemProxyState } from "../../../../src/server/adapters/system-proxy/state.ts";
import { networkStatusDtoSchema } from "../../../../src/shared/dto/network.ts";

const message = (seq: number, config: SystemProxyMessage["config"]): SystemProxyMessage => ({ v: 1, type: "system_proxy", seq, config });
const MANUAL: SystemProxyMessage["config"] = { state: "manual", http: "127.0.0.1:7890", https: "127.0.0.1:7890", bypass: [] };
const TARGET = new URL("https://api.example.com/v1");

describe("SystemProxyState", () => {
  it("takes only messages with a greater seq, and new requests follow the new configuration", () => {
    const state = new SystemProxyState(fromSystemMessage(message(2, { state: "off", bypass: [] })));
    expect(state.decideRoute(TARGET)).toEqual({ kind: "direct" });
    expect(state.apply(message(2, MANUAL))).toBe("stale_seq");
    expect(state.apply(message(1, MANUAL))).toBe("stale_seq");
    expect(state.decideRoute(TARGET)).toEqual({ kind: "direct" });
    expect(state.apply(message(3, MANUAL))).toBeUndefined();
    expect(state.decideRoute(TARGET)).toEqual({ kind: "proxy", endpoint: { host: "127.0.0.1", port: 7890 }, seq: 3 });
    expect(state.apply(message(4, { state: "unsupported", reason: "pac", bypass: [] }))).toBeUndefined();
    expect(state.decideRoute(TARGET)).toEqual({ kind: "refuse", reason: "pac" });
  });

  it("takes no shell message when started from the standard variables", () => {
    const state = new SystemProxyState(fromProxyEnv({}));
    expect(state.apply(message(5, MANUAL))).toBe("not_system_mode");
    expect(state.decideRoute(TARGET)).toEqual({ kind: "direct" });
  });

  it("keeps the latest outcome through the proxy and drops it when the configuration changes", () => {
    let clock = 1_000;
    const state = new SystemProxyState(fromSystemMessage(message(1, MANUAL)), { now: () => clock });
    expect(state.status().lastProxyOutcome).toBeUndefined();
    state.recordProxyOutcome(1, false);
    expect(state.status().lastProxyOutcome).toEqual({ ok: false, at: 1_000, seq: 1 });
    clock = 2_000;
    state.recordProxyOutcome(1, true);
    expect(state.status().lastProxyOutcome).toEqual({ ok: true, at: 2_000, seq: 1 });
    state.recordProxyOutcome(1, false);
    state.apply(message(2, MANUAL));
    expect(state.status().lastProxyOutcome).toBeUndefined();
    // A request decided under the old configuration that ends late does not count for the new one.
    state.recordProxyOutcome(1, false);
    expect(state.status().lastProxyOutcome).toBeUndefined();
  });

  it("describes each configuration through the status DTO", () => {
    const cases: Array<[SystemProxyMessage["config"], object]> = [
      [MANUAL, { source: "system", state: "manual", proxy: { http: "127.0.0.1:7890", https: "127.0.0.1:7890" } }],
      [{ state: "manual", http: "proxy.example.com:8080", bypass: [] }, { source: "system", state: "manual", proxy: { http: "proxy.example.com:8080" } }],
      [{ ...MANUAL, pacIgnored: true }, { source: "system", state: "manual", proxy: { http: "127.0.0.1:7890", https: "127.0.0.1:7890" }, pacIgnored: true }],
      [{ state: "off", bypass: [] }, { source: "system", state: "off" }],
      [{ state: "unsupported", reason: "socks", bypass: [] }, { source: "system", state: "unsupported", reason: "socks" }],
      [{ state: "error", reason: "read_failed", https: "127.0.0.1:7890", bypass: [] }, { source: "system", state: "error", reason: "read_failed", proxy: { https: "127.0.0.1:7890" } }],
      [{ state: "manual", http: "socks5://127.0.0.1:1080", bypass: [] }, { source: "system", state: "unsupported", reason: "unparsable" }],
    ];
    for (const [config, expected] of cases) {
      const status = new SystemProxyState(fromSystemMessage(message(1, config))).status();
      expect(status).toEqual(expected);
      expect(networkStatusDtoSchema.parse(status)).toEqual(status);
    }
    expect(new SystemProxyState(fromProxyEnv({ all_proxy: "socks5://127.0.0.1:1080" })).status()).toEqual({ source: "env", state: "unsupported", reason: "scheme" });
    expect(new SystemProxyState(fromProxyEnv({})).status()).toEqual({ source: "env", state: "off" });
  });
});
