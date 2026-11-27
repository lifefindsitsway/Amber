import { createHash } from "node:crypto";

/**
 * The salt the platform's web client mixes into its request signature, as published by open
 * research into the web client. It is the only fixed string of the scheme; nothing else in
 * Amber repeats it.
 */
const SIGNATURE_SALT = "A96D855A08C0A9707F8BEF0D9A527E4E";

/**
 * `application/x-www-form-urlencoded` the way the platform's reference client builds the
 * signed string: everything but ASCII letters, digits and `-_.~` percent-encoded as UTF-8,
 * spaces as `+`. The server checks the signature against the query exactly as sent, so the
 * same text is both signed and sent.
 */
function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * The query string of a signed web API request: `params` in the given order, then `uifid` and
 * `timestamp` (whole seconds), then `x-secsdk-web-signature`, the hex MD5 of
 * `<uifid>_<timestamp>_<salt>_<the query before the signature>`.
 *
 * The result carries session material (the uifid and the signature); callers put it only into
 * the request URL and never into a log line or an error.
 */
export function signDouyinQuery(params: ReadonlyArray<readonly [string, string]>, uifid: string, timestampSeconds: number): string {
  const timestamp = String(timestampSeconds);
  const query = [...params, ["uifid", uifid] as const, ["timestamp", timestamp] as const]
    .map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`)
    .join("&");
  const signature = createHash("md5").update(`${uifid}_${timestamp}_${SIGNATURE_SALT}_${query}`, "utf8").digest("hex");
  return `${query}&x-secsdk-web-signature=${signature}`;
}
