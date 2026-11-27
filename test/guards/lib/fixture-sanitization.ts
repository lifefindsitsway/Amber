import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Violation } from "./files.ts";
import { PLACEHOLDER, committableFiles } from "./secret-scan.ts";

/**
 * Recorded fixtures hold real responses from external services, so they are where the egress
 * IP of the recording machine and live session signatures most easily slip into a public
 * repository. Synthetic values in sources and tests are not scanned: there a public-looking
 * address is a deliberate test input, not a recording.
 */
export const RECORDED_FIXTURES_DIR = "test/fixtures/";

interface SanitizationRule {
  id: string;
  /** Reports whether `line` leaks something this rule covers. */
  leaks: (line: string) => boolean;
}

/** Ranges that never identify a host on the internet: private, shared, loopback, link-local, documentation, benchmarking, multicast and reserved. */
const NON_PUBLIC_IPV4: readonly (readonly [number, number, number])[] = [
  [0, 0, 8],
  [10, 0, 8],
  [100, 64, 10],
  [127, 0, 8],
  [169, 254, 16],
  [172, 16, 12],
  [192, 0, 24],
  [192, 168, 16],
  [198, 18, 15],
  [224, 0, 4],
  [240, 0, 4],
];
const DOCUMENTATION_IPV4 = ["192.0.2.", "198.51.100.", "203.0.113."];

// Digits and dots may not precede the address, but letters may: an encoded `ip%3D` ends in `D`.
const IPV4 = /(?<![0-9.])((?:\d{1,3}\.){3}\d{1,3})(?![0-9]|\.\d)/g;

/**
 * Four-part version numbers look like addresses: a user agent's `Chrome/140.0.0.0` or a
 * `v1.2.3.4` tag. A product token before a slash, other than the `ip` path segment that
 * signed media URLs use, or a leading `v` marks a version, not a host.
 */
function isVersionContext(before: string): boolean {
  const product = /(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)\/$/.exec(before);
  if (product && product[1]?.toLowerCase() !== "ip") {
    return true;
  }
  return /(?:^|[^A-Za-z0-9])v$/i.test(before);
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  if (DOCUMENTATION_IPV4.some((prefix) => address.startsWith(prefix))) {
    return false;
  }
  const value = ((octets[0] ?? 0) << 24 | (octets[1] ?? 0) << 16 | (octets[2] ?? 0) << 8 | (octets[3] ?? 0)) >>> 0;
  return !NON_PUBLIC_IPV4.some(([a, b, bits]) => {
    const base = ((a << 24) | (b << 16)) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === base;
  });
}

function leaksPublicIpv4(line: string): boolean {
  for (const match of line.matchAll(IPV4)) {
    const address = match[1] ?? "";
    if (isPublicIpv4(address) && !isVersionContext(line.slice(0, match.index))) {
      return true;
    }
  }
  return false;
}

/** Session and signature parameters of signed media and object-storage URLs, as query parameters. */
const SIGNED_QUERY =
  /[?&](?:signature|sig|lsig|sign|upsig|auth_key|ei|expires?|deadline|X-Amz-Signature|X-Amz-Credential|OSSAccessKeyId|xsec_token|x-secsdk-web-signature|uifid)=([^&\s"'#]+)/gi;
/** The same parameters encoded as path segments, as manifest URLs of some media CDNs do; a query-string cut misses them. */
const SIGNED_PATH = /\/(?:expire|ei|ip|signature|sig|lsig|sparams|lsparams)\/([^/\s"'?#]+)/g;

function leaksSignedParam(line: string): boolean {
  for (const pattern of [SIGNED_QUERY, SIGNED_PATH]) {
    for (const match of line.matchAll(pattern)) {
      if (!PLACEHOLDER.test(match[1] ?? "")) {
        return true;
      }
    }
  }
  return false;
}

const RULES: readonly SanitizationRule[] = [
  { id: "public-ipv4", leaks: leaksPublicIpv4 },
  { id: "signed-url-param", leaks: leaksSignedParam },
];

/** Committable files under the recorded-fixture directory. */
export function recordedFixtureFiles(root: string): string[] {
  return committableFiles(root).filter((file) => file.startsWith(RECORDED_FIXTURES_DIR));
}

/**
 * Recorded-fixture sanitization guard: public IPv4 addresses and live signed-URL parameters.
 * Reports only file and rule id, never the matched text, so the report does not repeat the leak.
 */
export function fixtureSanitizationScan(root: string, files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    let content: Buffer;
    try {
      content = readFileSync(join(root, file));
    } catch {
      continue;
    }
    if (content.includes(0)) {
      continue;
    }
    const lines = content.toString("utf8").split(/\r?\n/);
    for (const rule of RULES) {
      if (lines.some((line) => rule.leaks(line))) {
        violations.push({ file, rule: rule.id });
      }
    }
  }
  return violations;
}
