import type { NetworkStatusDto } from "../../../shared/dto/network.ts";
import type { NetworkRouter, NetworkStatusReader, RouteDecision } from "../../ports/network-route.ts";
import { displayEndpoint, fromSystemMessage, type ProxyConfiguration, type ProxySlot, type SystemProxyMessage } from "./config.ts";
import { decideRoute } from "./route.ts";

/** Why a shell message did not replace the configuration. */
export type SystemProxyRejection = "not_system_mode" | "stale_seq";

/**
 * The process-wide proxy configuration and the outcome of the latest request that went through
 * the proxy. Every route decision reads the configuration current at that moment. Reachability
 * comes only from real requests: nothing is probed, and an outcome belongs to the configuration
 * it was decided under, so a configuration change drops it.
 */
export class SystemProxyState implements NetworkRouter, NetworkStatusReader {
  private config: ProxyConfiguration;
  private lastOutcome: { ok: boolean; at: number; seq: number } | undefined;
  private readonly now: () => number;

  constructor(initial: ProxyConfiguration, options: { now?: () => number } = {}) {
    this.config = initial;
    this.now = options.now ?? Date.now;
  }

  get current(): ProxyConfiguration {
    return this.config;
  }

  /**
   * Applies a message from the desktop shell. Only a process in system proxy mode takes them,
   * and only a `seq` greater than the current one: a delayed or repeated message never rolls
   * the configuration back.
   */
  apply(message: SystemProxyMessage): SystemProxyRejection | undefined {
    if (this.config.source !== "system") {
      return "not_system_mode";
    }
    if (message.seq <= this.config.seq) {
      return "stale_seq";
    }
    this.config = fromSystemMessage(message);
    this.lastOutcome = undefined;
    return undefined;
  }

  decideRoute(url: URL): RouteDecision {
    return decideRoute(this.config, url);
  }

  recordProxyOutcome(seq: number, ok: boolean): void {
    if (seq === this.config.seq) {
      this.lastOutcome = { ok, at: this.now(), seq };
    }
  }

  status(): NetworkStatusDto {
    const { config } = this;
    const proxy = { ...displayed("http", config.http), ...displayed("https", config.https) };
    const outcome = this.lastOutcome?.seq === config.seq ? this.lastOutcome : undefined;
    return {
      source: config.source,
      state: config.state,
      ...(config.reason === undefined ? {} : { reason: config.reason }),
      ...(Object.keys(proxy).length === 0 ? {} : { proxy }),
      ...(config.pacIgnored === undefined ? {} : { pacIgnored: config.pacIgnored }),
      ...(outcome === undefined ? {} : { lastProxyOutcome: { ...outcome } }),
    };
  }
}

function displayed(scheme: "http" | "https", slot: ProxySlot | undefined): { http?: string; https?: string } {
  return slot === undefined || !("endpoint" in slot) ? {} : { [scheme]: displayEndpoint(slot.endpoint) };
}
