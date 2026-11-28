import { dirname } from "node:path";
import { amberError } from "../../domain/errors.ts";
import type { OutboundHttpClient } from "../../ports/outbound-http.ts";
import type { PlatformMediaDownload } from "./download.ts";
import { trustedImageUrl } from "./shared.ts";

/**
 * Downloads a platform's cover image to `output.path` for the caller to decode. Only an https
 * URL on one of `domains` (subdomains included, no user info, no port) is requested, and every
 * redirect hop stays on them; anything else fails before a request goes out. No cookie is ever
 * sent: a cover is public. The downloader's scratch files go beside `output.path`, in the
 * caller's job directory. `trustedHosts` is the calling adapter's own table, passed on to
 * every request.
 */
export async function fetchPlatformCover(
  http: OutboundHttpClient | undefined,
  download: PlatformMediaDownload,
  input: { coverUrl: string; domains: readonly string[]; trustedHosts: readonly string[]; output: { path: string }; maxBytes: number; signal: AbortSignal },
): Promise<{ sizeBytes: number }> {
  const url = trustedImageUrl(input.coverUrl, input.domains);
  if (url === undefined) {
    // The URL is not repeated: whatever it is, it is not one of ours to echo.
    throw amberError("source_unreachable", "the cover URL is not an https URL on the platform's image hosts");
  }
  if (http === undefined) {
    throw amberError("source_unreachable", "no outbound HTTP client is composed for covers");
  }
  const result = await download(http, {
    url,
    allowedHosts: input.domains,
    trustedHosts: input.trustedHosts,
    kind: "image",
    maxBytes: input.maxBytes,
    output: { path: input.output.path, scratchDir: dirname(input.output.path) },
    signal: input.signal,
  });
  return { sizeBytes: result.sizeBytes };
}
