import { describe, expect, it } from "vitest";
import { fromProxyEnv, fromSystemMessage, type SystemProxyMessage } from "../../../../src/server/adapters/system-proxy/config.ts";
import { decideRoute } from "../../../../src/server/adapters/system-proxy/route.ts";
import type { RouteDecision } from "../../../../src/server/ports/network-route.ts";

const PROXY = "127.0.0.1:7890";

function system(config: SystemProxyMessage["config"], seq = 1) {
  return fromSystemMessage({ v: 1, type: "system_proxy", seq, config });
}

const manual = (bypass: string[] = [], extra: Partial<SystemProxyMessage["config"]> = {}) =>
  system({ state: "manual", http: PROXY, https: PROXY, bypass, ...extra });

/** `direct`, `proxy host:port` or `refuse reason`, for compact tables. */
function verdict(decision: RouteDecision): string {
  if (decision.kind === "proxy") {
    return `proxy ${decision.endpoint.host}:${decision.endpoint.port}`;
  }
  return decision.kind === "refuse" ? `refuse ${decision.reason}` : "direct";
}

const route = (config: ReturnType<typeof system>, url: string): string => verdict(decideRoute(config, new URL(url)));

describe("decideRoute", () => {
  it("always reaches local and private targets directly, even under an unusable configuration", () => {
    const pac = system({ state: "unsupported", reason: "pac", bypass: [] });
    for (const url of [
      "http://localhost:4191/api",
      "https://LocalHost/",
      "https://app.localhost/",
      "https://printer.local/",
      "https://nas/",
      "https://localhost./",
      "http://127.0.0.1:8080/",
      "https://10.1.2.3/",
      "https://172.20.0.1/",
      "https://192.168.1.10/",
      "https://169.254.10.20/",
      "https://[::1]/",
      "https://[fd12:3456::1]/",
      "https://[fe80::1]/",
      "https://[::ffff:192.168.1.1]/",
      "https://[::ffff:7f00:1]/",
      "http://0.0.0.0:8080/",
      "https://[::]/",
    ]) {
      expect([url, route(manual(), url), route(pac, url)]).toEqual([url, "direct", "direct"]);
    }
    // Public literals and dotted names are not local.
    expect(route(manual(), "https://8.8.8.8/")).toBe(`proxy ${PROXY}`);
    expect(route(manual(), "https://[2001:4860::8888]/")).toBe(`proxy ${PROXY}`);
    expect(route(manual(), "https://172.32.0.1/")).toBe(`proxy ${PROXY}`);
  });

  it("matches Windows exceptions: * anywhere, case-insensitive, <local>, with a port or a scheme", () => {
    const config = manual(["*.Example.COM", "api.*.test", "intra*", "<local>", "build.example.org:8443", "https://secure.example.net", "10.*", "[2001:db8::5]:443"]);
    const table: Array<[string, string]> = [
      ["https://www.example.com/", "direct"],
      ["https://DEEP.sub.example.com/", "direct"],
      ["https://example.com/", `proxy ${PROXY}`],
      ["https://api.foo.test/", "direct"],
      ["https://intranet.corp.example/", "direct"],
      ["https://build.example.org:8443/", "direct"],
      ["https://build.example.org/", `proxy ${PROXY}`],
      ["https://secure.example.net/", "direct"],
      ["http://secure.example.net/", `proxy ${PROXY}`],
      ["https://[2001:db8::5]/", "direct"],
      ["https://[2001:db8::6]/", `proxy ${PROXY}`],
      ["https://claude.ai/", `proxy ${PROXY}`],
    ];
    for (const [url, expected] of table) {
      expect([url, route(config, url)]).toEqual([url, expected]);
    }
  });

  it("matches NO_PROXY the curl way: suffixes, *, ports, IP addresses and CIDR", () => {
    const env = (noProxy: string) => fromProxyEnv({ https_proxy: `http://${PROXY}`, http_proxy: `http://${PROXY}`, no_proxy: noProxy });
    const config = env("example.com, .example.org,*.example.net, api.test:8443, 8.8.8.8, 203.0.113.0/24, [2001:4860::1], 2001:4860:1::/48");
    const table: Array<[string, string]> = [
      ["https://example.com/", "direct"],
      ["https://www.example.com/", "direct"],
      ["https://notexample.com/", `proxy ${PROXY}`],
      ["https://example.org/", "direct"],
      ["https://a.b.example.org/", "direct"],
      ["https://www.example.net/", "direct"],
      ["https://api.test:8443/", "direct"],
      ["https://api.test/", `proxy ${PROXY}`],
      ["https://8.8.8.8/", "direct"],
      ["https://8.8.4.4/", `proxy ${PROXY}`],
      ["https://203.0.113.77/", "direct"],
      ["https://[2001:4860::1]/", "direct"],
      ["https://[2001:4860:1::9]/", "direct"],
      ["https://[2001:4860:2::9]/", `proxy ${PROXY}`],
    ];
    for (const [url, expected] of table) {
      expect([url, route(config, url)]).toEqual([url, expected]);
    }
    expect(route(env("*"), "https://anything.example/")).toBe("direct");
    // The two notations never mix: a Windows-only token means nothing to NO_PROXY.
    expect(route(env("<local>"), "https://api.example/")).toBe(`proxy ${PROXY}`);
    expect(route(manual(["example.com"]), "https://www.example.com/")).toBe(`proxy ${PROXY}`);
  });

  it("normalizes hosts before matching: lowercase, punycode, IPv6 without brackets, default ports", () => {
    const config = manual(["例子.测试", "*.bücher.example", "[2001:db8::1]", "secure.example:443"]);
    expect(route(config, "https://例子.测试/")).toBe("direct");
    expect(route(config, "https://xn--fsqu00a.xn--0zwm56d/")).toBe("direct");
    expect(route(config, "https://shop.BÜCHER.example/")).toBe("direct");
    expect(route(config, "https://[2001:DB8::1]:8443/")).toBe("direct");
    expect(route(config, "https://secure.example/")).toBe("direct");
    expect(route(config, "https://secure.example:443/")).toBe("direct");
    expect(route(config, "http://secure.example/")).toBe(`proxy ${PROXY}`);
    const noProxy = fromProxyEnv({ https_proxy: `http://${PROXY}`, NO_PROXY: "bücher.example:443" });
    expect(route(noProxy, "https://www.xn--bcher-kva.example/")).toBe("direct");
  });

  it("refuses an unusable configuration unless an exception exempts the target", () => {
    for (const reason of ["pac", "socks", "unparsable", "read_failed"] as const) {
      const config = system({ state: "unsupported", reason, bypass: ["*.corp.example"] });
      expect(route(config, "https://api.example.com/")).toBe(`refuse ${reason}`);
      expect(route(config, "https://git.corp.example/")).toBe("direct");
    }
    const env = fromProxyEnv({ https_proxy: "https://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7890", no_proxy: "intra.example" });
    expect(route(env, "https://api.example.com/")).toBe("refuse scheme");
    expect(route(env, "http://api.example.com/")).toBe(`proxy ${PROXY}`);
    expect(route(env, "https://intra.example/")).toBe("direct");
    expect(route(fromProxyEnv({ ALL_PROXY: "socks5://127.0.0.1:1080" }), "http://api.example.com/")).toBe("refuse scheme");
    expect(route(fromProxyEnv({ https_proxy: "http://[bad" }), "https://api.example.com/")).toBe("refuse unparsable");
  });

  it("reaches a scheme without a proxy of its own directly", () => {
    const httpOnly = system({ state: "manual", http: "proxy.example.com:8080", bypass: [] });
    expect(route(httpOnly, "http://api.example.com/")).toBe("proxy proxy.example.com:8080");
    expect(route(httpOnly, "https://api.example.com/")).toBe("direct");
    expect(route(system({ state: "off", bypass: [] }), "https://api.example.com/")).toBe("direct");
    // A failed reading keeps the last good proxy, or keeps connecting directly after an off one.
    expect(route(system({ state: "error", reason: "read_failed", https: PROXY, bypass: [] }), "https://api.example.com/")).toBe(`proxy ${PROXY}`);
    expect(route(system({ state: "error", reason: "read_failed", bypass: [] }), "https://api.example.com/")).toBe("direct");
  });

  it("takes each scheme's environment variables in order, lowercase first", () => {
    const env = {
      https_proxy: "http://lower-https.example:1",
      HTTPS_PROXY: "http://upper-https.example:2",
      http_proxy: "",
      HTTP_PROXY: "http://upper-http.example:3",
      all_proxy: "http://lower-all.example:4",
      ALL_PROXY: "http://upper-all.example:5",
    };
    expect(route(fromProxyEnv(env), "https://api.example.com/")).toBe("proxy lower-https.example:1");
    // An empty variable counts as unset.
    expect(route(fromProxyEnv(env), "http://api.example.com/")).toBe("proxy upper-http.example:3");
    expect(route(fromProxyEnv({ HTTPS_PROXY: "http://upper-https.example:2", all_proxy: "http://lower-all.example:4" }), "https://a.example/")).toBe(
      "proxy upper-https.example:2",
    );
    expect(route(fromProxyEnv({ all_proxy: "http://lower-all.example:4", ALL_PROXY: "http://upper-all.example:5" }), "http://a.example/")).toBe(
      "proxy lower-all.example:4",
    );
    expect(route(fromProxyEnv({ ALL_PROXY: "upper-all.example:5" }), "https://a.example/")).toBe("proxy upper-all.example:5");
    expect(route(fromProxyEnv({ no_proxy: "a.example", NO_PROXY: "b.example", https_proxy: "http://p.example:1" }), "https://b.example/")).toBe("proxy p.example:1");
    expect(route(fromProxyEnv({}), "https://a.example/")).toBe("direct");
  });
});
