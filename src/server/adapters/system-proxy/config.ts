import { z } from "zod";
import { SYSTEM_PROXY_BYPASS_MAX_ENTRIES, SYSTEM_PROXY_MESSAGE_MAX_BYTES } from "../../../shared/defaults.ts";
import { NETWORK_PROXY_STATES, type NetworkStatusDto } from "../../../shared/dto/network.ts";
import type { ProxyEndpoint, ProxyUnsupportedReason } from "../../ports/network-route.ts";
import { DEFAULT_PORTS, NO_BYPASS, noProxyMatcher, windowsBypassMatcher, type BypassMatcher } from "./bypass.ts";

/** The environment variable through which the desktop shell hands over the system proxy at start. */
export const SYSTEM_PROXY_ENV = "AMBER_SYSTEM_PROXY";

/** Per target scheme, the standard proxy variables in the order they are consulted. */
export const PROXY_ENV_CHAINS = {
  https: ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"],
  http: ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"],
  noProxy: ["no_proxy", "NO_PROXY"],
} as const;

/** The proxy for one target scheme, or the reason it cannot be used. */
export type ProxySlot = { endpoint: ProxyEndpoint } | { refused: ProxyUnsupportedReason };

/**
 * The normalized proxy configuration every route decision reads. `seq` identifies it: the
 * shell numbers each system proxy reading, the environment is read once and stays at 0.
 */
export interface ProxyConfiguration {
  source: NetworkStatusDto["source"];
  seq: number;
  state: NetworkStatusDto["state"];
  reason?: ProxyUnsupportedReason;
  http?: ProxySlot;
  https?: ProxySlot;
  bypass: BypassMatcher;
  pacIgnored?: true;
}

/**
 * A proxy address as the shell reports it: `host:port`, optionally with a scheme. Credentials
 * never appear in a Windows proxy setting, so an `@` makes the whole message invalid.
 */
const systemProxyAddressSchema = z.string().min(1).max(SYSTEM_PROXY_MESSAGE_MAX_BYTES).regex(/^[^@\s]+$/u);

const systemProxyConfigSchema = z
  .object({
    state: z.enum(NETWORK_PROXY_STATES),
    http: systemProxyAddressSchema.exactOptional(),
    https: systemProxyAddressSchema.exactOptional(),
    bypass: z.array(z.string().max(SYSTEM_PROXY_MESSAGE_MAX_BYTES)).max(SYSTEM_PROXY_BYPASS_MAX_ENTRIES),
    reason: z.enum(["pac", "socks", "unparsable", "read_failed"]).exactOptional(),
    pacIgnored: z.literal(true).exactOptional(),
  })
  .strict()
  .superRefine((config, context) => {
    const hasProxy = config.http !== undefined || config.https !== undefined;
    const issue = (message: string): void => context.addIssue({ code: "custom", message });
    if (config.state === "manual" && !hasProxy) {
      issue("a manual configuration names a proxy");
    }
    if ((config.state === "manual" || config.state === "off") && config.reason !== undefined) {
      issue("only an unsupported or failed configuration has a reason");
    }
    if (config.state === "unsupported" && (config.reason === undefined || hasProxy)) {
      issue("an unsupported configuration has a reason and no proxy");
    }
    if (config.state === "error" && config.reason !== "read_failed") {
      issue("a failed reading has the reason read_failed");
    }
    if (config.state === "off" && hasProxy) {
      issue("an off configuration names no proxy");
    }
  });

/** One message of the shell: the same object is the value of `AMBER_SYSTEM_PROXY` and one stdin line. */
export const systemProxyMessageSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("system_proxy"),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    config: systemProxyConfigSchema,
  })
  .strict();
export type SystemProxyMessage = z.infer<typeof systemProxyMessageSchema>;

/**
 * Parses one proxy address. A bare `host[:port]` is an http proxy (as curl and Windows read it);
 * any other scheme is refused. Credentials are accepted only where the source can carry them.
 */
export function parseProxyAddress(text: string, options: { credentials: boolean }): ProxySlot {
  const trimmed = text.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(trimmed);
  if (scheme !== null && (scheme[1] as string).toLowerCase() !== "http") {
    return { refused: "scheme" };
  }
  let url: URL;
  try {
    url = new URL(scheme === null ? `http://${trimmed}` : trimmed);
  } catch {
    return { refused: "unparsable" };
  }
  if (url.hostname === "" || url.port === "0" || (url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return { refused: "unparsable" };
  }
  const hasCredentials = url.username !== "" || url.password !== "";
  if (hasCredentials && !options.credentials) {
    return { refused: "unparsable" };
  }
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const endpoint: ProxyEndpoint = { host, port: url.port === "" ? DEFAULT_PORTS.http : Number(url.port) };
  if (hasCredentials) {
    try {
      endpoint.credentials = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    } catch {
      return { refused: "unparsable" };
    }
  }
  return { endpoint };
}

/** `host:port` of an endpoint for display; credentials are never part of it. */
export function displayEndpoint(endpoint: ProxyEndpoint): string {
  return `${endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
}

/** The configuration a valid shell message describes. */
export function fromSystemMessage(message: SystemProxyMessage): ProxyConfiguration {
  const { config } = message;
  const base = {
    source: "system" as const,
    seq: message.seq,
    bypass: windowsBypassMatcher(config.bypass),
    ...(config.pacIgnored === undefined ? {} : { pacIgnored: config.pacIgnored }),
  };
  if (config.state === "unsupported" || config.state === "off") {
    return { ...base, state: config.state, ...(config.reason === undefined ? {} : { reason: config.reason }) };
  }
  const http = config.http === undefined ? undefined : parseProxyAddress(config.http, { credentials: false });
  const https = config.https === undefined ? undefined : parseProxyAddress(config.https, { credentials: false });
  const slots = { ...(http === undefined ? {} : { http }), ...(https === undefined ? {} : { https }) };
  if ([https, http].some((slot) => slot !== undefined && "refused" in slot)) {
    // The shell reports anything but a plain http proxy as unparsable; a message that names one
    // anyway is read the same way, and the whole reading counts as unsupported.
    return { ...base, state: "unsupported", reason: "unparsable" };
  }
  return { ...base, ...slots, state: config.state, ...(config.reason === undefined ? {} : { reason: config.reason }) };
}

/**
 * The configuration of a process started with `AMBER_SYSTEM_PROXY`: system proxy mode, where
 * the standard proxy variables are ignored. A value that is not a valid message is treated as
 * unparsable, never as "no proxy", so nothing silently connects directly.
 */
export function fromSystemProxyEnv(value: string): ProxyConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const message = systemProxyMessageSchema.safeParse(parsed);
  if (!message.success) {
    return { source: "system", seq: 0, state: "unsupported", reason: "unparsable", bypass: NO_BYPASS };
  }
  return fromSystemMessage(message.data);
}

function firstSet(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

/** The configuration from the standard proxy variables, separately per target scheme. */
export function fromProxyEnv(env: Readonly<Record<string, string | undefined>>): ProxyConfiguration {
  const httpText = firstSet(env, PROXY_ENV_CHAINS.http);
  const httpsText = firstSet(env, PROXY_ENV_CHAINS.https);
  const noProxy = firstSet(env, PROXY_ENV_CHAINS.noProxy);
  const http = httpText === undefined ? undefined : parseProxyAddress(httpText, { credentials: true });
  const https = httpsText === undefined ? undefined : parseProxyAddress(httpsText, { credentials: true });
  const slots = { ...(http === undefined ? {} : { http }), ...(https === undefined ? {} : { https }) };
  const base = { source: "env" as const, seq: 0, bypass: noProxy === undefined ? NO_BYPASS : noProxyMatcher(noProxy), ...slots };
  const refused = [https, http].find((slot): slot is { refused: ProxyUnsupportedReason } => slot !== undefined && "refused" in slot);
  if (refused !== undefined) {
    return { ...base, state: "unsupported", reason: refused.refused };
  }
  return { ...base, state: http === undefined && https === undefined ? "off" : "manual" };
}

/** The start-up configuration: system proxy mode when the shell passed one, the standard variables otherwise. */
export function readProxyConfiguration(env: Readonly<Record<string, string | undefined>>): ProxyConfiguration {
  const system = env[SYSTEM_PROXY_ENV];
  return system === undefined ? fromProxyEnv(env) : fromSystemProxyEnv(system);
}
