import type { RouteDecision } from "../../ports/network-route.ts";
import { isLocalTarget, routeTarget } from "./bypass.ts";
import type { ProxyConfiguration } from "./config.ts";

/**
 * The route of one request under `config`, the first rule that holds deciding:
 * 1. local targets (loopback, private, link-local and unique local addresses, `localhost`,
 *    `.local` and dotless names) connect directly;
 * 2. a target on the exception list connects directly, even under a configuration that
 *    cannot be used;
 * 3. a configuration that cannot be used, or a proxy for this scheme that is not plain http,
 *    refuses the request: Amber never falls back to a direct connection;
 * 4. a proxy configured for the target's scheme carries it; a scheme without one connects
 *    directly, as Windows itself does when only some schemes have a proxy.
 */
export function decideRoute(config: ProxyConfiguration, url: URL): RouteDecision {
  const target = routeTarget(url);
  if (isLocalTarget(target) || config.bypass(target)) {
    return { kind: "direct" };
  }
  const slot = target.scheme === "https" ? config.https : config.http;
  if (slot !== undefined && "refused" in slot) {
    return { kind: "refuse", reason: slot.refused };
  }
  if (config.state === "unsupported" && config.http === undefined && config.https === undefined) {
    return { kind: "refuse", reason: config.reason ?? "unparsable" };
  }
  if (slot === undefined) {
    return { kind: "direct" };
  }
  return { kind: "proxy", endpoint: slot.endpoint, seq: config.seq };
}
