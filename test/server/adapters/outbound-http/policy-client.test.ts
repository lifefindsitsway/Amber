import type { RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import type { OutboundTransport, PinnedAddress } from "../../../../src/server/adapters/outbound-http/direct.ts";
import { PolicyOutboundHttpClient, type HostResolver } from "../../../../src/server/adapters/outbound-http/policy-client.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { FORBIDDEN_ADDRESS_RANGES } from "../../../../src/server/domain/network-policy.ts";
import { OutboundHttpError, type OutboundRequest, type OutboundResponse } from "../../../../src/server/ports/outbound-http.ts";
import { useLocalServers } from "../../../fixtures/http/local-server.ts";

// Every request goes to servers on 127.0.0.1 / 127.0.0.2 started by the test; host names are
// answered by a stub resolver, so nothing leaves the machine.
const serve = useLocalServers();

const ok: RequestListener = (_request, response) => response.end("ok");

/** Host name → addresses; a function value answers per call. */
function stubResolver(table: Record<string, string | (() => string)>): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    const entry = table[hostname];
    if (entry === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    const address = typeof entry === "function" ? entry() : entry;
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
  return Object.assign(resolve, { calls });
}

/** The forbidden address ranges, except that 127.0.0.1 counts as public and only 127.0.0.2 of loopback is forbidden. */
const TEST_RANGES = [...FORBIDDEN_ADDRESS_RANGES.filter((range) => range !== "127.0.0.0/8"), "127.0.0.2/32"];

const signal = () => new AbortController().signal;
const get = (url: string, extra: Partial<OutboundRequest> = {}): OutboundRequest => ({ url, method: "GET", signal: signal(), ...extra });

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("request unexpectedly succeeded");
}

describe("PolicyOutboundHttpClient (strict)", () => {
  it("refuses metadata and private literals, a privately resolving host, redirects inward and DNS rebinding with their refined codes", async () => {
    const internal = await serve("127.0.0.2", ok);
    let answers = 0;
    const publicServer = await serve("127.0.0.1", (request, response) => {
      response.statusCode = 302;
      response.setHeader("Location", request.url === "/to-literal" ? "http://10.0.0.5/" : `http://internal.test:${internal.port}/`);
      response.end();
    });
    const resolve = stubResolver({
      "private.test": "10.0.0.5",
      "public.test": "127.0.0.1",
      "internal.test": "127.0.0.2",
      // First answer public, any later one internal: the classic rebinding window.
      "rebind.test": () => (answers++ === 0 ? "127.0.0.1" : "127.0.0.2"),
    });
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve, forbidden: TEST_RANGES });

    expect(await codeOf(client.request(get("http://169.254.169.254/latest/meta-data/")))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.request(get("http://10.0.0.5/v1")))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.request(get("http://private.test/v1")))).toBe("network_blocked_by_policy.dns_rebinding");
    expect(await codeOf(client.request(get(`http://public.test:${publicServer.port}/to-literal`)))).toBe("network_blocked_by_policy.redirect");
    expect(await codeOf(client.request(get(`http://public.test:${publicServer.port}/to-host`)))).toBe("network_blocked_by_policy.redirect");
    expect(internal.received).toHaveLength(0);

    // Fifth case: the host is resolved once and the connection is pinned to that answer, so
    // a different answer at connect time cannot divert it to the internal server.
    const rebindTarget = await serve("127.0.0.1", ok);
    const rebindInternal = await serve("127.0.0.2", ok);
    expect(rebindTarget.port).not.toBe(rebindInternal.port);
    const response = await client.request(get(`http://rebind.test:${rebindTarget.port}/`));
    expect(await response.text()).toBe("ok");
    expect(resolve.calls.filter((host) => host === "rebind.test")).toHaveLength(1);
    expect(rebindTarget.received).toHaveLength(1);
    expect(rebindInternal.received).toHaveLength(0);
  });

  it("refuses a host when any of its addresses is forbidden", async () => {
    const resolve: HostResolver = async () => [{ address: "93.184.215.14", family: 4 }, { address: "::ffff:10.1.2.3", family: 6 }];
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve });
    expect(await codeOf(client.request(get("https://mixed.test/")))).toBe("network_blocked_by_policy.dns_rebinding");
  });

  it("admits an allowlisted exact origin to a forbidden address, still pinned", async () => {
    const internal = await serve("127.0.0.2", ok);
    const resolve = stubResolver({ "relay.lan": "127.0.0.2" });
    const allowlist = new Set([`http://relay.lan:${internal.port}`]);
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve, forbidden: TEST_RANGES, allowlist: () => allowlist });
    expect(await (await client.request(get(`http://relay.lan:${internal.port}/v1/models`))).text()).toBe("ok");
    // Same host, another port: a different origin, so not allowlisted.
    expect(await codeOf(client.request(get(`http://relay.lan:${internal.port + 1}/`)))).toBe("network_blocked_by_policy.dns_rebinding");
    // A literal forbidden address passes only through its own exact origin.
    allowlist.add(`http://127.0.0.2:${internal.port}`);
    expect(await (await client.request(get(`http://127.0.0.2:${internal.port}/`))).text()).toBe("ok");
    expect(internal.received).toHaveLength(2);
  });

  it("never reuses a pinned connection after the allowlist and DNS change", async () => {
    // Both servers listen on the same port number so only the address tells them apart.
    const internal = await serve("127.0.0.2", ok);
    const port = internal.port;
    const sameport = await serve("127.0.0.1", ok, port);

    let address = "127.0.0.2";
    const resolve = stubResolver({ "relay.lan": () => address });
    const allowlist = new Set([`http://relay.lan:${port}`]);
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve, forbidden: TEST_RANGES, allowlist: () => allowlist });

    expect(await (await client.request(get(`http://relay.lan:${port}/first`))).text()).toBe("ok");
    expect(internal.received.map((entry) => entry.path)).toEqual(["/first"]);

    allowlist.clear();
    address = "127.0.0.1";
    expect(await (await client.request(get(`http://relay.lan:${port}/second`))).text()).toBe("ok");
    expect(internal.received.map((entry) => entry.path)).toEqual(["/first"]);
    expect(sameport.received.map((entry) => entry.path)).toEqual(["/second"]);
    expect(internal.connections + sameport.connections).toBe(2);

    // And with the DNS answer back on the forbidden address, nothing reaches it any more.
    address = "127.0.0.2";
    expect(await codeOf(client.request(get(`http://relay.lan:${port}/third`)))).toBe("network_blocked_by_policy.dns_rebinding");
    expect(internal.received).toHaveLength(1);
  });

  it("treats an unresolvable host as a transport failure before sending", async () => {
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve: stubResolver({}) });
    const failure = await client.request(get("https://nowhere.test/")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutboundHttpError);
    expect(failure).toMatchObject({ phase: "before_send", reason: "network" });
  });

  it("checks endpoints at save time without sending anything", async () => {
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve: stubResolver({ "private.test": "10.0.0.5", "public.test": "93.184.215.14" }) });
    expect(await codeOf(client.check("http://169.254.169.254"))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.check("https://[fd00:ec2::254]/"))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.check("https://private.test/v1"))).toBe("network_blocked_by_policy.dns_rebinding");
    await expect(client.check("https://public.test/v1")).resolves.toBeUndefined();
    // Resolution failures are left to request time.
    await expect(client.check("https://unknown.test/v1")).resolves.toBeUndefined();
  });
});

describe("PolicyOutboundHttpClient redirects", () => {
  const credentials = {
    Authorization: "Bearer <placeholder>",
    "x-api-key": "<placeholder>",
    "xi-api-key": "<placeholder>",
    Cookie: "a=<placeholder>",
    Accept: "application/json",
    "Accept-Language": "zh-CN",
    "User-Agent": "amber-test",
    Range: "bytes=0-9",
  };

  async function chain() {
    const target = await serve("127.0.0.1", ok);
    const origin = await serve("127.0.0.1", (request, response) => {
      response.statusCode = request.url === "/see-other" ? 303 : 302;
      response.setHeader("Location", request.url === "/same" ? "/landed" : `http://127.0.0.1:${target.port}/landed`);
      response.end("moved");
    });
    return { target, origin };
  }

  const permissive = () => new PolicyOutboundHttpClient({ mode: "permissive" });

  it("forwards only harmless headers to another origin and everything within the same origin", async () => {
    const { target, origin } = await chain();
    for (const client of [permissive(), new PolicyOutboundHttpClient({ mode: "strict", forbidden: TEST_RANGES })]) {
      target.received.length = 0;
      origin.received.length = 0;
      expect(await (await client.request(get(`http://127.0.0.1:${origin.port}/cross`, { headers: credentials }))).text()).toBe("ok");
      const crossed = target.received[0]?.headers ?? {};
      for (const name of ["authorization", "x-api-key", "xi-api-key", "cookie"]) expect(crossed[name], name).toBeUndefined();
      expect(crossed).toMatchObject({ accept: "application/json", "accept-language": "zh-CN", "user-agent": "amber-test", range: "bytes=0-9" });

      expect(await (await client.request(get(`http://127.0.0.1:${origin.port}/same`, { headers: credentials }))).text()).toBe("ok");
      const same = origin.received.find((entry) => entry.path === "/landed")?.headers ?? {};
      expect(same).toMatchObject({ authorization: "Bearer <placeholder>", "x-api-key": "<placeholder>", cookie: "a=<placeholder>" });
    }
  });

  it("follows 303 with GET, keeps HEAD a HEAD and returns 3xx of other methods untouched", async () => {
    const { target, origin } = await chain();
    const client = permissive();
    await (await client.request(get(`http://127.0.0.1:${origin.port}/see-other`))).text();
    await (await client.request({ url: `http://127.0.0.1:${origin.port}/see-other`, method: "HEAD", signal: signal() })).text();
    expect(target.received.map((entry) => entry.method)).toEqual(["GET", "HEAD"]);

    const posted = await client.request({ url: `http://127.0.0.1:${origin.port}/cross`, method: "POST", body: "{}", signal: signal() });
    expect(posted.status).toBe(302);
    expect(await posted.text()).toBe("moved");
    expect(target.received).toHaveLength(2);
  });

  it("returns the 3xx with redirect: manual, still checking that hop", async () => {
    const { target, origin } = await chain();
    const response = await permissive().request(get(`http://127.0.0.1:${origin.port}/cross`, { redirect: "manual" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`http://127.0.0.1:${target.port}/landed`);
    expect(target.received).toHaveLength(0);
    const strict = new PolicyOutboundHttpClient({ mode: "strict" });
    expect(await codeOf(strict.request(get(`http://127.0.0.1:${origin.port}/cross`, { redirect: "manual" })))).toBe("network_blocked_by_policy.private_address");
  });

  it("follows at most maxRedirects redirects", async () => {
    const loop = await serve("127.0.0.1", (request, response) => {
      const step = Number((request.url ?? "/0").slice(1));
      if (step >= 2) {
        response.end(`landed after ${step}`);
        return;
      }
      response.statusCode = 301;
      response.setHeader("Location", `/${step + 1}`);
      response.end();
    });
    expect(await (await new PolicyOutboundHttpClient({ mode: "permissive", maxRedirects: 2 }).request(get(`http://127.0.0.1:${loop.port}/0`))).text()).toBe(
      "landed after 2",
    );
    expect(await codeOf(new PolicyOutboundHttpClient({ mode: "permissive", maxRedirects: 1 }).request(get(`http://127.0.0.1:${loop.port}/0`)))).toBe(
      "network_blocked_by_policy.redirect",
    );
  });

  it("lets local mode reach loopback without resolving through the policy", async () => {
    const local = await serve("127.0.0.1", ok);
    const resolve = stubResolver({});
    const client = new PolicyOutboundHttpClient({ mode: "permissive", resolve });
    expect(await (await client.request(get(`http://localhost:${local.port}/`))).text()).toBe("ok");
    await expect(client.check("http://169.254.169.254")).resolves.toBeUndefined();
    expect(resolve.calls).toEqual([]);
  });
});

/** A transport that answers every hop itself and records where the policy let it connect. */
function recordingTransport(): OutboundTransport & { sent: Array<{ url: string; pinned: PinnedAddress | undefined }> } {
  const sent: Array<{ url: string; pinned: PinnedAddress | undefined }> = [];
  return {
    sent,
    async send(request: OutboundRequest, pinned?: PinnedAddress): Promise<OutboundResponse> {
      sent.push({ url: request.url, pinned });
      return { status: 200, headers: new Map(), body: (async function* () {})(), text: async () => "ok" };
    },
  };
}

const publicOnly = (url: string, extra: Partial<OutboundRequest> = {}) => get(url, { publicOnly: true, ...extra });

describe("PolicyOutboundHttpClient publicOnly requests", () => {
  const modes = ["strict", "permissive"] as const;

  it("refuses private, loopback and link-local targets in both modes before sending anything", async () => {
    const resolve = stubResolver({
      "private.test": "10.0.0.5",
      "loopback.test": "127.0.0.1",
      "link-local.test": "169.254.10.1",
      "loopback6.test": "::1",
      "shared.test": "100.64.0.9",
      "home.test": "192.168.1.20",
    });
    for (const mode of modes) {
      const transport = recordingTransport();
      const client = new PolicyOutboundHttpClient({ mode, resolve, transport });
      for (const host of ["private.test", "loopback.test", "link-local.test", "loopback6.test", "shared.test", "home.test"]) {
        expect(await codeOf(client.request(publicOnly(`https://${host}/media`))), `${mode} ${host}`).toBe("network_blocked_by_policy.dns_rebinding");
      }
      for (const literal of ["https://127.0.0.1/", "https://10.1.2.3/", "https://169.254.169.254/", "https://[fe80::1]/", "https://[::1]/"]) {
        expect(await codeOf(client.request(publicOnly(literal))), `${mode} ${literal}`).toBe("network_blocked_by_policy.private_address");
      }
      expect(transport.sent).toEqual([]);
    }
  });

  it("re-checks every redirect hop in local mode too", async () => {
    const internal = await serve("127.0.0.2", ok);
    const origin = await serve("127.0.0.1", (_request, response) => {
      response.statusCode = 302;
      response.setHeader("Location", `http://internal.test:${internal.port}/`);
      response.end();
    });
    const resolve = stubResolver({ "public.test": "127.0.0.1", "internal.test": "127.0.0.2" });
    const client = new PolicyOutboundHttpClient({ mode: "permissive", resolve, forbidden: TEST_RANGES });
    expect(await codeOf(client.request(publicOnly(`http://public.test:${origin.port}/`)))).toBe("network_blocked_by_policy.redirect");
    expect(origin.received).toHaveLength(1);
    expect(internal.received).toHaveLength(0);
  });

  it("pins the checked address in both modes, so a changed DNS answer cannot divert the connection", async () => {
    for (const mode of modes) {
      // Both servers share one port number, so only the connected address tells them apart.
      const internal = await serve("127.0.0.2", ok);
      const target = await serve("127.0.0.1", ok, internal.port);
      let answers = 0;
      const resolve = stubResolver({ "rebind.test": () => (answers++ === 0 ? "127.0.0.1" : "127.0.0.2") });
      const client = new PolicyOutboundHttpClient({ mode, resolve, forbidden: TEST_RANGES });
      expect(await (await client.request(publicOnly(`http://rebind.test:${target.port}/`))).text()).toBe("ok");
      expect(resolve.calls, mode).toEqual(["rebind.test"]);
      expect(target.received, mode).toHaveLength(1);
      expect(internal.received, mode).toHaveLength(0);

      // The next request is resolved and checked afresh; its forbidden answer is refused.
      expect(await codeOf(client.request(publicOnly(`http://rebind.test:${target.port}/`)))).toBe("network_blocked_by_policy.dns_rebinding");
      expect(internal.received, mode).toHaveLength(0);
    }
  });

  it("admits the proxy fake-IP range only in local mode", async () => {
    const resolve = stubResolver({ "cdn.test": "198.18.0.7", "edge.test": "198.19.255.254" });

    const local = recordingTransport();
    const localClient = new PolicyOutboundHttpClient({ mode: "permissive", resolve, transport: local });
    await localClient.request(publicOnly("https://cdn.test/a"));
    await localClient.request(publicOnly("https://edge.test/b"));
    await localClient.request(publicOnly("https://198.18.3.4/c"));
    expect(local.sent).toEqual([
      { url: "https://cdn.test/a", pinned: { address: "198.18.0.7", family: 4 } },
      { url: "https://edge.test/b", pinned: { address: "198.19.255.254", family: 4 } },
      { url: "https://198.18.3.4/c", pinned: { address: "198.18.3.4", family: 4 } },
    ]);
    // The neighbouring forbidden ranges stay forbidden.
    expect(await codeOf(localClient.request(publicOnly("https://198.51.100.1/")))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(localClient.request(publicOnly("https://192.0.2.1/")))).toBe("network_blocked_by_policy.private_address");

    const server = recordingTransport();
    const serverClient = new PolicyOutboundHttpClient({ mode: "strict", resolve, transport: server });
    expect(await codeOf(serverClient.request(publicOnly("https://cdn.test/a")))).toBe("network_blocked_by_policy.dns_rebinding");
    expect(await codeOf(serverClient.request(publicOnly("https://198.18.3.4/c")))).toBe("network_blocked_by_policy.private_address");
    // Without publicOnly the server mode refuses the range as before.
    expect(await codeOf(serverClient.request(get("https://cdn.test/a")))).toBe("network_blocked_by_policy.dns_rebinding");
    expect(server.sent).toEqual([]);
  });

  it("is not exempted by the allowlist, which still admits the same origin without publicOnly", async () => {
    const internal = await serve("127.0.0.2", ok);
    const resolve = stubResolver({ "relay.lan": "127.0.0.2" });
    const allowlist = new Set([`http://relay.lan:${internal.port}`, `http://127.0.0.2:${internal.port}`]);
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve, forbidden: TEST_RANGES, allowlist: () => allowlist });
    expect(await codeOf(client.request(publicOnly(`http://relay.lan:${internal.port}/`)))).toBe("network_blocked_by_policy.dns_rebinding");
    expect(await codeOf(client.request(publicOnly(`http://127.0.0.2:${internal.port}/`)))).toBe("network_blocked_by_policy.private_address");
    expect(internal.received).toHaveLength(0);
    expect(await (await client.request(get(`http://relay.lan:${internal.port}/`))).text()).toBe("ok");
    expect(internal.received).toHaveLength(1);
  });

  it("leaves requests without publicOnly in local mode unchecked and unpinned", async () => {
    const resolve = stubResolver({});
    const transport = recordingTransport();
    const client = new PolicyOutboundHttpClient({ mode: "permissive", resolve, transport });
    await client.request(get("http://10.0.0.5/v1"));
    await client.request(get("http://relay.lan/v1"));
    expect(transport.sent).toEqual([
      { url: "http://10.0.0.5/v1", pinned: undefined },
      { url: "http://relay.lan/v1", pinned: undefined },
    ]);
    expect(resolve.calls).toEqual([]);
  });
});
