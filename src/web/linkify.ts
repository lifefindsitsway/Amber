/** A slice of plain text: either as-is, or an http(s) link whose visible text is the original slice. */
export type TextPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

/**
 * Where a link may start: `http://` or `https://` not glued to a preceding ASCII letter or
 * digit (so `xhttp://` is not a link), while CJK text right before it still counts as a boundary.
 */
const SCHEME = /(?<![A-Za-z0-9])https?:\/\//gi;
/** ASCII characters a URL may contain unescaped: unreserved, reserved and `%`. */
const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
/** Sentence punctuation that ends a sentence rather than the URL when it is the last character. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
/** `{` and `}` are not URL characters, so a `}` already ends the run before trimming. */
const CLOSING_TO_OPENING: Record<string, string> = { ")": "(", "]": "[" };
/**
 * A non-ASCII character that would continue a word: a URL written with such a character in
 * its path (an IRI, e.g. a Chinese wiki title) is not linked at all, since linking only its
 * ASCII prefix would point somewhere else.
 */
const WORD_CONTINUATION = /[\p{L}\p{M}\p{N}]/u;

/**
 * Splits untrusted plain text into text and http(s) link parts. Joining every part's `text`
 * gives back the input exactly; only candidates that `URL` parses with an http(s) protocol
 * become links, so no other scheme (`javascript:`, `mailto:` …) can ever reach an `href`.
 */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let plainStart = 0;
  const scheme = new RegExp(SCHEME.source, SCHEME.flags);
  for (let match = scheme.exec(text); match !== null; match = scheme.exec(text)) {
    const start = match.index;
    let end = start;
    while (end < text.length && URL_CHAR.test(text[end] as string)) end += 1;
    scheme.lastIndex = end;
    const run = text.slice(start, end);
    const next = text.codePointAt(end);
    if (next !== undefined && next > 0x7f && WORD_CONTINUATION.test(String.fromCodePoint(next)) && hasPathAfterHost(run, match[0].length)) {
      continue;
    }
    const candidate = trimTrailing(run);
    const href = httpHref(candidate);
    if (href === undefined) continue;
    if (start > plainStart) parts.push({ kind: "text", text: text.slice(plainStart, start) });
    parts.push({ kind: "link", text: candidate, href });
    plainStart = start + candidate.length;
    scheme.lastIndex = plainStart;
  }
  if (plainStart < text.length) parts.push({ kind: "text", text: text.slice(plainStart) });
  return parts;
}

function hasPathAfterHost(run: string, schemeLength: number): boolean {
  return /[/?#]/.test(run.slice(schemeLength));
}

/** Drops sentence punctuation and unbalanced closing brackets from the end of a URL run. */
function trimTrailing(run: string): string {
  let candidate = run;
  for (;;) {
    const last = candidate.at(-1);
    if (last === undefined) return candidate;
    if (TRAILING_PUNCTUATION.has(last)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    const opening = CLOSING_TO_OPENING[last];
    if (opening !== undefined && count(candidate, opening) < count(candidate, last)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    return candidate;
  }
}

function count(text: string, char: string): number {
  let total = 0;
  for (const item of text) if (item === char) total += 1;
  return total;
}

function httpHref(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "") return undefined;
  return url.href;
}
