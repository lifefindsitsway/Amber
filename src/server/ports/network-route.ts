import type { NETWORK_PROXY_REASONS, NetworkStatusDto } from "../../shared/dto/network.ts";

/** Why a proxy configuration is refused; one-to-one with the refined codes of `network_proxy_unsupported`. */
export type ProxyUnsupportedReason = (typeof NETWORK_PROXY_REASONS)[number];

/**
 * An http proxy to send through. `credentials` exist only for a proxy taken from the environment
 * (`http://user:pass@host:port`); they live in process memory only and never reach a log, a DTO,
 * an error message or a command line.
 */
export interface ProxyEndpoint {
  host: string;
  port: number;
  credentials?: { username: string; password: string };
}

/**
 * Where one request goes. `proxy` carries the configuration `seq` it was decided under, so the
 * outcome of the request is credited to that configuration only. `refuse`: the configuration
 * cannot be honoured and Amber never falls back to a direct connection.
 */
export type RouteDecision =
  | { kind: "direct" }
  | { kind: "proxy"; endpoint: ProxyEndpoint; seq: number }
  | { kind: "refuse"; reason: ProxyUnsupportedReason };

/**
 * The single route decision shared by outbound HTTP and the yt-dlp child process, made against
 * the configuration current at the time of the call. Decisions are never cached: a new request
 * after a configuration change uses the new configuration.
 */
export interface NetworkRouter {
  decideRoute(url: URL): RouteDecision;
  /**
   * The outcome of a request sent through the proxy decided under `seq`: `ok` once the proxy
   * carried it to the target, `false` when the proxy could not be used. Ignored when the
   * configuration has changed since.
   */
  recordProxyOutcome(seq: number, ok: boolean): void;
}

/** Read side of the proxy configuration for the network status line; nothing is probed. */
export interface NetworkStatusReader {
  /** The full status, proxy address (without credentials) included; the API drops it in server mode. */
  status(): NetworkStatusDto;
}
