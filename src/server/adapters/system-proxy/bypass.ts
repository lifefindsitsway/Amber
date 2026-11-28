import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { isForbiddenAddress, parseAddress } from "../../domain/network-policy.ts";

/**
 * A request target as the route decision and the bypass matchers see it: scheme, host in
 * lowercase with IDN as punycode, IPv6 without brackets and without a trailing root dot, and
 * the port with the scheme's default filled in.
 */
export interface RouteTarget {
  scheme: "http" | "https";
  host: string;
  port: number;
  /** 4 or 6 for an IP literal, 0 for a host name. */
  ip: 0 | 4 | 6;
}

/** Whether a target is exempt from the proxy by the configured exception list. */
export type BypassMatcher = (target: RouteTarget) => boolean;

export const NO_BYPASS: BypassMatcher = () => false;

/** The port a URL without one uses, per scheme. */
export const DEFAULT_PORTS = { http: 80, https: 443 } as const;

/** Normalizes an http(s) URL into its route target; WHATWG parsing already lowercases and punycodes the host. */
export function routeTarget(url: URL): RouteTarget {
  const scheme = url.protocol === "https:" ? "https" : "http";
  let host = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  host = stripRootDot(host.toLowerCase());
  const ip = isIP(host);
  return { scheme, host, port: url.port === "" ? DEFAULT_PORTS[scheme] : Number(url.port), ip: ip === 4 || ip === 6 ? ip : 0 };
}

function stripRootDot(host: string): string {
  return host.length > 1 && host.endsWith(".") ? host.slice(0, -1) : host;
}

/** Lowercases a host pattern and turns its non-ASCII labels into punycode; wildcard labels stay as written. */
function asciiPattern(host: string): string {
  return host
    .toLowerCase()
    .split(".")
    .map((label) => {
      if (label.includes("*") || !/[^\x20-\x7e]/u.test(label)) {
        return label;
      }
      const ascii = domainToASCII(label);
      return ascii === "" ? label : ascii;
    })
    .join(".");
}

/** Splits `host[:port]`, `[v6][:port]` or a bare IPv6 address; `port` is a number, `"*"` or absent. */
function splitPort(entry: string): { host: string; port?: number | "*" } | undefined {
  let host = entry;
  let portText: string | undefined;
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close < 0) {
      return undefined;
    }
    host = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) {
        return undefined;
      }
      portText = rest.slice(1);
    }
  } else {
    const colons = entry.split(":").length - 1;
    if (colons === 1) {
      const index = entry.indexOf(":");
      host = entry.slice(0, index);
      portText = entry.slice(index + 1);
    }
  }
  if (portText === undefined) {
    return { host };
  }
  if (portText === "*") {
    return { host, port: "*" };
  }
  if (!/^\d{1,5}$/u.test(portText)) {
    return undefined;
  }
  return { host, port: Number(portText) };
}

function portMatches(wanted: number | "*" | undefined, target: RouteTarget): boolean {
  return wanted === undefined || wanted === "*" || wanted === target.port;
}

function globRegex(pattern: string): RegExp {
  // Consecutive stars match what one does; collapsing them keeps the pattern linear.
  const source = pattern
    .replace(/\*+/gu, "*")
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "u");
}

function sameAddress(a: string, b: string): boolean {
  const left = parseAddress(a);
  const right = parseAddress(b);
  return left !== undefined && right !== undefined && left.family === right.family && left.value === right.value;
}

/**
 * The Windows proxy exception list (Internet Options "Do not use proxy server for addresses
 * beginning with"). Each entry is a pattern where `*` matches anything at any position,
 * compared without regard to case; `<local>` stands for every host name without a dot; an entry
 * may name a scheme (`https://host`) and a port (`host:8080`). Entries match the whole host,
 * so `example.com` does not cover `www.example.com`.
 */
export function windowsBypassMatcher(entries: readonly string[]): BypassMatcher {
  const rules: BypassMatcher[] = [];
  for (const raw of entries) {
    let entry = raw.trim().toLowerCase();
    if (entry === "") {
      continue;
    }
    if (entry === "<local>") {
      rules.push((target) => target.ip === 0 && !target.host.includes("."));
      continue;
    }
    let scheme: string | undefined;
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//u.exec(entry);
    if (schemeMatch !== null) {
      scheme = schemeMatch[1];
      entry = entry.slice(schemeMatch[0].length);
    }
    entry = entry.replace(/\/+$/u, "");
    const split = splitPort(entry);
    if (split === undefined || split.host === "") {
      continue;
    }
    const { port } = split;
    const host = stripRootDot(split.host);
    const pattern = globRegex(isIP(host) === 0 ? asciiPattern(host) : host);
    rules.push((target) => (scheme === undefined || scheme === target.scheme) && portMatches(port, target) && pattern.test(target.host));
  }
  return (target) => rules.some((rule) => rule(target));
}

/**
 * `NO_PROXY` as curl reads it: comma separated; `*` alone exempts everything; a host name
 * exempts itself and every subdomain (a leading `.` or `*.` is ignored); an IP address matches
 * exactly and `address/prefix` matches its range; any entry may end in `:port`.
 */
export function noProxyMatcher(value: string): BypassMatcher {
  const rules: BypassMatcher[] = [];
  for (const raw of value.split(/[\s,]+/u)) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") {
      continue;
    }
    if (entry === "*") {
      return () => true;
    }
    const cidr = /^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/u.exec(entry);
    if (cidr !== null) {
      const range = `${cidr[1] as string}/${cidr[2] as string}`;
      if (parseAddress(cidr[1] as string) === undefined) {
        continue;
      }
      rules.push((target) => target.ip !== 0 && inRange(target.host, range));
      continue;
    }
    const split = splitPort(entry);
    if (split === undefined || split.host === "") {
      continue;
    }
    const { port } = split;
    if (isIP(split.host) !== 0) {
      const address = split.host;
      rules.push((target) => target.ip !== 0 && portMatches(port, target) && sameAddress(address, target.host));
      continue;
    }
    const suffix = asciiPattern(stripRootDot(split.host.replace(/^\*?\./u, "")));
    if (suffix === "" || suffix.includes("*")) {
      continue;
    }
    rules.push((target) => target.ip === 0 && portMatches(port, target) && (target.host === suffix || target.host.endsWith(`.${suffix}`)));
  }
  return (target) => rules.some((rule) => rule(target));
}

function inRange(address: string, range: string): boolean {
  try {
    return isForbiddenAddress(address, [range]);
  } catch {
    // An out-of-bounds prefix length: the entry matches nothing.
    return false;
  }
}

/** Unspecified, loopback, private, link-local and unique local ranges: such targets never go through a proxy. An IPv4-mapped IPv6 address is judged by the IPv4 address it embeds. */
const LOCAL_RANGES: readonly string[] = ["0.0.0.0/8", "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "::/128", "::1/128", "fc00::/7", "fe80::/10"];

/**
 * Targets that are always reached directly: `localhost` and its subdomains, `.local` names,
 * host names without a dot, and loopback, private, link-local or unique local IP literals.
 */
export function isLocalTarget(target: RouteTarget): boolean {
  if (target.ip !== 0) {
    return isForbiddenAddress(target.host, LOCAL_RANGES);
  }
  const host = target.host;
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".");
}
