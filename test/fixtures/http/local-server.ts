import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

/**
 * Plain HTTP servers on loopback addresses for tests of outbound HTTP code, so nothing leaves
 * the machine. Each server listens on an ephemeral port unless a test needs a specific one.
 */
export interface LocalServer {
  port: number;
  /** Requests received: method, path and headers. */
  received: Array<{ method: string; path: string; headers: IncomingHttpHeaders }>;
  connections: number;
}

export type LocalServerHost = "127.0.0.1" | "127.0.0.2";

/**
 * Returns a `serve` function whose servers are closed after each test of the calling file,
 * open connections included (a handler that never answers must not keep the run alive).
 */
export function useLocalServers(): (host: LocalServerHost, handler: RequestListener, port?: number) => Promise<LocalServer> {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  });
  return async (host, handler, port = 0) => {
    const state: LocalServer = { port: 0, received: [], connections: 0 };
    const server = createServer((request, response) => {
      state.received.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers });
      handler(request, response);
    });
    server.on("connection", () => (state.connections += 1));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    state.port = (server.address() as AddressInfo).port;
    return state;
  };
}
