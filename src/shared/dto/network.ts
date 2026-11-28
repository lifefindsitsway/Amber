import { z } from "zod";

/** Where the proxy configuration comes from: the Windows system proxy (desktop client) or the standard proxy environment variables. */
export const NETWORK_PROXY_SOURCES = ["system", "env"] as const;
/** `off`: no proxy; `manual`: an http proxy is configured; `unsupported`: a configuration Amber refuses to use; `error`: reading it failed and the last good one is kept. */
export const NETWORK_PROXY_STATES = ["off", "manual", "unsupported", "error"] as const;
/** Why the state is `unsupported` or `error`; one-to-one with the refined codes of `network_proxy_unsupported`. */
export const NETWORK_PROXY_REASONS = ["pac", "socks", "scheme", "unparsable", "read_failed"] as const;

/**
 * `GET /api/network/status`: the configured proxy state and the outcome of the latest request that
 * went through the proxy. Nothing is probed to produce it. `proxy` (credentials removed) is given in
 * local mode only. `lastProxyOutcome` belongs to configuration `seq` and is dropped when it changes.
 */
export const networkStatusDtoSchema = z
  .object({
    source: z.enum(NETWORK_PROXY_SOURCES),
    state: z.enum(NETWORK_PROXY_STATES),
    reason: z.enum(NETWORK_PROXY_REASONS).exactOptional(),
    proxy: z
      .object({ http: z.string().min(1).exactOptional(), https: z.string().min(1).exactOptional() })
      .strict()
      .exactOptional(),
    /** A PAC script is set alongside the manual proxy and is ignored. */
    pacIgnored: z.literal(true).exactOptional(),
    lastProxyOutcome: z
      .object({ ok: z.boolean(), at: z.number().int(), seq: z.number().int().nonnegative() })
      .strict()
      .exactOptional(),
  })
  .strict();
export type NetworkStatusDto = z.infer<typeof networkStatusDtoSchema>;
