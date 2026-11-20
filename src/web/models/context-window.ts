/**
 * The common context window sizes offered as quick fills. Decimal on purpose: where a vendor's
 * "128K" is 131072 tokens, 128000 only leaves a little budget unused, while a binary value
 * where the vendor means 128000 would plan requests past the real window.
 */
export const CONTEXT_WINDOW_SUGGESTIONS = [
  { label: "32K", tokens: 32_000 },
  { label: "64K", tokens: 64_000 },
  { label: "128K", tokens: 128_000 },
  { label: "200K", tokens: 200_000 },
  { label: "256K", tokens: 256_000 },
  { label: "1M", tokens: 1_000_000 },
] as const;

/** The quick fills as written in an input; "128K" reads back as 128000. */
export const CONTEXT_WINDOW_SUGGESTION_LABELS: readonly string[] = CONTEXT_WINDOW_SUGGESTIONS.map((suggestion) => suggestion.label);

const SUFFIX_FACTORS: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000 };

/**
 * A token count as typed: digits with optional thousands separators, or a number with a K / M
 * suffix the way vendors write it ("128K", "1.5M"). `undefined` unless it is a positive
 * integer that a number can carry exactly.
 */
export function parseTokenCount(text: string): number | undefined {
  const compact = text
    .trim()
    .replace(/[\s,_，]/g, "")
    .toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(compact);
  if (match === null) return undefined;
  const [, digits = "", suffix = ""] = match;
  const value = Number(digits) * (suffix === "" ? 1 : (SUFFIX_FACTORS[suffix] ?? 1));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
