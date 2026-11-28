import { generateKeyPairSync, sign } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DirectOutboundHttpClient } from "../../../../src/server/adapters/outbound-http/direct.ts";
import { PolicyOutboundHttpClient } from "../../../../src/server/adapters/outbound-http/policy-client.ts";
import { fromProxyEnv, fromSystemMessage } from "../../../../src/server/adapters/system-proxy/config.ts";
import { SystemProxyState } from "../../../../src/server/adapters/system-proxy/state.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { OutboundHttpError, type OutboundResponse, type OutboundStreamBody } from "../../../../src/server/ports/outbound-http.ts";

// Self-contained on purpose: only vitest, Node built-ins and the code under test, so the same
// file runs unchanged on every supported Node line and platform. Everything listens on
// 127.0.0.1; the target host name never resolves, so only the fake proxy can reach the targets.

const TARGET_HOST = "api.example.test";
const PROXY_USER = "proxy-user";
const PROXY_PASSWORD = "proxy-pass";
const CHUNK_BYTES = 16 * 1024;

// --- A self-signed certificate built with node:crypto alone (DER by hand, ECDSA P-256). ---

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length;
  const header =
    length < 0x80 ? Buffer.from([tag, length]) : length < 0x100 ? Buffer.from([tag, 0x81, length]) : Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, body]);
}
const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
function objectId(text: string): Buffer {
  const [first = 0, second = 0, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const encoded = [value & 0x7f];
    for (let remaining = value >> 7; remaining > 0; remaining >>= 7) encoded.unshift((remaining & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
const utcTime = (date: Date): Buffer => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`, "latin1"));

function selfSignedCertificate(host: string): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(objectId("1.2.840.10045.4.3.2"));
  const name = sequence(der(0x31, sequence(objectId("2.5.4.3"), der(0x0c, Buffer.from(host)))));
  const now = Date.now();
  const subjectAltName = sequence(objectId("2.5.29.17"), der(0x04, sequence(der(0x82, Buffer.from(host)))));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(subjectAltName)),
  );
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  return { cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

const TLS = selfSignedCertificate(TARGET_HOST);

// --- Harness: a counting fake proxy and counting targets. ---

type ConnectBehaviour = "tunnel" | "tunnel_to_silent" | 407 | 502 | "close" | "hang";
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface Target {
  /** Requests whose headers arrived. */
  started: number;
  /** Requests whose body arrived in full. */
  completed: number;
  bodyBytes: number;
  headers: IncomingMessage["headers"][];
  urls: string[];
  /** Remote ports of every connection the target accepted. */
  peers: number[];
  handler: Handler;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tcpSockets = (): number => process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function harness(options: { credentials?: boolean; trustTargetCertificate?: boolean } = {}) {
  const baseline = tcpSockets();
  const infra = new Set<Socket>();
  const track = (socket: Socket): void => {
    infra.add(socket);
    socket.once("close", () => infra.delete(socket));
  };
  const servers: Array<Server | TcpServer> = [];

  const makeTarget = (): Target => ({ started: 0, completed: 0, bodyBytes: 0, headers: [], urls: [], peers: [], handler: (_request, response) => response.end("ok") });
  const httpsTarget = makeTarget();
  const httpTarget = makeTarget();
  const serve = (target: Target): Handler => (request, response) => {
    target.started += 1;
    target.headers.push(request.headers);
    target.urls.push(request.url ?? "");
    request.on("data", (chunk: Buffer) => (target.bodyBytes += chunk.length));
    request.once("end", () => (target.completed += 1));
    target.handler(request, response);
  };
  const httpsServer = createHttpsServer({ cert: TLS.cert, key: TLS.key }, serve(httpsTarget));
  const httpServer = createHttpServer(serve(httpTarget));
  for (const [server, target] of [[httpsServer, httpsTarget], [httpServer, httpTarget]] as const) {
    server.on("connection", (socket: Socket) => {
      track(socket);
      target.peers.push(socket.remotePort ?? 0);
    });
  }
  // Accepts and never answers: a TLS handshake through it stalls.
  const silentServer = createTcpServer(track);
  servers.push(httpsServer, httpServer, silentServer);
  const ports = { https: await listen(httpsServer), http: await listen(httpServer), silent: await listen(silentServer) };

  const proxy = {
    connects: [] as string[],
    forwards: [] as string[],
    authorizations: [] as Array<string | undefined>,
    upstreamPorts: new Set<number>(),
    behaviour: "tunnel" as ConnectBehaviour,
    /** Drops both sides once this many bytes of the client's request went through. */
    dropAfterBytes: undefined as number | undefined,
  };
  const proxyServer = createTcpServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onHead);
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const [method = "", requestTarget = ""] = (lines[0] ?? "").split(" ");
      const authorization = lines.find((line) => line.toLowerCase().startsWith("proxy-authorization:"))?.slice("proxy-authorization:".length).trim();
      proxy.authorizations.push(authorization);
      const rest = head.subarray(end + 4);
      if (method === "CONNECT") {
        proxy.connects.push(requestTarget);
        const behaviour = proxy.behaviour;
        if (behaviour === "hang") return;
        if (behaviour === "close") {
          client.destroy();
          return;
        }
        if (typeof behaviour === "number") {
          client.end(`HTTP/1.1 ${behaviour} ${behaviour === 407 ? "Proxy Authentication Required" : "Bad Gateway"}\r\nContent-Length: 0\r\n\r\n`);
          return;
        }
        relay(client, behaviour === "tunnel" ? ports.https : ports.silent, rest, "HTTP/1.1 200 Connection established\r\n\r\n");
        return;
      }
      proxy.forwards.push(requestTarget);
      relay(client, ports.http, head, undefined);
    };
    client.on("data", onHead);
    client.on("error", () => undefined);
  });
  const relay = (client: Socket, port: number, initial: Buffer, greeting: string | undefined): void => {
    const upstream = connect({ host: "127.0.0.1", port });
    track(upstream);
    let relayed = 0;
    const forward = (chunk: Buffer): void => {
      relayed += chunk.length;
      if (proxy.dropAfterBytes !== undefined && relayed > proxy.dropAfterBytes) {
        client.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(chunk);
    };
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      proxy.upstreamPorts.add(upstream.localPort ?? 0);
      if (greeting !== undefined) client.write(greeting);
      if (initial.length > 0) forward(initial);
      client.on("data", forward);
      upstream.pipe(client);
    });
  };
  servers.push(proxyServer);
  const proxyPort = await listen(proxyServer);

  cleanups.push(async () => {
    for (const socket of infra) socket.destroy();
    // A socket's handle is released when it emits close; the next test's count starts clean.
    for (let waited = 0; infra.size > 0 && waited < 2000; waited += 10) await sleep(10);
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  const proxyUrl = `http://${options.credentials === true ? `${PROXY_USER}:${PROXY_PASSWORD}@` : ""}127.0.0.1:${proxyPort}`;
  const state = new SystemProxyState(fromProxyEnv({ https_proxy: proxyUrl, http_proxy: proxyUrl }));
  const transport = new DirectOutboundHttpClient(options.trustTargetCertificate === false ? {} : { ca: [TLS.cert] });
  const client = new PolicyOutboundHttpClient({ mode: "permissive", router: state, transport });

  /** Connections a target accepted that did not come from the proxy. */
  const direct = (): number => [...httpsTarget.peers, ...httpTarget.peers].filter((port) => !proxy.upstreamPorts.has(port)).length;
  /** Waits until no client-side socket is left: every open TCP socket is one of the harness's own. */
  const noLeakedSockets = async (): Promise<void> => {
    const deadline = Date.now() + 3000;
    let leaked = tcpSockets() - baseline - infra.size;
    while (leaked !== 0 && Date.now() < deadline) {
      await sleep(20);
      leaked = tcpSockets() - baseline - infra.size;
    }
    expect(leaked).toBe(0);
  };
  return { client, state, proxy, proxyPort, httpsTarget, httpTarget, direct, noLeakedSockets };
}

const signal = (): AbortSignal => new AbortController().signal;

function streamBody(count: number, beforeChunk?: (index: number) => Promise<void>): OutboundStreamBody {
  async function* chunks(): AsyncIterable<Uint8Array> {
    for (let index = 0; index < count; index += 1) {
      await beforeChunk?.(index);
      yield new Uint8Array(CHUNK_BYTES).fill(index % 256);
    }
  }
  return { stream: chunks(), contentType: "application/octet-stream", contentLength: count * CHUNK_BYTES };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("request unexpectedly succeeded");
}

function phaseOf(error: unknown): { phase: string; reason: string } | undefined {
  return error instanceof OutboundHttpError ? { phase: error.phase, reason: error.reason } : undefined;
}

function appErrorOf(error: unknown): { class: string; code: string; retryDisposition: string } | undefined {
  return isAmberError(error) ? { class: error.appError.class, code: error.appError.code, retryDisposition: error.appError.retryDisposition } : undefined;
}

async function readAll(response: OutboundResponse): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk).toString("utf8"));
  return chunks;
}

describe("requests through the proxy", () => {
  it("sends a model request over a CONNECT tunnel with TLS inside, reaching the target exactly once", async () => {
    const h = await harness({ credentials: true });
    h.httpsTarget.handler = (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    };
    const response = await h.client.request({
      url: `https://${TARGET_HOST}/v1/messages`,
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer <placeholder>" },
      body: '{"model":"m"}',
      signal: signal(),
    });
    expect(response.route).toBe("proxy");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(h.proxy.connects).toEqual([`${TARGET_HOST}:443`]);
    // Proxy-Authorization rides on CONNECT only; the target sees the request's own headers.
    expect(h.proxy.authorizations).toEqual([`Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString("base64")}`]);
    expect(h.httpsTarget.headers[0]?.["proxy-authorization"]).toBeUndefined();
    expect(h.httpsTarget.headers[0]?.authorization).toBe("Bearer <placeholder>");
    expect(h.httpsTarget.headers[0]?.host).toBe(TARGET_HOST);
    expect([h.httpsTarget.started, h.httpsTarget.completed, h.httpTarget.started]).toEqual([1, 1, 0]);
    expect(h.direct()).toBe(0);
    expect(h.state.status().lastProxyOutcome).toMatchObject({ ok: true, seq: 0 });
    await h.noLeakedSockets();
  });

  it("streams a response through the tunnel chunk by chunk", async () => {
    const h = await harness();
    h.httpsTarget.handler = async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const index of [1, 2, 3]) {
        response.write(`data: ${index}\n\n`);
        await sleep(20);
      }
      response.end();
    };
    const response = await h.client.request({ url: `https://${TARGET_HOST}/v1/stream`, method: "POST", body: "{}", signal: signal() });
    expect((await readAll(response)).join("")).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    expect([h.proxy.connects.length, h.httpsTarget.completed, h.direct()]).toEqual([1, 1, 0]);
    await h.noLeakedSockets();
  });

  it("uploads a streamed body through the tunnel", async () => {
    const h = await harness();
    h.httpsTarget.handler = (request, response) => request.once("end", () => response.end("stored"));
    const response = await h.client.request({ url: `https://${TARGET_HOST}/v1/audio`, method: "POST", body: streamBody(8), signal: signal() });
    expect(await response.text()).toBe("stored");
    expect([h.httpsTarget.started, h.httpsTarget.completed, h.httpsTarget.bodyBytes]).toEqual([1, 1, 8 * CHUNK_BYTES]);
    expect([h.proxy.connects.length, h.direct()]).toEqual([1, 0]);
    await h.noLeakedSockets();
  });

  it("sends an http target to the proxy with the absolute URL and Proxy-Authorization", async () => {
    const h = await harness({ credentials: true });
    const response = await h.client.request({ url: `http://${TARGET_HOST}/feed?page=2`, method: "GET", signal: signal() });
    expect(response.route).toBe("proxy");
    expect(await response.text()).toBe("ok");
    expect(h.proxy.connects).toEqual([]);
    expect(h.proxy.forwards).toEqual([`http://${TARGET_HOST}/feed?page=2`]);
    expect(h.proxy.authorizations[0]).toBe(`Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString("base64")}`);
    expect(h.httpTarget.headers[0]?.host).toBe(TARGET_HOST);
    expect([h.httpTarget.completed, h.httpsTarget.started, h.direct()]).toEqual([1, 0, 0]);
    await h.noLeakedSockets();
  });

  it("uses a new connection for every request, so nothing is pooled", async () => {
    const h = await harness();
    for (let index = 0; index < 3; index += 1) {
      await (await h.client.request({ url: `https://${TARGET_HOST}/v1/${index}`, method: "GET", signal: signal() })).text();
    }
    expect(h.proxy.connects).toHaveLength(3);
    expect(new Set(h.httpsTarget.peers).size).toBe(3);
    await h.noLeakedSockets();
  });

  it("releases the connection at once when a response is discarded unread", async () => {
    const h = await harness();
    h.httpsTarget.handler = (_request, response) => {
      response.writeHead(500);
      response.write("x".repeat(CHUNK_BYTES));
    };
    const response = await h.client.request({ url: `https://${TARGET_HOST}/v1`, method: "GET", signal: signal() });
    expect(response.status).toBe(500);
    response.destroy?.();
    await h.noLeakedSockets();
  });
});

describe("send boundary through the proxy", () => {
  it("is before_send when the proxy never answers CONNECT and the request is cancelled or times out", async () => {
    const h = await harness();
    h.proxy.behaviour = "hang";
    const controller = new AbortController();
    const cancelled = failureOf(h.client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: controller.signal }));
    await sleep(50);
    controller.abort();
    expect(phaseOf(await cancelled)).toEqual({ phase: "before_send", reason: "aborted" });
    const timedOut = await failureOf(h.client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: signal(), timeoutMs: 100 }));
    expect(phaseOf(timedOut)).toEqual({ phase: "before_send", reason: "timeout" });
    expect([h.proxy.connects.length, h.httpsTarget.started]).toEqual([2, 0]);
    await h.noLeakedSockets();
  });

  it("is before_send when the TLS handshake inside the tunnel is cancelled", async () => {
    const h = await harness();
    h.proxy.behaviour = "tunnel_to_silent";
    const controller = new AbortController();
    const cancelled = failureOf(h.client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: controller.signal }));
    await sleep(100);
    controller.abort();
    expect(phaseOf(await cancelled)).toEqual({ phase: "before_send", reason: "aborted" });
    expect(h.httpsTarget.started).toBe(0);
    await h.noLeakedSockets();
  });

  it("is before_send when the upload is cancelled or dropped midway; the target never holds a complete request", async () => {
    const h = await harness();
    h.httpsTarget.handler = (request, response) => request.once("end", () => response.end("stored"));
    const controller = new AbortController();
    const cancelled = failureOf(
      h.client.request({
        url: `https://${TARGET_HOST}/v1/audio`,
        method: "POST",
        body: streamBody(8, async (index) => {
          if (index === 4) {
            controller.abort();
            await sleep(20);
          }
        }),
        signal: controller.signal,
      }),
    );
    expect(phaseOf(await cancelled)).toEqual({ phase: "before_send", reason: "aborted" });

    h.proxy.dropAfterBytes = 3 * CHUNK_BYTES;
    const dropped = await failureOf(
      h.client.request({ url: `https://${TARGET_HOST}/v1/audio`, method: "POST", body: streamBody(8, () => sleep(5)), signal: signal() }),
    );
    expect(phaseOf(dropped)).toEqual({ phase: "before_send", reason: "network" });
    expect(h.httpsTarget.completed).toBe(0);
    await h.noLeakedSockets();
  });

  it("is after_send once the whole request went through, whether the answer is late or breaks off", async () => {
    const h = await harness();
    h.httpsTarget.handler = () => undefined;
    const late = await failureOf(h.client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: signal(), timeoutMs: 200 }));
    expect(phaseOf(late)).toEqual({ phase: "after_send", reason: "timeout" });
    expect(h.httpsTarget.completed).toBe(1);

    h.httpsTarget.handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: 1\n\n");
    };
    const controller = new AbortController();
    const response = await h.client.request({ url: `https://${TARGET_HOST}/v1/stream`, method: "POST", body: "{}", signal: controller.signal });
    const iterator = response.body[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    expect(phaseOf(await failureOf(iterator.next()))).toEqual({ phase: "after_send", reason: "aborted" });
    expect(h.httpsTarget.completed).toBe(2);
    await h.noLeakedSockets();
  });
});

describe("proxy failures", () => {
  it("classifies 407, a refused CONNECT, an unreachable proxy and a replaced certificate, with nothing reaching the target", async () => {
    const h = await harness();
    const request = () => h.client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: signal() });

    h.proxy.behaviour = 407;
    expect(appErrorOf(await failureOf(request()))).toEqual({ class: "network_proxy_failed", code: "network_proxy_failed.auth_required", retryDisposition: "never" });
    h.proxy.behaviour = 502;
    expect(appErrorOf(await failureOf(request()))).toEqual({ class: "network_proxy_failed", code: "network_proxy_failed.rejected", retryDisposition: "safe" });
    h.proxy.behaviour = "close";
    expect(appErrorOf(await failureOf(request()))).toMatchObject({ code: "network_proxy_failed.rejected", retryDisposition: "safe" });
    expect(h.state.status().lastProxyOutcome).toMatchObject({ ok: false, seq: 0 });
    expect(h.httpsTarget.started).toBe(0);
    await h.noLeakedSockets();

    const untrusting = await harness({ trustTargetCertificate: false });
    const tls = await failureOf(untrusting.client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: signal() }));
    expect(appErrorOf(tls)).toEqual({ class: "network_proxy_failed", code: "network_proxy_failed.tls", retryDisposition: "never" });
    expect(untrusting.httpsTarget.started).toBe(0);
    await untrusting.noLeakedSockets();
  });

  it("reports an unreachable proxy as such and never falls back to a direct connection", async () => {
    const closed = createTcpServer();
    const port = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const state = new SystemProxyState(fromProxyEnv({ https_proxy: `http://${PROXY_USER}:${PROXY_PASSWORD}@127.0.0.1:${port}` }));
    const client = new PolicyOutboundHttpClient({ mode: "permissive", router: state, transport: new DirectOutboundHttpClient({ ca: [TLS.cert] }) });
    const failure = await failureOf(client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: signal() }));
    expect(appErrorOf(failure)).toEqual({ class: "network_proxy_failed", code: "network_proxy_failed.unreachable", retryDisposition: "safe" });
    expect(JSON.stringify(isAmberError(failure) ? failure.appError : {}) + String((failure as Error).message)).not.toContain(PROXY_PASSWORD);
    expect(state.status().lastProxyOutcome).toMatchObject({ ok: false });
  });

  it("refuses an unusable configuration before anything is sent", async () => {
    const h = await harness();
    for (const reason of ["pac", "socks", "unparsable", "read_failed"] as const) {
      const state = new SystemProxyState(fromSystemMessage({ v: 1, type: "system_proxy", seq: 1, config: { state: "unsupported", reason, bypass: [] } }));
      const client = new PolicyOutboundHttpClient({ mode: "permissive", router: state, transport: new DirectOutboundHttpClient({ ca: [TLS.cert] }) });
      const failure = await failureOf(client.request({ url: `https://${TARGET_HOST}/v1`, method: "POST", body: "{}", signal: signal() }));
      expect(appErrorOf(failure)).toEqual({ class: "network_proxy_unsupported", code: `network_proxy_unsupported.${reason}`, retryDisposition: "never" });
    }
    const scheme = new PolicyOutboundHttpClient({ mode: "permissive", router: new SystemProxyState(fromProxyEnv({ ALL_PROXY: `socks5://127.0.0.1:${h.proxyPort}` })) });
    expect(appErrorOf(await failureOf(scheme.request({ url: `https://${TARGET_HOST}/v1`, method: "GET", signal: signal() })))).toMatchObject({ code: "network_proxy_unsupported.scheme" });
    expect([h.proxy.connects.length, h.proxy.forwards.length, h.httpsTarget.started, h.httpTarget.started]).toEqual([0, 0, 0, 0]);
    await h.noLeakedSockets();
  });
});

describe("certificate identity through the proxy", () => {
  it("checks an IP literal target's certificate against the target, never against the proxy's host", async () => {
    // The target presents a certificate for the proxy's own name ("localhost"); were the name
    // taken from the socket to the proxy, it would pass for any IP literal target.
    const proxyNamed = selfSignedCertificate("localhost");
    const target = createHttpsServer({ cert: proxyNamed.cert, key: proxyNamed.key }, (_request, response) => response.end("ok"));
    const targetPort = await listen(target);
    const sockets = new Set<Socket>();
    const proxy = createTcpServer((client) => {
      sockets.add(client);
      client.once("data", () => {
        const upstream = connect({ host: "127.0.0.1", port: targetPort }, () => {
          client.write("HTTP/1.1 200 Connection established\r\n\r\n");
          client.pipe(upstream);
          upstream.pipe(client);
        });
        sockets.add(upstream);
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
      });
    });
    const proxyPort = await listen(proxy);
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([target, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    });
    const state = new SystemProxyState(fromProxyEnv({ https_proxy: `http://localhost:${proxyPort}` }));
    const client = new PolicyOutboundHttpClient({ mode: "permissive", router: state, transport: new DirectOutboundHttpClient({ ca: [proxyNamed.cert] }) });
    const failed = await client.request({ url: "https://203.0.113.5/v1", method: "GET", signal: new AbortController().signal, timeoutMs: 5000 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isAmberError(failed) ? failed.appError.code : failed).toBe("network_proxy_failed.tls");
  });
});
